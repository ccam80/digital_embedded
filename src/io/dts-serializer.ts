/**
 * Serializer for the .dts (digiTS) native JSON format.
 *
 * Converts Circuit objects to .dts JSON strings. bigint property values are
 * encoded as "_bigint:<n>" strings for JSON compatibility.
 */

import type { Circuit } from '../core/circuit.js';
import type { CircuitElement } from '../core/element.js';
import type { Wire } from '../core/circuit.js';
import type { ModelEntry } from '../core/registry.js';
import type {
  DtsDocument,
  DtsCircuit,
  DtsElement,
  DtsWire,
  DtsSerializedModelEntry,
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

function elementToDtsElement(
  element: CircuitElement,
  circuitModels?: Record<string, Record<string, ModelEntry>>,
): DtsElement {
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

  const bag = element.getProperties();
  const modelKey = bag.has('model') ? bag.get<string>('model') : undefined;
  if (modelKey !== undefined && modelKey !== '' && circuitModels !== undefined) {
    const componentModels = circuitModels[element.typeId];
    const entry = componentModels?.[modelKey];
    if (entry !== undefined) {
      const defaults = entry.params;
      const deltaParams: Record<string, number> = {};
      for (const key of bag.getModelParamKeys()) {
        const current = bag.getModelParam<number>(key);
        if (current !== defaults[key] && Number.isFinite(current)) {
          deltaParams[key] = current;
        }
      }
      result.modelParamDeltas = {
        model: modelKey,
        params: sortObjectKeys(deltaParams) as Record<string, number>,
      };
    }
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
  const circuitModels = circuit.metadata.models;
  const result: DtsCircuit = {
    name: circuit.metadata.name,
    elements: circuit.elements.map(el => elementToDtsElement(el, circuitModels)),
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
 * Project a runtime ModelEntry to its serialized form.
 * Factories are function references and are never serialized.
 * Inline entries: strip factory and paramDefs (rehydrated from component registry on load).
 * Netlist entries: keep netlist and paramDefs; no factory to strip.
 */
function serializeModelEntry(entry: ModelEntry): DtsSerializedModelEntry {
  if (entry.kind === 'inline') {
    return { kind: 'inline', params: entry.params };
  }
  return { kind: 'netlist', netlist: entry.netlist, paramDefs: entry.paramDefs, params: entry.params };
}

/**
 * Build the model-related fields of a DtsDocument from circuit metadata.
 * Returns an object with a `models` key when runtime models are present,
 * or an empty object when there are no user-imported models.
 */
function buildModelFields(
  circuit: Circuit,
): { models?: Record<string, Record<string, DtsSerializedModelEntry>> } {
  const runtimeModels = circuit.metadata.models;
  if (runtimeModels === undefined || Object.keys(runtimeModels).length === 0) {
    return {};
  }
  const serialized: Record<string, Record<string, DtsSerializedModelEntry>> = {};
  for (const [compType, compModels] of Object.entries(runtimeModels)) {
    if (Object.keys(compModels).length === 0) {
      continue;
    }
    serialized[compType] = {};
    for (const [modelName, entry] of Object.entries(compModels)) {
      serialized[compType][modelName] = serializeModelEntry(entry);
    }
  }
  if (Object.keys(serialized).length === 0) {
    return {};
  }
  return { models: serialized };
}

/**
 * Serialize a Circuit to a .dts JSON string.
 *
 * Produces a self-contained document with `format: "dts"`, `version: 1`,
 * and no `subcircuitDefinitions` key (standalone circuit).
 *
 * Output is deterministic: same circuit always produces byte-identical JSON.
 */
export function serializeCircuit(
  circuit: Circuit,
): string {
  const doc: DtsDocument = {
    format: 'dts',
    version: 1,
    circuit: circuitToDtsCircuit(circuit),
    ...buildModelFields(circuit),
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
 */
export function serializeWithSubcircuits(
  circuit: Circuit,
  subcircuits: Map<string, Circuit>,
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
    ...buildModelFields(circuit),
  };

  return JSON.stringify(doc, sortedReplacer, 2);
}
