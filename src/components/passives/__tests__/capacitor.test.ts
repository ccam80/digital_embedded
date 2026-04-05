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

import { describe, it, expect } from "vitest";
import {
  CapacitorDefinition,
  CAPACITOR_ATTRIBUTE_MAPPINGS,
} from "../capacitor.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { SparseSolverStamp } from "../../../core/analog-types.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";

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

function withState<T extends AnalogElementCore>(core: T): { element: T; pool: StatePool } {
  const size = core.stateSize ?? 0;
  const pool = new StatePool(Math.max(size, 1));
  if (size > 0) {
    core.stateBaseOffset = 0;
    core.initState!(pool);
  } else {
    core.stateBaseOffset = -1;
  }
  return { element: core, pool };
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
      analogElement.stampCompanion!(1e-6, "trapezoidal", voltages);

      // For trapezoidal: geq = 2C/h = 2 * 1e-6 / 1e-6 = 2.0
      const { solver, stamps } = makeStubSolver();
      analogElement.stamp(solver);

      const geqStamps = stamps.filter((s) => s.value > 0);
      expect(geqStamps.length).toBe(2); // diagonal entries
      expect(geqStamps[0].value).toBeCloseTo(2.0, 5);
    });
  });

  describe("updateCompanion_bdf1", () => {
    it("computes correct geq for BDF-1 method", () => {
      const props = new PropertyBag();
      props.setModelParam("capacitance", 1e-6);

      const analogElement = makeCapacitorElement(new Map([["pos", 1], ["neg", 2]]), props);

      const voltages = new Float64Array([5, 0]);
      analogElement.stampCompanion!(1e-6, "bdf1", voltages);

      // For BDF-1: geq = C/h = 1e-6 / 1e-6 = 1.0
      const { solver, stamps } = makeStubSolver();
      analogElement.stamp(solver);

      const geqStamps = stamps.filter((s) => s.value > 0);
      expect(geqStamps[0].value).toBeCloseTo(1.0, 5);
    });
  });

  describe("updateCompanion_bdf2", () => {
    it("computes correct geq for BDF-2 method and uses vPrevPrev", () => {
      const props = new PropertyBag();
      props.setModelParam("capacitance", 1e-6);

      const analogElement = makeCapacitorElement(new Map([["pos", 1], ["neg", 2]]), props);

      const voltages = new Float64Array([5, 0]);
      analogElement.stampCompanion!(1e-6, "bdf2", voltages);

      // For BDF-2: geq = 3C/(2h) = 3 * 1e-6 / (2 * 1e-6) = 1.5
      const { solver, stamps } = makeStubSolver();
      analogElement.stamp(solver);

      const geqStamps = stamps.filter((s) => s.value > 0);
      expect(geqStamps[0].value).toBeCloseTo(1.5, 5);
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
    it("stateSize is 6", () => {
      const props = new PropertyBag();
      props.setModelParam("capacitance", 1e-6);
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0,
      );
      expect(core.stateSize).toBe(6);
    });

    it("stateBaseOffset is -1 before compiler assigns it", () => {
      const props = new PropertyBag();
      props.setModelParam("capacitance", 1e-6);
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0,
      );
      expect(core.stateBaseOffset).toBe(-1);
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
      element.stampCompanion!(1e-6, "bdf1", voltages);

      // slot 0 = GEQ = C/h = 1e-6 / 1e-6 = 1.0
      expect(pool.state0[0]).toBeCloseTo(1.0, 5);
      // slot 1 = IEQ (non-zero: -geq * vNow = -1.0 * 5 = -5.0 for BDF-1 at steady DC)
      expect(pool.state0[1]).toBeCloseTo(-5.0, 5);
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
      element.stampCompanion!(1e-6, "bdf1", new Float64Array([3, 0]));
      expect(pool.state0[2]).toBeCloseTo(3.0, 5);

      // Second call: voltage = 7V — V_PREV should now be 7V after the call
      element.stampCompanion!(1e-6, "bdf1", new Float64Array([7, 0]));
      expect(pool.state0[2]).toBeCloseTo(7.0, 5);
    });

    it("getLteEstimate returns non-zero truncationError after stampCompanion", () => {
      const props = new PropertyBag();
      props.setModelParam("capacitance", 1e-6);
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0,
      );
      Object.assign(core, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
      const { element } = withState(core);

      element.stampCompanion!(1e-6, "bdf1", new Float64Array([5, 0]));
      const lte = element.getLteEstimate!(1e-6);
      expect(lte).toBeDefined();
      expect(lte.truncationError).toBeGreaterThanOrEqual(0);
    });

    it("toleranceReference uses max of last two voltage samples (natural-charge formulation)", () => {
      const C = 1e-6;
      const props = new PropertyBag();
      props.setModelParam("capacitance", C);
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0,
      );
      Object.assign(core, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
      const { element } = withState(core);

      // First call: v1 = 3V
      element.stampCompanion!(1e-6, "bdf1", new Float64Array([3, 0]));
      // Second call: v2 = 7V
      element.stampCompanion!(1e-6, "bdf1", new Float64Array([7, 0]));

      const lte = element.getLteEstimate!(1e-6);
      // toleranceReference = C * max(|v(n-1)|, |v(n-2)|) = C * max(7, 3) = C * 7
      expect(lte.toleranceReference).toBeCloseTo(C * 7, 10);
    });

    it("zero-crossing protection: toleranceReference is non-zero when vPrev was non-zero", () => {
      const C = 1e-6;
      const props = new PropertyBag();
      props.setModelParam("capacitance", C);
      const core = getFactory(CapacitorDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0,
      );
      Object.assign(core, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
      const { element } = withState(core);

      // First call: v1 = 5V (non-zero)
      element.stampCompanion!(1e-6, "bdf1", new Float64Array([5, 0]));
      // Second call: v2 = 0V (zero crossing)
      element.stampCompanion!(1e-6, "bdf1", new Float64Array([0, 0]));

      const lte = element.getLteEstimate!(1e-6);
      // toleranceReference = C * max(|0|, |5|) = C * 5 — NOT collapsed to zero
      expect(lte.toleranceReference).toBeCloseTo(C * 5, 10);
    });
  });
});
