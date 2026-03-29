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
import type { Rotation, Pin } from '../core/pin.js';
import { PinDirection, pinWorldPosition } from '../core/pin.js';
import type { CircuitElement } from '../core/element.js';
import type { Rect, RenderContext } from '../core/renderer-interface.js';
import type { ModelLibrary } from '../solver/analog/model-library.js';
import type { SubcircuitModelRegistry } from '../solver/analog/subcircuit-model-registry.js';
import type { MnaSubcircuitNetlist } from '../core/mna-subcircuit-netlist.js';
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
// MnaSubcircuitNetlist -> Circuit conversion (for SubcircuitModelRegistry)
// ---------------------------------------------------------------------------

const TYPE_PIN_LABELS: Record<string, string[]> = {
  Resistor: ['A', 'B'],
  Capacitor: ['A', 'B'],
  Inductor: ['A', 'B'],
  Diode: ['A', 'K'],
  NpnBJT: ['B', 'C', 'E'],
  PnpBJT: ['B', 'C', 'E'],
  NMOS: ['G', 'D', 'S'],
  PMOS: ['G', 'D', 'S'],
  NJFET: ['G', 'S', 'D'],
  PJFET: ['G', 'S', 'D'],
  DcVoltageSource: ['neg', 'pos'],
  CurrentSource: ['pos', 'neg'],
};

let _nlCounter = 0;

function makeNlPin(x: number, y: number, label: string): Pin {
  return {
    position: { x, y },
    label,
    direction: PinDirection.BIDIRECTIONAL,
    isInverted: false,
    isClock: false,
    bitWidth: 1,
  };
}

function makeNlElement(
  typeId: string,
  pins: Array<{ x: number; y: number; label: string }>,
  propsEntries: Array<[string, string | number | boolean]> = [],
): CircuitElement {
  const instanceId = typeId + '-nl-' + (++_nlCounter);
  const resolvedPins = pins.map(p => makeNlPin(p.x, p.y, p.label));
  const propsMap = new Map<string, PropertyValue>(
    propsEntries as Array<[string, PropertyValue]>,
  );
  const propertyBag = new PropertyBag(propsMap.entries());
  return {
    typeId,
    instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as Rotation,
    mirror: false,
    getPins() { return resolvedPins; },
    getProperties() { return propertyBag; },
    getBoundingBox(): Rect { return { x: 0, y: 0, width: 10, height: 10 }; },
    draw(_ctx: RenderContext) {},
    serialize() {
      return { typeId, instanceId, position: { x: 0, y: 0 }, rotation: 0 as 0, mirror: false, properties: {} };
    },
    getAttribute(k: string) { return propsMap.get(k); },
  } as CircuitElement;
}

function mnaNetlistToCircuit(
  def: MnaSubcircuitNetlist,
  name: string,
): Circuit {
  const circuit = new Circuit({ name });

  function netToX(n: number): number { return n + 1; }

  for (let i = 0; i < def.ports.length; i++) {
    circuit.addElement(makeNlElement('In', [
      { x: netToX(i), y: 0, label: 'out' },
    ], [['label', def.ports[i]]]));
  }

  let yRow = 2;
  for (let eIdx = 0; eIdx < def.elements.length; eIdx++) {
    const subEl = def.elements[eIdx];
    const conn = def.netlist[eIdx];
    const labels = TYPE_PIN_LABELS[subEl.typeId] ?? conn.map((_: number, i: number) => 'p' + i);

    const props: Array<[string, string | number | boolean]> = [];
    if (subEl.params !== undefined) {
      props.push(['_spiceModelOverrides', JSON.stringify(subEl.params)]);
      for (const [k, v] of Object.entries(subEl.params)) {
        if (typeof v === 'number') props.push([k, v]);
      }
    }
    const pins = conn.map((ni: number, pIdx: number) => ({
      x: netToX(ni),
      y: yRow,
      label: labels[pIdx] ?? ('p' + pIdx),
    }));

    circuit.addElement(makeNlElement(subEl.typeId, pins, props));

    for (const pin of pins) {
      circuit.addWire(new Wire({ x: pin.x, y: 0 }, { x: pin.x, y: yRow }));
    }
    yRow += 2;
  }

  return circuit;
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
    const modelDefinitions: Record<string, MnaSubcircuitNetlist> = {};
    for (const [name, nlDef] of Object.entries(doc.modelDefinitions)) {
      modelDefinitions[name] = nlDef;
      if (options?.transistorModelRegistry !== undefined && nlDef.elements.length > 0) {
        const modelCircuit = mnaNetlistToCircuit(nlDef, name);
        options.transistorModelRegistry.register(name, modelCircuit);
      }
    }
    circuit.metadata.modelDefinitions = modelDefinitions;
  }

  if (doc.subcircuitBindings !== undefined) {
    circuit.metadata.subcircuitBindings = doc.subcircuitBindings as Record<string, string>;
  }

  return { circuit, subcircuits };
}
