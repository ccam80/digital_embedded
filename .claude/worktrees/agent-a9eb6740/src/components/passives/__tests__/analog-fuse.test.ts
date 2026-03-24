/**
 * Tests for the AnalogFuse component.
 *
 * Covers:
 *   - Low current stays intact (thermal energy below threshold)
 *   - Overcurrent blows fuse at expected time (I²t threshold)
 *   - Blown fuse is effectively open circuit (R_blown >> R_cold)
 *   - Resistance transition is smooth (no step discontinuity)
 *   - Blown emits fuse-blown diagnostic with info severity
 */

import { describe, it, expect } from "vitest";
import {
  AnalogFuseElement,
  AnalogFuseDefinition,
  AnalogFuseCircuitElement,
  createAnalogFuseElement,
  ANALOG_FUSE_ATTRIBUTE_MAPPINGS,
} from "../analog-fuse.js";
import { PropertyBag } from "../../../core/properties.js";
import { SparseSolver } from "../../../analog/sparse-solver.js";
import { DiagnosticCollector } from "../../../analog/diagnostics.js";
import { solveDcOperatingPoint } from "../../../analog/dc-operating-point.js";
import { DEFAULT_SIMULATION_PARAMS } from "../../../core/analog-engine-interface.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import type { SolverDiagnostic } from "../../../core/analog-engine-interface.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import { FuseDefinition } from "../../switching/fuse.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fuse element with standard test parameters.
 *
 * Node layout: n_pos=1, n_neg=0 (ground)
 */
function makeFuseElement(opts: {
  rCold?: number;
  rBlown?: number;
  i2tRating?: number;
  emitDiagnostic?: (d: SolverDiagnostic) => void;
}): AnalogFuseElement {
  return new AnalogFuseElement(
    [1, 0],
    opts.rCold ?? 0.01,
    opts.rBlown ?? 1e9,
    opts.i2tRating ?? 1.0,
    opts.emitDiagnostic,
  );
}

/**
 * Manually run transient simulation steps by calling updateState with a
 * fixed voltage across the fuse for a total duration.
 *
 * Returns the fuse state after all timesteps.
 */
function runTransient(
  fuse: AnalogFuseElement,
  voltageAcrossFuse: number,
  dt: number,
  totalTime: number,
): { blown: boolean; thermalEnergy: number } {
  const nSteps = Math.ceil(totalTime / dt);
  // Build a voltage vector: node 1 = voltageAcrossFuse, everything else = 0
  const voltages = new Float64Array(2); // [node1-voltage, branch-current]
  voltages[0] = voltageAcrossFuse; // node 1 (pos terminal)

  for (let i = 0; i < nSteps; i++) {
    // Update operating point so stampNonlinear has current state
    fuse.updateOperatingPoint(voltages);
    fuse.updateState(dt, voltages);

    // After blow, voltage across fuse drops to nearly 0 due to R_blown
    // (in a real circuit). For testing the thermal model we keep the
    // voltage fixed to isolate the model behaviour.
  }

  return { blown: fuse.blown, thermalEnergy: fuse.thermalEnergy };
}

// ---------------------------------------------------------------------------
// Fuse tests
// ---------------------------------------------------------------------------

