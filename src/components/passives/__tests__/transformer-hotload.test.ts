/**
 * Category 4 -- Parameter hot-load (T1) for the Transformer netlist composite.
 *
 * Verifies that hot-loading k, L1, and L2 via setParam triggers
 * MUTfactor recomputation and that subsequent NR convergence reflects the
 * new operating point. Uses the canonical T1 buildFixture API.
 *
 * Voltage assertions sample peak |vSec| over a full AC period *after*
 * a settle window so the step-induced transient from the hot-load has
 * dissipated. Each peak is compared against an analytic closed-form
 * expectation derived from the coupled-inductor voltage-divider formula.
 */

import { describe, it, expect } from "vitest";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { AnalogInductorElement } from "../inductor.js";
import { MutualInductorElement } from "../mutual-inductor.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { Circuit } from "../../../core/circuit.js";
import type { Fixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

// ---------------------------------------------------------------------------
// Circuit builder
// ---------------------------------------------------------------------------

interface AcBenchParams {
  amplitude: number;
  frequency: number;
  rLoad: number;
  primaryInductance: number;
  couplingCoefficient: number;
}

function buildAcBench(facade: DefaultSimulatorFacade, p: AcBenchParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "AcVoltageSource", props: {
          label: "VS", amplitude: p.amplitude, frequency: p.frequency,
      } },
      { id: "tx",  type: "Transformer", props: {
          label:               "TX1",
          model:               "behavioral",
          turnsRatio:          1.0,
          primaryInductance:   p.primaryInductance,
          couplingCoefficient: p.couplingCoefficient,
      } },
      { id: "rl",  type: "Resistor", props: { label: "RLOAD", resistance: p.rLoad } },
      { id: "gnd", type: "Ground",   props: { label: "GND" } },
    ],
    connections: [
      ["vs:pos",  "tx:P1"],
      ["vs:neg",  "gnd:out"],
      ["tx:P2",   "gnd:out"],
      ["tx:S1",   "rl:pos"],
      ["rl:neg",  "gnd:out"],
      ["tx:S2",   "gnd:out"],
    ],
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nodeOf(fix: Fixture, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label ${label} not found in labelToNodeId`);
  return n;
}

function getTransformerCe(fix: Fixture) {
  const idx = fix.circuit.elements.findIndex(
    (_e, i) => fix.elementLabels.get(i) === "TX1",
  );
  if (idx < 0) throw new Error("TX1 element not found by elementLabels");
  const ce = fix.circuit.elementToCircuitElement.get(idx);
  if (ce === undefined) throw new Error("TX1 elementToCircuitElement entry missing");
  return ce;
}

function getInductorElement(fix: Fixture, subLabel: string): AnalogInductorElement {
  for (let i = 0; i < fix.circuit.elements.length; i++) {
    const el = fix.circuit.elements[i]!;
    if (el instanceof AnalogInductorElement && el.label === subLabel) {
      return el;
    }
  }
  throw new Error(`AnalogInductorElement with label ${subLabel} not found`);
}

function getMutElement(fix: Fixture, subLabel: string): MutualInductorElement {
  for (let i = 0; i < fix.circuit.elements.length; i++) {
    const el = fix.circuit.elements[i]!;
    if (el instanceof MutualInductorElement && el.label === subLabel) {
      return el;
    }
  }
  throw new Error(`MutualInductorElement with label ${subLabel} not found`);
}

/** Step the coordinator until simTime >= targetTime. */
function stepUntil(fix: Fixture, targetTime: number): void {
  while (fix.engine.simTime < targetTime) fix.coordinator.step();
}

/**
 * Step the coordinator until simTime >= endTime, sampling |vAt(node)| at every
 * step and returning the peak seen. Use this for "settled AC peak" measures
 * after a settle window has dissipated the step-induced transient.
 */
function samplePeakAbs(fix: Fixture, node: number, endTime: number): number {
  let peak = 0;
  while (fix.engine.simTime < endTime) {
    fix.coordinator.step();
    const v = Math.abs(fix.engine.getNodeVoltage(node));
    if (v > peak) peak = v;
  }
  return peak;
}

/**
 * Closed-form secondary peak amplitude for the AC bench circuit.
 *
 * Topology: VS (amplitude A, freq f) drives P1 of L1; P2 = gnd.
 * Secondary: L2 from S2(gnd) to S1; R_LOAD from S1 to gnd.
 *
 * Coupled-inductor KVL with both dots at P1/S1. With load current I flowing
 * S1 -> R_LOAD -> gnd, the current entering the dotted S1 terminal is -I:
 *   V1 = jωL1·I1 - jωM·I
 *   V_S1 = jωM·I1 - jωL2·I = R·I    (KVL at the load)
 * Eliminating I1:
 *   V_load / V1 = jωM·R / (-ω²(L1·L2 - M²) + jωL1·R)
 * where M = k·√(L1·L2), so (L1·L2 - M²) = L1·L2·(1 - k²) -> 0 at k=1.
 *
 * Returns: |V2_peak| = amplitude · |V2/V1|
 */
function analyticSecondaryPeak(
  amplitude: number,
  frequency: number,
  k: number,
  l1: number,
  l2: number,
  rLoad: number,
): number {
  const omega = 2 * Math.PI * frequency;
  const M = k * Math.sqrt(l1 * l2);

  // Numerator magnitude: |jωM·R| = ωMR
  const numMag = omega * M * rLoad;

  // Denominator: -ω²(L1·L2 - M²) + j(ωL1·R)
  const denomRe = -(omega * omega * (l1 * l2 - M * M));
  const denomIm = omega * l1 * rLoad;
  const denomMag = Math.sqrt(denomRe * denomRe + denomIm * denomIm);

  return amplitude * numMag / denomMag;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Transformer hot-load k, L1, L2 via setParam (T1 Category 4)", () => {
  it("hotload_k_recomputes_mutFactor_and_shifts_secondary_voltage", () => {
    // tStop must cover: 1.5ms initial settle + 1ms pre-sample + 3ms post-hot-load
    // settle + 1ms post-sample = 6.5ms; give 8ms headroom.
    const AMPLITUDE = 5;
    const FREQ = 1000;
    const R_LOAD = 100;
    const L = 1e-3;
    const K_BEFORE = 0.99;
    const K_AFTER = 0.50;

    const fix = buildFixture({
      build: (_r, facade) => buildAcBench(facade, {
        amplitude: AMPLITUDE, frequency: FREQ, rLoad: R_LOAD,
        primaryInductance: L, couplingCoefficient: K_BEFORE,
      }),
      params: { tStop: 8e-3, maxTimeStep: 5e-6, uic: true },
    });

    const s1Node = nodeOf(fix, "TX1:S1");
    const mutEl = getMutElement(fix, "TX1:MUT");

    const mutFactorBefore = mutEl.mutFactor;

    // 1) Settle startup transient (1.5 cycles at 1kHz).
    stepUntil(fix, 1.5e-3);
    // 2) Sample peak |vSec| over a full AC period (1ms) at the OLD k.
    const peakBefore = samplePeakAbs(fix, s1Node, 2.5e-3);

    // 3) Hot-load k from 0.99 to 0.50 via setComponentProperty on the
    //    top-level TransformerElement. Routes through
    //    SubcircuitWrapperElement.setParam("k", 0.50) -> MutualInductorElement
    //    .setParam("k", 0.50) -> _coupling = 0.50 -> recomputeMutFactor().
    fix.coordinator.setComponentProperty(getTransformerCe(fix), "k", K_AFTER);

    const mutFactorAfter = mutEl.mutFactor;

    // MUTfactor must have recomputed (primary spec contract for this test):
    // k dropped 0.99 -> 0.50, so MUTfactor = k*sqrt(L1*L2) drops in the
    // same ratio.
    expect(mutFactorAfter).toBeLessThan(mutFactorBefore);
    expect(mutFactorAfter / mutFactorBefore).toBeCloseTo(K_AFTER / K_BEFORE, 6);

    // 4) Settle the step-induced transient from the abrupt k change (3 cycles).
    stepUntil(fix, 5.5e-3);
    // 5) Sample peak |vSec| over a full AC period (1ms) at the NEW k.
    const peakAfter = samplePeakAbs(fix, s1Node, 6.5e-3);

    // Analytic expectations from the closed-form coupled-inductor formula.
    const expectedBefore = analyticSecondaryPeak(AMPLITUDE, FREQ, K_BEFORE, L, L, R_LOAD);
    const expectedAfter  = analyticSecondaryPeak(AMPLITUDE, FREQ, K_AFTER,  L, L, R_LOAD);

    // Both settled peaks must match the analytic expectation to within 1%
    // (toBeCloseTo precision=2 => |difference| < 0.005).
    expect(peakBefore).toBeCloseTo(expectedBefore, 2);
    expect(peakAfter).toBeCloseTo(expectedAfter, 2);
  });

  it("hotload_L1_via_inductor_setParam_recomputes_mutFactor", () => {
    const AMPLITUDE = 5;
    const FREQ = 1000;
    const R_LOAD = 100;
    const L_INIT = 1e-3;
    const L1_AFTER = 4e-3;
    const K = 0.99;

    const fix = buildFixture({
      build: (_r, facade) => buildAcBench(facade, {
        amplitude: AMPLITUDE, frequency: FREQ, rLoad: R_LOAD,
        primaryInductance: L_INIT, couplingCoefficient: K,
      }),
      params: { tStop: 8e-3, maxTimeStep: 5e-6, uic: true },
    });

    const s1Node = nodeOf(fix, "TX1:S1");
    const l1El = getInductorElement(fix, "TX1:L1");
    const mutEl = getMutElement(fix, "TX1:MUT");

    const mutFactorBefore = mutEl.mutFactor;
    const l1Before = l1El.inductance;

    stepUntil(fix, 1.5e-3);
    const peakBefore = samplePeakAbs(fix, s1Node, 2.5e-3);

    // Hot-load L1 directly on the AnalogInductorElement.
    // setParam("inductance", 4e-3) sets _nominalL -> _effectiveL, then cascades
    // to all _mutSiblings via recomputeMutFactor().
    l1El.setParam("inductance", L1_AFTER);
    // Engine temperature pass re-applies factor*SCALE/M; matches
    // setComponentProperty contract.
    fix.coordinator.getAnalogEngine()!.configure({});

    const l1After = l1El.inductance;
    const mutFactorAfter = mutEl.mutFactor;

    expect(l1Before).toBeCloseTo(L_INIT, 12);
    expect(l1After).toBeCloseTo(L1_AFTER, 12);

    // MUTfactor = k*sqrt(L1*L2). L1 quadrupled (1mH->4mH) while L2 stays
    // at 1mH (1:1 turns ratio), so MUTfactor doubles.
    expect(mutFactorAfter).toBeCloseTo(mutFactorBefore * 2, 6);

    // Settle the step-induced transient (3 cycles) before sampling.
    stepUntil(fix, 5.5e-3);
    const peakAfter = samplePeakAbs(fix, s1Node, 6.5e-3);

    // Analytic expectations: before uses L1=L2=L_INIT; after uses L1=L1_AFTER, L2=L_INIT.
    const expectedBefore = analyticSecondaryPeak(AMPLITUDE, FREQ, K, L_INIT,   L_INIT, R_LOAD);
    const expectedAfter  = analyticSecondaryPeak(AMPLITUDE, FREQ, K, L1_AFTER, L_INIT, R_LOAD);

    expect(peakBefore).toBeCloseTo(expectedBefore, 2);
    expect(peakAfter).toBeCloseTo(expectedAfter, 2);
  });

  it("hotload_L2_via_inductor_setParam_recomputes_mutFactor", () => {
    const AMPLITUDE = 5;
    const FREQ = 1000;
    const R_LOAD = 100;
    const L_INIT = 1e-3;
    const L2_AFTER = 4e-3;
    const K = 0.99;

    const fix = buildFixture({
      build: (_r, facade) => buildAcBench(facade, {
        amplitude: AMPLITUDE, frequency: FREQ, rLoad: R_LOAD,
        primaryInductance: L_INIT, couplingCoefficient: K,
      }),
      params: { tStop: 8e-3, maxTimeStep: 5e-6, uic: true },
    });

    const s1Node = nodeOf(fix, "TX1:S1");
    const l2El = getInductorElement(fix, "TX1:L2");
    const mutEl = getMutElement(fix, "TX1:MUT");

    const mutFactorBefore = mutEl.mutFactor;
    const l2Before = l2El.inductance;

    stepUntil(fix, 1.5e-3);
    const peakBefore = samplePeakAbs(fix, s1Node, 2.5e-3);

    l2El.setParam("inductance", L2_AFTER);
    fix.coordinator.getAnalogEngine()!.configure({});

    const l2After = l2El.inductance;
    const mutFactorAfter = mutEl.mutFactor;

    expect(l2Before).toBeCloseTo(L_INIT, 12);
    expect(l2After).toBeCloseTo(L2_AFTER, 12);

    // MUTfactor doubles: sqrt(1e-3 * 4e-3) vs sqrt(1e-3 * 1e-3).
    expect(mutFactorAfter).toBeCloseTo(mutFactorBefore * 2, 6);

    stepUntil(fix, 5.5e-3);
    const peakAfter = samplePeakAbs(fix, s1Node, 6.5e-3);

    // Analytic expectations: before uses L1=L2=L_INIT; after uses L1=L_INIT, L2=L2_AFTER.
    const expectedBefore = analyticSecondaryPeak(AMPLITUDE, FREQ, K, L_INIT, L_INIT,   R_LOAD);
    const expectedAfter  = analyticSecondaryPeak(AMPLITUDE, FREQ, K, L_INIT, L2_AFTER, R_LOAD);

    expect(peakBefore).toBeCloseTo(expectedBefore, 2);
    expect(peakAfter).toBeCloseTo(expectedAfter, 2);
  });

  it("hotload_k_then_L1_then_L2_in_sequence_each_shifts_mutFactor", () => {
    // Sequential hot-loads: each one needs its own settle+sample window.
    // 1.5ms initial settle + 1ms sample + 3 * (3ms settle + 1ms sample) = 14.5ms.
    const AMPLITUDE = 5;
    const FREQ = 1000;
    const R_LOAD = 100;
    const K0 = 0.99;
    const K1 = 0.50;
    const L_INIT = 1e-3;
    const L1_NEW = 2e-3;
    const L2_NEW = 2e-3;

    const fix = buildFixture({
      build: (_r, facade) => buildAcBench(facade, {
        amplitude: AMPLITUDE, frequency: FREQ, rLoad: R_LOAD,
        primaryInductance: L_INIT, couplingCoefficient: K0,
      }),
      params: { tStop: 16e-3, maxTimeStep: 5e-6, uic: true },
    });

    const s1Node = nodeOf(fix, "TX1:S1");
    const l1El = getInductorElement(fix, "TX1:L1");
    const l2El = getInductorElement(fix, "TX1:L2");
    const mutEl = getMutElement(fix, "TX1:MUT");

    stepUntil(fix, 1.5e-3);
    const peak0 = samplePeakAbs(fix, s1Node, 2.5e-3);
    const mutFactor0 = mutEl.mutFactor;

    // Baseline peak matches analytic expectation at initial operating point.
    const expectedPeak0 = analyticSecondaryPeak(AMPLITUDE, FREQ, K0, L_INIT, L_INIT, R_LOAD);
    expect(peak0).toBeCloseTo(expectedPeak0, 2);

    // Step 1: hot-load k from 0.99 to 0.50
    fix.coordinator.setComponentProperty(getTransformerCe(fix), "k", K1);
    const mutFactor1 = mutEl.mutFactor;
    stepUntil(fix, 5.5e-3);
    const peak1 = samplePeakAbs(fix, s1Node, 6.5e-3);

    // MUTfactor after k change: K1*sqrt(L_INIT*L_INIT) — bit-exact computable.
    const expectedMutFactor1 = K1 * Math.sqrt(L_INIT * L_INIT);
    expect(mutFactor1).toBeCloseTo(expectedMutFactor1, 10);
    expect(mutFactor1).not.toBeCloseTo(mutFactor0, 6);
    // Secondary peak matches analytic expectation at this operating point.
    const expectedPeak1 = analyticSecondaryPeak(AMPLITUDE, FREQ, K1, L_INIT, L_INIT, R_LOAD);
    expect(peak1).toBeCloseTo(expectedPeak1, 2);

    // Step 2: hot-load L1 from 1mH to 2mH
    l1El.setParam("inductance", L1_NEW);
    fix.coordinator.getAnalogEngine()!.configure({});
    const mutFactor2 = mutEl.mutFactor;
    stepUntil(fix, 9.5e-3);
    const peak2 = samplePeakAbs(fix, s1Node, 10.5e-3);

    // MUTfactor after L1 change: K1*sqrt(L1_NEW*L_INIT) — bit-exact computable.
    const expectedMutFactor2 = K1 * Math.sqrt(L1_NEW * L_INIT);
    expect(mutFactor2).toBeCloseTo(expectedMutFactor2, 10);
    expect(mutFactor2).not.toBeCloseTo(mutFactor1, 6);
    // Secondary peak matches analytic expectation.
    const expectedPeak2 = analyticSecondaryPeak(AMPLITUDE, FREQ, K1, L1_NEW, L_INIT, R_LOAD);
    expect(peak2).toBeCloseTo(expectedPeak2, 2);

    // Step 3: hot-load L2 from 1mH to 2mH
    l2El.setParam("inductance", L2_NEW);
    fix.coordinator.getAnalogEngine()!.configure({});
    const mutFactor3 = mutEl.mutFactor;
    stepUntil(fix, 13.5e-3);
    const peak3 = samplePeakAbs(fix, s1Node, 14.5e-3);

    // Final MUTfactor = K1 * sqrt(L1_NEW * L2_NEW) = 0.50 * sqrt(2e-3 * 2e-3) = 1e-3.
    const expectedMutFactor3 = K1 * Math.sqrt(L1_NEW * L2_NEW);
    expect(mutFactor3).toBeCloseTo(expectedMutFactor3, 10);
    expect(mutFactor3).not.toBeCloseTo(mutFactor2, 6);
    // Secondary peak matches analytic expectation.
    const expectedPeak3 = analyticSecondaryPeak(AMPLITUDE, FREQ, K1, L1_NEW, L2_NEW, R_LOAD);
    expect(peak3).toBeCloseTo(expectedPeak3, 2);
  });
});
