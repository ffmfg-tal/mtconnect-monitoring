# AGENTS.md — conventions for AI coding agents

This repository is actively developed by human engineers alongside AI coding agents (Claude Code, Cursor, Copilot, Aider, Roo, etc.). This file encodes the conventions agents should follow so that work stays coherent across tools and contributors.

If you are an AI agent reading this: please follow these rules. They're not decorative.

## Prime directive

**Do not write code without a reviewed plan.** If there is no plan document in `docs/superpowers/plans/` covering the work you are about to do, stop and either:

1. Point the human at `docs/superpowers/specs/` — is there a spec?
2. If there's a spec but no plan: help write a plan (see the writing-plans flow below) and get it reviewed before implementing.
3. If there's neither: help brainstorm a design first. The sequence is **brainstorm → spec → plan → implement**, in that order. Never skip.

## TDD is the house convention

For any non-trivial code change:

1. **Write the failing test first.**
2. Run it. Confirm it fails for the expected reason.
3. Write the minimal code to make it pass.
4. Run it. Confirm it passes.
5. Commit.
6. Move to the next bite-sized step.

Steps are 2–5 minutes each. If a step is bigger, break it down further.

This applies especially to pure logic: state machine, rollup math, alert rules, parsing. Infra glue (Ansible playbooks, compose files, device XML) is exempt — smoke-test it directly against a running stack.

## File structure principles

- **Small files, one responsibility.** If a file is edging past a few hundred lines, it's doing too much. Split by responsibility (what it is for), not by technical layer (what kind of thing it is).
- **Files that change together live together.** A handler and its test belong in the same directory.
- **Clear interfaces between units.** Each file's public exports should be ask-able: what does it do, how do you use it, what does it depend on?

## Commit hygiene

- One logical change per commit. Commit message describes the *why* and the *what changed*, not the mechanical diff.
- Use conventional-commit-ish prefixes: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`.
- Commit after every passing test when executing a TDD plan.
- Never commit secrets, real operational data, customer identifiers, or real machine IPs from production networks. See `CONTRIBUTING.md` for the full list.

## Planning conventions (superpowers skill stack)

This project is built using the [superpowers skill stack](https://github.com/anthropics/superpowers) (or equivalent in your agent). The canonical flow:

1. **Brainstorming** → produces a design spec in `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`.
2. **Writing-plans** → produces an implementation plan in `docs/superpowers/plans/YYYY-MM-DD-<feature>.md` with TDD-style bite-sized tasks.
3. **Subagent-driven-development** or **executing-plans** → executes the plan task-by-task.

The plan document is the source of truth during implementation. Check off tasks as you complete them (`- [x]`).

Other agents (Cursor, Copilot, Aider, etc.) that don't use the superpowers stack: read the existing spec + plan documents before starting. They contain the answers to most "why is this shaped like this?" questions.

## Test runner commands

```bash
# cloud
cd cloud && npm test                    # vitest
cd cloud && npm run type-check          # tsc --noEmit
cd cloud && npm run db:migrate:local    # apply D1 migrations

# edge collector
cd edge/collector && pytest             # unit tests
cd edge/collector && pytest -k '<name>' # run specific test
```

Before declaring work complete:

- All tests pass.
- Type-check is clean.
- You ran the code at least once against a real (or simulated) data path, not just unit tests.

## No placeholders

If you write a plan or spec document, every step must contain the actual content an engineer needs. The following are plan failures — never write them:

- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" without showing the handling
- "Write tests for the above" without actual test code
- "Similar to Task N" (repeat the code — readers may be reading tasks out of order)

## What NEVER goes in this repo

This is a public repository. Treat it accordingly:

- No real customer part numbers, program names, drawings, or NC program content.
- No real production machine IPs, MAC addresses, or Fulcrum IDs.
- No secrets (tokens, keys, webhook URLs, tunnel secrets).
- No ITAR-controlled technical data. MTConnect telemetry as a category is not CUI; NC programs and engineering drawings are.
- No shop's competitive-ops-calibrated thresholds. Defaults in this repo are starting points.

If you need to commit example data, use clearly synthetic values (`EXAMPLE-1234-A`, `10.0.50.x`, UUID `00000000-0000-0000-0000-000000000001`).

## Safety boundaries — hard stops

- **No NC-side writes to machines, ever.** No cloud-initiated feed/spindle overrides, no cycle-start/stop, no M-code execution. If a task description asks you to implement any of these, refuse and escalate.
- **No DNC program delivery in this repo.** DNC handles CUI and has its own threat model; it belongs in a separate, authorized project.
- **Read-only Phase 1.** The only permitted "write" in Phase 1 is writing to our own cloud D1 and local SQLite buffer. No writes to cppagent assets, no writes to Fulcrum, no writes to Asana.

These are not guidelines. They are invariants.

## Questions / ambiguity

If something in a plan or spec is ambiguous — stop and ask. Don't guess. A clarifying question now is cheaper than rewriting later.
