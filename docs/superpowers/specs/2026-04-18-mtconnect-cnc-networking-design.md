# MTConnect CNC Networking — Phase 1 Design

**Status:** Draft — awaiting review
**Date:** 2026-04-18
**Owner:** tschwartz@ffmfg.com
**Project codename:** `mtconnect-monitoring`
**Related projects:** `shop-floor-mes`, `fulcrum-pro-mcp`, `contract-manufacturer-ontology`

---

## 1. Purpose

Establish FFMFG's first-party machine data pipeline. Instrument CNC machines with MTConnect, collect telemetry to an owned cloud service, and render operations-productivity signals (OEE, real-time alerts) in the shop-floor MES.

This is an exercise in **sovereignty over our machine data**: hardware we own, software we wrote. No third-party SaaS telemetry platform (Memex, MachineMetrics, Scytec, FORCAM, etc.). Open-source components where we don't write the code ourselves.

### Phase 1 goals (in scope)

- **A. Utilization / OEE truth.** Per-machine and per-pool availability and utilization from measured state timelines.
- **D. Real-time shift alerts.** Feed-hold-too-long, idle-during-shift, sustained-alarm, offline, E-stop.

### Out of scope for Phase 1 (designed for, not built)

- Job ↔ machine-data correlation via MTConnect `WorkOrder` asset push (deferred to Phase 2; program-name inference used instead).
- Automatic progress logging back to Fulcrum (deferred to Phase 2+).
- DNC program delivery to machines — own project, full CMMC scope.
- NC-side writes (feed/spindle overrides, program start/stop) — permanently out of scope.

### Non-goals

- Performance (cycle-time) and Quality legs of OEE in Phase 1 — they require job/scrap correlation.
- Supporting every machine at FFMFG in Phase 1. Priority fleet only: 2× Haas, Okuma, 2× DN DVF 5000.

---

## 2. Machine Fleet (corrected)

| Machine | Controller | MTConnect path | Adapter effort |
|---|---|---|---|
| Haas VF-2 / VF-3 / VM-3 / UMC-500 | Haas NGC | Native MTConnect option (enable in Settings) | None — cppagent consumes directly |
| Okuma MU 5000 / lathes | Okuma OSP-P | Okuma App Suite MTConnect adapter (first-party, installs on HMI PC) OR custom THINC-API adapter | Configure App Suite (if licensed); custom adapter is fallback |
| DN Solutions DVF 5000 #1 & #2 | Siemens 840D sl / Sinumerik Operate | Custom adapter — Sinumerik OPC UA Server → SHDR | We write it (Python, asyncua) |

**Ontology correction to apply:** `contract-manufacturer-ontology/standards/mtconnect.md:76` and `.../integration/fulcrum-mtconnect.md:159` incorrectly identify the DVF 5000 as a "Mazak DVF" with Mazatrol Smooth. It is a **DN Solutions (formerly Doosan) DVF 5000** with a **Siemens 840D sl** controller. These docs will be corrected as part of Phase C.

---

## 3. Architecture

```
SHOP FLOOR                                   CLOUDFLARE
┌─────────────────────────────────┐          ┌──────────────────────────────┐
│  Haas NGC         (native)      │          │  mtconnect-collector Worker   │
│  Okuma OSP-P      (App Suite)   │          │  ┌─────────────────────────┐  │
│  Siemens 840D sl  (custom ad.)  │          │  │ POST /ingest/events     │  │
│  ┌─┘ Ethernet (monitoring VLAN) │          │  │ POST /ingest/state      │  │
│  │                              │          │  │ POST /ingest/rollups    │  │
│  ▼                              │          │  │ GET  /machines          │  │
│  ┌───────────────────────────┐  │          │  │ GET  /machines/:id/oee  │  │
│  │ Edge Box (1× Linux NUC)   │  │          │  │ GET  /alerts            │  │
│  │ ─ adapters (1 per machine)│  │  HTTPS   │  │ /proxy/edge/:cmd        │──┼─► back to Tunnel
│  │ ─ cppagent (MTConnect)    │◄─┼─────────►│  └─────────────────────────┘  │
│  │ ─ collector (forwarder)   │  │  mTLS    │         ▲                    │
│  │ ─ SQLite rolling buffer   │  │   via    │         ▼                    │
│  │ ─ CF Tunnel (drill-down)  │◄─┼──Tunnel──│    ┌────────────┐            │
│  └───────────────────────────┘  │          │    │    D1      │            │
└─────────────────────────────────┘          │    └────────────┘            │
                                              └───────────▲──────────────────┘
                                                          │
                                              ┌───────────┴──────────────────┐
                                              │  shop-floor-mes (existing)   │
                                              │  ─ Machines tab              │
                                              │  ─ Alert panel               │
                                              │  ─ Drill-down client         │
                                              └──────────────────────────────┘
```

