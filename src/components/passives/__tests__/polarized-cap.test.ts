/**
 * Tests for the PolarizedCap component.
 *
 * Covers:
 *   - DC steady-state leakage current
 *   - ESR dominates initial current spike
 *   - RC time constant with series resistor
 *   - Reverse-bias diagnostic emission
 *   - Forward-bias no diagnostic
 */

import { describe, it, expect } from "vitest";
import {
  PolarizedCapElement,
  PolarizedCapDefinition,
  AnalogPolarizedCapElement,
} from "../polarized-cap.js";
import { PropertyBag } from "../../../core/properties.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { DiagnosticCollector } from "../../../solver/analog/diagnostics.js";
import { solveDcOperatingPoint } from "../../../solver/analog/dc-operating-point.js";
import { DEFAULT_SIMULATION_PARAMS } from "../../../core/analog-engine-interface.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import type { SolverDiagnostic } from "../../../core/analog-engine-interface.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a PolarizedCap analog element for direct testing.
 *
 * Node layout:
 *   n_pos = 1, n_neg = 0 (ground), n_cap = 2
 *
 * This means the MNA matrix has 2 non-ground nodes:
 *   solver index 0 = node 1 (positive terminal)
 *   solver index 1 = node 2 (internal cap node)
 */
function makeCapElement(opts: {
  capacitance: number;
  esr: number;
  rLeak: number;
  reverseMax?: number;
  emitDiagnostic?: (d: SolverDiagnostic) => void;
}): AnalogPolarizedCapElement {
  return new AnalogPolarizedCapElement(
    [1, 0, 2],
    opts.capacitance,
    opts.esr,
    opts.rLeak,
    opts.reverseMax ?? 1.0,
    opts.emitDiagnostic,
  );
}

/**
 * Build a resistor analog element for test use.
 * n_a and n_b are 1-based (0 = ground).
 */
function makeResistorElement(nA: number, nB: number, resistance: number) {
  const G = 1 / resistance;
  return {
    pinNodeIds: [nA, nB] as readonly number[],
    allNodeIds: [nA, nB] as readonly number[],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    stamp(solver: SparseSolver): void {
      if (nA !== 0) solver.stamp(nA - 1, nA - 1, G);
      if (nA !== 0 && nB !== 0) solver.stamp(nA - 1, nB - 1, -G);
      if (nB !== 0 && nA !== 0) solver.stamp(nB - 1, nA - 1, -G);
      if (nB !== 0) solver.stamp(nB - 1, nB - 1, G);
    },
  };
}

// ---------------------------------------------------------------------------
// PolarizedCap tests
// ---------------------------------------------------------------------------

