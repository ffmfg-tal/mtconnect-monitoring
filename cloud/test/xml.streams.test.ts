// cloud/test/xml.streams.test.ts
import { describe, it, expect } from "vitest";
import { parseStreams } from "../src/xml/streams";
// @ts-expect-error — vite ?raw import returns string
import fixture from "./fixtures/demo_sample_1m.xml?raw";

describe("parseStreams", () => {
  it("extracts header with sequence cursors", () => {
    const r = parseStreams(fixture);
    expect(r.header.instanceId).toBeTruthy();
    expect(r.header.firstSequence).toBeGreaterThanOrEqual(0);
    expect(r.header.nextSequence).toBeGreaterThan(r.header.firstSequence);
    expect(r.header.lastSequence).toBeGreaterThanOrEqual(r.header.firstSequence);
  });

  it("extracts observations with device_uuid, sequence, timestamp, data_item_id, category", () => {
    const r = parseStreams(fixture);
    expect(r.observations.length).toBeGreaterThan(0);
    const o = r.observations[0];
    expect(o.deviceUuid).toBeTruthy();
    expect(typeof o.sequence).toBe("number");
    expect(o.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(o.dataItemId).toBeTruthy();
    expect(["SAMPLE", "EVENT", "CONDITION"]).toContain(o.category);
  });

  it("populates value_num for SAMPLE observations where numeric", () => {
    const r = parseStreams(fixture);
    const samples = r.observations.filter((o) => o.category === "SAMPLE");
    expect(samples.length).toBeGreaterThan(0);
    const numeric = samples.find(
      (s) => s.valueStr !== "UNAVAILABLE" && !isNaN(Number(s.valueStr)),
    );
    if (numeric) {
      expect(numeric.valueNum).not.toBeNull();
      expect(numeric.valueNum).not.toBeNaN();
    }
  });

  it("extracts condition observations with level", () => {
    const r = parseStreams(fixture);
    const conds = r.observations.filter((o) => o.category === "CONDITION");
    // demo usually has at least one NORMAL condition channel emitting
    for (const c of conds) {
      expect(["NORMAL", "WARNING", "FAULT", "UNAVAILABLE"]).toContain(
        c.conditionLevel,
      );
    }
  });
});
