import type {
  Activity,
  Contact,
  CrmProvider,
  Id,
  NewOpportunity,
  Opportunity,
  OpportunityFilter,
  Pipeline,
  ProviderInfo,
  Stage,
  User,
} from "@/lib/crm/types";
import { fetchWithRetry } from "@/lib/crm/net";

/**
 * Follow Up Boss adapter (https://docs.followupboss.com). The real-estate CRM.
 *
 * FUB has no separate "deal" object that agents actually use day to day — the
 * lead's stage on the person record IS the pipeline. So each FUB person maps to
 * one Contact and one Opportunity (same id), and FUB's account-wide stage list
 * becomes a single pipeline. Moving an opportunity sets the person's stage.
 *
 * FUB's API can't SEND texts or emails; it only records them. Sending goes
 * through the app's own channels (Twilio / Close / email) and is logged back
 * to the FUB timeline as a note, so the agent sees everything in FUB.
 *
 * Auth: the agent's API key (Basic auth, key as username). FUB also asks every
 * integration to identify itself with X-System / X-System-Key headers; set
 * FUB_SYSTEM + FUB_SYSTEM_KEY once for the platform (register at FUB's
 * developer page). They're optional — requests work without them.
 */

const API = "https://api.followupboss.com/v1";
const PIPELINE_ID = "fub";
/** Upper bound on people pulled per listing, so a 50k-lead account can't blow the function budget. */
const MAX_PEOPLE = Number(process.env.FUB_MAX_PEOPLE) || 2000;

interface FubPerson {
  id: number;
  name?: string;
  firstName?: string;
  lastName?: string;
  stage?: string;
  stageId?: number;
  source?: string;
  assignedUserId?: number;
  price?: number;
  created?: string;
  updated?: string;
  lastActivity?: string;
  tags?: string[];
  emails?: { value: string; type?: string; status?: string; isPrimary?: boolean | number }[];
  phones?: { value: string; type?: string; status?: string; isPrimary?: boolean | number }[];
}

interface FubStage {
  id: number;
  name: string;
  orderWeight?: number;
}

const WON = /closed|past client|sold|settled/i;
const LOST = /trash|non-?active|dead|lost|archiv/i;

export function fubStageType(name: string): Stage["type"] {
  if (WON.test(name)) return "won";
  if (LOST.test(name)) return "lost";
  return "open";
}

export function mapFubPerson(p: FubPerson): Contact {
  const name = p.name || [p.firstName, p.lastName].filter(Boolean).join(" ") || `Lead ${p.id}`;
  const bad = (s?: string) => Boolean(s && /bad|invalid|not ?valid|unsubscribed|bounced/i.test(s));
  return {
    id: String(p.id),
    name,
    points: [
      ...(p.emails ?? []).filter((e) => e.value && !bad(e.status)).map((e) => ({ channel: "email" as const, value: e.value, label: e.type })),
      ...(p.phones ?? []).filter((ph) => ph.value && !bad(ph.status)).map((ph) => ({ channel: "phone" as const, value: ph.value, label: ph.type })),
    ],
    attributes: {
      source: p.source ?? null,
      stage: p.stage ?? null,
      tags: (p.tags ?? []).join(", ") || null,
    },
  };
}

export class FollowUpBossProvider implements CrmProvider {
  private key = process.env.FUB_API_KEY ?? "";
  private stagesCache: FubStage[] | null = null;

  /** Per-org credentials (the org's encrypted connection) override the env. */
  constructor(key?: string) {
    if (key) this.key = key;
  }

