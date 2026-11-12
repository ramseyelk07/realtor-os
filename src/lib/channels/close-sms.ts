/**
 * Texting through the agent's own Close account.
 *
 * Close is one of the few CRMs whose API actually SENDS a text (an SMS activity
 * created with status "outbox" goes out from one of the account's Close numbers).
 * So an agent who already has an A2P-registered number in Close can text leads
 * from that number with no Twilio setup at all — and every message lands in
 * Close's own conversation view.
 *
 * Opt-in per workspace: the org connects Close (Settings → Connect your CRM) and
 * sets "Send texts through Close" to true. Otherwise nothing here runs and SMS
 * resolves through the normal transports (webhook / Twilio / log).
 *
 * Replies: pollCloseInboundSms() runs on the cron tick, picks up inbound texts
 * Close received since the last tick, and hands each to the normal inbound
 * handler (logs it, stops cadences, honors STOP, drafts/sends the AI reply).
 */
import type { SendResult } from "@/lib/comms";
import { fetchWithRetry } from "@/lib/crm/net";

const API = "https://api.close.com/api/v1";

export interface CloseSmsConfig {
  apiKey: string;
  /** E.164 Close number to text from; blank → Close picks (caller_id_mode auto). */
  smsFrom?: string;
}

/** US-default E.164 normalizer: "(951) 555-0123" → "+19515550123". */
export function toE164(raw: string): string {
  const s = String(raw ?? "").trim();
  if (s.startsWith("+")) return `+${s.slice(1).replace(/\D/g, "")}`;
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d ? `+${d}` : "";
}

async function closeReq<T>(cfg: CloseSmsConfig, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetchWithRetry(`${API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.apiKey}:`).toString("base64")}`,
      Accept: "application/json",
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Close API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<T>;
}

/** The current org's Close texting config, or null when not opted in. */
export async function closeSmsConfig(): Promise<CloseSmsConfig | null> {
  try {
    const { getConnection } = await import("@/lib/connections/store");
    const c = await getConnection("close");
    if (!c?.secrets.apiKey || String(c.config.smsEnabled ?? "").toLowerCase() !== "true") return null;
    return { apiKey: c.secrets.apiKey, smsFrom: c.config.smsFrom?.trim() || undefined };
  } catch {
    return null;
  }
}

/** The request body Close needs to send a text now. Pure (unit-tested). */
export function closeSmsBody(input: { leadId: string; contactId?: string; to: string; text: string; smsFrom?: string }): Record<string, unknown> {
  return {
    lead_id: input.leadId,
    ...(input.contactId ? { contact_id: input.contactId } : {}),
    status: "outbox",
    direction: "outbound",
    remote_phone: toE164(input.to),
    text: input.text,
    ...(input.smsFrom ? { local_phone: toE164(input.smsFrom) } : { caller_id_mode: "auto" }),
  };
}

/**
 * Send one text through Close. Needs the Close contact id (the workspace's CRM is
 * Close, so contact ids ARE Close contact ids) to find the lead. Returns null when
 * this can't be sent through Close (no contact id / not a Close contact), so the
 * caller falls back to the other transports.
 */
export async function sendViaClose(cfg: CloseSmsConfig, m: { to: string; body: string; contactId?: string }): Promise<SendResult | null> {
  if (!m.contactId || !m.contactId.startsWith("cont_")) return null;
  let leadId: string | undefined;
  try {
    leadId = (await closeReq<{ lead_id?: string }>(cfg, `/contact/${encodeURIComponent(m.contactId)}/`)).lead_id;
  } catch {
    return null;
  }
  if (!leadId) return null;
  try {
    const r = await closeReq<{ id: string; status?: string }>(cfg, "/activity/sms/", {
      method: "POST",
      body: closeSmsBody({ leadId, contactId: m.contactId, to: m.to, text: m.body, smsFrom: cfg.smsFrom }),
    });
    return { id: r.id, status: "queued", provider: "close" };
  } catch (e) {
    return { id: "", status: "failed", provider: "close", detail: e instanceof Error ? e.message : "Close send failed" };
  }
}

interface CloseSmsActivity {
  id: string;
  direction?: string;
  status?: string;
  remote_phone?: string;
  text?: string;
  date_created: string;
}

/**
 * Pull inbound texts Close received since the last tick and run each through the
 * normal inbound handler. The cursor lives in the Close connection's config.
 * Each message is processed once (dedup by Close activity id).
 */
export async function pollCloseInboundSms(): Promise<{ processed: number } | { skipped: string }> {
  const cfg = await closeSmsConfig();
  if (!cfg) return { skipped: "close sms not enabled" };
  const { getConnection, saveConnection } = await import("@/lib/connections/store");
  const conn = await getConnection("close");
  if (!conn) return { skipped: "no close connection" };

  const now = new Date().toISOString();
  // First run starts from now, so turning this on never replays old history.
  const since = conn.config.smsCursor || now;
  let processed = 0;
  let cursor = now;
  if (conn.config.smsCursor) {
    const r = await closeReq<{ data: CloseSmsActivity[] }>(cfg, `/activity/sms/?date_created__gt=${encodeURIComponent(since)}&_limit=100`);
    const page = [...(r.data ?? [])].sort((a, b) => (a.date_created < b.date_created ? -1 : 1));
    // A full page means there may be more: advance only to the last one seen so
    // the next tick continues from there instead of skipping the rest.
    if (page.length >= 100) cursor = page[page.length - 1].date_created;
    const inbound = page.filter((a) => a.direction === "inbound" && a.remote_phone && a.text);
    const { seenInboundEvent, forgetInboundEvent } = await import("@/lib/inbound-dedup");
    const { handleInbound } = await import("@/lib/inbound");
    for (const a of inbound) {
      if (await seenInboundEvent("close-sms", a.id)) continue;
      try {
        await handleInbound("sms", a.remote_phone!, a.text!);
        processed++;
      } catch {
        await forgetInboundEvent("close-sms", a.id);
      }
    }
  }
  await saveConnection({ kind: conn.kind, provider: "close", accountRef: conn.accountRef, secrets: conn.secrets, config: { ...conn.config, smsCursor: cursor } });
  return { processed };
}
