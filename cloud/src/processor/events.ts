export type EventCursor = {
  lastProgram: string | null;
  lastTool: string | null;
  lastPartCount: number | null;
  lastEstop: string | null;
};

export type EventRecord = {
  ts: string;
  kind:
    | "program_change"
    | "tool_change"
    | "part_completed"
    | "estop"
    | "agent_restart";
  payload: Record<string, unknown>;
};

export type EventResult = {
  events: EventRecord[];
  newCursor: EventCursor;
};

type Obs = {
  sequence: number;
  timestamp_utc: string;
  data_item_id: string;
  value_str: string | null;
  value_num: number | null;
};

export function deriveEvents(
  observations: Obs[],
  dataItemTypes: Map<string, { type: string }>,
  cursor: EventCursor,
): EventResult {
  const events: EventRecord[] = [];
  const c = { ...cursor };

  for (const o of observations) {
    const t = dataItemTypes.get(o.data_item_id)?.type;
    if (!t) continue;

    if (t === "PROGRAM") {
      if (c.lastProgram !== null && c.lastProgram !== o.value_str) {
        events.push({
          ts: o.timestamp_utc,
          kind: "program_change",
          payload: { from: c.lastProgram, to: o.value_str },
        });
      }
      c.lastProgram = o.value_str;
    } else if (t === "TOOL_NUMBER" || t === "TOOL_ASSET_ID") {
      if (c.lastTool !== null && c.lastTool !== o.value_str) {
        events.push({
          ts: o.timestamp_utc,
          kind: "tool_change",
          payload: { from: c.lastTool, to: o.value_str },
        });
      }
      c.lastTool = o.value_str;
    } else if (t === "PART_COUNT") {
      const n = o.value_num;
      if (n !== null && c.lastPartCount !== null && n > c.lastPartCount) {
        const delta = n - c.lastPartCount;
        for (let i = 0; i < delta; i++) {
          events.push({
            ts: o.timestamp_utc,
            kind: "part_completed",
            payload: { count: c.lastPartCount + i + 1 },
          });
        }
      }
      if (n !== null) c.lastPartCount = n;
    } else if (t === "EMERGENCY_STOP") {
      if (
        c.lastEstop !== "TRIGGERED" &&
        (o.value_str ?? "").toUpperCase() === "TRIGGERED"
      ) {
        events.push({
          ts: o.timestamp_utc,
          kind: "estop",
          payload: {},
        });
      }
      c.lastEstop = o.value_str;
    }
  }

  return { events, newCursor: c };
}
