/**
 * Tests for the ZenerElement component.
 *
 * Covers engine-agnostic interface contracts and parameter plumbing only.
 * Hand-computed expected values deleted per A1 §Test handling rule
 * (spec/architectural-alignment.md §A1): assertions whose expected values
 * were computed by hand, not produced by ngspice, are subject to deletion
 * during A1 execution.
 */

import { describe, it, expect } from "vitest";
import { ZenerDiodeDefinition, createZenerElement, ZENER_PARAM_DEFS, ZENER_PARAM_DEFAULTS, ZENER_SPICE_L1_PARAM_DEFS } from "../zener.js";
import { PropertyBag } from "../../../core/properties.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import type { AnalogElement, PoolBackedAnalogElement } from "../../../solver/analog/element.js";
import type { AnalogFactory } from "../../../core/registry.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import type { SetupContext } from "../../../solver/analog/setup-context.js";
import { MODEDCOP, MODEINITFLOAT, MODEINITJCT } from "../../../solver/analog/ckt-mode.js";

// ---------------------------------------------------------------------------
// Helper: run real setup() on an element with a given solver, allocating
// all handles. Must be called before load() so that all TSTALLOC handles are valid.
// ---------------------------------------------------------------------------

function runSetup(core: AnalogElement, solver: SparseSolver): void {
  let stateCount = 0;
  let nodeCount = 100;
  const ctx: SetupContext = {
    solver,
    temp: 300.15,
    nomTemp: 300.15,
    copyNodesets: false,
    makeVolt(_label: string, _suffix: string): number { return ++nodeCount; },
    makeCur(_label: string, _suffix: string): number { return ++nodeCount; },
    allocStates(n: number): number {
      const off = stateCount;
      stateCount += n;
      return off;
    },
    findBranch(_label: string): number { return 0; },
    findDevice(_label: string) { return null; },
  };
  (core as any).setup(ctx);
}

// ---------------------------------------------------------------------------
// Helper: allocate a StatePool for a single element, run real setup() to
// allocate handles, and call initState.
// ---------------------------------------------------------------------------

