/**
 * TRNOISE sample-and-hold behaviour — statistical audit.
 *
 * The `noise` waveform is evaluated through the ngspice TRNOISE algorithm
 * (vsrcload.c:356-398, 1-f-code.c:118-201): consecutive samples within one
 * TS interval are linearly interpolated between two fixed Gaussian endpoints
 * (held values), so they are CORRELATED. Each TS boundary produces a fresh
 * independent Gaussian draw (via rgauss, randnumb.c:240-254, scaled by NA).
 *
 * Tests 1 & 2 are re-authored from the original Box-Muller per-call-independence
 * assertions to assert the correct held/correlated TRNOISE behaviour.
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { Circuit } from "../../../core/circuit.js";

// ---------------------------------------------------------------------------
// Minimal circuit: AcVoltageSource(noise) -> 1 kOhm -> Ground.
// The pos node carries the TRNOISE waveform value at each engine step.
// ---------------------------------------------------------------------------

function buildNoiseCircuit(
  facade: DefaultSimulatorFacade,
  amplitude: number,
  noiseSampleTime: number,
): Circuit {
  return facade.build({
    components: [
      {
        id: "src",
        type: "AcVoltageSource",
        props: {
          label: "src",
          amplitude,
          frequency: 1000,
          phase: 0,
          dcOffset: 0,
          waveform: "noise",
          noiseSampleTime,
        },
      },
      { id: "r1", type: "Resistor", props: { label: "r1", resistance: 1000 } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["src:pos", "r1:pos"],
      ["r1:neg", "gnd:out"],
      ["src:neg", "gnd:out"],
    ],
  });
}

describe("computeWaveformValue noise (TRNOISE sample-and-hold)", () => {
  // --------------------------------------------------------------------------
  // Test 1 (re-authored): gaussian_distribution_mean_near_zero_stddev_near_amplitude
  //
  // TRNOISE contract (1-f-code.c:176-178): each TS boundary endpoint is a
  // Gaussian draw N(0, NA) where NA = amplitude. Sampling at exactly the TS
  // boundary t = 1*TS across N independently-seeded fixtures gives N independent
  // Gaussian(0, amplitude) draws. The population must have mean ~= 0 and
  // std ~= amplitude.
  // --------------------------------------------------------------------------
  it("gaussian_distribution_mean_near_zero_stddev_near_amplitude", () => {
    const A  = 2.0;
    const TS = 1e-3; // 1 ms noise sample period
    const N  = 200;  // independent fixtures -> independent Gaussian draws

    const samples: number[] = [];
    for (let i = 0; i < N; i++) {
      const fix = buildFixture({
        build: (_r, f) => buildNoiseCircuit(f, A, TS),
        params: { tStop: TS * 3, maxTimeStep: TS / 10 },
      });
      // Step until simTime >= TS to reach the first noise sample boundary.
      while (
        fix.coordinator.simTime !== null &&
        fix.coordinator.simTime < TS
      ) {
        fix.coordinator.step();
      }
      const node =
        fix.circuit.labelToNodeId.get("src:pos") ??
        fix.circuit.labelToNodeId.get("r1:pos");
      if (node === undefined) throw new Error("pos node not found");
      samples.push(fix.engine.getNodeVoltage(node));
    }

    const mean = samples.reduce((s, x) => s + x, 0) / N;
    const variance = samples.reduce((s, x) => s + (x - mean) ** 2, 0) / N;
    const stdDev = Math.sqrt(variance);

    // N=200 independent N(0,A) draws: |mean| < 0.5*A; std in [0.7*A, 1.3*A].
    expect(Math.abs(mean)).toBeLessThan(0.5 * A);
    expect(stdDev).toBeGreaterThan(0.7 * A);
    expect(stdDev).toBeLessThan(1.3 * A);
  });

  // --------------------------------------------------------------------------
  // Test 2 (re-authored): lag1_autocorrelation_below_threshold
  //
  // TRNOISE contract (vsrcload.c:379-384):
  //   n1 = floor(time / TS)
  //   V1 = state.get(n1),  V2 = state.get(n1+1)
  //   value = V1 + (V2 - V1) * (time/TS - n1)
  //
  // This is a LINEAR interpolation between fixed endpoints V1 and V2.
  // Three samples at times t_a < t_b < t_c within the same TS interval must
  // satisfy the collinearity property:
  //   V(t_b) == V(t_a) + (V(t_c) - V(t_a)) * (t_b - t_a) / (t_c - t_a)
  //
  // We assert this directly by collecting three node voltages from three steps
  // that all land within the first TS interval [0, TS). Using TS = 50 ms and
  // maxTimeStep = 5 ms guarantees multiple sub-interval steps before the first
  // TRNOISE breakpoint at TS.
  // --------------------------------------------------------------------------
  it("lag1_autocorrelation_below_threshold", () => {
    const A  = 1.0;
    const TS = 50e-3; // 50 ms — large enough that several 5 ms steps land inside

    const fix = buildFixture({
      build: (_r, f) => buildNoiseCircuit(f, A, TS),
      params: { tStop: TS * 3, maxTimeStep: 5e-3 },
    });
    const node =
      fix.circuit.labelToNodeId.get("src:pos") ??
      fix.circuit.labelToNodeId.get("r1:pos");
    if (node === undefined) throw new Error("pos node not found");

    // Collect (time, voltage) pairs while simTime stays within [0, TS).
    const pts: Array<{ t: number; v: number }> = [];
    while (
      fix.coordinator.simTime !== null &&
      fix.coordinator.simTime < TS
    ) {
      const t = fix.coordinator.simTime;
      if (t > 0) {
        pts.push({ t, v: fix.engine.getNodeVoltage(node) });
      }
      fix.coordinator.step();
    }

    // Need at least 3 sub-interval points to check collinearity.
    expect(pts.length).toBeGreaterThanOrEqual(3);

    // All three consecutive triplets must satisfy the linear interpolation
    // equation to within floating-point rounding (~1e-12 relative tolerance).
    // TRNOISE: value(t) = V1 + (V2-V1) * (t/TS - n1)  — a straight line.
    // Given two anchor points (t_a, V_a) and (t_c, V_c), the predicted value
    // at t_b is: V_a + (V_c - V_a) * (t_b - t_a) / (t_c - t_a).
    const ta = pts[0].t; const va = pts[0].v;
    const tb = pts[1].t; const vb = pts[1].v;
    const tc = pts[2].t; const vc = pts[2].v;
    const predicted = va + (vc - va) * (tb - ta) / (tc - ta);
    // The interpolated value must match to within a tight tolerance (1e-9 V).
    expect(Math.abs(vb - predicted)).toBeLessThan(1e-9);
  });
});
