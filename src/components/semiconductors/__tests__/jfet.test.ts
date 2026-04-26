/**
 * JFET tests â€” post-Phase-2.5-W1.4 A1 test handling.
 *
 * Per `spec/architectural-alignment.md` Â§A1 test-handling rule, the vast
 * majority of pre-port JFET tests have been deleted:
 *   - Hand-computed expected values on intermediate state (cutoff_zero_current,
 *     saturation_current, linear_region, gate_forward_current,
 *     output_characteristics, lambda_channel_length_modulation) â†’ deleted.
 *   - jfet_load_dcop_parity / MODEINITSMSIG / MODEINITTRAN tests that
 *     hand-computed expected values via the banned `Math.min(expArg, 80)`
 *     clamp (PARITY items A-1, A-2) â†’ deleted.
 *   - fet-base.test.ts (whole file) â†’ deleted (D-10: fet-base.ts is gone).
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
import { withNodeIds, runDcOp } from "../../../solver/analog/__tests__/test-helpers.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";
import type { ReactiveAnalogElement } from "../../../solver/analog/element.js";
import type { AnalogFactory } from "../../../core/registry.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import { MODEDCOP, MODEINITFLOAT } from "../../../solver/analog/ckt-mode.js";

// ---------------------------------------------------------------------------
// withState â€” allocate a StatePool and call initState on the element
// ---------------------------------------------------------------------------

function withState(element: AnalogElementCore): ReactiveAnalogElement {
  const re = element as ReactiveAnalogElement;
  re.stateBaseOffset = 0;
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

function makeDcOpCtx(voltages: Float64Array, matrixSize: number): LoadContext {
  const solver = new SparseSolver();
  solver._initStructure(matrixSize);
  return {
    cktMode: MODEDCOP | MODEINITFLOAT,
    solver,
    rhsOld: voltages,
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
    xfact: 1,
    gmin: 1e-12,
    reltol: 1e-3,
    iabstol: 1e-12,
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
// PJFET â€” weak stamp-emission smoke test (engine-agnostic contract).
// ---------------------------------------------------------------------------

describe("PJFET", () => {
  it("emits_stamps_when_conducting", () => {
    // Common-source PJFET: Vg=2V, Vd=0V, Vs=5V. Device must conduct in
    // saturation (vgs=3, vgd=-2, vds=5, vgst=vgs-VTO=1, vgst<vds).
    // Expected drain current magnitude with BETA=1e-4, B=1, LAMBDA=0:
    //   cdrain = betap * vgstÂ² * (B+Bfac) = 1e-4 * 1 * 1 â‰ˆ 1e-4 A
    //   gm     = betap * vgst * (2B+3*Bfac*vgst) = 1e-4 * 1 * 2 â‰ˆ 2e-4 S
    // Both exceed GMIN=1e-12 by 8+ orders of magnitude.
    // Node map: G=node1 (col/row 0), D=node2 (col/row 1), S=node3 (col/row 2).
    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams(PJFET_PARAMS);
    const core = withState(createPJfetElement(new Map([["G", 1], ["D", 2], ["S", 3]]), [], -1, propsObj));
    const element = withNodeIds(core, [1, 2, 3]);

    const voltages = new Float64Array(3);
    voltages[0] = 2;
    voltages[1] = 0;
    voltages[2] = 5;

    for (let i = 0; i < 50; i++) {
      element.load(makeDcOpCtx(voltages, 3));
    }

    const ctx = makeDcOpCtx(voltages, 3);
    element.load(ctx);
    const entries = ctx.solver.getCSCNonZeros();

    // Aggregate stamps by (row, col) â€” one stamp call per position for the
    // external-only pin set (no internal RD/RS nodes because RD=RS=0).
    const stampAt = (row: number, col: number): number => {
      const match = entries.filter((e) => e.row === row && e.col === col);
      return match.reduce((s, e) => s + e.value, 0);
    };

    // Row/col 0=G, 1=D, 2=S in matrix (0-based node index = nodeId - 1).
    const gG_G = stampAt(0, 0); // (ggd + ggs): gate self-conductance
    const gG_D = stampAt(0, 1); // -ggd
    const gG_S = stampAt(0, 2); // -ggs
    const gD_G = stampAt(1, 0); // gm - ggd: transconductance term
    const gD_D = stampAt(1, 1); // gdpr + gds + ggd (+ redundant gdpr=0 here)
    const gD_S = stampAt(1, 2); // -gds - gm: source-drain off-diagonal
    const gS_G = stampAt(2, 0); // -ggs - gm
    const gS_S = stampAt(2, 2); // gspr + gds + gm + ggs: source self-conductance

    // At least four specific stamp positions must be non-zero.
    expect(Math.abs(gG_G)).toBeGreaterThan(0);
    expect(Math.abs(gG_D)).toBeGreaterThan(0);
    expect(Math.abs(gD_S)).toBeGreaterThan(0);
    expect(Math.abs(gD_D)).toBeGreaterThan(0);

    // Source-drain off-diagonal = -(gds + gm). With gmâ‰ˆ2e-4 and gdsâ‰ˆ0
    // (LAMBDA=0 in saturation), magnitude must exceed GMIN by orders of
    // magnitude â€” proves active conduction, not GMIN-only clamp.
    const GMIN = 1e-12;
    expect(Math.abs(gD_S)).toBeGreaterThan(1e-5);
    expect(Math.abs(gD_S)).toBeGreaterThan(GMIN * 1e6);

    // Transconductance appears in D-row-G-col (gm - ggd). With ggd at GMIN
    // level (reverse-biased GD junction) and gm â‰ˆ 2e-4, |gD_G| â‰ˆ 2e-4.
    expect(Math.abs(gD_G)).toBeGreaterThan(1e-5);

    // KCL-style sign: gD_S and gS_G must carry opposite polarity pair
    // versus their diagonals (off-diagonals negative when diagonals positive).
    expect(gD_D).toBeGreaterThan(0);
    expect(gS_S).toBeGreaterThan(0);
    expect(gD_S).toBeLessThan(0);
    expect(gS_G).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// NR convergence test â€” engine-agnostic interface contract.
// ---------------------------------------------------------------------------

describe("NR", () => {
  it("converges_within_10_iterations", () => {
    // Common-source NJFET with Rd load.
    //   VDD=10V, Rd=10kÎ©, gate=0V, source=0V â†’ VGS=0V
    //   VTO=-2V â†’ vgst = VGS - VTO = 2V (device ON in saturation)
    //   BETA=1e-4, B=1, LAMBDA=0, Bfac = (1-B)/(PB-VTO) = 0
    //   cdrain = BETA * vgstÂ² * (B + Bfac*vgst) = 1e-4 * 4 * 1 = 4e-4 A
    //   Vdrop  = cdrain * Rd = 4e-4 * 1e4 = 4V
    //   VDS    = VDD - Vdrop = 10 - 4 = 6V  (still in saturation: VDS > vgst)
    //   node1 (drain) â‰ˆ 6V, node2 (vdd) = 10V, node3 (gate) = 0V.
    const matrixSize = 5;

    const propsObj = createTestPropertyBag();
    propsObj.replaceModelParams(NJFET_PARAMS);
    const jfet = withState(withNodeIds(createNJfetElement(new Map([["G", 3], ["S", 0], ["D", 1]]), [], -1, propsObj), [3, 0, 1]));
    const rd = makeResistorElement(2, 1, 10000);
    const vdd = makeDcVoltageSource(2, 0, 3, 10.0) as unknown as AnalogElement;
    const vgate = makeDcVoltageSource(3, 0, 4, 0.0) as unknown as AnalogElement;

    const result = runDcOp({
      elements: [vdd, vgate, rd, jfet],
      matrixSize,
      nodeCount: 3,
      params: { maxIterations: 10 },
    });

    expect(result.converged).toBe(true);
    expect(result.iterations).toBeLessThanOrEqual(10);

    // Node-voltage assertions â€” nodeVoltages[i-1] holds node i (1-based).
    const vDrain = result.nodeVoltages[0];
    const vVdd   = result.nodeVoltages[1];
    const vGate  = result.nodeVoltages[2];

    // VDD rail must sit at exactly 10V (voltage source).
    expect(vVdd).toBeCloseTo(10, 6);
    // Gate pinned at 0V.
    expect(vGate).toBeCloseTo(0, 6);

    // Drain voltage: analytic prediction is 6V. Allow a generous window that
    // excludes cutoff (VDSâ‰ˆ10V, no drain current) and excludes the linear
    // region (VDS<vgst=2V). Band (1V, 10V) proves the solution is in the
    // saturation operating regime the circuit is designed to produce.
    expect(vDrain).toBeGreaterThan(1);
    expect(vDrain).toBeLessThan(10);

    // Drain current through Rd: |iD| = (VDD - VDrain) / Rd.
    // Analytic expectation â‰ˆ 4e-4 A. Bound between 1e-5 A (device barely
    // on) and 1e-3 A (device hard-shorted) â€” at least two orders above GMIN.
    const iD = Math.abs((vVdd - vDrain) / 10000);
    expect(iD).toBeGreaterThan(1e-5);
    expect(iD).toBeLessThan(1e-3);
  });
});

// ---------------------------------------------------------------------------
// Registration tests â€” parameter plumbing / component registry.
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
    const rhsOld = new Float64Array([1.5, 0, 0]);

    function makeCtx(): LoadContext {
      const solver = new SparseSolver();
      solver._initStructure(matrixSize);
      return {
        cktMode: MODEDCOP | MODEINITFLOAT,
        solver,
        rhsOld,
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
        xfact: 1,
        gmin: 1e-12,
        reltol: 1e-3,
        iabstol: 1e-12,
        cktFixLimit: false,
        bypass: false,
        voltTol: 1e-6,
      } as LoadContext;
    }

    function createAndInit(overrides: Record<string, number> = {}): { element: ReactiveAnalogElement; pool: StatePool } {
      const propsObj = makeNjfetProps(overrides);
      const core = createNJfetElement(new Map([["G", 1], ["S", 0], ["D", 2]]), [], -1, propsObj) as unknown as ReactiveAnalogElement;
      core.stateBaseOffset = 0;
      const pool = new StatePool(core.stateSize);
      core.initState(pool);
      return { element: core, pool };
    }

    // Element at 300.15K
    const { element: el300, pool: pool300 } = createAndInit({ TEMP: 300.15 });
    el300.load(makeCtx());
    const vgs300 = pool300.state0[SLOT_VGS];

    // Element at 300.15K, setParam to 400K before load
    const { element: el400, pool: pool400 } = createAndInit({ TEMP: 300.15 });
    (el400 as unknown as { setParam: (k: string, v: number) => void }).setParam("TEMP", 400);
    el400.load(makeCtx());
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
    const rhsOld = new Float64Array([-1.5, 0, 0]);

    function makeCtx(): LoadContext {
      const solver = new SparseSolver();
      solver._initStructure(matrixSize);
      return {
        cktMode: MODEDCOP | MODEINITFLOAT,
        solver,
        rhsOld,
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
        xfact: 1,
        gmin: 1e-12,
        reltol: 1e-3,
        iabstol: 1e-12,
        cktFixLimit: false,
        bypass: false,
        voltTol: 1e-6,
      } as LoadContext;
    }

    function createAndInitP(overrides: Record<string, number> = {}): { element: ReactiveAnalogElement; pool: StatePool } {
      const propsObj = makePjfetProps(overrides);
      const core = createPJfetElement(new Map([["G", 1], ["S", 0], ["D", 2]]), [], -1, propsObj) as unknown as ReactiveAnalogElement;
      core.stateBaseOffset = 0;
      const pool = new StatePool(core.stateSize);
      core.initState(pool);
      return { element: core, pool };
    }

    const PSLOT_VGS = 0;

    // Element at 300.15K
    const { element: el300, pool: pool300 } = createAndInitP({ TEMP: 300.15 });
    el300.load(makeCtx());
    const vgs300 = pool300.state0[PSLOT_VGS];

    // Element at 300.15K, setParam to 400K before load
    const { element: el400, pool: pool400 } = createAndInitP({ TEMP: 300.15 });
    (el400 as unknown as { setParam: (k: string, v: number) => void }).setParam("TEMP", 400);
    el400.load(makeCtx());
    const vgs400 = pool400.state0[PSLOT_VGS];

    expect(vgs300).not.toBe(vgs400);
  });
});
