/**
 * Engine-dispatch tests for BehavioralDFlipflopElement.
 *
 * These tests exercise the defect where `MNAEngine.step()` does not dispatch
 * `updateCompanion()` on elements — only `stampCompanion()` and `updateState()`
 * are dispatched. Because the behavioral flip-flop puts its edge-detection
 * logic in `updateCompanion()` (and leaves `updateState()` as a no-op), driving
 * the clock through the real engine step loop fails to latch Q.
 *
 * Unlike the existing `behavioral_dff_toggle` test in
 * `behavioral-integration.test.ts`, these tests NEVER call
 * `element.updateCompanion(...)` directly. The clock is driven entirely by
 * mutating an ideal voltage source's scale between `engine.step()` calls,
 * which is the same path a real coordinator takes.
 *
 * Expected state BEFORE the fix: these tests fail — `_latchedQ` stays at its
 * initial `false` value, Q remains at vOL, and the rising-edge assertions
 * fail.
 *
 * Expected state AFTER the fix (see spec/engine-dispatch-updateCompanion.md):
 * MNAEngine.step() dispatches `updateCompanion(dt, method, voltages)` on every
 * element that defines it, once per accepted timestep, using the accepted
 * solution voltages.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MNAEngine } from "../analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../analog-engine.js";
import { StatePool } from "../state-pool.js";
import { EngineState } from "../../../core/engine-interface.js";
import {
  makeVoltageSource,
  makeResistor,
  withNodeIds,
} from "./test-helpers.js";
import {
  BehavioralDFlipflopElement,
} from "../behavioral-flipflop.js";
import {
  DigitalInputPinModel,
  DigitalOutputPinModel,
} from "../digital-pin-model.js";
import type { ResolvedPinElectrical } from "../../../core/pin-electrical.js";
import type { AnalogElement } from "../element.js";

// ---------------------------------------------------------------------------
// Shared electrical spec
// ---------------------------------------------------------------------------

const CMOS_3V3: ResolvedPinElectrical = {
  rOut: 50,
  cOut: 5e-12,
  rIn: 1e7,
  cIn: 5e-12,
  vOH: 3.3,
  vOL: 0.0,
  vIH: 2.0,
  vIL: 0.8,
  rHiZ: 1e7,
};

const LOAD_R = 10_000;

// ---------------------------------------------------------------------------
// Circuit builder
// ---------------------------------------------------------------------------

/**
 * Build a D-flipflop circuit driven entirely by real MNA elements:
 *
 *   Node 1: clock  — driven by ideal VS (branch row 4, scale-controlled)
 *   Node 2: D      — driven by ideal VS at vOH (branch row 5)
 *   Node 3: Q      — Norton output, 10kΩ load to ground
 *   Node 4: ~Q     — Norton output, 10kΩ load to ground
 *
 *   matrixSize = 4 nodes + 2 branches = 6
 *
 * The clock voltage source is returned so tests can toggle it between steps
 * via `setSourceScale(0 | 1)` — this is the only mutation the test performs,
 * and it exercises the engine's accepted-timestep path without bypassing
 * dispatch by calling `element.updateCompanion(...)` directly.
 */
