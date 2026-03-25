/**
 * Tests for behavioral analog factories for JK, RS, and T flip-flops.
 *
 * Verifies:
 *   JK::toggle_when_both_high       — J=1, K=1, rising clock → Q toggles
 *   JK::set_when_j_high             — J=1, K=0, rising clock → Q=1
 *   JK::reset_when_k_high           — J=0, K=1, rising clock → Q=0
 *   RS::set_and_reset               — S=1 → Q=1; R=1 → Q=0
 *   RS::both_high_holds             — S=1, R=1 → Q holds, diagnostic emitted
 *   T::toggles_on_t_high            — T=1, clock edge → Q toggles each edge
 *   Registration::all_flipflops_have_analog_factory
 *   RS_FF::both_set_emits_diagnostic
 */

import { describe, it, expect } from "vitest";
import {
  BehavioralJKFlipflopElement,
  BehavioralRSFlipflopElement,
  BehavioralTFlipflopElement,
  BehavioralRSAsyncLatchElement,
} from "../behavioral-flipflop-variants.js";
import {
  DigitalInputPinModel,
  DigitalOutputPinModel,
} from "../digital-pin-model.js";
import { SparseSolver } from "../sparse-solver.js";
import { JKDefinition } from "../../components/flipflops/jk.js";
import { RSDefinition } from "../../components/flipflops/rs.js";
import { TDefinition } from "../../components/flipflops/t.js";
import { JKAsyncDefinition } from "../../components/flipflops/jk-async.js";
import { RSAsyncDefinition } from "../../components/flipflops/rs-async.js";
import { DAsyncDefinition } from "../../components/flipflops/d-async.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";

// ---------------------------------------------------------------------------
// Shared test constants
// ---------------------------------------------------------------------------

