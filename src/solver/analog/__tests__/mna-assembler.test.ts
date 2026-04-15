/**
 * Tests for MNA infrastructure: MNA assembler and test elements.
 *
 * Test groups:
 *   Stamping     — full solve with resistors, voltage sources, current sources
 *   Assembler    — stampAll / checkAllConverged behaviour
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

    const voltages = new Float64Array(matrixSize);
    assembler.stampAll(elements, matrixSize, voltages, null, 0);

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

    const voltages = new Float64Array(matrixSize);
    assembler.stampAll(elements, matrixSize, voltages, null, 0);

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

    const voltages = new Float64Array(matrixSize);
    assembler.stampAll(elements, matrixSize, voltages, null, 0);

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
  it("stampAll_stamps_linear_element_each_call", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    // Spy on a resistor's stamp() method
    const resistor = makeResistor(1, 0, 1000);
    const stampSpy = vi.spyOn(resistor, "stamp");

    const voltages = new Float64Array(1);
    assembler.stampAll([resistor], 1, voltages, null, 0);
    assembler.stampAll([resistor], 1, voltages, null, 0);
    // stamp called once per stampAll call
    expect(stampSpy).toHaveBeenCalledTimes(2);
  });

  it("stampAll_skips_stampNonlinear_for_linear_elements", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    // Resistor is a linear element (isNonlinear=false)
    const resistor = makeResistor(1, 0, 1000);
    expect(resistor.isNonlinear).toBe(false);

    const stampNonlinearSpy = vi.fn();

    // Manually attach stampNonlinear to test the guard
    const resistorWithNl = {
      ...resistor,
      isNonlinear: false, // still false
      stampNonlinear: stampNonlinearSpy,
    };

    const voltages = new Float64Array(1);
    assembler.stampAll([resistorWithNl], 1, voltages, null, 0);

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

// ---------------------------------------------------------------------------
// stampAll tests — unified CKTload equivalent
// ---------------------------------------------------------------------------

describe("stampAll", () => {
  it("stamps_linear_and_nonlinear_and_reactive_in_single_pass", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    const linearStamp = vi.fn();
    const nlStamp = vi.fn();
    const reactiveStamp = vi.fn();

    const linearEl = {
      pinNodeIds: [1, 0],
      allNodeIds: [1, 0],
      branchIndex: -1,
      isNonlinear: false,
      isReactive: false,
      stamp: linearStamp,
      getPinCurrents(): number[] { return [0]; },
      setParam(): void {},
    };

    const nlEl = {
      pinNodeIds: [1, 0],
      allNodeIds: [1, 0],
      branchIndex: -1,
      isNonlinear: true,
      isReactive: false,
      stamp: vi.fn(),
      stampNonlinear: nlStamp,
      updateOperatingPoint: vi.fn(() => false),
      getPinCurrents(): number[] { return [0]; },
      setParam(): void {},
    };

    const reactiveEl = {
      pinNodeIds: [1, 0],
      allNodeIds: [1, 0],
      branchIndex: -1,
      isNonlinear: false,
      isReactive: true,
      stamp: vi.fn(),
      stampReactiveCompanion: reactiveStamp,
      getPinCurrents(): number[] { return [0]; },
      setParam(): void {},
    };

    const voltages = new Float64Array(1);
    assembler.stampAll([linearEl, nlEl, reactiveEl], 1, voltages, null, 1);

    expect(linearStamp).toHaveBeenCalledTimes(1);
    expect(nlStamp).toHaveBeenCalledTimes(1);
    expect(reactiveStamp).toHaveBeenCalledTimes(1);
  });

  it("calls_updateOperatingPoints_only_after_iteration_0", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    const updateOp = vi.fn(() => false);
    const el = {
      pinNodeIds: [1, 0],
      allNodeIds: [1, 0],
      branchIndex: -1,
      isNonlinear: true,
      isReactive: false,
      stamp: vi.fn(),
      stampNonlinear: vi.fn(),
      updateOperatingPoint: updateOp,
      getPinCurrents(): number[] { return [0]; },
      setParam(): void {},
    };

    const voltages = new Float64Array(1);

    assembler.stampAll([el], 1, voltages, null, 0);
    expect(updateOp).not.toHaveBeenCalled();

    assembler.stampAll([el], 1, voltages, null, 1);
    expect(updateOp).toHaveBeenCalledTimes(1);
  });

  it("sets_noncon_from_limiting_during_updateOperatingPoints", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    const el = {
      pinNodeIds: [1, 0],
      allNodeIds: [1, 0],
      branchIndex: -1,
      isNonlinear: true,
      isReactive: false,
      stamp: vi.fn(),
      stampNonlinear: vi.fn(),
      updateOperatingPoint: vi.fn(() => true),
      getPinCurrents(): number[] { return [0]; },
      setParam(): void {},
    };

    const voltages = new Float64Array(1);
    assembler.stampAll([el], 1, voltages, null, 1);

    expect(assembler.noncon).toBe(1);
  });

  it("calls_beginAssembly_and_finalize_on_solver", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);
    const beginSpy = vi.spyOn(solver, "beginAssembly");
    const finalizeSpy = vi.spyOn(solver, "finalize");

    const R1 = makeResistor(1, 0, 1000);
    const voltages = new Float64Array(1);
    assembler.stampAll([R1], 1, voltages, null, 0);

    expect(beginSpy).toHaveBeenCalledWith(1);
    expect(finalizeSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// shouldBypass tests — device bypass optimization
// ---------------------------------------------------------------------------

describe("shouldBypass", () => {
  it("skips stamp/stampNonlinear/stampReactiveCompanion when shouldBypass returns true at iteration > 0", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    const stampFn = vi.fn();
    const stampNlFn = vi.fn();
    const stampReactiveFn = vi.fn();

    const el = {
      pinNodeIds: [1, 0],
      allNodeIds: [1, 0],
      branchIndex: -1,
      isNonlinear: true,
      isReactive: true,
      stamp: stampFn,
      stampNonlinear: stampNlFn,
      stampReactiveCompanion: stampReactiveFn,
      updateOperatingPoint: vi.fn(() => false),
      getPinCurrents(): number[] { return [0]; },
      setParam(): void {},
      shouldBypass(_v: Float64Array, _pv: Float64Array): boolean { return true; },
    };

    const voltages = new Float64Array(1);
    const prevVoltages = new Float64Array(1);

    assembler.stampAll([el], 1, voltages, null, 1, prevVoltages);

    expect(stampFn).not.toHaveBeenCalled();
    expect(stampNlFn).not.toHaveBeenCalled();
    expect(stampReactiveFn).not.toHaveBeenCalled();
  });

  it("does NOT skip stamping when shouldBypass returns true at iteration 0", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    const stampFn = vi.fn();

    const el = {
      pinNodeIds: [1, 0],
      allNodeIds: [1, 0],
      branchIndex: -1,
      isNonlinear: false,
      isReactive: false,
      stamp: stampFn,
      getPinCurrents(): number[] { return [0]; },
      setParam(): void {},
      shouldBypass(_v: Float64Array, _pv: Float64Array): boolean { return true; },
    };

    const voltages = new Float64Array(1);
    const prevVoltages = new Float64Array(1);

    assembler.stampAll([el], 1, voltages, null, 0, prevVoltages);

    expect(stampFn).toHaveBeenCalledTimes(1);
  });

  it("does NOT skip stamping when shouldBypass returns false", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    const stampFn = vi.fn();

    const el = {
      pinNodeIds: [1, 0],
      allNodeIds: [1, 0],
      branchIndex: -1,
      isNonlinear: false,
      isReactive: false,
      stamp: stampFn,
      getPinCurrents(): number[] { return [0]; },
      setParam(): void {},
      shouldBypass(_v: Float64Array, _pv: Float64Array): boolean { return false; },
    };

    const voltages = new Float64Array(1);
    const prevVoltages = new Float64Array(1);

    assembler.stampAll([el], 1, voltages, null, 1, prevVoltages);

    expect(stampFn).toHaveBeenCalledTimes(1);
  });

  it("does NOT skip stamping when prevVoltages is omitted even if shouldBypass exists", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    const stampFn = vi.fn();

    const el = {
      pinNodeIds: [1, 0],
      allNodeIds: [1, 0],
      branchIndex: -1,
      isNonlinear: false,
      isReactive: false,
      stamp: stampFn,
      getPinCurrents(): number[] { return [0]; },
      setParam(): void {},
      shouldBypass(_v: Float64Array, _pv: Float64Array): boolean { return true; },
    };

    const voltages = new Float64Array(1);

    assembler.stampAll([el], 1, voltages, null, 1);

    expect(stampFn).toHaveBeenCalledTimes(1);
  });

  it("elements without shouldBypass are always stamped at iteration > 0", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);

    const stampFn = vi.fn();

    const el = {
      pinNodeIds: [1, 0],
      allNodeIds: [1, 0],
      branchIndex: -1,
      isNonlinear: false,
      isReactive: false,
      stamp: stampFn,
      getPinCurrents(): number[] { return [0]; },
      setParam(): void {},
    };

    const voltages = new Float64Array(1);
    const prevVoltages = new Float64Array(1);

    assembler.stampAll([el], 1, voltages, null, 1, prevVoltages);

    expect(stampFn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// checkAllConvergedDetailed tests (Item 8)
// ---------------------------------------------------------------------------

describe("checkAllConvergedDetailed", () => {
  function makeNonlinearElement(converges: boolean) {
    return {
      pinNodeIds: [1, 0],
      allNodeIds: [1, 0],
      branchIndex: -1,
      isNonlinear: true,
      isReactive: false,
      stamp(_solver: SparseSolver): void {},
      getPinCurrents(_v: Float64Array): number[] { return [0, 0]; },
      setParam(_key: string, _value: number): void {},
      checkConvergence(
        _voltages: Float64Array,
        _prevVoltages: Float64Array,
        _reltol: number,
        _iabstol: number,
      ): boolean {
        return converges;
      },
    };
  }

  it("returns allConverged=true and empty failedIndices when all elements converge", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);
    const el0 = makeNonlinearElement(true);
    const el1 = makeNonlinearElement(true);
    const voltages = new Float64Array([1.0]);
    const prevVoltages = new Float64Array([1.0]);
    const result = assembler.checkAllConvergedDetailed(
      [el0, el1], voltages, prevVoltages, 1e-3, 1e-6,
    );
    expect(result.allConverged).toBe(true);
    expect(result.failedIndices).toEqual([]);
  });

  it("returns allConverged=false and collects all failing indices without short-circuiting", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);
    const el0 = makeNonlinearElement(false); // fails
    const el1 = makeNonlinearElement(true);  // passes
    const el2 = makeNonlinearElement(false); // fails
    const voltages = new Float64Array([1.0]);
    const prevVoltages = new Float64Array([0.0]);
    const result = assembler.checkAllConvergedDetailed(
      [el0, el1, el2], voltages, prevVoltages, 1e-3, 1e-6,
    );
    expect(result.allConverged).toBe(false);
    expect(result.failedIndices).toEqual([0, 2]);
  });

  it("skips elements without checkConvergence (linear elements)", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);
    const R1 = makeResistor(1, 0, 1000); // no checkConvergence
    const el = makeNonlinearElement(true);
    const voltages = new Float64Array([5.0]);
    const prevVoltages = new Float64Array([5.0]);
    const result = assembler.checkAllConvergedDetailed(
      [R1, el], voltages, prevVoltages, 1e-3, 1e-6,
    );
    expect(result.allConverged).toBe(true);
    expect(result.failedIndices).toEqual([]);
  });

  it("checkAllConverged still short-circuits on first failure (unchanged)", () => {
    const solver = new SparseSolver();
    const assembler = new MNAAssembler(solver);
    let callCount = 0;
    const trackingEl = {
      pinNodeIds: [1, 0],
      allNodeIds: [1, 0],
      branchIndex: -1,
      isNonlinear: true,
      isReactive: false,
      stamp(_solver: SparseSolver): void {},
      getPinCurrents(_v: Float64Array): number[] { return [0]; },
      setParam(_k: string, _v: number): void {},
      checkConvergence(): boolean { callCount++; return false; },
    };
    const voltages = new Float64Array([1.0]);
    const prevVoltages = new Float64Array([0.0]);
    assembler.checkAllConverged(
      [trackingEl, trackingEl, trackingEl], voltages, prevVoltages, 1e-3, 1e-6,
    );
    // checkAllConverged short-circuits after first failure → only called once
    expect(callCount).toBe(1);
  });
});
