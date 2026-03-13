/**
 * Integration tests for the headless simulation pipeline — task 3.5.3.
 *
 * Tests exercise the full pipeline: build circuit → compile → simulate →
 * verify results. Components use mock element stubs with real execute
 * functions (simple AND/XOR/NOT/NOR logic).
 */

import { describe, it, expect } from "vitest";
import { SimulationRunner } from "../runner.js";
import { captureTrace } from "../trace.js";
import { ComponentRegistry } from "@/core/registry";
import { PropertyBag, PropertyType } from "@/core/properties";
import { AbstractCircuitElement } from "@/core/element";
import type { Pin, Rotation } from "@/core/pin";
import { PinDirection } from "@/core/pin";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import type { ComponentLayout } from "@/core/registry";
import { Circuit } from "@/core/circuit";
import { OscillationError } from "@/core/errors";
import { BitVector } from "@/core/signal";

// ---------------------------------------------------------------------------
// MockElement — shared test stub
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

function makePin(label: string, direction: PinDirection, localX: number, localY: number): Pin {
  return { label, direction, position: { x: localX, y: localY }, bitWidth: 1, isNegated: false, isClock: false };
}

function makePropBag(entries: Record<string, string | number | boolean> = {}): PropertyBag {
  const bag = new PropertyBag();
  for (const [k, v] of Object.entries(entries)) bag.set(k, v);
  return bag;
}

// ---------------------------------------------------------------------------
// Execute functions
// ---------------------------------------------------------------------------

function executePassThrough(_i: number, _s: Uint32Array, _hz: Uint32Array, _l: ComponentLayout): void {}
function executeNoop(_i: number, _s: Uint32Array, _hz: Uint32Array, _l: ComponentLayout): void {}

function executeXor2(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const a = state[layout.wiringTable[layout.inputOffset(index)]] ?? 0;
  const b = state[layout.wiringTable[layout.inputOffset(index) + 1]] ?? 0;
  state[layout.wiringTable[layout.outputOffset(index)]] = (a ^ b) >>> 0;
}

function executeAnd2(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const a = state[layout.wiringTable[layout.inputOffset(index)]] ?? 0;
  const b = state[layout.wiringTable[layout.inputOffset(index) + 1]] ?? 0;
  state[layout.wiringTable[layout.outputOffset(index)]] = (a & b) >>> 0;
}

function executeNot(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const a = state[layout.wiringTable[layout.inputOffset(index)]] ?? 0;
  state[layout.wiringTable[layout.outputOffset(index)]] = a === 0 ? 1 : 0;
}

