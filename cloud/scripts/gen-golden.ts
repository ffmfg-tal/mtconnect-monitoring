// scripts/gen-golden.ts
// Regenerate cloud/test/fixtures/golden_state_intervals.json by replaying
// the demo fixtures through the pure state-machine processor. Does NOT
// touch D1, so this runs on plain Node with tsx.
//
// Run: `npx tsx scripts/gen-golden.ts`

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProbe } from "../src/xml/probe";
import { parseStreams } from "../src/xml/streams";
import {
  deriveStateIntervals,
  type DataItemMeta,
  type ObservationRow,
  type StateMachineCursor,
} from "../src/processor/state_machine";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "test", "fixtures");

const probeXml = readFileSync(join(fixturesDir, "demo_probe.xml"), "utf8");
const sampleXml = readFileSync(
  join(fixturesDir, "demo_sample_1m.xml"),
  "utf8",
);

const probe = parseProbe(probeXml);
const sample = parseStreams(sampleXml);

// Build per-device data item meta map
const perDeviceMeta = new Map<string, Map<string, DataItemMeta>>();
for (const d of probe.devices) {
  const m = new Map<string, DataItemMeta>();
  for (const di of d.dataItems) {
    m.set(di.id, { type: di.type, category: di.category });
  }
  perDeviceMeta.set(d.uuid, m);
}

// Group observations per device and run the pure state machine per device
type Interval = {
  device_uuid: string;
  started_at: string;
  ended_at: string;
  state: string;
};
const intervals: Interval[] = [];

const byDevice = new Map<string, ObservationRow[]>();
for (const o of sample.observations) {
  const list = byDevice.get(o.deviceUuid) ?? [];
  list.push({
    sequence: o.sequence,
    timestamp_utc: o.timestamp,
    data_item_id: o.dataItemId,
    value_num: o.valueNum,
    value_str: o.valueStr,
    condition_level: o.conditionLevel ?? null,
  });
  byDevice.set(o.deviceUuid, list);
}

for (const [uuid, obs] of byDevice) {
  const meta = perDeviceMeta.get(uuid);
  if (!meta) continue;
  obs.sort((a, b) => a.sequence - b.sequence);
  const cursor: StateMachineCursor = {
    lastState: null,
    lastStateStart: null,
    lastProgram: null,
    lastTool: null,
    lastControllerMode: null,
    enteringProgram: null,
    enteringTool: null,
    enteringControllerMode: null,
  };
  const { closedIntervals } = deriveStateIntervals(obs, meta, cursor);
  for (const iv of closedIntervals) {
    intervals.push({
      device_uuid: uuid,
      started_at: iv.started_at,
      ended_at: iv.ended_at,
      state: iv.state,
    });
  }
}

intervals.sort((a, b) => {
  if (a.device_uuid !== b.device_uuid)
    return a.device_uuid < b.device_uuid ? -1 : 1;
  return a.started_at < b.started_at ? -1 : 1;
});

const outPath = join(fixturesDir, "golden_state_intervals.json");
writeFileSync(outPath, JSON.stringify(intervals, null, 2) + "\n");
console.log(`Wrote ${intervals.length} intervals to ${outPath}`);
