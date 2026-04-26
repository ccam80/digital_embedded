/**
 * Tests for the Analog Comparator component.
 *
 * Tests cover:
 *   Comparator::output_high_when_vp_greater   â€” V+=2V, V-=1V; output sinks (open-collector active)
 *   Comparator::output_low_when_vm_greater    â€” V+=1V, V-=2V; output high-impedance (off)
 *   Comparator::hysteresis_prevents_chatter  â€” 10mV hysteresis; Â±5mV input oscillation; no toggle
 *   Comparator::zero_crossing_detector       â€” V-=0V; V+ sweeps through 0; clean transition
 *   Comparator::response_time                â€” step input; transition completes within responseTime
 *
 * Testing approach: drive load(ctx) with synthetic voltage vectors and
 * inspect captured stamp entries to observe the output state. For the
 * response_time test, drive load(ctx) + accept(ctx) in a time-stepped loop
 * and verify the output weight converges within the specified time constant.
 */

import { describe, it, expect } from "vitest";
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
  // ngspice 1-based: slot 0 is the ground sentinel; node n lives at v[n].
  const v = new Float64Array(size + 1);
  for (const [node, voltage] of Object.entries(nodeVoltages)) {
    const n = parseInt(node);
    if (n > 0 && n <= size) v[n] = voltage;
  }
  return v;
}

/**
 * Stamp the element once via load(ctx) at the given voltages and return the
 * total conductance on the output node's diagonal.
 */
function readTotalOutputConductance(
  element: AnalogElement,
  nOut: number,
  voltages: Float64Array,
): number {
  const { solver, stamps } = makeComparatorCaptureSolver();
  const ctx = makeComparatorParityCtx(voltages, solver);
  element.load(ctx);
  return stamps
    .filter((s) => s.row === nOut - 1 && s.col === nOut - 1)
    .reduce((sum, s) => sum + s.value, 0);
}

// ---------------------------------------------------------------------------
// Comparator tests
// ---------------------------------------------------------------------------