function executeNor2(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const a = state[layout.wiringTable[layout.inputOffset(index)]] ?? 0;
  const b = state[layout.wiringTable[layout.inputOffset(index) + 1]] ?? 0;
  state[layout.wiringTable[layout.outputOffset(index)]] = (a | b) === 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Registry factory
// ---------------------------------------------------------------------------

function buildRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();

  registry.register({
    name: "In", typeId: -1,
    factory: (props) => new MockElement("In", crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin("out", PinDirection.OUTPUT, 2, 0),
    ], props),
    executeFn: executePassThrough,
    pinLayout: [],
    propertyDefs: [{ key: "label", label: "Label", type: PropertyType.STRING, defaultValue: "", description: "" }],
    attributeMap: [], category: "IO" as any, helpText: "In",
  });

  registry.register({
    name: "Out", typeId: -1,
    factory: (props) => new MockElement("Out", crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin("in", PinDirection.INPUT, 0, 0),
    ], props),
    executeFn: executeNoop,
    pinLayout: [],
    propertyDefs: [{ key: "label", label: "Label", type: PropertyType.STRING, defaultValue: "", description: "" }],
    attributeMap: [], category: "IO" as any, helpText: "Out",
  });

  registry.register({
    name: "XOR", typeId: -1,
    factory: (props) => new MockElement("XOR", crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin("in0", PinDirection.INPUT, -2, -1),
      makePin("in1", PinDirection.INPUT, -2, 1),
      makePin("out", PinDirection.OUTPUT, 2, 0),
    ], props),
    executeFn: executeXor2, pinLayout: [], propertyDefs: [], attributeMap: [], category: "LOGIC" as any, helpText: "XOR",
  });

  registry.register({
    name: "AND", typeId: -1,
    factory: (props) => new MockElement("AND", crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin("in0", PinDirection.INPUT, -2, -1),
      makePin("in1", PinDirection.INPUT, -2, 1),
      makePin("out", PinDirection.OUTPUT, 2, 0),
    ], props),
    executeFn: executeAnd2, pinLayout: [], propertyDefs: [], attributeMap: [], category: "LOGIC" as any, helpText: "AND",
  });

  registry.register({
    name: "NOT", typeId: -1,
    factory: (props) => new MockElement("NOT", crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin("in", PinDirection.INPUT, -2, 0),
      makePin("out", PinDirection.OUTPUT, 2, 0),
    ], props),
    executeFn: executeNot, pinLayout: [], propertyDefs: [], attributeMap: [], category: "LOGIC" as any, helpText: "NOT",
  });

  registry.register({
    name: "NOR", typeId: -1,
    factory: (props) => new MockElement("NOR", crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin("in0", PinDirection.INPUT, -2, -1),
      makePin("in1", PinDirection.INPUT, -2, 1),
      makePin("out", PinDirection.OUTPUT, 2, 0),
    ], props),
    executeFn: executeNor2, pinLayout: [], propertyDefs: [], attributeMap: [], category: "LOGIC" as any, helpText: "NOR",
  });

  return registry;
}

// ---------------------------------------------------------------------------
// Half-adder circuit builder
// ---------------------------------------------------------------------------

function buildHalfAdder(): Circuit {
  const circuit = new Circuit();

  const inA = new MockElement("In", "inA", { x: 0, y: 0 }, [
    makePin("out", PinDirection.OUTPUT, 2, 0),
  ], makePropBag({ label: "A" }));

  const inB = new MockElement("In", "inB", { x: 0, y: 2 }, [
    makePin("out", PinDirection.OUTPUT, 2, 0),
  ], makePropBag({ label: "B" }));

  // XOR: inputs at (4,0) and (4,2), output at (8,1)
  const xor = new MockElement("XOR", "xor", { x: 4, y: 0 }, [
    makePin("in0", PinDirection.INPUT, 0, 0),
    makePin("in1", PinDirection.INPUT, 0, 2),
    makePin("out", PinDirection.OUTPUT, 4, 1),
  ], makePropBag());

  // AND: shares input pin positions with XOR (same net A and net B)
  const and = new MockElement("AND", "and", { x: 4, y: 4 }, [
    makePin("in0", PinDirection.INPUT, 0, -4),
    makePin("in1", PinDirection.INPUT, 0, -2),
    makePin("out", PinDirection.OUTPUT, 4, 1),
  ], makePropBag());

  const outS = new MockElement("Out", "outS", { x: 9, y: 1 }, [
    makePin("in", PinDirection.INPUT, 0, 0),
  ], makePropBag({ label: "S" }));

  const outC = new MockElement("Out", "outC", { x: 9, y: 5 }, [
    makePin("in", PinDirection.INPUT, 0, 0),
  ], makePropBag({ label: "C" }));

  circuit.elements.push(inA, inB, xor, and, outS, outC);
  circuit.wires.push({ start: { x: 2, y: 0 }, end: { x: 4, y: 0 } } as any);
  circuit.wires.push({ start: { x: 2, y: 2 }, end: { x: 4, y: 2 } } as any);
  circuit.wires.push({ start: { x: 8, y: 1 }, end: { x: 9, y: 1 } } as any);
  circuit.wires.push({ start: { x: 8, y: 5 }, end: { x: 9, y: 5 } } as any);

  return circuit;
}

