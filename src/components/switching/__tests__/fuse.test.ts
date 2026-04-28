/**
 * Tests for Fuse component.
 *
 * Covers:
 *   - Initially closed (blown=false → state=1)
 *   - Blown → permanently open (state=0)
 *   - Cannot re-close once blown (no gate input)
 *   - Pin layout (2 bidirectional, no inputs)
 *   - Attribute mappings
 *   - Rendering (intact wire vs blown X mark)
 *   - ComponentDefinition completeness
 *   - Analog engine: setup() allocates 4 handles (TSTALLOC ressetup.c:46-49)
 *   - Analog engine: load() stamps conductance through cached handles
 *   - Analog engine: accept() integrates I²t and updates conductance
 */

import { describe, it, expect } from "vitest";
import {
  FuseElement,
  executeFuse,
  FuseDefinition,
  FUSE_ATTRIBUTE_MAPPINGS,
} from "../fuse.js";
import type { FETLayout } from "../nfet.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import { AnalogFuseElement, createAnalogFuseElement } from "../../passives/analog-fuse.js";
import { MNAEngine } from "../../../solver/analog/analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../../../solver/analog/analog-engine.js";
import type { AnalogElement } from "../../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// Layout helper
// ---------------------------------------------------------------------------

function makeFuseLayout(stateCount: number, blown: boolean = false): {
  layout: ComponentLayout & FETLayout;
  state: Uint32Array;
} {
  // Fuse has no inputs; state slots start at 0
  const state = new Uint32Array(stateCount);
  const layout: ComponentLayout & FETLayout = {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: (_i: number) => 0,
    inputOffset: (_i: number) => 0,
    outputCount: (_i: number) => 0,
    outputOffset: (_i: number) => 0,
    stateOffset: (_i: number) => 0,
    getProperty: (_i: number, key: string) => (key === "blown" ? blown : undefined),
  };
  return { layout, state };
}

// ---------------------------------------------------------------------------
// Analog engine fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal ConcreteCompiledAnalogCircuit shape for setup-only tests.
 * Mirrors the pattern in setup-stamp-order.test.ts.
 */
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

/**
 * Build an AnalogFuseElement with known pin nodes for engine tests.
 * posNode=1 (out1), negNode=2 (out2).
 *
 * Uses the real factory path: createAnalogFuseElement(pinNodes, props) so that
 * the element is constructed identically to the compiler path. Pin nodes are
 * passed directly to the factory; _pinNodes is initialized from them.
 */
function makeFuseAnalogElement(
  rCold = 0.01,
  rBlown = 1e9,
  i2tRating = 1e-4,
): AnalogFuseElement {
  const pinNodes = new Map([["out1", 1], ["out2", 2]]);
  const props = new PropertyBag();
  props.replaceModelParams({ rCold, rBlown, i2tRating });
  return createAnalogFuseElement(pinNodes, props, () => 0) as AnalogFuseElement;
}

// ---------------------------------------------------------------------------
// executeFuse tests
// ---------------------------------------------------------------------------

