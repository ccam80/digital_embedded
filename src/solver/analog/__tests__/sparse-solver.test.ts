import { describe, it, expect } from "vitest";
import { SparseSolver } from "../sparse-solver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assembleSolve(
  n: number,
  entries: Array<[number, number, number]>,
  rhs: number[]
): Float64Array {
  const solver = new SparseSolver();
  solver.beginAssembly(n);
  for (const [r, c, v] of entries) solver.stamp(r, c, v);
  for (let i = 0; i < rhs.length; i++) solver.stampRHS(i, rhs[i]);
  solver.finalize();
  const result = solver.factor();
  expect(result.success).toBe(true);
  const x = new Float64Array(n);
  solver.solve(x);
  return x;
}

// ---------------------------------------------------------------------------
// SparseSolver tests
// ---------------------------------------------------------------------------

describe("SparseSolver", () => {
  it("solves_2x2_dense", () => {
    // A = [[4,1],[1,3]], b = [1,2]
    // Analytical: x = [1/11, 7/11]
    const x = assembleSolve(
      2,
      [
        [0, 0, 4],
        [0, 1, 1],
        [1, 0, 1],
        [1, 1, 3],
      ],
      [1, 2]
    );
    expect(x[0]).toBeCloseTo(1 / 11, 12);
    expect(x[1]).toBeCloseTo(7 / 11, 12);
  });

  it("solves_3x3_sparse_tridiagonal", () => {
    // A = [[2,-1,0],[-1,3,-1],[0,-1,2]], b = [1,2,1]
    // Analytical solution: solve by hand
    // 2x0 - x1 = 1
    // -x0 + 3x1 - x2 = 2
    // -x1 + 2x2 = 1
    // From row 0: x0 = (1 + x1) / 2
    // From row 2: x2 = (1 + x1) / 2
    // Sub into row 1: -(1+x1)/2 + 3x1 - (1+x1)/2 = 2
    //   -1/2 - x1/2 + 3x1 - 1/2 - x1/2 = 2
    //   -1 + 2x1 = 2 => x1 = 1.5
    // x0 = 2.5/2 = 1.25, x2 = 1.25
    const x = assembleSolve(
      3,
      [
        [0, 0, 2],
        [0, 1, -1],
        [1, 0, -1],
        [1, 1, 3],
        [1, 2, -1],
        [2, 1, -1],
        [2, 2, 2],
      ],
      [1, 2, 1]
    );
    expect(x[0]).toBeCloseTo(1.25, 12);
    expect(x[1]).toBeCloseTo(1.5, 12);
    expect(x[2]).toBeCloseTo(1.25, 12);
  });

  it("sums_duplicate_entries", () => {
    // stamp (0,0) with 3.0, stamp (0,0) with 2.0; total should be 5.0
    // 1x1 system: 5*x = 10 => x = 2
    const solver = new SparseSolver();
    solver.beginAssembly(1);
    solver.stamp(0, 0, 3.0);
    solver.stamp(0, 0, 2.0);
    solver.stampRHS(0, 10.0);
    solver.finalize();
    const result = solver.factor();
    expect(result.success).toBe(true);
    const x = new Float64Array(1);
    solver.solve(x);
    expect(x[0]).toBeCloseTo(2.0, 12);
  });

  it("detects_singular_matrix", () => {
    // A = [[1,1],[1,1]] is singular
    const solver = new SparseSolver();
    solver.beginAssembly(2);
    solver.stamp(0, 0, 1);
    solver.stamp(0, 1, 1);
    solver.stamp(1, 0, 1);
    solver.stamp(1, 1, 1);
    solver.stampRHS(0, 1);
    solver.stampRHS(1, 1);
    solver.finalize();
    const result = solver.factor();
    expect(result.success).toBe(false);
    expect(result.singularRow).toBeDefined();
    expect(typeof result.singularRow).toBe("number");
  });

  it("identity_matrix_trivial", () => {
    // I * x = b => x = b
    const n = 4;
    const b = [3.0, -1.5, 0.0, 7.25];
    const solver = new SparseSolver();
    solver.beginAssembly(n);
    for (let i = 0; i < n; i++) solver.stamp(i, i, 1.0);
    for (let i = 0; i < n; i++) solver.stampRHS(i, b[i]);
    solver.finalize();
    const result = solver.factor();
    expect(result.success).toBe(true);
    const x = new Float64Array(n);
    solver.solve(x);
    for (let i = 0; i < n; i++) {
      expect(x[i]).toBeCloseTo(b[i], 12);
    }
  });

  it("reuses_symbolic_across_numeric_refactor", () => {
    // First solve: A = [[4,1],[1,3]], b = [1,2]
    const solver = new SparseSolver();

    solver.beginAssembly(2);
    solver.stamp(0, 0, 4);
    solver.stamp(0, 1, 1);
    solver.stamp(1, 0, 1);
    solver.stamp(1, 1, 3);
    solver.stampRHS(0, 1);
    solver.stampRHS(1, 2);
    solver.finalize();
    const r1 = solver.factor();
    expect(r1.success).toBe(true);
    const x1 = new Float64Array(2);
    solver.solve(x1);
    expect(x1[0]).toBeCloseTo(1 / 11, 12);
    expect(x1[1]).toBeCloseTo(7 / 11, 12);

    // Second solve: same pattern, different values — A = [[2,1],[1,4]], b = [3,5]
    // Analytical: det = 8-1=7; x0 = (3*4-5*1)/7 = 7/7 = 1; x1 = (2*5-3*1)/7 = 7/7 = 1
    solver.beginAssembly(2);
    solver.stamp(0, 0, 2);
    solver.stamp(0, 1, 1);
    solver.stamp(1, 0, 1);
    solver.stamp(1, 1, 4);
    solver.stampRHS(0, 3);
    solver.stampRHS(1, 5);
    solver.finalize();
    // topology should NOT be dirty — same nonzero pattern
    const r2 = solver.factor();
    expect(r2.success).toBe(true);
    const x2 = new Float64Array(2);
    solver.solve(x2);
    expect(x2[0]).toBeCloseTo(1.0, 12);
    expect(x2[1]).toBeCloseTo(1.0, 12);
  });

  it("invalidate_forces_resymbolize", () => {
    // First: 2x2 diagonal
    const solver = new SparseSolver();
    solver.beginAssembly(2);
    solver.stamp(0, 0, 3);
    solver.stamp(1, 1, 5);
    solver.stampRHS(0, 6);
    solver.stampRHS(1, 10);
    solver.finalize();
    let r = solver.factor();
    expect(r.success).toBe(true);
    const x1 = new Float64Array(2);
    solver.solve(x1);
    expect(x1[0]).toBeCloseTo(2, 12);
    expect(x1[1]).toBeCloseTo(2, 12);

    // Invalidate topology, then change to full 2x2
    solver.invalidateTopology();
    solver.beginAssembly(2);
    solver.stamp(0, 0, 4);
    solver.stamp(0, 1, 1);
    solver.stamp(1, 0, 1);
    solver.stamp(1, 1, 3);
    solver.stampRHS(0, 1);
    solver.stampRHS(1, 2);
    solver.finalize();
    r = solver.factor();
    expect(r.success).toBe(true);
    const x2 = new Float64Array(2);
    solver.solve(x2);
    expect(x2[0]).toBeCloseTo(1 / 11, 12);
    expect(x2[1]).toBeCloseTo(7 / 11, 12);
  });

  it("mna_resistor_divider_3x3", () => {
    // MNA stamp for: Vs=5V between node 1 and ground, R1=1kΩ (node1-node2), R2=1kΩ (node2-ground)
    // Nodes: 1=V1, 2=V2, branch 3=Ivs (current through voltage source)
    // Matrix size = 3 (2 nodes + 1 branch)
    //
    // MNA equations:
    // Row 0 (node 1): G1*(V1-V2) + Ivs = 0     => G1*V1 - G1*V2 + Ivs = 0
    // Row 1 (node 2): G2*V2 - G1*(V1-V2) = 0   => -G1*V1 + (G1+G2)*V2 = 0
    // Row 2 (branch): V1 = Vs                   => V1 = 5
    //
    // G1 = G2 = 1/1000 = 0.001 S
    //
    // Matrix:
    // [ G1,   -G1,  1 ] [V1]   [0 ]
    // [-G1, G1+G2,  0 ] [V2] = [0 ]
    // [ 1,    0,    0 ] [Ivs]  [Vs]

    const G = 1 / 1000; // conductance = 1/R
    const Vs = 5.0;

    const solver = new SparseSolver();
    solver.beginAssembly(3);

    // Row 0, node 1: G1*(V1-V2) stamp
    solver.stamp(0, 0, G);   // G1 to V1
    solver.stamp(0, 1, -G);  // -G1 to V2
    // Voltage source current injection into node 1
    solver.stamp(0, 2, 1);   // +1 for Ivs column

    // Row 1, node 2: G1*(V2-V1) + G2*V2 stamp
    solver.stamp(1, 0, -G);  // -G1 from V1
    solver.stamp(1, 1, G + G); // G1+G2 for V2

    // Row 2, branch equation V1 = Vs
    solver.stamp(2, 0, 1);   // V1 coefficient
    solver.stampRHS(2, Vs);  // RHS = Vs

    solver.finalize();
    const result = solver.factor();
    expect(result.success).toBe(true);

    const x = new Float64Array(3);
    solver.solve(x);

    // V1=5, V2=2.5, Ivs = -V1/1000 = wait, let's compute:
    // V1=5, V2=2.5; current through R1 = (V1-V2)/R1 = 2.5mA into node 2
    // Current through R2 = V2/R2 = 2.5mA out of node 2 — balanced
    // Current through Vs source: flows from node 1 to ground through the source branch
    // Ivs = -(V1-V2)/R1 = branch current, by KCL at node 1:
    // G1*(V1-V2) + Ivs = 0 => 0.001*2.5 + Ivs = 0 => Ivs = -0.0025A
    expect(x[0]).toBeCloseTo(5.0, 10);    // V1
    expect(x[1]).toBeCloseTo(2.5, 10);    // V2
    expect(x[2]).toBeCloseTo(-0.0025, 10); // Ivs
  });

  it("performance_50_node", () => {
    const n = 50;
    const solver = new SparseSolver();

    // Build a random sparse matrix with ~10% density, diagonally dominant
    const entries: Array<[number, number, number]> = [];
    for (let i = 0; i < n; i++) {
      let rowSum = 0;
      for (let j = 0; j < n; j++) {
        if (i !== j && Math.random() < 0.1) {
          const v = (Math.random() - 0.5) * 2;
          entries.push([i, j, v]);
          rowSum += Math.abs(v);
        }
      }
      // Diagonal dominance: diagonal > sum of off-diagonal abs values
      entries.push([i, i, rowSum + 1.0]);
    }

    const rhs = Array.from({ length: n }, () => Math.random());

    // Symbolic timing
    const t0 = performance.now();
    solver.beginAssembly(n);
    for (const [r, c, v] of entries) solver.stamp(r, c, v);
    for (let i = 0; i < n; i++) solver.stampRHS(i, rhs[i]);
    solver.finalize();
    const tSymbolic = performance.now() - t0;

    // Numeric factor timing
    const t1 = performance.now();
    const result = solver.factor();
    const tFactor = performance.now() - t1;

    expect(result.success).toBe(true);

    // Solve timing
    const t2 = performance.now();
    const x = new Float64Array(n);
    solver.solve(x);
    const tSolve = performance.now() - t2;

    // CI-relaxed performance targets (5x relaxed as per spec)
    expect(tSymbolic).toBeLessThan(5);    // 1ms * 5
    expect(tFactor).toBeLessThan(2.5);    // 0.5ms * 5
    expect(tSolve).toBeLessThan(1.0);     // 0.2ms * 5

    // Warm run: re-stamp same pattern, re-factor (simulates NR iteration 2+)
    solver.beginAssembly(n);
    for (const [r, c, v] of entries) solver.stamp(r, c, v);
    for (let i = 0; i < n; i++) solver.stampRHS(i, rhs[i]);
    solver.finalize(); // topology unchanged — skips symbolic

    const tw1 = performance.now();
    solver.factor();
    const tWarmFactor = performance.now() - tw1;

    const tw2 = performance.now();
    solver.solve(x);
    const tWarmSolve = performance.now() - tw2;

    // Verify solution is correct: A*x should equal b within tolerance
    // (residual check using original entries)
    const residual = new Float64Array(n);
    for (const [r, c, v] of entries) residual[r] += v * x[c];
    for (let i = 0; i < n; i++) {
      expect(Math.abs(residual[i] - rhs[i])).toBeLessThan(1e-8);
    }
  });
});

