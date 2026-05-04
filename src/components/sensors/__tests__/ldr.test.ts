/** Tests for the LDR (Light Dependent Resistor) component. */

import { describe, it, expect } from "vitest";
import {
  LDRElement,
  LDRDefinition,
  createLDRElement,
  LDR_DEFAULTS,
} from "../ldr.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory } from "../../../core/registry.js";
import { buildFixture, type Fixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

import type { AnalogFactory } from "../../../core/registry.js";
import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { CircuitElement } from "../../../core/element.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DividerParams {
  vSource: number;
  rSeries: number;
  rDark: number;
  luxRef: number;
  gamma: number;
  lux: number;
  ldrLabel?: string;
}

/**
 * Build a single-loop divider:
 *   Vsrc(pos) → r1(pos)─r1─r1(neg) → ldr:pos ─ LDR ─ ldr:neg → GND ← Vsrc(neg)
 *
 * Steady-state observable:
 *   V(ldr:pos) = Vsource · R_LDR / (rSeries + R_LDR)
 * where R_LDR = rDark · (lux/luxRef)^(-gamma) for lux > 0,
 *       R_LDR = rDark                          for lux = 0.
 */
function buildLDRDividerCircuit(facade: DefaultSimulatorFacade, p: DividerParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { label: "vs", voltage: p.vSource } },
      { id: "r1",  type: "Resistor",        props: { label: "r1", resistance: p.rSeries } },
      { id: "ldr", type: "LDR",             props: {
          label:  p.ldrLabel ?? "L1",
          rDark:  p.rDark,
          luxRef: p.luxRef,
          gamma:  p.gamma,
          lux:    p.lux,
      } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos",  "r1:pos"],
      ["r1:neg",  "ldr:pos"],
      ["ldr:neg", "gnd:out"],
      ["vs:neg",  "gnd:out"],
    ],
  });
}

function findLDR(elements: ReadonlyArray<unknown>): LDRElement {
  const idx = elements.findIndex((el) => el instanceof LDRElement);
  if (idx < 0) throw new Error("LDRElement not found in compiled circuit");
  return elements[idx] as LDRElement;
}

