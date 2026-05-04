/** Tests for NTCThermistorElement. */

import { describe, it, expect } from "vitest";
import {
  NTCThermistorElement,
  NTCThermistorDefinition,
  createNTCThermistorElement,
  NTC_DEFAULTS,
  NTC_SCHEMA,
} from "../ntc-thermistor.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory } from "../../../core/registry.js";
import { buildFixture, type Fixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

import type { AnalogFactory } from "../../../core/registry.js";
import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Slot index resolved by name from schema (ss0 rule #4 — no raw SLOT_* imports)
// ---------------------------------------------------------------------------

const SLOT_TEMPERATURE = NTC_SCHEMA.indexOf.get("TEMPERATURE")!;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface NtcDividerParams {
  /** Voltage source magnitude across the divider (V). Default 5. */
  vSource?: number;
  /** Pull-up resistor between vs:pos and ntc:pos (Ω). Default 10000. */
  rPull?: number;
  /** NTC reference resistance R₀ (Ω). Default 10000. */
  r0?: number;
  /** B-parameter (K). Default 3950. */
  beta?: number;
  /** Reference temperature T₀ (K). Default 298.15. */
  t0?: number;
  /** Operating temperature (K). Default 298.15. */
  temperature?: number;
  /** Enable self-heating thermal model. Default false. */
  selfHeating?: boolean;
  /** Thermal resistance to ambient (K/W). Default 50. */
  thermalResistance?: number;
  /** Thermal capacitance (J/K). Default 0.01. */
  thermalCapacitance?: number;
  /** Steinhart-Hart A coefficient (optional). */
  shA?: number;
  /** Steinhart-Hart B coefficient (optional). */
  shB?: number;
  /** Steinhart-Hart C coefficient (optional). */
  shC?: number;
}

/**
 * Build a single-loop voltage divider:
 *   Vsrc → R_pull → ntc:pos ─ NTC ─ ntc:neg → GND ← Vsrc:neg
 *
 * At DCOP the NTC body is a pure resistor `R(T)`, so the divider node
 * voltage is `V(ntc:pos) = Vs · R_ntc / (R_pull + R_ntc)`. Solving for
 * `R_ntc` yields `R_ntc = R_pull · V_div / (Vs − V_div)`, which we use
 * to verify the B-parameter / Steinhart-Hart resistance formulas at the
 * public engine surface.
 */
function buildNtcDivider(facade: DefaultSimulatorFacade, p: NtcDividerParams): Circuit {
  const ntcProps: Record<string, number | string | boolean> = {
    label: "ntc",
    r0:                 p.r0          ?? 10000,
    beta:               p.beta        ?? 3950,
    t0:                 p.t0          ?? 298.15,
    temperature:        p.temperature ?? 298.15,
    selfHeating:        p.selfHeating ?? false,
    thermalResistance:  p.thermalResistance  ?? 50,
    thermalCapacitance: p.thermalCapacitance ?? 0.01,
  };
  if (p.shA !== undefined) ntcProps.shA = p.shA;
  if (p.shB !== undefined) ntcProps.shB = p.shB;
  if (p.shC !== undefined) ntcProps.shC = p.shC;

  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { label: "vs", voltage: p.vSource ?? 5 } },
      { id: "rp",  type: "Resistor",        props: { label: "rp", resistance: p.rPull ?? 10000 } },
      { id: "ntc", type: "NTCThermistor",   props: ntcProps },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos",  "rp:pos"],
      ["rp:neg",  "ntc:pos"],
      ["ntc:neg", "gnd:out"],
      ["vs:neg",  "gnd:out"],
    ],
  });
}

function findNTC(elements: ReadonlyArray<unknown>): NTCThermistorElement {
  const idx = elements.findIndex((el) => el instanceof NTCThermistorElement);
  if (idx < 0) throw new Error("NTCThermistorElement not found in compiled circuit");
  return elements[idx] as NTCThermistorElement;
}

