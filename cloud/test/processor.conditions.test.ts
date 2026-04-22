// cloud/test/processor.conditions.test.ts
import { describe, it, expect } from "vitest";
import {
  deriveConditionTransitions,
  type ConditionObservation,
} from "../src/processor/conditions";

function cobs(
  seq: number,
  ts: string,
  id: string,
  level: string,
  opts: Partial<ConditionObservation> = {},
): ConditionObservation {
  return {
    sequence: seq,
    timestamp_utc: ts,
    data_item_id: id,
    condition_level: level as ConditionObservation["condition_level"],
    condition_native_code: opts.condition_native_code ?? null,
    condition_severity: opts.condition_severity ?? null,
    condition_qualifier: opts.condition_qualifier ?? null,
    message: opts.message ?? null,
  };
}

describe("deriveConditionTransitions", () => {
  it("opens a condition when level transitions NORMAL -> FAULT", () => {
    const r = deriveConditionTransitions(
      [
        cobs(1, "2026-04-22T10:00:00Z", "logic", "NORMAL"),
        cobs(2, "2026-04-22T10:01:00Z", "logic", "FAULT", {
          condition_native_code: "E50",
          message: "Spindle overload",
        }),
      ],
      new Map(),
    );
    expect(r.opens).toHaveLength(1);
    expect(r.opens[0]).toMatchObject({
      data_item_id: "logic",
      level: "FAULT",
      started_at: "2026-04-22T10:01:00Z",
      native_code: "E50",
      message: "Spindle overload",
    });
    expect(r.closes).toHaveLength(0);
  });

  it("closes an open condition when level returns to NORMAL", () => {
    const r = deriveConditionTransitions(
      [cobs(1, "2026-04-22T10:01:00Z", "logic", "NORMAL")],
      new Map([
        [
          "logic",
          { started_at: "2026-04-22T10:00:00Z", level: "FAULT" as const },
        ],
      ]),
    );
    expect(r.closes).toHaveLength(1);
    expect(r.closes[0]).toMatchObject({
      data_item_id: "logic",
      started_at: "2026-04-22T10:00:00Z",
      ended_at: "2026-04-22T10:01:00Z",
    });
  });

  it("replaces FAULT with different native_code (close old, open new)", () => {
    const r = deriveConditionTransitions(
      [
        cobs(1, "2026-04-22T10:02:00Z", "logic", "FAULT", {
          condition_native_code: "E51",
        }),
      ],
      new Map([
        [
          "logic",
          {
            started_at: "2026-04-22T10:00:00Z",
            level: "FAULT" as const,
            native_code: "E50",
          },
        ],
      ]),
    );
    expect(r.closes).toHaveLength(1);
    expect(r.opens).toHaveLength(1);
    expect(r.opens[0].native_code).toBe("E51");
  });

  it("ignores UNAVAILABLE -> UNAVAILABLE (no op)", () => {
    const r = deriveConditionTransitions(
      [
        cobs(1, "2026-04-22T10:00:00Z", "logic", "UNAVAILABLE"),
        cobs(2, "2026-04-22T10:01:00Z", "logic", "UNAVAILABLE"),
      ],
      new Map(),
    );
    expect(r.opens).toHaveLength(0);
    expect(r.closes).toHaveLength(0);
  });

  it("tracks separate channels per data_item_id", () => {
    const r = deriveConditionTransitions(
      [
        cobs(1, "2026-04-22T10:00:00Z", "logic", "FAULT", {
          condition_native_code: "E50",
        }),
        cobs(2, "2026-04-22T10:01:00Z", "motion", "WARNING", {
          condition_native_code: "W1",
        }),
      ],
      new Map(),
    );
    expect(r.opens).toHaveLength(2);
    expect(new Set(r.opens.map((o) => o.data_item_id))).toEqual(
      new Set(["logic", "motion"]),
    );
  });
});
