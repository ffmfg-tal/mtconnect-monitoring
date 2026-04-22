import { XMLParser } from "fast-xml-parser";

export type ProbeDataItem = {
  id: string;
  name?: string;
  category: "SAMPLE" | "EVENT" | "CONDITION";
  type: string;
  subType?: string;
  units?: string;
  nativeUnits?: string;
  componentPath: string;
};

export type ProbeDevice = {
  uuid: string;
  name: string;
  model?: string;
  dataItems: ProbeDataItem[];
};

export type ProbeParseResult = {
  header: {
    instanceId: string;
    schemaVersion: string;
    creationTime: string;
  };
  devices: ProbeDevice[];
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  allowBooleanAttributes: true,
  isArray: (tagName) => {
    // tags that should always be arrays even with a single element
    return [
      "Device",
      "DataItem",
      "Components",
      "Axes",
      "Controller",
      "Path",
      "Linear",
      "Rotary",
      "Systems",
      "Auxiliaries",
      "Hydraulic",
      "Electric",
      "Pneumatic",
      "Coolant",
      "Lubrication",
    ].includes(tagName);
  },
});

export function parseProbe(xml: string): ProbeParseResult {
  const root = parser.parse(xml);
  const md = root.MTConnectDevices;
  const hdr = md.Header;

  const devices: ProbeDevice[] = [];
  const deviceArr = md.Devices?.Device ?? [];
  for (const d of deviceArr) {
    const dataItems: ProbeDataItem[] = [];
    collectDataItems(d, d["@_name"] ?? "", dataItems);
    devices.push({
      uuid: d["@_uuid"],
      name: d["@_name"],
      model: d["@_model"],
      dataItems,
    });
  }

  return {
    header: {
      instanceId: hdr["@_instanceId"],
      schemaVersion: hdr["@_schemaVersion"] ?? hdr["@_version"] ?? "",
      creationTime: hdr["@_creationTime"],
    },
    devices,
  };
}

function collectDataItems(
  node: Record<string, unknown>,
  path: string,
  out: ProbeDataItem[],
): void {
  const dis = (node as { DataItems?: { DataItem?: unknown[] } }).DataItems
    ?.DataItem;
  if (Array.isArray(dis)) {
    for (const di of dis as Array<Record<string, string>>) {
      out.push({
        id: di["@_id"],
        name: di["@_name"],
        category: di["@_category"] as "SAMPLE" | "EVENT" | "CONDITION",
        type: di["@_type"],
        subType: di["@_subType"],
        units: di["@_units"],
        nativeUnits: di["@_nativeUnits"],
        componentPath: path,
      });
    }
  }
  // recurse into any nested component tags
  // with isArray:["Components"], node.Components is an array of objects,
  // each object keyed by component-tag => array of child components.
  const components = (node as { Components?: unknown }).Components;
  const compArr = Array.isArray(components)
    ? components
    : components
      ? [components]
      : [];
  for (const compObj of compArr) {
    for (const [tag, children] of Object.entries(
      compObj as Record<string, unknown>,
    )) {
      // skip attribute-ish keys (shouldn't be any under Components, but be safe)
      if (tag.startsWith("@_")) continue;
      const childArr = Array.isArray(children) ? children : [children];
      for (const child of childArr as Array<Record<string, unknown>>) {
        if (!child || typeof child !== "object") continue;
        const name = (child as Record<string, string>)["@_name"] ?? tag;
        collectDataItems(child, `${path}/${name}`, out);
      }
    }
  }
}