describe("PolarizedCap", () => {
  describe("dc_behaves_as_open_with_leakage", () => {
    it("DC current through capacitor equals V/R_leak in steady state", () => {
      // Circuit: 5V source → polarized cap (pos=node1, neg=ground, cap_internal=node2)
      // Leakage: R_leak = 25V / 1µA = 25MΩ
      // ESR: 0.1Ω (negligible at DC)
      // At DC steady state: cap is open, only leakage path conducts
      // I_leak = V / R_leak = 5 / 25e6 = 200nA
      //
      // MNA layout:
      //   node 1 = voltage source positive terminal (= pos terminal of cap)
      //   node 2 = internal cap node
      //   branch 2 (solver row 2) = voltage source branch
      //   matrixSize = 3 (2 nodes + 1 branch)

      const V = 5;
      const rLeak = 25e6;
      const esr = 0.1;
      const C = 100e-6;

      const vs = makeDcVoltageSource(1, 0, 2, V);
      const cap = makeCapElement({ capacitance: C, esr, rLeak });

      const solver = new SparseSolver();
      const diagnostics = new DiagnosticCollector();

      const result = solveDcOperatingPoint({
        solver,
        elements: [vs, cap],
        matrixSize: 3,
        params: DEFAULT_SIMULATION_PARAMS,
        diagnostics,
      });

      expect(result.converged).toBe(true);

      // At DC: capacitor is open (geq=0, ieq=0), only leakage path conducts
      // V(node1) = 5V (enforced by source)
      expect(result.nodeVoltages[0]).toBeCloseTo(V, 3);

      // Branch current = leakage current through ESR + cap_node path to ground
      // I = V / (ESR + R_leak) ≈ V / R_leak (ESR << R_leak)
      const expectedI = V / (esr + rLeak);
      const branchCurrent = Math.abs(result.nodeVoltages[2]);
      expect(Math.abs(branchCurrent - expectedI) / expectedI).toBeLessThan(0.01);
    });
  });

  describe("esr_adds_series_resistance", () => {
    it("initial current spike is dominated by ESR at t=0", () => {
      // At t=0 (first transient step with very small dt), the capacitor companion
      // has geq = C/dt >> G_leak, so almost all impedance is in ESR.
      // For a step from 0V to V_step, initial current ≈ V_step / ESR.
      //
      // MNA: node1=pos, node0=ground=neg, node2=cap_internal
      // Source: V_step on node1
      // matrixSize = 3

      const V_step = 10;
      const esr = 5.0;        // large ESR for clear measurement
      const C = 100e-6;
      const rLeak = 25e6;

      const vs = makeDcVoltageSource(1, 0, 2, V_step);
      const cap = makeCapElement({ capacitance: C, esr, rLeak });

      // Tiny timestep: geq = C/dt = 100e-6 / 1e-9 = 1e5 >> G_esr
      const dt = 1e-9;
      const initVoltages = new Float64Array([0, 0]);
      cap.stampCompanion(dt, "bdf1", initVoltages);

      const solver = new SparseSolver();
      const diagnostics = new DiagnosticCollector();

      const result = solveDcOperatingPoint({
        solver,
        elements: [vs, cap],
        matrixSize: 3,
        params: DEFAULT_SIMULATION_PARAMS,
        diagnostics,
      });

      expect(result.converged).toBe(true);

      // At t=0 with geq >> G_leak, cap is near short-circuit
      // Most of V_step drops across ESR
      // I ≈ V_step / ESR
      const expectedI = V_step / esr;
      const branchCurrent = Math.abs(result.nodeVoltages[2]);
      expect(Math.abs(branchCurrent - expectedI) / expectedI).toBeLessThan(0.1);
    });
  });

  describe("charges_with_rc_time_constant", () => {
    it("capacitor voltage reaches 63% of step voltage at t ≈ RC", () => {
      // RC circuit: 10µF cap + 1kΩ series resistor, 5V step input
      // Run transient to t = RC = 10ms using BDF-1 (backward Euler).
      // Expected: V(cap_pos) ≈ 5 * (1 - exp(-1)) ≈ 3.161V at t = RC.
      //
      // MNA layout (1-based nodes, 0=ground):
      //   node 1 = voltage source positive terminal
      //   node 2 = junction of R and cap positive terminal
      //   node 3 = cap internal node (between ESR and cap body)
      //   branch 3 (solver row 3) = voltage source branch current
      //   matrixSize = 4 (3 non-ground nodes + 1 voltage source branch)
      //
      // Cap: [nPos=2, nNeg=0(ground), nCap=3]
      // R: node1 ↔ node2
      // Vs: node1 to ground (branchIdx=3 = solver row 3)

      const V_step = 5;
      const R = 1000;
      const C = 10e-6;
      const rLeak = 25e6;
      const esr = 1e-3;     // tiny ESR so internal node is valid
      const RC = R * C;     // 10 ms

      const vs = makeDcVoltageSource(1, 0, 3, V_step);
      const rSeries = makeResistorElement(1, 2, R);
      const cap = new AnalogPolarizedCapElement([2, 0, 3], C, esr, rLeak, 1.0);

      const matrixSize = 4;
      const solver = new SparseSolver();
      let voltages = new Float64Array(matrixSize);

      // Run 500 steps at dt = RC/500 = 20µs using BDF-1 (no ringing on step input)
      const dt = RC / 500;
      const steps = 500;

      for (let step = 0; step < steps; step++) {
        cap.stampCompanion(dt, "bdf1", voltages);

        solver.beginAssembly(matrixSize);
        vs.stamp(solver);
        rSeries.stamp(solver);
        cap.stamp(solver);
        solver.finalize();

        const factorResult = solver.factor();
        if (!factorResult.success) {
          throw new Error(`Singular matrix at step ${step}`);
        }
        solver.solve(voltages);
      }

      // After RC seconds, V(cap_pos = node2, solver index 1) ≈ 5*(1-exp(-1)) ≈ 3.161V
      const vCapPos = voltages[1];
      const expected = V_step * (1 - Math.exp(-1));
      const tolerance = 0.10; // 10% — BDF-1 has first-order error
      expect(Math.abs(vCapPos - expected) / expected).toBeLessThan(tolerance);
    });
  });

  describe("reverse_bias_emits_diagnostic", () => {
    it("emits reverse-biased-cap diagnostic when V(pos) < V(neg) - reverseMax", () => {
      const diagnostics: SolverDiagnostic[] = [];
      const cap = makeCapElement({
        capacitance: 100e-6,
        esr: 0.1,
        rLeak: 25e6,
        reverseMax: 1.0,
        emitDiagnostic: (d) => diagnostics.push(d),
      });

      // Simulate -5V across cap: V(pos)=0, V(neg)=5 → vDiff = -5V < -reverseMax
      const voltages = new Float64Array([0, 5]);
      // pinNodeIds = [1, 0, 2]: n_pos=1 → voltages[0]=0, n_neg=0 (ground)=0
      // Reuse the element with n_neg=ground but apply voltages as if n_pos=-5
      // Build a cap where node 1 = pos (solver idx 0) and ground = neg
      const capReverse = new AnalogPolarizedCapElement(
        [1, 0, 2],
        100e-6,
        0.1,
        25e6,
        1.0,
        (d) => diagnostics.push(d),
      );

      // V(node1) = -5V → reverse biased by 5V
      const voltagesReverse = new Float64Array([-5, 0]);
      capReverse.updateOperatingPoint(voltagesReverse);

      expect(diagnostics.length).toBeGreaterThanOrEqual(1);
      expect(diagnostics[0].code).toBe("reverse-biased-cap");
      expect(diagnostics[0].severity).toBe("warning");
    });
  });

  describe("forward_bias_no_diagnostic", () => {
    it("emits no diagnostic when forward biased", () => {
      const diagnostics: SolverDiagnostic[] = [];
      const cap = new AnalogPolarizedCapElement(
        [1, 0, 2],
        100e-6,
        0.1,
        25e6,
        1.0,
        (d) => diagnostics.push(d),
      );

      // V(node1) = +5V → forward biased
      const voltages = new Float64Array([5, 0]);
      cap.updateOperatingPoint(voltages);

      expect(diagnostics.length).toBe(0);
    });
  });

  describe("definition", () => {
    it("PolarizedCapDefinition name is 'PolarizedCap'", () => {
      expect(PolarizedCapDefinition.name).toBe("PolarizedCap");
    });

    it("PolarizedCapDefinition has analog model", () => {
      expect(PolarizedCapDefinition.models?.analog).toBeDefined();
    });

    it("PolarizedCapDefinition has analogFactory", () => {
      expect(PolarizedCapDefinition.models?.analog?.factory).toBeDefined();
    });

    it("PolarizedCapDefinition getInternalNodeCount returns 1", () => {
      const props = new PropertyBag();
      expect(PolarizedCapDefinition.models?.analog?.getInternalNodeCount!(props)).toBe(1);
    });

    it("PolarizedCapDefinition isReactive", () => {
      const props = new PropertyBag();
      props.set("capacitance", 100e-6);
      const el = PolarizedCapDefinition.models!.analog!.factory(new Map([["pos", 1], ["neg", 0]]), [2], -1, props, () => 0);
      expect(el.isReactive).toBe(true);
    });

    it("PolarizedCapDefinition isNonlinear", () => {
      const props = new PropertyBag();
      const el = PolarizedCapDefinition.models!.analog!.factory(new Map([["pos", 1], ["neg", 0]]), [2], -1, props, () => 0);
      expect(el.isNonlinear).toBe(true);
    });

    it("PolarizedCapElement can be instantiated", () => {
      const props = new PropertyBag();
      props.set("capacitance", 100e-6);
      const el = new PolarizedCapElement(
        "test-id",
        { x: 0, y: 0 },
        0,
        false,
        props,
      );
      expect(el).toBeDefined();
    });
  });
});
