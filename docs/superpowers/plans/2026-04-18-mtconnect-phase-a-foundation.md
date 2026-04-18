# MTConnect Phase A — Foundation + First Haas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the full MTConnect monitoring pipeline end-to-end with one Haas machine: edge NUC running cppagent + Python collector + local SQLite buffer → Cloudflare Worker collector + D1 → "Machines" tab in shop-floor-mes showing live state and firing alerts.

**Architecture:** Edge box tails cppagent's MTConnect XML stream, computes state intervals + minute rollups, pushes summaries to a Cloudflare Worker that stores in D1 and exposes a read API. MES frontend renders from the collector API. Drill-down to raw samples proxies through a Cloudflare Tunnel back to the edge SQLite buffer.

**Tech Stack:** Cloudflare Workers + Hono + D1 + TypeScript + vitest (cloud), Python 3.12 + asyncio + httpx + aiosqlite + aiohttp + pytest (edge collector), cppagent (Apache-2.0), podman-compose, Ansible, React + Vite (MES frontend additions).

---

## Phase A scope (this plan)

This plan covers **Phase A only**: one Haas machine live end-to-end. Phases B (second Haas + Okuma), C (DN DVF 5000 + custom Siemens adapter), and D (fleet coverage) will each get their own follow-on plans once Phase A is in production and has been tuned.

## File structure

```
mtconnect-monitoring/
├── README.md                                    # (exists)
├── .gitignore                                   # (exists)
├── CLAUDE.md                                    # project instructions
├── cloud/                                       # Cloudflare Worker
│   ├── wrangler.jsonc
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── migrations/
│   │   └── 0001_init.sql                        # D1 schema (§5.1 of spec)
│   ├── src/
│   │   ├── index.ts                             # Hono app entry
│   │   ├── auth.ts                              # shared-secret middleware
│   │   ├── db.ts                                # D1 helpers
│   │   ├── types.ts                             # shared types
│   │   ├── ingest/
│   │   │   ├── state.ts                         # POST /ingest/state
│   │   │   ├── events.ts                        # POST /ingest/events
│   │   │   └── rollups.ts                       # POST /ingest/rollups
│   │   ├── read/
│   │   │   ├── machines.ts                      # GET /machines
│   │   │   ├── oee.ts                           # GET /machines/:id/oee
│   │   │   └── alerts.ts                        # GET /alerts, POST /alerts/:id/ack
│   │   ├── proxy/
│   │   │   └── drill_down.ts                    # GET /proxy/edge/samples
│   │   └── cron/
│   │       ├── alert_scan.ts                    # 30s alert rule scan
│   │       └── shift_rollup.ts                  # nightly OEE rollup
│   └── test/
│       ├── helpers.ts                           # fixture D1 + test client
│       ├── ingest.state.test.ts
│       ├── ingest.events.test.ts
│       ├── ingest.rollups.test.ts
│       ├── read.machines.test.ts
│       ├── read.oee.test.ts
│       ├── read.alerts.test.ts
│       ├── cron.alert_scan.test.ts
│       ├── cron.shift_rollup.test.ts
│       └── proxy.drill_down.test.ts
├── edge/
│   ├── collector/                               # Python service
│   │   ├── pyproject.toml
│   │   ├── src/collector/
│   │   │   ├── __init__.py
│   │   │   ├── __main__.py                      # entry point
│   │   │   ├── config.py                        # env + TOML config
│   │   │   ├── agent_client.py                  # cppagent /sample tail
│   │   │   ├── state_machine.py                 # execution state intervals
│   │   │   ├── rollups.py                       # 1-min rollup computation
│   │   │   ├── storage.py                       # local SQLite buffer
│   │   │   ├── uploader.py                      # push to cloud
│   │   │   └── drill_down.py                    # local HTTP drill-down
│   │   └── tests/
│   │       ├── conftest.py
│   │       ├── fixtures/
│   │       │   └── sample_streams/              # canned cppagent XML
│   │       ├── test_agent_client.py
│   │       ├── test_state_machine.py
│   │       ├── test_rollups.py
│   │       ├── test_storage.py
│   │       ├── test_uploader.py
│   │       └── test_drill_down.py
│   ├── cppagent/
│   │   ├── agent.cfg
│   │   └── devices/
│   │       └── haas-vf2-1.xml                   # Device description
│   ├── compose/
│   │   └── docker-compose.yaml                  # podman-compose stack
│   └── ansible/
│       ├── inventory.yml
│       ├── playbook.yml
│       └── roles/
│           ├── base/                            # OS hardening
│           ├── podman/                          # container runtime
│           └── services/                        # compose + tunnel
└── docs/
    ├── superpowers/
    │   ├── specs/                               # (exists)
    │   └── plans/                               # this plan
    └── runbooks/
        ├── add-new-machine.md
        └── drill-down-usage.md
```

## MES integration (in shop-floor-mes repo)

```
shop-floor-mes/
├── src/api/machines.ts                          # proxy to collector
└── frontend/src/views/MachinesView.tsx          # Machines tab component
└── frontend/src/components/MachineTile.tsx      # per-machine tile
└── frontend/src/components/MachineAlertsPanel.tsx
```

---

## Prerequisites (human-blocked, verify before starting)

