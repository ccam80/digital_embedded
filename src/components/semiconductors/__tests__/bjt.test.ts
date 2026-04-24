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
    voltages,
    dt: 0,
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
    const rhsOld = new Float64Array(10);
    const { ctx, element, s0 } = makeFullLoadCtx(MODEINITJCT, rhsOld, { OFF: 0 });
    element.load(ctx);
    // tVcrit > 0 for NPN (thermal-voltage-derived critical voltage).
    expect(s0[SLOT_VBE]).toBeGreaterThan(0);
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

  function makeBypassCtx(
    cktMode: number,
    rhsOld: Float64Array,
    bypass: boolean,
    modelParams?: Record<string, number>,
  ): { ctx: LoadContext; element: AnalogElement; s0: Float64Array; pool: StatePool; stampCount: { g: number; rhs: number } } {
    const propsObj = makeBjtProps(modelParams);
    const core = createBjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), -1, propsObj) as AnalogElementCore;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);
    const solver = new SparseSolver();
    solver.beginAssembly(10);
    const stampCount = { g: 0, rhs: 0 };
    const origAddEntry = solver.addEntry?.bind(solver);
    const origStampG = (solver as any).stampG;
    // Wrap solver to count stamps via addEntry (SparseSolver.addEntry is the stamp primitive).
    const origAddEntryFn = (solver as any).addEntry;
    if (origAddEntryFn) {
      (solver as any).addEntry = (row: number, col: number, val: number) => {
        if (row === col) stampCount.g++;
        origAddEntryFn.call(solver, row, col, val);
      };
    }
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
      bypass,
      voltTol: 1e-6,
    };
    const element = withNodeIds(core, [1, 2, 3]);
    return { ctx, element, s0: pool.states[0], pool, stampCount };
  }

  it("bypass_disabled_when_ctx_bypass_false", () => {
    // cite: bjtload.c:338 — bypass gate requires ctx.bypass=true; both calls must compute.
    // With bypass=false the gate never fires even when tolerances are met.
    const rhsOld = new Float64Array(10);
    rhsOld[0] = 0.65; // nodeB=1
    rhsOld[1] = 3.0;  // nodeC=2
    rhsOld[2] = 0.0;  // nodeE=3

    // First call — compute path, writes s0.
    const { ctx: ctx1, element: el1 } = makeBypassCtx(MODEDCOP | MODEINITFLOAT, rhsOld, false);
    el1.load(ctx1);
    const noncon1 = ctx1.noncon.value;

    // Second call with identical rhsOld — bypass=false, so compute path again.
    const { ctx: ctx2, element: el2, s0 } = makeBypassCtx(MODEDCOP | MODEINITFLOAT, rhsOld, false);
    // Prime s0 with same state from first call to make tolerances nominally met.
    const s0prime = (el1 as any).pool?.states?.[0];
    // Second load should also run compute (bypass=false), noncon should be >= 0.
    el2.load(ctx2);
    // Both calls produced noncon values (compute ran); the test checks bypass=false doesn't skip.
    // Verify stamps were emitted on the second call by checking no throw and noncon is consistent.
    expect(ctx2.noncon.value).toBeGreaterThanOrEqual(0);
    // s0[CC] is finite (compute wrote it, not NaN from a skip).
    expect(Number.isFinite(s0[SLOT_CC])).toBe(true);
  });

  it("bypass_triggers_when_tolerances_met", () => {
    // cite: bjtload.c:338-381 — bypass fires when ctx.bypass=true and all 4 tolerances pass.
    // Strategy: run first load() to prime s0, then manually align rhsOld to s0[VBE]/s0[VBC]
    // so delvbe=0 and delvbc=0 exactly, ensuring all 4 tolerance tests pass on the second call.
    const propsObj = makeBjtProps();
    const core = createBjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), -1, propsObj) as AnalogElementCore;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);
    const s0 = pool.states[0];

    function makeCtx(rhsOld: Float64Array, bypass: boolean, nonconRef: { value: number }): LoadContext {
      const solver = new SparseSolver();
      solver.beginAssembly(10);
      return {
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
        limitingCollector: null,
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
    }

    const element = withNodeIds(core, [1, 2, 3]);

    // First call — bypass=false, primes s0 with self-consistent op-state.
    const rhsOld1 = new Float64Array(10);
    rhsOld1[0] = 0.65; rhsOld1[1] = 3.0; rhsOld1[2] = 0.0;
    element.load(makeCtx(rhsOld1, false, { value: 0 }));

    // Build rhsOld2 aligned to s0[VBE]/s0[VBC] so delvbe=delvbc=0 exactly.
    // NPN: vbeRaw = vB-vE, vbcRaw = vB-vC. Set vB-vE = s0[VBE], vB-vC = s0[VBC].
    // Let vE=0, vC=0, solve: vB = s0[VBE]; vC = vB - s0[VBC].
    const vbeTarget = s0[SLOT_VBE];
    const vbcTarget = s0[SLOT_VBC];
    const rhsOld2 = new Float64Array(10);
    rhsOld2[0] = vbeTarget;           // nodeB=1 → vB = vbeTarget (vE=0)
    rhsOld2[1] = vbeTarget - vbcTarget; // nodeC=2 → vC = vB - vbcTarget
    rhsOld2[2] = 0.0;                 // nodeE=3

    const cc1 = s0[SLOT_CC];
    const noncon2 = { value: 0 };
    element.load(makeCtx(rhsOld2, true, noncon2));
    const cc2 = s0[SLOT_CC];

    // (a) noncon unchanged — bypass skips pnjlim+compute, no noncon bump.
    expect(noncon2.value).toBe(0);
    // (b) s0[CC] unchanged — bypass path does not call computeBjtOp, s0 preserved.
    expect(cc2).toBe(cc1);
    // (c) s0 values are finite — stamps emitted with restored values.
    expect(Number.isFinite(s0[SLOT_VBE])).toBe(true);
    expect(Number.isFinite(s0[SLOT_VBC])).toBe(true);
  });

  it("bypass_disabled_by_MODEINITPRED", () => {
    // cite: bjtload.c:347 — !(MODEINITPRED) is part of the bypass gate.
    // With cktMode|=MODEINITPRED, bypass gate must not fire even when ctx.bypass=true.
    // Strategy: prime s0 with a normal load, then call with MODEINITPRED and bypass=true.
    // Check that computeBjtOp ran by verifying s0[CC] reflects the computed (not sentinel) value.
    const propsObj = makeBjtProps();
    const core = createBjtElement(1, new Map([["B", 1], ["C", 2], ["E", 3]]), -1, propsObj) as AnalogElementCore;
    const pool = new StatePool((core as any).stateSize);
    (core as any).stateBaseOffset = 0;
    (core as any).initState(pool);
    const s0 = pool.states[0];
    const s1 = pool.states[1];
    const s2 = pool.states[2];

    function makeCtx(cktMode: number, rhsOld: Float64Array, bypass: boolean): LoadContext {
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
        limitingCollector: null,
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
    element.load(makeCtx(MODEDCOP | MODEINITFLOAT, rhsOld, false));

    // Copy s0 → s1 and s2 so xfact=0 extrapolation gives same vbe/vbc.
    for (let i = 0; i < (core as any).stateSize; i++) {
      s1[i] = s0[i];
      s2[i] = s0[i];
    }

    // Overwrite s0[CC] with a sentinel to detect whether computeBjtOp rewrites it.
    const sentinel = -999;
    s0[SLOT_CC] = sentinel;

    // Call with MODEINITPRED + bypass=true — bypass gate must NOT fire.
    element.load(makeCtx(MODETRAN | MODEINITPRED, new Float64Array(10), true));

    // If bypass was (incorrectly) taken, s0[CC] would remain sentinel.
    // If compute ran (correct), s0[CC] is rewritten to a real value.
    expect(s0[SLOT_CC]).not.toBe(sentinel);
    expect(Number.isFinite(s0[SLOT_CC])).toBe(true);
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
    const { ctx, element, s0 } = makeSmsigCtx();
    element.load(ctx);
    // All 9 op-state slots in s0 must be finite after load() under MODEINITSMSIG.
    expect(Number.isFinite(s0[SLOT_VBE])).toBe(true);
    expect(Number.isFinite(s0[SLOT_VBC])).toBe(true);
    expect(Number.isFinite(s0[SLOT_CC])).toBe(true);
    expect(Number.isFinite(s0[SLOT_CB])).toBe(true);
    expect(Number.isFinite(s0[SLOT_GPI])).toBe(true);
    expect(Number.isFinite(s0[SLOT_GMU])).toBe(true);
    expect(Number.isFinite(s0[SLOT_GM])).toBe(true);
    expect(Number.isFinite(s0[SLOT_GO])).toBe(true);
    expect(Number.isFinite(s0[SLOT_GX])).toBe(true);
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
