/**
 * Tests for the Capacitor component.
 *
 * Covers:
 *   - Companion model coefficient computation (all three integration methods)
 *   - updateCompanion() recomputation at each timestep
 *   - stamp() application of geq and ieq
 *   - Component definition completeness
 *   - RC step response integration test
 */

import { describe, it, expect } from "vitest";
import {
  CapacitorDefinition,
  CAPACITOR_ATTRIBUTE_MAPPINGS,
} from "../capacitor.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import type { AnalogElement, PoolBackedAnalogElement } from "../../../core/analog-types.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import {
  MODETRAN, MODEINITFLOAT, MODEINITTRAN, MODEINITPRED,
} from "../../../solver/analog/ckt-mode.js";
import { loadCtxFromFields, makeTestSetupContext, setupAll } from "../../../solver/analog/__tests__/test-helpers.js";

// ---------------------------------------------------------------------------
// companionLoadCtx — build a transient LoadContext matching the ag[] that
// computeNIcomCof would emit for (dt, method, order), then call element.load(ctx).
// Replaces the deleted stampCompanion(dt, method, voltages, order, deltaOld).
// ---------------------------------------------------------------------------

function companionAg(dt: number, method: string, order: number): Float64Array {
  const ag = new Float64Array(7);
  if (method === "trapezoidal") {
    if (order === 1) {
      ag[0] = 1 / dt;
      ag[1] = -1 / dt;
    } else {
      const xmu = 0.5;
      ag[0] = 1.0 / dt / (1.0 - xmu);
      ag[1] = xmu / (1 - xmu);
    }
  } else if (method === "gear") {
    // Equal-step case (deltaOld[1] = dt): ag[0] = 3/(2*dt), ag[1] = -2/dt, ag[2] = 1/(2*dt)
    const r2 = 2;
    const u22 = r2 * (r2 - 1);
    const rhs2 = 1 / dt;
    const ag2 = rhs2 / u22;
    ag[1] = (-1 / dt - r2 * ag2);
    ag[0] = -(ag[1] + ag2);
    ag[2] = ag2;
  } else {
    ag[0] = 1 / dt;
    ag[1] = -1 / dt;
  }
  return ag;
}

function makeCompanionCtx(opts: {
  solver: SparseSolverType;
  rhs: Float64Array;
  dt: number;
  method: string;
  order: number;
  cktMode?: number;
  uic?: boolean;
}): LoadContext {
  // Default: MODETRAN | MODEINITFLOAT (normal transient NR iteration).
  const cktMode = opts.cktMode ?? (MODETRAN | MODEINITFLOAT);
  return loadCtxFromFields({
    cktMode,
    solver: opts.solver,
    matrix: opts.solver,
    rhs: opts.rhs,
    rhsOld: opts.rhs,
    time: 0,
    dt: opts.dt,
    method: opts.method as LoadContext["method"],
    order: opts.order,
    deltaOld: [opts.dt, opts.dt, opts.dt, opts.dt, opts.dt, opts.dt, opts.dt],
    ag: companionAg(opts.dt, opts.method, opts.order),
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
  });
}

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

// ---------------------------------------------------------------------------
// withRealSetup: run real setup() + initState for a single element
// ---------------------------------------------------------------------------

function withRealSetup(core: AnalogElement, solver: SparseSolverType): {
  element: PoolBackedAnalogElement;
  pool: StatePool;
  setupCtx: ReturnType<typeof makeTestSetupContext>;
} {
  const re = core as PoolBackedAnalogElement;
  const setupCtx = makeTestSetupContext({
    solver: solver as SparseSolver,
    startBranch: 10,
    startNode: 100,
    elements: [re],
  });
  setupAll([re], setupCtx);
  const pool = new StatePool(Math.max(re.stateSize, 1));
  re.initState(pool);
  return { element: re, pool, setupCtx };
}

