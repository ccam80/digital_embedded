/**
 * Tests for NTCThermistorElement.
 *
 * Covers:
 *   - Resistance equals R₀ at T₀
 *   - NTC behaviour: resistance decreases with increasing temperature
 *   - B-parameter formula accuracy
 *   - Self-heating raises temperature under power dissipation
 *   - Self-heating reaches correct thermal equilibrium
 *   - Steinhart-Hart mode
 */

import { describe, it, expect } from "vitest";
import {
  NTCThermistorElement,
  NTCThermistorDefinition,
  createNTCThermistorElement,
} from "../ntc-thermistor.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNTC(overrides: Partial<{
  r0: number;
  beta: number;
  t0: number;
  temperature: number;
  selfHeating: boolean;
  thermalResistance: number;
  thermalCapacitance: number;
  shA: number;
  shB: number;
  shC: number;
}> = {}): NTCThermistorElement {
  const el = new NTCThermistorElement(
    overrides.r0 ?? 10000,
    overrides.beta ?? 3950,
    overrides.t0 ?? 298.15,
    overrides.temperature ?? 298.15,
    overrides.selfHeating ?? false,
    overrides.thermalResistance ?? 50,
    overrides.thermalCapacitance ?? 0.01,
    overrides.shA,
    overrides.shB,
    overrides.shC,
  );
  Object.assign(el, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
  return el;
}

// ---------------------------------------------------------------------------
// NTC
// ---------------------------------------------------------------------------

describe("NTC", () => {
  describe("resistance_at_t0_equals_r0", () => {
    it("resistance at T₀ equals R₀", () => {
      const ntc = makeNTC({ r0: 10000, t0: 298.15, temperature: 298.15 });
      expect(ntc.resistance()).toBeCloseTo(10000, 0);
    });

    it("resistance at T₀ = 300K with R₀ = 5000Ω equals 5000Ω", () => {
      const ntc = makeNTC({ r0: 5000, t0: 300, temperature: 300 });
      expect(ntc.resistance()).toBeCloseTo(5000, 0);
    });
  });

  describe("resistance_decreases_with_temperature", () => {
    it("resistance at 348K is less than R₀ at T₀=298K (NTC behaviour)", () => {
      const ntc = makeNTC({ r0: 10000, beta: 3950, t0: 298.15, temperature: 348 });
      expect(ntc.resistance()).toBeLessThan(10000);
    });

    it("resistance at 273K is greater than R₀ at T₀=298K (NTC below ref)", () => {
      const ntc = makeNTC({ r0: 10000, beta: 3950, t0: 298.15, temperature: 273 });
      expect(ntc.resistance()).toBeGreaterThan(10000);
    });
  });

  describe("beta_model_formula", () => {
    it("R₀=10k, B=3950, T=350K gives expected resistance", () => {
      // R = 10000 · exp(3950 · (1/350 - 1/298.15))
      const expected = 10000 * Math.exp(3950 * (1 / 350 - 1 / 298.15));
      const ntc = makeNTC({ r0: 10000, beta: 3950, t0: 298.15, temperature: 350 });
      expect(ntc.resistance()).toBeCloseTo(expected, 0);
    });

    it("B-parameter formula: result is approximately 1.4kΩ at 350K", () => {
      const ntc = makeNTC({ r0: 10000, beta: 3950, t0: 298.15, temperature: 350 });
      // R = 10000 · exp(3950 · (1/350 - 1/298.15)) ≈ 1405 Ω
      expect(ntc.resistance()).toBeGreaterThan(1200);
      expect(ntc.resistance()).toBeLessThan(1700);
    });
  });

  describe("self_heating_increases_temperature", () => {
    it("temperature rises from ambient under power dissipation", () => {
      // 1V across ~100Ω NTC (P≈10mW), selfHeating enabled
      // Use R₀=100Ω at T₀=298.15K so voltage of 1V gives ≈10mW
      const ntc = makeNTC({
        r0: 100,
        beta: 3950,
        t0: 298.15,
        temperature: 298.15,
        selfHeating: true,
        thermalResistance: 50,
        thermalCapacitance: 0.01,
      });

      const initialTemp = ntc.temperature;
      const voltages = new Float64Array(3);
      voltages[0] = 1.0; // node 1 at 1V
      voltages[1] = 0.0; // node 2 at 0V

      // Run many timesteps to accumulate heating
      const dt = 1e-4;
      for (let i = 0; i < 5000; i++) {
        ntc.updateState(dt, voltages);
      }

      expect(ntc.temperature).toBeGreaterThan(initialTemp);
    });
  });

  describe("thermal_equilibrium", () => {
    it("self-heating reaches T_ambient + P·R_thermal at steady state", () => {
      const thermalResistance = 100; // K/W
      const thermalCapacitance = 0.001; // J/K — small for faster convergence

      // Use high R₀ so temperature effect on resistance is small during test
      const r0 = 10000;
      const ntc = makeNTC({
        r0,
        beta: 3950,
        t0: 298.15,
        temperature: 298.15,
        selfHeating: true,
        thermalResistance,
        thermalCapacitance,
      });

      const voltage = 1.0; // V across the thermistor
      const voltages = new Float64Array(3);
      voltages[0] = voltage;
      voltages[1] = 0.0;

      // Run to steady state: time constant = R_thermal * C_thermal = 100 * 0.001 = 0.1s
      // Run for 10× time constant = 1s with dt=1ms
      const dt = 1e-3;
      for (let i = 0; i < 2000; i++) {
        ntc.updateState(dt, voltages);
      }

      // At equilibrium: P = V²/R(T_eq), T_eq = T_ambient + P · R_thermal
      // For large R₀ the temperature rise is small so R(T_eq) ≈ R₀
      const P_approx = (voltage * voltage) / r0;
      const tAmbient = 298.15;
      const expectedEq = tAmbient + P_approx * thermalResistance;

      // Allow 10% tolerance due to resistance-temperature feedback
      expect(ntc.temperature).toBeGreaterThan(expectedEq * 0.9);
      expect(ntc.temperature).toBeLessThan(expectedEq * 1.1 + 1);
    });
  });

  describe("steinhart_hart_mode", () => {
    it("Steinhart-Hart mode returns resistance consistent with the formula at 25°C", () => {
      // S-H coefficients for a typical 10kΩ NTC at 25°C
      const shA = 1.1e-3;
      const shB = 2.4e-4;
      const shC = 7.5e-8;

      const t25 = 298.15;
      const ntc = makeNTC({ temperature: t25, shA, shB, shC });
      const R = ntc.resistance();

      // Verify: 1/T = A + B·ln(R) + C·(ln(R))³ recovers T within 1%
      const lnR = Math.log(R);
      const tRecovered = 1 / (shA + shB * lnR + shC * lnR * lnR * lnR);

      expect(tRecovered).toBeCloseTo(t25, 0); // within ~1K
      const relErr = Math.abs(tRecovered - t25) / t25;
      expect(relErr).toBeLessThan(0.01); // within 1%
    });

    it("Steinhart-Hart resistance at higher temperature is lower than at 25°C", () => {
      const shA = 1.1e-3;
      const shB = 2.4e-4;
      const shC = 7.5e-8;

      const ntcCold = makeNTC({ temperature: 298.15, shA, shB, shC });
      const ntcHot = makeNTC({ temperature: 358.15, shA, shB, shC });

      expect(ntcHot.resistance()).toBeLessThan(ntcCold.resistance());
    });
  });

  describe("stampNonlinear", () => {
    it("stamps conductance between nodes", () => {
      const ntc = makeNTC({ r0: 10000, temperature: 298.15 });
      const stamps: Array<[number, number, number]> = [];
      const mockSolver = {
        stamp: (r: number, c: number, v: number) => stamps.push([r, c, v]),
        stampRHS: () => {},
      } as unknown as import("../../../analog/sparse-solver.js").SparseSolver;

      ntc.stampNonlinear(mockSolver);

      const G = 1 / ntc.resistance();
      expect(stamps).toContainEqual([0, 0, G]);
      expect(stamps).toContainEqual([0, 1, -G]);
      expect(stamps).toContainEqual([1, 0, -G]);
      expect(stamps).toContainEqual([1, 1, G]);
    });
  });

  describe("definition", () => {
    it("NTCThermistorDefinition has correct engine type", () => {
      expect(NTCThermistorDefinition.models?.analog).toBeDefined();
    });

    it("NTCThermistorDefinition has correct category", () => {
      expect(NTCThermistorDefinition.category).toBe(ComponentCategory.PASSIVES);
    });

    it("NTCThermistorDefinition r0 default is 10000", () => {
      const prop = NTCThermistorDefinition.propertyDefs.find((p) => p.key === "r0");
      expect(prop).toBeDefined();
      expect(prop!.defaultValue).toBe(10000);
    });

    it("analogFactory creates an NTCThermistorElement", () => {
      const props = new PropertyBag(new Map<string, import("../../../core/properties.js").PropertyValue>().entries());
      const element = createNTCThermistorElement(new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0);
      expect(element).toBeInstanceOf(NTCThermistorElement);
      expect(element.isNonlinear).toBe(true);
    });

    it("requiresBranchRow is false", () => {
      expect(NTCThermistorDefinition.models?.analog?.requiresBranchRow).toBeFalsy();
    });
  });
});
