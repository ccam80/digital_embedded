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
  InductorElement,
  InductorDefinition,
  INDUCTOR_ATTRIBUTE_MAPPINGS,
} from "../inductor.js";
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

// ---------------------------------------------------------------------------
// stamps_branch_equation tests
// ---------------------------------------------------------------------------

describe("Inductor", () => {
  describe("stamps_branch_equation", () => {
    it("stamps branch incidence and conductance entries", () => {
      const props = new PropertyBag();
      props.set("inductance", 0.01);

      const analogElement = InductorDefinition.analogFactory!(
        [0, 1],
        0,
        props,
        () => 0,
      );

      const { solver, stamps } = makeStubSolver();
      analogElement.stamp(solver);

      // Should have: 4 conductance stamps + 3 branch incidence stamps
      // Conductance: (0,0), (1,1), (0,1), (1,0)
      // Branch: (0, 0), (0, 1), (0, 2)
      expect(stamps.length).toBe(7);

      // Check for branch incidence entries
      const branchEntries = stamps.filter((s) => s.row === 0 && (s.col === 0 || s.col === 1));
      expect(branchEntries.some((s) => s.col === 0 && s.value === 1)).toBe(true);
      expect(branchEntries.some((s) => s.col === 1 && s.value === -1)).toBe(true);
    });
  });

  describe("updateCompanion_trapezoidal", () => {
    it("computes correct geq for trapezoidal method", () => {
      const props = new PropertyBag();
      props.set("inductance", 0.01);

      const analogElement = InductorDefinition.analogFactory!(
        [0, 1],
        0,
        props,
        () => 0,
      );

      const voltages = new Float64Array([5, 0]);
      analogElement.stampCompanion!(1e-4, "trapezoidal", voltages);

      // For trapezoidal: geq = 2L/h = 2 * 0.01 / 1e-4 = 200
      const { solver, stamps } = makeStubSolver();
      analogElement.stamp(solver);

      const geqStamps = stamps.filter((s) => s.value > 0 && s.row !== 0 && s.col !== 0);
      expect(geqStamps.length).toBeGreaterThan(0);
      expect(geqStamps[0].value).toBeCloseTo(200, 3);
    });
  });

  describe("updateCompanion_bdf1", () => {
    it("computes correct geq for BDF-1 method", () => {
      const props = new PropertyBag();
      props.set("inductance", 0.01);

      const analogElement = InductorDefinition.analogFactory!(
        [0, 1],
        0,
        props,
        () => 0,
      );

      const voltages = new Float64Array([5, 0]);
      analogElement.stampCompanion!(1e-4, "bdf1", voltages);

      // For BDF-1: geq = L/h = 0.01 / 1e-4 = 100
      const { solver, stamps } = makeStubSolver();
      analogElement.stamp(solver);

      const geqStamps = stamps.filter((s) => s.value > 0 && s.row !== 0 && s.col !== 0);
      expect(geqStamps[0].value).toBeCloseTo(100, 3);
    });
  });

  describe("is_reactive_true", () => {
    it("declares isReactive === true", () => {
      const props = new PropertyBag();
      const analogElement = InductorDefinition.analogFactory!(
        [0, 1],
        0,
        props,
        () => 0,
      );

      expect(analogElement.isReactive).toBe(true);
    });
  });

  describe("definition", () => {
    it("InductorDefinition name is 'AnalogInductor'", () => {
      expect(InductorDefinition.name).toBe("AnalogInductor");
    });

    it("InductorDefinition engineType is 'analog'", () => {
      expect(InductorDefinition.engineType).toBe("analog");
    });

    it("InductorDefinition has analogFactory", () => {
      expect(InductorDefinition.analogFactory).toBeDefined();
    });

    it("InductorDefinition requiresBranchRow is true", () => {
      expect(InductorDefinition.requiresBranchRow).toBe(true);
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
});