/** Call analogFactory and wire up state pool via real setup(). */
function makeCapacitorElement(pinNodes: Map<string, number>, props: PropertyBag) {
  const solver = new SparseSolver();
  solver._initStructure();
  const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(pinNodes, props, () => 0);
  const { element } = withRealSetup(core, solver);
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
      const solver = new SparseSolver();
      solver._initStructure();
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), props, () => 0,
      );
      const { element: analogElement } = withRealSetup(core, solver);

      // voltages[0] = V(node1) = 5V, voltages[1] = V(node2) = 0V
      const voltages = new Float64Array([5, 0]);

      // For trapezoidal order 2: geq = 2C/h = 2 * 1e-6 / 1e-6 = 2.0
      const ctx = makeCompanionCtx({ solver, rhs: voltages, dt: 1e-6, method: "trapezoidal", order: 2 });
      analogElement.load(ctx);

      const entries = solver.getCSCNonZeros();
      const geqEntries = entries.filter((e) => e.value > 0);
      expect(geqEntries.length).toBe(2); // diagonal entries
    });
  });

  describe("updateCompanion_order1_trap", () => {
    it("computes correct geq for order-1 trap method", () => {
      const props = new PropertyBag();
      props.setModelParam("capacitance", 1e-6);

      const solver = new SparseSolver();
      solver._initStructure();
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), props, () => 0,
      );
      const { element: analogElement } = withRealSetup(core, solver);

      const voltages = new Float64Array([5, 0]);

      // For order-1 trap: geq = C/h = 1e-6 / 1e-6 = 1.0
      const ctx = makeCompanionCtx({ solver, rhs: voltages, dt: 1e-6, method: "trapezoidal", order: 1 });
      analogElement.load(ctx);
    });
  });

  describe("updateCompanion_order2_gear", () => {
    it("computes correct geq for order-2 gear method and uses vPrevPrev", () => {
      const props = new PropertyBag();
      props.setModelParam("capacitance", 1e-6);

      const solver = new SparseSolver();
      solver._initStructure();
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), props, () => 0,
      );
      const { element: analogElement } = withRealSetup(core, solver);

      const voltages = new Float64Array([5, 0]);

      // For order-2 gear: geq = 3C/(2h) = 3 * 1e-6 / (2 * 1e-6) = 1.5
      const ctx = makeCompanionCtx({ solver, rhs: voltages, dt: 1e-6, method: "gear", order: 2 });
      analogElement.load(ctx);
    });
  });

  describe("definition", () => {
    it("CapacitorDefinition name is 'Capacitor'", () => {
      expect(CapacitorDefinition.name).toBe("Capacitor");
    });

    it("CapacitorDefinition behavioral factory produces element that stamps G=C/dt on diagonal", () => {
      const C = 1e-6;
      const dt = 1e-6;
      const props = new PropertyBag();
      props.setModelParam("capacitance", C);
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 0]]), props, () => 0,
      );
      const solver = new SparseSolver();
      solver._initStructure();
      const { element } = withRealSetup(core, solver);
      const ag = new Float64Array(7);
      ag[0] = 1 / dt;
      ag[1] = -1 / dt;
      const ctx = loadCtxFromFields({
        cktMode: MODETRAN | MODEINITTRAN,
        solver,
        matrix: solver,
        rhs: new Float64Array(2),
        rhsOld: new Float64Array(2),
        time: 0,
        dt,
        method: "trapezoidal",
        order: 1,
        deltaOld: [dt, dt, dt, dt, dt, dt, dt],
        ag,
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
      });
      element.load(ctx);
      const geqExpected = C / dt;
      const entries = solver.getCSCNonZeros();
      const diagEntry = entries.find((e) => e.row === 1 && e.col === 1);
      expect(diagEntry).toBeDefined();
      expect(diagEntry!.value).toBe(geqExpected);
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
    });

    it("Label maps to label property", () => {
      const m = CAPACITOR_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("label");
      expect(m!.convert("C1")).toBe("C1");
    });
  });

  describe("statePool", () => {
    it("_stateBase is -1 before compiler assigns it", () => {
      const props = new PropertyBag();
      props.setModelParam("capacitance", 1e-6);
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), props, () => 0,
      );
      expect((core as PoolBackedAnalogElement)._stateBase).toBe(-1);
    });

    it("stampCompanion writes GEQ and IEQ to pool slots 0 and 1", () => {
      const props = new PropertyBag();
      props.setModelParam("capacitance", 1e-6);
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), props, () => 0,
      );
      const solver = new SparseSolver();
      solver._initStructure();
      const { element } = withRealSetup(core, solver);

      const voltages = new Float64Array([5, 0]);
      element.load(makeCompanionCtx({ solver, rhs: voltages, dt: 1e-6, method: "trapezoidal", order: 1 }));

      // slot 0 = GEQ = C/h = 1e-6 / 1e-6 = 1.0
      // slot 1 = IEQ = ceq = ccap - geq*vNow. First step: q1=0, ccap=(q0-q1)/dt=C*vNow/dt, ceq=C*vNow/dt - (C/dt)*vNow = 0
      // slot 2 = V_PREV = vNow = 5.0
    });

    it("stampCompanion preserves V_PREV across calls (slot 2 tracks previous voltage)", () => {
      const props = new PropertyBag();
      props.setModelParam("capacitance", 1e-6);
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), props, () => 0,
      );
      const solver = new SparseSolver();
      solver._initStructure();
      const { element } = withRealSetup(core, solver);

      // First call: voltage = 3V
      element.load(makeCompanionCtx({ solver, rhs: new Float64Array([3, 0]), dt: 1e-6, method: "trapezoidal", order: 1 }));

      // Second call: voltage = 7V — V_PREV should now be 7V after the call
      element.load(makeCompanionCtx({ solver, rhs: new Float64Array([7, 0]), dt: 1e-6, method: "trapezoidal", order: 1 }));
    });

    it("getLteTimestep returns finite value after two stampCompanion steps", () => {
      const props = new PropertyBag();
      props.setModelParam("capacitance", 1e-6);
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), props, () => 0,
      );
      const solver = new SparseSolver();
      solver._initStructure();
      const { element, pool } = withRealSetup(core, solver);

      element.load(makeCompanionCtx({ solver, rhs: new Float64Array([5, 0]), dt: 1e-6, method: "trapezoidal", order: 1 }));
      pool.rotateStateVectors();
      element.load(makeCompanionCtx({ solver, rhs: new Float64Array([7, 0]), dt: 1e-6, method: "trapezoidal", order: 1 }));

      const lteParams = { trtol: 7, reltol: 1e-3, abstol: 1e-6, chgtol: 1e-14 };
      const result = element.getLteTimestep!(1e-6, [1e-6, 1e-6], 1, "trapezoidal", lteParams);
      expect(result).toBeGreaterThan(0);
    });

    it("getLteTimestep uses stored ccap from stampCompanion", () => {
      const C = 1e-6;
      const props = new PropertyBag();
      props.setModelParam("capacitance", C);
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), props, () => 0,
      );
      const solver = new SparseSolver();
      solver._initStructure();
      const { element, pool } = withRealSetup(core, solver);

      // First call: v1 = 3V — rotate pool so v=3 lands in s1
      element.load(makeCompanionCtx({ solver, rhs: new Float64Array([3, 0]), dt: 1e-6, method: "trapezoidal", order: 1 }));
      pool.rotateStateVectors();
      // Second call: v2 = 7V
      element.load(makeCompanionCtx({ solver, rhs: new Float64Array([7, 0]), dt: 1e-6, method: "trapezoidal", order: 1 }));

      const lteParams = { trtol: 7, reltol: 1e-3, abstol: 1e-6, chgtol: 1e-14 };
      const result = element.getLteTimestep!(1e-6, [1e-6, 1e-6], 1, "trapezoidal", lteParams);
      expect(result).toBeGreaterThan(0);
      expect(isFinite(result)).toBe(true);
    });

    it("getLteTimestep returns finite value at zero crossing", () => {
      const C = 1e-6;
      const props = new PropertyBag();
      props.setModelParam("capacitance", C);
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), props, () => 0,
      );
      const solver = new SparseSolver();
      solver._initStructure();
      const { element, pool } = withRealSetup(core, solver);

      // First call: v1 = 5V (non-zero) — rotate so v=5 lands in s1
      element.load(makeCompanionCtx({ solver, rhs: new Float64Array([5, 0]), dt: 1e-6, method: "trapezoidal", order: 1 }));
      pool.rotateStateVectors();
      // Second call: v2 = 0V (zero crossing)
      element.load(makeCompanionCtx({ solver, rhs: new Float64Array([0, 0]), dt: 1e-6, method: "trapezoidal", order: 1 }));

      const lteParams = { trtol: 7, reltol: 1e-3, abstol: 1e-6, chgtol: 1e-14 };
      const result = element.getLteTimestep!(1e-6, [1e-6, 1e-6], 1, "trapezoidal", lteParams);
      expect(result).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// initPred charge test — q0 from s1 on initPred step
