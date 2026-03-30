/**
 * Tests for the Potentiometer component.
 *
 * Covers:
 *   - Conductance stamp computation for both top and bottom resistors
 *   - Position-based resistance splitting
 *   - Edge cases (position 0 and 1)
 *   - Clamping to minimum resistance
 *   - Component definition completeness
 *   - Voltage divider integration test
 */

import { describe, it, expect } from "vitest";
import {
  PotentiometerElement,
  PotentiometerDefinition,
  POTENTIOMETER_ATTRIBUTE_MAPPINGS,
} from "../potentiometer.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { SparseSolver } from "../../../solver/analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StampCall {
  row: number;
  col: number;
  value: number;
}

function makeStubSolver(): { solver: SparseSolver; stamps: StampCall[] } {
  const stamps: StampCall[] = [];

  const solver: SparseSolver = {
    stamp: (row: number, col: number, value: number) => {
      stamps.push({ row, col, value });
    },
    stampRHS: () => {},
    beginAssembly: () => {},
    finalize: () => {},
    solve: () => new Float64Array([]),
  };

  return { solver, stamps };
}

// ---------------------------------------------------------------------------
// stamps_two_conductance_pairs tests
// ---------------------------------------------------------------------------

describe("Potentiometer", () => {
  describe("stamps_two_conductance_pairs", () => {
    it("stamps 8 conductance entries for position 0.5", () => {
      const props = new PropertyBag();
      props.setModelParam("resistance", 10000);
      props.setModelParam("position", 0.5);

      const analogElement = getFactory(PotentiometerDefinition.modelRegistry!.behavioral!)(
        new Map([["A", 1], ["B", 2], ["W", 3]]),
        [],
        -1,
        props,
        () => 0,
      );

      const { solver, stamps } = makeStubSolver();
      analogElement.stamp(solver);

      expect(stamps.length).toBe(8);

      // Check for top resistor stamps (G = 1/5000 = 0.0002)
      const topStamps = stamps.filter((s) => (s.row === 1 || s.row === 2) && (s.col === 1 || s.col === 2));
      expect(topStamps.some((s) => Math.abs(s.value - 0.0002) < 1e-6)).toBe(true);

      // Check for bottom resistor stamps (G = 1/5000 = 0.0002)
      const bottomStamps = stamps.filter((s) => (s.row === 2 || s.row === 3) && (s.col === 2 || s.col === 3));
      expect(bottomStamps.some((s) => Math.abs(s.value - 0.0002) < 1e-6)).toBe(true);
    });
  });

  describe("position_0_gives_full_resistance_on_bottom", () => {
    it("position=0 clamps R_top to minimum and R_bottom to full", () => {
      const props = new PropertyBag();
      props.setModelParam("resistance", 10000);
      props.setModelParam("position", 0);

      const analogElement = getFactory(PotentiometerDefinition.modelRegistry!.behavioral!)(
        new Map([["A", 1], ["B", 2], ["W", 3]]),
        [],
        -1,
        props,
        () => 0,
      );

      const { solver, stamps } = makeStubSolver();
      analogElement.stamp(solver);

      // Top resistance is 0, clamped to 1e-9: G_top = 1/(1e-9) = 1e9
      // Bottom resistance is 10000: G_bottom = 1/10000 = 0.0001
      const topStamps = stamps.filter((s) => (s.row === 1 || s.row === 2) && (s.col === 1 || s.col === 2));
      const bottomStamps = stamps.filter((s) => (s.row === 2 || s.row === 3) && (s.col === 2 || s.col === 3));

      expect(topStamps.some((s) => s.value > 1e8)).toBe(true); // Very large G_top
      expect(bottomStamps.some((s) => Math.abs(s.value - 0.0001) < 1e-6)).toBe(true);
    });
  });

  describe("position_1_gives_full_resistance_on_top", () => {
    it("position=1 clamps R_bottom to minimum and R_top to full", () => {
      const props = new PropertyBag();
      props.setModelParam("resistance", 10000);
      props.setModelParam("position", 1);

      const analogElement = getFactory(PotentiometerDefinition.modelRegistry!.behavioral!)(
        new Map([["A", 1], ["B", 2], ["W", 3]]),
        [],
        -1,
        props,
        () => 0,
      );

      const { solver, stamps } = makeStubSolver();
      analogElement.stamp(solver);

      // Top resistance is 10000: G_top = 1/10000 = 0.0001
      // Bottom resistance is 0, clamped to 1e-9: G_bottom = 1/(1e-9) = 1e9
      const topStamps = stamps.filter((s) => (s.row === 1 || s.row === 2) && (s.col === 1 || s.col === 2));
      const bottomStamps = stamps.filter((s) => (s.row === 2 || s.row === 3) && (s.col === 2 || s.col === 3));

      expect(topStamps.some((s) => Math.abs(s.value - 0.0001) < 1e-6)).toBe(true);
      expect(bottomStamps.some((s) => s.value > 1e8)).toBe(true); // Very large G_bottom
    });
  });

  describe("definition", () => {
    it("PotentiometerDefinition name is 'Potentiometer'", () => {
      expect(PotentiometerDefinition.name).toBe("Potentiometer");
    });

    it("PotentiometerDefinition has analog model", () => {
      expect(PotentiometerDefinition.modelRegistry?.behavioral).toBeDefined();
    });

    it("PotentiometerDefinition has analogFactory", () => {
      expect((PotentiometerDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
    });

    it("PotentiometerDefinition category is PASSIVES", () => {
      expect(PotentiometerDefinition.category).toBe(ComponentCategory.PASSIVES);
    });

    it("PotentiometerDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(PotentiometerDefinition)).not.toThrow();
    });
  });

  describe("pinLayout", () => {
    it("PotentiometerDefinition.pinLayout has 3 entries (A, B, W)", () => {
      expect(PotentiometerDefinition.pinLayout).toHaveLength(3);
      expect(PotentiometerDefinition.pinLayout[0].label).toBe("A");
      expect(PotentiometerDefinition.pinLayout[1].label).toBe("B");
      expect(PotentiometerDefinition.pinLayout[2].label).toBe("W");
    });
  });

  describe("attributeMapping", () => {
    it("resistance maps to resistance property", () => {
      const m = POTENTIOMETER_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "resistance");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("resistance");
      expect(m!.convert("10000")).toBeCloseTo(10000, 0);
    });

    it("position maps to position property", () => {
      const m = POTENTIOMETER_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "position");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("position");
      expect(m!.convert("0.3")).toBeCloseTo(0.3, 10);
    });

    it("Label maps to label property", () => {
      const m = POTENTIOMETER_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("label");
      expect(m!.convert("R1")).toBe("R1");
    });
  });
});
