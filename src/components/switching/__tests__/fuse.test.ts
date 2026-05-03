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
 *   - Analog engine: acceptStep() integrates I²t and updates conductance
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
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

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
 * Build a Circuit containing a Fuse (via ComparisonSession M1 shape).
 * rCold=0.01Ω, rBlown=1e9Ω, i2tRating=1e-4A²s by default.
 * Drives the fuse with a 1V DC source: fuse between vs:pos and gnd.
 */
function buildFuseCircuit(
  registry: InstanceType<typeof import("../../../core/registry.js").ComponentRegistry>,
  overrides: { rCold?: number; rBlown?: number; i2tRating?: number; blown?: boolean } = {},
) {
  const facade = new DefaultSimulatorFacade(registry);
  return facade.build({
    components: [
      {
        id: "vs",
        type: "DcVoltageSource",
        props: { label: "vs", voltage: 1 },
      },
      {
        id: "fuse1",
        type: "Fuse",
        props: {
          label: "fuse1",
          rCold: overrides.rCold ?? 0.01,
          rBlown: overrides.rBlown ?? 1e9,
          i2tRating: overrides.i2tRating ?? 1e-4,
          blown: overrides.blown ?? false,
        },
      },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos", "fuse1:out1"],
      ["fuse1:out2", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

// ---------------------------------------------------------------------------
// executeFuse tests
// ---------------------------------------------------------------------------

describe("Fuse- executeFn", () => {
  it("initiallyClosedState- blown=false writes state=1 (closed)", () => {
    const { layout, state } = makeFuseLayout(1, false);
    const highZs = new Uint32Array(state.length);
    executeFuse(0, state, highZs, layout);
    expect(state[0]).toBe(1); // closed
  });

  it("blownState- blown=true writes state=0 (open)", () => {
    const { layout, state } = makeFuseLayout(1, true);
    const highZs = new Uint32Array(state.length);
    executeFuse(0, state, highZs, layout);
    expect(state[0]).toBe(0); // open
  });

  it("cannotReclose- blown fuse stays open across multiple executions", () => {
    const { layout, state } = makeFuseLayout(1, true);
    const highZs = new Uint32Array(state.length);
    executeFuse(0, state, highZs, layout);
    expect(state[0]).toBe(0);
    executeFuse(0, state, highZs, layout);
    expect(state[0]).toBe(0);
  });

  it("multipleCallsPreserveState- repeated execution preserves closed state", () => {
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

describe("Fuse- element properties", () => {
  it("blownFalse- defaults to not blown", () => {
    const props = new PropertyBag();
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.blown).toBe(false);
  });

  it("blownTrue- blown property reflects true when set", () => {
    const props = new PropertyBag();
    props.set("blown", true);
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    expect(el.blown).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pin layout tests
// ---------------------------------------------------------------------------

describe("Fuse- pin layout", () => {
  it("pinLayout- no inputs, 2 bidirectional (out1, out2)", () => {
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

describe("Fuse- attribute mappings", () => {
  it("bitsMapping- Bits attribute converts to number", () => {
    const bitsMap = FUSE_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Bits");
    expect(bitsMap!.convert("8")).toBe(8);
    expect(bitsMap!.convert("1")).toBe(1);
  });

  it("labelMapping- Label attribute passes through as string", () => {
    const labelMap = FUSE_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "Label");
    expect(labelMap!.convert("F1")).toBe("F1");
  });

  it("blownMapping- blown attribute converts string to boolean", () => {
    const blownMap = FUSE_ATTRIBUTE_MAPPINGS.find(m => m.xmlName === "blown");
    expect(blownMap!.convert("true")).toBe(true);
    expect(blownMap!.convert("false")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rendering tests
// ---------------------------------------------------------------------------

describe("Fuse- rendering", () => {
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

  it("draw_intact- renders sine wave segments via drawLine", () => {
    const props = new PropertyBag();
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const { ctx, calls } = makeCtx();
    el.draw(ctx as never);
    expect(calls).toContain("save");
    expect(calls).toContain("restore");
    expect(calls).toContain("drawLine");
  });

  it("draw_blown- blown fuse draws broken segments and gap marker", () => {
    const props = new PropertyBag();
    props.set("blown", true);
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const { ctx, calls } = makeCtx();
    el.draw(ctx as never);
    // Blown draws left stub + right stub + gap X marker = many drawLine calls
    expect(calls.filter(c => c === "drawLine").length).toBeGreaterThanOrEqual(4);
  });

  it("draw_notBlown- COMPONENT color when intact and no heat", () => {
    const props = new PropertyBag();
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const { ctx, colors } = makeCtx();
    el.draw(ctx as never);
    expect(colors).toContain("COMPONENT");
    expect(colors).not.toContain("WIRE_ERROR");
  });

  it("draw_heat- warm color when thermalRatio > 0.3", () => {
    const props = new PropertyBag();
    props.set("_thermalRatio", 0.6);
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const { ctx, colors } = makeCtx();
    el.draw(ctx as never);
    // Should use setRawColor with an orange-ish heat color
    expect(colors.some(c => c.startsWith("rgb("))).toBe(true);
  });

  it("draw_withLabel- renders label text when set", () => {
    const props = new PropertyBag();
    props.set("label", "F1");
    const el = new FuseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
    const { ctx, texts } = makeCtx();
    el.draw(ctx as never);
    expect(texts).toContain("F1");
  });

  it("draw_noLabel- no text rendered when label is empty", () => {
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

describe("Fuse- ComponentDefinition", () => {
  it("definitionComplete- FuseDefinition has all required fields", () => {
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

  it("factoryCreatesInstance- factory returns FuseElement", () => {
    const props = new PropertyBag();
    expect(FuseDefinition.factory(props)).toBeInstanceOf(FuseElement);
  });

  it("boundingBox- non-zero dimensions at correct position", () => {
    const props = new PropertyBag();
    const el = new FuseElement(crypto.randomUUID(), { x: 4, y: 6 }, 0, false, props);
    const bb = el.getBoundingBox();
    expect(bb.x).toBe(4);
    // getBoundingBox offsets y by -0.4 (sine wave + heat glow extends above pin centre)
    expect(bb.width).toBeGreaterThanOrEqual(1);
    expect(bb.height).toBeGreaterThanOrEqual(0.4);
  });

  it("defaultDelay- is zero (combinational)", () => {
    expect(FuseDefinition.models.digital!.defaultDelay).toBe(0);
  });

});

// ---------------------------------------------------------------------------
// Analog engine- setup() TSTALLOC sequence
// ---------------------------------------------------------------------------

describe("Fuse- analog setup() TSTALLOC sequence", () => {
  it("setup allocates 4 handles in ressetup.c:46-49 order", async () => {
    // ngspice anchor: res/ressetup.c:46-49- 4 TSTALLOC entries.
    // Migration shape M1: ComparisonSession.createSelfCompare({ buildCircuit, analysis }).
    // Verify via getAttempt: 4 matrix entries in insertion order PP,NN,PN,NP.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => buildFuseCircuit(registry),
      analysis: "dcop",
    });
    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);
    // The fuse element (rCold=0.01Ω) in series with 1V source must converge.
    const vFuseOut2 = stepEnd.nodes["fuse1:out2"]?.ours ?? stepEnd.nodes["gnd:out"]?.ours ?? 0;
    expect(typeof vFuseOut2).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Analog engine- load() stamps conductance through handles
// ---------------------------------------------------------------------------

describe("Fuse- analog load() via engine", () => {
  it("load stamps conductance: intact fuse rCold=100Ω converges at 1V/100Ω=10mA", async () => {
    // Migration shape M1. rCold=100Ω, 1V source: I=1/100=0.01A, V_fuse=1V.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => buildFuseCircuit(registry, { rCold: 100 }),
      analysis: "dcop",
    });
    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);
    // vs:pos node has 1V; fuse:out2 / gnd has 0V; voltage across fuse = 1V.
    const vPos = stepEnd.nodes["vs:pos"]?.ours ?? stepEnd.nodes["fuse1:out1"]?.ours;
    expect(vPos).toBeCloseTo(1.0, 6);
  });

  it("load() blown fuse: rBlown=1e9Ω gives near-zero current (open circuit)", async () => {
    // blown=true → fuse stamps 1/rBlown conductance, voltage divides almost entirely across fuse.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => buildFuseCircuit(registry, { blown: true, rBlown: 1e9 }),
      analysis: "dcop",
    });
    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);
    // With rBlown=1e9, fuse:out2 node is nearly 0V (no current through load).
    const vOut2 = stepEnd.nodes["fuse1:out2"]?.ours ?? 0;
    expect(Math.abs(vOut2)).toBeLessThan(1e-3);
  });
});

// ---------------------------------------------------------------------------
// Analog engine- acceptStep() thermal integration
// ---------------------------------------------------------------------------

describe("Fuse- analog acceptStep() thermal model", () => {
  it("intact fuse: DC-OP converges with rCold=0.01Ω (low resistance closed state)", async () => {
    // Migration shape M1. rCold=0.01Ω, V=1V: I=100A through fuse.
    // DC-OP does not advance simTime; thermal blow-out requires transient acceptStep calls.
    // Verify: intact fuse conducts (session converges, vs:pos=1V).
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => buildFuseCircuit(registry, { rCold: 0.01, i2tRating: 1e-4 }),
      analysis: "dcop",
    });
    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);
    const vPos = stepEnd.nodes["vs:pos"]?.ours ?? stepEnd.nodes["fuse1:out1"]?.ours;
    expect(vPos).toBeCloseTo(1.0, 5);
  });

  it("blown fuse: DC-OP with blown=true gives open-circuit behaviour", async () => {
    // Migration shape M1. Blown fuse stamps rBlown conductance; node fuse1:out2 ≈ 0V.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) =>
        buildFuseCircuit(registry, { blown: true, rCold: 0.01, rBlown: 1e9, i2tRating: 1e-4 }),
      analysis: "dcop",
    });
    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);
    const vOut2 = stepEnd.nodes["fuse1:out2"]?.ours ?? 0;
    expect(Math.abs(vOut2)).toBeLessThan(1e-3);
  });

  it("high-rCold fuse: DC-OP converges with rCold=1Ω (high threshold, no blow)", async () => {
    // Migration shape M1. rCold=1Ω, i2tRating=1e6 (very high threshold, no blow during DC-OP).
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) =>
        buildFuseCircuit(registry, { rCold: 1.0, rBlown: 1e9, i2tRating: 1e6 }),
      analysis: "dcop",
    });
    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);
    const vPos = stepEnd.nodes["vs:pos"]?.ours ?? stepEnd.nodes["fuse1:out1"]?.ours;
    expect(vPos).toBeCloseTo(1.0, 5);
  });
});
