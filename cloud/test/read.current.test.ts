import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./migrations";
import app from "../src/index";
import type { Env } from "../src/types";

const e = env as unknown as Env;

async function seed() {
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
    "INSERT INTO devices (device_uuid, name) VALUES ('d1','Haas')",
  ).run();
  await e.DB.prepare(
    "INSERT INTO data_items (device_uuid, data_item_id, category, type) VALUES ('d1','exec','EVENT','EXECUTION'),('d1','rpm','SAMPLE','SPINDLE_SPEED')",
  ).run();
  await e.DB.prepare(
    "INSERT INTO observations (device_uuid, sequence, timestamp_utc, data_item_id, value_str) VALUES ('d1',1,'2026-04-22T09:59:00Z','exec','READY')",
  ).run();
  await e.DB.prepare(
    "INSERT INTO observations (device_uuid, sequence, timestamp_utc, data_item_id, value_str) VALUES ('d1',2,'2026-04-22T10:00:00Z','exec','ACTIVE')",
  ).run();
  await e.DB.prepare(
    "INSERT INTO observations (device_uuid, sequence, timestamp_utc, data_item_id, value_num, value_str) VALUES ('d1',3,'2026-04-22T10:00:01Z','rpm',1200,'1200')",
  ).run();
}

describe("GET /machines/:id/current", () => {
  beforeEach(seed);

  it("returns the latest observation per data_item_id", async () => {
    const res = await app.fetch(
      new Request("http://test/machines/d1/current"),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      observations: Record<string, unknown>[];
    };
    const byId = new Map(
      body.observations.map((o) => [(o as { data_item_id: string }).data_item_id, o]),
    );
    expect((byId.get("exec") as { value_str: string }).value_str).toBe(
      "ACTIVE",
    );
    expect((byId.get("rpm") as { value_num: number }).value_num).toBe(1200);
  });

  it("404s for unknown device", async () => {
    const res = await app.fetch(
      new Request("http://test/machines/nope/current"),
      env,
    );
    expect(res.status).toBe(404);
  });
});
