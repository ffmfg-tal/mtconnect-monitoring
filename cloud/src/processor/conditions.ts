export type ConditionLevel = "NORMAL" | "WARNING" | "FAULT" | "UNAVAILABLE";

export type ConditionObservation = {
  sequence: number;
  timestamp_utc: string;
  data_item_id: string;
  condition_level: ConditionLevel;
  condition_native_code: string | null;
  condition_severity: string | null;
  condition_qualifier: string | null;
  message: string | null;
};

export type OpenCondition = {
  started_at: string;
  level: "WARNING" | "FAULT" | "UNAVAILABLE";
  native_code?: string | null;
};

export type ConditionOpen = {
  data_item_id: string;
  started_at: string;
  level: "WARNING" | "FAULT" | "UNAVAILABLE";
  native_code: string | null;
  severity: string | null;
  qualifier: string | null;
  message: string | null;
};

export type ConditionClose = {
  data_item_id: string;
  started_at: string;
  ended_at: string;
};

export type ConditionResult = {
  opens: ConditionOpen[];
  closes: ConditionClose[];
  newOpen: Map<string, OpenCondition>;
};

export function deriveConditionTransitions(
  observations: ConditionObservation[],
  currentlyOpen: Map<string, OpenCondition>,
): ConditionResult {
  const opens: ConditionOpen[] = [];
  const closes: ConditionClose[] = [];
  const open = new Map(currentlyOpen);

  for (const o of observations) {
    const existing = open.get(o.data_item_id);

    if (o.condition_level === "NORMAL") {
      if (existing) {
        closes.push({
          data_item_id: o.data_item_id,
          started_at: existing.started_at,
          ended_at: o.timestamp_utc,
        });
        open.delete(o.data_item_id);
      }
      continue;
    }

    // UNAVAILABLE: don't start tracking an open condition from a nothing-state.
    // If there's already something open, a transition to UNAVAILABLE is
    // ambiguous - treat as no-op (keep the prior open, let NORMAL close it).
    if (o.condition_level === "UNAVAILABLE") {
      continue;
    }

    // non-NORMAL, non-UNAVAILABLE (WARNING or FAULT)
    const sameLevel = existing?.level === o.condition_level;
    const sameCode =
      (existing?.native_code ?? null) === (o.condition_native_code ?? null);
    if (existing && sameLevel && sameCode) continue;

    if (existing) {
      closes.push({
        data_item_id: o.data_item_id,
        started_at: existing.started_at,
        ended_at: o.timestamp_utc,
      });
    }
    opens.push({
      data_item_id: o.data_item_id,
      started_at: o.timestamp_utc,
      level: o.condition_level,
      native_code: o.condition_native_code,
      severity: o.condition_severity,
      qualifier: o.condition_qualifier,
      message: o.message,
    });
    open.set(o.data_item_id, {
      started_at: o.timestamp_utc,
      level: o.condition_level,
      native_code: o.condition_native_code,
    });
  }

  return { opens, closes, newOpen: open };
}
