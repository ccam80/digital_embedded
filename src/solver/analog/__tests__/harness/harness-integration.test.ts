/**
 * Integration test for the comparison harness infrastructure.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MNAEngine } from "../../analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../../analog-engine.js";
import { EngineState } from "../../../../core/engine-interface.js";
import { makeResistor, makeVoltageSource, makeDiode, makeCapacitor } from "../test-helpers.js";
import { StatePool } from "../../state-pool.js";
import type { AnalogElementCore } from "../../element.js";
import { isPoolBacked } from "../../element.js";
import { captureTopology, captureElementStates, createIterationCaptureHook, createStepCaptureHook } from "./capture.js";
import { convergenceSummary, nodeVoltageTrajectory, findLargestDelta, querySteps } from "./query.js";
import { compareSnapshots, formatComparison, findFirstDivergence } from "./compare.js";
import type { CaptureSession } from "./types.js";
import { DEVICE_MAPPINGS } from "./device-mappings.js";

function buildStatePool(elements: AnalogElementCore[]): StatePool {
  let offset = 0;
  for (const el of elements) {
    if (isPoolBacked(el)) { el.stateBaseOffset = offset; offset += el.stateSize; }
  }
  const pool = new StatePool(offset);
  for (const el of elements) {
    if (isPoolBacked(el)) el.initState(pool);
  }
  return pool;
}

function makeHWR() {
  const vs = makeVoltageSource(1, 0, 2, 5.0);
  const r = makeResistor(1, 2, 1000);
  const diode = makeDiode(2, 0, 1e-14, 1.0);
  const elements = [vs, r, diode];
  const pool = buildStatePool(elements);
  return {
    circuit: { netCount: 2, componentCount: 3, nodeCount: 2, branchCount: 1, matrixSize: 3, elements, labelToNodeId: new Map([["Vs", 1], ["R1:B", 2]]), statePool: pool } as ConcreteCompiledAnalogCircuit,
    pool,
  };
}

function makeRC() {
  const vs = makeVoltageSource(1, 0, 2, 5.0);
  const r = makeResistor(1, 2, 1000);
  const cap = makeCapacitor(2, 0, 1e-6);
  const elements = [vs, r, cap];
  const pool = buildStatePool(elements);
  return {
    circuit: { netCount: 2, componentCount: 3, nodeCount: 2, branchCount: 1, matrixSize: 3, elements, labelToNodeId: new Map([["Vs", 1], ["C1:A", 2]]), statePool: pool } as ConcreteCompiledAnalogCircuit,
    pool,
  };
}

describe("harness integration", () => {
  let engine: MNAEngine;
  beforeEach(() => { engine = new MNAEngine(); });

  it("captureTopology returns correct circuit structure", () => {
    const { circuit } = makeHWR();
    const topo = captureTopology(circuit);
    expect(topo.matrixSize).toBe(3);
    expect(topo.nodeCount).toBe(2);
    expect(topo.branchCount).toBe(1);
    expect(topo.elementCount).toBe(3);
    expect(topo.elements).toHaveLength(3);
    expect(topo.nodeLabels.size).toBeGreaterThan(0);
  });

  it("captureElementStates snapshots pool-backed elements", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    engine.dcOperatingPoint();
    const states = captureElementStates(circuit.elements, pool);
    expect(states.length).toBeGreaterThan(0);
  });

  it("iteration capture hook records NR iterations during DC OP", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    const { hook, getSnapshots, clear } = createIterationCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = hook;
    engine.dcOperatingPoint();
    const snapshots = getSnapshots();
    expect(snapshots.length).toBeGreaterThan(0);
    const first = snapshots[0];
    expect(first.iteration).toBe(0);
    expect(first.voltages).toBeInstanceOf(Float64Array);
    expect(first.voltages.length).toBeGreaterThan(0);
    expect(first.rhs).toBeInstanceOf(Float64Array);
    expect(first.matrix.length).toBeGreaterThan(0);
    expect(typeof first.noncon).toBe("number");
    expect(typeof first.globalConverged).toBe("boolean");
    expect(typeof first.elemConverged).toBe("boolean");
    const last = snapshots[snapshots.length - 1];
    expect(last.globalConverged).toBe(true);
    clear();
    expect(getSnapshots()).toHaveLength(0);
  });

  it("postIterationHook fires during DC OP (nonlinear circuit)", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    let hookCallCount = 0;
    engine.postIterationHook = (_i: number, _v: Float64Array, _p: Float64Array, _n: number, _g: boolean, _e: boolean) => { hookCallCount++; };
    const result = engine.dcOperatingPoint();
    expect(result.converged).toBe(true);
    expect(hookCallCount).toBeGreaterThan(0);
  });

  it("postIterationHook fires during DC OP (linear circuit)", () => {
    const { circuit, pool } = makeRC();
    engine.init(circuit);
    let hookCallCount = 0;
    let lastGlobalConverged = false;
    engine.postIterationHook = (_i: number, _v: Float64Array, _p: Float64Array, _n: number, g: boolean, _e: boolean) => {
      hookCallCount++;
      lastGlobalConverged = g;
    };
    const result = engine.dcOperatingPoint();
    expect(result.converged).toBe(true);
    expect(hookCallCount).toBeGreaterThan(0);
    expect(lastGlobalConverged).toBe(true);
  });

  it("step capture hook packages iterations into step snapshots", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    const capture = createStepCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = capture.hook;
    engine.dcOperatingPoint();
    capture.finalizeStep(0, 0, true);
    for (let i = 0; i < 10; i++) {
      engine.step();
      if (engine.getState() === EngineState.ERROR) break;
      capture.finalizeStep(engine.simTime, 0, true);
    }
    const steps = capture.getSteps();
    expect(steps.length).toBeGreaterThan(1);
    expect(steps[0].simTime).toBe(0);
    expect(steps[0].iterations.length).toBeGreaterThan(0);
  });

  it("convergenceSummary reports correct statistics", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    const capture = createStepCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = capture.hook;
    engine.dcOperatingPoint();
    capture.finalizeStep(0, 0, true);
    for (let i = 0; i < 5; i++) {
      engine.step();
      if (engine.getState() === EngineState.ERROR) break;
      capture.finalizeStep(engine.simTime, 0, true);
    }
    const session: CaptureSession = { source: "ours", topology: captureTopology(circuit), steps: capture.getSteps() };
    const summary = convergenceSummary(session);
    expect(summary.totalSteps).toBeGreaterThan(0);
    expect(summary.convergedSteps).toBe(summary.totalSteps);
    expect(summary.failedSteps).toBe(0);
    expect(summary.avgIterations).toBeGreaterThan(0);
  });

  it("nodeVoltageTrajectory returns voltage history", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    const capture = createStepCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = capture.hook;
    engine.dcOperatingPoint();
    capture.finalizeStep(0, 0, true);
    for (let i = 0; i < 5; i++) {
      engine.step();
      if (engine.getState() === EngineState.ERROR) break;
      capture.finalizeStep(engine.simTime, 0, true);
    }
    const session: CaptureSession = { source: "ours", topology: captureTopology(circuit), steps: capture.getSteps() };
    const trajectory = nodeVoltageTrajectory(session, 0);
    expect(trajectory.length).toBeGreaterThan(0);
    for (const point of trajectory) { expect(point.voltage).toBeCloseTo(5.0, 1); }
  });

  it("querySteps filters by convergence", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    const capture = createStepCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = capture.hook;
    engine.dcOperatingPoint();
    capture.finalizeStep(0, 0, true);
    const session: CaptureSession = { source: "ours", topology: captureTopology(circuit), steps: capture.getSteps() };
    expect(querySteps(session, { converged: true }).length).toBe(session.steps.length);
    expect(querySteps(session, { converged: false }).length).toBe(0);
  });

  it("compareSnapshots returns all-pass for self-comparison", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    const capture = createStepCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = capture.hook;
    engine.dcOperatingPoint();
    capture.finalizeStep(0, 0, true);
    const session: CaptureSession = { source: "ours", topology: captureTopology(circuit), steps: capture.getSteps() };
    const results = compareSnapshots(session, session);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.allWithinTol).toBe(true);
      expect(r.matrixDiffs).toHaveLength(0);
    }
  });

  it("formatComparison produces readable output", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    const capture = createStepCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = capture.hook;
    engine.dcOperatingPoint();
    capture.finalizeStep(0, 0, true);
    const session: CaptureSession = { source: "ours", topology: captureTopology(circuit), steps: capture.getSteps() };
    const formatted = formatComparison(compareSnapshots(session, session)[0]);
    expect(formatted).toContain("Step 0");
    expect(formatted).toContain("PASS");
  });

  it("findFirstDivergence returns null for identical sessions", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    const capture = createStepCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = capture.hook;
    engine.dcOperatingPoint();
    capture.finalizeStep(0, 0, true);
    const session: CaptureSession = { source: "ours", topology: captureTopology(circuit), steps: capture.getSteps() };
    expect(findFirstDivergence(compareSnapshots(session, session))).toBeNull();
  });

  it("DEVICE_MAPPINGS has populated MOSFET mapping", () => {
    const mos = DEVICE_MAPPINGS.mosfet;
    expect(Object.keys(mos.slotToNgspice).length).toBeGreaterThan(0);
    expect(Object.keys(mos.ngspiceToSlot).length).toBeGreaterThan(0);
    expect(mos.slotToNgspice["VGS"]).toBe(1);
    expect(mos.slotToNgspice["Q_GS"]).toBe(4);
    expect(mos.slotToNgspice["CCAP_GB"]).toBe(11);
  });

  it("MNAEngine exposes accessors after init", () => {
    const { circuit } = makeHWR();
    engine.init(circuit);
    expect(engine.solver).not.toBeNull();
    expect(engine.statePool).not.toBeNull();
    expect(engine.elements.length).toBe(3);
    expect(engine.compiled).not.toBeNull();
    expect(engine.compiled!.matrixSize).toBe(3);
  });

  it("MNAEngine accessors return null/empty before init", () => {
    expect(engine.solver).toBeNull();
    expect(engine.statePool).toBeNull();
    expect(engine.elements).toHaveLength(0);
    expect(engine.compiled).toBeNull();
  });

  it("SparseSolver exposes dimension, getRhsSnapshot, getCSCNonZeros", () => {
    const { circuit } = makeHWR();
    engine.init(circuit);
    engine.dcOperatingPoint();
    const solver = engine.solver!;
    expect(solver.dimension).toBe(3);
    const rhs = solver.getRhsSnapshot();
    expect(rhs).toBeInstanceOf(Float64Array);
    expect(rhs.length).toBe(3);
    const nz = solver.getCSCNonZeros();
    expect(nz.length).toBeGreaterThan(0);
    expect(nz[0]).toHaveProperty("row");
    expect(nz[0]).toHaveProperty("col");
    expect(nz[0]).toHaveProperty("value");
  });

  it("findLargestDelta identifies worst convergence point", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    const capture = createStepCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = capture.hook;
    engine.dcOperatingPoint();
    capture.finalizeStep(0, 0, true);
    const session: CaptureSession = { source: "ours", topology: captureTopology(circuit), steps: capture.getSteps() };
    const result = findLargestDelta(session, 1);
    expect(result).not.toBeNull();
    expect(result!.delta).toBeGreaterThan(0);
  });
});
