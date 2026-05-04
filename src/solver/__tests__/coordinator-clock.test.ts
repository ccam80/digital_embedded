/**
 * Tests for advanceClocks() on DefaultSimulationCoordinator (section 1.5).
 *
 * Covers:
 *   1. advanceClocks() is a no-op on analog-only coordinators (no throw)
 *   2. advanceClocks() toggles clock signals on digital coordinators
 *   3. Multiple toggle cycles maintain correct alternating state
 */

import { describe, it, expect } from 'vitest';
import { DefaultSimulationCoordinator } from '../coordinator.js';
import { compileUnified } from '../../compile/compile.js';
import { DefaultSimulatorFacade } from '../../headless/default-facade.js';
import { createDefaultRegistry } from '../../components/register-all.js';
import { Circuit } from '../../core/circuit.js';
import { PinDirection } from '../../core/pin.js';
import { ComponentRegistry } from '../../core/registry.js';
import { ComponentCategory } from '../../core/registry.js';
import type { StandaloneComponentDefinition } from '../../core/registry.js';
import { TestElement, makePin } from '../../test-fixtures/test-element.js';

function makeAnalogElementObj(
  typeId: string,
  instanceId: string,
  pinDescs: { x: number; y: number; label: string }[],
): TestElement {
  const pins = pinDescs.map(p => makePin(p.label, PinDirection.BIDIRECTIONAL, p.x, p.y));
  return new TestElement(typeId, instanceId, { x: 0, y: 0 }, pins);
}

// ---------------------------------------------------------------------------
// Analog-only fixture (pure resistor network, no digital domain)
// ---------------------------------------------------------------------------

