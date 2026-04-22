import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./migrations";
import { computeShiftRollup } from "../src/shift/rollup";
import type { Env } from "../src/types";

const e = env as unknown as Env;

async function seed() {
  await e.DB.prepare("DROP TABLE IF EXISTS rollups_shift").run();
  await e.DB.prepare("DROP TABLE IF EXISTS rollups_minute").run();
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
    `INSERT INTO rollups_minute (device_uuid, minute_start, active_s, feed_hold_s, stopped_s, part_delta)
     VALUES ('d1','2026-04-22T10:00:00Z',60,0,0,1),('d1','2026-04-22T10:01:00Z',60,0,0,1)`,
  ).run();
  await e.DB.prepare(
    "INSERT INTO alerts (device_uuid, kind, severity, triggered_at) VALUES ('d1','alarm_sustained','fault','2026-04-22T10:00:30Z')",
  ).run();
}

describe("computeShiftRollup", () => {
  beforeEach(seed);

  it("writes a rollups_shift row for the given date", async () => {
    await computeShiftRollup(e, "2026-04-22");
    const row = await e.DB.prepare(
      "SELECT * FROM rollups_shift WHERE device_uuid='d1' AND shift_date='2026-04-22'",
    ).first<{
      part_count: number;
      alarm_count: number;
      utilization_pct: number;
    }>();
    expect(row).not.toBeNull();
    expect(row!.part_count).toBe(2);
    expect(row!.alarm_count).toBe(1);
  });
});