// ---------------------------------------------------------------------------
// SR latch circuit builder (2 NOR gates with feedback)
//
// Layout:
//   NOR1 (Q gate): inputs S (net S) and Q̄ feedback (net QB), output Q (net Q)
//   NOR2 (Q̄ gate): inputs R (net R) and Q feedback (net Q), output Q̄ (net QB)
//
//   Pin positions:
//     In S  → output at (2,0)
//     In R  → output at (2,10)
//     NOR1  → in0 at (4,0), in1 at (4,6), out at (8,3)  → net Q
//     NOR2  → in0 at (4,4), in1 at (4,10), out at (8,7)  → net QB
//     Out Q  → input at (9,3)
//     Out QB → input at (9,7)
//
//   Feedback connections:
//     NOR2 output QB (8,7) → NOR1 input in1 (4,6)  [separate wire]
//     NOR1 output Q  (8,3) → NOR2 input in0 (4,4)  [separate wire]
// ---------------------------------------------------------------------------

function buildSrLatch(): Circuit {
  const circuit = new Circuit();

  const inS = new MockElement("In", "inS", { x: 0, y: 0 }, [
    makePin("out", PinDirection.OUTPUT, 2, 0),
  ], makePropBag({ label: "S" }));

  const inR = new MockElement("In", "inR", { x: 0, y: 10 }, [
    makePin("out", PinDirection.OUTPUT, 2, 0),
  ], makePropBag({ label: "R" }));

  // NOR1: in0=S at (4,0), in1=QB_feedback at (4,6), out=Q at (8,3)
  const nor1 = new MockElement("NOR", "nor1", { x: 4, y: 0 }, [
    makePin("in0", PinDirection.INPUT, 0, 0),
    makePin("in1", PinDirection.INPUT, 0, 6),
    makePin("out", PinDirection.OUTPUT, 4, 3),
  ], makePropBag());

  // NOR2: in0=Q_feedback at (4,4), in1=R at (4,10), out=QB at (8,7)
  const nor2 = new MockElement("NOR", "nor2", { x: 4, y: 4 }, [
    makePin("in0", PinDirection.INPUT, 0, 0),
    makePin("in1", PinDirection.INPUT, 0, 6),
    makePin("out", PinDirection.OUTPUT, 4, 3),
  ], makePropBag());

  const outQ = new MockElement("Out", "outQ", { x: 9, y: 3 }, [
    makePin("in", PinDirection.INPUT, 0, 0),
  ], makePropBag({ label: "Q" }));

  const outQB = new MockElement("Out", "outQB", { x: 9, y: 7 }, [
    makePin("in", PinDirection.INPUT, 0, 0),
  ], makePropBag({ label: "QB" }));

  circuit.elements.push(inS, inR, nor1, nor2, outQ, outQB);

  // S input → NOR1 in0
  circuit.wires.push({ start: { x: 2, y: 0 }, end: { x: 4, y: 0 } } as any);
  // R input → NOR2 in1
  circuit.wires.push({ start: { x: 2, y: 10 }, end: { x: 4, y: 10 } } as any);
  // NOR1 output Q (8,3) → NOR2 input in0 (4,4) via junction at (4,4)
  circuit.wires.push({ start: { x: 8, y: 3 }, end: { x: 4, y: 4 } } as any);
  // NOR2 output QB (8,7) → NOR1 input in1 (4,6) via junction at (4,6)
  circuit.wires.push({ start: { x: 8, y: 7 }, end: { x: 4, y: 6 } } as any);
  // NOR1 output Q → Out Q
  circuit.wires.push({ start: { x: 8, y: 3 }, end: { x: 9, y: 3 } } as any);
  // NOR2 output QB → Out QB
  circuit.wires.push({ start: { x: 8, y: 7 }, end: { x: 9, y: 7 } } as any);

  return circuit;
}