function buildAnalogOnlyCoordinator(): DefaultSimulationCoordinator {
  const registry = new ComponentRegistry();

  const groundDef: StandaloneComponentDefinition = {
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
  } as unknown as StandaloneComponentDefinition;

  const resistorDef: StandaloneComponentDefinition = {
    name: 'Resistor',
    typeId: 'Resistor' as unknown as number,
    factory: () => makeAnalogElementObj('Resistor', crypto.randomUUID(), [
      { x: 0, y: 0, label: 'p1' }, { x: 0, y: 4, label: 'p2' },
    ]),
    pinLayout: [
      { direction: PinDirection.BIDIRECTIONAL, label: 'p1', defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
      { direction: PinDirection.BIDIRECTIONAL, label: 'p2', defaultBitWidth: 1, position: { x: 0, y: 4 }, isNegatable: false, isClockCapable: false },
    ],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.PASSIVES,
    helpText: '',
    pinElectrical: {},
    models: {},
    modelRegistry: {
      behavioral: { kind: 'inline' as const, factory: (pinNodes: ReadonlyMap<string, number>) => {
        const nodeA = pinNodes.get('p1') ?? 0;
        const nodeB = pinNodes.get('p2') ?? 0;
        const g = 1 / 1000;
        return {
          label: "",
          _pinNodes: new Map(pinNodes),
          _stateBase: -1,
          branchIndex: -1 as const,
          ngspiceLoadOrder: 0,
          setup(_ctx: import('../analog/setup-context.js').SetupContext): void {},
          load(ctx: import('../analog/load-context.js').LoadContext): void {
            if (nodeA > 0) ctx.solver.stampElement(ctx.solver.allocElement(nodeA, nodeA), g);
            if (nodeB > 0) ctx.solver.stampElement(ctx.solver.allocElement(nodeB, nodeB), g);
            if (nodeA > 0 && nodeB > 0) { ctx.solver.stampElement(ctx.solver.allocElement(nodeA, nodeB), -g); ctx.solver.stampElement(ctx.solver.allocElement(nodeB, nodeA), -g); }
          },
          getPinCurrents(_v: Float64Array) { return [0, 0]; },
          setParam(_key: string, _value: number) {},
        };
      }, paramDefs: [], params: {} },
    },
  } as unknown as StandaloneComponentDefinition;

  registry.register(groundDef);
  registry.register(resistorDef);

  const circuit = new Circuit();
  const gndEl = makeAnalogElementObj('Ground', 'gnd-1', [{ x: 0, y: 0, label: 'gnd' }]);
  const res1El = makeAnalogElementObj('Resistor', 'res-1', [{ x: 0, y: 0, label: 'p1' }, { x: 0, y: 4, label: 'p2' }]);
  const res2El = makeAnalogElementObj('Resistor', 'res-2', [{ x: 0, y: 4, label: 'p1' }, { x: 0, y: 8, label: 'p2' }]);
  circuit.addElement(gndEl);
  circuit.addElement(res1El);
  circuit.addElement(res2El);

  const unified = compileUnified(circuit, registry);
  return new DefaultSimulationCoordinator(unified);
}

// ---------------------------------------------------------------------------
// Digital coordinator with a Clock component
// ---------------------------------------------------------------------------

function buildDigitalClockCoordinator() {
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({
    components: [
      { id: 'clk', type: 'Clock', props: { label: 'CLK' } },
      { id: 'Q',   type: 'Out',   props: { label: 'Q', bitWidth: 1 } },
    ],
    connections: [
      ['clk:out', 'Q:in'],
    ],
  });
  const coordinator = facade.compile(circuit);
  return { facade, circuit, coordinator };
}

// ---------------------------------------------------------------------------
// Tests: analog-only coordinator
// ---------------------------------------------------------------------------

describe('advanceClocks()  analog-only coordinator', () => {
  it('does not throw on an analog-only coordinator', () => {
    const coordinator = buildAnalogOnlyCoordinator();
    expect(() => coordinator.advanceClocks()).not.toThrow();
    coordinator.dispose();
  });

  it('is a no-op: calling multiple times does not throw', () => {
    const coordinator = buildAnalogOnlyCoordinator();
    expect(() => {
      coordinator.advanceClocks();
      coordinator.advanceClocks();
      coordinator.advanceClocks();
    }).not.toThrow();
    coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Tests: digital coordinator with Clock
// ---------------------------------------------------------------------------

describe('advanceClocks()  digital coordinator with Clock component', () => {
  it('does not throw on a digital coordinator', () => {
    const { coordinator } = buildDigitalClockCoordinator();
    expect(() => coordinator.advanceClocks()).not.toThrow();
    coordinator.dispose();
  });

  it('toggles the Clock output signal to high on the first advanceClocks() + step()', () => {
    const { coordinator } = buildDigitalClockCoordinator();

    const before = coordinator.readByLabel('Q');
    expect(before).toMatchObject({ type: 'digital', value: 0 });

    coordinator.advanceClocks();
    coordinator.step();

    const after = coordinator.readByLabel('Q');
    expect(after).toMatchObject({ type: 'digital', value: 1 });

    coordinator.dispose();
  });

  it('toggles back to low after a second advanceClocks() + step()', () => {
    const { coordinator } = buildDigitalClockCoordinator();

    coordinator.advanceClocks();
    coordinator.step();
    const afterFirst = coordinator.readByLabel('Q');
    expect(afterFirst).toMatchObject({ type: 'digital', value: 1 });

    coordinator.advanceClocks();
    coordinator.step();
    const afterSecond = coordinator.readByLabel('Q');
    expect(afterSecond).toMatchObject({ type: 'digital', value: 0 });

    coordinator.dispose();
  });

  it('maintains correct alternating state over multiple toggle cycles', () => {
    const { coordinator } = buildDigitalClockCoordinator();

    const expectedValues = [1, 0, 1, 0, 1, 0];
    for (const expected of expectedValues) {
      coordinator.advanceClocks();
      coordinator.step();
      const signal = coordinator.readByLabel('Q');
      expect(signal).toMatchObject({ type: 'digital', value: expected });
    }

    coordinator.dispose();
  });
});
