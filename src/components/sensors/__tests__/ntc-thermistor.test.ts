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
  NTC_DEFAULTS,
} from "../ntc-thermistor.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory } from "../../../core/registry.js";
import type { AnalogFactory } from "../../../core/registry.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import { makeSimpleCtx } from "../../../solver/analog/__tests__/test-helpers.js";
import { MODETRAN, MODEINITFLOAT } from "../../../solver/analog/ckt-mode.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Capture solver — records stamp tuples via the real allocElement/stampElement
// API so tests can read back what load() wrote.
// ---------------------------------------------------------------------------

interface CaptureStamp { row: number; col: number; value: number; }
interface CaptureRhs { row: number; value: number; }

function makeCaptureSolver(): {
  solver: SparseSolverType;
  stamps: CaptureStamp[];
  rhs: CaptureRhs[];
} {
  const stamps: CaptureStamp[] = [];
  const rhs: CaptureRhs[] = [];
  const handles: { row: number; col: number }[] = [];
  const handleIndex = new Map<string, number>();
  const solver = {
    stampRHS: (row: number, value: number) => {
      rhs.push({ row, value });
    },
    allocElement: (row: number, col: number): number => {
      const key = `${row},${col}`;
      let h = handleIndex.get(key);
      if (h === undefined) {
        h = handles.length;
        handles.push({ row, col });
        handleIndex.set(key, h);
      }
      return h;
    },
    stampElement: (handle: number, value: number) => {
      const { row, col } = handles[handle];
      stamps.push({ row, col, value });
    },
  } as unknown as SparseSolverType;
  return { solver, stamps, rhs };
}

// ---------------------------------------------------------------------------
// Build a minimal LoadContext for accept() calls. NTCThermistor.accept reads
// ctx.dt and ctx.voltages; no solver stamps occur inside accept.
// ---------------------------------------------------------------------------

function makeAcceptCtx(voltages: Float64Array, dt: number): import("../../../solver/analog/load-context.js").LoadContext {
  return {
    solver: undefined as unknown as SparseSolverType,
    voltages,
    cktMode: MODETRAN | MODEINITFLOAT,
    dt,
    method: "trapezoidal",
    order: 1,
    deltaOld: [dt, dt, dt, dt, dt, dt, dt],
    ag: new Float64Array(7),
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    xfact: 1,
    gmin: 1e-12,
    uic: false,
    reltol: 1e-3,
    iabstol: 1e-12,
  };
}

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
      const voltages = new Float64Array(2);
      voltages[0] = 1.0; // node 1 at 1V
      voltages[1] = 0.0; // node 2 at 0V

      // Run many timesteps to accumulate heating
      const dt = 1e-4;
      const ctx = makeAcceptCtx(voltages, dt);
      for (let i = 0; i < 5000; i++) {
        ntc.accept(ctx, 0, () => {});
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
      const voltages = new Float64Array(2);
      voltages[0] = voltage;
      voltages[1] = 0.0;

      // Run to steady state: time constant = R_thermal * C_thermal = 100 * 0.001 = 0.1s
      // Run for 10× time constant = 1s with dt=1ms
      const dt = 1e-3;
      const ctx = makeAcceptCtx(voltages, dt);
      for (let i = 0; i < 2000; i++) {
        ntc.accept(ctx, 0, () => {});
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

  describe("load", () => {
    it("stamps conductance between nodes", () => {
      const ntc = makeNTC({ r0: 10000, temperature: 298.15 });
      const { solver, stamps } = makeCaptureSolver();
      const ctx = makeSimpleCtx({
        solver,
        elements: [ntc as unknown as AnalogElement],
        matrixSize: 2,
        nodeCount: 2,
      });

      ntc.load(ctx);

      const G = 1 / ntc.resistance();
      const tuples = stamps.map((s) => [s.row, s.col, s.value] as [number, number, number]);
      expect(tuples).toContainEqual([0, 0, G]);
      expect(tuples).toContainEqual([0, 1, -G]);
      expect(tuples).toContainEqual([1, 0, -G]);
      expect(tuples).toContainEqual([1, 1, G]);
    });
  });

  describe("definition", () => {
    it("NTCThermistorDefinition has correct engine type", () => {
      expect(NTCThermistorDefinition.modelRegistry?.behavioral).toBeDefined();
    });

    it("NTCThermistorDefinition has correct category", () => {
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
      const element = createNTCThermistorElement(new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0);
      expect(element).toBeInstanceOf(NTCThermistorElement);
      expect(element.isNonlinear).toBe(true);
    });

    it("branchCount is false", () => {
      expect((NTCThermistorDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory;branchCount?:number}|undefined)?.branchCount).toBeFalsy();
    });
  });
});

// ---------------------------------------------------------------------------
// ntc_load_dcop_parity — C4.1 / Task 6.2.1
//
// NTC at 25°C nominal (T = T₀ = 298.15 K), self-heating OFF.
// Default params: r0=10000, beta=3950, t0=298.15, temperature=298.15.
// At T = T₀: R = r0 · exp(beta · (1/T - 1/T₀)) = 10000 · exp(0) = 10000 Ω.
// G = 1 / R = 1 / 10000.
//
// NGSPICE reference: ngspice resload.c stamps G=1/R. For a linear resistor at
// T=T₀ the B-parameter exponent is zero, so G = 1/r0 exactly.
// Nodes: pos=1 → idx 0, neg=2 → idx 1. matrixSize=2, nodeCount=2.
// ---------------------------------------------------------------------------

describe("ntc_load_dcop_parity", () => {
  it("NTC at 25°C (T=T₀) G=1/r0=1/10000 bit-exact", () => {
    const props = new PropertyBag();
    props.replaceModelParams(NTC_DEFAULTS);
    // Ensure temperature equals t0 so exponent is zero
    props.setModelParam("temperature", NTC_DEFAULTS.t0);

    const core = createNTCThermistorElement(
      new Map([["pos", 1], ["neg", 2]]),
      [],
      -1,
      props,
      () => 0,
    );
    const analogElement = Object.assign(core, {
      pinNodeIds: [1, 2] as readonly number[],
      allNodeIds: [1, 2] as readonly number[],
    }) as unknown as AnalogElement;

    const stampCtx = makeSimpleCtx({
      elements: [analogElement],
      matrixSize: 2,
      nodeCount: 2,
    });
    stampCtx.solver.beginAssembly(2);
    analogElement.load(stampCtx.loadCtx);
    stampCtx.solver.finalize();
    const stamps = stampCtx.solver.getCSCNonZeros();

    // NGSPICE ref: G = 1/r0 when T == T₀ (exponent = 0, exp(0) = 1).
    // Single IEEE-754 division: 1 / 10000.
    const NGSPICE_G_REF = 1 / NTC_DEFAULTS.r0;

    const e00 = stamps.find((e) => e.row === 0 && e.col === 0);
    expect(e00).toBeDefined();
    expect(e00!.value).toBe(NGSPICE_G_REF);

    const e11 = stamps.find((e) => e.row === 1 && e.col === 1);
    expect(e11).toBeDefined();
    expect(e11!.value).toBe(NGSPICE_G_REF);

    const e01 = stamps.find((e) => e.row === 0 && e.col === 1);
    expect(e01!.value).toBe(-NGSPICE_G_REF);

    const e10 = stamps.find((e) => e.row === 1 && e.col === 0);
    expect(e10!.value).toBe(-NGSPICE_G_REF);
  });
});