// ---------------------------------------------------------------------------
// Real MNA circuit benchmark — full engine pipeline
// ---------------------------------------------------------------------------

import {
  makeResistor,
  makeVoltageSource,
  makeCapacitor,
  makeDiode,
  makeInductor,
} from "../test-elements.js";
import { ConcreteCompiledAnalogCircuit } from "../compiled-analog-circuit.js";
import { MNAEngine } from "../analog-engine.js";
import { EngineState } from "../../../core/engine-interface.js";

describe("SparseSolver real MNA circuit", () => {
  it("mna_50node_realistic_circuit_performance", () => {
    // 50-node MNA circuit with realistic topology:
    //
    //   Vs=10V source: node 50 → GND (branch row 50)
    //   Resistor chain: node 50 → 49 → 48 → ... → 1 → GND (50 resistors)
    //   Shunt capacitors: every 5th node to GND (10 caps at nodes 5,10,...,50)
    //   Shunt diodes: every 7th node to GND (7 diodes at nodes 7,14,...,49)
    //   Inductor: node 25 → GND (branch row 51)
    //   Cross-links: 5 feedback resistors spanning non-adjacent nodes
    //
    // Matrix: 50 nodes + 2 branches = 52×52
    // ~70 elements, ~150 nonzeros, ~5.5% density (realistic MNA)

    const nodeCount = 50;
    const branchCount = 2;
    const matrixSize = nodeCount + branchCount;
    const elements: import("../element.js").AnalogElement[] = [];

    // Voltage source: node 50 → GND, branch row = 50
    elements.push(makeVoltageSource(50, 0, 50, 10.0));

    // Resistor chain: node i → node i-1, with node 1 → GND
    for (let i = 50; i >= 2; i--) {
      elements.push(makeResistor(i, i - 1, 1000 + i * 10));
    }
    elements.push(makeResistor(1, 0, 1000)); // node 1 → GND

    // Shunt capacitors: every 5th node to GND
    for (let i = 5; i <= 50; i += 5) {
      elements.push(makeCapacitor(i, 0, 100e-9));
    }

    // Shunt diodes: every 7th node to GND
    for (let i = 7; i <= 49; i += 7) {
      elements.push(makeDiode(i, 0, 1e-14, 1.0));
    }

    // Inductor: node 25 → GND, branch row = 51
    elements.push(makeInductor(25, 0, 51, 1e-3));

    // Cross-link resistors (feedback paths across the chain)
    elements.push(makeResistor(10, 40, 10000));
    elements.push(makeResistor(15, 35, 10000));
    elements.push(makeResistor(20, 30, 10000));
    elements.push(makeResistor(5, 45, 10000));
    elements.push(makeResistor(12, 38, 10000));

    const compiled = new ConcreteCompiledAnalogCircuit({
      nodeCount,
      branchCount,
      elements,
      labelToNodeId: new Map(),
      wireToNodeId: new Map(),
      models: new Map(),
      elementToCircuitElement: new Map(),
    });

    const engine = new MNAEngine();
    engine.init(compiled);

    // --- DC operating point ---
    const t0 = performance.now();
    const dcResult = engine.dcOperatingPoint();
    const tDcOp = performance.now() - t0;

    expect(dcResult.converged).toBe(true);

    // Voltage source enforces node 50 = 10V
    const v50 = engine.getNodeVoltage(50); // MNA node ID
    expect(v50).toBeCloseTo(10.0, 1);

    // --- Transient simulation: 100 steps ---
    engine.configure({ maxTimeStep: 1e-6 });
    const t1 = performance.now();
    let transientSteps = 0;
    while (transientSteps < 100 && engine.getState() !== EngineState.ERROR) {
      engine.step();
      transientSteps++;
    }
    const tTransient = performance.now() - t1;
    const tPerStep = tTransient / transientSteps;

    expect(engine.getState()).not.toBe(EngineState.ERROR);
    expect(transientSteps).toBe(100);

    // --- Isolated solver timing (apples-to-apples with performance_50_node) ---
    // Stamp the same circuit's linear elements into a raw SparseSolver
    const rawSolver = new SparseSolver();
    rawSolver.beginAssembly(matrixSize);
    for (const el of elements) {
      if (!el.isNonlinear) el.stamp(rawSolver);
    }
    // Also stamp diodes at their initial operating point (geq=GMIN, ieq=0)
    // so the matrix has the same sparsity pattern as a real NR iteration
    for (const el of elements) {
      if (el.isNonlinear && el.stampNonlinear) el.stampNonlinear(rawSolver);
    }

    const ts0 = performance.now();
    rawSolver.finalize();
    const tRawSymbolic = performance.now() - ts0;

    const ts1 = performance.now();
    const fResult = rawSolver.factor();
    const tRawFactor = performance.now() - ts1;
    expect(fResult.success).toBe(true);

    const ts2 = performance.now();
    const xRaw = new Float64Array(matrixSize);
    rawSolver.solve(xRaw);
    const tRawSolve = performance.now() - ts2;

    // Warm run: re-stamp and re-factor (simulates NR iteration 2+)
    rawSolver.beginAssembly(matrixSize);
    for (const el of elements) {
      if (!el.isNonlinear) el.stamp(rawSolver);
      if (el.isNonlinear && el.stampNonlinear) el.stampNonlinear(rawSolver);
    }
    rawSolver.finalize(); // topology unchanged — skips symbolic

    const tw1 = performance.now();
    rawSolver.factor();
    const tWarmFactor = performance.now() - tw1;

    const tw2 = performance.now();
    rawSolver.solve(xRaw);
    const tWarmSolve = performance.now() - tw2;

    // Performance targets for a 52×52 real MNA matrix:
    // DC OP: < 20ms (multiple NR iterations with 7 nonlinear diodes)
    // Per transient step: < 2ms
    expect(tDcOp).toBeLessThan(20);
    expect(tPerStep).toBeLessThan(2);
  });
});
