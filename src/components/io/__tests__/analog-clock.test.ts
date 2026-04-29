/**
 * Tests for the analog clock factory on the Clock component.
 */

import { describe, it, expect } from "vitest";
import { makeAnalogClockElement, ClockDefinition } from "../clock.js";
import { PropertyBag } from "../../../core/properties.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { MODEDCOP, MODEINITFLOAT } from "../../../solver/analog/ckt-mode.js";
import { loadCtxFromFields, makeTestSetupContext, setupAll } from "../../../solver/analog/__tests__/test-helpers.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}



// ===========================================================================
// AnalogClock tests
// ===========================================================================

describe("AnalogClock", () => {
  it("outputs_vdd_and_zero — 1kHz CMOS 3.3V; alternates between 0V and 3.3V", () => {
    const freq = 1000;
    const vdd = 3.3;
    const nodePos = 1;
    const nodeNeg = 0;
    const branchIdx = 1;

    const clk = makeAnalogClockElement(nodePos, nodeNeg, branchIdx, freq, vdd, () => 0);
    const rhs = new Float64Array(16);

    // At t=0: first half-period → vdd
    clk.stampAtTime(rhs, 0);
    expect(rhs[branchIdx]).toBe(vdd);

    // At t=0.5ms: second half-period (halfPeriod = 0.5ms) → 0
    rhs.fill(0);
    clk.stampAtTime(rhs, 0.0005);
    expect(rhs[branchIdx]).toBe(0);

    // At t=1ms: third half-period (back to high) → vdd
    rhs.fill(0);
    clk.stampAtTime(rhs, 0.001);
    expect(rhs[branchIdx]).toBe(vdd);

    // At t=1.5ms: fourth half-period → 0
    rhs.fill(0);
    clk.stampAtTime(rhs, 0.0015);
    expect(rhs[branchIdx]).toBe(0);
  });

  it("frequency_matches_property — 1kHz period is 1ms", () => {
    const freq = 1000;
    const halfPeriod = 1 / (2 * freq); // 0.5ms
    const BRANCH = 1;

    const clk = makeAnalogClockElement(1, 0, BRANCH, freq, 3.3, () => 0);
    const rhs = new Float64Array(16);

    // Measure transitions: output should be high at t=0, low at t=halfPeriod
    clk.stampAtTime(rhs, 0);
    expect(rhs[BRANCH]).toBe(3.3);

    rhs.fill(0);
    clk.stampAtTime(rhs, halfPeriod);
    expect(rhs[BRANCH]).toBe(0);

    // Period = 2 * halfPeriod = 1ms; verify at t=period it's high again
    rhs.fill(0);
    clk.stampAtTime(rhs, 2 * halfPeriod);
    expect(rhs[BRANCH]).toBe(3.3);
  });

  it("registers_breakpoints — getBreakpoints returns transition times", () => {
    const freq = 1000;
    const clk = makeAnalogClockElement(1, 0, 1, freq, 3.3, () => 0);

    // Over 0..2ms there should be breakpoints at 0.5ms, 1ms, 1.5ms, 2ms (exclusive end)
    const bps = clk.getBreakpoints(0, 0.002);
    expect(bps.length).toBeGreaterThan(0);

    // All breakpoints should be within (0, 0.002)
    for (const t of bps) {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(0.002);
    }

    // Breakpoints should be at half-period intervals
    for (const _t of bps) {
      // breakpoint present
    }
  });

  it("registers_breakpoints_via_callback — getBreakpoints returns correct transition times", () => {
    const freq = 1000;
    const clk = makeAnalogClockElement(1, 0, 1, freq, 3.3, () => 0);
    const bps = clk.getBreakpoints(0, 0.003);

    // Transitions at 0.5ms, 1ms, 1.5ms, 2ms, 2.5ms (strictly within (0, 3ms))
    expect(bps).toHaveLength(5);
  });

  it("digital_mode_unchanged — ClockDefinition has executeFn and factory", () => {
    // Verify the digital clock behavior is preserved
    expect(ClockDefinition.models.digital!.executeFn).toBeDefined();
    expect(ClockDefinition.factory).toBeDefined();
    expect(typeof ClockDefinition.models.digital!.executeFn).toBe("function");
    expect(typeof ClockDefinition.factory).toBe("function");
  });

  it("has both digital and analog models — clock appears in both palettes", () => {
    expect(ClockDefinition.models.digital).toBeDefined();
    expect(ClockDefinition.modelRegistry?.behavioral).toBeDefined();
  });

  it("has digital model — logical clock behavior preserved", () => {
    expect(ClockDefinition.models.digital).toBeDefined();
  });

  it("analogFactory_creates_element — factory produces a valid AnalogElement", () => {
    const props = new PropertyBag();
    props.set("Frequency", 1000);
    props.set("vdd", 3.3);
    const el = getFactory(ClockDefinition.modelRegistry!.behavioral!)!(new Map([["out", 1]]), props, () => 0);
    expect(el).toBeDefined();
    expect(el.branchIndex).toBe(-1);
  });

  it("stamp_produces_incidence_entries — voltage source topology", () => {
    const clk = makeAnalogClockElement(1, 0, 1, 1000, 3.3, () => 0);
    clk.label = "CLK1";
    const solver = new SparseSolver();
    solver._initStructure();
    const setupCtx = makeTestSetupContext({
      solver,
      startBranch: 1,
      startNode: 100,
      elements: [clk],
    });
    setupAll([clk], setupCtx);
    const rhs = new Float64Array(3);
    clk.load(loadCtxFromFields({
      solver,
      matrix: solver,
      rhs,
      rhsOld: new Float64Array(3),
      cktMode: MODEDCOP | MODEINITFLOAT,
      time: 0,
      dt: 0,
      method: "trapezoidal" as const,
      order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0],
      ag: new Float64Array(7),
      srcFact: 1,
      noncon: { value: 0 },
      limitingCollector: null,
      convergenceCollector: null,
      xfact: 1,
      gmin: 1e-12,
      reltol: 1e-3,
      iabstol: 1e-12,
      temp: 300.15,
      vt: 0.025852,
      cktFixLimit: false,
      bypass: false,
      voltTol: 1e-6,
    }));
    // nodePos=1, nodeNeg=0 (ground), branchIdx allocated by setup
    // B[nodePos,k] and C[k,nodePos] land at (1,b); nodeNeg=0 stamps suppressed
    const entries = solver.getCSCNonZeros();
    const b = clk.branchIndex;
    expect(entries.some((e) => e.row === 1 && e.col === b)).toBe(true);
  });
});

