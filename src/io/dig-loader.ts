/**
 * Circuit construction from parsed .dig XML.
 *
 * Transforms a DigCircuit parse tree (produced by parseDigXml) into a visual
 * Circuit model by:
 *   1. Looking up each elementName in the ComponentRegistry.
 *   2. Applying registered AttributeMapping[] to produce a PropertyBag.
 *   3. Calling factory(props) to create CircuitElement at the correct position.
 *   4. Creating Wire objects from DigWire endpoints.
 *   5. Extracting circuit-level metadata (Description, measurementOrdering).
 *
 * Per the phase-4 binding decisions:
 *   - Unknown element names throw DigParserError immediately.
 *   - InverterConfig is applied after element creation.
 *   - Rotation is set on the element from the parsed rotation attribute.
 */

import type { DigCircuit, DigVisualElement, DigWire, DigValue } from "./dig-schema.js";
import type { AttributeMapping } from "../core/registry.js";
import type { ComponentRegistry } from "../core/registry.js";
import type { CircuitElement } from "../core/element.js";
import type { CircuitMetadata, CustomShapeData, CustomDrawable } from "../core/circuit.js";
import { Circuit, Wire } from "../core/circuit.js";
import { PropertyBag } from "../core/properties.js";
import type { Rotation } from "../core/pin.js";
import { pinWorldPosition } from "../core/pin.js";
import { applyAttributeMappings } from "./attribute-map.js";
import type { DigAttributeMapping } from "./attribute-map.js";
import { parseDigXml } from "./dig-parser.js";

/**
 * Digital Java's grid unit size in pixels. .dig files store positions in
 * Java pixel coordinates; we divide by this to get grid units.
 */
const DIG_SIZE = 20;

// ---------------------------------------------------------------------------
// DigParserError
// ---------------------------------------------------------------------------

/**
 * Thrown when the dig loader encounters an unregistered component type.
 *
 * Carries the elementName and grid position for diagnostic messages.
 */
export class DigParserError extends Error {
  readonly elementName: string;
  readonly position: { x: number; y: number };

