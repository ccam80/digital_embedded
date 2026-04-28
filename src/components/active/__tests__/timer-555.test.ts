/**
 * Tests for the 555 Timer IC composite analog model.
 *
 * Test handling per A1 §Test handling rule (spec/architectural-alignment.md §A1):
 *   - Post-load observable state (engine-agnostic, node voltages): KEPT
 *   - Parameter-plumbing (setParam on vDrop, rDischarge): KEPT
 *   - Engine-agnostic interface contracts: KEPT
 *   Timer555 parity (C4.5)::timer555_load_transient_parity
 *                                                bit-exact stamp assertions with
 *                                                 hand-computed NGSPICE_* expected values
 *
 * Kept tests:
 *   Timer555::internal_divider_voltages          observable node voltage (CTRL = 2/3 VCC)
 *                                                 via runDcOp; engine-agnostic.
 *   Astable::oscillates_at_correct_frequency     transient observable (transition count)
 *   Astable::duty_cycle                          transient observable (time-weighted)
 *   Monostable::pulse_width                      transient observable (pulse timing)
 *   Monostable::retrigger_ignored_during_pulse   transient observable (pulse width bound)
 *
 * Astable circuit:
 *   VCC=5V  R1  node_a  R2  node_b(THR=TRIG)  C  GND
 *   DIS connected to node_a (between R1 and R2)
 *   OUT connected to node_out
 *   CTRL connected to node_ctrl (floating via internal divider)
 *   RST connected to VCC
 *
 * The voltage divider inside the 555 sets CTRL  2/3 VCC = 3.33V.
 * Charging: through R1+R2, from 1/3 VCC to 2/3 VCC.
 * Discharging: through R2 (DIS discharges through R2), from 2/3 VCC to 1/3 VCC.
 * f = 1.44 / ((R1 + 2·R2) · C)
 * duty = (R1 + R2) / (R1 + 2·R2)
 */

import { describe, it, expect } from "vitest";
import { Timer555Definition } from "../timer-555.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import { MNAEngine } from "../../../solver/analog/analog-engine.js";
import { ConcreteCompiledAnalogCircuit } from "../../../solver/analog/compiled-analog-circuit.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import { EngineState } from "../../../core/engine-interface.js";
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
// StatePool used as placeholder in buildHandCircuit — engine creates the real pool in _setup().

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Create a 555 analog element with the given pin-to-node mapping.
 * Uses the 3-param factory signature (A6.3): (pinNodes, props, getTime).
 * Internal nodes (nLower, nComp1Out, nComp2Out, nDisBase) are allocated
 * during setup() via the engine's SetupContext.
 */
function make555(
  nodes: { vcc: number; gnd: number; trig: number; thr: number; ctrl: number; rst: number; dis: number; out: number },
  overrides: Record<string, number | string> = {},
): AnalogElement {
  // pinLayout order: [DIS, TRIG, THR, VCC, CTRL, OUT, RST, GND]
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
  return core;
}

// ---------------------------------------------------------------------------
// Helper: build hand-wired ConcreteCompiledAnalogCircuit
// ---------------------------------------------------------------------------

function buildHandCircuit(opts: {
  nodeCount: number;
  elements: AnalogElement[];
}): ConcreteCompiledAnalogCircuit {
  // Pass an empty placeholder StatePool — MNAEngine._setup() calls
  // allocateStateBuffers() which creates the real pool after setup() runs.
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

import { stampRHS } from "../../../solver/analog/stamp-helpers.js";
import { AnalogCapacitorElement } from "../../passives/capacitor.js";
import type { SetupContext } from "../../../solver/analog/setup-context.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";

/**
 * Inline resistor helper for circuit assembly. Stamps directly in load() with
 * no setup()-time handle allocation — compatible with engine-managed setup.
 */
function makeResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const G = 1 / resistance;
  return {
    label: "",
    _pinNodes: new Map<string, number>([["A", nodeA], ["B", nodeB]]),
    _stateBase: -1,
    branchIndex: -1,
    ngspiceLoadOrder: 40,
    setParam(_key: string, _value: number): void {},
    getPinCurrents(): number[] { return []; },
    setup(_ctx: SetupContext): void {},
    load(ctx: LoadContext): void {
      const { solver } = ctx;
      if (nodeA > 0) { const h = solver.allocElement(nodeA, nodeA); solver.stampElement(h, G); }
      if (nodeB > 0) { const h = solver.allocElement(nodeB, nodeB); solver.stampElement(h, G); }
      if (nodeA > 0 && nodeB > 0) {
        solver.stampElement(solver.allocElement(nodeA, nodeB), -G);
        solver.stampElement(solver.allocElement(nodeB, nodeA), -G);
      }
    },
  } as unknown as AnalogElement;
}

