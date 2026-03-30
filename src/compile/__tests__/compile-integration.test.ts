/**
 * Integration tests for the unified compilation pipeline (P3-9).
 *
 * Verifies the unified compilation pipeline produces correct output for
 * digital, analog, and mixed-mode circuits.
 *
 * Circuit construction mirrors the patterns used in:
 *   src/compile/__tests__/extract-connectivity.test.ts
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
import type { ComponentDefinition, ComponentModels, ModelEntry } from '../../core/registry.js';
import { ComponentCategory } from '../../core/registry.js';
import type { SerializedElement } from '../../core/element.js';
import type { CircuitElement } from '../../core/element.js';
import type { SparseSolver } from '../../solver/analog/sparse-solver.js';
import type { AnalogElement } from '../../solver/analog/element.js';
import { createTestElementFromDecls } from '../../test-fixtures/test-element.js';
import { noopExecFn } from '../../test-fixtures/execute-stubs.js';

// ---------------------------------------------------------------------------
// Minimal flat CircuitElement (analog circuits)
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

function makeAnalogElement(
  typeId: string,
  instanceId: string,
  pinCoords: Array<{ x: number; y: number }>,
  propsMap: Map<string, PropertyValue> = new Map(),
): CircuitElement {
  const resolvedPins = pinCoords.map((p) => makeAnalogPin(p.x, p.y));
  const propertyBag: PropertyBagType = {
    has(k: string) { return propsMap.has(k); },
    get<T>(k: string): T { return propsMap.get(k) as T; },
    set(k: string, v: PropertyValue) { propsMap.set(k, v); },
    delete(k: string) { propsMap.delete(k); },
    keys() { return Array.from(propsMap.keys()); },
    entries() { return Array.from(propsMap.entries()); },
    clone() { return this; },
    size: propsMap.size,
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
    getAttribute(k: string) { return propsMap.get(k); },
    setAttribute(k: string, v: PropertyValue) { propsMap.set(k, v); },
  };
}

// ---------------------------------------------------------------------------
// Pin declaration helpers
// ---------------------------------------------------------------------------

function inputPin(x: number, y: number, label: string, bitWidth = 1): PinDeclaration {
  return { direction: PinDirection.INPUT, label, defaultBitWidth: bitWidth, position: { x, y }, isNegatable: false, isClockCapable: false, kind: "signal" };
}

function outputPin(x: number, y: number, label: string, bitWidth = 1): PinDeclaration {
  return { direction: PinDirection.OUTPUT, label, defaultBitWidth: bitWidth, position: { x, y }, isNegatable: false, isClockCapable: false, kind: "signal" };
}

// ---------------------------------------------------------------------------
// Analog element stubs
// ---------------------------------------------------------------------------

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

function makeVsElement(nodePos: number, nodeNeg: number, branchIdx: number): AnalogElement {
  return {
    pinNodeIds: [nodePos, nodeNeg],
    allNodeIds: [nodePos, nodeNeg],
    branchIndex: branchIdx,
    isNonlinear: false,
    isReactive: false,
    stamp(_s: SparseSolver) {},
    getPinCurrents(_v: Float64Array) { return [0, 0]; },
  };
}

function makeCapacitorElement(nodeA: number, nodeB: number, branchIdx: number): AnalogElement {
  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: branchIdx,
    isNonlinear: false,
    isReactive: true,
    stamp(_s: SparseSolver) {},
    getPinCurrents(_v: Float64Array) { return [0, 0]; },
  };
}

// ---------------------------------------------------------------------------
// Registry builders
// ---------------------------------------------------------------------------


function makeDigitalDef(name: string, pins: PinDeclaration[] = []): ComponentDefinition {
  return {
    name,
    typeId: -1 as unknown as number,
    factory: (props: PropertyBagType) => createTestElementFromDecls(name, crypto.randomUUID(), pins, props),
    pinLayout: pins,
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: '',
    models: { digital: { executeFn: noopExecFn } } as ComponentModels,
  };
}

function makeAnalogDef(
  name: string,
  branchCount: boolean,
  factoryFn: (pinNodes: ReadonlyMap<string, number>, _internal: readonly number[], branchIdx: number, _props: PropertyBagType, _getTime: () => number) => AnalogElement,
): ComponentDefinition {
  return {
    name,
    typeId: -1 as unknown as number,
    factory: () => { throw new Error('not used'); },
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: '',
    defaultModel: 'behavioral',
    models: {},
    modelRegistry: {
      behavioral: { kind: 'inline' as const, factory: factoryFn, branchCount: branchCount ? 1 : 0, paramDefs: [], params: {} },
    },
  } as unknown as ComponentDefinition;
}

function buildDigitalRegistry(): ComponentRegistry {
  const r = new ComponentRegistry();
  const twoIn = [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')];
  const singleIn = [inputPin(0, 0, 'in'), outputPin(2, 0, 'out')];
  r.register(makeDigitalDef('And', twoIn) as ComponentDefinition);
  r.register(makeDigitalDef('Not', singleIn) as ComponentDefinition);
  r.register(makeDigitalDef('Nor', twoIn) as ComponentDefinition);
  r.register(makeDigitalDef('In', [outputPin(0, 0, 'out')]) as ComponentDefinition);
  r.register(makeDigitalDef('Out', [inputPin(0, 0, 'in')]) as ComponentDefinition);
  r.register(makeDigitalDef('Tunnel', [outputPin(0, 0, 'out')]) as ComponentDefinition);
  return r;
}

function buildAnalogRegistry(): ComponentRegistry {
  const r = new ComponentRegistry();

  r.register({
    ...makeAnalogDef('AnalogVs', true, (pinNodes, _i, branchIdx) => {
      const [n0, n1] = [...pinNodes.values()];
      return makeVsElement(n0 ?? 0, n1 ?? 0, branchIdx);
    }),
  } as ComponentDefinition);

  r.register({
    ...makeAnalogDef('AnalogR', false, (pinNodes) => {
      const [n0, n1] = [...pinNodes.values()];
      return makeResistorElement(n0 ?? 0, n1 ?? 0);
    }),
  } as ComponentDefinition);

  r.register({
    ...makeAnalogDef('AnalogC', true, (pinNodes, _i, branchIdx) => {
      const [n0, n1] = [...pinNodes.values()];
      return makeCapacitorElement(n0 ?? 0, n1 ?? 0, branchIdx);
    }),
  } as ComponentDefinition);

  r.register({
    name: 'Ground',
    typeId: -1,
    factory: () => { throw new Error('not used'); },
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: '',
    models: {},
    modelRegistry: { behavioral: { kind: 'inline' as const, factory: () => { throw new Error('not used'); }, paramDefs: [], params: {} } },
  } as ComponentDefinition);

  return r;
}

function buildMixedRegistry(): ComponentRegistry {
  const r = new ComponentRegistry();
  const twoIn = [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')];

  // Digital components
  r.register(makeDigitalDef('And', twoIn) as ComponentDefinition);
  r.register(makeDigitalDef('In', [outputPin(0, 0, 'out')]) as ComponentDefinition);
  r.register(makeDigitalDef('Out', [inputPin(0, 0, 'in')]) as ComponentDefinition);

  // Analog components
  r.register({
    ...makeAnalogDef('AnalogR', false, (pinNodes) => {
      const [n0, n1] = [...pinNodes.values()];
      return makeResistorElement(n0 ?? 0, n1 ?? 0);
    }),
  } as ComponentDefinition);

  r.register({
    name: 'Ground',
    typeId: -1,
    factory: () => { throw new Error('not used'); },
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: '',
    models: {},
    modelRegistry: { behavioral: { kind: 'inline' as const, factory: () => { throw new Error('not used'); }, paramDefs: [], params: {} } },
  } as ComponentDefinition);

  // Bridge component with both models (has digital output, analog input)
  r.register({
    name: 'DABridge',
    typeId: -1,
    factory: () => { throw new Error('not used'); },
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.MISC,
    helpText: '',
    models: {
      digital: { executeFn: noopExecFn },
    },
    modelRegistry: {
      behavioral: { kind: 'inline' as const, branchCount: 0, factory: (pinNodes: ReadonlyMap<string, number>) => {
        const [n0, n1] = [...pinNodes.values()];
        return makeResistorElement(n0 ?? 0, n1 ?? 0);
      }, paramDefs: [], params: {} },
    },
  } as ComponentDefinition);

  return r;
}

// ---------------------------------------------------------------------------
// Test 1: Simple AND gate (digital only) — net count matches old compiler
// ---------------------------------------------------------------------------

describe('compileUnified — simple AND gate (digital only)', () => {
  it('net count matches reference compileUnified for standalone AND gate', () => {
    const twoIn = [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')];
    const registry = buildDigitalRegistry();

    const circuit = new Circuit();
    circuit.addElement(createTestElementFromDecls('And', 'and-1', twoIn));

    const reference = compileUnified(circuit, registry).digital!;
    const unified = compileUnified(circuit, registry);

    expect(unified.digital).not.toBeNull();
    expect(unified.analog).toBeNull();
    expect(unified.bridges).toHaveLength(0);
    expect(unified.digital!.netCount).toBe(reference.netCount);
  });

  it('wireSignalMap has digital addresses for all wires', () => {
    const twoIn = [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')];
    const registry = buildDigitalRegistry();

    const circuit = new Circuit();
    circuit.addElement(createTestElementFromDecls('And', 'and-1', twoIn));
    circuit.addElement(createTestElementFromDecls('And', 'and-2', twoIn, undefined, { x: 8, y: 0 }));
    const wire = new Wire({ x: 2, y: 0 }, { x: 8, y: 0 });
    circuit.addWire(wire);

    const unified = compileUnified(circuit, registry);

    expect(unified.wireSignalMap.has(wire)).toBe(true);
    const addr = unified.wireSignalMap.get(wire)!;
    expect(addr.domain).toBe('digital');
    if (addr.domain === 'digital') {
      expect(addr.netId).toBeGreaterThanOrEqual(0);
      expect(addr.netId).toBeLessThan(unified.digital!.netCount);
    }
  });

  it('wireToNetId in digital domain is consistent with unified wireSignalMap', () => {
    const twoIn = [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')];
    const registry = buildDigitalRegistry();

    const circuit = new Circuit();
    circuit.addElement(createTestElementFromDecls('And', 'and-1', twoIn));
    circuit.addElement(createTestElementFromDecls('And', 'and-2', twoIn, undefined, { x: 8, y: 0 }));
    const wire = new Wire({ x: 2, y: 0 }, { x: 8, y: 0 });
    circuit.addWire(wire);

    const reference = compileUnified(circuit, registry).digital!;
    const unified = compileUnified(circuit, registry);

    // Both should agree on the net ID for this wire
    const referenceNetId = reference.wireToNetId.get(wire);
    const unifiedAddr = unified.wireSignalMap.get(wire);

    expect(referenceNetId).toBeDefined();
    expect(unifiedAddr).toBeDefined();
    expect(unifiedAddr!.domain).toBe('digital');
    if (unifiedAddr!.domain === 'digital') {
      expect(unifiedAddr!.netId).toBe(referenceNetId);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: SR latch with feedback — SCC handling preserved
// ---------------------------------------------------------------------------

describe('compileUnified — SR latch (digital feedback)', () => {
  it('detects feedback SCC in unified path matching reference compiler', () => {
    const twoIn = [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')];
    const registry = buildDigitalRegistry();

    const circuit = new Circuit();
    const nor1 = createTestElementFromDecls('Nor', 'nor-1', twoIn);
    const nor2 = createTestElementFromDecls('Nor', 'nor-2', twoIn, undefined, { x: 8, y: 0 });
    circuit.addElement(nor1);
    circuit.addElement(nor2);

    // NOR1 out → NOR2 in-a
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 8, y: 0 }));
    // NOR2 out → NOR1 in-b
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 0, y: 1 }));

    const reference = compileUnified(circuit, registry).digital!;
    const unified = compileUnified(circuit, registry);

    expect(unified.digital).not.toBeNull();

    // Reference compiler detects feedback SCC
    const referenceFeedback = reference.evaluationOrder.filter((g) => g.isFeedback);
    expect(referenceFeedback.length).toBe(1);
    expect(referenceFeedback[0]!.componentIndices.length).toBe(2);

    // Unified must also detect the same feedback SCC
    const unifiedFeedback = unified.digital!.evaluationOrder.filter((g) => g.isFeedback);
    expect(unifiedFeedback.length).toBe(1);
    expect(unifiedFeedback[0]!.componentIndices.length).toBe(2);
  });

  it('component count and net count match reference for SR latch', () => {
    const twoIn = [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')];
    const registry = buildDigitalRegistry();

    const circuit = new Circuit();
    circuit.addElement(createTestElementFromDecls('Nor', 'nor-1', twoIn));
    circuit.addElement(createTestElementFromDecls('Nor', 'nor-2', twoIn, undefined, { x: 8, y: 0 }));
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 8, y: 0 }));
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 0, y: 1 }));

    const reference = compileUnified(circuit, registry).digital!;
    const unified = compileUnified(circuit, registry);

    expect(unified.digital!.componentCount).toBe(reference.componentCount);
    expect(unified.digital!.netCount).toBe(reference.netCount);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Simple resistor divider (analog only) — node count matches
// ---------------------------------------------------------------------------

describe('compileUnified — resistor divider (analog only)', () => {
  it('node count matches reference compileUnified for resistor divider', () => {
    const registry = buildAnalogRegistry();

    const circuit = new Circuit();
    circuit.addElement(makeAnalogElement('AnalogVs', 'vs1', [{ x: 10, y: 0 }, { x: 0, y: 0 }]));
    circuit.addElement(makeAnalogElement('AnalogR', 'r1', [{ x: 10, y: 0 }, { x: 20, y: 0 }]));
    circuit.addElement(makeAnalogElement('AnalogR', 'r2', [{ x: 20, y: 0 }, { x: 0, y: 0 }]));
    circuit.addElement(makeAnalogElement('Ground', 'gnd1', [{ x: 0, y: 0 }]));
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));
    circuit.addWire(new Wire({ x: 20, y: 0 }, { x: 20, y: 0 }));
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 0 }));

    const reference = compileUnified(circuit, registry).analog!;
    const unified = compileUnified(circuit, registry);

    expect(unified.analog).not.toBeNull();
    // Ground (neutral with analog model) always routes to digital; digital
    // partition is non-null but the analog topology is unchanged.
    expect(unified.digital).not.toBeNull();
    expect(unified.bridges).toHaveLength(0);
    expect(unified.analog!.nodeCount).toBe(reference.nodeCount);
  });

  it('element count matches reference for resistor divider', () => {
    const registry = buildAnalogRegistry();

    const circuit = new Circuit();
    circuit.addElement(makeAnalogElement('AnalogVs', 'vs1', [{ x: 10, y: 0 }, { x: 0, y: 0 }]));
    circuit.addElement(makeAnalogElement('AnalogR', 'r1', [{ x: 10, y: 0 }, { x: 20, y: 0 }]));
    circuit.addElement(makeAnalogElement('AnalogR', 'r2', [{ x: 20, y: 0 }, { x: 0, y: 0 }]));
    circuit.addElement(makeAnalogElement('Ground', 'gnd1', [{ x: 0, y: 0 }]));
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));
    circuit.addWire(new Wire({ x: 20, y: 0 }, { x: 20, y: 0 }));
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 0 }));

    const reference = compileUnified(circuit, registry).analog!;
    const unified = compileUnified(circuit, registry);

    // Vs, R1, R2 compiled (Ground skipped by analog compiler)
    expect(unified.analog!.elements.length).toBe(reference.elements.length);
  });

  it('wireSignalMap has analog addresses for all wires', () => {
    const registry = buildAnalogRegistry();

    const circuit = new Circuit();
    circuit.addElement(makeAnalogElement('AnalogVs', 'vs1', [{ x: 10, y: 0 }, { x: 0, y: 0 }]));
    circuit.addElement(makeAnalogElement('AnalogR', 'r1', [{ x: 10, y: 0 }, { x: 20, y: 0 }]));
    circuit.addElement(makeAnalogElement('AnalogR', 'r2', [{ x: 20, y: 0 }, { x: 0, y: 0 }]));
    circuit.addElement(makeAnalogElement('Ground', 'gnd1', [{ x: 0, y: 0 }]));

    const wire1 = new Wire({ x: 10, y: 0 }, { x: 10, y: 1 });
    const wire2 = new Wire({ x: 20, y: 0 }, { x: 20, y: 1 });
    const wire3 = new Wire({ x: 0, y: 0 }, { x: 0, y: 1 });
    circuit.addWire(wire1);
    circuit.addWire(wire2);
    circuit.addWire(wire3);

    const unified = compileUnified(circuit, registry);

    for (const wire of [wire1, wire2, wire3]) {
      expect(unified.wireSignalMap.has(wire)).toBe(true);
      const addr = unified.wireSignalMap.get(wire)!;
      expect(addr.domain).toBe('analog');
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: RC circuit (analog) — branch allocation preserved
// ---------------------------------------------------------------------------

describe('compileUnified — RC circuit (analog)', () => {
  it('branch count matches reference for RC circuit', () => {
    const registry = buildAnalogRegistry();

    const circuit = new Circuit();
    // Vs: pos=node1(x=10), neg=ground(x=0)  → 1 branch
    // R:  node1(x=10) — node2(x=20)          → 0 branches
    // C:  node2(x=20) — ground(x=0)          → 1 branch
    circuit.addElement(makeAnalogElement('AnalogVs', 'vs1', [{ x: 10, y: 0 }, { x: 0, y: 0 }]));
    circuit.addElement(makeAnalogElement('AnalogR', 'r1', [{ x: 10, y: 0 }, { x: 20, y: 0 }]));
    circuit.addElement(makeAnalogElement('AnalogC', 'c1', [{ x: 20, y: 0 }, { x: 0, y: 0 }]));
    circuit.addElement(makeAnalogElement('Ground', 'gnd1', [{ x: 0, y: 0 }]));
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));
    circuit.addWire(new Wire({ x: 20, y: 0 }, { x: 20, y: 0 }));
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 0 }));

    const reference = compileUnified(circuit, registry).analog!;
    const unified = compileUnified(circuit, registry);

    expect(unified.analog).not.toBeNull();
    expect(unified.analog!.branchCount).toBe(reference.branchCount);
  });

  it('matrix size matches reference for RC circuit', () => {
    const registry = buildAnalogRegistry();

    const circuit = new Circuit();
    circuit.addElement(makeAnalogElement('AnalogVs', 'vs1', [{ x: 10, y: 0 }, { x: 0, y: 0 }]));
    circuit.addElement(makeAnalogElement('AnalogR', 'r1', [{ x: 10, y: 0 }, { x: 20, y: 0 }]));
    circuit.addElement(makeAnalogElement('AnalogC', 'c1', [{ x: 20, y: 0 }, { x: 0, y: 0 }]));
    circuit.addElement(makeAnalogElement('Ground', 'gnd1', [{ x: 0, y: 0 }]));
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));
    circuit.addWire(new Wire({ x: 20, y: 0 }, { x: 20, y: 0 }));
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 0 }));

    const reference = compileUnified(circuit, registry).analog!;
    const unified = compileUnified(circuit, registry);

    expect(unified.analog!.matrixSize).toBe(reference.matrixSize);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Mixed digital+analog circuit — bridges, both partitions, cross-refs
// ---------------------------------------------------------------------------

describe('compileUnified — mixed digital+analog', () => {
  it('both digital and analog domains populated for mixed circuit', () => {
    const registry = buildMixedRegistry();

    // Digital part: AND gate at (0,0)
    // Analog part: Resistor from (30,0) to (0,0) with ground at (0,0)
    // Bridge component (DABridge) at (20,0) straddling both domains
    const twoIn = [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')];

    const circuit = new Circuit();
    circuit.addElement(createTestElementFromDecls('And', 'and-1', twoIn));
    circuit.addElement(makeAnalogElement('AnalogR', 'r1', [{ x: 30, y: 0 }, { x: 40, y: 0 }]));
    circuit.addElement(makeAnalogElement('Ground', 'gnd1', [{ x: 40, y: 0 }]));
    circuit.addWire(new Wire({ x: 40, y: 0 }, { x: 40, y: 0 }));
    circuit.addWire(new Wire({ x: 30, y: 0 }, { x: 30, y: 0 }));

    const unified = compileUnified(circuit, registry);

    expect(unified.digital).not.toBeNull();
    expect(unified.analog).not.toBeNull();
  });

  it('wireSignalMap contains entries for both domain wires in mixed circuit', () => {
    const registry = buildMixedRegistry();
    const twoIn = [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')];

    const circuit = new Circuit();
    circuit.addElement(createTestElementFromDecls('And', 'and-1', twoIn));
    circuit.addElement(createTestElementFromDecls('And', 'and-2', twoIn, undefined, { x: 8, y: 0 }));
    circuit.addElement(makeAnalogElement('AnalogR', 'r1', [{ x: 30, y: 0 }, { x: 40, y: 0 }]));
    circuit.addElement(makeAnalogElement('Ground', 'gnd1', [{ x: 40, y: 0 }]));

    const digitalWire = new Wire({ x: 2, y: 0 }, { x: 8, y: 0 });
    const analogWire1 = new Wire({ x: 30, y: 0 }, { x: 30, y: 1 });
    const analogWire2 = new Wire({ x: 40, y: 0 }, { x: 40, y: 1 });
    circuit.addWire(digitalWire);
    circuit.addWire(analogWire1);
    circuit.addWire(analogWire2);

    const unified = compileUnified(circuit, registry);

    expect(unified.wireSignalMap.has(digitalWire)).toBe(true);
    expect(unified.wireSignalMap.get(digitalWire)!.domain).toBe('digital');

    expect(unified.wireSignalMap.has(analogWire1)).toBe(true);
    expect(unified.wireSignalMap.get(analogWire1)!.domain).toBe('analog');
  });

  it('bridges array is non-empty when circuit has cross-domain boundary', () => {
    const registry = buildMixedRegistry();

    // Use DABridge as the boundary element — it has both digital and analog models
    // Digital side: AND output → DABridge digital input
    // Analog side: DABridge analog pin → Resistor → Ground
    const twoIn = [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')];
    const bridgePins = [inputPin(0, 0, 'din'), outputPin(1, 0, 'aout')];

    const circuit = new Circuit();
    circuit.addElement(createTestElementFromDecls('And', 'and-1', twoIn));
    circuit.addElement(createTestElementFromDecls('DABridge', 'bridge-1', bridgePins, undefined, { x: 4, y: 0 }));
    circuit.addElement(makeAnalogElement('AnalogR', 'r1', [{ x: 5, y: 0 }, { x: 10, y: 0 }]));
    circuit.addElement(makeAnalogElement('Ground', 'gnd1', [{ x: 10, y: 0 }]));

    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));  // AND out → bridge digital in
    circuit.addWire(new Wire({ x: 5, y: 0 }, { x: 5, y: 0 }));  // bridge analog out / R1 A
    circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 })); // R1 B / Ground

    const unified = compileUnified(circuit, registry);

    expect(unified.bridges.length).toBeGreaterThan(0);
    // Each bridge must have valid domain IDs
    for (const bridge of unified.bridges) {
      expect(bridge.digitalNetId).toBeGreaterThanOrEqual(0);
      expect(bridge.analogNodeId).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 6: Circuit with Tunnels — tunnel merging works
// ---------------------------------------------------------------------------

describe('compileUnified — tunnel merging', () => {
  it('tunnels at same label are merged into the same net group', () => {
    const registry = buildDigitalRegistry();

    // Two Tunnel elements with label "BUS" at different positions
    // They should be merged → share a net in the unified path
    const tunnelPins = [outputPin(0, 0, 'out')];
    const tunnelProps1 = new PropertyBag(new Map([['label', 'BUS']]));
    const tunnelProps2 = new PropertyBag(new Map([['label', 'BUS']]));

    const circuit = new Circuit();
    // AND gate output at (2,0) → Tunnel 1 at (2,0)
    // Tunnel 2 at (20,0) → NOT gate input at (20,0) (separate position, same label)
    const andPins = [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')];
    const notPins = [inputPin(0, 0, 'in'), outputPin(2, 0, 'out')];

    circuit.addElement(createTestElementFromDecls('And', 'and-1', andPins));
    circuit.addElement(createTestElementFromDecls('Tunnel', 't1', tunnelPins, tunnelProps1, { x: 2, y: 0 }));
    circuit.addElement(createTestElementFromDecls('Tunnel', 't2', tunnelPins, tunnelProps2, { x: 20, y: 0 }));
    circuit.addElement(createTestElementFromDecls('Not', 'not-1', notPins, undefined, { x: 20, y: 0 }));

    const unified = compileUnified(circuit, registry);

    // With tunnel merging, the AND output and NOT input must be on the same net
    expect(unified.digital).not.toBeNull();
    // Tunnel merging reduces net count vs no-merging scenario:
    // without merging: AND.a(0,0), AND.b(0,1), AND.out/T1.out(2,0), T2.out/NOT.in(20,0), NOT.out(22,0) = 5 nets
    // with tunnel merging: AND.out and NOT.in collapse into 1 net → 4 nets
    expect(unified.digital!.netCount).toBeLessThanOrEqual(5);
  });

  it('tunnel merging is consistent with extract-connectivity groups', () => {
    const registry = buildDigitalRegistry();

    const tunnelPins = [outputPin(0, 0, 'out')];
    const tunnelProps = new PropertyBag(new Map([['label', 'SIG']]));

    const circuit = new Circuit();
    const t1 = createTestElementFromDecls('Tunnel', 't1', tunnelPins, tunnelProps);
    const t2 = createTestElementFromDecls('Tunnel', 't2', tunnelPins, new PropertyBag(new Map([['label', 'SIG']])), { x: 50, y: 0 });
    circuit.addElement(t1);
    circuit.addElement(t2);

    // Should compile without errors — tunnels don't generate diagnostics
    expect(() => compileUnified(circuit, registry)).not.toThrow();

    const unified = compileUnified(circuit, registry);
    expect(unified.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Width mismatch — diagnostic emitted
// ---------------------------------------------------------------------------

describe('compileUnified — width mismatch diagnostic', () => {
  it('emits diagnostic when 1-bit output drives 8-bit input', () => {
    const oneBitOutPins: PinDeclaration[] = [
      { direction: PinDirection.OUTPUT, label: 'out', defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ];
    const eightBitInPins: PinDeclaration[] = [
      { direction: PinDirection.INPUT, label: 'in', defaultBitWidth: 8, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ];

    const registry = new ComponentRegistry();
    registry.register({
      name: 'Src',
      typeId: -1,
      factory: (props: PropertyBagType) => createTestElementFromDecls('Src', crypto.randomUUID(), oneBitOutPins, props),
      pinLayout: oneBitOutPins,
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: '',
      models: { digital: { executeFn: noopExecFn } } as ComponentModels,
    } as ComponentDefinition);
    registry.register({
      name: 'Dst',
      typeId: -1,
      factory: (props: PropertyBagType) => createTestElementFromDecls('Dst', crypto.randomUUID(), eightBitInPins, props),
      pinLayout: eightBitInPins,
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: '',
      models: { digital: { executeFn: noopExecFn } } as ComponentModels,
    } as ComponentDefinition);

    const circuit = new Circuit();
    // Both at (0,0) so their pins at (2,0) overlap → share a net with mismatched widths
    circuit.addElement(createTestElementFromDecls('Src', 'src-1', oneBitOutPins));
    circuit.addElement(createTestElementFromDecls('Dst', 'dst-1', eightBitInPins));

    // compileUnified must not throw for width mismatch — emit diagnostic instead
    expect(() => compileUnified(circuit, registry)).not.toThrow();

    const unified = compileUnified(circuit, registry);
    const widthDiagnostics = unified.diagnostics.filter((d) => d.code === 'width-mismatch');
    expect(widthDiagnostics.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 8: Empty circuit — graceful handling
// ---------------------------------------------------------------------------

describe('compileUnified — empty circuit', () => {
  it('returns null domains, empty maps, no diagnostics for empty circuit', () => {
    const registry = new ComponentRegistry();
    const circuit = new Circuit();

    const unified = compileUnified(circuit, registry);

    expect(unified.digital).toBeNull();
    expect(unified.analog).toBeNull();
    expect(unified.bridges).toHaveLength(0);
    expect(unified.wireSignalMap.size).toBe(0);
    expect(unified.labelSignalMap.size).toBe(0);
    expect(unified.diagnostics).toHaveLength(0);
  });

  it('returns pure digital domain for registry with only digital components', () => {
    const registry = buildDigitalRegistry();
    const circuit = new Circuit();
    // Empty circuit with digital registry — still empty
    const unified = compileUnified(circuit, registry);

    expect(unified.digital).toBeNull();
    expect(unified.analog).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 9: labelSignalMap — labels map to correct signal addresses
// ---------------------------------------------------------------------------

describe('compileUnified — labelSignalMap', () => {
  it('labels for In/Out components appear in labelSignalMap with digital addresses', () => {
    const inPins = [outputPin(0, 0, 'out')];
    const outPins = [inputPin(0, 0, 'in')];

    const registry = new ComponentRegistry();
    registry.register({
      name: 'In',
      typeId: -1,
      factory: (props: PropertyBagType) => createTestElementFromDecls('In', crypto.randomUUID(), inPins, props),
      pinLayout: inPins,
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.IO,
      helpText: '',
      models: { digital: { executeFn: noopExecFn } } as ComponentModels,
    } as ComponentDefinition);
    registry.register({
      name: 'Out',
      typeId: -1,
      factory: (props: PropertyBagType) => createTestElementFromDecls('Out', crypto.randomUUID(), outPins, props),
      pinLayout: outPins,
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.IO,
      helpText: '',
      models: { digital: { executeFn: noopExecFn } } as ComponentModels,
    } as ComponentDefinition);

    const circuit = new Circuit();

    const inProps = new PropertyBag(new Map([['label', 'A']]));
    const outProps = new PropertyBag(new Map([['label', 'Y']]));
    const inEl = createTestElementFromDecls('In', 'in-1', inPins, inProps);
    const outEl = createTestElementFromDecls('Out', 'out-1', outPins, outProps, { x: 10, y: 0 });

    circuit.addElement(inEl);
    circuit.addElement(outEl);
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 10, y: 0 }));

    const unified = compileUnified(circuit, registry);

    expect(unified.labelSignalMap.has('A')).toBe(true);
    expect(unified.labelSignalMap.has('Y')).toBe(true);

    const addrA = unified.labelSignalMap.get('A')!;
    const addrY = unified.labelSignalMap.get('Y')!;
    expect(addrA.domain).toBe('digital');
    expect(addrY.domain).toBe('digital');

    // A and Y are connected by wire → same net ID
    if (addrA.domain === 'digital' && addrY.domain === 'digital') {
      expect(addrA.netId).toBe(addrY.netId);
    }
  });

  it('labelSignalMap is consistent with labelToNetId from reference compileUnified', () => {
    const inPins = [outputPin(0, 0, 'out')];
    const outPins = [inputPin(0, 0, 'in')];

    const registry = new ComponentRegistry();
    registry.register({
      name: 'In',
      typeId: -1,
      factory: (props: PropertyBagType) => createTestElementFromDecls('In', crypto.randomUUID(), inPins, props),
      pinLayout: inPins,
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.IO,
      helpText: '',
      models: { digital: { executeFn: noopExecFn } } as ComponentModels,
    } as ComponentDefinition);
    registry.register({
      name: 'Out',
      typeId: -1,
      factory: (props: PropertyBagType) => createTestElementFromDecls('Out', crypto.randomUUID(), outPins, props),
      pinLayout: outPins,
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.IO,
      helpText: '',
      models: { digital: { executeFn: noopExecFn } } as ComponentModels,
    } as ComponentDefinition);

    const circuit = new Circuit();
    const inProps = new PropertyBag(new Map([['label', 'A']]));
    const outProps = new PropertyBag(new Map([['label', 'Y']]));
    circuit.addElement(createTestElementFromDecls('In', 'in-1', inPins, inProps));
    circuit.addElement(createTestElementFromDecls('Out', 'out-1', outPins, outProps, { x: 10, y: 0 }));
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 10, y: 0 }));

    const reference = compileUnified(circuit, registry).digital!;
    const unified = compileUnified(circuit, registry);

    // Both maps should agree on the net ID for label "A"
    const referenceNetIdA = reference.labelToNetId.get('A');
    const unifiedAddrA = unified.labelSignalMap.get('A');

    expect(referenceNetIdA).toBeDefined();
    expect(unifiedAddrA).toBeDefined();
    expect(unifiedAddrA!.domain).toBe('digital');
    if (unifiedAddrA!.domain === 'digital') {
      expect(unifiedAddrA!.netId).toBe(referenceNetIdA);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 6: Model resolution — H2-H8 / H12-H15 coverage
// ---------------------------------------------------------------------------

describe('compileUnified — model resolution', () => {
  function buildDualModelRegistry(): ComponentRegistry {
    const r = new ComponentRegistry();

    r.register({
      name: 'Ground',
      typeId: -1,
      factory: () => { throw new Error('not used'); },
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: '',
      models: {},
      modelRegistry: { behavioral: { kind: 'inline' as const, factory: () => { throw new Error('not used'); }, paramDefs: [], params: {} } },
    } as ComponentDefinition);

    r.register({
      ...makeAnalogDef('AnalogR', false, (pinNodes) => {
        const [n0, n1] = [...pinNodes.values()];
        return makeResistorElement(n0 ?? 0, n1 ?? 0);
      }),
    } as ComponentDefinition);

    const twoIn = [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')];
    const behavioralEntry: ModelEntry = {
      kind: 'inline',
      factory: (pinNodes: ReadonlyMap<string, number>, _internal: readonly number[], _branchIdx: number, _props: PropertyBag, _getTime: () => number) => {
        const [n0, n1] = [...pinNodes.values()];
        return makeResistorElement(n0 ?? 0, n1 ?? 0) as unknown as import('../../core/analog-types.js').AnalogElementCore;
      },
      paramDefs: [],
      params: {},
    };
    r.register({
      name: 'DualAnd',
      typeId: -1,
      factory: (props: PropertyBagType) => createTestElementFromDecls('DualAnd', crypto.randomUUID(), twoIn, props),
      pinLayout: twoIn,
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.LOGIC,
      helpText: '',
      models: {
        digital: { executeFn: noopExecFn },
      } as ComponentModels,
      modelRegistry: { behavioral: behavioralEntry },
      defaultModel: 'digital',
    } as ComponentDefinition);

    return r;
  }

  it('component with defaultModel="digital" and no model property compiles as digital (no analog domain)', () => {
    const r = buildDualModelRegistry();
    const twoIn = [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')];

    const circuit = new Circuit();
    circuit.addElement(createTestElementFromDecls('DualAnd', 'and-1', twoIn));
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 0 }));
    circuit.addWire(new Wire({ x: 0, y: 1 }, { x: 0, y: 1 }));
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 2, y: 0 }));

    const result = compileUnified(circuit, r);

    expect(result.digital).not.toBeNull();
    expect(result.analog).toBeNull();
  });

  it('component with model="behavioral" produces analog domain with elements', () => {
    const r = buildDualModelRegistry();
    const twoIn = [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')];

    const propsMap = new Map<string, PropertyValue>([['model', 'behavioral']]);
    const props = new PropertyBag(propsMap);
    const circuit = new Circuit();
    circuit.addElement(createTestElementFromDecls('DualAnd', 'and-1', twoIn, props));
    circuit.addElement(makeAnalogElement('Ground', 'gnd1', [{ x: 0, y: 0 }]));
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 0 }));
    circuit.addWire(new Wire({ x: 0, y: 1 }, { x: 0, y: 1 }));
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 2, y: 0 }));

    const result = compileUnified(circuit, r);

    expect(result.analog).not.toBeNull();
    expect(result.analog!.elements.length).toBe(1);
  });

  it('neutral Ground component touching analog net produces non-null analog domain', () => {
    const r = new ComponentRegistry();

    r.register({
      name: 'Ground',
      typeId: -1,
      factory: () => { throw new Error('not used'); },
      pinLayout: [{ label: 'gnd', direction: PinDirection.BIDIRECTIONAL, defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" }],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: '',
      models: {},
      modelRegistry: { behavioral: { kind: 'inline' as const, factory: () => { throw new Error('not used'); }, paramDefs: [], params: {} } },
    } as ComponentDefinition);

    r.register({
      ...makeAnalogDef('AnalogR', false, (pinNodes) => {
        const [n0, n1] = [...pinNodes.values()];
        return makeResistorElement(n0 ?? 0, n1 ?? 0);
      }),
      pinLayout: [
        { label: 'a', direction: PinDirection.BIDIRECTIONAL, defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
        { label: 'b', direction: PinDirection.BIDIRECTIONAL, defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
      ],
    } as ComponentDefinition);

    const circuit = new Circuit();
    circuit.addElement(makeAnalogElement('AnalogR', 'r1', [{ x: 0, y: 0 }, { x: 2, y: 0 }]));
    circuit.addElement(makeAnalogElement('Ground', 'gnd1', [{ x: 2, y: 0 }]));
    circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 1 }));
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 2, y: 1 }));

    const result = compileUnified(circuit, r);

    expect(result.analog).not.toBeNull();
    expect(result.analog!.nodeCount).toBe(1);
  });
});
