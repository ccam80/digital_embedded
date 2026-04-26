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
  MODEDCOP,
  MODEINITPRED,
  MODEINITFLOAT,
  MODEINITJCT,
  MODEINITSMSIG,
  MODEINITTRAN,
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
  solver._initStructure(3);
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
    bypass: false,
    voltTol: 1e-6,
    ...overrides,
  } as LoadContext;
}

// ---------------------------------------------------------------------------
// Task 3.2.1 — Diode MODEINITPRED xfact extrapolation
// ---------------------------------------------------------------------------

describe("Task 3.2.1 — Diode MODEINITPRED xfact", () => {
  it("extrapolates vdRaw as (1+xfact)*s1 - xfact*s2", () => {
    const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");
    const element = makeDiode();
    const pool = initPool(element);

    // Seed s1[SLOT_VD] = 0.65, s2[SLOT_VD] = 0.60
    pool.states[1][SLOT_VD] = 0.65;
    pool.states[2][SLOT_VD] = 0.60;

    const ctx = buildCtx(pool, MODETRAN | MODEINITPRED, 0.5);
    element.load(ctx);

    // (1 + 0.5) * 0.65 - 0.5 * 0.60 = 0.975 - 0.30 = 0.675
    // pnjlim is called with the extrapolated vdRaw as its first argument.
    const expected = (1 + 0.5) * 0.65 - 0.5 * 0.60;
    expect(pnjlimSpy.mock.calls.length).toBe(1);
    expect(pnjlimSpy.mock.calls[0][0]).toBe(expected);

    pnjlimSpy.mockRestore();
  });

  it("copies s1→s0 for VD, ID, GEQ before extrapolation", () => {
    // load() overwrites s0[SLOT_ID] and s0[SLOT_GEQ] at the end with newly computed
    // values, so we cannot inspect them on s0 after load() returns.
    // Instead we spy on pnjlim to capture a snapshot of s0 immediately before the
    // first call — at that moment the state-copy has already run but the end-of-load
    // write-back has not yet occurred.
    let capturedS0ID: number | undefined;
    let capturedS0GEQ: number | undefined;
    const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim").mockImplementation(
      (vnew, vold, vt, vcrit) => {
        if (capturedS0ID === undefined) {
          // First call: capture s0[SLOT_ID] and s0[SLOT_GEQ] right now.
          capturedS0ID  = pool.states[0][SLOT_ID];
          capturedS0GEQ = pool.states[0][SLOT_GEQ];
        }
        // Delegate to the real pnjlim so diode.load() completes normally.
        return NewtonRaphsonModule.pnjlim.wrappedImplementation
          ? NewtonRaphsonModule.pnjlim.wrappedImplementation(vnew, vold, vt, vcrit)
          : { value: vnew, limited: false };
      }
    );

    const element = makeDiode();
    const pool = initPool(element);

    // s0: pre-copy sentinel values (must differ from s1 to detect the copy)
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

    pnjlimSpy.mockRestore();

    // Use a clean implementation-capturing spy without wrapping pnjlim recursively.
    // Capture s0 slots directly inside the spy via closure over pool.
    capturedS0ID  = undefined;
    capturedS0GEQ = undefined;
    const realPnjlim = NewtonRaphsonModule.pnjlim;
    const captureSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim").mockImplementation(
      (vnew, vold, vt, vcrit) => {
        if (capturedS0ID === undefined) {
          capturedS0ID  = pool.states[0][SLOT_ID];
          capturedS0GEQ = pool.states[0][SLOT_GEQ];
        }
        return realPnjlim(vnew, vold, vt, vcrit);
      }
    );

    element.load(ctx);

    // VD copy: pnjlim receives vold = s0[SLOT_VD] after copy = s1[SLOT_VD] = 0.65
    const calls = captureSpy.mock.calls;
    expect(calls.length).toBe(1);
    const voldArg = calls[0][1];
    expect(voldArg).toBe(0.65);

    // ID copy: s0[SLOT_ID] at the moment of the first pnjlim call must equal s1[SLOT_ID] = 1e-3
    expect(capturedS0ID).toBe(1e-3);

    // GEQ copy: s0[SLOT_GEQ] at the moment of the first pnjlim call must equal s1[SLOT_GEQ] = 4e-2
    expect(capturedS0GEQ).toBe(4e-2);

    captureSpy.mockRestore();
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

    // pnjlim is called exactly once: the standard forward-bias path (not the breakdown path).
    const calls = pnjlimSpy.mock.calls;
    expect(calls.length).toBe(1);

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
    const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");
    const element = makeDiode();
    const pool = initPool(element);

    // s1/s2 set to values that would produce a different extrapolation
    pool.states[1][SLOT_VD] = 0.65;
    pool.states[2][SLOT_VD] = 0.60;

    // rhsOld: node1=0.72, node2=0.0, so vdRaw = va - vc = 0.72 - 0 = 0.72
    // nodeAnode=1 → voltages[0]; nodeCathode=2 → voltages[1]
    const rhsOld = new Float64Array([0.72, 0.0, 0.0]);

    // MODETRAN without MODEINITPRED → MODEINITFLOAT path → rhsOld read.
    // pnjlim's first argument is the rhsOld-derived vdRaw — confirms the else branch.
    const ctx = buildCtx(pool, MODETRAN | MODEINITFLOAT, 0.5, rhsOld);
    element.load(ctx);

    expect(pnjlimSpy.mock.calls.length).toBe(1);
    expect(pnjlimSpy.mock.calls[0][0]).toBe(0.72);

    pnjlimSpy.mockRestore();
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
  return createSpiceL1BjtElement(1, false, pinNodes, [], -1, bag);
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
  solver._initStructure(4);
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
    bypass: false,
    voltTol: 1e-6,
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
  it("extrapolates vbeRaw and vbcRaw as (1+xfact)*s1 - xfact*s2", () => {
    const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");
    const element = makeBjtL0();
    const pool = initBjtPool(element);

    // Seed s1[VBE]=0.72, s2[VBE]=0.70, s1[VBC]=-0.3, s2[VBC]=-0.28
    pool.states[1][BJT_SLOT_VBE] = 0.72;
    pool.states[2][BJT_SLOT_VBE] = 0.70;
    pool.states[1][BJT_SLOT_VBC] = -0.3;
    pool.states[2][BJT_SLOT_VBC] = -0.28;

    const ctx = buildBjtCtx(pool, MODETRAN | MODEINITPRED, 0.25);
    element.load(ctx);

    // (1+0.25)*0.72 - 0.25*0.70 = 0.74 exactly
    const expectedVbe = (1 + 0.25) * 0.72 - 0.25 * 0.70;
    // (1+0.25)*(-0.3) - 0.25*(-0.28) = -0.305 exactly
    const expectedVbc = (1 + 0.25) * (-0.3) - 0.25 * (-0.28);
    // pnjlim call sequence under L0 MODEINITPRED: [BE, BC] — first arg is the
    // extrapolated raw voltage for each junction.
    expect(pnjlimSpy.mock.calls.length).toBe(2);
    expect(pnjlimSpy.mock.calls[0][0]).toBe(expectedVbe);
    expect(pnjlimSpy.mock.calls[1][0]).toBe(expectedVbc);

    pnjlimSpy.mockRestore();
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

    // pnjlim is called with vold = s0[VBE] after the copy, which equals s1[VBE]=0.65.
    // BJT L0 calls pnjlim exactly twice under MODEINITPRED: once for BE, once for BC.
    const calls = pnjlimSpy.mock.calls;
    expect(calls.length).toBe(2);
    const copyVerifiedCall = calls.find((c) => c[1] === 0.65);
    expect(copyVerifiedCall).toBeDefined();

    pnjlimSpy.mockRestore();
  });

  it("runs pnjlim under MODEINITPRED", () => {
    // xfact=2: vbeRaw = (1+2)*0.9 - 2*0.85 = 1.0 (above tVcrit ~0.65)
    // The pnjlim skip mask is (MODEINITJCT | MODEINITSMSIG | MODEINITTRAN) — MODEINITPRED
    // is absent, so pnjlim runs for both BE and BC junctions.
    const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");

    const element = makeBjtL0();
    const pool = initBjtPool(element);

    pool.states[1][BJT_SLOT_VBE] = 0.9;
    pool.states[2][BJT_SLOT_VBE] = 0.85;
    pool.states[1][BJT_SLOT_VBC] = -0.1;
    pool.states[2][BJT_SLOT_VBC] = -0.08;

    const ctx = buildBjtCtx(pool, MODETRAN | MODEINITPRED, 2.0);
    element.load(ctx);

    // Exactly 2 calls: once for BE, once for BC — this is the key ngspice-alignment assertion.
    expect(pnjlimSpy.mock.calls.length).toBe(2);

    pnjlimSpy.mockRestore();
  });

  it("skips pnjlim under MODEINITJCT / MODEINITSMSIG / MODEINITTRAN", () => {
    const element = makeBjtL0();
    const pool = initBjtPool(element);

    // Sub-case 1: MODEINITJCT
    {
      const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");
      const ctx = buildBjtCtx(pool, MODETRAN | MODEINITJCT, 0.0);
      element.load(ctx);
      expect(pnjlimSpy.mock.calls.length).toBe(0);
      pnjlimSpy.mockRestore();
    }

    // Sub-case 2: MODEINITSMSIG
    {
      const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");
      const ctx = buildBjtCtx(pool, MODETRAN | MODEINITSMSIG, 0.0);
      element.load(ctx);
      expect(pnjlimSpy.mock.calls.length).toBe(0);
      pnjlimSpy.mockRestore();
    }

    // Sub-case 3: MODEINITTRAN
    {
      const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");
      const ctx = buildBjtCtx(pool, MODETRAN | MODEINITTRAN, 0.0);
      element.load(ctx);
      expect(pnjlimSpy.mock.calls.length).toBe(0);
      pnjlimSpy.mockRestore();
    }
  });

  it("falls through to rhsOld when MODEINITPRED is not set", () => {
    const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");
    const element = makeBjtL0();
    const pool = initBjtPool(element);

    // rhsOld: vB=node1=0.7, vC=node2=0.0, vE=node3=0.0 → vbeRaw = 0.7
    const rhsOld = new Float64Array([0.7, 0.0, 0.0, 0.0]);

    const ctx = buildBjtCtx(pool, MODETRAN | MODEINITFLOAT, 0.5, rhsOld);
    element.load(ctx);

    // pnjlim's first call (BE junction) receives vbeRaw — must equal the rhsOld-derived value.
    // L0 rhsOld path calls pnjlim exactly twice (BE + BC).
    expect(pnjlimSpy.mock.calls.length).toBe(2);
    expect(pnjlimSpy.mock.calls[0][0]).toBe(0.7);

    pnjlimSpy.mockRestore();
  });

});