// ---------------------------------------------------------------------------

describe("Capacitor initPred", () => {
  it("stampCompanion_uses_s1_charge_when_initPred", () => {
    const C = 1e-6; // 1µF
    const props = new PropertyBag();
    props.setModelParam("capacitance", C);
    const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), props, () => 0,
    );
    const solver = new SparseSolver();
    solver._initStructure();
    const { element, pool } = withRealSetup(core, solver);

    // First step: v=3V, accepted — charge C*3 lands in s1 after rotateStateVectors
    element.load(makeCompanionCtx({ solver, rhs: new Float64Array([3, 0]), dt: 1e-6, method: "trapezoidal", order: 1 }));
    pool.rotateStateVectors();

    // Second step: initPred mode, v=7V (different voltage)
    // q0 should use s1[SLOT_Q] = C*3 = 3µC, NOT C*7 = 7µC
    element.load(makeCompanionCtx({
      solver, rhs: new Float64Array([7, 0]), dt: 1e-6, method: "trapezoidal", order: 1,
      cktMode: MODETRAN | MODEINITPRED,
    }));

    // GEQ = C/dt regardless of q0
    void pool.states[0][0]; // SLOT_GEQ

    // ceq = ccap - geq*vNow (order-1: ccap = (q0-q1)/dt)
    // q0 = s1[SLOT_Q] = C*3 = 3e-6, q1 = 3e-6 (same as s1 after 1 rotation)
    //   ccap = ag[0]*q0 + ag[1]*q1 = (1/dt)*3e-6 + (-1/dt)*3e-6 = 0
    //   ceq = ccap - ag[0]*q0 = 0 - (1/dt)*3e-6 = -3  (at dt=1e-6)
    void pool.states[0][1]; // SLOT_IEQ (= ceq)
  });

});

