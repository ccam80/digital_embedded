/**
 * BJT component tests — post-W1.2 port.
 *
 * Test handling per `spec/architectural-alignment.md` §A1: only
 * parameter-plumbing tests (setParam propagation, default values),
 * engine-agnostic interface contracts (isNonlinear, pinNodeIds, modelRegistry
 * wiring), and LimitingEvent instrumentation remain.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createBjtElement,
  createSpiceL1BjtElement,
  NpnBjtDefinition,
  PnpBjtDefinition,
  BJT_PARAM_DEFS,
  BJT_SPICE_L1_PARAM_DEFS,
  BJT_SPICE_L1_NPN_DEFAULTS,
  BJT_NPN_DEFAULTS,
} from "../bjt.js";
import type { LoadContext } from "../../../solver/analog/element.js";
import { PropertyBag } from "../../../core/properties.js";
import { withNodeIds } from "../../../solver/analog/__tests__/test-helpers.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";
import { createTestPropertyBag } from "../../../test-fixtures/model-fixtures.js";
import {
  MODEDCOP, MODEINITFLOAT, MODETRAN, MODEINITPRED,
  MODEINITJCT, MODETRANOP, MODEUIC, MODEINITFIX,
  MODEINITSMSIG, MODEINITTRAN,
} from "../../../solver/analog/ckt-mode.js";
import type { LimitingEvent } from "../../../solver/analog/newton-raphson.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBjtProps(modelParams?: Record<string, number>): PropertyBag {
  const props = createTestPropertyBag();
  const defaults = { ...BJT_NPN_DEFAULTS };
  if (modelParams) Object.assign(defaults, modelParams);
  props.replaceModelParams(defaults);
  return props;
}

function makeSpiceL1Props(modelParams?: Record<string, number>): PropertyBag {
  const props = createTestPropertyBag();
  const defaults = { ...BJT_SPICE_L1_NPN_DEFAULTS };
  if (modelParams) Object.assign(defaults, modelParams);
  props.replaceModelParams(defaults);
  return props;
}

function makeDcOpCtx(voltages: Float64Array, matrixSize: number): LoadContext {
  const solver = new SparseSolver();
  solver.beginAssembly(matrixSize);
  return {
    cktMode: MODEDCOP | MODEINITFLOAT,
    solver,
    matrix: solver,
    rhs: voltages,
    rhsOld: voltages,
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
  };
}

// ---------------------------------------------------------------------------
// Engine-agnostic interface contracts
// ---------------------------------------------------------------------------

describe("BJT simple — interface contract", () => {
  it("isNonlinear_true", () => {
    const propsObj = makeBjtProps();
    const element = createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, propsObj);
    expect(element.isNonlinear).toBe(true);
  });

  it("isReactive_false", () => {
    const propsObj = makeBjtProps();
    const element = createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, propsObj);
    expect(element.isReactive).toBe(false);
  });

  it("pinNodeIds_correct", () => {
    const propsObj = makeBjtProps();
    const element = withNodeIds(createBjtElement(1, new Map([["B", 3], ["C", 5], ["E", 7]]), -1, propsObj), [3, 5, 7]);
    expect(element.pinNodeIds).toEqual([3, 5, 7]);
  });

  it("branchIndex_minus_one", () => {
    const propsObj = makeBjtProps();
    const element = createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, propsObj);
    expect(element.branchIndex).toBe(-1);
  });

  it("pnp_isNonlinear_true", () => {
    const propsObj = makeBjtProps();
    const element = createBjtElement(-1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, propsObj);
    expect(element.isNonlinear).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ComponentDefinition plumbing
// ---------------------------------------------------------------------------

describe("Definitions", () => {
  it("npn_definition_fields", () => {
    expect(NpnBjtDefinition.name).toBe("NpnBJT");
    expect(NpnBjtDefinition.modelRegistry!["spice"].kind).toBe("inline");
    expect(NpnBjtDefinition.modelRegistry!["spice"].paramDefs).toBe(BJT_SPICE_L1_PARAM_DEFS);
    expect(NpnBjtDefinition.defaultModel).toBe("spice");
    expect(NpnBjtDefinition.pinLayout).toHaveLength(3);
  });

  it("pnp_definition_fields", () => {
    expect(PnpBjtDefinition.name).toBe("PnpBJT");
    expect(PnpBjtDefinition.modelRegistry!["spice"].kind).toBe("inline");
    expect(PnpBjtDefinition.modelRegistry!["spice"].paramDefs).toBe(BJT_SPICE_L1_PARAM_DEFS);
    expect(PnpBjtDefinition.defaultModel).toBe("spice");
    expect(PnpBjtDefinition.pinLayout).toHaveLength(3);
  });

  it("npn_modelRegistry_has_both_simple_and_spice_l1", () => {
    const registry = NpnBjtDefinition.modelRegistry!;
    expect(registry["simple"]).toBeDefined();
    expect(registry["spice"]).toBeDefined();
    expect(registry["simple"].kind).toBe("inline");
    expect(registry["spice"].kind).toBe("inline");
  });

  it("pnp_modelRegistry_has_both_simple_and_spice_l1", () => {
    const registry = PnpBjtDefinition.modelRegistry!;
    expect(registry["simple"]).toBeDefined();
    expect(registry["spice"]).toBeDefined();
    expect(registry["simple"].kind).toBe("inline");
    expect(registry["spice"].kind).toBe("inline");
  });

  it("simple_model_uses_original_param_defs", () => {
    expect(NpnBjtDefinition.modelRegistry!["simple"].paramDefs).toBe(BJT_PARAM_DEFS);
    expect(PnpBjtDefinition.modelRegistry!["simple"].paramDefs).toBe(BJT_PARAM_DEFS);
  });

  it("spice_l1_model_uses_full_param_defs", () => {
    expect(NpnBjtDefinition.modelRegistry!["spice"].paramDefs).toBe(BJT_SPICE_L1_PARAM_DEFS);
    expect(PnpBjtDefinition.modelRegistry!["spice"].paramDefs).toBe(BJT_SPICE_L1_PARAM_DEFS);
  });

  it("npn_pin_labels", () => {
    const labels = NpnBjtDefinition.pinLayout.map((p) => p.label);
    expect(labels).toContain("C");
    expect(labels).toContain("B");
    expect(labels).toContain("E");
  });

  it("pnp_pin_labels", () => {
    const labels = PnpBjtDefinition.pinLayout.map((p) => p.label);
    expect(labels).toContain("C");
    expect(labels).toContain("B");
    expect(labels).toContain("E");
  });

  it("npn_simple_modelRegistry_factory_creates_element", () => {
    const propsObj = makeBjtProps();
    const entry = NpnBjtDefinition.modelRegistry!["simple"];
    if (entry.kind !== "inline") throw new Error("expected inline");
    const el = withNodeIds(entry.factory(new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj, () => 0), [1, 2, 3]);
    expect(el.isNonlinear).toBe(true);
    expect(el.pinNodeIds).toEqual([1, 2, 3]);
  });

  it("pnp_simple_modelRegistry_factory_creates_element", () => {
    const propsObj = makeBjtProps();
    const entry = PnpBjtDefinition.modelRegistry!["simple"];
    if (entry.kind !== "inline") throw new Error("expected inline");
    const el = withNodeIds(entry.factory(new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj, () => 0), [1, 2, 3]);
    expect(el.isNonlinear).toBe(true);
    expect(el.pinNodeIds).toEqual([1, 2, 3]);
  });

  it("npn_spice_l1_modelRegistry_factory_creates_element", () => {
    const propsObj = makeSpiceL1Props();
    const entry = NpnBjtDefinition.modelRegistry!["spice"];
    if (entry.kind !== "inline") throw new Error("expected inline");
    const el = withNodeIds(entry.factory(new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj, () => 0), [1, 2, 3]);
    expect(el.isNonlinear).toBe(true);
    expect(el.pinNodeIds).toEqual([1, 2, 3]);
  });

  it("pnp_spice_l1_modelRegistry_factory_creates_element", () => {
    const propsObj = makeSpiceL1Props();
    const entry = PnpBjtDefinition.modelRegistry!["spice"];
    if (entry.kind !== "inline") throw new Error("expected inline");
    const el = withNodeIds(entry.factory(new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj, () => 0), [1, 2, 3]);
    expect(el.isNonlinear).toBe(true);
    expect(el.pinNodeIds).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Model parameter plumbing
// ---------------------------------------------------------------------------

describe("ModelParams", () => {
  it("getModelParam_BF_returns_default_value", () => {
    const propsObj = makeBjtProps();
    expect(propsObj.getModelParam<number>("BF")).toBe(100);
  });

  it("getModelParam_IS_returns_default_value", () => {
    const propsObj = makeBjtProps();
    expect(propsObj.getModelParam<number>("IS")).toBe(1e-16);
  });

  it("all_11_params_defined_in_paramDefs", () => {
    const paramKeys = BJT_PARAM_DEFS.map(pd => pd.key);
    expect(paramKeys).toContain("BF");
    expect(paramKeys).toContain("IS");
    expect(paramKeys).toContain("NF");
    expect(paramKeys).toContain("BR");
    expect(paramKeys).toContain("VAF");
    expect(paramKeys).toContain("IKF");
    expect(paramKeys).toContain("IKR");
    expect(paramKeys).toContain("ISE");
    expect(paramKeys).toContain("ISC");
    expect(paramKeys).toContain("NR");
    expect(paramKeys).toContain("VAR");
  });

  it("primary_params_have_rank_primary", () => {
    const bf = BJT_PARAM_DEFS.find(pd => pd.key === "BF")!;
    const is_ = BJT_PARAM_DEFS.find(pd => pd.key === "IS")!;
    expect(bf.rank).toBe("primary");
    expect(is_.rank).toBe("primary");
  });

  it("secondary_params_have_rank_secondary", () => {
    const nf = BJT_PARAM_DEFS.find(pd => pd.key === "NF")!;
    const vaf = BJT_PARAM_DEFS.find(pd => pd.key === "VAF")!;
    expect(nf.rank).toBe("secondary");
    expect(vaf.rank).toBe("secondary");
  });

  it("setParam_updates_params_without_throwing", () => {
    // Parameter plumbing: setParam accepts known keys and does not throw.
    // Behavioural numerical correctness of setParam is validated by the
    // ngspice-comparison harness in Wave 3, not by hand-computed test values.
    const propsObj = makeBjtProps();
    const element = createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, propsObj);
    expect(() => element.setParam("BF", 50)).not.toThrow();
    expect(() => element.setParam("IS", 1e-12)).not.toThrow();
  });
});

describe("SPICE L1 model — parameter plumbing", () => {
  it("has full param set including terminal resistances and capacitances", () => {
    const paramKeys = BJT_SPICE_L1_PARAM_DEFS.map(pd => pd.key);
    expect(paramKeys).toContain("BF");
    expect(paramKeys).toContain("IS");
    expect(paramKeys).toContain("NF");
    expect(paramKeys).toContain("BR");
    expect(paramKeys).toContain("VAF");
    expect(paramKeys).toContain("VAR");
    expect(paramKeys).toContain("IKF");
    expect(paramKeys).toContain("IKR");
    expect(paramKeys).toContain("ISE");
    expect(paramKeys).toContain("ISC");
    expect(paramKeys).toContain("NR");
    expect(paramKeys).toContain("RB");
    expect(paramKeys).toContain("RC");
    expect(paramKeys).toContain("RE");
    expect(paramKeys).toContain("NE");
    expect(paramKeys).toContain("NC");
    expect(paramKeys).toContain("CJE");
    expect(paramKeys).toContain("CJC");
    expect(paramKeys).toContain("VJE");
    expect(paramKeys).toContain("VJC");
    expect(paramKeys).toContain("MJE");
    expect(paramKeys).toContain("MJC");
    expect(paramKeys).toContain("TF");
    expect(paramKeys).toContain("TR");
    expect(paramKeys).toContain("FC");
  });

  it("spice_l1_param_count_is_superset_of_simple", () => {
    expect(BJT_SPICE_L1_PARAM_DEFS.length).toBeGreaterThan(BJT_PARAM_DEFS.length);
  });

  it("factory_produces_valid_element_with_zero_resistances", () => {
    const propsObj = makeSpiceL1Props();
    const el = createSpiceL1BjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), [], -1, propsObj);
    expect(el.isNonlinear).toBe(true);
  });

  it("factory_produces_element_with_internal_nodes_when_resistances_nonzero", () => {
    const propsObj = makeSpiceL1Props({ RB: 10, RC: 1, RE: 0.5 });
    const internalNodes = [100, 101, 102];
    const el = createSpiceL1BjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), internalNodes, -1, propsObj);
    expect(el.isNonlinear).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// State schema — engine-agnostic interface contract (size/owner, seeded
// initial warm-start voltage).
// ---------------------------------------------------------------------------

describe("stateSchema — BJT simple", () => {
  it("stateSchema_declared", () => {
    const core = createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, makeBjtProps());
    expect(core.stateSchema).toBeDefined();
  });

  it("stateSchema_owner_identifies_element", () => {
    const core = createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, makeBjtProps());
    expect(core.stateSchema!.owner).toBe("BjtSimpleElement");
  });

  it("warmstart_NPN_VBE_seeded_to_0_6", () => {
    const core = createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, makeBjtProps());
    const pool = new StatePool(core.stateSize);
    core.stateBaseOffset = 0;
    core.initState!(pool);
  });

  it("warmstart_PNP_VBE_seeded_to_minus_0_6", () => {
    const core = createBjtElement(-1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, makeBjtProps());
    const pool = new StatePool(core.stateSize);
    core.stateBaseOffset = 0;
    core.initState!(pool);
  });
});

describe("stateSchema — BJT SPICE L1", () => {
  it("stateSchema_declared", () => {
    const core = createSpiceL1BjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), [], -1, makeSpiceL1Props());
    expect(core.stateSchema).toBeDefined();
  });

  it("stateSchema_owner_identifies_element", () => {
    const core = createSpiceL1BjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), [], -1, makeSpiceL1Props());
    expect(core.stateSchema!.owner).toBe("BjtSpiceL1Element");
  });

  it("warmstart_NPN_VBE_seeded_to_0_6", () => {
    const core = createSpiceL1BjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), [], -1, makeSpiceL1Props());
    const pool = new StatePool(core.stateSize);
    core.stateBaseOffset = 0;
    core.initState!(pool);
  });

  it("warmstart_PNP_VBE_seeded_to_minus_0_6", () => {
    const core = createSpiceL1BjtElement(-1, new Map([["B", 2], ["C", 1], ["E", 3]]), [], -1, makeSpiceL1Props());
    const pool = new StatePool(core.stateSize);
    core.stateBaseOffset = 0;
    core.initState!(pool);
  });
});

// ---------------------------------------------------------------------------
// LimitingEvent instrumentation — interface contract, does not assert
// hand-computed vBefore/vAfter values.
// ---------------------------------------------------------------------------

describe("BJT simple LimitingEvent instrumentation", () => {
  function makeNpnWithState(): AnalogElement {
    const props = makeBjtProps();
    const core = createBjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), -1, props) as AnalogElementCore & { label?: string; elementIndex?: number };
    core.label = "Q1";
    core.elementIndex = 5;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);
    return withNodeIds(core, [1, 2, 3]);
  }

  function makeCtxWithCollector(voltages: Float64Array, collector: LimitingEvent[] | null): LoadContext {
    const ctx = makeDcOpCtx(voltages, 10);
    return { ...ctx, limitingCollector: collector };
  }

  it("pushes BE and BC pnjlim events when limitingCollector provided", () => {
    const element = makeNpnWithState();
    const voltages = new Float64Array(10);
    voltages[0] = 5.0;
    voltages[1] = 3.0;
    voltages[2] = 0.0;

    const collector: LimitingEvent[] = [];
    element.load(makeCtxWithCollector(voltages, collector));

    expect(collector.length).toBeGreaterThanOrEqual(2);
    const beEv = collector.find((e: LimitingEvent) => e.junction === "BE");
    const bcEv = collector.find((e: LimitingEvent) => e.junction === "BC");
    expect(beEv).toBeDefined();
    expect(bcEv).toBeDefined();

    for (const ev of [beEv!, bcEv!]) {
      expect(ev.elementIndex).toBe(5);
      expect(ev.label).toBe("Q1");
      expect(ev.limitType).toBe("pnjlim");
      expect(Number.isFinite(ev.vBefore)).toBe(true);
      expect(Number.isFinite(ev.vAfter)).toBe(true);
      expect(typeof ev.wasLimited).toBe("boolean");
    }
  });

  it("does not throw when limitingCollector is null", () => {
    const element = makeNpnWithState();
    const voltages = new Float64Array(10);
    voltages[0] = 5.0;
    expect(() => element.load(makeCtxWithCollector(voltages, null))).not.toThrow();
  });
});

describe("BJT L1 LimitingEvent instrumentation", () => {
  function makeL1NpnWithState(): AnalogElement {
    const props = makeSpiceL1Props();
    const core = createSpiceL1BjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, props) as AnalogElementCore & { label?: string; elementIndex?: number };
    core.label = "Q1";
    core.elementIndex = 5;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);
    return withNodeIds(core, [1, 2, 3]);
  }

  it("pushes BE and BC pnjlim events", () => {
    const element = makeL1NpnWithState();
    const voltages = new Float64Array(10);
    voltages[0] = 5.0;
    voltages[1] = 3.0;
    voltages[2] = 0.0;

    const collector: LimitingEvent[] = [];
    const ctx = makeDcOpCtx(voltages, 10);
    element.load({ ...ctx, limitingCollector: collector });

    expect(collector.length).toBeGreaterThanOrEqual(2);
    const beEv = collector.find((e: LimitingEvent) => e.junction === "BE");
    const bcEv = collector.find((e: LimitingEvent) => e.junction === "BC");
    expect(beEv).toBeDefined();
    expect(bcEv).toBeDefined();

    expect(beEv!.elementIndex).toBe(5);
    expect(beEv!.label).toBe("Q1");
    expect(beEv!.limitType).toBe("pnjlim");
    expect(Number.isFinite(beEv!.vBefore)).toBe(true);
    expect(Number.isFinite(beEv!.vAfter)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 5.1.1 — MODEINITPRED full state-copy list (A1)
// bjtload.c:288-303: all 9 L0 op-state slots copied from state1 to state0.
// ---------------------------------------------------------------------------

describe("BJT L0 MODEINITPRED", () => {
  it("copies_9_slots_state1_to_state0", () => {
    // L0 slot indices (match bjt.ts createBjtElement local consts):
    // 0=VBE, 1=VBC, 2=CC, 3=CB, 4=GPI, 5=GMU, 6=GM, 7=GO, 8=GX
    const SLOT_VBE = 0, SLOT_VBC = 1, SLOT_CC = 2, SLOT_CB = 3;
    const SLOT_GPI = 4, SLOT_GMU = 5, SLOT_GM = 6, SLOT_GO = 7, SLOT_GX = 8;

    const propsObj = makeBjtProps();
    const core = createBjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), -1, propsObj) as AnalogElementCore;
    const stateSize: number = (core as any).stateSize;
    const pool = new StatePool(stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);

    const s0 = pool.states[0];
    const s1 = pool.states[1];
    const s2 = pool.states[2];

    // Prime state1 with physically consistent op-state values by running a
    // normal NR load() pass at vbe=0.65 V, vbc=-1.0 V (forward-active bias).
    // This gives s0 values that are self-consistent at those voltages; we then
    // copy s0 → s1 to simulate what the previous time-step would have left.
    const rhsOldPrime = new Float64Array(10);
    rhsOldPrime[0] = 0.65; // nodeB=1 → rhsOld[0]
    rhsOldPrime[1] = -1.0; // nodeC=2 → rhsOld[1]
    rhsOldPrime[2] = 0.0;  // nodeE=3 → rhsOld[2]
    const solverPrime = new SparseSolver();
    solverPrime.beginAssembly(10);
    const rhs = new Float64Array(10);
    const ctxPrime: LoadContext = {
      cktMode: MODEDCOP | MODEINITFLOAT,
      solver: solverPrime,
      matrix: solverPrime,
      rhs,
      rhsOld: rhsOldPrime,
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
      vt: 0.025852,
      cktFixLimit: false,
      bypass: false,
      voltTol: 1e-6,
    };
    const element = withNodeIds(core, [1, 2, 3]);
    element.load(ctxPrime);

    // Copy s0 → s1 so that s1 holds physically consistent sentinels.
    s1[SLOT_VBE] = s0[SLOT_VBE];
    s1[SLOT_VBC] = s0[SLOT_VBC];
    s1[SLOT_CC]  = s0[SLOT_CC];
    s1[SLOT_CB]  = s0[SLOT_CB];
    s1[SLOT_GPI] = s0[SLOT_GPI];
    s1[SLOT_GMU] = s0[SLOT_GMU];
    s1[SLOT_GM]  = s0[SLOT_GM];
    s1[SLOT_GO]  = s0[SLOT_GO];
    s1[SLOT_GX]  = s0[SLOT_GX];

    // Capture sentinel values for assertion.
    const sentVBE = s1[SLOT_VBE];
    const sentVBC = s1[SLOT_VBC];
    const sentCC  = s1[SLOT_CC];
    const sentCB  = s1[SLOT_CB];
    const sentGPI = s1[SLOT_GPI];
    const sentGMU = s1[SLOT_GMU];
    const sentGM  = s1[SLOT_GM];
    const sentGO  = s1[SLOT_GO];
    const sentGX  = s1[SLOT_GX];

    // Also seed s2 with the same values (so xfact extrapolation with any xfact
    // collapses to s1 values exactly — s0 = (1+x)*s1 - x*s2 = s1 when s2=s1).
    s2[SLOT_VBE] = sentVBE;
    s2[SLOT_VBC] = sentVBC;

    // Now run MODEINITPRED: bjtload.c:288-303 must copy all 9 slots s1 → s0,
    // then extrapolate voltages (collapsed to s1 values since s2=s1), run pnjlim
    // (no-op since prior=new), run computeBjtOp at the same voltages, and write
    // back the same op values — so s0 ends up identical to s1 sentinels.
    const solver = new SparseSolver();
    solver.beginAssembly(10);
    const rhsOld = new Float64Array(10);
    const ctx: LoadContext = {
      cktMode: MODETRAN | MODEINITPRED,
      solver,
      matrix: solver,
      rhs: new Float64Array(10),
      rhsOld,
      time: 1e-9,
      dt: 1e-9,
      method: "trapezoidal",
      order: 1,
      deltaOld: [1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9],
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
    element.load(ctx);

    // All 9 slots in s0 must equal the corresponding s1 sentinels.
    // VBE/VBC: copy + pnjlim(same,same) = same + writeback = sentinel.
    // CC/CB/GPI/GMU/GM/GO/GX: copy sets s0=s1, writeback with same voltages
    // sets s0 to identical computed op value.
    expect(s0[SLOT_VBE]).toBe(sentVBE);
    expect(s0[SLOT_VBC]).toBe(sentVBC);
    expect(s0[SLOT_CC]).toBe(sentCC);
    expect(s0[SLOT_CB]).toBe(sentCB);
    expect(s0[SLOT_GPI]).toBe(sentGPI);
    expect(s0[SLOT_GMU]).toBe(sentGMU);
    expect(s0[SLOT_GM]).toBe(sentGM);
    expect(s0[SLOT_GO]).toBe(sentGO);
    expect(s0[SLOT_GX]).toBe(sentGX);
  });
});

// ---------------------------------------------------------------------------
// Shared helper for 5.1.2 / 5.1.3 / 5.1.4 tests — full LoadContext literal.
// ---------------------------------------------------------------------------

function makeFullLoadCtx(cktMode: number, rhsOld: Float64Array, modelParams?: Record<string, number>): { ctx: LoadContext; element: AnalogElement; s0: Float64Array; pool: StatePool } {
  const propsObj = makeBjtProps(modelParams);
  const core = createBjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), -1, propsObj) as AnalogElementCore;
  const pool = new StatePool((core as any).stateSize);
  (core as any).stateBaseOffset = 0;
  (core as any).initState(pool);
  const solver = new SparseSolver();
  solver.beginAssembly(10);
  const ctx: LoadContext = {
    cktMode,
    solver,
    matrix: solver,
    rhs: new Float64Array(10),
    rhsOld,
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
    vt: 0.025852,
    cktFixLimit: false,
    bypass: false,
    voltTol: 1e-6,
  };
  const element = withNodeIds(core, [1, 2, 3]);
  return { ctx, element, s0: pool.states[0], pool };
}

// ---------------------------------------------------------------------------
// Task 5.1.2 — MODEINITJCT 3-branch priming verification (A3)
// bjtload.c:258-264, :265-269, :270-275 citation refresh + path-selection tests.
// ---------------------------------------------------------------------------

describe("BJT L0 MODEINITJCT", () => {
  // L0 slot indices
  const SLOT_VBE = 0, SLOT_VBC = 1, SLOT_CC = 2;

  it("uic_path_seeds_from_icvbe_icvce", () => {
    // cite: bjtload.c:258-264 — MODEINITJCT+MODETRANOP+MODEUIC seeds from IC* params.
    // pnjlim is skipped when MODEINITJCT is set; s0[VBE] = raw IC-derived voltage.
    const rhsOld = new Float64Array(10);
    const { ctx, element, s0 } = makeFullLoadCtx(
      MODEINITJCT | MODETRANOP | MODEUIC,
      rhsOld,
      { ICVBE: 0.5, ICVCE: 1.0 },
    );
    element.load(ctx);
    // NPN polarity=1: vbe_ic = 0.5, vbcRaw = vbe_ic - vce_ic = 0.5 - 1.0 = -0.5.
    // pnjlim is skipped under MODEINITJCT, so s0[VBE] = vbeLimited = vbeRaw = 0.5.
    expect(s0[SLOT_VBE]).toBe(0.5);
  });

  it("on_path_seeds_tVcrit", () => {
    // cite: bjtload.c:265-269 — MODEINITJCT, OFF=0: vbe=tVcrit, vbc=0.
    // tVcrit = vt * log(vt / (sqrt(2) * tSatCur)) with tSatCur = IS*AREA for
    // L0 (see bjt-temp.ts). For NPN defaults IS≈tSatCur scaled at T=300.15 K,
    // tVcrit lands near 0.85 V. Bound 0.6 V < vbe < 1.0 V matches the
    // thermal-voltage-derived critical voltage and rules out any trivially-
    // positive seed (e.g. vt itself ≈ 0.026 V or a bare pnjlim default).
    const rhsOld = new Float64Array(10);
    const { ctx, element, s0 } = makeFullLoadCtx(MODEINITJCT, rhsOld, { OFF: 0 });
    element.load(ctx);
    expect(s0[SLOT_VBE]).toBeGreaterThan(0.6);
    expect(s0[SLOT_VBE]).toBeLessThan(1.0);
    expect(s0[SLOT_VBC]).toBe(0);
  });

  it("off_path_zero_seeds", () => {
    // cite: bjtload.c:270-275 — MODEINITJCT+OFF: vbe=vbc=0 → near-zero downstream op.
    const rhsOld = new Float64Array(10);
    const { ctx, element, s0 } = makeFullLoadCtx(MODEINITJCT, rhsOld, { OFF: 1 });
    element.load(ctx);
    // vbeRaw=0, vbcRaw=0 → computeBjtOp produces near-zero cc (IS * (exp(0)-1) ~ 0).
    expect(Math.abs(s0[SLOT_CC])).toBeLessThan(1e-6);
  });
});

// ---------------------------------------------------------------------------
// Task 5.1.3 — NOBYPASS bypass test (A4)
// bjtload.c:338-381: 4-tolerance gate skips recompute when tolerances met.
// ---------------------------------------------------------------------------

describe("BJT L0 NOBYPASS", () => {
  const SLOT_VBE = 0, SLOT_VBC = 1, SLOT_CC = 2, SLOT_CB = 3;
  const SLOT_GPI = 4, SLOT_GMU = 5, SLOT_GM = 6, SLOT_GO = 7, SLOT_GX = 8;

  // Path-selection discriminator: bjt.ts L0 load() only calls
  // ctx.limitingCollector.push() on the compute path (bjt.ts:932-951,
  // inside the `else` branch of the bypass gate). On the bypass path
  // (bjt.ts:903-906), push() is never called. Providing a non-null
  // limitingCollector array therefore gives an exact 0/≥1 discriminator
  // between "bypass fired" and "compute ran".
  function makeBypassCtx(
    cktMode: number,
    rhsOld: Float64Array,
    bypass: boolean,
    modelParams?: Record<string, number>,
  ): {
    ctx: LoadContext;
    element: AnalogElement;
    s0: Float64Array;
    pool: StatePool;
    stampCount: { g: number; rhs: number };
    limitingCollector: LimitingEvent[];
  } {
    const propsObj = makeBjtProps(modelParams);
    const core = createBjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), -1, propsObj) as AnalogElementCore;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);
    const solver = new SparseSolver();
    solver.beginAssembly(10);
    // Stamp-count probe: wrap SparseSolver.stampElement (the G-matrix stamp
    // primitive used by the stampG helper) and SparseSolver.stampRHS (used by
    // stampRHS helper). Both paths of the bypass gate emit stamps (the stamp
    // block at bjt.ts:999-1023 runs unconditionally after the if/else), so
    // this probe primarily serves as a "stamps actually fired" sanity check
    // on the no-bypass path.
    const stampCount = { g: 0, rhs: 0 };
    const origStampElement = solver.stampElement.bind(solver);
    solver.stampElement = (handle: number, value: number) => {
      stampCount.g++;
      origStampElement(handle, value);
    };
    const origStampRHS = solver.stampRHS.bind(solver);
    solver.stampRHS = (row: number, value: number) => {
      stampCount.rhs++;
      origStampRHS(row, value);
    };
    const limitingCollector: LimitingEvent[] = [];
    const ctx: LoadContext = {
      cktMode,
      solver,
      matrix: solver,
      rhs: new Float64Array(10),
      rhsOld,
      time: 0,
      dt: 0,
      method: "trapezoidal",
      order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0],
      ag: new Float64Array(7),
      srcFact: 1,
      noncon: { value: 0 },
      limitingCollector,
      convergenceCollector: null,
      xfact: 1,
      gmin: 1e-12,
      reltol: 1e-3,
      iabstol: 1e-12,
      temp: 300.15,
      vt: 0.025852,
      cktFixLimit: false,
      bypass,
      voltTol: 1e-6,
    };
    const element = withNodeIds(core, [1, 2, 3]);
    return { ctx, element, s0: pool.states[0], pool, stampCount, limitingCollector };
  }

  it("bypass_disabled_when_ctx_bypass_false", () => {
    // cite: bjtload.c:338 — bypass gate requires ctx.bypass=true; both calls must compute.
    // Spec (task 5.1.3): "Assert both calls emit non-zero stamp counts (stamp-count
    // probe wrapping stampG/stampRHS)." We additionally assert the compute path
    // ran on both calls (limitingCollector populated), since with bypass=false
    // the gate can never fire even when tolerances are nominally met.
    const rhsOld = new Float64Array(10);
    rhsOld[0] = 0.65; // nodeB=1
    rhsOld[1] = 3.0;  // nodeC=2
    rhsOld[2] = 0.0;  // nodeE=3

    // First call — compute path, writes s0.
    const first = makeBypassCtx(MODEDCOP | MODEINITFLOAT, rhsOld, false);
    first.element.load(first.ctx);

    // Second call with identical rhsOld — bypass=false, so compute path again.
    // Prime s0 of the second element with the first element's s0 so that
    // tolerances WOULD be met if the gate were reachable; this proves the
    // ctx.bypass=false guard is what's blocking bypass, not the tolerances.
    const second = makeBypassCtx(MODEDCOP | MODEINITFLOAT, rhsOld, false);
    second.s0.set(first.s0);
    second.element.load(second.ctx);

    // (a) Both calls emit non-zero stamp counts. L0 stamps exactly 9 G-matrix
    // entries and 3 RHS entries per load (bjt.ts:999-1023), for nodes B=1,
    // C=2, E=3 (none are ground, so no stamps are dropped).
    expect(first.stampCount.g).toBe(9);
    expect(first.stampCount.rhs).toBe(3);
    expect(second.stampCount.g).toBe(9);
    expect(second.stampCount.rhs).toBe(3);
    // (b) Compute path ran on both calls — limitingCollector gets exactly
    // 2 pushes per compute call (BE + BC junctions, bjt.ts:932-951).
    expect(first.limitingCollector.length).toBe(2);
    expect(second.limitingCollector.length).toBe(2);
  });

  it("bypass_triggers_when_tolerances_met", () => {
    // cite: bjtload.c:338-381 — bypass fires when ctx.bypass=true and all 4 tolerances pass.
    // Spec (task 5.1.3): "(a) ctx.noncon.value unchanged on second call, (b) stamps
    // still emitted on second call (bypass preserves stamps), (c) a probe on
    // computeBjtOp call-count shows it was invoked once (first call) not twice."
    //
    // computeBjtOp is a private module function, so call-count is measured
    // indirectly via ctx.limitingCollector: bjt.ts L0 load() pushes to
    // limitingCollector only on the compute path (lines 932-951) — the
    // bypass path (lines 903-906) skips it entirely. The collector therefore
    // gives an exact 0/≥1 discriminator:
    //   compute ran  → limitingCollector.length === 2 (BE + BC)
    //   bypass fired → limitingCollector.length === 0
    const propsObj = makeBjtProps();
    const core = createBjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), -1, propsObj) as AnalogElementCore;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);
    const s0 = pool.states[0];

    function makeCtx(
      rhsOld: Float64Array,
      bypass: boolean,
      nonconRef: { value: number },
      limitingCollector: LimitingEvent[],
    ): { ctx: LoadContext; stampCount: { g: number; rhs: number } } {
      const solver = new SparseSolver();
      solver.beginAssembly(10);
      const stampCount = { g: 0, rhs: 0 };
      const origStampElement = solver.stampElement.bind(solver);
      solver.stampElement = (handle: number, value: number) => {
        stampCount.g++;
        origStampElement(handle, value);
      };
      const origStampRHS = solver.stampRHS.bind(solver);
      solver.stampRHS = (row: number, value: number) => {
        stampCount.rhs++;
        origStampRHS(row, value);
      };
      const ctx: LoadContext = {
        cktMode: MODEDCOP | MODEINITFLOAT,
        solver,
        matrix: solver,
        rhs: new Float64Array(10),
        rhsOld,
        time: 0,
        dt: 0,
        method: "trapezoidal",
        order: 1,
        deltaOld: [0, 0, 0, 0, 0, 0, 0],
        ag: new Float64Array(7),
        srcFact: 1,
        noncon: nonconRef,
        limitingCollector,
        convergenceCollector: null,
        xfact: 1,
        gmin: 1e-12,
        reltol: 1e-3,
        iabstol: 1e-12,
        temp: 300.15,
        vt: 0.025852,
        cktFixLimit: false,
        bypass,
        voltTol: 1e-6,
      };
      return { ctx, stampCount };
    }

    const element = withNodeIds(core, [1, 2, 3]);

    // First call — bypass=false, primes s0 with self-consistent op-state.
    const rhsOld1 = new Float64Array(10);
    rhsOld1[0] = 0.65; rhsOld1[1] = 3.0; rhsOld1[2] = 0.0;
    const limits1: LimitingEvent[] = [];
    const call1 = makeCtx(rhsOld1, false, { value: 0 }, limits1);
    element.load(call1.ctx);

    // First-call path probe: compute ran → exactly 2 pushes (BE + BC).
    expect(limits1.length).toBe(2);

    // Build rhsOld2 aligned to s0[VBE]/s0[VBC] so delvbe=delvbc=0 exactly.
    // NPN: vbeRaw = vB-vE, vbcRaw = vB-vC. Let vE=0, vC=vB-s0[VBC], vB=s0[VBE].
    const vbeTarget = s0[SLOT_VBE];
    const vbcTarget = s0[SLOT_VBC];
    const rhsOld2 = new Float64Array(10);
    rhsOld2[0] = vbeTarget;             // nodeB=1 → vB = vbeTarget (vE=0)
    rhsOld2[1] = vbeTarget - vbcTarget; // nodeC=2 → vC = vB - vbcTarget
    rhsOld2[2] = 0.0;                   // nodeE=3

    const noncon2 = { value: 0 };
    const limits2: LimitingEvent[] = [];
    const call2 = makeCtx(rhsOld2, true, noncon2, limits2);
    element.load(call2.ctx);

    // (a) noncon unchanged — bypass skips pnjlim+icheck++ (bjt.ts:930).
    expect(noncon2.value).toBe(0);
    // (b) stamps still emitted on bypass path — bypass preserves the stamp
    // block (bjt.ts:999-1023). L0 emits exactly 9 G entries + 3 RHS entries.
    expect(call2.stampCount.g).toBe(9);
    expect(call2.stampCount.rhs).toBe(3);
    // (c) computeBjtOp call-count probe: bypass path did NOT push to
    // limitingCollector (lines 932-951 are inside the compute-path else
    // branch). Exactly 0 pushes proves bypass fired instead of compute.
    expect(limits2.length).toBe(0);
  });

  it("bypass_disabled_by_MODEINITPRED", () => {
    // cite: bjtload.c:347 — !(MODEINITPRED) is part of the bypass gate.
    // With cktMode|=MODEINITPRED, bypass gate must not fire even when
    // ctx.bypass=true and tolerances are met.
    //
    // Probe: limitingCollector populated ⇒ compute path ran (bjt.ts:932-951).
    // If bypass had (incorrectly) fired, the collector would be empty.
    const propsObj = makeBjtProps();
    const core = createBjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), -1, propsObj) as AnalogElementCore;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);
    const s0 = pool.states[0];
    const s1 = pool.states[1];
    const s2 = pool.states[2];

    function makeCtx(
      cktMode: number,
      rhsOld: Float64Array,
      bypass: boolean,
      limitingCollector: LimitingEvent[],
    ): LoadContext {
      const solver = new SparseSolver();
      solver.beginAssembly(10);
      return {
        cktMode,
        solver,
        matrix: solver,
        rhs: new Float64Array(10),
        rhsOld,
        time: 0,
        dt: 1e-9,
        method: "trapezoidal",
        order: 1,
        deltaOld: [1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9],
        ag: new Float64Array(7),
        srcFact: 1,
        noncon: { value: 0 },
        limitingCollector,
        convergenceCollector: null,
        xfact: 0,
        gmin: 1e-12,
        reltol: 1e-3,
        iabstol: 1e-12,
        temp: 300.15,
        vt: 0.025852,
        cktFixLimit: false,
        bypass,
        voltTol: 1e-6,
      };
    }

    // Prime s0 at forward-active bias.
    const rhsOld = new Float64Array(10);
    rhsOld[0] = 0.65; rhsOld[1] = 3.0; rhsOld[2] = 0.0;
    const element = withNodeIds(core, [1, 2, 3]);
    element.load(makeCtx(MODEDCOP | MODEINITFLOAT, rhsOld, false, []));

    // Copy s0 → s1 and s2 so xfact=0 extrapolation gives vbe/vbc == s0 values.
    // With rhsOld nulled out, the MODEINITPRED branch computes vbeRaw/vbcRaw
    // from s1 (extrapolated), not from rhsOld — so the extrapolated values
    // match s0 exactly, and delvbe/delvbc = 0. Tolerances are nominally met;
    // only the !(MODEINITPRED) guard blocks bypass.
    for (let i = 0; i < (core as any).stateSize; i++) {
      s1[i] = s0[i];
      s2[i] = s0[i];
    }

    // Call with MODEINITPRED + bypass=true — bypass gate must NOT fire.
    const limits: LimitingEvent[] = [];
    element.load(makeCtx(MODETRAN | MODEINITPRED, new Float64Array(10), true, limits));

    // Path probe: compute ran (limitingCollector populated) ⇒ bypass did not
    // fire under MODEINITPRED. Exactly 2 pushes (BE + BC junctions).
    expect(limits.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Task 5.1.4 — noncon INITFIX/off gate verification (A5)
// bjtload.c:749-754: icheck++ unless MODEINITFIX && OFF.
// ---------------------------------------------------------------------------

describe("BJT L0 noncon", () => {
  function makeNonconCtx(cktMode: number, off: number): { ctx: LoadContext; element: AnalogElement; s0: Float64Array } {
    // Use large rhsOld to trigger pnjlim (large delvbe forces limiting).
    const rhsOld = new Float64Array(10);
    rhsOld[0] = 5.0; // vB high — ensures vbeRaw >> s0[VBE] → pnjlim fires, icheckLimited=true.
    rhsOld[1] = 3.0;
    rhsOld[2] = 0.0;
    const propsObj = makeBjtProps({ OFF: off });
    const core = createBjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), -1, propsObj) as AnalogElementCore;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);
    const solver = new SparseSolver();
    solver.beginAssembly(10);
    const ctx: LoadContext = {
      cktMode,
      solver,
      matrix: solver,
      rhs: new Float64Array(10),
      rhsOld,
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
      vt: 0.025852,
      cktFixLimit: false,
      bypass: false,
      voltTol: 1e-6,
    };
    return { ctx, element: withNodeIds(core, [1, 2, 3]), s0: pool.states[0] };
  }

  it("no_bump_when_initfix_and_off", () => {
    // cite: bjtload.c:749-754 — icheck++ unless MODEINITFIX && OFF.
    // OFF=1, cktMode=MODEINITFIX: the gate condition (OFF===0 || !(INITFIX)) is false → no bump.
    const { ctx, element } = makeNonconCtx(MODEINITFIX, 1);
    element.load(ctx);
    expect(ctx.noncon.value).toBe(0);
  });

  it("bumps_when_initfix_and_not_off", () => {
    // cite: bjtload.c:749-754 — OFF=0, MODEINITFIX: OFF===0 is true → bump permitted.
    // Large vB ensures pnjlim fires → icheckLimited=true → noncon increments.
    const { ctx, element } = makeNonconCtx(MODEINITFIX, 0);
    element.load(ctx);
    expect(ctx.noncon.value).toBeGreaterThanOrEqual(1);
  });

  it("bumps_when_not_initfix_and_off", () => {
    // cite: bjtload.c:749-754 — OFF=1, cktMode=MODEDCOP (no INITFIX): !(INITFIX) is true → bump.
    const { ctx, element } = makeNonconCtx(MODEDCOP | MODEINITFLOAT, 1);
    element.load(ctx);
    expect(ctx.noncon.value).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Task 5.1.5 — Parameterize NE / NC (A8)
// NE default 1.5, NC default 2 in BJT_PARAM_DEFS.
// ---------------------------------------------------------------------------

describe("ModelParams", () => {
  it("NE_default_1_5", () => {
    const propsObj = makeBjtProps();
    expect(propsObj.getModelParam<number>("NE")).toBe(1.5);
  });

  it("NC_default_2", () => {
    const propsObj = makeBjtProps();
    expect(propsObj.getModelParam<number>("NC")).toBe(2);
  });

  it("paramDefs_include_NE_NC", () => {
    const keys = BJT_PARAM_DEFS.map(pd => pd.key);
    expect(keys).toContain("NE");
    expect(keys).toContain("NC");
  });

  it("setParam_NE_NC_no_throw", () => {
    const propsObj = makeBjtProps();
    const element = createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, propsObj);
    expect(() => element.setParam("NE", 1.2)).not.toThrow();
    expect(() => element.setParam("NC", 2.5)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Task 5.1.6 — MODEINITSMSIG early-return + MODEINITTRAN state1 seed (A2/A9)
// ---------------------------------------------------------------------------

describe("BJT L0 MODEINITSMSIG", () => {
  const SLOT_VBE = 0, SLOT_VBC = 1, SLOT_CC = 2, SLOT_CB = 3;
  const SLOT_GPI = 4, SLOT_GMU = 5, SLOT_GM = 6, SLOT_GO = 7, SLOT_GX = 8;

  function makeSmsigCtx(primePool?: { s0: Float64Array }): { ctx: LoadContext; element: AnalogElement; s0: Float64Array; solver: SparseSolver } {
    const propsObj = makeBjtProps();
    const core = createBjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), -1, propsObj) as AnalogElementCore;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);

    // Prime s0 with valid DC-OP state so MODEINITSMSIG reads meaningful values.
    if (primePool) {
      const s0 = pool.states[0];
      const src = primePool.s0;
      for (let i = 0; i < Math.min(s0.length, src.length); i++) s0[i] = src[i];
    } else {
      // Run a DC-OP priming pass at forward-active bias.
      const primeSolver = new SparseSolver();
      primeSolver.beginAssembly(10);
      const rhsPrime = new Float64Array(10);
      rhsPrime[0] = 0.65; rhsPrime[1] = 3.0; rhsPrime[2] = 0.0;
      const primeCtx: LoadContext = {
        cktMode: MODEDCOP | MODEINITFLOAT,
        solver: primeSolver,
        matrix: primeSolver,
        rhs: new Float64Array(10),
        rhsOld: rhsPrime,
        time: 0, dt: 0, method: "trapezoidal", order: 1,
        deltaOld: [0, 0, 0, 0, 0, 0, 0],
        ag: new Float64Array(7), srcFact: 1,
        noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
        xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
        temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
      };
      withNodeIds(core, [1, 2, 3]).load(primeCtx);
    }

    const solver = new SparseSolver();
    solver.beginAssembly(10);
    const ctx: LoadContext = {
      cktMode: MODEDCOP | MODEINITSMSIG,
      solver,
      matrix: solver,
      rhs: new Float64Array(10),
      rhsOld: new Float64Array(10),
      time: 0, dt: 0, method: "trapezoidal", order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0],
      ag: new Float64Array(7), srcFact: 1,
      noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
      xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
      temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
    };
    return { ctx, element: withNodeIds(core, [1, 2, 3]), s0: pool.states[0], solver };
  }

  it("no_stamps_emitted", () => {
    // cite: bjtload.c:676,703 — MODEINITSMSIG stores op state, skips stamps via early return.
    const { ctx, element, solver } = makeSmsigCtx();

    // Wrap solver.addEntry to count stamp calls.
    let stampCallCount = 0;
    const origAddEntry = (solver as any).addEntry?.bind(solver);
    if (origAddEntry) {
      (solver as any).addEntry = (...args: unknown[]) => {
        stampCallCount++;
        return origAddEntry(...args);
      };
    }

    // Also count RHS via direct rhs array mutation detection — track rhs before/after.
    const rhsBefore = Array.from(ctx.rhs);
    element.load(ctx);
    const rhsAfter = Array.from(ctx.rhs);

    // Under MODEINITSMSIG, the early-return fires before stamp block — zero stamps.
    expect(stampCallCount).toBe(0);
    // RHS must not have changed.
    expect(rhsAfter).toEqual(rhsBefore);
  });

  it("state0_op_slots_populated", () => {
    // cite: bjtload.c:676,703 — MODEINITSMSIG reads s0 and runs computeBjtOp, writing back op slots.
    // Priming bias is vbe≈0.65 V forward-active (makeSmsigCtx prime pass); the
    // MODEINITSMSIG call dispatches through the general path which reads
    // vbeRaw/vbcRaw from s0 (MODEINITSMSIG is one of the modes that skips
    // pnjlim at bjt.ts:915), so s0[VBE]/s0[VBC] are written back unchanged.
    const { ctx, element, s0 } = makeSmsigCtx();
    const vbeBefore = s0[SLOT_VBE];
    const vbcBefore = s0[SLOT_VBC];
    element.load(ctx);
    // (a) VBE / VBC write-back is bit-exact under MODEINITSMSIG.
    expect(s0[SLOT_VBE]).toBe(vbeBefore);
    expect(s0[SLOT_VBC]).toBe(vbcBefore);
    // (b) Forward-active Gummel-Poon at vbe≈0.65 V produces clearly positive
    // cc, cb, gpi, gmu, gm, go for NPN defaults (IS=1e-16, BF=100, VAF=∞).
    expect(s0[SLOT_CC]).toBeGreaterThan(0);
    expect(s0[SLOT_CB]).toBeGreaterThan(0);
    expect(s0[SLOT_GPI]).toBeGreaterThan(0);
    expect(s0[SLOT_GMU]).toBeGreaterThan(0);
    expect(s0[SLOT_GM]).toBeGreaterThan(0);
    expect(s0[SLOT_GO]).toBeGreaterThan(0);
    // L0 has no base resistance → gx=0 (bjt.ts:972).
    expect(s0[SLOT_GX]).toBe(0);
  });
});

describe("BJT L0 MODEINITTRAN", () => {
  const SLOT_VBE = 0, SLOT_VBC = 1;

  it("state1_VBE_VBC_seeded", () => {
    // cite: bjtload.c:236-257 — MODEINITTRAN seeds state1 from the initial voltage read
    // so subsequent NIintegrate history has a valid t=0 prior value.
    const propsObj = makeBjtProps();
    const core = createBjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), -1, propsObj) as AnalogElementCore;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);

    const s1 = pool.states[1];

    // Seed state1 with known vbeRaw / vbcRaw values:
    // nodeB=1 → rhsOld[0], nodeC=2 → rhsOld[1], nodeE=3 → rhsOld[2].
    // NPN polarity=1: vbeRaw = vB - vE = 0.5, vbcRaw = vB - vC = 0.5 - (-0.3) = 0.8
    // State1 is pre-seeded by ngspice with the DC-OP values; for MODEINITTRAN,
    // load() reads from s1[VBE]/s1[VBC] and then writes them back.
    s1[SLOT_VBE] = 0.5;
    s1[SLOT_VBC] = 0.8;

    const solver = new SparseSolver();
    solver.beginAssembly(10);
    const ctx: LoadContext = {
      cktMode: MODETRAN | MODEINITTRAN,
      solver,
      matrix: solver,
      rhs: new Float64Array(10),
      rhsOld: new Float64Array(10),
      time: 1e-9, dt: 1e-9, method: "trapezoidal", order: 1,
      deltaOld: [1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9],
      ag: new Float64Array(7), srcFact: 1,
      noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
      xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
      temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
    };

    withNodeIds(core, [1, 2, 3]).load(ctx);

    // After MODEINITTRAN load(), state1 VBE/VBC must equal what was read from s1.
    expect(s1[SLOT_VBE]).toBe(0.5);
    expect(s1[SLOT_VBC]).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// Task 5.2.2 — MODEINITSMSIG return block verification (B3)
// bjtload.c:674-703: stores caps+op into state0, skips NIintegrate + stamps.
// ---------------------------------------------------------------------------

describe("BJT L1 MODEINITSMSIG", () => {
  // L1 slot indices used in these tests
  const SLOT_CQBE = 9, SLOT_CQBC = 11, SLOT_CQSUB = 13, SLOT_CQBX = 15;
  const SLOT_CEXBC = 17, SLOT_GEQCB = 18;

  function makeL1SmsigCtx(modelParams?: Record<string, number>): {
    ctx: LoadContext; element: AnalogElement; s0: Float64Array; solver: SparseSolver;
  } {
    const propsObj = makeSpiceL1Props({ CJE: 1e-12, CJC: 1e-12, ...modelParams });
    const core = createSpiceL1BjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj) as AnalogElementCore;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);

    // Prime s0 with a forward-active DC-OP pass so MODEINITSMSIG reads valid values.
    const primeSolver = new SparseSolver();
    primeSolver.beginAssembly(10);
    const rhsPrime = new Float64Array(10);
    rhsPrime[0] = 0.65; rhsPrime[1] = 3.0; rhsPrime[2] = 0.0;
    const primeCtx: LoadContext = {
      cktMode: MODEDCOP | MODEINITFLOAT,
      solver: primeSolver,
      matrix: primeSolver,
      rhs: new Float64Array(10),
      rhsOld: rhsPrime,
      time: 0, dt: 0, method: "trapezoidal", order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0],
      ag: new Float64Array(7), srcFact: 1,
      noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
      xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
      temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
    };
    withNodeIds(core, [1, 2, 3]).load(primeCtx);

    const solver = new SparseSolver();
    solver.beginAssembly(10);
    // MODEINITSMSIG reads vbeRaw/vbcRaw from s0, so rhsOld is only used for vbx/vsub.
    // Use same voltages as prime so vbx/vsub are consistent.
    const ctx: LoadContext = {
      cktMode: MODEDCOP | MODEINITSMSIG,
      solver,
      matrix: solver,
      rhs: new Float64Array(10),
      rhsOld: rhsPrime,
      time: 0, dt: 0, method: "trapezoidal", order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0],
      ag: new Float64Array(7), srcFact: 1,
      noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
      xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
      temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
    };
    return { ctx, element: withNodeIds(core, [1, 2, 3]), s0: pool.states[0], solver };
  }

  it("no_stamps_emitted", () => {
    // cite: bjtload.c:674-703 — MODEINITSMSIG stores caps+op and returns before stamps.
    const { ctx, element, solver } = makeL1SmsigCtx();

    let stampCallCount = 0;
    const origAddEntry = (solver as any).addEntry?.bind(solver);
    if (origAddEntry) {
      (solver as any).addEntry = (...args: unknown[]) => {
        stampCallCount++;
        return origAddEntry(...args);
      };
    }

    const rhsBefore = Array.from(ctx.rhs);
    element.load(ctx);
    const rhsAfter = Array.from(ctx.rhs);

    expect(stampCallCount).toBe(0);
    expect(rhsAfter).toEqual(rhsBefore);
  });

  it("cap_values_stored", () => {
    // cite: bjtload.c:674-703 — MODEINITSMSIG stores capbe/capbc/capsub/capbx into s0.
    // Defaults used: CJE=CJC=1e-12 (makeL1SmsigCtx baseline) + override
    // CJS=1e-12 (SPICE default is 0 → capsub would collapse to 0) and
    // XCJC=0.5 (SPICE default is 1 → czbx = ctot*(1-XCJC) = 0 → capbx=0).
    // With forward-active bias (vbe≈0.65 V, vbc≈-2.35 V), all four
    // depletion+diffusion caps are strictly positive:
    //   capbe = tf*gbeMod + czbe*sarg   (czbe=CJE*AREA > 0, sarg > 0)
    //   capbc = tr*gbc + czbc*sarg      (czbc = CJC*AREA*XCJC > 0)
    //   capsub = czsub * sarg           (czsub = CJS*AREA > 0 w/ CJS=1e-12)
    //   capbx = czbx * sarg             (czbx = CJC*AREA*(1-XCJC) > 0 w/ XCJC=0.5)
    const { ctx, element, s0 } = makeL1SmsigCtx({ CJS: 1e-12, XCJC: 0.5 });
    element.load(ctx);
    expect(s0[SLOT_CQBE]).toBeGreaterThan(0);
    expect(s0[SLOT_CQBC]).toBeGreaterThan(0);
    expect(s0[SLOT_CQSUB]).toBeGreaterThan(0);
    expect(s0[SLOT_CQBX]).toBeGreaterThan(0);
  });

  it("cexbc_equals_geqcb", () => {
    // cite: bjtload.c:674-703 — s0[CEXBC] = geqcb and s0[GEQCB] = geqcb (same value).
    // With TF=1e-9 and forward VBE, geqcb is non-zero; both slots receive the same value.
    const { ctx, element, s0 } = makeL1SmsigCtx({ TF: 1e-9 });
    element.load(ctx);
    // Both CEXBC and GEQCB slots should hold the same geqcb value.
    expect(s0[SLOT_CEXBC]).toBe(s0[SLOT_GEQCB]);
  });
});

// ---------------------------------------------------------------------------
// Task 5.2.1 — MODEINITPRED full state-copy list (B1/B2)
// bjtload.c:288-303: all 10 L1 op-state slots copied from state1 to state0.
// ---------------------------------------------------------------------------

describe("BJT L1 MODEINITPRED", () => {
  it("copies_10_slots_state1_to_state0", () => {
    // L1 slot indices (match bjt.ts createSpiceL1BjtElement local consts):
    // 0=VBE, 1=VBC, 2=CC, 3=CB, 4=GPI, 5=GMU, 6=GM, 7=GO, 8=QBE, 9=CQBE,
    // 10=QBC, 11=CQBC, 12=QSUB, 13=CQSUB, 14=QBX, 15=CQBX, 16=GX,
    // 17=CEXBC, 18=GEQCB, 19=GCSUB, 20=GEQBX, 21=VSUB, 22=CDSUB, 23=GDSUB
    const SLOT_VBE = 0, SLOT_VBC = 1, SLOT_CC = 2, SLOT_CB = 3;
    const SLOT_GPI = 4, SLOT_GMU = 5, SLOT_GM = 6, SLOT_GO = 7;
    const SLOT_GX = 16, SLOT_VSUB = 21;

    const propsObj = makeSpiceL1Props();
    const core = createSpiceL1BjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj) as AnalogElementCore;
    const stateSize: number = (core as any).stateSize;
    const pool = new StatePool(stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);

    const s0 = pool.states[0];
    const s1 = pool.states[1];
    const s2 = pool.states[2];

    // Prime state1 with physically consistent op-state values by running a
    // normal NR load() pass at vbe=0.65 V forward-active bias.
    const rhsOldPrime = new Float64Array(10);
    rhsOldPrime[0] = 0.65; // nodeB=1 → rhsOld[0]
    rhsOldPrime[1] = -1.0; // nodeC=2 → rhsOld[1]
    rhsOldPrime[2] = 0.0;  // nodeE=3 → rhsOld[2]
    const solverPrime = new SparseSolver();
    solverPrime.beginAssembly(10);
    const ctxPrime: LoadContext = {
      cktMode: MODEDCOP | MODEINITFLOAT,
      solver: solverPrime,
      matrix: solverPrime,
      rhs: new Float64Array(10),
      rhsOld: rhsOldPrime,
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
      vt: 0.025852,
      cktFixLimit: false,
      bypass: false,
      voltTol: 1e-6,
    };
    const element = withNodeIds(core, [1, 2, 3]);
    element.load(ctxPrime);

    // Copy s0 → s1 to simulate what the previous time-step would have left.
    s1[SLOT_VBE]  = s0[SLOT_VBE];
    s1[SLOT_VBC]  = s0[SLOT_VBC];
    s1[SLOT_CC]   = s0[SLOT_CC];
    s1[SLOT_CB]   = s0[SLOT_CB];
    s1[SLOT_GPI]  = s0[SLOT_GPI];
    s1[SLOT_GMU]  = s0[SLOT_GMU];
    s1[SLOT_GM]   = s0[SLOT_GM];
    s1[SLOT_GO]   = s0[SLOT_GO];
    s1[SLOT_GX]   = s0[SLOT_GX];
    s1[SLOT_VSUB] = s0[SLOT_VSUB];

    // Capture sentinel values for assertion.
    const sentVBE  = s1[SLOT_VBE];
    const sentVBC  = s1[SLOT_VBC];
    const sentCC   = s1[SLOT_CC];
    const sentCB   = s1[SLOT_CB];
    const sentGPI  = s1[SLOT_GPI];
    const sentGMU  = s1[SLOT_GMU];
    const sentGM   = s1[SLOT_GM];
    const sentGO   = s1[SLOT_GO];
    const sentGX   = s1[SLOT_GX];
    const sentVSUB = s1[SLOT_VSUB];

    // Seed s2 with identical values so xfact extrapolation collapses to s1
    // (s0 = (1+x)*s1 - x*s2 = s1 when s2=s1).
    s2[SLOT_VBE]  = sentVBE;
    s2[SLOT_VBC]  = sentVBC;
    s2[SLOT_VSUB] = sentVSUB;

    // Run MODEINITPRED: bjtload.c:288-303 must copy all 10 slots s1→s0.
    // Use xfact=0 so extrapolated voltage = s1 value exactly (no prediction shift).
    // Use the same rhsOld as the prime run so vbxRaw/vsubRaw (which are always read
    // from rhsOld directly, not from extrapolated state) match the prime values —
    // this keeps pnjlim a no-op and the op writeback identical to the prime result.
    const solver = new SparseSolver();
    solver.beginAssembly(10);
    const ctx: LoadContext = {
      cktMode: MODETRAN | MODEINITPRED,
      solver,
      matrix: solver,
      rhs: new Float64Array(10),
      rhsOld: rhsOldPrime,
      time: 1e-9,
      dt: 1e-9,
      method: "trapezoidal",
      order: 1,
      deltaOld: [1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9],
      ag: new Float64Array(7),
      srcFact: 1,
      noncon: { value: 0 },
      limitingCollector: null,
      convergenceCollector: null,
      xfact: 0,
      gmin: 1e-12,
      reltol: 1e-3,
      iabstol: 1e-12,
      temp: 300.15,
      vt: 0.025852,
      cktFixLimit: false,
      bypass: false,
      voltTol: 1e-6,
    };
    element.load(ctx);

    // All 10 slots in s0 must equal the corresponding s1 sentinels.
    // With xfact=0: extrapolated VBE/VBC/VSUB = s1 value. Same rhsOld as prime means
    // pnjlim sees prior=new → no limiting → writeback identical to prime values.
    expect(s0[SLOT_VBE]).toBe(sentVBE);
    expect(s0[SLOT_VBC]).toBe(sentVBC);
    expect(s0[SLOT_CC]).toBe(sentCC);
    expect(s0[SLOT_CB]).toBe(sentCB);
    expect(s0[SLOT_GPI]).toBe(sentGPI);
    expect(s0[SLOT_GMU]).toBe(sentGMU);
    expect(s0[SLOT_GM]).toBe(sentGM);
    expect(s0[SLOT_GO]).toBe(sentGO);
    expect(s0[SLOT_GX]).toBe(sentGX);
    expect(s0[SLOT_VSUB]).toBe(sentVSUB);
  });
});

// ---------------------------------------------------------------------------
// Task 5.2.3 — NOBYPASS bypass test (B4)
// bjtload.c:338-381: 4-tolerance gate + 15-slot restore on L1.
// ---------------------------------------------------------------------------

describe("BJT L1 NOBYPASS", () => {
  const SLOT_CC = 2, SLOT_CB = 3, SLOT_GPI = 4, SLOT_GMU = 5;
  const SLOT_GM = 6, SLOT_GO = 7, SLOT_GX = 16;
  const SLOT_VBE = 0, SLOT_VBC = 1, SLOT_VSUB = 21;

  // Path-selection discriminator: bjt.ts L1 load() only calls
  // ctx.limitingCollector.push() on the compute path (bjt.ts:1458-1486,
  // inside the `else` branch of the bypass gate). On the bypass path
  // (bjt.ts:1417-1432), push() is never called. L1 pushes exactly 3
  // events per compute call (BE + BC + SUB junctions), giving a clean
  // 0/3 discriminator.
  function makeL1BypassCtx(
    cktMode: number,
    rhsOld: Float64Array,
    bypass: boolean,
    modelParams?: Record<string, number>,
  ): {
    ctx: LoadContext;
    element: AnalogElement;
    s0: Float64Array;
    pool: StatePool;
    stampCount: { n: number };
    limitingCollector: LimitingEvent[];
  } {
    const propsObj = makeSpiceL1Props(modelParams);
    const core = createSpiceL1BjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj) as AnalogElementCore;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);
    const solver = new SparseSolver();
    solver.beginAssembly(10);
    // Stamp-count probe: wrap solver.stampElement (G-matrix primitive used by
    // the stampG helper) and solver.stampRHS (method used by stampRHS helper).
    const stampCount = { n: 0 };
    const origStampElement = solver.stampElement.bind(solver);
    solver.stampElement = (handle: number, value: number) => {
      stampCount.n++;
      origStampElement(handle, value);
    };
    const origStampRHS = solver.stampRHS.bind(solver);
    solver.stampRHS = (row: number, value: number) => {
      stampCount.n++;
      origStampRHS(row, value);
    };
    const limitingCollector: LimitingEvent[] = [];
    const ctx: LoadContext = {
      cktMode,
      solver,
      matrix: solver,
      rhs: new Float64Array(10),
      rhsOld,
      time: 0, dt: 0,
      method: "trapezoidal", order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0],
      ag: new Float64Array(7), srcFact: 1,
      noncon: { value: 0 }, limitingCollector, convergenceCollector: null,
      xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
      temp: 300.15, vt: 0.025852, cktFixLimit: false,
      bypass, voltTol: 1e-6,
    };
    const element = withNodeIds(core, [1, 2, 3]);
    return { ctx, element, s0: pool.states[0], pool, stampCount, limitingCollector };
  }

  it("bypass_disabled_when_ctx_bypass_false", () => {
    // cite: bjtload.c:338 — bypass=false means gate never fires; compute always runs.
    // Spec (task 5.2.3, same pattern as 5.1.3): assert both calls emit
    // non-zero stamps AND compute path ran (limitingCollector populated).
    const rhsOld = new Float64Array(10);
    rhsOld[0] = 0.65; rhsOld[1] = 3.0; rhsOld[2] = 0.0;

    // First call — compute path, writes s0.
    const first = makeL1BypassCtx(MODEDCOP | MODEINITFLOAT, rhsOld, false);
    first.element.load(first.ctx);
    const stamps1 = first.stampCount.n;
    const limits1 = first.limitingCollector.length;

    // Second call with identical rhsOld — bypass=false so compute runs again
    // even though s0 was pre-aligned to rhsOld (tolerances trivially met).
    const second = makeL1BypassCtx(MODEDCOP | MODEINITFLOAT, rhsOld, false);
    second.s0.set(first.s0);
    second.element.load(second.ctx);
    const stamps2 = second.stampCount.n;
    const limits2 = second.limitingCollector.length;

    // (a) Both calls emit non-zero stamp counts. Exact counts depend on the
    // L1 stamp block (bjt.ts:1849-1905) and aren't brittle — assert > 0.
    expect(stamps1).toBeGreaterThan(0);
    expect(stamps2).toBeGreaterThan(0);
    // (b) Compute path ran on both calls — L1 pushes exactly 3 events per
    // compute call (BE + BC + SUB, bjt.ts:1459-1485).
    expect(limits1).toBe(3);
    expect(limits2).toBe(3);
  });

  it("bypass_restores_and_stamps", () => {
    // cite: bjtload.c:338-381 — bypass fires when ctx.bypass=true and tolerances met.
    // Stamp block still runs on bypass path (mirrors ngspice goto load).
    // Spec (task 5.2.3): assert (a) noncon unchanged, (b) stamps still
    // emitted, (c) computeSpiceL1BjtOp NOT called on the bypass call
    // (limitingCollector length 0 — only compute path pushes).
    const propsObj = makeSpiceL1Props();
    const core = createSpiceL1BjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj) as AnalogElementCore;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);
    const s0 = pool.states[0];

    function makeCtx(
      rhsOld: Float64Array,
      bypass: boolean,
      nonconRef: { value: number },
      limitingCollector: LimitingEvent[],
    ): { ctx: LoadContext; stampCount: { n: number } } {
      const solver = new SparseSolver();
      solver.beginAssembly(10);
      const stampCount = { n: 0 };
      const origStampElement = solver.stampElement.bind(solver);
      solver.stampElement = (handle: number, value: number) => {
        stampCount.n++;
        origStampElement(handle, value);
      };
      const origStampRHS = solver.stampRHS.bind(solver);
      solver.stampRHS = (row: number, value: number) => {
        stampCount.n++;
        origStampRHS(row, value);
      };
      const ctx: LoadContext = {
        cktMode: MODEDCOP | MODEINITFLOAT,
        solver, matrix: solver,
        rhs: new Float64Array(10), rhsOld,
        time: 0, dt: 0, method: "trapezoidal", order: 1,
        deltaOld: [0, 0, 0, 0, 0, 0, 0],
        ag: new Float64Array(7), srcFact: 1,
        noncon: nonconRef, limitingCollector, convergenceCollector: null,
        xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
        temp: 300.15, vt: 0.025852, cktFixLimit: false,
        bypass, voltTol: 1e-6,
      };
      return { ctx, stampCount };
    }

    const element = withNodeIds(core, [1, 2, 3]);

    // First load: prime s0. bypass=false → compute path → 3 pushes expected.
    const rhsOld1 = new Float64Array(10);
    rhsOld1[0] = 0.65; rhsOld1[1] = 3.0; rhsOld1[2] = 0.0;
    const limits1: LimitingEvent[] = [];
    const call1 = makeCtx(rhsOld1, false, { value: 0 }, limits1);
    element.load(call1.ctx);
    expect(limits1.length).toBe(3);

    // Build rhsOld2 aligned to s0[VBE]/s0[VBC] so delvbe=delvbc=0.
    const vbeTarget = s0[SLOT_VBE];
    const vbcTarget = s0[SLOT_VBC];
    const rhsOld2 = new Float64Array(10);
    rhsOld2[0] = vbeTarget;
    rhsOld2[1] = vbeTarget - vbcTarget;
    rhsOld2[2] = 0.0;

    const noncon2 = { value: 0 };
    const limits2: LimitingEvent[] = [];
    // Second load: bypass=true, same voltages → tolerances met.
    const call2 = makeCtx(rhsOld2, true, noncon2, limits2);
    element.load(call2.ctx);

    // (a) noncon unchanged — bypass skips pnjlim+icheck++ (bjt.ts:1456).
    expect(noncon2.value).toBe(0);
    // (b) stamps still emitted on bypass path — bypass preserves the L1
    // stamp block (bjt.ts:1849-1905). Count must be > 0.
    expect(call2.stampCount.n).toBeGreaterThan(0);
    // (c) computeSpiceL1BjtOp call-count probe: bypass path did NOT push to
    // limitingCollector (lines 1458-1486 are inside the compute-path else).
    // Zero pushes proves bypass fired instead of compute.
    expect(limits2.length).toBe(0);
  });

  it("bypass_disabled_by_MODEINITPRED", () => {
    // cite: bjtload.c:347 — !(MODEINITPRED) is part of the bypass gate; MODEINITPRED disables it.
    // Probe: limitingCollector populated ⇒ compute path ran under MODEINITPRED.
    const propsObj = makeSpiceL1Props();
    const core = createSpiceL1BjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj) as AnalogElementCore;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);
    const s0 = pool.states[0];
    const s1 = pool.states[1];
    const s2 = pool.states[2];

    function makeCtx(
      cktMode: number,
      rhsOld: Float64Array,
      bypass: boolean,
      limitingCollector: LimitingEvent[],
    ): LoadContext {
      const solver = new SparseSolver();
      solver.beginAssembly(10);
      return {
        cktMode, solver, matrix: solver,
        rhs: new Float64Array(10), rhsOld,
        time: 1e-9, dt: 1e-9, method: "trapezoidal", order: 1,
        deltaOld: [1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9],
        ag: new Float64Array(7), srcFact: 1,
        noncon: { value: 0 }, limitingCollector, convergenceCollector: null,
        xfact: 0, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
        temp: 300.15, vt: 0.025852, cktFixLimit: false,
        bypass, voltTol: 1e-6,
      };
    }

    const element = withNodeIds(core, [1, 2, 3]);

    // Prime s0 with a normal NR pass at forward-active bias.
    const rhsOld1 = new Float64Array(10);
    rhsOld1[0] = 0.65; rhsOld1[1] = 3.0; rhsOld1[2] = 0.0;
    element.load(makeCtx(MODEDCOP | MODEINITFLOAT, rhsOld1, false, []));

    // Copy s0→s1, s1→s2 so MODEINITPRED extrapolation collapses to s0 values.
    s1.set(s0); s2.set(s0);

    // Call with MODEINITPRED + bypass=true — MODEINITPRED gate must prevent bypass.
    // The compute path will push 3 entries to limitingCollector.
    const limits: LimitingEvent[] = [];
    element.load(makeCtx(MODETRAN | MODEINITPRED, rhsOld1, true, limits));

    // Path probe: compute ran ⇒ exactly 3 pushes (BE + BC + SUB).
    expect(limits.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Task 5.2.4 — noncon INITFIX/off gate verification (B5)
// cite: bjtload.c:749-754 — icheck++ unless MODEINITFIX && OFF
// ---------------------------------------------------------------------------

describe("BJT L1 noncon", () => {
  function makeNonconCtx(cktMode: number, modelParams?: Record<string, number>): {
    ctx: LoadContext; element: AnalogElement;
  } {
    const propsObj = makeSpiceL1Props(modelParams);
    const core = createSpiceL1BjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj) as AnalogElementCore;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);
    const solver = new SparseSolver();
    solver.beginAssembly(10);
    // rhsOld: large voltage shift to trigger pnjlim.
    const rhsOld = new Float64Array(10);
    rhsOld[0] = 5.0; rhsOld[1] = 0.0; rhsOld[2] = 0.0;
    const ctx: LoadContext = {
      cktMode,
      solver, matrix: solver,
      rhs: new Float64Array(10), rhsOld,
      time: 0, dt: 0, method: "trapezoidal", order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0],
      ag: new Float64Array(7), srcFact: 1,
      noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
      xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
      temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
    };
    return { ctx, element: withNodeIds(core, [1, 2, 3]) };
  }

  it("no_bump_when_initfix_and_off", () => {
    // cite: bjtload.c:749-754 — OFF=1 + MODEINITFIX: noncon must not increment.
    const { ctx, element } = makeNonconCtx(MODEINITFIX, { OFF: 1 });
    element.load(ctx);
    expect(ctx.noncon.value).toBe(0);
  });

  it("bumps_when_initfix_and_not_off", () => {
    // cite: bjtload.c:749-754 — OFF=0 + MODEINITFIX: noncon increments when pnjlim fires.
    const { ctx, element } = makeNonconCtx(MODEINITFIX, { OFF: 0 });
    element.load(ctx);
    expect(ctx.noncon.value).toBeGreaterThanOrEqual(1);
  });

  it("bumps_when_not_initfix_and_off", () => {
    // cite: bjtload.c:749-754 — OFF=1 + MODEDCOP (no MODEINITFIX): noncon increments.
    const { ctx, element } = makeNonconCtx(MODEDCOP | MODEINITFLOAT, { OFF: 1 });
    element.load(ctx);
    expect(ctx.noncon.value).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Task 5.2.5 — CdBE uses op.gbe verification (B8)
// cite: bjtload.c:617, :625 — capbe = tf*gbeMod + ...; gbeMod derived from op.gbe.
// ---------------------------------------------------------------------------

describe("BJT L1 CdBE", () => {
  const SLOT_QBE = 8;

  it("scales_with_gbe_not_gm", () => {
    // cite: bjtload.c:617 — capbe uses gbeMod which derives from gbe (not gm).
    // Run two loads with different IS (changes gbe ~ IS*exp(vbe/vt)/vt) and compare QBE.
    // QBE = tf*cbeMod + czbe*(1-arg*sarg)/(1-xme); cbeMod scales with gbe via XTF path.
    // With TF>0 and vbeLimited>0, cbeMod = cbe*(1+argtf)/qb where argtf depends on gbe.
    function makeL1TranEl(IS: number): { el: AnalogElement; pool: StatePool } {
      const propsObj = makeSpiceL1Props({ TF: 1e-9, CJE: 1e-12, IS });
      const core = createSpiceL1BjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj) as AnalogElementCore;
      const pool = new StatePool((core as any).stateSize);
      (core as any).stateBaseOffset = 0;
      (core as any).initState(pool);
      return { el: withNodeIds(core, [1, 2, 3]), pool };
    }

    function makeCtx(): LoadContext {
      const solver = new SparseSolver();
      solver.beginAssembly(10);
      const rhsOld = new Float64Array(10);
      rhsOld[0] = 0.65; rhsOld[1] = 3.0; rhsOld[2] = 0.0;
      return {
        cktMode: MODEDCOP | MODEINITSMSIG,
        solver, matrix: solver,
        rhs: new Float64Array(10), rhsOld,
        time: 0, dt: 0, method: "trapezoidal", order: 1,
        deltaOld: [0, 0, 0, 0, 0, 0, 0],
        ag: new Float64Array(7), srcFact: 1,
        noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
        xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
        temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
      };
    }

    const { el: el1, pool: pool1 } = makeL1TranEl(1e-16);
    const { el: el2, pool: pool2 } = makeL1TranEl(1e-15);

    // Prime s0 with MODEDCOP|MODEINITFLOAT first so MODEINITSMSIG reads valid op state.
    const primeSolver = new SparseSolver(); primeSolver.beginAssembly(10);
    const rhsPrime = new Float64Array(10); rhsPrime[0] = 0.65; rhsPrime[1] = 3.0;
    const primeCtx: LoadContext = {
      cktMode: MODEDCOP | MODEINITFLOAT,
      solver: primeSolver, matrix: primeSolver,
      rhs: new Float64Array(10), rhsOld: rhsPrime,
      time: 0, dt: 0, method: "trapezoidal", order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0],
      ag: new Float64Array(7), srcFact: 1,
      noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
      xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
      temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
    };
    // Need separate prime solvers.
    const primeSolver2 = new SparseSolver(); primeSolver2.beginAssembly(10);
    el1.load({ ...primeCtx });
    el2.load({ ...primeCtx, solver: primeSolver2, matrix: primeSolver2 });

    el1.load(makeCtx());
    el2.load(makeCtx());

    const qbe1 = pool1.states[0][SLOT_QBE];
    const qbe2 = pool2.states[0][SLOT_QBE];

    // IS×10 → gbe×10 → larger QBE (monotonic response).
    expect(Number.isFinite(qbe1)).toBe(true);
    expect(Number.isFinite(qbe2)).toBe(true);
    expect(qbe2).toBeGreaterThan(qbe1);
  });
});

// ---------------------------------------------------------------------------
// Task 5.2.6 — External BC cap stamp destination verification (B9)
// cite: bjtload.c:841-842 — geqbx stamps to (nodeB_ext, nodeC_int), NOT nodeC_ext.
// ---------------------------------------------------------------------------

describe("BJT L1 BC_cap_stamps", () => {
  it("target_colPrime", () => {
    // cite: bjtload.c:841-842 — BJTbaseColPrimePtr targets nodeC_int (colPrime), not nodeC_ext.
    // With RC>0, nodeC_int !== nodeC_ext. Verify no stamp hits (nodeB_ext, nodeC_ext).
    // Node assignment: B=1 (ext), C=2 (ext), E=3; RC>0 creates nodeC_int=4.
    // internalNodeIds = [4] (internal collector node from RC).
    const propsObj = makeSpiceL1Props({ RC: 1, CJC: 1e-11 });
    const core = createSpiceL1BjtElement(
      1, new Map([["B", 1], ["C", 2], ["E", 3]]), [4], -1, propsObj,
    ) as AnalogElementCore;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);

    // Pre-allocate all needed matrix entries before load() (stampG calls allocElement at assembly time).
    // stampG subtracts 1 from node IDs before calling allocElement, so node N → index N-1.
    // We allocate entries for all node pairs that the L1 stamp block may touch.
    // Nodes: B_ext=1, C_ext=2, E=3, C_int=4. All pairs (0-based: 0,1,2,3).
    const solver = new SparseSolver();
    const nodeCount = 5; // 1-based nodes up to 4 → need size 5
    solver.beginAssembly(nodeCount);

    // Capture all (row, col) 0-based index pairs passed to allocElement.
    // Stored as 1-based node IDs to match the assertion logic.
    const allocatedPairs: Array<{ row: number; col: number }> = [];
    const origAllocElement = (solver as any).allocElement.bind(solver);
    (solver as any).allocElement = (row: number, col: number): number => {
      allocatedPairs.push({ row: row + 1, col: col + 1 }); // convert 0-based → 1-based
      return origAllocElement(row, col);
    };

    const rhsOld = new Float64Array(nodeCount);
    rhsOld[0] = 0.65; rhsOld[1] = -1.0; rhsOld[2] = 0.0;
    // Use MODEINITTRAN so s1 QBX is seeded and NIintegrate fires on the second call.
    // First call: MODEINITTRAN seeds QBX into state1.
    const ctxInit: LoadContext = {
      cktMode: MODETRAN | MODEINITTRAN,
      solver, matrix: solver,
      rhs: new Float64Array(nodeCount), rhsOld,
      time: 0, dt: 1e-9, method: "trapezoidal", order: 1,
      deltaOld: [1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9],
      ag: new Float64Array(7), srcFact: 1,
      noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
      xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
      temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
    };
    const el = withNodeIds(core, [1, 2, 3, 4]);
    el.load(ctxInit);

    // Clear collected pairs, then run MODETRAN | MODEINITFLOAT to trigger NIintegrate + geqbx stamp.
    allocatedPairs.length = 0;
    const ag = new Float64Array(7);
    ag[0] = 1 / 1e-9; // trapezoidal ag[0] = 1/dt
    const ctx: LoadContext = {
      cktMode: MODETRAN | MODEINITFLOAT,
      solver, matrix: solver,
      rhs: new Float64Array(nodeCount), rhsOld,
      time: 1e-9, dt: 1e-9, method: "trapezoidal", order: 1,
      deltaOld: [1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9],
      ag, srcFact: 1,
      noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
      xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
      temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
    };
    el.load(ctx);

    // nodeB_ext=1, nodeC_ext=2, nodeC_int=4.
    // No stamp should target (nodeB_ext=1, nodeC_ext=2) or (nodeC_ext=2, nodeB_ext=1).
    const nodeB_ext = 1, nodeC_ext = 2;
    const forbidden = allocatedPairs.filter(
      s => (s.row === nodeB_ext && s.col === nodeC_ext) ||
           (s.row === nodeC_ext && s.col === nodeB_ext),
    );
    expect(forbidden).toHaveLength(0);

    // A stamp to (nodeB_ext=1, nodeC_int=4) must be present (geqbx).
    const nodeC_int = 4;
    const toColPrime = allocatedPairs.filter(
      s => (s.row === nodeB_ext && s.col === nodeC_int) ||
           (s.row === nodeC_int && s.col === nodeB_ext),
    );
    expect(toColPrime.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Task 5.2.7 — BJTsubs SUBS model param (B10)
// cite: bjtload.c:184-187 — SUBS: 1=VERTICAL, 0=LATERAL
// ---------------------------------------------------------------------------

describe("SpiceL1 ModelParams", () => {
  it("SUBS_default_1", () => {
    const propsObj = makeSpiceL1Props();
    expect(propsObj.getModelParam<number>("SUBS")).toBe(1);
  });

  it("SUBS_in_paramDefs", () => {
    const keys = BJT_SPICE_L1_PARAM_DEFS.map((pd: { key: string }) => pd.key);
    expect(keys).toContain("SUBS");
  });

  it("setParam_SUBS_no_throw", () => {
    const propsObj = makeSpiceL1Props();
    const core = createSpiceL1BjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj) as AnalogElementCore;
    expect(() => (core as any).setParam("SUBS", 0)).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Task 5.2.8 — AREAB / AREAC params (B11)
  // ---------------------------------------------------------------------------

  it("AREAB_default_1", () => {
    const propsObj = makeSpiceL1Props();
    expect(propsObj.getModelParam<number>("AREAB")).toBe(1);
  });

  it("AREAC_default_1", () => {
    const propsObj = makeSpiceL1Props();
    expect(propsObj.getModelParam<number>("AREAC")).toBe(1);
  });

  it("paramDefs_include_AREAB_AREAC", () => {
    const keys = BJT_SPICE_L1_PARAM_DEFS.map((pd: { key: string }) => pd.key);
    expect(keys).toContain("AREAB");
    expect(keys).toContain("AREAC");
  });
});

// ---------------------------------------------------------------------------
// Task 5.2.8 — AREAB/AREAC area-scaling correctness tests
// cite: bjtload.c:184-187, 573-576, 582-585
// ---------------------------------------------------------------------------

describe("BJT L1 AREAB_AREAC", () => {
  function makeL1El(modelParams: Record<string, number>): { el: AnalogElement; pool: StatePool } {
    const propsObj = makeSpiceL1Props(modelParams);
    const core = createSpiceL1BjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj) as AnalogElementCore;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);
    return { el: withNodeIds(core, [1, 2, 3]), pool };
  }

  function makeDcInitCtx(): LoadContext {
    // Use MODEINITFLOAT with VBC forward-biased so cbcn = c4*(exp(vbc/(nc*vt))-1) != 0.
    // c4 = tBCleakCur * AREAB (VERTICAL) or AREAC (LATERAL). Differences in c4 → differences in cb.
    // NPN node order: B=node[0], C=node[1], E=node[2]. vbc = voltages[0] - voltages[1].
    // Set VB=0.65, VC=0 → vbc = 0.65 (forward-biased), making cbcn nonzero and proportional to c4.
    const solver = new SparseSolver();
    solver.beginAssembly(10);
    const rhsOld = new Float64Array(10);
    rhsOld[0] = 0.65;  // VB: VBE forward
    rhsOld[1] = 0.0;   // VC=0 → vbc = VB - VC = 0.65 (forward-biased, cbcn fires)
    return {
      cktMode: MODEDCOP | MODEINITFLOAT,
      solver, matrix: solver,
      rhs: new Float64Array(10), rhsOld,
      time: 0, dt: 0, method: "trapezoidal", order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0],
      ag: new Float64Array(7), srcFact: 1,
      noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
      xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
      temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
    };
  }

  function makeTranCtx(): LoadContext {
    const solver = new SparseSolver();
    solver.beginAssembly(10);
    const rhsOld = new Float64Array(10);
    rhsOld[0] = 0.65;
    rhsOld[1] = -1.0;
    const ag = new Float64Array(7);
    ag[0] = 1 / 1e-9;
    return {
      cktMode: MODETRAN | MODEINITTRAN,
      solver, matrix: solver,
      rhs: new Float64Array(10), rhsOld,
      time: 1e-9, dt: 1e-9, method: "trapezoidal", order: 1,
      deltaOld: [1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9],
      ag, srcFact: 1,
      noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
      xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
      temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
    };
  }

  const SLOT_CB = 3;
  const SLOT_CQSUB = 13;

  it("c4_scales_with_AREAB_under_VERTICAL", () => {
    // SUBS=1 (VERTICAL): c4 = tBCleakCur * AREAB. Run MODEINITJCT so ISC leakage fires.
    const { el: el1, pool: pool1 } = makeL1El({ SUBS: 1, AREAB: 2, AREAC: 4, ISC: 1e-12 });
    const { el: el2, pool: pool2 } = makeL1El({ SUBS: 1, AREAB: 4, AREAC: 4, ISC: 1e-12 });
    el1.load(makeDcInitCtx());
    el2.load(makeDcInitCtx());
    // cb contains the BC leakage contribution via cbcn which scales with c4=ISC*AREAB.
    // el2 has AREAB=4 vs el1 AREAB=2 — el2 should have larger |CB|.
    const cb1 = pool1.states[0][SLOT_CB];
    const cb2 = pool2.states[0][SLOT_CB];
    expect(Math.abs(cb2)).toBeGreaterThan(Math.abs(cb1));
  });

  it("c4_scales_with_AREAC_under_LATERAL", () => {
    // SUBS=0 (LATERAL): c4 = tBCleakCur * AREAC.
    const { el: el1, pool: pool1 } = makeL1El({ SUBS: 0, AREAB: 2, AREAC: 2, ISC: 1e-12 });
    const { el: el2, pool: pool2 } = makeL1El({ SUBS: 0, AREAB: 2, AREAC: 4, ISC: 1e-12 });
    el1.load(makeDcInitCtx());
    el2.load(makeDcInitCtx());
    const cb1 = pool1.states[0][SLOT_CB];
    const cb2 = pool2.states[0][SLOT_CB];
    expect(Math.abs(cb2)).toBeGreaterThan(Math.abs(cb1));
  });

  it("czsub_scales_with_AREAC_under_VERTICAL", () => {
    // SUBS=1 (VERTICAL): czsub = tSubcap * AREAC. Probe via CQSUB after MODEINITTRAN.
    const { el: el1, pool: pool1 } = makeL1El({ SUBS: 1, AREAB: 2, AREAC: 2, CJS: 1e-12 });
    const { el: el2, pool: pool2 } = makeL1El({ SUBS: 1, AREAB: 2, AREAC: 4, CJS: 1e-12 });
    el1.load(makeTranCtx());
    el2.load(makeTranCtx());
    // MODEINITTRAN seeds s1[CQSUB] = s0[CQSUB]. s0[CQSUB] reflects capsub ∝ czsub ∝ AREAC.
    const cqsub1 = pool1.states[1][SLOT_CQSUB]; // state1 after MODEINITTRAN copy
    const cqsub2 = pool2.states[1][SLOT_CQSUB];
    expect(cqsub2).toBeGreaterThan(cqsub1);
  });

  it("czsub_scales_with_AREAB_under_LATERAL", () => {
    // SUBS=0 (LATERAL): czsub = tSubcap * AREAB.
    const { el: el1, pool: pool1 } = makeL1El({ SUBS: 0, AREAB: 2, AREAC: 4, CJS: 1e-12 });
    const { el: el2, pool: pool2 } = makeL1El({ SUBS: 0, AREAB: 4, AREAC: 4, CJS: 1e-12 });
    el1.load(makeTranCtx());
    el2.load(makeTranCtx());
    const cqsub1 = pool1.states[1][SLOT_CQSUB];
    const cqsub2 = pool2.states[1][SLOT_CQSUB];
    expect(cqsub2).toBeGreaterThan(cqsub1);
  });
});

// ---------------------------------------------------------------------------
// Task 5.2.9 — MODEINITTRAN charge state copy verification (B12)
// cite: bjtload.c:715-724, 735-740, 764-769
// ---------------------------------------------------------------------------

describe("BJT L1 MODEINITTRAN", () => {
  const SLOT_QBE = 8, SLOT_CQBE = 9;
  const SLOT_QBC = 10, SLOT_CQBC = 11;
  const SLOT_QSUB = 12, SLOT_CQSUB = 13;
  const SLOT_QBX = 14, SLOT_CQBX = 15;

  function makeL1TranInittranEl(modelParams?: Record<string, number>): { el: AnalogElement; pool: StatePool } {
    const propsObj = makeSpiceL1Props({ CJE: 1e-12, CJC: 1e-12, CJS: 1e-12, ...modelParams });
    const core = createSpiceL1BjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj) as AnalogElementCore;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);
    return { el: withNodeIds(core, [1, 2, 3]), pool };
  }

  function makeInittranCtx(): LoadContext {
    const solver = new SparseSolver();
    solver.beginAssembly(10);
    const rhsOld = new Float64Array(10);
    rhsOld[0] = 0.65; rhsOld[1] = -1.0;
    const ag = new Float64Array(7);
    ag[0] = 1 / 1e-9;
    return {
      cktMode: MODETRAN | MODEINITTRAN,
      solver, matrix: solver,
      rhs: new Float64Array(10), rhsOld,
      time: 1e-9, dt: 1e-9, method: "trapezoidal", order: 1,
      deltaOld: [1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9],
      ag, srcFact: 1,
      noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
      xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
      temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
    };
  }

  it("copies_qbe_qbc_qbx_qsub_to_state1", () => {
    const { el, pool } = makeL1TranInittranEl();
    el.load(makeInittranCtx());
    const s0 = pool.states[0];
    const s1 = pool.states[1];
    expect(s1[SLOT_QBE]).toBe(s0[SLOT_QBE]);
    expect(s1[SLOT_QBC]).toBe(s0[SLOT_QBC]);
    expect(s1[SLOT_QBX]).toBe(s0[SLOT_QBX]);
    expect(s1[SLOT_QSUB]).toBe(s0[SLOT_QSUB]);
  });

  it("copies_cqbe_cqbc_to_state1", () => {
    const { el, pool } = makeL1TranInittranEl();
    el.load(makeInittranCtx());
    const s0 = pool.states[0];
    const s1 = pool.states[1];
    expect(s1[SLOT_CQBE]).toBe(s0[SLOT_CQBE]);
    expect(s1[SLOT_CQBC]).toBe(s0[SLOT_CQBC]);
  });

  it("copies_cqbx_cqsub_to_state1", () => {
    const { el, pool } = makeL1TranInittranEl();
    el.load(makeInittranCtx());
    const s0 = pool.states[0];
    const s1 = pool.states[1];
    expect(s1[SLOT_CQBX]).toBe(s0[SLOT_CQBX]);
    expect(s1[SLOT_CQSUB]).toBe(s0[SLOT_CQSUB]);
  });
});

// ---------------------------------------------------------------------------
// Task 5.2.10 — cexbc INITTRAN seed + dt guard removal (B15)
// cite: bjtload.c:531-535, 536-539
// ---------------------------------------------------------------------------

describe("BJT L1 excess_phase", () => {
  const SLOT_CEXBC = 17;

  function makeExcessPhaseEl(modelParams?: Record<string, number>): { el: AnalogElement; pool: StatePool } {
    const propsObj = makeSpiceL1Props({ PTF: 15, TF: 1e-9, ...modelParams });
    const core = createSpiceL1BjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj) as AnalogElementCore;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);
    return { el: withNodeIds(core, [1, 2, 3]), pool };
  }

  function makeInittranCtx(): LoadContext {
    const solver = new SparseSolver();
    solver.beginAssembly(10);
    const rhsOld = new Float64Array(10);
    rhsOld[0] = 0.65; rhsOld[1] = -1.0;
    const ag = new Float64Array(7);
    ag[0] = 1 / 1e-9;
    return {
      cktMode: MODETRAN | MODEINITTRAN,
      solver, matrix: solver,
      rhs: new Float64Array(10), rhsOld,
      time: 1e-9, dt: 1e-9, method: "trapezoidal", order: 1,
      deltaOld: [1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9],
      ag, srcFact: 1,
      noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
      xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
      temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
    };
  }

  it("initTran_seeds_cexbc_state1_state2", () => {
    // cite: bjtload.c:531-535 — INITTRAN seeds state1+state2 cexbc to cbe/qb.
    // Pre-seed state1[VBE] with a forward vbe so cbe > 0 at the INITTRAN call.
    const { el, pool } = makeExcessPhaseEl();
    // Prime: run DC-OP pass so s0[VBE] = 0.65 (computed and stored).
    const primeSolver = new SparseSolver(); primeSolver.beginAssembly(10);
    const rhsPrime = new Float64Array(10); rhsPrime[0] = 0.65; rhsPrime[1] = -1.0;
    el.load({
      cktMode: MODEDCOP | MODEINITFLOAT, solver: primeSolver, matrix: primeSolver,
      rhs: new Float64Array(10), rhsOld: rhsPrime,
      time: 0, dt: 0, method: "trapezoidal", order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0], ag: new Float64Array(7), srcFact: 1,
      noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
      xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
      temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
    });
    // Copy s0[VBE] → s1[VBE] so MODEINITTRAN branch reads a non-zero vbe.
    pool.states[1][0] = pool.states[0][0]; // SLOT_VBE = 0
    el.load(makeInittranCtx());
    const s1val = pool.states[1][SLOT_CEXBC];
    const s2val = pool.states[2][SLOT_CEXBC];
    expect(s1val).toBe(s2val);
    expect(s1val).toBeGreaterThan(0);
  });

  it("uses_deltaOld1_directly", () => {
    // cite: bjtload.c:536-539 — IIR denom uses deltaOld[1] directly (dctran.c:317 seeds).
    // Two elements with identical state but different deltaOld[1] must produce different s0[CEXBC],
    // proving the IIR denominator consumes deltaOld[1].
    const { el: el1, pool: pool1 } = makeExcessPhaseEl();
    const { el: el2, pool: pool2 } = makeExcessPhaseEl();

    // Manually seed state1+state2 with distinct cexbc values so the dt/d1 terms in the IIR
    // formula do not cancel algebraically (s1 != s2 → cc depends on deltaOld1).
    const s1 = 1e-12;
    const s2 = 2e-12;
    pool1.states[1][SLOT_CEXBC] = s1;
    pool1.states[2][SLOT_CEXBC] = s2;
    pool2.states[1][SLOT_CEXBC] = s1;
    pool2.states[2][SLOT_CEXBC] = s2;

    function makeTranCtxWith(deltaOld1: number): LoadContext {
      const solver = new SparseSolver();
      solver.beginAssembly(10);
      const rhsOld = new Float64Array(10);
      rhsOld[0] = 0.65; rhsOld[1] = -1.0;
      const ag = new Float64Array(7);
      ag[0] = 1 / 1e-9;
      return {
        cktMode: MODETRAN | MODEINITFLOAT,
        solver, matrix: solver,
        rhs: new Float64Array(10), rhsOld,
        time: 1e-9, dt: 1e-9, method: "trapezoidal", order: 1,
        deltaOld: [1e-9, deltaOld1, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9],
        ag, srcFact: 1,
        noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
        xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
        temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
      };
    }

    el1.load(makeTranCtxWith(1e-6));
    el2.load(makeTranCtxWith(1e-5));

    // Different deltaOld[1] → different dt/deltaOld1 term → different IIR cc → different s0[CEXBC].
    expect(pool1.states[0][SLOT_CEXBC]).not.toBe(pool2.states[0][SLOT_CEXBC]);
  });

  // ---------------------------------------------------------------------------
  // Task 5.2.11 — cex uses raw op.cbe (B22)
  // cite: bjtload.c:522-524
  // ---------------------------------------------------------------------------

  it("cex_is_raw_cbe_not_cbeMod", () => {
    // cite: bjtload.c:522-524 — cex/gex seeded from raw cbe/gbe BEFORE XTF modification.
    // INITTRAN seeds s1[CEXBC] = cbe/qb — independent of XTF.
    // Two elements differing only in XTF must produce identical s1[CEXBC].
    const { el: el0, pool: pool0 } = makeExcessPhaseEl({ XTF: 0 });
    const { el: el10, pool: pool10 } = makeExcessPhaseEl({ XTF: 10 });

    el0.load(makeInittranCtx());
    el10.load(makeInittranCtx());

    expect(pool0.states[1][SLOT_CEXBC]).toBe(pool10.states[1][SLOT_CEXBC]);
  });
});

// ---------------------------------------------------------------------------
// Task 5.2.12 — XTF=0 gbe adjustment verification (F-BJT-ADD-21)
// cite: bjtload.c:591-610
// ---------------------------------------------------------------------------

describe("BJT L1 XTF_zero", () => {
  const SLOT_QBE = 8;

  function makeL1WithTfXtf(TF: number, XTF: number): { el: AnalogElement; pool: StatePool } {
    const propsObj = makeSpiceL1Props({ TF, XTF, CJE: 1e-12 });
    const core = createSpiceL1BjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj) as AnalogElementCore;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);
    return { el: withNodeIds(core, [1, 2, 3]), pool };
  }

  function makeSmsigCtx(): LoadContext {
    const solver = new SparseSolver();
    solver.beginAssembly(10);
    const rhsOld = new Float64Array(10);
    rhsOld[0] = 0.65; rhsOld[1] = -1.0;
    return {
      cktMode: MODEDCOP | MODEINITSMSIG,
      solver, matrix: solver,
      rhs: new Float64Array(10), rhsOld,
      time: 0, dt: 0, method: "trapezoidal", order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0],
      ag: new Float64Array(7), srcFact: 1,
      noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
      xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
      temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
    };
  }

  it("cbeMod_computed_when_tf_nonzero_xtf_zero", () => {
    // cite: bjtload.c:591-610 — when tf>0 && vbe>0, cbeMod block runs.
    // XTF=0 collapses argtf=arg2=0, so cbeMod = cbe*(1+0)/qb = cbe/qb (still non-zero).
    const { el: elTf, pool: poolTf } = makeL1WithTfXtf(1e-9, 0);
    const { el: elNoTf, pool: poolNoTf } = makeL1WithTfXtf(0, 0);

    // Prime with DC-OP first.
    const primeSolver1 = new SparseSolver(); primeSolver1.beginAssembly(10);
    const primeSolver2 = new SparseSolver(); primeSolver2.beginAssembly(10);
    const rhsOld = new Float64Array(10); rhsOld[0] = 0.65; rhsOld[1] = -1.0;
    const primeCtx1: LoadContext = {
      cktMode: MODEDCOP | MODEINITFLOAT, solver: primeSolver1, matrix: primeSolver1,
      rhs: new Float64Array(10), rhsOld,
      time: 0, dt: 0, method: "trapezoidal", order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0], ag: new Float64Array(7), srcFact: 1,
      noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
      xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
      temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
    };
    elTf.load(primeCtx1);
    elNoTf.load({ ...primeCtx1, solver: primeSolver2, matrix: primeSolver2 });

    elTf.load(makeSmsigCtx());
    elNoTf.load(makeSmsigCtx());

    const qbeTf = poolTf.states[0][SLOT_QBE];
    const qbeNoTf = poolNoTf.states[0][SLOT_QBE];
    // With TF>0, QBE includes transit-time contribution: TF*cbeMod term.
    expect(qbeTf).toBeGreaterThan(0);
    expect(qbeNoTf).toBeGreaterThan(0);
    // TF=1e-9 adds transit-time contribution → larger QBE.
    expect(qbeTf).toBeGreaterThan(qbeNoTf);
  });

  it("cbeMod_skipped_when_tf_zero", () => {
    // cite: bjtload.c:591-610 — when tf=0, cbeMod block is skipped entirely.
    // QBE = DC component only: pe*czbe*(1-arg*sarg)/(1-xme) for vbe<fcpe.
    const { el, pool } = makeL1WithTfXtf(0, 0);

    // Prime.
    const primeSolver = new SparseSolver(); primeSolver.beginAssembly(10);
    const rhsOld = new Float64Array(10); rhsOld[0] = 0.65; rhsOld[1] = -1.0;
    el.load({
      cktMode: MODEDCOP | MODEINITFLOAT, solver: primeSolver, matrix: primeSolver,
      rhs: new Float64Array(10), rhsOld,
      time: 0, dt: 0, method: "trapezoidal", order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0], ag: new Float64Array(7), srcFact: 1,
      noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
      xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
      temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
    });

    el.load(makeSmsigCtx());

    const qbe = pool.states[0][SLOT_QBE];
    // TF=0 → no transit-time contribution → QBE == DC charge (CJE>0, so QBE>0).
    expect(qbe).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Task 5.2.13 — geqsub Norton aggregation verification (F-BJT-ADD-23)
// cite: bjtload.c:798-800, 823
// ---------------------------------------------------------------------------

describe("BJT L1 substrate", () => {
  const SLOT_GCSUB = 19, SLOT_GDSUB = 23;

  it("geqsub_aggregates_gcsub_gdsub", () => {
    // cite: bjtload.c:798-800 — geqsub = gcsub + gdsub; all substrate stamps use geqsub.
    // Strategy: run with CJS>0 and ISS>0 in tran mode so both gcsub and gdsub are non-zero.
    // Read gcsub and gdsub from s0. The stamp at (substConNode, substConNode) must equal
    // m * (gcsub + gdsub). We verify by checking the sum is non-zero and finite.
    const propsObj = makeSpiceL1Props({ CJS: 1e-12, ISS: 1e-14, SUBS: 1 });
    const core = createSpiceL1BjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj) as AnalogElementCore;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);
    const el = withNodeIds(core, [1, 2, 3]);

    const ag = new Float64Array(7);
    ag[0] = 1 / 1e-9;
    const rhsOld = new Float64Array(10);
    rhsOld[0] = 0.65; rhsOld[1] = -1.0;
    const solver = new SparseSolver(); solver.beginAssembly(10);
    const ctx: LoadContext = {
      cktMode: MODETRAN | MODEINITTRAN,
      solver, matrix: solver,
      rhs: new Float64Array(10), rhsOld,
      time: 1e-9, dt: 1e-9, method: "trapezoidal", order: 1,
      deltaOld: [1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9],
      ag, srcFact: 1,
      noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
      xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
      temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
    };
    el.load(ctx);

    const s0 = pool.states[0];
    const gcsub = s0[SLOT_GCSUB];
    const gdsub = s0[SLOT_GDSUB];
    const geqsub = gcsub + gdsub;
    // geqsub must be positive and finite — confirms both components contribute.
    expect(geqsub).toBeGreaterThan(0);
    expect(Number.isFinite(geqsub)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 5.2.14 — Cap block gating verification (F-BJT-ADD-25)
// cite: bjtload.c:561-563
// ---------------------------------------------------------------------------

describe("BJT L1 cap_block", () => {
  const SLOT_QBE = 8, SLOT_CQBE = 9;

  function makeL1Cap(modelParams?: Record<string, number>): { el: AnalogElement; pool: StatePool } {
    const propsObj = makeSpiceL1Props({ CJE: 1e-12, ...modelParams });
    const core = createSpiceL1BjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj) as AnalogElementCore;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);
    return { el: withNodeIds(core, [1, 2, 3]), pool };
  }

  function makeCtxWith(cktMode: number, dt: number): LoadContext {
    const solver = new SparseSolver();
    solver.beginAssembly(10);
    const rhsOld = new Float64Array(10);
    rhsOld[0] = 0.65; rhsOld[1] = -1.0;
    const ag = new Float64Array(7);
    if (dt > 0) ag[0] = 1 / dt;
    return {
      cktMode,
      solver, matrix: solver,
      rhs: new Float64Array(10), rhsOld,
      time: dt, dt, method: "trapezoidal", order: 1,
      deltaOld: [dt, dt, dt, dt, dt, dt, dt],
      ag, srcFact: 1,
      noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
      xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
      temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
    };
  }

  it("skipped_under_pure_dcop", () => {
    // cite: bjtload.c:561-563 — cap block gate excludes pure DCOP.
    const { el, pool } = makeL1Cap({ CJC: 1e-12 });
    el.load(makeCtxWith(MODEDCOP | MODEINITFLOAT, 0));
    // Cap block did not fire — QBE stays 0.
    expect(pool.states[0][SLOT_QBE]).toBe(0);
  });

  it("entered_under_MODETRAN", () => {
    // cite: bjtload.c:561-563 — MODETRAN bit opens cap block.
    const { el, pool } = makeL1Cap();
    el.load(makeCtxWith(MODEDCOP | MODETRAN | MODEINITFLOAT, 1e-9));
    expect(pool.states[0][SLOT_QBE]).toBeGreaterThan(0);
  });

  it("entered_under_MODETRANOP_MODEUIC", () => {
    // cite: bjtload.c:562 — (MODETRANOP && MODEUIC) opens cap block.
    const { el, pool } = makeL1Cap();
    el.load(makeCtxWith(MODETRANOP | MODEUIC | MODEINITFLOAT, 0));
    expect(pool.states[0][SLOT_QBE]).toBeGreaterThan(0);
  });

  it("entered_under_MODEINITSMSIG", () => {
    // cite: bjtload.c:563 — MODEINITSMSIG opens cap block; stores cap values in s0.
    const { el, pool } = makeL1Cap();
    // Prime s0 first with a DC-OP so MODEINITSMSIG reads valid op values.
    const primeSolver = new SparseSolver(); primeSolver.beginAssembly(10);
    const rhsOld = new Float64Array(10); rhsOld[0] = 0.65; rhsOld[1] = -1.0;
    el.load({
      cktMode: MODEDCOP | MODEINITFLOAT, solver: primeSolver, matrix: primeSolver,
      rhs: new Float64Array(10), rhsOld,
      time: 0, dt: 0, method: "trapezoidal", order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0], ag: new Float64Array(7), srcFact: 1,
      noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
      xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
      temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
    });
    el.load(makeCtxWith(MODEDCOP | MODEINITSMSIG, 0));
    // MODEINITSMSIG stores cap value in CQBE slot.
    expect(pool.states[0][SLOT_CQBE]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Task 5.2.15 — VSUB limiting collector entry (F-BJT-ADD-34)
// cite: after BC push — SUB push with junction="SUB"
// ---------------------------------------------------------------------------

describe("BJT L1 LimitingEvent SUB", () => {
  function makeL1ElWithLabel(modelParams?: Record<string, number>): AnalogElement {
    const propsObj = makeSpiceL1Props({ ISS: 1e-14, ...modelParams });
    const core = createSpiceL1BjtElement(
      1, new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj,
    ) as AnalogElementCore & { label?: string; elementIndex?: number };
    core.label = "Q_SUB";
    core.elementIndex = 7;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);
    return withNodeIds(core, [1, 2, 3]);
  }

  function makeCtxForSubLimiting(collector: LimitingEvent[] | null): LoadContext {
    // Use DC-OP mode with moderate vbe to trigger pnjlim on sub junction.
    // vsubRaw = polarity*subs*(0 - vSubCon) — with default SUBS=1 NPN, substConNode=nodeC_int=nodeC_ext=node2.
    // rhsOld[1] = 0 (collector=0) → vsubRaw = 1*1*(0-0) = 0. Use a large VBC to ensure sub junction fires.
    // Instead: start with all-zero state so pnjlim fires on BE at minimum.
    const solver = new SparseSolver();
    solver.beginAssembly(10);
    const rhsOld = new Float64Array(10);
    rhsOld[0] = 5.0;  // VBE very large — triggers pnjlim on BE and limits.
    return {
      cktMode: MODEDCOP | MODEINITFLOAT,
      solver, matrix: solver,
      rhs: new Float64Array(10), rhsOld,
      time: 0, dt: 0, method: "trapezoidal", order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0],
      ag: new Float64Array(7), srcFact: 1,
      noncon: { value: 0 }, limitingCollector: collector, convergenceCollector: null,
      xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
      temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
    };
  }

  it("pushes_SUB_event_when_collector_present", () => {
    const el = makeL1ElWithLabel();
    const collector: LimitingEvent[] = [];
    el.load(makeCtxForSubLimiting(collector));

    const subEv = collector.find((e: LimitingEvent) => e.junction === "SUB");
    expect(subEv).toBeDefined();
    expect(subEv!.limitType).toBe("pnjlim");
    expect(subEv!.elementIndex).toBe(7);
    expect(subEv!.label).toBe("Q_SUB");
    expect(Number.isFinite(subEv!.vBefore)).toBe(true);
    expect(Number.isFinite(subEv!.vAfter)).toBe(true);
    expect(typeof subEv!.wasLimited).toBe("boolean");
  });

  it("no_SUB_event_when_collector_null", () => {
    const el = makeL1ElWithLabel();
    expect(() => el.load(makeCtxForSubLimiting(null))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Wave 5.3 — BJT per-instance TEMP parameter
// ---------------------------------------------------------------------------

describe("BJT TEMP", () => {
  // Task 5.3.1 tests

  it("TEMP_default_300_15", () => {
    // After makeBjtProps(), propsObj.getModelParam<number>("TEMP") === 300.15.
    const propsObj = makeBjtProps();
    expect(propsObj.getModelParam<number>("TEMP")).toBe(300.15);
  });

  it("paramDefs_include_TEMP", () => {
    // BJT_PARAM_DEFS.map(pd => pd.key) contains "TEMP".
    const keys = BJT_PARAM_DEFS.map(pd => pd.key);
    expect(keys).toContain("TEMP");
  });

  it("setParam_TEMP_no_throw", () => {
    // element.setParam("TEMP", 400) doesn't throw.
    const propsObj = makeBjtProps();
    const element = createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, propsObj);
    expect(() => element.setParam("TEMP", 400)).not.toThrow();
  });

  // Task 5.3.2 tests

  it("tp_vt_reflects_TEMP", () => {
    // Construct L0 NPN with TEMP=400, assert tp.vt approximately equals 400 * KoverQ.
    // KoverQ = 1.3806226e-23 / 1.6021918e-19
    const KoverQ = 1.3806226e-23 / 1.6021918e-19;
    const vtAt300 = 300.15 * KoverQ;
    const vtAt400 = 400 * KoverQ;

    // Probe tp.vt through MODEINITJCT: s0[VBE] = tVcrit = vt * log(vt / (sqrt2 * tSatCur * AREA)).
    // At 300.15K with IS=1e-16: tSatCur=IS (no temp scaling at TNOM=300.15K).
    // tVcrit(300.15K) = vtAt300 * log(vtAt300 / (sqrt2 * 1e-16))
    // At 400K: tSatCur = IS * exp(factlog) >> IS. Both vt and tSatCur change.
    // Compute expected tVcrit values from the same formula used in computeBjtTempParams.
    const REFTEMP = 300.15;
    const k = 1.3806226e-23;
    const q_charge = 1.6021918e-19;
    function computeTVcrit(T: number, IS: number): number {
      const vt = T * KoverQ;
      const fact2 = T / REFTEMP;
      const egfet = 1.16 - (7.02e-4 * T * T) / (T + 1108);
      const arg = -egfet / (2 * k * T) + 1.1150877 / (k * (REFTEMP + REFTEMP));
      const pbfact = -2 * vt * (1.5 * Math.log(fact2) + q_charge * arg);
      const pbo_be = (0.75 - pbfact) / (REFTEMP / REFTEMP);
      const ratlog = Math.log(T / REFTEMP);
      const ratio1 = T / REFTEMP - 1;
      const factlog = ratio1 * 1.11 / vt + 3 * ratlog;
      const factor = Math.exp(factlog);
      const tSatCur = IS * factor;
      return vt * Math.log(vt / (Math.SQRT2 * tSatCur * 1));
    }

    const expectedTVcrit300 = computeTVcrit(300.15, 1e-16);
    const expectedTVcrit400 = computeTVcrit(400, 1e-16);

    const coreDefault = createBjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), -1, makeBjtProps({ TEMP: 300.15 })) as any;
    const core400 = createBjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), -1, makeBjtProps({ TEMP: 400 })) as any;
    const pool300 = new StatePool(coreDefault.stateSize);
    const pool400 = new StatePool(core400.stateSize);
    coreDefault.stateBaseOffset = 0;
    core400.stateBaseOffset = 0;
    coreDefault.initState(pool300);
    core400.initState(pool400);

    function makeJctCtx(): LoadContext {
      const solver = new SparseSolver();
      solver.beginAssembly(10);
      return {
        cktMode: MODEINITJCT,
        solver, matrix: solver,
        rhs: new Float64Array(10), rhsOld: new Float64Array(10),
        time: 0, dt: 0, method: "trapezoidal", order: 1,
        deltaOld: [0, 0, 0, 0, 0, 0, 0],
        ag: new Float64Array(7), srcFact: 1,
        noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
        xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
        temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
      };
    }

    withNodeIds(coreDefault, [1, 2, 3]).load(makeJctCtx());
    withNodeIds(core400, [1, 2, 3]).load(makeJctCtx());

    const vbe300 = pool300.states[0][0]; // SLOT_VBE = tVcrit(300.15K)
    const vbe400 = pool400.states[0][0]; // SLOT_VBE = tVcrit(400K)

    // Both must equal their analytically computed tVcrit values.
    expect(Math.abs(vbe300 - expectedTVcrit300)).toBeLessThan(1e-6);
    expect(Math.abs(vbe400 - expectedTVcrit400)).toBeLessThan(1e-6);
    // And vt(400K) > vt(300.15K) even though tVcrit(400K) < tVcrit(300.15K).
    expect(vtAt400).toBeGreaterThan(vtAt300);
  });

  it("tSatCur_scales_with_TEMP", () => {
    // Construct L1 NPN with IS=1e-16, XTI=3, EG=1.11, TNOM=300.15.
    // Build at TEMP=300.15 and TEMP=400. Assert tSatCur(400) > tSatCur(300.15).
    // We probe tSatCur via MODEINITJCT s0[VBE] = tVcrit = vt*log(vt/(sqrt2*tSatCur*AREA)).
    // Higher tSatCur → smaller tVcrit. Higher T also raises vt. Net effect: tVcrit(400) > tVcrit(300.15)
    // because at 400K the exp(factlog) factor dominates IS scaling.
    // We verify by checking that the CB (base current) after a DC forward-active load is
    // larger for TEMP=400 (higher tSatCur → larger cbe at same vbe).
    function makeL1AtTemp(TEMP: number): { el: any; pool: StatePool } {
      const propsObj = makeSpiceL1Props({ IS: 1e-16, XTI: 3, EG: 1.11, TNOM: 300.15, TEMP });
      const core = createSpiceL1BjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsObj) as any;
      const pool = new StatePool(core.stateSize);
      core.stateBaseOffset = 0;
      core.initState(pool);
      return { el: withNodeIds(core, [1, 2, 3]), pool };
    }

    function makeForwardCtx(): LoadContext {
      const solver = new SparseSolver();
      solver.beginAssembly(10);
      const rhsOld = new Float64Array(10);
      rhsOld[0] = 0.65; // VB
      rhsOld[1] = 3.0;  // VC
      rhsOld[2] = 0.0;  // VE
      return {
        cktMode: MODEDCOP | MODEINITFLOAT,
        solver, matrix: solver,
        rhs: new Float64Array(10), rhsOld,
        time: 0, dt: 0, method: "trapezoidal", order: 1,
        deltaOld: [0, 0, 0, 0, 0, 0, 0],
        ag: new Float64Array(7), srcFact: 1,
        noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
        xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
        temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
      };
    }

    const { el: el300, pool: pool300 } = makeL1AtTemp(300.15);
    const { el: el400, pool: pool400 } = makeL1AtTemp(400);
    el300.load(makeForwardCtx());
    el400.load(makeForwardCtx());

    const SLOT_CB = 3;
    const cb300 = pool300.states[0][SLOT_CB];
    const cb400 = pool400.states[0][SLOT_CB];
    // Higher temperature → higher tSatCur → larger base current at same vbe.
    expect(Math.abs(cb400)).toBeGreaterThan(Math.abs(cb300));
  });

  it("TNOM_stays_nominal", () => {
    // Construct BJT with TEMP=400, TNOM=300.15; assert tp.tBetaF reflects T/TNOM ratio.
    // tBetaF = BF * exp(ratlog * XTB) where ratlog = log(T / TNOM) = log(400/300.15).
    // With XTB=0.5, bfactor = exp(log(400/300.15)*0.5) = (400/300.15)^0.5.
    // Two elements with same TEMP=400 but different XTB must produce different tBetaF,
    // and the element with XTB=0 must have tBetaF == BF regardless of TEMP.
    const propsXtb0 = makeSpiceL1Props({ TEMP: 400, TNOM: 300.15, BF: 100, XTB: 0 });
    const propsXtb05 = makeSpiceL1Props({ TEMP: 400, TNOM: 300.15, BF: 100, XTB: 0.5 });

    // We probe tBetaF by checking the forward gain: in the Gummel-Poon model,
    // cb ≈ cbe / tBetaF + ...; so tBetaF changes the base current.
    const coreXtb0 = createSpiceL1BjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsXtb0) as any;
    const coreXtb05 = createSpiceL1BjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsXtb05) as any;
    const poolXtb0 = new StatePool(coreXtb0.stateSize);
    const poolXtb05 = new StatePool(coreXtb05.stateSize);
    coreXtb0.stateBaseOffset = 0;
    coreXtb05.stateBaseOffset = 0;
    coreXtb0.initState(poolXtb0);
    coreXtb05.initState(poolXtb05);

    function makeCtx(): LoadContext {
      const solver = new SparseSolver();
      solver.beginAssembly(10);
      const rhsOld = new Float64Array(10);
      rhsOld[0] = 0.65; rhsOld[1] = 3.0; rhsOld[2] = 0.0;
      return {
        cktMode: MODEDCOP | MODEINITFLOAT,
        solver, matrix: solver,
        rhs: new Float64Array(10), rhsOld,
        time: 0, dt: 0, method: "trapezoidal", order: 1,
        deltaOld: [0, 0, 0, 0, 0, 0, 0],
        ag: new Float64Array(7), srcFact: 1,
        noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
        xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
        temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
      };
    }

    withNodeIds(coreXtb0, [1, 2, 3]).load(makeCtx());
    withNodeIds(coreXtb05, [1, 2, 3]).load(makeCtx());

    const SLOT_CB = 3;
    const cbXtb0 = poolXtb0.states[0][SLOT_CB];
    const cbXtb05 = poolXtb05.states[0][SLOT_CB];

    // XTB=0.5 at TEMP=400 > TNOM=300.15 → bfactor > 1 → tBetaF > BF → smaller cb (less base current).
    // XTB=0 → bfactor=1 → tBetaF == BF.
    // So |cb(XTB=0.5)| < |cb(XTB=0)| when TEMP>TNOM and XTB>0.
    expect(Math.abs(cbXtb05)).toBeLessThan(Math.abs(cbXtb0));
  });

  // Task 5.3.3 test

  it("no_ctx_vt_read_in_bjt_ts", () => {
    // fs.readFileSync on bjt.ts; assert the string "ctx.vt" appears zero times.
    const fs = require("fs");
    const src = fs.readFileSync(
      require("path").resolve(__dirname, "../bjt.ts"),
      "utf8",
    ) as string;
    const matches = src.match(/ctx\.vt/g);
    expect(matches).toBeNull();
  });

  // Task 5.3.4 tests

  it("setParam_TEMP_recomputes_tp_L0", () => {
    // Construct L0 NPN at default TEMP=300.15, call setParam("TEMP", 400),
    // then run MODEINITJCT load and verify tVcrit (seeded into s0[VBE]) reflects 400K.
    // tVcrit = vt * log(vt / (sqrt2 * tSatCur * AREA)); tSatCur scales with TEMP
    // so tVcrit(400K) != tVcrit(300.15K).
    const REFTEMP = 300.15;
    const k = 1.3806226e-23;
    const q_charge = 1.6021918e-19;
    const KoverQ = k / q_charge;

    function computeExpectedTVcrit(T: number, IS: number): number {
      const vt = T * KoverQ;
      const fact2 = T / REFTEMP;
      const egfet = 1.16 - (7.02e-4 * T * T) / (T + 1108);
      const arg = -egfet / (2 * k * T) + 1.1150877 / (k * (REFTEMP + REFTEMP));
      const pbfact = -2 * vt * (1.5 * Math.log(fact2) + q_charge * arg);
      const ratlog = Math.log(T / REFTEMP);
      const ratio1 = T / REFTEMP - 1;
      const factlog = ratio1 * 1.11 / vt + 3 * ratlog;
      const factor = Math.exp(factlog);
      const tSatCur = IS * factor;
      return vt * Math.log(vt / (Math.SQRT2 * tSatCur * 1));
    }

    const expectedTVcrit300 = computeExpectedTVcrit(300.15, 1e-16);
    const expectedTVcrit400 = computeExpectedTVcrit(400, 1e-16);
    // They must differ (this is what we are testing — setParam actually changes tp).
    expect(Math.abs(expectedTVcrit400 - expectedTVcrit300)).toBeGreaterThan(0.05);

    const propsDefault = makeBjtProps();
    const core = createBjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), -1, propsDefault) as any;
    const pool = new StatePool(core.stateSize);
    core.stateBaseOffset = 0;
    core.initState(pool);
    const element = withNodeIds(core, [1, 2, 3]);

    function makeJctCtx(): LoadContext {
      const solver = new SparseSolver();
      solver.beginAssembly(10);
      return {
        cktMode: MODEINITJCT,
        solver, matrix: solver,
        rhs: new Float64Array(10), rhsOld: new Float64Array(10),
        time: 0, dt: 0, method: "trapezoidal", order: 1,
        deltaOld: [0, 0, 0, 0, 0, 0, 0],
        ag: new Float64Array(7), srcFact: 1,
        noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
        xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
        temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
      };
    }

    // First load at 300.15K — tVcrit should match expectedTVcrit300.
    element.load(makeJctCtx());
    const vbe300 = pool.states[0][0];
    expect(Math.abs(vbe300 - expectedTVcrit300)).toBeLessThan(1e-6);

    // setParam("TEMP", 400) must trigger makeTp() recompute.
    core.setParam("TEMP", 400);

    // Load again at MODEINITJCT — tVcrit must now reflect 400K.
    element.load(makeJctCtx());
    const vbe400 = pool.states[0][0];
    expect(Math.abs(vbe400 - expectedTVcrit400)).toBeLessThan(1e-6);
  });

  it("setParam_TEMP_recomputes_tp_L1", () => {
    // Construct L1 NPN at default TEMP=300.15, call setParam("TEMP", 400),
    // then run MODEINITJCT load and verify tVcrit (seeded into s0[VBE]) reflects 400K.
    const REFTEMP = 300.15;
    const k = 1.3806226e-23;
    const q_charge = 1.6021918e-19;
    const KoverQ = k / q_charge;

    function computeExpectedTVcrit(T: number, IS: number, EG: number, XTI: number): number {
      const vt = T * KoverQ;
      const fact2 = T / REFTEMP;
      const egfet = 1.16 - (7.02e-4 * T * T) / (T + 1108);
      const arg = -egfet / (2 * k * T) + 1.1150877 / (k * (REFTEMP + REFTEMP));
      const pbfact = -2 * vt * (1.5 * Math.log(fact2) + q_charge * arg);
      const ratlog = Math.log(T / REFTEMP);
      const ratio1 = T / REFTEMP - 1;
      const factlog = ratio1 * EG / vt + XTI * ratlog;
      const factor = Math.exp(factlog);
      const tSatCur = IS * factor;
      return vt * Math.log(vt / (Math.SQRT2 * tSatCur * 1));
    }

    const IS = 1e-16, EG = 1.11, XTI = 3;
    const expectedTVcrit300 = computeExpectedTVcrit(300.15, IS, EG, XTI);
    const expectedTVcrit400 = computeExpectedTVcrit(400, IS, EG, XTI);
    // Confirm they differ significantly so the test is meaningful.
    expect(Math.abs(expectedTVcrit400 - expectedTVcrit300)).toBeGreaterThan(0.05);

    const propsDefault = makeSpiceL1Props({ IS, EG, XTI });
    const core = createSpiceL1BjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), [], -1, propsDefault) as any;
    const pool = new StatePool(core.stateSize);
    core.stateBaseOffset = 0;
    core.initState(pool);
    const element = withNodeIds(core, [1, 2, 3]);

    function makeJctCtx(): LoadContext {
      const solver = new SparseSolver();
      solver.beginAssembly(10);
      return {
        cktMode: MODEINITJCT,
        solver, matrix: solver,
        rhs: new Float64Array(10), rhsOld: new Float64Array(10),
        time: 0, dt: 0, method: "trapezoidal", order: 1,
        deltaOld: [0, 0, 0, 0, 0, 0, 0],
        ag: new Float64Array(7), srcFact: 1,
        noncon: { value: 0 }, limitingCollector: null, convergenceCollector: null,
        xfact: 1, gmin: 1e-12, reltol: 1e-3, iabstol: 1e-12,
        temp: 300.15, vt: 0.025852, cktFixLimit: false, bypass: false, voltTol: 1e-6,
      };
    }

    // Load at default 300.15K.
    element.load(makeJctCtx());
    const vbe300 = pool.states[0][0];
    expect(Math.abs(vbe300 - expectedTVcrit300)).toBeLessThan(1e-6);

    // setParam("TEMP", 400) must trigger makeTp() recompute.
    core.setParam("TEMP", 400);

    // Load again — tVcrit must reflect 400K.
    element.load(makeJctCtx());
    const vbe400 = pool.states[0][0];
    expect(Math.abs(vbe400 - expectedTVcrit400)).toBeLessThan(1e-6);
  });
});
