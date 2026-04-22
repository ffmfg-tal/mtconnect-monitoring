import { describe, it, expect } from "vitest";
import { scanAlerts, type AlertInput } from "../src/alerts/rules";

describe("scanAlerts", () => {
  it("fires feed_hold_extended when FEED_HOLD open > 10min", () => {
    const input: AlertInput = {
      nowUtc: "2026-04-22T10:15:00Z",
      openIntervals: [
        { state: "FEED_HOLD", started_at: "2026-04-22T10:00:00Z" },
      ],
      openConditions: [],
      latestObservationTs: "2026-04-22T10:14:55Z",
      recentEstop: false,
    };
    const r = scanAlerts(input);
    expect(r.map((a) => a.kind)).toContain("feed_hold_extended");
  });

  it("fires alarm_sustained when FAULT open > 2min", () => {
    const input: AlertInput = {
      nowUtc: "2026-04-22T10:03:00Z",
      openIntervals: [],
      openConditions: [
        {
          data_item_id: "logic",
          level: "FAULT",
          started_at: "2026-04-22T10:00:30Z",
        },
      ],
      latestObservationTs: "2026-04-22T10:02:55Z",
      recentEstop: false,
    };
    const r = scanAlerts(input);
    expect(r.map((a) => a.kind)).toContain("alarm_sustained");
  });

  it("fires offline when no observation in > 5min", () => {
    const input: AlertInput = {
      nowUtc: "2026-04-22T10:10:00Z",
      openIntervals: [],
      openConditions: [],
      latestObservationTs: "2026-04-22T10:03:00Z",
      recentEstop: false,
    };
    const r = scanAlerts(input);
    expect(r.map((a) => a.kind)).toContain("offline");
  });

  it("fires estop_triggered when recentEstop", () => {
    const input: AlertInput = {
      nowUtc: "2026-04-22T10:10:00Z",
      openIntervals: [],
      openConditions: [],
      latestObservationTs: "2026-04-22T10:09:59Z",
      recentEstop: true,
    };
    const r = scanAlerts(input);
    expect(r.map((a) => a.kind)).toContain("estop_triggered");
  });

  it("fires idle_during_shift when STOPPED > 20min and no FAULT", () => {
    const input: AlertInput = {
      nowUtc: "2026-04-22T10:30:00Z",
      openIntervals: [
        { state: "STOPPED", started_at: "2026-04-22T10:05:00Z" },
      ],
      openConditions: [],
      latestObservationTs: "2026-04-22T10:29:55Z",
      recentEstop: false,
    };
    const r = scanAlerts(input);
    expect(r.map((a) => a.kind)).toContain("idle_during_shift");
  });

  it("does not fire idle_during_shift if FAULT condition is open", () => {
    const input: AlertInput = {
      nowUtc: "2026-04-22T10:30:00Z",
      openIntervals: [
        { state: "STOPPED", started_at: "2026-04-22T10:05:00Z" },
      ],
      openConditions: [
        {
          data_item_id: "logic",
          level: "FAULT",
          started_at: "2026-04-22T10:05:00Z",
        },
      ],
      latestObservationTs: "2026-04-22T10:29:55Z",
      recentEstop: false,
    };
    const r = scanAlerts(input);
    expect(r.map((a) => a.kind)).not.toContain("idle_during_shift");
  });
});
