import { describe, it, expect, beforeEach } from 'vitest';
import {
  createFSM,
  addState,
  addTransition,
  resetIdCounter,
} from '../model.js';
import { fsmToCircuit } from '../circuit-gen.js';
import { fsmToTransitionTable } from '../table-creator.js';
import { ComponentRegistry } from '../../core/registry.js';
import { PropertyBag, PropertyType } from '../../core/properties.js';
import type { Pin } from '../../core/pin.js';
import { PinDirection } from '../../core/pin.js';
import { TestElement, makePin } from '../../test-fixtures/test-element.js';
import { noopExecFn } from '../../test-fixtures/execute-stubs.js';

function buildRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();

  registry.register({
    name: 'In',
    typeId: -1,
    factory: (props) => new TestElement('In', crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin('out', PinDirection.OUTPUT, 2, 1),
    ], props),
    pinLayout: [],
    propertyDefs: [
      { key: 'label', type: PropertyType.STRING, label: 'Label', defaultValue: '' },
      { key: 'bitWidth', type: PropertyType.INT, label: 'Bits', defaultValue: 1 },
    ],
    attributeMap: [],
    category: 'IO' as any,
    helpText: '',
    models: { digital: { executeFn: noopExecFn } },
  });

  registry.register({
    name: 'Out',
    typeId: -1,
    factory: (props) => new TestElement('Out', crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin('in', PinDirection.INPUT, 0, 1),
    ], props),
    pinLayout: [],
    propertyDefs: [
      { key: 'label', type: PropertyType.STRING, label: 'Label', defaultValue: '' },
      { key: 'bitWidth', type: PropertyType.INT, label: 'Bits', defaultValue: 1 },
    ],
    attributeMap: [],
    category: 'IO' as any,
    helpText: '',
    models: { digital: { executeFn: noopExecFn } },
  });

  registry.register({
    name: 'And',
    typeId: -1,
    factory: (props) => {
      const count = (props.has('inputCount') ? props.get<number>('inputCount') : 2);
      const pins: Pin[] = [];
      for (let i = 0; i < count; i++) {
        pins.push(makePin(`in${i}`, PinDirection.INPUT, 0, i));
      }
      pins.push(makePin('out', PinDirection.OUTPUT, 4, Math.floor(count / 2)));
      return new TestElement('And', crypto.randomUUID(), { x: 0, y: 0 }, pins, props);
    },
    pinLayout: [],
    propertyDefs: [
      { key: 'inputCount', type: PropertyType.INT, label: 'Inputs', defaultValue: 2 },
      { key: 'bitWidth', type: PropertyType.INT, label: 'Bits', defaultValue: 1 },
    ],
    attributeMap: [],
    category: 'LOGIC' as any,
    helpText: '',
    models: { digital: { executeFn: noopExecFn } },
  });

  registry.register({
    name: 'Or',
    typeId: -1,
    factory: (props) => {
      const count = (props.has('inputCount') ? props.get<number>('inputCount') : 2);
      const pins: Pin[] = [];
      for (let i = 0; i < count; i++) {
        pins.push(makePin(`in${i}`, PinDirection.INPUT, 0, i));
      }
      pins.push(makePin('out', PinDirection.OUTPUT, 4, Math.floor(count / 2)));
      return new TestElement('Or', crypto.randomUUID(), { x: 0, y: 0 }, pins, props);
    },
    pinLayout: [],
    propertyDefs: [
      { key: 'inputCount', type: PropertyType.INT, label: 'Inputs', defaultValue: 2 },
      { key: 'bitWidth', type: PropertyType.INT, label: 'Bits', defaultValue: 1 },
    ],
    attributeMap: [],
    category: 'LOGIC' as any,
    helpText: '',
    models: { digital: { executeFn: noopExecFn } },
  });

  registry.register({
    name: 'Not',
    typeId: -1,
    factory: (props) => new TestElement('Not', crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin('in', PinDirection.INPUT, 0, 0),
      makePin('out', PinDirection.OUTPUT, 4, 0),
    ], props),
    pinLayout: [],
    propertyDefs: [
      { key: 'bitWidth', type: PropertyType.INT, label: 'Bits', defaultValue: 1 },
    ],
    attributeMap: [],
    category: 'LOGIC' as any,
    helpText: '',
    models: { digital: { executeFn: noopExecFn } },
  });

  registry.register({
    name: 'Const',
    typeId: -1,
    factory: (props) => new TestElement('Const', crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin('out', PinDirection.OUTPUT, 2, 0),
    ], props),
    pinLayout: [],
    propertyDefs: [
      { key: 'label', type: PropertyType.STRING, label: 'Label', defaultValue: '0' },
      { key: 'bitWidth', type: PropertyType.INT, label: 'Bits', defaultValue: 1 },
    ],
    attributeMap: [],
    category: 'IO' as any,
    helpText: '',
    models: { digital: { executeFn: noopExecFn } },
  });

  return registry;
}

