/**
 * Tests for model-analyser.ts
 *
 * Spec tests:
 *   - andGate: 2-input AND → truth table with 4 rows matching AND truth table
 *   - halfAdder: half adder → truth table with 4 rows, Sum and Carry columns correct
 *   - inputLimit: circuit with 21 single-bit inputs → throws with descriptive error
 *   - cycleDetection: circuit with combinational feedback → throws with cycle description
 *   - multiBit: 2-bit input, 2-bit output → 4 rows (2^2 combinations)
 */

import { describe, it, expect } from 'vitest';
import { analyseCircuit } from '../model-analyser.js';
import { SimulationRunner } from '../../headless/runner.js';
import { ComponentRegistry } from '../../core/registry.js';
import { PropertyBag, PropertyType } from '../../core/properties.js';
import { AbstractCircuitElement } from '../../core/element.js';
import type { Pin, Rotation } from '../../core/pin.js';
import { PinDirection } from '../../core/pin.js';
import type { RenderContext, Rect } from '../../core/renderer-interface.js';
import type { ComponentLayout } from '../../core/registry.js';
import { Circuit, Wire } from '../../core/circuit.js';
import type { SimulatorFacade } from '../../headless/facade.js';

// ---------------------------------------------------------------------------
// Stub element
// ---------------------------------------------------------------------------

class StubElement extends AbstractCircuitElement {
  private readonly _pins: Pin[];

  constructor(
    typeId: string,
    instanceId: string,
    position: { x: number; y: number },
    pins: Pin[],
    props: PropertyBag,
  ) {
    super(typeId, instanceId, position, 0 as Rotation, false, props);
    this._pins = pins;
  }

  getPins(): readonly Pin[] { return this._pins; }
  draw(_ctx: RenderContext): void {}
  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 4, height: 4 };
  }
  getHelpText(): string { return ''; }
}

function makePin(
  label: string,
  direction: PinDirection,
  x: number,
  y: number,
  bitWidth = 1,
): Pin {
  return { label, direction, position: { x, y }, bitWidth, isNegated: false, isClock: false };
}

function makePropBag(entries: Record<string, string | number | boolean> = {}): PropertyBag {
  const bag = new PropertyBag();
  for (const [k, v] of Object.entries(entries)) bag.set(k, v);
  return bag;
}

// ---------------------------------------------------------------------------
// Execute functions
// ---------------------------------------------------------------------------

function executePassThrough(_i: number, _s: Uint32Array, _l: ComponentLayout): void {}
function executeNoop(_i: number, _s: Uint32Array, _l: ComponentLayout): void {}

function executeAnd2(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const a = state[layout.inputOffset(index)] ?? 0;
  const b = state[layout.inputOffset(index) + 1] ?? 0;
  state[layout.outputOffset(index)] = (a & b) >>> 0;
}

function executeXor2(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const a = state[layout.inputOffset(index)] ?? 0;
  const b = state[layout.inputOffset(index) + 1] ?? 0;
  state[layout.outputOffset(index)] = (a ^ b) >>> 0;
}

function executeNot(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const a = state[layout.inputOffset(index)] ?? 0;
  state[layout.outputOffset(index)] = a === 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Registry factory
// ---------------------------------------------------------------------------

function buildRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();

  registry.register({
    name: 'In',
    typeId: -1,
    factory: (props) => new StubElement('In', crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin('out', PinDirection.OUTPUT, 2, 0),
    ], props),
    executeFn: executePassThrough,
    pinLayout: [],
    propertyDefs: [
      { key: 'label', type: PropertyType.STRING, label: 'Label', defaultValue: '', description: '' },
      { key: 'bitWidth', type: PropertyType.INT, label: 'Bit Width', defaultValue: 1, description: '' },
    ],
    attributeMap: [],
    category: 'IO' as any,
    helpText: '',
  });

  registry.register({
    name: 'Out',
    typeId: -1,
    factory: (props) => new StubElement('Out', crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin('in', PinDirection.INPUT, 0, 0),
    ], props),
    executeFn: executeNoop,
    pinLayout: [],
    propertyDefs: [
      { key: 'label', type: PropertyType.STRING, label: 'Label', defaultValue: '', description: '' },
      { key: 'bitWidth', type: PropertyType.INT, label: 'Bit Width', defaultValue: 1, description: '' },
    ],
    attributeMap: [],
    category: 'IO' as any,
    helpText: '',
  });

  registry.register({
    name: 'AND',
    typeId: -1,
    factory: (props) => new StubElement('AND', crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin('in0', PinDirection.INPUT, -2, -1),
      makePin('in1', PinDirection.INPUT, -2, 1),
      makePin('out', PinDirection.OUTPUT, 2, 0),
    ], props),
    executeFn: executeAnd2,
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: 'LOGIC' as any,
    helpText: '',
  });

  registry.register({
    name: 'XOR',
    typeId: -1,
    factory: (props) => new StubElement('XOR', crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin('in0', PinDirection.INPUT, -2, -1),
      makePin('in1', PinDirection.INPUT, -2, 1),
      makePin('out', PinDirection.OUTPUT, 2, 0),
    ], props),
    executeFn: executeXor2,
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: 'LOGIC' as any,
    helpText: '',
  });

  registry.register({
    name: 'NOT',
    typeId: -1,
    factory: (props) => new StubElement('NOT', crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin('in', PinDirection.INPUT, -2, 0),
      makePin('out', PinDirection.OUTPUT, 2, 0),
    ], props),
    executeFn: executeNot,
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: 'LOGIC' as any,
    helpText: '',
  });

  return registry;
}

