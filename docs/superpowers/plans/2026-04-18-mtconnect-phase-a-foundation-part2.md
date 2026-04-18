# MTConnect Phase A — Foundation + First Haas Implementation Plan (Part 2)

> Continuation of `2026-04-18-mtconnect-phase-a-foundation.md`. Picks up after Checkpoint 1 (cloud ingest + read endpoints done). Same header conventions apply.

**Goal (recap):** one Haas machine live end-to-end. This part covers crons, drill-down proxy, the Python edge collector, edge infra (cppagent + compose + Ansible), MES integration, and live bring-up.

---

## Part 4 — Cloud crons (alert scan + shift rollup)

### Task 12: Alert rule engine (pure logic, TDD)

**Files:**
- Create: `cloud/src/alerts/rules.ts`
- Create: `cloud/test/alerts.rules.test.ts`

- [ ] **Step 1: Failing test `cloud/test/alerts.rules.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import {
  evaluateAlerts,
  type AlertInput,
  type CurrentState,
} from "../src/alerts/rules";

const baseInput = (over: Partial<AlertInput> = {}): AlertInput => ({
  now: "2026-04-18T14:30:00Z",
  inShift: true,
  machines: [],
  openAlerts: [],
  recentEvents: [],
  ...over,
});

const state = (over: Partial<CurrentState> = {}): CurrentState => ({
  machine_id: "haas-vf2-1",
  state: "ACTIVE",
  started_at: "2026-04-18T14:00:00Z",
  last_seen_at: "2026-04-18T14:30:00Z",
  ...over,
});

describe("alert rule engine", () => {
  it("fires feed_hold_extended after 10 min in FEED_HOLD during shift", () => {
    const input = baseInput({
      machines: [state({ state: "FEED_HOLD", started_at: "2026-04-18T14:19:00Z" })],
    });
    const result = evaluateAlerts(input);
    expect(result.toOpen).toHaveLength(1);
    expect(result.toOpen[0].kind).toBe("feed_hold_extended");
    expect(result.toOpen[0].severity).toBe("warning");
  });

  it("does NOT fire feed_hold_extended at 9 min", () => {
    const input = baseInput({
      machines: [state({ state: "FEED_HOLD", started_at: "2026-04-18T14:21:00Z" })],
    });
    expect(evaluateAlerts(input).toOpen).toHaveLength(0);
  });

  it("does NOT fire feed_hold_extended outside shift", () => {
    const input = baseInput({
      inShift: false,
      machines: [state({ state: "FEED_HOLD", started_at: "2026-04-18T14:19:00Z" })],
    });
    expect(evaluateAlerts(input).toOpen).toHaveLength(0);
  });

  it("fires idle_during_shift after 20 min STOPPED during shift with no active alarm", () => {
    const input = baseInput({
      machines: [state({ state: "STOPPED", started_at: "2026-04-18T14:09:00Z" })],
    });
    const out = evaluateAlerts(input).toOpen;
    expect(out.some((a) => a.kind === "idle_during_shift")).toBe(true);
  });

  it("suppresses idle_during_shift when an alarm is active", () => {
    const input = baseInput({
      machines: [state({ state: "STOPPED", started_at: "2026-04-18T14:09:00Z" })],
      recentEvents: [
        {
          machine_id: "haas-vf2-1",
          ts: "2026-04-18T14:10:00Z",
          kind: "alarm",
          severity: "fault",
          payload: { code: "1010" },
        },
      ],
    });
    const out = evaluateAlerts(input).toOpen;
    expect(out.some((a) => a.kind === "idle_during_shift")).toBe(false);
  });

  it("fires offline after 5 min of no data during shift", () => {
    const input = baseInput({
      machines: [state({ state: "OFFLINE", started_at: "2026-04-18T14:24:00Z" })],
    });
    const out = evaluateAlerts(input).toOpen;
    expect(out.some((a) => a.kind === "offline")).toBe(true);
    expect(out.find((a) => a.kind === "offline")?.severity).toBe("fault");
  });

  it("clears feed_hold_extended when state leaves FEED_HOLD", () => {
    const input = baseInput({
      machines: [state({ state: "ACTIVE" })],
      openAlerts: [
        {
          id: 99,
          machine_id: "haas-vf2-1",
          kind: "feed_hold_extended",
          triggered_at: "2026-04-18T14:15:00Z",
        },
      ],
    });
    const res = evaluateAlerts(input);
    expect(res.toClear).toEqual([99]);
  });

  it("does not duplicate an already-open alert", () => {
    const input = baseInput({
      machines: [state({ state: "FEED_HOLD", started_at: "2026-04-18T14:19:00Z" })],
      openAlerts: [
        {
          id: 7,
          machine_id: "haas-vf2-1",
          kind: "feed_hold_extended",
          triggered_at: "2026-04-18T14:29:00Z",
        },
      ],
    });
    expect(evaluateAlerts(input).toOpen).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run → fails.**

Run: `cd cloud && npm test -- alerts.rules`
Expected: FAIL (no rules.ts).

- [ ] **Step 3: Write `cloud/src/alerts/rules.ts`**

```typescript
import type { AlertKind, ExecutionState, Severity } from "../types";

export type CurrentState = {
  machine_id: string;
  state: ExecutionState;
  started_at: string;
  last_seen_at: string;
  program?: string | null;
};

export type OpenAlert = {
  id: number;
  machine_id: string;
  kind: AlertKind;
  triggered_at: string;
};

export type EventRow = {
  machine_id: string;
  ts: string;
  kind: string;
  severity: Severity;
  payload?: Record<string, unknown>;
};

export type AlertInput = {
  now: string;
  inShift: boolean;
  machines: CurrentState[];
  openAlerts: OpenAlert[];
  recentEvents: EventRow[];
};

export type AlertDraft = {
  machine_id: string;
  kind: AlertKind;
  severity: Severity;
  triggered_at: string;
  message: string;
};

export type AlertEvalResult = {
  toOpen: AlertDraft[];
  toClear: number[];
};

const THRESHOLDS = {
  feed_hold_extended_secs: 10 * 60,
  idle_during_shift_secs: 20 * 60,
  offline_secs: 5 * 60,
  alarm_sustained_secs: 2 * 60,
} as const;

export function evaluateAlerts(input: AlertInput): AlertEvalResult {
  const toOpen: AlertDraft[] = [];
  const toClear: number[] = [];
  const now = Date.parse(input.now);

  for (const m of input.machines) {
    const openByKind = new Map<AlertKind, OpenAlert>();
    for (const a of input.openAlerts.filter((a) => a.machine_id === m.machine_id)) {
      openByKind.set(a.kind, a);
    }
    const durationSec = Math.max(0, (now - Date.parse(m.started_at)) / 1000);
    const machineEvents = input.recentEvents.filter((e) => e.machine_id === m.machine_id);
    const hasActiveAlarm = machineEvents.some(
      (e) => e.kind === "alarm" && e.severity === "fault",
    );

    const fire = (
      kind: AlertKind,
      severity: Severity,
      message: string,
    ): void => {
      if (!openByKind.has(kind)) {
        toOpen.push({
          machine_id: m.machine_id,
          kind,
          severity,
          triggered_at: input.now,
          message,
        });
      }
    };

    const clear = (kind: AlertKind): void => {
      const existing = openByKind.get(kind);
      if (existing) toClear.push(existing.id);
    };

    if (input.inShift && m.state === "FEED_HOLD" && durationSec >= THRESHOLDS.feed_hold_extended_secs) {
      fire("feed_hold_extended", "warning", `Feed hold for ${Math.round(durationSec / 60)} min`);
    } else {
      clear("feed_hold_extended");
    }

    if (
      input.inShift &&
      m.state === "STOPPED" &&
      durationSec >= THRESHOLDS.idle_during_shift_secs &&
      !hasActiveAlarm
    ) {
      fire("idle_during_shift", "warning", `Idle for ${Math.round(durationSec / 60)} min during shift`);
    } else {
      clear("idle_during_shift");
    }

    if (input.inShift && m.state === "OFFLINE" && durationSec >= THRESHOLDS.offline_secs) {
      fire("offline", "fault", `No data from agent for ${Math.round(durationSec / 60)} min`);
    } else {
      clear("offline");
    }

    if (hasActiveAlarm) {
      const alarmDurationSec = machineEvents
        .filter((e) => e.kind === "alarm" && e.severity === "fault")
        .map((e) => (now - Date.parse(e.ts)) / 1000)
        .reduce((a, b) => Math.max(a, b), 0);
      if (alarmDurationSec >= THRESHOLDS.alarm_sustained_secs) {
        fire("alarm_sustained", "fault", "Alarm sustained > 2 min");
      }
    } else {
      clear("alarm_sustained");
    }

    const estop = machineEvents.find((e) => e.kind === "estop");
    if (estop && (estop.payload as { value?: string })?.value === "TRIGGERED") {
      fire("estop_triggered", "fault", "E-stop triggered");
    } else {
      clear("estop_triggered");
    }
  }

  return { toOpen, toClear };
}
```

- [ ] **Step 4: Run → passes.**

Run: `cd cloud && npm test -- alerts.rules`
Expected: 7 passing.

- [ ] **Step 5: Commit.**

```bash
git add cloud/src/alerts/rules.ts cloud/test/alerts.rules.test.ts
git commit -m "feat(cloud): alert rule engine with 6 Phase 1 rules (pure logic)"
```

### Task 13: Alert scan cron handler

**Files:**
- Create: `cloud/src/cron/alert_scan.ts`
- Create: `cloud/test/cron.alert_scan.test.ts`
- Modify: `cloud/src/index.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { resetDb, seedMachine, testEnv } from "./helpers";
import { runAlertScan } from "../src/cron/alert_scan";