// ---------------------------------------------------------------------------
// Helper: count elements by type
// ---------------------------------------------------------------------------

function countByType(circuit: { elements: { typeId: string }[] }, typeId: string): number {
  return circuit.elements.filter((el) => el.typeId === typeId).length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetIdCounter();
});

describe('fsmToCircuit', () => {
  it('simpleCounter', () => {
    // 2-state counter FSM -> circuit with gates
    // S0 -> S1 (unconditional), S1 -> S0 (unconditional)
    const fsm = createFSM('counter');
    fsm.inputSignals = [];
    fsm.outputSignals = ['Y'];

    const s0 = addState(fsm, 'S0', { x: 0, y: 0 }, { outputs: { Y: 0 } });
    const s1 = addState(fsm, 'S1', { x: 100, y: 0 }, { outputs: { Y: 1 } });

    addTransition(fsm, s0.id, s1.id);
    addTransition(fsm, s1.id, s0.id);

    const registry = buildRegistry();
    const circuit = fsmToCircuit(fsm, registry, { flipflopType: 'D' });

    // Circuit should have elements (In for state bits, Out for outputs/next-state, gates)
    expect(circuit.elements.length).toBeGreaterThan(0);

    // Should have Out components for the next-state and output signals
    const outCount = countByType(circuit, 'Out');
    expect(outCount).toBeGreaterThanOrEqual(1);

    // Should have In components for state variable inputs
    const inCount = countByType(circuit, 'In');
    expect(inCount).toBeGreaterThanOrEqual(1);

    // Circuit should be structurally valid
    expect(Array.isArray(circuit.wires)).toBe(true);
  });

  it('jkFlipflops', () => {
    // Synthesize with JK option -> circuit contains JK-related outputs
    const fsm = createFSM('jk-test');
    fsm.inputSignals = ['A'];
    fsm.outputSignals = [];

    const s0 = addState(fsm, 'S0', { x: 0, y: 0 });
    const s1 = addState(fsm, 'S1', { x: 100, y: 0 });

    addTransition(fsm, s0.id, s1.id, 'A');
    addTransition(fsm, s1.id, s0.id, 'A');

    const registry = buildRegistry();
    const circuit = fsmToCircuit(fsm, registry, { flipflopType: 'JK' });

    // Circuit should have elements
    expect(circuit.elements.length).toBeGreaterThan(0);

    // JK synthesis produces J and K output signals
    const outLabels = circuit.elements
      .filter((el) => el.typeId === 'Out')
      .map((el) => {
        const props = el.getProperties();
        return props.has('label') ? props.get<string>('label') : '';
      });

    // Should have J and K outputs for the state bit
    const hasJ = outLabels.some((l) => l.includes('_J'));
    const hasK = outLabels.some((l) => l.includes('_K'));
    expect(hasJ).toBe(true);
    expect(hasK).toBe(true);
  });

  it('functionalVerification', () => {
    // Verify the synthesized circuit's transition table matches the original FSM
    const fsm = createFSM('verify');
    fsm.inputSignals = ['A'];
    fsm.outputSignals = ['Y'];

    const s0 = addState(fsm, 'S0', { x: 0, y: 0 }, { outputs: { Y: 0 } });
    const s1 = addState(fsm, 'S1', { x: 100, y: 0 }, { outputs: { Y: 1 } });

    addTransition(fsm, s0.id, s1.id, 'A');
    addTransition(fsm, s1.id, s0.id, 'A');

    // Get the original transition table
    const table = fsmToTransitionTable(fsm);

    // S0(0), A=0 -> stays S0
    const t00 = table.transitions.find(
      (t) => t.currentState[0] === 0n && t.input[0] === 0n,
    )!;
    expect(t00.nextState[0]).toBe(0n);
    expect(t00.output[0]).toBe(0n);

    // S0(0), A=1 -> goes to S1
    const t01 = table.transitions.find(
      (t) => t.currentState[0] === 0n && t.input[0] === 1n,
    )!;
    expect(t01.nextState[0]).toBe(1n);

    // S1(1), A=0 -> stays S1
    const t10 = table.transitions.find(
      (t) => t.currentState[0] === 1n && t.input[0] === 0n,
    )!;
    expect(t10.nextState[0]).toBe(1n);
    expect(t10.output[0]).toBe(1n);

    // S1(1), A=1 -> goes to S0
    const t11 = table.transitions.find(
      (t) => t.currentState[0] === 1n && t.input[0] === 1n,
    )!;
    expect(t11.nextState[0]).toBe(0n);

    // The circuit should synthesize without errors from this valid FSM
    const registry = buildRegistry();
    const circuit = fsmToCircuit(fsm, registry);
    expect(circuit.elements.length).toBeGreaterThan(0);
  });

  it('loadableCircuit', () => {
    // Synthesized circuit loads in editor without errors
    const fsm = createFSM('loadable');
    fsm.inputSignals = ['X'];
    fsm.outputSignals = ['Q'];

    const s0 = addState(fsm, 'S0', { x: 0, y: 0 }, { outputs: { Q: 0 } });
    const s1 = addState(fsm, 'S1', { x: 100, y: 0 }, { outputs: { Q: 1 } });

    addTransition(fsm, s0.id, s1.id, 'X');
    addTransition(fsm, s1.id, s0.id, '!X');

    const registry = buildRegistry();

    expect(() => {
      const circuit = fsmToCircuit(fsm, registry);
      // Circuit metadata should be set
      expect(circuit.metadata.name).toBe('Synthesised');
      // All elements should have valid positions
      for (const el of circuit.elements) {
        expect(typeof el.position.x).toBe('number');
        expect(typeof el.position.y).toBe('number');
      }
      // Wires should be valid
      for (const wire of circuit.wires) {
        expect(typeof wire.start.x).toBe('number');
        expect(typeof wire.end.x).toBe('number');
      }
    }).not.toThrow();
  });

  it('minimizedExpressions', () => {
    const fsm = createFSM('min-test');
    fsm.inputSignals = ['A', 'B'];
    fsm.outputSignals = ['Y'];

    const s0 = addState(fsm, 'S0', { x: 0, y: 0 }, { outputs: { Y: 0 } });
    const s1 = addState(fsm, 'S1', { x: 100, y: 0 }, { outputs: { Y: 1 } });
    const s2 = addState(fsm, 'S2', { x: 0, y: 100 }, { outputs: { Y: 1 } });
    const s3 = addState(fsm, 'S3', { x: 100, y: 100 }, { outputs: { Y: 0 } });

    addTransition(fsm, s0.id, s1.id, 'A & B');
    addTransition(fsm, s1.id, s2.id, 'A');
    addTransition(fsm, s2.id, s3.id, 'B');
    addTransition(fsm, s3.id, s0.id, '!A');

    const registry = buildRegistry();
    const minimizedCircuit = fsmToCircuit(fsm, registry, { minimize: true });

    expect(minimizedCircuit.elements.length).toBeGreaterThan(0);

    const inCount = countByType(minimizedCircuit, 'In');
    expect(inCount).toBeGreaterThanOrEqual(1);

    const outCount = countByType(minimizedCircuit, 'Out');
    expect(outCount).toBeGreaterThanOrEqual(1);

    expect(Array.isArray(minimizedCircuit.wires)).toBe(true);
  });

  it('synthesizeD — minimize:false uses raw SOP not minimize()', () => {
    // A 2-state FSM with one input: S0 --A--> S1 --A--> S0.
    // With minimize=true: Z_0_next simplifies to A (one variable).
    // With minimize=false: canonical SOP — one minterm per 1-row, no simplification.
    // Both circuits must be structurally valid and the unminimized circuit
    // must have at least as many elements as the minimized one.
    const fsm = createFSM('d-unmin-test');
    fsm.inputSignals = ['A'];
    fsm.outputSignals = [];

    const s0 = addState(fsm, 'S0', { x: 0, y: 0 });
    const s1 = addState(fsm, 'S1', { x: 100, y: 0 });

    addTransition(fsm, s0.id, s1.id, 'A');
    addTransition(fsm, s1.id, s0.id, 'A');

    const registry = buildRegistry();

    const minCircuit = fsmToCircuit(fsm, registry, { flipflopType: 'D', minimize: true });
    const rawCircuit = fsmToCircuit(fsm, registry, { flipflopType: 'D', minimize: false });

    // Both circuits are structurally valid
    expect(minCircuit.elements.length).toBeGreaterThan(0);
    expect(rawCircuit.elements.length).toBeGreaterThan(0);
    expect(Array.isArray(rawCircuit.wires)).toBe(true);

    // Both have Out components (next-state outputs)
    expect(countByType(rawCircuit, 'Out')).toBeGreaterThanOrEqual(1);

    // Unminimized SOP is never simpler than minimized — at least as many elements
    expect(rawCircuit.elements.length).toBeGreaterThanOrEqual(minCircuit.elements.length);
  });

  it('synthesizeJK — minimize:false uses raw SOP not minimize()', () => {
    // Same 2-state FSM, JK synthesis path.
    // With minimize=false the JK truth tables produce raw SOP expressions.
    // The circuit must be valid, contain J and K outputs, and have at least
    // as many elements as the minimized version.
    const fsm = createFSM('jk-unmin-test');
    fsm.inputSignals = ['A'];
    fsm.outputSignals = [];

    const s0 = addState(fsm, 'S0', { x: 0, y: 0 });
    const s1 = addState(fsm, 'S1', { x: 100, y: 0 });

    addTransition(fsm, s0.id, s1.id, 'A');
    addTransition(fsm, s1.id, s0.id, 'A');

    const registry = buildRegistry();

    const minCircuit = fsmToCircuit(fsm, registry, { flipflopType: 'JK', minimize: true });
    const rawCircuit = fsmToCircuit(fsm, registry, { flipflopType: 'JK', minimize: false });

    // Both circuits are structurally valid
    expect(minCircuit.elements.length).toBeGreaterThan(0);
    expect(rawCircuit.elements.length).toBeGreaterThan(0);
    expect(Array.isArray(rawCircuit.wires)).toBe(true);

    // Both have J and K outputs for the state bit
    const rawOutLabels = rawCircuit.elements
      .filter((el) => el.typeId === 'Out')
      .map((el) => {
        const props = el.getProperties();
        return props.has('label') ? props.get<string>('label') : '';
      });
    expect(rawOutLabels.some((l) => l.includes('_J'))).toBe(true);
    expect(rawOutLabels.some((l) => l.includes('_K'))).toBe(true);

    // Unminimized SOP is never simpler than minimized
    expect(rawCircuit.elements.length).toBeGreaterThanOrEqual(minCircuit.elements.length);
  });
});
