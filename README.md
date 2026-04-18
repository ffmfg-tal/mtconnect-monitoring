# mtconnect-monitoring

First-party CNC machine data pipeline for FFMFG. Self-hosted MTConnect agent + adapters on a shop-floor edge box, feeding a Cloudflare Workers collector that serves OEE metrics and real-time alerts to the shop-floor MES.

Sovereignty stance: hardware we own, software we wrote. Open-source components (cppagent, Python, Podman, SQLite, Ansible) where we don't write the code ourselves. No third-party SaaS machine-monitoring vendor.

## Scope

- **Phase 1 goals:** OEE truth + real-time shift alerts (read-only).
- **Phase 1 machines:** 2× Haas, Okuma, 2× DN DVF 5000 (Siemens 840D sl).
- **Out of scope for Phase 1:** WorkOrder asset push (deferred to Phase 2), DNC (separate project), NC-side writes (permanently out of scope).

See `docs/superpowers/specs/2026-04-18-mtconnect-cnc-networking-design.md` for the full design.

## Layout

- `cloud/` — Cloudflare Worker (`mtconnect-collector`): ingest, read API, drill-down proxy, crons.
- `edge/collector/` — Python service running on the edge NUC: tails cppagent, computes state intervals + rollups, pushes to cloud, serves drill-down.
- `edge/cppagent/` — cppagent configuration (agent.cfg + per-device XML).
- `edge/compose/` — podman-compose stack definition.
- `edge/ansible/` — baseline deploy for the edge NUC (OS hardening, VLAN egress, NTP, services).
- `docs/` — design specs, implementation plans, runbooks.
