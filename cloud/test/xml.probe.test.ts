// cloud/test/xml.probe.test.ts
import { describe, it, expect } from "vitest";
import { parseProbe } from "../src/xml/probe";
// @ts-expect-error — vite ?raw import returns string
import fixture from "./fixtures/demo_probe.xml?raw";

describe("parseProbe", () => {
  it("extracts header metadata", () => {
    const result = parseProbe(fixture);
    expect(result.header.instanceId).toBeTruthy();
    expect(result.header.schemaVersion).toMatch(/^\d+\.\d+/);
  });

  it("extracts at least one device", () => {
    const result = parseProbe(fixture);
    expect(result.devices.length).toBeGreaterThan(0);
    const d = result.devices[0];
    expect(d.uuid).toBeTruthy();
    expect(d.name).toBeTruthy();
  });

  it("extracts data items with category and type", () => {
    const result = parseProbe(fixture);
    const allItems = result.devices.flatMap((d) => d.dataItems);
    expect(allItems.length).toBeGreaterThan(0);
    const exec = allItems.find((di) => di.type === "EXECUTION");
    expect(exec).toBeDefined();
    expect(exec!.category).toBe("EVENT");
    expect(exec!.id).toBeTruthy();
  });

  it("captures component path for each data item", () => {
    const result = parseProbe(fixture);
    const allItems = result.devices.flatMap((d) => d.dataItems);
    // every data item should have a non-empty component path
    expect(allItems.every((di) => di.componentPath.length > 0)).toBe(true);
  });
});
