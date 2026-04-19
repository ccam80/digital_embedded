/**
 * Tests for SimulationCoordinator capability queries (section 1.1) and unified
 * execution methods (section 1.2): supportsMicroStep, supportsRunToBreak,
 * supportsAcSweep, supportsDcOp, timingModel, microStep, runToBreak,
 * dcOperatingPoint, acAnalysis, simTime, getState.
 */

import { describe, it, expect } from 'vitest';
import { DefaultSimulationCoordinator } from '../coordinator.js';
import { compileUnified } from '../../compile/compile.js';
import { DefaultSimulatorFacade } from '../../headless/default-facade.js';
import { createDefaultRegistry } from '../../components/register-all.js';
import { Circuit, Wire } from '../../core/circuit.js';
import { PropertyBag } from '../../core/properties.js';
import { PinDirection } from '../../core/pin.js';
import { ComponentRegistry } from '../../core/registry.js';
import { ComponentCategory } from '../../core/registry.js';
import { EngineState } from '../../core/engine-interface.js';
import { ResistorDefinition } from '../../components/passives/resistor.js';
import { CapacitorDefinition } from '../../components/passives/capacitor.js';
import { DcVoltageSourceDefinition } from '../../components/sources/dc-voltage-source.js';
import { GroundDefinition } from '../../components/io/ground.js';
import type { Pin } from '../../core/pin.js';
import type { ComponentDefinition } from '../../core/registry.js';
import type { AnalogElement } from '../analog/element.js';
import type { SparseSolver } from '../analog/sparse-solver.js';
import type { CircuitElement } from '../../core/element.js';
import type { SerializedElement } from '../../core/element.js';
import type { PropertyValue } from '../../core/properties.js';
import type { Rect, RenderContext } from '../../core/renderer-interface.js';
import { TestElement, makePin } from '../../test-fixtures/test-element.js';

function makeAnalogElementObj(typeId: string, instanceId: string, pinDescs: { x: number; y: number; label: string }[]): TestElement {
  const pins = pinDescs.map(p => makePin(p.label, PinDirection.BIDIRECTIONAL, p.x, p.y));
  return new TestElement(typeId, instanceId, { x: 0, y: 0 }, pins);
}

function makeResistorAnalogEl(nodeA: number, nodeB: number, r: number): AnalogElement {
  const g = 1 / r;
  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    stampAc(s: SparseSolver) {
      if (nodeA > 0) s.stampElement(s.allocElement(nodeA - 1, nodeA - 1), g);
      if (nodeB > 0) s.stampElement(s.allocElement(nodeB - 1, nodeB - 1), g);
      if (nodeA > 0 && nodeB > 0) { s.stampElement(s.allocElement(nodeA - 1, nodeB - 1), -g); s.stampElement(s.allocElement(nodeB - 1, nodeA - 1), -g); }
    },
    getPinCurrents(_v: Float64Array) { return [0, 0]; },
    setParam(_key: string, _value: number) {},
  };
}

function makeAnalogDef(
  name: string,
  pinDescs: { x: number; y: number; label: string }[],
  mnaFactory: (pinNodes: ReadonlyMap<string, number>) => AnalogElement,
): ComponentDefinition {
  return {
    name,
    typeId: name as unknown as number,
    factory: () => makeAnalogElementObj(name, crypto.randomUUID(), pinDescs),
    pinLayout: pinDescs.map(p => ({
      direction: PinDirection.BIDIRECTIONAL, label: p.label, defaultBitWidth: 1,
      position: { x: p.x, y: p.y }, isNegatable: false, isClockCapable: false,
    })),
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.PASSIVES,
    helpText: '',
    pinElectrical: {},
    defaultModel: 'behavioral',
    models: {},
    modelRegistry: { behavioral: { kind: 'inline' as const, factory: (pinNodes: ReadonlyMap<string, number>) => mnaFactory(pinNodes), paramDefs: [], params: {} } },
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
    category: ComponentCategory.PASSIVES,
    helpText: '',
    pinElectrical: {},
    defaultModel: 'behavioral',
    models: {},
    modelRegistry: {
      behavioral: { kind: 'inline' as const, factory: (_pinNodes: ReadonlyMap<string, number>) => ({
        branchIndex: -1 as const,
        isNonlinear: false, isReactive: false,
        stamp(_s: SparseSolver) {},
        getPinCurrents(_v: Float64Array) { return [0]; },
        setParam(_key: string, _value: number) {},
      }), paramDefs: [], params: {} },
    },
  } as unknown as ComponentDefinition;
}

function buildAnalogRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  registry.register(makeGroundDef());
  registry.register(makeAnalogDef(
    'Resistor',
    [{ x: 0, y: 0, label: 'p1' }, { x: 0, y: 4, label: 'p2' }],
    (pinNodes) => makeResistorAnalogEl(pinNodes.get('p1') ?? 0, pinNodes.get('p2') ?? 0, 1000),
  ));
  return registry;
}

function buildAnalogCircuit(_registry: ComponentRegistry): Circuit {
  const circuit = new Circuit();
  circuit.metadata = { ...circuit.metadata };
  const gndEl = makeAnalogElementObj('Ground', 'gnd-1', [{ x: 0, y: 0, label: 'gnd' }]);
  const res1El = makeAnalogElementObj('Resistor', 'res-1', [{ x: 0, y: 0, label: 'p1' }, { x: 0, y: 4, label: 'p2' }]);
  const res2El = makeAnalogElementObj('Resistor', 'res-2', [{ x: 0, y: 4, label: 'p1' }, { x: 0, y: 8, label: 'p2' }]);
  circuit.addElement(gndEl);
  circuit.addElement(res1El);
  circuit.addElement(res2El);
  return circuit;
}

/**
 * Build a low-level CircuitElement for analog tests using BIDIRECTIONAL pins
 * placed at specific grid coordinates (used for wire-based connectivity).
 */
function makeAnalogEl(
  typeId: string,
  instanceId: string,
  pins: Array<{ x: number; y: number; label?: string }>,
  propsMap: Map<string, PropertyValue> = new Map(),
  registry?: ComponentRegistry,
): CircuitElement {
  const def = registry?.get(typeId);
  const resolvedPins: Pin[] = pins.map((p, i) => ({
    position: { x: p.x, y: p.y },
    label: p.label || def?.pinLayout[i]?.label || '',
    direction: PinDirection.BIDIRECTIONAL,
    isNegated: false,
    isClock: false,
    kind: "signal" as const,
    bitWidth: 1,
  }));
  const propertyBag = new PropertyBag(propsMap.entries());
  const _mp: Record<string, number> = {};
  for (const [k, v] of propsMap) if (typeof v === 'number') _mp[k] = v;
  propertyBag.replaceModelParams(_mp);
  const serialized: SerializedElement = {
    typeId, instanceId, position: { x: 0, y: 0 },
    rotation: 0 as SerializedElement['rotation'], mirror: false, properties: {},
  };
  return {
    typeId, instanceId, position: { x: 0, y: 0 },
    rotation: 0 as CircuitElement['rotation'], mirror: false,
    getPins() { return resolvedPins; },
    getProperties() { return propertyBag; },
    getBoundingBox(): Rect { return { x: 0, y: 0, width: 10, height: 10 }; },
    draw(_ctx: RenderContext) {},
    serialize() { return serialized; },
    getAttribute(k: string) { return propsMap.get(k); },
    setAttribute(_name: string, _value: PropertyValue) {},
  };
}

/**
 * Build an RC circuit (DC source + resistor + capacitor + ground) directly
 * from element+wire topology so that transient simulation (time-advancing
 * MNA steps) can be verified.
 *
 * Topology: Vcc(5V) → R(1kΩ) → C(1µF) → GND, Vcc− → GND
 * Node 1: Vcc+ / R.A   Node 2: R.B / C.pos   Node 0: GND
 */
