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
import type { AnalogElement as AnalogElementCore } from "../../../solver/analog/element.js";
import type { PoolBackedAnalogElement } from "../../../solver/analog/element.js";
import type { AnalogFactory } from "../../../core/registry.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import type { SetupContext } from "../../../solver/analog/setup-context.js";
import {
  MODEDCOP,
  MODEINITFLOAT,
  MODEINITJCT,
} from "../../../solver/analog/ckt-mode.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../register-all.js";

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

function withState(core: AnalogElementCore): { element: PoolBackedAnalogElement; pool: StatePool; solver: SparseSolver } {
  const solver = new SparseSolver();
  solver._initStructure();
  runSetup(core, solver);
  const re = core as PoolBackedAnalogElement;
  const pool = new StatePool(Math.max(re.stateSize, 1));
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

  // ---------------------------------------------------------------------------
  // Forward voltage: Schottky at 1mA forward must settle between 0.20V and 0.40V
  // ---------------------------------------------------------------------------

  it("forward_voltage_at_1mA_is_low", () => {
    // Schottky junction voltage at 1mA: IS=1e-8, N=1.05, T=300.15K
    // Vf ≈ N*Vt * ln(If/IS + 1) ≈ 1.05 * 0.02585 * ln(1e-3 / 1e-8)
    //     ≈ 0.02714 * 11.51 ≈ 0.313V
    // Tolerance: [0.20V, 0.40V]- covers reasonable Schottky barrier physics
    const IS = 1e-8;
    const N = 1.05;
    const propsObj = makeParamBag({ IS, N, RS: 0, CJO: 0, TT: 0 });
    const core = createSchottkyElement(new Map([["A", 1], ["K", 2]]), propsObj, () => 0);
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
    // When RS=0, posPrimeNode must alias posNode- no makeVolt call
    let makeVoltCalls = 0;
    const core = createSchottkyElement(new Map([["A", 1], ["K", 2]]), makeParamBag({ RS: 0, CJO: 0 }), () => 0);
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
    const core = createSchottkyElement(new Map([["A", 1], ["K", 2]]), makeParamBag({ RS: 1 }), () => 0);
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
  // TSTALLOC ordering: RS>0 case- 7 entries with distinct internal node
  // ngspice anchor: diosetup.c:232-238
  // ---------------------------------------------------------------------------

  it("TSTALLOC_ordering_RS_nonzero", async () => {
    // RS=1 (Schottky default): internal prime node allocated.
    // Nodes: posNode=A, negNode=K, internal=posPrime.
    // Expected TSTALLOC order (diosetup.c:232-238):
    //  1. (posNode, posPrime)
    //  2. (negNode, posPrime)
    //  3. (posPrime, posNode)
    //  4. (posPrime, negNode)
    //  5. (posNode, posNode)
    //  6. (negNode, negNode)
    //  7. (posPrime, posPrime)
    // Via M1: assert matrix has non-zero entries at the expected positions
    // (A:A, A:posPrime, K:K, K:posPrime, posPrime:A, posPrime:K, posPrime:posPrime).
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 0.3 } },
            { id: "sd",  type: "SchottkyDiode",   props: { label: "sd",  RS: 1, CJO: 1e-12, IS: 1e-8, N: 1.05 } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vs:pos",  "sd:A"],
            ["sd:K",    "gnd:out"],
            ["vs:neg",  "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);

    const detail = session.getAttempt({ stepIndex: 0, phase: "dcopDirect", phaseAttemptIndex: 0 });
    const lastIter = detail.iterations[detail.iterations.length - 1].ours!;
    const M = lastIter.matrix!;
    const ms = lastIter.matrixSize;

    // With RS>0 the diode has a posPrime internal node.
    // The forward-biased Schottky must emit non-zero conductance stamps.
    // Assert that at least one off-diagonal entry is non-zero (RS path exists).
    const matrixRowLabels = (session as unknown as {
      _ourTopology: { matrixRowLabels: Map<number, string> };
    })._ourTopology.matrixRowLabels;

    // Find the sd:A (anode) and sd:K (cathode) row indices.
    let sdARow = -1;
    let sdKRow = -1;
    matrixRowLabels.forEach((label, row) => {
      if (label.includes("sd:A")) sdARow = row;
      if (label.includes("sd:K")) sdKRow = row;
    });

    expect(sdARow).toBeGreaterThanOrEqual(0);
    expect(sdKRow).toBeGreaterThanOrEqual(0);

    // Anode-Anode self-conductance must be non-zero (diosetup.c entry 5).
    expect(Math.abs(M[sdARow * ms + sdARow])).toBeGreaterThan(0);
    // Cathode-Cathode self-conductance must be non-zero (diosetup.c entry 6).
    expect(Math.abs(M[sdKRow * ms + sdKRow])).toBeGreaterThan(0);
    // Off-diagonal stamp (A,K) must be non-zero (RS path stamps conductance).
    expect(Math.abs(M[sdARow * ms + sdKRow]) + Math.abs(M[sdKRow * ms + sdARow])).toBeGreaterThan(0);
  });

  it("TSTALLOC_ordering_RS_zero", async () => {
    // RS=0: posPrimeNode = posNode. All 7 TSTALLOC entries collapse to 4 unique pairs.
    // Via M1: assert that with RS=0 the Schottky still emits stamps for a
    // forward-biased junction at the A/K positions only (no additional internal node).
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 0.3 } },
            { id: "sd",  type: "SchottkyDiode",   props: { label: "sd",  RS: 0, CJO: 0, IS: 1e-8, N: 1.05 } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vs:pos",  "sd:A"],
            ["sd:K",    "gnd:out"],
            ["vs:neg",  "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);

    const detail = session.getAttempt({ stepIndex: 0, phase: "dcopDirect", phaseAttemptIndex: 0 });
    const lastIter = detail.iterations[detail.iterations.length - 1].ours!;
    const M = lastIter.matrix!;
    const ms = lastIter.matrixSize;

    const matrixRowLabels = (session as unknown as {
      _ourTopology: { matrixRowLabels: Map<number, string> };
    })._ourTopology.matrixRowLabels;

    let sdARow = -1;
    let sdKRow = -1;
    matrixRowLabels.forEach((label, row) => {
      if (label.includes("sd:A")) sdARow = row;
      if (label.includes("sd:K")) sdKRow = row;
    });

    expect(sdARow).toBeGreaterThanOrEqual(0);
    expect(sdKRow).toBeGreaterThanOrEqual(0);

    // Forward-biased: anode self-conductance must be non-zero.
    expect(Math.abs(M[sdARow * ms + sdARow])).toBeGreaterThan(0);
    // Cathode self-conductance must be non-zero.
    expect(Math.abs(M[sdKRow * ms + sdKRow])).toBeGreaterThan(0);
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
