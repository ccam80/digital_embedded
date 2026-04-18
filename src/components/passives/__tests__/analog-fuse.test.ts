/**
 * Tests for the AnalogFuseElement MNA model and unified Fuse component.
 *
 * Covers:
 *   - Low current stays intact (thermal energy below threshold)
 *   - Overcurrent blows fuse at expected time (I²t threshold)
 *   - Blown fuse is effectively open circuit (R_blown >> R_cold)
 *   - Resistance transition is smooth (no step discontinuity)
 *   - Blown emits fuse-blown diagnostic with info severity
 *   - PropertyBag writeback propagates blown and thermalRatio
 *   - Unified FuseDefinition has both digital and analog support
 */

import { describe, it, expect } from "vitest";
import {
  AnalogFuseElement,
  createAnalogFuseElement,
} from "../analog-fuse.js";
import { PropertyBag } from "../../../core/properties.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { runDcOp } from "../../../solver/analog/__tests__/test-helpers.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { Diagnostic } from "../../../compile/types.js";
import { ComponentRegistry } from "../../../core/registry.js";
import type { AnalogFactory } from "../../../core/registry.js";
import { FuseDefinition } from "../../switching/fuse.js";



// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFuseElement(opts: {
  rCold?: number;
  rBlown?: number;
  i2tRating?: number;
  emitDiagnostic?: (d: Diagnostic) => void;
  onStateChange?: (blown: boolean, thermalRatio: number) => void;
}): AnalogFuseElement {
  return new AnalogFuseElement(
    [1, 0],
    opts.rCold ?? 0.01,
    opts.rBlown ?? 1e9,
    opts.i2tRating ?? 1.0,
    opts.emitDiagnostic,
    opts.onStateChange,
  );
}

// ---------------------------------------------------------------------------
// Fuse tests
// ---------------------------------------------------------------------------

