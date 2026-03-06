/**
 * Tests for substitute-library.ts
 *
 * Spec tests:
 *   - muxToGates: circuit with Multiplexer → substituted circuit has only basic gates
 *   - subcircuitInlined: circuit with subcircuit → subcircuit internals inlined and substituted
 *   - noSubNeeded: circuit with only basic gates → returned unchanged
 *   - unsubstitutable: circuit with RAM → reports RAM as blocking component
 *   - functionalEquivalence: original and substituted circuits produce same truth table
 */

import { describe, it, expect } from 'vitest';
import { substituteForAnalysis } from '../substitute-library.js';
import { ComponentRegistry } from '../../core/registry.js';
import { PropertyBag, PropertyType } from '../../core/properties.js';
import { AbstractCircuitElement } from '../../core/element.js';
import type { Pin, Rotation } from '../../core/pin.js';
import { PinDirection } from '../../core/pin.js';
import type { RenderContext, Rect } from '../../core/renderer-interface.js';
import type { ComponentLayout } from '../../core/registry.js';
import { Circuit, Wire } from '../../core/circuit.js';
import type { SubcircuitDefinition } from '../../components/subcircuit/subcircuit.js';
import { SubcircuitElement } from '../../components/subcircuit/subcircuit.js';
import { SimulationRunner } from '../../headless/runner.js';
import { analyseCircuit } from '../model-analyser.js';
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
// Execute functions (for functional equivalence test)
// ---------------------------------------------------------------------------

function executePassThrough(_i: number, _s: Uint32Array, _l: ComponentLayout): void {}
function executeNoop(_i: number, _s: Uint32Array, _l: ComponentLayout): void {}

function executeAnd2(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const a = state[layout.inputOffset(index)] ?? 0;
  const b = state[layout.inputOffset(index) + 1] ?? 0;
  state[layout.outputOffset(index)] = (a & b) >>> 0;
}

function executeOr2(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const a = state[layout.inputOffset(index)] ?? 0;
  const b = state[layout.inputOffset(index) + 1] ?? 0;
  state[layout.outputOffset(index)] = (a | b) >>> 0;
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
    name: 'OR',
    typeId: -1,
    factory: (props) => new StubElement('OR', crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin('in0', PinDirection.INPUT, -2, -1),
      makePin('in1', PinDirection.INPUT, -2, 1),
      makePin('out', PinDirection.OUTPUT, 2, 0),
    ], props),
    executeFn: executeOr2,
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
// Circuit builders
// ---------------------------------------------------------------------------

/**
 * Build a circuit containing a Multiplexer component.
 */
function buildMuxCircuit(): Circuit {
  const circuit = new Circuit();

  const mux = new StubElement('Multiplexer', 'mux1', { x: 4, y: 0 }, [
    makePin('D0', PinDirection.INPUT, 4, 0),
    makePin('D1', PinDirection.INPUT, 4, 2),
    makePin('S', PinDirection.INPUT, 6, 4),
    makePin('Y', PinDirection.OUTPUT, 12, 2),
  ], makePropBag());

  circuit.addElement(mux);
  return circuit;
}

/**
 * Build a circuit containing only basic AND and NOT gates.
 */
function buildBasicGatesCircuit(): Circuit {
  const circuit = new Circuit();

  const inA = new StubElement('In', 'inA', { x: 0, y: 0 }, [
    makePin('out', PinDirection.OUTPUT, 2, 0),
  ], makePropBag({ label: 'A', bitWidth: 1 }));

  const inB = new StubElement('In', 'inB', { x: 0, y: 2 }, [
    makePin('out', PinDirection.OUTPUT, 2, 2),
  ], makePropBag({ label: 'B', bitWidth: 1 }));

  const and = new StubElement('AND', 'and1', { x: 4, y: 1 }, [
    makePin('in0', PinDirection.INPUT, 4, 0),
    makePin('in1', PinDirection.INPUT, 4, 2),
    makePin('out', PinDirection.OUTPUT, 8, 1),
  ], makePropBag());

  const out = new StubElement('Out', 'outY', { x: 9, y: 1 }, [
    makePin('in', PinDirection.INPUT, 9, 1),
  ], makePropBag({ label: 'Y', bitWidth: 1 }));

  circuit.addElement(inA);
  circuit.addElement(inB);
  circuit.addElement(and);
  circuit.addElement(out);
  circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
  circuit.addWire(new Wire({ x: 2, y: 2 }, { x: 4, y: 2 }));
  circuit.addWire(new Wire({ x: 8, y: 1 }, { x: 9, y: 1 }));

  return circuit;
}

