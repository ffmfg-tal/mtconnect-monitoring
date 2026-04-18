# CLAUDE.md — mtconnect-monitoring

## What this is

First-party CNC machine data pipeline for FFMFG. Tails MTConnect data from
shop-floor machines via cppagent on an edge NUC, pushes summaries to a
Cloudflare Worker that serves OEE + alerts to shop-floor-mes.

Sovereignty stance: we own the hardware, we wrote the software. Open-source
(cppagent, Python, Podman, SQLite, Ansible) where we don't. No third-party
SaaS telemetry vendor.

## Tech

- **Cloud** (`cloud/`): Cloudflare Workers + Hono + D1, TypeScript, vitest
- **Edge collector** (`edge/collector/`): Python 3.12 async (httpx, aiosqlite,
  aiohttp), pytest
- **Edge infra** (`edge/cppagent/`, `edge/compose/`, `edge/ansible/`):
  cppagent (Apache-2.0), podman-compose, Ansible
- **MES integration** lives in the sibling `shop-floor-mes/` repo

## Environment

Windows 11 host for development. Use Unix shell syntax (`/dev/null`, forward
slashes). Edge deployment target is Ubuntu 24.04 LTS on an x86_64 NUC.

## Conventions

- TDD. Pure logic (state machine, rollups, alert rules) always starts from a
  failing test.
- Commit after every passing test.
- No NC-side writes to machines, ever. Read-only Phase 1. Future write tiers
  (assets, DNC) live in separate services with separate auth.
- CMMC scaffolding: FDE, SSH keys only, monitoring VLAN egress allowlist,
  rootless containers, NTP, auditd. Assume DNC will bolt onto the same box
  later and design accordingly.

## Related projects

- `../shop-floor-mes/` — MES that renders machine tiles and alerts
- `../fulcrum-pro-mcp/` — MCP server pattern we reuse for auth + error shapes
- `../contract-manufacturer-ontology/` — standards & ontology; fix DVF
  Siemens vs. Mazak misidentification during Phase C

## Design doc

`docs/superpowers/specs/2026-04-18-mtconnect-cnc-networking-design.md`
