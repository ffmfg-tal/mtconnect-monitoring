# mtconnect-monitoring

Open-source machine data pipeline for CNC shops. Self-hosted MTConnect agent + adapters on a shop-floor edge box feeding a lightweight cloud collector that serves OEE metrics and real-time alerts to a shop-floor MES.

Founded and operated by **[Final Frontier Manufacturing (FFMFG)](https://ffmfg.com)**, an AS9100 aerospace CNC shop in Arvada, CO. Released under Apache-2.0 for the broader precision manufacturing community.

## Why this exists

Most shop-floor monitoring today means signing up for a six-figure SaaS platform that owns your machine data, locks you into their roadmap, and bolts onto whatever you happen to run. FFMFG decided the better answer was to own it — hardware, software, the whole stack — and then open-source it so other shops don't have to rebuild it from scratch.

Design values:

- **Sovereignty.** The critical path is open-source. No third-party SaaS telemetry vendor in the data path. Run it on your own edge box, ship to your own cloud tenancy.
- **Read-only by default.** Phase 1 never writes to NC machines. DNC and writeback are separate, opt-in systems with their own controls.
- **CMMC-scaffolded.** Designed assuming CUI (via DNC) will live on the same edge box eventually. FDE, SSH keys, rootless containers, audit logging, monitoring VLAN egress allowlist out of the box.
- **AI-agent-friendly.** Conventions documented in `AGENTS.md`. TDD-first, bite-sized task plans, small focused files. Fits Claude Code, Cursor, Copilot, Aider, or any agent that can read a markdown file.

## What's in the box

- **Edge stack** (`edge/`) — cppagent (MTConnect Institute reference agent) + Python collector + local SQLite rolling buffer + Cloudflare Tunnel, orchestrated by podman-compose and deployed by Ansible.
- **Cloud collector** (`cloud/`) — Cloudflare Worker with D1 for state intervals, events, rollups, and alerts. Public read API, authenticated ingest, drill-down proxy back to the edge.
- **Adapters** — Haas (native MTConnect, no code), Okuma (App Suite adapter or THINC bridge), Siemens 840D sl (OPC UA adapter, ours to write).

## Supported controllers (Phase 1)

| Controller | Support path | Phase |
|---|---|---|
| Haas NGC | Native MTConnect (enable in Settings) | A — first target |
| Okuma OSP-P | Okuma App Suite MTConnect adapter (or THINC bridge) | B |
| Siemens 840D sl / Sinumerik Operate (DN, DMG MORI, Makino, others) | Custom OPC UA → SHDR adapter (this repo) | C |

More adapters welcome — see `CONTRIBUTING.md`.

## Status

Early-stage. Phase A (foundation + first Haas) is in active implementation. See `docs/superpowers/plans/` for the current plan and `docs/superpowers/specs/` for the design.

## Repository layout

- `cloud/` — Cloudflare Worker (ingest, read, drill-down proxy, crons)
- `edge/collector/` — Python service running on the edge NUC
- `edge/cppagent/` — cppagent configuration + per-device XML
- `edge/compose/` — podman-compose stack definition
- `edge/ansible/` — baseline deploy for the edge NUC (OS hardening, services)
- `docs/` — design specs, implementation plans, runbooks

## Getting involved

See `CONTRIBUTING.md` for how to run the stack locally, add a new controller adapter, or improve the core. Issues and PRs welcome.

If you run this in production at your own shop, we'd love to hear about it — open a discussion and describe your machine fleet.

## License

Apache-2.0. See `LICENSE`.
