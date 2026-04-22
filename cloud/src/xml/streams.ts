import { XMLParser } from "fast-xml-parser";

export type ParsedObservation = {
  deviceUuid: string;
  sequence: number;
  timestamp: string;
  dataItemId: string;
  category: "SAMPLE" | "EVENT" | "CONDITION";
  type: string;
  subType?: string;
  valueNum: number | null;
  valueStr: string | null;
  conditionLevel?: "NORMAL" | "WARNING" | "FAULT" | "UNAVAILABLE";
  conditionNativeCode?: string;
  conditionSeverity?: string;
  conditionQualifier?: string;
};

export type StreamsParseResult = {
  header: {
    instanceId: string;
    firstSequence: number;
    lastSequence: number;
    nextSequence: number;
    schemaVersion: string;
    creationTime: string;
  };
  observations: ParsedObservation[];
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  allowBooleanAttributes: true,
  preserveOrder: false,
  textNodeName: "#text",
  isArray: (tagName) => {
    // every known observation-bearing tag should be an array
    if (["DeviceStream", "ComponentStream"].includes(tagName)) return true;
    return false;
  },
});

// categories map from XML parent container name to MTConnect category
const CATEGORY_PARENTS: Record<string, "SAMPLE" | "EVENT" | "CONDITION"> = {
  Samples: "SAMPLE",
  Events: "EVENT",
  Condition: "CONDITION",
};

const CONDITION_LEVEL_TAGS = ["Normal", "Warning", "Fault", "Unavailable"];

export function parseStreams(xml: string): StreamsParseResult {
  const root = parser.parse(xml);
  const ms = root.MTConnectStreams;
  const hdr = ms.Header;

  const observations: ParsedObservation[] = [];

  const devStreams = ms.Streams?.DeviceStream ?? [];
  const devArr = Array.isArray(devStreams) ? devStreams : [devStreams];

  for (const ds of devArr) {
    const deviceUuid = ds["@_uuid"];
    const compStreams = ds.ComponentStream ?? [];
    const compArr = Array.isArray(compStreams) ? compStreams : [compStreams];
    for (const cs of compArr) {
      for (const [parentTag, inner] of Object.entries(cs)) {
        if (!(parentTag in CATEGORY_PARENTS)) continue;
        const category = CATEGORY_PARENTS[parentTag];
        collectFromCategoryNode(deviceUuid, category, inner, observations);
      }
    }
  }

  return {
    header: {
      instanceId: hdr["@_instanceId"],
      firstSequence: Number(hdr["@_firstSequence"]),
      lastSequence: Number(hdr["@_lastSequence"]),
      nextSequence: Number(hdr["@_nextSequence"]),
      schemaVersion: hdr["@_schemaVersion"] ?? hdr["@_version"] ?? "",
      creationTime: hdr["@_creationTime"],
    },
    observations,
  };
}

function collectFromCategoryNode(
  deviceUuid: string,
  category: "SAMPLE" | "EVENT" | "CONDITION",
  node: unknown,
  out: ParsedObservation[],
): void {
  if (node === null || node === undefined) return;
  // node is { TagName: [items] or item, ... }
  for (const [tag, value] of Object.entries(node as Record<string, unknown>)) {
    const arr = Array.isArray(value) ? value : [value];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, string>;
      if (category === "CONDITION") {
        // tag is the level (Normal|Warning|Fault|Unavailable)
        if (!CONDITION_LEVEL_TAGS.includes(tag)) continue;
        out.push({
          deviceUuid,
          sequence: Number(it["@_sequence"]),
          timestamp: it["@_timestamp"],
          dataItemId: it["@_dataItemId"],
          category: "CONDITION",
          type: it["@_type"] ?? "",
          subType: it["@_subType"],
          valueNum: null,
          valueStr: (it as Record<string, string>)["#text"] ?? null,
          conditionLevel: tag.toUpperCase() as
            | "NORMAL"
            | "WARNING"
            | "FAULT"
            | "UNAVAILABLE",
          conditionNativeCode: it["@_nativeCode"],
          conditionSeverity: it["@_nativeSeverity"],
          conditionQualifier: it["@_qualifier"],
        });
      } else {
        const text = (it as Record<string, string>)["#text"];
        const valueStr = text ?? (typeof item === "string" ? item : null);
        const valueNum =
          valueStr !== null && valueStr !== "UNAVAILABLE"
            ? parseFloatOrNull(valueStr)
            : null;
        out.push({
          deviceUuid,
          sequence: Number(it["@_sequence"]),
          timestamp: it["@_timestamp"],
          dataItemId: it["@_dataItemId"],
          category,
          type: tag,
          subType: it["@_subType"],
          valueNum,
          valueStr,
        });
      }
    }
  }
}

function parseFloatOrNull(s: string): number | null {
  const n = Number(s);
  return isNaN(n) ? null : n;
}
