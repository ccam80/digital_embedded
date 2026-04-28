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
  const el = new AnalogFuseElement(
    new Map([["out1", 1], ["out2", 0]]),
    opts.rCold ?? 0.01,
    opts.rBlown ?? 1e9,
    opts.i2tRating ?? 1.0,
    opts.emitDiagnostic,
    opts.onStateChange,
  );
  return el;
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

  describe("resistance_switches_at_threshold", () => {
    it("resistance is rCold below threshold and rBlown at/above threshold", () => {
      // Abrupt model: no smooth blend. At threshold-cross, resistance jumps
      // from rCold to rBlown in one accept(). The engine relies on the
      // breakpoint scheduled by accept() to land exactly on the trip instant
      // so the discontinuity never falls inside an integration step.
      const rCold = 0.01;
      const rBlown = 1e9;
      const i2tRating = 1.0;

      // Below threshold: drive low energy, expect rCold.
      const intactFuse = new AnalogFuseElement(new Map([["out1", 1], ["out2", 0]]), rCold, rBlown, i2tRating);
      intactFuse._pinNodes = new Map([["out1", 1], ["out2", 0]]);
      const lowEnergyV = Math.sqrt(0.5 * i2tRating) * rCold;
      const vLow = new Float64Array(2);
      vLow[1] = lowEnergyV;
      driveFuseStep(intactFuse, 1.0, vLow);
      expect(intactFuse.blown).toBe(false);
      expect(intactFuse.currentResistance).toBe(rCold);

      // At/above threshold: drive enough energy to trip in one step.
      const blownFuse = new AnalogFuseElement(new Map([["out1", 1], ["out2", 0]]), rCold, rBlown, i2tRating);
      blownFuse._pinNodes = new Map([["out1", 1], ["out2", 0]]);
      const highEnergyV = Math.sqrt(2 * i2tRating) * rCold;
      const vHigh = new Float64Array(2);
      vHigh[1] = highEnergyV;
      driveFuseStep(blownFuse, 1.0, vHigh);
      expect(blownFuse.blown).toBe(true);
      expect(blownFuse.currentResistance).toBe(rBlown);
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

      const el = createAnalogFuseElement(new Map([["out1", 1], ["out2", 0]]), props, () => 0) as AnalogFuseElement;

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
      const fuseProps = new PropertyBag();
      fuseProps.setModelParam("rCold", rCold);
      fuseProps.setModelParam("rBlown", 1e9);
      fuseProps.setModelParam("i2tRating", 100.0);
      const fuse = createAnalogFuseElement(new Map([["out1", 1], ["out2", 0]]), fuseProps, () => 0) as AnalogFuseElement;
      // nodeCount=1: branch occupies absolute 1-based row 2 (= nodeCount+1).
      const vsProps = new PropertyBag(); vsProps.setModelParam("voltage", 1.0);
      const vs = makeDcVoltageSource(new Map([["pos", 1], ["neg", 0]]), vsProps, () => 0) as unknown as AnalogElement;

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
      const fuseProps = new PropertyBag();
      fuseProps.setModelParam("rCold", rCold);
      fuseProps.setModelParam("rBlown", 1e9);
      fuseProps.setModelParam("i2tRating", 100.0);
      const fuse = createAnalogFuseElement(new Map([["out1", 1], ["out2", 2]]), fuseProps, () => 0) as AnalogFuseElement;
      // nodeCount=2: branch occupies absolute 1-based row 3 (= nodeCount+1).
      const vsProps2 = new PropertyBag(); vsProps2.setModelParam("voltage", 1.0);
      const vs = makeDcVoltageSource(new Map([["pos", 1], ["neg", 0]]), vsProps2, () => 0) as unknown as AnalogElement;

      const G_load = 1 / rLoad;
      const loadResistor: AnalogElement = {
        _pinNodes: new Map([["pos", 2], ["neg", 0]]),
        branchIndex: -1,
        _stateBase: -1,
        ngspiceLoadOrder: 0,
        label: "",
        setParam(_key: string, _value: number): void {},
        getPinCurrents(_v: Float64Array): number[] { return []; },
        setup(_ctx: import("../../../solver/analog/setup-context.js").SetupContext): void {},
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
    // Abrupt fuse model — un-blown stamps G = 1/rCold (single division, like
    // ngspice resload.c). Bit-exact equality with the closed-form scalar.
    // Nodes: pos=1 → row/col 1, neg=0 (ground, stamps suppressed).
    // makeSimpleCtx already runs _initStructure() in its CKTCircuitContext
    // ctor and then calls setup() to allocate handles; tests must NOT call
    // _initStructure again or the cached handles go stale.
    it("un-blown fuse stamps G=1/rCold bit-exact", () => {
      const rCold = 0.01;
      const rBlown = 1e9;
      const i2tRating = 1e-4;
      const MIN_RESISTANCE = 1e-12;
      const NGSPICE_G_REF = 1 / Math.max(rCold, MIN_RESISTANCE);

      const fuseProps = new PropertyBag();
      fuseProps.setModelParam("rCold", rCold);
      fuseProps.setModelParam("rBlown", rBlown);
      fuseProps.setModelParam("i2tRating", i2tRating);
      const fuse = createAnalogFuseElement(new Map([["out1", 1], ["out2", 0]]), fuseProps, () => 0) as AnalogFuseElement;

      const stampCtx = makeSimpleCtx({
        elements: [fuse as unknown as AnalogElement],
        matrixSize: 1,
        nodeCount: 1,
      });
      stampCtx.solver._resetForAssembly();
      fuse.load(stampCtx.loadCtx as unknown as LoadContext);
      const stamps = stampCtx.solver.getCSCNonZeros();

      const e00 = stamps.find((e) => e.row === 1 && e.col === 1);
      expect(e00).toBeDefined();
      expect(e00!.value).toBe(NGSPICE_G_REF);
    });
  });

  describe("unified FuseDefinition", () => {
    it("FuseDefinition behavioral factory produces AnalogFuseElement that stamps G=1/rCold on diagonal", () => {
      const rCold = 0.1;
      const props = new PropertyBag();
      props.setModelParam("rCold", rCold);
      props.setModelParam("rBlown", 1e9);
      props.setModelParam("i2tRating", 100.0);
      const entry = FuseDefinition.modelRegistry?.behavioral;
      if (!entry || entry.kind !== "inline") throw new Error("Expected inline behavioral entry");
      const el = entry.factory(new Map([["out1", 1], ["out2", 0]]), props, () => 0);
      expect(el).toBeInstanceOf(AnalogFuseElement);

      const stampCtx = makeSimpleCtx({
        elements: [el as unknown as import("../../../solver/analog/element.js").AnalogElement],
        matrixSize: 1,
        nodeCount: 1,
      });
      stampCtx.solver._resetForAssembly();
      el.load(stampCtx.loadCtx as unknown as LoadContext);
      const stamps = stampCtx.solver.getCSCNonZeros();
      const MIN_RESISTANCE = 1e-12;
      const G_expected = 1 / Math.max(rCold, MIN_RESISTANCE);
      const diag = stamps.find((e) => e.row === 1 && e.col === 1);
      expect(diag).toBeDefined();
      expect(diag!.value).toBe(G_expected);
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
      const el = createAnalogFuseElement(new Map([["out1", 1], ["out2", 0]]), props, () => 0);
      expect(el).toBeInstanceOf(AnalogFuseElement);
    });
  });
});
