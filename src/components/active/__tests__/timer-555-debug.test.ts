/**
 * Diagnostic test for timer-555 transient failure.
 * DELETE after fixing.
 */
import { describe, it } from "vitest";
import { EngineState } from "../../../core/engine-interface.js";
import { Timer555Definition } from "../timer-555.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import { MNAEngine } from "../../../solver/analog/analog-engine.js";
import { ConcreteCompiledAnalogCircuit } from "../../../solver/analog/compiled-analog-circuit.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
import {
  createTestCapacitor,
  makeVoltageSource,
  makeResistor,
} from "../../../solver/analog/__tests__/test-helpers.js";
import type { SetupContext } from "../../../solver/analog/setup-context.js";

function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

const TIMER555_MODEL_PARAM_KEYS = new Set(["vDrop", "rDischarge"]);

function makeProps(overrides: Record<string, number | string> = {}): PropertyBag {
  const modelParams: Record<string, number> = { vDrop: 1.5, rDischarge: 10 };
  const staticEntries: [string, number | string][] = [["model", "bipolar"]];
  for (const [k, v] of Object.entries(overrides)) {
    if (TIMER555_MODEL_PARAM_KEYS.has(k)) {
      modelParams[k] = v as number;
    } else {
      staticEntries.push([k, v]);
    }
  }
  const bag = new PropertyBag(staticEntries);
  bag.replaceModelParams(modelParams);
  return bag;
}

function make555(
  nodes: { vcc: number; gnd: number; trig: number; thr: number; ctrl: number; rst: number; dis: number; out: number },
  overrides: Record<string, number | string> = {},
): AnalogElement {
  const core = getFactory(Timer555Definition.modelRegistry!["bipolar"]!)(
    new Map([
      ["DIS",  nodes.dis],
      ["TRIG", nodes.trig],
      ["THR",  nodes.thr],
      ["VCC",  nodes.vcc],
      ["CTRL", nodes.ctrl],
      ["OUT",  nodes.out],
      ["RST",  nodes.rst],
      ["GND",  nodes.gnd],
    ]),
    makeProps(overrides),
    () => 0,
  );
  return Object.assign(core, {
    pinNodeIds: [nodes.dis, nodes.trig, nodes.thr, nodes.vcc, nodes.ctrl, nodes.out, nodes.rst, nodes.gnd],
    allNodeIds: [nodes.dis, nodes.trig, nodes.thr, nodes.vcc, nodes.ctrl, nodes.out, nodes.rst, nodes.gnd],
  }) as AnalogElement;
}

function buildHandCircuit(opts: {
  nodeCount: number;
  elements: AnalogElement[];
}): ConcreteCompiledAnalogCircuit {
  return new ConcreteCompiledAnalogCircuit({
    nodeCount: opts.nodeCount,
    elements: opts.elements,
    labelToNodeId: new Map(),
    wireToNodeId: new Map() as any,
    models: new Map(),
    elementToCircuitElement: new Map(),
    statePool: new StatePool(0),
  });
}

function makeVsElement(
  nodePos: number,
  nodeNeg: number,
  branchIdx: number,
  voltage: number,
): AnalogElement {
  const base = makeVoltageSource(nodePos, nodeNeg, branchIdx, voltage);
  const k = branchIdx + 1;
  return Object.assign(base, {
    _stateBase: -1,
    _pinNodes: new Map<string, number>(),
    setup(ctx: SetupContext): void {
      if (nodePos !== 0) { ctx.solver.allocElement(nodePos, k); ctx.solver.allocElement(k, nodePos); }
      if (nodeNeg !== 0) { ctx.solver.allocElement(nodeNeg, k); ctx.solver.allocElement(k, nodeNeg); }
      ctx.solver.allocElement(k, k);
    },
  });
}