### 3.1 Components

**Edge box** — one Linux NUC (Intel i5, 16GB RAM, 512GB NVMe, wired Ethernet) on a dedicated shop-floor monitoring VLAN. Ubuntu LTS or AlmaLinux. Runs a podman-compose stack:

**Machine network attachment — Unifi UDB-IoT per machine.** Each CNC is bridged onto the monitoring VLAN via a Unifi UDB-IoT ($45, USB-C powered, Wi-Fi → Ethernet). The bridge's uplink SSID is VLAN-tagged within the existing FFMFG Unifi stack; the machine's Ethernet port plugs into the bridge's LAN port. Benefits: no Cat6 pulls per machine (machine layouts reshuffle), bridges are first-class managed clients in Unifi, VLAN isolation is enforced at the SSID, and the CMMC egress allowlist (§8) lives on the Unifi firewall where other egress policy already does.

Known caveats, designed for:
- **RF environment.** CNC floors are EMI-noisy (VFDs, servo drives). Phase A's single-Haas bring-up doubles as the RF smoke test; reassess signal quality before buying bridges for the full fleet.
- **Power.** USB-C from the machine's control cabinet is the current hack. In the planned new facility each machine gets dedicated 120V + a small per-machine rack (computer, monitor, bridge, andon) so the bridge has a power feed independent of the machine itself. Until then, a machine powered off reports as `OFFLINE` — which is the correct semantics, not a bug.


- **Adapter processes** (one per non-native machine): Python 3.12+ services speaking SHDR on localhost to cppagent. Per-controller-kind implementations:
  - `siemens-opcua-adapter` (Phase C) — asyncua client polling Sinumerik OPC UA nodes.
  - `okuma-thinc-adapter` (fallback only, Phase B) — if Okuma App Suite MTConnect is unavailable.
  - Haas needs no custom adapter; cppagent consumes Haas's native agent directly.
- **cppagent** — open-source MTConnect Institute reference agent (Apache-2.0). Single instance hosting all Device descriptions. Serves `/current`, `/sample`, `/asset`, `/probe` on localhost.
- **collector** — Python service. Tails cppagent's `/sample` long-poll stream for all devices, computes closed state intervals and 1-minute rollups, writes a local SQLite rolling buffer (30-day TTL), and pushes summaries to the cloud over HTTPS.
- **Cloudflare Tunnel** — exposes only the collector's drill-down endpoint back to the cloud worker. No inbound from the public internet.

**mtconnect-collector Cloudflare Worker** — small Hono app. Owns a D1 database. Ingress endpoints authenticated with mTLS client cert (via CF Tunnel) + a rotating shared secret. Exposes read API for the MES and a drill-down proxy that tunnels back to the edge.

**shop-floor-mes** — adds a "Machines" view and an alert-panel integration. Does not own any machine-monitoring data itself; it is a client of the collector API.

### 3.2 Data flow (steady state)

