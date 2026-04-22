// cloud/test/ingest.observations.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./migrations";
import app from "../src/index";
import type { Env } from "../src/types";

const e = env as unknown as Env;

async function reset() {
  await e.DB.prepare("DROP TABLE IF EXISTS observations").run();
  await e.DB.prepare("DROP TABLE IF EXISTS data_items").run();
  await e.DB.prepare("DROP TABLE IF EXISTS devices").run();
  await e.DB.prepare("DROP TABLE IF EXISTS state_intervals").run();
  await e.DB.prepare("DROP TABLE IF EXISTS conditions").run();
  await e.DB.prepare("DROP TABLE IF EXISTS events").run();
  await e.DB.prepare("DROP TABLE IF EXISTS rollups_minute").run();
  await e.DB.prepare("DROP TABLE IF EXISTS rollups_shift").run();
  await e.DB.prepare("DROP TABLE IF EXISTS alerts").run();
  await e.DB.prepare("DROP TABLE IF EXISTS processor_cursors").run();
  await applyMigrations(e);
  // seed a device
  await e.DB.prepare(
    "INSERT INTO devices (device_uuid, name, current_instance_id) VALUES ('d1','Haas1','inst-1')",
  ).run();
}

function batch(n: number, startSeq = 1) {
  return {
    device_uuid: "d1",
    instance_id: "inst-1",
    batch: Array.from({ length: n }, (_, i) => ({
      sequence: startSeq + i,
      timestamp: new Date(Date.UTC(2026, 3, 22, 10, 0, i)).toISOString(),
      data_item_id: "exec",
      category: "EVENT",
      type: "EXECUTION",
      value_str: i % 2 === 0 ? "ACTIVE" : "READY",
    })),
  };
}

describe("POST /ingest/observations", () => {
  beforeEach(async () => {
    await reset();
  });

  it("401s without X-Edge-Secret", async () => {
    const res = await app.fetch(
      new Request("http://test/ingest/observations", {
        method: "POST",
        body: JSON.stringify(batch(1)),
        headers: { "content-type": "application/json" },
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("upserts observations and returns high water sequence", async () => {
    const res = await app.fetch(
      new Request("http://test/ingest/observations", {
        method: "POST",
        body: JSON.stringify(batch(10)),
        headers: {
          "content-type": "application/json",
          "X-Edge-Secret": e.EDGE_SHARED_SECRET,
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { high_water_sequence: number };
    expect(body.high_water_sequence).toBe(10);

    const { count } = (await e.DB.prepare(
      "SELECT COUNT(*) AS count FROM observations WHERE device_uuid='d1'",
    ).first<{ count: number }>())!;
    expect(count).toBe(10);
  });

  it("is idempotent on re-post", async () => {
    const headers = {
      "content-type": "application/json",
      "X-Edge-Secret": e.EDGE_SHARED_SECRET,
    };
    const body = JSON.stringify(batch(5));
    await app.fetch(
      new Request("http://test/ingest/observations", {
        method: "POST",
        body,
        headers,
      }),
      env,
    );
    await app.fetch(
      new Request("http://test/ingest/observations", {
        method: "POST",
        body,
        headers,
      }),
      env,
    );
    const { count } = (await e.DB.prepare(
      "SELECT COUNT(*) AS count FROM observations",
    ).first<{ count: number }>())!;
    expect(count).toBe(5);
  });

  it("400s when device does not exist", async () => {
    const res = await app.fetch(
      new Request("http://test/ingest/observations", {
        method: "POST",
        body: JSON.stringify({ ...batch(1), device_uuid: "unknown" }),
        headers: {
          "content-type": "application/json",
          "X-Edge-Secret": e.EDGE_SHARED_SECRET,
        },
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("updates current_instance_id when batch carries a new one", async () => {
    const headers = {
      "content-type": "application/json",
      "X-Edge-Secret": e.EDGE_SHARED_SECRET,
    };
    const newBatch = { ...batch(1), instance_id: "inst-2" };
    await app.fetch(
      new Request("http://test/ingest/observations", {
        method: "POST",
        body: JSON.stringify(newBatch),
        headers,
      }),
      env,
    );
    const d = (await e.DB.prepare(
      "SELECT current_instance_id FROM devices WHERE device_uuid='d1'",
    ).first<{ current_instance_id: string }>())!;
    expect(d.current_instance_id).toBe("inst-2");
  });
});
