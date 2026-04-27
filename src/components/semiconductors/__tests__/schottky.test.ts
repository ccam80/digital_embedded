/**
 * Tests for the Schottky diode component.
 *
 * The Schottky diode delegates entirely to createDiodeElement with
 * Schottky-tuned default parameters (higher IS, lower Vf, RS=1Ω, CJO=1pF).
 *
 * Covers:
 *   - Forward voltage is lower than silicon (~0.2V–0.4V at 1mA)
 *   - RS conditional internal node: RS>0 allocates internal prime node
 *   - TSTALLOC ordering with RS>0 (7 entries with distinct internal node)
 *   - Definition shape
 */

import { describe, it, expect } from "vitest";
import { SchottkyDiodeDefinition, createSchottkyElement, SCHOTTKY_PARAM_DEFAULTS, SCHOTTKY_PARAM_DEFS } from "../schottky.js";
import { DIODE_PARAM_DEFAULTS } from "../diode.js";
import { PropertyBag } from "../../../core/properties.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";
import type { ReactiveAnalogElement } from "../../../solver/analog/element.js";
import type { AnalogFactory } from "../../../core/registry.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import type { SetupContext } from "../../../solver/analog/setup-context.js";
import {
  MODEDCOP,
  MODEINITFLOAT,
  MODEINITJCT,
} from "../../../solver/analog/ckt-mode.js";
import { MNAEngine } from "../../../solver/analog/analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../../../solver/analog/analog-engine.js";
import type { AnalogElement } from "../../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// Helper: run real setup() on an element, allocating all handles.
// Must be called before load() so that all TSTALLOC handles are valid.
// ---------------------------------------------------------------------------

