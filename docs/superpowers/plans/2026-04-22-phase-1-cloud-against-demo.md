# Phase 1 — Cloud Against demo.mtconnect.org Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the cloud Worker end-to-end — raw-observation ingest, probe ingest, D1 schema, processor (state machine / condition tracker / minute rollups), alert engine, shift rollup, read API — and validate it against live `demo.mtconnect.org` via a dev poller shim. No NUC, no real machine.

**Architecture:** Pure-functional processors (state machine, conditions, rollups, events, alert rules) under `cloud/src/processor/` and `cloud/src/alerts/` — all unit-tested from fixtures. Cron-driven orchestration reads observations from D1 and advances per-stream cursors. Ingest endpoints validate inputs and upsert. A separate `scripts/demo-poller.ts` runs outside the Worker to drive end-to-end testing against the live demo agent.

**Tech Stack:** Cloudflare Workers + Hono + D1 (TypeScript), `fast-xml-parser` for XML, vitest + `@cloudflare/vitest-pool-workers`, `libxmljs2` (Node dev dep) for XSD validation in tests only.

**Spec reference:** `docs/superpowers/specs/2026-04-22-mtconnect-v2-redesign.md`
**Precondition:** Phase 0 complete — clean skeleton on `main`.

---

## File structure after this phase

```
cloud/
├── migrations/
│   └── 0001_v2_init.sql
├── src/
│   ├── index.ts                          # wire all routes + scheduled handler
│   ├── types.ts                          # Env + shared types
│   ├── auth.ts                           # kept from Phase 0
│   ├── xml/
│   │   ├── probe.ts                      # parse <MTConnectDevices>
│   │   └── streams.ts                    # parse <MTConnectStreams>
│   ├── ingest/
│   │   ├── probe.ts                      # POST /ingest/probe
│   │   └── observations.ts               # POST /ingest/observations
│   ├── processor/
│   │   ├── state_machine.ts              # pure: observations -> state_intervals
│   │   ├── conditions.ts                 # pure: observations -> condition transitions
│   │   ├── events.ts                     # pure: observations -> discrete events
│   │   ├── rollups_minute.ts             # pure: observations -> minute accumulator
│   │   └── run.ts                        # cron driver: reads cursor, runs all processors, writes back
│   ├── alerts/
│   │   ├── rules.ts                      # pure: (state_intervals, conditions, events, observations) -> alerts[]
│   │   ├── scanner.ts                    # cron driver: runs rules, upserts alerts, fans to Slack
│   │   └── slack.ts                      # Slack webhook fanout
│   ├── shift/
│   │   └── rollup.ts                     # cron driver: nightly shift rollup
│   └── read/
│       ├── machines.ts                   # GET /machines + GET /machines/:id/current
│       ├── sample.ts                     # GET /machines/:id/sample
│       ├── utilization.ts                # GET /machines/:id/utilization
│       └── alerts.ts                     # GET /alerts + POST /alerts/:id/ack
├── test/
│   ├── migrations.ts                     # helper: apply migrations to D1 in tests
│   ├── fixtures/
│   │   ├── demo_probe.xml                # captured from demo.mtconnect.org
│   │   ├── demo_current.xml              # captured /current snapshot
│   │   ├── demo_sample_1m.xml            # captured 60s of /sample
│   │   └── golden_state_intervals.json   # golden derived output from demo_sample_1m
│   ├── schemas/
│   │   ├── MTConnectDevices_2.7.xsd
│   │   └── MTConnectStreams_2.7.xsd
│   ├── auth.test.ts                      # unchanged
│   ├── xml.probe.test.ts
│   ├── xml.streams.test.ts
│   ├── ingest.probe.test.ts
│   ├── ingest.observations.test.ts
│   ├── processor.state_machine.test.ts
│   ├── processor.conditions.test.ts
│   ├── processor.events.test.ts
│   ├── processor.rollups_minute.test.ts
│   ├── processor.run.test.ts
│   ├── alerts.rules.test.ts
│   ├── alerts.scanner.test.ts
│   ├── shift.rollup.test.ts
│   ├── read.machines.test.ts
│   ├── read.sample.test.ts
│   ├── read.utilization.test.ts
│   ├── read.alerts.test.ts
│   ├── xsd.test.ts                       # validate fixtures against XSDs
│   └── shadow.integration.test.ts        # end-to-end using demo fixtures
└── scripts/
    └── demo-poller.ts                    # dev-only: polls demo.mtconnect.org -> local Worker
```

---

## Task 1: D1 schema migration

**Files:**
- Create: `cloud/migrations/0001_v2_init.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0001_v2_init.sql — MTConnect v2 schema, raw-observation-centric

CREATE TABLE devices (
  device_uuid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT,
  controller_type TEXT,
  controller_vendor TEXT,
  mtconnect_version TEXT,
  current_instance_id TEXT,
  probe_xml TEXT,
  probe_fetched_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

CREATE TABLE data_items (
  device_uuid TEXT NOT NULL,
  data_item_id TEXT NOT NULL,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  sub_type TEXT,
  units TEXT,
  native_units TEXT,
  component_path TEXT,
  PRIMARY KEY (device_uuid, data_item_id)
);

CREATE TABLE observations (
  device_uuid TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  timestamp_utc TEXT NOT NULL,
  data_item_id TEXT NOT NULL,
  value_num REAL,
  value_str TEXT,
  condition_level TEXT,
  condition_native_code TEXT,
  condition_severity TEXT,
  condition_qualifier TEXT,
  PRIMARY KEY (device_uuid, sequence)
);
CREATE INDEX idx_observations_ts ON observations(device_uuid, timestamp_utc);
CREATE INDEX idx_observations_type ON observations(device_uuid, data_item_id, timestamp_utc);

CREATE TABLE state_intervals (
  device_uuid TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  state TEXT NOT NULL,
  program TEXT,
  tool_number TEXT,
  controller_mode TEXT,
  PRIMARY KEY (device_uuid, started_at)
);

CREATE TABLE conditions (
  device_uuid TEXT NOT NULL,
  data_item_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  level TEXT NOT NULL,
  native_code TEXT,
  severity TEXT,
  qualifier TEXT,
  message TEXT,
  PRIMARY KEY (device_uuid, data_item_id, started_at)
);

CREATE TABLE events (
  device_uuid TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT,
  PRIMARY KEY (device_uuid, ts, kind)
);

CREATE TABLE rollups_minute (
  device_uuid TEXT NOT NULL,
  minute_start TEXT NOT NULL,
  active_s REAL DEFAULT 0,
  feed_hold_s REAL DEFAULT 0,
  stopped_s REAL DEFAULT 0,
  interrupted_s REAL DEFAULT 0,
  ready_s REAL DEFAULT 0,
  offline_s REAL DEFAULT 0,
  part_delta INTEGER DEFAULT 0,
  program TEXT,
  tool_number TEXT,
  avg_spindle_rpm REAL,
  max_spindle_load REAL,
  avg_feedrate REAL,
  PRIMARY KEY (device_uuid, minute_start)
);

CREATE TABLE rollups_shift (
  device_uuid TEXT NOT NULL,
  shift_date TEXT NOT NULL,
  availability_pct REAL,
  utilization_pct REAL,
  part_count INTEGER,
  alarm_count INTEGER,
  scheduled_seconds INTEGER,
  PRIMARY KEY (device_uuid, shift_date)
);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_uuid TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  triggered_at TEXT NOT NULL,
  cleared_at TEXT,
  acknowledged_by TEXT,
  acknowledged_at TEXT,
  message TEXT
);
CREATE INDEX idx_alerts_open ON alerts(device_uuid, cleared_at);

CREATE TABLE processor_cursors (
  device_uuid TEXT NOT NULL,
  stream TEXT NOT NULL,
  last_sequence INTEGER NOT NULL,
  last_run_at TEXT,
  PRIMARY KEY (device_uuid, stream)
);
```

- [ ] **Step 2: Commit**

```bash
git add cloud/migrations/0001_v2_init.sql
git commit -m "feat(cloud): add D1 v2 schema migration (devices, data_items, observations, derived tables)"
```

---

## Task 2: Test-harness migration applier

**Files:**
- Create: `cloud/test/migrations.ts`

- [ ] **Step 1: Install dependency**

```bash
cd cloud && npm install --save-dev node:fs
```
(Skip if already available — `node:fs` is built-in.)

- [ ] **Step 2: Write the applier**

```typescript
// cloud/test/migrations.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../src/types";

export async function applyMigrations(env: Env): Promise<void> {
  const dir = join(__dirname, "..", "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const f of files) {
    const sql = readFileSync(join(dir, f), "utf8");
    const statements = sql
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("--"));

    for (const stmt of statements) {
      await env.DB.prepare(stmt).run();
    }
  }
}
```

- [ ] **Step 3: Verify via a smoke test** (wait — no test file yet; deferred until Task 3 uses it).

- [ ] **Step 4: Commit**

```bash
git add cloud/test/migrations.ts
git commit -m "test(cloud): add migration applier for D1 tests"
```

---

## Task 3: XML parser for `/probe` — test first

**Files:**
- Create: `cloud/test/fixtures/demo_probe.xml`
- Create: `cloud/test/xml.probe.test.ts`
- Create: `cloud/src/xml/probe.ts`

- [ ] **Step 1: Capture the probe fixture**

Manual one-time capture:
```bash
curl -s https://demo.mtconnect.org/probe > cloud/test/fixtures/demo_probe.xml
```

Verify the file starts with `<?xml version="1.0"` and contains `<MTConnectDevices`.

- [ ] **Step 2: Install `fast-xml-parser`**

```bash
cd cloud && npm install fast-xml-parser
```

- [ ] **Step 3: Write the failing test**

```typescript
// cloud/test/xml.probe.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProbe } from "../src/xml/probe";

const fixture = readFileSync(
  join(__dirname, "fixtures", "demo_probe.xml"),
  "utf8",
);

describe("parseProbe", () => {
  it("extracts header metadata", () => {
    const result = parseProbe(fixture);
    expect(result.header.instanceId).toBeTruthy();
    expect(result.header.schemaVersion).toMatch(/^\d+\.\d+/);
  });

  it("extracts at least one device", () => {
    const result = parseProbe(fixture);
    expect(result.devices.length).toBeGreaterThan(0);
    const d = result.devices[0];
    expect(d.uuid).toBeTruthy();
    expect(d.name).toBeTruthy();
  });

  it("extracts data items with category and type", () => {
    const result = parseProbe(fixture);
    const allItems = result.devices.flatMap((d) => d.dataItems);
    expect(allItems.length).toBeGreaterThan(0);
    const exec = allItems.find((di) => di.type === "EXECUTION");
    expect(exec).toBeDefined();
    expect(exec!.category).toBe("EVENT");
    expect(exec!.id).toBeTruthy();
  });

  it("captures component path for each data item", () => {
    const result = parseProbe(fixture);
    const allItems = result.devices.flatMap((d) => d.dataItems);
    // every data item should have a non-empty component path
    expect(allItems.every((di) => di.componentPath.length > 0)).toBe(true);
  });
});
```

- [ ] **Step 4: Run — expect failure**

Run: `cd cloud && npm test -- xml.probe`
Expected: FAIL ("Cannot find module '../src/xml/probe'").

- [ ] **Step 5: Implement `cloud/src/xml/probe.ts`**

```typescript
import { XMLParser } from "fast-xml-parser";

export type ProbeDataItem = {
  id: string;
  name?: string;
  category: "SAMPLE" | "EVENT" | "CONDITION";
  type: string;
  subType?: string;
  units?: string;
  nativeUnits?: string;
  componentPath: string;
};

export type ProbeDevice = {
  uuid: string;
  name: string;
  model?: string;
  dataItems: ProbeDataItem[];
};

export type ProbeParseResult = {
  header: {
    instanceId: string;
    schemaVersion: string;
    creationTime: string;
  };
  devices: ProbeDevice[];
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  allowBooleanAttributes: true,
  isArray: (tagName) => {
    // tags that should always be arrays even with a single element
    return [
      "Device",
      "DataItem",
      "Components",
      "Axes",
      "Controller",
      "Path",
      "Linear",
      "Rotary",
      "Systems",
      "Auxiliaries",
      "Hydraulic",
      "Electric",
      "Pneumatic",
      "Coolant",
      "Lubrication",
    ].includes(tagName);
  },
});

export function parseProbe(xml: string): ProbeParseResult {
  const root = parser.parse(xml);
  const md = root.MTConnectDevices;
  const hdr = md.Header;

  const devices: ProbeDevice[] = [];
  const deviceArr = md.Devices?.Device ?? [];
  for (const d of deviceArr) {
    const dataItems: ProbeDataItem[] = [];
    collectDataItems(d, d["@_name"] ?? "", dataItems);
    devices.push({
      uuid: d["@_uuid"],
      name: d["@_name"],
      model: d["@_model"],
      dataItems,
    });
  }

  return {
    header: {
      instanceId: hdr["@_instanceId"],
      schemaVersion: hdr["@_schemaVersion"] ?? hdr["@_version"] ?? "",
      creationTime: hdr["@_creationTime"],
    },
    devices,
  };
}

function collectDataItems(
  node: Record<string, unknown>,
  path: string,
  out: ProbeDataItem[],
): void {
  const dis = (node as { DataItems?: { DataItem?: unknown[] } }).DataItems
    ?.DataItem;
  if (Array.isArray(dis)) {
    for (const di of dis as Array<Record<string, string>>) {
      out.push({
        id: di["@_id"],
        name: di["@_name"],
        category: di["@_category"] as "SAMPLE" | "EVENT" | "CONDITION",
        type: di["@_type"],
        subType: di["@_subType"],
        units: di["@_units"],
        nativeUnits: di["@_nativeUnits"],
        componentPath: path,
      });
    }
  }
  // recurse into any nested component tags
  const components = (node as { Components?: Record<string, unknown> })
    .Components;
  if (components) {
    for (const [tag, children] of Object.entries(components)) {
      if (Array.isArray(children)) {
        for (const child of children as Array<Record<string, unknown>>) {
          const name = (child as Record<string, string>)["@_name"] ?? tag;
          collectDataItems(child, `${path}/${name}`, out);
        }
      }
    }
  }
}
```

- [ ] **Step 6: Run — expect pass**

Run: `cd cloud && npm test -- xml.probe`
Expected: 4 tests passing.

- [ ] **Step 7: Commit**

