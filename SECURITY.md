# Security Policy

## Reporting a vulnerability

If you believe you've found a security vulnerability in this project — particularly anything that could let an attacker inject machine commands, exfiltrate shop-floor data, bypass the read-only Phase 1 boundary, or compromise the CMMC scaffolding — please report it privately before disclosing publicly.

**Email:** security@ffmfg.com
**Expected response:** within 3 business days

Please include:

- A description of the vulnerability
- Steps to reproduce (proof of concept if you have one)
- Potential impact
- Any suggested mitigation

We'll acknowledge receipt, triage, and keep you updated on remediation. Credit in release notes is offered unless you prefer to remain anonymous.

## Scope

In scope:

- The code in this repository (cloud worker, edge collector, adapters, Ansible playbooks)
- The design of the read/write boundaries documented in `docs/superpowers/specs/`

Out of scope for this repo (report to the respective projects):

- Cloudflare platform issues → Cloudflare's bug bounty
- MTConnect `cppagent` vulnerabilities → MTConnect Institute
- Vendor controller firmware (Haas, Okuma, Siemens, Fanuc) → the OEM
- An individual shop's deployment misconfiguration → that shop's IT/security team

## Hard safety boundaries

This project is designed with permanent invariants. If a reported vulnerability would, if exploited, allow any of the following, treat it as critical:

- Writing to an NC controller (feed/spindle overrides, cycle start/stop, M-code execution) via any path in this codebase.
- Pushing NC program files to a controller via any endpoint in this codebase (DNC is explicitly a separate project).
- Exfiltrating secrets stored in `wrangler secret`, `.env`, Cloudflare Tunnel credentials, or edge-box SSH keys.
- Cross-tenant read of another deployer's D1 data.

## CMMC / compliance context

This project is designed to be deployable in a CMMC Level 2 environment (monitoring plane is not CUI, DNC when added will be). If you're reporting an issue that specifically affects CMMC-scoped deployments, flag that in the report — we prioritize those.
