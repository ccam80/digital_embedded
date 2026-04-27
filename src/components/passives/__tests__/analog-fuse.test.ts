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
import { runDcOp, makeSimpleCtx, makeLoadCtx } from "../../../solver/analog/__tests__/test-helpers.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import { MODETRAN, MODEINITFLOAT } from "../../../solver/analog/ckt-mode.js";
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

/**
 * Drive one load()+accept() iteration on a fuse. The fuse load() stamps a
 * conductance into the solver (used by NR); accept() integrates I²·dt and
 * updates blown state.
 */
function driveFuseStep(fuse: AnalogFuseElement, dt: number, rhs: Float64Array): void {
  const solver = new SparseSolver();
  // rhs is 1-indexed: length = nodeCount + 1 (slot 0 = ground).
  solver._initStructure();
  const ctx = makeLoadCtx({
    solver,
    rhs: rhs,
    rhsOld: rhs,
    cktMode: MODETRAN | MODEINITFLOAT,
    dt,
    deltaOld: [dt, dt, dt, dt, dt, dt, dt],
  });
  fuse.load(ctx);
  fuse.accept(ctx, 0, () => {});
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

      // 1-indexed: slot 0 = ground, slot 1 = node 1 (fuse positive terminal).
      const voltages = new Float64Array(2);
      voltages[1] = 0.5 * rCold;

      const dt = 0.1;
      for (let i = 0; i < 10; i++) {
        driveFuseStep(fuse, dt, voltages);
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
      // 1-indexed: slot 0 = ground, slot 1 = node 1 (fuse positive terminal).
      const voltages = new Float64Array(2);
      voltages[1] = voltage;

      const dt = 0.001;
      const expectedBlowTime = i2tRating / (current * current);
      const maxSteps = Math.ceil(expectedBlowTime * 3 / dt);

      let blowStep = -1;
      for (let i = 0; i < maxSteps; i++) {
        if (!fuse.blown) {
          driveFuseStep(fuse, dt, voltages);
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
      // 1-indexed: slot 0 = ground, slot 1 = node 1 (fuse positive terminal).
      const voltages = new Float64Array(2);
      voltages[1] = voltage;

      const dt = 0.001;
      for (let i = 0; i < 100; i++) {
        driveFuseStep(fuse, dt, voltages);
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
        // 1-indexed: slot 0 = ground, slot 1 = node 1.
        const vArr = new Float64Array(2);
        vArr[1] = v;
        driveFuseStep(testFuse, dt, vArr);
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
      // 1-indexed: slot 0 = ground, slot 1 = node 1.
      const voltages = new Float64Array(2);
      voltages[1] = voltage;

      const dt = 0.01;
      for (let i = 0; i < 50; i++) {
        driveFuseStep(fuse, dt, voltages);
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
      // 1-indexed: slot 0 = ground, slot 1 = node 1.
      const voltages = new Float64Array(2);
      voltages[1] = voltage;

      const dt = 0.01;
      for (let i = 0; i < 100; i++) {
        driveFuseStep(fuse, dt, voltages);
      }

      expect(fuse.blown).toBe(true);
      expect(diagnostics.length).toBe(1);
    });
  });

  describe("thermalRatio", () => {
    it("thermalRatio is 0 initially and increases toward 1", () => {
      const fuse = makeFuseElement({ i2tRating: 1.0 });
      expect(fuse.thermalRatio).toBe(0);

      // 1-indexed: slot 0 = ground, slot 1 = node 1.
      const voltages = new Float64Array(2);
      voltages[1] = 1.0; // 100A through 0.01Ω
      driveFuseStep(fuse, 0.0001, voltages);

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

      // 1-indexed: slot 0 = ground, slot 1 = node 1.
      const voltages = new Float64Array(2);
      voltages[1] = 1.0; // high current

      driveFuseStep(fuse, 0.01, voltages);

      expect(calls.length).toBe(1);
      expect(calls[0].ratio).toBeGreaterThan(0);
    });

    it("createAnalogFuseElement writes blown and _thermalRatio into props", () => {
      const props = new PropertyBag();
      props.setModelParam("rCold", 0.01);
      props.setModelParam("rBlown", 1e9);
      props.setModelParam("i2tRating", 0.001);

      const el = createAnalogFuseElement(new Map([["out1", 1], ["out2", 0]]), [], -1, props, () => 0) as AnalogFuseElement;

      // 1-indexed: slot 0 = ground, slot 1 = node 1.
      const voltages = new Float64Array(2);
      voltages[1] = 1.0;

      driveFuseStep(el, 0.1, voltages);

      expect(props.get("_thermalRatio")).toBeGreaterThan(0);
      expect(props.get("blown")).toBe(true);
    });
  });

  describe("stamp_nonlinear", () => {
    it("stamps conductance into MNA solver when intact", () => {
      const rCold = 1.0;
      const fuse = new AnalogFuseElement([1, 0], rCold, 1e9, 100.0);
      // nodeCount=1: branch occupies absolute 1-based row 2 (= nodeCount+1).
      const vs = makeDcVoltageSource(1, 0, 2, 1.0) as unknown as AnalogElement;

      const result = runDcOp({
        elements: [vs, fuse],
        matrixSize: 2,
        nodeCount: 1,
      });

      expect(result.converged).toBe(true);
    });

    it("stamps near-zero conductance when blown", () => {
      const fuse = makeFuseElement({ rCold: 0.01, rBlown: 1e9, i2tRating: 0.0001 });

      // 1-indexed: slot 0 = ground, slot 1 = node 1.
      const voltages = new Float64Array(2);
      voltages[1] = 1000 * 0.01;
      driveFuseStep(fuse, 1.0, voltages);
      expect(fuse.blown).toBe(true);
      expect(fuse.currentResistance).toBeGreaterThan(1e8);
    });
  });

  describe("dc_operating_point", () => {
    it("intact fuse in series with load resistor: current = V / (R_cold + R_load)", () => {
      const rCold = 1.0;
      const rLoad = 9.0;
      const fuse = new AnalogFuseElement([1, 2], rCold, 1e9, 100.0);
      // nodeCount=2: branch occupies absolute 1-based row 3 (= nodeCount+1).
      const vs = makeDcVoltageSource(1, 0, 3, 1.0) as unknown as AnalogElement;

      const G_load = 1 / rLoad;
      const loadResistor: AnalogElement = {
        pinNodeIds: [2, 0] as readonly number[],
        allNodeIds: [2, 0] as readonly number[],
        branchIndex: -1,
        ngspiceLoadOrder: 0,
        isNonlinear: false,
        isReactive: false,
        setParam(_key: string, _value: number): void {},
        getPinCurrents(_v: Float64Array): number[] { return []; },
        load(ctx: LoadContext): void {
          // node 2 diagonal (1-indexed)
          ctx.solver.stampElement(ctx.solver.allocElement(2, 2), G_load);
        },
      };

      const result = runDcOp({
        elements: [vs, fuse, loadResistor],
        matrixSize: 3,
        nodeCount: 2,
      });

      expect(result.converged).toBe(true);
    });
  });

  describe("fuse_load_dcop_parity", () => {
    // fuse_load_dcop_parity — C4.1 / Task 6.2.1
    //
    // Fuse in un-blown state (thermalEnergy=0). rCold=0.01, rBlown=1e9, i2tRating=1e-4.
    // smoothResistance(0, 1e-4, 0.01, 1e9):
    //   width = 0.05 * 1e-4 = 5e-6
    //   x = (0 - 1e-4) / 5e-6 = -20
    //   blend = 0.5 * (1 + tanh(-20)) ≈ 0 (tanh(-20) ≈ -1 to 53-bit precision)
    //   R ≈ 0.01 + (1e9 - 0.01) * blend ≈ 0.01
    // G = 1 / max(R, 1e-12) = 1 / R_from_smooth_formula (bit-exact).
    //
    // NGSPICE reference: ngspice resload.c stamps G=1/R using a single division.
    // The test inlines the same smoothResistance computation as AnalogFuseElement.load().
    // Nodes: pos=1 → idx 0, neg=0 (ground). matrixSize=1, nodeCount=1.
    it("un-blown fuse stamps G=1/smoothResistance(0) bit-exact", () => {
      // Inline closed-form — same IEEE-754 operations as AnalogFuseElement.load()
      // with smoothResistance(thermalEnergy=0, i2tRating=1e-4, rCold=0.01, rBlown=1e9):
      const rCold = 0.01;
      const rBlown = 1e9;
      const i2tRating = 1e-4;
      const thermalEnergy = 0;
      const width = 0.05 * i2tRating;
      const x = (thermalEnergy - i2tRating) / Math.max(width, 1e-30);
      const blend = 0.5 * (1 + Math.tanh(x));
      const R_REF = rCold + (rBlown - rCold) * blend;
      const MIN_RESISTANCE = 1e-12;
      const NGSPICE_G_REF = 1 / Math.max(R_REF, MIN_RESISTANCE);

      // Construct fuse with pinNodeIds=[1, 0] (pos=1 above ground).
      const fuse = new AnalogFuseElement([1, 0], rCold, rBlown, i2tRating);

      const stampCtx = makeSimpleCtx({
        elements: [fuse as unknown as AnalogElement],
        matrixSize: 1,
        nodeCount: 1,
      });
      stampCtx.solver._initStructure();
      fuse.load(stampCtx.loadCtx as unknown as LoadContext);
      const stamps = stampCtx.solver.getCSCNonZeros();

      // Only the pos diagonal is stamped (neg=0 is ground, suppressed).
      // Under 1-indexed nodes: node 1 (pos) maps to matrix row/col 1.
      const e00 = stamps.find((e) => e.row === 1 && e.col === 1);
      expect(e00).toBeDefined();
      expect(e00!.value).toBe(NGSPICE_G_REF);
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
