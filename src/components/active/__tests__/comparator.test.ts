/**
 * Tests for the Analog Comparator component.
 *
 * Tests cover:
 *   Comparator::output_high_when_vp_greater   — V+=2V, V-=1V; output sinks (open-collector active)
 *   Comparator::output_low_when_vm_greater    — V+=1V, V-=2V; output high-impedance (off)
 *   Comparator::hysteresis_prevents_chatter  — 10mV hysteresis; ±5mV input oscillation; no toggle
 *   Comparator::zero_crossing_detector       — V-=0V; V+ sweeps through 0; clean transition
 *   Comparator::response_time                — step input; transition completes within responseTime
 *
 * Testing approach: drive updateOperatingPoint() with synthetic voltage vectors
 * and inspect stampNonlinear() calls to observe the output state. For the
 * response_time test, drive stampCompanion() in a time-stepped loop and verify
 * the output weight converges within the specified time constant.
 */

import { describe, it, expect, vi } from "vitest";
import { VoltageComparatorDefinition } from "../comparator.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockSolver() {
  return {
    stamp: vi.fn(),
    stampRHS: vi.fn(),
  } as unknown as SparseSolverType;
}

const COMPARATOR_MODEL_PARAM_KEYS = new Set(["hysteresis", "vos", "rSat", "responseTime"]);

function makeProps(overrides: Record<string, number | string> = {}): PropertyBag {
  const modelParams: Record<string, number> = {
    hysteresis: 0, vos: 0.001, rSat: 50, responseTime: 1e-6,
  };
  const staticEntries: [string, number | string][] = [["model", "open-collector"]];
  for (const [k, v] of Object.entries(overrides)) {
    if (COMPARATOR_MODEL_PARAM_KEYS.has(k)) {
      modelParams[k] = v as number;
    } else {
      staticEntries.push([k, v]);
    }
  }
  const bag = new PropertyBag(staticEntries);
  bag.replaceModelParams(modelParams);
  return bag;
}

function makeComparator(
  nInp: number,
  nInn: number,
  nOut: number,
  overrides: Record<string, number | string> = {},
): AnalogElement {
  return getFactory(VoltageComparatorDefinition.modelRegistry!["open-collector"]!)(
    new Map([["in+", nInp], ["in-", nInn], ["out", nOut]]),
    [],
    -1,
    makeProps(overrides),
    () => 0,
  ) as unknown as AnalogElement;
}

function makeVoltages(size: number, nodeVoltages: Record<number, number>): Float64Array {
  const v = new Float64Array(size);
  for (const [node, voltage] of Object.entries(nodeVoltages)) {
    const n = parseInt(node);
    if (n > 0 && n <= size) v[n - 1] = voltage;
  }
  return v;
}

/**
 * Get the total conductance after calling stampNonlinear (includes incremental updates).
 * Calls stamp() first to get the baseline, then stampNonlinear() to get the delta.
 */
function readTotalOutputConductance(element: AnalogElement, nOut: number): number {
  const solver = makeMockSolver();
  element.stamp(solver);
  element.stampNonlinear!(solver);
  const calls = (solver.stamp as ReturnType<typeof vi.fn>).mock.calls as number[][];
  return calls
    .filter((c) => c[0] === nOut - 1 && c[1] === nOut - 1)
    .reduce((sum, c) => sum + c[2], 0);
}

// ---------------------------------------------------------------------------
// Comparator tests
// ---------------------------------------------------------------------------