- [ ] Edge NUC procured (Intel i5, 16GB RAM, 512GB NVMe, wired Ethernet). Ubuntu 24.04 LTS or AlmaLinux 9 installed. Shop-floor monitoring VLAN provisioned by IT. Static IP assigned.
- [ ] One Haas machine identified for Phase A. MTConnect option confirmed available and enabled in Settings (Setting 143 and related on current NGC firmware). Haas network port plugged into monitoring VLAN. Static IP assigned.
- [ ] Cloudflare account access for the deployer; Wrangler CLI installed locally (`npm i -g wrangler` or use via npx).
- [ ] Cloudflare Zero Trust (Tunnel) organization in place, or ability to create one under the FFMFG account.
- [ ] Slack workspace access; `#shop-floor-alerts` channel created; incoming webhook URL obtained (or Slack MCP access from MES side, re-used).
- [ ] The MES repo (`shop-floor-mes`) cloned locally; existing `npm run dev` / `wrangler dev` path works.
- [ ] `gh` CLI authenticated (done).

---

## Part 1 — Project scaffold

### Task 1: CLAUDE.md for the new project

**Files:**
- Create: `mtconnect-monitoring/CLAUDE.md`

- [ ] **Step 1: Write CLAUDE.md**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add mtconnect-monitoring/CLAUDE.md
git commit -m "docs: add CLAUDE.md project instructions"
```

### Task 2: Cloud worker scaffold

**Files:**
- Create: `cloud/package.json`
- Create: `cloud/tsconfig.json`
- Create: `cloud/wrangler.jsonc`
- Create: `cloud/vitest.config.ts`
- Create: `cloud/src/index.ts`
- Create: `cloud/src/types.ts`

- [ ] **Step 1: `cloud/package.json`**

```json
{
  "name": "mtconnect-collector",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "deploy:staging": "wrangler deploy --env staging",
    "test": "vitest run",
    "test:watch": "vitest",
    "type-check": "tsc --noEmit",
    "db:migrate:local": "wrangler d1 migrations apply mtconnect --local",
    "db:migrate:staging": "wrangler d1 migrations apply mtconnect --env staging --remote",
    "db:migrate:prod": "wrangler d1 migrations apply mtconnect --remote"
  },
  "dependencies": {
    "hono": "^4.6.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "@cloudflare/workers-types": "^4.20250101.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "wrangler": "^3.90.0"
  }
}
```

- [ ] **Step 2: `cloud/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noImplicitAny": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: `cloud/wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "mtconnect-collector",
  "main": "src/index.ts",
  "compatibility_date": "2025-01-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "mtconnect",
      "database_id": "REPLACE_AT_DEPLOY"
    }
  ],
  "triggers": {
    "crons": [
      "*/1 * * * *",
      "5 7 * * *"
    ]
  },
  "env": {
    "staging": {
      "name": "mtconnect-collector-staging",
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "mtconnect-staging",
          "database_id": "REPLACE_AT_DEPLOY"
        }
      ]
    }
  }
}
```

- [ ] **Step 4: `cloud/vitest.config.ts`**

```typescript
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          d1Databases: ["DB"],
        },
      },
    },
  },
});
```

- [ ] **Step 5: `cloud/src/types.ts`**

```typescript
export type Env = {
  DB: D1Database;
  EDGE_SHARED_SECRET: string;
  EDGE_TUNNEL_HOSTNAME: string;
  SLACK_WEBHOOK_URL?: string;
};

export type ExecutionState =
  | "ACTIVE"
  | "FEED_HOLD"
  | "STOPPED"
  | "INTERRUPTED"
  | "OFFLINE";

export type AlertKind =
  | "feed_hold_extended"
  | "idle_during_shift"
  | "alarm_sustained"
  | "offline"
  | "estop_triggered"
  | "spindle_overload";

export type Severity = "info" | "warning" | "fault";

export type StateIntervalIn = {
  machine_id: string;
  state: ExecutionState;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  program?: string | null;
  tool_number?: number | null;
};

export type EventIn = {
  machine_id: string;
  ts: string;
  kind: string;
  severity: Severity;
  payload?: Record<string, unknown>;
};

export type RollupMinuteIn = {
  machine_id: string;
  minute_bucket: string;
  active_seconds: number;
  feed_hold_seconds: number;
  stopped_seconds: number;
  interrupted_seconds: number;
  offline_seconds: number;
  spindle_rpm_avg?: number | null;
  spindle_load_avg?: number | null;
  spindle_load_max?: number | null;
  feedrate_avg?: number | null;
  feed_override_avg?: number | null;
  part_count_delta: number;
  program?: string | null;
  tool_number?: number | null;
};
```

- [ ] **Step 6: `cloud/src/index.ts`** (minimal skeleton)

```typescript
import { Hono } from "hono";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "mtconnect-collector" }));

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // cron handlers wired in later tasks
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 7: Install + verify type-check**

Run: `cd cloud && npm install && npm run type-check`
Expected: no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add cloud/
git commit -m "feat(cloud): scaffold CF Worker with Hono + vitest + D1 binding"
```

### Task 3: D1 schema migration

**Files:**
- Create: `cloud/migrations/0001_init.sql`

- [ ] **Step 1: Write the migration**

```sql
-- machines: static registry, one row per machine
CREATE TABLE machines (
  id                TEXT PRIMARY KEY,
  display_name      TEXT NOT NULL,
  controller_kind   TEXT NOT NULL,
  pool              TEXT,
  ip                TEXT,
  agent_device_uuid TEXT,
  fulcrum_equip_id  TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- state_intervals: closed intervals of Execution state
CREATE TABLE state_intervals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id        TEXT NOT NULL,
  state             TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  ended_at          TEXT NOT NULL,
  duration_seconds  INTEGER NOT NULL,
  program           TEXT,
  tool_number       INTEGER,
  inferred_job_id   TEXT,
  inferred_op_id    TEXT,
  FOREIGN KEY (machine_id) REFERENCES machines(id)
);
CREATE INDEX idx_state_intervals_machine_time ON state_intervals(machine_id, started_at);

