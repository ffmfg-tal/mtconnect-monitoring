import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./migrations";
import app from "../src/index";
import type { Env } from "../src/types";

const e = env as unknown as Env;

async function seed() {
  await e.DB.prepare("DROP TABLE IF EXISTS rollups_minute").run();
  await e.DB.prepare("DROP TABLE IF EXISTS rollups_shift").run();
  await e.DB.prepare("DROP TABLE IF EXISTS alerts").run();
  await e.DB.prepare("DROP TABLE IF EXISTS observations").run();
  await e.DB.prepare("DROP TABLE IF EXISTS state_intervals").run();
  await e.DB.prepare("DROP TABLE IF EXISTS events").run();
  await e.DB.prepare("DROP TABLE IF EXISTS conditions").run();
  await e.DB.prepare("DROP TABLE IF EXISTS processor_cursors").run();
  await e.DB.prepare("DROP TABLE IF EXISTS data_items").run();
  await e.DB.prepare("DROP TABLE IF EXISTS devices").run();
  await applyMigrations(e);
  await e.DB.prepare(
    "INSERT INTO devices (device_uuid, name) VALUES ('d1','Haas')",
  ).run();
  await e.DB.prepare(
    `INSERT INTO rollups_minute (device_uuid, minute_start, active_s, feed_hold_s, stopped_s, interrupted_s, offline_s, part_delta)
     VALUES ('d1','2026-04-22T10:00:00Z',30,10,20,0,0,0),
            ('d1','2026-04-22T10:01:00Z',60,0,0,0,0,1)`,
  ).run();
}

describe("GET /machines/:id/utilization", () => {
  beforeEach(seed);

  it("returns availability_pct and utilization_pct over a day", async () => {
    const res = await app.fetch(
      new Request("http://test/machines/d1/utilization?date=2026-04-22"),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      availability_pct: number;
      utilization_pct: number;
      part_count: number;
      scheduled_seconds: number;
    };
    expect(body.scheduled_seconds).toBe(28800);
    expect(body.utilization_pct).toBeCloseTo(90 / 28800, 5);
    expect(body.availability_pct).toBeCloseTo(100 / 28800, 5);
    expect(body.part_count).toBe(1);
  });
});
