/**
 * Tests for CoupledInductorPair — mutual inductance companion model.
 *
 * Covers:
 *   - M = k·√(L₁·L₂) formula
 *   - Unity coupling transfers energy between windings
 *   - Zero coupling leaves inductors independent
 *   - Trapezoidal companion matrix entries (2L/h self, 2M/h cross)
 *   - BDF-2 companion matrix entries (3L/2h self, 3M/2h cross)
 */

import { describe, it, expect } from "vitest";
import { CoupledInductorPair } from "../coupled-inductor.js";
import type { CoupledInductorState } from "../coupled-inductor.js";
import type { SparseSolver } from "../sparse-solver.js";

// ---------------------------------------------------------------------------
// Stub solver
// ---------------------------------------------------------------------------

interface StampCall {
  row: number;
  col: number;
  value: number;
}

interface RHSCall {
  row: number;
  value: number;
}

function makeStubSolver(): { solver: SparseSolver; stamps: StampCall[]; rhs: RHSCall[] } {
  const stamps: StampCall[] = [];
  const rhs: RHSCall[] = [];
  const solver: SparseSolver = {
    stamp: (row, col, value) => stamps.push({ row, col, value }),
    stampRHS: (row, value) => rhs.push({ row, value }),
    beginAssembly: () => {},
    finalize: () => {},
    solve: () => new Float64Array(0),
  };
  return { solver, stamps, rhs };
}

// ---------------------------------------------------------------------------
// Helper: zero state
// ---------------------------------------------------------------------------