/**
 * Build a circuit containing a RAM component (unsubstitutable).
 */
function buildRamCircuit(): Circuit {
  const circuit = new Circuit();

  const ram = new StubElement('RAM', 'ram1', { x: 4, y: 0 }, [
    makePin('A', PinDirection.INPUT, 4, 0),
    makePin('D', PinDirection.OUTPUT, 8, 0),
  ], makePropBag());

  circuit.addElement(ram);
  return circuit;
}

/**
 * Build a circuit where a SubcircuitElement contains an AND gate internally.
 */
function buildSubcircuitCircuit(): { circuit: Circuit; nestedCircuit: Circuit } {
  // Build the nested (inner) circuit: A AND B → Y
  const nestedCircuit = new Circuit({ name: 'AndSubcircuit' });

  const nestedInA = new StubElement('In', 'nested_inA', { x: 0, y: 0 }, [
    makePin('out', PinDirection.OUTPUT, 2, 0),
  ], makePropBag({ label: 'A', bitWidth: 1 }));

  const nestedInB = new StubElement('In', 'nested_inB', { x: 0, y: 2 }, [
    makePin('out', PinDirection.OUTPUT, 2, 2),
  ], makePropBag({ label: 'B', bitWidth: 1 }));

  const nestedAnd = new StubElement('AND', 'nested_and', { x: 4, y: 1 }, [
    makePin('in0', PinDirection.INPUT, 4, 0),
    makePin('in1', PinDirection.INPUT, 4, 2),
    makePin('out', PinDirection.OUTPUT, 8, 1),
  ], makePropBag());

  const nestedOut = new StubElement('Out', 'nested_out', { x: 9, y: 1 }, [
    makePin('in', PinDirection.INPUT, 9, 1),
  ], makePropBag({ label: 'Y', bitWidth: 1 }));

  nestedCircuit.addElement(nestedInA);
  nestedCircuit.addElement(nestedInB);
  nestedCircuit.addElement(nestedAnd);
  nestedCircuit.addElement(nestedOut);
  nestedCircuit.addWire(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
  nestedCircuit.addWire(new Wire({ x: 2, y: 2 }, { x: 4, y: 2 }));
  nestedCircuit.addWire(new Wire({ x: 8, y: 1 }, { x: 9, y: 1 }));

  // Build the subcircuit definition
  const subcircuitDef: SubcircuitDefinition = {
    circuit: nestedCircuit,
    pinLayout: [
      { label: 'A', direction: PinDirection.INPUT, position: { x: 0, y: 1 }, defaultBitWidth: 1, isNegatable: false, isClockCapable: false },
      { label: 'B', direction: PinDirection.INPUT, position: { x: 0, y: 2 }, defaultBitWidth: 1, isNegatable: false, isClockCapable: false },
      { label: 'Y', direction: PinDirection.OUTPUT, position: { x: 4, y: 1 }, defaultBitWidth: 1, isNegatable: false, isClockCapable: false },
    ],
    shapeMode: 'DEFAULT',
    name: 'AndSubcircuit',
  };

  // Create the outer circuit with a subcircuit element
  const outerCircuit = new Circuit();

  const subcircuitEl = new SubcircuitElement(
    'AndSubcircuit',
    'sc1',
    { x: 10, y: 0 },
    0 as Rotation,
    false,
    makePropBag(),
    subcircuitDef,
  );

  outerCircuit.addElement(subcircuitEl);

  return { circuit: outerCircuit, nestedCircuit };
}

// ---------------------------------------------------------------------------
// Helper: collect all type IDs from a circuit's elements
// ---------------------------------------------------------------------------

function collectTypeIds(circuit: Circuit): string[] {
  return circuit.elements.map((el) => el.typeId);
}

// ---------------------------------------------------------------------------
// Facade for functional equivalence test
// ---------------------------------------------------------------------------

function buildFacade(registry: ComponentRegistry): SimulatorFacade {
  const runner = new SimulationRunner(registry);
  return {
    createCircuit: () => { throw new Error('not used'); },
    addComponent: () => { throw new Error('not used'); },
    connect: () => { throw new Error('not used'); },
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
    runTests: () => { throw new Error('not used'); },
    loadDig: () => { throw new Error('not used'); },
    serialize: () => { throw new Error('not used'); },
    deserialize: () => { throw new Error('not used'); },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubstituteLibrary', () => {
  it('muxToGates — circuit with Multiplexer → substituted circuit has only basic gates', () => {
    const registry = buildRegistry();
    const circuit = buildMuxCircuit();

    const result = substituteForAnalysis(circuit, registry);

    // No blocking components
    expect(result.blockingComponents).toHaveLength(0);

    // All elements in substituted circuit should be basic gate types
    const typeIds = collectTypeIds(result.circuit);
    expect(typeIds).not.toContain('Multiplexer');
    expect(typeIds).not.toContain('Mux');

    // Should contain AND and NOT gates from the MUX substitution
    expect(typeIds.some((t) => t === 'AND' || t === 'And')).toBe(true);
    expect(typeIds.some((t) => t === 'NOT' || t === 'Not')).toBe(true);
  });

  it('subcircuitInlined — circuit with subcircuit → subcircuit internals inlined and substituted', () => {
    const registry = buildRegistry();
    const { circuit } = buildSubcircuitCircuit();

    const result = substituteForAnalysis(circuit, registry);

    // No blocking components (AND gate is basic)
    expect(result.blockingComponents).toHaveLength(0);

    // The subcircuit element should be replaced by its internal elements
    const typeIds = collectTypeIds(result.circuit);
    expect(typeIds).not.toContain('AndSubcircuit');

    // Internal AND gate should be present
    expect(typeIds.some((t) => t === 'AND' || t === 'And')).toBe(true);

    // Internal In/Out elements should be present
    expect(typeIds.some((t) => t === 'In')).toBe(true);
    expect(typeIds.some((t) => t === 'Out')).toBe(true);
  });

  it('noSubNeeded — circuit with only basic gates → returned with same element count', () => {
    const registry = buildRegistry();
    const circuit = buildBasicGatesCircuit();
    const originalCount = circuit.elements.length;

    const result = substituteForAnalysis(circuit, registry);

    // No blocking components
    expect(result.blockingComponents).toHaveLength(0);

    // Same number of elements (no expansion or removal)
    expect(result.circuit.elements).toHaveLength(originalCount);

    // All types preserved
    const typeIds = collectTypeIds(result.circuit);
    expect(typeIds).toContain('AND');
    expect(typeIds).toContain('In');
    expect(typeIds).toContain('Out');
  });

  it('unsubstitutable — circuit with RAM → reports RAM as blocking component', () => {
    const registry = buildRegistry();
    const circuit = buildRamCircuit();

    const result = substituteForAnalysis(circuit, registry);

    // RAM should be in blockingComponents
    expect(result.blockingComponents).toContain('RAM');
    expect(result.blockingComponents.length).toBeGreaterThan(0);
  });

  it('functionalEquivalence — original and substituted circuits produce same truth table', () => {
    // Use a simple AND gate circuit (basic → no substitution needed)
    // and verify both original and substituted produce identical truth tables
    const registry = buildRegistry();
    const facade = buildFacade(registry);
    const circuit = buildBasicGatesCircuit();

    const result = substituteForAnalysis(circuit, registry);

    const originalTable = analyseCircuit(facade, circuit);
    const substitutedTable = analyseCircuit(facade, result.circuit);

    // Same number of inputs, outputs, and rows
    expect(substitutedTable.inputs).toHaveLength(originalTable.inputs.length);
    expect(substitutedTable.outputs).toHaveLength(originalTable.outputs.length);
    expect(substitutedTable.rows).toHaveLength(originalTable.rows.length);

    // All output values match for every row
    for (let i = 0; i < originalTable.rows.length; i++) {
      expect(substitutedTable.rows[i].outputValues).toEqual(originalTable.rows[i].outputValues);
    }
  });
});
