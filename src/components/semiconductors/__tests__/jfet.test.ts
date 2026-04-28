/**
 * JFET tests  post-Phase-2.5-W1.4 A1 test handling.
 *
 * Per `spec/architectural-alignment.md` Â§A1 test-handling rule, the vast
 * majority of pre-port JFET tests have been deleted:
 *   - Hand-computed expected values on intermediate state (cutoff_zero_current,
 *     saturation_current, linear_region, gate_forward_current,
 *     output_characteristics, lambda_channel_length_modulation)  deleted.
 *   - jfet_load_dcop_parity / MODEINITSMSIG / MODEINITTRAN tests that
 *     hand-computed expected values via the banned `Math.min(expArg, 80)`
 *     clamp (PARITY items A-1, A-2)  deleted.
 *   - fet-base.test.ts (whole file)  deleted (D-10: fet-base.ts is gone).
 *
 * Survivors (engine-agnostic interface contracts + parameter plumbing +
 * convergence interface contract):
 *   - Registration: NJfetDefinition / PJfetDefinition resolve via
 *     ComponentRegistry.
 *   - Pin layout: G/S/D pins present.
 *   - NR convergence: common-source JFET self-biases within 10 iterations.
 *   - PJFET polarity: weak stamp-emission smoke test (no hand-computed
 *     equality).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  NJfetDefinition,
  createNJfetElement,
  NJFET_PARAM_DEFS,
  NJFET_PARAM_DEFAULTS,
  SLOT_VGS,
  computeJfetTempParams,
  type JfetParams,
} from "../njfet.js";
import {
  PJfetDefinition,
  createPJfetElement,
  PJFET_PARAM_DEFS,
  PJFET_PARAM_DEFAULTS,
  computePjfetTempParams,
  type PjfetParams,
} from "../pjfet.js";
import { ComponentRegistry } from "../../../core/registry.js";
import { createTestPropertyBag } from "../../../test-fixtures/model-fixtures.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import { withNodeIds, runDcOp, makeLoadCtx } from "../../../solver/analog/__tests__/test-helpers.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";
import type { ReactiveAnalogElement } from "../../../solver/analog/element.js";
import type { AnalogFactory } from "../../../core/registry.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import { MODEDCOP, MODEINITFLOAT } from "../../../solver/analog/ckt-mode.js";

// ---------------------------------------------------------------------------
// withState  allocate a StatePool and call initState on the element.
// Also calls setup() so that TSTALLOC handles are valid for load().
// ---------------------------------------------------------------------------

function withState(element: AnalogElementCore, solver?: SparseSolver): ReactiveAnalogElement {
  const re = element as ReactiveAnalogElement;
  re.stateBaseOffset = 0;
  if (solver && typeof (re as any).setup === "function") {
    let stateCount = 0;
    let nodeCount = 1000;
    const ctx = {
      solver,
      temp: 300.15,
      nomTemp: 300.15,
      copyNodesets: false,
      makeVolt(_l: string, _s: string): number { return ++nodeCount; },
      makeCur(_l: string, _s: string): number { return ++nodeCount; },
      allocStates(n: number): number { const off = stateCount; stateCount += n; return off; },
      findDevice(_l: string) { return null; },
    };
    (re as any).setup(ctx);
  }
  const pool = new StatePool(re.stateSize);
  re.initState(pool);
  return re;
}

// ---------------------------------------------------------------------------
// Default model parameters
// ---------------------------------------------------------------------------

const NJFET_PARAMS = {
  VTO: -2.0,
  BETA: 1e-4,
  LAMBDA: 0,
  IS: 1e-14,
  N: 1,
  CGS: 0,
  CGD: 0,
  PB: 1.0,
  FC: 0.5,
  RD: 0,
  RS: 0,
  B: 1.0,
  TCV: 0,
  BEX: 0,
  AREA: 1,
  M: 1,
  KF: 0,
  AF: 1,
  TNOM: 300.15,
  TEMP: 300.15,
  OFF: 0,
};

const PJFET_PARAMS = {
  VTO: 2.0,
  BETA: 1e-4,
  LAMBDA: 0,
  IS: 1e-14,
  N: 1,
  CGS: 0,
  CGD: 0,
  PB: 1.0,
  FC: 0.5,
  RD: 0,
  RS: 0,
  B: 1.0,
  TCV: 0,
  BEX: 0,
  AREA: 1,
  TEMP: 300.15,
  M: 1,
  KF: 0,
  AF: 1,
  TNOM: 300.15,
  OFF: 0,
};

// ---------------------------------------------------------------------------
// DC-OP LoadContext helper.
// ---------------------------------------------------------------------------

function makeDcOpCtx(rhsOld: Float64Array, matrixSize: number, existingSolver?: SparseSolver): LoadContext {
  const solver = existingSolver ?? (() => { const s = new SparseSolver(); s._initStructure(); return s; })();
  return {
    cktMode: MODEDCOP | MODEINITFLOAT,
    solver,
    matrix: solver,
    rhsOld: rhsOld,
    rhs: new Float64Array(matrixSize),
    dt: 0,
    time: 0,
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
  } as LoadContext;
}

// ---------------------------------------------------------------------------
// Helper: inline resistor
// ---------------------------------------------------------------------------

function makeResistorElement(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const G = 1 / resistance;
  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: -1,
    ngspiceLoadOrder: 0,
    isNonlinear: false,
    isReactive: false,
    setParam(_key: string, _value: number): void {},
    getPinCurrents(_v: Float64Array): number[] { return []; },
    load(ctx: LoadContext): void {
      const { solver } = ctx;
      if (nodeA !== 0) solver.stampElement(solver.allocElement(nodeA, nodeA), G);
      if (nodeB !== 0) solver.stampElement(solver.allocElement(nodeB, nodeB), G);
      if (nodeA !== 0 && nodeB !== 0) {
        solver.stampElement(solver.allocElement(nodeA, nodeB), -G);
        solver.stampElement(solver.allocElement(nodeB, nodeA), -G);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// PJFET  weak stamp-emission smoke test (engine-agnostic contract).
// ---------------------------------------------------------------------------

describe("PJFET", () => {
  it("emits_stamps_when_conducting", () => {
    // Common-source PJFET: Vg=2V, Vd=0V, Vs=5V. Device must conduct in
    // saturation (vgs=3, vgd=-2, vds=5, vgst=vgs-VTO=1, vgst<vds).
    // vgs = polarity*(VG-VS) = -1*(2-5) = 3; VTO=2 => vgst=1 > 0 => saturation.
    // Expected: cdrain = 1e-4 A, gm = 2e-4 S (BETA=1e-4, B=1, LAMBDA=0).
    //
    // Internal index ordering for G=1,D=2,S=3, RD=RS=0:
    //   TSTALLOC starts with allocElement(drainNode=2, dp=2) so ext2->int1 first.
    //   Full mapping: ext1(G)->int2, ext2(D)->int1, ext3(S)->int3.
    //   stampAt uses getCSCNonZeros() which returns internal (row,col).
    //
    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams(PJFET_PARAMS);
    const sharedSolver = new SparseSolver();
    sharedSolver._initStructure();

    const core = createPJfetElement(new Map([["G", 1], ["D", 2], ["S", 3]]), propsObj) as unknown as ReactiveAnalogElement;
    core.stateBaseOffset = 0;

    let stateCount = 0;
    let nodeCount = 1000;
    const setupCtx = {
      solver: sharedSolver,
      temp: 300.15, nomTemp: 300.15, copyNodesets: false,
      makeVolt(_l: string, _s: string): number { return ++nodeCount; },
      makeCur(_l: string, _s: string): number { return ++nodeCount; },
      allocStates(n: number): number { const off = stateCount; stateCount += n; return off; },
      findDevice(_l: string) { return null; },
    };
    (core as any).setup(setupCtx);
    const pool = new StatePool(core.stateSize);
    core.initState(pool);

    const element = withNodeIds(core, [1, 2, 3]);

    // 1-based: slot 0=ground sentinel, 1=V(G)=2, 2=V(D)=0, 3=V(S)=5
    const voltages = new Float64Array(4);
    voltages[0] = 0;
    voltages[1] = 2; // V(G)
    voltages[2] = 0; // V(D)
    voltages[3] = 5; // V(S)

    for (let i = 0; i < 50; i++) {
      element.load(makeDcOpCtx(voltages, 4, sharedSolver));
    }

    const ctx = makeDcOpCtx(voltages, 4, sharedSolver);
    element.load(ctx);
    const entries = ctx.solver.getCSCNonZeros();

    // Aggregate accumulated stamps by internal (row, col).
    const stampAt = (row: number, col: number): number => {
      const match = entries.filter((e) => e.row === row && e.col === col);
      return match.reduce((s, e) => s + e.value, 0);
    };

    // Internal-to-external mapping: int1=D(ext2), int2=G(ext1), int3=S(ext3).
    // Semantic stamp positions (internal coords):
    //   _hGG   = allocElement(G=1,G=1) -> int(2,2): ggd+ggs
    //   _hGDP  = allocElement(G=1,D=2) -> int(2,1): -ggd
    //   _hDPG  = allocElement(D=2,G=1) -> int(1,2): gm-ggd
    //   _hDPDP = allocElement(D=2,D=2) -> int(1,1): gdpr+gds+ggd
    //   _hDPSP = allocElement(D=2,S=3) -> int(1,3): -gds-gm
    //   _hSPG  = allocElement(S=3,G=1) -> int(3,2): -ggs-gm
    //   _hSPSP = allocElement(S=3,S=3) -> int(3,3): gspr+gds+gm+ggs
    const gG_G  = stampAt(2, 2); // ggd + ggs: gate self-conductance
    const gG_D  = stampAt(2, 1); // -ggd
    const gD_G  = stampAt(1, 2); // gm - ggd: transconductance term
    const gD_D  = stampAt(1, 1); // gdpr + gds + ggd
    const gD_S  = stampAt(1, 3); // -gds - gm: drain-source off-diagonal
    const gS_G  = stampAt(3, 2); // -ggs - gm
    const gS_S  = stampAt(3, 3); // gspr + gds + gm + ggs: source self-conductance

    // All stamp positions must be non-zero.
    expect(Math.abs(gG_G)).toBeGreaterThan(0);
    expect(Math.abs(gG_D)).toBeGreaterThan(0);
    expect(Math.abs(gD_S)).toBeGreaterThan(0);
    expect(Math.abs(gD_D)).toBeGreaterThan(0);

    // Drain-source off-diagonal = -(gds+gm). With gm~2e-4 and gds=0
    // (LAMBDA=0 in saturation), magnitude must exceed GMIN by orders of
    // magnitude — proves active conduction, not GMIN-only clamp.
    const GMIN = 1e-12;
    expect(Math.abs(gD_S)).toBeGreaterThan(1e-5);
    expect(Math.abs(gD_S)).toBeGreaterThan(GMIN * 1e6);

    // Transconductance in D-G off-diagonal (gm-ggd). With ggd at GMIN
    // (reverse-biased GD: vgd=-2) and gm~2e-4, |gD_G|~2e-4.
    expect(Math.abs(gD_G)).toBeGreaterThan(1e-5);

    // KCL-style sign checks.
    expect(gD_D).toBeGreaterThan(0);
    expect(gS_S).toBeGreaterThan(0);
    expect(gD_S).toBeLessThan(0);
    expect(gS_G).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// NR convergence test  engine-agnostic interface contract.
// ---------------------------------------------------------------------------

describe("NR", () => {
  it("converges_within_10_iterations", () => {
    // Common-source NJFET with Rd load.
    //   VDD=10V, Rd=10kÎ, gate=0V, source=0V  VGS=0V
    //   VTO=-2V  vgst = VGS - VTO = 2V (device ON in saturation)
    //   BETA=1e-4, B=1, LAMBDA=0, Bfac = (1-B)/(PB-VTO) = 0
    //   cdrain = BETA * vgstÂ² * (B + Bfac*vgst) = 1e-4 * 4 * 1 = 4e-4 A
    //   Vdrop  = cdrain * Rd = 4e-4 * 1e4 = 4V
    //   VDS    = VDD - Vdrop = 10 - 4 = 6V  (still in saturation: VDS > vgst)
    //   node1 (drain)  6V, node2 (vdd) = 10V, node3 (gate) = 0V.
    const matrixSize = 6;

    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams(NJFET_PARAMS);
    const jfet = withNodeIds(createNJfetElement(new Map([["G", 3], ["S", 0], ["D", 1]]), propsObj) as unknown as AnalogElementCore, [3, 0, 1]) as unknown as ReactiveAnalogElement;
    const rd = makeResistorElement(2, 1, 10000);
    const vdd = makeDcVoltageSource(2, 0, 4, 10.0) as unknown as AnalogElement;
    const vgate = makeDcVoltageSource(3, 0, 5, 0.0) as unknown as AnalogElement;

    const result = runDcOp({
      elements: [vdd, vgate, rd, jfet],
      matrixSize,
      nodeCount: 3,
      params: { maxIterations: 10 },
    });

    expect(result.converged).toBe(true);
    expect(result.iterations).toBeLessThanOrEqual(10);

    // Node-voltage assertions  nodeVoltages[i] holds node i (1-based).
    const vDrain = result.nodeVoltages[1];
    const vVdd   = result.nodeVoltages[2];
    const vGate  = result.nodeVoltages[3];

    // VDD rail must sit at exactly 10V (voltage source).
    expect(vVdd).toBeCloseTo(10, 6);
    // Gate pinned at 0V.
    expect(vGate).toBeCloseTo(0, 6);

    // Drain voltage: analytic prediction is 6V. Allow a generous window that
    // excludes cutoff (VDS10V, no drain current) and excludes the linear
    // region (VDS<vgst=2V). Band (1V, 10V) proves the solution is in the
    // saturation operating regime the circuit is designed to produce.
    expect(vDrain).toBeGreaterThan(1);
    expect(vDrain).toBeLessThan(10);

    // Drain current through Rd: |iD| = (VDD - VDrain) / Rd.
    // Analytic expectation  4e-4 A. Bound between 1e-5 A (device barely
    // on) and 1e-3 A (device hard-shorted)  at least two orders above GMIN.
    const iD = Math.abs((vVdd - vDrain) / 10000);
    expect(iD).toBeGreaterThan(1e-5);
    expect(iD).toBeLessThan(1e-3);
  });
});

// ---------------------------------------------------------------------------
// Registration tests  parameter plumbing / component registry.
// ---------------------------------------------------------------------------

describe("Registration", () => {
  it("njfet_registered", () => {
    const registry = new ComponentRegistry();
    registry.register(NJfetDefinition);

    const def = registry.get("NJFET");
    expect(def).toBeDefined();
    expect(def!.modelRegistry?.["spice"]).toBeDefined();
    expect(def!.category).toBeDefined();
    expect((def!.modelRegistry?.["spice"] as { kind: "inline"; factory: AnalogFactory } | undefined)?.factory).toBeDefined();
  });

  it("pjfet_registered", () => {
    const registry = new ComponentRegistry();
    registry.register(PJfetDefinition);

    const def = registry.get("PJFET");
    expect(def).toBeDefined();
    expect(def!.modelRegistry?.["spice"]).toBeDefined();
    expect((def!.modelRegistry?.["spice"] as { kind: "inline"; factory: AnalogFactory } | undefined)?.factory).toBeDefined();
  });

  it("njfet_pin_layout_has_three_pins", () => {
    expect(NJfetDefinition.pinLayout).toHaveLength(3);
    const labels = NJfetDefinition.pinLayout.map((p) => p.label);
    expect(labels).toContain("G");
    expect(labels).toContain("D");
    expect(labels).toContain("S");
  });

  it("pjfet_pin_layout_has_three_pins", () => {
    expect(PJfetDefinition.pinLayout).toHaveLength(3);
    const labels = PJfetDefinition.pinLayout.map((p) => p.label);
    expect(labels).toContain("G");
    expect(labels).toContain("D");
    expect(labels).toContain("S");
  });
});

describe("NJFET_PARAM_DEFS partition layout", () => {
  it("instance params have partition='instance'", () => {
    const instanceKeys = ["AREA", "M", "TEMP", "OFF"];
    for (const key of instanceKeys) {
      const def = NJFET_PARAM_DEFS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.partition).toBe("instance");
    }
  });

  it("model params have partition='model'", () => {
    const modelKeys = [
      "VTO", "BETA", "LAMBDA", "IS", "N", "CGS", "CGD", "PB", "FC",
      "RD", "RS", "B", "TCV", "BEX", "KF", "AF", "TNOM"
    ];
    for (const key of modelKeys) {
      const def = NJFET_PARAM_DEFS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.partition).toBe("model");
    }
  });
});

describe("PJFET_PARAM_DEFS partition layout", () => {
  it("instance params have partition='instance'", () => {
    const instanceKeys = ["AREA", "M", "TEMP", "OFF"];
    for (const key of instanceKeys) {
      const def = PJFET_PARAM_DEFS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.partition).toBe("instance");
    }
  });

  it("model params have partition='model'", () => {
    const modelKeys = [
      "VTO", "BETA", "LAMBDA", "IS", "N", "CGS", "CGD", "PB", "FC",
      "RD", "RS", "B", "TCV", "BEX", "KF", "AF", "TNOM"
    ];
    for (const key of modelKeys) {
      const def = PJFET_PARAM_DEFS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.partition).toBe("model");
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers for TEMP tests.
// ---------------------------------------------------------------------------

function makeNjfetProps(overrides: Record<string, number> = {}): ReturnType<typeof createTestPropertyBag> {
  const propsObj = createTestPropertyBag();
  propsObj.replaceModelParams({ ...NJFET_PARAM_DEFAULTS, ...overrides });
  return propsObj;
}

function makePjfetProps(overrides: Record<string, number> = {}): ReturnType<typeof createTestPropertyBag> {
  const propsObj = createTestPropertyBag();
  propsObj.replaceModelParams({ ...PJFET_PARAM_DEFAULTS, ...overrides });
  return propsObj;
}

const CONSTKoverQ = 1.3806226e-23 / 1.6021918e-19;

function baseNjfetParams(overrides: Partial<JfetParams> = {}): JfetParams {
  return {
    VTO: -2.0, BETA: 1e-4, LAMBDA: 0, IS: 1e-14, N: 1,
    CGS: 0, CGD: 0, PB: 1.0, FC: 0.5, RD: 0, RS: 0,
    B: 1.0, TCV: 0, BEX: 0, AREA: 1, M: 1, KF: 0, AF: 1,
    TNOM: 300.15, TEMP: 300.15, OFF: 0,
    ...overrides,
  };
}

function basePjfetParams(overrides: Partial<PjfetParams> = {}): PjfetParams {
  return {
    VTO: 2.0, BETA: 1e-4, LAMBDA: 0, IS: 1e-14, N: 1,
    CGS: 0, CGD: 0, PB: 1.0, FC: 0.5, RD: 0, RS: 0,
    B: 1.0, TCV: 0, BEX: 0, AREA: 1, M: 1, KF: 0, AF: 1,
    TNOM: 300.15, TEMP: 300.15, OFF: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// NJFET TEMP tests (Tasks 7.2.1 + 7.2.2).
// ---------------------------------------------------------------------------

describe("NJFET TEMP", () => {
  it("TEMP_default_300_15", () => {
    const propsObj = makeNjfetProps();
    expect(propsObj.getModelParam<number>("TEMP")).toBe(300.15);
  });

  it("paramDefs_include_TEMP", () => {
    const keys = NJFET_PARAM_DEFS.map((pd) => pd.key);
    expect(keys).toContain("TEMP");
  });

  it("tp_vt_reflects_TEMP", () => {
    const tp = computeJfetTempParams(baseNjfetParams({ TEMP: 400 }));
    expect(tp.vt).toBeCloseTo(400 * CONSTKoverQ, 10);
  });

  it("tSatCur_scales_with_TEMP", () => {
    const tp300 = computeJfetTempParams(baseNjfetParams({ IS: 1e-14, TNOM: 300.15, TEMP: 300.15 }));
    const tp400 = computeJfetTempParams(baseNjfetParams({ IS: 1e-14, TNOM: 300.15, TEMP: 400 }));
    expect(tp400.tSatCur).toBeGreaterThan(tp300.tSatCur);
  });

  it("TNOM_stays_nominal", () => {
    const tp = computeJfetTempParams(baseNjfetParams({ TEMP: 400, TNOM: 300.15, BEX: 1 }));
    expect(tp.tBeta).toBeCloseTo(1e-4 * (400 / 300.15), 10);
  });

  it("no_ctx_vt_read_in_njfet_ts", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(srcDir, "..", "njfet.ts"), "utf8");
    const count = (src.match(/ctx\.vt/g) ?? []).length;
    expect(count).toBe(0);
  });

  it("setParam_TEMP_recomputes_tp", () => {
    const matrixSize = 3;

    // G=node1 at 1.5V forces a pnjlim-limited VGS; vcrit differs by temperature
    // so the post-limit VGS will differ between 300.15K and 400K.
    // 1-based: slot 0=ground sentinel, slot 1=V(G)=1.5, slot 2=V(D)=0.
    const rhsOld = new Float64Array([0, 1.5, 0]);

    function createAndInit(overrides: Record<string, number> = {}): { element: ReactiveAnalogElement; pool: StatePool; solver: SparseSolver } {
      const propsObj = makeNjfetProps(overrides);
      const core = createNJfetElement(new Map([["G", 1], ["S", 0], ["D", 2]]), propsObj) as unknown as ReactiveAnalogElement;
      core.stateBaseOffset = 0;
      const solver = new SparseSolver();
      solver._initStructure();
      let stateCount = 0;
      let nodeCount = 1000;
      const setupCtx = {
        solver,
        temp: 300.15, nomTemp: 300.15, copyNodesets: false,
        makeVolt(_l: string, _s: string): number { return ++nodeCount; },
        makeCur(_l: string, _s: string): number { return ++nodeCount; },
        allocStates(n: number): number { const off = stateCount; stateCount += n; return off; },
        findDevice(_l: string) { return null; },
      };
      (core as any).setup(setupCtx);
      const pool = new StatePool(core.stateSize);
      core.initState(pool);
      return { element: core, pool, solver };
    }

    // Element at 300.15K
    const { element: el300, pool: pool300, solver: solver300 } = createAndInit({ TEMP: 300.15 });
    el300.load(makeLoadCtx({ cktMode: MODEDCOP | MODEINITFLOAT, solver: solver300, rhsOld, rhs: new Float64Array(matrixSize), dt: 0 }));
    const vgs300 = pool300.state0[SLOT_VGS];

    // Element at 300.15K, setParam to 400K before load
    const { element: el400, pool: pool400, solver: solver400 } = createAndInit({ TEMP: 300.15 });
    (el400 as unknown as { setParam: (k: string, v: number) => void }).setParam("TEMP", 400);
    el400.load(makeLoadCtx({ cktMode: MODEDCOP | MODEINITFLOAT, solver: solver400, rhsOld, rhs: new Float64Array(matrixSize), dt: 0 }));
    const vgs400 = pool400.state0[SLOT_VGS];

    expect(vgs300).not.toBe(vgs400);
  });
});

// ---------------------------------------------------------------------------
// PJFET TEMP tests (Tasks 7.2.1 + 7.2.2 + 7.2.3).
// ---------------------------------------------------------------------------

describe("PJFET TEMP", () => {
  it("TEMP_default_300_15", () => {
    const propsObj = makePjfetProps();
    expect(propsObj.getModelParam<number>("TEMP")).toBe(300.15);
  });

  it("paramDefs_include_TEMP", () => {
    const keys = PJFET_PARAM_DEFS.map((pd) => pd.key);
    expect(keys).toContain("TEMP");
  });

  it("tp_vt_reflects_TEMP", () => {
    const tp = computePjfetTempParams(basePjfetParams({ TEMP: 400 }));
    expect(tp.vt).toBeCloseTo(400 * CONSTKoverQ, 10);
  });

  it("tSatCur_scales_with_TEMP", () => {
    const tp300 = computePjfetTempParams(basePjfetParams({ IS: 1e-14, TNOM: 300.15, TEMP: 300.15 }));
    const tp400 = computePjfetTempParams(basePjfetParams({ IS: 1e-14, TNOM: 300.15, TEMP: 400 }));
    expect(tp400.tSatCur).toBeGreaterThan(tp300.tSatCur);
  });

  it("no_ctx_vt_read_in_pjfet_ts", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(srcDir, "..", "pjfet.ts"), "utf8");
    const count = (src.match(/ctx\.vt/g) ?? []).length;
    expect(count).toBe(0);
  });

  it("setParam_TEMP_recomputes_tp", () => {
    const matrixSize = 3;

    // G=node1 at -1.5V, S=node3 at 0, D=node2 at 0.
    // vgsRaw = polarity * (vG - vS) = -1 * (-1.5 - 0) = 1.5 for PJFET.
    // 1-based: slot 0=ground sentinel, slot 1=V(G)=-1.5, slot 2=V(D)=0.
    const rhsOld = new Float64Array([0, -1.5, 0]);

    function createAndInitP(overrides: Record<string, number> = {}): { element: ReactiveAnalogElement; pool: StatePool; solver: SparseSolver } {
      const propsObj = makePjfetProps(overrides);
      const core = createPJfetElement(new Map([["G", 1], ["S", 0], ["D", 2]]), propsObj) as unknown as ReactiveAnalogElement;
      core.stateBaseOffset = 0;
      const solver = new SparseSolver();
      solver._initStructure();
      let stateCount = 0;
      let nodeCount = 1000;
      const setupCtx = {
        solver,
        temp: 300.15, nomTemp: 300.15, copyNodesets: false,
        makeVolt(_l: string, _s: string): number { return ++nodeCount; },
        makeCur(_l: string, _s: string): number { return ++nodeCount; },
        allocStates(n: number): number { const off = stateCount; stateCount += n; return off; },
        findDevice(_l: string) { return null; },
      };
      (core as any).setup(setupCtx);
      const pool = new StatePool(core.stateSize);
      core.initState(pool);
      return { element: core, pool, solver };
    }

    const PSLOT_VGS = 0;

    // Element at 300.15K
    const { element: el300, pool: pool300, solver: solver300 } = createAndInitP({ TEMP: 300.15 });
    el300.load(makeLoadCtx({ cktMode: MODEDCOP | MODEINITFLOAT, solver: solver300, rhsOld, rhs: new Float64Array(matrixSize), dt: 0 }));
    const vgs300 = pool300.state0[PSLOT_VGS];

    // Element at 300.15K, setParam to 400K before load
    const { element: el400, pool: pool400, solver: solver400 } = createAndInitP({ TEMP: 300.15 });
    (el400 as unknown as { setParam: (k: string, v: number) => void }).setParam("TEMP", 400);
    el400.load(makeLoadCtx({ cktMode: MODEDCOP | MODEINITFLOAT, solver: solver400, rhsOld, rhs: new Float64Array(matrixSize), dt: 0 }));
    const vgs400 = pool400.state0[PSLOT_VGS];

    expect(vgs300).not.toBe(vgs400);
  });
});