// ---------------------------------------------------------------------------
// Facade adapter: wraps SimulationRunner as SimulatorFacade
// ---------------------------------------------------------------------------

function buildFacade(registry: ComponentRegistry): SimulatorFacade {
  const runner = new SimulationRunner(registry);
  return {
    createCircuit: () => { throw new Error('not implemented'); },
    addComponent: () => { throw new Error('not implemented'); },
    connect: () => { throw new Error('not implemented'); },
    compile: (circuit) => runner.compile(circuit),
    step: (engine) => runner.step(engine),
    run: (engine, cycles) => runner.run(engine, cycles),
    runToStable: (engine, max) => runner.runToStable(engine, max),
    setInput: (engine, label, value) => runner.setInput(engine, label, value),
    readOutput: (engine, label) => runner.readOutput(engine, label),
    readAllSignals: (engine) => {
      const map = runner.readAllSignals(engine);
      const obj: Record<string, number> = {};
      for (const [k, v] of map) obj[k] = v;
      return obj;
    },
    runTests: () => { throw new Error('not implemented'); },
    loadDig: () => { throw new Error('not implemented'); },
    serialize: () => { throw new Error('not implemented'); },
    deserialize: () => { throw new Error('not implemented'); },
  };
}

// ---------------------------------------------------------------------------
// Circuit builders
// ---------------------------------------------------------------------------

/**
 * Build a 2-input AND gate circuit.
 * InA(label="A") → AND → Out(label="Y")
 * InB(label="B") → AND
 */
