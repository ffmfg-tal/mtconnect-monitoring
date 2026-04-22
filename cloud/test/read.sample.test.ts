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
  for (let i = 0; i < 10; i++) {
    await e.DB.prepare(
      "INSERT INTO observations (device_uuid, sequence, timestamp_utc, data_item_id, value_str, value_num) VALUES ('d1',?,?,?,?,?)",
    )
      .bind(
        i + 1,
        new Date(Date.UTC(2026, 3, 22, 10, 0, i)).toISOString(),
        i % 2 === 0 ? "exec" : "rpm",
        i % 2 === 0 ? "ACTIVE" : "1200",
        i % 2 === 0 ? null : 1200,
      )
      .run();
  }
}

describe("GET /machines/:id/sample", () => {
  beforeEach(seed);

  it("returns observations in the window", async () => {
    const res = await app.fetch(
      new Request(
        "http://test/machines/d1/sample?from=2026-04-22T10:00:00Z&to=2026-04-22T10:00:10Z",
      ),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { observations: unknown[] };
    expect(body.observations.length).toBe(10);
  });

  it("filters by types csv", async () => {
    const res = await app.fetch(
      new Request(
        "http://test/machines/d1/sample?from=2026-04-22T10:00:00Z&to=2026-04-22T10:00:10Z&types=EXECUTION",
      ),
      env,
    );
    const body = (await res.json()) as {
      observations: { data_item_id: string }[];
    };
    expect(body.observations.every((o) => o.data_item_id === "exec")).toBe(
      true,
    );
  });
});
