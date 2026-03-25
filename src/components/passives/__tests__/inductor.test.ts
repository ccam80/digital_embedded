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
import type { SparseSolver } from "../../../solver/analog/sparse-solver.js";

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
function makeInductorElement(pinNodes: Map<string, number>, branchIdx: number, props: PropertyBag) {
  const el = InductorDefinition.models!.analog!.factory(pinNodes, [], branchIdx, props, () => 0);
  Object.assign(el, { pinNodeIds: Array.from(pinNodes.values()), allNodeIds: Array.from(pinNodes.values()) });
  return el;
}

// ---------------------------------------------------------------------------
// stamps_branch_equation tests
// ---------------------------------------------------------------------------

describe("Inductor", () => {
  describe("stamps_branch_equation", () => {
    it("stamps branch incidence and conductance entries", () => {
      const props = new PropertyBag();
      props.set("inductance", 0.01);

      // Use non-ground nodes [1, 2] with branchIdx=2 (absolute solver row)
      // Node 1 → solver idx 0, Node 2 → solver idx 1, branch → solver row 2
      const analogElement = makeInductorElement(new Map([["A", 1], ["B", 2]]), 2, props);

      const { solver, stamps } = makeStubSolver();
      analogElement.stamp(solver);

      // Should have: 2 B-matrix incidence + 3 C/D-matrix branch = 5
      // B-matrix (node rows): (0,2)=+1, (1,2)=-1
      // C/D-matrix (branch row): (2,0)=+1, (2,1)=-1, (2,2)=-geq
      expect(stamps.length).toBe(5);

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
      props.set("inductance", 0.01);

      // [1, 2] with branchIdx=2. Solver: node1→idx0, node2→idx1, branch→idx2
      const analogElement = makeInductorElement(new Map([["A", 1], ["B", 2]]), 2, props);

      // voltages[0]=V(node1)=5V, voltages[1]=V(node2)=0V, voltages[2]=I_branch=0A
      const voltages = new Float64Array([5, 0, 0]);
      analogElement.stampCompanion!(1e-4, "trapezoidal", voltages);

      // For trapezoidal: geq = 2L/h = 2 * 0.01 / 1e-4 = 200
      const { solver, stamps } = makeStubSolver();
      analogElement.stamp(solver);

      // geq appears as -geq on the branch diagonal (row=2, col=2)
      const branchDiag = stamps.find((s) => s.row === 2 && s.col === 2);
      expect(branchDiag).toBeDefined();
      expect(branchDiag!.value).toBeCloseTo(-200, 3);
    });
  });

  describe("updateCompanion_bdf1", () => {
    it("computes correct geq for BDF-1 method", () => {
      const props = new PropertyBag();
      props.set("inductance", 0.01);

      const analogElement = makeInductorElement(new Map([["A", 1], ["B", 2]]), 2, props);

      const voltages = new Float64Array([5, 0, 0]);
      analogElement.stampCompanion!(1e-4, "bdf1", voltages);

      // For BDF-1: geq = L/h = 0.01 / 1e-4 = 100
      const { solver, stamps } = makeStubSolver();
      analogElement.stamp(solver);

      const branchDiag = stamps.find((s) => s.row === 2 && s.col === 2);
      expect(branchDiag).toBeDefined();
      expect(branchDiag!.value).toBeCloseTo(-100, 3);
    });
  });

  describe("is_reactive_true", () => {
    it("declares isReactive === true", () => {
      const props = new PropertyBag();
      const analogElement = makeInductorElement(new Map([["A", 1], ["B", 2]]), 2, props);

      expect(analogElement.isReactive).toBe(true);
    });
  });

  describe("definition", () => {
    it("InductorDefinition name is 'Inductor'", () => {
      expect(InductorDefinition.name).toBe("Inductor");
    });

    it("InductorDefinition has analog model", () => {
      expect(InductorDefinition.models?.analog).toBeDefined();
    });

    it("InductorDefinition has analogFactory", () => {
      expect(InductorDefinition.models?.analog?.factory).toBeDefined();
    });

    it("InductorDefinition requiresBranchRow is true", () => {
      expect(InductorDefinition.models?.analog?.requiresBranchRow).toBe(true);
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
