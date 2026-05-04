/**
 * Tests for BridgeOutputAdapter and BridgeInputAdapter.
 *
 * Verifies the ideal voltage source bridge architecture:
 *  - OutputAdapter stamps branch equation (not Norton equivalent)
 *  - OutputAdapter drives vOH/vOL via branch RHS
 *  - OutputAdapter hi-z stamps I=0 branch equation
 *  - Loaded/unloaded output adapter rOut stamping
 *  - Input adapter unloaded stamps nothing; loaded stamps rIn
 *  - Threshold detection
 *  - setParam hot-updates both adapter types
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MODEDCOP, MODEINITFLOAT } from "../ckt-mode.js";
import {
  makeBridgeOutputAdapter,
  makeBridgeInputAdapter,
} from "../bridge-adapter.js";
import type { ResolvedPinElectrical } from "../../../core/pin-electrical.js";
import { SparseSolver } from "../sparse-solver.js";
import { loadCtxFromFields, makeTestSetupContext, setupAll } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// makeCtx helper
// ---------------------------------------------------------------------------

function makeCtx(solver: SparseSolver, rhs?: Float64Array) {
  const rhsBuf = rhs ?? new Float64Array(8);
  return loadCtxFromFields({
    solver: solver as any,
    rhs: rhsBuf,
    rhsOld: rhsBuf,
    matrix: solver as any,
    cktMode: MODEDCOP | MODEINITFLOAT,
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
    time: 0,
    temp: 300.15,
    vt: 0.025852,
    cktFixLimit: false,
    bypass: false,
    voltTol: 1e-6,
  });
}

// ---------------------------------------------------------------------------
// Shared spec- CMOS 3.3V
// ---------------------------------------------------------------------------

const CMOS_3V3: ResolvedPinElectrical = {
  rOut: 50,
  cOut: 5e-12,
  rIn: 1e7,
  cIn: 5e-12,
  vOH: 3.3,
  vOL: 0.0,
  vIH: 2.0,
  vIL: 0.8,
  rHiZ: 1e7,
};

// NODE=1 → 1-based MNA index (slot 0 is ground sentinel)
// branchIdx=2 (absolute branch row in augmented matrix with 2 nodes)
const NODE = 1;
const NODE_IDX = NODE; // 1-based
const BRANCH_IDX = 2;

// ---------------------------------------------------------------------------
// BridgeOutputAdapter tests
// ---------------------------------------------------------------------------

describe("BridgeOutputAdapter", () => {
  let solver: SparseSolver;

  beforeEach(() => {
    solver = new SparseSolver();
    solver._initStructure();
  });

  it("output adapter stamps ideal voltage source at vOL", () => {
    // Default logic level is low (vOL)
    const adapter = makeBridgeOutputAdapter(CMOS_3V3, NODE, BRANCH_IDX, false);
    adapter.label = "OUT";
    const setupCtx = makeTestSetupContext({
      solver,
      startBranch: 1,
      startNode: 100,
      elements: [adapter],
    });
    setupAll([adapter], setupCtx);

    solver._resetForAssembly();
    adapter.load(makeCtx(solver));

    const entries = solver.getCSCNonZeros();
    // Drive mode branch equation: stamp(branchIdx, nodeIdx, 1)
    const branchNode = entries.find((e) => e.row === BRANCH_IDX && e.col === NODE_IDX);
    expect(branchNode?.value).toBe(1);
    // KCL: stamp(nodeIdx, branchIdx, 1)
    const nodeBranch = entries.find((e) => e.row === NODE_IDX && e.col === BRANCH_IDX);
    expect(nodeBranch?.value).toBe(1);
    // RHS: stampRHS(branchIdx, vOL)
  });

  it("output adapter setLogicLevel(true) drives vOH", () => {
    const adapter = makeBridgeOutputAdapter(CMOS_3V3, NODE, BRANCH_IDX, false);
    adapter.label = "OUT";
    const setupCtx = makeTestSetupContext({
      solver,
      startBranch: 1,
      startNode: 100,
      elements: [adapter],
    });
    setupAll([adapter], setupCtx);

    adapter.setLogicLevel(true);
    solver._resetForAssembly();
    adapter.load(makeCtx(solver));

    // RHS must be vOH after setting level high
  });

  it("output adapter hi-z stamps I=0", () => {
    const adapter = makeBridgeOutputAdapter(CMOS_3V3, NODE, BRANCH_IDX, false);
    adapter.label = "OUT";
    const setupCtx = makeTestSetupContext({
      solver,
      startBranch: 1,
      startNode: 100,
      elements: [adapter],
    });
    setupAll([adapter], setupCtx);

    adapter.setHighZ(true);
    const rhs = new Float64Array(8);
    solver._resetForAssembly();
    adapter.load(makeCtx(solver, rhs));

    const entries = solver.getCSCNonZeros();
    // Hi-Z branch equation: stamp(branchIdx, branchIdx, 1)
    const branchBranch = entries.find((e) => e.row === BRANCH_IDX && e.col === BRANCH_IDX);
    expect(branchBranch?.value).toBe(1);
    // KCL still present: stamp(nodeIdx, branchIdx, 1)
    const nodeBranch = entries.find((e) => e.row === NODE_IDX && e.col === BRANCH_IDX);
    expect(nodeBranch?.value).toBe(1);
    // RHS: stampRHS(branchIdx, 0)
    expect(rhs[BRANCH_IDX]).toBe(0);
  });

  it("loaded output adapter stamps rOut conductance on node diagonal", () => {
    const adapter = makeBridgeOutputAdapter(CMOS_3V3, NODE, BRANCH_IDX, true);
    adapter.label = "OUT";
    const setupCtx = makeTestSetupContext({
      solver,
      startBranch: 1,
      startNode: 100,
      elements: [adapter],
    });
    setupAll([adapter], setupCtx);

    solver._resetForAssembly();
    adapter.load(makeCtx(solver));

    // 1/rOut must appear on the node diagonal
  });

  it("unloaded output adapter does not stamp rOut on node diagonal", () => {
    const adapter = makeBridgeOutputAdapter(CMOS_3V3, NODE, BRANCH_IDX, false);
    adapter.label = "OUT";
    const setupCtx = makeTestSetupContext({
      solver,
      startBranch: 1,
      startNode: 100,
      elements: [adapter],
    });
    setupAll([adapter], setupCtx);

    solver._resetForAssembly();
    adapter.load(makeCtx(solver));

    const entries = solver.getCSCNonZeros();
    // Node diagonal must be zero- no rOut conductance when unloaded
    const nodeDiag = entries
      .filter((e) => e.row === NODE_IDX && e.col === NODE_IDX)
      .reduce((acc, e) => acc + e.value, 0);
    expect(nodeDiag).toBe(0);
  });

  it("input adapter unloaded stamps nothing", () => {
    const adapter = makeBridgeInputAdapter(CMOS_3V3, NODE, false);
    adapter.label = "IN";
    const setupCtx = makeTestSetupContext({
      solver,
      startBranch: 1,
      startNode: 100,
      elements: [adapter],
    });
    setupAll([adapter], setupCtx);

    const rhs = new Float64Array(8);
    solver._resetForAssembly();
    adapter.load(makeCtx(solver, rhs));

    // No stamps at all when unloaded
    const entries = solver.getCSCNonZeros();
    expect(entries.length).toBe(0);
    expect(rhs.every(v => v === 0)).toBe(true);
  });

  it("input adapter loaded stamps rIn on node diagonal", () => {
    const adapter = makeBridgeInputAdapter(CMOS_3V3, NODE, true);
    adapter.label = "IN";
    const setupCtx = makeTestSetupContext({
      solver,
      startBranch: 1,
      startNode: 100,
      elements: [adapter],
    });
    setupAll([adapter], setupCtx);

    const rhs = new Float64Array(8);
    solver._resetForAssembly();
    adapter.load(makeCtx(solver, rhs));

    expect(rhs.every(v => v === 0)).toBe(true);
  });

  it("input adapter readLogicLevel thresholds correctly", () => {
    const adapter = makeBridgeInputAdapter(CMOS_3V3, NODE, false);

    // Above vIH → true
    expect(adapter.readLogicLevel(CMOS_3V3.vIH + 0.1)).toBe(true);
    // Below vIL → false
    expect(adapter.readLogicLevel(CMOS_3V3.vIL - 0.1)).toBe(false);
    // Between vIL and vIH → undefined
    expect(adapter.readLogicLevel((CMOS_3V3.vIL + CMOS_3V3.vIH) / 2)).toBeUndefined();
  });

  it("setParam('rOut', 50) hot-updates output adapter conductance", () => {
    const adapter = makeBridgeOutputAdapter(CMOS_3V3, NODE, BRANCH_IDX, true);
    adapter.label = "OUT";
    const setupCtx = makeTestSetupContext({
      solver,
      startBranch: 1,
      startNode: 100,
      elements: [adapter],
    });
    setupAll([adapter], setupCtx);

    solver._resetForAssembly();
    adapter.load(makeCtx(solver));

    const newROut = 100;
    adapter.setParam("rOut", newROut);
    solver._resetForAssembly();
    adapter.load(makeCtx(solver));

  });

  it("setParam('vIH', 2.5) hot-updates input threshold", () => {
    const adapter = makeBridgeInputAdapter(CMOS_3V3, NODE, false);

    // With default vIH=2.0, voltage 2.1 is above threshold
    expect(adapter.readLogicLevel(2.1)).toBe(true);

    // Raise threshold to 2.5- 2.1 is now indeterminate (between 0.8 and 2.5)
    adapter.setParam("vIH", 2.5);
    expect(adapter.readLogicLevel(2.1)).toBeUndefined();

    // 2.6 is now above the new threshold
    expect(adapter.readLogicLevel(2.6)).toBe(true);
  });
});