1. Machine controller exposes state via native MTConnect (Haas), vendor adapter (Okuma), or OPC UA (Siemens).
2. Adapter (or cppagent directly for Haas) polls the controller at the rates in §4.1 and produces SHDR lines.
3. cppagent normalizes into MTConnect XML stream, serves `/sample`.
4. Collector tails `/sample`, maintains an in-memory state machine per device, emits:
   - **Closed state intervals** (pushed to cloud when interval closes — i.e., state changes).
   - **Events** (alarm, program_change, tool_change, part_completed, estop, door) — pushed on occurrence.
   - **Minute rollups** — pushed every minute.
5. Collector also writes raw samples and events to local SQLite for drill-down.
6. Cloud worker persists to D1.
7. Cloud worker runs two crons: **shift rollup** (nightly) and **alert rule scan** (every 30s).
8. MES polls collector read API for tiles, OEE bars, and alerts.
9. When a user drills into a state interval, MES calls collector `/proxy/edge/samples?...`, which tunnels to the edge's local SQLite and streams back.

---

## 4. Read / Write Spec

### 4.1 READ spec

#### Siemens 840D sl (DN DVF 5000) — OPC UA

Endpoint: `opc.tcp://<machine-ip>:4840` (Sinumerik OPC UA Server, port 4840).

| OPC UA node / source | MTConnect mapping | Sample rate | Notes |
|---|---|---|---|
| `/Channel/State/progState` | `Execution` event | 100 ms | ACTIVE / STOPPED / FEED_HOLD / INTERRUPTED — core OEE signal |
| `/Channel/State/opMode` | `ControllerMode` event | 500 ms | AUTOMATIC / MDA / JOG / REF |
| `/Channel/ProgramInfo/progName` | `Program` event | on change | NC program loaded |
| `/Channel/ProgramInfo/block` | `Block` event | 500 ms | Current block — noisy; local only, not pushed to cloud |
| `/Channel/Spindle/actSpeed` | `AngularVelocity` sample | 1 Hz | Actual RPM |
| `/Channel/Spindle/cmdSpeed` | `AngularVelocity` (commanded) | 1 Hz | Programmed RPM |
| `/Channel/Spindle/load` | `Load` sample | 1 Hz | % of rated — feeds Phase 2 tool-wear analysis |
| `/Channel/FeedRate/actFeed` | `PathFeedrate` sample | 1 Hz | Actual feedrate |
| `/Channel/FeedRate/override` | `PathFeedrateOverride` sample | on change | Operator override % |
| `/Channel/ToolManagement/actTNumber` | `ToolNumber` event | on change | Active tool |
| `/Channel/Alarms/list` | `Condition` (per component) | 500 ms | Normalized to Normal / Warning / Fault |
| `/Channel/Counter/partCount` | `PartCount` event | on change | M30 counter |
| PLC tag: door state | `DoorState` event | 500 ms | Via snap7 if not on OPC UA |
| PLC tag: E-stop | `EmergencyStop` event | 500 ms | Safety-critical, always read |

**Prerequisite verification:** before Phase C starts, controls tech must confirm Sinumerik OPC UA Server option is licensed and enabled on both DVFs (probe port 4840). If unlicensed, fallback path is snap7 to S7 PLC tags — yields run-lamp, door, E-stop, coolant, spindle-on (Boolean). Loses program name, exact feedrate, tool number. This still satisfies Phase 1 goals A + D but thinner. Dual implementation path is planned for.

#### Okuma OSP-P — App Suite MTConnect adapter (preferred) or THINC API (fallback)

- **Preferred:** Okuma App Suite MTConnect adapter. Installs on the Okuma HMI PC, exposes a device on the shop LAN; cppagent consumes it as an MTConnect device. No code written by us.
- **Fallback:** custom adapter using THINC API (DLL-based) running on Okuma HMI PC, bridging to SHDR. Covers same signals as the Siemens table (state, program, tool, feedrate, spindle, alarms).

#### Haas NGC — native MTConnect

Enable the MTConnect option in Settings (Setting 143 or equivalent on current firmware). Exposes an MTConnect device on the shop LAN. cppagent consumes directly. No code written by us.

