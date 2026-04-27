/**
 * Tests for the DC voltage source component.
 */

import { describe, it, expect, vi } from "vitest";
import { makeDcVoltageSource, DcVoltageSourceDefinition } from "../dc-voltage-source.js";
import { PropertyBag } from "../../../core/properties.js";
import type { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { MODEDCOP, MODEINITFLOAT, MODEINITJCT } from "../../../solver/analog/ckt-mode.js";

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

function makeMinimalCtx(solver: ReturnType<typeof makeMockSolver>, rhsOverride?: Float64Array) {
  const rhs = rhsOverride ?? solver._rhs;
  return {
    solver: solver as unknown as SparseSolver,
    matrix: solver as unknown as SparseSolver,
    rhs,
    rhsOld: new Float64Array(rhs.length),
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
  };
}

// ---------------------------------------------------------------------------
// DcVoltageSource unit tests
// ---------------------------------------------------------------------------

describe("DcVoltageSource", () => {
  it("stamp_incidence_and_rhs", () => {
    // 10V source between nodes 1 (pos) and 2 (neg), branch at absolute row 3
    // matrixSize = 4 (3 nodes + 1 branch)
    const src = makeDcVoltageSource(1, 2, 3, 10);
    const solver = makeMockSolver();

    src.load(makeMinimalCtx(solver));

    // Should produce 4 matrix stamps (1-based nodes: nodePos=1, nodeNeg=2, branch=3):
    // B[nodePos, k] = allocElement(1, 3) → stampElement(h,  1)
    // B[nodeNeg, k] = allocElement(2, 3) → stampElement(h, -1)
    // C[k, nodePos] = allocElement(3, 1) → stampElement(h,  1)
    // C[k, nodeNeg] = allocElement(3, 2) → stampElement(h, -1)
    expect(solver.allocElement).toHaveBeenCalledTimes(4);

    const stamps = solver._stamps;
    expect(stamps.some(([r, c, v]) => r === 1 && c === 3 && v ===  1)).toBe(true);
    expect(stamps.some(([r, c, v]) => r === 2 && c === 3 && v === -1)).toBe(true);
    expect(stamps.some(([r, c, v]) => r === 3 && c === 1 && v ===  1)).toBe(true);
    expect(stamps.some(([r, c, v]) => r === 3 && c === 2 && v === -1)).toBe(true);

    // RHS at branch row 3: RHS[3] = 10
    expect(solver._rhs[3]).toBe(10);
  });

  it("set_scale_modifies_rhs", () => {
    // ngspice vsrcload.c:54 — value = here->VSRCdcValue * ckt->CKTsrcFact
    // Sources read ctx.srcFact directly during load(); no per-element scale method.
    const src = makeDcVoltageSource(1, 2, 3, 10);

    const solver = makeMockSolver();
    const ctx = { ...makeMinimalCtx(solver), srcFact: 0.5 };
    src.load(ctx);

    // Incidence stamps are always ±1
    expect(solver.allocElement).toHaveBeenCalledTimes(4);

    // RHS = 10 * 0.5 = 5
    expect(solver._rhs[3]).toBe(5);
  });

  it("ground_node_stamps_suppressed", () => {
    // Positive at node 1, negative at ground (0), branch at row 2
    const src = makeDcVoltageSource(1, 0, 2, 5);
    const solver = makeMockSolver();

    src.load(makeMinimalCtx(solver));

    // Only 2 matrix stamps (neg is ground — nodeNeg=0 rows suppressed)
    // nodePos=1 (1-based), branch=2: B[1,2] and C[2,1]
    expect(solver.allocElement).toHaveBeenCalledTimes(2);
    const stamps = solver._stamps;
    expect(stamps.some(([r, c, v]) => r === 1 && c === 2 && v === 1)).toBe(true);
    expect(stamps.some(([r, c, v]) => r === 2 && c === 1 && v === 1)).toBe(true);
    expect(solver._rhs[2]).toBe(5);
  });

  it("branch_index_stored", () => {
    const src = makeDcVoltageSource(1, 2, 5, 10);
    expect(src.branchIndex).toBe(5);
  });

  it("is_not_nonlinear_or_reactive", () => {
    const src = makeDcVoltageSource(1, 2, 3, 10);
    expect(src.isNonlinear).toBe(false);
    expect(src.isReactive).toBe(false);
  });

  it("definition_has_requires_branch_row", () => {
    expect((DcVoltageSourceDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory;branchCount?:number}|undefined)?.branchCount).toBe(1);
  });

  it("definition_engine_type_analog", () => {
    expect(DcVoltageSourceDefinition.modelRegistry?.behavioral).toBeDefined();
  });

  it("default_voltage_from_analog_factory", () => {
    const props = new PropertyBag();
    props.replaceModelParams({ voltage: 5 });
    const el = getFactory(DcVoltageSourceDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 0]]),
      [],
      2,
      props,
      () => 0,
    );

    const solver = makeMockSolver();
    el.load(makeMinimalCtx(solver));

    // Default voltage is 5V, branch at row 2, nodeNeg=0 so only 2 stamps
    expect(solver._rhs[2]).toBe(5);
  });
});

