/**
 * Unit tests for DefaultSimulationCoordinator (P4-3).
 */

import { describe, it, expect, vi } from 'vitest';
import { DefaultSimulationCoordinator } from '../coordinator.js';
import { compileUnified } from '../compile.js';
import { Circuit, Wire } from '../../core/circuit.js';
import { AbstractCircuitElement } from '../../core/element.js';
import { PropertyBag, PropertyType } from '../../core/properties.js';
import { PinDirection } from '../../core/pin.js';
import { ComponentRegistry } from '../../core/registry.js';
import { FacadeError } from '../../headless/types.js';
import type { Pin, Rotation } from '../../core/pin.js';
import type { PinDeclaration } from '../../core/pin.js';
import type { RenderContext, Rect } from '../../core/renderer-interface.js';
import type { ComponentDefinition, ComponentLayout, AnalogFactory } from '../../core/registry.js';
import { ComponentCategory } from '../../core/registry.js';
import type { PropertyValue } from '../../core/properties.js';
import type { MeasurementObserver } from '../../core/engine-interface.js';
import type { SerializedElement } from '../../core/element.js';
import type { AnalogElement } from '../../analog/element.js';
import type { SparseSolver } from '../../analog/sparse-solver.js';
import type { SignalAddress, CompiledCircuitUnified } from '../types.js';
import { ConcreteCompiledAnalogCircuit } from '../../analog/compiled-analog-circuit.js';

class MockElement extends AbstractCircuitElement {
  private readonly _pins: Pin[];
  constructor(typeId: string, instanceId: string, position: { x: number; y: number }, pins: Pin[], props: PropertyBag) {
    super(typeId, instanceId, position, 0 as Rotation, false, props);
    this._pins = pins;
  }
  getPins(): readonly Pin[] { return this._pins; }
  draw(_ctx: RenderContext): void {}
  getBoundingBox(): Rect { return { x: this.position.x, y: this.position.y, width: 4, height: 4 }; }
  getHelpText(): string { return ''; }
}

function makePin(label: string, direction: PinDirection, localX: number, localY: number): Pin {
  return { label, direction, position: { x: localX, y: localY }, bitWidth: 1, isNegated: false, isClock: false };
}

function makePropBag(entries: Record<string, string | number | boolean> = {}): PropertyBag {
  const bag = new PropertyBag();
  for (const [k, v] of Object.entries(entries)) bag.set(k, v);
  return bag;
}

const executePassThrough = (_i: number, _s: Uint32Array, _h: Uint32Array, _l: ComponentLayout): void => {};
const executeNoop = (_i: number, _s: Uint32Array, _h: Uint32Array, _l: ComponentLayout): void => {};
const executeAnd2 = (index: number, state: Uint32Array, _h: Uint32Array, layout: ComponentLayout): void => {
  const a = state[layout.wiringTable[layout.inputOffset(index)]] ?? 0;
  const b = state[layout.wiringTable[layout.inputOffset(index) + 1]] ?? 0;
  state[layout.wiringTable[layout.outputOffset(index)]] = (a & b) >>> 0;
};

function buildDigitalRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  registry.register({
    name: 'In', typeId: -1,
    factory: (props) => new MockElement('In', crypto.randomUUID(), { x: 0, y: 0 }, [makePin('out', PinDirection.OUTPUT, 2, 0)], props),
    pinLayout: [], propertyDefs: [{ key: 'label', label: 'Label', type: PropertyType.STRING, defaultValue: '', description: 'Label' }],
    attributeMap: [], category: 'IO' as any, helpText: 'In',
    models: { digital: { executeFn: executePassThrough } },
  });
  registry.register({
    name: 'Out', typeId: -1,
    factory: (props) => new MockElement('Out', crypto.randomUUID(), { x: 0, y: 0 }, [makePin('in', PinDirection.INPUT, 0, 0)], props),
    pinLayout: [], propertyDefs: [{ key: 'label', label: 'Label', type: PropertyType.STRING, defaultValue: '', description: 'Label' }],
    attributeMap: [], category: 'IO' as any, helpText: 'Out',
    models: { digital: { executeFn: executeNoop } },
  });
  registry.register({
    name: 'AND', typeId: -1,
    factory: (props) => new MockElement('AND', crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin('in0', PinDirection.INPUT, -2, -1),
      makePin('in1', PinDirection.INPUT, -2, 1),
      makePin('out', PinDirection.OUTPUT, 2, 0),
    ], props),
    pinLayout: [], propertyDefs: [],
    attributeMap: [], category: 'LOGIC' as any, helpText: 'AND',
    models: { digital: { executeFn: executeAnd2 } },
  });
  return registry;
}