```bash
git add cloud/package.json cloud/package-lock.json cloud/src/xml/probe.ts cloud/test/xml.probe.test.ts cloud/test/fixtures/demo_probe.xml
git commit -m "feat(cloud): parse MTConnectDevices probe XML into typed device model"
```

---

## Task 4: XML parser for `/sample` streams — test first

**Files:**
- Create: `cloud/test/fixtures/demo_sample_1m.xml`
- Create: `cloud/test/xml.streams.test.ts`
- Create: `cloud/src/xml/streams.ts`

- [ ] **Step 1: Capture fixture**

```bash
curl -s "https://demo.mtconnect.org/sample?count=1000" > cloud/test/fixtures/demo_sample_1m.xml
```

- [ ] **Step 2: Write failing test**

```typescript
// cloud/test/xml.streams.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStreams } from "../src/xml/streams";

const fixture = readFileSync(
  join(__dirname, "fixtures", "demo_sample_1m.xml"),
  "utf8",
);

describe("parseStreams", () => {
  it("extracts header with sequence cursors", () => {
    const r = parseStreams(fixture);
    expect(r.header.instanceId).toBeTruthy();
    expect(r.header.firstSequence).toBeGreaterThanOrEqual(0);
    expect(r.header.nextSequence).toBeGreaterThan(r.header.firstSequence);
    expect(r.header.lastSequence).toBeGreaterThanOrEqual(r.header.firstSequence);
  });

  it("extracts observations with device_uuid, sequence, timestamp, data_item_id, category", () => {
    const r = parseStreams(fixture);
    expect(r.observations.length).toBeGreaterThan(0);
    const o = r.observations[0];
    expect(o.deviceUuid).toBeTruthy();
    expect(typeof o.sequence).toBe("number");
    expect(o.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(o.dataItemId).toBeTruthy();
    expect(["SAMPLE", "EVENT", "CONDITION"]).toContain(o.category);
  });

  it("populates value_num for SAMPLE observations where numeric", () => {
    const r = parseStreams(fixture);
    const samples = r.observations.filter((o) => o.category === "SAMPLE");
    expect(samples.length).toBeGreaterThan(0);
    const numeric = samples.find(
      (s) => s.valueStr !== "UNAVAILABLE" && !isNaN(Number(s.valueStr)),
    );
    if (numeric) {
      expect(numeric.valueNum).not.toBeNull();
      expect(numeric.valueNum).not.toBeNaN();
    }
  });

  it("extracts condition observations with level", () => {
    const r = parseStreams(fixture);
    const conds = r.observations.filter((o) => o.category === "CONDITION");
    // demo usually has at least one NORMAL condition channel emitting
    for (const c of conds) {
      expect(["NORMAL", "WARNING", "FAULT", "UNAVAILABLE"]).toContain(
        c.conditionLevel,
      );
    }
  });
});
```

- [ ] **Step 3: Run — expect failure**

- [ ] **Step 4: Implement `cloud/src/xml/streams.ts`**

```typescript
import { XMLParser } from "fast-xml-parser";

export type ParsedObservation = {
  deviceUuid: string;
  sequence: number;
  timestamp: string;
  dataItemId: string;
  category: "SAMPLE" | "EVENT" | "CONDITION";
  type: string;
  subType?: string;
  valueNum: number | null;
  valueStr: string | null;
  conditionLevel?: "NORMAL" | "WARNING" | "FAULT" | "UNAVAILABLE";
  conditionNativeCode?: string;
  conditionSeverity?: string;
  conditionQualifier?: string;
};

export type StreamsParseResult = {
  header: {
    instanceId: string;
    firstSequence: number;
    lastSequence: number;
    nextSequence: number;
    schemaVersion: string;
    creationTime: string;
  };
  observations: ParsedObservation[];
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  allowBooleanAttributes: true,
  preserveOrder: false,
  textNodeName: "#text",
  isArray: (tagName) => {
    // every known observation-bearing tag should be an array
    if (["DeviceStream", "ComponentStream"].includes(tagName)) return true;
    return false;
  },
});

// categories map from XML parent container name to MTConnect category
const CATEGORY_PARENTS: Record<string, "SAMPLE" | "EVENT" | "CONDITION"> = {
  Samples: "SAMPLE",
  Events: "EVENT",
  Condition: "CONDITION",
};

const CONDITION_LEVEL_TAGS = ["Normal", "Warning", "Fault", "Unavailable"];

export function parseStreams(xml: string): StreamsParseResult {
  const root = parser.parse(xml);
  const ms = root.MTConnectStreams;
  const hdr = ms.Header;

  const observations: ParsedObservation[] = [];

  const devStreams = ms.Streams?.DeviceStream ?? [];
  const devArr = Array.isArray(devStreams) ? devStreams : [devStreams];

  for (const ds of devArr) {
    const deviceUuid = ds["@_uuid"];
    const compStreams = ds.ComponentStream ?? [];
    const compArr = Array.isArray(compStreams) ? compStreams : [compStreams];
    for (const cs of compArr) {
      for (const [parentTag, inner] of Object.entries(cs)) {
        if (!(parentTag in CATEGORY_PARENTS)) continue;
        const category = CATEGORY_PARENTS[parentTag];
        collectFromCategoryNode(deviceUuid, category, inner, observations);
      }
    }
  }

  return {
    header: {
      instanceId: hdr["@_instanceId"],
      firstSequence: Number(hdr["@_firstSequence"]),
      lastSequence: Number(hdr["@_lastSequence"]),
      nextSequence: Number(hdr["@_nextSequence"]),
      schemaVersion: hdr["@_schemaVersion"] ?? hdr["@_version"] ?? "",
      creationTime: hdr["@_creationTime"],
    },
    observations,
  };
}

function collectFromCategoryNode(
  deviceUuid: string,
  category: "SAMPLE" | "EVENT" | "CONDITION",
  node: unknown,
  out: ParsedObservation[],
): void {
  if (node === null || node === undefined) return;
  // node is { TagName: [items] or item, ... }
  for (const [tag, value] of Object.entries(node as Record<string, unknown>)) {
    const arr = Array.isArray(value) ? value : [value];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, string>;
      if (category === "CONDITION") {
        // tag is the level (Normal|Warning|Fault|Unavailable)
        if (!CONDITION_LEVEL_TAGS.includes(tag)) continue;
        out.push({
          deviceUuid,
          sequence: Number(it["@_sequence"]),
          timestamp: it["@_timestamp"],
          dataItemId: it["@_dataItemId"],
          category: "CONDITION",
          type: it["@_type"] ?? "",
          subType: it["@_subType"],
          valueNum: null,
          valueStr: (it as Record<string, string>)["#text"] ?? null,
          conditionLevel: tag.toUpperCase() as
            | "NORMAL"
            | "WARNING"
            | "FAULT"
            | "UNAVAILABLE",
          conditionNativeCode: it["@_nativeCode"],
          conditionSeverity: it["@_nativeSeverity"],
          conditionQualifier: it["@_qualifier"],
        });
      } else {
        const text = (it as Record<string, string>)["#text"];
        const valueStr = text ?? (typeof item === "string" ? item : null);
        const valueNum =
          valueStr !== null && valueStr !== "UNAVAILABLE"
            ? parseFloatOrNull(valueStr)
            : null;
        out.push({
          deviceUuid,
          sequence: Number(it["@_sequence"]),
          timestamp: it["@_timestamp"],
          dataItemId: it["@_dataItemId"],
          category,
          type: tag,
          subType: it["@_subType"],
          valueNum,
          valueStr,
        });
      }
    }
  }
}

function parseFloatOrNull(s: string): number | null {
  const n = Number(s);
  return isNaN(n) ? null : n;
}
```

- [ ] **Step 5: Run — expect pass**

Run: `cd cloud && npm test -- xml.streams`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add cloud/src/xml/streams.ts cloud/test/xml.streams.test.ts cloud/test/fixtures/demo_sample_1m.xml
git commit -m "feat(cloud): parse MTConnectStreams XML into typed observation records"
```

---

## Task 5: `POST /ingest/probe`

**Files:**
- Create: `cloud/src/ingest/probe.ts`
- Create: `cloud/test/ingest.probe.test.ts`
- Modify: `cloud/src/index.ts` (wire route)

- [ ] **Step 1: Write failing test**

```typescript
// cloud/test/ingest.probe.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMigrations } from "./migrations";
import app from "../src/index";
import { parseProbe } from "../src/xml/probe";
import type { Env } from "../src/types";

const probeXml = readFileSync(
  join(__dirname, "fixtures", "demo_probe.xml"),
  "utf8",
);

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
    await (env as unknown as Env).DB.prepare("DELETE FROM data_items").run();
    await (env as unknown as Env).DB.prepare("DELETE FROM devices").run();
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
```

- [ ] **Step 2: Set `EDGE_SHARED_SECRET` in `vitest.config.ts` miniflare env**

Verify `cloud/vitest.config.ts` has the worker binding. If not, update:

```typescript
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        main: "./src/index.ts",
        miniflare: {
          compatibilityFlags: ["nodejs_compat"],
          compatibilityDate: "2025-01-01",
          d1Databases: ["DB"],
          bindings: {
            EDGE_SHARED_SECRET: "test-secret",
          },
        },
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
```

- [ ] **Step 3: Run — expect failure (no route, no handler)**

Run: `cd cloud && npm test -- ingest.probe`
Expected: FAIL.

- [ ] **Step 4: Implement `cloud/src/ingest/probe.ts`**

```typescript
import { Hono } from "hono";
import type { Env } from "../types";

type Body = {
  device_uuid: string;
  name: string;
  model?: string | null;
  controller_type?: string | null;
  controller_vendor?: string | null;
  mtconnect_version?: string | null;
  instance_id: string;
  probe_xml: string;
  data_items: Array<{
    id: string;
    category: string;
    type: string;
    subType?: string;
    units?: string;
    nativeUnits?: string;
    componentPath: string;
  }>;
};

export const probeIngest = new Hono<{ Bindings: Env }>();

probeIngest.post("/", async (c) => {
  const b = (await c.req.json<Body>().catch(() => null)) as Body | null;
  if (!b || !b.device_uuid || !b.instance_id || !Array.isArray(b.data_items)) {
    return c.json({ error: "invalid body" }, 400);
  }

  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];

  stmts.push(
    c.env.DB.prepare(
      `INSERT INTO devices (device_uuid, name, model, controller_type, controller_vendor, mtconnect_version, current_instance_id, probe_xml, probe_fetched_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (device_uuid) DO UPDATE SET
         name = excluded.name,
         model = excluded.model,
         controller_type = excluded.controller_type,
         controller_vendor = excluded.controller_vendor,
         mtconnect_version = excluded.mtconnect_version,
         current_instance_id = excluded.current_instance_id,
         probe_xml = excluded.probe_xml,
         probe_fetched_at = excluded.probe_fetched_at,
         updated_at = excluded.updated_at`,
    ).bind(
      b.device_uuid,
      b.name,
      b.model ?? null,
      b.controller_type ?? null,
      b.controller_vendor ?? null,
      b.mtconnect_version ?? null,
      b.instance_id,
      b.probe_xml,
      now,
      now,
    ),
  );

  stmts.push(
    c.env.DB.prepare("DELETE FROM data_items WHERE device_uuid = ?").bind(
      b.device_uuid,
    ),
  );

  for (const di of b.data_items) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO data_items (device_uuid, data_item_id, category, type, sub_type, units, native_units, component_path)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).bind(
        b.device_uuid,
        di.id,
        di.category,
        di.type,
        di.subType ?? null,
        di.units ?? null,
        di.nativeUnits ?? null,
        di.componentPath,
      ),
    );
  }

  await c.env.DB.batch(stmts);

  return c.json({ ok: true, device_uuid: b.device_uuid });
});
```

- [ ] **Step 5: Wire in `cloud/src/index.ts`**

```typescript
import { Hono } from "hono";
import type { Env } from "./types";
import { requireEdgeSecret } from "./auth";
import { probeIngest } from "./ingest/probe";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "mtconnect-collector" }));

const ingest = new Hono<{ Bindings: Env }>();
ingest.use("*", requireEdgeSecret);
ingest.route("/probe", probeIngest);
app.route("/ingest", ingest);

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    // wired in later tasks
  },
} satisfies ExportedHandler<Env>;

export { app as default };
```

- [ ] **Step 6: Run — expect pass**

Run: `cd cloud && npm test -- ingest.probe`
Expected: 3 tests pass.

- [ ] **Step 7: Commit**

```bash
git add cloud/src/ingest/probe.ts cloud/src/index.ts cloud/test/ingest.probe.test.ts cloud/vitest.config.ts
git commit -m "feat(cloud): POST /ingest/probe upserts device model + data_items"
```

---

## Task 6: `POST /ingest/observations`

**Files:**
- Create: `cloud/src/ingest/observations.ts`
- Create: `cloud/test/ingest.observations.test.ts`
- Modify: `cloud/src/index.ts`

- [ ] **Step 1: Write failing test**

```typescript
// cloud/test/ingest.observations.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./migrations";
import app from "../src/index";
import type { Env } from "../src/types";

const e = env as unknown as Env;

