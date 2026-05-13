/** PROBE (temporary): localize the residual TRA matched-load 1-ULP gap.
 *
 * Step 0 attempt 0 (dcopInitJct) iter 0:
 *   matrix bit-identical, rhs bit-identical, voltages diverge by 1 ULP.
 * Step 0 attempt 0 runs _spOrderAndFactor (FIRST factor, no _spPartition).
 *   → doRealDirect / partition is NOT relevant for the observed iter-0 gap.
 *
 * Step 0 attempt 1+ (dcopInitFix, dcopInitFloat, …) reuse the ordering via
 *   _spFactor, which calls _spPartition once.
 *
 * This probe captures, post-DCOP:
 *   - doRealDirect array (partition decisions for each step)
 *   - markowitz row/col/prod arrays (the partition op-count inputs)
 * and prints the ngspice partition formula side-by-side so a human can
 * verify our decisions match what ngspice would compute from the same matrix.
 */

import { it } from "vitest";
import path from "node:path";

import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  DLL_PATH,
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { SparseSolverInstrumentation } from "../../../solver/analog/sparse-solver-instrumentation.js";

const DTS = path.resolve(
  "src/components/passives/__tests__/fixtures/transmission-line-canon-matched-load.dts",
);

describeIfDll("TL probe — partition decisions", () => {
  it("dump doRealDirect and partition op-counts post-DCOP", async () => {
    const session = await ComparisonSession.create({ dtsPath: DTS, dllPath: DLL_PATH });
    await session.runDcOp();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine: any = (session as any)._engine;
    const solver = engine.solver;
    const inst = new SparseSolverInstrumentation(solver);

    // eslint-disable-next-line no-console
    console.log(`partitioned=${solver.partitioned} reordered=${inst.solver.reordered}`);

    const dim = inst.dimension;
    const drd = solver.doRealDirect;
    const nc = inst.markowitzRow;
    const no = inst.markowitzCol;
    const nm = inst.markowitzProd;

    // eslint-disable-next-line no-console
    console.log(`dim=${dim} drd.length=${drd.length}`);
    // eslint-disable-next-line no-console
    console.log("step | doRealDirect | Nc(MarkowitzRow) | No(MarkowitzCol) | Nm(MarkowitzProd) | expected=nm+no>3*nc-2*nm");
    for (let step = 1; step <= dim; step++) {
      const expected = (nm[step] + no[step] > 3 * nc[step] - 2 * nm[step]) ? 1 : 0;
      const match = expected === drd[step];
      // eslint-disable-next-line no-console
      console.log(`  ${step} | ${drd[step]} | ${nc[step]} | ${no[step]} | ${nm[step]} | ${expected} ${match ? "OK" : "MISMATCH"}`);
    }

    await session.dispose();
  });
});
