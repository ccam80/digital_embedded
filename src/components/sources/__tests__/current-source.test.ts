/**
 * Tests for the current source component.
 */

import { describe, it, expect, vi } from "vitest";
import { CurrentSourceDefinition, CURRENT_SOURCE_DEFAULTS } from "../current-source.js";
import { PropertyBag } from "../../../core/properties.js";
import type { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { MODEDCOP, MODEINITFLOAT, MODEINITJCT } from "../../../solver/analog/ckt-mode.js";
import { makeTestSetupContext, setupAll, loadCtxFromFields } from "../../../solver/analog/__tests__/test-helpers.js";

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

function makeMockSolver(rhsSize = 8) {
  const stamps: [number, number, number][] = [];
  const rhs = new Float64Array(rhsSize);

  const solver = {
    allocElement: vi.fn((row: number, col: number) => {
      stamps.push([row, col, 0]);
      return stamps.length - 1;
    }),
    stampElement: vi.fn((h: number, v: number) => {
      stamps[h][2] += v;
    }),
    _stamps: stamps,
    _rhs: rhs,
  };

  return solver;
}

function makeMinimalCtx(
  solver: ReturnType<typeof makeMockSolver>,
  overrides?: Partial<{ srcFact: number; cktMode: number }>,
) {
  return loadCtxFromFields({
    solver: solver as unknown as SparseSolver,
    matrix: solver as unknown as SparseSolver,
    rhs: solver._rhs,
    rhsOld: new Float64Array(solver._rhs.length),
    cktMode: overrides?.cktMode ?? (MODEDCOP | MODEINITFLOAT),
    time: 0,
    dt: 0,
    method: "trapezoidal" as const,
    order: 1,
    deltaOld: [0, 0, 0, 0, 0, 0, 0],
    ag: new Float64Array(7),
    srcFact: overrides?.srcFact ?? 1,
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

// ---------------------------------------------------------------------------
// Helper — build a current source element from pin map + current value
// ---------------------------------------------------------------------------

function makeCurrentSourceEl(nodePos: number, nodeNeg: number, current: number) {
  const props = new PropertyBag();
  props.replaceModelParams({ current });
  return getFactory(CurrentSourceDefinition.modelRegistry!.behavioral!)(
    new Map([["pos", nodePos], ["neg", nodeNeg]]),
    props,
    () => 0,
  );
}

// ---------------------------------------------------------------------------
// CurrentSource unit tests
// ---------------------------------------------------------------------------

describe("CurrentSource", () => {
  it("stamp_rhs_only", () => {
    // 10mA source: current flows from nodeNeg(2) to nodePos(1) through source
    const src = makeCurrentSourceEl(1, 2, 0.01);
    const solver = makeMockSolver();

    const setupCtx = makeTestSetupContext({ solver: solver as unknown as SparseSolver });
    setupAll([src], setupCtx);

    src.load(makeMinimalCtx(solver));

    // No matrix stamps — current sources are RHS-only
    expect(solver.allocElement).toHaveBeenCalledTimes(0);

    // RHS[nodePos] += I  → rhs[1] += 0.01
    // RHS[nodeNeg] -= I  → rhs[2] -= 0.01
    expect(solver._rhs[1]).toBe(0.01);
    expect(solver._rhs[2]).toBe(-0.01);
  });

  it("set_scale_modifies_current", () => {
    // ngspice vsrcload.c:54 — value = here->VSRCdcValue * ckt->CKTsrcFact
    // Sources read ctx.srcFact directly during load(); no per-element scale method.
    const src = makeCurrentSourceEl(1, 2, 0.01);

    const solver = makeMockSolver();
    const setupCtx = makeTestSetupContext({ solver: solver as unknown as SparseSolver });
    setupAll([src], setupCtx);

    const ctx = makeMinimalCtx(solver, { srcFact: 0.3 });
    src.load(ctx);

    // No matrix stamps
    expect(solver.allocElement).toHaveBeenCalledTimes(0);

    // I * scale = 0.01 * 0.3 = 0.003
    expect(solver._rhs[1]).toBeCloseTo(0.003, 15);
    expect(solver._rhs[2]).toBeCloseTo(-0.003, 15);
  });

  it("ground_node_rhs_suppressed", () => {
    // pos at node 1, neg at ground (0)
    const src = makeCurrentSourceEl(1, 0, 0.01);
    const solver = makeMockSolver();

    const setupCtx = makeTestSetupContext({ solver: solver as unknown as SparseSolver });
    setupAll([src], setupCtx);

    src.load(makeMinimalCtx(solver));

    // Only one RHS entry (ground row suppressed — rhs[0] stays 0)
    expect(solver._rhs[0]).toBe(0);
    expect(solver._rhs[1]).toBe(0.01);
  });

  it("branch_index_is_minus_one", () => {
    const src = makeCurrentSourceEl(1, 2, 0.01);
    const solver = makeMockSolver();
    const setupCtx = makeTestSetupContext({ solver: solver as unknown as SparseSolver });
    setupAll([src], setupCtx);
    expect(src.branchIndex).toBe(-1);
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
      props,
      () => 0,
    );

    const solver = makeMockSolver();
    const setupCtx = makeTestSetupContext({ solver: solver as unknown as SparseSolver });
    setupAll([el], setupCtx);

    el.load(makeMinimalCtx(solver));

    // Default current is 0.01 A; nodePos=1 → rhs[1], nodeNeg=2 → rhs[2]
    expect(solver._rhs[1]).toBe(0.01);
    expect(solver._rhs[2]).toBe(-0.01);
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
    const src = makeCurrentSourceEl(1, 2, CURRENT);
    const solver = makeMockSolver();

    const setupCtx = makeTestSetupContext({ solver: solver as unknown as SparseSolver });
    setupAll([src], setupCtx);

    src.load(makeMinimalCtx(solver, { srcFact: SRC_FACT }));

    // NGSPICE_REF: I * srcFact, bit-exact IEEE-754 product.
    const NGSPICE_REF_POS = CURRENT * SRC_FACT;
    const NGSPICE_REF_NEG = -(CURRENT * SRC_FACT);
    expect(solver._rhs[1]).toBe(NGSPICE_REF_POS);
    expect(solver._rhs[2]).toBe(NGSPICE_REF_NEG);
    // Zero matrix stamps (current source is RHS-only).
    expect(solver.allocElement).toHaveBeenCalledTimes(0);
    expect(NGSPICE_REF_POS).toBe(0.003);
  });

  it("srcfact_0_zeroes_rhs_both_rows", () => {
    const CURRENT = 0.015;
    const SRC_FACT = 0;
    const src = makeCurrentSourceEl(1, 2, CURRENT);
    const solver = makeMockSolver();

    const setupCtx = makeTestSetupContext({ solver: solver as unknown as SparseSolver });
    setupAll([src], setupCtx);

    src.load(makeMinimalCtx(solver, { cktMode: MODEDCOP | MODEINITJCT, srcFact: SRC_FACT }));

    expect(solver._rhs[1]).toBe(0);
    expect(solver._rhs[2]).toBe(0);
  });

  it("srcfact_1_preserves_full_current", () => {
    const CURRENT = 0.02;
    const src = makeCurrentSourceEl(1, 0, CURRENT);
    const solver = makeMockSolver();

    const setupCtx = makeTestSetupContext({ solver: solver as unknown as SparseSolver });
    setupAll([src], setupCtx);

    src.load(makeMinimalCtx(solver));

    // pos only (neg is ground → suppressed); rhs[1] = CURRENT, rhs[0] stays 0.
    expect(solver._rhs[0]).toBe(0);
    expect(solver._rhs[1]).toBe(CURRENT);
  });
});