describe("Timer555Debug", () => {
  it("diagnose_first_transient_step", () => {
    const R1 = 1000;
    const R2 = 10000;
    const C  = 10e-6;
    const VCC = 5;

    const nVcc  = 1;
    const nDis  = 2;
    const nCap  = 3;
    const nOut  = 4;
    const nCtrl = 5;
    const nodeCount  = 5;
    const brVcc = 11;

    const timer = make555(
      { vcc: nVcc, gnd: 0, trig: nCap, thr: nCap, ctrl: nCtrl, rst: nVcc, dis: nDis, out: nOut },
      { vDrop: 1.5 },
    );

    const vsVcc  = makeVsElement(nVcc, 0, brVcc, VCC);
    const r1El   = makeResistor(nVcc, nDis, R1);
    const r2El   = makeResistor(nDis, nCap, R2);
    const capEl  = createTestCapacitor(C, nCap, 0);

    const elements = [timer, vsVcc, r1El, r2El, capEl];
    const compiled = buildHandCircuit({ nodeCount, elements });
    const engine = new MNAEngine();
    engine.init(compiled);

    const dcResult = engine.dcOperatingPoint();
    console.log("DC converged:", dcResult.converged, "iters:", dcResult.iterations);
    const dcVoltages = Array.from(dcResult.nodeVoltages).map((v, i) => `[${i}]=${v.toFixed(4)}`).join(", ");
    console.log("DC node voltages:", dcVoltages);

    // Access engine's internal pool via ctx (not compiled.statePool which is the dummy)
    const ctx = (engine as any)._ctx;
    const pool = ctx?.statePool as StatePool | null;
    if (!pool) {
      console.log("No state pool found");
    } else {
      // Find cap stateBaseOffset — capEl is AnalogCapacitorElement, has stateBaseOffset
      const capBase = (capEl as any).stateBaseOffset as number;
      const SLOT_Q = 3, SLOT_CCAP = 4;
      console.log(`Cap stateBaseOffset=${capBase}, pool.totalSlots=${pool.totalSlots}`);
      console.log(`After DC-OP: states[0][Q]=${pool.states[0][capBase+SLOT_Q]?.toExponential(4)}, states[1][Q]=${pool.states[1][capBase+SLOT_Q]?.toExponential(4)}, states[2][Q]=${pool.states[2][capBase+SLOT_Q]?.toExponential(4)}, states[3][Q]=${pool.states[3][capBase+SLOT_Q]?.toExponential(4)}`);
    }

    const fExpected = 1.44 / ((R1 + 2 * R2) * C);
    const periodExpected = 1 / fExpected;
    const maxDt = periodExpected * 0.002;
    engine.configure({ maxTimeStep: maxDt });

    // Enable convergence log from the start
    engine.convergenceLog.enabled = true;

    // Run a few steps and print cap state at each
    let stepCount = 0;
    const maxSteps = 20;
    while (stepCount < maxSteps && engine.getState() !== EngineState.ERROR) {
      engine.step();
      stepCount++;
      if (pool) {
        const capBase = (capEl as any).stateBaseOffset as number;
        const SLOT_Q = 3, SLOT_CCAP = 4;
        const q0 = pool.states[0][capBase+SLOT_Q];
        const q1 = pool.states[1][capBase+SLOT_Q];
        const q2 = pool.states[2][capBase+SLOT_Q];
        const q3 = pool.states[3][capBase+SLOT_Q];
        const ccap0 = pool.states[0][capBase+SLOT_CCAP];
        const ccap1 = pool.states[1][capBase+SLOT_CCAP];
        console.log(`Step ${stepCount} (t=${engine.simTime.toExponential(3)}): q0=${q0?.toExponential(4)} q1=${q1?.toExponential(4)} q2=${q2?.toExponential(4)} q3=${q3?.toExponential(4)} ccap0=${ccap0?.toExponential(4)} ccap1=${ccap1?.toExponential(4)}`);
      }
    }

    const log = engine.convergenceLog;
    const all = log.getAll();
    console.log(`\nTotal log records: ${all.length}, engine state: ${engine.getState()}`);
    for (const rec of all.slice(0, 5)) {
      const lteInfo = rec.lteRejected ? ` LTE_REJECTED ratio=${rec.lteWorstRatio?.toFixed(3)} proposedDt=${rec.lteProposedDt?.toExponential(3)}` : "";
      console.log(`  step#${rec.stepNumber} t=${rec.simTime.toExponential(3)} outcome=${rec.outcome}${lteInfo}`);
      for (const att of rec.attempts) {
        console.log(`    attempt dt=${att.dt?.toExponential(3)} converged=${att.converged} iters=${att.iterations} trigger=${att.trigger}`);
      }
    }
  });
});
