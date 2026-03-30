/**
 * Tests for the analog partition guard fix and ground synthesis.
 *
 * Task 1.5: Verifies that:
 *   - Pure-digital circuits in "all" mode produce a non-null analog partition
 *   - Pure-digital circuits in "all" mode have bridge adapters
 *   - Pure-digital circuits in "all" mode produce no "no-ground" diagnostic
 *   - Pure-digital circuits in "cross-domain" mode skip analog (no boundary nets)
 *   - Bridge-only analog partitions (no components) assign node 0
 */

import { describe, it, expect } from 'vitest';
import { compileUnified } from '../compile.js';
import { Circuit, Wire } from '../../core/circuit.js';
import type { PinDeclaration } from '../../core/pin.js';
import { PinDirection } from '../../core/pin.js';
import { ComponentRegistry } from '../../core/registry.js';
import type { ComponentDefinition } from '../../core/registry.js';
import { ComponentCategory } from '../../core/registry.js';
import type { ConcreteCompiledAnalogCircuit } from '../../solver/analog/compiled-analog-circuit.js';
import { compileAnalogPartition } from '../../solver/analog/compiler.js';
import type { SolverPartition, ConnectivityGroup, BridgeStub, BridgeDescriptor } from '../types.js';
import { createTestElementFromDecls } from '../../test-fixtures/test-element.js';
import { noopExecFn } from '../../test-fixtures/execute-stubs.js';
import { MNAEngine } from '../../solver/analog/analog-engine.js';




function inputPin(x: number, y: number, label: string, bitWidth = 1): PinDeclaration {
  return { direction: PinDirection.INPUT, label, defaultBitWidth: bitWidth, position: { x, y }, isNegatable: false, isClockCapable: false, kind: "signal" };
}

function outputPin(x: number, y: number, label: string, bitWidth = 1): PinDeclaration {
  return { direction: PinDirection.OUTPUT, label, defaultBitWidth: bitWidth, position: { x, y }, isNegatable: false, isClockCapable: false, kind: "signal" };
}


function makeDigitalDef(name: string, pins: PinDeclaration[]): ComponentDefinition {
  return {
    name,
    typeId: -1 as unknown as number,
    factory: (props) => createTestElementFromDecls(name, crypto.randomUUID(), pins, props),
    pinLayout: pins,
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: '',
    models: { digital: { executeFn: noopExecFn } },
  };
}

function buildDigitalRegistry(): ComponentRegistry {
  const r = new ComponentRegistry();
  const twoIn = [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')];
  const singleOut = [outputPin(0, 0, 'out')];
  const singleIn = [inputPin(0, 0, 'in')];
  r.register(makeDigitalDef('And', twoIn) as ComponentDefinition);
  r.register(makeDigitalDef('In', singleOut) as ComponentDefinition);
  r.register(makeDigitalDef('Out', singleIn) as ComponentDefinition);
  return r;
}

function buildPureDigitalCircuit(): { circuit: Circuit; registry: ComponentRegistry } {
  const registry = buildDigitalRegistry();
  const twoIn = [inputPin(0, 0, 'a'), inputPin(0, 1, 'b'), outputPin(2, 0, 'out')];
  const singleOut = [outputPin(0, 0, 'out')];
  const singleIn = [inputPin(0, 0, 'in')];

  const circuit = new Circuit();
  circuit.addElement(createTestElementFromDecls('In', 'inA', singleOut));
  circuit.addElement(createTestElementFromDecls('In', 'inB', singleOut, undefined, { x: 0, y: 1 }));
  circuit.addElement(createTestElementFromDecls('And', 'and1', twoIn, undefined, { x: 4, y: 0 }));
  circuit.addElement(createTestElementFromDecls('Out', 'out1', singleIn, undefined, { x: 8, y: 0 }));

  circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
  circuit.addWire(new Wire({ x: 2, y: 1 }, { x: 4, y: 1 }));
  circuit.addWire(new Wire({ x: 6, y: 0 }, { x: 8, y: 0 }));

  return { circuit, registry };
}

describe('compile-bridge-guard: pure-digital circuit in "all" mode', () => {
  it('compiles analog partition (compiledAnalog !== null)', () => {
    const { circuit, registry } = buildPureDigitalCircuit();
    circuit.metadata = { ...circuit.metadata, digitalPinLoading: 'all' };

    const result = compileUnified(circuit, registry);

    expect(result.analog).not.toBeNull();
  });

  it('has bridge adapters in compiled result', () => {
    const { circuit, registry } = buildPureDigitalCircuit();
    circuit.metadata = { ...circuit.metadata, digitalPinLoading: 'all' };

    const result = compileUnified(circuit, registry);

    expect(result.bridges.length).toBeGreaterThan(0);
  });

  it('has no "no-ground" diagnostic', () => {
    const { circuit, registry } = buildPureDigitalCircuit();
    circuit.metadata = { ...circuit.metadata, digitalPinLoading: 'all' };

    const result = compileUnified(circuit, registry);
    const analogCircuit = result.analog as ConcreteCompiledAnalogCircuit;

    const noGroundDiags = analogCircuit.diagnostics.filter((d) => d.code === 'no-ground');
    expect(noGroundDiags).toHaveLength(0);
  });
});

describe('compile-bridge-guard: pure-digital circuit in "cross-domain" mode', () => {
  it('skips analog partition (compiledAnalog === null)', () => {
    const { circuit, registry } = buildPureDigitalCircuit();
    circuit.metadata = { ...circuit.metadata, digitalPinLoading: 'cross-domain' };

    const result = compileUnified(circuit, registry);

    expect(result.analog).toBeNull();
  });
});

describe('compile-bridge-guard: pure-digital circuit in "all" mode produces finite voltages', () => {
  it('DC operating point has all-finite node voltages (ground synthesis produces solvable matrix)', () => {
    const { circuit, registry } = buildPureDigitalCircuit();
    circuit.metadata = { ...circuit.metadata, digitalPinLoading: 'all' };

    const result = compileUnified(circuit, registry);
    const analogPartition = result.analog as ConcreteCompiledAnalogCircuit;
    expect(analogPartition).not.toBeNull();

    const engine = new MNAEngine();
    engine.init(analogPartition);
    const dcResult = engine.dcOperatingPoint();

    // If ground synthesis is fake (no real ground node), MNA produces NaN
    expect(dcResult.converged).toBe(true);
    for (let i = 0; i < dcResult.nodeVoltages.length; i++) {
      expect(Number.isFinite(dcResult.nodeVoltages[i])).toBe(true);
    }
  });
});

describe('compile-bridge-guard: bridge-only analog partition assigns node 0', () => {
  it('nodeCount >= 1 when partition has bridge groups but no components', () => {
    const boundaryGroup: ConnectivityGroup = {
      groupId: 10,
      pins: [],
      wires: [],
      domains: new Set(['digital', 'analog']),
      bitWidth: 1,
    };

    const descriptor: BridgeDescriptor = {
      boundaryGroup,
      direction: 'digital-to-analog',
      bitWidth: 1,
      electricalSpec: {},
    };

    const stub: BridgeStub = {
      boundaryGroupId: 10,
      descriptor,
    };

    const partition: SolverPartition = {
      components: [],
      groups: [boundaryGroup],
      bridgeStubs: [stub],
    };

    const registry = new ComponentRegistry();
    const compiled = compileAnalogPartition(partition, registry);

    expect(compiled.nodeCount).toBeGreaterThanOrEqual(1);
  });
});