async function reset() {
  await e.DB.prepare("DELETE FROM observations").run();
  await e.DB.prepare("DELETE FROM devices").run();
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
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `cloud/src/ingest/observations.ts`**

```typescript
import { Hono } from "hono";
import type { Env } from "../types";

type ObservationIn = {
  sequence: number;
  timestamp: string;
  data_item_id: string;
  category: "SAMPLE" | "EVENT" | "CONDITION";
  type: string;
  sub_type?: string;
  value_num?: number | null;
  value_str?: string | null;
  condition_level?: "NORMAL" | "WARNING" | "FAULT" | "UNAVAILABLE";
  condition_native_code?: string;
  condition_severity?: string;
  condition_qualifier?: string;
};

type Body = {
  device_uuid: string;
  instance_id: string;
  batch: ObservationIn[];
  gap?: { start_seq: number; end_seq: number };
};

export const observationsIngest = new Hono<{ Bindings: Env }>();

observationsIngest.post("/", async (c) => {
  const b = (await c.req.json<Body>().catch(() => null)) as Body | null;
  if (!b || !b.device_uuid || !b.instance_id || !Array.isArray(b.batch)) {
    return c.json({ error: "invalid body" }, 400);
  }

  // device existence check
  const dev = await c.env.DB.prepare(
    "SELECT current_instance_id FROM devices WHERE device_uuid = ?",
  )
    .bind(b.device_uuid)
    .first<{ current_instance_id: string | null }>();
  if (!dev) {
    return c.json({ error: "unknown device" }, 400);
  }

  const stmts: D1PreparedStatement[] = [];

  if (dev.current_instance_id !== b.instance_id) {
    stmts.push(
      c.env.DB.prepare(
        "UPDATE devices SET current_instance_id = ?, updated_at = ? WHERE device_uuid = ?",
      ).bind(b.instance_id, new Date().toISOString(), b.device_uuid),
    );
  }

  let high = 0;
  for (const o of b.batch) {
    if (o.sequence > high) high = o.sequence;
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO observations (device_uuid, sequence, timestamp_utc, data_item_id, value_num, value_str, condition_level, condition_native_code, condition_severity, condition_qualifier)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (device_uuid, sequence) DO UPDATE SET
           timestamp_utc = excluded.timestamp_utc,
           data_item_id = excluded.data_item_id,
           value_num = excluded.value_num,
           value_str = excluded.value_str,
           condition_level = excluded.condition_level,
           condition_native_code = excluded.condition_native_code,
           condition_severity = excluded.condition_severity,
           condition_qualifier = excluded.condition_qualifier`,
      ).bind(
        b.device_uuid,
        o.sequence,
        o.timestamp,
        o.data_item_id,
        o.value_num ?? null,
        o.value_str ?? null,
        o.condition_level ?? null,
        o.condition_native_code ?? null,
        o.condition_severity ?? null,
        o.condition_qualifier ?? null,
      ),
    );
  }

  if (b.gap) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO events (device_uuid, ts, kind, payload_json) VALUES (?,?,?,?)
         ON CONFLICT (device_uuid, ts, kind) DO NOTHING`,
      ).bind(
        b.device_uuid,
        new Date().toISOString(),
        "gap",
        JSON.stringify(b.gap),
      ),
    );
  }

  await c.env.DB.batch(stmts);

  return c.json({ ok: true, high_water_sequence: high });
});
```

- [ ] **Step 4: Wire route in `cloud/src/index.ts`**

```typescript
import { observationsIngest } from "./ingest/observations";
// ...
ingest.route("/observations", observationsIngest);
```

- [ ] **Step 5: Run — expect pass**

Run: `cd cloud && npm test -- ingest.observations`
Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add cloud/src/ingest/observations.ts cloud/src/index.ts cloud/test/ingest.observations.test.ts
git commit -m "feat(cloud): POST /ingest/observations upserts raw observations idempotently"
```

---

## Task 7: Pure state machine processor

**Files:**
- Create: `cloud/src/processor/state_machine.ts`
- Create: `cloud/test/processor.state_machine.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// cloud/test/processor.state_machine.test.ts
import { describe, it, expect } from "vitest";
import { deriveStateIntervals, type ObservationRow } from "../src/processor/state_machine";

function obs(
  seq: number,
  ts: string,
  dataItemId: string,
  value: string,
): ObservationRow {
  return {
    sequence: seq,
    timestamp_utc: ts,
    data_item_id: dataItemId,
    value_str: value,
    value_num: null,
    condition_level: null,
  };
}

