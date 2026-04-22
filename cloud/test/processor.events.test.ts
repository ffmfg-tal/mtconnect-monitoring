// cloud/test/processor.events.test.ts
import { describe, it, expect } from "vitest";
import { deriveEvents } from "../src/processor/events";

const dataItemTypes = new Map([
  ["prog", { type: "PROGRAM" }],
  ["tool", { type: "TOOL_NUMBER" }],
  ["part", { type: "PART_COUNT" }],
  ["estop", { type: "EMERGENCY_STOP" }],
]);

describe("deriveEvents", () => {
  it("emits program_change when PROGRAM observation changes", () => {
    const r = deriveEvents(
      [
        {
          sequence: 1,
          timestamp_utc: "2026-04-22T10:00:00Z",
          data_item_id: "prog",
          value_str: "O1234",
          value_num: null,
        },
        {
          sequence: 2,
          timestamp_utc: "2026-04-22T10:01:00Z",
          data_item_id: "prog",
          value_str: "O5678",
          value_num: null,
        },
      ],
      dataItemTypes,
      {
        lastProgram: null,
        lastTool: null,
        lastPartCount: null,
        lastEstop: null,
      },
    );
    expect(r.events.some((e) => e.kind === "program_change")).toBe(true);
  });

  it("emits part_completed for positive PART_COUNT delta", () => {
    const r = deriveEvents(
      [
        {
          sequence: 1,
          timestamp_utc: "2026-04-22T10:00:00Z",
          data_item_id: "part",
          value_str: "42",
          value_num: 42,
        },
        {
          sequence: 2,
          timestamp_utc: "2026-04-22T10:05:00Z",
          data_item_id: "part",
          value_str: "44",
          value_num: 44,
        },
      ],
      dataItemTypes,
      {
        lastProgram: null,
        lastTool: null,
        lastPartCount: null,
        lastEstop: null,
      },
    );
    const parts = r.events.filter((e) => e.kind === "part_completed");
    expect(parts).toHaveLength(2);
  });

  it("emits estop only on TRIGGERED", () => {
    const r = deriveEvents(
      [
        {
          sequence: 1,
          timestamp_utc: "2026-04-22T10:00:00Z",
          data_item_id: "estop",
          value_str: "ARMED",
          value_num: null,
        },
        {
          sequence: 2,
          timestamp_utc: "2026-04-22T10:01:00Z",
          data_item_id: "estop",
          value_str: "TRIGGERED",
          value_num: null,
        },
        {
          sequence: 3,
          timestamp_utc: "2026-04-22T10:02:00Z",
          data_item_id: "estop",
          value_str: "ARMED",
          value_num: null,
        },
      ],
      dataItemTypes,
      {
        lastProgram: null,
        lastTool: null,
        lastPartCount: null,
        lastEstop: null,
      },
    );
    const e = r.events.filter((x) => x.kind === "estop");
    expect(e).toHaveLength(1);
    expect(e[0].ts).toBe("2026-04-22T10:01:00Z");
  });

  it("does not emit program_change on initial (null -> value) if seeded null", () => {
    const r = deriveEvents(
      [
        {
          sequence: 1,
          timestamp_utc: "2026-04-22T10:00:00Z",
          data_item_id: "prog",
          value_str: "O1",
          value_num: null,
        },
      ],
      dataItemTypes,
      {
        lastProgram: null,
        lastTool: null,
        lastPartCount: null,
        lastEstop: null,
      },
    );
    // initial observation sets cursor but does not emit
    expect(r.events.filter((e) => e.kind === "program_change")).toHaveLength(0);
  });
});