/**
 * Create a production AnalogCapacitorElement for circuit assembly.
 */
function createTestCapacitor(capacitance: number, nodePos: number, nodeNeg: number): AnalogElement {
  return new AnalogCapacitorElement(
    new Map([["pos", nodePos], ["neg", nodeNeg]]),
    capacitance,
    0,      // IC
    0,      // TC1
    0,      // TC2
    300.15, // TNOM
    1,      // SCALE
    1,      // M
  );
}

/**
 * Inline voltage source element with a real setup() that pre-allocates matrix
 * entries. branchIdx is used directly as the branch row (0-based MNA row).
 *
 * branchIdx must be chosen to not collide with any internal nodes or branch
 * rows that the Timer555 composite allocates during its own setup(). The
 * Timer555 allocates nodeCount+1 through nodeCount+6 (4 voltage nodes + 2
 * VCVS branch rows). A safe branchIdx is nodeCount+6 or higher.
 */
function makeVsElement(
  nodePos: number,
  nodeNeg: number,
  branchIdx: number,
  voltage: number,
): AnalogElement {
  const k = branchIdx;
  let _hPosK = -1, _hKPos = -1;
  let _hNegK = -1, _hKNeg = -1;
  return {
    label: "",
    _pinNodes: new Map<string, number>([["pos", nodePos], ["neg", nodeNeg]]),
    _stateBase: -1,
    branchIndex: k,
    ngspiceLoadOrder: 48,
    setup(ctx: SetupContext): void {
      if (nodePos !== 0) { _hPosK = ctx.solver.allocElement(nodePos, k); _hKPos = ctx.solver.allocElement(k, nodePos); }
      if (nodeNeg !== 0) { _hNegK = ctx.solver.allocElement(nodeNeg, k); _hKNeg = ctx.solver.allocElement(k, nodeNeg); }
      ctx.solver.allocElement(k, k);
    },
    load(ctx: LoadContext): void {
      const { solver, rhs } = ctx;
      if (nodePos !== 0) { solver.stampElement(_hPosK, 1); solver.stampElement(_hKPos, 1); }
      if (nodeNeg !== 0) { solver.stampElement(_hNegK, -1); solver.stampElement(_hKNeg, -1); }
      stampRHS(rhs, k, voltage);
    },
    setParam(_key: string, _value: number): void {},
    getPinCurrents(): number[] { return []; },
  } as unknown as AnalogElement;
}

// ---------------------------------------------------------------------------
// Timer555 unit tests  observable DC operating point
// ---------------------------------------------------------------------------