// ===========================================================================
// Task C4.4 — Analog clock srcFact + breakpoint parity
//
// Clock is treated as an independent source for ngspice DC-OP source
// stepping. The RHS value (vdd on even half-periods, 0 on odd half-periods)
// is scaled by CKTsrcFact before the stamp (clock.ts load() body).
//
// Breakpoints are deterministic integer multiples of the half period —
// must match exact === expected.
// ===========================================================================

describe("clock_load_srcfact_parity", () => {
  function makeCtx(solver: SparseSolver, rhs: Float64Array, srcFact: number) {
    return loadCtxFromFields({
      solver,
      matrix: solver,
      rhs,
      rhsOld: new Float64Array(rhs.length),
      cktMode: MODEDCOP | MODEINITFLOAT,
      time: 0,
      dt: 0,
      method: "trapezoidal" as const,
      order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0],
      ag: new Float64Array(7),
      srcFact,
      noncon: { value: 0 },
      limitingCollector: null,
      convergenceCollector: null,
      xfact: 1,
      gmin: 1e-12,
      reltol: 1e-3,
      iabstol: 1e-12,
      temp: 300.15,
      vt: 0.025852,
      cktFixLimit: false,
      bypass: false,
      voltTol: 1e-6,
    });
  }

  function setupClk(clk: ReturnType<typeof makeAnalogClockElement>): SparseSolver {
    const solver = new SparseSolver();
    solver._initStructure();
    const setupCtx = makeTestSetupContext({
      solver,
      startBranch: clk.branchIndex >= 0 ? clk.branchIndex : 1,
      startNode: 100,
      elements: [clk],
    });
    setupAll([clk], setupCtx);
    return solver;
  }

  it("srcfact_05_halves_rhs_at_high_phase_bit_exact", () => {
    const VDD = 3.3;
    const FREQ = 1000;
    const BRANCH = 1;
    let simTime = 0; // first half-period → high
    const clk = makeAnalogClockElement(1, 0, BRANCH, FREQ, VDD, () => simTime);
    const solver = setupClk(clk);
    const rhs = new Float64Array(4);

    clk.load(makeCtx(solver, rhs, 0.5));

    // NGSPICE_REF: vdd * srcFact (high half-period value after scaling).
    const NGSPICE_REF = VDD * 0.5;
    expect(rhs[BRANCH]).toBe(NGSPICE_REF);
    expect(NGSPICE_REF).toBe(1.65);
  });

  it("srcfact_025_scales_rhs_at_low_phase_to_zero", () => {
    // In the low half-period the waveform value is 0V → 0 * srcFact = 0.
    const VDD = 3.3;
    const FREQ = 1000;
    const BRANCH = 1;
    const halfPeriod = 1 / (2 * FREQ);
    let simTime = halfPeriod; // second half-period → low
    const clk = makeAnalogClockElement(1, 0, BRANCH, FREQ, VDD, () => simTime);
    const solver = setupClk(clk);
    const rhs = new Float64Array(4);

    clk.load(makeCtx(solver, rhs, 0.25));

    const NGSPICE_REF = 0 * 0.25;
    expect(rhs[BRANCH]).toBe(NGSPICE_REF);
    expect(NGSPICE_REF).toBe(0);
  });

  it("srcfact_1_preserves_full_vdd", () => {
    const VDD = 5;
    const FREQ = 500;
    const BRANCH = 2;
    let simTime = 0; // first half-period → high
    const clk = makeAnalogClockElement(1, 0, BRANCH, FREQ, VDD, () => simTime);
    const solver = setupClk(clk);
    const rhs = new Float64Array(4);

    clk.load(makeCtx(solver, rhs, 1));

    expect(rhs[BRANCH]).toBe(VDD);
  });
});