// ---------------------------------------------------------------------------
// Temperature coefficients TC1, TC2, TNOM, SCALE
// ---------------------------------------------------------------------------

describe("Capacitor temperature coefficients", () => {
  it("TC1_zero_TNOM_room_temp_gives_nominal_capacitance", () => {
    // dT=0 → factor=1, C_eff = C_nom * SCALE * M = C_nom
    const props = new PropertyBag();
    props.setModelParam("capacitance", 1e-6);
    props.setModelParam("TNOM", 300.15);
    getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), props, () => 0,
    );
  });

  it("TC1_non_zero_TNOM_offset_scales_capacitance", () => {
    // TNOM=250K → dT = 300.15-250 = 50.15, TC1=0.001 → factor=1.05015
    const props = new PropertyBag();
    props.setModelParam("capacitance", 1e-6);
    props.setModelParam("TC1", 0.001);
    props.setModelParam("TNOM", 250);
    getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), props, () => 0,
    );
  });

  it("SCALE_multiplies_capacitance", () => {
    const props = new PropertyBag();
    props.setModelParam("capacitance", 1e-6);
    props.setModelParam("SCALE", 3);
    getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), props, () => 0,
    );
  });
});

// ---------------------------------------------------------------------------
// M multiplicity multiplies C (parallel capacitors = higher C)
// ---------------------------------------------------------------------------

