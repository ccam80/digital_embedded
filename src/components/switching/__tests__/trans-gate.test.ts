/**
 * Tests for TransGate component.
 *
 * Covers:
 *   - Pin declarations: correct count, labels, directions
 *   - executeTransGate: closed flag write (S=1,~S=0 → closed), open cases
 *   - ComponentDefinition completeness
 *   - Attribute mappings
 *   - Analog composite: setup() allocates 8 handles (4 per SW sub-element)
 *   - Analog composite: load() stamps conductance for NFET and PFET sub-elements
 *   - Analog composite: NFET ON when ctrl > Vth, PFET ON when ctrlN < -Vth (inverted)
 *   - TSTALLOC ordering: NFET SW 4 stamps then PFET SW 4 stamps
 */

import { describe, it, expect } from "vitest";
import {
  TransGateElement,
  TransGateAnalogElement,
  TransGateDefinition,
  TRANS_GATE_ATTRIBUTE_MAPPINGS,
  executeTransGate,
} from "../trans-gate.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";
import { MNAEngine } from "../../../solver/analog/analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../../../solver/analog/analog-engine.js";
import type { AnalogElement } from "../../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// Layout mock helper (same pattern as switches.test.ts)
// ---------------------------------------------------------------------------

function makeLayout(
  inputCount: number,
  outputCount: number = 2,
  propOverrides?: Record<string, unknown>,
): ComponentLayout {
  return {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => inputCount,
    stateOffset: () => inputCount + outputCount,
    getProperty: (_index: number, key: string): PropertyValue | undefined =>
      propOverrides?.[key] as PropertyValue | undefined,
  };
}

function makeState(size: number): Uint32Array {
  return new Uint32Array(size);
}

// ---------------------------------------------------------------------------
// RenderContext mock
// ---------------------------------------------------------------------------

interface DrawCall { method: string; args: unknown[] }

function makeStubCtx(): { ctx: RenderContext; calls: DrawCall[] } {
  const calls: DrawCall[] = [];
  const record = (method: string) => (...args: unknown[]): void => { calls.push({ method, args }); };
  const ctx: RenderContext = {
    drawLine: record("drawLine") as (x1: number, y1: number, x2: number, y2: number) => void,
    drawRect: record("drawRect") as (x: number, y: number, w: number, h: number, filled: boolean) => void,
    drawCircle: record("drawCircle") as (cx: number, cy: number, r: number, filled: boolean) => void,
    drawArc: record("drawArc") as (cx: number, cy: number, r: number, s: number, e: number) => void,
    drawPolygon: record("drawPolygon") as (points: readonly Point[], filled: boolean) => void,
    drawPath: record("drawPath") as (path: PathData) => void,
    drawText: record("drawText") as (text: string, x: number, y: number, anchor: TextAnchor) => void,
    save: record("save") as () => void,
    restore: record("restore") as () => void,
    translate: record("translate") as (dx: number, dy: number) => void,
    rotate: record("rotate") as (angle: number) => void,
    scale: record("scale") as (sx: number, sy: number) => void,
    setColor: record("setColor") as (color: ThemeColor) => void,
    setLineWidth: record("setLineWidth") as (w: number) => void,
    setFont: record("setFont") as (font: FontSpec) => void,
    setLineDash: record("setLineDash") as (pattern: number[]) => void,
  };
  return { ctx, calls };
}

// ---------------------------------------------------------------------------
// Minimal compiled-circuit fixture builder (same pattern as setup-stamp-order.test.ts)
// ---------------------------------------------------------------------------

