import { describe, it } from "vitest";
import { AnalogTappedTransformerElement } from "../tapped-transformer.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { MODETRAN, MODEINITTRAN, MODEINITFLOAT } from "../../../solver/analog/ckt-mode.js";
import { allocateStatePool, makeVoltageSource, makeResistor } from "../../../solver/analog/__tests__/test-helpers.js";
import type { AnalogElementCore } from "../../../solver/analog/element.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";

const N = 2, Vpeak = 10.0, freq = 1000, Lp = 500e-3, k = 0.99;
const Rload = 100e3;
const dt = 1 / (freq * 400);
const nodeCount = 4;
const bVsrc = nodeCount + 0;
const bTx1 = nodeCount + 1;
const matrixSize = nodeCount + 4;

function makeTransientCtx(solver: SparseSolverType, voltages: Float64Array, dt: number, mode: number): LoadContext {
  const ag = new Float64Array(7);
  if (dt > 0) { ag[0] = 1/dt; ag[1] = -1/dt; }
  return {
    cktMode: mode,
    solver: solver as unknown as import("../../../solver/analog/sparse-solver.js").SparseSolver,
    voltages,
    dt,
    method: "trapezoidal" as "trapezoidal",
    order: 1,
    deltaOld: [dt,dt,dt,dt,dt,dt,dt],
    ag,
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    xfact: 1,
    gmin: 1e-12,
    reltol: 1e-3,
    iabstol: 1e-12,
    cktFixLimit: false,
    bypass: false,
    voltTol: 1e-6,
  };
}

function doStep(tx: AnalogTappedTransformerElement, solver: SparseSolver, voltages: Float64Array, vSrc: number, mode: number): boolean {
  // Run NR iterations so PHI converges with voltages
  let prev = new Float64Array(voltages);
  for (let nr = 0; nr < 5; nr++) {
    const ctx = makeTransientCtx(solver as unknown as SparseSolverType, voltages, dt, mode);
    const vsrc = makeVoltageSource(1, 0, bVsrc, vSrc);
    const rLoad = makeResistor(2, 4, Rload);
    const rCtGnd = makeResistor(3, 0, 1e6);
    const rS2Gnd = makeResistor(4, 0, 1e6);
    solver._initStructure(matrixSize);
    vsrc.load(ctx);
    tx.load(ctx);
    rLoad.load(ctx);
    rCtGnd.load(ctx);
    rS2Gnd.load(ctx);
    const res = solver.factor();
    if (res !== 0) return false;
    solver.solve(voltages);
    // Check convergence
    let conv = true;
    for (let j = 0; j < voltages.length; j++) {
      if (Math.abs(voltages[j] - prev[j]) > 1e-9 * (1 + Math.abs(voltages[j]))) { conv = false; break; }
    }
    prev = new Float64Array(voltages);
    if (conv) break;
  }
  return true;
}

describe("tx trace with NR", () => {
  it("traces transformer with NR per step", () => {
    const tx = new AnalogTappedTransformerElement([1, 0, 2, 3, 4], bTx1, Lp, N, k, 0, 0);
    const pool = allocateStatePool([tx as AnalogElementCore]);
    const solver = new SparseSolver();
    let voltages = new Float64Array(matrixSize);

    let maxVS1CT = 0;
    for (let i = 0; i < 400; i++) {
      const t = i * dt;
      const vSrc = Vpeak * Math.sin(2 * Math.PI * freq * t);
      const mode = i === 0 ? (MODETRAN | MODEINITTRAN) : (MODETRAN | MODEINITFLOAT);

      const ok = doStep(tx, solver, voltages, vSrc, mode);
      if (!ok) { console.log(`Singular at step ${i}`); break; }

      const vs1 = voltages[1], vct = voltages[2];
      if (i < 5 || i % 50 === 0) {
        console.log(`step=${i} t=${t.toExponential(2)} vSrc=${vSrc.toFixed(4)} vs1=${vs1.toFixed(5)} vct=${vct.toFixed(5)} |vs1-vct|=${Math.abs(vs1-vct).toFixed(5)}`);
      }
      if (Math.abs(vs1-vct) > maxVS1CT) maxVS1CT = Math.abs(vs1-vct);

      pool.rotateStateVectors();
    }
    console.log(`maxVS1CT after 400 steps (1 cycle) = ${maxVS1CT}`);
  });
});
