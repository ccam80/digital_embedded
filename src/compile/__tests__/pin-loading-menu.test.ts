/**
 * Headless tests for the digitalPinLoading circuit metadata field.
 *
 * Verifies that setting digitalPinLoading to "cross-domain", "all", or "none"
 * produces the expected per-net bridge counts:
 *   all  > cross-domain >= none  (in terms of bridge group count)
 *
 * Components never change partition based on loading mode. The bridge count
 * reflects per-net bridges (one BridgeAdapter per boundary group), not per-
 * component routing.
 *
 * These tests exercise the compile pipeline directly without any UI.
 */

import { describe, it, expect } from 'vitest';
import { compileUnified } from '../compile.js';
import { Circuit, Wire } from '../../core/circuit.js';
import type { Pin, PinDeclaration } from '../../core/pin.js';
import { PinDirection } from '../../core/pin.js';
import type { RenderContext, Rect } from '../../core/renderer-interface.js';
import { PropertyBag } from '../../core/properties.js';
import type { PropertyBag as PropertyBagType, PropertyValue } from '../../core/properties.js';
import { ComponentRegistry } from '../../core/registry.js';
import type { ComponentDefinition, ComponentModels } from '../../core/registry.js';
import { ComponentCategory } from '../../core/registry.js';
import type { SerializedElement, CircuitElement } from '../../core/element.js';
import type { SparseSolver } from '../../solver/analog/sparse-solver.js';
import type { AnalogElement } from '../../solver/analog/element.js';
import { createTestElementFromDecls } from '../../test-fixtures/test-element.js';
import { noopExecFn } from '../../test-fixtures/execute-stubs.js';

// ---------------------------------------------------------------------------
// Minimal digital CircuitElement
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Minimal analog flat element
// ---------------------------------------------------------------------------

function makeAnalogPin(x: number, y: number): Pin {
  return {
    position: { x, y },
    label: '',
    direction: PinDirection.BIDIRECTIONAL,
    isNegated: false,
    isClock: false,
    kind: "signal",
    bitWidth: 1,
  };
}

function makeResistorElement(nodeA: number, nodeB: number): AnalogElement {
  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    stamp(_s: SparseSolver) {},
    getPinCurrents(_v: Float64Array) { return [0, 0]; },
  };
}

function makeAnalogElement(
  typeId: string,
  instanceId: string,
  pinCoords: Array<{ x: number; y: number }>,
): CircuitElement {
  const resolvedPins = pinCoords.map((p) => makeAnalogPin(p.x, p.y));
  const propsMap = new Map<string, unknown>();
  const propertyBag: PropertyBagType = {
    has(k: string) { return propsMap.has(k); },
    get<T>(k: string): T { return propsMap.get(k) as T; },
    set(k: string, v: unknown) { propsMap.set(k, v); },
    delete(k: string) { propsMap.delete(k); },
    keys() { return Array.from(propsMap.keys()); },
    entries() { return Array.from(propsMap.entries()); },
    clone() { return this; },
    size: 0,
  } as unknown as PropertyBagType;

  const serialized: SerializedElement = {
    typeId,
    instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as SerializedElement['rotation'],
    mirror: false,
    properties: {},
  };

  return {
    typeId,
    instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as CircuitElement['rotation'],
    mirror: false,
    getPins() { return resolvedPins; },
    getProperties() { return propertyBag; },
    getBoundingBox(): Rect { return { x: 0, y: 0, width: 10, height: 10 }; },
    draw(_ctx: RenderContext) {},
    serialize() { return serialized; },
    getAttribute(k: string) { return propsMap.get(k) as PropertyValue | undefined; },
    setAttribute(k: string, v: PropertyValue) { propsMap.set(k, v); },
  };
}

// ---------------------------------------------------------------------------
// Pin declaration helpers
// ---------------------------------------------------------------------------