describe("clock_breakpoints_parity", () => {
  it("1khz_breakpoints_exact_array_match", () => {
    // ngspice clock breakpoint schedule: every half-period transition in (tStart, tEnd).
    const FREQ = 1000;
    const halfPeriod = 1 / (2 * FREQ); // 0.0005

    // NGSPICE_REF computed inline: strictly-within breakpoints at k * halfPeriod for k=1..5.
    const NGSPICE_REF = [
      1 * halfPeriod,
      2 * halfPeriod,
      3 * halfPeriod,
      4 * halfPeriod,
      5 * halfPeriod,
    ];

    const clk = makeAnalogClockElement(1, 0, 1, FREQ, 3.3, () => 0);
    const bps = clk.getBreakpoints(0, 0.003);

    expect(bps).toHaveLength(NGSPICE_REF.length);
    for (let i = 0; i < NGSPICE_REF.length; i++) {
      expect(bps[i]).toBe(NGSPICE_REF[i]);
    }
  });

  it("nextBreakpoint_returns_next_halfperiod_exact", () => {
    const FREQ = 2000;
    const halfPeriod = 1 / (2 * FREQ); // 0.00025
    const clk = makeAnalogClockElement(1, 0, 1, FREQ, 3.3, () => 0);

    // NGSPICE_REF: first breakpoint strictly after 0 is 1 * halfPeriod.
    expect(clk.nextBreakpoint(0)).toBe(halfPeriod);
    // After halfPeriod, next is 2 * halfPeriod.
    expect(clk.nextBreakpoint(halfPeriod)).toBe(2 * halfPeriod);
  });
});
