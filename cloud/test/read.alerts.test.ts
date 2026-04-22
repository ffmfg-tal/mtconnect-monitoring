import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./migrations";
import app from "../src/index";
import type { Env } from "../src/types";

const e = env as unknown as Env;

async function seed() {
  await e.DB.prepare("DROP TABLE IF EXISTS alerts").run();
  await e.DB.prepare("DROP TABLE IF EXISTS observations").run();
  await e.DB.prepare("DROP TABLE IF EXISTS state_intervals").run();
  await e.DB.prepare("DROP TABLE IF EXISTS events").run();
  await e.DB.prepare("DROP TABLE IF EXISTS conditions").run();
  await e.DB.prepare("DROP TABLE IF EXISTS rollups_minute").run();
  await e.DB.prepare("DROP TABLE IF EXISTS rollups_shift").run();
  await e.DB.prepare("DROP TABLE IF EXISTS processor_cursors").run();
  await e.DB.prepare("DROP TABLE IF EXISTS data_items").run();
  await e.DB.prepare("DROP TABLE IF EXISTS devices").run();
  await applyMigrations(e);
  await e.DB.prepare(
    "INSERT INTO devices (device_uuid, name) VALUES ('d1','Haas')",
  ).run();
  await e.DB.prepare(
    "INSERT INTO alerts (device_uuid, kind, severity, triggered_at, message) VALUES ('d1','offline','fault','2026-04-22T10:00:00Z','no data')",
  ).run();
  await e.DB.prepare(
    "INSERT INTO alerts (device_uuid, kind, severity, triggered_at, cleared_at, message) VALUES ('d1','feed_hold_extended','warning','2026-04-22T09:50:00Z','2026-04-22T09:55:00Z','cleared')",
  ).run();
}

describe("alerts API", () => {
  beforeEach(seed);

  it("GET /alerts returns only open by default", async () => {
    const res = await app.fetch(new Request("http://test/alerts"), env);
    const body = (await res.json()) as { alerts: unknown[] };
    expect(body.alerts.length).toBe(1);
  });

  it("GET /alerts?include_cleared=1 returns all", async () => {
    const res = await app.fetch(
      new Request("http://test/alerts?include_cleared=1"),
      env,
    );
    const body = (await res.json()) as { alerts: unknown[] };
    expect(body.alerts.length).toBe(2);
  });

  it("POST /alerts/:id/ack sets acknowledged_by and acknowledged_at", async () => {
    const open = await e.DB.prepare(
      "SELECT id FROM alerts WHERE cleared_at IS NULL",
    ).first<{ id: number }>();
    const res = await app.fetch(
      new Request(`http://test/alerts/${open!.id}/ack`, {
        method: "POST",
        body: JSON.stringify({ acknowledged_by: "tal" }),
        headers: { "content-type": "application/json" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const row = await e.DB.prepare(
      "SELECT acknowledged_by FROM alerts WHERE id = ?",
    )
      .bind(open!.id)
      .first<{ acknowledged_by: string }>();
    expect(row!.acknowledged_by).toBe("tal");
  });
});
