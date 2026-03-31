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
  const stamps: Array<{ row: number; col: number; value: number }> = [];
  const rhs: Array<{ row: number; value: number }> = [];

  return {
    stamp: vi.fn((row: number, col: number, value: number) => {
      stamps.push({ row, col, value });
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

    const clk = makeAnalogClockElement(nodePos, nodeNeg, branchIdx, freq, vdd);
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

    const clk = makeAnalogClockElement(1, 0, 1, freq, 3.3);
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
    const clk = makeAnalogClockElement(1, 0, 1, freq, 3.3);

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
    const clk = makeAnalogClockElement(1, 0, 1, freq, 3.3);
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
    const clk = makeAnalogClockElement(1, 0, 1, 1000, 3.3);
    const solver = makeMockSolver();
    clk.stamp(solver as unknown as SparseSolver);
    // nodePos=1, nodeNeg=0 (ground), branchIdx=1
    // B[1,1] = stamp(0, 1, 1); C[1,1] = stamp(1, 0, 1)
    // nodeNeg=0 stamps suppressed
    expect(solver.stamp).toHaveBeenCalledWith(0, 1, 1); // B[nodePos, k]
    expect(solver.stamp).toHaveBeenCalledWith(1, 0, 1); // C[k, nodePos]
  });
});
