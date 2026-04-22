// cloud/test/processor.state_machine.test.ts
import { describe, it, expect } from "vitest";
import {
  deriveStateIntervals,
  type ObservationRow,
} from "../src/processor/state_machine";

function obs(
  seq: number,
  ts: string,
  dataItemId: string,
  value: string,
): ObservationRow {
  return {
    sequence: seq,
    timestamp_utc: ts,
    data_item_id: dataItemId,
    value_str: value,
    value_num: null,
    condition_level: null,
  };
}

describe("deriveStateIntervals", () => {
  const dataItemTypes = new Map([
    ["exec", { type: "EXECUTION", category: "EVENT" }],
    ["mode", { type: "CONTROLLER_MODE", category: "EVENT" }],
    ["avail", { type: "AVAILABILITY", category: "EVENT" }],
    ["prog", { type: "PROGRAM", category: "EVENT" }],
    ["tool", { type: "TOOL_NUMBER", category: "EVENT" }],
  ]);

  it("emits nothing if only one observation", () => {
    const r = deriveStateIntervals(
      [obs(1, "2026-04-22T10:00:00Z", "exec", "ACTIVE")],
      dataItemTypes,
      {
        lastState: null,
        lastProgram: null,
        lastTool: null,
        lastControllerMode: null,
        lastStateStart: null,
      },
    );
    expect(r.closedIntervals).toHaveLength(0);
  });

  it("emits a closed interval on state transition", () => {
    const r = deriveStateIntervals(
      [
        obs(1, "2026-04-22T10:00:00Z", "exec", "ACTIVE"),
        obs(2, "2026-04-22T10:00:30Z", "exec", "FEED_HOLD"),
      ],
      dataItemTypes,
      {
        lastState: null,
        lastProgram: null,
        lastTool: null,
        lastControllerMode: null,
        lastStateStart: null,
      },
    );
    expect(r.closedIntervals).toHaveLength(1);
    expect(r.closedIntervals[0].state).toBe("ACTIVE");
    expect(r.closedIntervals[0].started_at).toBe("2026-04-22T10:00:00Z");
    expect(r.closedIntervals[0].ended_at).toBe("2026-04-22T10:00:30Z");
  });

  it("normalizes PROGRAM_STOPPED and READY to STOPPED and READY separately", () => {
    const r = deriveStateIntervals(
      [
        obs(1, "2026-04-22T10:00:00Z", "exec", "READY"),
        obs(2, "2026-04-22T10:01:00Z", "exec", "ACTIVE"),
        obs(3, "2026-04-22T10:02:00Z", "exec", "PROGRAM_STOPPED"),
        obs(4, "2026-04-22T10:03:00Z", "exec", "READY"),
      ],
      dataItemTypes,
      {
        lastState: null,
        lastProgram: null,
        lastTool: null,
        lastControllerMode: null,
        lastStateStart: null,
      },
    );
    expect(r.closedIntervals.map((i) => i.state)).toEqual([
      "READY",
      "ACTIVE",
      "STOPPED",
    ]);
  });

  it("captures program and tool number at state entry", () => {
    const r = deriveStateIntervals(
      [
        obs(1, "2026-04-22T10:00:00Z", "prog", "O1234"),
        obs(2, "2026-04-22T10:00:00Z", "tool", "7"),
        obs(3, "2026-04-22T10:00:00Z", "exec", "ACTIVE"),
        obs(4, "2026-04-22T10:01:00Z", "prog", "O5678"),
        obs(5, "2026-04-22T10:02:00Z", "exec", "READY"),
      ],
      dataItemTypes,
      {
        lastState: null,
        lastProgram: null,
        lastTool: null,
        lastControllerMode: null,
        lastStateStart: null,
      },
    );
    const active = r.closedIntervals.find((i) => i.state === "ACTIVE");
    expect(active).toBeDefined();
    expect(active!.program).toBe("O1234");
    expect(active!.tool_number).toBe("7");
  });

  it("maps UNAVAILABLE execution to OFFLINE", () => {
    const r = deriveStateIntervals(
      [
        obs(1, "2026-04-22T10:00:00Z", "exec", "ACTIVE"),
        obs(2, "2026-04-22T10:01:00Z", "exec", "UNAVAILABLE"),
        obs(3, "2026-04-22T10:02:00Z", "exec", "READY"),
      ],
      dataItemTypes,
      {
        lastState: null,
        lastProgram: null,
        lastTool: null,
        lastControllerMode: null,
        lastStateStart: null,
      },
    );
    expect(r.closedIntervals.map((i) => i.state)).toEqual([
      "ACTIVE",
      "OFFLINE",
    ]);
  });

  it("returns open-state hint (no interval emitted) when state is still current", () => {
    const r = deriveStateIntervals(
      [obs(1, "2026-04-22T10:00:00Z", "exec", "ACTIVE")],
      dataItemTypes,
      {
        lastState: null,
        lastProgram: null,
        lastTool: null,
        lastControllerMode: null,
        lastStateStart: null,
      },
    );
    expect(r.newState.lastState).toBe("ACTIVE");
    expect(r.newState.lastStateStart).toBe("2026-04-22T10:00:00Z");
  });
});