function withState(core: AnalogElement): { element: PoolBackedAnalogElement; pool: StatePool; solver: SparseSolver } {
  const solver = new SparseSolver();
  solver._initStructure();
  runSetup(core, solver);
  const re = core as unknown as PoolBackedAnalogElement;
  const pool = new StatePool(Math.max(re.stateSize, 1));
  (re as PoolBackedAnalogElement & { _stateBase: number })._stateBase = 0;
  re.initState(pool);
  return { element: re, pool, solver };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParamBag(params: Record<string, number>): PropertyBag {
  const bag = new PropertyBag();
  bag.replaceModelParams(params);
  return bag;
}

/**
 * Build a bare LoadContext for a single-element unit test.
 */
function buildUnitCtx(
  solver: SparseSolver,
  rhsOld: Float64Array,
  overrides: Partial<LoadContext> = {},
): LoadContext {
  return {
    solver,
    matrix: solver,
    rhsOld: rhsOld,
    rhs: new Float64Array(rhsOld.length),
    cktMode: MODEDCOP | MODEINITFLOAT,
    time: 0,
    dt: 0,
    method: "trapezoidal",
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
    vt: 300.15 * 1.3806226e-23 / 1.6021918e-19,
    cktFixLimit: false,
    bypass: false,
    voltTol: 1e-6,
    ...overrides,
  } as LoadContext;
}

// ---------------------------------------------------------------------------
// Engine-agnostic interface contract tests (A1 survivors)
// ---------------------------------------------------------------------------

describe("Zener", () => {
  it("definition_has_correct_fields", () => {
    expect(ZenerDiodeDefinition.name).toBe("ZenerDiode");
    expect(ZenerDiodeDefinition.modelRegistry?.["spice"]).toBeDefined();
    expect(ZenerDiodeDefinition.modelRegistry?.["spice"]?.kind).toBe("inline");
    expect((ZenerDiodeDefinition.modelRegistry?.["spice"] as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
  });

  it("load_does_not_write_voltages", () => {
    // Verify that load() reads from voltages but does NOT write back.
    const propsObj = makeParamBag({ IS: 1e-14, N: 1, BV: 5.1, IBV: 1e-3 });
    const core = createZenerElement(new Map([["A", 1], ["K", 2]]), propsObj, () => 0);
    const { element, solver } = withState(core);
    const el = element;

    // 1-based: [0]=ground sentinel, [1]=nodeA, [2]=nodeK
    const voltages = new Float64Array([0, 0.7, 0.0]);
    const voltagesBefore = new Float64Array(voltages);

    (solver as any)._resetForAssembly();
    const ctx = buildUnitCtx(solver, voltages);
    el.load(ctx);

    // Voltages must be completely unchanged after load()
    expect(voltages[0]).toBe(voltagesBefore[0]);
    expect(voltages[1]).toBe(voltagesBefore[1]);
    expect(voltages[2]).toBe(voltagesBefore[2]);
  });

  it("setParam_accepts_known_keys", () => {
    // Parameter plumbing: setParam must not throw for known keys.
    const propsObj = makeParamBag({ IS: 1e-14, N: 1, BV: 5.1 });
    const core = createZenerElement(new Map([["A", 1], ["K", 2]]), propsObj, () => 0);
    const { element } = withState(core);
    // Engine-agnostic interface: setParam must accept recognised keys silently.
    expect(() => element.setParam("BV", 6.2)).not.toThrow();
    expect(() => element.setParam("IS", 1e-13)).not.toThrow();
    expect(() => element.setParam("N", 1.1)).not.toThrow();
    expect(() => element.setParam("NBV", 1.2)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Physical constants (mirroring zener.ts values)
// ---------------------------------------------------------------------------

const CONSTboltz = 1.3806226e-23;
const CHARGE = 1.6021918e-19;
const KoverQ = CONSTboltz / CHARGE;

// ---------------------------------------------------------------------------
// Zener primeJunctions tests
// ---------------------------------------------------------------------------

describe("Zener primeJunctions", () => {
  it("method_absent", () => {
    // primeJunctions() must NOT exist on the element — in-load MODEINITJCT priming
    // replaces it per dioload.c:130-138.
    const propsObj = makeParamBag({ IS: 1e-14, N: 1, BV: 5.1, IBV: 1e-3, TNOM: 300.15, TEMP: 300.15 });
    const core = createZenerElement(new Map([["A", 1], ["K", 2]]), propsObj, () => 0);
    const { element } = withState(core);
    expect((element as unknown as Record<string, unknown>)["primeJunctions"]).toBeUndefined();
  });

  it("MODEINITJCT_seeds_tVcrit", () => {
    // load() under MODEDCOP | MODEINITJCT with OFF==0 (default) must write
    // s0[SLOT_VD] = tVcrit = nVt * ln(nVt / (IS * sqrt(2))).  cite: dioload.c:135-136
    const IS = 1e-14;
    const N = 1;
    const TEMP = 300.15;
    const propsObj = makeParamBag({ IS, N, BV: 5.1, IBV: 1e-3, TNOM: 300.15, TEMP });
    const core = createZenerElement(new Map([["A", 1], ["K", 2]]), propsObj, () => 0);
    const { element, pool, solver } = withState(core);
    const el = element;

    const vt = TEMP * KoverQ;
    const nVt = N * vt;
    const expectedTVcrit = nVt * Math.log(nVt / (IS * Math.SQRT2));

    const voltages = new Float64Array(2);
    (solver as any)._resetForAssembly();
    const ctx = buildUnitCtx(solver, voltages, { cktMode: MODEDCOP | MODEINITJCT });
    el.load(ctx);

    expect(pool.state0[0]).toBeCloseTo(expectedTVcrit, 10);
  });

  it("MODEINITJCT_OFF_zeros_vd", () => {
    // load() under MODEDCOP | MODEINITJCT with OFF==1 must write s0[SLOT_VD] = 0.
    // cite: dioload.c:133-134
    const propsObj = makeParamBag({ IS: 1e-14, N: 1, BV: 5.1, IBV: 1e-3, TNOM: 300.15, TEMP: 300.15, OFF: 1 });
    const core = createZenerElement(new Map([["A", 1], ["K", 2]]), propsObj, () => 0);
    const { element, pool, solver } = withState(core);
    const el = element;

    const voltages = new Float64Array(2);
    (solver as any)._resetForAssembly();
    const ctx = buildUnitCtx(solver, voltages, { cktMode: MODEDCOP | MODEINITJCT });
    el.load(ctx);

    expect(pool.state0[0]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Zener TEMP tests
// ---------------------------------------------------------------------------

describe("Zener TEMP", () => {
  it("TEMP_default_300_15", () => {
    // After construction with full ZENER_PARAM_DEFAULTS (which includes TEMP),
    // getModelParam("TEMP") must return 300.15.
    const propsObj = makeParamBag({ ...ZENER_PARAM_DEFAULTS });
    expect(propsObj.getModelParam<number>("TEMP")).toBe(300.15);
  });

  it("paramDefs_include_TEMP", () => {
    // ZENER_PARAM_DEFS must include a "TEMP" entry in the secondary rank.
    const tempDef = ZENER_PARAM_DEFS.find((d) => d.key === "TEMP");
    expect(tempDef).toBeDefined();
    expect(tempDef!.rank).toBe("secondary");
    expect(tempDef!.default).toBe(300.15);
  });

  it("vt_reflects_TEMP", () => {
    // Construct zener with TEMP=400. Under MODEINITJCT, load() seeds
    // s0[SLOT_VD] = tp.tVcrit = nVt * ln(nVt / (IS * sqrt(2))).
    // nVt at 400K = 400 * KoverQ (with N=1).
    // Verify s0[SLOT_VD] equals the expected tVcrit at 400K.
    const IS = 1e-14;
    const N = 1;
    const TEMP = 400;
    const propsObj = makeParamBag({ IS, N, BV: 5.1, IBV: 1e-3, TNOM: 300.15, TEMP });
    const core = createZenerElement(new Map([["A", 1], ["K", 2]]), propsObj, () => 0);
    const { element, pool, solver } = withState(core);
    const el = element;

    const vt400 = TEMP * KoverQ;
    const nVt400 = N * vt400;
    const expectedTVcrit = nVt400 * Math.log(nVt400 / (IS * Math.SQRT2));

    const voltages = new Float64Array(2);
    (solver as any)._resetForAssembly();
    const ctx = buildUnitCtx(solver, voltages, { cktMode: MODEDCOP | MODEINITJCT });
    el.load(ctx);

    // s0[SLOT_VD = 0] is set to tVcrit under MODEINITJCT when OFF==0
    const storedVd = pool.state0[0];
    expect(storedVd).toBeCloseTo(expectedTVcrit, 10);
  });

  it("setParam_TEMP_recomputes", () => {
    // After setParam('TEMP', 400), load() under MODEINITJCT seeds s0[SLOT_VD]
    // with tVcrit recomputed at 400K — not at the original 300.15K.
    const IS = 1e-14;
    const N = 1;
    const propsObj = makeParamBag({ IS, N, BV: 5.1, IBV: 1e-3, TNOM: 300.15, TEMP: 300.15 });
    const core = createZenerElement(new Map([["A", 1], ["K", 2]]), propsObj, () => 0);
    const { element, pool, solver } = withState(core);
    const el = element;

    // Recompute expected tVcrit at 400K
    const vt400 = 400 * KoverQ;
    const nVt400 = N * vt400;
    const expectedTVcrit400 = nVt400 * Math.log(nVt400 / (IS * Math.SQRT2));

    // tVcrit at 300.15K (should differ)
    const vt300 = 300.15 * KoverQ;
    const nVt300 = N * vt300;
    const tVcrit300 = nVt300 * Math.log(nVt300 / (IS * Math.SQRT2));
    expect(expectedTVcrit400).not.toBeCloseTo(tVcrit300, 5);

    // Set TEMP to 400K — should trigger tp recompute
    element.setParam("TEMP", 400);

    const voltages = new Float64Array(2);
    (solver as any)._resetForAssembly();
    const ctx = buildUnitCtx(solver, voltages, { cktMode: MODEDCOP | MODEINITJCT });
    el.load(ctx);

    // s0[SLOT_VD] must reflect 400K tVcrit, not 300.15K
    const storedVd = pool.state0[0];
    expect(storedVd).toBeCloseTo(expectedTVcrit400, 10);
  });
});

// ---------------------------------------------------------------------------
// Zener schema partition layout tests
// ---------------------------------------------------------------------------

describe("ZENER_PARAM_DEFS partition layout", () => {
  it("TEMP has partition 'instance'", () => {
    const tempDef = ZENER_PARAM_DEFS.find((d) => d.key === "TEMP");
    expect(tempDef).toBeDefined();
    expect(tempDef!.partition).toBe("instance");
  });

  it("model params have partition 'model'", () => {
    const modelParamKeys = ["IS", "N", "BV", "NBV", "IBV", "TCV", "TNOM"];
    for (const key of modelParamKeys) {
      const def = ZENER_PARAM_DEFS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.partition).toBe("model");
    }
  });
});

describe("ZENER_SPICE_L1_PARAM_DEFS unchanged", () => {
  it("all SPICE_L1 defs have partition 'model'", () => {
    for (const def of ZENER_SPICE_L1_PARAM_DEFS) {
      expect(def.partition).toBe("model");
    }
  });
});