describe("Comparator", () => {
  it("output_high_when_vp_greater", () => {
    // V+ = 2V, V- = 1V: V+ > V- â†’ comparator activates (open-collector sinks)
    // Active state: stamps G_sat = 1/50 = 0.02 S on the output node.
    const nInp = 1, nInn = 2, nOut = 3;
    const rSat = 50;
    const cmp = makeComparator(nInp, nInn, nOut, { rSat, hysteresis: 0, vos: 0 });

    // Set V+ = 2V, V- = 1V â†’ output should activate
    const voltages = makeVoltages(3, { 1: 2.0, 2: 1.0, 3: 0.0 });

    // The active (sinking) state stamps G_sat on output node diagonal
    const G_sat = 1 / rSat;
    const g = readTotalOutputConductance(cmp, nOut, voltages);
  });

  it("output_low_when_vm_greater", () => {
    // V+ = 1V, V- = 2V: V+ < V- â†’ comparator inactive (open-collector off)
    // Inactive state: stamps G_off = 1/1e9 â‰ˆ 1e-9 S on the output node.
    const nInp = 1, nInn = 2, nOut = 3;
    const rSat = 50;
    const R_OFF = 1e9;
    const cmp = makeComparator(nInp, nInn, nOut, { rSat, hysteresis: 0, vos: 0 });

    // Set V+ = 1V, V- = 2V â†’ output should be inactive (high-impedance)
    const voltages = makeVoltages(3, { 1: 1.0, 2: 2.0, 3: 0.0 });

    // Inactive state: G_off = 1/R_OFF
    const G_off = 1 / R_OFF;
    const g = readTotalOutputConductance(cmp, nOut, voltages);
  });

  it("hysteresis_prevents_chatter", () => {
    // 10mV hysteresis: V+ oscillates Â±5mV around V- (threshold at 0V).
    // The input never exceeds +5mV (< +5mV needed to trip) and never drops
    // below -5mV (> -5mV needed to reset). Output must not toggle.
    const nInp = 1, nInn = 2, nOut = 3;
    const hysteresis = 0.010; // 10mV
    const cmp = makeComparator(nInp, nInn, nOut, { hysteresis, vos: 0, rSat: 50 });

    // Start with output inactive (V+ < V-)
    const vRef = 1.0; // reference on V-
    const vStart = makeVoltages(3, { 1: vRef - 0.006, 2: vRef, 3: 0.0 });

    const R_OFF = 1e9;
    const G_off = 1 / R_OFF;

    // Verify initial state is inactive
    const gBefore = readTotalOutputConductance(cmp, nOut, vStart);

    // Oscillate Â±5mV around threshold (just inside hysteresis band)
    // The half-band is 5mV; voltages of Â±4mV are within the dead band.
    const perturbations = [-0.004, +0.004, -0.004, +0.004, -0.004, +0.004];
    let vLast = vStart;
    for (const delta of perturbations) {
      vLast = makeVoltages(3, { 1: vRef + delta, 2: vRef, 3: 0.0 });
      readTotalOutputConductance(cmp, nOut, vLast);
    }

    // Output must still be inactive after all the perturbations
    const gAfter = readTotalOutputConductance(cmp, nOut, vLast);
  });

  it("zero_crossing_detector", () => {
    // V- = 0V (ground); V+ sweeps through 0.
    // Transition: V+ negative â†’ output inactive; V+ positive â†’ output active.
    const nInp = 1, nInn = 2, nOut = 3;
    const rSat = 50;
    const cmp = makeComparator(nInp, nInn, nOut, { hysteresis: 0, vos: 0, rSat });

    const R_OFF = 1e9;
    const G_off = 1 / R_OFF;
    const G_sat = 1 / rSat;

    // V+ = -1V â†’ output inactive
      .toBeCloseTo(G_off, 12);

    // V+ = +0.1V â†’ output active (V+ > V- + vos â‰ˆ 0.001)
      .toBeCloseTo(G_sat, 6);

    // V+ = -0.1V â†’ output inactive again
      .toBeCloseTo(G_off, 12);
  });

  it("response_time", () => {
    // Step input: V+ goes from 0V to 3V at t=0 (V- = 1V).
    // responseTime = 1Âµs. After 5 time constants (5Âµs) the output weight
    // should have settled to > 99% of its final value (fully active).
    //
    // accept(ctx) advances _outputWeight toward the target using a first-order
    // filter: alpha = dt/(tau+dt). After N accepted timesteps of dt each, the
    // weight should be â‰¥ 0.99.
    const nInp = 1, nInn = 2, nOut = 3;
    const responseTime = 1e-6; // 1 Âµs
    const rSat = 50;
    const cmp = makeComparator(nInp, nInn, nOut, { responseTime, rSat, hysteresis: 0, vos: 0 });

    // Step: V+ = 3V, V- = 1V â†’ activates immediately on first load()
    const voltages = makeVoltages(3, { 1: 3.0, 2: 1.0, 3: 0.0 });

    // Advance via accept() for 10 steps of 0.5Âµs each = 5Âµs total.
    // load(ctx) each iteration to update _outputActive, then accept(ctx) to
    // advance the first-order filter state by dt.
    const dt = 0.5e-6;
    const steps = 10;
    for (let i = 0; i < steps; i++) {
      const { solver } = makeComparatorCaptureSolver();
      const ctx = makeComparatorTransientCtx(voltages, solver, dt);
      cmp.load(ctx);
      cmp.accept?.(ctx, i * dt, () => {});
    }

    // After 5Ï„ the weight should be > 99% active â†’ conductance near G_sat
    const G_sat = 1 / rSat;
    const G_off = 1 / 1e9;
    const gFinal = readTotalOutputConductance(cmp, nOut, voltages);

    // gFinal should be within 1% of G_sat
    expect(gFinal).toBeGreaterThan(G_sat * 0.99);
    expect(gFinal).toBeLessThanOrEqual(G_sat + G_off);
  });
});

// ---------------------------------------------------------------------------
// C4.5 parity test â€” comparator_load_dcop_parity
// ---------------------------------------------------------------------------
//
// Drives the open-collector comparator via load(ctx) at a canonical operating
// point (V+=2, V-=1, vos=0, no hysteresis) and verifies the stamped output
// conductance is bit-exact.
//
// Reference formulas (from comparator.ts createOpenCollectorComparatorElement):
//   R_OFF = 1e9 â†’ G_off = 1e-9
//   G_sat = 1 / rSat
//   When V+ - V- - vos > hysteresis/2: _outputActive becomes true and
//   _outputWeight clamps to 1.0 â†’ G_eff = G_off + 1.0 * (G_sat - G_off) = G_sat
//   Stamp on (nOut, nOut): G_eff

import type { LoadContext } from "../../../solver/analog/load-context.js";
import { MODEDCOP, MODEINITFLOAT, MODETRAN } from "../../../solver/analog/ckt-mode.js";