function buildRcCoordinator() {
  const registry = new ComponentRegistry();
  registry.register(GroundDefinition);
  registry.register(ResistorDefinition);
  registry.register(CapacitorDefinition);
  registry.register(DcVoltageSourceDefinition);

  const circuit = new Circuit();

  const vcc = makeAnalogEl('DcVoltageSource', 'vcc1',
    [{ x: 10, y: 0 }, { x: 0, y: 0 }],
    new Map<string, PropertyValue>([['voltage', 5]]), registry,
  );
  const res = makeAnalogEl('Resistor', 'res1',
    [{ x: 10, y: 0 }, { x: 20, y: 0 }],
    new Map<string, PropertyValue>([['resistance', 1000]]), registry,
  );
  const cap = makeAnalogEl('Capacitor', 'cap1',
    [{ x: 20, y: 0 }, { x: 30, y: 0 }],
    new Map<string, PropertyValue>([['capacitance', 1e-6]]), registry,
  );
  const gnd = makeAnalogEl('Ground', 'gnd1', [{ x: 0, y: 0 }], new Map(), registry);
  const gnd2 = makeAnalogEl('Ground', 'gnd2', [{ x: 30, y: 0 }], new Map(), registry);

  circuit.addElement(vcc);
  circuit.addElement(res);
  circuit.addElement(cap);
  circuit.addElement(gnd);
  circuit.addElement(gnd2);

  circuit.addWire(new Wire({ x: 10, y: 0 }, { x: 10, y: 0 }));
  circuit.addWire(new Wire({ x: 20, y: 0 }, { x: 20, y: 0 }));
  circuit.addWire(new Wire({ x: 0, y: 0 }, { x: 0, y: 0 }));
  circuit.addWire(new Wire({ x: 30, y: 0 }, { x: 30, y: 0 }));

  const unified = compileUnified(circuit, registry);
  const coordinator = new DefaultSimulationCoordinator(unified);
  coordinator.initialize();
  return { coordinator };
}

// ---------------------------------------------------------------------------
// Digital fixture via DefaultSimulatorFacade
// ---------------------------------------------------------------------------

function buildDigitalCoordinator() {
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({
    components: [
      { id: 'A',    type: 'In',  props: { label: 'A', bitWidth: 1 } },
      { id: 'B',    type: 'In',  props: { label: 'B', bitWidth: 1 } },
      { id: 'gate', type: 'And' },
      { id: 'Y',    type: 'Out', props: { label: 'Y', bitWidth: 1 } },
    ],
    connections: [
      ['A:out', 'gate:In_1'],
      ['B:out', 'gate:In_2'],
      ['gate:out', 'Y:in'],
    ],
  });
  const coordinator = facade.compile(circuit);
  return { facade, circuit, coordinator };
}

// ---------------------------------------------------------------------------
// Section 1.3 snapshotSignals and signalCount — digital-only
// ---------------------------------------------------------------------------

describe('snapshotSignals and signalCount — digital-only coordinator', () => {
  it('signalCount equals digital netCount', () => {
    const { coordinator } = buildDigitalCoordinator();
    expect(coordinator.signalCount).toBe(3);
    coordinator.dispose();
  });

  it('snapshotSignals returns Float64Array of length signalCount', () => {
    const { coordinator } = buildDigitalCoordinator();
    const snap = coordinator.snapshotSignals();
    expect(snap).toBeInstanceOf(Float64Array);
    expect(snap.length).toBe(coordinator.signalCount);
    coordinator.dispose();
  });

  it('snapshotSignals changes after writing a signal and stepping', () => {
    const { coordinator } = buildDigitalCoordinator();
    const before = coordinator.snapshotSignals().slice();
    coordinator.writeByLabel('A', { type: 'digital', value: 1 });
    coordinator.writeByLabel('B', { type: 'digital', value: 1 });
    coordinator.step();
    const after = coordinator.snapshotSignals();
    let changed = false;
    for (let i = 0; i < before.length; i++) {
      if (before[i] !== after[i]) { changed = true; break; }
    }
    expect(changed).toBe(true);
    coordinator.dispose();
  });
});

