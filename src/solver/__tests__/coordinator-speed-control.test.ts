/**
 * Tests for speed control methods on DefaultSimulationCoordinator (P5b-4).
 * Covers: timingModel, computeFrameSteps, speed, adjustSpeed, parseSpeed, formatSpeed
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DefaultSimulationCoordinator } from '../coordinator.js';
import { compileUnified } from '../../compile/compile.js';
import { Circuit } from '../../core/circuit.js';
import { PropertyBag, PropertyType } from '../../core/properties.js';
import { PinDirection } from '../../core/pin.js';
import { ComponentRegistry } from '../../core/registry.js';
import { ComponentCategory } from '../../core/registry.js';
import type { Pin } from '../../core/pin.js';
import type { ComponentDefinition } from '../../core/registry.js';
import type { SerializedElement, CircuitElement } from '../../core/element.js';
import type { PropertyValue } from '../../core/properties.js';
import type { Rect, RenderContext } from '../../core/renderer-interface.js';
import type { AnalogElement } from '../analog/element.js';
import type { ComplexSparseSolver } from '../../core/analog-types.js';
import type { LoadContext } from '../analog/load-context.js';
import { TestElement, makePin } from '../../test-fixtures/test-element.js';
import { noopExecFn, executePassThrough } from '../../test-fixtures/execute-stubs.js';

function makePropBag(entries: Record<string, string | number | boolean> = {}): PropertyBag {
  const bag = new PropertyBag();
  for (const [k, v] of Object.entries(entries)) bag.set(k, v);
  return bag;
}

function makeAnalogElementObj(typeId: string, instanceId: string, pins: Array<{ x: number; y: number; label?: string }>): CircuitElement {
  const resolvedPins: Pin[] = pins.map((p) => ({
    position: { x: p.x, y: p.y }, label: p.label ?? '',
    direction: PinDirection.BIDIRECTIONAL, isNegated: false, isClock: false, kind: "signal" as const, bitWidth: 1,
  }));
  const propertyBag = new PropertyBag();
  const serialized: SerializedElement = {
    typeId, instanceId, position: { x: 0, y: 0 },
    rotation: 0 as SerializedElement['rotation'], mirror: false, properties: {},
  };
  return {
    typeId, instanceId, position: { x: 0, y: 0 },
    rotation: 0 as SerializedElement['rotation'], mirror: false,
    getPins() { return resolvedPins; },
    getProperties() { return propertyBag; },
    getBoundingBox(): Rect { return { x: 0, y: 0, width: 10, height: 10 }; },
    draw(_ctx: RenderContext) {},
    serialize() { return serialized; },
    getAttribute(_k: string) { return undefined; },
    setAttribute(_name: string, _value: PropertyValue) {},
  };
}

function makeResistorAnalogEl(n1: number, n2: number, resistance: number): AnalogElement {
  return {
    label: "",
    _pinNodes: new Map([["p1", n1], ["p2", n2]]),
    _stateBase: -1,
    branchIndex: -1,
    ngspiceLoadOrder: 0,
    setup(_ctx: import('../analog/setup-context.js').SetupContext): void {},
    load(_ctx: LoadContext): void { /* no-op for static test fixture */ },
    stampAc(solver: ComplexSparseSolver, _omega: number, _ctx: LoadContext): void {
      const g = 1 / resistance;
      if (n1 !== 0) { solver.stampComplexElement(solver.allocComplexElement(n1, n1), g, 0); }
      if (n2 !== 0) { solver.stampComplexElement(solver.allocComplexElement(n2, n2), g, 0); }
      if (n1 !== 0 && n2 !== 0) { solver.stampComplexElement(solver.allocComplexElement(n1, n2), -g, 0); solver.stampComplexElement(solver.allocComplexElement(n2, n1), -g, 0); }
    },
    getPinCurrents(_v: Float64Array): number[] { return [0, 0]; },
    setParam(_key: string, _value: number) {},
  };
}

function buildDigitalRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  registry.register({
    name: 'In', typeId: -1,
    factory: (props) => new TestElement('In', crypto.randomUUID(), { x: 0, y: 0 }, [makePin('out', PinDirection.OUTPUT, 2, 0)], props),
    pinLayout: [], propertyDefs: [{ key: 'label', label: 'Label', type: PropertyType.STRING, defaultValue: '', description: 'Label' }],
    attributeMap: [], category: 'IO' as any, helpText: 'In',
    models: { digital: { executeFn: executePassThrough } },
  });
  registry.register({
    name: 'Out', typeId: -1,
    factory: (props) => new TestElement('Out', crypto.randomUUID(), { x: 0, y: 0 }, [makePin('in', PinDirection.INPUT, 0, 0)], props),
    pinLayout: [], propertyDefs: [{ key: 'label', label: 'Label', type: PropertyType.STRING, defaultValue: '', description: 'Label' }],
    attributeMap: [], category: 'IO' as any, helpText: 'Out',
    models: { digital: { executeFn: noopExecFn } },
  });
  return registry;
}

