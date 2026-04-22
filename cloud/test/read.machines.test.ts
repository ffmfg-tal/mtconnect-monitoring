import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./migrations";
import app from "../src/index";
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
    "INSERT INTO devices (device_uuid, name, model, controller_type) VALUES ('d1','Haas-VF2','VF-2','HAAS_NGC'),('d2','Okuma-P300','P300','OKUMA')",
  ).run();
  await e.DB.prepare(
    "INSERT INTO observations (device_uuid, sequence, timestamp_utc, data_item_id, value_str) VALUES ('d1',1,?,'exec','ACTIVE')",
  )
    .bind(new Date().toISOString())
    .run();
}

describe("GET /machines", () => {
  beforeEach(async () => {
    await reset();
  });

  it("lists all machines with name and controller_type", async () => {
    const res = await app.fetch(new Request("http://test/machines"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      machines: Array<{ device_uuid: string; name: string }>;
    };
    expect(body.machines.map((m) => m.name).sort()).toEqual([
      "Haas-VF2",
      "Okuma-P300",
    ]);
  });
});
