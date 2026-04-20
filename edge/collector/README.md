# edge/collector — Monday MVP

One-file polling loop that tails a single machine's MTConnect `/current`
endpoint and pushes state intervals, events, and minute rollups to the
`mtconnect-collector` Cloudflare Worker.

**This is not the Phase-A NUC deployment.** No cppagent, no podman, no
SQLite buffer, no Ansible. Just Python talking straight to the Haas native
MTConnect agent over the shop LAN, on your Windows laptop. Purpose: prove
the pipeline end-to-end with one real machine so the full design has
signal behind it.

## Prereqs (check tomorrow morning)

1. **Haas MTConnect option enabled.** On NGC: `Setting 143 = MTCONNECT` (or
   equivalent on current firmware). Verify from another machine on the
   shop LAN:
   ```bash
   curl http://<haas-ip>:8082/probe
   # expect an XML response containing <MTConnectDevices>
   curl http://<haas-ip>:8082/current | head -60
   # expect <Execution>ACTIVE</Execution> etc.
   ```
   Default port is `8082`. If the setting is off, the request errors or
   times out — enabling it is a one-touch change at the machine control.
2. **Your laptop can reach the Haas.** Same LAN, no firewall blocking
   inbound to the Haas's port 8082.
3. **Cloud worker deployed.** From `cloud/`:
   ```bash
   npm install
   npm run db:migrate:prod
   npm run deploy
   ```
   Note the deployed URL (`https://mtconnect-collector.<subdomain>.workers.dev`).
4. **EDGE_SHARED_SECRET set as a Worker secret:**
   ```bash
   wrangler secret put EDGE_SHARED_SECRET
   # paste any strong random string; you'll reuse it below
   ```
5. **Machine row exists in D1.** The cloud rejects unknown `machine_id`s.
   One-shot seed (edit IP + display name):
   ```bash
   wrangler d1 execute mtconnect --remote --command "
   INSERT INTO machines (id, display_name, controller_kind, pool, ip, enabled, created_at, updated_at)
   VALUES ('haas-vf2-1', 'Haas VF-2 (MVP)', 'haas-ngc', 'vmc', '192.168.10.23', 1,
           strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))
   ON CONFLICT (id) DO NOTHING;
   "
   ```

## Install

```bash
cd edge/collector
py -m pip install -e ".[dev]"
py -m pytest -q   # 46 passing
```

## Run

Set four env vars, then start the loop:

```bash
export MTCONNECT_AGENT_URL="http://192.168.10.23:8082"
export MTCONNECT_MACHINE_ID="haas-vf2-1"
export MTCONNECT_CLOUD_BASE_URL="https://mtconnect-collector.<subdomain>.workers.dev"
export EDGE_SHARED_SECRET="<same value you set with wrangler secret put>"
# optional: export MTCONNECT_POLL_SECONDS=2

py -m collector.main
```

You should see log lines like:

```
2026-04-21 09:14:02 INFO collector: starting collector: machine=haas-vf2-1 ...
2026-04-21 09:14:02 INFO collector: pushed 2 event(s): program_change, tool_change
2026-04-21 09:16:02 INFO collector: pushed 1 rollup minute(s)
2026-04-21 09:22:14 INFO collector: pushed 1 state interval(s): ACTIVE(432s)
```

## Verify end-to-end

From another terminal, hit the cloud read endpoints:

```bash
# Latest state for all machines
curl $MTCONNECT_CLOUD_BASE_URL/machines

# Today's OEE for the Haas
curl $MTCONNECT_CLOUD_BASE_URL/machines/haas-vf2-1/oee?date=$(date -u +%Y-%m-%d)

# Open alerts (will be empty until the alert-rule cron is wired up)
curl $MTCONNECT_CLOUD_BASE_URL/alerts
```

Press cycle-start on the Haas → within ~2 s you should see a
`program_change` event on the cloud and a state interval close to ACTIVE
once the prior STOPPED interval ends.

## What this MVP deliberately does NOT do

- Buffer locally if the cloud is unreachable — events during an outage are dropped.
  (Phase A adds the SQLite rolling buffer.)
- Run cppagent or normalize per-component condition streams.
- Fire alerts (that's a Worker cron, not the edge).
- Handle multiple machines from one process.
- Run as a systemd service, rootless container, or with any CMMC controls.

All of those come in Phase A once the pipeline is proven. See
`docs/superpowers/specs/2026-04-18-mtconnect-cnc-networking-design.md`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `unknown machine_id` 400 from cloud | `machines` row not seeded — run the D1 insert above |
| `unauthorized` 401 from cloud | `EDGE_SHARED_SECRET` mismatch between laptop and Worker |
| `/current` 404 or connection refused | Haas MTConnect setting not enabled, or wrong port |
| `<Execution>UNAVAILABLE</Execution>` on every poll | Haas control is off or in a state the agent reports as unavailable — fine, OFFLINE intervals will still land in D1 |
| Rollups never arrive | The first attribution opens a bucket; it only flushes when a minute boundary is crossed, so expect a ~60 s warm-up |
