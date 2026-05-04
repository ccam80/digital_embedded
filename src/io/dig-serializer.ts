/**
 * .dig XML serializer- converts a Circuit back to Digital's XML format.
 *
 * Reverse of dig-loader.ts:
 *   Circuit → reverse attribute mappings → DigEntry[] → XML string
 *
 * Positions are converted from grid units back to Java pixel coordinates
 * (grid × DIG_SIZE where DIG_SIZE = 20).
 */

import type { Circuit, Wire } from "../core/circuit.js";
import type { CircuitElement } from "../core/element.js";
import type { ComponentRegistry } from "../core/registry.js";
import type { PropertyValue } from "../core/properties.js";
import { getUnmapped } from "./attribute-map.js";
import type { DigValue } from "./dig-schema.js";

/**
 * Java Digital's grid unit size in pixels. We multiply grid units by this
 * to produce .dig-compatible pixel coordinates.
 */
const DIG_SIZE = 20;

// ---------------------------------------------------------------------------
// XML escaping
// ---------------------------------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// Value serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a PropertyValue to its .dig XML value element string.
 *
 * Uses the xmlName to disambiguate special cases (rotation, testData, etc.)
 * and falls back to JS type inference for standard cases.
 */
function propertyValueToXml(xmlName: string, value: PropertyValue): string {
  // Rotation is a special element format
  if (xmlName === "rotation" && typeof value === "number") {
    return `<rotation rotation="${value}"/>`;
  }

  // Standard type inference from JS type
  if (typeof value === "string") {
    // Check for special encoded values
    if (xmlName === "Testdata") {
      return `<testData>\n            <dataString>${escapeXml(value)}</dataString>\n          </testData>`;
    }
    if (xmlName === "inverterConfig") {
      // Stored as JSON string of string array
      try {
        const labels: string[] = JSON.parse(value);
        const inner = labels.map((l) => `<string>${escapeXml(l)}</string>`).join("");
        return `<inverterConfig>${inner}</inverterConfig>`;
      } catch (err) {
        console.warn('[dig-serializer] InverterConfig JSON parse failed; using raw string', err);
        // Dual-format fallback (JSON-encoded vs raw string). Per
        // spec/architectural-alignment.md ssI1 retain-with-reason.
        return `<string>${escapeXml(value)}</string>`;
      }
    }
    if (xmlName === "Color") {
      // Stored as JSON string of {r,g,b,a}
      try {
        const c = JSON.parse(value) as { r: number; g: number; b: number; a: number };
        return `<awt-color>\n            <red>${c.r}</red>\n            <green>${c.g}</green>\n            <blue>${c.b}</blue>\n            <alpha>${c.a}</alpha>\n          </awt-color>`;
      } catch (err) {
        console.warn('[dig-serializer] Color JSON parse failed; using raw string', err);
        // Dual-format fallback (JSON-encoded vs raw string). Per
        // spec/architectural-alignment.md ssI1 retain-with-reason.
        return `<string>${escapeXml(value)}</string>`;
      }
    }
    if (xmlName === "Data") {
      return `<data>${escapeXml(value)}</data>`;
    }
    if (xmlName === "InDefault") {
      // Stored as JSON string of {value: string, highZ: boolean}
      try {
        const iv = JSON.parse(value) as { value: string; highZ: boolean };
        return `<value v="${iv.value}" z="${iv.highZ}"/>`;
      } catch (err) {
        console.warn('[dig-serializer] InDefault JSON parse failed; using raw string', err);
        // Dual-format fallback (JSON-encoded vs raw string). Per
        // spec/architectural-alignment.md ssI1 retain-with-reason.
        return `<string>${escapeXml(value)}</string>`;
      }
    }
    return `<string>${escapeXml(value)}</string>`;
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? `<int>${value}</int>` : `<double>${value}</double>`;
  }
  if (typeof value === "bigint") {
    return `<long>${value}</long>`;
  }
  if (typeof value === "boolean") {
    return `<boolean>${value}</boolean>`;
  }
  // number[]- unlikely in element attributes, but handle gracefully
  if (Array.isArray(value)) {
    return `<string>${value.join(",")}</string>`;
  }
  // Guard against plain objects- JSON-serialize rather than toString()
  // which would produce "[object Object]"
  if (typeof value === "object" && value !== null) {
    try {
      return `<string>${escapeXml(JSON.stringify(value))}</string>`;
    } catch (err) {
      console.warn('[dig-serializer] JSON.stringify failed (circular object?)', err);
      // JSON.stringify throws on circular objects. The serializer must emit
      // valid XML regardless. Per spec/architectural-alignment.md ssI1
      // retain-with-reason.
      return `<string>[unserializable]</string>`;
    }
  }
  return `<string>${String(value)}</string>`;
}

