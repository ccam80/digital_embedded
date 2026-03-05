/**
 * Deserializer for the .digb (Digital-in-Browser) native JSON format.
 *
 * Parses .digb JSON strings back to Circuit objects. bigint values encoded as
 * "_bigint:<n>" strings are restored to native bigint.
 */

import { Circuit, Wire } from '../core/circuit.js';
import type { CircuitMetadata } from '../core/circuit.js';
import type { ComponentRegistry } from '../core/registry.js';
import { PropertyBag } from '../core/properties.js';
import type { PropertyValue } from '../core/properties.js';
import type { Rotation } from '../core/pin.js';
import { validateDigbDocument } from './digb-schema.js';
import type { DigbCircuit, DigbElement, DigbWire } from './digb-schema.js';

// ---------------------------------------------------------------------------
// bigint decoding
// ---------------------------------------------------------------------------

const BIGINT_PREFIX = '_bigint:';

/**
 * Decode a bigint-encoded string back to bigint.
 * Returns null if the string does not carry the sentinel prefix.
 */
function decodeBigint(s: string): bigint | null {
  if (s.startsWith(BIGINT_PREFIX)) {
    return BigInt(s.slice(BIGINT_PREFIX.length));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Property restoration
// ---------------------------------------------------------------------------

function restorePropertyValue(raw: unknown): PropertyValue {
  if (typeof raw === 'string') {
    const bigintValue = decodeBigint(raw);
    if (bigintValue !== null) {
      return bigintValue;
    }
    return raw;
  }
  return raw as PropertyValue;
}

function restoreProperties(record: Record<string, unknown>): PropertyBag {
  const entries: Array<[string, PropertyValue]> = [];
  for (const [key, raw] of Object.entries(record)) {
    entries.push([key, restorePropertyValue(raw)]);
  }
  return new PropertyBag(entries);
}

// ---------------------------------------------------------------------------
// Rotation decoding
// ---------------------------------------------------------------------------

/**
 * Convert a .digb rotation in degrees (0/90/180/270) to a Rotation quarter-turn
 * value (0/1/2/3).
 */
function degreesToRotation(degrees: number): Rotation {
  const normalized = ((degrees % 360) + 360) % 360;
  return (normalized / 90) as Rotation;
}

// ---------------------------------------------------------------------------
// Circuit reconstruction
// ---------------------------------------------------------------------------

function deserializeDigbCircuit(
  digbCircuit: DigbCircuit,
  registry: ComponentRegistry,
): Circuit {
  const metadata: Partial<CircuitMetadata> = {
    name: digbCircuit.name,
  };

  if (digbCircuit.description !== undefined) {
    metadata.description = digbCircuit.description;
  }

  if (digbCircuit.isGeneric !== undefined) {
    metadata.isGeneric = digbCircuit.isGeneric;
  }

  const circuit = new Circuit(metadata);

  for (const savedEl of digbCircuit.elements) {
    const element = createElement(savedEl, registry);
    circuit.addElement(element);
  }

  for (const savedWire of digbCircuit.wires) {
    const wire = createWire(savedWire);
    circuit.addWire(wire);
  }

  return circuit;
}

function createElement(
  savedEl: DigbElement,
  registry: ComponentRegistry,
): import('../core/element.js').CircuitElement {
  const def = registry.get(savedEl.type);
  if (def === undefined) {
    throw new Error(
      `deserializeDigb: unknown component type "${savedEl.type}". ` +
        `Register it in the ComponentRegistry before loading.`,
    );
  }

  const props = restoreProperties(savedEl.properties);
  const element = def.factory(props);

  element.position = { x: savedEl.position.x, y: savedEl.position.y };
  element.rotation = degreesToRotation(savedEl.rotation);

  // Restore the persisted instanceId (readonly on the class, but must be
  // restored exactly for round-trip fidelity).
  (element as { instanceId: string }).instanceId = savedEl.id;

  return element;
}

function createWire(savedWire: DigbWire): Wire {
  if (savedWire.points.length < 2) {
    throw new Error(
      `deserializeDigb: wire must have at least 2 points, got ${savedWire.points.length}`,
    );
  }
  const start = savedWire.points[0];
  const end = savedWire.points[savedWire.points.length - 1];
  return new Wire(
    { x: start.x, y: start.y },
    { x: end.x, y: end.y },
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a .digb JSON string back to Circuit objects.
 *
 * Returns the main circuit and a map of subcircuit names to Circuit objects.
 * The subcircuits map is empty when the document has no `subcircuitDefinitions`.
 *
 * @throws Error if the JSON is malformed or the document fails validation.
 * @throws Error if any component type is not found in the registry.
 */
export function deserializeDigb(
  json: string,
  registry: ComponentRegistry,
): { circuit: Circuit; subcircuits: Map<string, Circuit> } {
  const raw = JSON.parse(json) as unknown;
  const doc = validateDigbDocument(raw);

  const circuit = deserializeDigbCircuit(doc.circuit, registry);

  const subcircuits = new Map<string, Circuit>();
  if (doc.subcircuitDefinitions !== undefined) {
    for (const [name, subDef] of Object.entries(doc.subcircuitDefinitions)) {
      subcircuits.set(name, deserializeDigbCircuit(subDef, registry));
    }
  }

  return { circuit, subcircuits };
}
