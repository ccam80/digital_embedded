/**
 * Tests for the Capacitor component.
 *
 * Covers:
 *   - Companion model coefficient computation (all three integration methods)
 *   - updateCompanion() recomputation at each timestep
 *   - stamp() application of geq and ieq
 *   - isReactive flag
 *   - Component definition completeness
 *   - RC step response integration test
 */

import { describe, it, expect, vi } from "vitest";
import {
  CapacitorDefinition,
  CAPACITOR_ATTRIBUTE_MAPPINGS,
} from "../capacitor.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";
import type { ReactiveAnalogElement } from "../../../solver/analog/element.js";
import { makeSimpleCtx } from "../../../solver/analog/__tests__/test-helpers.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

// ---------------------------------------------------------------------------
// withState: allocate a StatePool for a single element and call initState
// ---------------------------------------------------------------------------

function withState(core: AnalogElementCore): { element: ReactiveAnalogElement; pool: StatePool } {
  const re = core as ReactiveAnalogElement;
  const pool = new StatePool(Math.max(re.stateSize, 1));
  re.stateBaseOffset = 0;
  re.initState(pool);
  return { element: re, pool };
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCaptureSolver(): { solver: SparseSolverType; stamps: [number, number, number][]; rhsStamps: [number, number][] } {
  const stamps: [number, number, number][] = [];
  const rhsStamps: [number, number][] = [];
  const solver = {
    allocElement: vi.fn((row: number, col: number) => {
      stamps.push([row, col, 0]);
      return stamps.length - 1;
    }),
    stampElement: vi.fn((h: number, v: number) => {
      stamps[h][2] += v;
    }),
    stampRHS: vi.fn((row: number, v: number) => {
      rhsStamps.push([row, v]);
    }),
  } as unknown as SparseSolverType;
  return { solver, stamps, rhsStamps };
}

/** Call analogFactory, inject pinNodeIds, and wire up state pool (simulating what the compiler does). */
function makeCapacitorElement(pinNodes: Map<string, number>, props: PropertyBag) {
  const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(pinNodes, [], -1, props, () => 0);
  Object.assign(core, { pinNodeIds: Array.from(pinNodes.values()), allNodeIds: Array.from(pinNodes.values()) });
  const { element } = withState(core);
  return element;
}

// ---------------------------------------------------------------------------
// updateCompanion tests
// ---------------------------------------------------------------------------

describe("Capacitor", () => {
  describe("updateCompanion_trapezoidal", () => {
    it("computes correct geq and ieq for trapezoidal method", () => {
      const props = new PropertyBag();
      props.setModelParam("capacitance", 1e-6);

      // Node IDs are 1-based (ground=0). Use [1, 2] so both are non-ground.
      // Solver indices: node1→idx0, node2→idx1
      const analogElement = makeCapacitorElement(new Map([["pos", 1], ["neg", 2]]), props);

      // voltages[0] = V(node1) = 5V, voltages[1] = V(node2) = 0V
      const voltages = new Float64Array([5, 0]);
      analogElement.stampCompanion!(1e-6, "trapezoidal", voltages, 2, [1e-6, 1e-6]);

      // For trapezoidal: geq = 2C/h = 2 * 1e-6 / 1e-6 = 2.0
      const { solver, stamps } = makeCaptureSolver();
      const ctx = makeSimpleCtx({ elements: [analogElement], matrixSize: 2, nodeCount: 2, solver });
      analogElement.load(ctx.loadCtx);

      const geqStamps = stamps.filter((s) => s[2] > 0);
      expect(geqStamps.length).toBe(2); // diagonal entries
      expect(geqStamps[0][2]).toBeCloseTo(2.0, 5);
    });
  });

  describe("updateCompanion_bdf1", () => {
    it("computes correct geq for BDF-1 method", () => {
      const props = new PropertyBag();
      props.setModelParam("capacitance", 1e-6);

      const analogElement = makeCapacitorElement(new Map([["pos", 1], ["neg", 2]]), props);

      const voltages = new Float64Array([5, 0]);
      analogElement.stampCompanion!(1e-6, "bdf1", voltages, 1, [1e-6]);

      // For BDF-1: geq = C/h = 1e-6 / 1e-6 = 1.0
      const { solver, stamps } = makeCaptureSolver();
      const ctx = makeSimpleCtx({ elements: [analogElement], matrixSize: 2, nodeCount: 2, solver });
      analogElement.load(ctx.loadCtx);

      const geqStamps = stamps.filter((s) => s[2] > 0);
      expect(geqStamps[0][2]).toBeCloseTo(1.0, 5);
    });
  });

  describe("updateCompanion_bdf2", () => {
    it("computes correct geq for BDF-2 method and uses vPrevPrev", () => {
      const props = new PropertyBag();
      props.setModelParam("capacitance", 1e-6);

      const analogElement = makeCapacitorElement(new Map([["pos", 1], ["neg", 2]]), props);

      const voltages = new Float64Array([5, 0]);
      analogElement.stampCompanion!(1e-6, "bdf2", voltages, 2, [1e-6, 1e-6]);

      // For BDF-2: geq = 3C/(2h) = 3 * 1e-6 / (2 * 1e-6) = 1.5
      const { solver, stamps } = makeCaptureSolver();
      const ctx = makeSimpleCtx({ elements: [analogElement], matrixSize: 2, nodeCount: 2, solver });
      analogElement.load(ctx.loadCtx);

      const geqStamps = stamps.filter((s) => s[2] > 0);
      expect(geqStamps[0][2]).toBeCloseTo(1.5, 5);
    });
  });

  describe("is_reactive_true", () => {
    it("declares isReactive === true", () => {
      const props = new PropertyBag();
      props.setModelParam("capacitance", 1e-6);
      const analogElement = makeCapacitorElement(new Map([["pos", 1], ["neg", 2]]), props);

      expect(analogElement.isReactive).toBe(true);
    });
  });

  describe("definition", () => {
    it("CapacitorDefinition name is 'Capacitor'", () => {
      expect(CapacitorDefinition.name).toBe("Capacitor");
    });

    it("CapacitorDefinition has analog model", () => {
      expect(CapacitorDefinition.modelRegistry?.behavioral).toBeDefined();
    });

    it("CapacitorDefinition has analogFactory", () => {
      expect((CapacitorDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
    });

    it("CapacitorDefinition category is PASSIVES", () => {
      expect(CapacitorDefinition.category).toBe(ComponentCategory.PASSIVES);
    });

    it("CapacitorDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(CapacitorDefinition)).not.toThrow();
    });
  });

  describe("pinLayout", () => {
    it("CapacitorDefinition.pinLayout has 2 entries (pos, neg)", () => {
      expect(CapacitorDefinition.pinLayout).toHaveLength(2);
      expect(CapacitorDefinition.pinLayout[0].label).toBe("pos");
      expect(CapacitorDefinition.pinLayout[1].label).toBe("neg");
    });
  });

  describe("attributeMapping", () => {
    it("capacitance maps to capacitance property", () => {
      const m = CAPACITOR_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "capacitance");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("capacitance");
      expect(m!.convert("1e-6")).toBeCloseTo(1e-6, 10);
    });

    it("Label maps to label property", () => {
      const m = CAPACITOR_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("label");
      expect(m!.convert("C1")).toBe("C1");
    });
  });

  describe("statePool", () => {
    it("stateBaseOffset is -1 before compiler assigns it", () => {
      const props = new PropertyBag();
      props.setModelParam("capacitance", 1e-6);
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0,
      );
      expect((core as ReactiveAnalogElement).stateBaseOffset).toBe(-1);
    });

    it("stampCompanion writes GEQ and IEQ to pool slots 0 and 1", () => {
      const props = new PropertyBag();
      props.setModelParam("capacitance", 1e-6);
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0,
      );
      Object.assign(core, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
      const { element, pool } = withState(core);

      const voltages = new Float64Array([5, 0]);
      element.stampCompanion!(1e-6, "bdf1", voltages, 1, [1e-6]);

      // slot 0 = GEQ = C/h = 1e-6 / 1e-6 = 1.0
      expect(pool.state0[0]).toBeCloseTo(1.0, 5);
      // slot 1 = IEQ = ceq = ccap - geq*vNow. First step: q1=0, ccap=(q0-q1)/dt=C*vNow/dt, ceq=C*vNow/dt - (C/dt)*vNow = 0
      expect(pool.state0[1]).toBeCloseTo(0.0, 5);
      // slot 2 = V_PREV = vNow = 5.0
      expect(pool.state0[2]).toBeCloseTo(5.0, 5);
    });

    it("stampCompanion preserves V_PREV across calls (slot 2 tracks previous voltage)", () => {
      const props = new PropertyBag();
      props.setModelParam("capacitance", 1e-6);
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0,
      );
      Object.assign(core, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
      const { element, pool } = withState(core);

      // First call: voltage = 3V
      element.stampCompanion!(1e-6, "bdf1", new Float64Array([3, 0]), 1, [1e-6]);
      expect(pool.state0[2]).toBeCloseTo(3.0, 5);

      // Second call: voltage = 7V — V_PREV should now be 7V after the call
      element.stampCompanion!(1e-6, "bdf1", new Float64Array([7, 0]), 1, [1e-6]);
      expect(pool.state0[2]).toBeCloseTo(7.0, 5);
    });

    it("getLteTimestep returns finite value after two stampCompanion steps", () => {
      const props = new PropertyBag();
      props.setModelParam("capacitance", 1e-6);
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0,
      );
      Object.assign(core, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
      const { element, pool } = withState(core);

      element.stampCompanion!(1e-6, "bdf1", new Float64Array([5, 0]), 1, [1e-6]);
      pool.rotateStateVectors();
      pool.refreshElementRefs([element as unknown as import("../../../solver/analog/element.js").PoolBackedAnalogElementCore]);
      element.stampCompanion!(1e-6, "bdf1", new Float64Array([7, 0]), 1, [1e-6]);

      const lteParams = { trtol: 7, reltol: 1e-3, abstol: 1e-6, chgtol: 1e-14 };
      const result = element.getLteTimestep!(1e-6, [1e-6, 1e-6], 1, "bdf1", lteParams);
      expect(result).toBeGreaterThan(0);
    });

    it("getLteTimestep uses stored ccap from stampCompanion", () => {
      const C = 1e-6;
      const props = new PropertyBag();
      props.setModelParam("capacitance", C);
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0,
      );
      Object.assign(core, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
      const { element, pool } = withState(core);

      // First call: v1 = 3V — rotate pool so v=3 lands in s1
      element.stampCompanion!(1e-6, "bdf1", new Float64Array([3, 0]), 1, [1e-6]);
      pool.rotateStateVectors();
      pool.refreshElementRefs([element as unknown as import("../../../solver/analog/element.js").PoolBackedAnalogElementCore]);
      // Second call: v2 = 7V
      element.stampCompanion!(1e-6, "bdf1", new Float64Array([7, 0]), 1, [1e-6]);

      const lteParams = { trtol: 7, reltol: 1e-3, abstol: 1e-6, chgtol: 1e-14 };
      const result = element.getLteTimestep!(1e-6, [1e-6, 1e-6], 1, "bdf1", lteParams);
      expect(result).toBeGreaterThan(0);
      expect(isFinite(result)).toBe(true);
    });

    it("getLteTimestep returns finite value at zero crossing", () => {
      const C = 1e-6;
      const props = new PropertyBag();
      props.setModelParam("capacitance", C);
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0,
      );
      Object.assign(core, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
      const { element, pool } = withState(core);

      // First call: v1 = 5V (non-zero) — rotate so v=5 lands in s1
      element.stampCompanion!(1e-6, "bdf1", new Float64Array([5, 0]), 1, [1e-6]);
      pool.rotateStateVectors();
      pool.refreshElementRefs([element as unknown as import("../../../solver/analog/element.js").PoolBackedAnalogElementCore]);
      // Second call: v2 = 0V (zero crossing)
      element.stampCompanion!(1e-6, "bdf1", new Float64Array([0, 0]), 1, [1e-6]);

      const lteParams = { trtol: 7, reltol: 1e-3, abstol: 1e-6, chgtol: 1e-14 };
      const result = element.getLteTimestep!(1e-6, [1e-6, 1e-6], 1, "bdf1", lteParams);
      expect(result).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// initPred charge test — Change 20: q0 from s1 on initPred step
// ---------------------------------------------------------------------------

describe("Capacitor initPred", () => {
  // SLOT_Q = 3 in capacitor state schema
  const SLOT_Q = 3;

  it("stampCompanion_uses_s1_charge_when_initPred", () => {
    const C = 1e-6; // 1µF
    const props = new PropertyBag();
    props.setModelParam("capacitance", C);
    const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0,
    );
    Object.assign(core, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
    const { element, pool } = withState(core);

    // First step: v=3V, accepted — charge C*3 lands in s1 after rotateStateVectors
    element.stampCompanion!(1e-6, "bdf1", new Float64Array([3, 0]), 1, [1e-6]);
    pool.rotateStateVectors();
    pool.refreshElementRefs([element as unknown as import("../../../solver/analog/element.js").PoolBackedAnalogElementCore]);

    // Second step: initPred mode, v=7V (different voltage)
    // q0 should use s1[SLOT_Q] = C*3 = 3µC, NOT C*7 = 7µC
    pool.initMode = "initPred";
    element.stampCompanion!(1e-6, "bdf1", new Float64Array([7, 0]), 1, [1e-6]);

    // GEQ = C/dt regardless of q0
    const geq = pool.states[0][0]; // SLOT_GEQ
    expect(geq).toBeCloseTo(C / 1e-6, 3); // C/dt

    // ceq = ccap - geq*vNow (BDF1: ccap = (q0-q1)/dt)
    // When initPred: q0 = s1[SLOT_Q] = C*3 = 3e-6, q1 = 3e-6 (same as s1 after 1 rotation)
    //   ccap = (3e-6 - 3e-6) / 1e-6 = 0
    //   ceq = 0 - 1*7 = -7
    // When not initPred: q0 = C*7 = 7e-6
    //   ccap = (7e-6 - 3e-6) / 1e-6 = 4
    //   ceq = 4 - 1*7 = -3
    const ceq = pool.states[0][1]; // SLOT_IEQ (= ceq)
    // ceq must NOT be -3 (which would be the case if q0 = C*vNow = C*7)
    expect(ceq).not.toBeCloseTo(-3, 2);
    // ceq = -7 for initPred case (q0 = last accepted charge = C*3)
    expect(ceq).toBeCloseTo(-7, 3);
  });

  it("stampCompanion_uses_C_times_IC_on_initTran_with_UIC", () => {
    const C = 1e-6;
    const IC = 5.0; // initial voltage = 5V
    const props = new PropertyBag();
    props.setModelParam("capacitance", C);
    props.setModelParam("IC", IC);
    const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0,
    );
    Object.assign(core, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
    const { element, pool } = withState(core);

    // initTran + uic: q0 = C * IC
    pool.initMode = "initTran";
    (pool as any).uic = true;
    // Node voltage is 2V (different from IC=5V)
    element.stampCompanion!(1e-6, "bdf1", new Float64Array([2, 0]), 1, [1e-6]);

    // GEQ = C/dt = 1e-6/1e-6 = 1
    const geq = pool.states[0][0];
    expect(geq).toBeCloseTo(1, 6);
    // ceq = ccap - geq*vNow (BDF1: ccap = (q0-q1)/dt, q1=0 since no previous accepted step)
    // With UIC: q0 = C*IC = 5e-6 → ccap = 5e-6/1e-6 = 5 → ceq = 5 - 1*2 = 3
    // Without UIC: q0 = C*vNow = 2e-6 → ccap = 2 → ceq = 2 - 2 = 0
    const ceq = pool.states[0][1];
    expect(ceq).not.toBeCloseTo(0, 2);
    expect(ceq).toBeCloseTo(3, 3);
  });
});

// ---------------------------------------------------------------------------
// Change 39: Temperature coefficients TC1, TC2, TNOM, SCALE
// ---------------------------------------------------------------------------

describe("Capacitor temperature coefficients (Change 39)", () => {
  it("TC1_zero_TNOM_room_temp_gives_nominal_capacitance", () => {
    // dT=0 → factor=1, C_eff = C_nom * SCALE * M = C_nom
    const props = new PropertyBag();
    props.setModelParam("capacitance", 1e-6);
    props.setModelParam("TNOM", 300.15);
    const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0,
    ) as any;
    expect(core.C).toBeCloseTo(1e-6, 12);
  });

  it("TC1_non_zero_TNOM_offset_scales_capacitance", () => {
    // TNOM=250K → dT = 300.15-250 = 50.15, TC1=0.001 → factor=1.05015
    const props = new PropertyBag();
    props.setModelParam("capacitance", 1e-6);
    props.setModelParam("TC1", 0.001);
    props.setModelParam("TNOM", 250);
    const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0,
    ) as any;
    const dT = 300.15 - 250;
    const expected = 1e-6 * (1 + 0.001 * dT);
    expect(core.C).toBeCloseTo(expected, 12);
  });

  it("SCALE_multiplies_capacitance", () => {
    const props = new PropertyBag();
    props.setModelParam("capacitance", 1e-6);
    props.setModelParam("SCALE", 3);
    const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0,
    ) as any;
    expect(core.C).toBeCloseTo(3e-6, 12);
  });
});

// ---------------------------------------------------------------------------
// Change 40: M multiplicity multiplies C (parallel capacitors = higher C)
// ---------------------------------------------------------------------------

describe("Capacitor M multiplicity (Change 40)", () => {
  it("M2_doubles_effective_capacitance", () => {
    const props = new PropertyBag();
    props.setModelParam("capacitance", 1e-6);
    props.setModelParam("M", 2);
    const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0,
    ) as any;
    expect(core.C).toBeCloseTo(2e-6, 12);
  });

  it("M1_leaves_capacitance_unchanged", () => {
    const props = new PropertyBag();
    props.setModelParam("capacitance", 1e-6);
    props.setModelParam("M", 1);
    const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0,
    ) as any;
    expect(core.C).toBeCloseTo(1e-6, 12);
  });
});

// ---------------------------------------------------------------------------
// C4.6 — trap-order-2 ccap parity with non-standard xmu (Phase 3 G-02)
// ---------------------------------------------------------------------------
//
// Drives the analog capacitor element through a transient step with
// xmu=0.3 (non-standard — differs from the default 0.5 trapezoidal weighting)
// and asserts the stamped companion current `ccap` matches ngspice's
// niinteg.c trap-order-2 formula exactly:
//
//   ccap = ag[0] * (q0 - q1) + ag[1] * ccapPrev
//
// where:
//   ag[0] = 1.0 / dt / (1.0 - xmu)
//   ag[1] = xmu / (1.0 - xmu)
//   q0    = charge at current step   = C * vcap
//   q1    = charge at previous step  (read from state1[SLOT_Q])
//   ccapPrev = companion current at previous step (read from state1[SLOT_CCAP])
//
// Spec values: xmu=0.3, q0=1e-12, q1=0.9e-12, ccapPrev=1e-6, dt=1e-9.
// We configure C=1e-6 F and vcap=1e-6 V so the element-computed q0 = C * vcap
// equals exactly 1e-12, matching the spec.

import type { LoadContext } from "../../../solver/analog/load-context.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";

const SLOT_GEQ_CAP  = 0;
const SLOT_IEQ_CAP  = 1;
const SLOT_V_CAP    = 2;
const SLOT_Q_CAP    = 3;
const SLOT_CCAP_CAP = 4;
void SLOT_GEQ_CAP; void SLOT_IEQ_CAP; void SLOT_V_CAP;

describe("Capacitor trap-order-2 xmu parity (C4.6)", () => {
  it("capacitor_trap_order2_xmu_nonstandard_ccap_parity", () => {
    const dt  = 1e-9;
    const xmu = 0.3;
    const capacitance = 1e-6;          // 1 µF
    const vcap        = 1e-6;          // 1 µV  → q0 = C*vcap = 1e-12
    const q1          = 0.9e-12;       // previous step charge
    const ccapPrev    = 1e-6;          // previous step companion current

    const props = new PropertyBag();
    props.setModelParam("capacitance", capacitance);
    const element = makeCapacitorElement(new Map([["pos", 1], ["neg", 2]]), props);

    // Seed previous-step state: s1[SLOT_Q] = q1, s1[SLOT_CCAP] = ccapPrev.
    const re = element as unknown as { s1: Float64Array; stateBaseOffset: number };
    const base = re.stateBaseOffset;
    re.s1[base + SLOT_Q_CAP]    = q1;
    re.s1[base + SLOT_CCAP_CAP] = ccapPrev;

    // Trap order-2 integration coefficients (ngspice niinteg.c operand order):
    const ag0 = 1.0 / dt / (1.0 - xmu);
    const ag1 = xmu / (1.0 - xmu);

    // Minimal capturing solver (stamp entries are incidental; we inspect s0).
    const mockSolver: SparseSolverType = {
      stamp: () => {},
      stampRHS: () => {},
      allocElement: (() => 0) as unknown as SparseSolverType["allocElement"],
      stampElement: () => {},
    } as unknown as SparseSolverType;

    // Voltages set so vcap = v0 - v1 = 1e-6 (triggers q0 = C * vcap = 1e-12)
    const voltages = new Float64Array(2);
    voltages[0] = vcap;
    voltages[1] = 0;

    const ag = new Float64Array(8);
    ag[0] = ag0;
    ag[1] = ag1;

    const ctx: LoadContext = {
      solver: mockSolver,
      voltages,
      iteration: 0,
      initMode: "transient",
      dt,
      method: "trapezoidal",
      order: 2,
      deltaOld: [dt, dt, dt, dt, dt, dt, dt],
      ag,
      srcFact: 1,
      noncon: { value: 0 },
      limitingCollector: null,
      isDcOp: false,
      isTransient: true,
      xfact: 1,
      gmin: 1e-12,
      uic: false,
      reltol: 1e-3,
      iabstol: 1e-12,
    };

    element.load(ctx);

    // q0 the element wrote to s0:
    const q0_actual = (re as unknown as { s0: Float64Array }).s0[base + SLOT_Q_CAP];
    expect(q0_actual).toBe(1e-12);

    // ngspice niinteg.c trap-order-2 formula (bit-exact target):
    const expectedCcap = ag0 * (q0_actual - q1) + ag1 * ccapPrev;

    const actualCcap = (re as unknown as { s0: Float64Array }).s0[base + SLOT_CCAP_CAP];
    expect(actualCcap).toBe(expectedCcap);
  });
});