function buildAndGateCircuit(registry: ComponentRegistry): Circuit {
  const circuit = new Circuit();
  const inA = new MockElement('In', 'inA', { x: 0, y: 0 }, [makePin('out', PinDirection.OUTPUT, 2, 0)], makePropBag({ label: 'A' }));
  const inB = new MockElement('In', 'inB', { x: 0, y: 2 }, [makePin('out', PinDirection.OUTPUT, 2, 0)], makePropBag({ label: 'B' }));
  const and = new MockElement('AND', 'and1', { x: 4, y: 0 }, [
    makePin('in0', PinDirection.INPUT, 0, 0),
    makePin('in1', PinDirection.INPUT, 0, 2),
    makePin('out', PinDirection.OUTPUT, 4, 1),
  ], makePropBag());
  const outY = new MockElement('Out', 'outY', { x: 9, y: 1 }, [makePin('in', PinDirection.INPUT, 0, 0)], makePropBag({ label: 'Y' }));
  circuit.elements.push(inA, inB, and, outY);
  circuit.wires.push({ start: { x: 2, y: 0 }, end: { x: 4, y: 0 } } as any);
  circuit.wires.push({ start: { x: 2, y: 2 }, end: { x: 4, y: 2 } } as any);
  circuit.wires.push({ start: { x: 8, y: 1 }, end: { x: 9, y: 1 } } as any);
  void registry;
  return circuit;
}

// ---------------------------------------------------------------------------
// Analog test helpers (mirrors compile.test.ts pattern)
// ---------------------------------------------------------------------------

function makeAnalogElementObj(
  typeId: string,
  instanceId: string,
  pins: Array<{ x: number; y: number; label?: string }>,
) {
  const resolvedPins: Pin[] = pins.map((p) => ({
    position: { x: p.x, y: p.y },
    label: p.label ?? '',
    direction: PinDirection.BIDIRECTIONAL,
    isInverted: false,
    isClock: false,
    bitWidth: 1,
  }));
  const propertyBag = new PropertyBag();
  const serialized: SerializedElement = {
    typeId, instanceId, position: { x: 0, y: 0 },
    rotation: 0 as SerializedElement['rotation'], mirror: false, properties: {},
  };
  return {
    typeId, instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as SerializedElement['rotation'],
    mirror: false,
    getPins() { return resolvedPins; },
    getProperties() { return propertyBag; },
    getBoundingBox(): Rect { return { x: 0, y: 0, width: 10, height: 10 }; },
    draw(_ctx: RenderContext) {},
    serialize() { return serialized; },
    getHelpText() { return ''; },
    getAttribute(_k: string) { return undefined; },
  };
}

function makeResistorAnalogEl(n1: number, n2: number, resistance: number): AnalogElement {
  return {
    pinNodeIds: [n1, n2],
    allNodeIds: [n1, n2],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    stamp(solver: SparseSolver): void {
      const g = 1 / resistance;
      if (n1 !== 0) { solver.stamp(n1 - 1, n1 - 1, g); }
      if (n2 !== 0) { solver.stamp(n2 - 1, n2 - 1, g); }
      if (n1 !== 0 && n2 !== 0) {
        solver.stamp(n1 - 1, n2 - 1, -g);
        solver.stamp(n2 - 1, n1 - 1, -g);
      }
    },
    getPinCurrents(_v: Float64Array): number[] { return [0, 0]; },
  };
}

function makeAnalogDef(
  name: string,
  pinPairs: Array<{ x: number; y: number; label?: string }>,
  analogFactory: AnalogFactory,
): ComponentDefinition {
  return {
    name,
    typeId: -1 as unknown as number,
    factory: () => makeAnalogElementObj(name, crypto.randomUUID(), pinPairs),
    pinLayout: pinPairs.map((p, i) => ({
      direction: PinDirection.BIDIRECTIONAL,
      label: p.label ?? `p${i}`,
      defaultBitWidth: 1,
      position: p,
      isNegatable: false,
      isClockCapable: false,
    })),
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.ANALOG,
    helpText: '',
    models: { analog: { analogFactory, pinElectrical: {} } },
  } as unknown as ComponentDefinition;
}

