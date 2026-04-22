import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./migrations";
import { runAlertScanner } from "../src/alerts/scanner";
import type { Env } from "../src/types";

const e = env as unknown as Env;

async function reset() {
  await e.DB.prepare("DROP TABLE IF EXISTS alerts").run();
  await e.DB.prepare("DROP TABLE IF EXISTS processor_cursors").run();
  await e.DB.prepare("DROP TABLE IF EXISTS conditions").run();
  await e.DB.prepare("DROP TABLE IF EXISTS observations").run();
  await e.DB.prepare("DROP TABLE IF EXISTS state_intervals").run();
  await e.DB.prepare("DROP TABLE IF EXISTS events").run();
  await e.DB.prepare("DROP TABLE IF EXISTS rollups_minute").run();
  await e.DB.prepare("DROP TABLE IF EXISTS rollups_shift").run();
  await e.DB.prepare("DROP TABLE IF EXISTS data_items").run();
  await e.DB.prepare("DROP TABLE IF EXISTS devices").run();
  await applyMigrations(e);
  await e.DB.prepare(
    "INSERT INTO devices (device_uuid, name) VALUES ('d1','Haas1')",
  ).run();
}

describe("runAlertScanner", () => {
  beforeEach(async () => {
    await reset();
  });

  it("fires an offline alert when there are no observations", async () => {
    await runAlertScanner(e);
    const rows = await e.DB.prepare("SELECT kind FROM alerts").all<{
      kind: string;
    }>();
    expect(rows.results.map((r) => r.kind)).toContain("offline");
  });

  it("auto-clears an offline alert once observations arrive", async () => {
    await runAlertScanner(e);
    await e.DB.prepare(
      "INSERT INTO observations (device_uuid, sequence, timestamp_utc, data_item_id, value_str) VALUES ('d1',1,?, 'exec','ACTIVE')",
    )
      .bind(new Date().toISOString())
      .run();
    await runAlertScanner(e);
    const open = await e.DB.prepare(
      "SELECT id FROM alerts WHERE device_uuid='d1' AND kind='offline' AND cleared_at IS NULL",
    ).first();
    expect(open).toBeNull();
  });
});