// ---------------------------------------------------------------------------
// 3 NOT gates in series: NOT(NOT(NOT(X))) = NOT(X)
// ---------------------------------------------------------------------------

function buildChainOfInverters(): Circuit {
  const circuit = new Circuit();

  const inX = new MockElement("In", "inX", { x: 0, y: 0 }, [
    makePin("out", PinDirection.OUTPUT, 2, 0),
  ], makePropBag({ label: "X" }));

  // NOT A: input at (4,0), output at (8,0)
  const notA = new MockElement("NOT", "notA", { x: 4, y: 0 }, [
    makePin("in", PinDirection.INPUT, 0, 0),
    makePin("out", PinDirection.OUTPUT, 4, 0),
  ], makePropBag());

  // NOT B: input at (10,0), output at (14,0)
  const notB = new MockElement("NOT", "notB", { x: 10, y: 0 }, [
    makePin("in", PinDirection.INPUT, 0, 0),
    makePin("out", PinDirection.OUTPUT, 4, 0),
  ], makePropBag());

  // NOT C: input at (16,0), output at (20,0)
  const notC = new MockElement("NOT", "notC", { x: 16, y: 0 }, [
    makePin("in", PinDirection.INPUT, 0, 0),
    makePin("out", PinDirection.OUTPUT, 4, 0),
  ], makePropBag());

  const outY = new MockElement("Out", "outY", { x: 21, y: 0 }, [
    makePin("in", PinDirection.INPUT, 1, 0),
  ], makePropBag({ label: "Y" }));

  circuit.elements.push(inX, notA, notB, notC, outY);
  circuit.wires.push({ start: { x: 2, y: 0 }, end: { x: 4, y: 0 } } as any);
  circuit.wires.push({ start: { x: 8, y: 0 }, end: { x: 10, y: 0 } } as any);
  circuit.wires.push({ start: { x: 14, y: 0 }, end: { x: 16, y: 0 } } as any);
  circuit.wires.push({ start: { x: 20, y: 0 }, end: { x: 22, y: 0 } } as any);

  return circuit;
}

// ---------------------------------------------------------------------------
// Ring oscillator: 3 NOT gates in a loop (odd number → never stable)
// ---------------------------------------------------------------------------

