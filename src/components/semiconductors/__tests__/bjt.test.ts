/**
 * BJT component tests — post-W1.2 port.
 *
 * Test handling per `spec/architectural-alignment.md` §A1 and
 * `spec/phase-2.5-execution.md` §4: all assertions whose expected values were
 * hand-computed from the Gummel-Poon equations or inspected
 * `_updateOp`/`_stampCompanion` intermediate state have been deleted. Only
 * parameter-plumbing tests (setParam propagation, default values),
 * engine-agnostic interface contracts (isNonlinear, pinNodeIds, modelRegistry
 * wiring), and LimitingEvent instrumentation remain.
 *
 * Tests for matrix stamp contents, Norton currents, or pool state slot values
 * whose expected numbers came from hand-computing Gummel-Poon have been
 * deleted — per A1, those encode hand-computed divergence baselines. When
 * the ngspice-comparison harness is re-run in Wave 3, any genuine numerical
 * failures surface there with ngspice-authored expected values.
 */

import { describe, it, expect } from "vitest";
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
import { MODEDCOP, MODEINITFLOAT } from "../../../solver/analog/ckt-mode.js";
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
// initial warm-start voltage). Does NOT inspect slot-value relationships that
// were generated by _updateOp/_stampCompanion; those inspections are deleted.
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
    expect(pool.state0[0]).toBeCloseTo(0.6, 10);
  });

  it("warmstart_PNP_VBE_seeded_to_minus_0_6", () => {
    const core = createBjtElement(-1, new Map([["B", 2], ["C", 1], ["E", 3]]), -1, makeBjtProps());
    const pool = new StatePool(core.stateSize);
    core.stateBaseOffset = 0;
    core.initState!(pool);
    expect(pool.state0[0]).toBeCloseTo(-0.6, 10);
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
    expect(pool.state0[0]).toBeCloseTo(0.6, 10);
  });

  it("warmstart_PNP_VBE_seeded_to_minus_0_6", () => {
    const core = createSpiceL1BjtElement(-1, new Map([["B", 2], ["C", 1], ["E", 3]]), [], -1, makeSpiceL1Props());
    const pool = new StatePool(core.stateSize);
    core.stateBaseOffset = 0;
    core.initState!(pool);
    expect(pool.state0[0]).toBeCloseTo(-0.6, 10);
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