describe("alert scan cron", () => {
  beforeEach(async () => {
    await resetDb();
    await seedMachine("haas-vf2-1");
  });

  it("opens a feed_hold_extended alert when machine has been in FEED_HOLD > 10 min during shift", async () => {
    const e = testEnv();
    const triggeredAt = "2026-04-18T14:19:00Z";
    await e.DB.prepare(
      `INSERT INTO state_intervals (machine_id, state, started_at, ended_at, duration_seconds)
       VALUES ('haas-vf2-1', 'FEED_HOLD', ?, ?, 600)`,
    )
      .bind(triggeredAt, "2026-04-18T14:29:59Z")
      .run();

    await runAlertScan(e, new Date("2026-04-18T14:30:00Z"));

    const alert = await e.DB.prepare(
      "SELECT kind, cleared_at FROM alerts WHERE machine_id = 'haas-vf2-1'",
    ).first<{ kind: string; cleared_at: string | null }>();
    expect(alert?.kind).toBe("feed_hold_extended");
    expect(alert?.cleared_at).toBeNull();
  });

  it("clears an open alert when condition no longer holds", async () => {
    const e = testEnv();
    await e.DB.prepare(
      `INSERT INTO alerts (machine_id, kind, triggered_at, severity, message)
       VALUES ('haas-vf2-1', 'feed_hold_extended', '2026-04-18T14:19:00Z', 'warning', 'test')`,
    ).run();
    await e.DB.prepare(
      `INSERT INTO state_intervals (machine_id, state, started_at, ended_at, duration_seconds)
       VALUES ('haas-vf2-1', 'ACTIVE', '2026-04-18T14:25:00Z', '2026-04-18T14:30:00Z', 300)`,
    ).run();

    await runAlertScan(e, new Date("2026-04-18T14:30:00Z"));

    const row = await e.DB.prepare(
      "SELECT cleared_at FROM alerts WHERE machine_id = 'haas-vf2-1'",
    ).first<{ cleared_at: string | null }>();
    expect(row?.cleared_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Write `cloud/src/cron/alert_scan.ts`**

```typescript
import type { Env } from "../types";
import { evaluateAlerts, type CurrentState, type OpenAlert, type EventRow } from "../alerts/rules";

function inShift(at: Date): boolean {
  const utcHour = at.getUTCHours();
  const dow = at.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return utcHour >= 13 && utcHour < 22;
}

export async function runAlertScan(env: Env, now: Date = new Date()): Promise<void> {
  const nowIso = now.toISOString();
  const machinesRes = await env.DB.prepare(
    `SELECT m.id AS machine_id,
       (SELECT state FROM state_intervals si WHERE si.machine_id = m.id
          ORDER BY started_at DESC LIMIT 1) AS state,
       (SELECT started_at FROM state_intervals si WHERE si.machine_id = m.id
          ORDER BY started_at DESC LIMIT 1) AS started_at,
       (SELECT ended_at FROM state_intervals si WHERE si.machine_id = m.id
          ORDER BY started_at DESC LIMIT 1) AS last_seen_at
     FROM machines m WHERE m.enabled = 1`,
  ).all<CurrentState>();

  const machines: CurrentState[] = machinesRes.results
    .filter((m) => m.state !== null && m.started_at !== null)
    .map((m) => ({
      machine_id: m.machine_id,
      state: m.state,
      started_at: m.started_at,
      last_seen_at: m.last_seen_at ?? m.started_at,
    }));

  const openAlertsRes = await env.DB.prepare(
    `SELECT id, machine_id, kind, triggered_at FROM alerts WHERE cleared_at IS NULL`,
  ).all<OpenAlert>();

  const cutoff = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const eventsRes = await env.DB.prepare(
    `SELECT machine_id, ts, kind, severity, payload FROM events WHERE ts >= ?`,
  )
    .bind(cutoff)
    .all<{
      machine_id: string;
      ts: string;
      kind: string;
      severity: "info" | "warning" | "fault";
      payload: string | null;
    }>();

  const recentEvents: EventRow[] = eventsRes.results.map((r) => ({
    machine_id: r.machine_id,
    ts: r.ts,
    kind: r.kind,
    severity: r.severity,
    payload: r.payload ? JSON.parse(r.payload) : undefined,
  }));

  const { toOpen, toClear } = evaluateAlerts({
    now: nowIso,
    inShift: inShift(now),
    machines,
    openAlerts: openAlertsRes.results,
    recentEvents,
  });

  const stmts: D1PreparedStatement[] = [];
  for (const a of toOpen) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO alerts (machine_id, kind, triggered_at, severity, message)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(a.machine_id, a.kind, a.triggered_at, a.severity, a.message),
    );
  }
  for (const id of toClear) {
    stmts.push(env.DB.prepare(`UPDATE alerts SET cleared_at = ? WHERE id = ?`).bind(nowIso, id));
  }
  if (stmts.length > 0) await env.DB.batch(stmts);
}
```

- [ ] **Step 4: Wire into scheduled handler**

Modify `cloud/src/index.ts`:

```typescript
import { runAlertScan } from "./cron/alert_scan";
// ...
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (event.cron === "*/1 * * * *") {
      ctx.waitUntil(runAlertScan(env, new Date(event.scheduledTime)));
    }
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 5: Run → passes.**

```bash
cd cloud && npm test -- cron.alert_scan
```
Expected: 2 passing.

- [ ] **Step 6: Commit.**

```bash
git add cloud/src/cron/alert_scan.ts cloud/src/index.ts cloud/test/cron.alert_scan.test.ts
git commit -m "feat(cloud): alert scan cron (1-min tick, wired from scheduled handler)"
```

### Task 14: Shift rollup cron

**Files:**
- Create: `cloud/src/cron/shift_rollup.ts`
- Create: `cloud/test/cron.shift_rollup.test.ts`
- Modify: `cloud/src/index.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedMachine, testEnv } from "./helpers";
import { runShiftRollup } from "../src/cron/shift_rollup";

describe("shift rollup cron", () => {
  beforeEach(async () => {
    await resetDb();
    await seedMachine("haas-vf2-1");
  });

  it("computes one shift rollup row per machine for the day", async () => {
    const e = testEnv();
    const stmts = [];
    for (let h = 13; h < 22; h++) {
      for (let m = 0; m < 60; m++) {
        const bucket = `2026-04-17T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
        stmts.push(
          e.DB.prepare(
            `INSERT INTO rollups_minute
              (machine_id, minute_bucket, active_seconds, feed_hold_seconds, stopped_seconds,
               interrupted_seconds, offline_seconds, part_count_delta)
             VALUES (?, ?, ?, ?, ?, 0, 0, 0)`,
          ).bind("haas-vf2-1", bucket, 45, 5, 10),
        );
      }
    }
    await e.DB.batch(stmts);

    await runShiftRollup(e, new Date("2026-04-18T07:05:00Z"));

    const row = await e.DB.prepare(
      `SELECT active_seconds, feed_hold_seconds, availability, utilization
       FROM rollups_shift WHERE machine_id = 'haas-vf2-1' AND shift_date = '2026-04-17'`,
    ).first<{ active_seconds: number; feed_hold_seconds: number; availability: number; utilization: number }>();

    expect(row).not.toBeNull();
    expect(row!.active_seconds).toBe(45 * 60 * 9);
    expect(row!.feed_hold_seconds).toBe(5 * 60 * 9);
    expect(row!.availability).toBeGreaterThan(0);
    expect(row!.utilization).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Write `cloud/src/cron/shift_rollup.ts`**

```typescript
import type { Env } from "../types";

export async function runShiftRollup(env: Env, now: Date = new Date()): Promise<void> {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const shiftDate = yesterday.toISOString().slice(0, 10);

  const machines = await env.DB.prepare(
    `SELECT id FROM machines WHERE enabled = 1`,
  ).all<{ id: string }>();

  const stmts: D1PreparedStatement[] = [];
  const scheduled = 8 * 3600;

  for (const m of machines.results) {
    const sum = await env.DB.prepare(
      `SELECT
         COALESCE(SUM(active_seconds), 0) AS active_seconds,
         COALESCE(SUM(feed_hold_seconds), 0) AS feed_hold_seconds,
         COALESCE(SUM(stopped_seconds), 0) AS stopped_seconds,
         COALESCE(SUM(offline_seconds), 0) AS offline_seconds,
         COALESCE(SUM(part_count_delta), 0) AS part_count
       FROM rollups_minute
       WHERE machine_id = ?
         AND minute_bucket >= ?
         AND minute_bucket < ?`,
    )
      .bind(m.id, `${shiftDate}T13:00:00Z`, `${shiftDate}T22:00:00Z`)
      .first<{
        active_seconds: number;
        feed_hold_seconds: number;
        stopped_seconds: number;
        offline_seconds: number;
        part_count: number;
      }>();

    const active = sum?.active_seconds ?? 0;
    const feedHold = sum?.feed_hold_seconds ?? 0;
    const stopped = sum?.stopped_seconds ?? 0;
    const offline = sum?.offline_seconds ?? 0;
    const availability = (active + feedHold) / scheduled;
    const utilization = active / scheduled;

    const alarmCount = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM events
       WHERE machine_id = ? AND kind = 'alarm' AND ts >= ? AND ts < ?`,
    )
      .bind(m.id, `${shiftDate}T13:00:00Z`, `${shiftDate}T22:00:00Z`)
      .first<{ c: number }>();

    stmts.push(
      env.DB.prepare(
        `INSERT INTO rollups_shift
           (machine_id, shift_date, shift_name, scheduled_seconds, active_seconds,
            feed_hold_seconds, stopped_seconds, offline_seconds, availability, utilization,
            part_count, alarm_count)
         VALUES (?, ?, 'day', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(machine_id, shift_date) DO UPDATE SET
           active_seconds = excluded.active_seconds,
           feed_hold_seconds = excluded.feed_hold_seconds,
           stopped_seconds = excluded.stopped_seconds,
           offline_seconds = excluded.offline_seconds,
           availability = excluded.availability,
           utilization = excluded.utilization,
           part_count = excluded.part_count,
           alarm_count = excluded.alarm_count`,
      ).bind(
        m.id,
        shiftDate,
        scheduled,
        active,
        feedHold,
        stopped,
        offline,
        availability,
        utilization,
        sum?.part_count ?? 0,
        alarmCount?.c ?? 0,
      ),
    );
  }

  if (stmts.length > 0) await env.DB.batch(stmts);
}
```

- [ ] **Step 4: Wire cron + run.**

Modify `cloud/src/index.ts`:

```typescript
import { runShiftRollup } from "./cron/shift_rollup";
// ...
async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  if (event.cron === "*/1 * * * *") {
    ctx.waitUntil(runAlertScan(env, new Date(event.scheduledTime)));
  } else if (event.cron === "5 7 * * *") {
    ctx.waitUntil(runShiftRollup(env, new Date(event.scheduledTime)));
  }
},
```

- [ ] **Step 5: Run → passes.**

```bash
cd cloud && npm test -- cron.shift_rollup
```

- [ ] **Step 6: Commit.**

```bash
git add cloud/src/cron/shift_rollup.ts cloud/src/index.ts cloud/test/cron.shift_rollup.test.ts
git commit -m "feat(cloud): nightly shift rollup cron (OEE availability + utilization)"
```

---

## Part 5 — Drill-down proxy

### Task 15: `/proxy/edge/samples` endpoint

The drill-down tunnels a user's request through Cloudflare Tunnel to the edge box's local HTTP server (implemented later as the edge collector's `drill_down.py`). For Phase A we only handle the sample-window query.

**Files:**
- Create: `cloud/src/proxy/drill_down.ts`
- Create: `cloud/test/proxy.drill_down.test.ts`
- Modify: `cloud/src/index.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SELF, env } from "cloudflare:test";
import { resetDb, seedMachine } from "./helpers";

describe("GET /proxy/edge/:id/samples", () => {
  beforeEach(async () => {
    await resetDb();
    await seedMachine("haas-vf2-1");
    (env as unknown as { EDGE_TUNNEL_HOSTNAME: string }).EDGE_TUNNEL_HOSTNAME =
      "edge.example.internal";
    (env as unknown as { EDGE_SHARED_SECRET: string }).EDGE_SHARED_SECRET = "test-secret";
  });

  it("returns 404 for unknown machine", async () => {
    const res = await SELF.fetch("https://x/proxy/edge/ghost/samples?from=a&to=b");
    expect(res.status).toBe(404);
  });

  it("returns 400 if from/to missing", async () => {
    const res = await SELF.fetch("https://x/proxy/edge/haas-vf2-1/samples");
    expect(res.status).toBe(400);
  });

  it("forwards to edge tunnel hostname with auth header", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ samples: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const res = await SELF.fetch(
      "https://x/proxy/edge/haas-vf2-1/samples?from=2026-04-18T14:00:00Z&to=2026-04-18T14:30:00Z&signals=rpm",
    );
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalled();
    const calledUrl = (mockFetch.mock.calls[0][0] as Request).url;
    expect(calledUrl).toContain("edge.example.internal");
    expect(calledUrl).toContain("haas-vf2-1");
    const calledHeaders = (mockFetch.mock.calls[0][0] as Request).headers;
    expect(calledHeaders.get("X-Edge-Secret")).toBe("test-secret");
  });
});
```

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Write `cloud/src/proxy/drill_down.ts`**

```typescript
import { Hono } from "hono";
import type { Env } from "../types";
import { machineExists } from "../db";

export const drillDownProxy = new Hono<{ Bindings: Env }>();

drillDownProxy.get("/:id/samples", async (c) => {
  const id = c.req.param("id");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const signals = c.req.query("signals") ?? "rpm,load,feedrate";

  if (!from || !to) return c.json({ error: "from and to required" }, 400);
  if (!(await machineExists(c.env, id))) return c.json({ error: "not found" }, 404);

  const edgeUrl = `https://${c.env.EDGE_TUNNEL_HOSTNAME}/samples?machine_id=${encodeURIComponent(id)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&signals=${encodeURIComponent(signals)}`;
  const upstream = await fetch(
    new Request(edgeUrl, {
      method: "GET",
      headers: { "X-Edge-Secret": c.env.EDGE_SHARED_SECRET },
    }),
  );
  if (!upstream.ok) return c.json({ error: "edge unreachable" }, 502);
  const body = await upstream.text();
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
```

- [ ] **Step 4: Wire**

```typescript
import { drillDownProxy } from "./proxy/drill_down";
// ...
app.route("/proxy/edge", drillDownProxy);
```

- [ ] **Step 5: Run → passes.**

```bash
cd cloud && npm test -- proxy.drill_down
```

- [ ] **Step 6: Commit.**

```bash
git add cloud/src/proxy/drill_down.ts cloud/src/index.ts cloud/test/proxy.drill_down.test.ts
git commit -m "feat(cloud): drill-down proxy forwarding to edge via CF Tunnel"
```

**Checkpoint 2 — Cloud side is functionally complete.** Ingest, read, crons, drill-down. Next: build the edge collector that produces the data.

---

## Part 6 — Edge collector (Python) scaffold

### Task 16: Python project scaffold

**Files:**
- Create: `edge/collector/pyproject.toml`
- Create: `edge/collector/src/collector/__init__.py`
- Create: `edge/collector/tests/conftest.py`
- Create: `edge/collector/tests/fixtures/sample_streams/.gitkeep`
- Create: `edge/collector/README.md`

- [ ] **Step 1: `pyproject.toml`**

```toml
[project]
name = "mtconnect-collector"
version = "0.1.0"
description = "Edge-side MTConnect collector for FFMFG open-source monitoring stack"
requires-python = ">=3.12"
dependencies = [
  "httpx>=0.27",
  "aiosqlite>=0.20",
  "aiohttp>=3.10",
  "pydantic>=2.8",
  "tomli>=2.0; python_version<'3.11'",
]

[project.optional-dependencies]
dev = [
  "pytest>=8.3",
  "pytest-asyncio>=0.24",
  "pytest-httpx>=0.32",
  "ruff>=0.6",
  "mypy>=1.11",
]

[project.scripts]
mtconnect-collector = "collector.__main__:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/collector"]

[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"
addopts = "-ra --strict-markers"

[tool.ruff]
line-length = 100
target-version = "py312"
[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B", "ASYNC"]

[tool.mypy]
python_version = "3.12"
strict = true
```

- [ ] **Step 2: `src/collector/__init__.py`**

```python
"""Edge-side MTConnect collector.

Tails cppagent's /sample stream, computes closed state intervals + 1-minute
rollups, writes a local SQLite rolling buffer, pushes summaries to the cloud.
"""

__version__ = "0.1.0"
```

- [ ] **Step 3: `tests/conftest.py`**

```python
from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture
def fixtures_dir() -> Path:
    return Path(__file__).parent / "fixtures"
```

- [ ] **Step 4: `tests/fixtures/sample_streams/.gitkeep`**

Empty file. Reserved for canned cppagent `/sample` XML responses added in Task 18.

- [ ] **Step 5: `edge/collector/README.md`**

```markdown
# collector

Edge-side Python service. Tails cppagent, normalizes, pushes summaries to the
cloud, serves drill-down requests locally.

## Run locally

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
pytest
python -m collector --config config.toml
```

## Against a simulated agent

The `mtconnect/cppagent` container ships a simulator. See
`../cppagent/agent.cfg` for a minimal config that replays a sample stream
with no real machine.

## Architecture

Entry point `collector.__main__` wires:

- `agent_client` — tails cppagent `/sample` long-poll stream.
- `state_machine` — emits closed state intervals from the event stream.
- `rollups` — emits 1-minute rollups from samples + state.
- `storage` — local SQLite buffer with 30-day TTL for raw samples and intervals.
- `uploader` — pushes state intervals, events, and rollups to the cloud.
- `drill_down` — aiohttp server on localhost for cloud-originated drill-down queries.
```

- [ ] **Step 6: Install + pytest.**

```bash
cd edge/collector
python -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
pytest
```
Expected: no tests collected (0 passed).

- [ ] **Step 7: Commit.**

```bash
git add edge/collector/
git commit -m "feat(edge): scaffold Python collector package (pyproject, pytest)"
```

### Task 17: Config module

**Files:**
- Create: `edge/collector/src/collector/config.py`
- Create: `edge/collector/tests/test_config.py`
- Create: `edge/collector/config.example.toml`

- [ ] **Step 1: Failing test**

```python
from __future__ import annotations

from pathlib import Path

import pytest

from collector.config import Config, MachineConfig, load_config


def test_load_minimal(tmp_path: Path) -> None:
    cfg = tmp_path / "c.toml"
    cfg.write_text(
        """
[agent]
base_url = "http://localhost:5000"

[cloud]
base_url = "https://mtconnect-collector.example.workers.dev"
shared_secret_env = "EDGE_SHARED_SECRET"

[storage]
sqlite_path = "/var/lib/collector/buffer.db"
retention_days = 30

[drill_down]
listen_host = "127.0.0.1"
listen_port = 8989

[[machine]]
id = "haas-vf2-1"
agent_device = "HaasVf2_1"
""",
        encoding="utf-8",
    )
    config = load_config(cfg)
    assert isinstance(config, Config)
    assert config.agent.base_url == "http://localhost:5000"
    assert config.storage.retention_days == 30
    assert config.machines == [MachineConfig(id="haas-vf2-1", agent_device="HaasVf2_1")]


def test_missing_file(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        load_config(tmp_path / "nope.toml")
```

- [ ] **Step 2: Run → fails.**

Run: `cd edge/collector && pytest tests/test_config.py`
Expected: ImportError.

- [ ] **Step 3: Write `src/collector/config.py`**

```python
from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class AgentConfig:
    base_url: str


@dataclass(frozen=True)
class CloudConfig:
    base_url: str
    shared_secret_env: str


@dataclass(frozen=True)
class StorageConfig:
    sqlite_path: str
    retention_days: int


@dataclass(frozen=True)
class DrillDownConfig:
    listen_host: str
    listen_port: int


@dataclass(frozen=True)
class MachineConfig:
    id: str
    agent_device: str


@dataclass(frozen=True)
class Config:
    agent: AgentConfig
    cloud: CloudConfig
    storage: StorageConfig
    drill_down: DrillDownConfig
    machines: list[MachineConfig]


def load_config(path: Path) -> Config:
    if not path.exists():
        raise FileNotFoundError(path)
    raw = tomllib.loads(path.read_text(encoding="utf-8"))
    return Config(
        agent=AgentConfig(**raw["agent"]),
        cloud=CloudConfig(**raw["cloud"]),
        storage=StorageConfig(**raw["storage"]),
        drill_down=DrillDownConfig(**raw["drill_down"]),
        machines=[MachineConfig(**m) for m in raw.get("machine", [])],
    )
```

- [ ] **Step 4: `config.example.toml`**

```toml
[agent]
base_url = "http://localhost:5000"

[cloud]
base_url = "https://mtconnect-collector.example.workers.dev"
shared_secret_env = "EDGE_SHARED_SECRET"

[storage]
sqlite_path = "/var/lib/collector/buffer.db"
retention_days = 30

[drill_down]
listen_host = "127.0.0.1"
listen_port = 8989

[[machine]]
id = "haas-vf2-1"
agent_device = "HaasVf2_1"
```

- [ ] **Step 5: Run → passes.**

```bash
cd edge/collector && pytest tests/test_config.py
```
Expected: 2 passing.

- [ ] **Step 6: Commit.**

```bash
git add edge/collector/
git commit -m "feat(edge): collector config module (TOML, typed dataclasses)"
```

---

## Part 7 — Edge collector components

### Task 18: Agent client (tails cppagent /sample)

**Files:**
- Create: `edge/collector/src/collector/agent_client.py`
- Create: `edge/collector/tests/test_agent_client.py`
- Create: `edge/collector/tests/fixtures/sample_streams/haas_active_to_feedhold.xml`

- [ ] **Step 1: Create the fixture file `tests/fixtures/sample_streams/haas_active_to_feedhold.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MTConnectStreams
    xmlns="urn:mtconnect.org:MTConnectStreams:2.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="urn:mtconnect.org:MTConnectStreams:2.0 http://www.mtconnect.org/schemas/MTConnectStreams_2.0.xsd">
  <Header creationTime="2026-04-18T14:00:00Z" sender="cppagent" instanceId="1" version="2.2" bufferSize="131072" nextSequence="100" firstSequence="1" lastSequence="99"/>
  <Streams>
    <DeviceStream name="HaasVf2_1" uuid="haas-vf2-1">
      <ComponentStream component="Controller" name="controller" componentId="c1">
        <Events>
          <Execution dataItemId="exec" sequence="10" timestamp="2026-04-18T14:00:00Z">ACTIVE</Execution>
          <Execution dataItemId="exec" sequence="25" timestamp="2026-04-18T14:05:00Z">FEED_HOLD</Execution>
          <Program dataItemId="prog" sequence="11" timestamp="2026-04-18T14:00:01Z">O1001</Program>
          <ToolAssetId dataItemId="tool" sequence="12" timestamp="2026-04-18T14:00:02Z">3</ToolAssetId>
        </Events>
        <Samples>
          <SpindleSpeed dataItemId="s" sequence="20" timestamp="2026-04-18T14:01:00Z">8200</SpindleSpeed>
          <PathFeedrate dataItemId="f" sequence="21" timestamp="2026-04-18T14:01:00Z">118</PathFeedrate>
        </Samples>
      </ComponentStream>
    </DeviceStream>
  </Streams>
</MTConnectStreams>
```

- [ ] **Step 2: Failing test `tests/test_agent_client.py`**

```python
from __future__ import annotations

from pathlib import Path

import pytest

from collector.agent_client import Event, Sample, parse_sample_response


@pytest.mark.asyncio
async def test_parse_events_and_samples(fixtures_dir: Path) -> None:
    xml = (fixtures_dir / "sample_streams" / "haas_active_to_feedhold.xml").read_text(
        encoding="utf-8"
    )
    result = parse_sample_response(xml, device_uuid_to_machine_id={"haas-vf2-1": "haas-vf2-1"})
    events = [r for r in result if isinstance(r, Event)]
    samples = [r for r in result if isinstance(r, Sample)]
    exec_events = [e for e in events if e.data_item == "Execution"]
    assert [e.value for e in exec_events] == ["ACTIVE", "FEED_HOLD"]
    assert any(e.data_item == "Program" and e.value == "O1001" for e in events)
    rpm = [s for s in samples if s.data_item == "SpindleSpeed"]
    assert rpm[0].value == pytest.approx(8200.0)


@pytest.mark.asyncio
async def test_parse_skips_unknown_device(fixtures_dir: Path) -> None:
    xml = (fixtures_dir / "sample_streams" / "haas_active_to_feedhold.xml").read_text(
        encoding="utf-8"
    )
    result = parse_sample_response(xml, device_uuid_to_machine_id={})
    assert result == []
```

- [ ] **Step 3: Write `src/collector/agent_client.py`**

```python
from __future__ import annotations

import xml.etree.ElementTree as ET
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from typing import Literal

import httpx

NS = {"mtc": "urn:mtconnect.org:MTConnectStreams:2.0"}


@dataclass(frozen=True)
class Event:
    machine_id: str
    data_item: str
    value: str
    timestamp: str
    sequence: int


@dataclass(frozen=True)
class Sample:
    machine_id: str
    data_item: str
    value: float
    timestamp: str
    sequence: int


Record = Event | Sample


def parse_sample_response(
    xml_text: str,
    device_uuid_to_machine_id: Mapping[str, str],
) -> list[Record]:
    root = ET.fromstring(xml_text)
    out: list[Record] = []
    for device in root.findall(".//mtc:DeviceStream", NS):
        uuid = device.attrib.get("uuid", "")
        machine_id = device_uuid_to_machine_id.get(uuid)
        if machine_id is None:
            continue
        for events in device.findall(".//mtc:Events", NS):
            for el in events:
                tag = _local(el.tag)
                if el.text is None:
                    continue
                out.append(
                    Event(
                        machine_id=machine_id,
                        data_item=tag,
                        value=el.text.strip(),
                        timestamp=el.attrib.get("timestamp", ""),
                        sequence=int(el.attrib.get("sequence", "0")),
                    )
                )
        for samples in device.findall(".//mtc:Samples", NS):
            for el in samples:
                tag = _local(el.tag)
                if el.text is None:
                    continue
                try:
                    v = float(el.text.strip())
                except ValueError:
                    continue
                out.append(
                    Sample(
                        machine_id=machine_id,
                        data_item=tag,
                        value=v,
                        timestamp=el.attrib.get("timestamp", ""),
                        sequence=int(el.attrib.get("sequence", "0")),
                    )
                )
    return out


def _local(tag: str) -> str:
    if "}" in tag:
        return tag.split("}", 1)[1]
    return tag


Mode = Literal["stream", "poll"]


class AgentClient:
    def __init__(
        self,
        base_url: str,
        device_uuid_to_machine_id: Mapping[str, str],
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._map = dict(device_uuid_to_machine_id)
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(60.0))
        self._from: int | None = None

    async def poll_once(self, count: int = 500) -> list[Record]:
        params: dict[str, str | int] = {"count": count}
        if self._from is not None:
            params["from"] = self._from
        r = await self._client.get(f"{self._base}/sample", params=params)
        r.raise_for_status()
        records = parse_sample_response(r.text, self._map)
        if records:
            self._from = max(r.sequence for r in records) + 1
        return records

    async def stream(self, interval_ms: int = 1000, count: int = 100) -> AsyncIterator[Record]:
        params = {"interval": interval_ms, "count": count, "heartbeat": 10000}
        if self._from is None:
            async with self._client.stream("GET", f"{self._base}/current") as r:
                async for chunk in r.aiter_text():
                    records = parse_sample_response(chunk, self._map)
                    for rec in records:
                        yield rec
                    if records:
                        self._from = max(r.sequence for r in records) + 1
                    break
        while True:
            params["from"] = self._from or 0
            async with self._client.stream("GET", f"{self._base}/sample", params=params) as r:
                async for chunk in r.aiter_text():
                    records = parse_sample_response(chunk, self._map)
                    for rec in records:
                        yield rec
                    if records:
                        self._from = max(rec.sequence for rec in records) + 1

    async def aclose(self) -> None:
        await self._client.aclose()
```

- [ ] **Step 4: Run → passes.**

```bash
cd edge/collector && pytest tests/test_agent_client.py
```
Expected: 2 passing.

- [ ] **Step 5: Commit.**

```bash
git add edge/collector/
git commit -m "feat(edge): agent client + XML parser for cppagent /sample"
```

### Task 19: State machine (closed intervals)

**Files:**
- Create: `edge/collector/src/collector/state_machine.py`
- Create: `edge/collector/tests/test_state_machine.py`

- [ ] **Step 1: Failing test**

```python
from __future__ import annotations

from collector.agent_client import Event
from collector.state_machine import StateInterval, StateMachine


def ex(machine_id: str, value: str, ts: str, seq: int) -> Event:
    return Event(
        machine_id=machine_id,
        data_item="Execution",
        value=value,
        timestamp=ts,
        sequence=seq,
    )


def test_closes_interval_on_state_change() -> None:
    sm = StateMachine()
    closed = list(sm.ingest(ex("m1", "ACTIVE", "2026-04-18T14:00:00Z", 1)))
    assert closed == []
    closed = list(sm.ingest(ex("m1", "FEED_HOLD", "2026-04-18T14:05:00Z", 2)))
    assert len(closed) == 1
    interval = closed[0]
    assert isinstance(interval, StateInterval)
    assert interval.machine_id == "m1"
    assert interval.state == "ACTIVE"
    assert interval.duration_seconds == 300


def test_maps_unknown_value_to_stopped() -> None:
    sm = StateMachine()
    list(sm.ingest(ex("m1", "READY", "2026-04-18T14:00:00Z", 1)))
    closed = list(sm.ingest(ex("m1", "ACTIVE", "2026-04-18T14:01:00Z", 2)))
    assert closed[0].state == "STOPPED"


def test_ignores_repeated_same_state() -> None:
    sm = StateMachine()
    list(sm.ingest(ex("m1", "ACTIVE", "2026-04-18T14:00:00Z", 1)))
    closed = list(sm.ingest(ex("m1", "ACTIVE", "2026-04-18T14:02:00Z", 2)))
    assert closed == []


def test_tracks_multiple_machines_independently() -> None:
    sm = StateMachine()
    list(sm.ingest(ex("m1", "ACTIVE", "2026-04-18T14:00:00Z", 1)))
    list(sm.ingest(ex("m2", "ACTIVE", "2026-04-18T14:00:00Z", 2)))
    closed = list(sm.ingest(ex("m1", "STOPPED", "2026-04-18T14:10:00Z", 3)))
    assert len(closed) == 1
    assert closed[0].machine_id == "m1"
```

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Write `src/collector/state_machine.py`**

```python
from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from collector.agent_client import Event, Sample

ExecState = Literal["ACTIVE", "FEED_HOLD", "STOPPED", "INTERRUPTED", "OFFLINE"]


@dataclass(frozen=True)
class StateInterval:
    machine_id: str
    state: ExecState
    started_at: str
    ended_at: str
    duration_seconds: int
    program: str | None = None
    tool_number: int | None = None


def _map_execution(value: str) -> ExecState:
    v = value.upper()
    if v == "ACTIVE":
        return "ACTIVE"
    if v == "FEED_HOLD":
        return "FEED_HOLD"
    if v in ("INTERRUPTED",):
        return "INTERRUPTED"
    if v == "UNAVAILABLE":
        return "OFFLINE"
    return "STOPPED"


@dataclass
class _Open:
    state: ExecState
    started_at: str
    program: str | None = None
    tool_number: int | None = None


class StateMachine:
    def __init__(self) -> None:
        self._open: dict[str, _Open] = {}
        self._program: dict[str, str | None] = {}
        self._tool: dict[str, int | None] = {}

    def ingest(self, record: Event | Sample) -> Iterable[StateInterval]:
        if isinstance(record, Sample):
            return ()
        if record.data_item == "Program":
            self._program[record.machine_id] = record.value or None
            return ()
        if record.data_item in ("ToolAssetId", "ToolNumber"):
            try:
                self._tool[record.machine_id] = int(record.value)
            except (TypeError, ValueError):
                self._tool[record.machine_id] = None
            return ()
        if record.data_item != "Execution":
            return ()
        return self._on_execution(record)

    def _on_execution(self, ev: Event) -> Iterator[StateInterval]:
        state = _map_execution(ev.value)
        current = self._open.get(ev.machine_id)
        if current is None:
            self._open[ev.machine_id] = _Open(
                state=state,
                started_at=ev.timestamp,
                program=self._program.get(ev.machine_id),
                tool_number=self._tool.get(ev.machine_id),
            )
            return
        if current.state == state:
            return
        duration = _secs(current.started_at, ev.timestamp)
        if duration >= 0:
            yield StateInterval(
                machine_id=ev.machine_id,
                state=current.state,
                started_at=current.started_at,
                ended_at=ev.timestamp,
                duration_seconds=duration,
                program=current.program,
                tool_number=current.tool_number,
            )
        self._open[ev.machine_id] = _Open(
            state=state,
            started_at=ev.timestamp,
            program=self._program.get(ev.machine_id),
            tool_number=self._tool.get(ev.machine_id),
        )

    def mark_offline(self, machine_id: str, at_iso: str) -> Iterable[StateInterval]:
        current = self._open.get(machine_id)
        if current is None or current.state == "OFFLINE":
            return ()
        closed = StateInterval(
            machine_id=machine_id,
            state=current.state,
            started_at=current.started_at,
            ended_at=at_iso,
            duration_seconds=max(0, _secs(current.started_at, at_iso)),
            program=current.program,
            tool_number=current.tool_number,
        )
        self._open[machine_id] = _Open(state="OFFLINE", started_at=at_iso)
        return (closed,)


def _secs(start: str, end: str) -> int:
    try:
        s = datetime.fromisoformat(start.replace("Z", "+00:00"))
        e = datetime.fromisoformat(end.replace("Z", "+00:00"))
    except ValueError:
        return 0
    return int((e - s).total_seconds())
```

- [ ] **Step 4: Run → passes.**

```bash
cd edge/collector && pytest tests/test_state_machine.py
```

- [ ] **Step 5: Commit.**

```bash
git add edge/collector/
git commit -m "feat(edge): state machine producing closed intervals from Execution events"
```

### Task 20: Minute rollups

**Files:**
- Create: `edge/collector/src/collector/rollups.py`
- Create: `edge/collector/tests/test_rollups.py`

- [ ] **Step 1: Failing test**

```python
from __future__ import annotations

from collector.agent_client import Sample
from collector.rollups import RollupBuilder


def sp(ts: str, v: float, name: str = "SpindleSpeed") -> Sample:
    return Sample(machine_id="m1", data_item=name, value=v, timestamp=ts, sequence=1)


def test_minute_rollup_averages_spindle_rpm() -> None:
    rb = RollupBuilder()
    for s in (sp("2026-04-18T14:00:10Z", 8000), sp("2026-04-18T14:00:30Z", 8400)):
        rb.add_sample(s)
    rb.add_state_second("m1", "2026-04-18T14:00:15Z", "ACTIVE")
    rb.add_state_second("m1", "2026-04-18T14:00:45Z", "ACTIVE")
    out = list(rb.flush_closed(now_iso="2026-04-18T14:02:00Z"))
    assert len(out) == 1
    r = out[0]
    assert r["minute_bucket"] == "2026-04-18T14:00:00Z"
    assert r["spindle_rpm_avg"] == 8200
    assert r["active_seconds"] == 2


def test_no_flush_for_incomplete_minute() -> None:
    rb = RollupBuilder()
    rb.add_sample(sp("2026-04-18T14:05:30Z", 9000))
    out = list(rb.flush_closed(now_iso="2026-04-18T14:05:45Z"))
    assert out == []
```

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Write `src/collector/rollups.py`**

```python
from __future__ import annotations

from collections.abc import Iterable
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from collector.agent_client import Sample
from collector.state_machine import ExecState


def _bucket(ts: str) -> str:
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return ts
    return dt.replace(second=0, microsecond=0).strftime("%Y-%m-%dT%H:%M:00Z")


@dataclass
class _Bucket:
    machine_id: str
    bucket: str
    rpm_sum: float = 0.0
    rpm_n: int = 0
    load_sum: float = 0.0
    load_n: int = 0
    load_max: float = 0.0
    feed_sum: float = 0.0
    feed_n: int = 0
    state_seconds: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    program: str | None = None
    tool_number: int | None = None


class RollupBuilder:
    def __init__(self) -> None:
        self._by_key: dict[tuple[str, str], _Bucket] = {}

    def _get(self, machine_id: str, bucket: str) -> _Bucket:
        key = (machine_id, bucket)
        b = self._by_key.get(key)
        if b is None:
            b = _Bucket(machine_id=machine_id, bucket=bucket)
            self._by_key[key] = b
        return b

    def add_sample(self, s: Sample) -> None:
        b = self._get(s.machine_id, _bucket(s.timestamp))
        if s.data_item == "SpindleSpeed":
            b.rpm_sum += s.value
            b.rpm_n += 1
        elif s.data_item == "Load":
            b.load_sum += s.value
            b.load_n += 1
            if s.value > b.load_max:
                b.load_max = s.value
        elif s.data_item == "PathFeedrate":
            b.feed_sum += s.value
            b.feed_n += 1

    def add_state_second(self, machine_id: str, ts: str, state: ExecState) -> None:
        b = self._get(machine_id, _bucket(ts))
        b.state_seconds[state] += 1

    def set_program(self, machine_id: str, bucket: str, program: str | None) -> None:
        self._get(machine_id, bucket).program = program

    def set_tool(self, machine_id: str, bucket: str, tool_number: int | None) -> None:
        self._get(machine_id, bucket).tool_number = tool_number

    def flush_closed(self, now_iso: str) -> Iterable[dict]:
        try:
            now_dt = datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
        except ValueError:
            return []
        cutoff = (now_dt - timedelta(minutes=1)).replace(second=0, microsecond=0)
        cutoff_str = cutoff.strftime("%Y-%m-%dT%H:%M:00Z")

        out: list[dict] = []
        to_remove: list[tuple[str, str]] = []
        for key, b in self._by_key.items():
            if b.bucket >= cutoff_str:
                continue
            out.append(
                {
                    "machine_id": b.machine_id,
                    "minute_bucket": b.bucket,
                    "active_seconds": b.state_seconds.get("ACTIVE", 0),
                    "feed_hold_seconds": b.state_seconds.get("FEED_HOLD", 0),
                    "stopped_seconds": b.state_seconds.get("STOPPED", 0),
                    "interrupted_seconds": b.state_seconds.get("INTERRUPTED", 0),
                    "offline_seconds": b.state_seconds.get("OFFLINE", 0),
                    "spindle_rpm_avg": round(b.rpm_sum / b.rpm_n, 1) if b.rpm_n else None,
                    "spindle_load_avg": round(b.load_sum / b.load_n, 1) if b.load_n else None,
                    "spindle_load_max": b.load_max if b.load_n else None,
                    "feedrate_avg": round(b.feed_sum / b.feed_n, 1) if b.feed_n else None,
                    "feed_override_avg": None,
                    "part_count_delta": 0,
                    "program": b.program,
                    "tool_number": b.tool_number,
                }
            )
            to_remove.append(key)
        for key in to_remove:
            del self._by_key[key]
        return out
```

- [ ] **Step 4: Run → passes.**

- [ ] **Step 5: Commit.**

```bash
git add edge/collector/
git commit -m "feat(edge): minute-bucket rollup builder (spindle rpm/load, feedrate, state-seconds)"
```

### Task 21: Local SQLite storage

**Files:**
- Create: `edge/collector/src/collector/storage.py`
- Create: `edge/collector/tests/test_storage.py`

- [ ] **Step 1: Failing test**

```python
from __future__ import annotations

from pathlib import Path

import pytest

from collector.storage import LocalStorage


@pytest.mark.asyncio
async def test_round_trip_sample(tmp_path: Path) -> None:
    s = LocalStorage(db_path=tmp_path / "buf.db", retention_days=30)
    await s.open()
    await s.write_sample("m1", "SpindleSpeed", 8200.0, "2026-04-18T14:00:10Z")
    rows = await s.read_samples(
        "m1", "2026-04-18T14:00:00Z", "2026-04-18T14:01:00Z", signals=["SpindleSpeed"]
    )
    assert rows == [{"ts": "2026-04-18T14:00:10Z", "data_item": "SpindleSpeed", "value": 8200.0}]
    await s.close()


@pytest.mark.asyncio
async def test_retention_drops_old_rows(tmp_path: Path) -> None:
    s = LocalStorage(db_path=tmp_path / "buf.db", retention_days=1)
    await s.open()
    await s.write_sample("m1", "SpindleSpeed", 1.0, "2020-01-01T00:00:00Z")
    await s.write_sample("m1", "SpindleSpeed", 2.0, "2026-04-18T14:00:00Z")
    deleted = await s.sweep_expired(now_iso="2026-04-19T00:00:00Z")
    assert deleted == 1
    await s.close()
```

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Write `src/collector/storage.py`**

```python
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import aiosqlite


_SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
  machine_id TEXT NOT NULL,
  ts         TEXT NOT NULL,
  data_item  TEXT NOT NULL,
  value      REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_m_t ON samples(machine_id, ts);

CREATE TABLE IF NOT EXISTS closed_intervals (
  machine_id       TEXT NOT NULL,
  state            TEXT NOT NULL,
  started_at       TEXT NOT NULL,
  ended_at         TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  program          TEXT,
  tool_number      INTEGER,
  uploaded         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (machine_id, started_at, state)
);

CREATE TABLE IF NOT EXISTS events (
  machine_id TEXT NOT NULL,
  ts         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  severity   TEXT NOT NULL,
  payload    TEXT,
  uploaded   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_m_t ON events(machine_id, ts);

CREATE TABLE IF NOT EXISTS rollups_minute (
  machine_id    TEXT NOT NULL,
  minute_bucket TEXT NOT NULL,
  payload       TEXT NOT NULL,
  uploaded      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (machine_id, minute_bucket)
);
"""


class LocalStorage:
    def __init__(self, db_path: str | Path, retention_days: int) -> None:
        self._path = str(db_path)
        self._retention = retention_days
        self._db: aiosqlite.Connection | None = None

    async def open(self) -> None:
        self._db = await aiosqlite.connect(self._path)
        await self._db.executescript(_SCHEMA)
        await self._db.commit()

    async def close(self) -> None:
        if self._db is not None:
            await self._db.close()
            self._db = None

    def _conn(self) -> aiosqlite.Connection:
        assert self._db is not None, "storage not opened"
        return self._db

    async def write_sample(self, machine_id: str, data_item: str, value: float, ts: str) -> None:
        await self._conn().execute(
            "INSERT INTO samples (machine_id, ts, data_item, value) VALUES (?, ?, ?, ?)",
            (machine_id, ts, data_item, value),
        )
        await self._conn().commit()

    async def write_closed_interval(
        self,
        machine_id: str,
        state: str,
        started_at: str,
        ended_at: str,
        duration_seconds: int,
        program: str | None,
        tool_number: int | None,
    ) -> None:
        await self._conn().execute(
            """INSERT OR IGNORE INTO closed_intervals
                 (machine_id, state, started_at, ended_at, duration_seconds, program, tool_number)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (machine_id, state, started_at, ended_at, duration_seconds, program, tool_number),
        )
        await self._conn().commit()

    async def write_event(
        self, machine_id: str, ts: str, kind: str, severity: str, payload_json: str | None
    ) -> None:
        await self._conn().execute(
            "INSERT INTO events (machine_id, ts, kind, severity, payload) VALUES (?, ?, ?, ?, ?)",
            (machine_id, ts, kind, severity, payload_json),
        )
        await self._conn().commit()

    async def write_rollup(self, machine_id: str, minute_bucket: str, payload_json: str) -> None:
        await self._conn().execute(
            """INSERT INTO rollups_minute (machine_id, minute_bucket, payload)
               VALUES (?, ?, ?)
               ON CONFLICT(machine_id, minute_bucket) DO UPDATE SET
                 payload = excluded.payload,
                 uploaded = 0""",
            (machine_id, minute_bucket, payload_json),
        )
        await self._conn().commit()

    async def mark_uploaded(self, table: str, ids: list[int]) -> None:
        if not ids or table not in ("events", "closed_intervals", "rollups_minute"):
            return
        placeholders = ",".join("?" * len(ids))
        await self._conn().execute(
            f"UPDATE {table} SET uploaded = 1 WHERE rowid IN ({placeholders})",
            ids,
        )
        await self._conn().commit()

    async def read_samples(
        self, machine_id: str, from_ts: str, to_ts: str, signals: list[str]
    ) -> list[dict]:
        if not signals:
            return []
        placeholders = ",".join("?" * len(signals))
        rows = await self._conn().execute_fetchall(
            f"""SELECT ts, data_item, value FROM samples
                WHERE machine_id = ? AND ts >= ? AND ts < ? AND data_item IN ({placeholders})
                ORDER BY ts""",
            (machine_id, from_ts, to_ts, *signals),
        )
        return [{"ts": r[0], "data_item": r[1], "value": r[2]} for r in rows]

    async def sweep_expired(self, now_iso: str) -> int:
        now = datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
        cutoff = (now - timedelta(days=self._retention)).astimezone(timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        cur = await self._conn().execute("DELETE FROM samples WHERE ts < ?", (cutoff,))
        await self._conn().commit()
        return cur.rowcount

    async def pending_intervals(self, limit: int = 200) -> list[tuple[int, dict]]:
        rows = await self._conn().execute_fetchall(
            """SELECT rowid, machine_id, state, started_at, ended_at, duration_seconds, program, tool_number
               FROM closed_intervals WHERE uploaded = 0 ORDER BY started_at LIMIT ?""",
            (limit,),
        )
        return [
            (
                r[0],
                {
                    "machine_id": r[1],
                    "state": r[2],
                    "started_at": r[3],
                    "ended_at": r[4],
                    "duration_seconds": r[5],
                    "program": r[6],
                    "tool_number": r[7],
                },
            )
            for r in rows
        ]

    async def pending_events(self, limit: int = 200) -> list[tuple[int, dict]]:
        rows = await self._conn().execute_fetchall(
            """SELECT rowid, machine_id, ts, kind, severity, payload
               FROM events WHERE uploaded = 0 ORDER BY ts LIMIT ?""",
            (limit,),
        )
        return [
            (
                r[0],
                {
                    "machine_id": r[1],
                    "ts": r[2],
                    "kind": r[3],
                    "severity": r[4],
                    "payload": r[5],
                },
            )
            for r in rows
        ]

    async def pending_rollups(self, limit: int = 200) -> list[tuple[int, dict]]:
        rows = await self._conn().execute_fetchall(
            """SELECT rowid, machine_id, minute_bucket, payload
               FROM rollups_minute WHERE uploaded = 0 ORDER BY minute_bucket LIMIT ?""",
            (limit,),
        )
        return [
            (
                r[0],
                {
                    "machine_id": r[1],
                    "minute_bucket": r[2],
                    "payload": r[3],
                },
            )
            for r in rows
        ]
```

- [ ] **Step 4: Run → passes.**

- [ ] **Step 5: Commit.**

```bash
git add edge/collector/
git commit -m "feat(edge): local SQLite buffer (samples, intervals, events, rollups) with TTL sweep"
```

### Task 22: Uploader (push to cloud)

**Files:**
- Create: `edge/collector/src/collector/uploader.py`
- Create: `edge/collector/tests/test_uploader.py`

- [ ] **Step 1: Failing test** (uses `pytest-httpx`)

```python
from __future__ import annotations

import json

import pytest
from pytest_httpx import HTTPXMock

from collector.uploader import CloudUploader


@pytest.mark.asyncio
async def test_upload_state_intervals_marks_rows_uploaded(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://cloud.example/ingest/state", method="POST", json={"inserted": 1}
    )
    u = CloudUploader(base_url="https://cloud.example", shared_secret="s")
    ok = await u.push_state_intervals(
        [(1, {"machine_id": "m1", "state": "ACTIVE",
              "started_at": "2026-04-18T14:00:00Z", "ended_at": "2026-04-18T14:05:00Z",
              "duration_seconds": 300, "program": None, "tool_number": None})]
    )
    assert ok == [1]
    req = httpx_mock.get_request()
    assert req is not None
    assert req.headers["X-Edge-Secret"] == "s"
    body = json.loads(req.read().decode())
    assert body[0]["state"] == "ACTIVE"
    await u.aclose()


@pytest.mark.asyncio
async def test_upload_non_2xx_returns_empty(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://cloud.example/ingest/state", method="POST", status_code=503
    )
    u = CloudUploader(base_url="https://cloud.example", shared_secret="s")
    ok = await u.push_state_intervals(
        [(1, {"machine_id": "m1", "state": "ACTIVE",
              "started_at": "t", "ended_at": "t", "duration_seconds": 0,
              "program": None, "tool_number": None})]
    )
    assert ok == []
    await u.aclose()
```

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Write `src/collector/uploader.py`**

```python
from __future__ import annotations

import json
from collections.abc import Iterable

import httpx


class CloudUploader:
    def __init__(
        self,
        base_url: str,
        shared_secret: str,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._secret = shared_secret
        self._client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, connect=5.0),
            headers={"X-Edge-Secret": shared_secret, "Content-Type": "application/json"},
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _post(self, path: str, body: list[dict]) -> bool:
        try:
            r = await self._client.post(f"{self._base}{path}", json=body)
            return 200 <= r.status_code < 300
        except httpx.HTTPError:
            return False

    async def push_state_intervals(
        self, rows: Iterable[tuple[int, dict]]
    ) -> list[int]:
        rows = list(rows)
        if not rows:
            return []
        body = [r[1] for r in rows]
        return [r[0] for r in rows] if await self._post("/ingest/state", body) else []

    async def push_events(self, rows: Iterable[tuple[int, dict]]) -> list[int]:
        rows = list(rows)
        if not rows:
            return []
        body = []
        for _, r in rows:
            payload = r.get("payload")
            body.append(
                {
                    "machine_id": r["machine_id"],
                    "ts": r["ts"],
                    "kind": r["kind"],
                    "severity": r["severity"],
                    "payload": json.loads(payload) if isinstance(payload, str) and payload else payload,
                }
            )
        return [r[0] for r in rows] if await self._post("/ingest/events", body) else []

    async def push_rollups(self, rows: Iterable[tuple[int, dict]]) -> list[int]:
        rows = list(rows)
        if not rows:
            return []
        body = [json.loads(r[1]["payload"]) for r in rows]
        return [r[0] for r in rows] if await self._post("/ingest/rollups", body) else []
```

- [ ] **Step 4: Run → passes.**

- [ ] **Step 5: Commit.**

```bash
git add edge/collector/
git commit -m "feat(edge): cloud uploader with shared-secret auth and per-endpoint push methods"
```

### Task 23: Drill-down local HTTP server

**Files:**
- Create: `edge/collector/src/collector/drill_down.py`
- Create: `edge/collector/tests/test_drill_down.py`

- [ ] **Step 1: Failing test**

```python
from __future__ import annotations

from pathlib import Path

import pytest
from aiohttp.test_utils import AioHTTPTestCase, TestClient, TestServer

from collector.drill_down import DrillDownServer
from collector.storage import LocalStorage


@pytest.mark.asyncio
async def test_returns_samples_in_window(tmp_path: Path) -> None:
    storage = LocalStorage(db_path=tmp_path / "buf.db", retention_days=30)
    await storage.open()
    await storage.write_sample("m1", "SpindleSpeed", 8200.0, "2026-04-18T14:00:10Z")
    await storage.write_sample("m1", "SpindleSpeed", 8400.0, "2026-04-18T14:00:30Z")

    server = DrillDownServer(storage=storage, shared_secret="s")
    app = server.build_app()
    async with TestClient(TestServer(app)) as client:
        r = await client.get(
            "/samples",
            params={
                "machine_id": "m1",
                "from": "2026-04-18T14:00:00Z",
                "to": "2026-04-18T14:01:00Z",
                "signals": "SpindleSpeed",
            },
            headers={"X-Edge-Secret": "s"},
        )
        assert r.status == 200
        body = await r.json()
        assert len(body["samples"]) == 2

    await storage.close()


@pytest.mark.asyncio
async def test_rejects_bad_secret(tmp_path: Path) -> None:
    storage = LocalStorage(db_path=tmp_path / "buf.db", retention_days=30)
    await storage.open()

    server = DrillDownServer(storage=storage, shared_secret="s")
    async with TestClient(TestServer(server.build_app())) as client:
        r = await client.get(
            "/samples",
            params={
                "machine_id": "m1",
                "from": "a",
                "to": "b",
                "signals": "SpindleSpeed",
            },
            headers={"X-Edge-Secret": "wrong"},
        )
        assert r.status == 401

    await storage.close()
```

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Write `src/collector/drill_down.py`**

```python
from __future__ import annotations

from aiohttp import web

from collector.storage import LocalStorage


class DrillDownServer:
    def __init__(self, storage: LocalStorage, shared_secret: str) -> None:
        self._storage = storage
        self._secret = shared_secret

    def build_app(self) -> web.Application:
        app = web.Application()
        app.router.add_get("/samples", self._samples)
        app.router.add_get("/health", lambda r: web.json_response({"ok": True}))
        return app

    def _authed(self, request: web.Request) -> bool:
        provided = request.headers.get("X-Edge-Secret", "")
        return _timing_safe(provided, self._secret)

    async def _samples(self, request: web.Request) -> web.Response:
        if not self._authed(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        machine_id = request.query.get("machine_id")
        f = request.query.get("from")
        t = request.query.get("to")
        signals_raw = request.query.get("signals", "SpindleSpeed")
        if not (machine_id and f and t):
            return web.json_response({"error": "machine_id, from, to required"}, status=400)
        signals = [s for s in signals_raw.split(",") if s]
        rows = await self._storage.read_samples(machine_id, f, t, signals)
        return web.json_response({"machine_id": machine_id, "samples": rows})


def _timing_safe(a: str, b: str) -> bool:
    if len(a) != len(b):
        return False
    diff = 0
    for x, y in zip(a, b):
        diff |= ord(x) ^ ord(y)
    return diff == 0
```

- [ ] **Step 4: Run → passes.**

- [ ] **Step 5: Commit.**

```bash
git add edge/collector/
git commit -m "feat(edge): drill-down aiohttp server on localhost (X-Edge-Secret auth)"
```

### Task 24: Main loop + `__main__`

**Files:**
- Create: `edge/collector/src/collector/__main__.py`

- [ ] **Step 1: Write `src/collector/__main__.py`**

```python
from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
from datetime import datetime, timezone
from pathlib import Path

from aiohttp import web

from collector.agent_client import AgentClient, Event, Sample
from collector.config import load_config
from collector.drill_down import DrillDownServer
from collector.rollups import RollupBuilder
from collector.state_machine import StateMachine
from collector.storage import LocalStorage
from collector.uploader import CloudUploader


async def run(config_path: Path) -> None:
    cfg = load_config(config_path)
    secret = os.environ[cfg.cloud.shared_secret_env]

    storage = LocalStorage(db_path=cfg.storage.sqlite_path, retention_days=cfg.storage.retention_days)
    await storage.open()
    uploader = CloudUploader(base_url=cfg.cloud.base_url, shared_secret=secret)
    state_machine = StateMachine()
    rollups = RollupBuilder()

    device_map = {m.agent_device: m.id for m in cfg.machines}
    agent = AgentClient(base_url=cfg.agent.base_url, device_uuid_to_machine_id=device_map)

    drill = DrillDownServer(storage=storage, shared_secret=secret)
    runner = web.AppRunner(drill.build_app())
    await runner.setup()
    site = web.TCPSite(runner, cfg.drill_down.listen_host, cfg.drill_down.listen_port)
    await site.start()

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    sweep_task = asyncio.create_task(_sweep_loop(storage, stop))
    upload_task = asyncio.create_task(_upload_loop(storage, uploader, stop))
    ingest_task = asyncio.create_task(_ingest_loop(agent, state_machine, rollups, storage, stop))

    await stop.wait()

    for t in (sweep_task, upload_task, ingest_task):
        t.cancel()
    await asyncio.gather(sweep_task, upload_task, ingest_task, return_exceptions=True)
    await runner.cleanup()
    await uploader.aclose()
    await agent.aclose()
    await storage.close()


async def _ingest_loop(
    agent: AgentClient,
    state_machine: StateMachine,
    rollups: RollupBuilder,
    storage: LocalStorage,
    stop: asyncio.Event,
) -> None:
    backoff = 1.0
    while not stop.is_set():
        try:
            records = await agent.poll_once()
            for rec in records:
                if isinstance(rec, Sample):
                    await storage.write_sample(rec.machine_id, rec.data_item, rec.value, rec.timestamp)
                    rollups.add_sample(rec)
                else:
                    closed_intervals = list(state_machine.ingest(rec))
                    for interval in closed_intervals:
                        await storage.write_closed_interval(
                            interval.machine_id,
                            interval.state,
                            interval.started_at,
                            interval.ended_at,
                            interval.duration_seconds,
                            interval.program,
                            interval.tool_number,
                        )
                    if isinstance(rec, Event) and rec.data_item == "Execution":
                        # seed state-second counters for this bucket
                        rollups.add_state_second(rec.machine_id, rec.timestamp, _map(rec.value))
            now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            for r in rollups.flush_closed(now_iso):
                await storage.write_rollup(r["machine_id"], r["minute_bucket"], json.dumps(r))
            backoff = 1.0
            await asyncio.sleep(1.0)
        except Exception:  # noqa: BLE001 — keep running, back off
            await asyncio.sleep(min(30.0, backoff))
            backoff *= 2


async def _upload_loop(storage: LocalStorage, uploader: CloudUploader, stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            intervals = await storage.pending_intervals(limit=200)
            ok = await uploader.push_state_intervals(intervals)
            await storage.mark_uploaded("closed_intervals", ok)

            events = await storage.pending_events(limit=200)
            ok = await uploader.push_events(events)
            await storage.mark_uploaded("events", ok)

            rollups = await storage.pending_rollups(limit=200)
            ok = await uploader.push_rollups(rollups)
            await storage.mark_uploaded("rollups_minute", ok)

            await asyncio.sleep(15.0)
        except Exception:  # noqa: BLE001
            await asyncio.sleep(30.0)


async def _sweep_loop(storage: LocalStorage, stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            await storage.sweep_expired(now_iso)
        except Exception:  # noqa: BLE001
            pass
        await asyncio.sleep(3600.0)


def _map(value: str) -> str:
    v = value.upper()
    if v in ("ACTIVE", "FEED_HOLD", "STOPPED", "INTERRUPTED"):
        return v
    if v == "UNAVAILABLE":
        return "OFFLINE"
    return "STOPPED"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True, type=Path)
    args = ap.parse_args()
    asyncio.run(run(args.config))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Smoke test against simulator**

Run cppagent's simulator adapter locally, point `config.toml` at it, run:

```bash
cd edge/collector
EDGE_SHARED_SECRET=test python -m collector --config config.example.toml
```

Expected: service starts, no crashes, drill-down server listens on 127.0.0.1:8989. Stop with Ctrl-C.

- [ ] **Step 3: Commit.**

```bash
git add edge/collector/src/collector/__main__.py
git commit -m "feat(edge): wire main loop (ingest/upload/sweep tasks + drill-down server)"
```

**Checkpoint 3 — Edge collector is complete.** Next: cppagent config, compose stack, Ansible deploy.

---

## Part 8 — Edge infrastructure

### Task 25: cppagent configuration + Haas device XML

**Files:**
- Create: `edge/cppagent/agent.cfg`
- Create: `edge/cppagent/devices/haas-vf2-1.xml`

- [ ] **Step 1: `agent.cfg`**

```
Devices = devices/haas-vf2-1.xml
Port = 5000
ServerIp = 0.0.0.0
AllowPut = false
Pretty = true
BufferSize = 131072

Adapters
{
  HaasVf2_1
  {
    Device = HaasVf2_1
    Url = http://HAAS_MACHINE_IP:8082/current
    SuppressIPAddress = true
    ReconnectInterval = 10000
  }
}

logger_config
{
  logging_level = info
  output = file /var/log/cppagent/agent.log
}
```

Notes:
- `HAAS_MACHINE_IP` is replaced at deploy time by Ansible (see Task 27).
- `http_adapter` mode: cppagent pulls from the Haas native agent. Port 8082 and path `/current` match current Haas NGC MTConnect service; confirm against `docs/runbooks/add-new-machine.md` before deploying.

- [ ] **Step 2: `devices/haas-vf2-1.xml`** (minimal Device descriptor — cppagent serves whatever the upstream agent publishes, but needs a device descriptor to present)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MTConnectDevices
    xmlns="urn:mtconnect.org:MTConnectDevices:2.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="urn:mtconnect.org:MTConnectDevices:2.0 http://www.mtconnect.org/schemas/MTConnectDevices_2.0.xsd">
  <Header creationTime="2026-04-18T00:00:00Z" sender="cppagent" instanceId="1" version="2.2" bufferSize="131072"/>
  <Devices>
    <Device id="HaasVf2_1" name="HaasVf2_1" uuid="haas-vf2-1">
      <Description manufacturer="Haas">Example Haas VF-2 Phase A machine</Description>
      <DataItems>
        <DataItem id="avail" category="EVENT" type="AVAILABILITY"/>
      </DataItems>
      <Components>
        <Controller id="cont1">
          <DataItems>
            <DataItem id="exec" category="EVENT" type="EXECUTION"/>
            <DataItem id="prog" category="EVENT" type="PROGRAM"/>
            <DataItem id="mode" category="EVENT" type="CONTROLLER_MODE"/>
            <DataItem id="tool" category="EVENT" type="TOOL_ASSET_ID"/>
          </DataItems>
        </Controller>
        <Axes id="axes1">
          <Components>
            <Rotary id="spindle1" name="spindle">
              <DataItems>
                <DataItem id="s" category="SAMPLE" type="SPINDLE_SPEED" units="REVOLUTION/MINUTE"/>
                <DataItem id="sl" category="SAMPLE" type="LOAD" units="PERCENT"/>
              </DataItems>
            </Rotary>
          </Components>
        </Axes>
        <Path id="path1">
          <DataItems>
            <DataItem id="f" category="SAMPLE" type="PATH_FEEDRATE" units="INCH/MINUTE"/>
          </DataItems>
        </Path>
      </Components>
    </Device>
  </Devices>
</MTConnectDevices>
```

- [ ] **Step 3: Commit.**

```bash
git add edge/cppagent/
git commit -m "feat(edge): cppagent config + Haas VF-2 device XML descriptor"
```

### Task 26: podman-compose stack

**Files:**
- Create: `edge/compose/docker-compose.yaml`
- Create: `edge/compose/.env.example`

- [ ] **Step 1: `docker-compose.yaml`**

```yaml
services:
  cppagent:
    image: ghcr.io/mtconnect/cppagent:latest
    container_name: cppagent
    restart: unless-stopped
    network_mode: host
    volumes:
      - ../cppagent:/etc/cppagent:ro
      - cppagent-logs:/var/log/cppagent
    command: ["/etc/cppagent/agent.cfg"]
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:5000/probe"]
      interval: 30s
      timeout: 5s
      retries: 3

  collector:
    image: ghcr.io/ffmfg-tal/mtconnect-collector:latest
    container_name: collector
    restart: unless-stopped
    network_mode: host
    depends_on: [cppagent]
    environment:
      EDGE_SHARED_SECRET: ${EDGE_SHARED_SECRET}
    volumes:
      - ./config.toml:/etc/collector/config.toml:ro
      - collector-buffer:/var/lib/collector
    command: ["--config", "/etc/collector/config.toml"]

  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: cloudflared
    restart: unless-stopped
    network_mode: host
    command: ["tunnel", "--no-autoupdate", "run", "--token", "${CLOUDFLARE_TUNNEL_TOKEN}"]

volumes:
  cppagent-logs:
  collector-buffer:
```

- [ ] **Step 2: `.env.example`**

```
EDGE_SHARED_SECRET=replace-with-long-random-string
CLOUDFLARE_TUNNEL_TOKEN=replace-with-tunnel-token-from-cf-zero-trust
```

- [ ] **Step 3: Smoke test compose locally (no real machine required)**

Use the cppagent simulator adapter (point `Url` at `agent/simulator_samples.csv` instead of the Haas IP) and run:

```bash
cd edge/compose
cp .env.example .env
# edit .env with test values
podman-compose up -d
curl http://127.0.0.1:5000/probe
```

Expected: probe returns 200 with XML containing `HaasVf2_1` device.

- [ ] **Step 4: Commit.**

```bash
git add edge/compose/
git commit -m "feat(edge): podman-compose stack (cppagent + collector + cloudflared)"
```

### Task 27: Ansible base role (OS hardening)

Uses `dev-sec.os-hardening` and `dev-sec.ssh-hardening` as the baseline; adds FFMFG-specific items on top.

**Files:**
- Create: `edge/ansible/inventory.yml`
- Create: `edge/ansible/playbook.yml`
- Create: `edge/ansible/requirements.yml`
- Create: `edge/ansible/roles/base/tasks/main.yml`

- [ ] **Step 1: `inventory.yml`**

```yaml
all:
  children:
    edge_boxes:
      hosts:
        edge01:
          ansible_host: 10.0.50.10
          ansible_user: deploy
          ansible_become: true
          ansible_ssh_private_key_file: ~/.ssh/ffmfg_edge01
```

- [ ] **Step 2: `requirements.yml`**

```yaml
collections:
  - name: devsec.hardening
    version: "8.0.0"
  - name: containers.podman
    version: "1.13.0"
```

- [ ] **Step 3: `playbook.yml`**

```yaml
- name: Provision FFMFG edge box
  hosts: edge_boxes
  become: true
  pre_tasks:
    - name: Install collection deps
      community.general.pip:
        name:
          - jmespath
        executable: pip3
      delegate_to: localhost
      become: false
      run_once: true
  roles:
    - devsec.hardening.os_hardening
    - devsec.hardening.ssh_hardening
    - role: base
    - role: services
  vars:
    os_desktop_enable: false
    sysctl_overwrite:
      net.ipv4.ip_forward: 0
    ssh_allow_tcp_forwarding: "no"
    ssh_permit_root_login: "no"
    ssh_password_authentication: "no"
```

- [ ] **Step 4: `roles/base/tasks/main.yml`**

```yaml
- name: Ensure required packages
  ansible.builtin.apt:
    name:
      - podman
      - podman-compose
      - chrony
      - ufw
      - auditd
      - fail2ban
      - unattended-upgrades
      - curl
    state: present
    update_cache: true

- name: Configure chrony to use time.cloudflare.com
  ansible.builtin.copy:
    dest: /etc/chrony/conf.d/ffmfg.conf
    content: |
      server time.cloudflare.com iburst
      server 0.pool.ntp.org iburst
    owner: root
    group: root
    mode: "0644"
  notify: restart chrony

- name: UFW default deny incoming
  community.general.ufw:
    default: deny
    direction: incoming

- name: UFW default deny outgoing (allowlist below)
  community.general.ufw:
    default: deny
    direction: outgoing

- name: UFW allow outbound to Cloudflare (IP ranges updated annually)
  community.general.ufw:
    rule: allow
    direction: out
    to_ip: "{{ item }}"
    proto: tcp
    to_port: "443"
  loop:
    - 173.245.48.0/20
    - 103.21.244.0/22
    - 103.22.200.0/22
    - 103.31.4.0/22
    - 141.101.64.0/18
    - 108.162.192.0/18
    - 190.93.240.0/20
    - 188.114.96.0/20
    - 197.234.240.0/22
    - 198.41.128.0/17
    - 162.158.0.0/15
    - 104.16.0.0/13
    - 104.24.0.0/14
    - 172.64.0.0/13
    - 131.0.72.0/22

- name: UFW allow NTP
  community.general.ufw:
    rule: allow
    direction: out
    proto: udp
    to_port: "123"

- name: UFW allow inbound SSH from admin subnet
  community.general.ufw:
    rule: allow
    direction: in
    proto: tcp
    to_port: "22"
    from_ip: 10.0.40.0/24

- name: UFW enabled
  community.general.ufw:
    state: enabled

- name: Enable unattended-upgrades
  ansible.builtin.copy:
    dest: /etc/apt/apt.conf.d/20auto-upgrades
    content: |
      APT::Periodic::Update-Package-Lists "1";
      APT::Periodic::Unattended-Upgrade "1";
      APT::Periodic::AutocleanInterval "7";
    mode: "0644"

- name: Deploy user (no shell, cannot su)
  ansible.builtin.user:
    name: deploy
    shell: /bin/bash
    groups:
      - sudo
    append: true
    state: present

- name: Ensure auditd is running
  ansible.builtin.systemd:
    name: auditd
    enabled: true
    state: started
```

- [ ] **Step 5: Create handlers**

Create `edge/ansible/roles/base/handlers/main.yml`:

```yaml
- name: restart chrony
  ansible.builtin.systemd:
    name: chrony
    state: restarted
```

- [ ] **Step 6: Dry-run against a throwaway Ubuntu VM**

```bash
cd edge/ansible
ansible-galaxy install -r requirements.yml
ansible-playbook -i inventory.yml playbook.yml --check
```
Expected: no errors in check mode.

- [ ] **Step 7: Commit.**

```bash
git add edge/ansible/
git commit -m "feat(edge): Ansible base role (dev-sec + FFMFG egress allowlist + NTP)"
```

### Task 28: Ansible service role (compose + cloudflared)

**Files:**
- Create: `edge/ansible/roles/services/tasks/main.yml`
- Create: `edge/ansible/roles/services/templates/config.toml.j2`

- [ ] **Step 1: `roles/services/tasks/main.yml`**

```yaml
- name: Create collector config dir
  ansible.builtin.file:
    path: /etc/collector
    state: directory
    mode: "0755"

- name: Render collector config
  ansible.builtin.template:
    src: config.toml.j2
    dest: /etc/collector/config.toml
    mode: "0644"

- name: Create compose dir
  ansible.builtin.file:
    path: /opt/mtconnect
    state: directory
    mode: "0755"

- name: Copy compose file
  ansible.builtin.copy:
    src: "{{ playbook_dir }}/../compose/docker-compose.yaml"
    dest: /opt/mtconnect/docker-compose.yaml
    mode: "0644"

- name: Copy cppagent config tree
  ansible.builtin.copy:
    src: "{{ playbook_dir }}/../cppagent/"
    dest: /opt/mtconnect/cppagent/
    mode: "0644"

- name: Write .env
  ansible.builtin.copy:
    dest: /opt/mtconnect/.env
    content: |
      EDGE_SHARED_SECRET={{ edge_shared_secret }}
      CLOUDFLARE_TUNNEL_TOKEN={{ cloudflare_tunnel_token }}
    mode: "0600"
    owner: root
    group: root
  no_log: true

- name: Enable linger for deploy user (rootless podman services)
  ansible.builtin.command: loginctl enable-linger deploy
  args:
    creates: /var/lib/systemd/linger/deploy

- name: Systemd unit for compose
  ansible.builtin.copy:
    dest: /etc/systemd/system/mtconnect.service
    content: |
      [Unit]
      Description=MTConnect edge stack
      After=network-online.target
      Wants=network-online.target

      [Service]
      Type=simple
      WorkingDirectory=/opt/mtconnect
      EnvironmentFile=/opt/mtconnect/.env
      ExecStart=/usr/bin/podman-compose up
      ExecStop=/usr/bin/podman-compose down
      Restart=always
      RestartSec=10

      [Install]
      WantedBy=multi-user.target
    mode: "0644"
  notify: reload systemd

- name: Enable + start mtconnect service
  ansible.builtin.systemd:
    name: mtconnect
    enabled: true
    state: started
    daemon_reload: true
```

Handler:

```yaml
# edge/ansible/roles/services/handlers/main.yml
- name: reload systemd
  ansible.builtin.systemd:
    daemon_reload: true
```

- [ ] **Step 2: `templates/config.toml.j2`**

```jinja
[agent]
base_url = "http://127.0.0.1:5000"

[cloud]
base_url = "{{ cloud_base_url }}"
shared_secret_env = "EDGE_SHARED_SECRET"

[storage]
sqlite_path = "/var/lib/collector/buffer.db"
retention_days = 30

[drill_down]
listen_host = "127.0.0.1"
listen_port = 8989

{% for m in machines %}
[[machine]]
id = "{{ m.id }}"
agent_device = "{{ m.agent_device }}"
{% endfor %}
```

- [ ] **Step 3: Group vars**

Create `edge/ansible/group_vars/edge_boxes.yml`:

```yaml
cloud_base_url: "https://mtconnect-collector.YOUR_WORKERS_SUBDOMAIN.workers.dev"
# edge_shared_secret and cloudflare_tunnel_token come from ansible-vault
machines:
  - id: haas-vf2-1
    agent_device: HaasVf2_1
```

And a vault file `edge/ansible/group_vars/edge_boxes.vault.yml` (created encrypted with `ansible-vault create`; never commit unencrypted):

```yaml
edge_shared_secret: "REDACTED"
cloudflare_tunnel_token: "REDACTED"
```

- [ ] **Step 4: Deploy**

```bash
cd edge/ansible
ansible-playbook -i inventory.yml playbook.yml --ask-vault-pass
```
Expected: `mtconnect.service` active on edge01; `podman ps` shows `cppagent`, `collector`, `cloudflared` all `Up`.

- [ ] **Step 5: Commit.**

```bash
git add edge/ansible/
git commit -m "feat(edge): Ansible services role (compose systemd + templated config + vault)"
```

---

## Part 9 — MES integration (shop-floor-mes)

These tasks live in the **shop-floor-mes** repo, not this one. The shop-floor-mes repo is a separate git repo; each task's commit lands there.

### Task 29: Backend proxy route

**Files (in shop-floor-mes):**
- Create: `src/api/machines.ts`
- Create: `test/api/machines.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Failing test `test/api/machines.test.ts`**

```typescript
import { describe, it, expect, vi } from "vitest";
import { SELF, env } from "cloudflare:test";

describe("GET /api/machines", () => {
  it("proxies to the collector and returns its body", async () => {
    const fetched = vi.fn(async () =>
      new Response(JSON.stringify({ machines: [{ id: "haas-vf2-1" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetched);
    (env as unknown as { MTCONNECT_COLLECTOR_URL: string }).MTCONNECT_COLLECTOR_URL =
      "https://collector.example";

    const res = await SELF.fetch("https://x/api/machines");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { machines: Array<{ id: string }> };
    expect(body.machines[0].id).toBe("haas-vf2-1");
    expect(fetched.mock.calls[0][0]).toContain("collector.example/machines");
  });
});
```

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Write `src/api/machines.ts`**

```typescript
import { Hono } from "hono";
import type { Env } from "../env";

export const machinesApi = new Hono<{ Bindings: Env }>();

machinesApi.get("/", async (c) => {
  const upstream = await fetch(`${c.env.MTCONNECT_COLLECTOR_URL}/machines`);
  if (!upstream.ok) return c.json({ error: "collector unavailable" }, 502);
  return new Response(await upstream.text(), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

machinesApi.get("/:id/oee", async (c) => {
  const id = c.req.param("id");
  const date = c.req.query("date") ?? "";
  const qs = date ? `?date=${encodeURIComponent(date)}` : "";
  const upstream = await fetch(`${c.env.MTCONNECT_COLLECTOR_URL}/machines/${encodeURIComponent(id)}/oee${qs}`);
  if (!upstream.ok) return c.json({ error: "collector unavailable" }, 502);
  return new Response(await upstream.text(), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

machinesApi.get("/:id/samples", async (c) => {
  const id = c.req.param("id");
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  const signals = c.req.query("signals") ?? "SpindleSpeed";
  const qs = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&signals=${encodeURIComponent(signals)}`;
  const upstream = await fetch(`${c.env.MTCONNECT_COLLECTOR_URL}/proxy/edge/${encodeURIComponent(id)}/samples${qs}`);
  if (!upstream.ok) return c.json({ error: "collector unavailable" }, 502);
  return new Response(await upstream.text(), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
```

- [ ] **Step 4: Add to Env type**

Edit `src/env.ts`:

```typescript
export type Env = {
  // ... existing
  MTCONNECT_COLLECTOR_URL: string;
};
```

- [ ] **Step 5: Wire into `src/index.ts`**

```typescript
import { machinesApi } from "./api/machines";
// ...
app.route("/api/machines", machinesApi);
```

- [ ] **Step 6: Add collector URL to `wrangler.jsonc`**

```jsonc
"vars": {
  "MTCONNECT_COLLECTOR_URL": "https://mtconnect-collector.YOUR_WORKERS_SUBDOMAIN.workers.dev"
}
```

- [ ] **Step 7: Run → passes.**

```bash
cd shop-floor-mes && npm test -- machines
```

- [ ] **Step 8: Commit (in shop-floor-mes).**

```bash
cd shop-floor-mes
git add src/api/machines.ts src/env.ts src/index.ts test/api/machines.test.ts wrangler.jsonc
git commit -m "feat: proxy /api/machines/* to mtconnect-collector"
```

### Task 30: MachineTile component

**Files (in shop-floor-mes):**
- Create: `frontend/src/components/MachineTile.tsx`
- Create: `frontend/src/components/MachineTile.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MachineTile } from "./MachineTile";

describe("MachineTile", () => {
  it("shows machine name and state", () => {
    render(
      <MachineTile
        machine={{
          id: "haas-vf2-1",
          display_name: "Haas VF-2 #1",
          pool: "small-3-axis-mill",
          current_state: "ACTIVE",
          last_seen_at: "2026-04-18T14:30:00Z",
        }}
      />,
    );
    expect(screen.getByText("Haas VF-2 #1")).toBeInTheDocument();
    expect(screen.getByText(/ACTIVE/)).toBeInTheDocument();
  });

  it("renders FEED_HOLD with warning color class", () => {
    render(
      <MachineTile
        machine={{
          id: "haas-vf2-1",
          display_name: "Haas VF-2 #1",
          pool: "small-3-axis-mill",
          current_state: "FEED_HOLD",
          last_seen_at: "2026-04-18T14:30:00Z",
        }}
      />,
    );
    const tile = screen.getByTestId("machine-tile-haas-vf2-1");
    expect(tile.className).toMatch(/state-feed-hold/);
  });
});
```

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Write `frontend/src/components/MachineTile.tsx`**

```tsx
import type { FC } from "react";

export type MachineSummary = {
  id: string;
  display_name: string;
  pool: string | null;
  current_state: "ACTIVE" | "FEED_HOLD" | "STOPPED" | "INTERRUPTED" | "OFFLINE" | null;
  last_seen_at: string | null;
};

type Props = { machine: MachineSummary; onClick?: (id: string) => void };

const STATE_CLASS: Record<NonNullable<MachineSummary["current_state"]>, string> = {
  ACTIVE: "state-active",
  FEED_HOLD: "state-feed-hold",
  STOPPED: "state-stopped",
  INTERRUPTED: "state-interrupted",
  OFFLINE: "state-offline",
};

export const MachineTile: FC<Props> = ({ machine, onClick }) => {
  const stateClass = machine.current_state ? STATE_CLASS[machine.current_state] : "state-unknown";
  return (
    <button
      type="button"
      data-testid={`machine-tile-${machine.id}`}
      className={`machine-tile ${stateClass}`}
      onClick={() => onClick?.(machine.id)}
    >
      <div className="machine-tile__name">{machine.display_name}</div>
      <div className="machine-tile__state">{machine.current_state ?? "—"}</div>
      {machine.pool && <div className="machine-tile__pool">{machine.pool}</div>}
    </button>
  );
};
```

- [ ] **Step 4: Add styles in `frontend/src/components/MachineTile.css`**

```css
.machine-tile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px;
  border-radius: 8px;
  background: #1a1a2e;
  color: #fff;
  border: 2px solid #2e2e44;
  min-width: 180px;
  cursor: pointer;
  transition: transform 120ms ease;
}
.machine-tile:hover { transform: translateY(-2px); }
.machine-tile__name { font-weight: 700; font-size: 14px; }
.machine-tile__state { font-size: 18px; font-weight: 600; }
.machine-tile__pool { font-size: 11px; color: #6c757d; }

.machine-tile.state-active      { border-color: #00b4d8; }
.machine-tile.state-feed-hold   { border-color: #e76f51; }
.machine-tile.state-stopped     { border-color: #6c757d; }
.machine-tile.state-interrupted { border-color: #e76f51; background: #2d1113; }
.machine-tile.state-offline     { border-color: #444; background: #0d0d1a; color: #888; }
```

Import CSS in `MachineTile.tsx` with `import "./MachineTile.css";`.

- [ ] **Step 5: Run → passes.**

- [ ] **Step 6: Commit.**

```bash
cd shop-floor-mes
git add frontend/src/components/MachineTile.{tsx,test.tsx,css}
git commit -m "feat(ui): MachineTile component with state-colored border"
```

### Task 31: MachinesView (the Machines tab)

**Files (in shop-floor-mes):**
- Create: `frontend/src/views/MachinesView.tsx`
- Create: `frontend/src/views/MachinesView.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MachinesView } from "./MachinesView";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/api/machines")) {
        return new Response(
          JSON.stringify({
            machines: [
              { id: "haas-vf2-1", display_name: "Haas VF-2 #1", pool: "small-3-axis-mill", current_state: "ACTIVE", last_seen_at: "2026-04-18T14:30:00Z" },
              { id: "haas-vf3-1", display_name: "Haas VF-3", pool: "small-3-axis-mill", current_state: "STOPPED", last_seen_at: "2026-04-18T14:25:00Z" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }),
  );
});

describe("MachinesView", () => {
  it("loads and renders machines grouped by pool", async () => {
    render(<MachinesView />);
    await waitFor(() => {
      expect(screen.getByText("Haas VF-2 #1")).toBeInTheDocument();
      expect(screen.getByText("Haas VF-3")).toBeInTheDocument();
    });
    expect(screen.getByText("small-3-axis-mill")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Write `MachinesView.tsx`**

```tsx
import { useEffect, useState } from "react";
import { MachineTile, type MachineSummary } from "../components/MachineTile";
import "./MachinesView.css";

export function MachinesView(): JSX.Element {
  const [machines, setMachines] = useState<MachineSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/machines");
        if (!r.ok) throw new Error(`${r.status}`);
        const body = (await r.json()) as { machines: MachineSummary[] };
        if (!cancelled) setMachines(body.machines);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };
    load();
    const t = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (error) return <div className="machines-view__error">Failed to load: {error}</div>;
  if (machines === null) return <div className="machines-view__loading">Loading…</div>;

  const byPool = new Map<string, MachineSummary[]>();
  for (const m of machines) {
    const key = m.pool ?? "unassigned";
    const list = byPool.get(key) ?? [];
    list.push(m);
    byPool.set(key, list);
  }

  return (
    <div className="machines-view">
      {[...byPool.entries()].map(([pool, list]) => (
        <section key={pool} className="machines-view__pool">
          <h2>{pool}</h2>
          <div className="machines-view__grid">
            {list.map((m) => (
              <MachineTile key={m.id} machine={m} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: CSS**

```css
/* frontend/src/views/MachinesView.css */
.machines-view { padding: 24px; display: flex; flex-direction: column; gap: 24px; }
.machines-view__pool h2 { color: #00b4d8; text-transform: uppercase; font-size: 14px; letter-spacing: 0.08em; margin-bottom: 12px; }
.machines-view__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
.machines-view__loading, .machines-view__error { padding: 24px; color: #6c757d; }
```

- [ ] **Step 5: Add route / nav entry**

Wire the view into whatever router the MES uses (confirm against `shop-floor-mes/frontend/src/App.tsx`). Add a "Machines" tab next to the existing scoreboard tab.

- [ ] **Step 6: Run + commit.**

```bash
cd shop-floor-mes && npm test -- MachinesView
git add frontend/src/views/MachinesView.{tsx,test.tsx,css} frontend/src/App.tsx
git commit -m "feat(ui): Machines tab listing machines by pool with live state"
```

### Task 32: Alert panel integration

**Files (in shop-floor-mes):**
- Create: `frontend/src/components/MachineAlertsPanel.tsx`
- Create: `frontend/src/components/MachineAlertsPanel.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MachineAlertsPanel } from "./MachineAlertsPanel";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          alerts: [
            {
              id: 1,
              machine_id: "haas-vf2-1",
              machine_name: "Haas VF-2 #1",
              kind: "feed_hold_extended",
              triggered_at: "2026-04-18T14:20:00Z",
              severity: "warning",
              message: "Feed hold for 12 min",
            },
          ],
        }),
        { status: 200 },
      ),
    ),
  );
});

it("renders open alerts", async () => {
  render(<MachineAlertsPanel />);
  await waitFor(() => {
    expect(screen.getByText(/Haas VF-2 #1/)).toBeInTheDocument();
    expect(screen.getByText(/Feed hold for 12 min/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Write `MachineAlertsPanel.tsx`**

```tsx
import { useEffect, useState } from "react";

type Alert = {
  id: number;
  machine_id: string;
  machine_name: string;
  kind: string;
  triggered_at: string;
  severity: "info" | "warning" | "fault";
  message: string;
};

export function MachineAlertsPanel(): JSX.Element {
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const r = await fetch("/api/machines/alerts");
      if (r.ok && alive) {
        const body = (await r.json()) as { alerts: Alert[] };
        setAlerts(body.alerts);
      }
    };
    tick();
    const iv = setInterval(tick, 10_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  if (alerts.length === 0) return <div className="machine-alerts machine-alerts--empty">No machine alerts</div>;

  return (
    <div className="machine-alerts">
      {alerts.map((a) => (
        <div key={a.id} className={`machine-alerts__row sev-${a.severity}`}>
          <span className="machine-alerts__machine">{a.machine_name}</span>
          <span className="machine-alerts__kind">{a.kind}</span>
          <span className="machine-alerts__msg">{a.message}</span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Add `/api/machines/alerts` to backend proxy**

Extend `src/api/machines.ts` with:

```typescript
machinesApi.get("/alerts", async (c) => {
  const upstream = await fetch(`${c.env.MTCONNECT_COLLECTOR_URL}/alerts`);
  if (!upstream.ok) return c.json({ error: "collector unavailable" }, 502);
  return new Response(await upstream.text(), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
```

- [ ] **Step 5: Run + commit.**

```bash
cd shop-floor-mes && npm test -- MachineAlertsPanel
git add frontend/src/components/MachineAlertsPanel.tsx src/api/machines.ts
git commit -m "feat(ui): machine alerts panel (open alerts polled from collector)"
```

---

## Part 10 — Live bring-up

### Task 33: Create production D1 and deploy cloud worker to staging

- [ ] **Step 1: Create the staging D1**

Run:

```bash
cd cloud
npx wrangler d1 create mtconnect-staging
```

Copy the `database_id` into `wrangler.jsonc` under `env.staging.d1_databases[0].database_id`.

- [ ] **Step 2: Apply migrations to staging**

```bash
npm run db:migrate:staging
```
Expected: 2 migrations applied.

- [ ] **Step 3: Set staging secrets**

```bash
npx wrangler secret put EDGE_SHARED_SECRET --env staging
npx wrangler secret put EDGE_TUNNEL_HOSTNAME --env staging
```

Use a 48-byte random hex for `EDGE_SHARED_SECRET`. Use the Cloudflare Tunnel hostname you'll assign in Task 35.

- [ ] **Step 4: Deploy**

```bash
npm run deploy:staging
```
Expected: deploys to `mtconnect-collector-staging.<your>.workers.dev`.

- [ ] **Step 5: Smoke test the live worker**

```bash
curl https://mtconnect-collector-staging.<your>.workers.dev/health
```
Expected: `{"ok":true,"service":"mtconnect-collector"}`

- [ ] **Step 6: Commit the `database_id` update.**

```bash
git add cloud/wrangler.jsonc
git commit -m "chore(cloud): wire staging D1 database id"
```

### Task 34: Enable MTConnect on the Haas + register machine

This task involves physical machine access and requires the controls tech (see verification email from Part A prereqs).

- [ ] **Step 1: At the machine (Haas NGC control):**
  - Settings → find MTConnect option (Setting 143 or current equivalent). Enable it.
  - Assign a static IP on the shop-floor monitoring VLAN.
  - Document firmware version, MTConnect port (typically 8082 per Haas docs — verify against the installed firmware).

- [ ] **Step 2: Verify from a laptop on the monitoring VLAN**

```bash
curl http://<haas-ip>:8082/probe
curl http://<haas-ip>:8082/current
```
Expected: MTConnect XML from the Haas's native agent.

- [ ] **Step 3: Register the machine in staging D1**

Run a one-shot SQL via wrangler:

```bash
cd cloud
npx wrangler d1 execute mtconnect-staging --env staging --remote --command "INSERT INTO machines (id, display_name, controller_kind, pool, ip, enabled, created_at, updated_at) VALUES ('haas-vf2-1', 'Haas VF-2 #1', 'haas-ngc', 'small-3-axis-mill', '<haas-ip>', 1, datetime('now'), datetime('now'))"
```

- [ ] **Step 4: Commit the machine registration procedure to the runbook** (Task 38).

### Task 35: Deploy edge stack to the NUC via Ansible

- [ ] **Step 1: Provision CF Tunnel**

In CF Zero Trust dashboard:

1. Create a Tunnel named `edge-drill-down`.
2. Under "Public Hostnames" add `edge.<your-zone>.com` → `http://localhost:8989`.
3. Copy the tunnel token.

- [ ] **Step 2: Set vault values**

```bash
cd edge/ansible
ansible-vault create group_vars/edge_boxes.vault.yml
# content: edge_shared_secret: "<48-byte hex, same as staging worker secret>"
# content: cloudflare_tunnel_token: "<token from step 1>"
```

- [ ] **Step 3: Update `group_vars/edge_boxes.yml` cloud_base_url**

```yaml
cloud_base_url: "https://mtconnect-collector-staging.<your>.workers.dev"
```

- [ ] **Step 4: Build the collector container image**

Build-and-push (locally for now):

```bash
cd edge/collector
podman build -t ghcr.io/ffmfg-tal/mtconnect-collector:0.1.0 .
podman push ghcr.io/ffmfg-tal/mtconnect-collector:0.1.0
```

(Needs a `Dockerfile` — add it: multi-stage, Python 3.12-slim, `pip install .`.)

Create `edge/collector/Dockerfile`:

```Dockerfile
FROM python:3.12-slim AS builder
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir --target=/install .

FROM python:3.12-slim
RUN useradd --uid 1000 collector
RUN mkdir -p /var/lib/collector && chown collector:collector /var/lib/collector
USER collector
COPY --from=builder /install /usr/local/lib/python3.12/site-packages
ENTRYPOINT ["python", "-m", "collector"]
```

Update `edge/compose/docker-compose.yaml` image tag to `:0.1.0`.

- [ ] **Step 5: Deploy**

```bash
cd edge/ansible
ansible-playbook -i inventory.yml playbook.yml --ask-vault-pass
```
Expected: NUC comes up with `mtconnect.service` running; `podman ps` shows `cppagent`, `collector`, `cloudflared` all running.

- [ ] **Step 6: Check local cppagent**

```bash
ssh deploy@edge01 curl -fsS http://127.0.0.1:5000/probe | head -20
```
Expected: MTConnect Devices XML with Haas device.

- [ ] **Step 7: Commit.**

```bash
git add edge/collector/Dockerfile edge/compose/docker-compose.yaml
git commit -m "feat(edge): production Dockerfile and v0.1.0 image tag"
```

### Task 36: End-to-end smoke test

- [ ] **Step 1: Trigger a state change on the Haas**

Physically press Cycle Start on a loaded program. Let it run 2 minutes. Press Feed Hold. Wait 1 minute. Reset.

- [ ] **Step 2: Observe in the staging D1**

```bash
cd cloud
npx wrangler d1 execute mtconnect-staging --env staging --remote --command "SELECT state, started_at, duration_seconds FROM state_intervals WHERE machine_id = 'haas-vf2-1' ORDER BY started_at DESC LIMIT 5"
```
Expected: ACTIVE, FEED_HOLD, STOPPED intervals with plausible durations.

- [ ] **Step 3: Observe in the MES**

Open `shop-floor-mes` → Machines tab. The Haas tile should show live state transitions within 15 seconds of each change (1-second ingest + up to 10s uploader poll + client polling).

- [ ] **Step 4: Trigger an alert**

Leave the machine in FEED_HOLD for 11 minutes. Observe:
- `alerts` table in staging D1 gets a row with `kind = 'feed_hold_extended'`.
- The MES alert panel shows the alert.

- [ ] **Step 5: Clear the alert**

Reset the machine. Observe:
- The alert's `cleared_at` is set within 1 minute.
- The MES alert panel no longer shows the alert.

- [ ] **Step 6: Drill-down**

In the MES, click the Haas tile → the view should fetch `/api/machines/haas-vf2-1/samples?from=…&to=…&signals=SpindleSpeed` and render spindle RPM curves for the last 30 minutes. Verify the data looks right.

- [ ] **Step 7: Document failures, if any, in the runbook.**

### Task 37: Production deploy

- [ ] **Step 1: Create production D1**

```bash
cd cloud
npx wrangler d1 create mtconnect
```

Copy id into `wrangler.jsonc` main block (not env.staging).

- [ ] **Step 2: Migrate + secret + deploy prod**

```bash
npm run db:migrate:prod
npx wrangler secret put EDGE_SHARED_SECRET
npx wrangler secret put EDGE_TUNNEL_HOSTNAME
npm run deploy
```

- [ ] **Step 3: Re-register the Haas in prod D1**

Same `INSERT INTO machines …` as Task 34 Step 3 but against the prod D1.

- [ ] **Step 4: Update Ansible `cloud_base_url` to prod URL + re-deploy**

```bash
cd edge/ansible
# edit group_vars/edge_boxes.yml
ansible-playbook -i inventory.yml playbook.yml --ask-vault-pass --tags services
```

- [ ] **Step 5: Re-run the Task 36 smoke tests against prod.**

- [ ] **Step 6: Commit.**

```bash
git add cloud/wrangler.jsonc edge/ansible/group_vars/edge_boxes.yml
git commit -m "chore: wire production D1 and edge cloud_base_url"
```

### Task 38: Runbooks

**Files:**
- Create: `docs/runbooks/add-new-machine.md`
- Create: `docs/runbooks/drill-down-usage.md`

- [ ] **Step 1: `docs/runbooks/add-new-machine.md`**

```markdown
# Add a new machine to the monitoring pipeline

## Before you start

- Machine has an Ethernet port on the shop-floor monitoring VLAN.
- Static IP assigned (coordinate with IT).
- Adapter path known:
  - Haas NGC: native MTConnect; port typically 8082.
  - Okuma OSP-P: Okuma App Suite MTConnect adapter (installed on HMI PC) OR custom THINC bridge (Phase B).
  - Siemens 840D sl: Sinumerik OPC UA Server option enabled (Phase C).

## Register in D1

```bash
cd cloud
npx wrangler d1 execute mtconnect --remote --command \
  "INSERT INTO machines (id, display_name, controller_kind, pool, ip, enabled, created_at, updated_at) \
   VALUES ('<id>', '<display_name>', '<controller_kind>', '<pool>', '<ip>', 1, datetime('now'), datetime('now'))"
```

## Add to cppagent config

1. Create `edge/cppagent/devices/<id>.xml` (see `haas-vf2-1.xml` as template).
2. Append adapter block to `edge/cppagent/agent.cfg`:

```
Adapters
{
  <AgentDevice>
  {
    Device = <AgentDevice>
    Url = http://<machine-ip>:<port>/current
    ReconnectInterval = 10000
  }
}
```

3. Update `edge/ansible/group_vars/edge_boxes.yml` machines list:

```yaml
machines:
  - id: <id>
    agent_device: <AgentDevice>
```

## Deploy

```bash
cd edge/ansible
ansible-playbook -i inventory.yml playbook.yml --ask-vault-pass --tags services
```

## Verify

- `curl http://<edge-ip>:5000/probe` on the monitoring VLAN shows the new device.
- `wrangler d1 execute mtconnect --remote --command "SELECT * FROM state_intervals WHERE machine_id = '<id>' LIMIT 5"` shows data within 2 minutes of any machine activity.
- MES Machines tab shows the new tile.
```

- [ ] **Step 2: `docs/runbooks/drill-down-usage.md`**

```markdown
# Drill-down: reading raw samples

## What it is

The cloud collector stores summaries (state intervals, minute rollups). Raw
1 Hz samples stay on the edge box's SQLite buffer for 30 days. Drill-down
lets a user fetch a time window of raw samples for a specific machine
without needing VPN access to the edge box.

## Request shape

```
GET /api/machines/<id>/samples?from=<iso>&to=<iso>&signals=<comma-separated>
```

Signal names match MTConnect DataItem types: `SpindleSpeed`, `Load`,
`PathFeedrate`.

Windows older than 30 days return HTTP 404 (data aged out of the edge buffer).

## Network path

```
MES client → shop-floor-mes worker /api/machines/.../samples
          → mtconnect-collector worker /proxy/edge/.../samples
          → (fetch via CF Tunnel) → edge drill-down server (127.0.0.1:8989)
          → local SQLite
```

## Troubleshooting

- 502 at cloud → cloudflared is down on the edge box. `ssh edge01 systemctl status mtconnect`.
- 404 from edge → window older than retention or machine_id typo.
- Slow (>5 s) → SQLite sweep running; check `collector` container logs.
```

- [ ] **Step 3: Commit.**

```bash
git add docs/runbooks/
git commit -m "docs: runbooks for adding a machine and drill-down usage"
```

---

## Phase A complete — verification checklist

- [ ] All cloud vitest suites green (`cd cloud && npm test`).
- [ ] All collector pytest suites green (`cd edge/collector && pytest`).
- [ ] `cd cloud && npm run type-check` clean.
- [ ] Staging end-to-end verified (Task 36).
- [ ] Production end-to-end verified (Task 37 Step 5).
- [ ] Haas shows live state transitions in the MES.
- [ ] `feed_hold_extended` alert fired and cleared correctly.
- [ ] Drill-down samples render in the MES.
- [ ] Edge box survives a reboot: run `ssh edge01 sudo reboot`, wait 2 min, verify stack is back up.
- [ ] Runbooks published and reviewed.

---

## Phase B / C / D — follow-on plans (separate documents)

Each subsequent phase will have its own plan document, written after Phase A is in production and has collected a week of real data for threshold tuning. Scope previews:

### Phase B (second Haas + Okuma)

- Add second Haas: one entry in `machines` table, one device XML in cppagent, one machines-list line in Ansible group vars, one adapter block in agent.cfg. Verifies multi-machine scale.
- Okuma integration: determine whether Okuma App Suite MTConnect adapter is available on the target machine. If yes, no new code — just adapter-block config. If no, write a THINC-API bridge on the Okuma HMI PC (Python + THINC DLL via .NET bridge, or C# adapter that emits SHDR to cppagent).
- Tune alert thresholds against one week of real Phase A data.

### Phase C (DN DVF 5000 + custom Siemens adapter)

- Write `edge/adapters/siemens_opcua/` — a Python package with its own test suite, consuming Sinumerik OPC UA via `asyncua`, emitting SHDR on a local socket for cppagent.
- Fallback path: `python-snap7` reading PLC tags if OPC UA option is not licensed.
- FreeOpcUa-based simulator harness for CI so the adapter can be tested with no real machine.
- Add `siemens-opcua-adapter` as a third service in `docker-compose.yaml`, one instance per machine (config-driven).
- Correct the ontology docs in `../contract-manufacturer-ontology/` (Doosan / DN Solutions / Siemens, not Mazak).

### Phase D (fleet coverage + pool-level features)

- Add DVF #2, remaining Okuma machines.
- Per-pool alert threshold overrides.
- Pool-level utilization bars on the MES scoreboard.
- Shift-rollup enhancements (effective capacity = gross × (1 − maintenance%) × (1 − downtime%) × (1 − setup_ratio%)).
- `WorkOrder` asset push (job correlation) deferred to a separate Phase E plan — turns on Performance and Quality legs of OEE by linking machine data to Fulcrum job/op UUIDs.
