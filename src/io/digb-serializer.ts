/**
 * Serializer for the .digb (Digital-in-Browser) native JSON format.
 *
 * Converts Circuit objects to .digb JSON strings. bigint property values are
 * encoded as "_bigint:<n>" strings for JSON compatibility.
 */

import type { Circuit } from '../core/circuit.js';
import type { CircuitElement } from '../core/element.js';
import type { Wire } from '../core/circuit.js';
import type {
  DigbDocument,
  DigbCircuit,
  DigbElement,
  DigbWire,
} from './digb-schema.js';

// ---------------------------------------------------------------------------
// bigint encoding
// ---------------------------------------------------------------------------

/** Sentinel prefix for bigint-encoded string values. */
const BIGINT_PREFIX = '_bigint:';

/**
 * Encode a bigint as a JSON-safe string.
 * Decoded by the deserializer back to bigint.
 */
export function encodeDigbBigint(value: bigint): string {
  return `${BIGINT_PREFIX}${value.toString()}`;
}

// ---------------------------------------------------------------------------
// Key sorting for deterministic output
// ---------------------------------------------------------------------------

function sortObjectKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted;
}

function sortedReplacer(
  this: unknown,
  _key: string,
  value: unknown,
): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return sortObjectKeys(value as Record<string, unknown>);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Property serialization
// ---------------------------------------------------------------------------

function serializePropertyValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return encodeDigbBigint(value);
  }
  return value;
}

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
// Circuit conversion
// ---------------------------------------------------------------------------

function elementToDigbElement(element: CircuitElement): DigbElement {
  const props = serializeProperties(
    element.getProperties().entries() as IterableIterator<[string, unknown]>,
  );
  return {
    type: element.typeId,
    id: element.instanceId,
    position: { x: element.position.x, y: element.position.y },
    rotation: element.rotation * 90,
    properties: props,
  };
}

function wireToDigbWire(wire: Wire): DigbWire {
  return {
    points: [
      { x: wire.start.x, y: wire.start.y },
      { x: wire.end.x, y: wire.end.y },
    ],
  };
}

function circuitToDigbCircuit(circuit: Circuit): DigbCircuit {
  const result: DigbCircuit = {
    name: circuit.metadata.name,
    elements: circuit.elements.map(elementToDigbElement),
    wires: circuit.wires.map(wireToDigbWire),
  };

  if (circuit.metadata.description) {
    result.description = circuit.metadata.description;
  }

  if (circuit.metadata.isGeneric) {
    result.isGeneric = circuit.metadata.isGeneric;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Serialize a Circuit to a .digb JSON string.
 *
 * Produces a self-contained document with `format: "digb"`, `version: 1`,
 * and no `subcircuitDefinitions` key (standalone circuit).
 *
 * Output is deterministic: same circuit always produces byte-identical JSON.
 */
export function serializeCircuit(circuit: Circuit): string {
  const doc: DigbDocument = {
    format: 'digb',
    version: 1,
    circuit: circuitToDigbCircuit(circuit),
  };

  return JSON.stringify(doc, sortedReplacer, 2);
}

/**
 * Serialize a Circuit together with its subcircuit definitions to a .digb
 * JSON string.
 *
 * The main circuit is placed under `circuit`; each subcircuit in the map is
 * placed under `subcircuitDefinitions` keyed by its name. The result is a
 * fully self-contained document — no external files are required to load it.
 */
export function serializeWithSubcircuits(
  circuit: Circuit,
  subcircuits: Map<string, Circuit>,
): string {
  const subcircuitDefinitions: Record<string, DigbCircuit> = {};
  for (const [name, sub] of subcircuits) {
    subcircuitDefinitions[name] = circuitToDigbCircuit(sub);
  }

  const doc: DigbDocument = {
    format: 'digb',
    version: 1,
    circuit: circuitToDigbCircuit(circuit),
    subcircuitDefinitions,
  };

  return JSON.stringify(doc, sortedReplacer, 2);
}
