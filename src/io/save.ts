/**
 * Native JSON save format — serialize a Circuit to a JSON string.
 *
 * The format preserves the visual model: elements with their type names,
 * properties, positions, rotations; wires with endpoints; circuit metadata.
 * Keys are sorted for stable, diff-friendly output.
 *
 * bigint values are encoded as "_bigint:<n>" strings because JSON.stringify
 * has no native bigint support.
 */

import type { Circuit } from "../core/circuit.js";
import type { CircuitElement } from "../core/element.js";
import type { Wire } from "../core/circuit.js";
import type {
  SavedCircuit,
  SavedElement,
  SavedMetadata,
  SavedWire,
} from "./save-schema.js";

// ---------------------------------------------------------------------------
// Format version
// ---------------------------------------------------------------------------

/** Current save format version. Increment when making breaking schema changes. */
export const SAVE_FORMAT_VERSION = 1;

// ---------------------------------------------------------------------------
// bigint encoding
// ---------------------------------------------------------------------------

/** Sentinel prefix that marks a bigint-encoded string value. */
const BIGINT_PREFIX = "_bigint:";

/**
 * Encode a bigint as a JSON-safe string.
 * Round-trips via decodeBigint().
 */
export function encodeBigint(value: bigint): string {
  return `${BIGINT_PREFIX}${value.toString()}`;
}

/**
 * Decode a previously encoded bigint string back to bigint.
 * Returns null if the string does not carry the sentinel prefix.
 */
export function decodeBigint(s: string): bigint | null {
  if (s.startsWith(BIGINT_PREFIX)) {
    return BigInt(s.slice(BIGINT_PREFIX.length));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Property serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a single PropertyValue to a JSON-safe form.
 * - bigint → "_bigint:<n>"
 * - number, string, boolean, number[] → pass through unchanged
 */
function serializePropertyValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return encodeBigint(value);
  }
  return value;
}

/**
 * Serialize all entries from a PropertyBag iterable into a plain object
 * with keys sorted alphabetically for stable output.
 */
function serializeProperties(
  entries: IterableIterator<[string, unknown]>,
): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    raw[k] = serializePropertyValue(v);
  }
  return sortObjectKeys(raw);
}

// ---------------------------------------------------------------------------
// Key sorting for deterministic output
// ---------------------------------------------------------------------------

/**
 * Return a new plain object with the same entries but keys in alphabetical order.
 * This ensures two calls on the same data produce byte-identical JSON.
 */
function sortObjectKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Element serialization
// ---------------------------------------------------------------------------

function serializeElement(element: CircuitElement): SavedElement {
  const props = serializeProperties(
    element.getProperties().entries() as IterableIterator<[string, unknown]>,
  );
  return {
    typeName: element.typeId,
    instanceId: element.instanceId,
    position: { x: element.position.x, y: element.position.y },
    rotation: element.rotation,
    mirror: element.mirror,
    properties: props,
  };
}

// ---------------------------------------------------------------------------
// Wire serialization
// ---------------------------------------------------------------------------

function serializeWire(wire: Wire): SavedWire {
  return {
    p1: { x: wire.start.x, y: wire.start.y },
    p2: { x: wire.end.x, y: wire.end.y },
  };
}

// ---------------------------------------------------------------------------
// Metadata serialization
// ---------------------------------------------------------------------------

function serializeMetadata(circuit: Circuit): SavedMetadata {
  return {
    name: circuit.metadata.name,
    description: circuit.metadata.description,
    measurementOrdering: [...circuit.metadata.measurementOrdering],
    isGeneric: circuit.metadata.isGeneric,
  };
}

// ---------------------------------------------------------------------------
// JSON replacer with sorted keys
// ---------------------------------------------------------------------------

/**
 * JSON.stringify replacer that sorts object keys at every level.
 * This guarantees stable key ordering throughout the entire document tree,
 * including nested objects produced by property values.
 */
function sortedReplacer(
  this: unknown,
  _key: string,
  value: unknown,
): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return sortObjectKeys(value as Record<string, unknown>);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Serialize a Circuit to a JSON string.
 *
 * Output properties:
 * - Valid JSON parseable by JSON.parse()
 * - Stable/deterministic: same circuit always produces byte-identical output
 * - bigint property values encoded as "_bigint:<n>" strings
 * - Includes version field for future migration
 * - Human-readable with 2-space indentation
 */
export function serializeCircuit(circuit: Circuit): string {
  const document: SavedCircuit = {
    version: SAVE_FORMAT_VERSION,
    metadata: serializeMetadata(circuit),
    elements: circuit.elements.map(serializeElement),
    wires: circuit.wires.map(serializeWire),
  };

  return JSON.stringify(document, sortedReplacer, 2);
}