describe('snapshotSignals and signalCount — analog-only coordinator', () => {
  it('signalCount equals analog nodeCount', () => {
    const registry = buildAnalogRegistry();
    const circuit = buildAnalogCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    expect(coord.signalCount).toBeGreaterThan(0);
    coord.dispose();
  });

  it('snapshotSignals returns Float64Array of length signalCount', () => {
    const registry = buildAnalogRegistry();
    const circuit = buildAnalogCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    const snap = coord.snapshotSignals();
    expect(snap).toBeInstanceOf(Float64Array);
    expect(snap.length).toBe(coord.signalCount);
    coord.dispose();
  });

  it('snapshotSignals contains non-zero voltages after DC op', () => {
    const { coordinator } = buildRcCoordinator();
    const snap = coordinator.snapshotSignals();
    const hasNonZero = Array.from(snap).some(v => v !== 0);
    expect(hasNonZero).toBe(true);
    coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Section 1.1 Capability queries — digital-only
// ---------------------------------------------------------------------------

describe('capability queries — digital-only coordinator', () => {
  it('supportsMicroStep returns true', () => {
    const { coordinator } = buildDigitalCoordinator();
    expect(coordinator.supportsMicroStep()).toBe(true);
    coordinator.dispose();
  });

  it('supportsRunToBreak returns true', () => {
    const { coordinator } = buildDigitalCoordinator();
    expect(coordinator.supportsRunToBreak()).toBe(true);
    coordinator.dispose();
  });

  it('supportsAcSweep returns false', () => {
    const { coordinator } = buildDigitalCoordinator();
    expect(coordinator.supportsAcSweep()).toBe(false);
    coordinator.dispose();
  });

  it('supportsDcOp returns false', () => {
    const { coordinator } = buildDigitalCoordinator();
    expect(coordinator.supportsDcOp()).toBe(false);
    coordinator.dispose();
  });

  it('timingModel is discrete', () => {
    const { coordinator } = buildDigitalCoordinator();
    expect(coordinator.timingModel).toBe('discrete');
    coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Section 1.1 Capability queries — analog-only
// ---------------------------------------------------------------------------

describe('capability queries — analog-only coordinator', () => {
  it('supportsMicroStep returns true (digital engine exists via neutral components)', () => {
    const registry = buildAnalogRegistry();
    const circuit = buildAnalogCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    // Neutral components (Ground) always route to digital, so a digital
    // engine exists and provides microStep capability.
    expect(coord.supportsMicroStep()).toBe(true);
    coord.dispose();
  });

  it('supportsRunToBreak returns true (digital engine exists via neutral components)', () => {
    const registry = buildAnalogRegistry();
    const circuit = buildAnalogCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    expect(coord.supportsRunToBreak()).toBe(true);
    coord.dispose();
  });

  it('supportsAcSweep returns true', () => {
    const registry = buildAnalogRegistry();
    const circuit = buildAnalogCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    expect(coord.supportsAcSweep()).toBe(true);
    coord.dispose();
  });

  it('supportsDcOp returns true', () => {
    const registry = buildAnalogRegistry();
    const circuit = buildAnalogCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    expect(coord.supportsDcOp()).toBe(true);
    coord.dispose();
  });

  it('timingModel is mixed (both engines present via neutral components)', () => {
    const registry = buildAnalogRegistry();
    const circuit = buildAnalogCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    // Neutral components (Ground) route to digital, creating both engines.
    expect(coord.timingModel).toBe('mixed');
    coord.dispose();
  });
});

// ---------------------------------------------------------------------------
// Section 1.2 Unified execution — digital-only
// ---------------------------------------------------------------------------

describe('unified execution methods — digital-only coordinator', () => {
  it('microStep executes without throwing', () => {
    const { coordinator } = buildDigitalCoordinator();
    expect(() => coordinator.microStep()).not.toThrow();
    coordinator.dispose();
  });

  it('runToBreak executes without throwing', () => {
    const { coordinator } = buildDigitalCoordinator();
    expect(() => coordinator.runToBreak()).not.toThrow();
    coordinator.dispose();
  });

  it('dcOperatingPoint returns null for digital-only', () => {
    const { coordinator } = buildDigitalCoordinator();
    expect(coordinator.dcOperatingPoint()).toBeNull();
    coordinator.dispose();
  });

  it('acAnalysis returns null for digital-only', () => {
    const { coordinator } = buildDigitalCoordinator();
    const result = coordinator.acAnalysis({
      type: 'dec',
      fStart: 1,
      fStop: 1e6,
      numPoints: 10,
      sourceLabel: '',
      outputNodes: [],
    });
    expect(result).toBeNull();
    coordinator.dispose();
  });

  it('simTime is null for digital-only', () => {
    const { coordinator } = buildDigitalCoordinator();
    expect(coordinator.simTime).toBeNull();
    coordinator.dispose();
  });

  it('getState returns STOPPED initially', () => {
    const { coordinator } = buildDigitalCoordinator();
    expect(coordinator.getState()).toBe(EngineState.STOPPED);
    coordinator.dispose();
  });

  it('getState returns RUNNING after start', () => {
    const { coordinator } = buildDigitalCoordinator();
    coordinator.start();
    expect(coordinator.getState()).toBe(EngineState.RUNNING);
    coordinator.stop();
    coordinator.dispose();
  });

  it('getState returns PAUSED after stop', () => {
    const { coordinator } = buildDigitalCoordinator();
    coordinator.start();
    coordinator.stop();
    expect(coordinator.getState()).toBe(EngineState.PAUSED);
    coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Section 1.2 Unified execution — analog-only
// ---------------------------------------------------------------------------

describe('unified execution methods — analog-only coordinator', () => {
  it('microStep is a no-op (does not throw)', () => {
    const registry = buildAnalogRegistry();
    const circuit = buildAnalogCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    expect(() => coord.microStep()).not.toThrow();
    coord.dispose();
  });

  it('runToBreak is a no-op (does not throw)', () => {
    const registry = buildAnalogRegistry();
    const circuit = buildAnalogCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    expect(() => coord.runToBreak()).not.toThrow();
    coord.dispose();
  });

  it('dcOperatingPoint returns a DcOpResult', () => {
    const registry = buildAnalogRegistry();
    const circuit = buildAnalogCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    coord.initialize();
    const result = coord.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(typeof result!.converged).toBe('boolean');
    expect(result!.nodeVoltages).toBeInstanceOf(Float64Array);
    coord.dispose();
  });

  it('simTime is a number (not null) for analog-only', () => {
    const registry = buildAnalogRegistry();
    const circuit = buildAnalogCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    expect(coord.simTime).not.toBeNull();
    expect(typeof coord.simTime).toBe('number');
    coord.dispose();
  });

  it('simTime advances after step', () => {
    const { coordinator } = buildRcCoordinator();
    const t0 = coordinator.simTime!;
    coordinator.step();
    const t1 = coordinator.simTime!;
    expect(t1).toBeGreaterThan(t0);
    coordinator.dispose();
  });

  it('getState returns STOPPED initially', () => {
    const registry = buildAnalogRegistry();
    const circuit = buildAnalogCircuit(registry);
    const unified = compileUnified(circuit, registry);
    const coord = new DefaultSimulationCoordinator(unified);
    expect(coord.getState()).toBe(EngineState.STOPPED);
    coord.dispose();
  });
});

// ---------------------------------------------------------------------------
// Section 1.11 Narrowed compiled accessor
// ---------------------------------------------------------------------------

describe('narrowed compiled accessor — digital-only coordinator', () => {
  it('compiled.wireSignalMap is a Map', () => {
    const { coordinator } = buildDigitalCoordinator();
    expect(coordinator.compiled.wireSignalMap).toBeInstanceOf(Map);
    coordinator.dispose();
  });

  it('compiled.labelSignalMap is a Map with entries for labeled pins', () => {
    const { coordinator } = buildDigitalCoordinator();
    const lsm = coordinator.compiled.labelSignalMap;
    expect(lsm).toBeInstanceOf(Map);
    expect(lsm.has('A')).toBe(true);
    expect(lsm.has('B')).toBe(true);
    expect(lsm.has('Y')).toBe(true);
    coordinator.dispose();
  });

  it('compiled.diagnostics is an array', () => {
    const { coordinator } = buildDigitalCoordinator();
    expect(Array.isArray(coordinator.compiled.diagnostics)).toBe(true);
    coordinator.dispose();
  });

  it('compiled accessor via SimulationCoordinator interface exposes wireSignalMap', () => {
    const { coordinator } = buildDigitalCoordinator();
    // Type-check via interface reference — only the narrowed fields are visible
    const iface: import('../../solver/coordinator-types.js').SimulationCoordinator = coordinator;
    expect(iface.compiled.wireSignalMap).toBeInstanceOf(Map);
    coordinator.dispose();
  });

  it('compiled accessor via SimulationCoordinator interface exposes labelSignalMap', () => {
    const { coordinator } = buildDigitalCoordinator();
    const iface: import('../../solver/coordinator-types.js').SimulationCoordinator = coordinator;
    expect(iface.compiled.labelSignalMap).toBeInstanceOf(Map);
    coordinator.dispose();
  });

  it('compiled accessor via SimulationCoordinator interface exposes diagnostics', () => {
    const { coordinator } = buildDigitalCoordinator();
    const iface: import('../../solver/coordinator-types.js').SimulationCoordinator = coordinator;
    expect(Array.isArray(iface.compiled.diagnostics)).toBe(true);
    coordinator.dispose();
  });
});
