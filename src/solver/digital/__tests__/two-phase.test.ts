/**
 * Tests for two-phase sequential protocol (Tasks 2.1 and 2.2).
 *
 * Task 2.1: Verifies that the compiler populates sampleFns table from
 * ComponentDefinition.sampleFn.
 *
 * Task 2.2: Verifies that _stepLevel() calls sampleFn before the
 * combinational sweep, enabling correct shift-register and cross-feedback
 * flip-flop behavior.
 */

import { describe, it, expect } from "vitest";
import { compileUnified } from "@/compile/compile.js";
import { DigitalEngine } from "../digital-engine.js";
import { Circuit, Wire } from "@/core/circuit";
import { BitVector } from "@/core/signal";
import { ComponentRegistry } from "@/core/registry";
import type { ComponentDefinition, ExecuteFunction } from "@/core/registry";
import { ComponentCategory } from "@/core/registry";
import { AbstractCircuitElement } from "@/core/element";
import type { Pin, PinDeclaration } from "@/core/pin";
import { PinDirection, resolvePins, createInverterConfig, createClockConfig } from "@/core/pin";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import { PropertyBag } from "@/core/properties";

// ---------------------------------------------------------------------------
// Minimal test CircuitElement implementation
// ---------------------------------------------------------------------------

class TestElement extends AbstractCircuitElement {
  private readonly _pins: readonly Pin[];

  constructor(
    typeId: string,
    instanceId: string,
    position: { x: number; y: number },
    pinDecls: PinDeclaration[],
    props?: PropertyBag,
  ) {
    super(typeId, instanceId, position, 0, false, props ?? new PropertyBag());
    this._pins = resolvePins(
      pinDecls,
      position,
      0,
      createInverterConfig([]),
      createClockConfig([]),
    );
  }

  getPins(): readonly Pin[] { return this._pins; }
  draw(_ctx: RenderContext): void {}
  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 2, height: 2 };
  }
}

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
// Execute/sample functions using wiring table indirection
// ---------------------------------------------------------------------------

const executeAnd: ExecuteFunction = (index, state, _highZs, layout) => {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  state[wt[outBase]!] = (state[wt[inBase]!]! & state[wt[inBase + 1]!]!) >>> 0;
};

/** sampleDFF: latch D on rising clock edge into state slot */
const sampleDFF: ExecuteFunction = (index, state, _highZs, layout) => {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const stBase = layout.stateOffset(index);
  const D = state[wt[inBase]!]! & 1;
  const clk = state[wt[inBase + 1]!]! & 1;
  const prevClk = state[stBase + 1]! & 1;
  if (!prevClk && clk) {
    state[stBase] = D; // latch
  }
  state[stBase + 1] = clk; // update prevClk
};

/** executeDFF: write Q/~Q from state slot (no input reading) */
const executeDFF: ExecuteFunction = (index, state, _highZs, layout) => {
  const wt = layout.wiringTable;
  const outBase = layout.outputOffset(index);
  const stBase = layout.stateOffset(index);
  state[wt[outBase]!] = state[stBase]!;
  state[wt[outBase + 1]!] = (~state[stBase]!) >>> 0;
};

// ---------------------------------------------------------------------------
// Definition builders
// ---------------------------------------------------------------------------

function makeDef(
  name: string,
  pins: PinDeclaration[],
  executeFn: ExecuteFunction,
  opts?: { sampleFn?: ExecuteFunction; stateSlotCount?: number },
): ComponentDefinition {
  return {
    name,
    typeId: -1,
    factory: (props) => new TestElement(name, crypto.randomUUID(), { x: 0, y: 0 }, pins, props),
    pinLayout: pins,
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: "",
    models: {
      digital: {
        executeFn,
        ...(opts?.sampleFn !== undefined ? { sampleFn: opts.sampleFn } : {}),
        ...(opts?.stateSlotCount !== undefined ? { stateSlotCount: opts.stateSlotCount } : {}),
      },
    },
  };
}