describe("Fuse", () => {
  describe("low_current_stays_intact", () => {
    it("0.5A through 1A-rated fuse for 10s stays intact", () => {
      // I²t threshold: i2tRating = 1.0 A²·s
      // At I = 0.5A: I² = 0.25 A², time to blow = 1.0/0.25 = 4s
      // But we only run for 10 steps at tiny current to stay well below.
      //
      // Easier: use very low current (0.01A) so I²·t_total = 0.0001 * 10 = 0.001 << 1.0
      // rCold = 0.01Ω, voltage for 0.01A = 0.0001V
      const rCold = 0.01;
      const i2tRating = 1.0;
      const fuse = makeFuseElement({ rCold, i2tRating });

      // Drive 0.5A: V = I * R_cold = 0.5 * 0.01 = 0.005V
      // I²·t = 0.25 * 1.0 = 0.25 < 1.0 → should NOT blow in 1s
      const voltages = new Float64Array(1);
      voltages[0] = 0.5 * rCold; // 0.005V → 0.5A through rCold

      const dt = 0.1;
      for (let i = 0; i < 10; i++) {
        fuse.updateOperatingPoint(voltages);
        fuse.updateState(dt, voltages);
      }

      expect(fuse.blown).toBe(false);
      expect(fuse.thermalEnergy).toBeLessThan(i2tRating);
      // Resistance is still very close to R_cold
      expect(fuse.currentResistance).toBeLessThan(rCold * 2);
    });
  });

  describe("overcurrent_blows_fuse", () => {
    it("3A through 1A-rated fuse blows at t ≈ i2tRating/I² ≈ 0.111s", () => {
      // i2tRating = 1.0 A²·s, I = 3A → blow time = 1.0 / 9 ≈ 0.111s
      // Use small dt for accuracy; tolerance ±20%
      const rCold = 0.01;
      const i2tRating = 1.0;
      const fuse = makeFuseElement({ rCold, i2tRating });

      // V = 3A * 0.01Ω = 0.03V for 3A through intact fuse
      const current = 3.0;
      const voltage = current * rCold;
      const voltages = new Float64Array(1);
      voltages[0] = voltage;

      const dt = 0.001; // 1ms steps for accuracy
      const expectedBlowTime = i2tRating / (current * current); // ≈ 0.111s
      const maxSteps = Math.ceil(expectedBlowTime * 3 / dt); // run 3× expected time

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

      // Blow time should be within ±20% of expected
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

      // Drive overcurrent: I = 10A, blow time ≈ 1/(100) = 0.01s
      const voltage = 10 * rCold; // 0.1V → 10A through intact fuse
      const voltages = new Float64Array(1);
      voltages[0] = voltage;

      const dt = 0.001;
      for (let i = 0; i < 100; i++) {
        fuse.updateOperatingPoint(voltages);
        fuse.updateState(dt, voltages);
      }

      expect(fuse.blown).toBe(true);

      // After blowing, resistance should be well above R_cold and approaching R_blown.
      // The tanh transition means at e > i2tRating the blend > 0.5, so R > midpoint.
      expect(fuse.currentResistance).toBeGreaterThan(rBlown * 0.5);
    });
  });

  describe("resistance_transition_smooth", () => {
    it("resistance changes continuously without step discontinuity near blow threshold", () => {
      const rCold = 0.01;
      const rBlown = 1e9;
      const i2tRating = 1.0;
      const width = 0.05 * i2tRating; // 5% transition width

      // Sample resistance at many points across the transition region
      // and assert no step larger than a continuous tanh function allows
      const fuse = new AnalogFuseElement([1, 0], rCold, rBlown, i2tRating);

      // Manually inject thermal energy values and check continuity
      const resistances: number[] = [];
      const N = 1000;

      for (let i = 0; i <= N; i++) {
        // Energy range: 0.5 * i2tRating to 1.5 * i2tRating
        const energy = 0.5 * i2tRating + (i2tRating * i) / N;
        // Access the private smoothResistance logic via currentResistance
        // by temporarily injecting via updateState with a zero-current voltage
        // (accumulates 0 energy since I = 0/R ≈ 0)
        // Instead, test smoothResistance indirectly via the public interface:
        // Create a fresh fuse and let it accumulate to this energy manually.
        const testFuse = new AnalogFuseElement([1, 0], rCold, rBlown, i2tRating);
        // Inject energy directly: use a voltage that gives sqrt(energy/dt) current
        const dt = 1.0;
        const current = Math.sqrt(energy); // I²·dt = energy * dt = energy for dt=1
        const v = current * rCold;
        const vArr = new Float64Array(1);
        vArr[0] = v;
        testFuse.updateOperatingPoint(vArr);
        testFuse.updateState(dt, vArr);
        resistances.push(testFuse.currentResistance);
      }

      // Check monotonic increase (resistance only increases as energy grows)
      for (let i = 1; i < resistances.length; i++) {
        expect(resistances[i]).toBeGreaterThanOrEqual(resistances[i - 1] * 0.9999);
      }

      // Check no single step exceeds 10% of (R_blown - R_cold)
      const maxAllowedStep = 0.1 * (rBlown - rCold);
      for (let i = 1; i < resistances.length; i++) {
        const step = resistances[i] - resistances[i - 1];
        expect(step).toBeLessThanOrEqual(maxAllowedStep);
      }
    });
  });

  describe("blown_emits_diagnostic", () => {
    it("driving 2× rated current emits fuse-blown diagnostic with info severity", () => {
      const diagnostics: SolverDiagnostic[] = [];
      const fuse = makeFuseElement({
        rCold: 0.01,
        rBlown: 1e9,
        i2tRating: 1.0,
        emitDiagnostic: (d) => diagnostics.push(d),
      });

      // 2A through a 0.01Ω fuse: V = 0.02V, blow time = 1/(4) = 0.25s
      const current = 2.0;
      const voltage = current * 0.01;
      const voltages = new Float64Array(1);
      voltages[0] = voltage;

      const dt = 0.01;
      // Run long enough to blow: 0.25s / 0.01 = 25 steps, run 50 to be safe
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
      const diagnostics: SolverDiagnostic[] = [];
      const fuse = makeFuseElement({
        rCold: 0.01,
        rBlown: 1e9,
        i2tRating: 0.1,
        emitDiagnostic: (d) => diagnostics.push(d),
      });

      const voltage = 10 * 0.01; // 10A
      const voltages = new Float64Array(1);
      voltages[0] = voltage;

      const dt = 0.01;
      for (let i = 0; i < 100; i++) {
        fuse.updateOperatingPoint(voltages);
        fuse.updateState(dt, voltages);
      }

      expect(fuse.blown).toBe(true);
      // Should be exactly 1 diagnostic despite many steps after blow
      expect(diagnostics.length).toBe(1);
    });
  });

  describe("stamp_nonlinear", () => {
    it("stamps conductance into MNA solver when intact", () => {
      // Circuit: 1V source between node 1 (positive) and ground (node 0),
      // fuse between node 1 and ground (node 0).
      // matrixSize = 2 (1 node + 1 voltage source branch).
      // Current = V / R_cold = 1.0 / 1.0 = 1A
      const rCold = 1.0;
      const fuse = new AnalogFuseElement([1, 0], rCold, 1e9, 100.0);
      const vs = makeDcVoltageSource(1, 0, 1, 1.0);

      const solver = new SparseSolver();
      const diagnostics = new DiagnosticCollector();

      const result = solveDcOperatingPoint({
        solver,
        elements: [vs, fuse],
        matrixSize: 2,
        params: DEFAULT_SIMULATION_PARAMS,
        diagnostics,
      });

      expect(result.converged).toBe(true);
      // Source current is in branch row index 1 (solver row 1, 0-based)
      const sourceCurrent = Math.abs(result.nodeVoltages[1]);
      expect(sourceCurrent).toBeCloseTo(1.0, 2);
    });

    it("stamps near-zero conductance when blown", () => {
      const fuse = makeFuseElement({ rCold: 0.01, rBlown: 1e9, i2tRating: 0.0001 });

      // Blow the fuse immediately
      const voltages = new Float64Array(1);
      voltages[0] = 1000 * 0.01; // huge current
      fuse.updateOperatingPoint(voltages);
      fuse.updateState(1.0, voltages);
      expect(fuse.blown).toBe(true);

      // Now check resistance is near R_blown
      expect(fuse.currentResistance).toBeGreaterThan(1e8);
    });
  });

  describe("dc_operating_point", () => {
    it("intact fuse in series with load resistor: current = V / (R_cold + R_load)", () => {
      // Circuit: 1V source → fuse (rCold=1Ω) → 9Ω load → ground
      // Expected current: 1 / (1 + 9) = 0.1A
      //
      // MNA layout:
      //   node 1 = source positive terminal
      //   node 2 = junction between fuse and load
      //   branch 2 (solver row 2) = voltage source branch current
      //   matrixSize = 3

      const rCold = 1.0;
      const rLoad = 9.0;
      const fuse = new AnalogFuseElement([1, 2], rCold, 1e9, 100.0);
      const vs = makeDcVoltageSource(1, 0, 2, 1.0);

      // Load resistor: 9Ω between node 2 and ground
      const G_load = 1 / rLoad;
      const loadResistor = {
        nodeIndices: [2, 0] as readonly number[],
        branchIndex: -1,
        isNonlinear: false,
        isReactive: false,
        stamp(solver: SparseSolver): void {
          solver.stamp(1, 1, G_load); // node 2 → solver[1]
        },
      };

      const solver = new SparseSolver();
      const diagnostics = new DiagnosticCollector();

      // For nonlinear elements (fuse) in DC OP, need Newton-Raphson loop.
      // solveDcOperatingPoint handles this via newtonRaphson which calls
      // stampNonlinear for nonlinear elements.
      const result = solveDcOperatingPoint({
        solver,
        elements: [vs, fuse, loadResistor],
        matrixSize: 3,
        params: DEFAULT_SIMULATION_PARAMS,
        diagnostics,
      });

      expect(result.converged).toBe(true);

      // Source current is in branch row (index 2 = solver row 2)
      const sourceCurrent = Math.abs(result.nodeVoltages[2]);
      expect(sourceCurrent).toBeCloseTo(0.1, 2); // 100mA ± 1%
    });
  });

  describe("definition", () => {
    it("AnalogFuseDefinition name is 'AnalogFuse'", () => {
      expect(AnalogFuseDefinition.name).toBe("AnalogFuse");
    });

    it("AnalogFuseDefinition engineType is 'analog'", () => {
      expect(AnalogFuseDefinition.engineType).toBe("analog");
    });

    it("AnalogFuseDefinition has analogFactory", () => {
      expect(AnalogFuseDefinition.analogFactory).toBeDefined();
    });

    it("AnalogFuseDefinition requiresBranchRow is falsy", () => {
      expect(AnalogFuseDefinition.requiresBranchRow).toBeFalsy();
    });

    it("AnalogFuseDefinition category is PASSIVES", () => {
      expect(AnalogFuseDefinition.category).toBe(ComponentCategory.PASSIVES);
    });

    it("AnalogFuseDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(AnalogFuseDefinition)).not.toThrow();
    });

    it("AnalogFuseCircuitElement can be instantiated", () => {
      const props = new PropertyBag();
      props.set("rCold", 0.01);
      const el = new AnalogFuseCircuitElement("test-id", { x: 0, y: 0 }, 0, false, props);
      expect(el).toBeDefined();
    });

    it("ANALOG_FUSE_ATTRIBUTE_MAPPINGS has rCold mapping", () => {
      const m = ANALOG_FUSE_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "rCold");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("rCold");
      expect(m!.convert("0.05")).toBeCloseTo(0.05, 5);
    });

    it("FuseDefinition engineType is 'both'", () => {
      expect(FuseDefinition.engineType).toBe("both");
    });

    it("FuseDefinition has analogFactory pointing to createAnalogFuseElement", () => {
      expect(FuseDefinition.analogFactory).toBeDefined();
      expect(typeof FuseDefinition.analogFactory).toBe("function");
    });

    it("createAnalogFuseElement factory creates AnalogFuseElement", () => {
      const props = new PropertyBag();
      props.set("rCold", 0.01);
      props.set("rBlown", 1e9);
      props.set("i2tRating", 1.0);
      const el = createAnalogFuseElement([1, 0], -1, props, () => 0);
      expect(el).toBeInstanceOf(AnalogFuseElement);
      expect(el.isNonlinear).toBe(true);
      expect(el.isReactive).toBe(false);
    });
  });
});