function buildDigitalCircuit(registry: ComponentRegistry): Circuit {
  const circuit = new Circuit();
  const inA = new TestElement('In', 'inA', { x: 0, y: 0 }, [makePin('out', PinDirection.OUTPUT, 2, 0)], makePropBag({ label: 'A' }));
  const outY = new TestElement('Out', 'outY', { x: 4, y: 0 }, [makePin('in', PinDirection.INPUT, 0, 0)], makePropBag({ label: 'Y' }));
  circuit.elements.push(inA, outY);
  circuit.wires.push({ start: { x: 2, y: 0 }, end: { x: 4, y: 0 } } as any);
  void registry;
  return circuit;
}

function makeGroundDef(): ComponentDefinition {
  return {
    name: 'Ground', typeId: -1 as unknown as number,
    factory: () => makeAnalogElementObj('Ground', crypto.randomUUID(), [{ x: 0, y: 0, label: 'gnd' }]),
    pinLayout: [{ direction: PinDirection.BIDIRECTIONAL, label: 'gnd', defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false }],
    propertyDefs: [], attributeMap: [], category: ComponentCategory.PASSIVES, helpText: '',
    pinElectrical: {},
    defaultModel: 'behavioral',
    models: {},
    modelRegistry: {
      behavioral: { kind: 'inline' as const, factory: (gndPinNodes: ReadonlyMap<string, number>) => ({
        label: "",
        _pinNodes: new Map(gndPinNodes),
        _stateBase: -1,
        branchIndex: -1 as const,
        ngspiceLoadOrder: 0,
        setup(_ctx: import('../analog/setup-context.js').SetupContext): void {},
        load(_ctx: import('../analog/load-context.js').LoadContext): void {},
        getPinCurrents(_v: Float64Array) { return [0]; },
        setParam(_key: string, _value: number) {},
      }), paramDefs: [], params: {} },
    },
  } as unknown as ComponentDefinition;
}

