import { describe, it } from "vitest";
import { SparseSolver } from "../sparse-solver.js";

describe("debug2", () => {
  it("mna_3x3_trace", () => {
    // Simple 3x3: A = [[2,-1,0],[-1,3,-1],[0,-1,2]], b = [1,2,1]
    // This test PASSES, so tridiag is fine. Let's try the MNA matrix manually.
    
    // MNA matrix (no AMD, no pivot — just trace what happens):
    // Row 0: [G, -G, 1]     G=0.001
    // Row 1: [-G, 2G, 0]
    // Row 2: [1,  0,  0]
    // RHS: [0, 0, 5]
    
    // With AMD on this, let's see what permutation we get.
    // Adjacency (excluding diagonal):
    //   0: {1, 2}  (from stamps: (0,1,-G), (0,2,1), (1,0,-G), (2,0,1))
    //   1: {0}     (from stamps: (0,1,-G), (1,0,-G))
    //   2: {0}     (from stamps: (0,2,1), (2,0,1))
    // Degrees: 0→2, 1→1, 2→1
    // AMD step 0: pick node 1 (deg 1) or node 2 (deg 1) — whichever comes first = 1
    // Neighbors of 1: {0}. After eliminating 1: adj[0] still has {2}. degree[0]=1
    // AMD step 1: pick node 2 (deg 1) or node 0 (deg 1) — pick 0
    // AMD step 2: pick node 2
    // Wait... let me recheck. After step 0 (eliminate 1):
    //   adj[0] was {1,2}, remove 1 → {2}. Merge neighbors of 1 into 0: neighbors=[0], skip. 
    //   adj[0]={2}, degree[0]=1
    //   adj[2] was {0}, degree[2]=1
    // Step 1: both 0 and 2 have degree 1, pick 0 first
    // perm = [1, 0, 2]
    // permInv = [1, 0, 2]  (permInv[0]=1, permInv[1]=0, permInv[2]=2)
    
    // Permuted matrix A_perm[permInv[i], permInv[j]] = A[i,j]:
    // A[0,0]=G → A_perm[1,1]=G
    // A[0,1]=-G → A_perm[1,0]=-G
    // A[0,2]=1 → A_perm[1,2]=1
    // A[1,0]=-G → A_perm[0,1]=-G
    // A[1,1]=2G → A_perm[0,0]=2G
    // A[2,0]=1 → A_perm[2,1]=1
    //
    // A_perm = [[2G, -G, 0], [-G, G, 1], [0, 1, 0]]
    // = [[0.002, -0.001, 0], [-0.001, 0.001, 1], [0, 1, 0]]
    
    // Dense LU of A_perm (no pivoting):
    // k=0: pivot = 0.002
    //   L[1,0] = -0.001/0.002 = -0.5
    //   L[2,0] = 0/0.002 = 0
    //   Row 1: [-0.001+0.5*0.002, 0.001+0.5*(-0.001), 1+0] = [0, 0.0005, 1]
    //   Row 2: [0, 1, 0]
    // k=1: pivot = 0.0005
    //   L[2,1] = 1/0.0005 = 2000
    //   Row 2: [0, 1-2000*0.0005, 0-2000*1] = [0, 0, -2000]
    // k=2: pivot = -2000
    //
    // U = [[0.002, -0.001, 0], [0, 0.0005, 1], [0, 0, -2000]]
    // L = [[1, 0, 0], [-0.5, 1, 0], [0, 2000, 1]]
    //
    // Solve L*y = P*b_perm where b_perm[j] = rhs[perm[j]]:
    //   perm = [1, 0, 2], rhs = [0, 0, 5]
    //   b_perm = [rhs[1], rhs[0], rhs[2]] = [0, 0, 5]
    //   With no pivoting, P=I, so y = L\b_perm:
    //     y[0] = 0
    //     y[1] = 0 - (-0.5)*0 = 0
    //     y[2] = 5 - 0*0 - 2000*0 = 5
    //   U*z = y:
    //     z[2] = 5/(-2000) = -0.0025
    //     z[1] = (0 - 1*(-0.0025))/0.0005 = 0.0025/0.0005 = 5
    //     z[0] = (0 - (-0.001)*5 - 0*(-0.0025))/0.002 = 0.005/0.002 = 2.5
    //   z = [2.5, 5, -0.0025]
    //   Undo perm: x[perm[j]] = z[j]:
    //     x[1] = z[0] = 2.5
    //     x[0] = z[1] = 5
    //     x[2] = z[2] = -0.0025
    //   x = [5, 2.5, -0.0025] ✓
    
    // So the algorithm SHOULD work. The question is: does my sparse LU
    // produce the same L and U?
    
    const G = 1/1000;
    const Vs = 5.0;
    const solver = new SparseSolver() as any; // cast to access internals
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
    console.log("etree:", Array.from(solver._etree));
    
    const result = solver.factor();
    console.log("factor result:", result);
    console.log("pinv:", Array.from(solver._pinv));
    
    console.log("\nL:");
    for (let j = 0; j < 3; j++) {
      const p0 = solver._lColPtr[j];
      const p1 = solver._lColPtr[j+1];
      for (let p = p0; p < p1; p++) {
        console.log(`  L[${solver._lRowIdx[p]},${j}] = ${solver._lVals[p]}`);
      }
    }
    
    console.log("\nU:");
    for (let j = 0; j < 3; j++) {
      const p0 = solver._uColPtr[j];
      const p1 = solver._uColPtr[j+1];
      for (let p = p0; p < p1; p++) {
        console.log(`  U[${solver._uRowIdx[p]},${j}] = ${solver._uVals[p]}`);
      }
    }
    
    const x = new Float64Array(3);
    solver.solve(x);
    console.log("\nsolution:", Array.from(x));
    console.log("expected: [5, 2.5, -0.0025]");
  });
});