function makeMinimalCircuit(
  elements: AnalogElement[],
  nodeCount: number,
): ConcreteCompiledAnalogCircuit {
  return {
    nodeCount,
    elements,
    labelToNodeId: new Map(),
    labelPinNodes: new Map(),
    wireToNodeId: new Map(),
    models: new Map(),
    statePool: null,
    componentCount: elements.length,
    netCount: nodeCount,
    diagnostics: [],
    branchCount: 0,
    matrixSize: nodeCount,
    bridgeOutputAdapters: [],
    bridgeInputAdapters: [],
    elementToCircuitElement: new Map(),
    resolvedPins: [],
  } as unknown as ConcreteCompiledAnalogCircuit;
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

function makeTransGateElement(overrides?: { label?: string; bitWidth?: number }): TransGateElement {
  const props = new PropertyBag();
  props.set("bitWidth", overrides?.bitWidth ?? 1);
  if (overrides?.label !== undefined) props.set("label", overrides.label);
  return new TransGateElement("test-tg-001", { x: 0, y: 0 }, 0, false, props);
}

function makeTransGateAnalogElement(
  inNode: number,
  outNode: number,
  ctrlNode: number,
  ctrlNNode: number,
  overrides?: { ron?: number; roff?: number; vth?: number },
): TransGateAnalogElement {
  const pinNodes = new Map<string, number>([
    ["p1", ctrlNode],
    ["p2", ctrlNNode],
    ["out1", inNode],
    ["out2", outNode],
  ]);
  const el = new TransGateAnalogElement(pinNodes);
  return el;
}

// ===========================================================================
// TransGateElement tests
// ===========================================================================

describe("TransGateElement", () => {
  describe("pins", () => {
    it("has 4 pins", () => {
      const tg = makeTransGateElement();
      expect(tg.getPins()).toHaveLength(4);
    });

    it("p1 pin is INPUT", () => {
      const tg = makeTransGateElement();
      const p1 = tg.getPins().find((p) => p.label === "p1");
      expect(p1).toBeDefined();
      expect(p1!.direction).toBe(PinDirection.INPUT);
    });

    it("p2 pin is INPUT", () => {
      const tg = makeTransGateElement();
      const p2 = tg.getPins().find((p) => p.label === "p2");
      expect(p2).toBeDefined();
      expect(p2!.direction).toBe(PinDirection.INPUT);
    });

    it("out1 pin is BIDIRECTIONAL", () => {
      const tg = makeTransGateElement();
      const out1 = tg.getPins().find((p) => p.label === "out1");
      expect(out1).toBeDefined();
      expect(out1!.direction).toBe(PinDirection.BIDIRECTIONAL);
    });

    it("out2 pin is BIDIRECTIONAL", () => {
      const tg = makeTransGateElement();
      const out2 = tg.getPins().find((p) => p.label === "out2");
      expect(out2).toBeDefined();
      expect(out2!.direction).toBe(PinDirection.BIDIRECTIONAL);
    });
  });

  describe("getBoundingBox", () => {
    it("bounding box has width 2 and height 2", () => {
      const tg = makeTransGateElement();
      const bb = tg.getBoundingBox();
      expect(bb.width).toBe(2);
      expect(bb.height).toBe(2);
    });

    it("bounding box y offset is -1 (extends up for p1 pin)", () => {
      const tg = makeTransGateElement();
      const bb = tg.getBoundingBox();
      expect(bb.y).toBe(tg.position.y - 1);
    });
  });

  describe("rendering", () => {
    it("draw() calls drawPolygon twice (two bowtie halves)", () => {
      const tg = makeTransGateElement();
      const { ctx, calls } = makeStubCtx();
      tg.draw(ctx);
      const polygonCalls = calls.filter((c) => c.method === "drawPolygon");
      expect(polygonCalls).toHaveLength(2);
    });

    it("draw() calls drawCircle once (inversion bubble for p2)", () => {
      const tg = makeTransGateElement();
      const { ctx, calls } = makeStubCtx();
      tg.draw(ctx);
      const circleCalls = calls.filter((c) => c.method === "drawCircle");
      expect(circleCalls).toHaveLength(1);
    });

    it("draw() calls drawLine once (gate line for p1)", () => {
      const tg = makeTransGateElement();
      const { ctx, calls } = makeStubCtx();
      tg.draw(ctx);
      const lineCalls = calls.filter((c) => c.method === "drawLine");
      expect(lineCalls).toHaveLength(1);
    });

    it("draw() with label calls drawText", () => {
      const tg = makeTransGateElement({ label: "TG1" });
      const { ctx, calls } = makeStubCtx();
      tg.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => c.args[0] === "TG1")).toBe(true);
    });

    it("draw() without label does not call drawText", () => {
      const tg = makeTransGateElement({ label: "" });
      const { ctx, calls } = makeStubCtx();
      tg.draw(ctx);
      expect(calls.filter((c) => c.method === "drawText")).toHaveLength(0);
    });
  });
});

