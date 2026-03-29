/**
 * Deserializer for the .dts (digiTS) native JSON format.
 *
 * Parses .dts JSON strings back to Circuit objects. bigint values encoded as
 * "_bigint:<n>" strings are restored to native bigint.
 */

import { Circuit, Wire } from '../core/circuit.js';
import type { CircuitMetadata } from '../core/circuit.js';
import type { ComponentRegistry } from '../core/registry.js';
import { PropertyBag } from '../core/properties.js';
import type { PropertyValue } from '../core/properties.js';
import type { Rotation } from '../core/pin.js';
import type { ModelLibrary } from '../solver/analog/model-library.js';
import type { SubcircuitModelRegistry } from '../solver/analog/subcircuit-model-registry.js';
import { validateDtsDocument } from './dts-schema.js';
import type { DtsCircuit, DtsElement, DtsWire } from './dts-schema.js';

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
 * Convert a .dts rotation in degrees (0/90/180/270) to a Rotation quarter-turn
 * value (0/1/2/3).
 */
function degreesToRotation(degrees: number): Rotation {
  const normalized = ((degrees % 360) + 360) % 360;
  return (normalized / 90) as Rotation;
}

// ---------------------------------------------------------------------------
// Circuit reconstruction
// ---------------------------------------------------------------------------

function deserializeDtsCircuit(
  dtsCircuit: DtsCircuit,
  registry: ComponentRegistry,
): Circuit {
  const metadata: Partial<CircuitMetadata> = {
    name: dtsCircuit.name,
  };

  if (dtsCircuit.description !== undefined) {
    metadata.description = dtsCircuit.description;
  }

  if (dtsCircuit.isGeneric !== undefined) {
    metadata.isGeneric = dtsCircuit.isGeneric;
  }

  if (dtsCircuit.measurementOrdering !== undefined) {
    metadata.measurementOrdering = [...dtsCircuit.measurementOrdering];
  }

  if (dtsCircuit.traces !== undefined && dtsCircuit.traces.length > 0) {
    metadata.traces = dtsCircuit.traces.map(t => ({
      name: t.name,
      domain: t.domain as 'digital' | 'analog',
      panelIndex: t.panelIndex,
      group: t.group as 'input' | 'output' | 'probe',
    }));
  }

  if (dtsCircuit.attributes !== undefined) {
    const attrs = dtsCircuit.attributes;
    const loadingRaw = attrs['digitalPinLoading'];
    if (
      loadingRaw === 'cross-domain' ||
      loadingRaw === 'all' ||
      loadingRaw === 'none'
    ) {
      metadata.digitalPinLoading = loadingRaw;
    }
    const overridesRaw = attrs['digitalPinLoadingOverrides'];
    if (overridesRaw !== undefined) {
      metadata.digitalPinLoadingOverrides = JSON.parse(overridesRaw) as CircuitMetadata['digitalPinLoadingOverrides'];
    }
  }

  const circuit = new Circuit(metadata);

  for (const savedEl of dtsCircuit.elements) {
    const element = createElement(savedEl, registry);
    circuit.addElement(element);
  }

  for (const savedWire of dtsCircuit.wires) {
    const wire = createWire(savedWire);
    circuit.addWire(wire);
  }

  return circuit;
}

function createElement(
  savedEl: DtsElement,
  registry: ComponentRegistry,
): import('../core/element.js').CircuitElement {
  const def = registry.get(savedEl.type);
  if (def === undefined) {
    throw new Error(
      `deserializeDts: unknown component type "${savedEl.type}". ` +
        `Register it in the ComponentRegistry before loading.`,
    );
  }

  const props = restoreProperties(savedEl.properties);
  const element = def.factory(props);

  element.position = { x: savedEl.position.x, y: savedEl.position.y };
  element.rotation = degreesToRotation(savedEl.rotation);
  element.mirror = savedEl.mirror ?? false;

  // Restore the persisted instanceId (readonly on the class, but must be
  // restored exactly for round-trip fidelity).
  (element as { instanceId: string }).instanceId = savedEl.id;

  return element;
}

function createWire(savedWire: DtsWire): Wire {
  if (savedWire.points.length < 2) {
    throw new Error(
      `deserializeDts: wire must have at least 2 points, got ${savedWire.points.length}`,
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
 * Options for populating runtime registries during DTS deserialization.
 */
export interface DtsDeserializeOptions {
  /**
   * When provided, named parameter sets from the document are added to this
   * library so they are available at compile time.
   */
  modelLibrary?: ModelLibrary;
  /**
   * When provided, model definition circuits from the document are
   * deserialized and registered here so they can be expanded at compile time.
   */
  transistorModelRegistry?: SubcircuitModelRegistry;
}

/**
 * Parse a .dts JSON string back to Circuit objects.
 *
 * Returns the main circuit and a map of subcircuit names to Circuit objects.
 * The subcircuits map is empty when the document has no `subcircuitDefinitions`.
 * Accepts both `format: 'dts'` (current) and `format: 'digb'`.
 *
 * When `options.modelLibrary` is provided, named parameter sets are added to
 * it. When `options.transistorModelRegistry` is provided, model definition
 * circuits are registered in it.
 *
 * @throws Error if the JSON is malformed or the document fails validation.
 * @throws Error if any component type is not found in the registry.
 */
export function deserializeDts(
  json: string,
  registry: ComponentRegistry,
  options?: DtsDeserializeOptions,
): { circuit: Circuit; subcircuits: Map<string, Circuit> } {
  const raw = JSON.parse(json) as unknown;
  const doc = validateDtsDocument(raw);

  const circuit = deserializeDtsCircuit(doc.circuit, registry);

  const subcircuits = new Map<string, Circuit>();
  if (doc.subcircuitDefinitions !== undefined) {
    for (const [name, subDef] of Object.entries(doc.subcircuitDefinitions)) {
      subcircuits.set(name, deserializeDtsCircuit(subDef, registry));
    }
  }

  if (doc.namedParameterSets !== undefined) {
    circuit.metadata.namedParameterSets = doc.namedParameterSets;
    if (options?.modelLibrary !== undefined) {
      for (const [name, entry] of Object.entries(doc.namedParameterSets)) {
        options.modelLibrary.add({
          name,
          type: entry.deviceType as import('../core/analog-types.js').DeviceType,
          level: 1,
          params: entry.params,
        });
      }
    }
  }

  if (doc.modelDefinitions !== undefined) {
    const modelDefinitions: Record<string, { ports: string[]; elementCount: number }> = {};
    for (const [name, dtsDef] of Object.entries(doc.modelDefinitions)) {
      const attrs = dtsDef.attributes ?? {};
      const hasTopology = dtsDef.elements.length > 0 || dtsDef.wires.length > 0;
      let ports: string[];
      let elementCount: number;
      if (hasTopology) {
        const modelCircuit = deserializeDtsCircuit(dtsDef, registry);
        elementCount = modelCircuit.elements.length;
        ports = attrs['ports'] !== undefined
          ? (JSON.parse(attrs['ports']) as string[])
          : [];
        if (options?.transistorModelRegistry !== undefined) {
          options.transistorModelRegistry.register(name, modelCircuit);
        }
      } else {
        ports = attrs['ports'] !== undefined
          ? (JSON.parse(attrs['ports']) as string[])
          : [];
        elementCount = attrs['elementCount'] !== undefined
          ? parseInt(attrs['elementCount'], 10)
          : 0;
      }
      modelDefinitions[name] = { ports, elementCount };
    }
    circuit.metadata.modelDefinitions = modelDefinitions;
  }

  return { circuit, subcircuits };
}
