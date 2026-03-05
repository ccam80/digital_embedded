/**
 * Tests for dependency.ts (task 8.3.4).
 *
 * Tests:
 *   - andGate: output depends on both inputs
 *   - passThrough: buffer (In→Out) → output depends on input, not on other inputs
 *   - independentOutputs: two independent output chains → correct dependency subsets
 */

import { describe, expect, it } from 'vitest';
import { analyseDependencies } from '../dependency.js';
import { Circuit, Wire } from '../../core/circuit.js';
import { ComponentRegistry } from '../../core/registry.js';
import { PropertyBag, PropertyType } from '../../core/properties.js';
import { AbstractCircuitElement } from '../../core/element.js';
import type { Pin, Rotation } from '../../core/pin.js';
import { PinDirection } from '../../core/pin.js';
import type { RenderContext, Rect } from '../../core/renderer-interface.js';
import type { ComponentLayout } from '../../core/registry.js';
import { SimulationRunner } from '../../headless/runner.js';
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

function makePin(label: string, direction: PinDirection, x: number, y: number, bw = 1): Pin {
  return { label, direction, position: { x, y }, bitWidth: bw, isNegated: false, isClock: false };
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
      { key: 'label', type: PropertyType.STRING, label: 'Label', defaultValue: '' },
      { key: 'bitWidth', type: PropertyType.INT, label: 'Bits', defaultValue: 1 },
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
      { key: 'label', type: PropertyType.STRING, label: 'Label', defaultValue: '' },
      { key: 'bitWidth', type: PropertyType.INT, label: 'Bits', defaultValue: 1 },
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

  return registry;
}

// ---------------------------------------------------------------------------
// Facade factory
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
 * AND gate circuit:
 *   In(A) ──┐
 *            AND ── Out(Y)
 *   In(B) ──┘
 */
