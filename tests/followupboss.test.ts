import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FollowUpBossProvider, fubStageType, mapFubPerson } from "@/lib/crm/providers/followupboss";

/**
 * Follow Up Boss adapter, driven through realistic FUB API payloads with a mocked
 * fetch: asserts the requests it sends (endpoints, auth, bodies) and the
 * universal shapes it maps into.
 */

interface Call { url: string; method: string; body: unknown; auth?: string }
let calls: Call[] = [];

const STAGES = [
  { id: 2, name: "Lead", orderWeight: 1 },
  { id: 5, name: "Hot", orderWeight: 2 },
  { id: 9, name: "Closed", orderWeight: 3 },
  { id: 11, name: "Trash", orderWeight: 4 },
];
const PERSON = {
  id: 101,
  name: "Jane Roe",
  stage: "Hot",
  stageId: 5,
  source: "Zillow",
  assignedUserId: 7,
  price: 650000,
  created: "2026-01-01T00:00:00Z",
  updated: "2026-02-01T00:00:00Z",
  lastActivity: "2026-01-15T00:00:00Z",
  tags: ["Buyer"],
  emails: [{ value: "jane@x.com" }, { value: "old@x.com", status: "Bad" }],
  phones: [{ value: "(951) 555-0100", type: "mobile" }],
};

function route(url: string, init?: RequestInit): { status?: number; body: unknown } {
  const method = (init?.method ?? "GET").toUpperCase();
  const p = new URL(url).pathname.replace("/v1", "");
  if (method === "GET" && p === "/stages") return { body: { stages: STAGES } };
  if (method === "GET" && p === "/users") return { body: { users: [{ id: 7, name: "Kaleb Adams", email: "k@x.com" }] } };
  if (method === "GET" && p === "/people") return { body: { people: [PERSON], _metadata: { total: 1 } } };
  if (method === "GET" && p === "/people/101") return { body: PERSON };
  if (method === "PUT" && p === "/people/101") return { body: { ...PERSON, stage: "Closed", stageId: 9 } };
  if (method === "POST" && p === "/people") return { body: { ...PERSON, id: 202, name: "New Lead" } };
  if (method === "POST" && p === "/notes") return { body: { id: 55, created: "2026-03-01T00:00:00Z" } };
  if (method === "GET" && p === "/notes") return { body: { notes: [{ id: 1, subject: "Call back", body: "Tuesday", created: "2026-01-10T00:00:00Z" }] } };
  if (method === "GET" && p === "/calls") return { body: { calls: [{ id: 2, isIncoming: true, duration: 95, created: "2026-01-12T00:00:00Z" }] } };
  if (method === "GET" && p === "/textMessages") return { body: { textmessages: [{ id: 3, isIncoming: false, message: "Hi Jane", created: "2026-01-14T00:00:00Z" }] } };
  if (method === "GET" && p === "/emails") return { body: { emails: [] } };
  return { status: 404, body: { error: "not found" } };
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization });
    const r = route(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("Follow Up Boss provider", () => {
  it("is ready only with a key, and authenticates with Basic auth", async () => {
    expect(new FollowUpBossProvider().info().ready).toBe(Boolean(process.env.FUB_API_KEY));
    const fub = new FollowUpBossProvider("fka_test");
    expect(fub.info()).toMatchObject({ id: "followupboss", ready: true });
    await fub.listUsers();
    expect(calls[0].auth).toBe(`Basic ${Buffer.from("fka_test:").toString("base64")}`);
  });

  it("maps FUB stages to one pipeline with won/lost terminals", async () => {
    const [pipe] = await new FollowUpBossProvider("k").listPipelines();
    expect(pipe.id).toBe("fub");
    expect(pipe.stages.map((s) => [s.label, s.type])).toEqual([
      ["Lead", "open"],
      ["Hot", "open"],
      ["Closed", "won"],
      ["Trash", "lost"],
    ]);
  });

  it("maps a person to a contact, dropping bad emails", () => {
    const c = mapFubPerson(PERSON);
    expect(c.name).toBe("Jane Roe");
    expect(c.points).toEqual([
      { channel: "email", value: "jane@x.com", label: undefined },
      { channel: "phone", value: "(951) 555-0100", label: "mobile" },
    ]);
  });

  it("maps a person to an opportunity on the FUB pipeline", async () => {
    const [o] = await new FollowUpBossProvider("k").listOpportunities();
    expect(o).toMatchObject({ id: "101", contactId: "101", pipelineId: "fub", stageId: "5", value: 650000, ownerId: "7", lastActivityAt: "2026-01-15T00:00:00Z" });
  });

  it("filters by stage type", async () => {
    const fub = new FollowUpBossProvider("k");
    expect(await fub.listOpportunities({ stageType: "open" })).toHaveLength(1);
    expect(await fub.listOpportunities({ stageType: "won" })).toHaveLength(0);
  });

  it("moves a deal by setting the person's stage name", async () => {
    const o = await new FollowUpBossProvider("k").moveOpportunity("101", "9");
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toContain("/people/101");
    expect(put.body).toEqual({ stage: "Closed" });
    expect(o.stageId).toBe("9");
  });

  it("merges notes, calls, and texts into one newest-first timeline", async () => {
    const acts = await new FollowUpBossProvider("k").listActivities("101");
    expect(acts.map((a) => [a.kind, a.direction])).toEqual([
      ["sms", "outbound"],
      ["call", "inbound"],
      ["note", undefined],
    ]);
  });

  it("logs everything back to FUB as a note on the person", async () => {
    await new FollowUpBossProvider("k").logActivity({ contactId: "101", kind: "sms", summary: "Hey Jane", direction: "outbound", occurredAt: "2026-03-01T00:00:00Z" });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toContain("/notes");
    expect(post.body).toMatchObject({ personId: 101, subject: "Realtor OS: text", body: "Hey Jane" });
  });

  it("creates a person with deduplication", async () => {
    await new FollowUpBossProvider("k").createContact({ name: "New Lead", points: [{ channel: "phone", value: "5551234567" }] });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toContain("deduplicate=true");
    expect(post.body).toMatchObject({ firstName: "New", lastName: "Lead", phones: [{ value: "5551234567" }] });
  });

  it("classifies common real-estate stage names", () => {
    expect(fubStageType("Past Client")).toBe("won");
    expect(fubStageType("Non-Active")).toBe("lost");
    expect(fubStageType("Unresponsive/Stale")).toBe("open");
  });
});
