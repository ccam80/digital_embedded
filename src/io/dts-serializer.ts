/**
 * Serializer for the .dts (digiTS) native JSON format.
 *
 * Converts Circuit objects to .dts JSON strings. bigint property values are
 * encoded as "_bigint:<n>" strings for JSON compatibility.
 */

import type { Circuit } from '../core/circuit.js';
import type { CircuitElement } from '../core/element.js';
import type { Wire } from '../core/circuit.js';
import type { SubcircuitModelRegistry } from '../solver/analog/subcircuit-model-registry.js';
import type { MnaSubcircuitNetlist } from '../core/mna-subcircuit-netlist.js';
import type {
  DtsDocument,
  DtsCircuit,
  DtsElement,
  DtsWire,
} from './dts-schema.js';

// ---------------------------------------------------------------------------
// bigint encoding
// ---------------------------------------------------------------------------

/** Sentinel prefix for bigint-encoded string values. */
const BIGINT_PREFIX = '_bigint:';

/**
 * Encode a bigint as a JSON-safe string.
 * Decoded by the deserializer back to bigint.
 */
export function encodeDtsBigint(value: bigint): string {
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
    return encodeDtsBigint(value);
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

function elementToDtsElement(element: CircuitElement): DtsElement {
  const props = serializeProperties(
    element.getProperties().entries() as IterableIterator<[string, unknown]>,
  );
  const result: DtsElement = {
    type: element.typeId,
    id: element.instanceId,
    position: { x: element.position.x, y: element.position.y },
    rotation: element.rotation * 90, // .dts stores degrees; internal Rotation is quarter-turns
    properties: props,
  };
  if (element.mirror) {
    result.mirror = true;
  }
  return result;
}

function wireToDtsWire(wire: Wire): DtsWire {
  return {
    points: [
      { x: wire.start.x, y: wire.start.y },
      { x: wire.end.x, y: wire.end.y },
    ],
  };
}

function circuitToDtsCircuit(circuit: Circuit): DtsCircuit {
  const result: DtsCircuit = {
    name: circuit.metadata.name,
    elements: circuit.elements.map(elementToDtsElement),
    wires: circuit.wires.map(wireToDtsWire),
  };

  if (circuit.metadata.description) {
    result.description = circuit.metadata.description;
  }

  if (circuit.metadata.isGeneric) {
    result.isGeneric = circuit.metadata.isGeneric;
  }

  if (circuit.metadata.measurementOrdering.length > 0) {
    result.measurementOrdering = [...circuit.metadata.measurementOrdering];
  }

  if (circuit.metadata.traces !== undefined && circuit.metadata.traces.length > 0) {
    result.traces = circuit.metadata.traces.map(t => ({
      name: t.name,
      domain: t.domain,
      panelIndex: t.panelIndex,
      group: t.group,
    }));
  }

  if (
    circuit.metadata.digitalPinLoading !== undefined ||
    (circuit.metadata.digitalPinLoadingOverrides !== undefined &&
      circuit.metadata.digitalPinLoadingOverrides.length > 0)
  ) {
    const attrs: Record<string, string> = {};
    if (circuit.metadata.digitalPinLoading !== undefined) {
      attrs['digitalPinLoading'] = circuit.metadata.digitalPinLoading;
    }
    if (
      circuit.metadata.digitalPinLoadingOverrides !== undefined &&
      circuit.metadata.digitalPinLoadingOverrides.length > 0
    ) {
      attrs['digitalPinLoadingOverrides'] = JSON.stringify(
        circuit.metadata.digitalPinLoadingOverrides,
      );
    }
    result.attributes = attrs;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the model-related fields of a DtsDocument from circuit metadata.
 *
 * When a `SubcircuitModelRegistry` is provided, its MnaSubcircuitNetlist
 * objects are written directly. Without the registry, the metadata
 * MnaSubcircuitNetlist is written as-is.
 */
function buildModelFields(
  circuit: Circuit,
  subcircuitModels?: SubcircuitModelRegistry,
): Pick<DtsDocument, 'modelDefinitions' | 'namedParameterSets' | 'subcircuitBindings'> {
  const result: Pick<DtsDocument, 'modelDefinitions' | 'namedParameterSets' | 'subcircuitBindings'> = {};

  if (circuit.metadata.modelDefinitions !== undefined) {
    const modelDefinitions: Record<string, MnaSubcircuitNetlist> = {};
    for (const [name, def] of Object.entries(circuit.metadata.modelDefinitions)) {
      const registryNetlist = subcircuitModels?.get(name);
      if (registryNetlist !== undefined) {
        modelDefinitions[name] = registryNetlist;
      } else {
        modelDefinitions[name] = def;
      }
    }
    result.modelDefinitions = modelDefinitions;
  }

  if (circuit.metadata.namedParameterSets !== undefined) {
    result.namedParameterSets = circuit.metadata.namedParameterSets;
  }

  if (circuit.metadata.subcircuitBindings !== undefined) {
    result.subcircuitBindings = circuit.metadata.subcircuitBindings;
  }

  return result;
}

/**
 * Serialize a Circuit to a .dts JSON string.
 *
 * Produces a self-contained document with `format: "dts"`, `version: 1`,
 * and no `subcircuitDefinitions` key (standalone circuit).
 *
 * When `subcircuitModels` is provided, MnaSubcircuitNetlist objects from the
 * registry are serialized directly.
 *
 * Output is deterministic: same circuit always produces byte-identical JSON.
 */
export function serializeCircuit(
  circuit: Circuit,
  subcircuitModels?: SubcircuitModelRegistry,
): string {
  const doc: DtsDocument = {
    format: 'dts',
    version: 1,
    circuit: circuitToDtsCircuit(circuit),
    ...buildModelFields(circuit, subcircuitModels),
  };

  return JSON.stringify(doc, sortedReplacer, 2);
}

/**
 * Serialize a Circuit together with its subcircuit definitions to a .dts
 * JSON string.
 *
 * The main circuit is placed under `circuit`; each subcircuit in the map is
 * placed under `subcircuitDefinitions` keyed by its name. The result is a
 * fully self-contained document — no external files are required to load it.
 *
 * When `subcircuitModels` is provided, MnaSubcircuitNetlist objects from the
 * registry are serialized directly.
 */
export function serializeWithSubcircuits(
  circuit: Circuit,
  subcircuits: Map<string, Circuit>,
  subcircuitModels?: SubcircuitModelRegistry,
): string {
  const subcircuitDefinitions: Record<string, DtsCircuit> = {};
  for (const [name, sub] of subcircuits) {
    subcircuitDefinitions[name] = circuitToDtsCircuit(sub);
  }

  const doc: DtsDocument = {
    format: 'dts',
    version: 1,
    circuit: circuitToDtsCircuit(circuit),
    subcircuitDefinitions,
    ...buildModelFields(circuit, subcircuitModels),
  };

  return JSON.stringify(doc, sortedReplacer, 2);
}