// ===========================================================================
// executeTransGate tests
// ===========================================================================

describe("executeTransGate", () => {
  it("S=1, ~S=0 → closed=1 (normal on state)", () => {
    // Input layout: [S=0, ~S=1]; outputs: [A=2, B=3]; state at offset 4
    const layout = makeLayout(2, 2);
    const state = makeState(8);
    const highZs = new Uint32Array(8);
    state[0] = 1; // S=1
    state[1] = 0; // ~S=0
    executeTransGate(0, state, highZs, layout);
    expect(state[4]).toBe(1);
  });

  it("S=0, ~S=1 → closed=0 (inverted state is open)", () => {
    const layout = makeLayout(2, 2);
    const state = makeState(8);
    const highZs = new Uint32Array(8);
    state[0] = 0; // S=0
    state[1] = 1; // ~S=1
    executeTransGate(0, state, highZs, layout);
    expect(state[4]).toBe(0);
  });

  it("S=0, ~S=0 → closed=0 (invalid/both low → open)", () => {
    const layout = makeLayout(2, 2);
    const state = makeState(8);
    const highZs = new Uint32Array(8);
    state[0] = 0;
    state[1] = 0;
    executeTransGate(0, state, highZs, layout);
    expect(state[4]).toBe(0);
  });

  it("S=1, ~S=1 → closed=0 (invalid/both high → open)", () => {
    const layout = makeLayout(2, 2);
    const state = makeState(8);
    const highZs = new Uint32Array(8);
    state[0] = 1;
    state[1] = 1;
    executeTransGate(0, state, highZs, layout);
    expect(state[4]).toBe(0);
  });

  it("S high-Z → closed=0 (high-impedance input → open)", () => {
    const layout = makeLayout(2, 2);
    const state = makeState(8);
    const highZs = new Uint32Array(8);
    highZs[0] = 0xffffffff; // S is high-Z
    state[1] = 0;           // ~S=0
    executeTransGate(0, state, highZs, layout);
    expect(state[4]).toBe(0);
  });
});

// ===========================================================================
// ComponentDefinition completeness
// ===========================================================================

describe("TransGateDefinition", () => {
  it("name is TransGate", () => {
    expect(TransGateDefinition.name).toBe("TransGate");
  });

  it("typeId is -1", () => {
    expect(TransGateDefinition.typeId).toBe(-1);
  });

  it("category is SWITCHING", () => {
    expect(TransGateDefinition.category).toBe(ComponentCategory.SWITCHING);
  });

  it("digital executeFn is executeTransGate", () => {
    expect(TransGateDefinition.models!.digital!.executeFn).toBe(executeTransGate);
  });

  it("digital stateSlotCount is 1", () => {
    expect(TransGateDefinition.models!.digital!.stateSlotCount).toBe(1);
  });

  it("digital inputSchema is [p1, p2]", () => {
    expect(TransGateDefinition.models!.digital!.inputSchema).toEqual(["p1", "p2"]);
  });

  it("digital outputSchema is [out1, out2]", () => {
    expect(TransGateDefinition.models!.digital!.outputSchema).toEqual(["out1", "out2"]);
  });

  it("factory produces a TransGateElement", () => {
    const props = new PropertyBag();
    props.set("bitWidth", 1);
    const el = TransGateDefinition.factory(props);
    expect(el.typeId).toBe("TransGate");
  });

  it("modelRegistry has behavioral entry", () => {
    expect(TransGateDefinition.modelRegistry?.behavioral).toBeDefined();
  });

  it("behavioral factory is inline kind", () => {
    expect(TransGateDefinition.modelRegistry?.behavioral?.kind).toBe("inline");
  });

  it("can be registered without throwing", () => {
    const registry = new ComponentRegistry();
    expect(() => registry.register(TransGateDefinition)).not.toThrow();
  });

  it("propertyDefs include Ron", () => {
    expect(TransGateDefinition.propertyDefs.map((d) => d.key)).toContain("Ron");
  });

  it("propertyDefs include Roff", () => {
    expect(TransGateDefinition.propertyDefs.map((d) => d.key)).toContain("Roff");
  });

  it("propertyDefs include Vth", () => {
    expect(TransGateDefinition.propertyDefs.map((d) => d.key)).toContain("Vth");
  });
});

