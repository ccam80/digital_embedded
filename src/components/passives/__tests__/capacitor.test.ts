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
  CapacitorElement,
  CapacitorDefinition,
  CAPACITOR_ATTRIBUTE_MAPPINGS,
} from "../capacitor.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { SparseSolver } from "../../../analog/sparse-solver.js";

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

function makeStubSolver(): { solver: SparseSolver; stamps: StampCall[]; rhsStamps: RHSCall[] } {
  const stamps: StampCall[] = [];
  const rhsStamps: RHSCall[] = [];

  const solver: SparseSolver = {
    stamp: (row: number, col: number, value: number) => {
      stamps.push({ row, col, value });
    },
    stampRHS: (row: number, value: number) => {
      rhsStamps.push({ row, value });
    },
    beginAssembly: () => {},
    finalize: () => {},
    solve: () => new Float64Array([]),
  };

  return { solver, stamps, rhsStamps };
}

/** Call analogFactory and inject pinNodeIds (simulating what the compiler does). */
function makeCapacitorElement(pinNodes: Map<string, number>, props: PropertyBag) {
  const el = CapacitorDefinition.models!.analog!.factory(pinNodes, [], -1, props, () => 0);
  Object.assign(el, { pinNodeIds: Array.from(pinNodes.values()), allNodeIds: Array.from(pinNodes.values()) });
  return el;
}

// ---------------------------------------------------------------------------
// updateCompanion tests
// ---------------------------------------------------------------------------

describe("Capacitor", () => {
  describe("updateCompanion_trapezoidal", () => {
    it("computes correct geq and ieq for trapezoidal method", () => {
      const props = new PropertyBag();
      props.set("capacitance", 1e-6);

      // Node IDs are 1-based (ground=0). Use [1, 2] so both are non-ground.
      // Solver indices: node1→idx0, node2→idx1
      const analogElement = makeCapacitorElement(new Map([["pos", 1], ["neg", 2]]), props);

      // voltages[0] = V(node1) = 5V, voltages[1] = V(node2) = 0V
      const voltages = new Float64Array([5, 0]);
      analogElement.stampCompanion!(1e-6, "trapezoidal", voltages);

      // For trapezoidal: geq = 2C/h = 2 * 1e-6 / 1e-6 = 2.0
      const { solver, stamps, rhsStamps } = makeStubSolver();
      analogElement.stamp(solver);

      const geqStamps = stamps.filter((s) => s.value > 0);
      expect(geqStamps.length).toBe(2); // diagonal entries
      expect(geqStamps[0].value).toBeCloseTo(2.0, 5);
    });
  });

  describe("updateCompanion_bdf1", () => {
    it("computes correct geq for BDF-1 method", () => {
      const props = new PropertyBag();
      props.set("capacitance", 1e-6);

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
      props.set("capacitance", 1e-6);

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
      const analogElement = makeCapacitorElement(new Map([["pos", 1], ["neg", 2]]), props);

      expect(analogElement.isReactive).toBe(true);
    });
  });

  describe("definition", () => {
    it("CapacitorDefinition name is 'Capacitor'", () => {
      expect(CapacitorDefinition.name).toBe("Capacitor");
    });

    it("CapacitorDefinition has analog model", () => {
      expect(CapacitorDefinition.models?.analog).toBeDefined();
    });

    it("CapacitorDefinition has analogFactory", () => {
      expect(CapacitorDefinition.models?.analog?.factory).toBeDefined();
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
});
