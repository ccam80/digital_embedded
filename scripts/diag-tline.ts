/**
 * Diagnostic for the transmission-line propagation_delay hang.
 * Mirrors the test body line by line, with stderr checkpoints.
 * Run: timeout 60 npx tsx scripts/diag-tline.ts
 */
import { TransmissionLineDefinition } from "../src/components/passives/transmission-line.js";
import { PropertyBag } from "../src/core/properties.js";
import { ConcreteCompiledAnalogCircuit } from "../src/solver/analog/compiled-analog-circuit.js";
import { StatePool } from "../src/solver/analog/state-pool.js";
import { MNAEngine } from "../src/solver/analog/analog-engine.js";
import { EngineState } from "../src/core/engine-interface.js";
import { makeVoltageSource, makeResistor } from "../src/solver/analog/__tests__/test-helpers.js";
import type { AnalogElement } from "../src/solver/analog/element.js";
import type { ModelEntry, AnalogFactory } from "../src/core/registry.js";

function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

import { openSync, writeSync } from "fs";
const LOG_FD = openSync(".diag-tline.log", "w");
function ck(label: string) {
  const line = `[${new Date().toISOString().slice(11, 23)}] CHECKPOINT ${label}\n`;
  writeSync(LOG_FD, line);
  process.stderr.write(line);
}

function buildNodeIds(port1: number, port2: number, firstInternal: number, N: number): number[] {
  const ids: number[] = [port1, port2];
  for (let k = 0; k < N - 1; k++) ids.push(firstInternal + k);
  for (let k = 0; k < N - 1; k++) ids.push(firstInternal + (N - 1) + k);
  return ids;
}

function buildTLineCircuit(opts: { nodeCount: number; branchCount: number; elements: AnalogElement[] }) {
  const allElements = opts.elements;
  let offset = 0;
  for (const el of allElements) {
    if ((el as any).poolBacked) {
      (el as any).stateBaseOffset = offset;
      offset += (el as any).stateSize ?? 0;
    }
  }
  const statePool = new StatePool(Math.max(offset, 1));
  for (const el of allElements) {
    if ((el as any).poolBacked && (el as any).initState) (el as any).initState(statePool);
  }
  return new ConcreteCompiledAnalogCircuit({
    nodeCount: opts.nodeCount,
    branchCount: opts.branchCount,
    elements: allElements,
    labelToNodeId: new Map(),
    wireToNodeId: new Map(),
    models: new Map(),
    elementToCircuitElement: new Map(),
    statePool,
  });
}

ck("start");

const Z0 = 50;
const tau = 10e-9;
const N = 20;
const internalCount = 2 * (N - 1);
const nodeCount = 2 + internalCount;
const vsBranchIdx = nodeCount;
const firstLBranch = nodeCount + 1;

const nodeIds = buildNodeIds(1, 2, 3, N);
const props = new PropertyBag();
props.setModelParam("impedance", Z0);
props.setModelParam("delay", tau);
props.setModelParam("lossPerMeter", 0);
props.setModelParam("length", 1.0);
props.setModelParam("segments", N);

ck("built props");

const tlineEl = getFactory(TransmissionLineDefinition.modelRegistry!.behavioral!)(
  new Map([["P1b", nodeIds[0]], ["P2b", nodeIds[1]], ["P1a", 0], ["P2a", 0]]), nodeIds.slice(2), firstLBranch, props, () => 0,
);

const vs = makeVoltageSource(1, 0, vsBranchIdx, 1.0);
const rLoad = makeResistor(2, 0, Z0);

const branchCount = 1 + N;
const compiled = buildTLineCircuit({
  nodeCount, branchCount, elements: [vs, tlineEl as any, rLoad],
});

ck("built compiled1");

const engine = new MNAEngine();
engine.init(compiled);
engine.configure({ maxTimeStep: tau / 10 });

ck("engine1 init+configure");

const dcResult = engine.dcOperatingPoint();
ck(`engine1.dcOperatingPoint() returned converged=${dcResult.converged} iters=${dcResult.iterations}`);

const compiled2 = buildTLineCircuit({
  nodeCount, branchCount, elements: [vs, tlineEl as any, rLoad],
});
const engine2 = new MNAEngine();
engine2.init(compiled2);
engine2.configure({ maxTimeStep: tau / 20 });

