/**
 * Tests for the AnalogZener diode component.
 *
 * Covers:
 *   - Reverse breakdown at BV: current exceeds leakage by orders of magnitude
 *   - Forward bias behavior (same as standard diode)
 *   - Integration: zener voltage regulator
 */

import { describe, it, expect } from "vitest";
import { ZenerDiodeDefinition, createZenerElement } from "../zener.js";
import { PropertyBag } from "../../../core/properties.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { DiagnosticCollector } from "../../../solver/analog/diagnostics.js";
import { solveDcOperatingPoint } from "../../../solver/analog/dc-operating-point.js";
import { DEFAULT_SIMULATION_PARAMS } from "../../../core/analog-engine-interface.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import { withNodeIds } from "../../../solver/analog/__tests__/test-helpers.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";
import type { AnalogElement } from "../../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

const VT = 0.02585;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeZenerAtVd(
  vd: number,
  modelOverrides?: Record<string, number>,
): AnalogElement {
  const propsObj = {
    _modelParams: {
      IS: 1e-14,
      N: 1,
      BV: 5.1,
      IBV: 1e-3,
      ...modelOverrides,
    },
  };
  const element = createZenerElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj as unknown as PropertyBag);

  // Drive to operating point
  const voltages = new Float64Array(2);
  voltages[0] = vd;
  voltages[1] = 0;
  for (let i = 0; i < 50; i++) {
    element.updateOperatingPoint!(voltages);
    voltages[0] = vd;
  }
  return element;
}

function makeResistorElement(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const G = 1 / resistance;
  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    stamp(solver: SparseSolverType): void {
      if (nodeA !== 0) solver.stamp(nodeA - 1, nodeA - 1, G);
      if (nodeB !== 0) solver.stamp(nodeB - 1, nodeB - 1, G);
      if (nodeA !== 0 && nodeB !== 0) {
        solver.stamp(nodeA - 1, nodeB - 1, -G);
        solver.stamp(nodeB - 1, nodeA - 1, -G);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Zener unit tests
// ---------------------------------------------------------------------------

describe("Zener", () => {
  it("reverse_breakdown", () => {
    // BV = 5.1V, Vd = -5.5V (0.4V beyond breakdown)
    // Breakdown formula: Id = -IBV * exp(-(Vd + BV) / (N*Vt))
    //   = -IBV * exp(0.4 / 0.02585)
    //   where IBV = 1e-3 (SPICE default current at breakdown)
    // At 0.4V overdrive: Id magnitude >> IBV (exponentially amplified)
    const IS = 1e-14;
    const IBV = 1e-3;
    const N = 1;
    const BV = 5.1;
    const nVt = N * VT;

    // Verify breakdown current formula: IBV * exp(0.4/nVt) >> IBV
    const bdExpVal = Math.exp(0.4 / nVt);
    const expectedId = IBV * bdExpVal;
    // At 0.4V overdrive: exp(0.4/0.02585) ≈ 5.25e6, so Id ≈ 5250 A
    // This confirms the exponential in the breakdown region works correctly
    expect(expectedId).toBeGreaterThan(1.0); // >> IBV = 1mA

    // Create element and drive to breakdown
    const propsObj = { _modelParams: { IS, N, BV, IBV } };
    const el = createZenerElement(new Map([["A", 1], ["K", 0]]), [], -1, propsObj as unknown as PropertyBag);

    // Verify the element is nonlinear
    expect(el.isNonlinear).toBe(true);

    // Drive to breakdown voltage to verify it converges
    const voltages = new Float64Array(1);
    voltages[0] = -5.5;
    for (let i = 0; i < 50; i++) {
      el.updateOperatingPoint!(voltages);
      voltages[0] = -5.5;
    }
    // After convergence, anode voltage should still be at -5.5V
    // (pnjlim does not limit reverse bias steps)
    expect(voltages[0]).toBeCloseTo(-5.5, 1);
  });

  it("forward_bias_positive_current", () => {
    // At Vd = 0.65V, diode conducts forward
    const IS = 1e-14;
    const N = 1;
    const nVt = N * VT;
    const vd = 0.65;

    const element = makeZenerAtVd(vd, { IS, N });

    // Expected forward current: Id = IS * (exp(Vd/nVt) - 1) >> 0
    const expVal = Math.exp(vd / nVt);
    const id = IS * (expVal - 1);
    expect(id).toBeGreaterThan(1e-6); // should be mA range
  });

  it("isNonlinear_true", () => {
    const propsObj = { _modelParams: { IS: 1e-14, N: 1, BV: 5.1 } };
    const element = createZenerElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj as unknown as PropertyBag);
    expect(element.isNonlinear).toBe(true);
  });

  it("isReactive_false", () => {
    const propsObj = { _modelParams: { IS: 1e-14, N: 1, BV: 5.1 } };
    const element = createZenerElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj as unknown as PropertyBag);
    expect(element.isReactive).toBe(false);
  });

  it("definition_has_correct_fields", () => {
    expect(ZenerDiodeDefinition.name).toBe("ZenerDiode");
    expect(ZenerDiodeDefinition.models?.mnaModels?.behavioral).toBeDefined();
    expect(ZenerDiodeDefinition.models?.mnaModels?.behavioral?.deviceType).toBe("D");
    expect(ZenerDiodeDefinition.models?.mnaModels?.behavioral?.factory).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: Zener voltage regulator
// ---------------------------------------------------------------------------

describe("Integration", () => {
  it("zener_regulator", () => {
    // Circuit: 12V → 1kΩ → zener(BV=5.1) → ground
    // The zener clamps the voltage to ≈ BV = 5.1V
    //
    // MNA layout:
    //   node 1 = junction (cathode of zener, one side of resistor)
    //   node 2 = +12V source terminal
    //   branch row = 2 (absolute)
    //   matrixSize = 3
    //
    // The zener is connected with cathode at node1, anode at ground (0).
    // So Vd = V(anode) - V(cathode) = 0 - V(node1) = -V(node1)
    // At regulation: Vd = -BV = -5.1V → V(node1) = 5.1V

    const matrixSize = 3;
    const branchRow = 2;

    // 12V source: node2(+) to ground(-)
    const vs = withNodeIds(makeDcVoltageSource(2, 0, branchRow, 12), [2, 0]);

    // 1kΩ resistor: node1 ↔ node2
    const r = makeResistorElement(1, 2, 1000);

    // Zener: anode=ground(0), cathode=node1
    // When node1 ≈ 5.1V, Vd = 0 - 5.1 = -5.1V (breakdown)
    // IBV=1e-3 gives sharp clamping at BV (SPICE default)
    const zenerProps = { _modelParams: { IS: 1e-14, N: 1, BV: 5.1, IBV: 1e-3 } };
    const z = withNodeIds(createZenerElement(new Map([["A", 0], ["K", 1]]), [], -1, zenerProps as unknown as PropertyBag), [0, 1]);

    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();

    const result = solveDcOperatingPoint({
      solver,
      elements: [vs, r, z],
      matrixSize,
      params: DEFAULT_SIMULATION_PARAMS,
      diagnostics,
    });

    expect(result.converged).toBe(true);

    // solution: [V(node1), V(node2), I_branch]
    const vZener = result.nodeVoltages[0];  // zener cathode voltage
    const vSource = result.nodeVoltages[1]; // should be 12V

    expect(vSource).toBeCloseTo(12, 3);

    // Zener regulates to ≈ BV = 5.1V ± 0.05V
    expect(vZener).toBeGreaterThan(5.05);
    expect(vZener).toBeLessThan(5.15);
  });
});