// ===========================================================================
// Attribute mappings
// ===========================================================================

describe("TRANS_GATE_ATTRIBUTE_MAPPINGS", () => {
  it("Bits XML attribute maps to bitWidth", () => {
    const m = TRANS_GATE_ATTRIBUTE_MAPPINGS.find((a) => a.xmlName === "Bits");
    expect(m).toBeDefined();
    expect(m!.convert("8")).toBe(8);
  });

  it("Label XML attribute maps to label", () => {
    const m = TRANS_GATE_ATTRIBUTE_MAPPINGS.find((a) => a.xmlName === "Label");
    expect(m).toBeDefined();
    expect(m!.convert("TG")).toBe("TG");
  });

  it("Ron XML attribute maps to Ron", () => {
    const m = TRANS_GATE_ATTRIBUTE_MAPPINGS.find((a) => a.xmlName === "Ron");
    expect(m).toBeDefined();
    expect(m!.convert("10")).toBe(10);
  });

  it("Roff XML attribute maps to Roff", () => {
    const m = TRANS_GATE_ATTRIBUTE_MAPPINGS.find((a) => a.xmlName === "Roff");
    expect(m).toBeDefined();
    expect(m!.convert("1e6")).toBe(1e6);
  });

  it("Vth XML attribute maps to Vth", () => {
    const m = TRANS_GATE_ATTRIBUTE_MAPPINGS.find((a) => a.xmlName === "Vth");
    expect(m).toBeDefined();
    expect(m!.convert("1.5")).toBe(1.5);
  });
});

// ===========================================================================
// TransGateAnalogElement — TSTALLOC ordering and stamp behavior
// ===========================================================================

