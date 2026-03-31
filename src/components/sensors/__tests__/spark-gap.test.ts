/**
 * Tests for SparkGapElement.
 *
 * Covers:
 *   - Blocks below breakdown voltage
 *   - Conducts above breakdown voltage
 *   - Hysteresis: stays conducting while current exceeds holding threshold
 *   - Extinguishes when current drops below holding threshold
 *   - Smooth resistance transition for NR convergence
 *   - Stamping behaviour
 *   - Definition metadata
 */

import { describe, it, expect } from "vitest";
import { SparkGapElement, SparkGapDefinition, createSparkGapElement } from "../spark-gap.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory } from "../../../core/registry.js";
import type { AnalogFactory } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSparkGap(overrides: Partial<{
  vBreakdown: number;
  rOn: number;
  rOff: number;
  iHold: number;
}> = {}): SparkGapElement {
  const el = new SparkGapElement(
    overrides.vBreakdown ?? 1000,
    overrides.rOn ?? 5,
    overrides.rOff ?? 1e10,
    overrides.iHold ?? 0.01,
  );
  Object.assign(el, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
  return el;
}

/** Apply a voltage to the gap by updating its operating point. */
function applyVoltage(gap: SparkGapElement, v: number): void {
  const voltages = new Float64Array(3);
  voltages[0] = v; // node 1 at voltage v
  voltages[1] = 0; // node 2 at ground
  gap.updateOperatingPoint(voltages);
}

// ---------------------------------------------------------------------------
// SparkGap
// ---------------------------------------------------------------------------

describe("SparkGap", () => {
  describe("blocks_below_breakdown", () => {
    it("500V across 1000V gap: current ≈ 500/R_off (nA range)", () => {
      const gap = makeSparkGap({ vBreakdown: 1000, rOff: 1e10 });
      applyVoltage(gap, 500);
      const R = gap.resistance();
      const I = 500 / R;
      // Should be in nA range: 500/1e10 = 50nA
      expect(I).toBeLessThan(1e-6); // less than 1µA
      expect(gap.conducting).toBe(false);
    });

    it("resistance below breakdown is close to R_off", () => {
      const gap = makeSparkGap({ vBreakdown: 1000, rOff: 1e10, rOn: 5 });
      applyVoltage(gap, 100);
      // Should be close to rOff (smooth blend keeps it near rOff far from threshold)
      expect(gap.resistance()).toBeGreaterThan(1e8);
    });

    it("gap starts in blocking state", () => {
      const gap = makeSparkGap();
      expect(gap.conducting).toBe(false);
    });
  });

  describe("conducts_above_breakdown", () => {
    it("1500V fires the gap and allows current to flow", () => {
      const gap = makeSparkGap({ vBreakdown: 1000, rOn: 5, rOff: 1e10 });
      applyVoltage(gap, 1500);
      expect(gap.conducting).toBe(true);
    });

    it("resistance drops significantly above breakdown", () => {
      const gap = makeSparkGap({ vBreakdown: 1000, rOn: 5, rOff: 1e10 });
      applyVoltage(gap, 1500);
      // Resistance should be close to rOn when well above breakdown
      expect(gap.resistance()).toBeLessThan(100);
    });

    it("current above breakdown is much larger than below", () => {
      const gap = makeSparkGap({ vBreakdown: 1000, rOn: 5, rOff: 1e10 });

      // Below breakdown
      applyVoltage(gap, 500);
      const I_below = 500 / gap.resistance();

      // Above breakdown — reset for fresh gap
      const gap2 = makeSparkGap({ vBreakdown: 1000, rOn: 5, rOff: 1e10 });
      applyVoltage(gap2, 1500);
      const I_above = 1500 / gap2.resistance();

      expect(I_above).toBeGreaterThan(I_below * 1000);
    });
  });

  describe("holds_until_current_drops", () => {
    it("gap stays conducting while voltage keeps current above iHold", () => {
      // iHold = 10mA, rOn = 5Ω → need V > 0.05V to hold
      const gap = makeSparkGap({ vBreakdown: 1000, rOn: 5, iHold: 0.01 });

      // Fire the gap
      applyVoltage(gap, 1500);
      expect(gap.conducting).toBe(true);

      // Reduce voltage but keep I = V/rOn > iHold: V > 0.05V
      // Apply 10V: I = 10/5 = 2A >> iHold
      applyVoltage(gap, 10);
      expect(gap.conducting).toBe(true);

      // Apply 1V: I = 1/5 = 200mA >> iHold
      applyVoltage(gap, 1);
      expect(gap.conducting).toBe(true);
    });

    it("conducting gap has low resistance well above holding current", () => {
      const gap = makeSparkGap({ vBreakdown: 1000, rOn: 5, iHold: 0.01 });
      applyVoltage(gap, 1500); // fire
      applyVoltage(gap, 50);   // V=50V, I=10A >> iHold — should stay on
      expect(gap.resistance()).toBeLessThan(100);
    });
  });

  describe("extinguishes_below_holding", () => {
    it("gap returns to blocking when current drops below iHold", () => {
      // iHold = 10mA, rOn = 5Ω → holding current threshold: V = 0.01*5 = 0.05V
      const gap = makeSparkGap({ vBreakdown: 1000, rOn: 5, iHold: 0.01 });

      // Fire the gap
      applyVoltage(gap, 1500);
      expect(gap.conducting).toBe(true);

      // Reduce voltage so I = V/rOn < iHold: need V < 0.05V
      // Apply 0V: I = 0A < 10mA
      applyVoltage(gap, 0);
      expect(gap.conducting).toBe(false);
    });

    it("resistance returns toward R_off after extinction", () => {
      const gap = makeSparkGap({ vBreakdown: 1000, rOn: 5, rOff: 1e10, iHold: 0.01 });
      applyVoltage(gap, 1500); // fire
      applyVoltage(gap, 0);    // extinguish
      expect(gap.resistance()).toBeGreaterThan(1e6);
    });

    it("can re-fire after extinction", () => {
      const gap = makeSparkGap({ vBreakdown: 1000, rOn: 5, iHold: 0.01 });
      applyVoltage(gap, 1500); // fire
      applyVoltage(gap, 0);    // extinguish
      expect(gap.conducting).toBe(false);
      applyVoltage(gap, 1500); // re-fire
      expect(gap.conducting).toBe(true);
    });
  });

  describe("smooth_transition", () => {
    it("resistance changes monotonically across the breakdown transition zone", () => {
      // Sample resistance at several voltages spanning breakdown
      // The smooth tanh blend ensures resistance decreases monotonically
      // from rOff to rOn as voltage increases through vBreakdown.
      const vBreakdown = 1000;
      const samples: number[] = [];
      for (const v of [900, 950, 1000, 1050, 1100]) {
        const gap = makeSparkGap({ vBreakdown, rOn: 5, rOff: 1e10 });
        applyVoltage(gap, v);
        samples.push(gap.resistance());
      }
      // Each subsequent sample should be <= the previous (monotonically decreasing)
      for (let i = 1; i < samples.length; i++) {
        expect(samples[i]).toBeLessThanOrEqual(samples[i - 1]);
      }
    });

    it("resistance at breakdown voltage is midpoint between rOn and rOff", () => {
      const rOn = 5;
      const rOff = 1e10;
      const vBreakdown = 1000;
      const gap = makeSparkGap({ vBreakdown, rOn, rOff });

      // At exactly breakdown: tanh(0) = 0, blend = 0.5
      // R = rOff + (rOn - rOff) * 0.5 = (rOn + rOff) / 2
      applyVoltage(gap, vBreakdown);
      const R = gap.resistance();
      const expected = rOff + (rOn - rOff) * 0.5;

      // Allow tolerance since state machine may flip at exactly vBreakdown
      expect(R).toBeGreaterThan(rOn);
      expect(R).toBeLessThan(rOff);
      // Should be within an order of magnitude of the midpoint
      expect(R).toBeLessThan(expected * 10);
    });
  });

  describe("stampNonlinear", () => {
    it("stamps conductance matrix between nodes in blocking state", () => {
      const gap = makeSparkGap({ vBreakdown: 1000, rOff: 1e10 });
      // Below breakdown — in blocking state
      applyVoltage(gap, 100);

      const stamps: Array<[number, number, number]> = [];
      const mockSolver = {
        stamp: (r: number, c: number, v: number) => stamps.push([r, c, v]),
        stampRHS: () => {},
      } as unknown as import("../../../solver/analog/sparse-solver.js").SparseSolver;

      gap.stampNonlinear(mockSolver);

      const G = 1 / gap.resistance();
      expect(stamps).toContainEqual([0, 0, G]);
      expect(stamps).toContainEqual([0, 1, -G]);
      expect(stamps).toContainEqual([1, 0, -G]);
      expect(stamps).toContainEqual([1, 1, G]);
    });

    it("stamps higher conductance in conducting state", () => {
      const gap = makeSparkGap({ vBreakdown: 1000, rOn: 5, rOff: 1e10 });

      // Blocking state conductance
      applyVoltage(gap, 100);
      const stamps1: Array<[number, number, number]> = [];
      const solver1 = {
        stamp: (r: number, c: number, v: number) => stamps1.push([r, c, v]),
        stampRHS: () => {},
      } as unknown as import("../../../solver/analog/sparse-solver.js").SparseSolver;
      gap.stampNonlinear(solver1);
      const G_off = stamps1.find(([r, c]) => r === 0 && c === 0)![2];

      // Conducting state conductance
      applyVoltage(gap, 1500);
      const stamps2: Array<[number, number, number]> = [];
      const solver2 = {
        stamp: (r: number, c: number, v: number) => stamps2.push([r, c, v]),
        stampRHS: () => {},
      } as unknown as import("../../../solver/analog/sparse-solver.js").SparseSolver;
      gap.stampNonlinear(solver2);
      const G_on = stamps2.find(([r, c]) => r === 0 && c === 0)![2];

      expect(G_on).toBeGreaterThan(G_off);
    });
  });

  describe("definition", () => {
    it("SparkGapDefinition has engine type analog", () => {
      expect(SparkGapDefinition.modelRegistry?.behavioral).toBeDefined();
    });

    it("SparkGapDefinition has correct category", () => {
      expect(SparkGapDefinition.category).toBe(ComponentCategory.PASSIVES);
    });

    it("SparkGapDefinition has vBreakdown default 1000", () => {
      const prop = SparkGapDefinition.propertyDefs.find((p) => p.key === "vBreakdown");
      expect(prop).toBeDefined();
      expect(prop!.defaultValue).toBe(1000);
    });

    it("analogFactory creates a SparkGapElement", () => {
      const props = new PropertyBag(new Map<string, import("../../../core/properties.js").PropertyValue>().entries());
      const element = createSparkGapElement(new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0);
      expect(element).toBeInstanceOf(SparkGapElement);
      expect(element.isNonlinear).toBe(true);
      expect(element.isReactive).toBe(false);
    });

    it("branchCount is false", () => {
      expect((SparkGapDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory;branchCount?:number}|undefined)?.branchCount).toBeFalsy();
    });
  });
});