const CMOS33: ResolvedPinElectrical = {
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

const V_HIGH = 3.3;
const V_LOW = 0.0;
const VIH = CMOS33.vIH;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInputPin(nodeId: number): DigitalInputPinModel {
  const pin = new DigitalInputPinModel(CMOS33);
  pin.init(nodeId, 0);
  return pin;
}

function makeOutputPin(nodeId: number): DigitalOutputPinModel {
  const pin = new DigitalOutputPinModel(CMOS33);
  pin.init(nodeId, -1);
  return pin;
}

function makeSolver(size: number): SparseSolver {
  return new SparseSolver(size, 0);
}

/**
 * Build a JK element.
 * Node layout: ground=0, J=1, C=2, K=3, Q=4, ~Q=5
 */
function buildJK(): {
  element: BehavioralJKFlipflopElement;
  jPin: DigitalInputPinModel;
  clockPin: DigitalInputPinModel;
  kPin: DigitalInputPinModel;
  qPin: DigitalOutputPinModel;
  qBarPin: DigitalOutputPinModel;
} {
  const jPin = makeInputPin(1);
  const clockPin = makeInputPin(2);
  const kPin = makeInputPin(3);
  const qPin = makeOutputPin(4);
  const qBarPin = makeOutputPin(5);

  const element = new BehavioralJKFlipflopElement(
    jPin, clockPin, kPin, qPin, qBarPin,
    VIH, CMOS33.vIL,
  );
  return { element, jPin, clockPin, kPin, qPin, qBarPin };
}

/**
 * Build a clocked RS element.
 * Node layout: ground=0, S=1, C=2, R=3, Q=4, ~Q=5
 */
function buildRS(): {
  element: BehavioralRSFlipflopElement;
  sPin: DigitalInputPinModel;
  clockPin: DigitalInputPinModel;
  rPin: DigitalInputPinModel;
  qPin: DigitalOutputPinModel;
  qBarPin: DigitalOutputPinModel;
} {
  const sPin = makeInputPin(1);
  const clockPin = makeInputPin(2);
  const rPin = makeInputPin(3);
  const qPin = makeOutputPin(4);
  const qBarPin = makeOutputPin(5);

  const element = new BehavioralRSFlipflopElement(
    sPin, clockPin, rPin, qPin, qBarPin,
    VIH, CMOS33.vIL,
  );
  return { element, sPin, clockPin, rPin, qPin, qBarPin };
}

/**
 * Build a T element with enable input.
 * Node layout: ground=0, T=1, C=2, Q=3, ~Q=4
 */
function buildT(): {
  element: BehavioralTFlipflopElement;
  tPin: DigitalInputPinModel;
  clockPin: DigitalInputPinModel;
  qPin: DigitalOutputPinModel;
  qBarPin: DigitalOutputPinModel;
} {
  const tPin = makeInputPin(1);
  const clockPin = makeInputPin(2);
  const qPin = makeOutputPin(3);
  const qBarPin = makeOutputPin(4);

  const element = new BehavioralTFlipflopElement(
    tPin, clockPin, qPin, qBarPin,
    VIH, CMOS33.vIL,
  );
  return { element, tPin, clockPin, qPin, qBarPin };
}

/**
 * Build a level-sensitive RS latch (no clock).
 * Node layout: ground=0, S=1, R=2, Q=3, ~Q=4
 */
function buildRSLatch(): {
  element: BehavioralRSAsyncLatchElement;
  sPin: DigitalInputPinModel;
  rPin: DigitalInputPinModel;
  qPin: DigitalOutputPinModel;
  qBarPin: DigitalOutputPinModel;
} {
  const sPin = makeInputPin(1);
  const rPin = makeInputPin(2);
  const qPin = makeOutputPin(3);
  const qBarPin = makeOutputPin(4);

  const element = new BehavioralRSAsyncLatchElement(
    sPin, rPin, qPin, qBarPin,
    VIH, CMOS33.vIL,
  );
  return { element, sPin, rPin, qPin, qBarPin };
}

/**
 * Build a voltages array for MNA nodes 1-5 (1-based).
 * readMnaVoltage(nodeId, v) reads v[nodeId-1], so:
 *   v[0]=node1, v[1]=node2, v[2]=node3, v[3]=node4, v[4]=node5
 */
function v6(n1: number, n2: number, n3: number, n4: number, n5: number): Float64Array {
  const arr = new Float64Array(5);
  arr[0] = n1;
  arr[1] = n2;
  arr[2] = n3;
  arr[3] = n4;
  arr[4] = n5;
  return arr;
}

/**
 * Build a voltages array for MNA nodes 1-4 (1-based).
 * readMnaVoltage(nodeId, v) reads v[nodeId-1], so:
 *   v[0]=node1, v[1]=node2, v[2]=node3, v[3]=node4
 */
function v5(n1: number, n2: number, n3: number, n4: number): Float64Array {
  const arr = new Float64Array(4);
  arr[0] = n1;
  arr[1] = n2;
  arr[2] = n3;
  arr[3] = n4;
  return arr;
}

/**
 * Simulate a rising clock edge on a JK element.
 * Calls updateCompanion with clock-low voltages then clock-high voltages.
 * Returns the Q output voltage after the edge.
 */
function applyJKRisingEdge(
  element: BehavioralJKFlipflopElement,
  j: number,
  k: number,
): number {
  const solver = makeSolver(5);
  solver.beginAssembly();
  element.stamp(solver);
  element.stampNonlinear(solver);

  // First call: clock low (no edge yet)
  element.updateCompanion(1e-9, 'bdf1', v6(j, V_LOW, k, V_LOW, V_LOW));
  // Second call: clock rises (rising edge detected)
  element.updateCompanion(1e-9, 'bdf1', v6(j, V_HIGH, k, V_LOW, V_LOW));

  solver.beginAssembly();
  element.stamp(solver);
  element.stampNonlinear(solver);

  // The qPin is at nodeId=4, so read currentVoltage directly
  return element.pinNodeIds[3] === 4
    ? (element as unknown as { _qPin: DigitalOutputPinModel })._qPin?.currentVoltage ?? V_LOW
    : V_LOW;
}

/**
 * Get Q voltage by stampNonlinear inspection after update.
 */
function getQVoltage(qPin: DigitalOutputPinModel, element: { stamp: (s: SparseSolver) => void; stampNonlinear: (s: SparseSolver) => void }, size: number): number {
  const solver = makeSolver(size);
  solver.beginAssembly();
  element.stamp(solver);
  element.stampNonlinear(solver);
  return qPin.currentVoltage;
}

// ---------------------------------------------------------------------------
// JK tests
// ---------------------------------------------------------------------------

describe("JK", () => {
  it("toggle_when_both_high", () => {
    // J=1, K=1 on rising clock edge → Q toggles
    const { element, qPin, qBarPin } = buildJK();
    const solver = makeSolver(5);

    solver.beginAssembly();
    element.stamp(solver);
    element.stampNonlinear(solver);

    // Initial Q=false (vOL)
    expect(qPin.currentVoltage).toBeCloseTo(CMOS33.vOL, 5);
    expect(qBarPin.currentVoltage).toBeCloseTo(CMOS33.vOH, 5);

    // First rising edge: J=1, K=1 → Q toggles from false to true
    element.updateCompanion(1e-9, 'bdf1', v6(V_HIGH, V_LOW, V_HIGH, V_LOW, V_LOW));
    element.updateCompanion(1e-9, 'bdf1', v6(V_HIGH, V_HIGH, V_HIGH, V_LOW, V_LOW));

    solver.beginAssembly();
    element.stamp(solver);
    element.stampNonlinear(solver);
    expect(qPin.currentVoltage).toBeCloseTo(CMOS33.vOH, 5);

    // Second rising edge: J=1, K=1 → Q toggles back to false
    element.updateCompanion(1e-9, 'bdf1', v6(V_HIGH, V_LOW, V_HIGH, V_LOW, V_LOW));
    element.updateCompanion(1e-9, 'bdf1', v6(V_HIGH, V_HIGH, V_HIGH, V_LOW, V_LOW));

    solver.beginAssembly();
    element.stamp(solver);
    element.stampNonlinear(solver);
    expect(qPin.currentVoltage).toBeCloseTo(CMOS33.vOL, 5);
  });

  it("set_when_j_high", () => {
    // J=1, K=0, rising clock → Q=1
    const { element, qPin } = buildJK();
    const solver = makeSolver(5);

    solver.beginAssembly();
    element.stamp(solver);
    element.stampNonlinear(solver);

    element.updateCompanion(1e-9, 'bdf1', v6(V_HIGH, V_LOW, V_LOW, V_LOW, V_LOW));
    element.updateCompanion(1e-9, 'bdf1', v6(V_HIGH, V_HIGH, V_LOW, V_LOW, V_LOW));

    solver.beginAssembly();
    element.stamp(solver);
    element.stampNonlinear(solver);
    expect(qPin.currentVoltage).toBeCloseTo(CMOS33.vOH, 5);
  });

  it("reset_when_k_high", () => {
    // First set Q=1 via J=1, K=0 edge
    // Then J=0, K=1 on next rising edge → Q=0
    const { element, qPin } = buildJK();
    const solver = makeSolver(5);

    solver.beginAssembly();
    element.stamp(solver);
    element.stampNonlinear(solver);

    // Set Q=1
    element.updateCompanion(1e-9, 'bdf1', v6(V_HIGH, V_LOW, V_LOW, V_LOW, V_LOW));
    element.updateCompanion(1e-9, 'bdf1', v6(V_HIGH, V_HIGH, V_LOW, V_LOW, V_LOW));

    solver.beginAssembly();
    element.stamp(solver);
    element.stampNonlinear(solver);
    expect(qPin.currentVoltage).toBeCloseTo(CMOS33.vOH, 5);

    // Reset Q=0: J=0, K=1
    element.updateCompanion(1e-9, 'bdf1', v6(V_LOW, V_LOW, V_HIGH, V_LOW, V_LOW));
    element.updateCompanion(1e-9, 'bdf1', v6(V_LOW, V_HIGH, V_HIGH, V_LOW, V_LOW));

    solver.beginAssembly();
    element.stamp(solver);
    element.stampNonlinear(solver);
    expect(qPin.currentVoltage).toBeCloseTo(CMOS33.vOL, 5);
  });
});

// ---------------------------------------------------------------------------
// RS tests (clocked)
// ---------------------------------------------------------------------------

describe("RS", () => {
  it("set_and_reset", () => {
    // S=1, R=0 on rising edge → Q=1; then S=0, R=1 → Q=0
    const { element, qPin } = buildRS();
    const solver = makeSolver(5);

    solver.beginAssembly();
    element.stamp(solver);
    element.stampNonlinear(solver);

    // Set: S=1, R=0
    element.updateCompanion(1e-9, 'bdf1', v6(V_HIGH, V_LOW, V_LOW, V_LOW, V_LOW));
    element.updateCompanion(1e-9, 'bdf1', v6(V_HIGH, V_HIGH, V_LOW, V_LOW, V_LOW));

    solver.beginAssembly();
    element.stamp(solver);
    element.stampNonlinear(solver);
    expect(qPin.currentVoltage).toBeCloseTo(CMOS33.vOH, 5);

    // Reset: S=0, R=1
    element.updateCompanion(1e-9, 'bdf1', v6(V_LOW, V_LOW, V_HIGH, V_LOW, V_LOW));
    element.updateCompanion(1e-9, 'bdf1', v6(V_LOW, V_HIGH, V_HIGH, V_LOW, V_LOW));

    solver.beginAssembly();
    element.stamp(solver);
    element.stampNonlinear(solver);
    expect(qPin.currentVoltage).toBeCloseTo(CMOS33.vOL, 5);
  });

  it("both_high_holds", () => {
    // First set Q=1, then apply S=1, R=1 on rising edge
    // Q must remain 1 (hold previous value)
    const { element, qPin } = buildRS();
    const solver = makeSolver(5);

    solver.beginAssembly();
    element.stamp(solver);
    element.stampNonlinear(solver);

    // Set Q=1
    element.updateCompanion(1e-9, 'bdf1', v6(V_HIGH, V_LOW, V_LOW, V_LOW, V_LOW));
    element.updateCompanion(1e-9, 'bdf1', v6(V_HIGH, V_HIGH, V_LOW, V_LOW, V_LOW));

    solver.beginAssembly();
    element.stamp(solver);
    element.stampNonlinear(solver);
    const qBefore = qPin.currentVoltage;
    expect(qBefore).toBeCloseTo(CMOS33.vOH, 5);

    // S=1, R=1 on rising edge → forbidden: Q must hold
    element.updateCompanion(1e-9, 'bdf1', v6(V_HIGH, V_LOW, V_HIGH, V_LOW, V_LOW));
    element.updateCompanion(1e-9, 'bdf1', v6(V_HIGH, V_HIGH, V_HIGH, V_LOW, V_LOW));

    solver.beginAssembly();
    element.stamp(solver);
    element.stampNonlinear(solver);
    expect(qPin.currentVoltage).toBeCloseTo(qBefore, 5);
  });
});

// ---------------------------------------------------------------------------
// T tests
// ---------------------------------------------------------------------------

describe("T", () => {
  it("toggles_on_t_high", () => {
    // T=1 on each rising clock edge → Q toggles each time
    const { element, qPin } = buildT();
    const solver = makeSolver(4);

    solver.beginAssembly();
    element.stamp(solver);
    element.stampNonlinear(solver);

    // Initial Q=false
    expect(qPin.currentVoltage).toBeCloseTo(CMOS33.vOL, 5);

    // 1st edge: T=1 → Q toggles to true
    element.updateCompanion(1e-9, 'bdf1', v5(V_HIGH, V_LOW, V_LOW, V_LOW));
    element.updateCompanion(1e-9, 'bdf1', v5(V_HIGH, V_HIGH, V_LOW, V_LOW));

    solver.beginAssembly();
    element.stamp(solver);
    element.stampNonlinear(solver);
    expect(qPin.currentVoltage).toBeCloseTo(CMOS33.vOH, 5);

    // 2nd edge: T=1 → Q toggles back to false
    element.updateCompanion(1e-9, 'bdf1', v5(V_HIGH, V_LOW, V_LOW, V_LOW));
    element.updateCompanion(1e-9, 'bdf1', v5(V_HIGH, V_HIGH, V_LOW, V_LOW));

    solver.beginAssembly();
    element.stamp(solver);
    element.stampNonlinear(solver);
    expect(qPin.currentVoltage).toBeCloseTo(CMOS33.vOL, 5);

    // 3rd edge: T=1 → Q toggles to true again
    element.updateCompanion(1e-9, 'bdf1', v5(V_HIGH, V_LOW, V_LOW, V_LOW));
    element.updateCompanion(1e-9, 'bdf1', v5(V_HIGH, V_HIGH, V_LOW, V_LOW));

    solver.beginAssembly();
    element.stamp(solver);
    element.stampNonlinear(solver);
    expect(qPin.currentVoltage).toBeCloseTo(CMOS33.vOH, 5);
  });
});

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe("Registration", () => {
  it("all_flipflops_have_analog_factory", () => {
    // JK, RS, T and all async variants must have analog factory defined
    expect(JKDefinition.models?.analog?.factory).toBeDefined();
    expect(typeof JKDefinition.models?.analog?.factory).toBe("function");

    expect(RSDefinition.models?.analog?.factory).toBeDefined();
    expect(typeof RSDefinition.models?.analog?.factory).toBe("function");

    expect(TDefinition.models?.analog?.factory).toBeDefined();
    expect(typeof TDefinition.models?.analog?.factory).toBe("function");

    expect(JKAsyncDefinition.models?.analog?.factory).toBeDefined();
    expect(typeof JKAsyncDefinition.models?.analog?.factory).toBe("function");

    expect(RSAsyncDefinition.models?.analog?.factory).toBeDefined();
    expect(typeof RSAsyncDefinition.models?.analog?.factory).toBe("function");

    expect(DAsyncDefinition.models?.analog?.factory).toBeDefined();
    expect(typeof DAsyncDefinition.models?.analog?.factory).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// RS_FF diagnostic test
// ---------------------------------------------------------------------------

describe("RS_FF", () => {
  it("both_set_emits_diagnostic", () => {
    // S=1, R=1 on rising clock edge must emit a diagnostic with:
    //   code: 'rs-flipflop-both-set'
    //   severity: 'warning'
    const { element } = buildRS();
    const solver = makeSolver(5);

    solver.beginAssembly();
    element.stamp(solver);
    element.stampNonlinear(solver);

    // Apply S=1, R=1 on rising clock edge
    element.updateCompanion(1e-9, 'bdf1', v6(V_HIGH, V_LOW, V_HIGH, V_LOW, V_LOW));
    element.updateCompanion(1e-9, 'bdf1', v6(V_HIGH, V_HIGH, V_HIGH, V_LOW, V_LOW));

    const diagnostics = element.getDiagnostics();
    expect(diagnostics.length).toBeGreaterThanOrEqual(1);

    const diag = diagnostics.find(d => d.code === 'rs-flipflop-both-set');
    expect(diag).toBeDefined();
    expect(diag!.severity).toBe('warning');
  });
});