function buildDffEngineDispatchCircuit(): {
  circuit: ConcreteCompiledAnalogCircuit;
  element: BehavioralDFlipflopElement;
  qPin: DigitalOutputPinModel;
  qBarPin: DigitalOutputPinModel;
  clockSource: AnalogElement & { setSourceScale(factor: number): void };
  dSource: AnalogElement & { setSourceScale(factor: number): void };
} {
  const clockPin = new DigitalInputPinModel(CMOS_3V3, true);
  clockPin.init(1, 0);

  const dPin = new DigitalInputPinModel(CMOS_3V3, true);
  dPin.init(2, 0);

  const qPin = new DigitalOutputPinModel(CMOS_3V3);
  qPin.init(3, -1);

  const qBarPin = new DigitalOutputPinModel(CMOS_3V3);
  qBarPin.init(4, -1);

  const element = new BehavioralDFlipflopElement(
    clockPin,
    dPin,
    qPin,
    qBarPin,
    null,
    null,
    "low",
  );
  element._setThresholds(CMOS_3V3.vIH, CMOS_3V3.vIL);

  // Clock and D voltage sources — clock starts LOW (scale=0), D stays HIGH.
  const clockSource = makeVoltageSource(1, 0, 4, 3.3) as AnalogElement & {
    setSourceScale(factor: number): void;
  };
  clockSource.setSourceScale(0); // clock initially LOW

  const dSource = makeVoltageSource(2, 0, 5, 3.3) as AnalogElement & {
    setSourceScale(factor: number): void;
  };
  dSource.setSourceScale(1); // D held HIGH

  const rLoadQ = makeResistor(3, 0, LOAD_R);
  const rLoadQBar = makeResistor(4, 0, LOAD_R);

  const elements: AnalogElement[] = [
    clockSource,
    dSource,
    rLoadQ,
    rLoadQBar,
    withNodeIds(element, [1, 2, 3, 4]),
  ];

  const circuit: ConcreteCompiledAnalogCircuit = {
    netCount: 4,
    componentCount: 5,
    nodeCount: 4,
    branchCount: 2,
    matrixSize: 6,
    elements,
    labelToNodeId: new Map([
      ["clock", 1],
      ["D", 2],
      ["Q", 3],
      ["QB", 4],
    ]),
    statePool: new StatePool(0),
  };

  return { circuit, element, qPin, qBarPin, clockSource, dSource };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BehavioralDFlipflop engine dispatch (updateCompanion reachability)", () => {
  let engine: MNAEngine;

  beforeEach(() => {
    engine = new MNAEngine();
  });

  it("latches D=HIGH through engine.step() when clock rises", () => {
    // D tied HIGH, clock initially LOW. DC op → Q should start at vOL (latchedQ=false).
    // Then pulse clock HIGH and call engine.step() — the engine should dispatch
    // updateCompanion on the flipflop, which detects the rising edge, samples
    // D=HIGH, and latches Q=true.
    const { circuit, qPin, qBarPin, clockSource } = buildDffEngineDispatchCircuit();

    engine.init(circuit);
    const dcOp = engine.dcOperatingPoint();
    expect(dcOp.converged).toBe(true);
    expect(engine.getState()).not.toBe(EngineState.ERROR);

    // Initial latched Q is false, so Q ≈ vOL.
    expect(qPin.currentVoltage).toBeLessThan(CMOS_3V3.vIL);
    expect(qBarPin.currentVoltage).toBeGreaterThan(CMOS_3V3.vIH);

    // First step with clock still LOW — no edge, Q should stay LOW.
    engine.step();
    expect(engine.getState()).not.toBe(EngineState.ERROR);
    expect(qPin.currentVoltage).toBeLessThan(CMOS_3V3.vIL);

    // Raise clock HIGH and step again — rising edge should latch D=HIGH.
    clockSource.setSourceScale(1);
    engine.step();
    expect(engine.getState()).not.toBe(EngineState.ERROR);

    // After the rising edge, Q should be HIGH (latchedQ=true → Norton at vOH).
    // Take a second step at clock HIGH to let the output pin RC fully settle
    // (stampNonlinear updates the Norton target immediately, so Q should jump
    // close to vOH in a single step, but we allow one extra step for margin).
    engine.step();
    expect(qPin.currentVoltage).toBeGreaterThan(CMOS_3V3.vIH);
    expect(qBarPin.currentVoltage).toBeLessThan(CMOS_3V3.vIL);
  });

  it("toggles Q across four clock edges via engine.step() (D tied to ~Q mirror)", () => {
    // Canonical toggle pattern: drive clock low→high→low→high…, with D wired
    // to vOH on every even edge and vOL on every odd edge so Q alternates.
    // This time we emulate that by flipping the D source scale between edges.
    const { circuit, qPin, clockSource, dSource } = buildDffEngineDispatchCircuit();

    engine.init(circuit);
    expect(engine.dcOperatingPoint().converged).toBe(true);

    // Helper: pulse one rising edge (low → high → step → high stays) and then
    // drop clock back to LOW ready for the next rising edge.
    function pulseClockAndStep(dHigh: boolean): void {
      dSource.setSourceScale(dHigh ? 1 : 0);
      // Clock is already LOW from constructor / previous call.
      clockSource.setSourceScale(1); // rise
      engine.step();                 // accepted step should trigger edge
      engine.step();                 // let output settle
      clockSource.setSourceScale(0); // fall (no edge action)
      engine.step();
    }

    // Edge 1: D=HIGH → Q latches HIGH
    pulseClockAndStep(true);
    expect(engine.getState()).not.toBe(EngineState.ERROR);
    expect(qPin.currentVoltage).toBeGreaterThan(CMOS_3V3.vIH);

    // Edge 2: D=LOW → Q latches LOW
    pulseClockAndStep(false);
    expect(qPin.currentVoltage).toBeLessThan(CMOS_3V3.vIL);

    // Edge 3: D=HIGH → Q latches HIGH again
    pulseClockAndStep(true);
    expect(qPin.currentVoltage).toBeGreaterThan(CMOS_3V3.vIH);

    // Edge 4: D=LOW → Q latches LOW
    pulseClockAndStep(false);
    expect(qPin.currentVoltage).toBeLessThan(CMOS_3V3.vIL);
  });

  it("does not latch without a rising clock edge (clock held HIGH)", () => {
    // Sanity / negative check: if clock is raised exactly once BEFORE DC op
    // (so there is never a LOW→HIGH transition during transient stepping),
    // then repeated steps should NOT produce a false edge. This guards against
    // a naive fix that treats the first updateCompanion call as an edge.
    const { circuit, qPin, clockSource } = buildDffEngineDispatchCircuit();

    // Clock HIGH from t=0, so DC op sees it HIGH and _prevClockVoltage is
    // updated on the first dispatch to match — no subsequent rising edges.
    clockSource.setSourceScale(1);

    engine.init(circuit);
    expect(engine.dcOperatingPoint().converged).toBe(true);

    // Step many times with clock held HIGH. Q should stay at its initial LOW.
    for (let i = 0; i < 10; i++) {
      engine.step();
      if (engine.getState() === EngineState.ERROR) break;
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);
    // Initial _latchedQ is false → Q should never have been latched HIGH.
    expect(qPin.currentVoltage).toBeLessThan(CMOS_3V3.vIL);
  });
});