function buildAndGate(): Circuit {
  const circuit = new Circuit();

  const inA = new StubElement('In', 'inA', { x: 0, y: 0 }, [
    makePin('out', PinDirection.OUTPUT, 2, 0),
  ], makePropBag({ label: 'A', bitWidth: 1 }));

  const inB = new StubElement('In', 'inB', { x: 0, y: 2 }, [
    makePin('out', PinDirection.OUTPUT, 2, 2),
  ], makePropBag({ label: 'B', bitWidth: 1 }));

  const and = new StubElement('AND', 'and1', { x: 4, y: 0 }, [
    makePin('in0', PinDirection.INPUT, 4, 0),
    makePin('in1', PinDirection.INPUT, 4, 2),
    makePin('out', PinDirection.OUTPUT, 8, 1),
  ], makePropBag());

  const out = new StubElement('Out', 'outY', { x: 9, y: 1 }, [
    makePin('in', PinDirection.INPUT, 9, 1),
  ], makePropBag({ label: 'Y', bitWidth: 1 }));

  circuit.elements.push(inA, inB, and, out);
  circuit.wires.push(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
  circuit.wires.push(new Wire({ x: 2, y: 2 }, { x: 4, y: 2 }));
  circuit.wires.push(new Wire({ x: 8, y: 1 }, { x: 9, y: 1 }));

  return circuit;
}

/**
 * Buffer (pass-through) circuit:
 *   In(A) ── Out(Y)   (A directly wired to Y)
 *   In(B) ── Out(Z)   (B directly wired to Z)
 */
function buildPassThrough(): Circuit {
  const circuit = new Circuit();

  const inA = new StubElement('In', 'inA', { x: 0, y: 0 }, [
    makePin('out', PinDirection.OUTPUT, 2, 0),
  ], makePropBag({ label: 'A', bitWidth: 1 }));

  const inB = new StubElement('In', 'inB', { x: 0, y: 4 }, [
    makePin('out', PinDirection.OUTPUT, 2, 4),
  ], makePropBag({ label: 'B', bitWidth: 1 }));

  const outY = new StubElement('Out', 'outY', { x: 4, y: 0 }, [
    makePin('in', PinDirection.INPUT, 4, 0),
  ], makePropBag({ label: 'Y', bitWidth: 1 }));

  const outZ = new StubElement('Out', 'outZ', { x: 4, y: 4 }, [
    makePin('in', PinDirection.INPUT, 4, 4),
  ], makePropBag({ label: 'Z', bitWidth: 1 }));

  circuit.elements.push(inA, inB, outY, outZ);
  circuit.wires.push(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
  circuit.wires.push(new Wire({ x: 2, y: 4 }, { x: 4, y: 4 }));

  return circuit;
}

/**
 * Two independent AND chains:
 *   Chain 1: In(A) + In(B) → AND → Out(Y1)
 *   Chain 2: In(C) + In(D) → AND → Out(Y2)
 *
 * Y1 depends on A and B, not C or D.
 * Y2 depends on C and D, not A or B.
 */
function buildIndependentOutputs(): Circuit {
  const circuit = new Circuit();

  const inA = new StubElement('In', 'inA', { x: 0, y: 0 }, [
    makePin('out', PinDirection.OUTPUT, 2, 0),
  ], makePropBag({ label: 'A', bitWidth: 1 }));

  const inB = new StubElement('In', 'inB', { x: 0, y: 2 }, [
    makePin('out', PinDirection.OUTPUT, 2, 2),
  ], makePropBag({ label: 'B', bitWidth: 1 }));

  const inC = new StubElement('In', 'inC', { x: 0, y: 8 }, [
    makePin('out', PinDirection.OUTPUT, 2, 8),
  ], makePropBag({ label: 'C', bitWidth: 1 }));

  const inD = new StubElement('In', 'inD', { x: 0, y: 10 }, [
    makePin('out', PinDirection.OUTPUT, 2, 10),
  ], makePropBag({ label: 'D', bitWidth: 1 }));

  const and1 = new StubElement('AND', 'and1', { x: 4, y: 0 }, [
    makePin('in0', PinDirection.INPUT, 4, 0),
    makePin('in1', PinDirection.INPUT, 4, 2),
    makePin('out', PinDirection.OUTPUT, 8, 1),
  ], makePropBag());

  const and2 = new StubElement('AND', 'and2', { x: 4, y: 8 }, [
    makePin('in0', PinDirection.INPUT, 4, 8),
    makePin('in1', PinDirection.INPUT, 4, 10),
    makePin('out', PinDirection.OUTPUT, 8, 9),
  ], makePropBag());

  const outY1 = new StubElement('Out', 'outY1', { x: 10, y: 1 }, [
    makePin('in', PinDirection.INPUT, 10, 1),
  ], makePropBag({ label: 'Y1', bitWidth: 1 }));

  const outY2 = new StubElement('Out', 'outY2', { x: 10, y: 9 }, [
    makePin('in', PinDirection.INPUT, 10, 9),
  ], makePropBag({ label: 'Y2', bitWidth: 1 }));

  circuit.elements.push(inA, inB, inC, inD, and1, and2, outY1, outY2);
  circuit.wires.push(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
  circuit.wires.push(new Wire({ x: 2, y: 2 }, { x: 4, y: 2 }));
  circuit.wires.push(new Wire({ x: 8, y: 1 }, { x: 10, y: 1 }));
  circuit.wires.push(new Wire({ x: 2, y: 8 }, { x: 4, y: 8 }));
  circuit.wires.push(new Wire({ x: 2, y: 10 }, { x: 4, y: 10 }));
  circuit.wires.push(new Wire({ x: 8, y: 9 }, { x: 10, y: 9 }));

  return circuit;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dependency', () => {
  // -------------------------------------------------------------------------
  // andGate: output depends on both inputs
  // -------------------------------------------------------------------------

  it('andGate — AND gate output depends on both A and B', () => {
    const registry = buildRegistry();
    const facade = buildFacade(registry);
    const circuit = buildAndGate();

    const matrix = analyseDependencies(facade, circuit);

    expect(matrix.inputs).toEqual(['A', 'B']);
    expect(matrix.outputs).toEqual(['Y']);

    // Y depends on A (index 0)
    expect(matrix.depends[0]![0]).toBe(true);
    // Y depends on B (index 1)
    expect(matrix.depends[0]![1]).toBe(true);
  });

  // -------------------------------------------------------------------------
  // passThrough: Y depends only on A, Z depends only on B
  // -------------------------------------------------------------------------

  it('passThrough — Y depends on A only, Z depends on B only', () => {
    const registry = buildRegistry();
    const facade = buildFacade(registry);
    const circuit = buildPassThrough();

    const matrix = analyseDependencies(facade, circuit);

    expect(matrix.inputs).toEqual(['A', 'B']);
    expect(matrix.outputs).toEqual(['Y', 'Z']);

    const aIdx = matrix.inputs.indexOf('A');
    const bIdx = matrix.inputs.indexOf('B');
    const yIdx = matrix.outputs.indexOf('Y');
    const zIdx = matrix.outputs.indexOf('Z');

    // Y depends on A, not B
    expect(matrix.depends[yIdx]![aIdx]).toBe(true);
    expect(matrix.depends[yIdx]![bIdx]).toBe(false);

    // Z depends on B, not A
    expect(matrix.depends[zIdx]![bIdx]).toBe(true);
    expect(matrix.depends[zIdx]![aIdx]).toBe(false);
  });

  // -------------------------------------------------------------------------
  // independentOutputs: Y1 depends on A,B not C,D; Y2 depends on C,D not A,B
  // -------------------------------------------------------------------------

  it('independentOutputs — Y1 depends on A+B only, Y2 depends on C+D only', () => {
    const registry = buildRegistry();
    const facade = buildFacade(registry);
    const circuit = buildIndependentOutputs();

    const matrix = analyseDependencies(facade, circuit);

    expect(matrix.inputs).toEqual(['A', 'B', 'C', 'D']);
    expect(matrix.outputs).toEqual(['Y1', 'Y2']);

    const aIdx = 0, bIdx = 1, cIdx = 2, dIdx = 3;
    const y1Idx = 0, y2Idx = 1;

    // Y1 depends on A and B
    expect(matrix.depends[y1Idx]![aIdx]).toBe(true);
    expect(matrix.depends[y1Idx]![bIdx]).toBe(true);
    // Y1 does NOT depend on C or D
    expect(matrix.depends[y1Idx]![cIdx]).toBe(false);
    expect(matrix.depends[y1Idx]![dIdx]).toBe(false);

    // Y2 depends on C and D
    expect(matrix.depends[y2Idx]![cIdx]).toBe(true);
    expect(matrix.depends[y2Idx]![dIdx]).toBe(true);
    // Y2 does NOT depend on A or B
    expect(matrix.depends[y2Idx]![aIdx]).toBe(false);
    expect(matrix.depends[y2Idx]![bIdx]).toBe(false);
  });
});
