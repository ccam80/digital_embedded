/**
 * Diagnostic: stamp a 5V/1k/1k resistor divider exactly as the test would,
 * then factor + solve and dump the resulting node voltages. Should be
 * V_node1=5, V_node2=2.5, branch_current=0.005.
 *
 * If solve returns these correctly, the bug is in NR / element load layer.
 * If solve returns wrong values, the bug is in the solver itself.
 */
import { SparseSolver } from "../src/solver/analog/sparse-solver.js";

const n = 3; // 2 nodes + 1 voltage-source branch
const solver = new SparseSolver();
solver.beginAssembly(n);

// Voltage source: V=5V, +node=1 (idx 0), -node=GND, branch=2
const k = 2;
solver.stampElement(solver.allocElement(0, k), 1);
solver.stampElement(solver.allocElement(k, 0), 1);
solver.stampRHS(k, 5);

// R1 = 1k between node1 (idx 0) and node2 (idx 1)
const G = 1 / 1000;
solver.stampElement(solver.allocElement(0, 0), G);
solver.stampElement(solver.allocElement(0, 1), -G);
solver.stampElement(solver.allocElement(1, 0), -G);
solver.stampElement(solver.allocElement(1, 1), G);

// R2 = 1k between node2 (idx 1) and GND
solver.stampElement(solver.allocElement(1, 1), G);

solver.finalize();

console.log("=== Pre-factor matrix ===");
for (const e of solver.getCSCNonZeros()) {
  console.log(`  A[${e.row}][${e.col}] = ${e.value}`);
}

const r = solver.factor();
console.log(`\nfactor: success=${r.success}, usedReorder=${r.usedReorder}`);

const x = new Float64Array(n);
solver.solve(x);

console.log("\n=== Solution ===");
console.log(`x[0] (V_node1) = ${x[0]}  (expected 5)`);
console.log(`x[1] (V_node2) = ${x[1]}  (expected 2.5)`);
console.log(`x[2] (branch I) = ${x[2]}  (expected 0.0025 with R_total=2k)`);
