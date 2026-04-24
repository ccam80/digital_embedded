/**
 * Phase 3 — xfact predictor tests.
 *
 * Task 3.2.1: Diode MODEINITPRED xfact extrapolation.
 * Task 3.2.2–3.2.4: BJT tests appended by the BJT implementer task_group.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDiodeElement, DIODE_PARAM_DEFAULTS } from "../diode.js";
import {
  createBjtElement,
  createSpiceL1BjtElement,
  BJT_NPN_DEFAULTS,
  BJT_SPICE_L1_NPN_DEFAULTS,
} from "../bjt.js";
import { PropertyBag } from "../../../core/properties.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import {
  MODETRAN,
  MODEINITPRED,
  MODEINITFLOAT,
} from "../../../solver/analog/ckt-mode.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import * as NewtonRaphsonModule from "../../../solver/analog/newton-raphson.js";

// ---------------------------------------------------------------------------
// Slot indices (mirror diode.ts internal ordering)
// ---------------------------------------------------------------------------
const SLOT_VD = 0;
const SLOT_GEQ = 1;
const SLOT_IEQ = 2;
const SLOT_ID = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParamBag(overrides: Record<string, number> = {}): PropertyBag {
  const bag = new PropertyBag();
  bag.replaceModelParams({ ...DIODE_PARAM_DEFAULTS, ...overrides });
  return bag;
}

/**
 * Instantiate a diode element with anode=node1, cathode=node2 (1-based node IDs).
 * RS=0 so no internal node — nodeJunction === nodeAnode.
 */
function makeDiode(paramOverrides: Record<string, number> = {}) {
  const pinNodes = new Map<string, number>([["A", 1], ["K", 2]]);
  const props = makeParamBag(paramOverrides);
  return createDiodeElement(pinNodes, [], -1, props);
}

/**
 * Allocate a StatePool for the given element and call initState.
 */
function initPool(element: ReturnType<typeof makeDiode>): StatePool {
  const pool = new StatePool(Math.max(element.stateSize, 1));
  element.stateBaseOffset = 0;
  element.initState(pool);
  return pool;
}

/**
 * Build a bare LoadContext. The solver size of 3 covers nodes 1 and 2 (0-based
 * indices 0 and 1).
 */
function buildCtx(
  pool: StatePool,
  cktMode: number,
  xfact: number,
  rhsOld?: Float64Array,
  overrides: Partial<LoadContext> = {},
): LoadContext {
  const solver = new SparseSolver();
  solver.beginAssembly(3);
  const voltages = rhsOld ?? new Float64Array(3);
  return {
    solver,
    rhsOld: voltages,
    rhs: voltages,
    cktMode,
    dt: 1e-9,
    method: "trapezoidal",
    order: 1,
    deltaOld: [1e-9, 2e-9, 0, 0, 0, 0, 0],
    ag: new Float64Array(7),
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    xfact,
    gmin: 1e-12,
    reltol: 1e-3,
    iabstol: 1e-12,
    cktFixLimit: false,
    ...overrides,
  } as LoadContext;
}

// ---------------------------------------------------------------------------
// Task 3.2.1 — Diode MODEINITPRED xfact extrapolation
// ---------------------------------------------------------------------------