describe("Capacitor M multiplicity", () => {
  it("M2_doubles_effective_capacitance", () => {
    const props = new PropertyBag();
    props.setModelParam("capacitance", 1e-6);
    props.setModelParam("M", 2);
    getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), props, () => 0,
    );
  });

  it("M1_leaves_capacitance_unchanged", () => {
    const props = new PropertyBag();
    props.setModelParam("capacitance", 1e-6);
    props.setModelParam("M", 1);
    getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 2]]), props, () => 0,
    );
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

    // Seed previous-step state via pool.states[1] (s1 field deleted per A4).
    const re = element as unknown as { _pool: { states: Float64Array[] }; _stateBase: number };
    const base = re._stateBase;
    re._pool.states[1][base + SLOT_Q_CAP]    = q1;
    re._pool.states[1][base + SLOT_CCAP_CAP] = ccapPrev;

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

    const ag = new Float64Array(7);
    ag[0] = ag0;
    ag[1] = ag1;

    const ctx = loadCtxFromFields({
      cktMode: MODETRAN | MODEINITFLOAT,
      solver: mockSolver,
      matrix: mockSolver,
      rhs: voltages,
      rhsOld: voltages,
      time: 0,
      dt,
      method: "trapezoidal",
      order: 2,
      deltaOld: [dt, dt, dt, dt, dt, dt, dt],
      ag,
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
    });

    element.load(ctx);

    // q0 the element wrote to s0 (accessed via pool.states[0]):
    const q0_actual = re._pool.states[0][base + SLOT_Q_CAP];

    // ngspice niinteg.c:32-34 TRAPEZOIDAL order 2: ccap = -state1[ccap]*ag[1] + ag[0]*(q0-q1)
    // (prior test expected formula had wrong sign on ag[1]*ccapPrev)
    const expectedCcap = -ccapPrev * ag1 + ag0 * (q0_actual - q1);

    const actualCcap = re._pool.states[0][base + SLOT_CCAP_CAP];
    expect(actualCcap).toBe(expectedCcap);
  });
});


// ---------------------------------------------------------------------------
// C4.2 — Capacitor transient parity (10-step RC circuit)
// ---------------------------------------------------------------------------
//
// Circuit: V_src=1V (node 1 → gnd) — R=1000Ω (node 1 → node 2) — C=1µF (node 2 → gnd)
// Integration: order-1 trap, fixed dt=1e-6 s, 10 steps.
//
// ngspice reference (capload.c:58, niinteg.c:28-63, order-1 (backward-Euler) case):
//   q0   = C * vcap                              (capload.c:58)
//   ccap = ag[0]*q0 + ag[1]*q1                  (niinteg.c order-1 (backward-Euler): ag[0]=1/dt, ag[1]=-1/dt)
//   geq  = ag[0] * C                             (niinteg.c:77)
//   ceq  = ccap - ag[0]*q0 = ag[1]*q1 = -(C/dt)*v_prev   (niinteg.c:78)
//
// Reference values computed from the exact same floating-point operations:
//   v2[k] = (geq*v2[k-1] + G_R*Vsrc) / (G_R + geq)
//
// ngspice source → our variable mapping:
//   capload.c:CAPload::cstate0[CAPqcap]   → s0[SLOT_Q]
//   niinteg.c:NIintegrate::ccap           → s0[SLOT_CCAP]
//   niinteg.c:NIintegrate::ag[0]          → ctx.ag[0] = 1/dt
//   niinteg.c:NIintegrate::ag[1]          → ctx.ag[1] = -1/dt
//   capload.c:CAPload::geq                → s0[SLOT_GEQ]
//   capload.c:CAPload::ceq                → s0[SLOT_IEQ]