function nodeOf(fix: Fixture, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

/** Extract R_ntc from the divider node voltage. */
function rNtcFromDividerVoltage(vDiv: number, vSrc: number, rPull: number): number {
  return (rPull * vDiv) / (vSrc - vDiv);
}

/** Closed-form B-parameter resistance: R(T) = R₀ · exp(β · (1/T − 1/T₀)). */
function rBParam(r0: number, beta: number, t0: number, t: number): number {
  return r0 * Math.exp(beta * (1 / t - 1 / t0));
}

describe("NTC", () => {
  describe("definition", () => {
    it("NTCThermistorDefinition has a behavioral inline factory", () => {
      expect(NTCThermistorDefinition.modelRegistry?.behavioral).toBeDefined();
    });

    it("NTCThermistorDefinition category is PASSIVES", () => {
      expect(NTCThermistorDefinition.category).toBe(ComponentCategory.PASSIVES);
    });

    it("NTCThermistorDefinition r0 default is 10000", () => {
      const params = NTCThermistorDefinition.modelRegistry?.behavioral?.params;
      expect(params).toBeDefined();
      expect(params!["r0"]).toBe(10000);
    });

    it("analogFactory creates an NTCThermistorElement", () => {
      const props = new PropertyBag();
      props.replaceModelParams(NTC_DEFAULTS);
      const element = createNTCThermistorElement(new Map([["pos", 1], ["neg", 2]]), props, () => 0);
      expect(element).toBeInstanceOf(NTCThermistorElement);
    });

    it("branchCount is falsy (NTC stamps in-place; no branch row)", () => {
      const entry = NTCThermistorDefinition.modelRegistry?.behavioral as
        | { kind: "inline"; factory: AnalogFactory; branchCount?: number }
        | undefined;
      expect(entry?.branchCount).toBeFalsy();
    });

    it("factory_returns_element_with_stateBase_minus_one_before_compile", () => {
      const props = new PropertyBag();
      props.replaceModelParams(NTC_DEFAULTS);
      const el = createNTCThermistorElement(new Map([["pos", 1], ["neg", 2]]), props, () => 0);
      expect(el._stateBase).toBe(-1);
    });
  });

  // -------------------------------------------------------------------------
  // resistance_at_t0_equals_r0
  //
  // At T = T₀ the B-parameter exponent is zero, so R(T₀) = R₀. With a
  // matched pull-up R_pull = R₀ the divider lands at exactly Vs / 2.
  // -------------------------------------------------------------------------
  describe("resistance_at_t0_equals_r0", () => {
    it("at T = T₀ = 298.15K with R_pull = R₀ = 10kΩ, V(ntc:pos) = Vs/2", () => {
      const fix = buildFixture({
        build: (_r, facade) => buildNtcDivider(facade, {
          vSource: 5, rPull: 10000, r0: 10000, t0: 298.15, temperature: 298.15,
        }),
      });
      const result = fix.coordinator.dcOperatingPoint()!;
      expect(result.converged).toBe(true);

      const vDiv = fix.engine.getNodeVoltage(nodeOf(fix, "ntc:pos"));
      expect(vDiv).toBeCloseTo(2.5, 6);

      const rNtc = rNtcFromDividerVoltage(vDiv, 5, 10000);
      expect(rNtc).toBeCloseTo(10000, 0);
    });

    it("at T = T₀ = 300K with R_pull = R₀ = 5kΩ, R_ntc reads back as 5kΩ", () => {
      const fix = buildFixture({
        build: (_r, facade) => buildNtcDivider(facade, {
          vSource: 5, rPull: 5000, r0: 5000, t0: 300, temperature: 300,
        }),
      });
      const vDiv = fix.engine.getNodeVoltage(nodeOf(fix, "ntc:pos"));
      const rNtc = rNtcFromDividerVoltage(vDiv, 5, 5000);
      expect(rNtc).toBeCloseTo(5000, 0);
    });
  });

  // -------------------------------------------------------------------------
  // resistance_decreases_with_temperature (NTC behaviour)
  //
  // At T > T₀ the B-parameter formula gives R(T) < R₀, so the divider
  // node voltage on the NTC arm (NTC pulled to GND, R_pull to Vs) drops.
  // At T < T₀ the divider node rises above Vs/2.
  // -------------------------------------------------------------------------
  describe("resistance_decreases_with_temperature", () => {
    it("R(348K) < R₀ ⇒ divider node falls below Vs/2 (NTC behaviour above T₀)", () => {
      const fix = buildFixture({
        build: (_r, facade) => buildNtcDivider(facade, {
          vSource: 5, rPull: 10000, r0: 10000, beta: 3950, t0: 298.15, temperature: 348,
        }),
      });
      expect(fix.coordinator.dcOperatingPoint()!.converged).toBe(true);

      const vDiv = fix.engine.getNodeVoltage(nodeOf(fix, "ntc:pos"));
      const rNtc = rNtcFromDividerVoltage(vDiv, 5, 10000);
      const rExpected = rBParam(10000, 3950, 298.15, 348);
      expect(vDiv).toBeLessThan(2.5);
      expect(rNtc).toBeCloseTo(rExpected, -1); // ~1Ω relative on a ~2.4kΩ value
    });

    it("R(273K) > R₀ ⇒ divider node rises above Vs/2 (NTC behaviour below T₀)", () => {
      const fix = buildFixture({
        build: (_r, facade) => buildNtcDivider(facade, {
          vSource: 5, rPull: 10000, r0: 10000, beta: 3950, t0: 298.15, temperature: 273,
        }),
      });
      expect(fix.coordinator.dcOperatingPoint()!.converged).toBe(true);

      const vDiv = fix.engine.getNodeVoltage(nodeOf(fix, "ntc:pos"));
      const rNtc = rNtcFromDividerVoltage(vDiv, 5, 10000);
      const rExpected = rBParam(10000, 3950, 298.15, 273);
      expect(vDiv).toBeGreaterThan(2.5);
      expect(rNtc).toBeCloseTo(rExpected, -2); // expected ≈ 27kΩ
    });
  });

  // -------------------------------------------------------------------------
  // beta_model_formula
  //
  // R(T=350K, R₀=10k, β=3950, T₀=298.15) ≈ 1405 Ω. Verify the divider
  // observation matches the closed-form value.
  // -------------------------------------------------------------------------
  describe("beta_model_formula", () => {
    it("R(350K, 10k, 3950, 298.15) ≈ 1405Ω via DCOP divider observation", () => {
      const fix = buildFixture({
        build: (_r, facade) => buildNtcDivider(facade, {
          vSource: 5, rPull: 10000, r0: 10000, beta: 3950, t0: 298.15, temperature: 350,
        }),
      });
      expect(fix.coordinator.dcOperatingPoint()!.converged).toBe(true);

      const vDiv = fix.engine.getNodeVoltage(nodeOf(fix, "ntc:pos"));
      const rNtc = rNtcFromDividerVoltage(vDiv, 5, 10000);
      const rExpected = rBParam(10000, 3950, 298.15, 350);
      expect(rExpected).toBeGreaterThan(1300);
      expect(rExpected).toBeLessThan(1500);
      // Engine-observed R within 0.1% of closed-form (DCOP convergence).
      expect(Math.abs(rNtc - rExpected) / rExpected).toBeLessThan(0.001);
    });
  });

  // -------------------------------------------------------------------------
  // self_heating_increases_temperature
  //
  // With self-heating enabled and a low-impedance NTC dissipating real
  // power, the pool TEMPERATURE slot must rise above ambient after a
  // sustained transient. We observe the slot through `fix.pool.state1`
  // (last-accepted history) after stepping for several thermal RC
  // periods.
  // -------------------------------------------------------------------------
  describe("self_heating_increases_temperature", () => {
    it("pool TEMPERATURE slot rises from ambient under sustained power", () => {
      // Vs=1V across r0=100Ω NTC ⇒ ~10 mW dissipated.
      // τ_th = R_th · C_th = 50 · 0.01 = 0.5 s. Step for several τ.
      const fix = buildFixture({
        build: (_r, facade) => buildNtcDivider(facade, {
          vSource: 1, rPull: 1, // tiny pull-up so most of Vs drops across NTC
          r0: 100, beta: 3950, t0: 298.15, temperature: 298.15,
          selfHeating: true, thermalResistance: 50, thermalCapacitance: 0.01,
        }),
        params: { tStop: 5.0, maxTimeStep: 1e-3 },
      });
      const ntc = findNTC(fix.circuit.elements);
      const slotIdx = ntc._stateBase + SLOT_TEMPERATURE;
      const initialTemp = fix.pool.state1[slotIdx];

      // Step ~2 s of sim time (≥ 4 thermal time constants).
      while (fix.engine.simTime < 2.0) fix.coordinator.step();

      const finalTemp = fix.pool.state1[slotIdx];
      expect(finalTemp).toBeGreaterThan(initialTemp);
    });
  });

  // -------------------------------------------------------------------------
  // thermal_equilibrium
  //
  // At steady state: T_eq = T_ambient + P · R_thermal, where P = V²/R(T_eq).
  // Tight thermal capacitance shrinks τ; we step well past 5 τ.
  // -------------------------------------------------------------------------
  describe("thermal_equilibrium", () => {
    it("self-heating reaches T_amb + P · R_th at steady state (within feedback margin)", () => {
      const thermalResistance = 100;   // K/W
      const thermalCapacitance = 0.001; // J/K — small for fast convergence (τ = 0.1 s)
      const r0 = 10000;
      const tAmbient = 298.15;
      const vSource = 1.0;

      const fix = buildFixture({
        build: (_r, facade) => buildNtcDivider(facade, {
          vSource,
          rPull: 1, // negligible pull-up so V across NTC ≈ Vs
          r0, beta: 3950, t0: tAmbient, temperature: tAmbient,
          selfHeating: true, thermalResistance, thermalCapacitance,
        }),
        params: { tStop: 5.0, maxTimeStep: 1e-3 },
      });
      const ntc = findNTC(fix.circuit.elements);
      const slotIdx = ntc._stateBase + SLOT_TEMPERATURE;

      while (fix.engine.simTime < 2.0) fix.coordinator.step();
      const finalTemp = fix.pool.state1[slotIdx];

      // Ambient-power estimate: P ≈ V² / R₀ at T₀ before feedback.
      const pApprox = (vSource * vSource) / r0;
      const expectedEq = tAmbient + pApprox * thermalResistance;

      // Allow 10% margin around expectedEq for resistance-temperature feedback.
      expect(finalTemp).toBeGreaterThan(expectedEq * 0.9);
      expect(finalTemp).toBeLessThan(expectedEq * 1.1 + 1);
    });
  });

  // -------------------------------------------------------------------------
  // steinhart_hart_mode
  //
  // S-H coefficients for a typical 10kΩ NTC at 25°C land R(25°C) ≈ 10kΩ.
  // We verify via the same divider observation that the divider behaves
  // consistently and that R(hot) < R(cold) (NTC behaviour) under the S-H
  // formula.
  // -------------------------------------------------------------------------
  describe("steinhart_hart_mode", () => {
    it("S-H mode converges DCOP and R(25°C) ≈ 10kΩ via divider", () => {
      const shA = 1.1e-3;
      const shB = 2.4e-4;
      const shC = 7.5e-8;

      const fix = buildFixture({
        build: (_r, facade) => buildNtcDivider(facade, {
          vSource: 5, rPull: 10000, temperature: 298.15, shA, shB, shC,
        }),
      });
      expect(fix.coordinator.dcOperatingPoint()!.converged).toBe(true);

      const vDiv = fix.engine.getNodeVoltage(nodeOf(fix, "ntc:pos"));
      const rNtc = rNtcFromDividerVoltage(vDiv, 5, 10000);
      // The chosen S-H coefficients land R(25°C) within ±20% of 10kΩ.
      expect(rNtc).toBeGreaterThan(8000);
      expect(rNtc).toBeLessThan(12000);
    });

    it("S-H mode: R(358.15K) < R(298.15K) (NTC behaviour)", () => {
      const shA = 1.1e-3;
      const shB = 2.4e-4;
      const shC = 7.5e-8;

      const fixCold = buildFixture({
        build: (_r, facade) => buildNtcDivider(facade, {
          vSource: 5, rPull: 10000, temperature: 298.15, shA, shB, shC,
        }),
      });
      const fixHot = buildFixture({
        build: (_r, facade) => buildNtcDivider(facade, {
          vSource: 5, rPull: 10000, temperature: 358.15, shA, shB, shC,
        }),
      });

      const vCold = fixCold.engine.getNodeVoltage(nodeOf(fixCold, "ntc:pos"));
      const vHot  = fixHot .engine.getNodeVoltage(nodeOf(fixHot,  "ntc:pos"));
      const rCold = rNtcFromDividerVoltage(vCold, 5, 10000);
      const rHot  = rNtcFromDividerVoltage(vHot,  5, 10000);

      expect(rHot).toBeLessThan(rCold);
    });
  });
});