function makeGroundDef(): ComponentDefinition {
  return {
    name: 'Ground',
    typeId: -1 as unknown as number,
    factory: () => makeAnalogElementObj('Ground', crypto.randomUUID(), [{ x: 0, y: 0, label: 'gnd' }]),
    pinLayout: [{
      direction: PinDirection.BIDIRECTIONAL, label: 'gnd', defaultBitWidth: 1,
      position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false,
    }],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.ANALOG,
    helpText: '',
    models: {
      analog: {
        analogFactory: (_el: unknown, _pins: number[]) => ({
          pinNodeIds: _pins, allNodeIds: _pins, branchIndex: -1,
          isNonlinear: false, isReactive: false,
          stamp(_s: SparseSolver) {},
          getPinCurrents(_v: Float64Array) { return [0]; },
        }),
        pinElectrical: {},
      },
    },
  } as unknown as ComponentDefinition;
}

function buildResistorDividerCircuit(): { circuit: Circuit; registry: ComponentRegistry } {
  const groundDef = makeGroundDef();
  const resistorFactory: AnalogFactory = (
    _el: unknown, pinNodes: number[], _props: unknown,
  ) => makeResistorAnalogEl(pinNodes[0] ?? 0, pinNodes[1] ?? 0, 1000);
  const resistorDef = makeAnalogDef(
    'Resistor',
    [{ x: 0, y: 0, label: 'p1' }, { x: 0, y: 4, label: 'p2' }],
    resistorFactory as AnalogFactory,
  );
  const registry = new ComponentRegistry();
  registry.register(groundDef);
  registry.register(resistorDef);

  const circuit = new Circuit();
  circuit.metadata = { ...circuit.metadata };
  const gndEl = makeAnalogElementObj('Ground', 'gnd-1', [{ x: 0, y: 0, label: 'gnd' }]);
  const res1El = makeAnalogElementObj('Resistor', 'res-1', [{ x: 0, y: 0, label: 'p1' }, { x: 0, y: 4, label: 'p2' }]);
  const res2El = makeAnalogElementObj('Resistor', 'res-2', [{ x: 0, y: 4, label: 'p1' }, { x: 0, y: 8, label: 'p2' }]);
  circuit.addElement(gndEl);
  circuit.addElement(res1El);
  circuit.addElement(res2El);
  return { circuit, registry };
}

// ===========================================================================
// Tests — digital-only
// ===========================================================================