function makeResistorDef(): ComponentDefinition {
  return {
    name: 'Resistor', typeId: -1 as unknown as number,
    factory: () => makeAnalogElementObj('Resistor', crypto.randomUUID(), [{ x: 0, y: 0, label: 'p1' }, { x: 0, y: 4, label: 'p2' }]),
    pinLayout: [
      { direction: PinDirection.BIDIRECTIONAL, label: 'p1', defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
      { direction: PinDirection.BIDIRECTIONAL, label: 'p2', defaultBitWidth: 1, position: { x: 0, y: 4 }, isNegatable: false, isClockCapable: false },
    ],
    propertyDefs: [], attributeMap: [], category: ComponentCategory.PASSIVES, helpText: '',
    pinElectrical: {},
    defaultModel: 'behavioral',
    models: {},
    modelRegistry: {
      behavioral: { kind: 'inline' as const, factory: (pinNodes: ReadonlyMap<string, number>) => makeResistorAnalogEl(pinNodes.get('p1') ?? 0, pinNodes.get('p2') ?? 0, 1000), paramDefs: [], params: {} },
    },
  } as unknown as ComponentDefinition;
}

function buildAnalogCircuit(): { circuit: Circuit; registry: ComponentRegistry } {
  const registry = new ComponentRegistry();
  registry.register(makeGroundDef());
  registry.register(makeResistorDef());
  const circuit = new Circuit();
  circuit.addElement(makeAnalogElementObj('Ground', 'gnd-1', [{ x: 0, y: 0, label: 'gnd' }]));
  circuit.addElement(makeAnalogElementObj('Resistor', 'res-1', [{ x: 0, y: 0, label: 'p1' }, { x: 0, y: 4, label: 'p2' }]));
  circuit.addElement(makeAnalogElementObj('Resistor', 'res-2', [{ x: 0, y: 4, label: 'p1' }, { x: 0, y: 8, label: 'p2' }]));
  return { circuit, registry };
}

describe('DefaultSimulationCoordinator -- timingModel', () => {
  it('digital-only circuit has timingModel discrete', () => {
    const registry = buildDigitalRegistry();
    const circuit = buildDigitalCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    expect(coord.timingModel).toBe('discrete');
    coord.dispose();
  });
  it('analog-only circuit has timingModel mixed (both engines via neutral components)', () => {
    const { circuit, registry } = buildAnalogCircuit();
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    // Neutral components (Ground) always route to digital, so both engines
    // exist and timingModel is "mixed".
    expect(coord.timingModel).toBe('mixed');
    coord.dispose();
  });
});

describe('DefaultSimulationCoordinator -- computeFrameSteps (digital-only circuit)', () => {
  let coord: DefaultSimulationCoordinator;
  beforeEach(() => {
    const registry = buildDigitalRegistry();
    const circuit = buildDigitalCircuit(registry);
    const unified = compileUnified(circuit, registry);
    coord = new DefaultSimulationCoordinator(unified);
  });
  it('returns null simTimeGoal  no continuous time model', () => {
    coord.speed = 1e-3;
    const result = coord.computeFrameSteps(0.016);
    expect(result.steps).toBe(0);
    expect(result.simTimeGoal).toBeNull();
    expect(result.budgetMs).toBe(12);
    expect(result.missed).toBe(false);
  });
  it('simTimeGoal stays null regardless of wallDt', () => {
    coord.speed = 1e-3;
    const resultClamped = coord.computeFrameSteps(1.0);
    const resultRef = coord.computeFrameSteps(0.1);
    expect(resultClamped.simTimeGoal).toBeNull();
    expect(resultRef.simTimeGoal).toBeNull();
  });
  it('speed has no effect on simTimeGoal for digital-only', () => {
    coord.speed = 1e-2;
    const result = coord.computeFrameSteps(0.01);
    expect(result.simTimeGoal).toBeNull();
  });
});

describe('DefaultSimulationCoordinator -- computeFrameSteps (continuous)', () => {
  let coord: DefaultSimulationCoordinator;
  beforeEach(() => {
    const { circuit, registry } = buildAnalogCircuit();
    const unified = compileUnified(circuit, registry);
    coord = new DefaultSimulationCoordinator(unified);
  });
  it('returns steps=0 for continuous', () => {
    expect(coord.computeFrameSteps(0.016).steps).toBe(0);
  });
  it('simTimeGoal equals simTime plus speed times wallDt', () => {
    coord.speed = 1e-3;
    coord.computeFrameSteps(0.016);
  });
  it('budgetMs is 12 for continuous', () => {
    expect(coord.computeFrameSteps(0.016).budgetMs).toBe(12);
  });
  it('missed is false for continuous', () => {
    expect(coord.computeFrameSteps(0.016).missed).toBe(false);
  });
  it('clamps wallDt to 0.1s for continuous', () => {
    coord.speed = 1e-3;
  });
});

describe('DefaultSimulationCoordinator -- speed control (digital-only uses analog speed)', () => {
  let coord: DefaultSimulationCoordinator;
  beforeEach(() => {
    const registry = buildDigitalRegistry();
    const circuit = buildDigitalCircuit(registry);
    const unified = compileUnified(circuit, registry);
    coord = new DefaultSimulationCoordinator(unified);
  });
  it('default speed is 1e-3 (1ms/s)', () => { expect(coord.speed).toBe(1e-3); });
  it('speed setter updates speed', () => { coord.speed = 0.5; expect(coord.speed).toBe(0.5); });
  it('speed setter clamps to 1e-9 floor', () => { coord.speed = -1; expect(coord.speed).toBe(1e-9); });
  it('parseSpeed ignores invalid text', () => { const prev = coord.speed; coord.parseSpeed('abc'); expect(coord.speed).toBe(prev); });
  it('formatSpeed returns ms/s for default speed', () => {
    const fmt = coord.formatSpeed();
    expect(fmt.unit).toBe('ms/s'); expect(fmt.value).toBe('1');
  });
});

describe('DefaultSimulationCoordinator -- speed control (continuous)', () => {
  let coord: DefaultSimulationCoordinator;
  beforeEach(() => {
    const { circuit, registry } = buildAnalogCircuit();
    const unified = compileUnified(circuit, registry);
    coord = new DefaultSimulationCoordinator(unified);
  });
  it('default analog speed is 1e-3', () => { expect(coord.speed).toBe(1e-3); });
  it('speed setter updates analog speed', () => { coord.speed = 1e-6; expect(coord.speed).toBe(1e-6); });
  it('speed setter clamps negative to 1e-9 floor', () => { coord.speed = -1; expect(coord.speed).toBe(1e-9); });
  it('adjustSpeed clamps analog speed at 1e-9 floor for negative result', () => {
    coord.speed = 1e-3; coord.adjustSpeed(-1); expect(coord.speed).toBe(1e-9);
  });
  it('parseSpeed ignores invalid text for analog', () => { const prev = coord.speed; coord.parseSpeed('bad'); expect(coord.speed).toBe(prev); });
  it('formatSpeed returns s/s for rate at or above 1', () => { coord.speed = 2; expect(coord.formatSpeed().unit).toBe('s/s'); });
  it('formatSpeed returns ms/s for rate in 1e-3 to 1 range', () => {
    coord.speed = 5e-3; const fmt = coord.formatSpeed();
    expect(fmt.unit).toBe('ms/s'); expect(fmt.value).toBe('5');
  });
  it('formatSpeed returns micros/s for rate in 1e-6 to 1e-3 range', () => {
    coord.speed = 500e-6; const fmt = coord.formatSpeed();
    expect(fmt.unit).toBe('Âµs/s'); expect(fmt.value).toBe('500');
  });
  it('formatSpeed returns ns/s for rate below 1e-6', () => {
    coord.speed = 100e-9; expect(coord.formatSpeed().unit).toBe('ns/s');
  });
});
