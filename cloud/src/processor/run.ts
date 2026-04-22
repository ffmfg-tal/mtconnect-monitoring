import type { Env } from "../types";
import {
  deriveStateIntervals,
  type StateMachineCursor,
  type ObservationRow,
  type DataItemMeta,
} from "./state_machine";
import {
  deriveConditionTransitions,
  type OpenCondition,
  type ConditionObservation,
} from "./conditions";
import { deriveEvents, type EventCursor } from "./events";
import { deriveMinuteRollups } from "./rollups_minute";

const EMPTY_STATE_CURSOR: StateMachineCursor = {
  lastState: null,
  lastStateStart: null,
  lastProgram: null,
  lastTool: null,
  lastControllerMode: null,
  enteringProgram: null,
  enteringTool: null,
  enteringControllerMode: null,
};

const EMPTY_EVENT_CURSOR: EventCursor = {
  lastProgram: null,
  lastTool: null,
  lastPartCount: null,
  lastEstop: null,
};

export async function runProcessor(env: Env): Promise<void> {
  const devices = await env.DB.prepare(
    "SELECT device_uuid FROM devices",
  ).all<{ device_uuid: string }>();

  for (const d of devices.results) {
    await processDevice(env, d.device_uuid);
  }
}

async function processDevice(env: Env, deviceUuid: string): Promise<void> {
  // Load all cursor rows
  const cur = await env.DB.prepare(
    "SELECT stream, last_sequence, state_json FROM processor_cursors WHERE device_uuid = ?",
  )
    .bind(deviceUuid)
    .all<{
      stream: string;
      last_sequence: number;
      state_json: string | null;
    }>();

  const seqByStream: Record<string, number> = {};
  const stateByStream: Record<string, string | null> = {};
  for (const r of cur.results) {
    seqByStream[r.stream] = r.last_sequence;
    stateByStream[r.stream] = r.state_json;
  }

  const stateSince = seqByStream["state_machine"] ?? 0;
  const condSince = seqByStream["conditions"] ?? 0;
  const eventSince = seqByStream["events"] ?? 0;
  const rollupSince = seqByStream["rollups_minute"] ?? 0;
  const minSince = Math.min(stateSince, condSince, eventSince, rollupSince);

  // Data items lookup
  const diRes = await env.DB.prepare(
    "SELECT data_item_id, category, type FROM data_items WHERE device_uuid = ?",
  )
    .bind(deviceUuid)
    .all<{ data_item_id: string; category: string; type: string }>();
  const dataItemMeta = new Map<string, DataItemMeta>(
    diRes.results.map((r) => [
      r.data_item_id,
      { type: r.type, category: r.category },
    ]),
  );
  const dataItemTypesOnly = new Map<string, { type: string }>(
    diRes.results.map((r) => [r.data_item_id, { type: r.type }]),
  );

  // Load observations since the oldest cursor
  const obsRes = await env.DB.prepare(
    `SELECT sequence, timestamp_utc, data_item_id, value_num, value_str,
            condition_level, condition_native_code, condition_severity, condition_qualifier
     FROM observations WHERE device_uuid = ? AND sequence > ? ORDER BY sequence ASC LIMIT 5000`,
  )
    .bind(deviceUuid, minSince)
    .all<{
      sequence: number;
      timestamp_utc: string;
      data_item_id: string;
      value_num: number | null;
      value_str: string | null;
      condition_level: string | null;
      condition_native_code: string | null;
      condition_severity: string | null;
      condition_qualifier: string | null;
    }>();
  if (obsRes.results.length === 0) return;

  const observations: ObservationRow[] = obsRes.results.map((r) => ({
    sequence: r.sequence,
    timestamp_utc: r.timestamp_utc,
    data_item_id: r.data_item_id,
    value_num: r.value_num,
    value_str: r.value_str,
    condition_level: r.condition_level,
  }));

  // --- state machine
  const smObs = observations.filter((o) => o.sequence > stateSince);
  const smCursor = parseStateCursor(stateByStream["state_machine_state"]);
  const sm = deriveStateIntervals(smObs, dataItemMeta, smCursor);

  // --- conditions
  const condObs: ConditionObservation[] = obsRes.results
    .filter((r) => r.sequence > condSince && r.condition_level !== null)
    .map((r) => ({
      sequence: r.sequence,
      timestamp_utc: r.timestamp_utc,
      data_item_id: r.data_item_id,
      condition_level: r.condition_level as ConditionObservation["condition_level"],
      condition_native_code: r.condition_native_code,
      condition_severity: r.condition_severity,
      condition_qualifier: r.condition_qualifier,
      message: r.value_str,
    }));
  const openCondMap = await loadOpenConditions(env, deviceUuid);
  const cond = deriveConditionTransitions(condObs, openCondMap);

  // --- events
  const evObs = observations.filter((o) => o.sequence > eventSince);
  const evCursor = parseEventCursor(stateByStream["event_cursor"]);
  const ev = deriveEvents(evObs, dataItemTypesOnly, evCursor);

  // --- rollups: feed freshly closed intervals (from this run) + recent events
  const rollupBuckets = deriveMinuteRollups(sm.closedIntervals, ev.events);

  // Writes
  const stmts: D1PreparedStatement[] = [];
  for (const iv of sm.closedIntervals) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO state_intervals (device_uuid, started_at, ended_at, state, program, tool_number, controller_mode)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (device_uuid, started_at) DO NOTHING`,
      ).bind(
        deviceUuid,
        iv.started_at,
        iv.ended_at,
        iv.state,
        iv.program ?? null,
        iv.tool_number ?? null,
        iv.controller_mode ?? null,
      ),
    );
  }
  for (const op of cond.opens) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO conditions (device_uuid, data_item_id, started_at, level, native_code, severity, qualifier, message)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT (device_uuid, data_item_id, started_at) DO NOTHING`,
      ).bind(
        deviceUuid,
        op.data_item_id,
        op.started_at,
        op.level,
        op.native_code,
        op.severity,
        op.qualifier,
        op.message,
      ),
    );
  }
  for (const cl of cond.closes) {
    stmts.push(
      env.DB.prepare(
        "UPDATE conditions SET ended_at = ? WHERE device_uuid = ? AND data_item_id = ? AND started_at = ?",
      ).bind(cl.ended_at, deviceUuid, cl.data_item_id, cl.started_at),
    );
  }
  for (const eRec of ev.events) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO events (device_uuid, ts, kind, payload_json) VALUES (?,?,?,?)
         ON CONFLICT (device_uuid, ts, kind) DO NOTHING`,
      ).bind(deviceUuid, eRec.ts, eRec.kind, JSON.stringify(eRec.payload)),
    );
  }
  for (const b of rollupBuckets.values()) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO rollups_minute (device_uuid, minute_start, active_s, feed_hold_s, stopped_s, interrupted_s, ready_s, offline_s, part_delta, program, tool_number, avg_spindle_rpm, max_spindle_load, avg_feedrate)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (device_uuid, minute_start) DO UPDATE SET
           active_s = rollups_minute.active_s + excluded.active_s,
           feed_hold_s = rollups_minute.feed_hold_s + excluded.feed_hold_s,
           stopped_s = rollups_minute.stopped_s + excluded.stopped_s,
           interrupted_s = rollups_minute.interrupted_s + excluded.interrupted_s,
           ready_s = rollups_minute.ready_s + excluded.ready_s,
           offline_s = rollups_minute.offline_s + excluded.offline_s,
           part_delta = rollups_minute.part_delta + excluded.part_delta,
           program = COALESCE(excluded.program, rollups_minute.program),
           tool_number = COALESCE(excluded.tool_number, rollups_minute.tool_number)`,
      ).bind(
        deviceUuid,
        b.minute_start,
        b.active_s,
        b.feed_hold_s,
        b.stopped_s,
        b.interrupted_s,
        b.ready_s,
        b.offline_s,
        b.part_delta,
        b.program,
        b.tool_number,
        b.avg_spindle_rpm,
        b.max_spindle_load,
        b.avg_feedrate,
      ),
    );
  }

  // Advance cursors to highest sequence seen
  const maxSeq = observations.at(-1)!.sequence;
  const now = new Date().toISOString();
  for (const stream of [
    "state_machine",
    "conditions",
    "events",
    "rollups_minute",
  ]) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO processor_cursors (device_uuid, stream, last_sequence, last_run_at)
         VALUES (?,?,?,?)
         ON CONFLICT (device_uuid, stream) DO UPDATE SET
           last_sequence = excluded.last_sequence,
           last_run_at = excluded.last_run_at`,
      ).bind(deviceUuid, stream, maxSeq, now),
    );
  }

  // Persist cursor state as JSON in state_json column (pseudo-streams)
  stmts.push(
    env.DB.prepare(
      `INSERT INTO processor_cursors (device_uuid, stream, last_sequence, last_run_at, state_json)
       VALUES (?, 'state_machine_state', ?, ?, ?)
       ON CONFLICT (device_uuid, stream) DO UPDATE SET
         last_sequence = excluded.last_sequence,
         last_run_at = excluded.last_run_at,
         state_json = excluded.state_json`,
    ).bind(deviceUuid, maxSeq, now, JSON.stringify(sm.newState)),
  );
  stmts.push(
    env.DB.prepare(
      `INSERT INTO processor_cursors (device_uuid, stream, last_sequence, last_run_at, state_json)
       VALUES (?, 'event_cursor', ?, ?, ?)
       ON CONFLICT (device_uuid, stream) DO UPDATE SET
         last_sequence = excluded.last_sequence,
         last_run_at = excluded.last_run_at,
         state_json = excluded.state_json`,
    ).bind(deviceUuid, maxSeq, now, JSON.stringify(ev.newCursor)),
  );

  await env.DB.batch(stmts);
}

function parseStateCursor(raw: string | null | undefined): StateMachineCursor {
  if (!raw) return { ...EMPTY_STATE_CURSOR };
  try {
    const parsed = JSON.parse(raw) as Partial<StateMachineCursor>;
    return { ...EMPTY_STATE_CURSOR, ...parsed };
  } catch {
    return { ...EMPTY_STATE_CURSOR };
  }
}

function parseEventCursor(raw: string | null | undefined): EventCursor {
  if (!raw) return { ...EMPTY_EVENT_CURSOR };
  try {
    const parsed = JSON.parse(raw) as Partial<EventCursor>;
    return { ...EMPTY_EVENT_CURSOR, ...parsed };
  } catch {
    return { ...EMPTY_EVENT_CURSOR };
  }
}

async function loadOpenConditions(
  env: Env,
  deviceUuid: string,
): Promise<Map<string, OpenCondition>> {
  const res = await env.DB.prepare(
    "SELECT data_item_id, started_at, level, native_code FROM conditions WHERE device_uuid = ? AND ended_at IS NULL",
  )
    .bind(deviceUuid)
    .all<{
      data_item_id: string;
      started_at: string;
      level: string;
      native_code: string | null;
    }>();
  const m = new Map<string, OpenCondition>();
  for (const r of res.results) {
    m.set(r.data_item_id, {
      started_at: r.started_at,
      level: r.level as OpenCondition["level"],
      native_code: r.native_code,
    });
  }
  return m;
}