describe('DefaultSimulationCoordinator - digital-only', () => {
  it('has non-null digitalBackend and null analogBackend', () => {
    const registry = buildDigitalRegistry();
    const circuit = buildAndGateCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    expect(coord.digitalBackend).not.toBeNull();
    expect(coord.analogBackend).toBeNull();
    coord.dispose();
  });

  it('compiled property returns the unified output', () => {
    const registry = buildDigitalRegistry();
    const circuit = buildAndGateCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    expect(coord.compiled).toBe(unified);
    coord.dispose();
  });

  it('label IO: A=1 B=1 gives Y=1 after step', () => {
    const registry = buildDigitalRegistry();
    const circuit = buildAndGateCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    coord.writeByLabel('A', { type: 'digital', value: 1 });
    coord.writeByLabel('B', { type: 'digital', value: 1 });
    coord.step();
    const y = coord.readByLabel('Y') as { type: 'digital'; value: number };
    expect(y.type).toBe('digital');
    expect(y.value).toBe(1);
    coord.dispose();
  });

  it('label IO: A=1 B=0 gives Y=0 after step', () => {
    const registry = buildDigitalRegistry();
    const circuit = buildAndGateCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    coord.writeByLabel('A', { type: 'digital', value: 1 });
    coord.writeByLabel('B', { type: 'digital', value: 0 });
    coord.step();
    const y = coord.readByLabel('Y') as { type: 'digital'; value: number };
    expect(y.type).toBe('digital');
    expect(y.value).toBe(0);
    coord.dispose();
  });

  it('readAllSignals returns all labeled signals with digital type', () => {
    const registry = buildDigitalRegistry();
    const circuit = buildAndGateCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    const signals = coord.readAllSignals();
    expect(signals.has('A')).toBe(true);
    expect(signals.has('B')).toBe(true);
    expect(signals.has('Y')).toBe(true);
    for (const [, v] of signals) { expect(v.type).toBe('digital'); }
    coord.dispose();
  });

  it('readSignal with digital address returns digital SignalValue', () => {
    const registry = buildDigitalRegistry();
    const circuit = buildAndGateCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    const addr = unified.labelSignalMap.get('A');
    expect(addr).toBeDefined();
    expect(addr!.domain).toBe('digital');
    const sv = coord.readSignal(addr!);
    expect(sv.type).toBe('digital');
    coord.dispose();
  });

  it('writeSignal with digital address drives AND gate output', () => {
    const registry = buildDigitalRegistry();
    const circuit = buildAndGateCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    const addrA = unified.labelSignalMap.get('A')!;
    const addrB = unified.labelSignalMap.get('B')!;
    coord.writeSignal(addrA, { type: 'digital', value: 1 });
    coord.writeSignal(addrB, { type: 'digital', value: 1 });
    coord.step();
    const sv = coord.readSignal(unified.labelSignalMap.get('Y')!) as { type: 'digital'; value: number };
    expect(sv.value).toBe(1);
    coord.dispose();
  });

  it('MeasurementObserver: onStep called with incrementing count', () => {
    const registry = buildDigitalRegistry();
    const circuit = buildAndGateCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    const onStep = vi.fn();
    const onReset = vi.fn();
    coord.addMeasurementObserver({ onStep, onReset });
    coord.step(); coord.step(); coord.step();
    expect(onStep).toHaveBeenCalledTimes(3);
    expect(onStep.mock.calls[0][0]).toBe(1);
    expect(onStep.mock.calls[2][0]).toBe(3);
    coord.dispose();
  });

  it('MeasurementObserver: onReset called on reset', () => {
    const registry = buildDigitalRegistry();
    const circuit = buildAndGateCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    const onStep = vi.fn();
    const onReset = vi.fn();
    coord.addMeasurementObserver({ onStep, onReset });
    coord.step();
    coord.reset();
    expect(onReset).toHaveBeenCalledTimes(1);
    coord.dispose();
  });

  it('removeMeasurementObserver stops notifications', () => {
    const registry = buildDigitalRegistry();
    const circuit = buildAndGateCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    const onStep = vi.fn();
    const obs: MeasurementObserver = { onStep, onReset: vi.fn() };
    coord.addMeasurementObserver(obs);
    coord.step();
    coord.removeMeasurementObserver(obs);
    coord.step();
    expect(onStep).toHaveBeenCalledTimes(1);
    coord.dispose();
  });

  it('reset resets step count so onStep restarts from 1', () => {
    const registry = buildDigitalRegistry();
    const circuit = buildAndGateCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    const stepCounts: number[] = [];
    coord.addMeasurementObserver({ onStep: (n) => stepCounts.push(n), onReset: vi.fn() });
    coord.step(); coord.step(); coord.reset(); coord.step();
    expect(stepCounts).toEqual([1, 2, 1]);
    coord.dispose();
  });

  it('start/stop/dispose do not throw', () => {
    const registry = buildDigitalRegistry();
    const circuit = buildAndGateCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    expect(() => coord.start()).not.toThrow();
    expect(() => coord.stop()).not.toThrow();
    expect(() => coord.dispose()).not.toThrow();
  });

  it('writeSignal to analog address throws FacadeError on digital-only coordinator', () => {
    const registry = buildDigitalRegistry();
    const circuit = buildAndGateCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    expect(() =>
      coord.writeSignal({ domain: 'analog', nodeId: 0 }, { type: 'analog', voltage: 1.0 }),
    ).toThrow(FacadeError);
    coord.dispose();
  });

  it('writeSignal with analog SignalValue to digital address throws FacadeError', () => {
    const registry = buildDigitalRegistry();
    const circuit = buildAndGateCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    const addrA = unified.labelSignalMap.get('A')!;
    expect(() =>
      coord.writeSignal(addrA, { type: 'analog', voltage: 3.3 }),
    ).toThrow(FacadeError);
    coord.dispose();
  });

  it('readByLabel throws FacadeError for unknown label', () => {
    const registry = buildDigitalRegistry();
    const circuit = buildAndGateCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    expect(() => coord.readByLabel('NONEXISTENT')).toThrow(FacadeError);
    coord.dispose();
  });

  it('degenerate case: digital-only step works with no bridges', () => {
    const registry = buildDigitalRegistry();
    const circuit = buildAndGateCircuit(registry);
    const unified = compileUnified(circuit, registry);
    expect(unified.bridges).toHaveLength(0);
    const coord = new DefaultSimulationCoordinator(unified);
    coord.writeByLabel('A', { type: 'digital', value: 1 });
    coord.writeByLabel('B', { type: 'digital', value: 1 });
    expect(() => coord.step()).not.toThrow();
    coord.dispose();
  });
});

// ===========================================================================
// Tests — analog-only
// ===========================================================================

