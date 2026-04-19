/**
 * Tests for the current source component.
 */

import { describe, it, expect, vi } from "vitest";
import { makeCurrentSource, CurrentSourceDefinition, CURRENT_SOURCE_DEFAULTS } from "../current-source.js";
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

function makeMockSolver() {
  const stamps: [number, number, number][] = [];
  const rhs: Record<number, number> = {};

  const solver = {
    allocElement: vi.fn((row: number, col: number) => {
      stamps.push([row, col, 0]);
      return stamps.length - 1;
    }),
    stampElement: vi.fn((h: number, v: number) => {
      stamps[h][2] += v;
    }),
    stampRHS: vi.fn((row: number, value: number) => {
      rhs[row] = (rhs[row] ?? 0) + value;
    }),
    _stamps: stamps,
    _rhs: rhs,
  };

  return solver;
}

function makeMinimalCtx(solver: unknown) {
  return {
    solver: solver as SparseSolver,
    voltages: new Float64Array(4),
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
  };
}

// ---------------------------------------------------------------------------
// CurrentSource unit tests
// ---------------------------------------------------------------------------

describe("CurrentSource", () => {
  it("stamp_rhs_only", () => {
    // 10mA source: current flows from nodeNeg(2) to nodePos(1) through source
    const src = makeCurrentSource(1, 2, 0.01);
    const solver = makeMockSolver();

    src.load(makeMinimalCtx(solver));

    // No matrix stamps — current sources are RHS-only
    expect(solver.allocElement).toHaveBeenCalledTimes(0);

    // RHS[nodePos-1] += I  → RHS[0] += 0.01
    // RHS[nodeNeg-1] -= I  → RHS[1] -= 0.01
    expect(solver.stampRHS).toHaveBeenCalledTimes(2);
    expect(solver.stampRHS).toHaveBeenCalledWith(0,  0.01);
    expect(solver.stampRHS).toHaveBeenCalledWith(1, -0.01);
  });

  it("set_scale_modifies_current", () => {
    // ngspice vsrcload.c:54 — value = here->VSRCdcValue * ckt->CKTsrcFact
    // Sources read ctx.srcFact directly during load(); no per-element scale method.
    const src = makeCurrentSource(1, 2, 0.01);

    const solver = makeMockSolver();
    const ctx = { ...makeMinimalCtx(solver), srcFact: 0.3 };
    src.load(ctx);

    // No matrix stamps
    expect(solver.allocElement).toHaveBeenCalledTimes(0);

    // I * scale = 0.01 * 0.3 = 0.003
    expect(solver.stampRHS).toHaveBeenCalledWith(0,  0.003);
    expect(solver.stampRHS).toHaveBeenCalledWith(1, -0.003);
  });

  it("ground_node_rhs_suppressed", () => {
    // pos at node 1, neg at ground (0)
    const src = makeCurrentSource(1, 0, 0.01);
    const solver = makeMockSolver();

    src.load(makeMinimalCtx(solver));

    // Only one RHS entry (ground row suppressed)
    expect(solver.stampRHS).toHaveBeenCalledTimes(1);
    expect(solver.stampRHS).toHaveBeenCalledWith(0, 0.01);
  });

  it("branch_index_is_minus_one", () => {
    const src = makeCurrentSource(1, 2, 0.01);
    expect(src.branchIndex).toBe(-1);
  });

  it("is_not_nonlinear_or_reactive", () => {
    const src = makeCurrentSource(1, 2, 0.01);
    expect(src.isNonlinear).toBe(false);
    expect(src.isReactive).toBe(false);
  });

  it("definition_engine_type_analog", () => {
    expect(CurrentSourceDefinition.modelRegistry?.behavioral).toBeDefined();
  });

  it("definition_does_not_require_branch_row", () => {
    expect((CurrentSourceDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory;branchCount?:number}|undefined)?.branchCount).toBeFalsy();
  });

  it("default_current_from_analog_factory", () => {
    const props = new PropertyBag();
    props.replaceModelParams(CURRENT_SOURCE_DEFAULTS);
    const el = getFactory(CurrentSourceDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]),
      [],
      -1,
      props,
      () => 0,
    );

    const solver = makeMockSolver();
    el.load(makeMinimalCtx(solver));

    // Default current is 0.01 A
    expect(solver.stampRHS).toHaveBeenCalledWith(0,  0.01);
    expect(solver.stampRHS).toHaveBeenCalledWith(1, -0.01);
  });
});

// ===========================================================================
// Task C4.4 — Current source srcFact parity
//
// ngspice reference: cktload.c:96-136 + ISRCload.
// An independent current source stamps `I * CKTsrcFact` into nodePos row,
// `-I * CKTsrcFact` into nodeNeg row. RHS-only — no matrix entries.
// ===========================================================================

describe("isource_load_srcfact_parity", () => {
  it("srcfact_03_scales_rhs_bit_exact", () => {
    const CURRENT = 0.01;
    const SRC_FACT = 0.3;
    const src = makeCurrentSource(1, 2, CURRENT);
    const solver = makeMockSolver();

    const ctx = {
      solver: solver as unknown as SparseSolver,
      voltages: new Float64Array(3),
      iteration: 0,
      initMode: "initFloat" as const,
      dt: 0,
      method: "trapezoidal" as const,
      order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0],
      ag: new Float64Array(8),
      srcFact: SRC_FACT,
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

    src.load(ctx);

    // NGSPICE_REF: I * srcFact, bit-exact IEEE-754 product.
    const NGSPICE_REF_POS = CURRENT * SRC_FACT;
    const NGSPICE_REF_NEG = -(CURRENT * SRC_FACT);
    expect(solver.stampRHS).toHaveBeenCalledWith(0, NGSPICE_REF_POS);
    expect(solver.stampRHS).toHaveBeenCalledWith(1, NGSPICE_REF_NEG);
    // Zero matrix stamps (current source is RHS-only).
    expect(solver.allocElement).toHaveBeenCalledTimes(0);
    expect(NGSPICE_REF_POS).toBe(0.003);
  });

  it("srcfact_0_zeroes_rhs_both_rows", () => {
    const CURRENT = 0.015;
    const SRC_FACT = 0;
    const src = makeCurrentSource(1, 2, CURRENT);
    const solver = makeMockSolver();

    const ctx = {
      solver: solver as unknown as SparseSolver,
      voltages: new Float64Array(3),
      iteration: 0,
      initMode: "initJct" as const,
      dt: 0,
      method: "trapezoidal" as const,
      order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0],
      ag: new Float64Array(8),
      srcFact: SRC_FACT,
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

    src.load(ctx);

    expect(solver.stampRHS).toHaveBeenCalledWith(0, 0);
    expect(solver.stampRHS).toHaveBeenCalledWith(1, -0);
  });

  it("srcfact_1_preserves_full_current", () => {
    const CURRENT = 0.02;
    const src = makeCurrentSource(1, 0, CURRENT);
    const solver = makeMockSolver();

    const ctx = {
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
    };

    src.load(ctx);

    // pos only (neg is ground → suppressed).
    expect(solver.stampRHS).toHaveBeenCalledTimes(1);
    expect(solver.stampRHS).toHaveBeenCalledWith(0, CURRENT);
  });
});