function zeroState(): CoupledInductorState {
  return {
    prevI1: 0,
    prevI2: 0,
    prevV1: 0,
    prevV2: 0,
    prevPrevI1: 0,
    prevPrevI2: 0,
    prevPrevV1: 0,
    prevPrevV2: 0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Coupling", () => {
  it("mutual_inductance_formula — M = k·√(L₁·L₂)", () => {
    const pair = new CoupledInductorPair(1e-3, 4e-3, 0.95);
    // M = 0.95 · √(0.001 · 0.004) = 0.95 · 0.002 = 0.0019
    expect(pair.m).toBeCloseTo(0.95 * Math.sqrt(1e-3 * 4e-3), 10);
    expect(pair.m).toBeCloseTo(1.9e-3, 6);
  });

  it("unity_coupling_transfers_energy — voltage appears across L₂ proportional to √(L₂/L₁)", () => {
    // With k=1: M = √(L₁·L₂). For trapezoidal with a step in I₁ history,
    // the cross-term in branch2's history current equals (2M/h)·prevI1 which
    // acts as a voltage source proportional to turns ratio √(L₂/L₁).
    const L1 = 1e-3;
    const L2 = 4e-3; // turns ratio √(L2/L1) = 2
    const pair = new CoupledInductorPair(L1, L2, 1.0);

    expect(pair.m).toBeCloseTo(Math.sqrt(L1 * L2), 12);

    // Stamp with I1=1A history, I2=0, V1=0, V2=0
    const state: CoupledInductorState = {
      prevI1: 1.0,
      prevI2: 0.0,
      prevV1: 0.0,
      prevV2: 0.0,
    };
    const dt = 1e-4;
    const { solver, rhs } = makeStubSolver();

    // nodes1=[1,0], nodes2=[2,0], branch1=2, branch2=3 (1-based node IDs)
    pair.stampCompanion(solver, 2, 3, [1, 0], [2, 0], dt, "trapezoidal", state);

    // hist2 for trapezoidal: -(2L2/h)·prevI2 - (2M/h)·prevI1 - prevV2
    //   = 0 - (2·√(L1·L2)/h)·1 - 0
    //   = -(2·M/h)·1
    const g12 = (2 * pair.m) / dt;
    const hist2Entry = rhs.find((r) => r.row === 3);
    expect(hist2Entry).toBeDefined();
    // hist2 = -(2M/h)·prevI1 = -g12 (with prevI1=1, prevI2=0, prevV2=0)
    expect(hist2Entry!.value).toBeCloseTo(-g12, 6);

    // hist1 for trapezoidal: -(2L1/h)·prevI1 - (2M/h)·prevI2 - prevV1
    //   = -(2L1/h)·1 - 0 - 0
    const g11 = (2 * L1) / dt;
    const hist1Entry = rhs.find((r) => r.row === 2);
    expect(hist1Entry).toBeDefined();
    expect(hist1Entry!.value).toBeCloseTo(-g11, 6);
  });

  it("zero_coupling_independent — k=0 produces no cross-coupling terms", () => {
    const pair = new CoupledInductorPair(1e-3, 4e-3, 0.0);
    expect(pair.m).toBe(0);

    const state: CoupledInductorState = {
      prevI1: 2.0,
      prevI2: 3.0,
      prevV1: 1.0,
      prevV2: 0.5,
    };
    const dt = 1e-4;
    const { solver, stamps } = makeStubSolver();

    pair.stampCompanion(solver, 2, 3, [1, 0], [2, 0], dt, "trapezoidal", state);

    // With M=0, there should be no cross-coupling stamp between branch1 and branch2
    // i.e. no stamp(2, 3, ...) or stamp(3, 2, ...) — both should be zero value
    const cross12 = stamps.filter((s) => s.row === 2 && s.col === 3);
    const cross21 = stamps.filter((s) => s.row === 3 && s.col === 2);

    // Cross terms should be zero (or absent)
    for (const s of cross12) expect(Math.abs(s.value)).toBe(0);
    for (const s of cross21) expect(Math.abs(s.value)).toBe(0);
  });

  it("trapezoidal_companion_coefficients — 2L₁/h self, 2M/h cross terms", () => {
    const L1 = 2e-3;
    const L2 = 8e-3;
    const k = 0.5;
    const pair = new CoupledInductorPair(L1, L2, k);
    const dt = 1e-3;

    const { solver, stamps } = makeStubSolver();
    pair.stampCompanion(solver, 2, 3, [1, 0], [2, 0], dt, "trapezoidal", zeroState());

    // Self term for branch1: -g11 at (branch1, branch1) = -(2L1/h)
    const g11 = (2 * L1) / dt;
    const selfEntry1 = stamps.find((s) => s.row === 2 && s.col === 2);
    expect(selfEntry1).toBeDefined();
    expect(selfEntry1!.value).toBeCloseTo(-g11, 8);

    // Self term for branch2: -g22 at (branch2, branch2) = -(2L2/h)
    const g22 = (2 * L2) / dt;
    const selfEntry2 = stamps.find((s) => s.row === 3 && s.col === 3);
    expect(selfEntry2).toBeDefined();
    expect(selfEntry2!.value).toBeCloseTo(-g22, 8);

    // Cross term at (branch1, branch2): -(2M/h)
    const M = k * Math.sqrt(L1 * L2);
    const g12 = (2 * M) / dt;
    const crossEntry12 = stamps.find((s) => s.row === 2 && s.col === 3);
    expect(crossEntry12).toBeDefined();
    expect(crossEntry12!.value).toBeCloseTo(-g12, 8);

    // Cross term at (branch2, branch1): -(2M/h) (symmetric)
    const crossEntry21 = stamps.find((s) => s.row === 3 && s.col === 2);
    expect(crossEntry21).toBeDefined();
    expect(crossEntry21!.value).toBeCloseTo(-g12, 8);
  });

  it("bdf2_companion_coefficients — 3L/(2h) self, 3M/(2h) cross terms", () => {
    const L1 = 1e-3;
    const L2 = 1e-3;
    const k = 0.8;
    const pair = new CoupledInductorPair(L1, L2, k);
    const dt = 2e-4;

    const { solver, stamps } = makeStubSolver();
    pair.stampCompanion(solver, 4, 5, [1, 0], [2, 0], dt, "bdf2", zeroState());

    // Self coefficient for BDF-2: -(3L1/2h)
    const g11 = (3 * L1) / (2 * dt);
    const selfEntry1 = stamps.find((s) => s.row === 4 && s.col === 4);
    expect(selfEntry1).toBeDefined();
    expect(selfEntry1!.value).toBeCloseTo(-g11, 8);

    // Self coefficient for BDF-2: -(3L2/2h)
    const g22 = (3 * L2) / (2 * dt);
    const selfEntry2 = stamps.find((s) => s.row === 5 && s.col === 5);
    expect(selfEntry2).toBeDefined();
    expect(selfEntry2!.value).toBeCloseTo(-g22, 8);

    // Cross coefficient for BDF-2: -(3M/2h)
    const M = k * Math.sqrt(L1 * L2);
    const g12 = (3 * M) / (2 * dt);
    const crossEntry12 = stamps.find((s) => s.row === 4 && s.col === 5);
    expect(crossEntry12).toBeDefined();
    expect(crossEntry12!.value).toBeCloseTo(-g12, 8);

    const crossEntry21 = stamps.find((s) => s.row === 5 && s.col === 4);
    expect(crossEntry21).toBeDefined();
    expect(crossEntry21!.value).toBeCloseTo(-g12, 8);
  });
});