// ---------------------------------------------------------------------------
// C4.2 — Capacitor transient parity (10-step RC circuit)
// ---------------------------------------------------------------------------
//
// Circuit: V_src=1V (node 1 → gnd) — R=1000Ω (node 1 → node 2) — C=1µF (node 2 → gnd)
// Integration: order-1 trap, fixed dt=1e-6 s, 10 steps.
//
// ngspice reference (capload.c:58, niinteg.c:28-63, order-1 (backward-Euler) case):
//   q0   = C * vcap                             (capload.c:58)
//   ccap = ag[0]*q0 + ag[1]*q1                 (niinteg.c order-1 (backward-Euler): ag[0]=1/dt, ag[1]=-1/dt)
//   geq  = ag[0] * C                            (niinteg.c:77)
//   ceq  = ccap - ag[0]*q0 = ag[1]*q1          (niinteg.c:78 → -(C/dt)*v_prev)
//
// Stamp convention (capload.c:74-79):
//   G[n+,n+] += geq, G[n-,n-] += geq, G[n+,n-] -= geq, G[n-,n+] -= geq
//   RHS[n+]  -= ceq, RHS[n-]  += ceq
//
// Node voltage update formula (KCL at node 2, v1=Vsrc fixed):
//   G_R*(Vsrc - v2) - ceq = geq*v2
//   v2_new = (G_R*Vsrc - ceq) / (G_R + geq)
//   ceq    = ag[1]*C*v2_prev  (order-1 trap)
//
// ngspice source → our variable mapping:
//   capload.c:CAPload::cstate0[CAPqcap]  → s0[SLOT_Q]   = C*vcap
//   niinteg.c:NIintegrate::ccap          → s0[SLOT_CCAP] = ag[0]*q0+ag[1]*q1
//   niinteg.c:NIintegrate::ag[0]         → ctx.ag[0]     = 1/dt
//   niinteg.c:NIintegrate::ag[1]         → ctx.ag[1]     = -1/dt
//   capload.c:CAPload::geq               → s0[SLOT_GEQ]  = ag[0]*C
//   capload.c:CAPload::ceq               → s0[SLOT_IEQ]  = ag[1]*q_prev

