# Contributing to mtconnect-monitoring

Thanks for wanting to help. This project is built to be extended — every additional controller adapter, alert rule, OEE metric, and runbook makes it more useful to the next shop that adopts it.

## Quick orientation

Start with:

1. `README.md` — what this is and why.
2. `AGENTS.md` — conventions for humans and AI coding agents.
3. `docs/superpowers/specs/2026-04-18-mtconnect-cnc-networking-design.md` — the Phase 1 design.
4. `docs/superpowers/plans/` — active implementation plans.

## Ways to contribute

- **Add a controller adapter.** Mazak, Fanuc, Mitsubishi, Heidenhain, older Siemens, Okuma variants — all welcome. Follow the Python adapter template in `edge/collector/` and file a `docs/runbooks/add-<controller>-machine.md`.
- **Add an alert rule.** The alert-rule system in `cloud/src/cron/alert_scan.ts` is a simple rule-per-function pattern. Propose new rules with test fixtures.
- **Improve OEE calculations.** Phase 1 ships Availability + Utilization. Performance (cycle-time vs estimate) and Quality (scrap-rate) require job correlation and scrap data — contributions that close those gaps are highly welcome.
- **Document your deployment.** A runbook from a shop that successfully deployed this on, say, a fleet of Haas VF-2s with a different network topology, is gold for the next shop.
- **File bugs.** Especially anything that looks like silent data loss (missed state transitions, miscounted rollups, rogue alerts).

## What NEVER goes in this repo

This is a public repository. Treat it as such. The following must never be committed:

- **Real customer part numbers, program names, drawings, or NC programs.** Use made-up examples like `EXAMPLE-1234-A` or `DEMO-OP20.MPF`.
- **Real machine IP addresses or MAC addresses from a production network.** Use examples from `10.0.50.0/24` or other clearly synthetic ranges.
- **Real Fulcrum Pro / ERP IDs.** Use example UUIDs only.
- **Slack webhook URLs, Cloudflare tunnel tokens, wrangler secrets, API keys, bearer tokens.** Any secret. Use `.env.example` for shape.
- **Database dumps containing real operational data** — even "just for testing."
- **`.pem`, `.key`, `.pfx`, `.p12`, `terraform.tfstate`, `.env`** — covered by `.gitignore`, keep it that way.
- **ITAR-controlled technical data.** If your shop works with defense programs, know what technical data you handle and keep it on your side. MTConnect telemetry by itself is not CUI; NC program content and engineering drawings are.
- **Competitive ops telemetry.** Default alert thresholds in this repo are starting points, not FFMFG's calibrated values. Keep your tuned thresholds in your own deployment config.

If you accidentally commit something sensitive, stop, don't push, and let us know — we'll help you rewrite history before it goes public.

## Development setup

### Cloud worker (`cloud/`)

```bash
cd cloud
npm install
npm run db:migrate:local         # apply migrations to local D1
npm run dev                       # wrangler dev
npm test                          # run vitest suite
npm run type-check
```

### Edge collector (`edge/collector/`)

```bash
cd edge/collector
python -m venv .venv
source .venv/bin/activate         # on Windows: .venv\Scripts\activate
pip install -e '.[dev]'
pytest                            # run test suite
```

### End-to-end (no real machines)

A synthetic cppagent (shipping in the `mtconnect/cppagent` container as a simulator) drives canned state transitions into the collector. The edge-side tests run fully offline against fixture XML streams in `edge/collector/tests/fixtures/sample_streams/`.

## Conventions

- **TDD.** Pure logic (state machine, rollup math, alert rules, parsing) starts from a failing test. Always.
- **Small files, one responsibility.** If a file is growing beyond a few hundred lines, it's probably doing too much.
- **Commit per passing test.** Frequent, small commits beat one giant "feat: implement X" commit.
- **No placeholders in plans or PRs.** No "TODO: implement validation" — implement the validation or remove the claim.
- **Unix shell syntax in scripts and docs** (forward slashes, `/dev/null`), even though FFMFG's primary dev host is Windows.

## AI coding agents

We actively use Claude Code (via the superpowers skill stack) to develop this project. External contributors using Cursor, Copilot, Aider, Roo, or any other agent are welcome — see `AGENTS.md` for the conventions agents should follow.

If your agent generates a PR, you are still responsible for its correctness. Review the diff before submitting.

## PR checklist

- [ ] Tests for any new behavior (TDD).
- [ ] `npm test` / `pytest` passing.
- [ ] Type-check clean (`npm run type-check`).
- [ ] No secrets / real data / customer identifiers in the diff.
- [ ] `README.md`, `AGENTS.md`, or relevant runbook updated if behavior changed.
- [ ] Commit messages describe the *why*, not just the *what*.

## License

By contributing, you agree that your contributions are licensed under the Apache-2.0 license that governs this project.

## Contact

Open a GitHub Discussion or Issue. For security disclosures see `SECURITY.md`.
