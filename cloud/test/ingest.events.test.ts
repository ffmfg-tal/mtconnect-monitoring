import { describe, it, expect, beforeEach } from "vitest";
import { SELF } from "cloudflare:test";
import { resetDb, seedMachine, authHeaders, testEnv } from "./helpers";

describe("POST /ingest/events", () => {
  beforeEach(async () => {
    await resetDb();
    await seedMachine("haas-vf2-1");
  });

  it("inserts an alarm event with JSON payload", async () => {
    const payload = [
      {
        machine_id: "haas-vf2-1",
        ts: "2026-04-18T14:05:00Z",
        kind: "alarm",
        severity: "fault",
        payload: { code: "1010", text: "Spindle overload" },
      },
    ];
    const res = await SELF.fetch("https://x/ingest/events", {
      method: "POST",
      headers: authHeaders("test-secret"),
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);

    const row = await testEnv()
      .DB.prepare("SELECT kind, severity, payload FROM events WHERE machine_id = ?")
      .bind("haas-vf2-1")
      .first<{ kind: string; severity: string; payload: string }>();
    expect(row?.kind).toBe("alarm");
    expect(row?.severity).toBe("fault");
    expect(JSON.parse(row!.payload)).toEqual({ code: "1010", text: "Spindle overload" });
  });

  it("handles empty payload field (null)", async () => {
    const payload = [
      {
        machine_id: "haas-vf2-1",
        ts: "2026-04-18T14:06:00Z",
        kind: "program_change",
        severity: "info",
      },
    ];
    const res = await SELF.fetch("https://x/ingest/events", {
      method: "POST",
      headers: authHeaders("test-secret"),
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
  });
});
