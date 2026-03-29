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
import type { MnaSubcircuitNetlist, SubcircuitElement } from '../core/mna-subcircuit-netlist.js';
import { pinWorldPosition } from '../core/pin.js';
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
// Circuit -> MnaSubcircuitNetlist conversion
// ---------------------------------------------------------------------------

function circuitToMnaNetlist(
  subcircuit: Circuit,
  portNames: string[],
): MnaSubcircuitNetlist {
  const pointToId = new Map<string, number>();
  let nextPointId = 0;

  function getId(x: number, y: number): number {
    const k = x + ',' + y;
    let id = pointToId.get(k);
    if (id === undefined) {
      id = nextPointId++;
      pointToId.set(k, id);
    }
    return id;
  }

  for (const wire of subcircuit.wires) {
    getId(wire.start.x, wire.start.y);
    getId(wire.end.x, wire.end.y);
  }
  for (const el of subcircuit.elements) {
    for (const pin of el.getPins()) {
      const wp = pinWorldPosition(el, pin);
      getId(wp.x, wp.y);
    }
  }

  const parent = Array.from({ length: nextPointId }, (_, i) => i);
  const rnk = new Array<number>(nextPointId).fill(0);

  function find(i: number): number {
    while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; }
    return i;
  }
  function union(a: number, b: number): void {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (rnk[ra]! < rnk[rb]!) parent[ra] = rb;
    else if (rnk[ra]! > rnk[rb]!) parent[rb] = ra;
    else { parent[rb] = ra; rnk[ra]!++; }
  }

  for (const wire of subcircuit.wires) {
    union(getId(wire.start.x, wire.start.y), getId(wire.end.x, wire.end.y));
  }

  const portLabelToRoot = new Map<string, number>();
  const ifaceIds = new Set<string>();

  for (const el of subcircuit.elements) {
    if (el.typeId !== 'In' && el.typeId !== 'Out') continue;
    const props = el.getProperties();
    const label = props.has('label') ? props.get<string>('label') : '';
    if (!label) continue;
    ifaceIds.add(el.instanceId);
    const pins = el.getPins();
    if (pins.length === 0) continue;
    const wp = pinWorldPosition(el, pins[0]);
    portLabelToRoot.set(label, find(getId(wp.x, wp.y)));
  }

  const rootToNet = new Map<number, number>();
  let nextNet = 0;
  for (const portName of portNames) {
    const root = portLabelToRoot.get(portName);
    if (root !== undefined && !rootToNet.has(root)) {
      rootToNet.set(root, nextNet);
    }
    nextNet++;
  }

  function netIdx(pid: number): number {
    const root = find(pid);
    let idx = rootToNet.get(root);
    if (idx === undefined) { idx = nextNet++; rootToNet.set(root, idx); }
    return idx;
  }

  const elements: SubcircuitElement[] = [];
  const netlistArr: number[][] = [];

  for (const el of subcircuit.elements) {
    if (ifaceIds.has(el.instanceId)) continue;
    const subEl: SubcircuitElement = { typeId: el.typeId };
    const props = el.getProperties();

    const overrides = props.has('_spiceModelOverrides')
      ? props.get<string>('_spiceModelOverrides') : undefined;
    if (overrides !== undefined) {
      subEl.params = JSON.parse(overrides) as Record<string, number>;
    }
    const pKeys = ['resistance', 'capacitance', 'inductance', 'voltage', 'current'];
    for (const key of pKeys) {
      if (props.has(key)) {
        if (!subEl.params) subEl.params = {};
        subEl.params[key] = props.get<number>(key);
      }
    }
    const modelName = props.has('subcircuitModel')
      ? props.get<string>('subcircuitModel') : undefined;
    if (modelName !== undefined) subEl.modelRef = modelName;

    elements.push(subEl);
    const pinNets: number[] = [];
    for (const pin of el.getPins()) {
      const wp = pinWorldPosition(el, pin);
      pinNets.push(netIdx(getId(wp.x, wp.y)));
    }
    netlistArr.push(pinNets);
  }

  return {
    ports: portNames,
    elements,
    internalNetCount: nextNet - portNames.length,
    netlist: netlistArr,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the model-related fields of a DtsDocument from circuit metadata.
 *
 * When a `SubcircuitModelRegistry` is provided, model definition circuits are
 * converted to MnaSubcircuitNetlist format. Without the registry, the metadata
 * MnaSubcircuitNetlist is written directly.
 */
function buildModelFields(
  circuit: Circuit,
  transistorModels?: SubcircuitModelRegistry,
): Pick<DtsDocument, 'modelDefinitions' | 'namedParameterSets' | 'subcircuitBindings'> {
  const result: Pick<DtsDocument, 'modelDefinitions' | 'namedParameterSets' | 'subcircuitBindings'> = {};

  if (circuit.metadata.modelDefinitions !== undefined) {
    const modelDefinitions: Record<string, MnaSubcircuitNetlist> = {};
    for (const [name, def] of Object.entries(circuit.metadata.modelDefinitions)) {
      const fullCircuit = transistorModels?.get(name);
      if (fullCircuit !== undefined) {
        modelDefinitions[name] = circuitToMnaNetlist(fullCircuit, def.ports);
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
 * When `transistorModels` is provided, model definition circuits are serialized
 * in full topology from the registry.
 *
 * Output is deterministic: same circuit always produces byte-identical JSON.
 */
export function serializeCircuit(
  circuit: Circuit,
  transistorModels?: SubcircuitModelRegistry,
): string {
  const doc: DtsDocument = {
    format: 'dts',
    version: 1,
    circuit: circuitToDtsCircuit(circuit),
    ...buildModelFields(circuit, transistorModels),
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
 * When `transistorModels` is provided, model definition circuits are serialized
 * in full topology from the registry.
 */
export function serializeWithSubcircuits(
  circuit: Circuit,
  subcircuits: Map<string, Circuit>,
  transistorModels?: SubcircuitModelRegistry,
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
    ...buildModelFields(circuit, transistorModels),
  };

  return JSON.stringify(doc, sortedReplacer, 2);
}
