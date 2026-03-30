/**
 * Deserializer for the .dts (digiTS) native JSON format.
 *
 * Parses .dts JSON strings back to Circuit objects. bigint values encoded as
 * "_bigint:<n>" strings are restored to native bigint.
 */

import { Circuit, Wire } from '../core/circuit.js';
import type { CircuitMetadata } from '../core/circuit.js';
import type { ComponentRegistry, ModelEntry } from '../core/registry.js';
import { PropertyBag } from '../core/properties.js';
import type { PropertyValue } from '../core/properties.js';
import type { Rotation } from '../core/pin.js';
import { validateDtsDocument } from './dts-schema.js';
import type { DtsCircuit, DtsElement, DtsWire, DtsSerializedModelEntry } from './dts-schema.js';

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
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, number>;
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

/**
 * Rehydrate a serialized model registry into the runtime form.
 * Inline entries: restore factory and paramDefs from the component registry.
 * Netlist entries: carry their own paramDefs; factory is compiled later.
 */
function rehydrateModels(
  serialized: Record<string, Record<string, DtsSerializedModelEntry>>,
  registry: ComponentRegistry,
): Record<string, Record<string, ModelEntry>> {
  const result: Record<string, Record<string, ModelEntry>> = {};
  for (const [compType, compModels] of Object.entries(serialized)) {
    result[compType] = {};
    const def = registry.get(compType);
    for (const [modelName, entry] of Object.entries(compModels)) {
      if (entry.kind === 'inline') {
        if (def === undefined || def.modelRegistry === undefined) {
          throw new Error(
            `deserializeDts: cannot rehydrate inline model "${compType}"/"${modelName}" — ` +
            `component type "${compType}" not found in registry or has no modelRegistry.`,
          );
        }
        const baseEntry = Object.values(def.modelRegistry)[0];
        if (baseEntry === undefined || baseEntry.kind !== 'inline') {
          throw new Error(
            `deserializeDts: cannot rehydrate inline model "${compType}"/"${modelName}" — ` +
            `no inline base entry found in component modelRegistry.`,
          );
        }
        result[compType][modelName] = {
          kind: 'inline',
          factory: baseEntry.factory,
          paramDefs: baseEntry.paramDefs,
          params: entry.params,
        };
      } else {
        result[compType][modelName] = {
          kind: 'netlist',
          netlist: entry.netlist,
          paramDefs: entry.paramDefs,
          params: entry.params,
        };
      }
    }
  }
  return result;
}

function deserializeDtsCircuit(
  dtsCircuit: DtsCircuit,
  registry: ComponentRegistry,
  circuitModels?: Record<string, Record<string, ModelEntry>>,
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
      const parsed = JSON.parse(overridesRaw) as NonNullable<CircuitMetadata['digitalPinLoadingOverrides']>;
      metadata.digitalPinLoadingOverrides = parsed;
    }
  }

  if (circuitModels !== undefined) {
    metadata.models = circuitModels;
  }

  const circuit = new Circuit(metadata);

  for (const savedEl of dtsCircuit.elements) {
    const element = createElement(savedEl, registry, circuitModels);
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
  circuitModels?: Record<string, Record<string, ModelEntry>>,
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

  if (savedEl.modelParamDeltas !== undefined && circuitModels !== undefined) {
    const { model: modelKey, params: deltaParams } = savedEl.modelParamDeltas;
    const entry = circuitModels[savedEl.type]?.[modelKey];
    if (entry !== undefined) {
      const merged: Record<string, number> = { ...entry.params, ...deltaParams };
      props.replaceModelParams(merged);
    }
  }

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
 * Parse a .dts JSON string back to Circuit objects.
 *
 * Returns the main circuit and a map of subcircuit names to Circuit objects.
 * The subcircuits map is empty when the document has no `subcircuitDefinitions`.
 * Accepts both `format: 'dts'` (current) and `format: 'digb'`.
 *
 * @throws Error if the JSON is malformed or the document fails validation.
 * @throws Error if any component type is not found in the registry.
 * @throws Error if the document contains obsolete fields (namedParameterSets,
 *   modelDefinitions, subcircuitBindings).
 */
export function deserializeDts(
  json: string,
  registry: ComponentRegistry,
): { circuit: Circuit; subcircuits: Map<string, Circuit> } {
  const raw = JSON.parse(json) as unknown;
  const doc = validateDtsDocument(raw);

  const circuitModels =
    doc.models !== undefined
      ? rehydrateModels(doc.models, registry)
      : undefined;

  const circuit = deserializeDtsCircuit(doc.circuit, registry, circuitModels);

  const subcircuits = new Map<string, Circuit>();
  if (doc.subcircuitDefinitions !== undefined) {
    for (const [name, subDef] of Object.entries(doc.subcircuitDefinitions)) {
      subcircuits.set(name, deserializeDtsCircuit(subDef, registry, circuitModels));
    }
  }

  return { circuit, subcircuits };
}
