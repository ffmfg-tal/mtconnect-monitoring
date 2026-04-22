import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./migrations";
import { parseProbe } from "../src/xml/probe";
import { parseStreams } from "../src/xml/streams";
import { runProcessor } from "../src/processor/run";
import type { Env } from "../src/types";
// @ts-expect-error — vite ?raw import returns string
import probeXml from "./fixtures/demo_probe.xml?raw";
// @ts-expect-error — vite ?raw import returns string
import sampleXml from "./fixtures/demo_sample_1m.xml?raw";
// @ts-expect-error — vite ?raw import returns string; golden file may not exist yet
import goldenRaw from "./fixtures/golden_state_intervals.json?raw";

const e = env as unknown as Env;

async function seedFromFixtures() {
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

  const probe = parseProbe(probeXml as string);
  for (const d of probe.devices) {
    await e.DB.prepare(
      "INSERT INTO devices (device_uuid, name, current_instance_id) VALUES (?,?,?)",
    )
      .bind(d.uuid, d.name, probe.header.instanceId)
      .run();
    for (const di of d.dataItems) {
      await e.DB.prepare(
        "INSERT INTO data_items (device_uuid, data_item_id, category, type, sub_type, units, native_units, component_path) VALUES (?,?,?,?,?,?,?,?)",
      )
        .bind(
          d.uuid,
          di.id,
          di.category,
          di.type,
          di.subType ?? null,
          di.units ?? null,
          di.nativeUnits ?? null,
          di.componentPath,
        )
        .run();
    }
  }

  const parsed = parseStreams(sampleXml as string);
  for (const o of parsed.observations) {
    await e.DB.prepare(
      "INSERT OR IGNORE INTO observations (device_uuid, sequence, timestamp_utc, data_item_id, value_num, value_str, condition_level, condition_native_code, condition_severity, condition_qualifier) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        o.deviceUuid,
        o.sequence,
        o.timestamp,
        o.dataItemId,
        o.valueNum,
        o.valueStr,
        o.conditionLevel ?? null,
        o.conditionNativeCode ?? null,
        o.conditionSeverity ?? null,
        o.conditionQualifier ?? null,
      )
      .run();
  }
}

describe("shadow integration", () => {
  beforeEach(seedFromFixtures);

  it("produces derived tables that match the golden file", async () => {
    await runProcessor(e);
    const intervals = await e.DB.prepare(
      "SELECT device_uuid, started_at, ended_at, state FROM state_intervals ORDER BY device_uuid, started_at",
    ).all();

    // To regenerate the golden file, run `npm run gen:golden` from cloud/.
    // vitest-pool-workers runs tests inside workerd, so we can't writeFileSync
    // from inside this test body.
    const golden = JSON.parse(goldenRaw as string);
    expect(intervals.results).toEqual(golden);
  });
});