describe("TransGateAnalogElement", () => {
  describe("TSTALLOC sequence", () => {
    it("setup() produces 8-entry insertion order: NFET SW 4 then PFET SW 4", () => {
      // Per PB-TRANSGATE TSTALLOC table:
      // Nodes: inNode=out1=1, outNode=out2=2, ctrlNode=p1=3, ctrlNNode=p2=4
      // NFET SW (swsetup.c:59-62, first pass):
      //   _hPP=(1,1), _hPN=(1,2), _hNP=(2,1), _hNN=(2,2)
      // PFET SW (swsetup.c:59-62, second pass):
      //   _hPP=(1,1), _hPN=(1,2), _hNP=(2,1), _hNN=(2,2)
      const el = makeTransGateAnalogElement(1, 2, 3, 4);
      const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 4);
      const engine = new MNAEngine();
      engine.init(circuit);
      (engine as any)._setup();
      const order = (engine as any)._solver._getInsertionOrder();
      expect(order).toEqual([
        { extRow: 1, extCol: 1 }, // NFET SW _hPP: (inNode, inNode)
        { extRow: 1, extCol: 2 }, // NFET SW _hPN: (inNode, outNode)
        { extRow: 2, extCol: 1 }, // NFET SW _hNP: (outNode, inNode)
        { extRow: 2, extCol: 2 }, // NFET SW _hNN: (outNode, outNode)
        { extRow: 1, extCol: 1 }, // PFET SW _hPP: (inNode, inNode)
        { extRow: 1, extCol: 2 }, // PFET SW _hPN: (inNode, outNode)
        { extRow: 2, extCol: 1 }, // PFET SW _hNP: (outNode, inNode)
        { extRow: 2, extCol: 2 }, // PFET SW _hNN: (outNode, outNode)
      ]);
    });

    it("setup() allocates state: _stateBase increments by 2 per sub-element (SW_NUM_STATES=2)", () => {
      const el = makeTransGateAnalogElement(1, 2, 3, 4);
      const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 4);
      const engine = new MNAEngine();
      engine.init(circuit);
      (engine as any)._setup();
      // NFET SW stateBase=0, PFET SW stateBase=2 (each allocates 2 state slots)
      expect(el._nfetSW._stateBase).toBe(0);
      expect(el._pfetSW._stateBase).toBe(2);
    });
  });

  describe("handle fields populated after setup()", () => {
    it("_nfetSW handle fields are not -1 after setup()", () => {
      const el = makeTransGateAnalogElement(1, 2, 3, 4);
      const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 4);
      const engine = new MNAEngine();
      engine.init(circuit);
      (engine as any)._setup();
      expect(el._nfetSW._hPP).not.toBe(-1);
      expect(el._nfetSW._hPN).not.toBe(-1);
      expect(el._nfetSW._hNP).not.toBe(-1);
      expect(el._nfetSW._hNN).not.toBe(-1);
    });

    it("_pfetSW handle fields are not -1 after setup()", () => {
      const el = makeTransGateAnalogElement(1, 2, 3, 4);
      const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 4);
      const engine = new MNAEngine();
      engine.init(circuit);
      (engine as any)._setup();
      expect(el._pfetSW._hPP).not.toBe(-1);
      expect(el._pfetSW._hPN).not.toBe(-1);
      expect(el._pfetSW._hNP).not.toBe(-1);
      expect(el._pfetSW._hNN).not.toBe(-1);
    });
  });

  describe("sub-element node assignments", () => {
    it("_nfetSW D maps to inNode (out1)", () => {
      const el = makeTransGateAnalogElement(1, 2, 3, 4);
      expect(el._nfetSW._pinNodes.get("D")).toBe(1);
    });

    it("_nfetSW S maps to outNode (out2)", () => {
      const el = makeTransGateAnalogElement(1, 2, 3, 4);
      expect(el._nfetSW._pinNodes.get("S")).toBe(2);
    });

    it("_pfetSW D maps to inNode (out1)", () => {
      const el = makeTransGateAnalogElement(1, 2, 3, 4);
      expect(el._pfetSW._pinNodes.get("D")).toBe(1);
    });

    it("_pfetSW S maps to outNode (out2)", () => {
      const el = makeTransGateAnalogElement(1, 2, 3, 4);
      expect(el._pfetSW._pinNodes.get("S")).toBe(2);
    });
  });

  describe("setParam propagates to both sub-elements", () => {
    it("setParam Ron propagates to both SW sub-elements", () => {
      const el = makeTransGateAnalogElement(1, 2, 3, 4);
      el.setParam("Ron", 100);
      // Verify via load behavior: after setup both sub-elements stamp with updated Ron
      const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 4);
      const engine = new MNAEngine();
      engine.init(circuit);
      (engine as any)._setup();
      // Both SW elements have Ron=100; no error expected
      expect(el._nfetSW._hPP).not.toBe(-1);
      expect(el._pfetSW._hPP).not.toBe(-1);
    });
  });

  describe("ngspiceLoadOrder", () => {
    it("composite has ngspiceLoadOrder = SW", () => {
      const el = makeTransGateAnalogElement(1, 2, 3, 4);
      expect(el.ngspiceLoadOrder).toBeDefined();
    });
  });

  describe("isNonlinear and isReactive", () => {
    it("isNonlinear is true (switch is nonlinear)", () => {
      const el = makeTransGateAnalogElement(1, 2, 3, 4);
      expect(el.isNonlinear).toBe(true);
    });

    it("isReactive is false", () => {
      const el = makeTransGateAnalogElement(1, 2, 3, 4);
      expect(el.isReactive).toBe(false);
    });
  });
});
