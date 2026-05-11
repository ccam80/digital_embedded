/**
 * Category 4 -- Parameter hot-load (T1) for the Transformer netlist composite.
 *
 * Verifies that hot-loading k, L1, and L2 via setParam triggers
 * MUTfactor recomputation and that subsequent NR convergence reflects the
 * new operating point. Uses the canonical T1 buildFixture API.
 *
 * Voltage-shift assertions sample peak |vSec| over a full AC period *after*
 * a settle window so the step-induced transient from the hot-load has
 * dissipated; the contract is "settled operating point shifted in the
 * expected direction" -- not "instantaneous voltage one step after the
 * setParam call".
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Transformer hot-load k, L1, L2 via setParam (T1 Category 4)", () => {
  it("hotload_k_recomputes_mutFactor_and_shifts_secondary_voltage", () => {
    // tStop must cover: 1.5ms initial settle + 1ms pre-sample + 3ms post-hot-load
    // settle + 1ms post-sample = 6.5ms; give 8ms headroom.
    const fix = buildFixture({
      build: (_r, facade) => buildAcBench(facade, {
        amplitude: 5, frequency: 1000, rLoad: 100,
        primaryInductance: 1e-3, couplingCoefficient: 0.99,
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
    fix.coordinator.setComponentProperty(getTransformerCe(fix), "k", 0.50);

    const mutFactorAfter = mutEl.mutFactor;

    // MUTfactor must have recomputed (primary spec contract for this test):
    // k dropped 0.99 -> 0.50, so MUTfactor = k*sqrt(L1*L2) drops in the
    // same ratio.
    expect(mutFactorAfter).toBeLessThan(mutFactorBefore);
    expect(mutFactorAfter / mutFactorBefore).toBeCloseTo(0.50 / 0.99, 6);

    // 4) Settle the step-induced transient from the abrupt k change (3 cycles).
    stepUntil(fix, 5.5e-3);
    // 5) Sample peak |vSec| over a full AC period (1ms) at the NEW k.
    const peakAfter = samplePeakAbs(fix, s1Node, 6.5e-3);

    // Both peaks must be physically sensible AC amplitudes (non-zero, not NaN).
    expect(peakBefore).toBeGreaterThan(0);
    expect(peakAfter).toBeGreaterThan(0);
    expect(Number.isFinite(peakBefore)).toBe(true);
    expect(Number.isFinite(peakAfter)).toBe(true);

    // Lower k reduces energy coupled to the secondary; settled peak amplitude
    // must have shifted in that direction. Strict monotone, no ratio cap.
    expect(peakAfter).toBeLessThan(peakBefore);
  });

  it("hotload_L1_via_inductor_setParam_recomputes_mutFactor", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAcBench(facade, {
        amplitude: 5, frequency: 1000, rLoad: 100,
        primaryInductance: 1e-3, couplingCoefficient: 0.99,
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
    l1El.setParam("inductance", 4e-3);
    // Engine temperature pass re-applies factor*SCALE/M; matches
    // setComponentProperty contract.
    fix.coordinator.getAnalogEngine()!.configure({});

    const l1After = l1El.inductance;
    const mutFactorAfter = mutEl.mutFactor;

    expect(l1Before).toBeCloseTo(1e-3, 12);
    expect(l1After).toBeCloseTo(4e-3, 12);

    // MUTfactor = k*sqrt(L1*L2). L1 quadrupled (1mH->4mH) while L2 stays
    // at 1mH (1:1 turns ratio), so MUTfactor doubles.
    expect(mutFactorAfter).toBeCloseTo(mutFactorBefore * 2, 6);

    // Settle the step-induced transient (3 cycles) before sampling.
    stepUntil(fix, 5.5e-3);
    const peakAfter = samplePeakAbs(fix, s1Node, 6.5e-3);

    expect(peakBefore).toBeGreaterThan(0);
    expect(peakAfter).toBeGreaterThan(0);
    expect(Number.isFinite(peakBefore)).toBe(true);
    expect(Number.isFinite(peakAfter)).toBe(true);

    // Operating point shifted: settled peak amplitude is not equal to the
    // pre-hot-load peak. No magnitude-direction claim here -- doubling
    // MUTfactor by raising L1 affects the secondary amplitude through both
    // ideal transformer ratio and finite-Q impedance, and the net direction
    // depends on circuit Q which is not the spec contract for this test.
    expect(peakAfter).not.toBeCloseTo(peakBefore, 6);
  });

  it("hotload_L2_via_inductor_setParam_recomputes_mutFactor", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAcBench(facade, {
        amplitude: 5, frequency: 1000, rLoad: 100,
        primaryInductance: 1e-3, couplingCoefficient: 0.99,
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

    l2El.setParam("inductance", 4e-3);
    fix.coordinator.getAnalogEngine()!.configure({});

    const l2After = l2El.inductance;
    const mutFactorAfter = mutEl.mutFactor;

    expect(l2Before).toBeCloseTo(1e-3, 12);
    expect(l2After).toBeCloseTo(4e-3, 12);

    // MUTfactor doubles: sqrt(1e-3 * 4e-3) vs sqrt(1e-3 * 1e-3).
    expect(mutFactorAfter).toBeCloseTo(mutFactorBefore * 2, 6);

    stepUntil(fix, 5.5e-3);
    const peakAfter = samplePeakAbs(fix, s1Node, 6.5e-3);

    expect(peakBefore).toBeGreaterThan(0);
    expect(peakAfter).toBeGreaterThan(0);
    expect(Number.isFinite(peakBefore)).toBe(true);
    expect(Number.isFinite(peakAfter)).toBe(true);

    expect(peakAfter).not.toBeCloseTo(peakBefore, 6);
  });

  it("hotload_k_then_L1_then_L2_in_sequence_each_shifts_mutFactor", () => {
    // Sequential hot-loads: each one needs its own settle+sample window.
    // 1.5ms initial settle + 1ms sample + 3 * (3ms settle + 1ms sample) = 14.5ms.
    const fix = buildFixture({
      build: (_r, facade) => buildAcBench(facade, {
        amplitude: 5, frequency: 1000, rLoad: 100,
        primaryInductance: 1e-3, couplingCoefficient: 0.99,
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

    // Step 1: hot-load k from 0.99 to 0.50
    fix.coordinator.setComponentProperty(getTransformerCe(fix), "k", 0.50);
    const mutFactor1 = mutEl.mutFactor;
    stepUntil(fix, 5.5e-3);
    const peak1 = samplePeakAbs(fix, s1Node, 6.5e-3);

    expect(mutFactor1).not.toBeCloseTo(mutFactor0, 6);
    expect(peak1).not.toBeCloseTo(peak0, 6);

    // Step 2: hot-load L1 from 1mH to 2mH
    l1El.setParam("inductance", 2e-3);
    fix.coordinator.getAnalogEngine()!.configure({});
    const mutFactor2 = mutEl.mutFactor;
    stepUntil(fix, 9.5e-3);
    const peak2 = samplePeakAbs(fix, s1Node, 10.5e-3);

    expect(mutFactor2).not.toBeCloseTo(mutFactor1, 6);
    expect(peak2).not.toBeCloseTo(peak1, 6);

    // Step 3: hot-load L2 from 1mH to 2mH
    l2El.setParam("inductance", 2e-3);
    fix.coordinator.getAnalogEngine()!.configure({});
    const mutFactor3 = mutEl.mutFactor;
    stepUntil(fix, 13.5e-3);
    const peak3 = samplePeakAbs(fix, s1Node, 14.5e-3);

    expect(mutFactor3).not.toBeCloseTo(mutFactor2, 6);
    expect(peak3).not.toBeCloseTo(peak2, 6);

    // Final MUTfactor = 0.50 * sqrt(2e-3 * 2e-3) = 0.50 * 2e-3 = 1e-3
    expect(mutFactor3).toBeCloseTo(0.50 * Math.sqrt(2e-3 * 2e-3), 10);

    // All sampled peaks are physically sensible AC amplitudes.
    for (const p of [peak0, peak1, peak2, peak3]) {
      expect(p).toBeGreaterThan(0);
      expect(Number.isFinite(p)).toBe(true);
    }
  });
});
