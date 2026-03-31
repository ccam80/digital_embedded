/**
 * Tests for LDRElement (Light Dependent Resistor).
 *
 * Covers:
 *   - Dark resistance at lux=0
 *   - Bright resistance at reference lux
 *   - Power-law formula accuracy
 *   - Slider-adjustable lux changes resistance
 *   - Stamping behaviour
 *   - Definition metadata
 */

import { describe, it, expect } from "vitest";
import { LDRElement, LDRDefinition, createLDRElement, LDR_DEFAULTS } from "../ldr.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory } from "../../../core/registry.js";
import type { AnalogFactory } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLDR(overrides: Partial<{
  rDark: number;
  luxRef: number;
  gamma: number;
  lux: number;
}> = {}): LDRElement {
  const el = new LDRElement(
    overrides.rDark ?? 1e6,
    overrides.luxRef ?? 1000,
    overrides.gamma ?? 0.7,
    overrides.lux ?? 500,
  );
  Object.assign(el, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
  return el;
}

// ---------------------------------------------------------------------------
// LDR
// ---------------------------------------------------------------------------

describe("LDR", () => {
  describe("dark_resistance", () => {
    it("lux=0 returns R_dark (not power-law formula)", () => {
      const ldr = makeLDR({ rDark: 1e6, lux: 0 });
      expect(ldr.resistance()).toBeCloseTo(1e6, 0);
    });

    it("lux=0 with custom rDark returns that value", () => {
      const ldr = makeLDR({ rDark: 500000, lux: 0 });
      expect(ldr.resistance()).toBeCloseTo(500000, 0);
    });
  });

  describe("bright_resistance", () => {
    it("lux equals luxRef returns rDark (power-law exponent is 1)", () => {
      // At lux = luxRef: R = rDark * (luxRef/luxRef)^(-γ) = rDark * 1 = rDark
      const rDark = 100; // set rDark to the expected "light" resistance
      const luxRef = 1000;
      const ldr = makeLDR({ rDark, luxRef, gamma: 0.7, lux: luxRef });
      // R ≈ rDark (which equals rLight at reference illumination)
      expect(ldr.resistance()).toBeCloseTo(rDark, 1);
    });

    it("resistance at reference lux matches expected light resistance", () => {
      // Use rDark=100 as the calibrated light resistance at luxRef=1000
      const rLight = 100;
      const luxRef = 1000;
      const ldr = makeLDR({ rDark: rLight, luxRef, gamma: 0.7, lux: luxRef });
      expect(ldr.resistance()).toBeCloseTo(rLight, 1);
    });
  });

  describe("power_law_correct", () => {
    it("lux=100 with luxRef=1000, gamma=0.7 matches formula R_dark*(100/lux_ref)^(-gamma)", () => {
      const rDark = 1e6;
      const luxRef = 1000;
      const gamma = 0.7;
      const lux = 100;
      const expected = rDark * Math.pow(lux / luxRef, -gamma);
      const ldr = makeLDR({ rDark, luxRef, gamma, lux });
      expect(ldr.resistance()).toBeCloseTo(expected, 0);
    });

    it("lower lux gives higher resistance than at reference", () => {
      const ldr100 = makeLDR({ rDark: 1e6, luxRef: 1000, gamma: 0.7, lux: 100 });
      const ldr1000 = makeLDR({ rDark: 1e6, luxRef: 1000, gamma: 0.7, lux: 1000 });
      expect(ldr100.resistance()).toBeGreaterThan(ldr1000.resistance());
    });

    it("higher lux gives lower resistance than at reference", () => {
      const ldr5000 = makeLDR({ rDark: 1e6, luxRef: 1000, gamma: 0.7, lux: 5000 });
      const ldr1000 = makeLDR({ rDark: 1e6, luxRef: 1000, gamma: 0.7, lux: 1000 });
      expect(ldr5000.resistance()).toBeLessThan(ldr1000.resistance());
    });
  });

  describe("slider_changes_resistance", () => {
    it("changing lux via setLux changes resistance", () => {
      const ldr = makeLDR({ rDark: 1e6, luxRef: 1000, gamma: 0.7, lux: 100 });
      const rBefore = ldr.resistance();

      ldr.setLux(5000);
      const rAfter = ldr.resistance();

      expect(rAfter).toBeLessThan(rBefore);
    });

    it("conductance is consistent with new resistance after lux change", () => {
      const ldr = makeLDR({ rDark: 1e6, luxRef: 1000, gamma: 0.7, lux: 500 });

      ldr.setLux(2000);
      const R = ldr.resistance();
      const expectedG = 1 / R;

      const stamps: Array<[number, number, number]> = [];
      const mockSolver = {
        stamp: (r: number, c: number, v: number) => stamps.push([r, c, v]),
        stampRHS: () => {},
      } as unknown as import("../../../solver/analog/sparse-solver.js").SparseSolver;

      ldr.stampNonlinear(mockSolver);

      // Check that diagonal conductance matches expected
      const diagStamp = stamps.find(([r, c]) => r === 0 && c === 0);
      expect(diagStamp).toBeDefined();
      expect(diagStamp![2]).toBeCloseTo(expectedG, 10);
    });
  });

  describe("stampNonlinear", () => {
    it("stamps conductance between the two nodes", () => {
      const ldr = makeLDR({ rDark: 1e6, luxRef: 1000, gamma: 0.7, lux: 1000 });
      const stamps: Array<[number, number, number]> = [];
      const mockSolver = {
        stamp: (r: number, c: number, v: number) => stamps.push([r, c, v]),
        stampRHS: () => {},
      } as unknown as import("../../../solver/analog/sparse-solver.js").SparseSolver;

      ldr.stampNonlinear(mockSolver);

      const G = 1 / ldr.resistance();
      expect(stamps).toContainEqual([0, 0, G]);
      expect(stamps).toContainEqual([0, 1, -G]);
      expect(stamps).toContainEqual([1, 0, -G]);
      expect(stamps).toContainEqual([1, 1, G]);
    });

    it("lux=0 stamps dark conductance", () => {
      const rDark = 1e6;
      const ldr = makeLDR({ rDark, lux: 0 });
      const stamps: Array<[number, number, number]> = [];
      const mockSolver = {
        stamp: (r: number, c: number, v: number) => stamps.push([r, c, v]),
        stampRHS: () => {},
      } as unknown as import("../../../solver/analog/sparse-solver.js").SparseSolver;

      ldr.stampNonlinear(mockSolver);

      const G = 1 / rDark;
      expect(stamps).toContainEqual([0, 0, G]);
    });
  });

  describe("definition", () => {
    it("LDRDefinition has engine type analog", () => {
      expect(LDRDefinition.modelRegistry?.behavioral).toBeDefined();
    });

    it("LDRDefinition has correct category", () => {
      expect(LDRDefinition.category).toBe(ComponentCategory.PASSIVES);
    });

    it("LDRDefinition has rDark default 1e6", () => {
      const prop = LDRDefinition.propertyDefs.find((p) => p.key === "rDark");
      expect(prop).toBeDefined();
      expect(prop!.defaultValue).toBe(1e6);
    });

    it("analogFactory creates an LDRElement", () => {
      const props = new PropertyBag();
      props.replaceModelParams(LDR_DEFAULTS);
      const element = createLDRElement(new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0);
      expect(element).toBeInstanceOf(LDRElement);
      expect(element.isNonlinear).toBe(true);
      expect(element.isReactive).toBe(false);
    });

    it("branchCount is false", () => {
      expect((LDRDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory;branchCount?:number}|undefined)?.branchCount).toBeFalsy();
    });
  });
});