function buildRingOscillator(): Circuit {
  const circuit = new Circuit();

  // NOT A: input at (4,0), output at (8,0)
  const notA = new MockElement("NOT", "notA", { x: 4, y: 0 }, [
    makePin("in", PinDirection.INPUT, 0, 0),
    makePin("out", PinDirection.OUTPUT, 4, 0),
  ], makePropBag());

  // NOT B: input at (10,0), output at (14,0)
  const notB = new MockElement("NOT", "notB", { x: 10, y: 0 }, [
    makePin("in", PinDirection.INPUT, 0, 0),
    makePin("out", PinDirection.OUTPUT, 4, 0),
  ], makePropBag());

  // NOT C: input at (16,0), output at (4,0) — feeds back to NOT A input
  const notC = new MockElement("NOT", "notC", { x: 16, y: 0 }, [
    makePin("in", PinDirection.INPUT, 0, 0),
    makePin("out", PinDirection.OUTPUT, -12, 0),  // feedback: world (4,0) = local (4-16, 0-0)
  ], makePropBag());

  circuit.elements.push(notA, notB, notC);
  circuit.wires.push({ start: { x: 8, y: 0 }, end: { x: 10, y: 0 } } as any);
  circuit.wires.push({ start: { x: 14, y: 0 }, end: { x: 16, y: 0 } } as any);
  // Ring closure: NOT C output world (4,0) is at same position as NOT A input world (4,0)
  // — pin position overlap creates the net (no separate wire needed)

  return circuit;
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("Integration", () => {
  // -------------------------------------------------------------------------
  // halfAdderFullCycle
  // -------------------------------------------------------------------------

  it("halfAdderFullCycle — all 4 input combinations produce correct S and C", () => {
    const registry = buildRegistry();
    const runner = new SimulationRunner(registry);

    const cases: [number, number, number, number][] = [
      [0, 0, 0, 0],
      [0, 1, 1, 0],
      [1, 0, 1, 0],
      [1, 1, 0, 1],
    ];

    for (const [a, b, expectedS, expectedC] of cases) {
      const circuit = buildHalfAdder();
      const engine = runner.compile(circuit);
      runner.setInput(engine, "A", a);
      runner.setInput(engine, "B", b);
      runner.step(engine);
      expect(runner.readOutput(engine, "S")).toBe(expectedS);
      expect(runner.readOutput(engine, "C")).toBe(expectedC);
    }
  });

  // -------------------------------------------------------------------------
  // srLatchInitializes
  // -------------------------------------------------------------------------

  it("srLatchInitializes — SR latch from 2 NOR gates: Q and QB are complementary after init", () => {
    const registry = buildRegistry();
    const runner = new SimulationRunner(registry);
    const circuit = buildSrLatch();

    // Set S=0, R=0 (idle state — latch retains its state)
    const engine = runner.compile(circuit);
    runner.setInput(engine, "S", 0);
    runner.setInput(engine, "R", 0);

    // Run to stable — the SR latch feedback SCC should converge
    runner.runToStable(engine, 100);

    const q = runner.readOutput(engine, "Q");
    const qb = runner.readOutput(engine, "QB");

    // Q and QB must be complementary: one is 1 and the other is 0
    expect(q + qb).toBe(1);
    expect(q).not.toBe(qb);
  });

  // -------------------------------------------------------------------------
  // chainOfInvertersStabilizes
  // -------------------------------------------------------------------------

  it("chainOfInvertersStabilizes — 3 NOT gates in series: output is inverted input", () => {
    const registry = buildRegistry();
    const runner = new SimulationRunner(registry);

    for (const input of [0, 1]) {
      const circuit = buildChainOfInverters();
      const engine = runner.compile(circuit);
      runner.setInput(engine, "X", input);
      runner.step(engine);

      const output = runner.readOutput(engine, "Y");
      // NOT(NOT(NOT(x))) = NOT(x)
      expect(output).toBe(input === 0 ? 1 : 0);
    }
  });

  // -------------------------------------------------------------------------
  // oscillatingCircuitDetected
  // -------------------------------------------------------------------------

  it("oscillatingCircuitDetected — ring oscillator throws OscillationError", () => {
    const registry = buildRegistry();
    const runner = new SimulationRunner(registry);
    const circuit = buildRingOscillator();

    const engine = runner.compile(circuit);
    expect(() => runner.runToStable(engine, 20)).toThrow(OscillationError);
  });

  // -------------------------------------------------------------------------
  // signalTraceCapture
  // -------------------------------------------------------------------------

  it("signalTraceCapture — 5-step trace captures correct array length and BitVector type", () => {
    const registry = buildRegistry();
    const runner = new SimulationRunner(registry);
    const circuit = buildHalfAdder();
    const engine = runner.compile(circuit);

    // Set stable inputs before tracing
    runner.setInput(engine, "A", 1);
    runner.setInput(engine, "B", 0);

    const trace = captureTrace(runner, engine, ["S", "C"], 5);

    // Each label should have exactly 5 entries
    expect(trace.get("S")).toHaveLength(5);
    expect(trace.get("C")).toHaveLength(5);

    // Each entry should be a BitVector
    for (const value of trace.get("S")!) {
      expect(value).toBeInstanceOf(BitVector);
    }

    // With A=1, B=0: S=1, C=0 for all 5 steps
    for (const value of trace.get("S")!) {
      expect(value).toEqual(BitVector.fromNumber(1, 1));
    }
    for (const value of trace.get("C")!) {
      expect(value).toEqual(BitVector.fromNumber(0, 1));
    }
  });
});
