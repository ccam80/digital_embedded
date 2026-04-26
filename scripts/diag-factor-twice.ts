/**
 * Diagnostic: factor a known 3x3 twice, compare solutions.
 * If the second solve diverges from the first, F2's reuse-pivot path is broken.
 */
import { SparseSolver } from "../src/solver/analog/sparse-solver.js";

function stamp(solver: SparseSolver, entries: Array<[number, number, number]>): void {
  for (const [r, c, v] of entries) {
    solver.stampElement(solver.allocElement(r, c), v);
  }
}

function solveAndDump(solver: SparseSolver, rhs: number[], label: string): Float64Array {
  for (let i = 0; i < rhs.length; i++) solver.stampRHS(i, rhs[i]!);
  solver.finalize();
  const r = solver.factor();
  if (!r.success) {
    console.log(`${label}: factor FAILED`, r);
    return new Float64Array(rhs.length);
  }
  console.log(`${label}: usedReorder=${r.usedReorder}`);
  const x = new Float64Array(rhs.length);
  solver.solve(x);
  console.log(`${label}: x=[${Array.from(x).map(v => v.toFixed(15)).join(", ")}]`);
  return x;
}

// Cyclic sparsity → forces fill-in. Reuse path will exercise persisted fills.
const entries: Array<[number, number, number]> = [
  [0, 0, 2], [0, 1, 1],
  [1, 1, 2], [1, 2, 1],
  [2, 0, 1],             [2, 2, 2],
];
const rhs = [3, 3, 3];

const solver = new SparseSolver();

console.log("=== First factor ===");
solver.beginAssembly(3);
stamp(solver, entries);
const x1 = solveAndDump(solver, rhs, "factor #1");

console.log("\n=== Second factor (same matrix, same RHS) ===");
solver.beginAssembly(3);
stamp(solver, entries);
const x2 = solveAndDump(solver, rhs, "factor #2");

console.log("\n=== Bit-exact comparison ===");
let diverged = false;
for (let i = 0; i < x1.length; i++) {
  if (!Object.is(x1[i], x2[i])) {
    console.log(`x[${i}]: first=${x1[i]}, second=${x2[i]} DIVERGE`);
    diverged = true;
  }
}
if (!diverged) console.log("All entries bit-identical — reuse path correct.");

// === NR-style: change stamp values between assemblies, same structure ===
console.log("\n=== Third factor (CHANGED values, same structure) ===");
const entries2: Array<[number, number, number]> = [
  [0, 0, 5], [0, 1, 2],
  [1, 1, 3], [1, 2, 1],
  [2, 0, 1],             [2, 2, 4],
];
const rhs2 = [7, 4, 5];
solver.beginAssembly(3);
stamp(solver, entries2);
const x3 = solveAndDump(solver, rhs2, "factor #3");

// Verify against fresh solver
const solver2 = new SparseSolver();
solver2.beginAssembly(3);
stamp(solver2, entries2);
const xRef = solveAndDump(solver2, rhs2, "fresh-solver reference");

console.log("\n=== NR-style comparison ===");
let nrDiverged = false;
for (let i = 0; i < x3.length; i++) {
  if (!Object.is(x3[i], xRef[i])) {
    console.log(`x[${i}]: reuse=${x3[i]}, fresh=${xRef[i]} DIVERGE`);
    nrDiverged = true;
  }
}
if (!nrDiverged) console.log("Reuse path bit-matches fresh-factor on changed values.");
