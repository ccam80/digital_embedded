/**
 * Tests for wiring table indirection (Task 1.2a).
 *
 * Verifies that layout.wiringTable is available, that inputOffset/outputOffset
 * return wiring-table indices, and that engine internals resolve through the
 * wiring table correctly.
 */

import { describe, it, expect } from "vitest";
import { compileUnified } from "@/compile/compile.js";
import { DigitalEngine } from "../digital-engine.js";

import { Circuit, Wire } from "@/core/circuit";
import { ComponentRegistry } from "@/core/registry";
import type { ComponentDefinition, ExecuteFunction } from "@/core/registry";
import { ComponentCategory } from "@/core/registry";
import type { PinDeclaration } from "@/core/pin";
import { PinDirection } from "@/core/pin";
import type { } from "@/core/renderer-interface";
import { createTestElementFromDecls } from '@/test-fixtures/test-element.js';
import { noopExecFn } from '@/test-fixtures/execute-stubs.js';

// ---------------------------------------------------------------------------
// Minimal test CircuitElement implementation
// ---------------------------------------------------------------------------




// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

function twoInputOneOutput(): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "a", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT, label: "b", defaultBitWidth: 1, position: { x: 0, y: 1 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
}

function dffPins(): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "D", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT, label: "C", defaultBitWidth: 1, position: { x: 0, y: 1 }, isNegatable: false, isClockCapable: true, kind: "signal" },
    { direction: PinDirection.OUTPUT, label: "Q", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.OUTPUT, label: "~Q", defaultBitWidth: 1, position: { x: 2, y: 1 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
}

// ---------------------------------------------------------------------------
// Execute functions using wiring table indirection
// ---------------------------------------------------------------------------

const executeAnd: ExecuteFunction = (index, state, _highZs, layout) => {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  state[wt[outBase]!] = (state[wt[inBase]!]! & state[wt[inBase + 1]!]!) >>> 0;
};

const executeOr: ExecuteFunction = (index, state, _highZs, layout) => {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  state[wt[outBase]!] = (state[wt[inBase]!]! | state[wt[inBase + 1]!]!) >>> 0;
};

const executeXor: ExecuteFunction = (index, state, _highZs, layout) => {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  state[wt[outBase]!] = (state[wt[inBase]!]! ^ state[wt[inBase + 1]!]!) >>> 0;
};


const executeDFF: ExecuteFunction = (index, state, _highZs, layout) => {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = layout.stateOffset(index);
  const D = state[wt[inBase]!]! & 1;
  const clk = state[wt[inBase + 1]!]! & 1;
  const prevClk = state[stBase + 1]! & 1;
  if (!prevClk && clk) {
    state[stBase] = D;
  }
  state[wt[outBase]!] = state[stBase]!;
  state[wt[outBase + 1]!] = (~state[stBase]!) >>> 0;
  state[stBase + 1] = clk;
};

// ---------------------------------------------------------------------------
// Definition builders
// ---------------------------------------------------------------------------

function makeDef(
  name: string,
  pins: PinDeclaration[],
  executeFn: ExecuteFunction,
  opts?: { stateSlotCount?: number },
): ComponentDefinition {
  return {
    name,
    typeId: -1,
    factory: (props) => createTestElementFromDecls(name, `${name}-0`, pins, props),
    pinLayout: pins,
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: "",
    models: {
      digital: {
        executeFn,
        ...(opts?.stateSlotCount !== undefined ? { stateSlotCount: opts.stateSlotCount } : {}),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: set a net value directly in the engine
// ---------------------------------------------------------------------------

function setNet(engine: DigitalEngine, netId: number, value: number): void {
  (engine as unknown as { _values: Uint32Array })["_values"][netId] = value >>> 0;
  (engine as unknown as { _highZs: Uint32Array })["_highZs"][netId] = 0;
  (engine as unknown as { _undefinedFlags: Uint8Array })["_undefinedFlags"][netId] = 0;
}

function getNet(engine: DigitalEngine, netId: number): number {
  return engine.getSignalRaw(netId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WiringIndirection", () => {
  it("non_contiguous_inputs_resolve_correctly", () => {
    // Create a circuit where an AND gate has inputs connected to non-contiguous nets.
    // In0 (x=0,y=0) -> AND.a (x=4,y=0)
    // In1 (x=0,y=4) -> AND.b (x=4,y=1)
    // AND.out -> Out (x=8,y=0)
    const registry = new ComponentRegistry();
    registry.register(makeDef("In", [
      { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ], noopExecFn));
    registry.register(makeDef("And", twoInputOneOutput(), executeAnd));
    registry.register(makeDef("Out", [
      { direction: PinDirection.INPUT, label: "in", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ], noopExecFn));

    const circuit = new Circuit();
    const in0 = createTestElementFromDecls("In", "in0", [
      { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ]);
    const in1 = createTestElementFromDecls("In", "in1", [
      { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ], undefined, { x: 0, y: 4 });
    const andGate = createTestElementFromDecls("And", "and0", twoInputOneOutput(), undefined, { x: 4, y: 0 });
    const outComp = createTestElementFromDecls("Out", "out0", [
      { direction: PinDirection.INPUT, label: "in", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ], undefined, { x: 8, y: 0 });

    circuit.addElement(in0);
    circuit.addElement(in1);
    circuit.addElement(andGate);
    circuit.addElement(outComp);
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
    circuit.addWire(new Wire({ x: 2, y: 4 }, { x: 4, y: 1 }));
    circuit.addWire(new Wire({ x: 6, y: 0 }, { x: 8, y: 0 }));

    const compiled = compileUnified(circuit, registry).digital!;
    const wt = compiled.layout.wiringTable;

    const engine = new DigitalEngine("level");
    engine.init(compiled);

    // Find AND gate component index (index 2, since elements are in order)
    const andIdx = 2;
    const inBase = compiled.layout.inputOffset(andIdx);
    const inputNet0 = wt[inBase]!;
    const inputNet1 = wt[inBase + 1]!;

    // Set both inputs to 1 via their net IDs
    setNet(engine, inputNet0, 1);
    setNet(engine, inputNet1, 1);
    engine.step();

    const outBase = compiled.layout.outputOffset(andIdx);
    const outputNet = wt[outBase]!;
    expect(getNet(engine, outputNet)).toBe(1);
  });

  it("output_writes_go_to_correct_nets", () => {
    // AND gate whose output net is non-contiguous with its inputs.
    const registry = new ComponentRegistry();
    registry.register(makeDef("In", [
      { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ], noopExecFn));
    registry.register(makeDef("And", twoInputOneOutput(), executeAnd));

    const circuit = new Circuit();
    const in0 = createTestElementFromDecls("In", "in0", [
      { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ]);
    const in1 = createTestElementFromDecls("In", "in1", [
      { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ], undefined, { x: 0, y: 4 });
    const andGate = createTestElementFromDecls("And", "and0", twoInputOneOutput(), undefined, { x: 4, y: 0 });

    circuit.addElement(in0);
    circuit.addElement(in1);
    circuit.addElement(andGate);
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
    circuit.addWire(new Wire({ x: 2, y: 4 }, { x: 4, y: 1 }));

    const compiled = compileUnified(circuit, registry).digital!;
    const wt = compiled.layout.wiringTable;
    const engine = new DigitalEngine("level");
    engine.init(compiled);

    // Set AND inputs high
    const andIdx = 2;
    const inBase = compiled.layout.inputOffset(andIdx);
    setNet(engine, wt[inBase]!, 1);
    setNet(engine, wt[inBase + 1]!, 1);
    engine.step();

    const outBase = compiled.layout.outputOffset(andIdx);
    expect(getNet(engine, wt[outBase]!)).toBe(1);
  });

  it("state_access_bypasses_wiring_table", () => {
    // Compile a circuit with a D flip-flop. Verify state slots are direct.
    const registry = new ComponentRegistry();
    registry.register(makeDef("In", [
      { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ], noopExecFn));
    registry.register(makeDef("DFF", dffPins(), executeDFF, { stateSlotCount: 2 }));

    const circuit = new Circuit();
    const dIn = createTestElementFromDecls("In", "din", [
      { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ]);
    const clkIn = createTestElementFromDecls("In", "clk", [
      { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ], undefined, { x: 0, y: 1 });
    const dff = createTestElementFromDecls("DFF", "dff0", dffPins(), undefined, { x: 4, y: 0 });

    circuit.addElement(dIn);
    circuit.addElement(clkIn);
    circuit.addElement(dff);
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
    circuit.addWire(new Wire({ x: 2, y: 1 }, { x: 4, y: 1 }));

    const compiled = compileUnified(circuit, registry).digital!;
    const engine = new DigitalEngine("level");
    engine.init(compiled);

    const dffIdx = 2;
    const stBase = compiled.layout.stateOffset(dffIdx);
    expect(stBase).toBeGreaterThanOrEqual(compiled.netCount);

    const wt = compiled.layout.wiringTable;
    const inBase = compiled.layout.inputOffset(dffIdx);
    const dNet = wt[inBase]!;
    const clkNet = wt[inBase + 1]!;

    // Set D=1, clk=0
    setNet(engine, dNet, 1);
    setNet(engine, clkNet, 0);
    engine.step();

    // Rising edge: set clk=1
    setNet(engine, clkNet, 1);
    engine.step();

    // State slot should hold latched value (D=1)
    const values = (engine as unknown as { _values: Uint32Array })._values;
    expect(values[stBase]).toBe(1);
  });

  it("compiled_circuit_from_real_circuit_has_correct_wiring", () => {
    // Half adder: In0->XOR->Sum, In0->AND->Carry, In1->XOR, In1->AND
    const registry = new ComponentRegistry();
    registry.register(makeDef("In", [
      { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ], noopExecFn));
    registry.register(makeDef("Xor", twoInputOneOutput(), executeXor));
    registry.register(makeDef("And", twoInputOneOutput(), executeAnd));
    registry.register(makeDef("Out", [
      { direction: PinDirection.INPUT, label: "in", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ], noopExecFn));

    const circuit = new Circuit();
    // Place components with enough spacing to avoid pin collisions
    const in0 = createTestElementFromDecls("In", "a", [
      { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ]);
    const in1 = createTestElementFromDecls("In", "b", [
      { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ], undefined, { x: 0, y: 4 });
    const xorGate = createTestElementFromDecls("Xor", "xor0", twoInputOneOutput(), undefined, { x: 6, y: 0 });
    const andGate = createTestElementFromDecls("And", "and0", twoInputOneOutput(), undefined, { x: 6, y: 4 });
    const sumOut = createTestElementFromDecls("Out", "sum", [
      { direction: PinDirection.INPUT, label: "in", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ], undefined, { x: 10, y: 0 });
    const carryOut = createTestElementFromDecls("Out", "carry", [
      { direction: PinDirection.INPUT, label: "in", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ], undefined, { x: 10, y: 4 });

    circuit.addElement(in0);
    circuit.addElement(in1);
    circuit.addElement(xorGate);
    circuit.addElement(andGate);
    circuit.addElement(sumOut);
    circuit.addElement(carryOut);

    // Wire: In0.out(2,0) -> XOR.a(6,0)
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 6, y: 0 }));
    // Wire: In1.out(2,4) -> XOR.b(6,1)
    circuit.addWire(new Wire({ x: 2, y: 4 }, { x: 6, y: 1 }));
    // Wire: In0.out(2,0) -> AND.a(6,4)
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 6, y: 4 }));
    // Wire: In1.out(2,4) -> AND.b(6,5)
    circuit.addWire(new Wire({ x: 2, y: 4 }, { x: 6, y: 5 }));
    // Wire: XOR.out(8,0) -> Sum.in(10,0)
    circuit.addWire(new Wire({ x: 8, y: 0 }, { x: 10, y: 0 }));
    // Wire: AND.out(8,4) -> Carry.in(10,4)
    circuit.addWire(new Wire({ x: 8, y: 4 }, { x: 10, y: 4 }));

    const compiled = compileUnified(circuit, registry).digital!;
    const wt = compiled.layout.wiringTable;
    const engine = new DigitalEngine("level");
    engine.init(compiled);

    // Test all 4 input combinations
    const in0Idx = 0;
    const in1Idx = 1;
    const in0Net = wt[compiled.layout.outputOffset(in0Idx)]!;
    const in1Net = wt[compiled.layout.outputOffset(in1Idx)]!;

    const xorIdx = 2;
    const andIdx = 3;
    const sumNet = wt[compiled.layout.outputOffset(xorIdx)]!;
    const carryNet = wt[compiled.layout.outputOffset(andIdx)]!;

    const testCases = [
      { a: 0, b: 0, sum: 0, carry: 0 },
      { a: 0, b: 1, sum: 1, carry: 0 },
      { a: 1, b: 0, sum: 1, carry: 0 },
      { a: 1, b: 1, sum: 0, carry: 1 },
    ];

    for (const tc of testCases) {
      setNet(engine, in0Net, tc.a);
      setNet(engine, in1Net, tc.b);
      engine.step();
      expect(getNet(engine, sumNet)).toBe(tc.sum);
      expect(getNet(engine, carryNet)).toBe(tc.carry);
    }
  });

  it("gate_component_reads_through_wiring_table", () => {
    // OR gate with non-contiguous input nets
    const registry = new ComponentRegistry();
    registry.register(makeDef("In", [
      { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ], noopExecFn));
    registry.register(makeDef("Or", twoInputOneOutput(), executeOr));

    const circuit = new Circuit();
    const in0 = createTestElementFromDecls("In", "in0", [
      { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ]);
    const in1 = createTestElementFromDecls("In", "in1", [
      { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ], undefined, { x: 0, y: 4 });
    const orGate = createTestElementFromDecls("Or", "or0", twoInputOneOutput(), undefined, { x: 4, y: 0 });

    circuit.addElement(in0);
    circuit.addElement(in1);
    circuit.addElement(orGate);
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
    circuit.addWire(new Wire({ x: 2, y: 4 }, { x: 4, y: 1 }));

    const compiled = compileUnified(circuit, registry).digital!;
    const wt = compiled.layout.wiringTable;
    const engine = new DigitalEngine("level");
    engine.init(compiled);

    const orIdx = 2;
    const inBase = compiled.layout.inputOffset(orIdx);
    setNet(engine, wt[inBase]!, 1);
    setNet(engine, wt[inBase + 1]!, 1);
    engine.step();

    const outBase = compiled.layout.outputOffset(orIdx);
    expect(getNet(engine, wt[outBase]!)).toBe(1);
  });

  it("flipflop_io_uses_wiring_table_state_is_direct", () => {
    // D flip-flop: verify input/output access uses wiringTable, state is direct
    const registry = new ComponentRegistry();
    registry.register(makeDef("In", [
      { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ], noopExecFn));
    registry.register(makeDef("DFF", dffPins(), executeDFF, { stateSlotCount: 2 }));

    const circuit = new Circuit();
    const dIn = createTestElementFromDecls("In", "din", [
      { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ]);
    const clkIn = createTestElementFromDecls("In", "clk", [
      { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    ], undefined, { x: 0, y: 1 });
    const dff = createTestElementFromDecls("DFF", "dff0", dffPins(), undefined, { x: 4, y: 0 });

    circuit.addElement(dIn);
    circuit.addElement(clkIn);
    circuit.addElement(dff);
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
    circuit.addWire(new Wire({ x: 2, y: 1 }, { x: 4, y: 1 }));

    const compiled = compileUnified(circuit, registry).digital!;
    const wt = compiled.layout.wiringTable;
    const engine = new DigitalEngine("level");
    engine.init(compiled);

    const dffIdx = 2;
    const inBase = compiled.layout.inputOffset(dffIdx);
    const outBase = compiled.layout.outputOffset(dffIdx);
    const stBase = compiled.layout.stateOffset(dffIdx);

    // Verify wiring table resolves inputs/outputs to net IDs
    expect(wt[inBase]).toBeDefined();
    expect(wt[outBase]).toBeDefined();

    // Verify state offset is beyond net IDs (direct access)
    expect(stBase).toBeGreaterThanOrEqual(compiled.netCount);

    // Clock edge test: D=1, clk 0->1
    setNet(engine, wt[inBase]!, 1);
    setNet(engine, wt[inBase + 1]!, 0);
    engine.step();
    setNet(engine, wt[inBase + 1]!, 1);
    engine.step();

    // Q should be 1 (latched D)
    expect(getNet(engine, wt[outBase]!)).toBe(1);
  });

  it("wiringTable_is_Int32Array_on_compiled_layout", () => {
    const registry = new ComponentRegistry();
    registry.register(makeDef("And", twoInputOneOutput(), executeAnd));

    const circuit = new Circuit();
    circuit.addElement(createTestElementFromDecls("And", "and0", twoInputOneOutput()));

    const compiled = compileUnified(circuit, registry).digital!;

    expect(compiled.layout.wiringTable).toBeInstanceOf(Int32Array);
    expect(compiled.wiringTable).toBeInstanceOf(Int32Array);
    expect(compiled.layout.wiringTable).toBe(compiled.wiringTable);
  });
});