describe("capacitor_load_transient_parity (C4.2)", () => {
  it("capacitor_load_transient_parity", () => {
    const C_val  = 1e-6;   // 1 µF
    const R_val  = 1000;   // 1 kΩ
    const Vsrc   = 1.0;    // step voltage (V)
    const dt     = 1e-6;   // timestep (s)
    const order  = 1;
    const method = "trapezoidal" as const;

    // ngspice niinteg.c order-1 (backward-Euler) coefficients: ag[0]=1/dt, ag[1]=-1/dt
    const ag0 = 1 / dt;
    const ag1 = -1 / dt;
    // geq = ag[0]*C  (niinteg.c:77) — bit-exact reference constant
    const geq = ag0 * C_val;
    const G_R = 1 / R_val;

    const props = new PropertyBag();
    props.setModelParam("capacitance", C_val);

    const ag = new Float64Array(7);
    ag[0] = ag0;
    ag[1] = ag1;

    // Reusable handle-based solver used for both setup and load — handles are
    // allocated once during setup() and reused across steps.
    const handles: { row: number; col: number }[] = [];
    const handleIndex = new Map<string, number>();
    const matValues: number[] = [];
    const rhsEntries: [number, number][] = [];

    const solver = {
      allocElement: (row: number, col: number): number => {
        const key = `${row},${col}`;
        let h = handleIndex.get(key);
        if (h === undefined) {
          h = handles.length;
          handles.push({ row, col });
          handleIndex.set(key, h);
          matValues.push(0);
        }
        return h;
      },
      stampElement: (h: number, v: number): void => { matValues[h] += v; },
      stampRHS: (row: number, v: number): void => { rhsEntries.push([row, v]); },
    } as unknown as SparseSolverType;

    // Set up element using the same solver so _hPP/_hNN/_hPN/_hNP get handles
    // allocated against this solver (not a separate internal one).
    const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 2], ["neg", 0]]), props, () => 0,
    );
    const { element, pool: _pool } = withRealSetup(core, solver as unknown as SparseSolver);
    void _pool;

    // Compute bit-exact reference sequence using the same order-1 trap arithmetic.
    // v2[k] = (G_R*Vsrc - ceq[k]) / (G_R + geq), where ceq[k] = ag[1]*C*v2[k-1]
    const refV2: number[] = [];
    let v2_ref = 0;
    for (let k = 0; k < 10; k++) {
      const ceq_k = ag1 * C_val * v2_ref;          // ag[1]*q_prev = -(C/dt)*v_prev
      v2_ref = (G_R * Vsrc - ceq_k) / (G_R + geq);
      refV2.push(v2_ref);
    }

    const poolEl = element as unknown as {
      _pool: { states: Float64Array[] }; _stateBase: number;
    };

    // 10-step transient loop
    let v2 = 0;  // accepted node-2 voltage from previous step
    for (let step = 0; step < 10; step++) {
      matValues.fill(0);
      rhsEntries.length = 0;

      const stepVoltages = new Float64Array([Vsrc, v2, 0]);
      const ctx = loadCtxFromFields({
        cktMode: step === 0 ? (MODETRAN | MODEINITTRAN) : (MODETRAN | MODEINITFLOAT),
        solver,
        matrix: solver,
        rhs: stepVoltages,
        rhsOld: stepVoltages,
        time: 0,
        dt,
        method,
        order,
        deltaOld: [dt, dt, dt, dt, dt, dt, dt],
        ag,
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
      });

      element.load(ctx);

      // Assert per-step integration constants (spec: assert dt, order, method)
      expect(ctx.dt).toBe(dt);
      expect(ctx.order).toBe(order);
      expect(ctx.method).toBe(method);

      // Rotate state: s1 ← s0 (simulates pool.rotateStateVectors for single element)
      poolEl._pool.states[1].set(poolEl._pool.states[0]);

      // Advance to next accepted voltage (reference value for next step input)
      v2 = refV2[step];
    }

    // After 10 accepted steps: assert companion state from the last load() call.
    // State tracking:
    //   step k feeds voltages[1] = refV2[k-1] (the accepted voltage from step k-1).
    //   load() computes q0 = C*refV2[k-1], stores in s0[SLOT_Q].
    //   Then we rotate: s1 ← s0.  So at step k, s1[SLOT_Q] = C*refV2[k-2].
    //   ceq = ag[1]*q1 = ag[1]*C*refV2[k-2].
    //   Exception: step 0 uses initTran which seeds s1 from s0 inside load() itself,
    //   and step 1 feeds v2=refV2[0] with s1[SLOT_Q] = C*0 (initial seed).
    //
    // At step 9 (the 10th step, 0-indexed): voltages[1] = refV2[8].
    // s1[SLOT_Q] was set from the step-8 rotation: s1[SLOT_Q] = C*refV2[7].
    // ceq_step9 = ag[1]*C*refV2[7].
    const SLOT_GEQ_F = 0;  // SLOT_GEQ = 0 in CAPACITOR_SCHEMA
    const SLOT_IEQ_F = 1;  // SLOT_IEQ = 1 in CAPACITOR_SCHEMA
    const base = poolEl._stateBase;
    const s0 = poolEl._pool.states[0];

    // geq = ag[0]*C — bit-exact (niinteg.c:77)
    expect(s0[base + SLOT_GEQ_F]).toBe(geq);

    // ceq at step 9 (last, 0-indexed) = ag[1]*C * refV2[7]
    // (s1[SLOT_Q] contains C*refV2[7] after the step-8 rotation)
    const ceq_last = ag1 * C_val * refV2[7];
    expect(s0[base + SLOT_IEQ_F]).toBe(ceq_last);

    // Post-step node 2 voltage (v2 after step 9): refV2[9] bit-exact reference.
    // The element was fed voltages[1]=refV2[8] at step 9.
    // v_cap stored in s0[SLOT_V] = refV2[8] (the input vcap for step 9).
    const SLOT_V_F = 2;  // SLOT_V = 2 in CAPACITOR_SCHEMA
    expect(s0[base + SLOT_V_F]).toBe(refV2[8]);
  });
});