  private async req<T>(path: string, init?: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> }): Promise<T> {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(init?.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${this.key}:`).toString("base64")}`,
      Accept: "application/json",
    };
    if (process.env.FUB_SYSTEM) headers["X-System"] = process.env.FUB_SYSTEM;
    if (process.env.FUB_SYSTEM_KEY) headers["X-System-Key"] = process.env.FUB_SYSTEM_KEY;
    if (init?.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetchWithRetry(url.toString(), {
      method: init?.method ?? "GET",
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Follow Up Boss API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json() as Promise<T>;
  }

  info(): ProviderInfo {
    return {
      id: "followupboss",
      label: "Follow Up Boss",
      capabilities: { read: true, write: true, activities: true, customFields: false },
      ready: Boolean(this.key),
      setupHint: "Connect with your Follow Up Boss API key (Admin → API in Follow Up Boss).",
    };
  }

  private async stages(): Promise<FubStage[]> {
    if (this.stagesCache) return this.stagesCache;
    const r = await this.req<{ stages?: FubStage[] }>("/stages", { query: { limit: 100 } });
    this.stagesCache = [...(r.stages ?? [])].sort((a, b) => (a.orderWeight ?? 0) - (b.orderWeight ?? 0));
    return this.stagesCache;
  }

  private async stageIdFor(p: FubPerson): Promise<string> {
    if (p.stageId) return String(p.stageId);
    const hit = (await this.stages()).find((s) => s.name.toLowerCase() === (p.stage ?? "").toLowerCase());
    return hit ? String(hit.id) : p.stage ?? "";
  }

  private async toOpp(p: FubPerson): Promise<Opportunity> {
    const contact = mapFubPerson(p);
    return {
      id: String(p.id),
      title: contact.name,
      pipelineId: PIPELINE_ID,
      stageId: await this.stageIdFor(p),
      value: Number(p.price) || 0,
      currency: "USD",
      contactId: String(p.id),
      ownerId: p.assignedUserId ? String(p.assignedUserId) : undefined,
      source: p.source,
      createdAt: p.created ?? new Date(0).toISOString(),
      updatedAt: p.updated ?? p.created ?? new Date(0).toISOString(),
      lastActivityAt: p.lastActivity ?? p.updated,
      tags: p.tags,
    };
  }

  private async allPeople(): Promise<FubPerson[]> {
    const out: FubPerson[] = [];
    let offset = 0;
    while (out.length < MAX_PEOPLE) {
      const r = await this.req<{ people?: FubPerson[]; _metadata?: { total?: number } }>("/people", {
        query: { limit: 100, offset, sort: "-updated", fields: "allFields" },
      });
      const page = r.people ?? [];
      out.push(...page);
      offset += page.length;
      if (page.length < 100 || (r._metadata?.total && offset >= r._metadata.total)) break;
    }
    return out.slice(0, MAX_PEOPLE);
  }

  async listUsers(): Promise<User[]> {
    const r = await this.req<{ users?: { id: number; name: string; email?: string }[] }>("/users", { query: { limit: 100 } });
    return (r.users ?? []).map((u) => ({ id: String(u.id), name: u.name, email: u.email }));
  }

  async listPipelines(): Promise<Pipeline[]> {
    const stages = await this.stages();
    const open = stages.filter((s) => fubStageType(s.name) === "open");
    return [
      {
        id: PIPELINE_ID,
        label: "Follow Up Boss",
        stages: stages.map((s) => {
          const type = fubStageType(s.name);
          const i = open.indexOf(s);
          return { id: String(s.id), label: s.name, type, probability: type === "won" ? 1 : type === "lost" ? 0 : (i + 1) / (open.length + 1) };
        }),
      },
    ];
  }

  async listContacts(): Promise<Contact[]> {
    return (await this.allPeople()).map(mapFubPerson);
  }

  async getContact(id: Id): Promise<Contact | null> {
    try {
      return mapFubPerson(await this.req<FubPerson>(`/people/${encodeURIComponent(id)}`, { query: { fields: "allFields" } }));
    } catch {
      return null;
    }
  }

  async createContact(input: Omit<Contact, "id">): Promise<Contact> {
    const [firstName, ...rest] = input.name.trim().split(/\s+/);
    const p = await this.req<FubPerson>("/people", {
      method: "POST",
      query: { deduplicate: "true" },
      body: {
        firstName,
        lastName: rest.join(" ") || undefined,
        source: "Realtor OS",
        emails: input.points.filter((x) => x.channel === "email").map((x) => ({ value: x.value })),
        phones: input.points.filter((x) => x.channel === "phone" || x.channel === "sms").map((x) => ({ value: x.value })),
      },
    });
    return mapFubPerson(p);
  }

  async listOpportunities(filter?: OpportunityFilter): Promise<Opportunity[]> {
    let out = await Promise.all((await this.allPeople()).map((p) => this.toOpp(p)));
    if (filter?.stageType) {
      const types = new Map((await this.stages()).map((s) => [String(s.id), fubStageType(s.name)]));
      out = out.filter((o) => (types.get(o.stageId) ?? "open") === filter.stageType);
    }
    if (filter?.ownerId) out = out.filter((o) => o.ownerId === filter.ownerId);
    if (filter?.staleSince) out = out.filter((o) => !o.lastActivityAt || o.lastActivityAt <= filter.staleSince!);
    return out;
  }

  async getOpportunity(id: Id): Promise<Opportunity | null> {
    try {
      return await this.toOpp(await this.req<FubPerson>(`/people/${encodeURIComponent(id)}`, { query: { fields: "allFields" } }));
    } catch {
      return null;
    }
  }

  private async setStage(personId: Id, stageId: Id): Promise<Opportunity> {
    const stage = (await this.stages()).find((s) => String(s.id) === String(stageId));
    const p = await this.req<FubPerson>(`/people/${encodeURIComponent(personId)}`, {
      method: "PUT",
      body: stage ? { stage: stage.name } : { stageId: Number(stageId) },
    });
    return this.toOpp(p);
  }

  /** A FUB "opportunity" is the person — creating one sets the person's stage (and price). */
  async createOpportunity(input: NewOpportunity): Promise<Opportunity> {
    if (input.value) {
      await this.req(`/people/${encodeURIComponent(input.contactId)}`, { method: "PUT", body: { price: Math.round(input.value) } });
    }
    return this.setStage(input.contactId, input.stageId);
  }

  async moveOpportunity(id: Id, stageId: Id): Promise<Opportunity> {
    return this.setStage(id, stageId);
  }

  async listActivities(opportunityId: Id): Promise<Activity[]> {
    return this.activitiesFor(opportunityId);
  }

  async listActivitiesByContact(contactId: Id): Promise<Activity[]> {
    return this.activitiesFor(contactId);
  }

  private async activitiesFor(personId: Id, limit = 25): Promise<Activity[]> {
    const q = { personId, limit, sort: "-created" };
    const [notes, calls, texts, emails] = await Promise.all([
      this.req<{ notes?: { id: number; subject?: string; body?: string; created: string }[] }>("/notes", { query: q }).catch(() => ({ notes: [] })),
      this.req<{ calls?: { id: number; isIncoming?: boolean; note?: string; duration?: number; created: string }[] }>("/calls", { query: q }).catch(() => ({ calls: [] })),
      this.req<{ textmessages?: FubText[]; textMessages?: FubText[] }>("/textMessages", { query: q }).catch((): { textmessages?: FubText[]; textMessages?: FubText[] } => ({ textmessages: [] })),
      this.req<{ emails?: { id: number; isIncoming?: boolean; subject?: string; created: string }[] }>("/emails", { query: q }).catch(() => ({ emails: [] })),
    ]);
    const base = { opportunityId: String(personId), contactId: String(personId) };
    const out: Activity[] = [
      ...(notes.notes ?? []).map((n) => ({ ...base, id: `note_${n.id}`, kind: "note" as const, summary: [n.subject, n.body].filter(Boolean).join(": ").slice(0, 500), occurredAt: n.created })),
      ...(calls.calls ?? []).map((c) => ({
        ...base,
        id: `call_${c.id}`,
        kind: "call" as const,
        summary: c.note || `Call (${Math.round(Number(c.duration ?? 0))}s)`,
        occurredAt: c.created,
        direction: c.isIncoming ? ("inbound" as const) : ("outbound" as const),
      })),
      ...((texts.textmessages ?? texts.textMessages) ?? []).map((t) => ({
        ...base,
        id: `text_${t.id}`,
        kind: "sms" as const,
        summary: t.message ?? "",
        occurredAt: t.created ?? t.sent ?? "",
        direction: t.isIncoming ? ("inbound" as const) : ("outbound" as const),
      })),
      ...(emails.emails ?? []).map((e) => ({
        ...base,
        id: `email_${e.id}`,
        kind: "email" as const,
        summary: e.subject ?? "Email",
        occurredAt: e.created,
        direction: e.isIncoming ? ("inbound" as const) : ("outbound" as const),
      })),
    ];
    return out.filter((a) => a.occurredAt).sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  }

  async listRecentActivities(limit: number): Promise<Activity[]> {
    const q = { limit: Math.min(limit, 100), sort: "-created" };
    const [notes, calls] = await Promise.all([
      this.req<{ notes?: { id: number; personId: number; subject?: string; body?: string; created: string }[] }>("/notes", { query: q }).catch(() => ({ notes: [] })),
      this.req<{ calls?: { id: number; personId: number; isIncoming?: boolean; note?: string; created: string }[] }>("/calls", { query: q }).catch(() => ({ calls: [] })),
    ]);
    const out: Activity[] = [
      ...(notes.notes ?? []).map((n) => ({ id: `note_${n.id}`, opportunityId: String(n.personId), contactId: String(n.personId), kind: "note" as const, summary: [n.subject, n.body].filter(Boolean).join(": ").slice(0, 500), occurredAt: n.created })),
      ...(calls.calls ?? []).map((c) => ({
        id: `call_${c.id}`,
        opportunityId: String(c.personId),
        contactId: String(c.personId),
        kind: "call" as const,
        summary: c.note || "Call",
        occurredAt: c.created,
        direction: c.isIncoming ? ("inbound" as const) : ("outbound" as const),
      })),
    ];
    return out.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1)).slice(0, limit);
  }

  /** Everything the app does is recorded on the FUB timeline as a note (FUB can't send, only record). */
  async logActivity(input: Omit<Activity, "id">): Promise<Activity> {
    const personId = input.contactId || input.opportunityId;
    if (!personId) throw new Error("Follow Up Boss activity needs a person.");
    const subject =
      input.kind === "sms" ? "Realtor OS: text" : input.kind === "email" ? "Realtor OS: email" : input.kind === "call" ? "Realtor OS: call" : "Realtor OS";
    const note = await this.req<{ id: number; created?: string }>("/notes", {
      method: "POST",
      body: { personId: Number(personId), subject: input.direction === "inbound" ? `${subject} (received)` : subject, body: input.summary, isHtml: false },
    });
    return { ...input, id: `note_${note.id}`, occurredAt: note.created ?? input.occurredAt };
  }
}

interface FubText {
  id: number;
  isIncoming?: boolean;
  message?: string;
  created?: string;
  sent?: string;
}
