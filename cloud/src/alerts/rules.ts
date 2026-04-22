export type AlertKind =
  | "feed_hold_extended"
  | "idle_during_shift"
  | "alarm_sustained"
  | "offline"
  | "estop_triggered"
  | "spindle_overload";

export type AlertOut = {
  kind: AlertKind;
  severity: "warning" | "fault";
  triggered_at: string;
  message: string;
};

export type AlertInput = {
  nowUtc: string;
  openIntervals: Array<{
    state:
      | "ACTIVE"
      | "FEED_HOLD"
      | "STOPPED"
      | "INTERRUPTED"
      | "READY"
      | "OFFLINE";
    started_at: string;
  }>;
  openConditions: Array<{
    data_item_id: string;
    level: "WARNING" | "FAULT" | "UNAVAILABLE";
    started_at: string;
  }>;
  latestObservationTs: string | null;
  recentEstop: boolean;
};

function elapsedSeconds(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 1000;
}

export function scanAlerts(i: AlertInput): AlertOut[] {
  const out: AlertOut[] = [];

  for (const iv of i.openIntervals) {
    if (
      iv.state === "FEED_HOLD" &&
      elapsedSeconds(iv.started_at, i.nowUtc) > 600
    ) {
      out.push({
        kind: "feed_hold_extended",
        severity: "warning",
        triggered_at: iv.started_at,
        message: `Feed hold open > 10 min since ${iv.started_at}`,
      });
    }
    if (
      iv.state === "STOPPED" &&
      elapsedSeconds(iv.started_at, i.nowUtc) > 1200
    ) {
      const hasFault = i.openConditions.some((c) => c.level === "FAULT");
      if (!hasFault) {
        out.push({
          kind: "idle_during_shift",
          severity: "warning",
          triggered_at: iv.started_at,
          message: `Idle > 20 min since ${iv.started_at}`,
        });
      }
    }
  }

  for (const c of i.openConditions) {
    if (c.level === "FAULT" && elapsedSeconds(c.started_at, i.nowUtc) > 120) {
      out.push({
        kind: "alarm_sustained",
        severity: "fault",
        triggered_at: c.started_at,
        message: `Fault on ${c.data_item_id} sustained > 2 min`,
      });
    }
  }

  if (
    !i.latestObservationTs ||
    elapsedSeconds(i.latestObservationTs, i.nowUtc) > 300
  ) {
    out.push({
      kind: "offline",
      severity: "fault",
      triggered_at: i.latestObservationTs ?? i.nowUtc,
      message: "No observations in > 5 min",
    });
  }

  if (i.recentEstop) {
    out.push({
      kind: "estop_triggered",
      severity: "fault",
      triggered_at: i.nowUtc,
      message: "E-stop triggered",
    });
  }

  return out;
}
