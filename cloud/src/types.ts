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