function buildAndGate(): { circuit: Circuit } {
  const circuit = new Circuit();

  const inA = new StubElement('In', 'inA', { x: 0, y: 0 }, [
    makePin('out', PinDirection.OUTPUT, 2, 0),
  ], makePropBag({ label: 'A', bitWidth: 1 }));

  const inB = new StubElement('In', 'inB', { x: 0, y: 2 }, [
    makePin('out', PinDirection.OUTPUT, 2, 0),
  ], makePropBag({ label: 'B', bitWidth: 1 }));

  const and = new StubElement('AND', 'and1', { x: 4, y: 0 }, [
    makePin('in0', PinDirection.INPUT, 0, 0),
    makePin('in1', PinDirection.INPUT, 0, 2),
    makePin('out', PinDirection.OUTPUT, 4, 1),
  ], makePropBag());

  const out = new StubElement('Out', 'outY', { x: 9, y: 1 }, [
    makePin('in', PinDirection.INPUT, 0, 0),
  ], makePropBag({ label: 'Y', bitWidth: 1 }));

  circuit.elements.push(inA, inB, and, out);
  circuit.wires.push(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
  circuit.wires.push(new Wire({ x: 2, y: 2 }, { x: 4, y: 2 }));
  circuit.wires.push(new Wire({ x: 8, y: 1 }, { x: 9, y: 1 }));

  return { circuit };
}

/**
 * Build a half adder circuit:
 *   Sum = A XOR B
 *   Carry = A AND B
 */
function buildHalfAdder(): { circuit: Circuit } {
  const circuit = new Circuit();

  const inA = new StubElement('In', 'inA', { x: 0, y: 0 }, [
    makePin('out', PinDirection.OUTPUT, 2, 0),
  ], makePropBag({ label: 'A', bitWidth: 1 }));

  const inB = new StubElement('In', 'inB', { x: 0, y: 2 }, [
    makePin('out', PinDirection.OUTPUT, 2, 0),
  ], makePropBag({ label: 'B', bitWidth: 1 }));

  const xor = new StubElement('XOR', 'xor1', { x: 4, y: 0 }, [
    makePin('in0', PinDirection.INPUT, 0, 0),
    makePin('in1', PinDirection.INPUT, 0, 2),
    makePin('out', PinDirection.OUTPUT, 4, 1),
  ], makePropBag());

  const and = new StubElement('AND', 'and1', { x: 4, y: 4 }, [
    makePin('in0', PinDirection.INPUT, 0, -4),
    makePin('in1', PinDirection.INPUT, 0, -2),
    makePin('out', PinDirection.OUTPUT, 4, 1),
  ], makePropBag());

  const outSum = new StubElement('Out', 'outSum', { x: 9, y: 1 }, [
    makePin('in', PinDirection.INPUT, 0, 0),
  ], makePropBag({ label: 'Sum', bitWidth: 1 }));

  const outCarry = new StubElement('Out', 'outCarry', { x: 9, y: 5 }, [
    makePin('in', PinDirection.INPUT, 0, 0),
  ], makePropBag({ label: 'Carry', bitWidth: 1 }));

  circuit.elements.push(inA, inB, xor, and, outSum, outCarry);
  circuit.wires.push(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
  circuit.wires.push(new Wire({ x: 2, y: 2 }, { x: 4, y: 2 }));
  circuit.wires.push(new Wire({ x: 8, y: 1 }, { x: 9, y: 1 }));
  circuit.wires.push(new Wire({ x: 8, y: 5 }, { x: 9, y: 5 }));

  return { circuit };
}

/**
 * Build a circuit with 21 single-bit inputs (exceeds the 20-bit limit).
 */
function buildTooManyInputs(): { circuit: Circuit } {
  const circuit = new Circuit();

  for (let i = 0; i < 21; i++) {
    const inEl = new StubElement('In', `in${i}`, { x: 0, y: i * 4 }, [
      makePin('out', PinDirection.OUTPUT, 2, 0),
    ], makePropBag({ label: `I${i}`, bitWidth: 1 }));
    circuit.elements.push(inEl);
  }

  return { circuit };
}

/**
 * Build a circuit with a combinational feedback loop: NOT gate → output wired to input.
 */
function buildCyclicCircuit(): { circuit: Circuit } {
  const circuit = new Circuit();

  const not1 = new StubElement('NOT', 'not1', { x: 4, y: 0 }, [
    makePin('in', PinDirection.INPUT, 0, 0),
    makePin('out', PinDirection.OUTPUT, 4, 0),
  ], makePropBag());

  circuit.elements.push(not1);
  // Feedback: output → input
  circuit.wires.push(new Wire({ x: 8, y: 0 }, { x: 4, y: 0 }));

  return { circuit };
}

/**
 * Build a circuit with a 2-bit input and pass-through to a 2-bit output.
 * Uses a chain: In(2-bit) → NOT(x2) → Out(2-bit)
 * Actually simpler: In(A,2-bit) → Out(Y), using two 1-bit ins instead
 * since our stub has only 1-bit pins.
 *
 * For the multiBit test we use two 1-bit inputs and verify 4 rows.
 * The spec says: "2-bit input, 2-bit output → 4 rows (2^2 combinations)"
 * which is 2 bits total input space.
 */
function buildMultiBitCircuit(): { circuit: Circuit } {
  // Two 1-bit inputs (total = 2 bits → 4 combinations)
  // Each input goes through a NOT gate and out
  const circuit = new Circuit();

  const inA = new StubElement('In', 'inA', { x: 0, y: 0 }, [
    makePin('out', PinDirection.OUTPUT, 2, 0),
  ], makePropBag({ label: 'A', bitWidth: 1 }));

  const inB = new StubElement('In', 'inB', { x: 0, y: 4 }, [
    makePin('out', PinDirection.OUTPUT, 2, 0),
  ], makePropBag({ label: 'B', bitWidth: 1 }));

  const notA = new StubElement('NOT', 'notA', { x: 4, y: 0 }, [
    makePin('in', PinDirection.INPUT, 0, 0),
    makePin('out', PinDirection.OUTPUT, 4, 0),
  ], makePropBag());

  const notB = new StubElement('NOT', 'notB', { x: 4, y: 4 }, [
    makePin('in', PinDirection.INPUT, 0, 0),
    makePin('out', PinDirection.OUTPUT, 4, 0),
  ], makePropBag());

  const outY = new StubElement('Out', 'outY', { x: 10, y: 0 }, [
    makePin('in', PinDirection.INPUT, 0, 0),
  ], makePropBag({ label: 'Y', bitWidth: 1 }));

  const outZ = new StubElement('Out', 'outZ', { x: 10, y: 4 }, [
    makePin('in', PinDirection.INPUT, 0, 0),
  ], makePropBag({ label: 'Z', bitWidth: 1 }));

  circuit.elements.push(inA, inB, notA, notB, outY, outZ);
  circuit.wires.push(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
  circuit.wires.push(new Wire({ x: 8, y: 0 }, { x: 10, y: 0 }));
  circuit.wires.push(new Wire({ x: 2, y: 4 }, { x: 4, y: 4 }));
  circuit.wires.push(new Wire({ x: 8, y: 4 }, { x: 10, y: 4 }));

  return { circuit };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ModelAnalyser', () => {
  it('andGate — 2-input AND → truth table with 4 rows matching AND truth table', () => {
    const registry = buildRegistry();
    const facade = buildFacade(registry);
    const { circuit } = buildAndGate();

    const table = analyseCircuit(facade, circuit);

    expect(table.inputs).toHaveLength(2);
    expect(table.inputs[0].name).toBe('A');
    expect(table.inputs[1].name).toBe('B');
    expect(table.outputs).toHaveLength(1);
    expect(table.outputs[0].name).toBe('Y');
    expect(table.rows).toHaveLength(4);

    // AND truth table: A=0,B=0→0; A=0,B=1→0; A=1,B=0→0; A=1,B=1→1
    expect(table.rows[0].inputValues).toEqual([0n, 0n]);
    expect(table.rows[0].outputValues).toEqual([0n]);

    expect(table.rows[1].inputValues).toEqual([0n, 1n]);
    expect(table.rows[1].outputValues).toEqual([0n]);

    expect(table.rows[2].inputValues).toEqual([1n, 0n]);
    expect(table.rows[2].outputValues).toEqual([0n]);

    expect(table.rows[3].inputValues).toEqual([1n, 1n]);
    expect(table.rows[3].outputValues).toEqual([1n]);
  });

  it('halfAdder — half adder → truth table with 4 rows, Sum and Carry columns correct', () => {
    const registry = buildRegistry();
    const facade = buildFacade(registry);
    const { circuit } = buildHalfAdder();

    const table = analyseCircuit(facade, circuit);

    expect(table.inputs).toHaveLength(2);
    expect(table.outputs).toHaveLength(2);

    const sumIdx = table.outputs.findIndex((o) => o.name === 'Sum');
    const carryIdx = table.outputs.findIndex((o) => o.name === 'Carry');
    expect(sumIdx).toBeGreaterThanOrEqual(0);
    expect(carryIdx).toBeGreaterThanOrEqual(0);

    expect(table.rows).toHaveLength(4);

    // A=0,B=0: Sum=0, Carry=0
    expect(table.rows[0].outputValues[sumIdx]).toBe(0n);
    expect(table.rows[0].outputValues[carryIdx]).toBe(0n);

    // A=0,B=1: Sum=1, Carry=0
    expect(table.rows[1].outputValues[sumIdx]).toBe(1n);
    expect(table.rows[1].outputValues[carryIdx]).toBe(0n);

    // A=1,B=0: Sum=1, Carry=0
    expect(table.rows[2].outputValues[sumIdx]).toBe(1n);
    expect(table.rows[2].outputValues[carryIdx]).toBe(0n);

    // A=1,B=1: Sum=0, Carry=1
    expect(table.rows[3].outputValues[sumIdx]).toBe(0n);
    expect(table.rows[3].outputValues[carryIdx]).toBe(1n);
  });

  it('inputLimit — circuit with 21 single-bit inputs → throws with descriptive error', () => {
    const registry = buildRegistry();
    const facade = buildFacade(registry);
    const { circuit } = buildTooManyInputs();

    expect(() => analyseCircuit(facade, circuit)).toThrow(/21 input bits/);
    expect(() => analyseCircuit(facade, circuit)).toThrow(/Maximum is 20/);
  });

  it('cycleDetection — circuit with combinational feedback → throws with cycle description', () => {
    const registry = buildRegistry();
    const facade = buildFacade(registry);
    const { circuit } = buildCyclicCircuit();

    expect(() => analyseCircuit(facade, circuit)).toThrow(/did not stabilize/i);
  });

  it('multiBit — 2 single-bit inputs, 2 single-bit outputs → 4 rows (2^2 combinations)', () => {
    const registry = buildRegistry();
    const facade = buildFacade(registry);
    const { circuit } = buildMultiBitCircuit();

    const table = analyseCircuit(facade, circuit);

    // 2 inputs × 1 bit each = 2 total input bits → 4 rows
    expect(table.rows).toHaveLength(4);
    expect(table.inputs).toHaveLength(2);
    expect(table.outputs).toHaveLength(2);

    // NOT gates: Y = !A, Z = !B
    // Row 0: A=0, B=0 → Y=1, Z=1
    expect(table.rows[0].inputValues).toEqual([0n, 0n]);
    const yIdx = table.outputs.findIndex((o) => o.name === 'Y');
    const zIdx = table.outputs.findIndex((o) => o.name === 'Z');
    expect(table.rows[0].outputValues[yIdx]).toBe(1n);
    expect(table.rows[0].outputValues[zIdx]).toBe(1n);

    // Row 3: A=1, B=1 → Y=0, Z=0
    expect(table.rows[3].inputValues).toEqual([1n, 1n]);
    expect(table.rows[3].outputValues[yIdx]).toBe(0n);
    expect(table.rows[3].outputValues[zIdx]).toBe(0n);
  });
});
