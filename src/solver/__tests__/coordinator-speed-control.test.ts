/**
 * Tests for speed control methods on DefaultSimulationCoordinator (P5b-4).
 * Covers: timingModel, computeFrameSteps, speed, adjustSpeed, parseSpeed, formatSpeed
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DefaultSimulationCoordinator } from '../coordinator.js';
import { compileUnified } from '../../compile/compile.js';
import { Circuit } from '../../core/circuit.js';
import { AbstractCircuitElement } from '../../core/element.js';
import { PropertyBag, PropertyType } from '../../core/properties.js';
import { PinDirection } from '../../core/pin.js';
import { ComponentRegistry } from '../../core/registry.js';
import { ComponentCategory } from '../../core/registry.js';
import type { Pin, Rotation } from '../../core/pin.js';
import type { RenderContext, Rect } from '../../core/renderer-interface.js';
import type { ComponentDefinition, ComponentLayout, AnalogFactory } from '../../core/registry.js';
import type { SerializedElement } from '../../core/element.js';
import type { AnalogElement } from '../analog/element.js';
import type { SparseSolver } from '../analog/sparse-solver.js';

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

function makeAnalogElementObj(typeId: string, instanceId: string, pins: Array<{ x: number; y: number; label?: string }>) {
  const resolvedPins: Pin[] = pins.map((p) => ({
    position: { x: p.x, y: p.y }, label: p.label ?? '',
    direction: PinDirection.BIDIRECTIONAL, isInverted: false, isClock: false, bitWidth: 1,
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
    getHelpText() { return ''; },
    getAttribute(_k: string) { return undefined; },
  };
}

function makeResistorAnalogEl(n1: number, n2: number, resistance: number): AnalogElement {
  return {
    pinNodeIds: [n1, n2], allNodeIds: [n1, n2], branchIndex: -1,
    isNonlinear: false, isReactive: false,
    stamp(solver: SparseSolver): void {
      const g = 1 / resistance;
      if (n1 !== 0) { solver.stamp(n1 - 1, n1 - 1, g); }
      if (n2 !== 0) { solver.stamp(n2 - 1, n2 - 1, g); }
      if (n1 !== 0 && n2 !== 0) { solver.stamp(n1 - 1, n2 - 1, -g); solver.stamp(n2 - 1, n1 - 1, -g); }
    },
    getPinCurrents(_v: Float64Array): number[] { return [0, 0]; },
  };
}

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
  return registry;
}

function buildDigitalCircuit(registry: ComponentRegistry): Circuit {
  const circuit = new Circuit();
  const inA = new MockElement('In', 'inA', { x: 0, y: 0 }, [makePin('out', PinDirection.OUTPUT, 2, 0)], makePropBag({ label: 'A' }));
  const outY = new MockElement('Out', 'outY', { x: 4, y: 0 }, [makePin('in', PinDirection.INPUT, 0, 0)], makePropBag({ label: 'Y' }));
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
    propertyDefs: [], attributeMap: [], category: ComponentCategory.ANALOG, helpText: '',
    models: { analog: {
      analogFactory: (_el: unknown, _pins: number[]) => ({
        pinNodeIds: _pins, allNodeIds: _pins, branchIndex: -1,
        isNonlinear: false, isReactive: false,
        stamp(_s: SparseSolver) {},
        getPinCurrents(_v: Float64Array) { return [0]; },
      }),
      pinElectrical: {},
    } },
  } as unknown as ComponentDefinition;
}

function makeResistorDef(): ComponentDefinition {
  const analogFactory: AnalogFactory = (_el: unknown, pinNodes: number[], _props: unknown) =>
    makeResistorAnalogEl(pinNodes[0] ?? 0, pinNodes[1] ?? 0, 1000);
  return {
    name: 'Resistor', typeId: -1 as unknown as number,
    factory: () => makeAnalogElementObj('Resistor', crypto.randomUUID(), [{ x: 0, y: 0, label: 'p1' }, { x: 0, y: 4, label: 'p2' }]),
    pinLayout: [
      { direction: PinDirection.BIDIRECTIONAL, label: 'p1', defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
      { direction: PinDirection.BIDIRECTIONAL, label: 'p2', defaultBitWidth: 1, position: { x: 0, y: 4 }, isNegatable: false, isClockCapable: false },
    ],
    propertyDefs: [], attributeMap: [], category: ComponentCategory.ANALOG, helpText: '',
    models: { analog: { analogFactory, pinElectrical: {} } },
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
  it('analog-only circuit has timingModel continuous', () => {
    const { circuit, registry } = buildAnalogCircuit();
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    expect(coord.timingModel).toBe('continuous');
    coord.dispose();
  });
});

describe('DefaultSimulationCoordinator -- computeFrameSteps (discrete)', () => {
  let coord: DefaultSimulationCoordinator;
  beforeEach(() => {
    const registry = buildDigitalRegistry();
    const circuit = buildDigitalCircuit(registry);
    const unified = compileUnified(circuit, registry);
    coord = new DefaultSimulationCoordinator(unified);
  });
  it('returns steps = round(speed * wallDt) for default speed', () => {
    const result = coord.computeFrameSteps(0.016);
    expect(result.steps).toBe(Math.round(1000 * 0.016));
    expect(result.simTimeGoal).toBeNull();
    expect(result.budgetMs).toBe(Infinity);
    expect(result.missed).toBe(false);
  });
  it('clamps wallDt to 0.1s to prevent huge jumps', () => {
    const resultClamped = coord.computeFrameSteps(1.0);
    const resultRef = coord.computeFrameSteps(0.1);
    expect(resultClamped.steps).toBe(resultRef.steps);
  });
  it('rounds step count correctly for fractional result', () => {
    coord.speed = 100;
    const result = coord.computeFrameSteps(0.016);
    expect(result.steps).toBe(2);
  });
  it('simTimeGoal is null for discrete', () => {
    expect(coord.computeFrameSteps(0.05).simTimeGoal).toBeNull();
  });
  it('budgetMs is Infinity for discrete', () => {
    expect(coord.computeFrameSteps(0.05).budgetMs).toBe(Infinity);
  });
  it('missed is false for discrete', () => {
    expect(coord.computeFrameSteps(0.05).missed).toBe(false);
  });
  it('speed change is reflected in computeFrameSteps', () => {
    coord.speed = 10000;
    expect(coord.computeFrameSteps(0.01).steps).toBe(100);
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
    const simTimeBefore = coord.simTime as number;
    const result = coord.computeFrameSteps(0.016);
    expect(result.simTimeGoal).toBeCloseTo(simTimeBefore + 1e-3 * 0.016, 15);
  });
  it('budgetMs is 12 for continuous', () => {
    expect(coord.computeFrameSteps(0.016).budgetMs).toBe(12);
  });
  it('missed is false for continuous', () => {
    expect(coord.computeFrameSteps(0.016).missed).toBe(false);
  });
  it('clamps wallDt to 0.1s for continuous', () => {
    coord.speed = 1e-3;
    const simTimeBefore = coord.simTime as number;
    expect(coord.computeFrameSteps(10.0).simTimeGoal).toBeCloseTo(simTimeBefore + 1e-3 * 0.1, 15);
  });
});

describe('DefaultSimulationCoordinator -- speed control (discrete)', () => {
  let coord: DefaultSimulationCoordinator;
  beforeEach(() => {
    const registry = buildDigitalRegistry();
    const circuit = buildDigitalCircuit(registry);
    const unified = compileUnified(circuit, registry);
    coord = new DefaultSimulationCoordinator(unified);
  });
  it('default speed is 1000', () => { expect(coord.speed).toBe(1000); });
  it('speed setter updates speed', () => { coord.speed = 5000; expect(coord.speed).toBe(5000); });
  it('speed setter clamps to MIN_SPEED of 1', () => { coord.speed = 0; expect(coord.speed).toBe(1); });
  it('speed setter clamps to MAX_SPEED of 10_000_000', () => { coord.speed = 100_000_000; expect(coord.speed).toBe(10_000_000); });
  it('adjustSpeed multiplies by factor', () => { coord.speed = 1000; coord.adjustSpeed(10); expect(coord.speed).toBe(10_000); });
  it('adjustSpeed clamps to MAX_SPEED', () => { coord.speed = 10_000_000; coord.adjustSpeed(2); expect(coord.speed).toBe(10_000_000); });
  it('adjustSpeed with factor less than 1 reduces speed', () => { coord.speed = 1000; coord.adjustSpeed(0.5); expect(coord.speed).toBe(500); });
  it('parseSpeed parses integer text', () => { coord.parseSpeed('5000'); expect(coord.speed).toBe(5000); });
  it('parseSpeed parses scientific notation', () => { coord.parseSpeed('1e6'); expect(coord.speed).toBe(1_000_000); });
  it('parseSpeed ignores invalid text', () => { const prev = coord.speed; coord.parseSpeed('abc'); expect(coord.speed).toBe(prev); });
  it('formatSpeed returns Hz for speed below 1000', () => {
    coord.speed = 500; const fmt = coord.formatSpeed();
    expect(fmt.unit).toBe('Hz'); expect(fmt.value).toBe('500');
  });
  it('formatSpeed returns kHz for speed in 1000 to 999999 range', () => {
    coord.speed = 5000; const fmt = coord.formatSpeed();
    expect(fmt.unit).toBe('kHz'); expect(fmt.value).toBe('5');
  });
  it('formatSpeed returns MHz for speed at or above 1_000_000', () => {
    coord.speed = 2_000_000; const fmt = coord.formatSpeed();
    expect(fmt.unit).toBe('MHz'); expect(fmt.value).toBe('2');
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
  it('adjustSpeed multiplies analog speed by factor', () => {
    coord.speed = 1e-3; coord.adjustSpeed(10); expect(coord.speed).toBeCloseTo(1e-2, 15);
  });
  it('adjustSpeed clamps analog speed at 1e-9 floor for negative result', () => {
    coord.speed = 1e-3; coord.adjustSpeed(-1); expect(coord.speed).toBe(1e-9);
  });
  it('parseSpeed parses float for analog', () => { coord.parseSpeed('0.005'); expect(coord.speed).toBeCloseTo(0.005, 10); });
  it('parseSpeed parses scientific notation for analog', () => { coord.parseSpeed('1e-6'); expect(coord.speed).toBeCloseTo(1e-6, 20); });
  it('parseSpeed ignores invalid text for analog', () => { const prev = coord.speed; coord.parseSpeed('bad'); expect(coord.speed).toBe(prev); });
  it('formatSpeed returns s/s for rate at or above 1', () => { coord.speed = 2; expect(coord.formatSpeed().unit).toBe('s/s'); });
  it('formatSpeed returns ms/s for rate in 1e-3 to 1 range', () => {
    coord.speed = 5e-3; const fmt = coord.formatSpeed();
    expect(fmt.unit).toBe('ms/s'); expect(fmt.value).toBe('5');
  });
  it('formatSpeed returns micros/s for rate in 1e-6 to 1e-3 range', () => {
    coord.speed = 500e-6; const fmt = coord.formatSpeed();
    expect(fmt.unit).toBe('µs/s'); expect(fmt.value).toBe('500');
  });
  it('formatSpeed returns ns/s for rate below 1e-6', () => {
    coord.speed = 100e-9; expect(coord.formatSpeed().unit).toBe('ns/s');
  });
});