-- events: discrete occurrences
CREATE TABLE events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id        TEXT NOT NULL,
  ts                TEXT NOT NULL,
  kind              TEXT NOT NULL,
  severity          TEXT NOT NULL,
  payload           TEXT,
  FOREIGN KEY (machine_id) REFERENCES machines(id)
);
CREATE INDEX idx_events_machine_time ON events(machine_id, ts);

-- rollups_minute
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

-- rollups_shift
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

-- alerts
CREATE TABLE alerts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id        TEXT NOT NULL,
  kind              TEXT NOT NULL,
  triggered_at      TEXT NOT NULL,
  cleared_at        TEXT,
  severity          TEXT NOT NULL,
  message           TEXT NOT NULL,
  acknowledged_by   TEXT,
  acknowledged_at   TEXT
);
CREATE INDEX idx_alerts_machine_open ON alerts(machine_id, cleared_at);
CREATE INDEX idx_alerts_kind_open ON alerts(kind, machine_id, cleared_at);
```

- [ ] **Step 2: Apply migration locally**

Run: `cd cloud && npx wrangler d1 create mtconnect --local && npm run db:migrate:local`
Expected: 7 statements executed, 0 errors.

- [ ] **Step 3: Commit**

```bash
git add cloud/migrations/
git commit -m "feat(cloud): add initial D1 schema migration"
```

### Task 4: Test helpers (fixture D1 + test client)

**Files:**
- Create: `cloud/test/helpers.ts`

- [ ] **Step 1: Write test helpers**

```typescript
import { env } from "cloudflare:test";
import type { Env } from "../src/types";

export function testEnv(): Env {
  return env as unknown as Env;
}

export async function resetDb(e: Env = testEnv()): Promise<void> {
  await e.DB.batch([
    e.DB.prepare("DELETE FROM alerts"),
    e.DB.prepare("DELETE FROM rollups_shift"),
    e.DB.prepare("DELETE FROM rollups_minute"),
    e.DB.prepare("DELETE FROM events"),
    e.DB.prepare("DELETE FROM state_intervals"),
    e.DB.prepare("DELETE FROM machines"),
  ]);
}