function nodeOf(fix: Fixture, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

function ceByLabel(fix: Fixture, label: string): CircuitElement {
  for (const ce of fix.circuit.elementToCircuitElement.values()) {
    if (ce.getProperties().getOrDefault<string>("label", "") === label) return ce;
  }
  throw new Error(`CircuitElement with label '${label}' not found`);
}

/** Closed-form LDR resistance: lux=0 → rDark; else rDark·(lux/luxRef)^(-gamma). */
function ldrResistance(rDark: number, luxRef: number, gamma: number, lux: number): number {
  if (lux <= 0) return rDark;
  return rDark * Math.pow(lux / luxRef, -gamma);
}

describe("LDR", () => {
  describe("definition", () => {
    it("LDRDefinition has behavioral inline factory", () => {
      const entry = LDRDefinition.modelRegistry?.behavioral;
      expect(entry).toBeDefined();
      expect(entry!.kind).toBe("inline");
    });

    it("LDRDefinition category is PASSIVES", () => {
      expect(LDRDefinition.category).toBe(ComponentCategory.PASSIVES);
    });

    it("LDRDefinition has rDark default 1e6", () => {
      const params = LDRDefinition.modelRegistry?.behavioral?.params;
      expect(params).toBeDefined();
      expect(params!["rDark"]).toBe(1e6);
    });

    it("analogFactory creates an LDRElement", () => {
      const props = new PropertyBag();
      props.replaceModelParams(LDR_DEFAULTS);
      const pinNodes = new Map<string, number>();
      pinNodes.set("pos", 1);
      pinNodes.set("neg", 2);
      const element = createLDRElement(pinNodes, props, () => 0);
      expect(element).toBeInstanceOf(LDRElement);
    });

    it("behavioral entry has no branchCount (pure two-terminal resistor shape)", () => {
      const entry = LDRDefinition.modelRegistry?.behavioral;
      if (!entry || entry.kind !== "inline") throw new Error("Expected inline behavioral entry");
      const branchCount = (entry as { kind: "inline"; factory: AnalogFactory; branchCount?: number }).branchCount;
      expect(branchCount).toBeFalsy();
    });
  });

  describe("resistance_shape", () => {
    function buildElement(rDark: number, luxRef: number, gamma: number, lux: number): LDRElement {
      const props = new PropertyBag();
      props.replaceModelParams(LDR_DEFAULTS);
      props.setModelParam("rDark", rDark);
      props.setModelParam("luxRef", luxRef);
      props.setModelParam("gamma", gamma);
      props.setModelParam("lux", lux);
      const pinNodes = new Map<string, number>();
      pinNodes.set("pos", 1);
      pinNodes.set("neg", 2);
      const el = createLDRElement(pinNodes, props, () => 0);
      return el as LDRElement;
    }

    it("lux=0 returns rDark (dark branch, not power law)", () => {
      const el = buildElement(1e6, 1000, 0.7, 0);
      expect(el.resistance()).toBe(1e6);
    });

    it("lux=0 with custom rDark returns that value", () => {
      const el = buildElement(500_000, 1000, 0.7, 0);
      expect(el.resistance()).toBe(500_000);
    });

    it("lux=luxRef gives R=rDark (power-law factor = 1)", () => {
      const el = buildElement(100, 1000, 0.7, 1000);
      expect(el.resistance()).toBeCloseTo(100, 9);
    });

    it("lower lux gives higher resistance than at reference", () => {
      const dim = buildElement(1e6, 1000, 0.7, 100);
      const ref = buildElement(1e6, 1000, 0.7, 1000);
      expect(dim.resistance()).toBeGreaterThan(ref.resistance());
    });

    it("higher lux gives lower resistance than at reference", () => {
      const bright = buildElement(1e6, 1000, 0.7, 5000);
      const ref    = buildElement(1e6, 1000, 0.7, 1000);
      expect(bright.resistance()).toBeLessThan(ref.resistance());
    });

    it("R(lux) matches closed-form rDark*(lux/luxRef)^(-gamma) at lux=100, luxRef=1000, gamma=0.7", () => {
      const el = buildElement(1e6, 1000, 0.7, 100);
      const expected = 1e6 * Math.pow(100 / 1000, -0.7);
      expect(el.resistance()).toBeCloseTo(expected, 6);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: Vsrc → R_series → LDR → GND divider on the public surface.
//
// At DCOP the LDR is a pure resistor with R(lux). The divider law gives
//   V(ldr:pos) = Vsrc · R_LDR / (rSeries + R_LDR).
// Reading V(ldr:pos) via `engine.getNodeVoltage(labelToNodeId.get("ldr:pos"))`
// confirms the LDR participates in the production compile + DCOP path with
// the documented R(lux) function. Bit-exact stamp values are in the ngspice
// harness parity suite.
// ---------------------------------------------------------------------------

describe("LDR_divider_dcop", () => {
  it("V(ldr:pos) = Vsrc · R_LDR / (rSeries + R_LDR) at lux=luxRef (R_LDR=rDark)", () => {
    // R_LDR = rDark · (1000/1000)^(-0.7) = rDark = 1kΩ.
    // Match rSeries to rDark for a clean 50% divider.
    const V       = 5;
    const rSeries = 1000;
    const rDark   = 1000;

    const fix = buildFixture({
      build: (_r, facade) => buildLDRDividerCircuit(facade, {
        vSource: V, rSeries, rDark, luxRef: 1000, gamma: 0.7, lux: 1000,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vLdrPos = fix.engine.getNodeVoltage(nodeOf(fix, "L1:pos"));
    const R_LDR = ldrResistance(rDark, 1000, 0.7, 1000);
    const expected = V * R_LDR / (rSeries + R_LDR);
    expect(vLdrPos).toBeCloseTo(expected, 6);
  });

  it("V(ldr:pos) tracks the closed-form divider at lux=100 (dim → high R_LDR)", () => {
    // R_LDR(lux=100, luxRef=1000, gamma=0.7) = 1e6 · (100/1000)^(-0.7) ≈ 5.012e6.
    // With rSeries=1MΩ the divider sits well above 50%.
    const V       = 5;
    const rSeries = 1e6;
    const rDark   = 1e6;
    const luxRef  = 1000;
    const gamma   = 0.7;
    const lux     = 100;

    const fix = buildFixture({
      build: (_r, facade) => buildLDRDividerCircuit(facade, {
        vSource: V, rSeries, rDark, luxRef, gamma, lux,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vLdrPos = fix.engine.getNodeVoltage(nodeOf(fix, "L1:pos"));
    const R_LDR = ldrResistance(rDark, luxRef, gamma, lux);
    const expected = V * R_LDR / (rSeries + R_LDR);
    expect(vLdrPos).toBeCloseTo(expected, 6);
  });

  it("V(ldr:pos) collapses toward 0 at lux=5000 (bright → low R_LDR)", () => {
    // R_LDR(lux=5000) = 1e6 · 5^(-0.7) ≈ 320kΩ; with rSeries=1MΩ the divider
    // pulls V(ldr:pos) below 25% of Vsrc.
    const V       = 5;
    const rSeries = 1e6;
    const rDark   = 1e6;
    const luxRef  = 1000;
    const gamma   = 0.7;
    const lux     = 5000;

    const fix = buildFixture({
      build: (_r, facade) => buildLDRDividerCircuit(facade, {
        vSource: V, rSeries, rDark, luxRef, gamma, lux,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vLdrPos = fix.engine.getNodeVoltage(nodeOf(fix, "L1:pos"));
    const R_LDR = ldrResistance(rDark, luxRef, gamma, lux);
    const expected = V * R_LDR / (rSeries + R_LDR);
    expect(vLdrPos).toBeCloseTo(expected, 6);
    expect(vLdrPos).toBeLessThan(V * 0.25);
  });
});

// ---------------------------------------------------------------------------
// Hot-loadable `lux`: setComponentProperty observable contract.
//
// The LDR's `lux` is a slider-driven runtime parameter. Mutating it via
// `coordinator.setComponentProperty(ce, "lux", value)` must propagate into
// the element's `_p.lux` (via `setParam`) so the next DCOP picks up the new
// R(lux). This is the same contract diode `IS`/`N` exercises and the
// project-wide "all model params hot-loadable via setParam" requirement.
// ---------------------------------------------------------------------------

describe("LDR_lux_hotloadable", () => {
  it("setComponentProperty('lux', higher) lowers R_LDR and lowers V(ldr:pos)", () => {
    const V       = 5;
    const rSeries = 1e6;
    const rDark   = 1e6;
    const luxRef  = 1000;
    const gamma   = 0.7;

    const fix = buildFixture({
      build: (_r, facade) => buildLDRDividerCircuit(facade, {
        vSource: V, rSeries, rDark, luxRef, gamma, lux: 100, // dim
      }),
    });

    const before = fix.coordinator.dcOperatingPoint()!;
    expect(before.converged).toBe(true);
    const vBefore = fix.engine.getNodeVoltage(nodeOf(fix, "L1:pos"));
    const expectedBefore = V * ldrResistance(rDark, luxRef, gamma, 100)
                         / (rSeries + ldrResistance(rDark, luxRef, gamma, 100));
    expect(vBefore).toBeCloseTo(expectedBefore, 6);

    // Bump lux up by 50× — R_LDR shrinks by a factor of 50^0.7 ≈ 16.
    fix.coordinator.setComponentProperty(ceByLabel(fix, "L1"), "lux", 5000);

    const after = fix.coordinator.dcOperatingPoint()!;
    expect(after.converged).toBe(true);
    const vAfter = fix.engine.getNodeVoltage(nodeOf(fix, "L1:pos"));
    const expectedAfter = V * ldrResistance(rDark, luxRef, gamma, 5000)
                        / (rSeries + ldrResistance(rDark, luxRef, gamma, 5000));
    expect(vAfter).toBeCloseTo(expectedAfter, 6);
    expect(vAfter).toBeLessThan(vBefore);
  });

  it("setComponentProperty('lux', 0) returns the dark-branch resistance R=rDark", () => {
    const V       = 5;
    const rSeries = 1e6;
    const rDark   = 1e6;
    const luxRef  = 1000;
    const gamma   = 0.7;

    const fix = buildFixture({
      build: (_r, facade) => buildLDRDividerCircuit(facade, {
        vSource: V, rSeries, rDark, luxRef, gamma, lux: 1000, // ref
      }),
    });

    fix.coordinator.setComponentProperty(ceByLabel(fix, "L1"), "lux", 0);

    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    const vLdrPos = fix.engine.getNodeVoltage(nodeOf(fix, "L1:pos"));
    // lux=0 takes the dark branch in resistance(): R_LDR = rDark.
    const expected = V * rDark / (rSeries + rDark);
    expect(vLdrPos).toBeCloseTo(expected, 6);

    // Sanity: also check the in-circuit element's resistance() reads rDark.
    const ldr = findLDR(fix.circuit.elements);
    expect(ldr.resistance()).toBe(rDark);
  });
});