describe("deriveStateIntervals", () => {
  const dataItemTypes = new Map([
    ["exec", { type: "EXECUTION", category: "EVENT" }],
    ["mode", { type: "CONTROLLER_MODE", category: "EVENT" }],
    ["avail", { type: "AVAILABILITY", category: "EVENT" }],
    ["prog", { type: "PROGRAM", category: "EVENT" }],
    ["tool", { type: "TOOL_NUMBER", category: "EVENT" }],
  ]);

  it("emits nothing if only one observation", () => {
    const r = deriveStateIntervals(
      [obs(1, "2026-04-22T10:00:00Z", "exec", "ACTIVE")],
      dataItemTypes,
      { lastState: null, lastProgram: null, lastTool: null, lastControllerMode: null, lastStateStart: null },
    );
    expect(r.closedIntervals).toHaveLength(0);
  });

  it("emits a closed interval on state transition", () => {
    const r = deriveStateIntervals(
      [
        obs(1, "2026-04-22T10:00:00Z", "exec", "ACTIVE"),
        obs(2, "2026-04-22T10:00:30Z", "exec", "FEED_HOLD"),
      ],
      dataItemTypes,
      { lastState: null, lastProgram: null, lastTool: null, lastControllerMode: null, lastStateStart: null },
    );
    expect(r.closedIntervals).toHaveLength(1);
    expect(r.closedIntervals[0].state).toBe("ACTIVE");
    expect(r.closedIntervals[0].started_at).toBe("2026-04-22T10:00:00Z");
    expect(r.closedIntervals[0].ended_at).toBe("2026-04-22T10:00:30Z");
  });

  it("normalizes PROGRAM_STOPPED and READY to STOPPED and READY separately", () => {
    const r = deriveStateIntervals(
      [
        obs(1, "2026-04-22T10:00:00Z", "exec", "READY"),
        obs(2, "2026-04-22T10:01:00Z", "exec", "ACTIVE"),
        obs(3, "2026-04-22T10:02:00Z", "exec", "PROGRAM_STOPPED"),
        obs(4, "2026-04-22T10:03:00Z", "exec", "READY"),
      ],
      dataItemTypes,
      { lastState: null, lastProgram: null, lastTool: null, lastControllerMode: null, lastStateStart: null },
    );
    expect(r.closedIntervals.map((i) => i.state)).toEqual([
      "READY",
      "ACTIVE",
      "STOPPED",
    ]);
  });

  it("captures program and tool number at state entry", () => {
    const r = deriveStateIntervals(
      [
        obs(1, "2026-04-22T10:00:00Z", "prog", "O1234"),
        obs(2, "2026-04-22T10:00:00Z", "tool", "7"),
        obs(3, "2026-04-22T10:00:00Z", "exec", "ACTIVE"),
        obs(4, "2026-04-22T10:01:00Z", "prog", "O5678"),
        obs(5, "2026-04-22T10:02:00Z", "exec", "READY"),
      ],
      dataItemTypes,
      { lastState: null, lastProgram: null, lastTool: null, lastControllerMode: null, lastStateStart: null },
    );
    const active = r.closedIntervals.find((i) => i.state === "ACTIVE");
    expect(active).toBeDefined();
    expect(active!.program).toBe("O1234");
    expect(active!.tool_number).toBe("7");
  });

  it("maps UNAVAILABLE execution to OFFLINE", () => {
    const r = deriveStateIntervals(
      [
        obs(1, "2026-04-22T10:00:00Z", "exec", "ACTIVE"),
        obs(2, "2026-04-22T10:01:00Z", "exec", "UNAVAILABLE"),
        obs(3, "2026-04-22T10:02:00Z", "exec", "READY"),
      ],
      dataItemTypes,
      { lastState: null, lastProgram: null, lastTool: null, lastControllerMode: null, lastStateStart: null },
    );
    expect(r.closedIntervals.map((i) => i.state)).toEqual(["ACTIVE", "OFFLINE"]);
  });

  it("returns open-state hint (no interval emitted) when state is still current", () => {
    const r = deriveStateIntervals(
      [obs(1, "2026-04-22T10:00:00Z", "exec", "ACTIVE")],
      dataItemTypes,
      { lastState: null, lastProgram: null, lastTool: null, lastControllerMode: null, lastStateStart: null },
    );
    expect(r.newState.lastState).toBe("ACTIVE");
    expect(r.newState.lastStateStart).toBe("2026-04-22T10:00:00Z");
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `cloud/src/processor/state_machine.ts`**

```typescript
export type NormalizedState =
  | "ACTIVE"
  | "FEED_HOLD"
  | "STOPPED"
  | "INTERRUPTED"
  | "READY"
  | "OFFLINE";

export type ObservationRow = {
  sequence: number;
  timestamp_utc: string;
  data_item_id: string;
  value_str: string | null;
  value_num: number | null;
  condition_level: string | null;
};

export type DataItemMeta = {
  type: string;
  category: string;
};

export type StateMachineCursor = {
  lastState: NormalizedState | null;
  lastStateStart: string | null;
  lastProgram: string | null;
  lastTool: string | null;
  lastControllerMode: string | null;
};

export type ClosedInterval = {
  state: NormalizedState;
  started_at: string;
  ended_at: string;
  program: string | null;
  tool_number: string | null;
  controller_mode: string | null;
};

export type StateMachineResult = {
  closedIntervals: ClosedInterval[];
  newState: StateMachineCursor;
};

const EXECUTION_MAP: Record<string, NormalizedState> = {
  ACTIVE: "ACTIVE",
  FEED_HOLD: "FEED_HOLD",
  INTERRUPTED: "INTERRUPTED",
  READY: "READY",
  STOPPED: "STOPPED",
  PROGRAM_STOPPED: "STOPPED",
  PROGRAM_COMPLETED: "STOPPED",
  OPTIONAL_STOP: "STOPPED",
  UNAVAILABLE: "OFFLINE",
};

export function deriveStateIntervals(
  observations: ObservationRow[],
  dataItemTypes: Map<string, DataItemMeta>,
  cursor: StateMachineCursor,
): StateMachineResult {
  const closed: ClosedInterval[] = [];
  let state = { ...cursor };

  for (const o of observations) {
    const meta = dataItemTypes.get(o.data_item_id);
    if (!meta) continue;

    if (meta.type === "PROGRAM") {
      state.lastProgram = o.value_str;
      continue;
    }
    if (meta.type === "TOOL_NUMBER" || meta.type === "TOOL_ASSET_ID") {
      state.lastTool = o.value_str;
      continue;
    }
    if (meta.type === "CONTROLLER_MODE") {
      state.lastControllerMode = o.value_str;
      continue;
    }
    if (meta.type === "EXECUTION") {
      const raw = (o.value_str ?? "UNAVAILABLE").toUpperCase();
      const next = EXECUTION_MAP[raw] ?? "OFFLINE";
      if (next !== state.lastState) {
        if (state.lastState !== null && state.lastStateStart !== null) {
          closed.push({
            state: state.lastState,
            started_at: state.lastStateStart,
            ended_at: o.timestamp_utc,
            program: state.lastProgram,
            tool_number: state.lastTool,
            controller_mode: state.lastControllerMode,
          });
        }
        state.lastState = next;
        state.lastStateStart = o.timestamp_utc;
      }
    }
  }

  return { closedIntervals: closed, newState: state };
}
```

- [ ] **Step 4: Run — expect pass**

Run: `cd cloud && npm test -- processor.state_machine`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add cloud/src/processor/state_machine.ts cloud/test/processor.state_machine.test.ts
git commit -m "feat(cloud): pure state machine deriving closed intervals from observations"
```

---

## Task 8: Pure condition tracker

**Files:**
- Create: `cloud/src/processor/conditions.ts`
- Create: `cloud/test/processor.conditions.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// cloud/test/processor.conditions.test.ts
import { describe, it, expect } from "vitest";
import { deriveConditionTransitions, type ConditionObservation } from "../src/processor/conditions";

function cobs(seq: number, ts: string, id: string, level: string, opts: Partial<ConditionObservation> = {}): ConditionObservation {
  return {
    sequence: seq,
    timestamp_utc: ts,
    data_item_id: id,
    condition_level: level as ConditionObservation["condition_level"],
    condition_native_code: opts.condition_native_code ?? null,
    condition_severity: opts.condition_severity ?? null,
    condition_qualifier: opts.condition_qualifier ?? null,
    message: opts.message ?? null,
  };
}

describe("deriveConditionTransitions", () => {
  it("opens a condition when level transitions NORMAL -> FAULT", () => {
    const r = deriveConditionTransitions(
      [
        cobs(1, "2026-04-22T10:00:00Z", "logic", "NORMAL"),
        cobs(2, "2026-04-22T10:01:00Z", "logic", "FAULT", { condition_native_code: "E50", message: "Spindle overload" }),
      ],
      new Map(),
    );
    expect(r.opens).toHaveLength(1);
    expect(r.opens[0]).toMatchObject({
      data_item_id: "logic",
      level: "FAULT",
      started_at: "2026-04-22T10:01:00Z",
      native_code: "E50",
      message: "Spindle overload",
    });
    expect(r.closes).toHaveLength(0);
  });

  it("closes an open condition when level returns to NORMAL", () => {
    const r = deriveConditionTransitions(
      [
        cobs(1, "2026-04-22T10:01:00Z", "logic", "NORMAL"),
      ],
      new Map([["logic", { started_at: "2026-04-22T10:00:00Z", level: "FAULT" as const }]]),
    );
    expect(r.closes).toHaveLength(1);
    expect(r.closes[0]).toMatchObject({
      data_item_id: "logic",
      started_at: "2026-04-22T10:00:00Z",
      ended_at: "2026-04-22T10:01:00Z",
    });
  });

  it("replaces FAULT with different native_code (close old, open new)", () => {
    const r = deriveConditionTransitions(
      [cobs(1, "2026-04-22T10:02:00Z", "logic", "FAULT", { condition_native_code: "E51" })],
      new Map([["logic", { started_at: "2026-04-22T10:00:00Z", level: "FAULT" as const, native_code: "E50" }]]),
    );
    expect(r.closes).toHaveLength(1);
    expect(r.opens).toHaveLength(1);
    expect(r.opens[0].native_code).toBe("E51");
  });

  it("ignores UNAVAILABLE -> UNAVAILABLE (no op)", () => {
    const r = deriveConditionTransitions(
      [
        cobs(1, "2026-04-22T10:00:00Z", "logic", "UNAVAILABLE"),
        cobs(2, "2026-04-22T10:01:00Z", "logic", "UNAVAILABLE"),
      ],
      new Map(),
    );
    expect(r.opens).toHaveLength(0);
    expect(r.closes).toHaveLength(0);
  });

  it("tracks separate channels per data_item_id", () => {
    const r = deriveConditionTransitions(
      [
        cobs(1, "2026-04-22T10:00:00Z", "logic", "FAULT", { condition_native_code: "E50" }),
        cobs(2, "2026-04-22T10:01:00Z", "motion", "WARNING", { condition_native_code: "W1" }),
      ],
      new Map(),
    );
    expect(r.opens).toHaveLength(2);
    expect(new Set(r.opens.map((o) => o.data_item_id))).toEqual(new Set(["logic", "motion"]));
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `cloud/src/processor/conditions.ts`**

```typescript
export type ConditionLevel = "NORMAL" | "WARNING" | "FAULT" | "UNAVAILABLE";

export type ConditionObservation = {
  sequence: number;
  timestamp_utc: string;
  data_item_id: string;
  condition_level: ConditionLevel;
  condition_native_code: string | null;
  condition_severity: string | null;
  condition_qualifier: string | null;
  message: string | null;
};

export type OpenCondition = {
  started_at: string;
  level: "WARNING" | "FAULT" | "UNAVAILABLE";
  native_code?: string | null;
};

export type ConditionOpen = {
  data_item_id: string;
  started_at: string;
  level: "WARNING" | "FAULT" | "UNAVAILABLE";
  native_code: string | null;
  severity: string | null;
  qualifier: string | null;
  message: string | null;
};

export type ConditionClose = {
  data_item_id: string;
  started_at: string;
  ended_at: string;
};

export type ConditionResult = {
  opens: ConditionOpen[];
  closes: ConditionClose[];
  newOpen: Map<string, OpenCondition>;
};

export function deriveConditionTransitions(
  observations: ConditionObservation[],
  currentlyOpen: Map<string, OpenCondition>,
): ConditionResult {
  const opens: ConditionOpen[] = [];
  const closes: ConditionClose[] = [];
  const open = new Map(currentlyOpen);

  for (const o of observations) {
    const existing = open.get(o.data_item_id);

    if (o.condition_level === "NORMAL") {
      if (existing) {
        closes.push({
          data_item_id: o.data_item_id,
          started_at: existing.started_at,
          ended_at: o.timestamp_utc,
        });
        open.delete(o.data_item_id);
      }
      continue;
    }

    // non-NORMAL
    const sameLevel = existing?.level === o.condition_level;
    const sameCode =
      (existing?.native_code ?? null) === (o.condition_native_code ?? null);
    if (existing && sameLevel && sameCode) continue;

    if (existing) {
      closes.push({
        data_item_id: o.data_item_id,
        started_at: existing.started_at,
        ended_at: o.timestamp_utc,
      });
    }
    opens.push({
      data_item_id: o.data_item_id,
      started_at: o.timestamp_utc,
      level: o.condition_level,
      native_code: o.condition_native_code,
      severity: o.condition_severity,
      qualifier: o.condition_qualifier,
      message: o.message,
    });
    open.set(o.data_item_id, {
      started_at: o.timestamp_utc,
      level: o.condition_level,
      native_code: o.condition_native_code,
    });
  }

  return { opens, closes, newOpen: open };
}
```

- [ ] **Step 4: Run — expect pass**

Run: `cd cloud && npm test -- processor.conditions`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add cloud/src/processor/conditions.ts cloud/test/processor.conditions.test.ts
git commit -m "feat(cloud): pure condition channel tracker emitting opens/closes"
```

---

## Task 9: Pure event detector

**Files:**
- Create: `cloud/src/processor/events.ts`
- Create: `cloud/test/processor.events.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// cloud/test/processor.events.test.ts
import { describe, it, expect } from "vitest";
import { deriveEvents, type EventCursor } from "../src/processor/events";

const dataItemTypes = new Map([
  ["prog", { type: "PROGRAM" }],
  ["tool", { type: "TOOL_NUMBER" }],
  ["part", { type: "PART_COUNT" }],
  ["estop", { type: "EMERGENCY_STOP" }],
]);

describe("deriveEvents", () => {
  it("emits program_change when PROGRAM observation changes", () => {
    const r = deriveEvents(
      [
        { sequence: 1, timestamp_utc: "2026-04-22T10:00:00Z", data_item_id: "prog", value_str: "O1234", value_num: null },
        { sequence: 2, timestamp_utc: "2026-04-22T10:01:00Z", data_item_id: "prog", value_str: "O5678", value_num: null },
      ],
      dataItemTypes,
      { lastProgram: null, lastTool: null, lastPartCount: null, lastEstop: null },
    );
    expect(r.events.some((e) => e.kind === "program_change")).toBe(true);
  });

  it("emits part_completed for positive PART_COUNT delta", () => {
    const r = deriveEvents(
      [
        { sequence: 1, timestamp_utc: "2026-04-22T10:00:00Z", data_item_id: "part", value_str: "42", value_num: 42 },
        { sequence: 2, timestamp_utc: "2026-04-22T10:05:00Z", data_item_id: "part", value_str: "44", value_num: 44 },
      ],
      dataItemTypes,
      { lastProgram: null, lastTool: null, lastPartCount: null, lastEstop: null },
    );
    const parts = r.events.filter((e) => e.kind === "part_completed");
    expect(parts).toHaveLength(2);
  });

  it("emits estop only on TRIGGERED", () => {
    const r = deriveEvents(
      [
        { sequence: 1, timestamp_utc: "2026-04-22T10:00:00Z", data_item_id: "estop", value_str: "ARMED", value_num: null },
        { sequence: 2, timestamp_utc: "2026-04-22T10:01:00Z", data_item_id: "estop", value_str: "TRIGGERED", value_num: null },
        { sequence: 3, timestamp_utc: "2026-04-22T10:02:00Z", data_item_id: "estop", value_str: "ARMED", value_num: null },
      ],
      dataItemTypes,
      { lastProgram: null, lastTool: null, lastPartCount: null, lastEstop: null },
    );
    const e = r.events.filter((x) => x.kind === "estop");
    expect(e).toHaveLength(1);
    expect(e[0].ts).toBe("2026-04-22T10:01:00Z");
  });

  it("does not emit program_change on initial (null -> value) if seeded null", () => {
    const r = deriveEvents(
      [{ sequence: 1, timestamp_utc: "2026-04-22T10:00:00Z", data_item_id: "prog", value_str: "O1", value_num: null }],
      dataItemTypes,
      { lastProgram: null, lastTool: null, lastPartCount: null, lastEstop: null },
    );
    // initial observation sets cursor but does not emit
    expect(r.events.filter((e) => e.kind === "program_change")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `cloud/src/processor/events.ts`**

```typescript
export type EventCursor = {
  lastProgram: string | null;
  lastTool: string | null;
  lastPartCount: number | null;
  lastEstop: string | null;
};

export type EventRecord = {
  ts: string;
  kind:
    | "program_change"
    | "tool_change"
    | "part_completed"
    | "estop"
    | "agent_restart";
  payload: Record<string, unknown>;
};

export type EventResult = {
  events: EventRecord[];
  newCursor: EventCursor;
};

type Obs = {
  sequence: number;
  timestamp_utc: string;
  data_item_id: string;
  value_str: string | null;
  value_num: number | null;
};

export function deriveEvents(
  observations: Obs[],
  dataItemTypes: Map<string, { type: string }>,
  cursor: EventCursor,
): EventResult {
  const events: EventRecord[] = [];
  const c = { ...cursor };

  for (const o of observations) {
    const t = dataItemTypes.get(o.data_item_id)?.type;
    if (!t) continue;

    if (t === "PROGRAM") {
      if (c.lastProgram !== null && c.lastProgram !== o.value_str) {
        events.push({
          ts: o.timestamp_utc,
          kind: "program_change",
          payload: { from: c.lastProgram, to: o.value_str },
        });
      }
      c.lastProgram = o.value_str;
    } else if (t === "TOOL_NUMBER" || t === "TOOL_ASSET_ID") {
      if (c.lastTool !== null && c.lastTool !== o.value_str) {
        events.push({
          ts: o.timestamp_utc,
          kind: "tool_change",
          payload: { from: c.lastTool, to: o.value_str },
        });
      }
      c.lastTool = o.value_str;
    } else if (t === "PART_COUNT") {
      const n = o.value_num;
      if (n !== null && c.lastPartCount !== null && n > c.lastPartCount) {
        const delta = n - c.lastPartCount;
        for (let i = 0; i < delta; i++) {
          events.push({
            ts: o.timestamp_utc,
            kind: "part_completed",
            payload: { count: c.lastPartCount + i + 1 },
          });
        }
      }
      if (n !== null) c.lastPartCount = n;
    } else if (t === "EMERGENCY_STOP") {
      if (
        c.lastEstop !== "TRIGGERED" &&
        (o.value_str ?? "").toUpperCase() === "TRIGGERED"
      ) {
        events.push({
          ts: o.timestamp_utc,
          kind: "estop",
          payload: {},
        });
      }
      c.lastEstop = o.value_str;
    }
  }

  return { events, newCursor: c };
}
```

- [ ] **Step 4: Run — expect pass**

Run: `cd cloud && npm test -- processor.events`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add cloud/src/processor/events.ts cloud/test/processor.events.test.ts
git commit -m "feat(cloud): pure event detector (program, tool, part, estop)"
```

---

## Task 10: Pure minute-rollup accumulator

**Files:**
- Create: `cloud/src/processor/rollups_minute.ts`
- Create: `cloud/test/processor.rollups_minute.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// cloud/test/processor.rollups_minute.test.ts
import { describe, it, expect } from "vitest";
import { deriveMinuteRollups, type ClosedInterval } from "../src/processor/rollups_minute";

const iv = (
  state: string,
  start: string,
  end: string,
  prog: string | null = "O1",
  tool: string | null = "7",
): ClosedInterval => ({
  state: state as ClosedInterval["state"],
  started_at: start,
  ended_at: end,
  program: prog,
  tool_number: tool,
});

describe("deriveMinuteRollups", () => {
  it("attributes a 30s ACTIVE interval entirely to its bucket", () => {
    const r = deriveMinuteRollups(
      [iv("ACTIVE", "2026-04-22T10:00:15Z", "2026-04-22T10:00:45Z")],
      [],
    );
    expect(r.size).toBe(1);
    const row = r.get("2026-04-22T10:00:00Z")!;
    expect(row.active_s).toBe(30);
    expect(row.program).toBe("O1");
  });

  it("splits a 90s interval across 2 buckets correctly", () => {
    const r = deriveMinuteRollups(
      [iv("ACTIVE", "2026-04-22T10:00:30Z", "2026-04-22T10:02:00Z")],
      [],
    );
    expect(r.size).toBe(2);
    expect(r.get("2026-04-22T10:00:00Z")!.active_s).toBe(30);
    expect(r.get("2026-04-22T10:01:00Z")!.active_s).toBe(60);
  });

  it("handles intervals across 3+ buckets (edge-to-edge)", () => {
    const r = deriveMinuteRollups(
      [iv("ACTIVE", "2026-04-22T10:00:30Z", "2026-04-22T10:03:10Z")],
      [],
    );
    expect(r.size).toBe(4);
    expect(r.get("2026-04-22T10:00:00Z")!.active_s).toBe(30);
    expect(r.get("2026-04-22T10:01:00Z")!.active_s).toBe(60);
    expect(r.get("2026-04-22T10:02:00Z")!.active_s).toBe(60);
    expect(r.get("2026-04-22T10:03:00Z")!.active_s).toBe(10);
  });

  it("attributes state seconds by state column", () => {
    const r = deriveMinuteRollups(
      [
        iv("ACTIVE", "2026-04-22T10:00:00Z", "2026-04-22T10:00:30Z"),
        iv("FEED_HOLD", "2026-04-22T10:00:30Z", "2026-04-22T10:00:45Z"),
        iv("STOPPED", "2026-04-22T10:00:45Z", "2026-04-22T10:01:00Z"),
      ],
      [],
    );
    const row = r.get("2026-04-22T10:00:00Z")!;
    expect(row.active_s).toBe(30);
    expect(row.feed_hold_s).toBe(15);
    expect(row.stopped_s).toBe(15);
  });

  it("accumulates part_delta from part_completed events", () => {
    const r = deriveMinuteRollups(
      [iv("ACTIVE", "2026-04-22T10:00:00Z", "2026-04-22T10:02:00Z")],
      [
        { kind: "part_completed", ts: "2026-04-22T10:00:30Z", payload: {} },
        { kind: "part_completed", ts: "2026-04-22T10:01:15Z", payload: {} },
        { kind: "part_completed", ts: "2026-04-22T10:01:45Z", payload: {} },
      ],
    );
    expect(r.get("2026-04-22T10:00:00Z")!.part_delta).toBe(1);
    expect(r.get("2026-04-22T10:01:00Z")!.part_delta).toBe(2);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `cloud/src/processor/rollups_minute.ts`**

```typescript
export type ClosedInterval = {
  state: "ACTIVE" | "FEED_HOLD" | "STOPPED" | "INTERRUPTED" | "READY" | "OFFLINE";
  started_at: string;
  ended_at: string;
  program: string | null;
  tool_number: string | null;
};

export type EventLite = {
  kind: string;
  ts: string;
  payload: Record<string, unknown>;
};

export type MinuteRollup = {
  minute_start: string;
  active_s: number;
  feed_hold_s: number;
  stopped_s: number;
  interrupted_s: number;
  ready_s: number;
  offline_s: number;
  part_delta: number;
  program: string | null;
  tool_number: string | null;
  avg_spindle_rpm: number | null;
  max_spindle_load: number | null;
  avg_feedrate: number | null;
};

const STATE_COL: Record<ClosedInterval["state"], keyof MinuteRollup> = {
  ACTIVE: "active_s",
  FEED_HOLD: "feed_hold_s",
  STOPPED: "stopped_s",
  INTERRUPTED: "interrupted_s",
  READY: "ready_s",
  OFFLINE: "offline_s",
};

function floorMinute(iso: string): string {
  const d = new Date(iso);
  d.setUTCSeconds(0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function addMinute(iso: string): string {
  const d = new Date(iso);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function deriveMinuteRollups(
  intervals: ClosedInterval[],
  events: EventLite[],
): Map<string, MinuteRollup> {
  const buckets = new Map<string, MinuteRollup>();

  function getOrCreate(minute: string): MinuteRollup {
    let b = buckets.get(minute);
    if (!b) {
      b = {
        minute_start: minute,
        active_s: 0,
        feed_hold_s: 0,
        stopped_s: 0,
        interrupted_s: 0,
        ready_s: 0,
        offline_s: 0,
        part_delta: 0,
        program: null,
        tool_number: null,
        avg_spindle_rpm: null,
        max_spindle_load: null,
        avg_feedrate: null,
      };
      buckets.set(minute, b);
    }
    return b;
  }

  for (const iv of intervals) {
    const startMs = Date.parse(iv.started_at);
    const endMs = Date.parse(iv.ended_at);
    let cur = floorMinute(iv.started_at);
    const lastMinute = floorMinute(iv.ended_at);

    while (true) {
      const minStart = Date.parse(cur);
      const minEnd = Date.parse(addMinute(cur));
      const segStart = Math.max(startMs, minStart);
      const segEnd = Math.min(endMs, minEnd);
      const segSeconds = (segEnd - segStart) / 1000;
      if (segSeconds > 0) {
        const b = getOrCreate(cur);
        const col = STATE_COL[iv.state];
        (b as unknown as Record<string, number>)[col] =
          ((b as unknown as Record<string, number>)[col] ?? 0) + segSeconds;
        b.program = iv.program ?? b.program;
        b.tool_number = iv.tool_number ?? b.tool_number;
      }
      if (cur === lastMinute) break;
      cur = addMinute(cur);
    }
  }

  for (const e of events) {
    if (e.kind === "part_completed") {
      const b = getOrCreate(floorMinute(e.ts));
      b.part_delta += 1;
    }
  }

  return buckets;
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add cloud/src/processor/rollups_minute.ts cloud/test/processor.rollups_minute.test.ts
git commit -m "feat(cloud): pure minute-rollup accumulator with multi-bucket attribution"
```

---

## Task 11: Processor cron driver

**Files:**
- Create: `cloud/src/processor/run.ts`
- Create: `cloud/test/processor.run.test.ts`
- Modify: `cloud/src/index.ts` (wire scheduled handler)
- Modify: `cloud/wrangler.jsonc` (add cron trigger)

- [ ] **Step 1: Write the driver** (this task is fatter — reads cursor, loads observations, calls pure processors, writes back, advances cursor, per device)

```typescript
// cloud/src/processor/run.ts
import type { Env } from "../types";
import {
  deriveStateIntervals,
  type StateMachineCursor,
  type ObservationRow,
  type DataItemMeta,
} from "./state_machine";
import {
  deriveConditionTransitions,
  type OpenCondition,
  type ConditionObservation,
} from "./conditions";
import { deriveEvents, type EventCursor } from "./events";
import { deriveMinuteRollups, type ClosedInterval } from "./rollups_minute";

export async function runProcessor(env: Env): Promise<void> {
  const devices = await env.DB.prepare(
    "SELECT device_uuid FROM devices",
  ).all<{ device_uuid: string }>();

  for (const d of devices.results) {
    await processDevice(env, d.device_uuid);
  }
}

async function processDevice(env: Env, deviceUuid: string): Promise<void> {
  // Load cursor
  const cur = await env.DB.prepare(
    "SELECT stream, last_sequence FROM processor_cursors WHERE device_uuid = ?",
  )
    .bind(deviceUuid)
    .all<{ stream: string; last_sequence: number }>();
  const cursors: Record<string, number> = {};
  for (const r of cur.results) cursors[r.stream] = r.last_sequence;

  const stateSince = cursors["state_machine"] ?? 0;
  const condSince = cursors["conditions"] ?? 0;
  const eventSince = cursors["events"] ?? 0;
  const rollupSince = cursors["rollups_minute"] ?? 0;
  const minSince = Math.min(stateSince, condSince, eventSince, rollupSince);

  // Data items lookup
  const diRes = await env.DB.prepare(
    "SELECT data_item_id, category, type FROM data_items WHERE device_uuid = ?",
  )
    .bind(deviceUuid)
    .all<{ data_item_id: string; category: string; type: string }>();
  const dataItemMeta = new Map<string, DataItemMeta>(
    diRes.results.map((r) => [r.data_item_id, { type: r.type, category: r.category }]),
  );
  const dataItemTypesOnly = new Map<string, { type: string }>(
    diRes.results.map((r) => [r.data_item_id, { type: r.type }]),
  );

  // Load observations since the oldest cursor
  const obsRes = await env.DB.prepare(
    `SELECT sequence, timestamp_utc, data_item_id, value_num, value_str, condition_level, condition_native_code, condition_severity, condition_qualifier
     FROM observations WHERE device_uuid = ? AND sequence > ? ORDER BY sequence ASC LIMIT 5000`,
  )
    .bind(deviceUuid, minSince)
    .all<{
      sequence: number;
      timestamp_utc: string;
      data_item_id: string;
      value_num: number | null;
      value_str: string | null;
      condition_level: string | null;
      condition_native_code: string | null;
      condition_severity: string | null;
      condition_qualifier: string | null;
    }>();
  if (obsRes.results.length === 0) return;

  const observations: ObservationRow[] = obsRes.results.map((r) => ({
    sequence: r.sequence,
    timestamp_utc: r.timestamp_utc,
    data_item_id: r.data_item_id,
    value_num: r.value_num,
    value_str: r.value_str,
    condition_level: r.condition_level,
  }));

  // --- state machine
  const smObs = observations.filter((o) => o.sequence > stateSince);
  const smCursor = await loadStateCursor(env, deviceUuid);
  const sm = deriveStateIntervals(smObs, dataItemMeta, smCursor);

  // --- conditions
  const condObs: ConditionObservation[] = obsRes.results
    .filter((r) => r.sequence > condSince && r.condition_level !== null)
    .map((r) => ({
      sequence: r.sequence,
      timestamp_utc: r.timestamp_utc,
      data_item_id: r.data_item_id,
      condition_level: r.condition_level as ConditionObservation["condition_level"],
      condition_native_code: r.condition_native_code,
      condition_severity: r.condition_severity,
      condition_qualifier: r.condition_qualifier,
      message: r.value_str,
    }));
  const openCondMap = await loadOpenConditions(env, deviceUuid);
  const cond = deriveConditionTransitions(condObs, openCondMap);

  // --- events
  const evObs = observations.filter((o) => o.sequence > eventSince);
  const evCursor = await loadEventCursor(env, deviceUuid);
  const ev = deriveEvents(evObs, dataItemTypesOnly, evCursor);

  // --- rollups: feed freshly closed intervals (from this run) + recent events
  const rollupBuckets = deriveMinuteRollups(sm.closedIntervals, ev.events);

  // Writes
  const stmts: D1PreparedStatement[] = [];
  for (const iv of sm.closedIntervals) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO state_intervals (device_uuid, started_at, ended_at, state, program, tool_number, controller_mode)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (device_uuid, started_at) DO NOTHING`,
      ).bind(
        deviceUuid,
        iv.started_at,
        iv.ended_at,
        iv.state,
        iv.program ?? null,
        iv.tool_number ?? null,
        iv.controller_mode ?? null,
      ),
    );
  }
  for (const op of cond.opens) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO conditions (device_uuid, data_item_id, started_at, level, native_code, severity, qualifier, message)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT (device_uuid, data_item_id, started_at) DO NOTHING`,
      ).bind(
        deviceUuid,
        op.data_item_id,
        op.started_at,
        op.level,
        op.native_code,
        op.severity,
        op.qualifier,
        op.message,
      ),
    );
  }
  for (const cl of cond.closes) {
    stmts.push(
      env.DB.prepare(
        "UPDATE conditions SET ended_at = ? WHERE device_uuid = ? AND data_item_id = ? AND started_at = ?",
      ).bind(cl.ended_at, deviceUuid, cl.data_item_id, cl.started_at),
    );
  }
  for (const e of ev.events) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO events (device_uuid, ts, kind, payload_json) VALUES (?,?,?,?)
         ON CONFLICT (device_uuid, ts, kind) DO NOTHING`,
      ).bind(deviceUuid, e.ts, e.kind, JSON.stringify(e.payload)),
    );
  }
  for (const b of rollupBuckets.values()) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO rollups_minute (device_uuid, minute_start, active_s, feed_hold_s, stopped_s, interrupted_s, ready_s, offline_s, part_delta, program, tool_number, avg_spindle_rpm, max_spindle_load, avg_feedrate)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (device_uuid, minute_start) DO UPDATE SET
           active_s = rollups_minute.active_s + excluded.active_s,
           feed_hold_s = rollups_minute.feed_hold_s + excluded.feed_hold_s,
           stopped_s = rollups_minute.stopped_s + excluded.stopped_s,
           interrupted_s = rollups_minute.interrupted_s + excluded.interrupted_s,
           ready_s = rollups_minute.ready_s + excluded.ready_s,
           offline_s = rollups_minute.offline_s + excluded.offline_s,
           part_delta = rollups_minute.part_delta + excluded.part_delta,
           program = COALESCE(excluded.program, rollups_minute.program),
           tool_number = COALESCE(excluded.tool_number, rollups_minute.tool_number)`,
      ).bind(
        deviceUuid,
        b.minute_start,
        b.active_s,
        b.feed_hold_s,
        b.stopped_s,
        b.interrupted_s,
        b.ready_s,
        b.offline_s,
        b.part_delta,
        b.program,
        b.tool_number,
        b.avg_spindle_rpm,
        b.max_spindle_load,
        b.avg_feedrate,
      ),
    );
  }

  // Advance cursors to highest sequence seen
  const maxSeq = observations.at(-1)!.sequence;
  const now = new Date().toISOString();
  for (const stream of ["state_machine", "conditions", "events", "rollups_minute"]) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO processor_cursors (device_uuid, stream, last_sequence, last_run_at)
         VALUES (?,?,?,?)
         ON CONFLICT (device_uuid, stream) DO UPDATE SET last_sequence = excluded.last_sequence, last_run_at = excluded.last_run_at`,
      ).bind(deviceUuid, stream, maxSeq, now),
    );
  }

  // Persist state machine cursor as KV-ish row in processor_cursors metadata
  stmts.push(
    env.DB.prepare(
      `INSERT INTO processor_cursors (device_uuid, stream, last_sequence, last_run_at)
       VALUES (?, 'state_machine_state', ?, ?)
       ON CONFLICT (device_uuid, stream) DO UPDATE SET last_sequence = excluded.last_sequence, last_run_at = excluded.last_run_at`,
    ).bind(
      deviceUuid,
      encodeStateCursor(sm.newState),
      now,
    ),
  );
  stmts.push(
    env.DB.prepare(
      `INSERT INTO processor_cursors (device_uuid, stream, last_sequence, last_run_at)
       VALUES (?, 'event_cursor', ?, ?)
       ON CONFLICT (device_uuid, stream) DO UPDATE SET last_sequence = excluded.last_sequence, last_run_at = excluded.last_run_at`,
    ).bind(deviceUuid, encodeEventCursor(ev.newCursor), now),
  );

  await env.DB.batch(stmts);
}

// Cursors encoded as int by hash of small JSON — keep it simple by stashing in dedicated table... but schema has no such column.
// Simpler: put JSON in last_run_at? No. Use dedicated tables.
async function loadStateCursor(
  env: Env,
  deviceUuid: string,
): Promise<StateMachineCursor> {
  const r = await env.DB.prepare(
    "SELECT last_run_at FROM processor_cursors WHERE device_uuid = ? AND stream = 'state_machine_state'",
  )
    .bind(deviceUuid)
    .first<{ last_run_at: string | null }>();
  if (!r || !r.last_run_at) {
    return {
      lastState: null,
      lastStateStart: null,
      lastProgram: null,
      lastTool: null,
      lastControllerMode: null,
    };
  }
  try {
    return JSON.parse(r.last_run_at);
  } catch {
    return {
      lastState: null,
      lastStateStart: null,
      lastProgram: null,
      lastTool: null,
      lastControllerMode: null,
    };
  }
}

async function loadEventCursor(env: Env, deviceUuid: string): Promise<EventCursor> {
  const r = await env.DB.prepare(
    "SELECT last_run_at FROM processor_cursors WHERE device_uuid = ? AND stream = 'event_cursor'",
  )
    .bind(deviceUuid)
    .first<{ last_run_at: string | null }>();
  if (!r || !r.last_run_at) {
    return { lastProgram: null, lastTool: null, lastPartCount: null, lastEstop: null };
  }
  try {
    return JSON.parse(r.last_run_at);
  } catch {
    return { lastProgram: null, lastTool: null, lastPartCount: null, lastEstop: null };
  }
}

async function loadOpenConditions(
  env: Env,
  deviceUuid: string,
): Promise<Map<string, OpenCondition>> {
  const res = await env.DB.prepare(
    "SELECT data_item_id, started_at, level, native_code FROM conditions WHERE device_uuid = ? AND ended_at IS NULL",
  )
    .bind(deviceUuid)
    .all<{ data_item_id: string; started_at: string; level: string; native_code: string | null }>();
  const m = new Map<string, OpenCondition>();
  for (const r of res.results) {
    m.set(r.data_item_id, {
      started_at: r.started_at,
      level: r.level as OpenCondition["level"],
      native_code: r.native_code,
    });
  }
  return m;
}

function encodeStateCursor(c: StateMachineCursor): string {
  return JSON.stringify(c);
}
function encodeEventCursor(c: EventCursor): string {
  return JSON.stringify(c);
}
```

Note on cursor storage: we piggyback cursor JSON in `processor_cursors.last_run_at` for the pseudo-streams `state_machine_state` and `event_cursor`, keeping migrations minimal. If this feels hacky later, add a dedicated `processor_state(device_uuid, stream, state_json)` table in a follow-up migration.

- [ ] **Step 2: Write integration test that exercises the full driver against seeded observations**

```typescript
// cloud/test/processor.run.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./migrations";
import { runProcessor } from "../src/processor/run";
import type { Env } from "../src/types";

const e = env as unknown as Env;

async function reset() {
  await applyMigrations(e);
  await e.DB.prepare("DELETE FROM observations").run();
  await e.DB.prepare("DELETE FROM state_intervals").run();
  await e.DB.prepare("DELETE FROM events").run();
  await e.DB.prepare("DELETE FROM conditions").run();
  await e.DB.prepare("DELETE FROM rollups_minute").run();
  await e.DB.prepare("DELETE FROM processor_cursors").run();
  await e.DB.prepare("DELETE FROM data_items").run();
  await e.DB.prepare("DELETE FROM devices").run();
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
```

- [ ] **Step 3: Run — expect pass**

Run: `cd cloud && npm test -- processor.run`
Expected: 3 tests pass.

- [ ] **Step 4: Wire cron in `cloud/src/index.ts`**

```typescript
import { runProcessor } from "./processor/run";
// ...
export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const cron = controller.cron;
    if (cron === "*/1 * * * *") {
      await runProcessor(env);
    }
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 5: Wire cron trigger in `cloud/wrangler.jsonc`**

```jsonc
"triggers": { "crons": ["*/1 * * * *"] }
```

- [ ] **Step 6: Commit**

```bash
git add cloud/src/processor/run.ts cloud/src/index.ts cloud/wrangler.jsonc cloud/test/processor.run.test.ts
git commit -m "feat(cloud): processor cron driver wiring state machine + conditions + events + rollups"
```

---

## Task 12: Alert rules (pure) + scanner (cron driver)

**Files:**
- Create: `cloud/src/alerts/rules.ts`
- Create: `cloud/src/alerts/slack.ts`
- Create: `cloud/src/alerts/scanner.ts`
- Create: `cloud/test/alerts.rules.test.ts`
- Create: `cloud/test/alerts.scanner.test.ts`
- Modify: `cloud/src/index.ts`
- Modify: `cloud/wrangler.jsonc` (add 30s-ish cron — min is 1m, so use `*/1 * * * *` with a time-of-day filter; or accept 60s cadence in Phase 1 and tune later)

- [ ] **Step 1: Write rules tests**

```typescript
// cloud/test/alerts.rules.test.ts
import { describe, it, expect } from "vitest";
import { scanAlerts, type AlertInput } from "../src/alerts/rules";

const now = (iso: string) => new Date(iso);

describe("scanAlerts", () => {
  it("fires feed_hold_extended when FEED_HOLD open > 10min", () => {
    const input: AlertInput = {
      nowUtc: "2026-04-22T10:15:00Z",
      openIntervals: [
        { state: "FEED_HOLD", started_at: "2026-04-22T10:00:00Z" },
      ],
      openConditions: [],
      latestObservationTs: "2026-04-22T10:14:55Z",
      recentEstop: false,
    };
    const r = scanAlerts(input);
    expect(r.map((a) => a.kind)).toContain("feed_hold_extended");
  });

  it("fires alarm_sustained when FAULT open > 2min", () => {
    const input: AlertInput = {
      nowUtc: "2026-04-22T10:03:00Z",
      openIntervals: [],
      openConditions: [
        { data_item_id: "logic", level: "FAULT", started_at: "2026-04-22T10:00:30Z" },
      ],
      latestObservationTs: "2026-04-22T10:02:55Z",
      recentEstop: false,
    };
    const r = scanAlerts(input);
    expect(r.map((a) => a.kind)).toContain("alarm_sustained");
  });

  it("fires offline when no observation in > 5min", () => {
    const input: AlertInput = {
      nowUtc: "2026-04-22T10:10:00Z",
      openIntervals: [],
      openConditions: [],
      latestObservationTs: "2026-04-22T10:03:00Z",
      recentEstop: false,
    };
    const r = scanAlerts(input);
    expect(r.map((a) => a.kind)).toContain("offline");
  });

  it("fires estop_triggered when recentEstop", () => {
    const input: AlertInput = {
      nowUtc: "2026-04-22T10:10:00Z",
      openIntervals: [],
      openConditions: [],
      latestObservationTs: "2026-04-22T10:09:59Z",
      recentEstop: true,
    };
    const r = scanAlerts(input);
    expect(r.map((a) => a.kind)).toContain("estop_triggered");
  });

  it("fires idle_during_shift when STOPPED > 20min and no FAULT", () => {
    const input: AlertInput = {
      nowUtc: "2026-04-22T10:30:00Z",
      openIntervals: [
        { state: "STOPPED", started_at: "2026-04-22T10:05:00Z" },
      ],
      openConditions: [],
      latestObservationTs: "2026-04-22T10:29:55Z",
      recentEstop: false,
    };
    const r = scanAlerts(input);
    expect(r.map((a) => a.kind)).toContain("idle_during_shift");
  });

  it("does not fire idle_during_shift if FAULT condition is open", () => {
    const input: AlertInput = {
      nowUtc: "2026-04-22T10:30:00Z",
      openIntervals: [
        { state: "STOPPED", started_at: "2026-04-22T10:05:00Z" },
      ],
      openConditions: [
        { data_item_id: "logic", level: "FAULT", started_at: "2026-04-22T10:05:00Z" },
      ],
      latestObservationTs: "2026-04-22T10:29:55Z",
      recentEstop: false,
    };
    const r = scanAlerts(input);
    expect(r.map((a) => a.kind)).not.toContain("idle_during_shift");
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `cloud/src/alerts/rules.ts`**

```typescript
export type AlertKind =
  | "feed_hold_extended"
  | "idle_during_shift"
  | "alarm_sustained"
  | "offline"
  | "estop_triggered"
  | "spindle_overload";

export type AlertOut = {
  kind: AlertKind;
  severity: "warning" | "fault";
  triggered_at: string;
  message: string;
};

export type AlertInput = {
  nowUtc: string;
  openIntervals: Array<{
    state: "ACTIVE" | "FEED_HOLD" | "STOPPED" | "INTERRUPTED" | "READY" | "OFFLINE";
    started_at: string;
  }>;
  openConditions: Array<{
    data_item_id: string;
    level: "WARNING" | "FAULT" | "UNAVAILABLE";
    started_at: string;
  }>;
  latestObservationTs: string | null;
  recentEstop: boolean;
};

function elapsedSeconds(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 1000;
}

export function scanAlerts(i: AlertInput): AlertOut[] {
  const out: AlertOut[] = [];

  for (const iv of i.openIntervals) {
    if (iv.state === "FEED_HOLD" && elapsedSeconds(iv.started_at, i.nowUtc) > 600) {
      out.push({
        kind: "feed_hold_extended",
        severity: "warning",
        triggered_at: iv.started_at,
        message: `Feed hold open > 10 min since ${iv.started_at}`,
      });
    }
    if (iv.state === "STOPPED" && elapsedSeconds(iv.started_at, i.nowUtc) > 1200) {
      const hasFault = i.openConditions.some((c) => c.level === "FAULT");
      if (!hasFault) {
        out.push({
          kind: "idle_during_shift",
          severity: "warning",
          triggered_at: iv.started_at,
          message: `Idle > 20 min since ${iv.started_at}`,
        });
      }
    }
  }

  for (const c of i.openConditions) {
    if (c.level === "FAULT" && elapsedSeconds(c.started_at, i.nowUtc) > 120) {
      out.push({
        kind: "alarm_sustained",
        severity: "fault",
        triggered_at: c.started_at,
        message: `Fault on ${c.data_item_id} sustained > 2 min`,
      });
    }
  }

  if (
    !i.latestObservationTs ||
    elapsedSeconds(i.latestObservationTs, i.nowUtc) > 300
  ) {
    out.push({
      kind: "offline",
      severity: "fault",
      triggered_at: i.latestObservationTs ?? i.nowUtc,
      message: "No observations in > 5 min",
    });
  }

  if (i.recentEstop) {
    out.push({
      kind: "estop_triggered",
      severity: "fault",
      triggered_at: i.nowUtc,
      message: "E-stop triggered",
    });
  }

  return out;
}
```

- [ ] **Step 4: Run — expect pass**

Run: `cd cloud && npm test -- alerts.rules`
Expected: 6 tests pass.

- [ ] **Step 5: Implement Slack fanout (minimal)**

```typescript
// cloud/src/alerts/slack.ts
export async function postToSlack(
  webhookUrl: string | undefined,
  text: string,
): Promise<void> {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {
    // swallow — alert is already persisted in D1; Slack is best-effort
  }
}
```

- [ ] **Step 6: Implement scanner cron driver**

```typescript
// cloud/src/alerts/scanner.ts
import type { Env } from "../types";
import { scanAlerts, type AlertInput } from "./rules";
import { postToSlack } from "./slack";

export async function runAlertScanner(env: Env): Promise<void> {
  const nowUtc = new Date().toISOString();
  const devices = await env.DB.prepare(
    "SELECT device_uuid, name FROM devices",
  ).all<{ device_uuid: string; name: string }>();

  for (const d of devices.results) {
    await scanDevice(env, d.device_uuid, d.name, nowUtc);
  }
}

async function scanDevice(
  env: Env,
  deviceUuid: string,
  deviceName: string,
  nowUtc: string,
): Promise<void> {
  // Open intervals = most recent state_intervals row whose ended_at is the latest
  // In v2 we don't have open intervals as a table — infer from state cursor.
  // Simplification for Phase 1: treat the "lastState" from processor_cursors JSON as the current open interval.
  const stateRow = await env.DB.prepare(
    "SELECT last_run_at FROM processor_cursors WHERE device_uuid = ? AND stream = 'state_machine_state'",
  )
    .bind(deviceUuid)
    .first<{ last_run_at: string | null }>();
  const openIntervals: AlertInput["openIntervals"] = [];
  if (stateRow?.last_run_at) {
    try {
      const c = JSON.parse(stateRow.last_run_at);
      if (c.lastState && c.lastStateStart) {
        openIntervals.push({ state: c.lastState, started_at: c.lastStateStart });
      }
    } catch {
      /* ignore */
    }
  }

  const openCondsRes = await env.DB.prepare(
    "SELECT data_item_id, level, started_at FROM conditions WHERE device_uuid = ? AND ended_at IS NULL",
  )
    .bind(deviceUuid)
    .all<{ data_item_id: string; level: string; started_at: string }>();
  const openConditions = openCondsRes.results.map((r) => ({
    data_item_id: r.data_item_id,
    level: r.level as "WARNING" | "FAULT" | "UNAVAILABLE",
    started_at: r.started_at,
  }));

  const latestObs = await env.DB.prepare(
    "SELECT MAX(timestamp_utc) AS ts FROM observations WHERE device_uuid = ?",
  )
    .bind(deviceUuid)
    .first<{ ts: string | null }>();

  const recentEstopRow = await env.DB.prepare(
    "SELECT 1 AS x FROM events WHERE device_uuid = ? AND kind = 'estop' AND ts > datetime('now','-60 seconds') LIMIT 1",
  )
    .bind(deviceUuid)
    .first<{ x: number }>();

  const alerts = scanAlerts({
    nowUtc,
    openIntervals,
    openConditions,
    latestObservationTs: latestObs?.ts ?? null,
    recentEstop: !!recentEstopRow,
  });

  for (const a of alerts) {
    // Insert or rearm — one open alert per (device_uuid, kind)
    const existing = await env.DB.prepare(
      "SELECT id FROM alerts WHERE device_uuid = ? AND kind = ? AND cleared_at IS NULL LIMIT 1",
    )
      .bind(deviceUuid, a.kind)
      .first<{ id: number }>();
    if (existing) continue; // already firing
    await env.DB.prepare(
      "INSERT INTO alerts (device_uuid, kind, severity, triggered_at, message) VALUES (?,?,?,?,?)",
    )
      .bind(deviceUuid, a.kind, a.severity, a.triggered_at, a.message)
      .run();
    await postToSlack(
      env.SLACK_WEBHOOK_URL,
      `[${a.severity.toUpperCase()}] ${deviceName}: ${a.message}`,
    );
  }

  // Auto-clear: if an alert was firing but the condition is no longer true, clear it.
  const openAlerts = await env.DB.prepare(
    "SELECT id, kind FROM alerts WHERE device_uuid = ? AND cleared_at IS NULL",
  )
    .bind(deviceUuid)
    .all<{ id: number; kind: string }>();
  const firingKinds = new Set(alerts.map((a) => a.kind));
  for (const oa of openAlerts.results) {
    if (!firingKinds.has(oa.kind)) {
      await env.DB.prepare("UPDATE alerts SET cleared_at = ? WHERE id = ?")
        .bind(nowUtc, oa.id)
        .run();
    }
  }
}
```

- [ ] **Step 7: Scanner integration test**

```typescript
// cloud/test/alerts.scanner.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./migrations";
import { runAlertScanner } from "../src/alerts/scanner";
import type { Env } from "../src/types";

const e = env as unknown as Env;

async function reset() {
  await applyMigrations(e);
  await e.DB.prepare("DELETE FROM alerts").run();
  await e.DB.prepare("DELETE FROM processor_cursors").run();
  await e.DB.prepare("DELETE FROM conditions").run();
  await e.DB.prepare("DELETE FROM observations").run();
  await e.DB.prepare("DELETE FROM devices").run();
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
    const rows = await e.DB.prepare("SELECT kind FROM alerts").all<{ kind: string }>();
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
```

- [ ] **Step 8: Wire scanner into scheduled handler**

In `cloud/src/index.ts`, update `scheduled`:

```typescript
import { runAlertScanner } from "./alerts/scanner";
// ...
async scheduled(controller, env, _ctx) {
  if (controller.cron === "*/1 * * * *") {
    await runProcessor(env);
    await runAlertScanner(env);
  }
}
```

- [ ] **Step 9: Run tests**

Run: `cd cloud && npm test -- alerts`
Expected: 8 tests pass (6 rules + 2 scanner).

- [ ] **Step 10: Commit**

```bash
git add cloud/src/alerts cloud/test/alerts.rules.test.ts cloud/test/alerts.scanner.test.ts cloud/src/index.ts
git commit -m "feat(cloud): alert rule engine + cron scanner with Slack fanout and auto-clear"
```

---

## Task 13: Read API — GET /machines

**Files:**
- Create: `cloud/src/read/machines.ts`
- Create: `cloud/test/read.machines.test.ts`
- Modify: `cloud/src/index.ts`

- [ ] **Step 1: Write test**

```typescript
// cloud/test/read.machines.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./migrations";
import app from "../src/index";
import type { Env } from "../src/types";

const e = env as unknown as Env;

async function reset() {
  await applyMigrations(e);
  await e.DB.prepare("DELETE FROM observations").run();
  await e.DB.prepare("DELETE FROM devices").run();
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
    const body = (await res.json()) as { machines: Array<{ device_uuid: string; name: string }> };
    expect(body.machines.map((m) => m.name).sort()).toEqual(["Haas-VF2", "Okuma-P300"]);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

```typescript
// cloud/src/read/machines.ts
import { Hono } from "hono";
import type { Env } from "../types";

export const machinesRead = new Hono<{ Bindings: Env }>();

machinesRead.get("/", async (c) => {
  const res = await c.env.DB.prepare(
    `SELECT d.device_uuid, d.name, d.model, d.controller_type, d.controller_vendor,
            (SELECT MAX(timestamp_utc) FROM observations o WHERE o.device_uuid = d.device_uuid) AS last_observation_ts
     FROM devices d
     ORDER BY d.name`,
  ).all();
  return c.json({ machines: res.results });
});
```

- [ ] **Step 4: Wire route**

```typescript
// cloud/src/index.ts
import { machinesRead } from "./read/machines";
// ...
app.route("/machines", machinesRead);
```

- [ ] **Step 5: Run — expect pass, commit**

```bash
git add cloud/src/read/machines.ts cloud/src/index.ts cloud/test/read.machines.test.ts
git commit -m "feat(cloud): GET /machines listing devices + latest observation timestamp"
```

---

## Task 14: Read API — GET /machines/:id/current

**Files:**
- Create: `cloud/src/read/current.ts`
- Create: `cloud/test/read.current.test.ts`
- Modify: `cloud/src/index.ts`

- [ ] **Step 1: Write test** (exercise: latest observation per data_item_id)

```typescript
// cloud/test/read.current.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./migrations";
import app from "../src/index";
import type { Env } from "../src/types";

const e = env as unknown as Env;

async function seed() {
  await applyMigrations(e);
  await e.DB.prepare("DELETE FROM observations").run();
  await e.DB.prepare("DELETE FROM data_items").run();
  await e.DB.prepare("DELETE FROM devices").run();
  await e.DB.prepare("INSERT INTO devices (device_uuid, name) VALUES ('d1','Haas')").run();
  await e.DB.prepare(
    "INSERT INTO data_items (device_uuid, data_item_id, category, type) VALUES ('d1','exec','EVENT','EXECUTION'),('d1','rpm','SAMPLE','SPINDLE_SPEED')",
  ).run();
  // Older obs for exec
  await e.DB.prepare(
    "INSERT INTO observations (device_uuid, sequence, timestamp_utc, data_item_id, value_str) VALUES ('d1',1,'2026-04-22T09:59:00Z','exec','READY')",
  ).run();
  // Latest obs for exec
  await e.DB.prepare(
    "INSERT INTO observations (device_uuid, sequence, timestamp_utc, data_item_id, value_str) VALUES ('d1',2,'2026-04-22T10:00:00Z','exec','ACTIVE')",
  ).run();
  // Sample
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
    const body = (await res.json()) as { observations: Record<string, unknown>[] };
    const byId = new Map(body.observations.map((o: any) => [o.data_item_id, o]));
    expect((byId.get("exec") as any).value_str).toBe("ACTIVE");
    expect((byId.get("rpm") as any).value_num).toBe(1200);
  });

  it("404s for unknown device", async () => {
    const res = await app.fetch(
      new Request("http://test/machines/nope/current"),
      env,
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

Add to `cloud/src/read/machines.ts`:

```typescript
machinesRead.get("/:id/current", async (c) => {
  const id = c.req.param("id");
  const dev = await c.env.DB.prepare(
    "SELECT device_uuid FROM devices WHERE device_uuid = ?",
  )
    .bind(id)
    .first();
  if (!dev) return c.json({ error: "not found" }, 404);
  const res = await c.env.DB.prepare(
    `SELECT o.data_item_id, o.timestamp_utc, o.value_num, o.value_str,
            o.condition_level, o.condition_native_code, o.condition_severity,
            di.category, di.type, di.sub_type
     FROM observations o
     JOIN data_items di ON di.device_uuid = o.device_uuid AND di.data_item_id = o.data_item_id
     WHERE o.device_uuid = ?
       AND o.sequence = (
         SELECT MAX(sequence) FROM observations o2
         WHERE o2.device_uuid = o.device_uuid AND o2.data_item_id = o.data_item_id
       )`,
  )
    .bind(id)
    .all();
  return c.json({ device_uuid: id, observations: res.results });
});
```

- [ ] **Step 4: Run — expect pass, commit**

```bash
git add cloud/src/read/machines.ts cloud/test/read.current.test.ts
git commit -m "feat(cloud): GET /machines/:id/current returns latest observation per data_item"
```

---

## Task 15: Read API — GET /machines/:id/sample

**Files:**
- Create: `cloud/test/read.sample.test.ts`
- Modify: `cloud/src/read/machines.ts` (add route)

- [ ] **Step 1: Write test**

```typescript
// cloud/test/read.sample.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./migrations";
import app from "../src/index";
import type { Env } from "../src/types";

const e = env as unknown as Env;

async function seed() {
  await applyMigrations(e);
  await e.DB.prepare("DELETE FROM observations").run();
  await e.DB.prepare("DELETE FROM data_items").run();
  await e.DB.prepare("DELETE FROM devices").run();
  await e.DB.prepare("INSERT INTO devices (device_uuid, name) VALUES ('d1','Haas')").run();
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
    const body = (await res.json()) as { observations: { data_item_id: string }[] };
    expect(body.observations.every((o) => o.data_item_id === "exec")).toBe(true);
  });
});
```

- [ ] **Step 2: Implement route in `cloud/src/read/machines.ts`**

```typescript
machinesRead.get("/:id/sample", async (c) => {
  const id = c.req.param("id");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const typesCsv = c.req.query("types");
  if (!from || !to) return c.json({ error: "from and to required" }, 400);

  const types = typesCsv ? typesCsv.split(",").map((s) => s.trim()).filter(Boolean) : null;
  let sql = `SELECT o.sequence, o.timestamp_utc, o.data_item_id, o.value_num, o.value_str, o.condition_level, di.type
             FROM observations o
             JOIN data_items di ON di.device_uuid = o.device_uuid AND di.data_item_id = o.data_item_id
             WHERE o.device_uuid = ?
               AND o.timestamp_utc >= ?
               AND o.timestamp_utc <= ?`;
  const bindings: unknown[] = [id, from, to];
  if (types && types.length > 0) {
    const placeholders = types.map(() => "?").join(",");
    sql += ` AND di.type IN (${placeholders})`;
    bindings.push(...types);
  }
  sql += " ORDER BY o.timestamp_utc, o.sequence LIMIT 10000";
  const res = await c.env.DB.prepare(sql).bind(...bindings).all();
  return c.json({ device_uuid: id, observations: res.results });
});
```

- [ ] **Step 3: Run — expect pass, commit**

```bash
git add cloud/src/read/machines.ts cloud/test/read.sample.test.ts
git commit -m "feat(cloud): GET /machines/:id/sample with type filter and time window"
```

---

## Task 16: Read API — GET /machines/:id/utilization

**Files:**
- Create: `cloud/src/read/utilization.ts`
- Create: `cloud/test/read.utilization.test.ts`
- Modify: `cloud/src/index.ts`

- [ ] **Step 1: Write test**

```typescript
// cloud/test/read.utilization.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./migrations";
import app from "../src/index";
import type { Env } from "../src/types";

const e = env as unknown as Env;

async function seed() {
  await applyMigrations(e);
  await e.DB.prepare("DELETE FROM rollups_minute").run();
  await e.DB.prepare("DELETE FROM devices").run();
  await e.DB.prepare("INSERT INTO devices (device_uuid, name) VALUES ('d1','Haas')").run();
  await e.DB.prepare(
    `INSERT INTO rollups_minute (device_uuid, minute_start, active_s, feed_hold_s, stopped_s, interrupted_s, offline_s, part_delta)
     VALUES ('d1','2026-04-22T10:00:00Z',30,10,20,0,0,0),
            ('d1','2026-04-22T10:01:00Z',60,0,0,0,0,1)`,
  ).run();
}

describe("GET /machines/:id/utilization", () => {
  beforeEach(seed);

  it("returns availability_pct and utilization_pct over a day", async () => {
    const res = await app.fetch(
      new Request("http://test/machines/d1/utilization?date=2026-04-22"),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      availability_pct: number;
      utilization_pct: number;
      part_count: number;
      scheduled_seconds: number;
    };
    // scheduled_seconds default = 8h = 28800
    // total active = 90, feed_hold = 10
    // utilization = 90/28800, availability = (90+10)/28800
    expect(body.scheduled_seconds).toBe(28800);
    expect(body.utilization_pct).toBeCloseTo(90 / 28800, 5);
    expect(body.availability_pct).toBeCloseTo(100 / 28800, 5);
    expect(body.part_count).toBe(1);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// cloud/src/read/utilization.ts
import { Hono } from "hono";
import type { Env } from "../types";

export const utilizationRead = new Hono<{ Bindings: Env }>();

utilizationRead.get("/:id/utilization", async (c) => {
  const id = c.req.param("id");
  const date = c.req.query("date"); // YYYY-MM-DD
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "date=YYYY-MM-DD required" }, 400);
  }
  const from = `${date}T00:00:00Z`;
  const to = `${date}T23:59:59Z`;
  const row = await c.env.DB.prepare(
    `SELECT
       COALESCE(SUM(active_s), 0) AS active_s,
       COALESCE(SUM(feed_hold_s), 0) AS feed_hold_s,
       COALESCE(SUM(part_delta), 0) AS part_count
     FROM rollups_minute
     WHERE device_uuid = ? AND minute_start >= ? AND minute_start <= ?`,
  )
    .bind(id, from, to)
    .first<{ active_s: number; feed_hold_s: number; part_count: number }>();

  const scheduledSeconds = 8 * 3600; // default single-shift; per-machine override in Phase 3
  const active = row?.active_s ?? 0;
  const feedHold = row?.feed_hold_s ?? 0;
  return c.json({
    device_uuid: id,
    date,
    scheduled_seconds: scheduledSeconds,
    availability_pct: (active + feedHold) / scheduledSeconds,
    utilization_pct: active / scheduledSeconds,
    part_count: row?.part_count ?? 0,
    note: "utilization only — true OEE requires Performance and Quality legs (see spec § Out of scope)",
  });
});
```

- [ ] **Step 3: Wire route**

```typescript
// cloud/src/index.ts
import { utilizationRead } from "./read/utilization";
app.route("/machines", utilizationRead);
```

- [ ] **Step 4: Run — expect pass, commit**

```bash
git add cloud/src/read/utilization.ts cloud/src/index.ts cloud/test/read.utilization.test.ts
git commit -m "feat(cloud): GET /machines/:id/utilization with honest labeling (not full OEE)"
```

---

## Task 17: Read API — GET /alerts + POST /alerts/:id/ack

**Files:**
- Create: `cloud/src/read/alerts.ts`
- Create: `cloud/test/read.alerts.test.ts`
- Modify: `cloud/src/index.ts`

- [ ] **Step 1: Test**

```typescript
// cloud/test/read.alerts.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./migrations";
import app from "../src/index";
import type { Env } from "../src/types";

const e = env as unknown as Env;

async function seed() {
  await applyMigrations(e);
  await e.DB.prepare("DELETE FROM alerts").run();
  await e.DB.prepare("DELETE FROM devices").run();
  await e.DB.prepare("INSERT INTO devices (device_uuid, name) VALUES ('d1','Haas')").run();
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
    const res = await app.fetch(new Request("http://test/alerts?include_cleared=1"), env);
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
```

- [ ] **Step 2: Implement**

```typescript
// cloud/src/read/alerts.ts
import { Hono } from "hono";
import type { Env } from "../types";

export const alertsRead = new Hono<{ Bindings: Env }>();

alertsRead.get("/", async (c) => {
  const includeCleared = c.req.query("include_cleared") === "1";
  const sql = includeCleared
    ? "SELECT * FROM alerts ORDER BY triggered_at DESC LIMIT 500"
    : "SELECT * FROM alerts WHERE cleared_at IS NULL ORDER BY triggered_at DESC LIMIT 500";
  const res = await c.env.DB.prepare(sql).all();
  return c.json({ alerts: res.results });
});

alertsRead.post("/:id/ack", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const body = (await c.req.json<{ acknowledged_by?: string }>().catch(() => ({}))) ?? {};
  const by = body.acknowledged_by ?? "unknown";
  const now = new Date().toISOString();
  const res = await c.env.DB.prepare(
    "UPDATE alerts SET acknowledged_by = COALESCE(acknowledged_by, ?), acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?",
  )
    .bind(by, now, id)
    .run();
  if (res.meta.changes === 0) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});
```

- [ ] **Step 3: Wire route**

```typescript
// cloud/src/index.ts
import { alertsRead } from "./read/alerts";
app.route("/alerts", alertsRead);
```

- [ ] **Step 4: Run, commit**

```bash
git add cloud/src/read/alerts.ts cloud/src/index.ts cloud/test/read.alerts.test.ts
git commit -m "feat(cloud): GET /alerts + POST /alerts/:id/ack"
```

---

## Task 18: Nightly shift rollup cron

**Files:**
- Create: `cloud/src/shift/rollup.ts`
- Create: `cloud/test/shift.rollup.test.ts`
- Modify: `cloud/src/index.ts`
- Modify: `cloud/wrangler.jsonc` (add nightly cron)

- [ ] **Step 1: Write test**

```typescript
// cloud/test/shift.rollup.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./migrations";
import { computeShiftRollup } from "../src/shift/rollup";
import type { Env } from "../src/types";

const e = env as unknown as Env;

async function seed() {
  await applyMigrations(e);
  await e.DB.prepare("DELETE FROM rollups_shift").run();
  await e.DB.prepare("DELETE FROM rollups_minute").run();
  await e.DB.prepare("DELETE FROM alerts").run();
  await e.DB.prepare("DELETE FROM devices").run();
  await e.DB.prepare("INSERT INTO devices (device_uuid, name) VALUES ('d1','Haas')").run();
  await e.DB.prepare(
    `INSERT INTO rollups_minute (device_uuid, minute_start, active_s, feed_hold_s, stopped_s, part_delta)
     VALUES ('d1','2026-04-22T10:00:00Z',60,0,0,1),('d1','2026-04-22T10:01:00Z',60,0,0,1)`,
  ).run();
  await e.DB.prepare(
    "INSERT INTO alerts (device_uuid, kind, severity, triggered_at) VALUES ('d1','alarm_sustained','fault','2026-04-22T10:00:30Z')",
  ).run();
}

describe("computeShiftRollup", () => {
  beforeEach(seed);

  it("writes a rollups_shift row for the given date", async () => {
    await computeShiftRollup(e, "2026-04-22");
    const row = await e.DB.prepare(
      "SELECT * FROM rollups_shift WHERE device_uuid='d1' AND shift_date='2026-04-22'",
    ).first<{ part_count: number; alarm_count: number; utilization_pct: number }>();
    expect(row).not.toBeNull();
    expect(row!.part_count).toBe(2);
    expect(row!.alarm_count).toBe(1);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// cloud/src/shift/rollup.ts
import type { Env } from "../types";

const SCHEDULED_SECONDS_DEFAULT = 8 * 3600;

export async function computeShiftRollup(env: Env, date: string): Promise<void> {
  const from = `${date}T00:00:00Z`;
  const to = `${date}T23:59:59Z`;

  const devices = await env.DB.prepare("SELECT device_uuid FROM devices").all<{ device_uuid: string }>();

  for (const d of devices.results) {
    const r = await env.DB.prepare(
      `SELECT
         COALESCE(SUM(active_s), 0) AS active_s,
         COALESCE(SUM(feed_hold_s), 0) AS feed_hold_s,
         COALESCE(SUM(part_delta), 0) AS part_count
       FROM rollups_minute
       WHERE device_uuid = ? AND minute_start >= ? AND minute_start <= ?`,
    )
      .bind(d.device_uuid, from, to)
      .first<{ active_s: number; feed_hold_s: number; part_count: number }>();

    const alarms = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM alerts WHERE device_uuid = ? AND severity = 'fault' AND triggered_at >= ? AND triggered_at <= ?",
    )
      .bind(d.device_uuid, from, to)
      .first<{ count: number }>();

    const active = r?.active_s ?? 0;
    const feedHold = r?.feed_hold_s ?? 0;
    const utilization = active / SCHEDULED_SECONDS_DEFAULT;
    const availability = (active + feedHold) / SCHEDULED_SECONDS_DEFAULT;

    await env.DB.prepare(
      `INSERT INTO rollups_shift (device_uuid, shift_date, availability_pct, utilization_pct, part_count, alarm_count, scheduled_seconds)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT (device_uuid, shift_date) DO UPDATE SET
         availability_pct = excluded.availability_pct,
         utilization_pct = excluded.utilization_pct,
         part_count = excluded.part_count,
         alarm_count = excluded.alarm_count,
         scheduled_seconds = excluded.scheduled_seconds`,
    )
      .bind(
        d.device_uuid,
        date,
        availability,
        utilization,
        r?.part_count ?? 0,
        alarms?.count ?? 0,
        SCHEDULED_SECONDS_DEFAULT,
      )
      .run();
  }
}
```

- [ ] **Step 3: Wire scheduled handler**

In `cloud/src/index.ts`:

```typescript
import { computeShiftRollup } from "./shift/rollup";
// ...
async scheduled(controller, env, _ctx) {
  if (controller.cron === "*/1 * * * *") {
    await runProcessor(env);
    await runAlertScanner(env);
  } else if (controller.cron === "0 4 * * *") {
    // 04:00 UTC ~ 22:00 MDT previous day (approx) — tune per shop
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await computeShiftRollup(env, yesterday);
  }
}
```

- [ ] **Step 4: Add cron to `wrangler.jsonc`**

```jsonc
"triggers": { "crons": ["*/1 * * * *", "0 4 * * *"] }
```

- [ ] **Step 5: Run, commit**

```bash
git add cloud/src/shift/rollup.ts cloud/src/index.ts cloud/wrangler.jsonc cloud/test/shift.rollup.test.ts
git commit -m "feat(cloud): nightly shift rollup cron (04:00 UTC)"
```

---

## Task 19: XSD validation in CI

**Files:**
- Create: `cloud/test/schemas/MTConnectDevices_2.7.xsd` (vendored)
- Create: `cloud/test/schemas/MTConnectStreams_2.7.xsd` (vendored)
- Create: `cloud/test/xsd.test.ts`
- Modify: `cloud/package.json` (add `libxmljs2` dev dep)

- [ ] **Step 1: Vendor the XSDs**

```bash
curl -o cloud/test/schemas/MTConnectDevices_2.7.xsd https://schemas.mtconnect.org/schemas/MTConnectDevices_2.7.xsd
curl -o cloud/test/schemas/MTConnectStreams_2.7.xsd https://schemas.mtconnect.org/schemas/MTConnectStreams_2.7.xsd
```

(If the Streams XSD imports Devices — likely — place both in the same dir and `libxmljs2` will resolve relative imports.)

- [ ] **Step 2: Install libxmljs2**

```bash
cd cloud && npm install --save-dev libxmljs2
```

If `libxmljs2` fails to build on Windows, use `xmldom` + manual DTD check as a fallback, or skip this task and add a TODO for CI (Linux runner) only.

- [ ] **Step 3: Write test**

```typescript
// cloud/test/xsd.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error - libxmljs2 has no types in some versions
import libxml from "libxmljs2";

const fixturesDir = join(__dirname, "fixtures");
const schemaDir = join(__dirname, "schemas");

function validate(xmlPath: string, xsdPath: string) {
  const xml = libxml.parseXml(readFileSync(xmlPath, "utf8"));
  const xsd = libxml.parseXml(readFileSync(xsdPath, "utf8"));
  const ok = xml.validate(xsd);
  return { ok, errors: xml.validationErrors?.map((e: Error) => e.message) ?? [] };
}

describe("MTConnect XSD validation", () => {
  it("demo_probe.xml validates against MTConnectDevices 2.7", () => {
    const r = validate(
      join(fixturesDir, "demo_probe.xml"),
      join(schemaDir, "MTConnectDevices_2.7.xsd"),
    );
    expect(r.ok, r.errors.join("\n")).toBe(true);
  });

  it("demo_sample_1m.xml validates against MTConnectStreams 2.7", () => {
    const r = validate(
      join(fixturesDir, "demo_sample_1m.xml"),
      join(schemaDir, "MTConnectStreams_2.7.xsd"),
    );
    expect(r.ok, r.errors.join("\n")).toBe(true);
  });
});
```

- [ ] **Step 4: Run, commit**

```bash
git add cloud/test/schemas cloud/test/xsd.test.ts cloud/package.json cloud/package-lock.json
git commit -m "test(cloud): XSD-validate demo fixtures against MTConnect 2.7 schemas"
```

(If libxmljs2 doesn't install, commit with the test marked `.skip` and a TODO.)

---

## Task 20: Dev poller shim (end-to-end against demo.mtconnect.org)

**Files:**
- Create: `cloud/scripts/demo-poller.ts`
- Create: `cloud/scripts/tsconfig.json`
- Modify: `cloud/package.json` (add script)

- [ ] **Step 1: Write the poller**

```typescript
// cloud/scripts/demo-poller.ts
// Dev-only: polls demo.mtconnect.org and posts to a local Worker.
// Usage: npm run poll:demo -- --base http://localhost:8787 --secret test-secret

import { parseProbe } from "../src/xml/probe";
import { parseStreams } from "../src/xml/streams";

type Args = { base: string; secret: string; interval: number };

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const get = (name: string, def?: string) => {
    const idx = args.findIndex((a) => a === `--${name}`);
    return idx >= 0 ? args[idx + 1] : def;
  };
  return {
    base: get("base", "http://localhost:8787")!,
    secret: get("secret", "test-secret")!,
    interval: Number(get("interval", "5000")!),
  };
}

async function postJson(url: string, secret: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Edge-Secret": secret },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`POST ${url} -> ${res.status} ${await res.text()}`);
  }
  return res;
}

async function fetchText(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

async function main() {
  const { base, secret, interval } = parseArgs();
  console.log(`demo-poller: base=${base} interval=${interval}ms`);

  const probeXml = await fetchText("https://demo.mtconnect.org/probe");
  const probe = parseProbe(probeXml);

  // Post probe for each device
  for (const d of probe.devices) {
    await postJson(`${base}/ingest/probe`, secret, {
      device_uuid: d.uuid,
      name: d.name,
      model: d.model,
      controller_type: null,
      controller_vendor: null,
      mtconnect_version: probe.header.schemaVersion,
      instance_id: probe.header.instanceId,
      probe_xml: probeXml,
      data_items: d.dataItems,
    });
  }
  console.log(`posted probe for ${probe.devices.length} device(s)`);

  // Cursor per device_uuid: start from "now" via /current; then long-poll /sample from nextSequence.
  const currentXml = await fetchText("https://demo.mtconnect.org/current");
  const firstStreams = parseStreams(currentXml);
  const cursors = new Map<string, number>();
  for (const d of probe.devices) {
    cursors.set(d.uuid, firstStreams.header.nextSequence);
  }

  while (true) {
    try {
      for (const d of probe.devices) {
        const from = cursors.get(d.uuid)!;
        const xml = await fetchText(
          `https://demo.mtconnect.org/sample?from=${from}&count=1000`,
        );
        const parsed = parseStreams(xml);
        const forDevice = parsed.observations.filter(
          (o) => o.deviceUuid === d.uuid,
        );
        if (forDevice.length > 0) {
          await postJson(`${base}/ingest/observations`, secret, {
            device_uuid: d.uuid,
            instance_id: parsed.header.instanceId,
            batch: forDevice.map((o) => ({
              sequence: o.sequence,
              timestamp: o.timestamp,
              data_item_id: o.dataItemId,
              category: o.category,
              type: o.type,
              sub_type: o.subType,
              value_num: o.valueNum,
              value_str: o.valueStr,
              condition_level: o.conditionLevel,
              condition_native_code: o.conditionNativeCode,
              condition_severity: o.conditionSeverity,
              condition_qualifier: o.conditionQualifier,
            })),
          });
          console.log(`${d.name}: posted ${forDevice.length} obs, next=${parsed.header.nextSequence}`);
        }
        cursors.set(d.uuid, parsed.header.nextSequence);
      }
    } catch (e) {
      console.error("poll error", e);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

main();
```

- [ ] **Step 2: Add `tsconfig.json` for scripts**

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"]
  },
  "include": ["./*.ts", "../src/**/*.ts"]
}
```

- [ ] **Step 3: Add script to package.json**

```json
"scripts": {
  ...
  "poll:demo": "tsx scripts/demo-poller.ts"
}
```

Install tsx:

```bash
cd cloud && npm install --save-dev tsx
```

- [ ] **Step 4: Manually smoke-test** (not a unit test — document in README)

Run these in two terminals:
- Terminal 1: `cd cloud && npm run dev` (wrangler dev)
- Terminal 2: `cd cloud && npm run poll:demo -- --base http://localhost:8787 --secret test-secret`

Hit `http://localhost:8787/machines` after ~30s — expect 2+ machines (demo has Okuma + Mazak).

- [ ] **Step 5: Commit**

```bash
git add cloud/scripts/demo-poller.ts cloud/scripts/tsconfig.json cloud/package.json cloud/package-lock.json
git commit -m "feat(cloud): dev-only poller shim to drive local Worker from demo.mtconnect.org"
```

---

## Task 21: Shadow integration test — golden-file stability

**Files:**
- Create: `cloud/test/fixtures/golden_state_intervals.json` (will be populated Step 2)
- Create: `cloud/test/shadow.integration.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// cloud/test/shadow.integration.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { applyMigrations } from "./migrations";
import { parseProbe } from "../src/xml/probe";
import { parseStreams } from "../src/xml/streams";
import { runProcessor } from "../src/processor/run";
import type { Env } from "../src/types";

const e = env as unknown as Env;
const fixturesDir = join(__dirname, "fixtures");
const goldenPath = join(fixturesDir, "golden_state_intervals.json");

async function seedFromFixtures() {
  const probeXml = readFileSync(join(fixturesDir, "demo_probe.xml"), "utf8");
  const sampleXml = readFileSync(join(fixturesDir, "demo_sample_1m.xml"), "utf8");

  await applyMigrations(e);
  await e.DB.prepare("DELETE FROM observations").run();
  await e.DB.prepare("DELETE FROM state_intervals").run();
  await e.DB.prepare("DELETE FROM events").run();
  await e.DB.prepare("DELETE FROM conditions").run();
  await e.DB.prepare("DELETE FROM rollups_minute").run();
  await e.DB.prepare("DELETE FROM processor_cursors").run();
  await e.DB.prepare("DELETE FROM data_items").run();
  await e.DB.prepare("DELETE FROM devices").run();

  const probe = parseProbe(probeXml);
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
        .bind(d.uuid, di.id, di.category, di.type, di.subType ?? null, di.units ?? null, di.nativeUnits ?? null, di.componentPath)
        .run();
    }
  }

  const parsed = parseStreams(sampleXml);
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

    if (process.env.UPDATE_GOLDEN === "1") {
      writeFileSync(goldenPath, JSON.stringify(intervals.results, null, 2));
      return;
    }

    if (!existsSync(goldenPath)) {
      throw new Error(
        "golden file missing; run `UPDATE_GOLDEN=1 npm test -- shadow` first",
      );
    }
    const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
    expect(intervals.results).toEqual(golden);
  });
});
```

- [ ] **Step 2: Bootstrap the golden file**

Run:
```bash
cd cloud && UPDATE_GOLDEN=1 npm test -- shadow
```

Inspect `cloud/test/fixtures/golden_state_intervals.json` — sanity-check content.

- [ ] **Step 3: Run without the env var**

Run: `cd cloud && npm test -- shadow`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add cloud/test/shadow.integration.test.ts cloud/test/fixtures/golden_state_intervals.json
git commit -m "test(cloud): shadow integration golden-file test against demo fixtures"
```

---

## Task 22: Final sanity — full test suite + type check

- [ ] **Step 1: Run full test suite**

Run: `cd cloud && npm test`
Expected: all tests pass, no skips except possibly XSD if libxmljs2 failed to install.

- [ ] **Step 2: Type check**

Run: `cd cloud && npm run type-check`
Expected: exit 0.

- [ ] **Step 3: Document Phase 1 outcome in CHANGELOG or README**

Update `cloud/README.md` (create if absent) with a Phase 1 section describing the run steps and what's live.

- [ ] **Step 4: Commit**

```bash
git add cloud/README.md
git commit -m "docs(cloud): Phase 1 complete — ingest + processor + alerts + read API, validated vs demo.mtconnect.org"
```

---

## Done

After Task 22:
- Cloud worker ingests probe + observations
- Processor derives state_intervals, conditions, events, rollups_minute
- Alert scanner fires 5 alert kinds and auto-clears
- Read API exposes /machines, /current, /sample, /utilization, /alerts
- Nightly shift rollup runs
- XSD validation in CI
- `npm run poll:demo` drives live end-to-end against demo.mtconnect.org
- Golden-file shadow test locks in derived output shape

Ready for Phase 2 (edge forwarder).
