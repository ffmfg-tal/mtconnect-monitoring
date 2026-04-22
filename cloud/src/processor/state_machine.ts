export type NormalizedState =
  | "ACTIVE"
  | "FEED_HOLD"
  | "STOPPED"
  | "INTERRUPTED"
  | "READY"
  | "OFFLINE";

export type ObservationRow = {
  sequence: number;
  timestamp_utc: string;
  data_item_id: string;
  value_str: string | null;
  value_num: number | null;
  condition_level: string | null;
};

export type DataItemMeta = {
  type: string;
  category: string;
};

export type StateMachineCursor = {
  lastState: NormalizedState | null;
  lastStateStart: string | null;
  lastProgram: string | null;
  lastTool: string | null;
  lastControllerMode: string | null;
  // snapshot of program/tool/mode at the moment the current state was entered.
  // these are what get stamped onto the interval when it closes, so that
  // changes to program/tool while a state is ongoing don't rewrite the
  // interval's "entering" context.
  enteringProgram?: string | null;
  enteringTool?: string | null;
  enteringControllerMode?: string | null;
};

export type ClosedInterval = {
  state: NormalizedState;
  started_at: string;
  ended_at: string;
  program: string | null;
  tool_number: string | null;
  controller_mode: string | null;
};

export type StateMachineResult = {
  closedIntervals: ClosedInterval[];
  newState: StateMachineCursor;
};

const EXECUTION_MAP: Record<string, NormalizedState> = {
  ACTIVE: "ACTIVE",
  FEED_HOLD: "FEED_HOLD",
  INTERRUPTED: "INTERRUPTED",
  READY: "READY",
  STOPPED: "STOPPED",
  PROGRAM_STOPPED: "STOPPED",
  PROGRAM_COMPLETED: "STOPPED",
  OPTIONAL_STOP: "STOPPED",
  UNAVAILABLE: "OFFLINE",
};

export function deriveStateIntervals(
  observations: ObservationRow[],
  dataItemTypes: Map<string, DataItemMeta>,
  cursor: StateMachineCursor,
): StateMachineResult {
  const closed: ClosedInterval[] = [];
  let state = { ...cursor };

  for (const o of observations) {
    const meta = dataItemTypes.get(o.data_item_id);
    if (!meta) continue;

    if (meta.type === "PROGRAM") {
      state.lastProgram = o.value_str;
      continue;
    }
    if (meta.type === "TOOL_NUMBER" || meta.type === "TOOL_ASSET_ID") {
      state.lastTool = o.value_str;
      continue;
    }
    if (meta.type === "CONTROLLER_MODE") {
      state.lastControllerMode = o.value_str;
      continue;
    }
    if (meta.type === "EXECUTION") {
      const raw = (o.value_str ?? "UNAVAILABLE").toUpperCase();
      const next = EXECUTION_MAP[raw] ?? "OFFLINE";
      if (next !== state.lastState) {
        if (state.lastState !== null && state.lastStateStart !== null) {
          closed.push({
            state: state.lastState,
            started_at: state.lastStateStart,
            ended_at: o.timestamp_utc,
            program: state.enteringProgram ?? state.lastProgram,
            tool_number: state.enteringTool ?? state.lastTool,
            controller_mode:
              state.enteringControllerMode ?? state.lastControllerMode,
          });
        }
        state.lastState = next;
        state.lastStateStart = o.timestamp_utc;
        // snapshot context as of state entry
        state.enteringProgram = state.lastProgram;
        state.enteringTool = state.lastTool;
        state.enteringControllerMode = state.lastControllerMode;
      }
    }
  }

  return { closedIntervals: closed, newState: state };
}
