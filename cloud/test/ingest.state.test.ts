import { describe, it, expect, beforeEach } from "vitest";
import { SELF } from "cloudflare:test";
import { resetDb, seedMachine, authHeaders, testEnv } from "./helpers";

describe("POST /ingest/state", () => {
  beforeEach(async () => {
    await resetDb();
    await seedMachine("haas-vf2-1");
  });

  it("inserts a closed interval", async () => {
    const payload = [
      {
        machine_id: "haas-vf2-1",
        state: "ACTIVE",
        started_at: "2026-04-18T14:00:00Z",
        ended_at: "2026-04-18T14:12:00Z",
        duration_seconds: 720,
        program: "O1001",
        tool_number: 3,
      },
    ];
    const res = await SELF.fetch("https://x/ingest/state", {
      method: "POST",
      headers: authHeaders("test-secret"),
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 1 });

    const row = await testEnv()
      .DB.prepare(
        "SELECT state, duration_seconds, program FROM state_intervals WHERE machine_id = ?",
      )
      .bind("haas-vf2-1")
      .first();
    expect(row).toEqual({ state: "ACTIVE", duration_seconds: 720, program: "O1001" });
  });

  it("rejects unknown machine_id with 400", async () => {
    const payload = [
      {
        machine_id: "ghost",
        state: "ACTIVE",
        started_at: "2026-04-18T14:00:00Z",
        ended_at: "2026-04-18T14:01:00Z",
        duration_seconds: 60,
      },
    ];
    const res = await SELF.fetch("https://x/ingest/state", {
      method: "POST",
      headers: authHeaders("test-secret"),
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
  });

  it("is idempotent on exact duplicate", async () => {
    const payload = [
      {
        machine_id: "haas-vf2-1",
        state: "ACTIVE",
        started_at: "2026-04-18T14:00:00Z",
        ended_at: "2026-04-18T14:12:00Z",
        duration_seconds: 720,
      },
    ];
    await SELF.fetch("https://x/ingest/state", {
      method: "POST",
      headers: authHeaders("test-secret"),
      body: JSON.stringify(payload),
    });
    const res2 = await SELF.fetch("https://x/ingest/state", {
      method: "POST",
      headers: authHeaders("test-secret"),
      body: JSON.stringify(payload),
    });
    expect(res2.status).toBe(200);

    const row = (await testEnv()
      .DB.prepare("SELECT COUNT(*) AS count FROM state_intervals WHERE machine_id = ?")
      .bind("haas-vf2-1")
      .first<{ count: number }>()) as { count: number };
    expect(row.count).toBe(1);
  });
});