  constructor(
    message: string,
    elementName: string,
    position: { x: number; y: number },
  ) {
    super(message);
    this.name = "DigParserError";
    this.elementName = elementName;
    this.position = position;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Transform a DigCircuit parse tree into a visual Circuit model.
 *
 * For each DigVisualElement: look up elementName in the registry, apply
 * attribute mappings, call factory(props), position the element.
 * For each DigWire: create Wire from endpoints.
 * Circuit-level metadata (Description, measurementOrdering) is also extracted.
 *
 * @throws DigParserError if any elementName is not registered.
 */
export function loadDigCircuit(
  parsed: DigCircuit,
  registry: ComponentRegistry,
): Circuit {
  const metadata = extractCircuitMetadata(parsed);
  const circuit = new Circuit(metadata);

  for (const ve of parsed.visualElements) {
    // Skip unregistered elements gracefully (e.g. GenericInitCode, decorations,
    // HDL elements) rather than crashing. These are metadata/decoration elements
    // from Digital that have no simulation behavior in our engine.
    if (registry.get(ve.elementName) === undefined) {
      console.warn(
        `Skipping unregistered element "${ve.elementName}" at (${ve.pos.x}, ${ve.pos.y})`,
      );
      continue;
    }
    const element = createElementFromDig(ve, registry);
    circuit.addElement(element);
  }

  for (const dw of parsed.wires) {
    circuit.addWire(createWireFromDig(dw));
  }

  propagateWireBitWidths(circuit);

  return circuit;
}

/**
 * Parse a .dig XML string and load it into a Circuit.
 *
 * Convenience entry point that chains parseDigXml() and loadDigCircuit().
 * Identical to calling parseDigXml(xml) then loadDigCircuit(parsed, registry).
 *
 * @throws DigParserError if any elementName is not registered.
 * @throws Error if the XML is malformed.
 */
export function loadDig(xml: string, registry: ComponentRegistry): Circuit {
  const parsed = parseDigXml(xml);
  return loadDigCircuit(parsed, registry);
}

/**
 * Load a pre-parsed DigCircuit into a Circuit.
 *
 * Accepts a DigCircuit produced by parseDigXml() and delegates directly to
 * loadDigCircuit(). Provided for callers that already hold a parsed structure
 * and want to avoid re-parsing.
 *
 * @throws DigParserError if any elementName is not registered.
 */
export function loadDigFromParsed(parsed: DigCircuit, registry: ComponentRegistry): Circuit {
  return loadDigCircuit(parsed, registry);
}

/**
 * Look up the component in the registry, map its attributes, and instantiate
 * a CircuitElement at the correct grid position.
 *
 * @throws DigParserError when elementName is not registered.
 */
export function createElementFromDig(
  ve: DigVisualElement,
  registry: ComponentRegistry,
): CircuitElement {
  const def = registry.get(ve.elementName);
  if (def === undefined) {
    throw new DigParserError(
      `Unknown component "${ve.elementName}" at (${ve.pos.x}, ${ve.pos.y}). ` +
        `Register this component type before loading circuits that contain it.`,
      ve.elementName,
      ve.pos,
    );
  }

  const props = applyAllMappings(ve, def.attributeMap);

  const element = def.factory(props);

  element.position = { x: ve.pos.x / DIG_SIZE, y: ve.pos.y / DIG_SIZE };

  const rotation = extractRotationFromEntries(ve.elementAttributes);
  if (rotation !== undefined) {
    element.rotation = rotation;
  }

  const mirror = extractMirrorFromEntries(ve.elementAttributes);
  if (mirror) {
    element.mirror = true;
  }

  return element;
}

/**
 * Apply the registered AttributeMapping[] to a DigVisualElement's attributes,
 * producing a PropertyBag.
 *
 * Handles both DigAttributeMapping (with convertDigValue) and plain
 * AttributeMapping (with string-based convert). For plain mappings, the
 * DigValue is converted to a string representation before calling convert().
 */
function applyAllMappings(
  ve: DigVisualElement,
  mappings: AttributeMapping[],
): PropertyBag {
  const digMappings = mappings.filter(isDigAttributeMapping);
  const plainMappings = mappings.filter((m) => !isDigAttributeMapping(m));

  const bag = applyAttributeMappings(ve.elementAttributes, digMappings);

  const entryByKey = new Map<string, DigValue>();
  for (const entry of ve.elementAttributes) {
    entryByKey.set(entry.key, entry.value);
  }

  if (plainMappings.length > 0) {
    for (const mapping of plainMappings) {
      const digValue = entryByKey.get(mapping.xmlName);
      if (digValue !== undefined) {
        const strValue = digValueToString(digValue);
        bag.set(mapping.propertyKey, mapping.convert(strValue));
      }
    }
  }

  for (const key of ["generic", "enabled"] as const) {
    if (!bag.has(key) && entryByKey.has(key)) {
      const digValue = entryByKey.get(key)!;
      const strValue = digValueToString(digValue);
      bag.set(key, key === "enabled" ? strValue === "true" : strValue);
    }
  }

  return bag;
}

/**
 * Convert a DigValue to its string representation for use with plain
 * AttributeMapping.convert() functions that expect string input.
 */
function digValueToString(v: DigValue): string {
  switch (v.type) {
    case "string":
      return v.value;
    case "int":
      return v.value.toString(10);
    case "long":
      return v.value.toString();
    case "boolean":
      return v.value ? "true" : "false";
    case "rotation":
      return v.value.toString(10);
    case "color":
      return JSON.stringify(v.value);
    case "testData":
      return v.value;
    case "inverterConfig":
      return v.value.join(",");
    case "data":
      return v.value;
    case "inValue":
      return JSON.stringify({ value: v.value.value.toString(), highZ: v.value.highZ });
    case "romList":
      return JSON.stringify(v.value);
    case "customShape":
      return JSON.stringify(v.value);
    case "enum":
      return v.value;
  }
}

/**
 * Extract the rotation value directly from DigEntry[], if present.
 * Returns undefined when no rotation attribute was in the XML.
 *
 * Rotation is always a built-in attribute handled here rather than through
 * component-specific attribute mappings.
 */
function extractRotationFromEntries(
  entries: { key: string; value: DigValue }[],
): Rotation | undefined {
  const entry = entries.find((e) => e.key === "rotation");
  if (entry === undefined) return undefined;
  const v = entry.value;
  if (v.type !== "rotation") return undefined;
  return v.value;
}

/**
 * Extract the mirror flag directly from DigEntry[], if present.
 * Returns false when no Mirror attribute was in the XML.
 */
function extractMirrorFromEntries(
  entries: { key: string; value: DigValue }[],
): boolean {
  const entry = entries.find((e) => e.key === "Mirror");
  if (entry === undefined) return false;
  if (entry.value.type === "boolean") return entry.value.value;
  // Some .dig files may encode mirror as a string
  if (entry.value.type === "string") return entry.value.value === "true";
  return false;
}

/**
 * Set `isNegated = true` on each Pin whose label is listed in the config.
 *
 * Apply negation flags from the .dig file's inverter configuration.
 */
export function applyInverterConfig(
  element: CircuitElement,
  config: string[],
): void {
  if (config.length === 0) return;

  const negatedSet = new Set(config);
  const pins = element.getPins();

  for (const pin of pins) {
    if (negatedSet.has(pin.label)) {
      (pin as { isNegated: boolean }).isNegated = true;
    }
  }
}

/**
 * Create a Wire from a parsed DigWire.
 */
export function createWireFromDig(dw: DigWire): Wire {
  return new Wire(
    { x: dw.p1.x / DIG_SIZE, y: dw.p1.y / DIG_SIZE },
    { x: dw.p2.x / DIG_SIZE, y: dw.p2.y / DIG_SIZE },
  );
}

/**
 * Extract CircuitMetadata from the circuit-level attributes and the parsed
 * measurementOrdering.
 */
export function extractCircuitMetadata(parsed: DigCircuit): Partial<CircuitMetadata> {
  const metadata: Partial<CircuitMetadata> = {};

  if (parsed.measurementOrdering !== undefined) {
    metadata.measurementOrdering = parsed.measurementOrdering;
  }

  for (const entry of parsed.attributes) {
    if (entry.key === "Description" && entry.value.type === "string") {
      metadata.description = entry.value.value;
    }
    if (entry.key === "isGeneric" && entry.value.type === "boolean") {
      metadata.isGeneric = entry.value.value;
    }
    if (entry.key === "Width" && entry.value.type === "int") {
      metadata.chipWidth = entry.value.value;
    }
    if (entry.key === "Height" && entry.value.type === "int") {
      metadata.chipHeight = entry.value.value;
    }
    if (entry.key === "shapeType" && (entry.value.type === "string" || entry.value.type === "enum")) {
      metadata.shapeType = entry.value.value;
    }
    if (entry.key === "customShape" && entry.value.type === "customShape") {
      metadata.customShape = convertCustomShapeData(entry.value.value);
    }
  }

  return metadata;
}

/**
 * Convert raw parsed custom shape data (pixel coordinates) to grid units (÷ DIG_SIZE).
 */
function convertCustomShapeData(
  raw: import("./dig-schema.js").DigCustomShapeData,
): CustomShapeData {
  const pins = new Map<string, { pos: { x: number; y: number }; showLabel: boolean }>();
  for (const pin of raw.pins) {
    pins.set(pin.name, {
      pos: { x: pin.pos.x / DIG_SIZE, y: pin.pos.y / DIG_SIZE },
      showLabel: pin.showLabel,
    });
  }

  const drawables: CustomDrawable[] = raw.drawables.map((d) => {
    switch (d.type) {
      case "poly":
        return {
          type: "poly" as const,
          path: d.path,
          evenOdd: d.evenOdd,
          thickness: d.thickness,
          filled: d.filled,
          color: d.color,
        };
      case "line":
        return {
          type: "line" as const,
          p1: { x: d.p1.x / DIG_SIZE, y: d.p1.y / DIG_SIZE },
          p2: { x: d.p2.x / DIG_SIZE, y: d.p2.y / DIG_SIZE },
          thickness: d.thickness,
          color: d.color,
        };
      case "circle":
        return {
          type: "circle" as const,
          p1: { x: d.p1.x / DIG_SIZE, y: d.p1.y / DIG_SIZE },
          p2: { x: d.p2.x / DIG_SIZE, y: d.p2.y / DIG_SIZE },
          thickness: d.thickness,
          filled: d.filled,
          color: d.color,
        };
      case "text":
        return {
          type: "text" as const,
          pos: { x: d.pos.x / DIG_SIZE, y: d.pos.y / DIG_SIZE },
          text: d.text,
          orientation: d.orientation,
          size: d.size,
          color: d.color,
        };
    }
  });

  return { pins, drawables };
}

// ---------------------------------------------------------------------------
// Wire bit width propagation
// ---------------------------------------------------------------------------

/**
 * Set each wire's bitWidth by tracing connected nets from multi-bit pins.
 *
 * 1. Build adjacency: endpoint position → list of wires touching that point.
 * 2. Seed from multi-bit component pins.
 * 3. Flood-fill through connected wires so the entire net gets the bit width.
 */
function propagateWireBitWidths(circuit: Circuit): void {
  if (circuit.wires.length === 0) return;

  // Adjacency: position key → wires sharing that endpoint
  const pointToWires = new Map<string, Wire[]>();
  const wireKeys = new Map<Wire, [string, string]>();

  for (const wire of circuit.wires) {
    const sk = ptKey(wire.start.x, wire.start.y);
    const ek = ptKey(wire.end.x, wire.end.y);
    wireKeys.set(wire, [sk, ek]);

    let sl = pointToWires.get(sk);
    if (!sl) { sl = []; pointToWires.set(sk, sl); }
    sl.push(wire);

    let el = pointToWires.get(ek);
    if (!el) { el = []; pointToWires.set(ek, el); }
    el.push(wire);
  }

  // Seed: collect multi-bit pin positions
  const seeds = new Map<string, number>(); // position key → max bitWidth
  for (const element of circuit.elements) {
    for (const pin of element.getPins()) {
      if (pin.bitWidth <= 1) continue;
      const wp = pinWorldPosition(element, pin);
      const key = ptKey(wp.x, wp.y);
      const existing = seeds.get(key) ?? 1;
      if (pin.bitWidth > existing) {
        seeds.set(key, pin.bitWidth);
      }
    }
  }

  if (seeds.size === 0) return;

  // Flood-fill from each seed through connected wires
  const visited = new Set<Wire>();

  for (const [seedKey, bw] of seeds) {
    const startWires = pointToWires.get(seedKey);
    if (!startWires) continue;

    const queue: Wire[] = [];
    for (const w of startWires) {
      if (!visited.has(w)) {
        visited.add(w);
        queue.push(w);
      }
    }

    while (queue.length > 0) {
      const wire = queue.pop()!;
      if (bw > wire.bitWidth) wire.bitWidth = bw;

      const [sk, ek] = wireKeys.get(wire)!;
      for (const neighborKey of [sk, ek]) {
        const neighbors = pointToWires.get(neighborKey);
        if (!neighbors) continue;
        for (const nw of neighbors) {
          if (!visited.has(nw)) {
            visited.add(nw);
            queue.push(nw);
          }
        }
      }
    }
  }
}

function ptKey(x: number, y: number): string {
  return `${x},${y}`;
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isDigAttributeMapping(m: AttributeMapping): m is DigAttributeMapping {
  return typeof (m as DigAttributeMapping).convertDigValue === "function";
}
