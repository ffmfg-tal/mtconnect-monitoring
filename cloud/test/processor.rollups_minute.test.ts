// cloud/test/processor.rollups_minute.test.ts
import { describe, it, expect } from "vitest";
import {
  deriveMinuteRollups,
  type ClosedInterval,
} from "../src/processor/rollups_minute";

const iv = (
  state: string,
  start: string,
  end: string,
  prog: string | null = "O1",
  tool: string | null = "7",
): ClosedInterval => ({
  state: state as ClosedInterval["state"],
  started_at: start,
  ended_at: end,
  program: prog,
  tool_number: tool,
});

describe("deriveMinuteRollups", () => {
  it("attributes a 30s ACTIVE interval entirely to its bucket", () => {
    const r = deriveMinuteRollups(
      [iv("ACTIVE", "2026-04-22T10:00:15Z", "2026-04-22T10:00:45Z")],
      [],
    );
    expect(r.size).toBe(1);
    const row = r.get("2026-04-22T10:00:00Z")!;
    expect(row.active_s).toBe(30);
    expect(row.program).toBe("O1");
  });

  it("splits a 90s interval across 2 buckets correctly", () => {
    const r = deriveMinuteRollups(
      [iv("ACTIVE", "2026-04-22T10:00:30Z", "2026-04-22T10:02:00Z")],
      [],
    );
    expect(r.size).toBe(2);
    expect(r.get("2026-04-22T10:00:00Z")!.active_s).toBe(30);
    expect(r.get("2026-04-22T10:01:00Z")!.active_s).toBe(60);
  });

  it("handles intervals across 3+ buckets (edge-to-edge)", () => {
    const r = deriveMinuteRollups(
      [iv("ACTIVE", "2026-04-22T10:00:30Z", "2026-04-22T10:03:10Z")],
      [],
    );
    expect(r.size).toBe(4);
    expect(r.get("2026-04-22T10:00:00Z")!.active_s).toBe(30);
    expect(r.get("2026-04-22T10:01:00Z")!.active_s).toBe(60);
    expect(r.get("2026-04-22T10:02:00Z")!.active_s).toBe(60);
    expect(r.get("2026-04-22T10:03:00Z")!.active_s).toBe(10);
  });

  it("attributes state seconds by state column", () => {
    const r = deriveMinuteRollups(
      [
        iv("ACTIVE", "2026-04-22T10:00:00Z", "2026-04-22T10:00:30Z"),
        iv("FEED_HOLD", "2026-04-22T10:00:30Z", "2026-04-22T10:00:45Z"),
        iv("STOPPED", "2026-04-22T10:00:45Z", "2026-04-22T10:01:00Z"),
      ],
      [],
    );
    const row = r.get("2026-04-22T10:00:00Z")!;
    expect(row.active_s).toBe(30);
    expect(row.feed_hold_s).toBe(15);
    expect(row.stopped_s).toBe(15);
  });

  it("accumulates part_delta from part_completed events", () => {
    const r = deriveMinuteRollups(
      [iv("ACTIVE", "2026-04-22T10:00:00Z", "2026-04-22T10:02:00Z")],
      [
        { kind: "part_completed", ts: "2026-04-22T10:00:30Z", payload: {} },
        { kind: "part_completed", ts: "2026-04-22T10:01:15Z", payload: {} },
        { kind: "part_completed", ts: "2026-04-22T10:01:45Z", payload: {} },
      ],
    );
    expect(r.get("2026-04-22T10:00:00Z")!.part_delta).toBe(1);
    expect(r.get("2026-04-22T10:01:00Z")!.part_delta).toBe(2);
  });
});