/**
 * Serialize a preserved unmapped DigValue back to XML.
 */
function digValueToXml(v: DigValue): string {
  switch (v.type) {
    case "string":
      return `<string>${escapeXml(v.value)}</string>`;
    case "int":
      return `<int>${v.value}</int>`;
    case "long":
      return `<long>${v.value}</long>`;
    case "boolean":
      return `<boolean>${v.value}</boolean>`;
    case "rotation":
      return `<rotation rotation="${v.value}"/>`;
    case "testData":
      return `<testData>\n            <dataString>${escapeXml(v.value)}</dataString>\n          </testData>`;
    case "data":
      return `<data>${escapeXml(v.value)}</data>`;
    case "enum":
      return `<${v.xmlTag}>${escapeXml(v.value)}</${v.xmlTag}>`;
    case "color": {
      const c = v.value;
      return `<awt-color>\n            <red>${c.r}</red>\n            <green>${c.g}</green>\n            <blue>${c.b}</blue>\n            <alpha>${c.a}</alpha>\n          </awt-color>`;
    }
    case "inverterConfig":
      return `<inverterConfig>${v.value.map((s) => `<string>${escapeXml(s)}</string>`).join("")}</inverterConfig>`;
    case "inValue":
      return `<value v="${v.value.value}" z="${v.value.highZ}"/>`;
    case "romList": {
      if (v.value.files.length === 0) {
        return `<romList>\n            <roms/>\n          </romList>`;
      }
      const roms = v.value.files
        .map((f) => `<rom>\n              <name>${escapeXml(f.name)}</name>\n              <data>${escapeXml(f.data)}</data>\n            </rom>`)
        .join("\n            ");
      return `<romList>\n            ${roms}\n          </romList>`;
    }
    case "customShape":
      // Custom shapes are not serialized; preserve as empty placeholder
      return `<string>[customShape]</string>`;
  }
}

// ---------------------------------------------------------------------------
// Entry serialization
// ---------------------------------------------------------------------------

function writeEntry(indent: string, key: string, valueXml: string): string {
  return `${indent}<entry>\n${indent}  <string>${escapeXml(key)}</string>\n${indent}  ${valueXml}\n${indent}</entry>\n`;
}

// ---------------------------------------------------------------------------
// Element serialization
// ---------------------------------------------------------------------------

/** Properties that are handled structurally (not as entries). */
const SKIP_PROPERTIES = new Set(["position"]);

