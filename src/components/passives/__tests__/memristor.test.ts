/**
 * Tests for the Memristor (Joglekar window function model).
 *
 * Covers:
 *   - Initial resistance at w=0.5
 *   - Positive current increases w → decreases resistance
 *   - Negative current decreases w → increases resistance
 *   - Pinched hysteresis I-V loop under AC excitation
 *   - Window function prevents w from leaving [0, 1]
 */

import { describe, it, expect } from "vitest";
import { MemristorElement, MemristorDefinition, createMemristorElement } from "../memristor.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Test defaults matching MemristorDefinition
// ---------------------------------------------------------------------------

const R_ON = 100;
const R_OFF = 16000;
const INITIAL_W = 0.5;
const MOBILITY = 1e-14;
const DEVICE_LENGTH = 10e-9;
const WINDOW_ORDER = 1;

function makeMemristor(overrides: Partial<{
  rOn: number;
  rOff: number;
  initialState: number;
  mobility: number;
  deviceLength: number;
  windowOrder: number;
}> = {}): MemristorElement {
  const el = new MemristorElement(
    overrides.rOn ?? R_ON,
    overrides.rOff ?? R_OFF,
    overrides.initialState ?? INITIAL_W,
    overrides.mobility ?? MOBILITY,
    overrides.deviceLength ?? DEVICE_LENGTH,
    overrides.windowOrder ?? WINDOW_ORDER,
  );
  Object.assign(el, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
  return el;
}

// ---------------------------------------------------------------------------
// Memristor
// ---------------------------------------------------------------------------

describe("Memristor", () => {
  describe("initial_resistance", () => {
    it("w=0.5 gives R = (R_on + R_off) / 2", () => {
      const mem = makeMemristor();
      const expected = (R_ON + R_OFF) / 2;
      expect(mem.resistance()).toBeCloseTo(expected, 2);
    });

    it("w=0.5 gives R = 8050 Ω with defaults", () => {
      const mem = makeMemristor();
      // R(0.5) = 100*0.5 + 16000*(0.5) = 50 + 8000 = 8050
      expect(mem.resistance()).toBeCloseTo(8050, 1);
    });

    it("conductance at w=0 equals 1/R_off", () => {
      const mem = makeMemristor({ initialState: 0.0 });
      // G(0) = 0*(1/R_on - 1/R_off) + 1/R_off = 1/R_off
      expect(mem.conductance()).toBeCloseTo(1 / R_OFF, 15);
    });

    it("conductance at w=1 equals 1/R_on", () => {
      const mem = makeMemristor({ initialState: 1.0 });
      // G(1) = 1*(1/R_on - 1/R_off) + 1/R_off = 1/R_on
      expect(mem.conductance()).toBeCloseTo(1 / R_ON, 15);
    });
  });

  describe("positive_current_decreases_resistance", () => {
    it("positive voltage causes w to increase", () => {
      const mem = makeMemristor();
      const wBefore = mem.w;

      // Apply positive voltage across A-B; run several timesteps
      const voltages = new Float64Array(3);
      voltages[0] = 1.0; // node 1 (A) = index 0
      voltages[1] = 0.0; // node 2 (B) = index 1

      const dt = 1e-6; // 1 µs steps
      for (let i = 0; i < 100; i++) {
        mem.updateState(dt, voltages);
      }

      expect(mem.w).toBeGreaterThan(wBefore);
    });

    it("positive voltage causes resistance to decrease", () => {
      const mem = makeMemristor();
      const rBefore = mem.resistance();

      const voltages = new Float64Array(3);
      voltages[0] = 1.0;
      voltages[1] = 0.0;

      const dt = 1e-6;
      for (let i = 0; i < 100; i++) {
        mem.updateState(dt, voltages);
      }

      expect(mem.resistance()).toBeLessThan(rBefore);
    });
  });

  describe("negative_current_increases_resistance", () => {
    it("negative voltage causes w to decrease", () => {
      const mem = makeMemristor();
      const wBefore = mem.w;

      const voltages = new Float64Array(3);
      voltages[0] = -1.0; // node 1 (A)
      voltages[1] = 0.0;  // node 2 (B)

      const dt = 1e-6;
      for (let i = 0; i < 100; i++) {
        mem.updateState(dt, voltages);
      }

      expect(mem.w).toBeLessThan(wBefore);
    });

    it("negative voltage causes resistance to increase", () => {
      const mem = makeMemristor();
      const rBefore = mem.resistance();

      const voltages = new Float64Array(3);
      voltages[0] = -1.0;
      voltages[1] = 0.0;

      const dt = 1e-6;
      for (let i = 0; i < 100; i++) {
        mem.updateState(dt, voltages);
      }

      expect(mem.resistance()).toBeGreaterThan(rBefore);
    });
  });

  describe("pinched_hysteresis_loop", () => {
    it("I-V characteristic is different for increasing vs decreasing V (pinched loop)", () => {
      // Apply a full AC sine cycle and collect I at V≈0 on the rising and falling half.
      // A pinched hysteresis loop passes through I=0 at V=0 for both half-cycles,
      // but the slope (effective conductance) differs between rising and falling edges.
      const mem = makeMemristor();
      const voltages = new Float64Array(3);

      const dt = 1e-7; // 100 ns timestep
      const freq = 1e3; // 1 kHz
      const amplitude = 1.0;
      const stepsPerCycle = Math.round(1 / (freq * dt));

      // Collect conductance samples near V=0 for rising and falling phases
      const risingConductances: number[] = [];
      const fallingConductances: number[] = [];

      for (let step = 0; step < 3 * stepsPerCycle; step++) {
        const t = step * dt;
        const v = amplitude * Math.sin(2 * Math.PI * freq * t);
        voltages[0] = v;
        voltages[1] = 0;

        const phase = (t * freq) % 1.0;
        // Sample near V=0 crossings: rising (phase ≈ 0 or 1) and falling (phase ≈ 0.5)
        if (step > stepsPerCycle) { // skip first cycle (transient)
          if (phase < 0.02) {
            risingConductances.push(mem.conductance());
          } else if (phase > 0.49 && phase < 0.51) {
            fallingConductances.push(mem.conductance());
          }
        }

        mem.updateState(dt, voltages);
      }

      // Both crossing points should have measurable conductance (loop passes through origin)
      expect(risingConductances.length).toBeGreaterThan(0);
      expect(fallingConductances.length).toBeGreaterThan(0);

      // The conductance on the rising half differs from the falling half — this is
      // the signature of a pinched hysteresis loop (different slopes at V=0)
      const avgRising = risingConductances.reduce((a, b) => a + b, 0) / risingConductances.length;
      const avgFalling = fallingConductances.reduce((a, b) => a + b, 0) / fallingConductances.length;

      // The relative difference should be meaningful (> 0.1%)
      const relativeDiff = Math.abs(avgRising - avgFalling) / ((avgRising + avgFalling) / 2);
      expect(relativeDiff).toBeGreaterThan(0.001);
    });
  });

  describe("window_function_bounds_state", () => {
    it("large positive current never pushes w above 1.0", () => {
      const mem = makeMemristor({ initialState: 0.5 });
      const voltages = new Float64Array(3);
      voltages[0] = 100.0; // large positive voltage
      voltages[1] = 0.0;

      const dt = 1e-6;
      for (let i = 0; i < 10000; i++) {
        mem.updateState(dt, voltages);
      }

      expect(mem.w).toBeLessThanOrEqual(1.0);
    });

    it("large negative current never pushes w below 0.0", () => {
      const mem = makeMemristor({ initialState: 0.5 });
      const voltages = new Float64Array(3);
      voltages[0] = -100.0; // large negative voltage
      voltages[1] = 0.0;

      const dt = 1e-6;
      for (let i = 0; i < 10000; i++) {
        mem.updateState(dt, voltages);
      }

      expect(mem.w).toBeGreaterThanOrEqual(0.0);
    });

    it("window function fp is zero at w=0 (no state drift below boundary)", () => {
      const mem = makeMemristor({ initialState: 0.0 });
      // At w=0: f_p(0) = 1 - (2*0 - 1)^(2p) = 1 - (-1)^2 = 1 - 1 = 0
      const voltages = new Float64Array(3);
      voltages[0] = 10.0;
      voltages[1] = 0.0;

      const dt = 1e-6;
      for (let i = 0; i < 1000; i++) {
        mem.updateState(dt, voltages);
      }

      // w should remain at 0 (window function clamps dynamics at boundaries)
      // Note: due to floating point, w may drift slightly; check it stays at or near 0
      expect(mem.w).toBeCloseTo(0.0, 5);
    });

    it("window function fp is zero at w=1 (no state drift above boundary)", () => {
      const mem = makeMemristor({ initialState: 1.0 });
      // At w=1: f_p(1) = 1 - (2*1 - 1)^(2p) = 1 - 1^2 = 0
      const voltages = new Float64Array(3);
      voltages[0] = -10.0;
      voltages[1] = 0.0;

      const dt = 1e-6;
      for (let i = 0; i < 1000; i++) {
        mem.updateState(dt, voltages);
      }

      expect(mem.w).toBeCloseTo(1.0, 5);
    });
  });

  describe("stampNonlinear", () => {
    it("stamps conductance between nodes A and B", () => {
      const mem = makeMemristor();
      const stamps: Array<[number, number, number]> = [];
      const rhsStamps: Array<[number, number]> = [];

      const mockSolver = {
        stamp: (r: number, c: number, v: number) => stamps.push([r, c, v]),
        stampRHS: (r: number, v: number) => rhsStamps.push([r, v]),
      } as unknown as import("../../../analog/sparse-solver.js").SparseSolver;

      mem.stampNonlinear(mockSolver);

      const G = mem.conductance();

      // Expect 4 conductance stamps: [0,0,G], [0,1,-G], [1,0,-G], [1,1,G]
      // (node 1 → index 0, node 2 → index 1)
      expect(stamps).toContainEqual([0, 0, G]);
      expect(stamps).toContainEqual([0, 1, -G]);
      expect(stamps).toContainEqual([1, 0, -G]);
      expect(stamps).toContainEqual([1, 1, G]);
    });
  });

  describe("definition", () => {
    it("MemristorDefinition has correct engine type and category", () => {
      expect(MemristorDefinition.models?.mnaModels?.behavioral).toBeDefined();
      expect(MemristorDefinition.category).toBe(ComponentCategory.PASSIVES);
    });

    it("MemristorDefinition has rOn default 100", () => {
      const prop = MemristorDefinition.propertyDefs.find((p) => p.key === "rOn");
      expect(prop).toBeDefined();
      expect(prop!.defaultValue).toBe(100);
    });

    it("MemristorDefinition has rOff default 16000", () => {
      const prop = MemristorDefinition.propertyDefs.find((p) => p.key === "rOff");
      expect(prop).toBeDefined();
      expect(prop!.defaultValue).toBe(16000);
    });

    it("analogFactory creates a MemristorElement", () => {
      const propsMap = new Map<string, import("../../../core/properties.js").PropertyValue>();
      const props = new PropertyBag(propsMap.entries());
      const element = createMemristorElement(new Map([["A", 1], ["B", 2]]), [], -1, props);
      expect(element).toBeInstanceOf(MemristorElement);
      expect(element.isNonlinear).toBe(true);
      expect(element.isReactive).toBe(false);
    });

    it("requiresBranchRow is false", () => {
      expect(MemristorDefinition.models?.mnaModels?.behavioral?.requiresBranchRow).toBeFalsy();
    });
  });
});
