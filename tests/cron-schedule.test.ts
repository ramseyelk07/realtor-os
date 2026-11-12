import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The autopilot only reaches prospects within their 8am–9pm local window and
 * holds the rest for the next run, so the cron MUST tick through the day. A
 * once-daily schedule (especially at a US-night UTC hour) silently means the
 * agent never calls. Guard the frequency so it can't regress.
 */
describe("autopilot cron schedule", () => {
  const cfg = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as {
    crons?: { path: string; schedule: string }[];
  };

  it("registers the agent cron", () => {
    const cron = cfg.crons?.find((c) => c.path === "/api/agent/cron");
    expect(cron, "vercel.json must register /api/agent/cron").toBeDefined();
  });

  it("runs at least hourly, never just once a day", () => {
    const cron = cfg.crons?.find((c) => c.path === "/api/agent/cron");
    const hourField = cron!.schedule.trim().split(/\s+/)[1]; // min hour dom mon dow
    // "*" (every hour) or a list/range/step is fine; a single fixed hour is NOT —
    // unless the hourly tick comes from the GitHub Actions fallback (Vercel Hobby
    // rejects sub-daily crons, so those deployments keep a daily Vercel cron and
    // tick hourly through .github/workflows/autopilot.yml instead).
    const isSingleFixedHour = /^\d+$/.test(hourField);
    const workflow = join(process.cwd(), ".github/workflows/autopilot.yml");
    const hourlyFallback = existsSync(workflow) && /cron:\s*"0 \* \* \* \*"/.test(readFileSync(workflow, "utf8"));
    expect(isSingleFixedHour && !hourlyFallback, `cron hour "${hourField}" runs once a day — the agent would skip everyone in quiet hours`).toBe(false);
  });
});
