# MTConnect monitoring — v2 clean-slate redesign

**Date:** 2026-04-22
**Author:** Tal Schwartz
**Status:** Draft — pending user review
**Supersedes:** `2026-04-18-mtconnect-cnc-networking-design.md` (archived to `v1-archive` branch)

## Why we're rebuilding

After proper research into the MTConnect standard (Part 1 v2.5, Part 3 v2.5, cppagent 2.7, the Institute's working groups and reference materials), v1 has foundational issues that would compound as we add machines. We're doing this once, it needs to last years, and the canonical patterns exist — we just hadn't read them.

### v1's substantive issues

1. **Wrong ingest model.** v1 polls `/current` every 2s. Canonical MTConnect consumption is `/sample?from=<nextSequence>&interval=1000&heartbeat=10000` HTTP long-poll, which gives us:
   - Every state transition (no missed FEED_HOLD blips or brief FAULTs)
   - True dwell times (sequence-stamped transitions, not poll-interval approximations)
   - Sequence-based gap detection (compare `from` vs `Header.firstSequence` on response)
   - `Header.instanceId` surfaces agent restarts, letting us rebaseline deterministically
2. **No `/probe` awareness.** v1 hardcodes DataItem XML paths. Every reference client uses `/probe` to build an inventory keyed by `id`, then binds observations by `type` + `category` + optional `subType`. Adapter authors are inconsistent with names; binding by name is brittle and will break per-vendor.
3. **`CONDITION` category is mis-modeled.** MTConnect conditions are stateful channels (`NORMAL` / `WARNING` / `FAULT` / `UNAVAILABLE`) per subsystem (`Logic`, `Motion`, `System`, `Hydraulic`, `Coolant`, `Electric`, `Pneumatic`, `Lubrication`, plus machine-specific). v1 flattens all faults into a `active_faults` list and loses the channel semantics.
4. **Cppagent never actually integrated.** No `Devices.xml`, no container config, no simulator harness. v1's tests run against hand-written fixtures, not real cppagent output.
5. **Unused ecosystem.** `demo.mtconnect.org` runs 2.7 live with Okuma + Mazak simulators — free development target. cppagent's `simulator/simulator.rb` + recorded Mazak/Okuma SHDR traces are realistic replay fixtures we weren't using. `mtconnect/MtconnectTranspiler.Sinks.Python` generates Python dataclasses from the canonical SysML model.

### Reasons to raze rather than patch

Fixing all five above in place touches every file in `edge/collector/`, the cloud ingest contract, the D1 schema, and the test fixtures. The refactor surface is larger than a rewrite, and a rewrite lets us internalize the canonical patterns rather than paper them over.

## Principles

- **Edge is the buffer-of-record.** It captures, durably stores, and forwards raw observations. It does not interpret them. This preserves sovereignty (the full record lives on our hardware) without doubling the surface area where business logic must live.
- **Cloud is the brain.** Parsing, state machine, condition channels, rollups, alerts, OEE — one place, easy to iterate, cheaper to retain long-term.
- **Canonical MTConnect everywhere.** `/probe`-driven binding, `/sample` long-poll, sequence tracking, instanceId-aware reconnect, XSD-validated responses, Agent Device connectivity as a first-class signal.
- **Shadow-testable.** Every component exercisable against `demo.mtconnect.org` and cppagent's replay simulator, without a machine in the loop.
- **Read-only Phase 1.** No NC-side writes. DNC delivery and asset writes live in separate services with separate auth, added later.
- **CMMC-aware.** Rootless containers, FDE, SSH keys only, monitoring VLAN, auditd, NTP, egress-only tunnel. Design for DNC bolt-on.

## Architecture

```
Machine controller
    ↓  (vendor protocol: Haas NGC native, FOCAS, THINC, OPC UA)
Adapter (SHDR, TCP 7878)  ── HMI PC / vendor appliance / NUC, depending on controller
    ↓  SHDR
cppagent (single instance, multi-device)  ── NUC, containerized
    ↓  HTTP long-poll /sample?from=<next>&interval=1000&heartbeat=10000
Edge forwarder (Python 3.12 asyncio)  ── NUC, containerized
    ├─→ SQLite WAL buffer-of-record (raw observations keyed by device_uuid+sequence)
    └─→ HTTPS batched POST /ingest/observations  (via CF Tunnel, X-Edge-Secret)
                                                              ↓
Cloud Worker (Hono on Cloudflare Workers)
    ├─→ D1: raw observations + derived tables (state_intervals, conditions, events, rollups_minute, rollups_shift, alerts)
    ├─→ R2: observation archives (>90d, compressed NDJSON)
    ├─→ Cron processor: state machine, condition tracker, minute rollup (1m)
    ├─→ Cron alerter: rule engine (30s)
    ├─→ Cron shift rollup: nightly at 22:00 local
    └─→ Read API: /machines, /machines/:id/{current,sample,oee}, /alerts
                                                              ↑
Shop-floor-mes (cloud-hosted)  ── reads only from cloud Worker
```

**Adapter placement per controller family:**

| Controller | Adapter | Placement | Phase |
|---|---|---|---|
| Haas NGC | Native MTConnect (Setting 143) | On-control | 3 |
| Okuma OSP-P | Okuma MTConnect Adapter (free THINC app) | On-control | 4 |
| Siemens 840D sl (DVF) | Our `asyncua` → SHDR bridge | NUC container | 5 |
| Fanuc | FANUC MTConnect Server (licensed) OR TrakHound Fanuc agent (OSS) | HMI PC | Future |

## Edge components (NUC)

### Container stack (podman-compose)

| Service | Image | Purpose |
|---|---|---|
| `cppagent` | `mtconnect/agent:2.7` | Single instance, multi-device. Reads `/etc/cppagent/Devices.xml` + `/etc/cppagent/agent.cfg` from bind mount. Exposes `:5000` on loopback only. |
| `forwarder` | ours, Python 3.12-slim | Long-polls cppagent, writes SQLite, forwards to cloud. |
| `cloudflared` | `cloudflare/cloudflared:latest` | Egress-only tunnel for forwarder → cloud ingest. |
| `siemens-adapter` (Phase 5) | ours, Python 3.12-slim | `asyncua` → SHDR adapter for DVF. One container per DVF machine on separate port. |

All containers run rootless under a dedicated `mtconnect` user (UID 2000).

### cppagent configuration

`edge/cppagent/agent.cfg`:
```
Devices = Devices.xml
SchemaVersion = 2.7
WorkerThreads = 4
MonitorConfigFiles = yes
Port = 5000
ServerIp = 127.0.0.1
JsonVersion = 2
BufferSize = 17           # 2^17 = 131,072 observations
MaxAssets = 1024
DisableAgentDevice = false # Agent Device is our adapter-connectivity signal
Validation = true

logger_config {
  output = cout
  level = warn
}
```

`edge/cppagent/Devices.xml`: one `<Device>` element per machine, checked into the repo. This is ground-truth documentation of the fleet; adding a new machine is a PR that adds a `<Device>` and an `Adapters { NameN { … } }` block to `agent.cfg`.

Per-controller `Devices.xml` templates live under `edge/cppagent/devices/`:
- `haas-ngc-vf2.xml` — Haas VF-2 NGC template
- `okuma-osp-p300.xml` — Okuma OSP-P300 template
- `siemens-840d-dvf.xml` — DVF / Siemens 840D sl template

The canonical production `Devices.xml` composes these per the live fleet.

### Forwarder responsibilities

Strict scope — forward, don't interpret:

1. **Startup**
   - Fetch `GET /probe` from cppagent
   - Parse device tree, cache DataItem inventory (`id` → `{type, category, subType, units, componentPath}`)
   - Record `Header.instanceId` and `Header.schemaVersion`
   - POST probe to cloud `/ingest/probe`
2. **Steady state**
   - Open `GET /sample?from=<nextSequence>&interval=1000&heartbeat=10000` as chunked long-poll
   - For each `<MTConnectStreams>` chunk, parse observations
   - Upsert each observation to SQLite keyed by `(device_uuid, sequence)`
   - Update `nextSequence` cursor in `agent_state` table
3. **Batched forward**
   - Every 1 second (or 500 observations, whichever first), batch un-forwarded observations and POST to cloud `/ingest/observations` with `X-Edge-Secret`
   - On 2xx, mark `forwarded_at` on rows
   - On failure, exponential backoff (1s → 2s → 4s → … → 60s capped), keep buffering
4. **Gap detection**
   - If `Header.firstSequence` on a response > cursor `from`, log gap, include `gap_start`/`gap_end` in next forward batch
5. **Agent restart detection**
   - If `Header.instanceId` differs from last seen, log restart, reset cursor from `/current`, refetch `/probe`, re-POST probe to cloud
6. **Connection loss**
   - On cppagent unreachable > 10s, emit synthetic `agent_offline` heartbeat to cloud every 60s until restored (cloud correlates with Agent Device observations for disambiguation)

### Edge SQLite schema

`/var/lib/mtconnect/forwarder.sqlite` (WAL mode, synchronous=NORMAL):

```sql
CREATE TABLE observations (
  device_uuid TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  timestamp_utc TEXT NOT NULL,       -- ISO-8601 from agent
  data_item_id TEXT NOT NULL,
  category TEXT NOT NULL,            -- SAMPLE | EVENT | CONDITION
  type TEXT NOT NULL,
  sub_type TEXT,
  value_num REAL,                    -- populated for SAMPLE
  value_str TEXT,                    -- populated for EVENT and CONDITION.message
  condition_level TEXT,              -- NORMAL | WARNING | FAULT | UNAVAILABLE (CONDITION only)
  condition_native_code TEXT,
  condition_severity TEXT,
  condition_qualifier TEXT,
  forwarded_at TEXT,                 -- NULL until cloud acks
  PRIMARY KEY (device_uuid, sequence)
);
CREATE INDEX idx_observations_forwarded ON observations(forwarded_at) WHERE forwarded_at IS NULL;
CREATE INDEX idx_observations_timestamp ON observations(timestamp_utc);

CREATE TABLE probe_cache (
  device_uuid TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  raw_xml TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE agent_state (
  device_uuid TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  last_sequence INTEGER NOT NULL,
  last_forward_at TEXT
);
```

### Retention

- **Raw observations:** 30 days at edge, partitioned by day. A weekly cron drops day-partitions older than 30 days and `VACUUM`s.
- **Storage budget:** ~500 MB/machine-month on chatty 5-axis. 15 machines × 30 days ≈ 220 GB. NUC has 1 TB NVMe; room for ~3× fleet growth or longer retention.

### NUC baseline (Ansible)

`edge/ansible/playbook.yml`:
- Ubuntu 24.04 LTS, full-disk encryption (LUKS)
- SSH keys only, no password auth, non-default port
- Monitoring VLAN interface configuration
- `unattended-upgrades` enabled
- `auditd` enabled with MTConnect-relevant rules
- NTP via `chrony`, stratum-1 upstreams
- `podman`, `podman-compose` installed; `mtconnect` user with subuid/subgid mappings
- `cloudflared` service installed and enrolled
- Cron: weekly edge SQLite retention job

## Cloud components

### Ingest surface

Authenticated with `X-Edge-Secret` (constant-time compare, same as v1):

- `POST /ingest/probe`
  - Body: `{ device_uuid, name, model, controller_type, controller_vendor, mtconnect_version, instance_id, probe_xml, data_items: [{id, category, type, sub_type, units, component_path}, …] }`
  - Upserts `devices` and replaces `data_items` for that device
  - XSD-validated against `MTConnectDevices_2.7.xsd`

- `POST /ingest/observations`
  - Body: `{ device_uuid, instance_id, batch: [{sequence, timestamp, data_item_id, category, type, sub_type, value_num?, value_str?, condition_level?, condition_native_code?, condition_severity?, condition_qualifier?}, …], gap?: {start_seq, end_seq} }`
  - Idempotent upsert on `(device_uuid, sequence)`
  - If `instance_id` differs from `devices.current_instance_id`, triggers processor re-baseline
  - Returns high-water-mark sequence acked

### D1 schema (cloud)

```sql
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
  PRIMARY KEY (device_uuid, data_item_id),
  FOREIGN KEY (device_uuid) REFERENCES devices(device_uuid)
);

-- Hot observation store (0-90 days). Older observations archived to R2.
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

-- Derived: execution state closed intervals
CREATE TABLE state_intervals (
  device_uuid TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  state TEXT NOT NULL,              -- ACTIVE | FEED_HOLD | STOPPED | INTERRUPTED | READY | OFFLINE
  program TEXT,
  tool_number TEXT,
  controller_mode TEXT,
  PRIMARY KEY (device_uuid, started_at)
);

-- Derived: condition channels (stateful per data_item_id)
CREATE TABLE conditions (
  device_uuid TEXT NOT NULL,
  data_item_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,                    -- NULL while active
  level TEXT NOT NULL,              -- WARNING | FAULT | UNAVAILABLE (NORMAL is implicit gaps)
  native_code TEXT,
  severity TEXT,
  qualifier TEXT,
  message TEXT,
  PRIMARY KEY (device_uuid, data_item_id, started_at)
);

-- Derived: discrete events
CREATE TABLE events (
  device_uuid TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,               -- program_change | tool_change | part_completed | estop | agent_restart | gap
  payload_json TEXT,
  PRIMARY KEY (device_uuid, ts, kind)
);

-- Derived: minute rollups
CREATE TABLE rollups_minute (
  device_uuid TEXT NOT NULL,
  minute_start TEXT NOT NULL,       -- ISO-8601 floored to minute
  active_s REAL DEFAULT 0,
  feed_hold_s REAL DEFAULT 0,
  stopped_s REAL DEFAULT 0,
  interrupted_s REAL DEFAULT 0,
  ready_s REAL DEFAULT 0,
  offline_s REAL DEFAULT 0,
  part_delta INTEGER DEFAULT 0,
  program TEXT,                     -- latest in window
  tool_number TEXT,                 -- latest in window
  avg_spindle_rpm REAL,
  max_spindle_load REAL,
  avg_feedrate REAL,
  PRIMARY KEY (device_uuid, minute_start)
);

-- Derived: shift rollups (nightly cron)
CREATE TABLE rollups_shift (
  device_uuid TEXT NOT NULL,
  shift_date TEXT NOT NULL,         -- YYYY-MM-DD local
  availability_pct REAL,
  utilization_pct REAL,
  part_count INTEGER,
  alarm_count INTEGER,
  scheduled_seconds INTEGER,
  PRIMARY KEY (device_uuid, shift_date)
);

-- Alerts
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

-- Processor cursor (per device, per derived stream)
CREATE TABLE processor_cursors (
  device_uuid TEXT NOT NULL,
  stream TEXT NOT NULL,             -- state_machine | conditions | rollups_minute | alerts
  last_sequence INTEGER NOT NULL,
  last_run_at TEXT,
  PRIMARY KEY (device_uuid, stream)
);
```

### Stream processor (cron, every 60s)

Pure-functional, replayable. Invoked by CF cron trigger:

1. For each device, read observations `WHERE sequence > cursor.last_sequence ORDER BY sequence`
2. Feed into:
   - **State machine** — computes execution-state closed intervals. Normalizes `Execution` values (`READY` | `ACTIVE` | `INTERRUPTED` | `STOPPED` | `FEED_HOLD` | `PROGRAM_STOPPED` | `PROGRAM_COMPLETED` | `OPTIONAL_STOP` | `UNAVAILABLE`) into our 6-state alphabet. Uses `ControllerMode` and `Availability` to disambiguate.
   - **Condition tracker** — per-data-item stateful channel, emits transitions to `conditions` table. Level change (e.g., `NORMAL`→`FAULT`) opens a new interval; `NORMAL` closes the active one.
   - **Event detector** — emits `program_change`, `tool_change`, `part_completed` (on PartCount delta), `estop`, `agent_restart` (on instance_id change), `gap`.
   - **Minute accumulator** — attributes state-seconds, SAMPLE averages, and EVENT latest-values to minute buckets.
3. Advance cursor per stream.

Pure functions are in `cloud/src/processor/`, unit-tested independently.

### Alert rules (scanner, cron every 30s)

| Rule | Trigger | Severity | Source |
|---|---|---|---|
| `feed_hold_extended` | `state_intervals` open interval with state=FEED_HOLD and ended_at IS NULL and duration > 10 min during shift window | warning | state_intervals |
| `idle_during_shift` | state=STOPPED open > 20 min during shift, no active FAULT condition | warning | state_intervals + conditions |
| `alarm_sustained` | condition at level=FAULT open > 2 min | fault | conditions |
| `offline` | no observations from device_uuid > 5 min during shift | fault | observations.max(timestamp_utc) |
| `estop_triggered` | new event kind=estop in last scan window | fault | events |
| `spindle_overload` | avg(spindle_load over 30s rolling) > 95% | warning | observations (tuned Phase 5) |

Fan-out: `alerts` table + Slack webhook to `#shop-floor-alerts` (configurable via env var).

### Shift rollup (cron, nightly 22:00 local via CF cron trigger)

For each device, compute yesterday's shift rollup row using `state_intervals`, `events`, `conditions`. Writes `rollups_shift`.

Shift schedule is a simple per-machine config for Phase 3; multi-shift / per-pool scheduling is Phase 6+.

### Read API (public)

- `GET /machines` — latest state, program, tool, open conditions, open alerts count per device
- `GET /machines/:id/current` — /current-equivalent derived from latest row per `data_item_id`
- `GET /machines/:id/sample?from=<ts>&to=<ts>&types=EXECUTION,SPINDLE_SPEED,…` — type-filtered time series. Hot tier from `observations` (≤90d), cold tier from R2 NDJSON archives (>90d).
- `GET /machines/:id/oee?date=YYYY-MM-DD` — daily availability + utilization + part count. Labeled `/utilization` in the MES, not "OEE," until we have Performance and Quality legs from job/scrap data (deferred to Phase 2+ in separate project).
- `GET /alerts`, `POST /alerts/:id/ack` — same as v1

### R2 archival (weekly cron)

Every Sunday, export observations older than 90 days into `r2://observations-archive/<device_uuid>/<YYYY>/<MM>/<DD>.ndjson.gz`, delete from D1. Archives are queryable on-demand by the sample endpoint's cold path.

## Wire protocol (edge → cloud)

**Authentication:** `X-Edge-Secret` header, constant-time compare.

**Endpoints:**
- `POST /ingest/probe` on forwarder startup and on `instance_id` change.
- `POST /ingest/observations` batched every 1s or 500 observations.

**Idempotency:** cloud upserts by `(device_uuid, sequence)`. Edge retries are safe.

**Error handling:** cloud returns `{ ok: true, high_water_sequence: N }` on success. Edge marks `forwarded_at` for rows with `sequence <= N`. On 4xx with detail, edge logs and drops (for schema errors, we want to catch and fix, not loop).

## Testing strategy

### Unit (TDD, pure logic)
- State machine (`cloud/src/processor/state_machine.ts`)
- Condition tracker (`cloud/src/processor/conditions.ts`)
- Minute accumulator (`cloud/src/processor/rollups.ts`)
- Alert rules (`cloud/src/alerts/rules.ts`)

All pure input→output, covered to >95%.

### XSD validation
- Every MTConnect XML fixture validated against official 2.7 XSDs (`MTConnectDevices_2.7.xsd`, `MTConnectStreams_2.7.xsd`) in CI.
- Schemas vendored under `cloud/test/schemas/`.

### Shadow integration (CI + on-demand)
- Separate CF Worker environment `mtconnect-shadow` polls `demo.mtconnect.org` directly (no edge).
- Golden-file test: given a fixed 1-hour window of demo observations, derived state_intervals, rollups, and conditions must match a checked-in golden file byte-for-byte.
- Re-baselined manually when the spec model changes (rare).

### Replay integration (local)
- `docker-compose.replay.yml` under `cloud/test/replay/`:
  - `cppagent` container
  - `simulator.rb` container replaying `demo/agent/mazak.txt`
  - Real D1 (via `wrangler dev --local`) receiving forwarder output
- Smoke test: 60s replay should produce expected state transitions + ≥3 minute rollups.

### End-to-end (staging)
- Same cloud Worker with a staging domain, real NUC in the lab, one Haas NGC simulator. Exercises on PR merges to `main` before shop-floor deploy.

## Phased rollout

| Phase | Scope | Duration | Completion gate |
|---|---|---|---|
| **0 — Raze** | Archive v1 to `v1-archive` branch. Delete `edge/collector/`. Keep: `cloud/src/auth.ts`, D1 migration scaffolding, vitest/Hono setup. Update CLAUDE.md. | 1 session | `main` has only the skeleton, v1 reachable via branch. |
| **1 — Cloud-only against demo** | CF Worker ingests observations from a shim that polls `demo.mtconnect.org` /probe + /sample. Full processor, alerts, read API, all working against live public data. No NUC. | 2 sessions | Live demo dashboard reflecting demo Okuma + Mazak state. Golden tests pass. |
| **2 — Edge forwarder + cppagent simulator** | Python forwarder, local cppagent + simulator.rb replay, Ansible NUC baseline playbook written (not deployed), podman-compose file, SQLite buffer-of-record. | 2 sessions | Replay integration test green. Ansible playbook runs against a Vagrant/VM target cleanly. |
| **3 — First Haas on real NUC** | NUC deployed (Ansible), hardened, one Haas NGC native → cppagent → forwarder → cloud → MES dashboard. CF Tunnel live. Slack alerts firing. | 2 sessions | One machine on shop floor, MES tile updates in <5s, alert fires within 30s of simulated condition. |
| **4 — Second Haas + first Okuma** | Multi-device in same `Devices.xml`. Okuma MTConnect app installed on control. Okuma fixtures added. | 2 sessions | Three machines on the fleet dashboard, Okuma-specific condition semantics correct. |
| **5 — DVF via Siemens OPC UA** | `asyncua` → SHDR bridge adapter we write. Full TDD against simulator, 1-week shadow run, then MES visibility. | 3 sessions | DVF #1 and DVF #2 on dashboard. Siemens condition channels match ontology. |
| **6 — Fleet fill + per-pool alert tuning** | Remaining Okuma machines, alert threshold tuning per pool, shift schedule refinement. | 2 sessions | Full fleet live, alerts dialed in, no false-positive storms for 7 days. |

## Razing — what goes, what stays, what's new

### Delete (archived to `v1-archive` branch)
- `edge/collector/` entirely
- `cloud/src/ingest/state.ts`, `cloud/src/ingest/events.ts`, `cloud/src/ingest/rollups.ts` — wrong contract
- `cloud/src/read/oee.ts` — relabel and rewrite as `/utilization`
- v1 D1 schema migration — replaced
- v1 test fixtures in `edge/collector/tests/fixtures/` — replaced with cppagent simulator output
- Old design doc moved to `v1-archive`, superseded by this doc

### Keep
- `cloud/src/auth.ts` — X-Edge-Secret middleware works as-is
- `cloud/src/db.ts` helpers — trivially adapted
- Vitest + Hono + wrangler scaffolding
- CLAUDE.md conventions (TDD, commit-per-test, Unix shell syntax)
- Runbooks under `docs/runbooks/` — edge hardware, vendor verification emails
- Project memory entries (Unifi bridge plan, CMMC L2 verdict)

### New
- `edge/forwarder/` — Python 3.12 async forwarder (aiosqlite, httpx, lxml)
- `edge/cppagent/` — `agent.cfg` + `Devices.xml` + per-machine device templates under `devices/`
- `edge/compose/` — `compose.yml` (podman-compose) orchestrating cppagent, forwarder, cloudflared
- `edge/ansible/` — NUC baseline playbook + inventory
- `edge/siemens-adapter/` (Phase 5) — `asyncua` → SHDR bridge
- `cloud/src/processor/` — state machine, condition tracker, minute accumulator (pure)
- `cloud/src/alerts/` — rule engine + Slack fanout
- `cloud/src/ingest/observations.ts` — new raw-observation ingest
- `cloud/src/ingest/probe.ts` — device model ingest
- `cloud/src/read/sample.ts` — type-filtered time series, hot+cold
- `cloud/src/read/current.ts` — /current-equivalent derived endpoint
- `cloud/src/archive/` — weekly R2 archive cron
- `cloud/test/schemas/` — vendored MTConnect 2.7 XSDs
- `cloud/test/replay/` — docker-compose cppagent + simulator.rb harness

## Out of scope

- **Job ↔ machine correlation via `WorkOrder` asset.** Deferred to Phase 2 program-name-inference. Asset writes to cppagent are a separate project.
- **Performance and Quality OEE legs.** Require job routing, ideal cycle time, and NCR/scrap data from Fulcrum. Surface as "utilization" only until then.
- **DNC program delivery.** CUI scope, separate service, separate auth, separate network enclave.
- **NC-side writes of any kind.** Permanently out of scope for this service.
- **Multi-agent HA / failover.** Single cppagent per NUC; we accept single-point-of-failure at the agent layer for Phase 1. If operationally necessary we split later.
- **MQTT sink.** Evaluated and rejected — long-poll is canonical and our SQLite buffer makes broker buffering redundant.

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Siemens OPC UA adapter complexity delays Phase 5 | Medium | Medium | 1-week shadow run against ontology fixtures before MES visibility; asyncua is mature |
| DVF misidentified as Mazak in contract-manufacturer-ontology | Known | Low | Fix ontology + confirm controller type at adapter selection |
| Cppagent circular buffer rollover during extended cloud outage | Low | Medium | 30-day edge SQLite is buffer-of-record; cppagent buffer is transient |
| XSD drift between agent version and our schema vendoring | Low | Low | Pin cppagent to `2.7`, vendor 2.7 XSDs; upgrade schemas as a tested change |
| Haas NGC MTConnect setting not enabled on a shipping control | Medium | Low | Vendor-verification checklist in runbook |
| R2 archival job lag under fleet scale | Low | Low | Size-based trigger in addition to weekly time-based |

## Open questions

None blocking. The following can be decided during implementation:
- Exact shift schedule config format (per-machine JSON blob vs D1 table) — will decide in Phase 3 when the first real Haas is live.
- Specific Slack channel routing per severity — confirm with shop floor before Phase 3 go-live.
- R2 archive retention (indefinite? 2 years? 7 years for audit?) — TBD with compliance input; not blocking Phase 0–3.

## References

- [MTConnect Standard docs](https://docs.mtconnect.org/) — Parts 1 (fundamentals), 2 (devices), 3 (observations), 4 (assets)
- [cppagent repo](https://github.com/mtconnect/cppagent) — reference agent, current v2.7.0.7
- [cppagent wiki: REST API and WebSockets](https://github.com/mtconnect/cppagent/wiki/MTConnect-REST-API-and-WebSockets)
- [cppagent wiki: SHDR 2.0](https://github.com/mtconnect/cppagent/wiki/SHDR-2.0)
- [MTConnect schemas](https://schemas.mtconnect.org/) — XSDs 1.0 through 2.7
- [model.mtconnect.org](https://model.mtconnect.org/) — canonical SysML model browser
- [demo.mtconnect.org](https://demo.mtconnect.org/) — live public agent, Okuma + Mazak simulators
- [NIST smstestbed Devices.xml](https://github.com/usnistgov/smstestbed/blob/master/mtconnect/agent/Devices.xml) — real-world reference device file
- [TrakHound/MTConnect.NET](https://github.com/TrakHound/MTConnect.NET) — best-documented open-source consumer, cross-reference for concepts
- v1 design doc: `2026-04-18-mtconnect-cnc-networking-design.md` (archived to `v1-archive` branch)