export async function seedMachine(
  id: string,
  overrides: Partial<{
    display_name: string;
    controller_kind: string;
    pool: string;
    ip: string;
  }> = {},
  e: Env = testEnv(),
): Promise<void> {
  const now = new Date().toISOString();
  await e.DB.prepare(
    `INSERT INTO machines (id, display_name, controller_kind, pool, ip, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(
      id,
      overrides.display_name ?? id,
      overrides.controller_kind ?? "haas-ngc",
      overrides.pool ?? "small-3-axis-mill",
      overrides.ip ?? "10.0.50.21",
      now,
      now,
    )
    .run();
}

export function authHeaders(secret = "test-secret"): HeadersInit {
  return { "X-Edge-Secret": secret, "Content-Type": "application/json" };
}
```

- [ ] **Step 2: Commit**

```bash
git add cloud/test/helpers.ts
git commit -m "test(cloud): add D1 reset + machine seed helpers"
```

### Task 5: Auth middleware

**Files:**
- Create: `cloud/src/auth.ts`
- Create: `cloud/test/auth.test.ts`

- [ ] **Step 1: Write failing test `cloud/test/auth.test.ts`**

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";
import { authHeaders } from "./helpers";

describe("edge-secret auth middleware", () => {
  beforeAll(() => {
    (env as unknown as { EDGE_SHARED_SECRET: string }).EDGE_SHARED_SECRET =
      "test-secret";
  });

  it("rejects missing header with 401", async () => {
    const res = await SELF.fetch("https://x/ingest/state", {
      method: "POST",
      body: JSON.stringify([]),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects wrong secret with 401", async () => {
    const res = await SELF.fetch("https://x/ingest/state", {
      method: "POST",
      body: JSON.stringify([]),
      headers: authHeaders("bogus"),
    });
    expect(res.status).toBe(401);
  });

  it("allows correct secret through", async () => {
    const res = await SELF.fetch("https://x/ingest/state", {
      method: "POST",
      body: JSON.stringify([]),
      headers: authHeaders("test-secret"),
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cloud && npm test -- auth`
Expected: FAIL (no /ingest/state route, no middleware).

- [ ] **Step 3: Write `cloud/src/auth.ts`**

```typescript
import type { MiddlewareHandler } from "hono";
import type { Env } from "./types";

export const requireEdgeSecret: MiddlewareHandler<{ Bindings: Env }> = async (
  c,
  next,
) => {
  const provided = c.req.header("X-Edge-Secret");
  const expected = c.env.EDGE_SHARED_SECRET;
  if (!expected) {
    return c.json({ error: "server misconfigured" }, 500);
  }
  if (!provided || !timingSafeEqual(provided, expected)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
```

- [ ] **Step 4: Wire a stub `/ingest/state` so the test can pass**

Edit `cloud/src/index.ts` — add:

```typescript
import { Hono } from "hono";
import type { Env } from "./types";
import { requireEdgeSecret } from "./auth";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "mtconnect-collector" }));

const ingest = new Hono<{ Bindings: Env }>();
ingest.use("*", requireEdgeSecret);
ingest.post("/state", (c) => c.json({ inserted: 0 }));
app.route("/ingest", ingest);

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {},
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd cloud && npm test -- auth`
Expected: 3 passing.

- [ ] **Step 6: Commit**

```bash
git add cloud/src/auth.ts cloud/src/index.ts cloud/test/auth.test.ts
git commit -m "feat(cloud): add X-Edge-Secret auth middleware with timing-safe compare"
```

---

## Part 2 — Cloud ingest endpoints

### Task 6: Ingest state intervals

**Files:**
- Create: `cloud/src/db.ts`
- Create: `cloud/src/ingest/state.ts`
- Create: `cloud/test/ingest.state.test.ts`
- Modify: `cloud/src/index.ts`

- [ ] **Step 1: Write failing test `cloud/test/ingest.state.test.ts`**

```typescript
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";
import { resetDb, seedMachine, authHeaders, testEnv } from "./helpers";

describe("POST /ingest/state", () => {
  beforeAll(() => {
    (env as unknown as { EDGE_SHARED_SECRET: string }).EDGE_SHARED_SECRET =
      "test-secret";
  });

  beforeEach(async () => {
    await resetDb();
    await seedMachine("haas-vf2-1");
  });

  it("inserts a closed interval", async () => {
    const payload = [
      {
        machine_id: "haas-vf2-1",
        state: "ACTIVE",
        started_at: "2026-04-18T14:00:00Z",
        ended_at: "2026-04-18T14:12:00Z",
        duration_seconds: 720,
        program: "O1001",
        tool_number: 3,
      },
    ];
    const res = await SELF.fetch("https://x/ingest/state", {
      method: "POST",
      headers: authHeaders("test-secret"),
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 1 });

    const row = await testEnv()
      .DB.prepare("SELECT state, duration_seconds, program FROM state_intervals WHERE machine_id = ?")
      .bind("haas-vf2-1")
      .first();
    expect(row).toEqual({ state: "ACTIVE", duration_seconds: 720, program: "O1001" });
  });

  it("rejects unknown machine_id with 400", async () => {
    const payload = [{
      machine_id: "ghost",
      state: "ACTIVE",
      started_at: "2026-04-18T14:00:00Z",
      ended_at: "2026-04-18T14:01:00Z",
      duration_seconds: 60,
    }];
    const res = await SELF.fetch("https://x/ingest/state", {
      method: "POST",
      headers: authHeaders("test-secret"),
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
  });

  it("is idempotent on exact duplicate (same machine + started_at + state)", async () => {
    const payload = [{
      machine_id: "haas-vf2-1",
      state: "ACTIVE",
      started_at: "2026-04-18T14:00:00Z",
      ended_at: "2026-04-18T14:12:00Z",
      duration_seconds: 720,
    }];
    await SELF.fetch("https://x/ingest/state", {
      method: "POST",
      headers: authHeaders("test-secret"),
      body: JSON.stringify(payload),
    });
    const res2 = await SELF.fetch("https://x/ingest/state", {
      method: "POST",
      headers: authHeaders("test-secret"),
      body: JSON.stringify(payload),
    });
    expect(res2.status).toBe(200);

    const { count } = await testEnv()
      .DB.prepare("SELECT COUNT(*) AS count FROM state_intervals WHERE machine_id = ?")
      .bind("haas-vf2-1")
      .first<{ count: number }>() as { count: number };
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cloud && npm test -- ingest.state`
Expected: FAIL.

- [ ] **Step 3: Write `cloud/src/db.ts`**

```typescript
import type { Env } from "./types";

export async function machineExists(env: Env, id: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS x FROM machines WHERE id = ? AND enabled = 1")
    .bind(id)
    .first<{ x: number } | null>();
  return row !== null;
}

export async function distinctMachineIds(
  env: Env,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => "?").join(",");
  const res = await env.DB.prepare(
    `SELECT id FROM machines WHERE enabled = 1 AND id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{ id: string }>();
  return new Set(res.results.map((r) => r.id));
}
```

- [ ] **Step 4: Write `cloud/src/ingest/state.ts`**

```typescript
import { Hono } from "hono";
import type { Env, StateIntervalIn } from "../types";
import { distinctMachineIds } from "../db";

export const stateIngest = new Hono<{ Bindings: Env }>();

stateIngest.post("/", async (c) => {
  const body = (await c.req.json()) as StateIntervalIn[];
  if (!Array.isArray(body)) return c.json({ error: "expected array" }, 400);
  if (body.length === 0) return c.json({ inserted: 0 });

  const uniqMachines = Array.from(new Set(body.map((r) => r.machine_id)));
  const known = await distinctMachineIds(c.env, uniqMachines);
  for (const id of uniqMachines) {
    if (!known.has(id)) return c.json({ error: `unknown machine_id: ${id}` }, 400);
  }

  const stmts = body.map((r) =>
    c.env.DB.prepare(
      `INSERT INTO state_intervals
         (machine_id, state, started_at, ended_at, duration_seconds, program, tool_number, inferred_job_id, inferred_op_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT DO NOTHING`,
    ).bind(
      r.machine_id,
      r.state,
      r.started_at,
      r.ended_at,
      r.duration_seconds,
      r.program ?? null,
      r.tool_number ?? null,
    ),
  );
  await c.env.DB.batch(stmts);

  return c.json({ inserted: body.length });
});
```

- [ ] **Step 5: Add uniqueness constraint to support ON CONFLICT**

Append to `cloud/migrations/0001_init.sql` BEFORE running migrations fresh (or create a `0002_state_interval_unique.sql`):

```sql
CREATE UNIQUE INDEX uniq_state_intervals_dedup
  ON state_intervals(machine_id, started_at, state);
```

Add this as `cloud/migrations/0002_state_interval_unique.sql` to avoid rewriting history:

```sql
CREATE UNIQUE INDEX uniq_state_intervals_dedup
  ON state_intervals(machine_id, started_at, state);
```

Run: `cd cloud && npm run db:migrate:local`
Expected: migration 0002 applied.

- [ ] **Step 6: Wire into `cloud/src/index.ts`**

Replace the ingest stub:

```typescript
import { Hono } from "hono";
import type { Env } from "./types";
import { requireEdgeSecret } from "./auth";
import { stateIngest } from "./ingest/state";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "mtconnect-collector" }));

const ingest = new Hono<{ Bindings: Env }>();
ingest.use("*", requireEdgeSecret);
ingest.route("/state", stateIngest);
app.route("/ingest", ingest);

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {},
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 7: Run test to verify pass**

Run: `cd cloud && npm test -- ingest.state`
Expected: 3 passing.

- [ ] **Step 8: Commit**

```bash
git add cloud/
git commit -m "feat(cloud): POST /ingest/state with idempotent upsert + machine validation"
```

### Task 7: Ingest events

**Files:**
- Create: `cloud/src/ingest/events.ts`
- Create: `cloud/test/ingest.events.test.ts`
- Modify: `cloud/src/index.ts`

- [ ] **Step 1: Write failing test `cloud/test/ingest.events.test.ts`**

```typescript
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";
import { resetDb, seedMachine, authHeaders, testEnv } from "./helpers";

describe("POST /ingest/events", () => {
  beforeAll(() => {
    (env as unknown as { EDGE_SHARED_SECRET: string }).EDGE_SHARED_SECRET =
      "test-secret";
  });

  beforeEach(async () => {
    await resetDb();
    await seedMachine("haas-vf2-1");
  });

  it("inserts an alarm event with JSON payload", async () => {
    const payload = [{
      machine_id: "haas-vf2-1",
      ts: "2026-04-18T14:05:00Z",
      kind: "alarm",
      severity: "fault",
      payload: { code: "1010", text: "Spindle overload" },
    }];
    const res = await SELF.fetch("https://x/ingest/events", {
      method: "POST",
      headers: authHeaders("test-secret"),
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);

    const row = await testEnv()
      .DB.prepare("SELECT kind, severity, payload FROM events WHERE machine_id = ?")
      .bind("haas-vf2-1")
      .first<{ kind: string; severity: string; payload: string }>();
    expect(row?.kind).toBe("alarm");
    expect(row?.severity).toBe("fault");
    expect(JSON.parse(row!.payload)).toEqual({ code: "1010", text: "Spindle overload" });
  });

  it("handles empty payload field (null)", async () => {
    const payload = [{
      machine_id: "haas-vf2-1",
      ts: "2026-04-18T14:06:00Z",
      kind: "program_change",
      severity: "info",
    }];
    const res = await SELF.fetch("https://x/ingest/events", {
      method: "POST",
      headers: authHeaders("test-secret"),
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cloud && npm test -- ingest.events`
Expected: FAIL.

- [ ] **Step 3: Write `cloud/src/ingest/events.ts`**

```typescript
import { Hono } from "hono";
import type { Env, EventIn } from "../types";
import { distinctMachineIds } from "../db";

export const eventsIngest = new Hono<{ Bindings: Env }>();

eventsIngest.post("/", async (c) => {
  const body = (await c.req.json()) as EventIn[];
  if (!Array.isArray(body)) return c.json({ error: "expected array" }, 400);
  if (body.length === 0) return c.json({ inserted: 0 });

  const uniqMachines = Array.from(new Set(body.map((r) => r.machine_id)));
  const known = await distinctMachineIds(c.env, uniqMachines);
  for (const id of uniqMachines) {
    if (!known.has(id)) return c.json({ error: `unknown machine_id: ${id}` }, 400);
  }

  const stmts = body.map((r) =>
    c.env.DB.prepare(
      `INSERT INTO events (machine_id, ts, kind, severity, payload)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      r.machine_id,
      r.ts,
      r.kind,
      r.severity,
      r.payload ? JSON.stringify(r.payload) : null,
    ),
  );
  await c.env.DB.batch(stmts);
  return c.json({ inserted: body.length });
});
```

- [ ] **Step 4: Wire into `cloud/src/index.ts`**

Add import and route:

```typescript
import { eventsIngest } from "./ingest/events";
// ...
ingest.route("/events", eventsIngest);
```

- [ ] **Step 5: Run to verify pass**

Run: `cd cloud && npm test -- ingest.events`
Expected: 2 passing.

- [ ] **Step 6: Commit**

```bash
git add cloud/src/ingest/events.ts cloud/src/index.ts cloud/test/ingest.events.test.ts
git commit -m "feat(cloud): POST /ingest/events"
```

### Task 8: Ingest rollups

**Files:**
- Create: `cloud/src/ingest/rollups.ts`
- Create: `cloud/test/ingest.rollups.test.ts`
- Modify: `cloud/src/index.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";
import { resetDb, seedMachine, authHeaders, testEnv } from "./helpers";

describe("POST /ingest/rollups", () => {
  beforeAll(() => {
    (env as unknown as { EDGE_SHARED_SECRET: string }).EDGE_SHARED_SECRET =
      "test-secret";
  });

  beforeEach(async () => {
    await resetDb();
    await seedMachine("haas-vf2-1");
  });

  it("upserts a minute rollup", async () => {
    const payload = [{
      machine_id: "haas-vf2-1",
      minute_bucket: "2026-04-18T14:00:00Z",
      active_seconds: 45,
      feed_hold_seconds: 0,
      stopped_seconds: 15,
      interrupted_seconds: 0,
      offline_seconds: 0,
      spindle_rpm_avg: 8200,
      spindle_load_avg: 38,
      spindle_load_max: 71,
      feedrate_avg: 118,
      feed_override_avg: 100,
      part_count_delta: 0,
      program: "O1001",
      tool_number: 3,
    }];
    const res = await SELF.fetch("https://x/ingest/rollups", {
      method: "POST",
      headers: authHeaders("test-secret"),
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);

    const row = await testEnv()
      .DB.prepare(
        "SELECT active_seconds, spindle_rpm_avg FROM rollups_minute WHERE machine_id = ? AND minute_bucket = ?",
      )
      .bind("haas-vf2-1", "2026-04-18T14:00:00Z")
      .first<{ active_seconds: number; spindle_rpm_avg: number }>();
    expect(row?.active_seconds).toBe(45);
    expect(row?.spindle_rpm_avg).toBe(8200);
  });

  it("overwrites existing minute bucket on re-push", async () => {
    const base = {
      machine_id: "haas-vf2-1",
      minute_bucket: "2026-04-18T14:00:00Z",
      active_seconds: 30,
      feed_hold_seconds: 0,
      stopped_seconds: 30,
      interrupted_seconds: 0,
      offline_seconds: 0,
      part_count_delta: 0,
    };
    await SELF.fetch("https://x/ingest/rollups", {
      method: "POST",
      headers: authHeaders("test-secret"),
      body: JSON.stringify([base]),
    });
    await SELF.fetch("https://x/ingest/rollups", {
      method: "POST",
      headers: authHeaders("test-secret"),
      body: JSON.stringify([{ ...base, active_seconds: 60, stopped_seconds: 0 }]),
    });
    const row = await testEnv()
      .DB.prepare(
        "SELECT active_seconds FROM rollups_minute WHERE machine_id = ? AND minute_bucket = ?",
      )
      .bind("haas-vf2-1", "2026-04-18T14:00:00Z")
      .first<{ active_seconds: number }>();
    expect(row?.active_seconds).toBe(60);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cloud && npm test -- ingest.rollups`
Expected: FAIL.

- [ ] **Step 3: Write `cloud/src/ingest/rollups.ts`**

```typescript
import { Hono } from "hono";
import type { Env, RollupMinuteIn } from "../types";
import { distinctMachineIds } from "../db";

export const rollupsIngest = new Hono<{ Bindings: Env }>();

rollupsIngest.post("/", async (c) => {
  const body = (await c.req.json()) as RollupMinuteIn[];
  if (!Array.isArray(body)) return c.json({ error: "expected array" }, 400);
  if (body.length === 0) return c.json({ inserted: 0 });

  const uniqMachines = Array.from(new Set(body.map((r) => r.machine_id)));
  const known = await distinctMachineIds(c.env, uniqMachines);
  for (const id of uniqMachines) {
    if (!known.has(id)) return c.json({ error: `unknown machine_id: ${id}` }, 400);
  }

  const stmts = body.map((r) =>
    c.env.DB.prepare(
      `INSERT INTO rollups_minute
         (machine_id, minute_bucket, active_seconds, feed_hold_seconds, stopped_seconds,
          interrupted_seconds, offline_seconds, spindle_rpm_avg, spindle_load_avg,
          spindle_load_max, feedrate_avg, feed_override_avg, part_count_delta, program, tool_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(machine_id, minute_bucket) DO UPDATE SET
         active_seconds = excluded.active_seconds,
         feed_hold_seconds = excluded.feed_hold_seconds,
         stopped_seconds = excluded.stopped_seconds,
         interrupted_seconds = excluded.interrupted_seconds,
         offline_seconds = excluded.offline_seconds,
         spindle_rpm_avg = excluded.spindle_rpm_avg,
         spindle_load_avg = excluded.spindle_load_avg,
         spindle_load_max = excluded.spindle_load_max,
         feedrate_avg = excluded.feedrate_avg,
         feed_override_avg = excluded.feed_override_avg,
         part_count_delta = excluded.part_count_delta,
         program = excluded.program,
         tool_number = excluded.tool_number`,
    ).bind(
      r.machine_id,
      r.minute_bucket,
      r.active_seconds,
      r.feed_hold_seconds,
      r.stopped_seconds,
      r.interrupted_seconds,
      r.offline_seconds,
      r.spindle_rpm_avg ?? null,
      r.spindle_load_avg ?? null,
      r.spindle_load_max ?? null,
      r.feedrate_avg ?? null,
      r.feed_override_avg ?? null,
      r.part_count_delta,
      r.program ?? null,
      r.tool_number ?? null,
    ),
  );
  await c.env.DB.batch(stmts);
  return c.json({ inserted: body.length });
});
```

- [ ] **Step 4: Wire into index**

```typescript
import { rollupsIngest } from "./ingest/rollups";
// ...
ingest.route("/rollups", rollupsIngest);
```

- [ ] **Step 5: Run + commit**

```bash
cd cloud && npm test -- ingest.rollups
```
Expected: 2 passing.

```bash
git add cloud/src/ingest/rollups.ts cloud/src/index.ts cloud/test/ingest.rollups.test.ts
git commit -m "feat(cloud): POST /ingest/rollups with upsert"
```

---

## Part 3 — Cloud read endpoints

### Task 9: GET /machines

**Files:**
- Create: `cloud/src/read/machines.ts`
- Create: `cloud/test/read.machines.test.ts`
- Modify: `cloud/src/index.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { SELF } from "cloudflare:test";
import { resetDb, seedMachine } from "./helpers";

describe("GET /machines", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns empty array when no machines", async () => {
    const res = await SELF.fetch("https://x/machines");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ machines: [] });
  });

  it("returns registered machines with current state", async () => {
    await seedMachine("haas-vf2-1", { display_name: "Haas VF-2 #1" });
    const res = await SELF.fetch("https://x/machines");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      machines: Array<{ id: string; display_name: string; current_state: string | null }>;
    };
    expect(body.machines).toHaveLength(1);
    expect(body.machines[0].id).toBe("haas-vf2-1");
    expect(body.machines[0].display_name).toBe("Haas VF-2 #1");
    expect(body.machines[0].current_state).toBeNull();
  });
});
```

- [ ] **Step 2: Run → fails.** `cd cloud && npm test -- read.machines`

- [ ] **Step 3: Write `cloud/src/read/machines.ts`**

```typescript
import { Hono } from "hono";
import type { Env } from "../types";

export const machinesRead = new Hono<{ Bindings: Env }>();

machinesRead.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT
       m.id, m.display_name, m.controller_kind, m.pool, m.ip, m.fulcrum_equip_id,
       (SELECT state FROM state_intervals si WHERE si.machine_id = m.id
          ORDER BY started_at DESC LIMIT 1) AS current_state,
       (SELECT ended_at FROM state_intervals si WHERE si.machine_id = m.id
          ORDER BY started_at DESC LIMIT 1) AS last_seen_at
     FROM machines m
     WHERE m.enabled = 1
     ORDER BY m.pool, m.display_name`,
  ).all();
  return c.json({ machines: rows.results });
});
```

- [ ] **Step 4: Wire into `cloud/src/index.ts` (public — no auth for read)**

```typescript
import { machinesRead } from "./read/machines";
// ...
app.route("/machines", machinesRead);
```

- [ ] **Step 5: Run + commit**

```bash
cd cloud && npm test -- read.machines
git add cloud/src/read/machines.ts cloud/src/index.ts cloud/test/read.machines.test.ts
git commit -m "feat(cloud): GET /machines with latest state rollup"
```

### Task 10: GET /machines/:id/oee

**Files:**
- Create: `cloud/src/read/oee.ts`
- Create: `cloud/test/read.oee.test.ts`
- Modify: `cloud/src/index.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { SELF } from "cloudflare:test";
import { resetDb, seedMachine, testEnv } from "./helpers";

describe("GET /machines/:id/oee", () => {
  beforeEach(async () => {
    await resetDb();
    await seedMachine("haas-vf2-1");
  });

  it("returns zero availability when no state rows", async () => {
    const res = await SELF.fetch("https://x/machines/haas-vf2-1/oee?date=2026-04-18");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { availability: number; utilization: number };
    expect(body.availability).toBe(0);
    expect(body.utilization).toBe(0);
  });

  it("computes availability + utilization from minute rollups for the date", async () => {
    const now = new Date().toISOString();
    const minutes = Array.from({ length: 60 }, (_, i) => {
      const bucket = `2026-04-18T14:${String(i).padStart(2, "0")}:00Z`;
      return testEnv()
        .DB.prepare(
          `INSERT INTO rollups_minute
            (machine_id, minute_bucket, active_seconds, feed_hold_seconds, stopped_seconds,
             interrupted_seconds, offline_seconds, part_count_delta)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind("haas-vf2-1", bucket, 45, 5, 10, 0, 0, 0);
    });
    await testEnv().DB.batch(minutes);

    const res = await SELF.fetch("https://x/machines/haas-vf2-1/oee?date=2026-04-18");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      active_seconds: number;
      scheduled_seconds: number;
      availability: number;
      utilization: number;
    };
    expect(body.active_seconds).toBe(45 * 60);
    expect(body.availability).toBeGreaterThan(0);
    expect(body.utilization).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run → fails.** `cd cloud && npm test -- read.oee`

- [ ] **Step 3: Write `cloud/src/read/oee.ts`**

```typescript
import { Hono } from "hono";
import type { Env } from "../types";

export const oeeRead = new Hono<{ Bindings: Env }>();

oeeRead.get("/:id/oee", async (c) => {
  const id = c.req.param("id");
  const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);

  const row = await c.env.DB.prepare(
    `SELECT
       COALESCE(SUM(active_seconds), 0)      AS active_seconds,
       COALESCE(SUM(feed_hold_seconds), 0)   AS feed_hold_seconds,
       COALESCE(SUM(stopped_seconds), 0)     AS stopped_seconds,
       COALESCE(SUM(offline_seconds), 0)     AS offline_seconds,
       COALESCE(SUM(part_count_delta), 0)    AS part_count
     FROM rollups_minute
     WHERE machine_id = ?
       AND minute_bucket >= ?
       AND minute_bucket < ?`,
  )
    .bind(id, `${date}T00:00:00Z`, `${date}T23:59:59Z`)
    .first<{
      active_seconds: number;
      feed_hold_seconds: number;
      stopped_seconds: number;
      offline_seconds: number;
      part_count: number;
    }>();

  const active = row?.active_seconds ?? 0;
  const feedHold = row?.feed_hold_seconds ?? 0;
  const stopped = row?.stopped_seconds ?? 0;
  const offline = row?.offline_seconds ?? 0;
  const scheduled = 8 * 3600;

  const availability = scheduled > 0 ? (active + feedHold) / scheduled : 0;
  const utilization = scheduled > 0 ? active / scheduled : 0;

  return c.json({
    machine_id: id,
    date,
    active_seconds: active,
    feed_hold_seconds: feedHold,
    stopped_seconds: stopped,
    offline_seconds: offline,
    scheduled_seconds: scheduled,
    availability,
    utilization,
    part_count: row?.part_count ?? 0,
  });
});
```

- [ ] **Step 4: Wire**

```typescript
import { oeeRead } from "./read/oee";
// ...
app.route("/machines", oeeRead);
```

(`oeeRead` mounts `/:id/oee` under `/machines`, alongside the existing `machinesRead`.)

- [ ] **Step 5: Run + commit**

```bash
cd cloud && npm test -- read.oee
git add cloud/src/read/oee.ts cloud/src/index.ts cloud/test/read.oee.test.ts
git commit -m "feat(cloud): GET /machines/:id/oee computing availability + utilization"
```

### Task 11: Alerts read + ack

**Files:**
- Create: `cloud/src/read/alerts.ts`
- Create: `cloud/test/read.alerts.test.ts`
- Modify: `cloud/src/index.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { SELF } from "cloudflare:test";
import { resetDb, seedMachine, testEnv } from "./helpers";

async function seedAlert(machineId: string, kind: string, cleared = false) {
  const now = new Date().toISOString();
  await testEnv()
    .DB.prepare(
      `INSERT INTO alerts (machine_id, kind, triggered_at, cleared_at, severity, message)
       VALUES (?, ?, ?, ?, 'warning', 'test')`,
    )
    .bind(machineId, kind, now, cleared ? now : null)
    .run();
}

describe("GET /alerts + POST /alerts/:id/ack", () => {
  beforeEach(async () => {
    await resetDb();
    await seedMachine("haas-vf2-1");
  });

  it("returns only open alerts by default", async () => {
    await seedAlert("haas-vf2-1", "feed_hold_extended");
    await seedAlert("haas-vf2-1", "idle_during_shift", true);
    const res = await SELF.fetch("https://x/alerts");
    const body = (await res.json()) as { alerts: Array<{ kind: string }> };
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0].kind).toBe("feed_hold_extended");
  });

  it("?include_cleared=1 returns all", async () => {
    await seedAlert("haas-vf2-1", "feed_hold_extended");
    await seedAlert("haas-vf2-1", "idle_during_shift", true);
    const res = await SELF.fetch("https://x/alerts?include_cleared=1");
    const body = (await res.json()) as { alerts: unknown[] };
    expect(body.alerts).toHaveLength(2);
  });

  it("acknowledges an alert", async () => {
    await seedAlert("haas-vf2-1", "feed_hold_extended");
    const alertRow = await testEnv()
      .DB.prepare("SELECT id FROM alerts LIMIT 1")
      .first<{ id: number }>();
    const res = await SELF.fetch(`https://x/alerts/${alertRow!.id}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: "tyler" }),
    });
    expect(res.status).toBe(200);
    const after = await testEnv()
      .DB.prepare("SELECT acknowledged_by FROM alerts WHERE id = ?")
      .bind(alertRow!.id)
      .first<{ acknowledged_by: string }>();
    expect(after?.acknowledged_by).toBe("tyler");
  });
});
```

- [ ] **Step 2: Run → fails**

- [ ] **Step 3: Write `cloud/src/read/alerts.ts`**

```typescript
import { Hono } from "hono";
import type { Env } from "../types";

export const alertsRead = new Hono<{ Bindings: Env }>();

alertsRead.get("/", async (c) => {
  const includeCleared = c.req.query("include_cleared") === "1";
  const where = includeCleared ? "" : "WHERE cleared_at IS NULL";
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.machine_id, m.display_name AS machine_name, a.kind, a.triggered_at,
            a.cleared_at, a.severity, a.message, a.acknowledged_by, a.acknowledged_at
     FROM alerts a
     LEFT JOIN machines m ON m.id = a.machine_id
     ${where}
     ORDER BY a.triggered_at DESC
     LIMIT 200`,
  ).all();
  return c.json({ alerts: rows.results });
});

alertsRead.post("/:id/ack", async (c) => {
  const id = Number(c.req.param("id"));
  const { user } = (await c.req.json()) as { user?: string };
  if (!user) return c.json({ error: "user required" }, 400);

  const now = new Date().toISOString();
  const res = await c.env.DB.prepare(
    `UPDATE alerts
     SET acknowledged_by = ?, acknowledged_at = ?
     WHERE id = ? AND acknowledged_by IS NULL`,
  )
    .bind(user, now, id)
    .run();

  return c.json({ acknowledged: res.meta.changes > 0 });
});
```

- [ ] **Step 4: Wire**

```typescript
import { alertsRead } from "./read/alerts";
// ...
app.route("/alerts", alertsRead);
```

- [ ] **Step 5: Run + commit**

```bash
cd cloud && npm test -- read.alerts
git add cloud/src/read/alerts.ts cloud/src/index.ts cloud/test/read.alerts.test.ts
git commit -m "feat(cloud): GET /alerts + POST /alerts/:id/ack"
```

---

## Checkpoint 1 — Cloud ingest + read done

At this point the cloud worker has functional ingest (state, events, rollups) and read (machines, oee, alerts). The alert-generation cron and drill-down proxy remain; the edge side isn't built yet. Continue into Part 4 to add crons, then Part 5 for the edge collector.

The plan continues in `2026-04-18-mtconnect-phase-a-foundation-part2.md` (next document) with:

- Part 4: Alert scan cron + shift rollup cron
- Part 5: Drill-down proxy endpoint
- Part 6: Edge collector (Python) — scaffold, config
- Part 7: Edge collector — agent_client, state_machine, rollups, storage, uploader, drill_down, main
- Part 8: Edge infra — cppagent config, compose, Ansible base + service roles
- Part 9: MES integration — backend proxy, Machines tab, Alert panel
- Part 10: Live bring-up — enable MTConnect on Haas, register machine, end-to-end smoke test, runbooks
- Phase B/C/D at-a-glance (separate follow-on plans)

Splitting the plan into two files keeps each one under the editor's comfortable review length and each Part as a reviewable unit.
