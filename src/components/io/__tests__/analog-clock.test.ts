/**
 * Tests for the analog clock factory on the Clock component.
 */

import { describe, it, expect, vi } from "vitest";
import { makeAnalogClockElement, ClockDefinition } from "../clock.js";
import { PropertyBag } from "../../../core/properties.js";
import type { SparseSolver } from "../../../solver/analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


// ---------------------------------------------------------------------------
// Mock solver
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function makeMockSolver() {
  const stamps: [number, number, number][] = [];
  const rhs: Array<{ row: number; value: number }> = [];

  return {
    allocElement: vi.fn((row: number, col: number) => {
      stamps.push([row, col, 0]);
      return stamps.length - 1;
    }),
    stampElement: vi.fn((h: number, v: number) => {
      stamps[h][2] += v;
    }),
    stampRHS: vi.fn((row: number, value: number) => {
      rhs.push({ row, value });
    }),
    _stamps: stamps,
    _rhs: rhs,
  };
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
    const solver = makeMockSolver();

    // At t=0: first half-period → vdd
    clk.stampAtTime(solver as unknown as SparseSolver, 0);
    expect(solver.stampRHS).toHaveBeenLastCalledWith(branchIdx, vdd);

    // At t=0.5ms: second half-period (halfPeriod = 0.5ms) → 0
    clk.stampAtTime(solver as unknown as SparseSolver, 0.0005);
    expect(solver.stampRHS).toHaveBeenLastCalledWith(branchIdx, 0);

    // At t=1ms: third half-period (back to high) → vdd
    clk.stampAtTime(solver as unknown as SparseSolver, 0.001);
    expect(solver.stampRHS).toHaveBeenLastCalledWith(branchIdx, vdd);

    // At t=1.5ms: fourth half-period → 0
    clk.stampAtTime(solver as unknown as SparseSolver, 0.0015);
    expect(solver.stampRHS).toHaveBeenLastCalledWith(branchIdx, 0);
  });

  it("frequency_matches_property — 1kHz period is 1ms", () => {
    const freq = 1000;
    const halfPeriod = 1 / (2 * freq); // 0.5ms

    const clk = makeAnalogClockElement(1, 0, 1, freq, 3.3, () => 0);
    const solver = makeMockSolver();

    // Measure transitions: output should be high at t=0, low at t=halfPeriod
    clk.stampAtTime(solver as unknown as SparseSolver, 0);
    const firstCall = solver._rhs[solver._rhs.length - 1];
    expect(firstCall.value).toBeCloseTo(3.3, 10);

    clk.stampAtTime(solver as unknown as SparseSolver, halfPeriod);
    const secondCall = solver._rhs[solver._rhs.length - 1];
    expect(secondCall.value).toBeCloseTo(0, 10);

    // Period = 2 * halfPeriod = 1ms; verify at t=period it's high again
    clk.stampAtTime(solver as unknown as SparseSolver, 2 * halfPeriod);
    const thirdCall = solver._rhs[solver._rhs.length - 1];
    expect(thirdCall.value).toBeCloseTo(3.3, 10);
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
    const halfPeriod = 1 / (2 * freq);
    for (const t of bps) {
      const n = Math.round(t / halfPeriod);
      expect(t).toBeCloseTo(n * halfPeriod, 10);
    }
  });

  it("registers_breakpoints_via_callback — getBreakpoints returns correct transition times", () => {
    const freq = 1000;
    const clk = makeAnalogClockElement(1, 0, 1, freq, 3.3, () => 0);
    const bps = clk.getBreakpoints(0, 0.003);

    // Transitions at 0.5ms, 1ms, 1.5ms, 2ms, 2.5ms (strictly within (0, 3ms))
    expect(bps).toHaveLength(5);
    expect(bps[0]).toBeCloseTo(0.0005, 10);
    expect(bps[1]).toBeCloseTo(0.001, 10);
    expect(bps[2]).toBeCloseTo(0.0015, 10);
    expect(bps[3]).toBeCloseTo(0.002, 10);
    expect(bps[4]).toBeCloseTo(0.0025, 10);
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
    const el = getFactory(ClockDefinition.modelRegistry!.behavioral!)!(new Map([["out", 1]]), [], 1, props, () => 0);
    expect(el).toBeDefined();
    expect(el.isNonlinear).toBe(false);
    expect(el.isReactive).toBe(false);
    expect(el.branchIndex).toBe(1);
  });

  it("stamp_produces_incidence_entries — voltage source topology", () => {
    const clk = makeAnalogClockElement(1, 0, 1, 1000, 3.3, () => 0);
    const solver = makeMockSolver();
    clk.load({
      solver: solver as unknown as SparseSolver,
      voltages: new Float64Array(3),
      iteration: 0,
      initMode: "initFloat" as const,
      dt: 0,
      method: "trapezoidal" as const,
      order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0],
      ag: new Float64Array(8),
      srcFact: 1,
      noncon: { value: 0 },
      limitingCollector: null,
      isDcOp: true,
      isTransient: false,

      isTransientDcop: false,

      isAc: false,
      xfact: 1,
      gmin: 1e-12,
      uic: false,
      reltol: 1e-3,
      iabstol: 1e-12,
    });
    // nodePos=1, nodeNeg=0 (ground), branchIdx=1
    // B[1,1] = allocElement(0, 1) → stampElement(h, 1)
    // C[1,1] = allocElement(1, 0) → stampElement(h, 1)
    // nodeNeg=0 stamps suppressed
    const stamps = solver._stamps;
    expect(stamps.some(([r, c, v]) => r === 0 && c === 1 && v === 1)).toBe(true); // B[nodePos, k]
    expect(stamps.some(([r, c, v]) => r === 1 && c === 0 && v === 1)).toBe(true); // C[k, nodePos]
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
  function makeCtx(solver: unknown, srcFact: number) {
    return {
      solver: solver as SparseSolver,
      voltages: new Float64Array(3),
      iteration: 0,
      initMode: "initFloat" as const,
      dt: 0,
      method: "trapezoidal" as const,
      order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0],
      ag: new Float64Array(8),
      srcFact,
      noncon: { value: 0 },
      limitingCollector: null,
      isDcOp: true,
      isTransient: false,

      isTransientDcop: false,

      isAc: false,
      xfact: 1,
      gmin: 1e-12,
      uic: false,
      reltol: 1e-3,
      iabstol: 1e-12,
    };
  }

  it("srcfact_05_halves_rhs_at_high_phase_bit_exact", () => {
    const VDD = 3.3;
    const FREQ = 1000;
    const BRANCH = 1;
    let simTime = 0; // first half-period → high
    const clk = makeAnalogClockElement(1, 0, BRANCH, FREQ, VDD, () => simTime);
    const solver = makeMockSolver();

    clk.load(makeCtx(solver, 0.5));

    // NGSPICE_REF: vdd * srcFact (high half-period value after scaling).
    const NGSPICE_REF = VDD * 0.5;
    expect(solver.stampRHS).toHaveBeenCalledWith(BRANCH, NGSPICE_REF);
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
    const solver = makeMockSolver();

    clk.load(makeCtx(solver, 0.25));

    const NGSPICE_REF = 0 * 0.25;
    expect(solver.stampRHS).toHaveBeenCalledWith(BRANCH, NGSPICE_REF);
    expect(NGSPICE_REF).toBe(0);
  });

  it("srcfact_1_preserves_full_vdd", () => {
    const VDD = 5;
    const FREQ = 500;
    const BRANCH = 2;
    let simTime = 0; // first half-period → high
    const clk = makeAnalogClockElement(1, 0, BRANCH, FREQ, VDD, () => simTime);
    const solver = makeMockSolver();

    clk.load(makeCtx(solver, 1));

    expect(solver.stampRHS).toHaveBeenCalledWith(BRANCH, VDD);
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
