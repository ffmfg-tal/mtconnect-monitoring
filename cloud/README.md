# mtconnect-collector (cloud)

Cloudflare Worker that ingests MTConnect probe + observation batches from
the edge NUC, derives state intervals, conditions, events, and minute/shift
rollups, and exposes a read API for the MES tiles.

## Phase 1 — complete

What's live:

- **Ingest**
  - `POST /ingest/probe` — accepts probe XML + parsed data-item catalog, upserts
    devices + data_items
  - `POST /ingest/observations` — appends observation batches, auto-detects
    instance_id rollovers, records gap events
  - Both require the `X-Edge-Secret` header to match `EDGE_SHARED_SECRET`
- **Processor** (cron `*/1 * * * *`)
  - Reads new observations since per-stream cursors
  - Pure state machine → `state_intervals`
  - Pure condition tracker → `conditions` (open/close)
  - Pure event detector → `events` (program, tool, part_completed, estop)
  - Pure minute rollups → `rollups_minute`
  - State-machine + event cursors persisted as JSON in `processor_cursors.state_json`
- **Alerts** (cron `*/1 * * * *`, same as processor)
  - Rules: `feed_hold_extended`, `idle_during_shift`, `alarm_sustained`,
    `offline`, `estop_triggered`
  - Auto-clears when the underlying condition resolves
  - Best-effort Slack fanout via `SLACK_WEBHOOK_URL`
- **Shift rollup** (cron `0 4 * * *` ≈ 22:00 MDT previous day)
  - Summarizes `rollups_minute` + `alerts` into `rollups_shift` per device/date
- **Read API**
  - `GET /machines` — device list with latest observation timestamp
  - `GET /machines/:id/current` — latest observation per data_item
  - `GET /machines/:id/sample?from&to[&types]` — observation window
  - `GET /machines/:id/utilization?date=YYYY-MM-DD` — utilization + part count
    (honest-labeled; true OEE requires Performance + Quality legs)
  - `GET /alerts[?include_cleared=1]`, `POST /alerts/:id/ack`

## Dev workflow

```bash
cd cloud
npm install
npm test         # 62 workers-pool tests
npm run test:xsd # XSD validation (2 tests, 1 skipped — see below)
npm run type-check
```

### End-to-end against demo.mtconnect.org

```bash
# Terminal 1
cd cloud
npm run dev    # wrangler dev

# Terminal 2
cd cloud
npm run poll:demo -- --base http://localhost:8787 --secret test-secret
```

After ~30s, hit `http://localhost:8787/machines` — expect 2+ machines
(demo.mtconnect.org publishes Okuma + Mazak).

### Golden-file regeneration

```bash
cd cloud
npm run gen:golden    # rewrites test/fixtures/golden_state_intervals.json
```

## XSD validation

`test/xsd.test.ts` validates `test/fixtures/demo_*.xml` against vendored
MTConnect 2.7 schemas via `libxmljs2`. It runs under a separate vitest
config (`vitest.xsd.config.ts`) using Node's forks pool, because
`libxmljs2` is a native Node binding that can't load inside
`@cloudflare/vitest-pool-workers`.

Known: the Devices 2.7 XSD fails to compile in libxml2 (probably XSD 1.1
features not supported by libxml2), so that test is currently `.skip`'d
with a TODO. Streams 2.7 validates cleanly.

## Migrations

```bash
npm run db:migrate:local     # local d1 (wrangler dev)
npm run db:migrate:staging   # --remote, staging env
npm run db:migrate:prod      # --remote, prod
```

Migrations:

- `0001_v2_init.sql` — core tables (devices, data_items, observations,
  state_intervals, conditions, events, rollups_minute, rollups_shift,
  alerts, processor_cursors)
- `0002_processor_cursor_state.sql` — adds `state_json TEXT` to
  `processor_cursors` for state-machine + event-detector cursor persistence

## Next

Phase 2: edge forwarder (NUC-side). The Python collector in
`../edge/collector/` already does polling + rolling aggregation; the Phase 2
work is the batched forwarder to `/ingest/observations` + the Ansible
playbook to stand up the NUC.