// ---------------------------------------------------------------------------
// Task 3.2.3 — BJT L1 MODEINITPRED xfact
// ---------------------------------------------------------------------------

describe("Task 3.2.3 — BJT L1 MODEINITPRED xfact", () => {
  it("extrapolates vbeRaw and vbcRaw via xfact", () => {
    const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");
    const element = makeBjtL1();
    const pool = initBjtPool(element);

    // Seed s1[VBE]=0.72, s2[VBE]=0.70, s1[VBC]=-0.3, s2[VBC]=-0.28
    pool.states[1][BJT_SLOT_VBE] = 0.72;
    pool.states[2][BJT_SLOT_VBE] = 0.70;
    pool.states[1][BJT_SLOT_VBC] = -0.3;
    pool.states[2][BJT_SLOT_VBC] = -0.28;

    const ctx = buildBjtCtx(pool, MODETRAN | MODEINITPRED, 0.25);
    element.load(ctx);

    const expectedVbe = (1 + 0.25) * 0.72 - 0.25 * 0.70;
    const expectedVbc = (1 + 0.25) * (-0.3) - 0.25 * (-0.28);
    // pnjlim call sequence under L1 MODEINITPRED: [BE, BC, substrate] — the first two
    // receive the extrapolated raw voltages; substrate is observed separately.
    expect(pnjlimSpy.mock.calls.length).toBe(3);
    expect(pnjlimSpy.mock.calls[0][0]).toBe(expectedVbe);
    expect(pnjlimSpy.mock.calls[1][0]).toBe(expectedVbc);

    pnjlimSpy.mockRestore();
  });

  it("writes extrapolated vsubRaw then overwrites with rhsOld per bjtload.c:328-330", () => {
    const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");
    const element = makeBjtL1();
    const pool = initBjtPool(element);

    // Seed s1[VSUB]=0.01, s2[VSUB]=0.005; all nodes at 0V so rhsOld re-read gives 0.
    pool.states[1][BJT_SLOT_VSUB] = 0.01;
    pool.states[2][BJT_SLOT_VSUB] = 0.005;

    const ctx = buildBjtCtx(pool, MODETRAN | MODEINITPRED, 0.25);
    element.load(ctx);

    // Runtime assertions. The intermediate extrapolation is overwritten before any
    // observable exit point, so we assert (a) the post-overwrite value pnjlim sees,
    // and (b) the state-copy that precedes the extrapolation.
    //
    // Order under L1 MODEINITPRED: BE, BC, substrate.
    expect(pnjlimSpy.mock.calls.length).toBe(3);
    // Substrate pnjlim first arg = vsubRaw AFTER the rhsOld re-read → 0 (all nodes 0V).
    expect(pnjlimSpy.mock.calls[2][0]).toBe(0);
    // Substrate pnjlim second arg = s0[VSUB] AFTER the s1→s0 copy → s1[VSUB] = 0.01.
    expect(pnjlimSpy.mock.calls[2][1]).toBe(0.01);

    // Source-text guard. The runtime path cannot observe the intermediate extrapolated
    // value (it is overwritten). To guarantee the ngspice verbatim port of
    // bjtload.c:304-305 (extrapolation) + :328-330 (unconditional rhsOld re-read), read
    // bjt.ts and assert both operations are present in the L1 MODEINITPRED branch with
    // the re-read AFTER the extrapolation.
    const fs = require("fs");
    const path = require("path");
    const bjtSource: string = fs.readFileSync(
      path.resolve(__dirname, "../bjt.ts"),
      "utf8",
    );
    const predMarker = "} else if (mode & MODEINITPRED) {";
    const firstPred = bjtSource.indexOf(predMarker);
    expect(firstPred).toBeGreaterThan(-1);
    const l1PredStart = bjtSource.indexOf(predMarker, firstPred + 1);
    expect(l1PredStart).toBeGreaterThan(firstPred);
    const predBodyEnd = bjtSource.indexOf("} else {", l1PredStart);
    expect(predBodyEnd).toBeGreaterThan(l1PredStart);
    const l1PredBody = bjtSource.slice(l1PredStart, predBodyEnd);

    // Extrapolation line for VSUB
    const extrapRegex = /\(1\s*\+\s*ctx\.xfact\)\s*\*\s*s1\[[^\]]*SLOT_VSUB\]\s*-\s*ctx\.xfact\s*\*\s*s2\[[^\]]*SLOT_VSUB\]/;
    const extrapIdx = l1PredBody.search(extrapRegex);
    expect(extrapIdx).toBeGreaterThan(-1);

    // Final vsubRaw re-read (from rhsOld / polarity*subs*(...)) must follow the extrapolation.
    const lastVsubAssign = l1PredBody.lastIndexOf("vsubRaw =");
    expect(lastVsubAssign).toBeGreaterThan(extrapIdx);

    pnjlimSpy.mockRestore();
  });

  it("copies s1→s0 for VBE, VBC, VSUB at the start of the PRED branch", () => {
    // Verify the three state-slot copies via pnjlim's second arg (vold = s0[slot] after copy).
    // First pnjlim call: BE → vold = s0[VBE] = s1[VBE].
    // Second call: BC → vold = s0[VBC] = s1[VBC].
    // Third call: VSUB → vold = s0[VSUB] = s1[VSUB].
    const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");

    const element = makeBjtL1();
    const pool = initBjtPool(element);

    pool.states[1][BJT_SLOT_VBE]  = 0.72;
    pool.states[1][BJT_SLOT_VBC]  = -0.3;
    pool.states[1][BJT_SLOT_VSUB] = 0.01;
    // s0 sentinels differ from s1 to confirm copy happened
    pool.states[0][BJT_SLOT_VBE]  = 0.0;
    pool.states[0][BJT_SLOT_VBC]  = 0.0;
    pool.states[0][BJT_SLOT_VSUB] = 0.0;

    const ctx = buildBjtCtx(pool, MODETRAN | MODEINITPRED, 0.25);
    element.load(ctx);

    const calls = pnjlimSpy.mock.calls;
    // Three pnjlim calls in order: BE, BC, VSUB.
    // Second argument (vold) of each must equal the corresponding s1 value after copy.
    expect(calls[0][1]).toBe(0.72);   // VBE: s0[VBE] after copy = s1[VBE]
    expect(calls[1][1]).toBe(-0.3);   // VBC: s0[VBC] after copy = s1[VBC]
    expect(calls[2][1]).toBe(0.01);   // VSUB: s0[VSUB] after copy = s1[VSUB]

    pnjlimSpy.mockRestore();
  });

  it("runs pnjlim on all three junctions under MODEINITPRED", () => {
    const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");

    const element = makeBjtL1();
    const pool = initBjtPool(element);

    pool.states[1][BJT_SLOT_VBE] = 0.65;
    pool.states[2][BJT_SLOT_VBE] = 0.60;

    const ctx = buildBjtCtx(pool, MODETRAN | MODEINITPRED, 0.5);
    element.load(ctx);

    // Exactly 3 calls: BE, BC, substrate — this is the key ngspice-alignment assertion.
    expect(pnjlimSpy.mock.calls.length).toBe(3);

    pnjlimSpy.mockRestore();
  });

  it("skips pnjlim under MODEINITJCT / MODEINITSMSIG / MODEINITTRAN", () => {
    const element = makeBjtL1();
    const pool = initBjtPool(element);

    // Sub-case 1: MODEINITJCT
    {
      const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");
      const ctx = buildBjtCtx(pool, MODETRAN | MODEINITJCT, 0.0);
      element.load(ctx);
      expect(pnjlimSpy.mock.calls.length).toBe(0);
      pnjlimSpy.mockRestore();
    }

    // Sub-case 2: MODEINITSMSIG
    {
      const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");
      const ctx = buildBjtCtx(pool, MODETRAN | MODEINITSMSIG, 0.0);
      element.load(ctx);
      expect(pnjlimSpy.mock.calls.length).toBe(0);
      pnjlimSpy.mockRestore();
    }

    // Sub-case 3: MODEINITTRAN
    {
      const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");
      const ctx = buildBjtCtx(pool, MODETRAN | MODEINITTRAN, 0.0);
      element.load(ctx);
      expect(pnjlimSpy.mock.calls.length).toBe(0);
      pnjlimSpy.mockRestore();
    }
  });

  it("falls through to rhsOld when MODEINITPRED is not set", () => {
    const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");
    const element = makeBjtL1();
    const pool = initBjtPool(element);

    // vBi=node1(internal=ext when RB=0)=0.7, vCi=node2=0.0, vEi=node3=0.0 → vbeRaw=0.7
    const rhsOld = new Float64Array([0.7, 0.0, 0.0, 0.0]);

    const ctx = buildBjtCtx(pool, MODETRAN | MODEINITFLOAT, 0.5, rhsOld);
    element.load(ctx);

    // pnjlim's first call (BE junction) receives vbeRaw — must equal the rhsOld-derived value.
    // L1 rhsOld path calls pnjlim three times (BE + BC + substrate).
    expect(pnjlimSpy.mock.calls.length).toBe(3);
    expect(pnjlimSpy.mock.calls[0][0]).toBe(0.7);

    pnjlimSpy.mockRestore();
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
    // BJT L1 calls pnjlim exactly three times under MODEINITPRED: BE, BC, and substrate.
    const calls = pnjlimSpy.mock.calls;
    expect(calls.length).toBe(3);
    const copyVerifiedCall = calls.find((c) => c[1] === 0.42);
    expect(copyVerifiedCall).toBeDefined();

    pnjlimSpy.mockRestore();
  });
});