// ===========================================================================
// Task C4.4 — DC voltage source srcFact parity
//
// ngspice reference: cktload.c:96-136 + each source's DEVload.
// The independent voltage source stamps its RHS entry as `V * CKTsrcFact`
// during DC-OP source-stepping. At srcFact=0.5 the RHS entry must be
// exactly half the nominal source voltage, bit-exact.
//
// ngspice → ours mapping:
//   CKTsrcFact             → ctx.srcFact
//   *CKTrhs += VSRCdcValue → solver.stampRHS(branch, V * srcFact)
// ===========================================================================

describe("dc_vsource_load_srcfact_parity", () => {
  it("srcfact_05_halves_rhs_bit_exact", () => {
    const VOLTAGE = 10;
    const SRC_FACT = 0.5;
    const BRANCH_ROW = 3;

    const src = makeDcVoltageSource(1, 2, BRANCH_ROW, VOLTAGE);
    const solver = makeMockSolver(8);

    src.load({ ...makeMinimalCtx(solver), srcFact: SRC_FACT });

    // ngspice reference: NGSPICE_REF = voltage * srcFact.
    // Bit-exact: the final RHS stamp at the branch row must equal the product.
    const NGSPICE_REF = VOLTAGE * SRC_FACT;
    expect(solver._rhs[BRANCH_ROW]).toBe(NGSPICE_REF);
    expect(NGSPICE_REF).toBe(5);
  });

  it("srcfact_1_preserves_full_rhs", () => {
    const VOLTAGE = 12;
    const SRC_FACT = 1;
    const BRANCH_ROW = 2;

    const src = makeDcVoltageSource(1, 0, BRANCH_ROW, VOLTAGE);
    const solver = makeMockSolver(8);

    src.load({ ...makeMinimalCtx(solver), srcFact: SRC_FACT });

    const NGSPICE_REF = VOLTAGE * SRC_FACT;
    expect(solver._rhs[BRANCH_ROW]).toBe(NGSPICE_REF);
    expect(NGSPICE_REF).toBe(12);
  });

  it("srcfact_0_zeroes_rhs_leaving_incidence", () => {
    const VOLTAGE = 7;
    const SRC_FACT = 0;
    const BRANCH_ROW = 3;

    const src = makeDcVoltageSource(1, 2, BRANCH_ROW, VOLTAGE);
    const solver = makeMockSolver(8);

    src.load({ ...makeMinimalCtx(solver), cktMode: MODEDCOP | MODEINITJCT, srcFact: SRC_FACT });

    const NGSPICE_REF = VOLTAGE * SRC_FACT;
    expect(solver._rhs[BRANCH_ROW]).toBe(NGSPICE_REF);
    expect(NGSPICE_REF).toBe(0);

    // Incidence stamps are srcFact-independent — must remain present.
    // Nodes are 1-based: nodePos=1, nodeNeg=2, BRANCH_ROW=3.
    const stamps = solver._stamps;
    expect(stamps.some(([r, c, v]) => r === 1 && c === BRANCH_ROW && v ===  1)).toBe(true);
    expect(stamps.some(([r, c, v]) => r === 2 && c === BRANCH_ROW && v === -1)).toBe(true);
    expect(stamps.some(([r, c, v]) => r === BRANCH_ROW && c === 1 && v ===  1)).toBe(true);
    expect(stamps.some(([r, c, v]) => r === BRANCH_ROW && c === 2 && v === -1)).toBe(true);
  });
});