### 4.2 WRITE spec

#### Phase 1 — strictly read-only

No writes of any kind in Phase 1.

Rationale: (a) cloud-initiated machine commands present safety risk; (b) read-only keeps the system out of the CUI boundary and simplifies CMMC; (c) Phase 1 is explicitly a foundation/learning phase.

#### Future write tiers (designed for, implemented later)

| Tier | Write target | CMMC scope | Authorization | Phase |
|---|---|---|---|---|
| Asset writes | cppagent `/asset` endpoint (push `WorkOrder` asset with Fulcrum job/op UUIDs for machine-data correlation) | Low — context metadata, no CUI | Service-to-service from MES on op-start | Phase 2 |
| DNC writes | NC program files to controller file system via SFTP / SMB3 | **Full CMMC scope — CUI** | Authenticated programmer + operator acknowledgment, full audit trail, FIPS TLS | Future project |
| NC-side writes | Feed/spindle overrides, cycle start/stop, M-code execution | **Permanently out of scope** | None — not doing this | Never |

The adapter architecture keeps writes cleanly separated from reads — any future asset or DNC writes go through dedicated services with their own auth and audit, never through the sample/event read path.

---

## 5. Data Model

### 5.1 D1 schema (on mtconnect-collector)

```sql
-- machines: static registry, one row per machine
CREATE TABLE machines (
  id                TEXT PRIMARY KEY,        -- 'haas-vf2-1', 'dn-dvf-1'
  display_name      TEXT NOT NULL,
  controller_kind   TEXT NOT NULL,           -- 'haas-ngc' | 'okuma-osp' | 'siemens-840d'
  pool              TEXT,                    -- MES resource pool
  ip                TEXT,
  agent_device_uuid TEXT,                    -- cppagent Device UUID
  fulcrum_equip_id  TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- state_intervals: closed intervals of Execution state
CREATE TABLE state_intervals (
  id                INTEGER PRIMARY KEY,
  machine_id        TEXT NOT NULL,
  state             TEXT NOT NULL,           -- ACTIVE | FEED_HOLD | STOPPED | INTERRUPTED | OFFLINE
  started_at        TEXT NOT NULL,
  ended_at          TEXT NOT NULL,
  duration_seconds  INTEGER NOT NULL,
  program           TEXT,
  tool_number       INTEGER,
  inferred_job_id   TEXT,                    -- best-effort from program name
  inferred_op_id    TEXT,
  FOREIGN KEY (machine_id) REFERENCES machines(id)
);
CREATE INDEX idx_state_intervals_machine_time ON state_intervals(machine_id, started_at);

-- events: discrete occurrences
CREATE TABLE events (
  id                INTEGER PRIMARY KEY,
  machine_id        TEXT NOT NULL,
  ts                TEXT NOT NULL,
  kind              TEXT NOT NULL,           -- alarm | program_change | tool_change | part_completed | estop | door
  severity          TEXT NOT NULL,           -- info | warning | fault
  payload           TEXT,                    -- JSON
  FOREIGN KEY (machine_id) REFERENCES machines(id)
);
CREATE INDEX idx_events_machine_time ON events(machine_id, ts);

-- rollups_minute: 1-minute rollups
CREATE TABLE rollups_minute (
  machine_id            TEXT NOT NULL,
  minute_bucket         TEXT NOT NULL,
  active_seconds        INTEGER NOT NULL DEFAULT 0,
  feed_hold_seconds     INTEGER NOT NULL DEFAULT 0,
  stopped_seconds       INTEGER NOT NULL DEFAULT 0,
  interrupted_seconds   INTEGER NOT NULL DEFAULT 0,
  offline_seconds       INTEGER NOT NULL DEFAULT 0,
  spindle_rpm_avg       REAL,
  spindle_load_avg      REAL,
  spindle_load_max      REAL,
  feedrate_avg          REAL,
  feed_override_avg     REAL,
  part_count_delta      INTEGER NOT NULL DEFAULT 0,
  program               TEXT,
  tool_number           INTEGER,
  PRIMARY KEY (machine_id, minute_bucket)
);

-- rollups_shift: per-machine per-shift OEE snapshot
CREATE TABLE rollups_shift (
  machine_id        TEXT NOT NULL,
  shift_date        TEXT NOT NULL,
  shift_name        TEXT NOT NULL,
  scheduled_seconds INTEGER NOT NULL,
  active_seconds    INTEGER NOT NULL,
  feed_hold_seconds INTEGER NOT NULL,
  stopped_seconds   INTEGER NOT NULL,
  offline_seconds   INTEGER NOT NULL,
  availability      REAL NOT NULL,
  utilization       REAL NOT NULL,
  part_count        INTEGER NOT NULL DEFAULT 0,
  alarm_count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (machine_id, shift_date)
);

-- alerts: generated by collector worker
CREATE TABLE alerts (
  id                INTEGER PRIMARY KEY,
  machine_id        TEXT NOT NULL,
  kind              TEXT NOT NULL,           -- feed_hold_extended | idle_during_shift | alarm_sustained | offline | estop_triggered | spindle_overload
  triggered_at      TEXT NOT NULL,
  cleared_at        TEXT,
  severity          TEXT NOT NULL,
  message           TEXT NOT NULL,
  acknowledged_by   TEXT,
  acknowledged_at   TEXT
);
CREATE INDEX idx_alerts_machine_open ON alerts(machine_id, cleared_at);
```

