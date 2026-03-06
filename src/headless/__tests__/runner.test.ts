/**
 * Tests for SimulationRunner — task 3.5.1.
 *
 * Each test builds a circuit with mock elements that have the correct pin
 * local positions (relative to element), then compiles and exercises the runner API.
 *
 * Half-adder circuit:
 *   Net layout (assigned by compiler based on pin local positions + element position):
 *     netA: output of In "A"
 *     netB: output of In "B"
 *     netS: output of XOR, input of Out "S"
 *     netC: output of AND, input of Out "C"
 *
 * Execute functions use layout.inputOffset(index) + i as net IDs, which
 * requires contiguous input net IDs. The test helper ensures this by
 * placing components so the compiler assigns contiguous nets to each gate.
 */

import { describe, it, expect } from "vitest";
import { SimulationRunner } from "../runner.js";
import { ComponentRegistry } from "@/core/registry";
import { PropertyBag, PropertyType } from "@/core/properties";
import { AbstractCircuitElement } from "@/core/element";
import type { Pin, Rotation } from "@/core/pin";
import { PinDirection } from "@/core/pin";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import type { ComponentLayout } from "@/core/registry";
import { Circuit } from "@/core/circuit";
import { OscillationError } from "@/core/errors";
import { FacadeError } from "../types.js";

// ---------------------------------------------------------------------------
// MockElement — simple CircuitElement stub for tests
// ---------------------------------------------------------------------------

class MockElement extends AbstractCircuitElement {
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
  getBoundingBox(): Rect { return { x: this.position.x, y: this.position.y, width: 4, height: 4 }; }
  getHelpText(): string { return ""; }
}

function makePin(label: string, direction: PinDirection, localX: number, localY: number, bitWidth = 1): Pin {
  return {
    label,
    direction,
    position: { x: localX, y: localY },
    bitWidth,
    isNegated: false,
    isClock: false,
  };
}

function makePropBag(entries: Record<string, string | number | boolean> = {}): PropertyBag {
  const bag = new PropertyBag();
  for (const [k, v] of Object.entries(entries)) {
    bag.set(k, v);
  }
  return bag;
}

// ---------------------------------------------------------------------------
// executePassThrough — for In components (output is set externally)
// ---------------------------------------------------------------------------

function executePassThrough(_index: number, _state: Uint32Array, _layout: ComponentLayout): void {
  // In components: value is set externally via setSignalValue
}

// ---------------------------------------------------------------------------
// executeNoop — for Out components (just reads, no writes)
// ---------------------------------------------------------------------------

function executeNoop(_index: number, _state: Uint32Array, _layout: ComponentLayout): void {}

// ---------------------------------------------------------------------------
// executeXor2 — two-input XOR using inputOffset + contiguous net IDs
// ---------------------------------------------------------------------------

function executeXor2(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const a = state[layout.inputOffset(index)] ?? 0;
  const b = state[layout.inputOffset(index) + 1] ?? 0;
  state[layout.outputOffset(index)] = (a ^ b) >>> 0;
}

// ---------------------------------------------------------------------------
// executeAnd2 — two-input AND using inputOffset + contiguous net IDs
// ---------------------------------------------------------------------------

function executeAnd2(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const a = state[layout.inputOffset(index)] ?? 0;
  const b = state[layout.inputOffset(index) + 1] ?? 0;
  state[layout.outputOffset(index)] = (a & b) >>> 0;
}

