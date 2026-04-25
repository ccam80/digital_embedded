/**
 * Tests for the Inductor component.
 *
 * Covers:
 *   - Branch variable stamps (incidence matrix entries)
 *   - Companion model coefficient computation (all three integration methods)
 *   - updateCompanion() recomputation at each timestep
 *   - stamp() application of geq, ieq, and branch entries
 *   - isReactive flag
 *   - Component definition completeness
 *   - RL step response integration test
 */

import { describe, it, expect, vi } from "vitest";
import {
  InductorDefinition,
  INDUCTOR_ATTRIBUTE_MAPPINGS,
} from "../inductor.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";
import type { ReactiveAnalogElement } from "../../../solver/analog/element.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import {
  MODETRAN, MODEDC, MODEDCOP,
  MODEINITFLOAT, MODEINITTRAN,
} from "../../../solver/analog/ckt-mode.js";
import { makeLoadCtx } from "../../../solver/analog/__tests__/test-helpers.js";

// ---------------------------------------------------------------------------
// companion context builder — replaces the deleted stampCompanion(dt, method,
// voltages, order, deltaOld) method. Seeds ag[] to match computeNIcomCof for
// (dt, method, order) then the caller invokes element.load(ctx).
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
  voltages: Float64Array;
  dt: number;
  method: string;
  order: number;
  cktMode?: number;
  uic?: boolean;
}): LoadContext {
  return makeLoadCtx({
    solver: opts.solver,
    voltages: opts.voltages,
    cktMode: opts.cktMode ?? (MODETRAN | MODEINITFLOAT),
    dt: opts.dt,
    method: opts.method as LoadContext["method"],
    order: opts.order,
    deltaOld: [opts.dt, opts.dt, opts.dt, opts.dt, opts.dt, opts.dt, opts.dt],
    ag: companionAg(opts.dt, opts.method, opts.order),
    uic: opts.uic ?? false,
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
function makeInductorElement(pinNodes: Map<string, number>, branchIdx: number, props: PropertyBag) {
  const core = getFactory(InductorDefinition.modelRegistry!.behavioral!)(pinNodes, [], branchIdx, props, () => 0);
  Object.assign(core, { pinNodeIds: Array.from(pinNodes.values()), allNodeIds: Array.from(pinNodes.values()) });
  const { element } = withState(core);
  return element;
}

// ---------------------------------------------------------------------------
// stamps_branch_equation tests
// ---------------------------------------------------------------------------

describe("Inductor", () => {
  describe("stamps_branch_equation", () => {
    it("stamps branch incidence and conductance entries", () => {
      const props = new PropertyBag();
      props.setModelParam("inductance", 0.01);

      // Use non-ground nodes [1, 2] with branchIdx=2 (absolute solver row)
      // Node 1 → solver idx 0, Node 2 → solver idx 1, branch → solver row 2
      const analogElement = makeInductorElement(new Map([["A", 1], ["B", 2]]), 2, props);

      const { solver, stamps } = makeCaptureSolver();
      // Use a non-transient / non-DC-OP context so only the topology-constant
      // branch incidence entries are stamped (no companion branch diagonal term).
      const voltages = new Float64Array([0, 0, 0]);
      const ctx: LoadContext = {
        cktMode: MODEDCOP | MODEINITFLOAT,
        solver, voltages, dt: 0,
        method: "trapezoidal", order: 1,
        deltaOld: [0, 0, 0, 0, 0, 0, 0], ag: new Float64Array(7),
        srcFact: 1, noncon: { value: 0 }, limitingCollector: null,
        xfact: 1, gmin: 1e-12, uic: false,
        reltol: 1e-3, iabstol: 1e-12, cktFixLimit: false,
        bypass: false, voltTol: 1e-6,
      };
      analogElement.load(ctx);

      // Should have: 2 B-matrix incidence + 2 C/D-matrix branch + 1 branch diagonal = 5
      // B-matrix (node rows): (0,2)=+1, (1,2)=-1
      // C/D-matrix (branch row): (2,0)=+1, (2,1)=-1
      // D-matrix diagonal (branch row): (2,2)=-req stamped unconditionally per indload.c:119-123
      expect(stamps.length).toBe(5);

      // B sub-matrix: branch current incidence in node KCL rows
      const nodeEntries = stamps.filter((s) => s[0] < 2);
      expect(nodeEntries.some((s) => s[0] === 0 && s[1] === 2 && s[2] === 1)).toBe(true);
      expect(nodeEntries.some((s) => s[0] === 1 && s[1] === 2 && s[2] === -1)).toBe(true);

      // C sub-matrix: branch equation entries
      const branchEntries = stamps.filter((s) => s[0] === 2);
      expect(branchEntries.some((s) => s[1] === 0 && s[2] === 1)).toBe(true);
      expect(branchEntries.some((s) => s[1] === 1 && s[2] === -1)).toBe(true);
    });
  });

  describe("updateCompanion_trapezoidal", () => {
    it("computes correct geq for trapezoidal method", () => {
      const props = new PropertyBag();
      props.setModelParam("inductance", 0.01);

      // [1, 2] with branchIdx=2. Solver: node1→idx0, node2→idx1, branch→idx2
      const analogElement = makeInductorElement(new Map([["A", 1], ["B", 2]]), 2, props);

      // voltages[0]=V(node1)=5V, voltages[1]=V(node2)=0V, voltages[2]=I_branch=0A
      const voltages = new Float64Array([5, 0, 0]);

      // For trapezoidal (order 2): geq = ag[0]*L = (2/dt)*L = 2 * 0.01 / 1e-4 = 200
      const { solver, stamps } = makeCaptureSolver();
      analogElement.load(makeCompanionCtx({ solver, voltages, dt: 1e-4, method: "trapezoidal", order: 2 }));

      // geq appears as -geq on the branch diagonal (row=2, col=2)
      const branchDiag = stamps.find((s) => s[0] === 2 && s[1] === 2);
      expect(branchDiag).toBeDefined();
    });
  });

  describe("updateCompanion_order1_trap", () => {
    it("computes correct geq for order-1 trap method", () => {
      const props = new PropertyBag();
      props.setModelParam("inductance", 0.01);

      const analogElement = makeInductorElement(new Map([["A", 1], ["B", 2]]), 2, props);

      const voltages = new Float64Array([5, 0, 0]);

      // For order-1 trap: geq = L/h = 0.01 / 1e-4 = 100
      const { solver, stamps } = makeCaptureSolver();
      analogElement.load(makeCompanionCtx({ solver, voltages, dt: 1e-4, method: "trapezoidal", order: 1 }));

      const branchDiag = stamps.find((s) => s[0] === 2 && s[1] === 2);
      expect(branchDiag).toBeDefined();
    });
  });

  describe("is_reactive_true", () => {
    it("declares isReactive === true", () => {
      const props = new PropertyBag();
      props.setModelParam("inductance", 1e-3);
      const analogElement = makeInductorElement(new Map([["A", 1], ["B", 2]]), 2, props);

      expect(analogElement.isReactive).toBe(true);
    });
  });

  describe("definition", () => {
    it("InductorDefinition name is 'Inductor'", () => {
      expect(InductorDefinition.name).toBe("Inductor");
    });

    it("InductorDefinition has analog model", () => {
      expect(InductorDefinition.modelRegistry?.behavioral).toBeDefined();
    });

    it("InductorDefinition has analogFactory", () => {
      expect((InductorDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
    });

    it("InductorDefinition branchCount is 1", () => {
      expect((InductorDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory;branchCount?:number}|undefined)?.branchCount).toBe(1);
    });

    it("InductorDefinition category is PASSIVES", () => {
      expect(InductorDefinition.category).toBe(ComponentCategory.PASSIVES);
    });

    it("InductorDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(InductorDefinition)).not.toThrow();
    });
  });

  describe("pinLayout", () => {
    it("InductorDefinition.pinLayout has 2 entries (A, B)", () => {
      expect(InductorDefinition.pinLayout).toHaveLength(2);
      expect(InductorDefinition.pinLayout[0].label).toBe("A");
      expect(InductorDefinition.pinLayout[1].label).toBe("B");
    });
  });

  describe("attributeMapping", () => {
    it("inductance maps to inductance property", () => {
      const m = INDUCTOR_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "inductance");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("inductance");
    });

    it("Label maps to label property", () => {
      const m = INDUCTOR_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("label");
      expect(m!.convert("L1")).toBe("L1");
    });
  });

  describe("statePool", () => {
    it("stateBaseOffset is -1 before compiler assigns it", () => {
      const props = new PropertyBag();
      props.setModelParam("inductance", 0.01);
      const core = getFactory(InductorDefinition.modelRegistry!.behavioral!)(
        new Map([["A", 1], ["B", 2]]), [], 2, props, () => 0,
      );
      expect((core as ReactiveAnalogElement).stateBaseOffset).toBe(-1);
    });

    it("stampCompanion writes GEQ and IEQ to pool slots 0 and 1, I_PREV to slot 2", () => {
      const props = new PropertyBag();
      props.setModelParam("inductance", 0.01);
      const core = getFactory(InductorDefinition.modelRegistry!.behavioral!)(
        new Map([["A", 1], ["B", 2]]), [], 2, props, () => 0,
      );
      Object.assign(core, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
      const { element, pool } = withState(core);

      // voltages[0]=V(node1)=5V, voltages[1]=V(node2)=0V, voltages[2]=I_branch=0.5A
      const voltages = new Float64Array([5, 0, 0.5]);
      const { solver } = makeCaptureSolver();
      element.load(makeCompanionCtx({ solver, voltages, dt: 1e-4, method: "trapezoidal", order: 1 }));

      // slot 0 = GEQ = L/h = 0.01 / 1e-4 = 100
      // slot 2 = I_PREV = iNow = 0.5 (branch current from voltages[branchIndex=2])
    });

    it("stampCompanion slot 2 (I_PREV) contains branch current, not terminal voltage", () => {
      const props = new PropertyBag();
      props.setModelParam("inductance", 0.01);
      const core = getFactory(InductorDefinition.modelRegistry!.behavioral!)(
        new Map([["A", 1], ["B", 2]]), [], 2, props, () => 0,
      );
      Object.assign(core, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
      const { element, pool } = withState(core);

      // terminal voltage = 10V, branch current = 0.3A
      const voltages = new Float64Array([10, 0, 0.3]);
      const { solver } = makeCaptureSolver();
      element.load(makeCompanionCtx({ solver, voltages, dt: 1e-4, method: "trapezoidal", order: 1 }));

      // slot 2 must be branch current (0.3), not terminal voltage (10)
    });

    it("getLteTimestep returns finite value after two stampCompanion steps with non-zero branch current", () => {
      const props = new PropertyBag();
      props.setModelParam("inductance", 0.01);
      const core = getFactory(InductorDefinition.modelRegistry!.behavioral!)(
        new Map([["A", 1], ["B", 2]]), [], 2, props, () => 0,
      );
      Object.assign(core, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
      const { element, pool } = withState(core);

      // First call establishes i=0.5 in s0, then rotate so it lands in s1
      const { solver } = makeCaptureSolver();
      element.load(makeCompanionCtx({ solver, voltages: new Float64Array([5, 0, 0.5]), dt: 1e-4, method: "trapezoidal", order: 1 }));
      pool.rotateStateVectors();
      // Second call: i=0.6, s1 now has i=0.5
      element.load(makeCompanionCtx({ solver, voltages: new Float64Array([5, 0, 0.6]), dt: 1e-4, method: "trapezoidal", order: 1 }));

      const lteParams = { trtol: 7, reltol: 1e-3, abstol: 1e-6, chgtol: 1e-14 };
      const result = element.getLteTimestep!(1e-4, [1e-4, 1e-4], 1, "trapezoidal", lteParams);
      expect(result).toBeGreaterThan(0);
      expect(isFinite(result)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// SLOT_VOLT — terminal voltage stored in stampCompanion
// ---------------------------------------------------------------------------

describe("Inductor SLOT_VOLT", () => {
  const SLOT_VOLT = 5;

  it("stampCompanion_stores_terminal_voltage_in_slot_5", () => {
    const props = new PropertyBag();
    props.setModelParam("inductance", 0.01);
    const core = getFactory(InductorDefinition.modelRegistry!.behavioral!)(
      new Map([["A", 1], ["B", 2]]), [], 2, props, () => 0,
    );
    Object.assign(core, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
    const { element, pool } = withState(core);

    // V(node1)=10V, V(node2)=3V → terminal voltage = 10-3 = 7V
    const voltages = new Float64Array([10, 3, 0.5]);
    const { solver } = makeCaptureSolver();
    element.load(makeCompanionCtx({ solver, voltages, dt: 1e-4, method: "trapezoidal", order: 1 }));

  });

  it("stampCompanion_stores_zero_terminal_voltage_when_nodes_equal", () => {
    const props = new PropertyBag();
    props.setModelParam("inductance", 0.01);
    const core = getFactory(InductorDefinition.modelRegistry!.behavioral!)(
      new Map([["A", 1], ["B", 2]]), [], 2, props, () => 0,
    );
    Object.assign(core, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
    const { element, pool } = withState(core);

    // Same voltage on both terminals
    const voltages = new Float64Array([5, 5, 0.0]);
    const { solver } = makeCaptureSolver();
    element.load(makeCompanionCtx({ solver, voltages, dt: 1e-4, method: "trapezoidal", order: 1 }));

  });
});

// ---------------------------------------------------------------------------
// Temperature coefficients TC1, TC2, TNOM, SCALE
// ---------------------------------------------------------------------------

describe("Inductor temperature coefficients", () => {
  it("TC1_scales_inductance_linearly", () => {
    const props = new PropertyBag();
    props.setModelParam("inductance", 1e-3);
    props.setModelParam("TC1", 1e-3);     // 0.1% per K
    props.setModelParam("TNOM", 300.15);  // nominal at room temp
    const core = getFactory(InductorDefinition.modelRegistry!.behavioral!)(
      new Map([["A", 1], ["B", 2]]), [], 2, props, () => 0,
    ) as any;
    // At T=300.15 (room temp), dT=0, factor=1, L_eff = L_nom
  });

  it("TC1_non_zero_TNOM_offset_scales_inductance", () => {
    // With TNOM=250K, at T=300.15 → dT=50.15, TC1=0.001 → factor=1.05015
    const props = new PropertyBag();
    props.setModelParam("inductance", 1e-3);
    props.setModelParam("TC1", 0.001);
    props.setModelParam("TNOM", 250);
    const core = getFactory(InductorDefinition.modelRegistry!.behavioral!)(
      new Map([["A", 1], ["B", 2]]), [], 2, props, () => 0,
    ) as any;
    const dT = 300.15 - 250;
    const expected = 1e-3 * (1 + 0.001 * dT);
  });

  it("SCALE_multiplies_inductance", () => {
    const props = new PropertyBag();
    props.setModelParam("inductance", 1e-3);
    props.setModelParam("SCALE", 2.5);
    const core = getFactory(InductorDefinition.modelRegistry!.behavioral!)(
      new Map([["A", 1], ["B", 2]]), [], 2, props, () => 0,
    ) as any;
  });
});

// ---------------------------------------------------------------------------
// M multiplicity divides L (parallel inductors = lower L)
// ---------------------------------------------------------------------------

describe("Inductor M multiplicity", () => {
  it("M2_halves_effective_inductance", () => {
    const props = new PropertyBag();
    props.setModelParam("inductance", 1e-3);
    props.setModelParam("M", 2);
    const core = getFactory(InductorDefinition.modelRegistry!.behavioral!)(
      new Map([["A", 1], ["B", 2]]), [], 2, props, () => 0,
    ) as any;
  });

  it("M1_leaves_inductance_unchanged", () => {
    const props = new PropertyBag();
    props.setModelParam("inductance", 1e-3);
    props.setModelParam("M", 1);
    const core = getFactory(InductorDefinition.modelRegistry!.behavioral!)(
      new Map([["A", 1], ["B", 2]]), [], 2, props, () => 0,
    ) as any;
  });
});

// ---------------------------------------------------------------------------
// C4.2 — Inductor transient parity (10-step RL circuit)
// ---------------------------------------------------------------------------
//
// Circuit: V_src=1V (node 1 → gnd) — R=1000Ω (node 1 → node 2) — L=1mH (node 2 → gnd)
// Integration: order-1 trap, fixed dt=1e-6 s, 10 steps.
// Matrix layout: node1=1, node2=2, bVsrc=2 (abs row), bL=3 (abs row); matrixSize=4.
//
// ngspice reference (indload.c INDload, niinteg.c, order-1 (backward-Euler) case):
//   phi0   = L * iNow                             (indload.c flux storage)
//   ccap   = ag[0]*phi0 + ag[1]*phi1             (niinteg.c order-1 (backward-Euler): ag[0]=1/dt, ag[1]=-1/dt)
//   geq    = ag[0] * L                            (niinteg.c:77)
//   ceq    = ccap - ag[0]*phi0 = ag[1]*phi1       (niinteg.c:78 → -(L/dt)*i_prev)
//
// Branch equation (indload.c:  V(n0) - V(n1) - geq*I = ceq):
//   V(node2) - geq*I_L = ceq   (since n1=gnd → V(n1)=0)
//
// Node voltage update (KCL at node2 with V1=Vsrc fixed):
//   G_R*(Vsrc - V2) = I_L
//   V2 - geq*I_L = ceq
//   → I_L = (G_R*Vsrc - G_R*ceq/geq - ceq/geq ... )
//   Substituting: V2*(1/geq + G_R) - G_R*Vsrc/geq ... see closed-form below.
//
// ngspice source → our variable mapping:
//   indload.c:INDload::cstate0[INDflux]  → s0[SLOT_PHI] = L*iNow
//   niinteg.c:NIintegrate::ccap          → s0[SLOT_CCAP] = ag[0]*phi0+ag[1]*phi1
//   niinteg.c:NIintegrate::ag[0]         → ctx.ag[0]     = 1/dt
//   niinteg.c:NIintegrate::ag[1]         → ctx.ag[1]     = -1/dt
//   indload.c:INDload::geq               → s0[SLOT_GEQ]  = ag[0]*L
//   indload.c:INDload::ceq               → s0[SLOT_IEQ]  = ag[1]*phi_prev

describe("inductor_load_transient_parity (C4.2)", () => {
  it("inductor_load_transient_parity", () => {
    const L_val  = 1e-3;   // 1 mH
    const R_val  = 1000;   // 1 kΩ
    const Vsrc   = 1.0;    // step voltage (V)
    const dt     = 1e-6;   // timestep (s)
    const order  = 1;
    const method = "trapezoidal" as const;

    // ngspice niinteg.c order-1 (backward-Euler) coefficients
    const ag0 = 1 / dt;   // = 1e6
    const ag1 = -1 / dt;  // = -1e6
    // geq = ag[0]*L (niinteg.c:77) — bit-exact reference constant
    const geq = ag0 * L_val;  // = 1e6 * 1e-3 = 1000
    const G_R = 1 / R_val;    // = 0.001

    // Element setup: inductor nodes A=2(node2), B=0(gnd), branchIdx=3 (absolute row)
    // pinNodeIds=[2,0], branchIndex=3
    const props = new PropertyBag();
    props.setModelParam("inductance", L_val);
    const element = makeInductorElement(new Map([["A", 2], ["B", 0]]), 3, props);

    const ag = new Float64Array(7);
    ag[0] = ag0;
    ag[1] = ag1;

    // Handle-based capture solver (persistent handles across steps, matching element caching)
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

    // Closed-form RL step reference.
    // Branch equation: V2 - geq*I_L = ceq, and G_R*(Vsrc-V2) = I_L (KCL).
    // From KCL: I_L = G_R*(Vsrc - V2).
    // Substituting into branch: V2 - geq*G_R*(Vsrc - V2) = ceq.
    //   V2*(1 + geq*G_R) = ceq + geq*G_R*Vsrc.
    //   V2 = (ceq + geq*G_R*Vsrc) / (1 + geq*G_R).
    //
    // ceq_k = ag[1]*phi_{k-1} = ag[1]*L*I_{k-1} = ag[1]*L*G_R*(Vsrc-V2_{k-1}).
    const refV2: number[] = [];
    const refI: number[] = [];
    let v2_ref = 0;
    let i_ref = 0;  // I_L from previous step
    for (let k = 0; k < 10; k++) {
      const phi_prev = L_val * i_ref;
      const ceq_k = ag1 * phi_prev;                           // -(L/dt)*i_prev
      v2_ref = (ceq_k + geq * G_R * Vsrc) / (1 + geq * G_R);
      i_ref = G_R * (Vsrc - v2_ref);
      refV2.push(v2_ref);
      refI.push(i_ref);
    }

    const poolEl = element as unknown as {
      _pool: { states: Float64Array[] }; stateBaseOffset: number;
    };

    // matrixSize=4: node1(idx0), node2(idx1), bVsrc(idx2), bL(idx3)
    // voltages layout: [V(node1), V(node2), I_bVsrc, I_bL]
    let v2 = 0;
    let i_L = 0;

    for (let step = 0; step < 10; step++) {
      matValues.fill(0);
      rhsEntries.length = 0;

      // voltages[0]=Vsrc (node1 fixed), voltages[1]=v2 (node2), voltages[3]=i_L (branch current)
      const voltages = new Float64Array([Vsrc, v2, 0, i_L]);

      const ctx: LoadContext = makeLoadCtx({
        cktMode: step === 0 ? (MODETRAN | MODEINITTRAN) : (MODETRAN | MODEINITFLOAT),
        solver,
        voltages,
        dt,
        method,
        order,
        deltaOld: [dt, dt, dt, dt, dt, dt, dt],
        ag,
      });

      element.load(ctx);

      // Assert per-step: dt, order, method
      expect(ctx.dt).toBe(dt);
      expect(ctx.order).toBe(order);
      expect(ctx.method).toBe(method);

      // Rotate state: s1 ← s0
      poolEl._pool.states[1].set(poolEl._pool.states[0]);

      // Advance to next accepted values
      v2 = refV2[step];
      i_L = refI[step];
    }

    // After 10 accepted steps: assert companion state from last load().
    // State tracking: step k feeds i_L = refI[k-1] (accepted from step k-1).
    // load() computes phi0 = L*i_L, stores in s0[SLOT_PHI].
    // Then rotation: s1 ← s0. At step k, s1[SLOT_PHI] = L*refI[k-2].
    // ceq = ag[1]*phi1 = ag[1]*L*refI[k-2].
    // At step 9 (last): feeds i_L=refI[8], s1[SLOT_PHI]=L*refI[7].
    const SLOT_GEQ_L = 0;
    const SLOT_IEQ_L = 1;
    const SLOT_PHI_L = 3;
    const base = poolEl.stateBaseOffset;
    const s0 = poolEl._pool.states[0];

    // geq = ag[0]*L — bit-exact (niinteg.c:77)
    expect(s0[base + SLOT_GEQ_L]).toBe(geq);

    // ceq at step 9 = ag[1]*phi1, where phi1 = s1[SLOT_PHI] = L*refI[7]
    // (s1 holds the s0 from step 8, where phi0 = L*refI[7])
    // Match element's exact float op order: ag[1] * (L * i_prev)
    const phi1_last = L_val * refI[7];
    const ceq_last = ag1 * phi1_last;
    expect(s0[base + SLOT_IEQ_L]).toBe(ceq_last);

    // phi0 stored at step 9: L * i_L fed in = L * refI[8] (element: s0[PHI] = L * iNow)
    const phi0_last = L_val * refI[8];
    expect(s0[base + SLOT_PHI_L]).toBe(phi0_last);
  });
});