Volume sizing: 2 machines × ~2000 event + state rows/day + 2880 minute rollups/day. At full priority fleet (6-8 machines) × 365 days that is well inside D1's comfort zone — no TSDB needed at this scale.

### 5.2 Computation locations

| Metric | Computed where | Trigger |
|---|---|---|
| State intervals | Edge collector | Execution state change |
| Minute rollups | Edge collector | Every minute |
| Shift rollup + OEE availability/utilization | Cloud worker cron | Nightly |
| Alerts | Cloud worker cron | Every 30 s |
| Raw sample drill-down | Edge (on demand) | MES user click |

### 5.3 Alert rules (Phase 1 defaults)

| Rule | Condition | Severity |
|---|---|---|
| `feed_hold_extended` | `FEED_HOLD` state open > 10 min during shift | warning |
| `idle_during_shift` | `STOPPED` state open > 20 min during shift, no active alarm | warning |
| `alarm_sustained` | fault-severity condition active > 2 min | fault |
| `offline` | no data from agent > 5 min during shift | fault |
| `estop_triggered` | `EmergencyStop` event with value TRIGGERED | fault |
| `spindle_overload` | `Load` sample > 95% for > 30 s | warning (enabled after Phase C tuning) |

Thresholds are per-machine-pool overridable via `machines` table extension (Phase D). Alert fan-out: (1) MES alert panel, (2) Slack `#shop-floor-alerts`, (3) `GET /alerts?unack=1` for future andon integrations.

---

## 6. Phased Roadmap

### Phase A — Pipeline proof, one Haas (~3 sessions)

- Procure edge NUC; install Ubuntu LTS + Ansible baseline (FDE, SSH keys, monitoring VLAN, NTP, unattended-upgrades).
- Stand up `mtconnect-collector` CF Worker skeleton, D1 migrations, auth.
- Enable MTConnect option on one Haas; verify `/probe` and `/current` respond.
- Deploy cppagent on edge box; configure it to consume from the Haas native agent.
- Write collector service; compute state intervals + minute rollups; push to cloud; buffer to local SQLite.
- Deploy CF Tunnel for drill-down proxy.
- Add "Machines" tab skeleton to shop-floor-mes.
- Smoke test: cycle start → ACTIVE interval in D1 within 10 s, rendered in MES.
- **Deliverable:** one Haas machine live with state, utilization bar, and `feed_hold_extended` firing correctly.