ck("engine2 init+configure");

let attemptIdx = 0;
let stepIdx = 0;

// Wire NR iteration hook + monkey-patch solver to find the exact hang site.
const ctx2 = (engine2 as any).cktContext;
if (ctx2) {
  const origFactor = ctx2.solver.factor.bind(ctx2.solver);
  const origSolve = ctx2.solver.solve.bind(ctx2.solver);
  let factorCount = 0, solveCount = 0;
  // Trace internal factor paths — keep only the names that are top-level.
  const proto = Object.getPrototypeOf(ctx2.solver);
  for (const name of ["factorNumerical", "factorWithReorder", "_numericLUMarkowitz", "_numericLUReusePivots", "_searchForPivot"]) {
    const orig = proto[name];
    if (typeof orig !== "function") continue;
    proto[name] = function (...args: any[]) {
      if (attemptIdx >= 4) ck(`    ${name}(${args.map(a => typeof a === "number" ? a : "...").join(",")}) ENTER singletons=${(this as any)._singletons}`);
      const r = orig.apply(this, args);
      if (attemptIdx >= 4) {
        const summary = r && typeof r === "object" ? `success=${r.success}${r.rejectedAtStep != null ? " rejAt=" + r.rejectedAtStep : ""}${r.singularRow != null ? " sing=" + r.singularRow : ""}` : `ret=${r}`;
        ck(`    ${name} EXIT ${summary}`);
      }
      return r;
    };
  }
  ctx2.solver.factor = function (gmin: number) {
    factorCount++;
    if (attemptIdx >= 4 && factorCount <= 80) ck(`  factor#${factorCount} attempt#${attemptIdx} gmin=${gmin} ENTER`);
    const r = origFactor(gmin);
    if (attemptIdx >= 4 && factorCount <= 80) ck(`  factor#${factorCount} attempt#${attemptIdx} EXIT success=${r.success}`);
    return r;
  };
  ctx2.solver.solve = function (rhs: Float64Array) {
    solveCount++;
    if (attemptIdx >= 4 && solveCount <= 80) ck(`  solve#${solveCount} attempt#${attemptIdx} ENTER`);
    const r = origSolve(rhs);
    if (attemptIdx >= 4 && solveCount <= 80) ck(`  solve#${solveCount} attempt#${attemptIdx} EXIT`);
    return r;
  };
  ctx2.postIterationHook = (iter: number, _rhs: any, _old: any, noncon: number, glob: boolean, elem: boolean) => {
    if (attemptIdx >= 4 && attemptIdx <= 6) {
      ck(`  NR iter#${iter} attempt#${attemptIdx} noncon=${noncon} globalConv=${glob} elemConv=${elem}`);
    }
  };
}
(engine2 as any).stepPhaseHook = {
  onAttemptBegin(phase: string, dt: number) {
    attemptIdx++;
    if (attemptIdx <= 60 || attemptIdx % 50 === 0) {
      ck(`step#${stepIdx} attempt#${attemptIdx} BEGIN phase=${phase} dt=${dt.toExponential(3)}`);
    }
  },
  onAttemptEnd(outcome: string, converged: boolean) {
    if (attemptIdx <= 60 || attemptIdx % 50 === 0) {
      ck(`step#${stepIdx} attempt#${attemptIdx} END outcome=${outcome} converged=${converged}`);
    }
  },
};

let steps = 0;
const t0 = Date.now();
while (engine2.simTime < 0.8 * tau && steps < 10000) {
  stepIdx = steps + 1;
  engine2.step();
  steps++;
  if (steps <= 5 || steps % 100 === 1) ck(`engine2.step #${steps} simTime=${engine2.simTime.toExponential(3)} dt=${engine2.currentDt.toExponential(3)} state=${engine2.getState()}`);
  if (engine2.getState() === EngineState.ERROR) { ck("engine2 ERROR"); break; }
  if (Date.now() - t0 > 15_000) { ck(`bailing at step ${steps} after 15s — attempts=${attemptIdx}`); break; }
}
ck(`first loop done steps=${steps} attempts=${attemptIdx}`);
