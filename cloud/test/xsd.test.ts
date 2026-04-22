import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error - libxmljs2 has no types
import libxml from "libxmljs2";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures");
const schemaDir = join(__dirname, "schemas");

function validate(xmlPath: string, xsdPath: string) {
  const xml = libxml.parseXml(readFileSync(xmlPath, "utf8"));
  const xsd = libxml.parseXml(readFileSync(xsdPath, "utf8"));
  const ok = xml.validate(xsd);
  return {
    ok,
    errors: xml.validationErrors?.map((err: Error) => err.message) ?? [],
  };
}

describe("MTConnect XSD validation", () => {
  // TODO: MTConnectDevices 2.7 XSD fails to compile in libxml2 with
  // "Invalid XSD schema" — likely an XSD 1.1 feature (vc:minVersion='1.1' is
  // set on the root schema element) that libxml2 does not support. The
  // parser stage succeeds; it's the schema compilation that fails. Until we
  // either (a) strip 1.1-only constructs at load time, (b) switch to a
  // full XSD 1.1 validator (e.g. xerces-j via a Java step in CI), or
  // (c) vendor the 1.0-compatible subset, skip this case.
  it.skip("demo_probe.xml validates against MTConnectDevices 2.7", () => {
    const r = validate(
      join(fixturesDir, "demo_probe.xml"),
      join(schemaDir, "MTConnectDevices_2.7.xsd"),
    );
    expect(r.ok, r.errors.join("\n")).toBe(true);
  });

  it("demo_sample_1m.xml validates against MTConnectStreams 2.7", () => {
    const r = validate(
      join(fixturesDir, "demo_sample_1m.xml"),
      join(schemaDir, "MTConnectStreams_2.7.xsd"),
    );
    expect(r.ok, r.errors.join("\n")).toBe(true);
  });
});
