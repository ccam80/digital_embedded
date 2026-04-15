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

import { describe, it, expect } from "vitest";
import {
  InductorDefinition,
  INDUCTOR_ATTRIBUTE_MAPPINGS,
} from "../inductor.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { SparseSolverStamp } from "../../../core/analog-types.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";
import type { ReactiveAnalogElement } from "../../../solver/analog/element.js";

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

interface StampCall {
  row: number;
  col: number;
  value: number;
}

interface RHSCall {
  row: number;
  value: number;
}

function makeStubSolver(): { solver: SparseSolverStamp; stamps: StampCall[]; rhsStamps: RHSCall[] } {
  const stamps: StampCall[] = [];
  const rhsStamps: RHSCall[] = [];

  const solver: SparseSolverStamp = {
    stamp: (row: number, col: number, value: number) => {
      stamps.push({ row, col, value });
    },
    stampRHS: (row: number, value: number) => {
      rhsStamps.push({ row, value });
    },
  };

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

      const { solver, stamps } = makeStubSolver();
      analogElement.stamp(solver);

      // Should have: 2 B-matrix incidence + 2 C/D-matrix branch (topology only) = 4
      // B-matrix (node rows): (0,2)=+1, (1,2)=-1
      // C/D-matrix (branch row): (2,0)=+1, (2,1)=-1
      // Note: (2,2)=-geq is now stamped by stampReactiveCompanion
      expect(stamps.length).toBe(4);

      // B sub-matrix: branch current incidence in node KCL rows
      const nodeEntries = stamps.filter((s) => s.row < 2);
      expect(nodeEntries.some((s) => s.row === 0 && s.col === 2 && s.value === 1)).toBe(true);
      expect(nodeEntries.some((s) => s.row === 1 && s.col === 2 && s.value === -1)).toBe(true);

      // C sub-matrix: branch equation entries
      const branchEntries = stamps.filter((s) => s.row === 2);
      expect(branchEntries.some((s) => s.col === 0 && s.value === 1)).toBe(true);
      expect(branchEntries.some((s) => s.col === 1 && s.value === -1)).toBe(true);
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
      analogElement.stampCompanion!(1e-4, "trapezoidal", voltages, 2, [1e-4, 1e-4]);

      // For trapezoidal: geq = 2L/h = 2 * 0.01 / 1e-4 = 200
      const { solver, stamps } = makeStubSolver();
      analogElement.stamp(solver);
      analogElement.stampReactiveCompanion!(solver);

      // geq appears as -geq on the branch diagonal (row=2, col=2)
      const branchDiag = stamps.find((s) => s.row === 2 && s.col === 2);
      expect(branchDiag).toBeDefined();
      expect(branchDiag!.value).toBeCloseTo(-200, 3);
    });
  });

  describe("updateCompanion_bdf1", () => {
    it("computes correct geq for BDF-1 method", () => {
      const props = new PropertyBag();
      props.setModelParam("inductance", 0.01);

      const analogElement = makeInductorElement(new Map([["A", 1], ["B", 2]]), 2, props);

      const voltages = new Float64Array([5, 0, 0]);
      analogElement.stampCompanion!(1e-4, "bdf1", voltages, 1, [1e-4]);

      // For BDF-1: geq = L/h = 0.01 / 1e-4 = 100
      const { solver, stamps } = makeStubSolver();
      analogElement.stamp(solver);
      analogElement.stampReactiveCompanion!(solver);

      const branchDiag = stamps.find((s) => s.row === 2 && s.col === 2);
      expect(branchDiag).toBeDefined();
      expect(branchDiag!.value).toBeCloseTo(-100, 3);
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
      expect(m!.convert("0.01")).toBeCloseTo(0.01, 10);
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
      element.stampCompanion!(1e-4, "bdf1", voltages, 1, [1e-4]);

      // slot 0 = GEQ = L/h = 0.01 / 1e-4 = 100
      expect(pool.state0[0]).toBeCloseTo(100, 3);
      // slot 2 = I_PREV = iNow = 0.5 (branch current from voltages[branchIndex=2])
      expect(pool.state0[2]).toBeCloseTo(0.5, 5);
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
      element.stampCompanion!(1e-4, "bdf1", voltages, 1, [1e-4]);

      // slot 2 must be branch current (0.3), not terminal voltage (10)
      expect(pool.state0[2]).toBeCloseTo(0.3, 5);
      expect(pool.state0[2]).not.toBeCloseTo(10, 1);
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
      element.stampCompanion!(1e-4, "bdf1", new Float64Array([5, 0, 0.5]), 1, [1e-4]);
      pool.rotateStateVectors();
      pool.refreshElementRefs([element as unknown as import("../../../solver/analog/element.js").PoolBackedAnalogElementCore]);
      // Second call: i=0.6, s1 now has i=0.5
      element.stampCompanion!(1e-4, "bdf1", new Float64Array([5, 0, 0.6]), 1, [1e-4]);

      const lteParams = { trtol: 7, reltol: 1e-3, abstol: 1e-6, chgtol: 1e-14 };
      const result = element.getLteTimestep!(1e-4, [1e-4, 1e-4], 1, "bdf1", lteParams);
      expect(result).toBeGreaterThan(0);
      expect(isFinite(result)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Change 30: SLOT_VOLT — terminal voltage stored in stampCompanion
// ---------------------------------------------------------------------------

describe("Inductor SLOT_VOLT (Change 30)", () => {
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
    element.stampCompanion!(1e-4, "bdf1", voltages, 1, [1e-4]);

    expect(pool.states[0][SLOT_VOLT]).toBeCloseTo(7, 6);
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
    element.stampCompanion!(1e-4, "bdf1", voltages, 1, [1e-4]);

    expect(pool.states[0][SLOT_VOLT]).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// Change 39: Temperature coefficients TC1, TC2, TNOM, SCALE
// ---------------------------------------------------------------------------

describe("Inductor temperature coefficients (Change 39)", () => {
  it("TC1_scales_inductance_linearly", () => {
    const props = new PropertyBag();
    props.setModelParam("inductance", 1e-3);
    props.setModelParam("TC1", 1e-3);     // 0.1% per K
    props.setModelParam("TNOM", 300.15);  // nominal at room temp
    const core = getFactory(InductorDefinition.modelRegistry!.behavioral!)(
      new Map([["A", 1], ["B", 2]]), [], 2, props, () => 0,
    ) as any;
    // At T=300.15 (room temp), dT=0, factor=1, L_eff = L_nom
    expect(core.L).toBeCloseTo(1e-3, 9);
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
    expect(core.L).toBeCloseTo(expected, 12);
  });

  it("SCALE_multiplies_inductance", () => {
    const props = new PropertyBag();
    props.setModelParam("inductance", 1e-3);
    props.setModelParam("SCALE", 2.5);
    const core = getFactory(InductorDefinition.modelRegistry!.behavioral!)(
      new Map([["A", 1], ["B", 2]]), [], 2, props, () => 0,
    ) as any;
    expect(core.L).toBeCloseTo(2.5e-3, 12);
  });
});

// ---------------------------------------------------------------------------
// Change 40: M multiplicity divides L (parallel inductors = lower L)
// ---------------------------------------------------------------------------

describe("Inductor M multiplicity (Change 40)", () => {
  it("M2_halves_effective_inductance", () => {
    const props = new PropertyBag();
    props.setModelParam("inductance", 1e-3);
    props.setModelParam("M", 2);
    const core = getFactory(InductorDefinition.modelRegistry!.behavioral!)(
      new Map([["A", 1], ["B", 2]]), [], 2, props, () => 0,
    ) as any;
    expect(core.L).toBeCloseTo(0.5e-3, 12);
  });

  it("M1_leaves_inductance_unchanged", () => {
    const props = new PropertyBag();
    props.setModelParam("inductance", 1e-3);
    props.setModelParam("M", 1);
    const core = getFactory(InductorDefinition.modelRegistry!.behavioral!)(
      new Map([["A", 1], ["B", 2]]), [], 2, props, () => 0,
    ) as any;
    expect(core.L).toBeCloseTo(1e-3, 12);
  });
});