function inputPin(x: number, y: number, label: string): PinDeclaration {
  return { direction: PinDirection.INPUT, label, defaultBitWidth: 1, position: { x, y }, isNegatable: false, isClockCapable: false, kind: "signal" };
}

function outputPin(x: number, y: number, label: string): PinDeclaration {
  return { direction: PinDirection.OUTPUT, label, defaultBitWidth: 1, position: { x, y }, isNegatable: false, isClockCapable: false, kind: "signal" };
}

// ---------------------------------------------------------------------------
// Registry with digital, analog, and dual-model (bridge) components
// ---------------------------------------------------------------------------


function buildMixedRegistry(): ComponentRegistry {
  const r = new ComponentRegistry();

  // Pure digital component
  r.register({
    name: 'And',
    typeId: -1,
    factory: (props: PropertyBagType) => createTestElementFromDecls('And', crypto.randomUUID(), [
      inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out'),
    ], props instanceof PropertyBag ? props : new PropertyBag()),
    pinLayout: [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: '',
    models: { digital: { executeFn: noopExecFn } } as ComponentModels,
  } as ComponentDefinition);

  // Pure analog component
  r.register({
    name: 'AnalogR',
    typeId: -1,
    factory: () => { throw new Error('not used'); },
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: '',
    models: {
      mnaModels: {
        behavioral: {
          branchCount: 0,
          factory: (pinNodes: ReadonlyMap<string, number>) => {
            const [n0, n1] = [...pinNodes.values()];
            return makeResistorElement(n0 ?? 0, n1 ?? 0);
          },
        },
      },
    } as ComponentModels,
  } as ComponentDefinition);

  // Ground (neutral)
  r.register({
    name: 'Ground',
    typeId: -1,
    factory: () => { throw new Error('not used'); },
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: '',
    models: { mnaModels: { behavioral: {} } } as ComponentModels,
  } as ComponentDefinition);

  // Dual-model component: digital model + MNA model
  r.register({
    name: 'DABridge',
    typeId: -1,
    factory: (props: PropertyBagType) => createTestElementFromDecls(
      'DABridge',
      crypto.randomUUID(),
      [inputPin(0, 0, 'din'), outputPin(1, 0, 'aout')],
      props instanceof PropertyBag ? props : new PropertyBag(),
    ),
    pinLayout: [inputPin(0, 0, 'din'), outputPin(1, 0, 'aout')],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: '',
    models: {
      digital: { executeFn: noopExecFn },
      mnaModels: {
        behavioral: {
          branchCount: 0,
          factory: (pinNodes: ReadonlyMap<string, number>) => {
            const [n0, n1] = [...pinNodes.values()];
            return makeResistorElement(n0 ?? 0, n1 ?? 0);
          },
        },
      },
    } as ComponentModels,
  } as ComponentDefinition);

  return r;
}

// ---------------------------------------------------------------------------
// Circuit builder: digital (And) → DABridge → analog (R → Ground)
// Pins at integer coords so connectivity groups form correctly.
// ---------------------------------------------------------------------------
//
// Layout (x coords):
//   And: a=(0,0), b=(0,1), out=(2,0)
//   DABridge: din=(4,0), aout=(5,0)
//   AnalogR: A=(5,0), B=(10,0)
//   Ground: pin=(10,0)
//
// Wires:
//   (2,0)→(4,0)  : And.out → DABridge.din  (digital group)
//   (5,0)→(5,0)  : DABridge.aout / R.A     (analog group, point wire)
//   (10,0)→(10,0): R.B / Ground             (analog group, point wire)

function buildMixedCircuit(): { circuit: Circuit; registry: ComponentRegistry } {
  const registry = buildMixedRegistry();
  const bridgePins = [inputPin(0, 0, 'din'), outputPin(1, 0, 'aout')];
  const andPins = [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')];

  const circuit = new Circuit();
  circuit.addElement(createTestElementFromDecls('And', 'and-1', andPins));
  circuit.addElement(createTestElementFromDecls('DABridge', 'bridge-1', bridgePins));
  circuit.addElement(makeAnalogElement('AnalogR', 'r1', [{ x: 5, y: 0 }, { x: 10, y: 0 }]));
  circuit.addElement(makeAnalogElement('Ground', 'gnd1', [{ x: 10, y: 0 }]));

  circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
  circuit.addWire(new Wire({ x: 5, y: 0 }, { x: 5, y: 0 }));
  circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));

  return { circuit, registry };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('digitalPinLoading — circuit metadata controls bridge adapter synthesis', () => {
  it('default (absent) is equivalent to cross-domain mode', () => {
    const { circuit, registry } = buildMixedCircuit();

    // No metadata set — should behave the same as explicit "cross-domain"
    const resultDefault = compileUnified(circuit, registry);

    circuit.metadata.digitalPinLoading = 'cross-domain';
    const resultExplicit = compileUnified(circuit, registry);

    expect(resultDefault.bridges.length).toBe(resultExplicit.bridges.length);
  });

  it('cross-domain mode produces exactly one bridge for the DABridge element', () => {
    const { circuit, registry } = buildMixedCircuit();
    circuit.metadata.digitalPinLoading = 'cross-domain';

    const result = compileUnified(circuit, registry);

    expect(result.bridges).toHaveLength(1);
  });

  it('all mode produces more bridges than cross-domain for the same circuit', () => {
    const { circuit, registry } = buildMixedCircuit();

    circuit.metadata.digitalPinLoading = 'cross-domain';
    const crossResult = compileUnified(circuit, registry);

    circuit.metadata.digitalPinLoading = 'all';
    const allResult = compileUnified(circuit, registry);

    // "all" injects "analog" into every digital-only net, so more boundary
    // groups are created. Cross-domain only bridges real boundaries.
    expect(allResult.bridges.length).toBeGreaterThan(crossResult.bridges.length);
  });

  it('all mode: bridge count is at least as large as cross-domain bridge count', () => {
    const { circuit, registry } = buildMixedCircuit();

    circuit.metadata.digitalPinLoading = 'cross-domain';
    const crossDomain = compileUnified(circuit, registry);

    circuit.metadata.digitalPinLoading = 'all';
    const all = compileUnified(circuit, registry);

    // Per-net ordering invariant: all >= cross-domain in bridge group count.
    expect(all.bridges.length).toBeGreaterThanOrEqual(crossDomain.bridges.length);
  });

  it('none mode produces zero bridges for a circuit with only digital-model pins at the boundary', () => {
    const { registry } = buildMixedCircuit();

    // Build a purely digital circuit — no analog components at all
    const andPins = [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')];
    const circuit = new Circuit();
    circuit.addElement(createTestElementFromDecls('And', 'and-1', andPins));
    circuit.metadata.digitalPinLoading = 'none';

    const result = compileUnified(circuit, registry);

    expect(result.bridges).toHaveLength(0);
  });

  it('changing digitalPinLoading from cross-domain to all increases bridge count', () => {
    const { circuit, registry } = buildMixedCircuit();

    circuit.metadata.digitalPinLoading = 'cross-domain';
    const crossResult = compileUnified(circuit, registry);

    circuit.metadata.digitalPinLoading = 'all';
    const allResult = compileUnified(circuit, registry);

    // "all" injects "analog" into all digital-only nets, producing more bridges.
    expect(allResult.bridges.length).toBeGreaterThan(crossResult.bridges.length);
  });

  it('none mode on mixed circuit preserves the analog partition', () => {
    const { circuit, registry } = buildMixedCircuit();
    circuit.metadata.digitalPinLoading = 'none';

    const result = compileUnified(circuit, registry);

    // The analog partition must exist (contains AnalogR + Ground elements).
    expect(result.analog).not.toBeNull();
  });
});
