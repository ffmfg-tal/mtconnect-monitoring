import { describe, it, expect, beforeEach } from "vitest";
import { SELF } from "cloudflare:test";
import { resetDb, seedMachine, authHeaders, testEnv } from "./helpers";

describe("POST /ingest/rollups", () => {
  beforeEach(async () => {
    await resetDb();
    await seedMachine("haas-vf2-1");
  });

  it("upserts a minute rollup", async () => {
    const payload = [
      {
        machine_id: "haas-vf2-1",
        minute_bucket: "2026-04-18T14:00:00Z",
        active_seconds: 45,
        feed_hold_seconds: 0,
        stopped_seconds: 15,
        interrupted_seconds: 0,
        offline_seconds: 0,
        spindle_rpm_avg: 8200,
        spindle_load_avg: 38,
        spindle_load_max: 71,
        feedrate_avg: 118,
        feed_override_avg: 100,
        part_count_delta: 0,
        program: "O1001",
        tool_number: 3,
      },
    ];
    const res = await SELF.fetch("https://x/ingest/rollups", {
      method: "POST",
      headers: authHeaders("test-secret"),
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);

    const row = await testEnv()
      .DB.prepare(
        "SELECT active_seconds, spindle_rpm_avg FROM rollups_minute WHERE machine_id = ? AND minute_bucket = ?",
      )
      .bind("haas-vf2-1", "2026-04-18T14:00:00Z")
      .first<{ active_seconds: number; spindle_rpm_avg: number }>();
    expect(row?.active_seconds).toBe(45);
    expect(row?.spindle_rpm_avg).toBe(8200);
  });

  it("overwrites existing minute bucket on re-push", async () => {
    const base = {
      machine_id: "haas-vf2-1",
      minute_bucket: "2026-04-18T14:00:00Z",
      active_seconds: 30,
      feed_hold_seconds: 0,
      stopped_seconds: 30,
      interrupted_seconds: 0,
      offline_seconds: 0,
      part_count_delta: 0,
    };
    await SELF.fetch("https://x/ingest/rollups", {
      method: "POST",
      headers: authHeaders("test-secret"),
      body: JSON.stringify([base]),
    });
    await SELF.fetch("https://x/ingest/rollups", {
      method: "POST",
      headers: authHeaders("test-secret"),
      body: JSON.stringify([{ ...base, active_seconds: 60, stopped_seconds: 0 }]),
    });
    const row = await testEnv()
      .DB.prepare(
        "SELECT active_seconds FROM rollups_minute WHERE machine_id = ? AND minute_bucket = ?",
      )
      .bind("haas-vf2-1", "2026-04-18T14:00:00Z")
      .first<{ active_seconds: number }>();
    expect(row?.active_seconds).toBe(60);
  });
});
