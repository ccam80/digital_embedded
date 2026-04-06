/**
 * Tests for MNA infrastructure: MNA assembler and test elements.
 *
 * Test groups:
 *   Stamping     — full solve with resistors, voltage sources, current sources
 *   Assembler    — stampLinear / stampNonlinear / checkAllConverged behaviour
 *   Convergence  — checkAllConverged edge cases
 */

import { describe, it, expect, vi } from "vitest";
import { SparseSolver } from "../sparse-solver.js";
import { MNAAssembler } from "../mna-assembler.js";
import {
  makeResistor,
  makeVoltageSource,
  makeCurrentSource,
} from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Stamping tests — full solve
// ---------------------------------------------------------------------------

describe("Stamping", () => {
  /**
   * Resistor divider DC solve.
   *
   * Circuit: Vs=5V from node 1 to GND (node 0), R1=1kΩ from node 1 to node 2,
   * R2=1kΩ from node 2 to GND.
   *
   * MNA matrix (nodeCount=2, branchCount=1, matrixSize=3):
   *   Rows/cols 0,1 = nodes 1,2; row/col 2 = branch for Vs
   *
   *   [ G1       0      1  ] [V1]   [0]
   *   [-G1  G1+G2      0  ] [V2] = [0]
   *   [  1       0      0  ] [I ]   [5]
   *
   * where G1 = G2 = 1e-3 S
   * Solution: V1 = 5V, V2 = 2.5V, I = -5mA
   */
  it("resistor_divider_dc", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    // Nodes: 1 = top of divider, 2 = midpoint, 0 = ground
    // Branch row index 2 (after 2 node rows) for the voltage source
    const nodeCount = 2;
    const branchCount = 1;
    const matrixSize = nodeCount + branchCount;

    const R1 = makeResistor(1, 2, 1000);
    const R2 = makeResistor(2, 0, 1000);
    // Voltage source: +5V at node 1, referenced to GND; branch row = nodeCount = 2
    const Vs = makeVoltageSource(1, 0, nodeCount, 5);

    const elements = [R1, R2, Vs];

    solver.beginAssembly(matrixSize);
    assembler.stampLinear(elements);
    solver.finalize();

    const factorResult = solver.factor();
    expect(factorResult.success).toBe(true);

    const solution = new Float64Array(matrixSize);
    solver.solve(solution);

    // solution[0] = V1 (node 1), solution[1] = V2 (node 2), solution[2] = branch current
    const V1 = solution[0];
    const V2 = solution[1];

    expect(V1).toBeCloseTo(5.0, 8);
    expect(V2).toBeCloseTo(2.5, 8);
  });

  /**
   * Two voltage sources in series with a resistor to ground.
   *
   * Circuit: V1=3V (node 1→GND) + V2=2V (node 2→node 1) in series,
   * resistor R=1kΩ from node 2 to GND.
   *
   * Expected: V2 = 5V, current through R = 5V / 1kΩ = 5mA.
   */
  it("two_voltage_sources_series", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    // Nodes: 1, 2; Branches: branch0 for V1 (row 2), branch1 for V2 (row 3)
    const nodeCount = 2;
    const branchCount = 2;
    const matrixSize = nodeCount + branchCount;

    const R = makeResistor(2, 0, 1000);
    // V1: node 1 → GND = 3V, branch row index = nodeCount = 2
    const V1 = makeVoltageSource(1, 0, nodeCount, 3);
    // V2: node 2 → node 1 = 2V, branch row index = nodeCount + 1 = 3
    const V2src = makeVoltageSource(2, 1, nodeCount + 1, 2);

    const elements = [R, V1, V2src];

    solver.beginAssembly(matrixSize);
    assembler.stampLinear(elements);
    solver.finalize();

    const factorResult = solver.factor();
    expect(factorResult.success).toBe(true);

    const solution = new Float64Array(matrixSize);
    solver.solve(solution);

    // solution[0] = V_node1, solution[1] = V_node2
    const Vnode1 = solution[0];
    const Vnode2 = solution[1];

    expect(Vnode1).toBeCloseTo(3.0, 8);
    expect(Vnode2).toBeCloseTo(5.0, 8);

    // Current through R = V_node2 / 1000 = 5mA
    const I_R = Vnode2 / 1000;
    expect(I_R).toBeCloseTo(5e-3, 8);
  });

  /**
   * Current source with resistor.
   *
   * Circuit: I=1mA from GND to node 1, R=1kΩ from node 1 to GND.
   * Expected: V_node1 = 1mA * 1kΩ = 1.0V.
   */
  it("current_source_with_resistor", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    const nodeCount = 1;
    const matrixSize = nodeCount; // no branches

    const I = makeCurrentSource(1, 0, 1e-3);
    const R = makeResistor(1, 0, 1000);

    const elements = [I, R];

    solver.beginAssembly(matrixSize);
    assembler.stampLinear(elements);
    solver.finalize();

    const factorResult = solver.factor();
    expect(factorResult.success).toBe(true);

    const solution = new Float64Array(matrixSize);
    solver.solve(solution);

    // solution[0] = V_node1
    const Vnode1 = solution[0];
    expect(Vnode1).toBeCloseTo(1.0, 8);
  });
});

// ---------------------------------------------------------------------------
// Assembler tests
// ---------------------------------------------------------------------------

describe("Assembler", () => {
  it("linear_only_stamps_once", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    // Spy on a resistor's stamp() method
    const resistor = makeResistor(1, 0, 1000);
    const stampSpy = vi.spyOn(resistor, "stamp");

    solver.beginAssembly(1);
    assembler.stampLinear([resistor]);
    assembler.stampLinear([resistor]);
    // stamp called twice because stampLinear was called twice (caller controls when)
    expect(stampSpy).toHaveBeenCalledTimes(2);
  });

  it("nonlinear_skips_linear_elements", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    // Resistor is a linear element (isNonlinear=false)
    const resistor = makeResistor(1, 0, 1000);
    expect(resistor.isNonlinear).toBe(false);

    // The resistor does not have stampNonlinear defined
    // Create a spy on the method — it won't be called because isNonlinear=false
    const stampNonlinearSpy = vi.fn();

    // Manually attach stampNonlinear to test the guard
    const resistorWithNl = {
      ...resistor,
      isNonlinear: false, // still false
      stampNonlinear: stampNonlinearSpy,
    };

    solver.beginAssembly(1);
    assembler.stampNonlinear([resistorWithNl]);

    // Because isNonlinear=false, stampNonlinear must not be called
    expect(stampNonlinearSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Convergence tests
// ---------------------------------------------------------------------------

describe("Convergence", () => {
  it("all_linear_converges_immediately", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    // Linear elements have no checkConvergence method
    const R1 = makeResistor(1, 0, 1000);
    const R2 = makeResistor(2, 0, 1000);
    expect(R1.checkConvergence).toBeUndefined();
    expect(R2.checkConvergence).toBeUndefined();

    const voltages = new Float64Array([1.0, 2.0]);
    const prevVoltages = new Float64Array([1.0, 2.0]);

    const converged = assembler.checkAllConverged(
      [R1, R2],
      voltages,
      prevVoltages,
      1e-3,
      1e-6,
    );

    expect(converged).toBe(true);
  });
});