### Phase B — Second Haas + Okuma (~2 sessions)

- Add second Haas — verifies multi-machine scale.
- Okuma: verify App Suite MTConnect adapter licensing; install on HMI PC or configure cppagent to consume.
- Wire all six Phase 1 alert rules; tune thresholds against real shift data.
- Shift rollups cron running nightly; OEE on dashboard.
- **Deliverable:** 3 machines live, first OEE report from real data, alert latency measured end-to-end.

### Phase C — DVF 5000 #1, custom Siemens adapter (~3 sessions)

- Controls tech verifies Sinumerik OPC UA Server option on DVF #1.
- Write `siemens-opcua-adapter` (Python, asyncua); unit-test against a FreeOpcUa simulator before touching the real machine.
- Shadow-run alongside manual monitoring for one week; reconcile state intervals against operator logs.
- Correct ontology docs (Doosan DN, Siemens, not Mazak/Mazatrol).
- **Deliverable:** DVF #1 instrumented, simulator-backed regression test suite, adapter repo ready to open-source.

### Phase D — DVF #2 + remaining Okuma (~2 sessions)

- Add DVF #2 (zero new code, one config entry in the adapter).
- Add remaining Okuma machines.
- Per-pool alert threshold overrides.
- **Deliverable:** priority fleet live, pool-level utilization on scoreboard.

---

## 7. Build & Test Strategy

1. **OPC UA simulator** — FreeOpcUa `asyncua` server locally exposing the Sinumerik node shape. Scripted state transitions (load program, start, feedhold, alarm, tool change, M30) assert through cppagent + collector into fixtures. Runs in CI.
2. **cppagent synthetic device** — cppagent ships a sample device; use it to generate traffic against the collector during local dev with no real hardware.
3. **Collector unit tests** — replay canned SHDR / XML streams, assert computed state intervals, rollups, and alert firings match fixtures.
4. **Staging D1** — collector worker has a `staging` wrangler env pointing at a separate D1, so real edge data can flow during bring-up without touching prod.
5. **Shadow mode** — during Phase B/C, collector writes prod D1 but MES shows machine state alongside the existing manual board for one week before any manual signal is retired.
6. **Chaos checks** — network partition (edge WAN unplugged for 30 min) verifies local SQLite keeps collecting and the cloud backfills on reconnect.
7. **Alert rehearsal** — artificially trigger each rule (stop during shift, leave in feed-hold, raise a controlled alarm) and verify MES panel + Slack fan-out on each.

### Verification checklist before declaring Phase 1 done

- [ ] All three controller kinds live on ≥ 1 machine each.
- [ ] 7 consecutive days of shift rollups with no gaps > 5 min.
- [ ] All 6 alert rules fired in rehearsal; MTTA measured.
- [ ] Drill-down: pull raw samples for any 1-min window in last 30 days within 5 s.
- [ ] Edge box reboot-and-resume with no manual intervention.
- [ ] Ansible baseline reproducible: wipe + re-apply + machines reconnected < 15 min.
- [ ] CMMC scaffolding verified (§8).
- [ ] Ontology docs corrected.

---

## 8. CMMC Scaffolding (monitoring plane)

Even though Phase 1 handles no CUI, the edge box and cloud collector are being designed so that DNC (CUI) can be added as a bolt-on service on the same infrastructure without a rewrite.

### Controls baked into Phase 1

