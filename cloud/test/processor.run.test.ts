import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./migrations";
import { runProcessor } from "../src/processor/run";
import type { Env } from "../src/types";

const e = env as unknown as Env;

async function reset() {
  await e.DB.prepare("DROP TABLE IF EXISTS observations").run();
  await e.DB.prepare("DROP TABLE IF EXISTS state_intervals").run();
  await e.DB.prepare("DROP TABLE IF EXISTS events").run();
  await e.DB.prepare("DROP TABLE IF EXISTS conditions").run();
  await e.DB.prepare("DROP TABLE IF EXISTS rollups_minute").run();
  await e.DB.prepare("DROP TABLE IF EXISTS rollups_shift").run();
  await e.DB.prepare("DROP TABLE IF EXISTS alerts").run();
  await e.DB.prepare("DROP TABLE IF EXISTS processor_cursors").run();
  await e.DB.prepare("DROP TABLE IF EXISTS data_items").run();
  await e.DB.prepare("DROP TABLE IF EXISTS devices").run();
  await applyMigrations(e);
  await e.DB.prepare(
    "INSERT INTO devices (device_uuid, name, current_instance_id) VALUES ('d1','Haas','i1')",
  ).run();
  await e.DB.prepare(
    "INSERT INTO data_items (device_uuid, data_item_id, category, type) VALUES ('d1','exec','EVENT','EXECUTION')",
  ).run();
}

async function insertObs(seq: number, ts: string, id: string, valueStr: string) {
  await e.DB.prepare(
    "INSERT INTO observations (device_uuid, sequence, timestamp_utc, data_item_id, value_str) VALUES ('d1',?,?,?,?)",
  )
    .bind(seq, ts, id, valueStr)
    .run();
}

describe("runProcessor", () => {
  beforeEach(async () => {
    await reset();
  });

  it("produces a state_interval from two EXECUTION observations", async () => {
    await insertObs(1, "2026-04-22T10:00:00Z", "exec", "ACTIVE");
    await insertObs(2, "2026-04-22T10:00:30Z", "exec", "READY");
    await runProcessor(e);
    const rows = await e.DB.prepare(
      "SELECT * FROM state_intervals WHERE device_uuid='d1'",
    ).all<{ state: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].state).toBe("ACTIVE");
  });

  it("produces a rollups_minute row with active_s = 30", async () => {
    await insertObs(1, "2026-04-22T10:00:00Z", "exec", "ACTIVE");
    await insertObs(2, "2026-04-22T10:00:30Z", "exec", "READY");
    await runProcessor(e);
    const row = await e.DB.prepare(
      "SELECT active_s FROM rollups_minute WHERE device_uuid='d1' AND minute_start='2026-04-22T10:00:00Z'",
    ).first<{ active_s: number }>();
    expect(row?.active_s).toBe(30);
  });

  it("advances cursors so a second run with no new obs is a no-op", async () => {
    await insertObs(1, "2026-04-22T10:00:00Z", "exec", "ACTIVE");
    await insertObs(2, "2026-04-22T10:00:30Z", "exec", "READY");
    await runProcessor(e);
    await runProcessor(e);
    const { count } = (await e.DB.prepare(
      "SELECT COUNT(*) AS count FROM state_intervals",
    ).first<{ count: number }>())!;
    expect(count).toBe(1);
  });
});