describe("Comparator", () => {
  it("output_high_when_vp_greater", () => {
    // V+ = 2V, V- = 1V: V+ > V- → comparator activates (open-collector sinks)
    // Active state: stamps G_sat = 1/50 = 0.02 S on the output node.
    const nInp = 1, nInn = 2, nOut = 3;
    const rSat = 50;
    const cmp = makeComparator(nInp, nInn, nOut, { rSat, hysteresis: 0, vos: 0 });

    // Set V+ = 2V, V- = 1V → output should activate
    const voltages = makeVoltages(3, { 1: 2.0, 2: 1.0, 3: 0.0 });
    cmp.updateOperatingPoint!(voltages);

    // The active (sinking) state stamps G_sat on output node diagonal
    const G_sat = 1 / rSat;
    const g = readTotalOutputConductance(cmp, nOut);
    expect(g).toBeCloseTo(G_sat, 6);
  });

  it("output_low_when_vm_greater", () => {
    // V+ = 1V, V- = 2V: V+ < V- → comparator inactive (open-collector off)
    // Inactive state: stamps G_off = 1/1e9 ≈ 1e-9 S on the output node.
    const nInp = 1, nInn = 2, nOut = 3;
    const rSat = 50;
    const R_OFF = 1e9;
    const cmp = makeComparator(nInp, nInn, nOut, { rSat, hysteresis: 0, vos: 0 });

    // Set V+ = 1V, V- = 2V → output should be inactive (high-impedance)
    const voltages = makeVoltages(3, { 1: 1.0, 2: 2.0, 3: 0.0 });
    cmp.updateOperatingPoint!(voltages);

    // Inactive state: G_off = 1/R_OFF
    const G_off = 1 / R_OFF;
    const g = readTotalOutputConductance(cmp, nOut);
    expect(g).toBeCloseTo(G_off, 15);
  });

  it("hysteresis_prevents_chatter", () => {
    // 10mV hysteresis: V+ oscillates ±5mV around V- (threshold at 0V).
    // The input never exceeds +5mV (< +5mV needed to trip) and never drops
    // below -5mV (> -5mV needed to reset). Output must not toggle.
    const nInp = 1, nInn = 2, nOut = 3;
    const hysteresis = 0.010; // 10mV
    const cmp = makeComparator(nInp, nInn, nOut, { hysteresis, vos: 0, rSat: 50 });

    // Start with output inactive (V+ < V-)
    const vRef = 1.0; // reference on V-
    const vStart = makeVoltages(3, { 1: vRef - 0.006, 2: vRef, 3: 0.0 });
    cmp.updateOperatingPoint!(vStart);

    const R_OFF = 1e9;
    const G_off = 1 / R_OFF;

    // Verify initial state is inactive
    const gBefore = readTotalOutputConductance(cmp, nOut);
    expect(gBefore).toBeCloseTo(G_off, 12);

    // Oscillate ±5mV around threshold (just inside hysteresis band)
    // The half-band is 5mV; voltages of ±4mV are within the dead band.
    const perturbations = [-0.004, +0.004, -0.004, +0.004, -0.004, +0.004];
    for (const delta of perturbations) {
      const v = makeVoltages(3, { 1: vRef + delta, 2: vRef, 3: 0.0 });
      cmp.updateOperatingPoint!(v);
    }

    // Output must still be inactive after all the perturbations
    const gAfter = readTotalOutputConductance(cmp, nOut);
    expect(gAfter).toBeCloseTo(G_off, 12);
  });

  it("zero_crossing_detector", () => {
    // V- = 0V (ground); V+ sweeps through 0.
    // Transition: V+ negative → output inactive; V+ positive → output active.
    const nInp = 1, nInn = 2, nOut = 3;
    const rSat = 50;
    const cmp = makeComparator(nInp, nInn, nOut, { hysteresis: 0, vos: 0, rSat });

    const R_OFF = 1e9;
    const G_off = 1 / R_OFF;
    const G_sat = 1 / rSat;

    // V+ = -1V → output inactive
    cmp.updateOperatingPoint!(makeVoltages(3, { 1: -1.0, 2: 0.0, 3: 0.0 }));
    expect(readTotalOutputConductance(cmp, nOut)).toBeCloseTo(G_off, 12);

    // V+ = +0.1V → output active (V+ > V- + vos ≈ 0.001)
    cmp.updateOperatingPoint!(makeVoltages(3, { 1: 0.1, 2: 0.0, 3: 0.0 }));
    expect(readTotalOutputConductance(cmp, nOut)).toBeCloseTo(G_sat, 6);

    // V+ = -0.1V → output inactive again
    cmp.updateOperatingPoint!(makeVoltages(3, { 1: -0.1, 2: 0.0, 3: 0.0 }));
    expect(readTotalOutputConductance(cmp, nOut)).toBeCloseTo(G_off, 12);
  });

  it("response_time", () => {
    // Step input: V+ goes from 0V to 3V at t=0 (V- = 1V).
    // responseTime = 1µs. After 5 time constants (5µs) the output weight
    // should have settled to > 99% of its final value (fully active).
    //
    // The stampCompanion method advances _outputWeight toward the target
    // using a first-order filter: alpha = dt/(tau+dt).
    // After N steps of dt each, the weight should be ≥ 0.99.
    const nInp = 1, nInn = 2, nOut = 3;
    const responseTime = 1e-6; // 1 µs
    const rSat = 50;
    const cmp = makeComparator(nInp, nInn, nOut, { responseTime, rSat, hysteresis: 0, vos: 0 });

    // Step: V+ = 3V, V- = 1V → activates immediately in updateOperatingPoint
    cmp.updateOperatingPoint!(makeVoltages(3, { 1: 3.0, 2: 1.0, 3: 0.0 }));

    // Step through time: 10 steps of 0.5µs each = 5µs total
    const dt = 0.5e-6;
    const steps = 10;
    const voltages = makeVoltages(3, { 1: 3.0, 2: 1.0, 3: 0.0 });
    for (let i = 0; i < steps; i++) {
      cmp.stampCompanion!(dt, "bdf1", voltages);
    }

    // After 5τ the weight should be > 99% active → conductance near G_sat
    const G_sat = 1 / rSat;
    const G_off = 1 / 1e9;
    const gFinal = readTotalOutputConductance(cmp, nOut);

    // gFinal should be within 1% of G_sat
    expect(gFinal).toBeGreaterThan(G_sat * 0.99);
    expect(gFinal).toBeLessThanOrEqual(G_sat + G_off);
  });
});