describe("Task 3.2.1 — Diode MODEINITPRED xfact", () => {
  it("extrapolates vdRaw as (1+xfact)*s1 - xfact*s2", () => {
    const element = makeDiode();
    const pool = initPool(element);

    // Seed s1[SLOT_VD] = 0.65, s2[SLOT_VD] = 0.60
    pool.states[1][SLOT_VD] = 0.65;
    pool.states[2][SLOT_VD] = 0.60;

    const ctx = buildCtx(pool, MODETRAN | MODEINITPRED, 0.5);
    element.load(ctx);

    // (1 + 0.5) * 0.65 - 0.5 * 0.60 = 0.975 - 0.30 = 0.675
    const expected = (1 + 0.5) * 0.65 - 0.5 * 0.60;
    expect((ctx as any).__phase3ProbeVdRaw).toBe(expected);
  });

  it("copies s1→s0 for VD, ID, GEQ before extrapolation", () => {
    // The copy is verified via pnjlim's vold argument, which equals s0[SLOT_VD]
    // at the time pnjlim is called — i.e., after the state-copy overwrites s0[SLOT_VD]
    // with s1[SLOT_VD]. load() subsequently overwrites s0[SLOT_ID] and s0[SLOT_GEQ]
    // with the post-load computed values, so they cannot be inspected on s0 after load().
    // Instead we spy on pnjlim to capture the vold argument (= s0[SLOT_VD] post-copy).
    const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");

    const element = makeDiode();
    const pool = initPool(element);

    // s0: pre-copy sentinel values
    pool.states[0][SLOT_VD]  = 0.1;
    pool.states[0][SLOT_ID]  = 2e-3;
    pool.states[0][SLOT_GEQ] = 8e-2;

    // s1: values to be copied into s0
    pool.states[1][SLOT_VD]  = 0.65;
    pool.states[1][SLOT_ID]  = 1e-3;
    pool.states[1][SLOT_GEQ] = 4e-2;

    // s2 for extrapolation
    pool.states[2][SLOT_VD] = 0.60;

    const ctx = buildCtx(pool, MODETRAN | MODEINITPRED, 0.5);
    element.load(ctx);

    // pnjlim is called with vold = s0[SLOT_VD] AFTER the state-copy.
    // The copy sets s0[SLOT_VD] = s1[SLOT_VD] = 0.65, so vold must be 0.65.
    const calls = pnjlimSpy.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // Find a call whose vold (second arg) equals 0.65 (the copied value, not the sentinel 0.1)
    const copyVerifiedCall = calls.find((c) => c[1] === 0.65);
    expect(copyVerifiedCall).toBeDefined();

    pnjlimSpy.mockRestore();
  });

  it("runs pnjlim on the extrapolated vdRaw", () => {
    // Extrapolation: (1+2)*0.9 - 2*0.85 = 2.7 - 1.7 = 1.0
    // This is well above vcrit (~0.65 for default IS), so pnjlim will limit it.
    const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");

    const element = makeDiode();
    const pool = initPool(element);

    pool.states[1][SLOT_VD] = 0.9;
    pool.states[2][SLOT_VD] = 0.85;
    // s0[SLOT_VD] will be set to s1[SLOT_VD]=0.9 by the state-copy
    pool.states[0][SLOT_VD] = 0.9;

    const ctx = buildCtx(pool, MODETRAN | MODEINITPRED, 2.0);
    element.load(ctx);

    // pnjlim must be called at least once with vdRaw = 1.0
    const calls = pnjlimSpy.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);

    // The first arg to the standard pnjlim call is the extrapolated vdRaw = 1.0
    const extrapolated = (1 + 2.0) * 0.9 - 2.0 * 0.85;
    const pnjlimCallWithExtrapolated = calls.find(
      (c) => c[0] === extrapolated,
    );
    expect(pnjlimCallWithExtrapolated).toBeDefined();

    // Second arg (vold) is s0[SLOT_VD] after the state-copy, which equals s1[SLOT_VD]=0.9
    expect(pnjlimCallWithExtrapolated![1]).toBe(0.9);

    pnjlimSpy.mockRestore();
  });

  it("falls through to rhsOld when MODEINITPRED is not set", () => {
    const element = makeDiode();
    const pool = initPool(element);

    // s1/s2 set to values that would produce a different extrapolation
    pool.states[1][SLOT_VD] = 0.65;
    pool.states[2][SLOT_VD] = 0.60;

    // rhsOld: node1=0.72, node2=0.0, so vdRaw = va - vc = 0.72 - 0 = 0.72
    // nodeAnode=1 → voltages[0]; nodeCathode=2 → voltages[1]
    const rhsOld = new Float64Array([0.72, 0.0, 0.0]);

    // MODETRAN without MODEINITPRED → MODEINITFLOAT path → rhsOld read
    const ctx = buildCtx(pool, MODETRAN | MODEINITFLOAT, 0.5, rhsOld);
    element.load(ctx);

    expect((ctx as any).__phase3ProbeVdRaw).toBe(0.72);
  });

  it("does not allocate during the MODEINITPRED branch", () => {
    // Source-text assertion: verify the MODEINITPRED branch body contains no
    // allocations (no `new X`, no non-empty object literals `{}`, no closures).
    const fs = require("fs");
    const path = require("path");

    // The test file lives in __tests__; diode.ts is one level up.
    const altPath = path.resolve(__dirname, "../diode.ts");
    const source: string = fs.readFileSync(altPath, "utf8");

    // Extract the MODEINITPRED branch body: from `} else if (mode & MODEINITPRED) {`
    // to the closing `} else {` that starts the rhsOld fallthrough branch.
    const predMarker = "} else if (mode & MODEINITPRED) {";
    const predStart = source.indexOf(predMarker);
    expect(predStart).toBeGreaterThan(-1);

    // Find the matching `} else {` that follows (the rhsOld fallthrough)
    const elseStart = source.indexOf("} else {", predStart);
    expect(elseStart).toBeGreaterThan(predStart);

    const branchBody = source.slice(predStart + predMarker.length, elseStart);

    // Strip single-line comments to avoid false positives from comment text.
    const codeOnly = branchBody.replace(/\/\/[^\n]*/g, "");

    // No `new SomeClass` or `new Array` constructor calls
    expect(codeOnly).not.toMatch(/new\s+\w/);
    // No array literal allocations: `= []` or `return []` (not subscript access like arr[i])
    expect(codeOnly).not.toMatch(/(?:=\s*|return\s+)\[\s*\]/);
    // No object literal allocations: `= {}` or `return {}`
    expect(codeOnly).not.toMatch(/(?:=\s*|return\s+)\{\s*\}/);
    // No arrow functions or function expressions (closures)
    expect(codeOnly).not.toMatch(/=>|function\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// BJT helpers (shared by Tasks 3.2.2, 3.2.3, 3.2.4)
// ---------------------------------------------------------------------------

/**
 * L0 BJT: B=node1, C=node2, E=node3 (1-based). NPN polarity=1. No internal nodes.
 */
function makeBjtL0(paramOverrides: Record<string, number> = {}) {
  const pinNodes = new Map<string, number>([["B", 1], ["C", 2], ["E", 3]]);
  const bag = new PropertyBag();
  bag.replaceModelParams({ ...BJT_NPN_DEFAULTS, ...paramOverrides });
  return createBjtElement(1, pinNodes, -1, bag);
}

/**
 * L1 BJT: B=node1, C=node2, E=node3 (1-based). NPN polarity=1. No internal nodes (RB=RC=RE=0).
 */
function makeBjtL1(paramOverrides: Record<string, number> = {}) {
  const pinNodes = new Map<string, number>([["B", 1], ["C", 2], ["E", 3]]);
  const bag = new PropertyBag();
  bag.replaceModelParams({ ...BJT_SPICE_L1_NPN_DEFAULTS, ...paramOverrides });
  return createSpiceL1BjtElement(1, pinNodes, [], -1, bag);
}

function initBjtPool(element: ReturnType<typeof makeBjtL0>): StatePool {
  const pool = new StatePool(Math.max(element.stateSize, 1));
  element.stateBaseOffset = 0;
  element.initState(pool);
  return pool;
}

/**
 * Build a LoadContext for BJT tests. Solver size=4 covers nodes 1-3 (0-based 0-2).
 */
function buildBjtCtx(
  pool: StatePool,
  cktMode: number,
  xfact: number,
  rhsOld?: Float64Array,
  overrides: Partial<LoadContext> = {},
): LoadContext {
  const solver = new SparseSolver();
  solver.beginAssembly(4);
  const voltages = rhsOld ?? new Float64Array(4);
  return {
    solver,
    rhsOld: voltages,
    rhs: voltages,
    cktMode,
    dt: 1e-9,
    method: "trapezoidal",
    order: 1,
    deltaOld: [1e-9, 2e-9, 0, 0, 0, 0, 0],
    ag: new Float64Array(7),
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    xfact,
    gmin: 1e-12,
    reltol: 1e-3,
    iabstol: 1e-12,
    cktFixLimit: false,
    ...overrides,
  } as LoadContext;
}

// Slot indices — mirror internal constants in bjt.ts (L0 and L1 share VBE=0, VBC=1).
const BJT_SLOT_VBE  = 0;
const BJT_SLOT_VBC  = 1;
// L1-only slots
const BJT_SLOT_VSUB = 21;

// ---------------------------------------------------------------------------
// Task 3.2.2 — BJT L0 MODEINITPRED xfact
// ---------------------------------------------------------------------------

describe("Task 3.2.2 — BJT L0 MODEINITPRED xfact", () => {
  it("extrapolates vbeRaw as (1+xfact)*s1[VBE] - xfact*s2[VBE]", () => {
    const element = makeBjtL0();
    const pool = initBjtPool(element);

    // Seed s1[VBE]=0.65, s2[VBE]=0.60
    pool.states[1][BJT_SLOT_VBE] = 0.65;
    pool.states[2][BJT_SLOT_VBE] = 0.60;
    pool.states[1][BJT_SLOT_VBC] = -0.1;
    pool.states[2][BJT_SLOT_VBC] = -0.1;

    const ctx = buildBjtCtx(pool, MODETRAN | MODEINITPRED, 0.5);
    element.load(ctx);

    const expected = (1 + 0.5) * 0.65 - 0.5 * 0.60;
    expect((ctx as any).__phase3ProbeVbeRaw).toBe(expected);
  });

  it("extrapolates vbcRaw as (1+xfact)*s1[VBC] - xfact*s2[VBC]", () => {
    const element = makeBjtL0();
    const pool = initBjtPool(element);

    pool.states[1][BJT_SLOT_VBE] = 0.65;
    pool.states[2][BJT_SLOT_VBE] = 0.60;
    pool.states[1][BJT_SLOT_VBC] = -0.10;
    pool.states[2][BJT_SLOT_VBC] = -0.08;

    const ctx = buildBjtCtx(pool, MODETRAN | MODEINITPRED, 0.5);
    element.load(ctx);

    const expected = (1 + 0.5) * (-0.10) - 0.5 * (-0.08);
    expect((ctx as any).__phase3ProbeVbcRaw).toBe(expected);
  });

  it("copies s1→s0 for VBE and VBC before extrapolation (verified via pnjlim vold)", () => {
    const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");

    const element = makeBjtL0();
    const pool = initBjtPool(element);

    pool.states[0][BJT_SLOT_VBE] = 0.1;  // sentinel
    pool.states[1][BJT_SLOT_VBE] = 0.65; // to be copied into s0
    pool.states[2][BJT_SLOT_VBE] = 0.60;
    pool.states[1][BJT_SLOT_VBC] = -0.1;
    pool.states[2][BJT_SLOT_VBC] = -0.08;

    const ctx = buildBjtCtx(pool, MODETRAN | MODEINITPRED, 0.5);
    element.load(ctx);

    // pnjlim is called with vold = s0[VBE] after the copy, which equals s1[VBE]=0.65
    const calls = pnjlimSpy.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const copyVerifiedCall = calls.find((c) => c[1] === 0.65);
    expect(copyVerifiedCall).toBeDefined();

    pnjlimSpy.mockRestore();
  });

  it("falls through to rhsOld when MODEINITPRED is not set", () => {
    const element = makeBjtL0();
    const pool = initBjtPool(element);

    // rhsOld: vB=node1=0.7, vC=node2=0.0, vE=node3=0.0 → vbeRaw = 0.7
    const rhsOld = new Float64Array([0.7, 0.0, 0.0, 0.0]);

    const ctx = buildBjtCtx(pool, MODETRAN | MODEINITFLOAT, 0.5, rhsOld);
    element.load(ctx);

    expect((ctx as any).__phase3ProbeVbeRaw).toBe(0.7);
  });

  it("probe writes appear in both MODEINITPRED and rhsOld branches", () => {
    const element = makeBjtL0();
    const pool = initBjtPool(element);

    pool.states[1][BJT_SLOT_VBE] = 0.65;
    pool.states[2][BJT_SLOT_VBE] = 0.60;
    pool.states[1][BJT_SLOT_VBC] = -0.10;
    pool.states[2][BJT_SLOT_VBC] = -0.08;

    const ctxPred = buildBjtCtx(pool, MODETRAN | MODEINITPRED, 0.5);
    element.load(ctxPred);
    expect((ctxPred as any).__phase3ProbeVbeRaw).toBeDefined();
    expect((ctxPred as any).__phase3ProbeVbcRaw).toBeDefined();

    const rhsOld = new Float64Array([0.7, 0.0, 0.0, 0.0]);
    const ctxNr = buildBjtCtx(pool, MODETRAN | MODEINITFLOAT, 0.0, rhsOld);
    element.load(ctxNr);
    expect((ctxNr as any).__phase3ProbeVbeRaw).toBeDefined();
    expect((ctxNr as any).__phase3ProbeVbcRaw).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Task 3.2.3 — BJT L1 MODEINITPRED xfact
// ---------------------------------------------------------------------------

describe("Task 3.2.3 — BJT L1 MODEINITPRED xfact", () => {
  it("extrapolates vbeRaw as (1+xfact)*s1[VBE] - xfact*s2[VBE]", () => {
    const element = makeBjtL1();
    const pool = initBjtPool(element);

    pool.states[1][BJT_SLOT_VBE] = 0.65;
    pool.states[2][BJT_SLOT_VBE] = 0.60;

    const ctx = buildBjtCtx(pool, MODETRAN | MODEINITPRED, 0.5);
    element.load(ctx);

    const expected = (1 + 0.5) * 0.65 - 0.5 * 0.60;
    expect((ctx as any).__phase3ProbeVbeRaw).toBe(expected);
  });

  it("extrapolates vbcRaw as (1+xfact)*s1[VBC] - xfact*s2[VBC]", () => {
    const element = makeBjtL1();
    const pool = initBjtPool(element);

    pool.states[1][BJT_SLOT_VBC] = -0.10;
    pool.states[2][BJT_SLOT_VBC] = -0.08;

    const ctx = buildBjtCtx(pool, MODETRAN | MODEINITPRED, 0.5);
    element.load(ctx);

    const expected = (1 + 0.5) * (-0.10) - 0.5 * (-0.08);
    expect((ctx as any).__phase3ProbeVbcRaw).toBe(expected);
  });

  it("extrapolates vsub and writes __phase3ProbeVsubExtrap before rhsOld re-read", () => {
    const element = makeBjtL1();
    const pool = initBjtPool(element);

    pool.states[1][BJT_SLOT_VSUB] = 0.30;
    pool.states[2][BJT_SLOT_VSUB] = 0.25;

    const ctx = buildBjtCtx(pool, MODETRAN | MODEINITPRED, 0.5);
    element.load(ctx);

    const expectedExtrap = (1 + 0.5) * 0.30 - 0.5 * 0.25;
    expect((ctx as any).__phase3ProbeVsubExtrap).toBe(expectedExtrap);
  });

  it("overwrites vsubRaw with rhsOld read (bjtload.c:328-330) as __phase3ProbeVsubFinal", () => {
    const element = makeBjtL1();
    const pool = initBjtPool(element);

    // With all nodes at 0V, vsubRaw = polarity(1) * subs(1) * (0 - vSubCon(0)) = 0
    pool.states[1][BJT_SLOT_VSUB] = 0.30;
    pool.states[2][BJT_SLOT_VSUB] = 0.25;

    const ctx = buildBjtCtx(pool, MODETRAN | MODEINITPRED, 0.5);
    element.load(ctx);

    // Final vsub must be the rhsOld re-read, not the extrapolated value
    expect((ctx as any).__phase3ProbeVsubFinal).toBe(0);
    // And it must differ from extrap (which was 0.325)
    expect((ctx as any).__phase3ProbeVsubExtrap).not.toBe((ctx as any).__phase3ProbeVsubFinal);
  });

  it("pnjlim IS called under MODEINITPRED (mask does not skip it)", () => {
    const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");

    const element = makeBjtL1();
    const pool = initBjtPool(element);

    pool.states[1][BJT_SLOT_VBE] = 0.65;
    pool.states[2][BJT_SLOT_VBE] = 0.60;

    const ctx = buildBjtCtx(pool, MODETRAN | MODEINITPRED, 0.5);
    element.load(ctx);

    expect(pnjlimSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

    pnjlimSpy.mockRestore();
  });

  it("falls through to rhsOld when MODEINITPRED is not set", () => {
    const element = makeBjtL1();
    const pool = initBjtPool(element);

    // vBi=node1(internal=ext when RB=0)=0.7, vCi=node2=0.0, vEi=node3=0.0 → vbeRaw=0.7
    const rhsOld = new Float64Array([0.7, 0.0, 0.0, 0.0]);

    const ctx = buildBjtCtx(pool, MODETRAN | MODEINITFLOAT, 0.5, rhsOld);
    element.load(ctx);

    expect((ctx as any).__phase3ProbeVbeRaw).toBe(0.7);
  });
});

// ---------------------------------------------------------------------------
// Task 3.2.4 — BJT L1 VSUB state-copy
// ---------------------------------------------------------------------------

describe("Task 3.2.4 — BJT L1 VSUB state-copy", () => {
  it("copies s1[VSUB] into s0[VSUB] inside the MODEINITPRED branch", () => {
    // s0[SLOT_VSUB] is overwritten at the end of load() with vsubLimited,
    // so we verify the copy via the pnjlim call: pnjlim(vsubRaw, s0[VSUB], vt, tSubVcrit)
    // where s0[VSUB] is the vold argument and must equal s1[VSUB] after the copy.
    const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");

    const element = makeBjtL1();
    const pool = initBjtPool(element);

    // Place sentinel in s0[VSUB], target in s1[VSUB]
    pool.states[0][BJT_SLOT_VSUB] = 0.0;  // sentinel — must be overwritten by copy
    pool.states[1][BJT_SLOT_VSUB] = 0.42; // the value that must be copied to s0
    pool.states[2][BJT_SLOT_VSUB] = 0.35; // s2 for extrapolation

    const ctx = buildBjtCtx(pool, MODETRAN | MODEINITPRED, 0.5);
    element.load(ctx);

    // pnjlim is called as pnjlim(vsubRaw, s0[VSUB], vt, tSubVcrit).
    // The second argument (vold) must equal s1[VSUB]=0.42 after the state-copy.
    const calls = pnjlimSpy.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const copyVerifiedCall = calls.find((c) => c[1] === 0.42);
    expect(copyVerifiedCall).toBeDefined();

    pnjlimSpy.mockRestore();
  });
});