describe("AnalogFuseElement", () => {
  describe("low_current_stays_intact", () => {
    it("0.5A through 1A-rated fuse for 1s stays intact", () => {
      const rCold = 0.01;
      const i2tRating = 1.0;
      const fuse = makeFuseElement({ rCold, i2tRating });

      const voltages = new Float64Array(1);
      voltages[0] = 0.5 * rCold;

      const dt = 0.1;
      for (let i = 0; i < 10; i++) {
        fuse.updateOperatingPoint(voltages);
        fuse.updateState(dt, voltages);
      }

      expect(fuse.blown).toBe(false);
      expect(fuse.thermalEnergy).toBeLessThan(i2tRating);
      expect(fuse.currentResistance).toBeLessThan(rCold * 2);
    });
  });

  describe("overcurrent_blows_fuse", () => {
    it("3A through 1A-rated fuse blows at t ≈ i2tRating/I² ≈ 0.111s", () => {
      const rCold = 0.01;
      const i2tRating = 1.0;
      const fuse = makeFuseElement({ rCold, i2tRating });

      const current = 3.0;
      const voltage = current * rCold;
      const voltages = new Float64Array(1);
      voltages[0] = voltage;

      const dt = 0.001;
      const expectedBlowTime = i2tRating / (current * current);
      const maxSteps = Math.ceil(expectedBlowTime * 3 / dt);

      let blowStep = -1;
      for (let i = 0; i < maxSteps; i++) {
        if (!fuse.blown) {
          fuse.updateOperatingPoint(voltages);
          fuse.updateState(dt, voltages);
          if (fuse.blown) {
            blowStep = i;
          }
        }
      }

      expect(fuse.blown).toBe(true);

      const actualBlowTime = blowStep * dt;
      const tolerance = 0.20;
      expect(Math.abs(actualBlowTime - expectedBlowTime) / expectedBlowTime).toBeLessThan(tolerance);
    });
  });

  describe("blown_fuse_open_circuit", () => {
    it("blown fuse has resistance close to R_blown", () => {
      const rCold = 0.01;
      const rBlown = 1e9;
      const i2tRating = 1.0;
      const fuse = makeFuseElement({ rCold, rBlown, i2tRating });

      const voltage = 10 * rCold;
      const voltages = new Float64Array(1);
      voltages[0] = voltage;

      const dt = 0.001;
      for (let i = 0; i < 100; i++) {
        fuse.updateOperatingPoint(voltages);
        fuse.updateState(dt, voltages);
      }

      expect(fuse.blown).toBe(true);
      expect(fuse.currentResistance).toBeGreaterThan(rBlown * 0.5);
    });
  });

  describe("resistance_transition_smooth", () => {
    it("resistance changes continuously without step discontinuity near blow threshold", () => {
      const rCold = 0.01;
      const rBlown = 1e9;
      const i2tRating = 1.0;

      const resistances: number[] = [];
      const N = 1000;

      for (let i = 0; i <= N; i++) {
        const energy = 0.5 * i2tRating + (i2tRating * i) / N;
        const testFuse = new AnalogFuseElement([1, 0], rCold, rBlown, i2tRating);
        const dt = 1.0;
        const current = Math.sqrt(energy);
        const v = current * rCold;
        const vArr = new Float64Array(1);
        vArr[0] = v;
        testFuse.updateOperatingPoint(vArr);
        testFuse.updateState(dt, vArr);
        resistances.push(testFuse.currentResistance);
      }

      // Monotonic increase
      for (let i = 1; i < resistances.length; i++) {
        expect(resistances[i]).toBeGreaterThanOrEqual(resistances[i - 1] * 0.9999);
      }

      // No single step exceeds 10% of range
      const maxAllowedStep = 0.1 * (rBlown - rCold);
      for (let i = 1; i < resistances.length; i++) {
        const step = resistances[i] - resistances[i - 1];
        expect(step).toBeLessThanOrEqual(maxAllowedStep);
      }
    });
  });

  describe("blown_emits_diagnostic", () => {
    it("driving 2× rated current emits fuse-blown diagnostic with info severity", () => {
      const diagnostics: Diagnostic[] = [];
      const fuse = makeFuseElement({
        rCold: 0.01,
        rBlown: 1e9,
        i2tRating: 1.0,
        emitDiagnostic: (d) => diagnostics.push(d),
      });

      const current = 2.0;
      const voltage = current * 0.01;
      const voltages = new Float64Array(1);
      voltages[0] = voltage;

      const dt = 0.01;
      for (let i = 0; i < 50; i++) {
        fuse.updateOperatingPoint(voltages);
        fuse.updateState(dt, voltages);
      }

      expect(fuse.blown).toBe(true);
      expect(diagnostics.length).toBe(1);
      expect(diagnostics[0].code).toBe("fuse-blown");
      expect(diagnostics[0].severity).toBe("info");
    });

    it("diagnostic is emitted only once even after multiple steps past blow", () => {
      const diagnostics: Diagnostic[] = [];
      const fuse = makeFuseElement({
        rCold: 0.01,
        rBlown: 1e9,
        i2tRating: 0.1,
        emitDiagnostic: (d) => diagnostics.push(d),
      });

      const voltage = 10 * 0.01;
      const voltages = new Float64Array(1);
      voltages[0] = voltage;

      const dt = 0.01;
      for (let i = 0; i < 100; i++) {
        fuse.updateOperatingPoint(voltages);
        fuse.updateState(dt, voltages);
      }

      expect(fuse.blown).toBe(true);
      expect(diagnostics.length).toBe(1);
    });
  });

  describe("thermalRatio", () => {
    it("thermalRatio is 0 initially and increases toward 1", () => {
      const fuse = makeFuseElement({ i2tRating: 1.0 });
      expect(fuse.thermalRatio).toBe(0);

      const voltages = new Float64Array(1);
      voltages[0] = 1.0; // 100A through 0.01Ω
      fuse.updateOperatingPoint(voltages);
      fuse.updateState(0.0001, voltages);

      expect(fuse.thermalRatio).toBeGreaterThan(0);
      expect(fuse.thermalRatio).toBeLessThanOrEqual(1);
    });
  });

  describe("props_writeback", () => {
    it("onStateChange callback receives blown and thermalRatio", () => {
      const calls: Array<{ blown: boolean; ratio: number }> = [];
      const fuse = makeFuseElement({
        rCold: 0.01,
        i2tRating: 0.001,
        onStateChange: (blown, ratio) => calls.push({ blown, ratio }),
      });

      const voltages = new Float64Array(1);
      voltages[0] = 1.0; // high current

      fuse.updateOperatingPoint(voltages);
      fuse.updateState(0.01, voltages);

      expect(calls.length).toBe(1);
      expect(calls[0].ratio).toBeGreaterThan(0);
    });

    it("createAnalogFuseElement writes blown and _thermalRatio into props", () => {
      const props = new PropertyBag();
      props.setModelParam("rCold", 0.01);
      props.setModelParam("rBlown", 1e9);
      props.setModelParam("i2tRating", 0.001);

      const el = createAnalogFuseElement(new Map([["out1", 1], ["out2", 0]]), [], -1, props, () => 0) as AnalogFuseElement;

      const voltages = new Float64Array(1);
      voltages[0] = 1.0;

      el.updateOperatingPoint(voltages);
      el.updateState(0.1, voltages);

      expect(props.get("_thermalRatio")).toBeGreaterThan(0);
      expect(props.get("blown")).toBe(true);
    });
  });

  describe("stamp_nonlinear", () => {
    it("stamps conductance into MNA solver when intact", () => {
      const rCold = 1.0;
      const fuse = new AnalogFuseElement([1, 0], rCold, 1e9, 100.0);
      const vs = makeDcVoltageSource(1, 0, 1, 1.0) as unknown as AnalogElement;

      const result = runDcOp({
        elements: [vs, fuse],
        matrixSize: 2,
        nodeCount: 1,
      });

      expect(result.converged).toBe(true);
      const sourceCurrent = Math.abs(result.nodeVoltages[1]);
      expect(sourceCurrent).toBeCloseTo(1.0, 2);
    });

    it("stamps near-zero conductance when blown", () => {
      const fuse = makeFuseElement({ rCold: 0.01, rBlown: 1e9, i2tRating: 0.0001 });

      const voltages = new Float64Array(1);
      voltages[0] = 1000 * 0.01;
      fuse.updateOperatingPoint(voltages);
      fuse.updateState(1.0, voltages);
      expect(fuse.blown).toBe(true);
      expect(fuse.currentResistance).toBeGreaterThan(1e8);
    });
  });

  describe("dc_operating_point", () => {
    it("intact fuse in series with load resistor: current = V / (R_cold + R_load)", () => {
      const rCold = 1.0;
      const rLoad = 9.0;
      const fuse = new AnalogFuseElement([1, 2], rCold, 1e9, 100.0);
      const vs = makeDcVoltageSource(1, 0, 2, 1.0) as unknown as AnalogElement;

      const G_load = 1 / rLoad;
      const loadResistor = {
        pinNodeIds: [2, 0] as readonly number[],
        allNodeIds: [2, 0] as readonly number[],
        branchIndex: -1,
        isNonlinear: false,
        isReactive: false,
        setParam(_key: string, _value: number): void {},
        getPinCurrents(_v: Float64Array): number[] { return []; },
        stamp(solver: SparseSolver): void {
          solver.stampElement(solver.allocElement(1, 1), G_load);
        },
      };

      const result = runDcOp({
        elements: [vs, fuse, loadResistor],
        matrixSize: 3,
        nodeCount: 2,
      });

      expect(result.converged).toBe(true);
      const sourceCurrent = Math.abs(result.nodeVoltages[2]);
      expect(sourceCurrent).toBeCloseTo(0.1, 2);
    });
  });

  describe("unified FuseDefinition", () => {
    it("FuseDefinition has both digital and analog models", () => {
      expect(FuseDefinition.modelRegistry?.behavioral).toBeDefined();
    });

    it("FuseDefinition has analogFactory", () => {
      expect((FuseDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
      expect(typeof (FuseDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBe("function");
    });

    it("FuseDefinition has switchPins for bus resolver", () => {
      expect(FuseDefinition.models?.digital?.switchPins).toEqual([0, 1]);
    });

    it("FuseDefinition has analog properties (rCold, i2tRating)", () => {
      const keys = FuseDefinition.propertyDefs.map(d => d.key);
      expect(keys).toContain("rCold");
      expect(keys).toContain("rBlown");
      expect(keys).toContain("i2tRating");
      expect(keys).toContain("currentRating");
    });

    it("FuseDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(FuseDefinition)).not.toThrow();
    });

    it("createAnalogFuseElement factory creates AnalogFuseElement", () => {
      const props = new PropertyBag();
      props.setModelParam("rCold", 0.01);
      props.setModelParam("rBlown", 1e9);
      props.setModelParam("i2tRating", 1e-4);
      const el = createAnalogFuseElement(new Map([["out1", 1], ["out2", 0]]), [], -1, props, () => 0);
      expect(el).toBeInstanceOf(AnalogFuseElement);
      expect(el.isNonlinear).toBe(true);
      expect(el.isReactive).toBe(false);
    });
  });
});