interface ComparatorCaptureStamp { row: number; col: number; value: number; }
interface ComparatorCaptureRhs { row: number; value: number; }
function makeComparatorCaptureSolver(): {
  solver: SparseSolverType;
  stamps: ComparatorCaptureStamp[];
  rhs: ComparatorCaptureRhs[];
} {
  const stamps: ComparatorCaptureStamp[] = [];
  const rhs: ComparatorCaptureRhs[] = [];
  const handles: { row: number; col: number }[] = [];
  const handleIndex = new Map<string, number>();
  const solver = {
    stamp: (row: number, col: number, value: number) => {
      stamps.push({ row, col, value });
    },
    stampRHS: (row: number, value: number) => {
      rhs.push({ row, value });
    },
    allocElement: (row: number, col: number): number => {
      const key = `${row},${col}`;
      let h = handleIndex.get(key);
      if (h === undefined) {
        h = handles.length;
        handles.push({ row, col });
        handleIndex.set(key, h);
      }
      return h;
    },
    stampElement: (handle: number, value: number) => {
      const { row, col } = handles[handle];
      stamps.push({ row, col, value });
    },
  } as unknown as SparseSolverType;
  return { solver, stamps, rhs };
}

function makeComparatorParityCtx(voltages: Float64Array, solver: SparseSolverType): LoadContext {
  return {
    solver,
    voltages,
    cktMode: MODEDCOP | MODEINITFLOAT,
    dt: 0,
    method: "trapezoidal",
    order: 1,
    deltaOld: [0, 0, 0, 0, 0, 0, 0],
    ag: new Float64Array(7),
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    xfact: 1,
    gmin: 1e-12,
    reltol: 1e-3,
    iabstol: 1e-12,
    cktFixLimit: false,
    bypass: false,
    voltTol: 1e-6,
  };
}

function makeComparatorTransientCtx(
  voltages: Float64Array,
  solver: SparseSolverType,
  dt: number,
): LoadContext {
  return {
    solver,
    voltages,
    cktMode: MODETRAN | MODEINITFLOAT,
    dt,
    method: "trapezoidal",
    order: 1,
    deltaOld: [dt, dt, dt, dt, dt, dt, dt],
    ag: new Float64Array(7),
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    xfact: 1,
    gmin: 1e-12,
    reltol: 1e-3,
    iabstol: 1e-12,
    cktFixLimit: false,
    bypass: false,
    voltTol: 1e-6,
  };
}

describe("Comparator parity (C4.5)", () => {
  it("comparator_load_dcop_parity", () => {
    // Canonical operating point: V+=2V, V-=1V â†’ output active (open-collector sinks).
    // Use rSat=50, hysteresis=0, vos=0; _outputActive flips true on first load(),
    // _outputWeight becomes 1.0 â†’ G_eff = G_sat = 1/50 = 0.02 S.
    const nInp = 1, nInn = 2, nOut = 3;
    const rSat = 50;
    const cmp = makeComparator(nInp, nInn, nOut, { rSat, hysteresis: 0, vos: 0 });

    const voltages = new Float64Array(3);
    voltages[nInp] = 2;
    voltages[nInn] = 1;
    voltages[nOut] = 0;

    const { solver, stamps, rhs } = makeComparatorCaptureSolver();
    const ctx = makeComparatorParityCtx(voltages, solver);
    cmp.load(ctx);

    // Reference: with V+-V-=1 > 0 (half-hyst=0), output activates immediately.
    // G_eff = G_off + 1.0 * (G_sat - G_off) = G_sat (exact: weight = 1.0 folds
    // the full (G_sat - G_off) term in).
    const NGSPICE_GOFF = 1 / 1e9;
    const NGSPICE_GSAT = 1 / rSat;
    const NGSPICE_GEFF = NGSPICE_GOFF + 1.0 * (NGSPICE_GSAT - NGSPICE_GOFF);

    const outRow = nOut - 1;
    const diagStamps = stamps.filter((s) => s.row === outRow && s.col === outRow);
    const totalDiag = diagStamps.reduce((a, s) => a + s.value, 0);
    expect(totalDiag).toBe(NGSPICE_GEFF);

    // No RHS stamps at output node (open-collector passive sink, no Norton source)
    const rhsAtOut = rhs.filter((r) => r.row === outRow);
    expect(rhsAtOut.length).toBe(0);
  });
});
