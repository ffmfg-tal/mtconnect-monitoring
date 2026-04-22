// cloud/test/ingest.probe.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./migrations";
import app from "../src/index";
import { parseProbe } from "../src/xml/probe";
import type { Env } from "../src/types";
// @ts-expect-error — vite ?raw import returns string
import probeXml from "./fixtures/demo_probe.xml?raw";

function payload() {
  const parsed = parseProbe(probeXml);
  const d = parsed.devices[0];
  return {
    device_uuid: d.uuid,
    name: d.name,
    model: d.model ?? null,
    controller_type: null,
    controller_vendor: null,
    mtconnect_version: parsed.header.schemaVersion,
    instance_id: parsed.header.instanceId,
    probe_xml: probeXml,
    data_items: d.dataItems,
  };
}

describe("POST /ingest/probe", () => {
  beforeEach(async () => {
    await (env as unknown as Env).DB.prepare("DROP TABLE IF EXISTS data_items").run();
    await (env as unknown as Env).DB.prepare("DROP TABLE IF EXISTS devices").run();
    await (env as unknown as Env).DB.prepare("DROP TABLE IF EXISTS observations").run();
    await (env as unknown as Env).DB.prepare("DROP TABLE IF EXISTS state_intervals").run();
    await (env as unknown as Env).DB.prepare("DROP TABLE IF EXISTS conditions").run();
    await (env as unknown as Env).DB.prepare("DROP TABLE IF EXISTS events").run();
    await (env as unknown as Env).DB.prepare("DROP TABLE IF EXISTS rollups_minute").run();
    await (env as unknown as Env).DB.prepare("DROP TABLE IF EXISTS rollups_shift").run();
    await (env as unknown as Env).DB.prepare("DROP TABLE IF EXISTS alerts").run();
    await (env as unknown as Env).DB.prepare("DROP TABLE IF EXISTS processor_cursors").run();
    await applyMigrations(env as unknown as Env);
  });

  it("401s without X-Edge-Secret", async () => {
    const res = await app.fetch(
      new Request("http://test/ingest/probe", {
        method: "POST",
        body: JSON.stringify(payload()),
        headers: { "content-type": "application/json" },
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("upserts device + data_items and returns 200", async () => {
    const res = await app.fetch(
      new Request("http://test/ingest/probe", {
        method: "POST",
        body: JSON.stringify(payload()),
        headers: {
          "content-type": "application/json",
          "X-Edge-Secret": (env as unknown as Env).EDGE_SHARED_SECRET,
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const { count } = (await (env as unknown as Env).DB.prepare(
      "SELECT COUNT(*) AS count FROM data_items",
    ).first<{ count: number }>())!;
    expect(count).toBeGreaterThan(0);
  });

  it("replaces data_items on re-post (no duplicates)", async () => {
    const p = payload();
    const headers = {
      "content-type": "application/json",
      "X-Edge-Secret": (env as unknown as Env).EDGE_SHARED_SECRET,
    };
    await app.fetch(
      new Request("http://test/ingest/probe", {
        method: "POST",
        body: JSON.stringify(p),
        headers,
      }),
      env,
    );
    const first = (await (env as unknown as Env).DB.prepare(
      "SELECT COUNT(*) AS count FROM data_items",
    ).first<{ count: number }>())!.count;
    await app.fetch(
      new Request("http://test/ingest/probe", {
        method: "POST",
        body: JSON.stringify(p),
        headers,
      }),
      env,
    );
    const second = (await (env as unknown as Env).DB.prepare(
      "SELECT COUNT(*) AS count FROM data_items",
    ).first<{ count: number }>())!.count;
    expect(second).toBe(first);
  });
});
