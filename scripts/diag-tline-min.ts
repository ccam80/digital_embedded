/**
 * Minimal repro of the propagation_delay hang — no patching, no proto wrapping.
 */
import { TransmissionLineDefinition } from "../src/components/passives/transmission-line.js";
import { PropertyBag } from "../src/core/properties.js";
import { ConcreteCompiledAnalogCircuit } from "../src/solver/analog/compiled-analog-circuit.js";
import { StatePool } from "../src/solver/analog/state-pool.js";
import { MNAEngine } from "../src/solver/analog/analog-engine.js";
import { EngineState } from "../src/core/engine-interface.js";
import { makeVoltageSource, makeResistor } from "../src/solver/analog/__tests__/test-helpers.js";
import type { ModelEntry, AnalogFactory } from "../src/core/registry.js";
import { openSync, writeSync } from "fs";

const FD = openSync(".diag-tline-min.log", "w");
function ck(label: string) {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${label}\n`;
  writeSync(FD, line);
  process.stderr.write(line);
}
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("expect inline");
  return entry.factory;
}
function buildNodeIds(p1: number, p2: number, fInt: number, N: number) {
  const ids = [p1, p2];
  for (let k = 0; k < N - 1; k++) ids.push(fInt + k);
  for (let k = 0; k < N - 1; k++) ids.push(fInt + (N - 1) + k);
  return ids;
}
function buildCirc(opts: any) {
  let off = 0;
  for (const el of opts.elements) {
    if (el.poolBacked) { el.stateBaseOffset = off; off += el.stateSize ?? 0; }
  }
  const sp = new StatePool(Math.max(off, 1));
  for (const el of opts.elements) if (el.poolBacked && el.initState) el.initState(sp);
  return new ConcreteCompiledAnalogCircuit({
    nodeCount: opts.nodeCount, branchCount: opts.branchCount, elements: opts.elements,
    labelToNodeId: new Map(), wireToNodeId: new Map(), models: new Map(),
    elementToCircuitElement: new Map(), statePool: sp,
  });
}

ck("start");
const Z0 = 50, tau = 10e-9, N = 20;
const ic = 2 * (N - 1), nc = 2 + ic, vsBr = nc, firstLBr = nc + 1;
const ids = buildNodeIds(1, 2, 3, N);
const props = new PropertyBag();
props.setModelParam("impedance", Z0);
props.setModelParam("delay", tau);
props.setModelParam("lossPerMeter", 0);
props.setModelParam("length", 1.0);
props.setModelParam("segments", N);

const tl = getFactory(TransmissionLineDefinition.modelRegistry!.behavioral!)(
  new Map([["P1b", ids[0]], ["P2b", ids[1]], ["P1a", 0], ["P2a", 0]]), ids.slice(2), firstLBr, props, () => 0,
);
const vs = makeVoltageSource(1, 0, vsBr, 1.0);
const rL = makeResistor(2, 0, Z0);
const c1 = buildCirc({ nodeCount: nc, branchCount: 1 + N, elements: [vs, tl, rL] });

ck("built compiled1");

const e1 = new MNAEngine();
e1.init(c1);
e1.configure({ maxTimeStep: tau / 10 });

// Wrap solver methods on the prototype to log entry/exit for the hang search.
const ctx1 = (e1 as any).cktContext;
const proto = Object.getPrototypeOf(ctx1.solver);
let factorCount = 0, pivotCount = 0;
for (const name of ["factor", "factorNumerical", "factorWithReorder", "_numericLUMarkowitz", "_numericLUReusePivots", "_searchForPivot"]) {
  const orig = proto[name];
  if (typeof orig !== "function") continue;
  proto[name] = function (...args: any[]) {
    if (name === "factor") factorCount++;
    if (name === "_searchForPivot") pivotCount++;
    const argsStr = args.map(a => typeof a === "number" ? String(a) : "..").join(",");
    ck(`  ENTER ${name}(${argsStr})`);
    const r = orig.apply(this, args);
    const summary = r && typeof r === "object"
      ? `success=${r.success}${r.rejectedAtStep != null ? " rejAt=" + r.rejectedAtStep : ""}${r.singularRow != null ? " sing=" + r.singularRow : ""}`
      : `ret=${r}`;
    ck(`  EXIT  ${name} ${summary}`);
    return r;
  };
}

ck("engine1 configured, calling dcOperatingPoint");

const dc = e1.dcOperatingPoint();
ck(`dcop converged=${dc.converged} iters=${dc.iterations}`);

const c2 = buildCirc({ nodeCount: nc, branchCount: 1 + N, elements: [vs, tl, rL] });
const e2 = new MNAEngine();
e2.init(c2);
e2.configure({ maxTimeStep: tau / 20 });
ck("engine2 configured, starting step loop");

let steps = 0;
const t0 = Date.now();
while (e2.simTime < 0.8 * tau && steps < 10000) {
  e2.step();
  steps++;
  if (steps <= 5 || steps % 50 === 0) ck(`step#${steps} simTime=${e2.simTime.toExponential(3)} dt=${e2.currentDt.toExponential(3)} state=${e2.getState()}`);
  if (e2.getState() === EngineState.ERROR) { ck("ERROR"); break; }
  if (Date.now() - t0 > 8_000) { ck(`bail at step ${steps}`); break; }
}
ck(`done steps=${steps}`);