- **Access control:** SSH key-only authentication on the edge box; no local passwords; per-user keys managed in a central repo; sudo auditd rules.
- **Identification / auth:** unique per-person keys; service accounts distinct from human accounts; no shared credentials.
- **System / comms protection:** full-disk encryption (LUKS); TLS 1.3 on all outbound to cloud; mTLS on cloud ingress via CF Tunnel; egress allowlist to Cloudflare IP ranges + NTP only.
- **Configuration management:** host configuration in git; deploy via Ansible; no SSH-and-edit drift.
- **Audit / accountability:** systemd journal + auditd → shipped to cloud log sink alongside telemetry; retention ≥ 90 days.
- **Physical protection:** edge box lives in a locked network cabinet on the shop floor; tamper-evident seal.
- **Media protection:** FDE covers data at rest; local SQLite buffer is inside LUKS.
- **Time sync:** NTP to an authoritative source (required for audit log integrity).
- **Host hygiene:** Ubuntu LTS / AlmaLinux with unattended security updates; rootless containers (podman); adapter/collector processes run as non-root.
- **Secret management:** cloud push tokens and TLS material stored in systemd credentials or a sealed local store, not environment variables.

### Future DNC overlay (documented, not built)

When DNC is added, the following additional controls kick in on the same box:

- FIPS 140-3 validated cryptography (OpenSSL FIPS provider or RHEL FIPS mode) for CUI at rest and in transit.
- SIEM integration with CUI-flagged events and 3+ year retention.
- Per-programmer authentication + per-operator acknowledgment for every NC file push, with full content hash audit.
- Separate service on the edge box with its own user, its own cgroups, and its own egress policy — no sharing of identity, ports, or credentials with the monitoring plane.
- System Security Plan (SSP) document covering this specific boundary.

### Data classification reminder

- **Operational telemetry** (state, RPM, feedrate, loads): not CUI. Standard TLS + audit.
- **Program names** captured via MTConnect: may reveal part identity. Cloud storage treats `program` field as **sensitive metadata** — not exposed to unauthenticated endpoints; avoid customer-name substrings in prod logs.
- **NC program content**: never transits MTConnect; reserved for the DNC project's own CUI-scoped channel.

---

## 9. Open Questions / Prerequisites

| Item | Owner | Blocking? |
|---|---|---|
| Verify Sinumerik OPC UA Server option licensed on both DVF 5000s | Controls tech | Blocks Phase C start |
| Verify Okuma App Suite MTConnect adapter licensed | Controls tech / Okuma rep | Blocks Phase B Okuma step (fallback exists) |
| Procure edge NUC hardware | Tyler | Blocks Phase A |
| Shop-floor monitoring VLAN + Unifi SSID provisioned on existing Unifi stack | IT | Blocks Phase A |
| Unifi UDB-IoT bridges ordered (1 per priority-fleet machine) | Tyler | Blocks Phase A bring-up of first Haas |
| Per-machine rack design (computer, monitor, bridge, andon, dedicated 120V) for new facility | Tyler / facilities | Non-blocking for Phase 1; informs new-facility buildout |
| Slack `#shop-floor-alerts` channel + bot token | Tyler | Blocks alert fan-out (MES-only delivery works without it) |
| Decide edge-box hostname convention + cloud machine-id convention | Tyler | Non-blocking, minor |

---

## 10. Sovereignty Audit

| Component | Source | License | Ownership |
|---|---|---|---|
| cppagent | MTConnect Institute | Apache-2.0 | Open-source, we run our own build |
| Siemens OPC UA adapter | Ours | Internal (open-source-ready) | Wholly ours |
| Okuma adapter (if needed) | Ours | Internal | Wholly ours |
| Collector service | Ours | Internal | Wholly ours |
| mtconnect-collector Worker | Ours | Internal | Wholly ours |
| MES Machines tab | Ours | Internal | Wholly ours (part of shop-floor-mes) |
| Podman / Ansible / SQLite / Python / asyncua | Open-source | Apache-2.0 / GPL / public domain / BSD | We run our own builds |
| Ubuntu LTS / AlmaLinux | Open-source | various | We run our own box |
| Unifi UDB-IoT + Unifi controller stack | Third-party hardware | — | On-prem managed, no vendor telemetry dependency; consistent with existing FFMFG network posture |
| Cloudflare Workers / D1 / Tunnel | Third-party platform | — | Same posture as existing MES; user already uses CF |

Nothing in the critical telemetry path requires a third-party SaaS machine-monitoring vendor.