describe("Timer555", () => {
  it("internal_divider_voltages", () => {
    // CTRL pin floating: internal divider sets CTRL  2/3 × VCC.
    // With VCC=5V: CTRL  3.333V ±1%
    // Solve DC with VCC=5V fixed, CTRL floating (driven only by internal divider).
    //
    // Node assignment:
    //   node 1 = VCC, node 2 = GND (connected to circuit ground=0 via VS),
    //   node 3 = TRIG, node 4 = THR, node 5 = CTRL
    //   node 6 = RST (tied to VCC), node 7 = DIS, node 8 = OUT
    //
    // For a simpler approach: use 1-based nodes, VCC=1, GND=2(=circuit GND),
    // CTRL=3 (floating, driven only by internal divider).
    // The 555 stamps 5kΩ from VCC→CTRL and 10kΩ from CTRL→GND.
    // DC solve gives CTRL = VCC * (10k/15k) = 2/3 VCC.
    //
    // Let GND node = circuit ground (node 0). VCC node=1, CTRL node=2,
    // THR/TRIG/RST/DIS/OUT = don't care nodes for this test.
    // branchCount=1 (VCC voltage source), matrixSize=5.
    //
    // Nodes: 1=VCC, 2=CTRL, 3=TRIG(unused), 4=THR(unused), 5=RST(=VCC)
    //         DIS=0(GND), OUT=0(GND)  grounded for simplicity
    const VCC = 5;
    const nVcc = 1, nGnd = 0, nTrig = 0, nThr = 0, nCtrl = 2;
    const nRst = 1; // RST tied to VCC
    const nDis = 0, nOut = 0; // OUT grounded — not relevant for this test
    // nodeCount=2 (VCC=1, CTRL=2). Timer555 allocates indices 3-8 internally
    // (nLower=3, nComp1Out=4, nComp2Out=5, nDisBase=6, comp1_br=7, comp2_br=8).
    // VCC voltage source branch: brVcc=8 → k=9 (above all timer internal allocs).
    const nodeCount = 2;
    const brVcc = 8; // safe: k=brVcc+1=9, above timer's internal range 3-8

    const timer = make555(
      { vcc: nVcc, gnd: nGnd, trig: nTrig, thr: nThr, ctrl: nCtrl, rst: nRst, dis: nDis, out: nOut },
    );

    const vsVcc = makeVsElement(nVcc, nGnd, brVcc, VCC);

    const elements = [timer, vsVcc];
    const compiled = buildHandCircuit({ nodeCount, elements });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);

    const vCtrlSolved = result.nodeVoltages[nCtrl];
    const vExpected = VCC * (2 / 3);
    const errorPct = Math.abs(vCtrlSolved - vExpected) / vExpected * 100;

    // CTRL  2/3 VCC ±1%
    expect(errorPct).toBeLessThan(1);

    // Trigger reference = CTRL/2  1/3 VCC ±1%
    const vTrigRef = vCtrlSolved * 0.5;
    const vTrigExpected = VCC / 3;
    const trigErrorPct = Math.abs(vTrigRef - vTrigExpected) / vTrigExpected * 100;
    expect(trigErrorPct).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// Astable (free-running) transient tests
// ---------------------------------------------------------------------------

/**
 * Astable 555 circuit:
 *
 *   VCC → R1 → node_a → R2 → node_b → C → GND
 *                     ↑                  ↑
 *                    DIS               THR, TRIG
 *
 * The DIS pin connects between R1 and R2 (node_a).
 * THR and TRIG are both connected to node_b (the capacitor top plate).
 *
 * Charge path: VCC → R1 → R2 → C (DIS is OFF/Hi-Z)
 * Discharge path: C → R2 → DIS (which sinks to GND through R_sat)
 *
 * Timing:
 *   t_high = 0.693 × (R1 + R2) × C
 *   t_low  = 0.693 × R2 × C
 *   T      = t_high + t_low = 0.693 × (R1 + 2R2) × C
 *   f      = 1.44 / ((R1 + 2R2) × C)
 *   duty   = (R1 + R2) / (R1 + 2R2)
 *
 * For R1=1kΩ, R2=10kΩ, C=10µF:
 *   f  1.44 / (21000 × 10e-6) = 6.857 Hz  period  145.8ms
 *   duty  11/21  52.38%
 *
 * Node assignment for MNA:
 *   1 = VCC (fixed at 5V via voltage source, branch 0)
 *   2 = node_a (DIS, R1-R2 junction)
 *   3 = node_b (THR, TRIG, capacitor top plate)
 *   4 = OUT    (output)
 *   5 = CTRL   (floating, internal divider from VCC)
 *   GND = 0 (circuit ground)
 *   RST = VCC = node 1 (always active)
 *
 * Elements:
 *   VS_VCC:   voltage source, 5V, node1→GND, branch row 5
 *   R1:       1kΩ, node1→node2
 *   R2:       10kΩ, node2→node3
 *   C:        10µF, node3→GND
 *   timer555: [VCC=1, GND=0, TRIG=3, THR=3, CTRL=5, RST=1, DIS=2, OUT=4]
 *
 * nodeCount=5 (VCC, node_a, node_b, OUT, CTRL)
 * branchCount=1 (VS_VCC branch row = nodeCount = 5)
 * matrixSize = 6
 */

function buildAstableCircuit(R1: number, R2: number, C: number, VCC: number, vDrop: number): {
  engine: MNAEngine;
  nOut: number;
  nCap: number;
} {
  const nVcc  = 1; // VCC node
  const nDis  = 2; // DIS pin / R1-R2 junction
  const nCap  = 3; // capacitor top / THR / TRIG
  const nOut  = 4; // output
  const nCtrl = 5; // CTRL (floating via internal divider)

  const nodeCount  = 5;
  // Timer555 allocates nodeCount+1..nodeCount+6 internally (4 voltage + 2 VCVS branches).
  // nodeCount=5 → timer range 6-11. Safe VCC branch: brVcc=11 → k=12.
  const brVcc = 11;

  const timer = make555(
    { vcc: nVcc, gnd: 0, trig: nCap, thr: nCap, ctrl: nCtrl, rst: nVcc, dis: nDis, out: nOut },
    { vDrop },
  );

  const vsVcc  = makeVsElement(nVcc, 0, brVcc, VCC);
  const r1El   = makeResistor(nVcc, nDis, R1);
  const r2El   = makeResistor(nDis, nCap, R2);
  const capEl  = createTestCapacitor(C, nCap, 0);

  const elements = [timer, vsVcc, r1El, r2El, capEl];

  const compiled = buildHandCircuit({ nodeCount, elements });

  const engine = new MNAEngine();
  engine.init(compiled);

  return { engine, nOut, nCap };
}

describe("Astable", () => {
  it("oscillates_at_correct_frequency", () => {
    const R1 = 1000;    // 1kΩ
    const R2 = 10000;   // 10kΩ
    const C  = 10e-6;   // 10µF
    const VCC = 5;

    // Expected: f = 1.44 / ((R1 + 2*R2) * C) = 1.44 / (21000 * 10e-6)  6.857 Hz
    const fExpected = 1.44 / ((R1 + 2 * R2) * C);
    const periodExpected = 1 / fExpected;

    const { engine, nOut } = buildAstableCircuit(R1, R2, C, VCC, 1.5);

    // Run DC operating point first to initialize
    const dcResult = engine.dcOperatingPoint();
    expect(dcResult.converged).toBe(true);

    // Use timestep = 0.2% of period for accurate threshold-crossing resolution
    engine.configure({ maxTimeStep: periodExpected * 0.002 });

    // Skip the first period (initial transient from DC state differs from
    // steady-state). Measure frequency over periods 2-6 (5 steady-state periods).
    const warmupTime = periodExpected * 1.5;
    let steps = 0;
    const maxStepsWarmup = 10000;
    while (engine.simTime < warmupTime && steps < maxStepsWarmup) {
      engine.step();
      steps++;
      if (engine.getState() === EngineState.ERROR) break;
    }
    expect(engine.getState()).not.toBe(EngineState.ERROR);

    // Now measure 5 complete steady-state periods
    let transitions = 0;
    let prevOutVoltage = engine.getNodeVoltage(nOut);
    const midVoltage = VCC / 2;
    const measureStart = engine.simTime;
    const measureTime = 5 * periodExpected;
    steps = 0;
    const maxSteps = 50000;

    while (engine.simTime < measureStart + measureTime && steps < maxSteps) {
      engine.step();
      steps++;
      if (engine.getState() === EngineState.ERROR) break;

      const vOut = engine.getNodeVoltage(nOut);
      if ((prevOutVoltage < midVoltage && vOut >= midVoltage) ||
          (prevOutVoltage >= midVoltage && vOut < midVoltage)) {
        transitions++;
      }
      prevOutVoltage = vOut;
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);

    // 5 complete steady-state periods = 10 transitions
    expect(transitions).toBeGreaterThanOrEqual(8);
    expect(transitions).toBeLessThanOrEqual(12);

    // Measure frequency from steady-state transitions over known time window
    const fMeasured = transitions / 2 / measureTime;
    const fError = Math.abs(fMeasured - fExpected) / fExpected;
    // Within 10% (spec requirement; accounts for timestep quantization)
    expect(fError).toBeLessThan(0.10);
  });

  it("duty_cycle", () => {
    const R1 = 1000;
    const R2 = 10000;
    const C  = 10e-6;
    const VCC = 5;

    // Expected duty cycle: (R1 + R2) / (R1 + 2*R2) = 11000/21000  52.38%
    const dutyExpected = (R1 + R2) / (R1 + 2 * R2);
    const fExpected = 1.44 / ((R1 + 2 * R2) * C);
    const periodExpected = 1 / fExpected;

    const { engine, nOut } = buildAstableCircuit(R1, R2, C, VCC, 1.5);

    const dcResult = engine.dcOperatingPoint();
    expect(dcResult.converged).toBe(true);

    // Use timestep = 0.2% of period for accurate threshold-crossing resolution
    engine.configure({ maxTimeStep: periodExpected * 0.002 });

    // Skip first period (initial transient)
    const warmupTime = periodExpected * 1.5;
    let steps = 0;
    while (engine.simTime < warmupTime && steps < 10000) {
      engine.step();
      steps++;
      if (engine.getState() === EngineState.ERROR) break;
    }
    expect(engine.getState()).not.toBe(EngineState.ERROR);

    // Measure duty cycle over 5 steady-state periods
    let timeHigh = 0;
    let timeLow = 0;
    const measureStart = engine.simTime;
    const measureTime = 5 * periodExpected;
    steps = 0;
    const maxSteps = 50000;

    while (engine.simTime < measureStart + measureTime && steps < maxSteps) {
      const tBefore = engine.simTime;
      engine.step();
      steps++;
      if (engine.getState() === EngineState.ERROR) break;

      const dt = engine.simTime - tBefore;
      const vOut = engine.getNodeVoltage(nOut);
      const isHigh = vOut > VCC / 2;

      if (isHigh) {
        timeHigh += dt;
      } else {
        timeLow += dt;
      }
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);

    const totalMeasured = timeHigh + timeLow;
    expect(totalMeasured).toBeGreaterThan(0);

    const dutyMeasured = timeHigh / totalMeasured;
    const dutyError = Math.abs(dutyMeasured - dutyExpected) / dutyExpected;

    // Within 5% relative error
    expect(dutyError).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// Monostable (one-shot) transient tests
// ---------------------------------------------------------------------------

/**
 * Monostable 555 circuit:
 *
 *   VCC → R → node_thr → C → GND
 *                   ↑
 *                  THR (and DIS)
 *
 *   TRIG: externally driven (pulsed low to trigger)
 *   OUT: monitored for pulse width
 *
 * Initial state: C is discharged, TRIG is high (idle).
 * The 555 is in RESET state (Q=0, output low, DIS grounds C through R_sat).
 *
 * Trigger event: TRIG goes below 1/3 VCC  SET (Q=1, output high, DIS off).
 * C now charges through R from VCC.
 * When V_C reaches 2/3 VCC  RESET (Q=0, output low, DIS discharges C).
 *
 * Pulse width: t_W = 1.1 × R × C
 * For R=100kΩ, C=1µF: t_W = 1.1 × 100e3 × 1e-6 = 110ms
 *
 * Node assignment:
 *   1 = VCC     (fixed at 5V, branch 0)
 *   2 = THR     (capacitor top plate = DIS pin connects here)
 *   3 = TRIG    (driven by external "source")
 *   4 = OUT     (output)
 *   5 = CTRL    (floating, internal divider)
 *   GND = 0
 *   RST = VCC = node 1
 *
 * Elements:
 *   VS_VCC:    5V source, node1→GND, branch 5
 *   R:         100kΩ, node1→node2
 *   C:         1µF, node2→GND
 *   VS_TRIG:   voltage source controlling TRIG, node3→GND, branch 6
 *   timer555:  [VCC=1, GND=0, TRIG=3, THR=2, CTRL=5, RST=1, DIS=2, OUT=4]
 *
 * nodeCount=5, branchCount=2, matrixSize=7
 */

function buildMonostableCircuit(R: number, Cval: number, VCC: number): {
  engine: MNAEngine;
  nOut: number;
  setTrig: (v: number) => void;
} {
  const nVcc  = 1;
  const nThr  = 2; // capacitor top / THR / DIS
  const nTrig = 3;
  const nOut  = 4;
  const nCtrl = 5;

  const nodeCount   = 5;
  // Timer555 allocates nodeCount+1..nodeCount+6 internally (4 voltage + 2 VCVS branches).
  // nodeCount=5 → timer range 6-11. Safe VCC branch: brVcc=11 → k=12. vsTrig: k=13.
  const brVcc  = 11; // k = brVcc+1 = 12 (used by makeVoltageSource/makeVsElement)
  const brTrig = 13; // k = brTrig = 13 (used directly by vsTrig.load())

  const timer = make555(
    { vcc: nVcc, gnd: 0, trig: nTrig, thr: nThr, ctrl: nCtrl, rst: nVcc, dis: nThr, out: nOut },
  );

  const vsVcc  = makeVsElement(nVcc, 0, brVcc, VCC);
  const rEl    = makeResistor(nVcc, nThr, R);
  const capEl  = createTestCapacitor(Cval, nThr, 0);

  // Mutable trigger voltage source with real setup() to pre-allocate its branch row.
  // Uses k=brTrig directly (1-based) for its matrix entries.
  let _trigVoltage = VCC; // starts HIGH (idle)
  let _hTrigK = -1, _hKTrig = -1;
  const vsTrig: AnalogElement = {
    branchIndex: brTrig,
    ngspiceLoadOrder: 0,
    label: "",
    _stateBase: -1,
    _pinNodes: new Map<string, number>([["pos", nTrig], ["neg", 0]]),
    setup(ctx: SetupContext): void {
      const k = brTrig;
      if (nTrig > 0) {
        _hTrigK = ctx.solver.allocElement(nTrig, k);
        _hKTrig = ctx.solver.allocElement(k, nTrig);
      }
      ctx.solver.allocElement(k, k); // ensure branch row in solver index
    },
    setParam(_key: string, _value: number): void {},
    getPinCurrents(_v: Float64Array): number[] { return []; },
    load(ctx: LoadContext): void {
      const { solver, rhs } = ctx;
      const k = brTrig;
      if (nTrig > 0) {
        solver.stampElement(_hTrigK, 1);
        solver.stampElement(_hKTrig, 1);
      }
      stampRHS(rhs, k, _trigVoltage);
    },
  } as unknown as AnalogElement;

  const elements = [timer, vsVcc, rEl, capEl, vsTrig];

  const compiled = buildHandCircuit({ nodeCount, elements });

  const engine = new MNAEngine();
  engine.init(compiled);

  return {
    engine,
    nOut,
    setTrig: (v: number) => { _trigVoltage = v; },
  };
}

describe("Monostable", () => {
  it("pulse_width", () => {
    const R    = 100e3;  // 100kΩ
    const Cval = 1e-6;   // 1µF
    const VCC  = 5;

    // Expected pulse width: 1.1 × R × C = 110ms
    const tWidthExpected = 1.1 * R * Cval;

    const { engine, nOut, setTrig } = buildMonostableCircuit(R, Cval, VCC);

    // Initialize: run DC OP with TRIG high to establish initial RESET state
    const dcResult = engine.dcOperatingPoint();
    expect(dcResult.converged).toBe(true);

    // Use timestep = 0.5% of pulse width for accurate threshold-crossing resolution
    const maxDt = tWidthExpected * 0.005;
    engine.configure({ maxTimeStep: maxDt });

    // Apply trigger pulse (TRIG goes to 0.5V < 1/3 VCC = 1.67V  fires trigger comparator)
    setTrig(0.5);

    // Run one step to register the trigger
    engine.step();

    const midVoltage = VCC / 2;
    let pulseStart = -1;
    let pulseEnd = -1;
    let prevHigh = engine.getNodeVoltage(nOut) > midVoltage;

    // Release trigger (TRIG goes back to VCC)
    setTrig(VCC);

    let steps = 0;
    const maxSteps = 50000;
    const maxSimTime = tWidthExpected * 3; // simulate 3× expected pulse width

    while (engine.simTime < maxSimTime && steps < maxSteps) {
      engine.step();
      steps++;
      if (engine.getState() === EngineState.ERROR) break;

      const vOut = engine.getNodeVoltage(nOut);
      const isHigh = vOut > midVoltage;

      if (!prevHigh && isHigh) {
        pulseStart = engine.simTime;
      }
      if (prevHigh && !isHigh && pulseStart >= 0) {
        pulseEnd = engine.simTime;
        break; // pulse complete
      }
      prevHigh = isHigh;
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);
    expect(pulseEnd).toBeGreaterThan(0);

    const tWidthMeasured = pulseEnd - pulseStart;
    const tWidthError = Math.abs(tWidthMeasured - tWidthExpected) / tWidthExpected;

    // Within 10% (timestep quantization at comparator crossings)
    expect(tWidthError).toBeLessThan(0.10);
  });

  it("retrigger_ignored_during_pulse", () => {
    // Standard 555: applying a second trigger during the output pulse does NOT
    // extend the pulse. The capacitor continues charging; once it hits 2/3 VCC,
    // the timer resets regardless of TRIG level.
    const R    = 100e3;
    const Cval = 1e-6;
    const VCC  = 5;
    const tWidthExpected = 1.1 * R * Cval; // 110ms

    const { engine, nOut, setTrig } = buildMonostableCircuit(R, Cval, VCC);

    engine.dcOperatingPoint();
    const maxDt = tWidthExpected * 0.005;
    engine.configure({ maxTimeStep: maxDt });

    // Trigger the 555
    setTrig(0.5);
    engine.step();
    setTrig(VCC);

    // Record when output goes high
    let pulseStart = -1;
    let pulseEnd = -1;
    let retriggered = false;
    let prevHigh = engine.getNodeVoltage(nOut) > VCC / 2;

    let steps = 0;
    const maxSteps = 50000;
    const maxSimTime = tWidthExpected * 3;

    while (engine.simTime < maxSimTime && steps < maxSteps) {
      engine.step();
      steps++;
      if (engine.getState() === EngineState.ERROR) break;

      const vOut = engine.getNodeVoltage(nOut);
      const isHigh = vOut > VCC / 2;

      if (!prevHigh && isHigh && pulseStart < 0) {
        pulseStart = engine.simTime;
      }

      // Apply retrigger at 30% through the expected pulse
      if (pulseStart >= 0 && !retriggered && engine.simTime > pulseStart + tWidthExpected * 0.3) {
        setTrig(0.5); // re-trigger during pulse
        retriggered = true;
      }
      if (retriggered && engine.simTime > pulseStart + tWidthExpected * 0.4) {
        setTrig(VCC); // release retrigger
      }

      if (prevHigh && !isHigh && pulseStart >= 0) {
        pulseEnd = engine.simTime;
        break;
      }
      prevHigh = isHigh;
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);
    expect(pulseEnd).toBeGreaterThan(0);

    const tWidthMeasured = pulseEnd - pulseStart;

    // Pulse width must NOT be extended beyond 1.1×RC × 1.15 (15% margin).
    // If retrigger extended the pulse, it would be ~2× tWidthExpected.
    expect(tWidthMeasured).toBeLessThan(tWidthExpected * 1.15);
    // Pulse must have the normal width (within 10%)
    const tWidthError = Math.abs(tWidthMeasured - tWidthExpected) / tWidthExpected;
    expect(tWidthError).toBeLessThan(0.10);
  });
});
