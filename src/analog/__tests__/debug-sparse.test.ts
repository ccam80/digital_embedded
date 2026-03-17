import { describe, it, expect } from "vitest";
import { SparseSolver } from "../sparse-solver.js";

describe("debug", () => {
  it("mna_3x3_debug", () => {
    const G = 1 / 1000;
    const Vs = 5.0;
    const solver = new SparseSolver();
    solver.beginAssembly(3);
    solver.stamp(0, 0, G);
    solver.stamp(0, 1, -G);
    solver.stamp(0, 2, 1);
    solver.stamp(1, 0, -G);
    solver.stamp(1, 1, G + G);
    solver.stamp(2, 0, 1);
    solver.stampRHS(2, Vs);
    solver.finalize();
    const result = solver.factor();
    console.log("factor result:", result);
    const x = new Float64Array(3);
    solver.solve(x);
    console.log("solution:", Array.from(x));
    console.log("expected: [5, 2.5, -0.0025]");
    expect(x[0]).toBeCloseTo(5.0, 10);
  });
});
