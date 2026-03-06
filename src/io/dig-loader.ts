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
import type { CircuitMetadata } from "../core/circuit.js";
import { Circuit, Wire } from "../core/circuit.js";
import { PropertyBag } from "../core/properties.js";
import type { Rotation } from "../core/pin.js";
import { applyAttributeMappings } from "./attribute-map.js";
import type { DigAttributeMapping } from "./attribute-map.js";
import { parseDigXml } from "./dig-parser.js";

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
    const element = createElementFromDig(ve, registry);
    circuit.addElement(element);
  }

  for (const dw of parsed.wires) {
    circuit.addWire(createWireFromDig(dw));
  }

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

  element.position = { x: ve.pos.x, y: ve.pos.y };

  const rotation = extractRotationFromEntries(ve.elementAttributes);
  if (rotation !== undefined) {
    element.rotation = rotation;
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
    { x: dw.p1.x, y: dw.p1.y },
    { x: dw.p2.x, y: dw.p2.y },
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
  }

  return metadata;
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isDigAttributeMapping(m: AttributeMapping): m is DigAttributeMapping {
  return typeof (m as DigAttributeMapping).convertDigValue === "function";
}