// ---------------------------------------------------------------------------
// buildHalfAdder — creates a Circuit with a half-adder topology
//
// Component layout (positions chosen so nets are contiguous):
//   Pin positions are LOCAL (relative to element position).
//
//   In "A"   at (0,0)  → output pin at local (2,0)   → world (2,0)
//   In "B"   at (0,2)  → output pin at local (2,0)   → world (2,2)
//   XOR      at (4,0)  → input pins at local (0,0) and (0,2), output at local (4,1) → world (4,0),(4,2),(8,1)
//   AND      at (4,4)  → input pins at local (0,-4) and (0,-2), output at local (4,1) → world (4,0),(4,2),(8,5)
//   Out "S"  at (9,1)  → input pin at local (0,0)    → world (9,1)
//   Out "C"  at (9,5)  → input pin at local (0,0)    → world (9,5)
//
// Wires:
//   (2,0)→(4,0): connects In A output to XOR input 0
//   (2,0)→(4,0): connects In A output to AND input 0  (same net — compiler merges)
//   (2,2)→(4,2): connects In B output to XOR input 1
//   (2,2)→(4,2): connects In B output to AND input 1  (same net)
//   (8,1)→(9,1): connects XOR output to Out S input
//   (8,5)→(9,5): connects AND output to Out C input
// ---------------------------------------------------------------------------

function buildHalfAdder(registry: ComponentRegistry): Circuit {
  const circuit = new Circuit();

  // In A: output at local (2,0)
  const inA = new MockElement("In", "inA", { x: 0, y: 0 }, [
    makePin("out", PinDirection.OUTPUT, 2, 0),
  ], makePropBag({ label: "A" }));

  // In B: output at local (2,0)
  const inB = new MockElement("In", "inB", { x: 0, y: 2 }, [
    makePin("out", PinDirection.OUTPUT, 2, 0),
  ], makePropBag({ label: "B" }));

  // XOR: inputs at local (0,0) and (0,2), output at local (4,1)
  const xor = new MockElement("XOR", "xor", { x: 4, y: 0 }, [
    makePin("in0", PinDirection.INPUT, 0, 0),
    makePin("in1", PinDirection.INPUT, 0, 2),
    makePin("out", PinDirection.OUTPUT, 4, 1),
  ], makePropBag());

  // AND: inputs at local (0,-4) and (0,-2), output at local (4,1)
  // Note: AND inputs share world positions with XOR inputs → same nets (net A and net B)
  const and = new MockElement("AND", "and", { x: 4, y: 4 }, [
    makePin("in0", PinDirection.INPUT, 0, -4),
    makePin("in1", PinDirection.INPUT, 0, -2),
    makePin("out", PinDirection.OUTPUT, 4, 1),
  ], makePropBag());

  // Out S: input at local (0,0)
  const outS = new MockElement("Out", "outS", { x: 9, y: 1 }, [
    makePin("in", PinDirection.INPUT, 0, 0),
  ], makePropBag({ label: "S" }));

  // Out C: input at local (0,0)
  const outC = new MockElement("Out", "outC", { x: 9, y: 5 }, [
    makePin("in", PinDirection.INPUT, 0, 0),
  ], makePropBag({ label: "C" }));

  circuit.elements.push(inA, inB, xor, and, outS, outC);

  // Wires connecting components via world positions
  // In A output (2,0) → XOR input 0 (4,0)
  circuit.wires.push({ start: { x: 2, y: 0 }, end: { x: 4, y: 0 } } as any);
  // In A output (2,0) → AND input 0 (4,0)  [merges with above via position overlap]
  // (covered by pin position overlap — both XOR in0 and AND in0 are at (4,0))
  // In B output (2,2) → XOR input 1 (4,2)
  circuit.wires.push({ start: { x: 2, y: 2 }, end: { x: 4, y: 2 } } as any);
  // XOR output (8,1) → Out S input (9,1)
  circuit.wires.push({ start: { x: 8, y: 1 }, end: { x: 9, y: 1 } } as any);
  // AND output (8,5) → Out C input (9,5)
  circuit.wires.push({ start: { x: 8, y: 5 }, end: { x: 9, y: 5 } } as any);

  void registry;
  return circuit;
}

// ---------------------------------------------------------------------------
// buildRegistry — register mock components
// ---------------------------------------------------------------------------

function buildRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();

  registry.register({
    name: "In",
    typeId: -1,
    factory: (props) => new MockElement("In", crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin("out", PinDirection.OUTPUT, 2, 0),
    ], props),
    executeFn: executePassThrough,
    pinLayout: [],
    propertyDefs: [{ key: "label", label: "Label", type: PropertyType.STRING, defaultValue: "", description: "Label" }],
    attributeMap: [],
    category: "IO" as any,
    helpText: "In",
  });

  registry.register({
    name: "Out",
    typeId: -1,
    factory: (props) => new MockElement("Out", crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin("in", PinDirection.INPUT, 0, 0),
    ], props),
    executeFn: executeNoop,
    pinLayout: [],
    propertyDefs: [{ key: "label", label: "Label", type: PropertyType.STRING, defaultValue: "", description: "Label" }],
    attributeMap: [],
    category: "IO" as any,
    helpText: "Out",
  });

  registry.register({
    name: "XOR",
    typeId: -1,
    factory: (props) => new MockElement("XOR", crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin("in0", PinDirection.INPUT, -2, -1),
      makePin("in1", PinDirection.INPUT, -2, 1),
      makePin("out", PinDirection.OUTPUT, 2, 0),
    ], props),
    executeFn: executeXor2,
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: "LOGIC" as any,
    helpText: "XOR",
  });

  registry.register({
    name: "AND",
    typeId: -1,
    factory: (props) => new MockElement("AND", crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin("in0", PinDirection.INPUT, -2, -1),
      makePin("in1", PinDirection.INPUT, -2, 1),
      makePin("out", PinDirection.OUTPUT, 2, 0),
    ], props),
    executeFn: executeAnd2,
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: "LOGIC" as any,
    helpText: "AND",
  });

  return registry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Runner", () => {
  // -------------------------------------------------------------------------
  // compileAndStep
  // -------------------------------------------------------------------------

  it("compileAndStep — build half-adder, compile, setInput A=1 B=1, step, readOutput S=0, C=1", () => {
    const registry = buildRegistry();
    const runner = new SimulationRunner(registry);
    const circuit = buildHalfAdder(registry);

    const engine = runner.compile(circuit);

    runner.setInput(engine, "A", 1);
    runner.setInput(engine, "B", 1);
    runner.step(engine);

    expect(runner.readOutput(engine, "S")).toBe(0); // 1 XOR 1 = 0
    expect(runner.readOutput(engine, "C")).toBe(1); // 1 AND 1 = 1
  });

  // -------------------------------------------------------------------------
  // allFourInputCombinations
  // -------------------------------------------------------------------------

  it("allFourInputCombinations — half-adder: test all 4 input combos, verify correct S and C", () => {
    const registry = buildRegistry();
    const runner = new SimulationRunner(registry);

    const cases: [number, number, number, number][] = [
      [0, 0, 0, 0],
      [0, 1, 1, 0],
      [1, 0, 1, 0],
      [1, 1, 0, 1],
    ];

    for (const [a, b, expectedS, expectedC] of cases) {
      const circuit = buildHalfAdder(registry);
      const engine = runner.compile(circuit);
      runner.setInput(engine, "A", a);
      runner.setInput(engine, "B", b);
      runner.step(engine);
      expect(runner.readOutput(engine, "S")).toBe(expectedS);
      expect(runner.readOutput(engine, "C")).toBe(expectedC);
    }
  });

  // -------------------------------------------------------------------------
  // runToStableOnCombinational
  // -------------------------------------------------------------------------

  it("runToStableOnCombinational — combinational circuit stabilizes in 1 step", () => {
    // Simple pass-through circuit: In "X" → Out "Y"
    const registry = new ComponentRegistry();

    registry.register({
      name: "In",
      typeId: -1,
      factory: (props) => new MockElement("In", crypto.randomUUID(), { x: 0, y: 0 }, [
        makePin("out", PinDirection.OUTPUT, 2, 0),
      ], props),
      executeFn: executePassThrough,
      pinLayout: [],
      propertyDefs: [{ key: "label", label: "Label", type: PropertyType.STRING, defaultValue: "", description: "Label" }],
      attributeMap: [],
      category: "IO" as any,
      helpText: "In",
    });

    registry.register({
      name: "Out",
      typeId: -1,
      factory: (props) => new MockElement("Out", crypto.randomUUID(), { x: 0, y: 0 }, [
        makePin("in", PinDirection.INPUT, 4, 0),
      ], props),
      executeFn: executeNoop,
      pinLayout: [],
      propertyDefs: [{ key: "label", label: "Label", type: PropertyType.STRING, defaultValue: "", description: "Label" }],
      attributeMap: [],
      category: "IO" as any,
      helpText: "Out",
    });

    const circuit = new Circuit();
    const inX = new MockElement("In", "inX", { x: 0, y: 0 }, [
      makePin("out", PinDirection.OUTPUT, 2, 0),
    ], makePropBag({ label: "X" }));
    const outY = new MockElement("Out", "outY", { x: 3, y: 0 }, [
      makePin("in", PinDirection.INPUT, 1, 0),
    ], makePropBag({ label: "Y" }));
    circuit.elements.push(inX, outY);
    circuit.wires.push({ start: { x: 2, y: 0 }, end: { x: 4, y: 0 } } as any);

    const runner = new SimulationRunner(registry);
    const engine = runner.compile(circuit);
    runner.setInput(engine, "X", 0);

    // Should not throw — combinational circuit stabilizes quickly
    expect(() => runner.runToStable(engine, 100)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // runToStableThrowsOnOscillation
  // -------------------------------------------------------------------------

  it("runToStableThrowsOnOscillation — oscillating circuit throws OscillationError", () => {
    // Build a circuit with a component whose execute function toggles its output
    // every step — guaranteed to never stabilize.
    const registry = new ComponentRegistry();

    let toggle = 0;
    registry.register({
      name: "Osc",
      typeId: -1,
      factory: (props) => new MockElement("Osc", crypto.randomUUID(), { x: 0, y: 0 }, [
        makePin("out", PinDirection.OUTPUT, 2, 0),
      ], props),
      executeFn: (_index: number, state: Uint32Array, layout: ComponentLayout) => {
        toggle = toggle === 0 ? 1 : 0;
        state[layout.outputOffset(_index)] = toggle;
      },
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: "LOGIC" as any,
      helpText: "Osc",
    });

    const circuit = new Circuit();
    circuit.elements.push(
      new MockElement("Osc", "osc", { x: 0, y: 0 }, [
        makePin("out", PinDirection.OUTPUT, 2, 0),
      ], makePropBag()),
    );

    const runner = new SimulationRunner(registry);
    const engine = runner.compile(circuit);

    expect(() => runner.runToStable(engine, 10)).toThrow(OscillationError);
  });

  // -------------------------------------------------------------------------
  // readAllSignals
  // -------------------------------------------------------------------------

  it("readAllSignals — returns Map with all In/Out labels", () => {
    const registry = buildRegistry();
    const runner = new SimulationRunner(registry);
    const circuit = buildHalfAdder(registry);

    const engine = runner.compile(circuit);
    const signals = runner.readAllSignals(engine);

    // Half-adder has labels: A, B, S, C
    expect(signals.has("A")).toBe(true);
    expect(signals.has("B")).toBe(true);
    expect(signals.has("S")).toBe(true);
    expect(signals.has("C")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // setInputByLabel
  // -------------------------------------------------------------------------

  it("setInputByLabel — setInput 'A' to 1, verify net value changed", () => {
    const registry = buildRegistry();
    const runner = new SimulationRunner(registry);
    const circuit = buildHalfAdder(registry);

    const engine = runner.compile(circuit);

    // Before: A should be 0 (UNDEFINED signals read as 0 in raw form)
    runner.setInput(engine, "A", 1);

    // After setting, read via readAllSignals
    const signals = runner.readAllSignals(engine);
    expect(signals.get("A")).toBe(1);
  });

  // -------------------------------------------------------------------------
  // unknownLabelThrows
  // -------------------------------------------------------------------------

  it("unknownLabelThrows — setInput with nonexistent label throws FacadeError", () => {
    const registry = buildRegistry();
    const runner = new SimulationRunner(registry);
    const circuit = buildHalfAdder(registry);

    const engine = runner.compile(circuit);

    expect(() => runner.setInput(engine, "NONEXISTENT", 1)).toThrow(FacadeError);
  });
});
