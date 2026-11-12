import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { closeSmsBody, sendViaClose, toE164 } from "@/lib/channels/close-sms";

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET" && url.includes("/contact/cont_1/")) return new Response(JSON.stringify({ id: "cont_1", lead_id: "lead_1" }), { status: 200 });
    if (method === "POST" && url.endsWith("/activity/sms/")) return new Response(JSON.stringify({ id: "acti_9", status: "outbox" }), { status: 200 });
    return new Response("{}", { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("Close texting", () => {
  it("normalizes US numbers to E.164", () => {
    expect(toE164("(951) 555-0123")).toBe("+19515550123");
    expect(toE164("19515550123")).toBe("+19515550123");
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("builds an outbox SMS from a fixed Close number", () => {
    expect(closeSmsBody({ leadId: "lead_1", contactId: "cont_1", to: "951-555-0123", text: "Hi", smsFrom: "9515550000" })).toEqual({
      lead_id: "lead_1",
      contact_id: "cont_1",
      status: "outbox",
      direction: "outbound",
      remote_phone: "+19515550123",
      text: "Hi",
      local_phone: "+19515550000",
    });
  });

  it("lets Close pick the number when none is set", () => {
    const b = closeSmsBody({ leadId: "l", to: "9515550123", text: "Hi" });
    expect(b.caller_id_mode).toBe("auto");
    expect(b.local_phone).toBeUndefined();
  });

  it("sends through Close for a Close contact", async () => {
    const r = await sendViaClose({ apiKey: "api_x" }, { to: "9515550123", body: "Hi", contactId: "cont_1" });
    expect(r).toEqual({ id: "acti_9", status: "queued", provider: "close" });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ lead_id: "lead_1", status: "outbox", remote_phone: "+19515550123" });
  });

  it("returns null (fall back to other transports) for non-Close contacts", async () => {
    expect(await sendViaClose({ apiKey: "api_x" }, { to: "9515550123", body: "Hi", contactId: "101" })).toBeNull();
    expect(await sendViaClose({ apiKey: "api_x" }, { to: "9515550123", body: "Hi" })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
