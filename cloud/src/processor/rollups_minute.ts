export type ClosedInterval = {
  state:
    | "ACTIVE"
    | "FEED_HOLD"
    | "STOPPED"
    | "INTERRUPTED"
    | "READY"
    | "OFFLINE";
  started_at: string;
  ended_at: string;
  program: string | null;
  tool_number: string | null;
};

export type EventLite = {
  kind: string;
  ts: string;
  payload: Record<string, unknown>;
};

export type MinuteRollup = {
  minute_start: string;
  active_s: number;
  feed_hold_s: number;
  stopped_s: number;
  interrupted_s: number;
  ready_s: number;
  offline_s: number;
  part_delta: number;
  program: string | null;
  tool_number: string | null;
  avg_spindle_rpm: number | null;
  max_spindle_load: number | null;
  avg_feedrate: number | null;
};

const STATE_COL: Record<ClosedInterval["state"], keyof MinuteRollup> = {
  ACTIVE: "active_s",
  FEED_HOLD: "feed_hold_s",
  STOPPED: "stopped_s",
  INTERRUPTED: "interrupted_s",
  READY: "ready_s",
  OFFLINE: "offline_s",
};

function floorMinute(iso: string): string {
  const d = new Date(iso);
  d.setUTCSeconds(0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function addMinute(iso: string): string {
  const d = new Date(iso);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function deriveMinuteRollups(
  intervals: ClosedInterval[],
  events: EventLite[],
): Map<string, MinuteRollup> {
  const buckets = new Map<string, MinuteRollup>();

  function getOrCreate(minute: string): MinuteRollup {
    let b = buckets.get(minute);
    if (!b) {
      b = {
        minute_start: minute,
        active_s: 0,
        feed_hold_s: 0,
        stopped_s: 0,
        interrupted_s: 0,
        ready_s: 0,
        offline_s: 0,
        part_delta: 0,
        program: null,
        tool_number: null,
        avg_spindle_rpm: null,
        max_spindle_load: null,
        avg_feedrate: null,
      };
      buckets.set(minute, b);
    }
    return b;
  }

  for (const iv of intervals) {
    const startMs = Date.parse(iv.started_at);
    const endMs = Date.parse(iv.ended_at);
    let cur = floorMinute(iv.started_at);
    const lastMinute = floorMinute(iv.ended_at);

    while (true) {
      const minStart = Date.parse(cur);
      const minEnd = Date.parse(addMinute(cur));
      const segStart = Math.max(startMs, minStart);
      const segEnd = Math.min(endMs, minEnd);
      const segSeconds = (segEnd - segStart) / 1000;
      if (segSeconds > 0) {
        const b = getOrCreate(cur);
        const col = STATE_COL[iv.state];
        (b as unknown as Record<string, number>)[col] =
          ((b as unknown as Record<string, number>)[col] ?? 0) + segSeconds;
        b.program = iv.program ?? b.program;
        b.tool_number = iv.tool_number ?? b.tool_number;
      }
      if (cur === lastMinute) break;
      cur = addMinute(cur);
    }
  }

  for (const e of events) {
    if (e.kind === "part_completed") {
      const b = getOrCreate(floorMinute(e.ts));
      b.part_delta += 1;
    }
  }

  return buckets;
}