function makeRegistry(...defs: ComponentDefinition[]): ComponentRegistry {
  const registry = new ComponentRegistry();
  for (const def of defs) {
    registry.register(def);
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Task 2.1 Tests: sampleFn on ComponentDefinition
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pin declarations for single-input/output (In/Out stubs)
// ---------------------------------------------------------------------------

function oneInputOneOutput(): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "in", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
}

// ---------------------------------------------------------------------------
// Stub execute functions for In/Out components
// ---------------------------------------------------------------------------

const executeIn: ExecuteFunction = (index, state, _highZs, layout) => {
  const wt = layout.wiringTable;
  const outBase = layout.outputOffset(index);
  state[wt[outBase]!] = state[wt[outBase]!]!;
};

const executeOut: ExecuteFunction = (_index, _state, _highZs, _layout) => {
  // no-op: Out just reads
};

// ---------------------------------------------------------------------------
// Task 2.1 Tests: sampleFn on ComponentDefinition
// ---------------------------------------------------------------------------

describe("SampleFn", () => {
  it("compiler_populates_sampleFns_table", () => {
    const dffDef = makeDef("DFF", dffPins(), executeDFF, { sampleFn: sampleDFF, stateSlotCount: 2 });
    const registry = makeRegistry(dffDef);

    const circuit = new Circuit();
    const dff = registry.get("DFF")!.factory(new PropertyBag());
    dff.position = { x: 0, y: 0 };
    circuit.addElement(dff);

    const compiled = compileUnified(circuit, registry).digital!;
    const typeId = compiled.typeIds[0]!;
    expect(compiled.sampleFns[typeId]).toBe(sampleDFF);
  });

  it("components_without_sampleFn_have_null_entry", () => {
    const andDef = makeDef("And", twoInputOneOutput(), executeAnd);
    const registry = makeRegistry(andDef);

    const circuit = new Circuit();
    const and1 = registry.get("And")!.factory(new PropertyBag());
    and1.position = { x: 0, y: 0 };
    circuit.addElement(and1);

    const compiled = compileUnified(circuit, registry).digital!;
    const typeId = compiled.typeIds[0]!;
    expect(compiled.sampleFns[typeId]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 2.2 Tests: Two-Phase _stepLevel()
// ---------------------------------------------------------------------------

describe("TwoPhaseStep", () => {
  it("shift_register_propagates_correctly", () => {
    const inDef = makeDef("In", oneInputOneOutput(), executeIn);
    const outDef = makeDef("Out", oneInputOneOutput(), executeOut);
    const dffDef = makeDef("DFF", dffPins(), executeDFF, { sampleFn: sampleDFF, stateSlotCount: 2 });
    const registry = makeRegistry(inDef, outDef, dffDef);

    const circuit = new Circuit();

    // In_data at (0,0): input pin at (0,0), output pin at (2,0)
    const inData = registry.get("In")!.factory(new PropertyBag());
    inData.position = { x: 0, y: 0 };
    circuit.addElement(inData);

    // In_clk at (0, 10): output pin at (2, 10)
    const inClk = registry.get("In")!.factory(new PropertyBag());
    inClk.position = { x: 0, y: 10 };
    circuit.addElement(inClk);

    // DFF_A at (10, 0): D at (10,0), C at (10,1), Q at (12,0), ~Q at (12,1)
    const dffA = registry.get("DFF")!.factory(new PropertyBag());
    dffA.position = { x: 10, y: 0 };
    circuit.addElement(dffA);

    // DFF_B at (20, 0): D at (20,0), C at (20,1), Q at (22,0), ~Q at (22,1)
    const dffB = registry.get("DFF")!.factory(new PropertyBag());
    dffB.position = { x: 20, y: 0 };
    circuit.addElement(dffB);

    // Out at (30, 0): input pin at (30,0), output pin at (32,0)
    const out = registry.get("Out")!.factory(new PropertyBag());
    out.position = { x: 30, y: 0 };
    circuit.addElement(out);

    // Wire In_data.out → DFF_A.D
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 10, y: 0 }));
    // Wire In_clk.out → DFF_A.C
    circuit.addWire(new Wire({ x: 2, y: 10 }, { x: 10, y: 1 }));
    // Wire DFF_A.C → DFF_B.C (shared clock net)
    circuit.addWire(new Wire({ x: 10, y: 1 }, { x: 20, y: 1 }));
    // Wire DFF_A.Q → DFF_B.D
    circuit.addWire(new Wire({ x: 12, y: 0 }, { x: 20, y: 0 }));
    // Wire DFF_B.Q → Out.in
    circuit.addWire(new Wire({ x: 22, y: 0 }, { x: 30, y: 0 }));

    const compiled = compileUnified(circuit, registry).digital!;
    const engine = new DigitalEngine();
    engine.init(compiled);

    // Find net IDs for data input, clock input, DFF_A.Q, DFF_B.Q
    const dataNetId = compiled.pinNetMap.get(`${inData.instanceId}:out`)!;
    const clkNetId = compiled.pinNetMap.get(`${inClk.instanceId}:out`)!;
    const qaNetId = compiled.pinNetMap.get(`${dffA.instanceId}:Q`)!;
    const qbNetId = compiled.pinNetMap.get(`${dffB.instanceId}:Q`)!;

    // Set In=1, clock low. Step (nothing latched).
    engine.setSignalValue(dataNetId, BitVector.fromNumber(1, 1));
    engine.setSignalValue(clkNetId, BitVector.fromNumber(0, 1));
    engine.step();
    expect(engine.getSignalRaw(qaNetId)).toBe(0);
    expect(engine.getSignalRaw(qbNetId)).toBe(0);

    // Toggle clock high, step.
    engine.setSignalValue(clkNetId, BitVector.fromNumber(1, 1));
    engine.step();
    // DFF_A should have latched D=1 → Q=1
    // DFF_B sampled DFF_A's OLD output (0) → Q=0
    expect(engine.getSignalRaw(qaNetId)).toBe(1);
    expect(engine.getSignalRaw(qbNetId)).toBe(0);

    // Toggle clock low, then high, step.
    engine.setSignalValue(clkNetId, BitVector.fromNumber(0, 1));
    engine.step();
    engine.setSignalValue(clkNetId, BitVector.fromNumber(1, 1));
    engine.step();
    // DFF_B now has DFF_A's value from previous cycle → Q=1
    expect(engine.getSignalRaw(qbNetId)).toBe(1);
  });

  it("concurrent_flip_flops_sample_simultaneously", () => {
    const dffDef = makeDef("DFF", dffPins(), executeDFF, { sampleFn: sampleDFF, stateSlotCount: 2 });
    const registry = makeRegistry(dffDef);

    const circuit = new Circuit();

    // DFF_A at (0, 0): D at (0,0), C at (0,1), Q at (2,0), ~Q at (2,1)
    const dffA = registry.get("DFF")!.factory(new PropertyBag());
    dffA.position = { x: 0, y: 0 };
    circuit.addElement(dffA);

    // DFF_B at (10, 0): D at (10,0), C at (10,1), Q at (12,0), ~Q at (12,1)
    const dffB = registry.get("DFF")!.factory(new PropertyBag());
    dffB.position = { x: 10, y: 0 };
    circuit.addElement(dffB);

    // Cross-feedback: A.Q → B.D, B.Q → A.D
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 10, y: 0 }));
    circuit.addWire(new Wire({ x: 12, y: 0 }, { x: 0, y: 0 }));
    // Shared clock
    circuit.addWire(new Wire({ x: 0, y: 1 }, { x: 10, y: 1 }));

    const compiled = compileUnified(circuit, registry).digital!;
    const engine = new DigitalEngine();
    engine.init(compiled);

    const clkNetId = compiled.pinNetMap.get(`${dffA.instanceId}:C`)!;
    const qaNetId = compiled.pinNetMap.get(`${dffA.instanceId}:Q`)!;
    const qbNetId = compiled.pinNetMap.get(`${dffB.instanceId}:Q`)!;

    // Find state offsets to initialize A.Q=1, B.Q=0
    // DFF_A is element 0, DFF_B is element 1
    const stBaseA = compiled.layout.stateOffset(0);
    const stBaseB = compiled.layout.stateOffset(1);

    // Initialize: A stored Q = 1, B stored Q = 0
    // We need to write directly to the engine's signal array via setSignalValue
    // for the output nets, and also set the state slots.
    // State slots: stBase+0 = storedQ, stBase+1 = prevClk
    // We write the state array directly by using getSignalRaw/setSignalValue
    // on the state offset... but setSignalValue works on net IDs.
    // Instead, step once with clock low to propagate initial state.
    // Then manually set state slots via a trick: use the raw signal approach.

    // Actually we need raw access. Let's set initial state by:
    // 1. Setting clock low, stepping to clear prevClk
    engine.setSignalValue(clkNetId, BitVector.fromNumber(0, 1));
    engine.step();

    // 2. Now directly write state slots. We can access the compiled circuit's
    //    signalArraySize to know the array dimensions. The engine's internal
    //    _values array is not directly accessible, but we can use a workaround:
    //    set A's Q output net to 1, set state slot for A to 1 manually.
    //    Since state slots are at indices >= netCount, we can use setSignalValue
    //    with the state offset as if it were a net ID.
    engine.setSignalValue(stBaseA, BitVector.fromNumber(1, 1));   // A.storedQ = 1
    engine.setSignalValue(stBaseA + 1, BitVector.fromNumber(0, 1)); // A.prevClk = 0
    engine.setSignalValue(stBaseB, BitVector.fromNumber(0, 1));   // B.storedQ = 0
    engine.setSignalValue(stBaseB + 1, BitVector.fromNumber(0, 1)); // B.prevClk = 0

    // Step with clock low to propagate executeDFF outputs from state slots
    engine.setSignalValue(clkNetId, BitVector.fromNumber(0, 1));
    engine.step();
    expect(engine.getSignalRaw(qaNetId)).toBe(1);
    expect(engine.getSignalRaw(qbNetId)).toBe(0);

    // Rising clock edge + step: both sample simultaneously
    engine.setSignalValue(clkNetId, BitVector.fromNumber(1, 1));
    engine.step();
    // A sampled B's OLD Q=0, B sampled A's OLD Q=1 → they swap
    expect(engine.getSignalRaw(qaNetId)).toBe(0);
    expect(engine.getSignalRaw(qbNetId)).toBe(1);
  });

  it("combinational_only_circuit_unaffected", () => {
    const andDef = makeDef("And", twoInputOneOutput(), executeAnd);
    const inDef = makeDef("In", oneInputOneOutput(), executeIn);
    const outDef = makeDef("Out", oneInputOneOutput(), executeOut);
    const registry = makeRegistry(andDef, inDef, outDef);

    const circuit = new Circuit();

    // In_A at (0, 0): output at (2, 0)
    const inA = registry.get("In")!.factory(new PropertyBag());
    inA.position = { x: 0, y: 0 };
    circuit.addElement(inA);

    // In_B at (0, 5): output at (2, 5)
    const inB = registry.get("In")!.factory(new PropertyBag());
    inB.position = { x: 0, y: 5 };
    circuit.addElement(inB);

    // And at (10, 0): inputs at (10,0) and (10,1), output at (12,0)
    const andGate = registry.get("And")!.factory(new PropertyBag());
    andGate.position = { x: 10, y: 0 };
    circuit.addElement(andGate);

    // Out at (20, 0): input at (20, 0)
    const outEl = registry.get("Out")!.factory(new PropertyBag());
    outEl.position = { x: 20, y: 0 };
    circuit.addElement(outEl);

    // Wire In_A.out → And.a
    circuit.addWire(new Wire({ x: 2, y: 0 }, { x: 10, y: 0 }));
    // Wire In_B.out → And.b
    circuit.addWire(new Wire({ x: 2, y: 5 }, { x: 10, y: 1 }));
    // Wire And.out → Out.in
    circuit.addWire(new Wire({ x: 12, y: 0 }, { x: 20, y: 0 }));

    const compiled = compileUnified(circuit, registry).digital!;
    const engine = new DigitalEngine();
    engine.init(compiled);

    // Verify sequentialComponents is empty
    expect(compiled.sequentialComponents.length).toBe(0);

    const inANetId = compiled.pinNetMap.get(`${inA.instanceId}:out`)!;
    const inBNetId = compiled.pinNetMap.get(`${inB.instanceId}:out`)!;
    const outNetId = compiled.pinNetMap.get(`${outEl.instanceId}:in`)!;

    // Set both inputs high, step
    engine.setSignalValue(inANetId, BitVector.fromNumber(1, 1));
    engine.setSignalValue(inBNetId, BitVector.fromNumber(1, 1));
    engine.step();
    expect(engine.getSignalRaw(outNetId)).toBe(1);

    // Set one input low, step
    engine.setSignalValue(inANetId, BitVector.fromNumber(0, 1));
    engine.step();
    expect(engine.getSignalRaw(outNetId)).toBe(0);
  });
});