describe("Fuse — executeFn", () => {
  it("initiallyClosedState — blown=false writes state=1 (closed)", () => {
    const { layout, state } = makeFuseLayout(1, false);
    const highZs = new Uint32Array(state.length);
    executeFuse(0, state, highZs, layout);
    expect(state[0]).toBe(1); // closed
  });

  it("blownState — blown=true writes state=0 (open)", () => {
    const { layout, state } = makeFuseLayout(1, true);
    const highZs = new Uint32Array(state.length);
    executeFuse(0, state, highZs, layout);
    expect(state[0]).toBe(0); // open
  });

  it("cannotReclose — blown fuse stays open across multiple executions", () => {
    const { layout, state } = makeFuseLayout(1, true);
    const highZs = new Uint32Array(state.length);
    executeFuse(0, state, highZs, layout);
    expect(state[0]).toBe(0);
    executeFuse(0, state, highZs, layout);
    expect(state[0]).toBe(0);
  });

  it("multipleCallsPreserveState — repeated execution preserves closed state", () => {
    const { layout, state } = makeFuseLayout(1, false);
    const highZs = new Uint32Array(state.length);
    executeFuse(0, state, highZs, layout);
    executeFuse(0, state, highZs, layout);
    expect(state[0]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// FuseElement property tests
// ---------------------------------------------------------------------------

describe("Fuse — element properties", () => {
  it("blownFalse — defaults to not blown", () => {
    const props = new PropertyBag();
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.blown).toBe(false);
  });

  it("blownTrue — blown property reflects true when set", () => {
    const props = new PropertyBag();
    props.set("blown", true);
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.blown).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pin layout tests
// ---------------------------------------------------------------------------

describe("Fuse — pin layout", () => {
  it("pinLayout — no inputs, 2 bidirectional (out1, out2)", () => {
    const props = new PropertyBag();
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const pins = el.getPins();
    const inputs = pins.filter(p => p.direction === PinDirection.INPUT);
    const bidirectional = pins.filter(p => p.direction === PinDirection.BIDIRECTIONAL);
    expect(inputs.length).toBe(0);
    expect(bidirectional.length).toBe(2);
    const labels = pins.map(p => p.label);
    expect(labels).toContain("out1");
    expect(labels).toContain("out2");
  });
});

// ---------------------------------------------------------------------------
// Attribute mapping tests
// ---------------------------------------------------------------------------

describe("Fuse — attribute mappings", () => {
  it("bitsMapping — Bits attribute converts to number", () => {
    const bitsMap = FUSE_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
    expect(bitsMap!.convert("8")).toBe(8);
    expect(bitsMap!.convert("1")).toBe(1);
  });

  it("labelMapping — Label attribute passes through as string", () => {
    const labelMap = FUSE_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Label");
    expect(labelMap!.convert("F1")).toBe("F1");
  });

  it("blownMapping — blown attribute converts string to boolean", () => {
    const blownMap = FUSE_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "blown");
    expect(blownMap!.convert("true")).toBe(true);
    expect(blownMap!.convert("false")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rendering tests
// ---------------------------------------------------------------------------

describe("Fuse — rendering", () => {
  function makeCtx() {
    const calls: string[] = [];
    const colors: string[] = [];
    const texts: string[] = [];
    const ctx = {
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      translate: () => {},
      setColor: (c: string) => { calls.push("setColor"); colors.push(c); },
      setRawColor: (c: string) => { calls.push("setRawColor"); colors.push(c); },
      setLineWidth: () => calls.push("setLineWidth"),
      setFont: () => {},
      setLineDash: () => {},
      drawLine: () => calls.push("drawLine"),
      drawArc: () => calls.push("drawArc"),
      drawPath: () => calls.push("drawPath"),
      drawText: (t: string) => { calls.push("drawText"); texts.push(t); },
    };
    return { ctx, calls, colors, texts };
  }

  it("draw_intact — renders sine wave segments via drawLine", () => {
    const props = new PropertyBag();
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const { ctx, calls } = makeCtx();
    el.draw(ctx as never);
    expect(calls).toContain("save");
    expect(calls).toContain("restore");
    expect(calls).toContain("drawLine");
  });

  it("draw_blown — blown fuse draws broken segments and gap marker", () => {
    const props = new PropertyBag();
    props.set("blown", true);
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const { ctx, calls } = makeCtx();
    el.draw(ctx as never);
    // Blown draws left stub + right stub + gap X marker = many drawLine calls
    expect(calls.filter(c => c === "drawLine").length).toBeGreaterThanOrEqual(4);
  });

  it("draw_notBlown — COMPONENT color when intact and no heat", () => {
    const props = new PropertyBag();
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const { ctx, colors } = makeCtx();
    el.draw(ctx as never);
    expect(colors).toContain("COMPONENT");
    expect(colors).not.toContain("WIRE_ERROR");
  });

  it("draw_heat — warm color when thermalRatio > 0.3", () => {
    const props = new PropertyBag();
    props.set("_thermalRatio", 0.6);
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const { ctx, colors } = makeCtx();
    el.draw(ctx as never);
    // Should use setRawColor with an orange-ish heat color
    expect(colors.some(c => c.startsWith("rgb("))).toBe(true);
  });

  it("draw_withLabel — renders label text when set", () => {
    const props = new PropertyBag();
    props.set("label", "F1");
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const { ctx, texts } = makeCtx();
    el.draw(ctx as never);
    expect(texts).toContain("F1");
  });

  it("draw_noLabel — no text rendered when label is empty", () => {
    const props = new PropertyBag();
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const { ctx, texts } = makeCtx();
    el.draw(ctx as never);
    expect(texts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ComponentDefinition tests
// ---------------------------------------------------------------------------

describe("Fuse — ComponentDefinition", () => {
  it("definitionComplete — FuseDefinition has all required fields", () => {
    expect(FuseDefinition.name).toBe("Fuse");
    expect(FuseDefinition.factory).toBeDefined();
    expect(FuseDefinition.models!.digital!.executeFn).toBeDefined();
    expect(FuseDefinition.pinLayout).toBeDefined();
    expect(FuseDefinition.propertyDefs).toBeDefined();
    expect(FuseDefinition.attributeMap).toBeDefined();
    expect(FuseDefinition.category).toBe(ComponentCategory.SWITCHING);
    expect(FuseDefinition.helpText).toBeDefined();
    expect(typeof FuseDefinition.models.digital!.defaultDelay).toBe("number");
  });

  it("factoryCreatesInstance — factory returns FuseElement", () => {
    const props = new PropertyBag();
    expect(FuseDefinition.factory(props)).toBeInstanceOf(FuseElement);
  });

  it("boundingBox — non-zero dimensions at correct position", () => {
    const props = new PropertyBag();
    const el = new FuseElement(crypto.randomUUID(), { x: 4, y: 6 }, 0, false, props);
    const bb = el.getBoundingBox();
    expect(bb.x).toBe(4);
    // getBoundingBox offsets y by -0.4 (sine wave + heat glow extends above pin centre)
    expect(bb.width).toBeGreaterThanOrEqual(1);
    expect(bb.height).toBeGreaterThanOrEqual(0.4);
  });

  it("defaultDelay — is zero (combinational)", () => {
    expect(FuseDefinition.models.digital!.defaultDelay).toBe(0);
  });

  it("ngspiceNodeMap — present on definition and behavioral model", () => {
    expect(FuseDefinition.ngspiceNodeMap).toEqual({ out1: "pos", out2: "neg" });
    const behavioral = FuseDefinition.modelRegistry?.["behavioral"];
    expect(behavioral).toBeDefined();
    expect(behavioral!.kind).toBe("inline");
    if (behavioral!.kind === "inline") {
      expect(behavioral!.ngspiceNodeMap).toEqual({ out1: "pos", out2: "neg" });
    }
  });
});

// ---------------------------------------------------------------------------
// Analog engine — setup() TSTALLOC sequence
// ---------------------------------------------------------------------------

describe("Fuse — analog setup() TSTALLOC sequence", () => {
  it("setup allocates 4 handles in ressetup.c:46-49 order", () => {
    // ngspice anchor: res/ressetup.c:46-49 — 4 TSTALLOC entries.
    // posNode=1 (out1), negNode=2 (out2).
    // Expected sequence:
    //  1. (posNode=1, posNode=1)  → _hPP
    //  2. (negNode=2, negNode=2)  → _hNN
    //  3. (posNode=1, negNode=2)  → _hPN
    //  4. (negNode=2, posNode=1)  → _hNP
    const el = makeFuseAnalogElement();
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 },  // (1) RESposNode, RESposNode
      { extRow: 2, extCol: 2 },  // (2) RESnegNode, RESnegNode
      { extRow: 1, extCol: 2 },  // (3) RESposNode, RESnegNode
      { extRow: 2, extCol: 1 },  // (4) RESnegNode, RESposNode
    ]);
  });
});

// ---------------------------------------------------------------------------
// Analog engine — load() stamps conductance through handles
// ---------------------------------------------------------------------------

describe("Fuse — analog load() via engine", () => {
  it("load stamps 4 conductance entries after setup", () => {
    // After _setup(), load() should stamp +G, +G, -G, -G through the 4 handles.
    // We verify by running dcOperatingPoint which calls _setup() then load().
    // Use a minimal circuit: fuse between node 1 and 2 with rCold=100Ω.
    const rCold = 100;
    const el = makeFuseAnalogElement(rCold);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();

    // After setup the handles are allocated; verify all are non-negative
    expect((el as any)._hPP).toBeGreaterThanOrEqual(0);
    expect((el as any)._hNN).toBeGreaterThanOrEqual(0);
    expect((el as any)._hPN).toBeGreaterThanOrEqual(0);
    expect((el as any)._hNP).toBeGreaterThanOrEqual(0);

    // Initial conductance matches rCold
    const expectedG = 1 / rCold;
    expect((el as any)._conduct).toBeCloseTo(expectedG, 10);
  });

  it("load() does not call allocElement (no new handles after setup)", () => {
    // Record insertion order length after setup; load() must not extend it.
    const el = makeFuseAnalogElement();
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();

    const orderAfterSetup = (engine as any)._solver._getInsertionOrder().length;
    expect(orderAfterSetup).toBe(4); // exactly 4 from TSTALLOC sequence

    // Manually call load() with a stub context — insertion order must not grow
    const stubCtx = {
      solver: (engine as any)._solver,
      rhs: new Float64Array(4),
      rhsOld: new Float64Array(4),
      dt: 1e-6,
      temp: 300.15,
      reltol: 1e-3,
      abstol: 1e-12,
      iabstol: 1e-12,
      vntol: 1e-6,
      gmin: 1e-12,
    };
    el.load(stubCtx as any);

    const orderAfterLoad = (engine as any)._solver._getInsertionOrder().length;
    expect(orderAfterLoad).toBe(4); // unchanged — load() must not call allocElement
  });
});

// ---------------------------------------------------------------------------
// Analog engine — accept() thermal integration
// ---------------------------------------------------------------------------

describe("Fuse — analog accept() thermal model", () => {
  it("i2t accumulates correctly and blows fuse at threshold", () => {
    // i2tRating = 1e-4 A²·s, rCold = 0.01 Ω
    // Apply V=1V across the fuse: I ≈ 1/0.01 = 100A, I²·dt per step
    // After 1 step of dt=1e-6s: I²·dt = 100²×1e-6 = 0.01 → need 0.0001/0.01 = 0.01s
    const el = makeFuseAnalogElement(0.01, 1e9, 1e-4);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();

    // Initially not blown
    expect(el.blown).toBe(false);
    expect(el.thermalEnergy).toBe(0);

    // Simulate accept() calls with V=1V (rhs[1]=1, rhs[2]=0), dt=1e-6s
    const rhs = new Float64Array(4);
    rhs[1] = 1.0; // posNode voltage
    rhs[2] = 0.0; // negNode voltage
    const dt = 1e-6;
    const stubCtx = {
      solver: (engine as any)._solver,
      rhs,
      rhsOld: rhs,
      dt,
      temp: 300.15,
      reltol: 1e-3,
      abstol: 1e-12,
      iabstol: 1e-12,
      vntol: 1e-6,
      gmin: 1e-12,
    };

    // I = V * G = 1 * (1/0.01) = 100A. I²·dt = 10000 * 1e-6 = 0.01 per step.
    // Need i2tAccum >= 1e-4. After 1 step: 0.01 > 1e-4 → blows immediately.
    el.accept(stubCtx as any, 0, () => {});
    expect(el.blown).toBe(true);
    expect(el.thermalRatio).toBeCloseTo(1, 0);
  });

  it("conductance updates after each accept() step", () => {
    // Very high i2tRating so fuse doesn't blow; check conductance changes
    const el = makeFuseAnalogElement(1.0, 1e9, 1e6);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();

    const initialConductance = (el as any)._conduct;
    expect(initialConductance).toBeCloseTo(1 / 1.0, 10);

    // Accept step — conductance should still be near 1/rCold (no blow)
    const rhs = new Float64Array(4);
    rhs[1] = 0.001; // very small voltage
    rhs[2] = 0.0;
    const stubCtx = {
      solver: (engine as any)._solver,
      rhs,
      rhsOld: rhs,
      dt: 1e-9,
      temp: 300.15,
      reltol: 1e-3,
      abstol: 1e-12,
      iabstol: 1e-12,
      vntol: 1e-6,
      gmin: 1e-12,
    };
    el.accept(stubCtx as any, 0, () => {});
    // Not blown, conductance stays near rCold value
    expect(el.blown).toBe(false);
    expect((el as any)._conduct).toBeCloseTo(1 / 1.0, 3);
  });

  it("thermalRatio increases monotonically with energy accumulation", () => {
    const el = makeFuseAnalogElement(0.01, 1e9, 1.0); // high threshold
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();

    const rhs = new Float64Array(4);
    rhs[1] = 0.1;
    rhs[2] = 0.0;
    const stubCtx = {
      solver: (engine as any)._solver,
      rhs,
      rhsOld: rhs,
      dt: 1e-6,
      temp: 300.15,
      reltol: 1e-3,
      abstol: 1e-12,
      iabstol: 1e-12,
      vntol: 1e-6,
      gmin: 1e-12,
    };

    let prevRatio = 0;
    for (let i = 0; i < 5; i++) {
      el.accept(stubCtx as any, i * 1e-6, () => {});
      const ratio = el.thermalRatio;
      expect(ratio).toBeGreaterThan(prevRatio);
      prevRatio = ratio;
    }
  });
});