function serializeElement(
  element: CircuitElement,
  registry: ComponentRegistry,
): string {
  const def = registry.getStandalone(element.typeId);

  // Build reverse map: propertyKey → xmlName
  const reverseMap = new Map<string, string>();
  if (def) {
    for (const m of def.attributeMap) {
      reverseMap.set(m.propertyKey, m.xmlName);
    }
  }

  let xml = "    <visualElement>\n";
  xml += `      <elementName>${escapeXml(element.typeId)}</elementName>\n`;
  xml += "      <elementAttributes>\n";

  // Serialize rotation if non-zero
  if (element.rotation !== 0) {
    xml += writeEntry("        ", "rotation", `<rotation rotation="${element.rotation}"/>`);
  }

  // Serialize mirror if true
  if (element.mirror) {
    xml += writeEntry("        ", "mirror", "<boolean>true</boolean>");
  }

  // Serialize properties via reverse attribute mappings
  const bag = element.getProperties();
  for (const [propKey, value] of bag.entries()) {
    if (SKIP_PROPERTIES.has(propKey)) continue;

    // Skip rotation/mirror- already handled above
    if (propKey === "rotation" || propKey === "mirror") continue;

    // Skip compiler-injected transient state that is regenerated on every
    // compile. _pinElectrical is a resolved object injected by the analog
    // compiler- it must not be serialized (it would produce "[object Object]").
    // User per-pin overrides are stored separately as _pinElectricalOverrides
    // (a JSON string) which serializes correctly.
    if (propKey === "_pinElectrical") continue;

    // Skip internal-only keys that don't map to XML
    if (propKey === "_inverterLabels") {
      // Map back to inverterConfig XML format
      const labels = String(value)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (labels.length > 0) {
        const inner = labels.map((l) => `<string>${escapeXml(l)}</string>`).join("");
        xml += writeEntry("        ", "inverterConfig", `<inverterConfig>${inner}</inverterConfig>`);
      }
      continue;
    }

    const xmlName = reverseMap.get(propKey) ?? propKey;
    const valueXml = propertyValueToXml(xmlName, value);
    xml += writeEntry("        ", xmlName, valueXml);
  }

  // Serialize unmapped entries (preserved from loading for round-trip)
  const unmapped = getUnmapped(bag);
  for (const [key, digValue] of unmapped) {
    // Skip rotation/mirror- already handled
    if (key === "rotation" || key === "mirror") continue;
    xml += writeEntry("        ", key, digValueToXml(digValue));
  }

  xml += "      </elementAttributes>\n";

  // Position: grid units → pixel coordinates
  const px = Math.round(element.position.x * DIG_SIZE);
  const py = Math.round(element.position.y * DIG_SIZE);
  xml += `      <pos x="${px}" y="${py}"/>\n`;

  xml += "    </visualElement>\n";
  return xml;
}

// ---------------------------------------------------------------------------
// Wire serialization
// ---------------------------------------------------------------------------

function serializeWire(wire: Wire): string {
  const x1 = Math.round(wire.start.x * DIG_SIZE);
  const y1 = Math.round(wire.start.y * DIG_SIZE);
  const x2 = Math.round(wire.end.x * DIG_SIZE);
  const y2 = Math.round(wire.end.y * DIG_SIZE);
  return `    <wire>\n      <p1 x="${x1}" y="${y1}"/>\n      <p2 x="${x2}" y="${y2}"/>\n    </wire>\n`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Serialize a Circuit to .dig XML format (Digital's native file format).
 *
 * Reverse of loadDigCircuit():
 *   - Element properties are reverse-mapped via the registry's attributeMap
 *   - Positions are converted from grid units to Java pixel coordinates (×20)
 *   - Unmapped entries preserved during loading are round-tripped
 *   - Rotation and mirror are emitted as standard .dig entries
 *
 * @param circuit   The circuit to serialize.
 * @param registry  Component registry for reverse attribute mapping lookup.
 * @returns         .dig XML string compatible with hneemann/Digital.
 */
export function serializeCircuitToDig(
  circuit: Circuit,
  registry: ComponentRegistry,
): string {
  let xml = '<?xml version="1.0" encoding="utf-8"?>\n';
  xml += "<circuit>\n";
  xml += "  <version>2</version>\n";

  // Circuit-level attributes
  xml += "  <attributes>\n";
  if (circuit.metadata.isGeneric) {
    xml += writeEntry("    ", "isGeneric", "<boolean>true</boolean>");
  }
  xml += writeEntry(
    "    ",
    "romContent",
    "<romList>\n        <roms/>\n      </romList>",
  );
  if (circuit.metadata.description) {
    xml += writeEntry(
      "    ",
      "Description",
      `<string>${escapeXml(circuit.metadata.description)}</string>`,
    );
  }
  xml += "  </attributes>\n";

  // Visual elements
  xml += "  <visualElements>\n";
  for (const element of circuit.elements) {
    xml += serializeElement(element, registry);
  }
  xml += "  </visualElements>\n";

  // Wires
  xml += "  <wires>\n";
  for (const wire of circuit.wires) {
    xml += serializeWire(wire);
  }
  xml += "  </wires>\n";

  // Measurement ordering
  if (
    circuit.metadata.measurementOrdering &&
    circuit.metadata.measurementOrdering.length > 0
  ) {
    xml += "  <measurementOrdering>\n";
    for (const name of circuit.metadata.measurementOrdering) {
      xml += `    <string>${escapeXml(name)}</string>\n`;
    }
    xml += "  </measurementOrdering>\n";
  } else {
    xml += "  <measurementOrdering/>\n";
  }

  xml += "</circuit>\n";
  return xml;
}
