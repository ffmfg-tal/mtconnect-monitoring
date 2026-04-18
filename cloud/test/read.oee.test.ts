import { describe, it, expect, beforeEach } from "vitest";
import { SELF } from "cloudflare:test";
import { resetDb, seedMachine, testEnv } from "./helpers";

describe("GET /machines/:id/oee", () => {
  beforeEach(async () => {
    await resetDb();
    await seedMachine("haas-vf2-1");
  });

  it("returns zero availability when no rollups exist", async () => {
    const res = await SELF.fetch("https://x/machines/haas-vf2-1/oee?date=2026-04-18");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { availability: number; utilization: number };
    expect(body.availability).toBe(0);
    expect(body.utilization).toBe(0);
  });

  it("computes availability + utilization from minute rollups for the date", async () => {
    const stmts = [];
    for (let i = 0; i < 60; i++) {
      const bucket = `2026-04-18T14:${String(i).padStart(2, "0")}:00Z`;
      stmts.push(
        testEnv()
          .DB.prepare(
            `INSERT INTO rollups_minute
              (machine_id, minute_bucket, active_seconds, feed_hold_seconds, stopped_seconds,
               interrupted_seconds, offline_seconds, part_count_delta)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind("haas-vf2-1", bucket, 45, 5, 10, 0, 0, 0),
      );
    }
    await testEnv().DB.batch(stmts);

    const res = await SELF.fetch("https://x/machines/haas-vf2-1/oee?date=2026-04-18");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      active_seconds: number;
      scheduled_seconds: number;
      availability: number;
      utilization: number;
    };
    expect(body.active_seconds).toBe(45 * 60);
    expect(body.availability).toBeGreaterThan(0);
    expect(body.utilization).toBeGreaterThan(0);
  });
});
