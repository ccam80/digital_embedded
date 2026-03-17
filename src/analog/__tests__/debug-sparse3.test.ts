import { describe, it } from "vitest";
import { SparseSolver } from "../sparse-solver.js";

describe("debug3", () => {
  it("mna_3x3_full_trace", () => {
    const G = 1/1000;
    const Vs = 5.0;
    const solver = new SparseSolver() as any;
    solver.beginAssembly(3);
    solver.stamp(0, 0, G);
    solver.stamp(0, 1, -G);
    solver.stamp(0, 2, 1);
    solver.stamp(1, 0, -G);
    solver.stamp(1, 1, G + G);
    solver.stamp(2, 0, 1);
    solver.stampRHS(2, Vs);
    solver.finalize();
    
    console.log("perm:", Array.from(solver._perm));
    console.log("permInv:", Array.from(solver._permInv));
    console.log("aColPtr:", Array.from(solver._aColPtr));
    console.log("aRowIdx:", Array.from(solver._aRowIdx));
    
    // Expected permuted matrix:
    // A_perm = [[2G, -G, 0], [-G, G, 1], [0, 1, 0]]
    // Let's verify aVals
    solver._reloadPermutedValues();
    console.log("aVals:", Array.from(solver._aVals));
    
    // Manual: column 0 has rows [0,1] with vals [2G, -G]
    //         column 1 has rows [0,1,2] with vals [-G, G, 1]  
    //         column 2 has rows [1] with vals [1]
    
    console.log("etree:", Array.from(solver._etree));
    
    const result = solver.factor();
    console.log("\nfactor:", result);
    console.log("pinv:", Array.from(solver._pinv));
    
    const n = 3;
    console.log("\nL (pivoted rows):");
    for (let j = 0; j < n; j++) {
      const p0 = solver._lColPtr[j];
      const p1 = solver._lColPtr[j+1];
      for (let p = p0; p < p1; p++) {
        console.log(`  L[${solver._lRowIdx[p]},${j}] = ${solver._lVals[p]}`);
      }
    }
    
    console.log("\nU (pivoted rows):");
    for (let j = 0; j < n; j++) {
      const p0 = solver._uColPtr[j];
      const p1 = solver._uColPtr[j+1];
      for (let p = p0; p < p1; p++) {
        console.log(`  U[${solver._uRowIdx[p]},${j}] = ${solver._uVals[p]}`);
      }
    }
    
    // Expected (no pivoting, identity pinv):
    // L = [[1,0,0],[-0.5,1,0],[0,2000,1]]  
    // U = [[0.002,-0.001,0],[0,0.0005,1],[0,0,-2000]]
    
    const x = new Float64Array(3);
    solver.solve(x);
    console.log("\nsolution:", Array.from(x));
    console.log("expected: [5, 2.5, -0.0025]");
  });
});