function runSetup(core: AnalogElementCore, solver: SparseSolver): void {
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
// Helper: allocate a StatePool for a single element, run real setup(),
// and call initState.
// ---------------------------------------------------------------------------

function withState(core: AnalogElementCore): { element: ReactiveAnalogElement; pool: StatePool; solver: SparseSolver } {
  const solver = new SparseSolver();
  solver._initStructure();
  runSetup(core, solver);
  const re = core as ReactiveAnalogElement;
  const pool = new StatePool(Math.max(re.stateSize, 1));
  re.stateBaseOffset = 0;
  re.initState(pool);
  return { element: re, pool, solver };
}

// ---------------------------------------------------------------------------
// Helper: build a bare LoadContext for unit tests
// ---------------------------------------------------------------------------

function buildUnitCtx(
  solver: SparseSolver,
  rhsOld: Float64Array,
  overrides: Partial<LoadContext> = {},
): LoadContext {
  return {
    solver,
    matrix: solver,
    rhsOld,
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
// Helper: build minimal ConcreteCompiledAnalogCircuit for engine._setup()
// ---------------------------------------------------------------------------

function makeMinimalCircuit(
  elements: AnalogElement[],
  nodeCount: number,
): ConcreteCompiledAnalogCircuit {
  return {
    nodeCount,
    elements,
    labelToNodeId: new Map(),
    labelPinNodes: new Map(),
    wireToNodeId: new Map(),
    models: new Map(),
    statePool: null,
    componentCount: elements.length,
    netCount: nodeCount,
    diagnostics: [],
    branchCount: 0,
    matrixSize: nodeCount,
    bridgeOutputAdapters: [],
    bridgeInputAdapters: [],
    elementToCircuitElement: new Map(),
    resolvedPins: [],
  } as unknown as ConcreteCompiledAnalogCircuit;
}

function makeParamBag(params: Record<string, number>): PropertyBag {
  const bag = new PropertyBag();
  bag.replaceModelParams({ ...DIODE_PARAM_DEFAULTS, ...SCHOTTKY_PARAM_DEFAULTS, ...params });
  return bag;
}

// ---------------------------------------------------------------------------
// Schottky diode tests
// ---------------------------------------------------------------------------

describe("Schottky", () => {
  it("definition_has_correct_fields", () => {
    expect(SchottkyDiodeDefinition.name).toBe("SchottkyDiode");
    expect(SchottkyDiodeDefinition.modelRegistry?.["spice"]).toBeDefined();
    expect(SchottkyDiodeDefinition.modelRegistry?.["spice"]?.kind).toBe("inline");
    expect((SchottkyDiodeDefinition.modelRegistry?.["spice"] as { kind: "inline"; factory: AnalogFactory } | undefined)?.factory).toBeDefined();
  });

  it("isNonlinear_true", () => {
    const propsObj = makeParamBag({});
    const core = createSchottkyElement(new Map([["A", 1], ["K", 2]]), propsObj);
    expect(core.isNonlinear).toBe(true);
  });

  it("isReactive_true_when_cjo_nonzero", () => {
    // SCHOTTKY_PARAM_DEFAULTS has CJO=1e-12 (1pF) → reactive
    const propsObj = makeParamBag({});
    const core = createSchottkyElement(new Map([["A", 1], ["K", 2]]), propsObj);
    expect(core.isReactive).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Forward voltage: Schottky at 1mA forward must settle between 0.20V and 0.40V
  // ---------------------------------------------------------------------------

  it("forward_voltage_at_1mA_is_low", () => {
    // Schottky junction voltage at 1mA: IS=1e-8, N=1.05, T=300.15K
    // Vf ≈ N*Vt * ln(If/IS + 1) ≈ 1.05 * 0.02585 * ln(1e-3 / 1e-8)
    //     ≈ 0.02714 * 11.51 ≈ 0.313V
    // Tolerance: [0.20V, 0.40V] — covers reasonable Schottky barrier physics
    const IS = 1e-8;
    const N = 1.05;
    const propsObj = makeParamBag({ IS, N, RS: 0, CJO: 0, TT: 0 });
    const core = createSchottkyElement(new Map([["A", 1], ["K", 2]]), propsObj);
    const { element, pool, solver } = withState(core);

    // Run MODEINITJCT to seed state, then drive to 0.3V operating point
    const voltages = new Float64Array(3);
    voltages[1] = 0.3;
    voltages[2] = 0;

    // Seed with initJct to get a starting VD
    (solver as any)._resetForAssembly();
    (element as any).load(buildUnitCtx(solver, voltages, { cktMode: MODEDCOP | MODEINITJCT }));

    // Iterate load() to drive toward stable operating point
    for (let i = 0; i < 30; i++) {
      (solver as any)._resetForAssembly();
      (element as any).load(buildUnitCtx(solver, voltages, { cktMode: MODEDCOP | MODEINITFLOAT }));
    }

    // SLOT_VD is index 0 in state0
    const vd = pool.state0[0];
    expect(vd).toBeGreaterThan(0.20);
    expect(vd).toBeLessThan(0.40);
  });

  // ---------------------------------------------------------------------------
  // RS conditional internal node
  // ---------------------------------------------------------------------------

  it("RS_zero_no_internal_node", () => {
    // When RS=0, posPrimeNode must alias posNode — no makeVolt call
    let makeVoltCalls = 0;
    const core = createSchottkyElement(new Map([["A", 1], ["K", 2]]), makeParamBag({ RS: 0, CJO: 0 }));
    const solver = new SparseSolver();
    solver._initStructure();
    let stateCount = 0;
    let nodeCount = 100;
    const ctx: SetupContext = {
      solver,
      temp: 300.15,
      nomTemp: 300.15,
      copyNodesets: false,
      makeVolt(_label: string, _suffix: string): number {
        makeVoltCalls++;
        return ++nodeCount;
      },
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
    expect(makeVoltCalls).toBe(0);
  });

  it("RS_nonzero_allocates_internal_node", () => {
    // When RS > 0, makeVolt must be called exactly once for the internal prime node
    let makeVoltCalls = 0;
    const core = createSchottkyElement(new Map([["A", 1], ["K", 2]]), makeParamBag({ RS: 1 }));
    const solver = new SparseSolver();
    solver._initStructure();
    let stateCount = 0;
    let nodeCount = 100;
    const ctx: SetupContext = {
      solver,
      temp: 300.15,
      nomTemp: 300.15,
      copyNodesets: false,
      makeVolt(_label: string, _suffix: string): number {
        makeVoltCalls++;
        return ++nodeCount;
      },
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
    expect(makeVoltCalls).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // TSTALLOC ordering: RS>0 case — 7 entries with distinct internal node
  // ---------------------------------------------------------------------------

  it("TSTALLOC_ordering_RS_nonzero", () => {
    // ngspice anchor: diosetup.c:232-238 — 7 entries.
    // RS=1 (Schottky default): _posPrimeNode = internal node = 3 (nodeCount+1).
    // Nodes: posNode=1 (A), negNode=2 (K), internal=3.
    // Expected:
    //  1. (1,3) posNode, _posPrimeNode
    //  2. (2,3) negNode, _posPrimeNode
    //  3. (3,1) _posPrimeNode, posNode
    //  4. (3,2) _posPrimeNode, negNode
    //  5. (1,1) posNode, posNode
    //  6. (2,2) negNode, negNode
    //  7. (3,3) _posPrimeNode, _posPrimeNode
    const props = new PropertyBag();
    props.replaceModelParams({
      IS: 1e-8, N: 1.05, RS: 1, CJO: 1e-12, VJ: 0.6, M: 0.5, TT: 0,
      FC: 0.5, BV: 40, IBV: 1e-3, EG: 0.69, XTI: 2, KF: 0, AF: 1,
      NBV: NaN, IKF: Infinity, IKR: Infinity, AREA: 1, OFF: 0, IC: NaN,
      ISW: 0, NSW: NaN, TEMP: 300.15, TNOM: 300.15,
    });
    const el = createSchottkyElement(new Map([["A", 1], ["K", 2]]), props);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 3 },  // (1) posNode, _posPrimeNode
      { extRow: 2, extCol: 3 },  // (2) negNode, _posPrimeNode
      { extRow: 3, extCol: 1 },  // (3) _posPrimeNode, posNode
      { extRow: 3, extCol: 2 },  // (4) _posPrimeNode, negNode
      { extRow: 1, extCol: 1 },  // (5) posNode, posNode
      { extRow: 2, extCol: 2 },  // (6) negNode, negNode
      { extRow: 3, extCol: 3 },  // (7) _posPrimeNode, _posPrimeNode
    ]);
  });

  it("TSTALLOC_ordering_RS_zero", () => {
    // RS=0: _posPrimeNode = posNode=1. All 7 entries collapse to 4 unique pairs.
    // Entries with both row and col >= 1 are recorded.
    // Expected (same as PB-DIO RS=0):
    //  1. (1,1), 2. (2,1), 3. (1,1), 4. (1,2), 5. (1,1), 6. (2,2), 7. (1,1)
    const props = new PropertyBag();
    props.replaceModelParams({
      IS: 1e-8, N: 1.05, RS: 0, CJO: 0, VJ: 0.6, M: 0.5, TT: 0,
      FC: 0.5, BV: 40, IBV: 1e-3, EG: 0.69, XTI: 2, KF: 0, AF: 1,
      NBV: NaN, IKF: Infinity, IKR: Infinity, AREA: 1, OFF: 0, IC: NaN,
      ISW: 0, NSW: NaN, TEMP: 300.15, TNOM: 300.15,
    });
    const el = createSchottkyElement(new Map([["A", 1], ["K", 2]]), props);
    const circuit = makeMinimalCircuit([el as unknown as AnalogElement], 2);
    const engine = new MNAEngine();
    engine.init(circuit);
    (engine as any)._setup();
    const order = (engine as any)._solver._getInsertionOrder();
    expect(order).toEqual([
      { extRow: 1, extCol: 1 },  // (1) posNode, _posPrimeNode (alias)
      { extRow: 2, extCol: 1 },  // (2) negNode, _posPrimeNode (alias)
      { extRow: 1, extCol: 1 },  // (3) _posPrimeNode (alias), posNode
      { extRow: 1, extCol: 2 },  // (4) _posPrimeNode (alias), negNode
      { extRow: 1, extCol: 1 },  // (5) posNode, posNode
      { extRow: 2, extCol: 2 },  // (6) negNode, negNode
      { extRow: 1, extCol: 1 },  // (7) _posPrimeNode (alias), _posPrimeNode (alias)
    ]);
  });
});

// ---------------------------------------------------------------------------
// SCHOTTKY_PARAM_DEFS partition layout
// ---------------------------------------------------------------------------

describe("SCHOTTKY_PARAM_DEFS partition layout", () => {
  it("primary params have partition 'model'", () => {
    for (const key of ["IS", "N"]) {
      const def = SCHOTTKY_PARAM_DEFS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.partition).toBe("model");
    }
  });

  it("secondary params have partition 'model'", () => {
    for (const key of ["RS", "CJO", "VJ", "M", "TT", "FC", "BV", "IBV", "EG", "XTI", "KF", "AF"]) {
      const def = SCHOTTKY_PARAM_DEFS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.partition).toBe("model");
    }
  });
});