describe('DefaultSimulationCoordinator - analog-only', () => {
  it('has null digitalBackend and non-null analogBackend', () => {
    const { circuit, registry } = buildResistorDividerCircuit();
    const unified = compileUnified(circuit, registry);
    expect(unified.analog).not.toBeNull();
    const coord = new DefaultSimulationCoordinator(unified);
    expect(coord.digitalBackend).toBeNull();
    expect(coord.analogBackend).not.toBeNull();
    coord.dispose();
  });

  it('step does not throw for analog-only circuit', () => {
    const { circuit, registry } = buildResistorDividerCircuit();
    const unified = compileUnified(circuit, registry);
    expect(unified.analog).not.toBeNull();
    const coord = new DefaultSimulationCoordinator(unified);
    expect(() => coord.step()).not.toThrow();
    coord.dispose();
  });

  it('readSignal with digital address throws FacadeError on analog-only coordinator', () => {
    const { circuit, registry } = buildResistorDividerCircuit();
    const unified = compileUnified(circuit, registry);
    expect(unified.analog).not.toBeNull();
    const coord = new DefaultSimulationCoordinator(unified);
    const addr: SignalAddress = { domain: 'digital', netId: 0, bitWidth: 1 };
    expect(() => coord.readSignal(addr)).toThrow(FacadeError);
    coord.dispose();
  });
});

// ===========================================================================
// Helpers — mixed-signal
// ===========================================================================

/**
 * Build a minimal ConcreteCompiledAnalogCircuit with no elements, suitable
 * for mixed-signal tests that only need both backends to exist.
 */
function buildMinimalAnalogDomain(): ConcreteCompiledAnalogCircuit {
  return new ConcreteCompiledAnalogCircuit({
    nodeCount: 1,
    branchCount: 0,
    elements: [],
    labelToNodeId: new Map(),
    wireToNodeId: new Map(),
    models: new Map(),
    elementToCircuitElement: new Map(),
    bridges: [],
  });
}

/**
 * Assemble a CompiledCircuitUnified that has both digital and analog backends
 * with no bridges. The digital domain comes from a real AND-gate compilation;
 * the analog domain is a minimal stub.
 */
function buildMixedCompiledUnified(): CompiledCircuitUnified {
  const digitalRegistry = buildDigitalRegistry();
  const digitalCircuit = buildAndGateCircuit(digitalRegistry);
  const digitalUnified = compileUnified(digitalCircuit, digitalRegistry);
  // The AND-gate circuit is digital-only, so analog must be null here.
  expect(digitalUnified.digital).not.toBeNull();

  const analogDomain = buildMinimalAnalogDomain();

  return {
    digital: digitalUnified.digital,
    analog: analogDomain,
    bridges: [],
    wireSignalMap: new Map([...digitalUnified.wireSignalMap]),
    labelSignalMap: new Map([...digitalUnified.labelSignalMap]),
    diagnostics: [],
  };
}

// ===========================================================================
// Tests — mixed-signal
// ===========================================================================

describe('DefaultSimulationCoordinator - mixed-signal', () => {
  it('has both digitalBackend and analogBackend for mixed circuit', () => {
    const unified = buildMixedCompiledUnified();
    const coord = new DefaultSimulationCoordinator(unified);
    expect(coord.digitalBackend).not.toBeNull();
    expect(coord.analogBackend).not.toBeNull();
    coord.dispose();
  });

  it('step works without bridges when both backends exist', () => {
    const unified = buildMixedCompiledUnified();
    expect(unified.bridges).toHaveLength(0);
    const coord = new DefaultSimulationCoordinator(unified);
    // With no bridges, _stepMixed takes the early return path: digital.step() + analog.step()
    expect(() => coord.step()).not.toThrow();
    expect(() => coord.step()).not.toThrow();
    coord.dispose();
  });

  it('reset clears bridge state and notifies observers', () => {
    const unified = buildMixedCompiledUnified();
    const coord = new DefaultSimulationCoordinator(unified);
    const onStep = vi.fn();
    const onReset = vi.fn();
    coord.addMeasurementObserver({ onStep, onReset });

    coord.step();
    coord.step();
    coord.step();
    expect(onStep).toHaveBeenCalledTimes(3);

    coord.reset();
    expect(onReset).toHaveBeenCalledTimes(1);

    // After reset, step count restarts from 1
    coord.step();
    expect(onStep.mock.calls[3]![0]).toBe(1);

    coord.dispose();
  });

  it('dispose cleans up both backends without throwing', () => {
    const unified = buildMixedCompiledUnified();
    const coord = new DefaultSimulationCoordinator(unified);
    coord.step();
    expect(() => coord.dispose()).not.toThrow();
  });
});
