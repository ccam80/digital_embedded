/**
 * Tests for the SCR (Silicon Controlled Rectifier) component.
 *
 * Covers:
 *   - blocks_without_gate: V_AK = 50V, no gate — only leakage
 *   - triggers_with_gate_current: gate current > I_GT latches device
 *   - holds_after_gate_removed: SCR stays conducting after gate removed
 *   - turns_off_below_holding_current: unlatch when I_AK < I_hold
 *   - blocks_reverse: V_AK = -50V — only reverse leakage
 *   - breakover_voltage: V_AK > V_breakover triggers without gate
 *   - no_writeback: updateOperatingPoint does not modify voltages[]
 *   - pool_state: pool.state0 slots contain correct values after updateOperatingPoint
 */

import { describe, it, expect } from "vitest";
import { createScrElement, ScrDefinition, SCR_PARAM_DEFAULTS } from "../scr.js";
import { PropertyBag } from "../../../core/properties.js";
import { createTestPropertyBag } from "../../../test-fixtures/model-fixtures.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import { withNodeIds, runDcOp } from "../../../solver/analog/__tests__/test-helpers.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";
import type { ReactiveAnalogElement } from "../../../solver/analog/element.js";
import type { AnalogFactory } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Helper: allocate a StatePool for a single element and call initState
// ---------------------------------------------------------------------------

function withState(core: AnalogElementCore): { element: ReactiveAnalogElement; pool: StatePool } {
  const re = core as ReactiveAnalogElement;
  const pool = new StatePool(Math.max(re.stateSize, 1));
  re.stateBaseOffset = 0;
  re.initState(pool);
  return { element: re, pool };
}

// ---------------------------------------------------------------------------
// Default SCR parameters (matching spec defaults)
// ---------------------------------------------------------------------------

const SCR_DEFAULTS = {
  vOn: 1.5,
  iH: 5e-3,
  rOn: 0.01,
  vBreakover: 100,
  iS: 1e-12,
  alpha1: 0.5,
  alpha2_0: 0.3,
  i_ref: 1e-3,
  n: 1,
};

// Slot indices (must match scr.ts)
const SLOT_VAK        = 0;
const SLOT_GEQ        = 2;
const SLOT_IEQ        = 3;
const SLOT_G_GATE_GEQ = 4;
const SLOT_LATCHED    = 6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScrElement(overrides: Partial<typeof SCR_DEFAULTS> = {}): AnalogElement {
  const params = { ...SCR_PARAM_DEFAULTS, ...SCR_DEFAULTS, ...overrides };
  const props = createTestPropertyBag();
  props.replaceModelParams(params);
  // nodeA=1, nodeK=2, nodeG=3
  const core = createScrElement(new Map([["A", 1], ["K", 2], ["G", 3]]), [], -1, props);
  const { element } = withState(core);
  return withNodeIds(element, [1, 2, 3]);
}

function makeResistorElement(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const G = 1 / resistance;
  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    setParam(_key: string, _value: number): void {},
    getPinCurrents(_v: Float64Array): number[] { return []; },
    stamp(solver: SparseSolver): void {
      if (nodeA !== 0) solver.stampElement(solver.allocElement(nodeA - 1, nodeA - 1), G);
      if (nodeB !== 0) solver.stampElement(solver.allocElement(nodeB - 1, nodeB - 1), G);
      if (nodeA !== 0 && nodeB !== 0) {
        solver.stampElement(solver.allocElement(nodeA - 1, nodeB - 1), -G);
        solver.stampElement(solver.allocElement(nodeB - 1, nodeA - 1), -G);
      }
    },
  };
}

/**
 * Drive SCR to a steady operating point by iterating updateOperatingPoint.
 * nodeA=1 (index 0), nodeK=2 (index 1), nodeG=3 (index 2)
 */
function driveToOp(
  element: AnalogElement,
  vAnode: number,
  vCathode: number,
  vGate: number,
  iterations = 100,
): Float64Array {
  const voltages = new Float64Array(3);
  voltages[0] = vAnode;
  voltages[1] = vCathode;
  voltages[2] = vGate;
  for (let i = 0; i < iterations; i++) {
    element.updateOperatingPoint!(voltages);
    voltages[0] = vAnode;
    voltages[1] = vCathode;
    voltages[2] = vGate;
  }
  return voltages;
}

// ---------------------------------------------------------------------------
// SCR unit tests
// ---------------------------------------------------------------------------

describe("SCR", () => {
  it("blocks_without_gate", () => {
    // V_AK = 50V, I_G = 0 — SCR should block (only leakage current in µA range)
    // Use a DC circuit: 50V source + 10kΩ load + SCR (A=node1, K=gnd)
    // With no gate drive, SCR in blocking state: I_AK << 1mA

    // Circuit nodes: node1=anode, node2=positive source terminal
    // Branch row for voltage source = row index 2 (0-based = matrix row 2)
    // matrixSize = 3 nodes + 1 branch = 4... but node2 is shared via 10kΩ
    // Layout: VS(node2→gnd) + R(node2→node1) + SCR(A=node1, K=gnd, G=gnd)
    //   node1=anode, node2=source+, gnd=0; SCR gate tied to gnd
    //   branchRow index = 2 (third row, after 2 node rows)

    const matrixSize = 3; // node1, node2, branch
    const scrProps0 = new PropertyBag(); scrProps0.replaceModelParams({ ...SCR_PARAM_DEFAULTS, ...SCR_DEFAULTS });
    const scrCore = createScrElement(new Map([["A", 1], ["K", 0], ["G", 0]]), [], -1, scrProps0);
    const { element: scrEl } = withState(scrCore);
    const scr = withNodeIds(scrEl, [1, 0, 0]);
    const vs = withNodeIds(makeDcVoltageSource(2, 0, 2, 50), [2, 0]);
    const rLoad = makeResistorElement(2, 1, 10000); // 10kΩ

    const result = runDcOp({
      elements: [vs, rLoad, scr],
      matrixSize,
      nodeCount: 2,
    });

    expect(result.converged).toBe(true);

    // V(node2) = 50V enforced by source
    expect(result.nodeVoltages[1]).toBeCloseTo(50, 1);

    // With SCR blocking, most voltage drops across it
    const iAk = (result.nodeVoltages[1] - result.nodeVoltages[0]) / 10000;
    expect(Math.abs(iAk)).toBeLessThan(1e-3); // less than 1mA (leakage only)
  });

  it("triggers_with_gate_current", () => {
    // V_AK = 50V, inject gate current well above I_GT (200µA).
    // Expected: SCR latches and presents low on-state conductance.
    const scrProps1 = new PropertyBag(); scrProps1.replaceModelParams({ ...SCR_PARAM_DEFAULTS, ...SCR_DEFAULTS });
    const scrCore1 = createScrElement(new Map([["A", 1], ["K", 2], ["G", 3]]), [], -1, scrProps1);
    const { element: scr } = withState(scrCore1);

    // Drive to operating point: 50V anode, 0V cathode, 0.65V gate
    const voltages = new Float64Array(3);
    voltages[0] = 50;   // anode (node1 → index 0)
    voltages[1] = 0;    // cathode (node2 → index 1)
    voltages[2] = 0.65; // gate (node3 → index 2) — forward-biased

    for (let i = 0; i < 200; i++) {
      scr.updateOperatingPoint!(voltages);
      voltages[0] = 50;
      voltages[1] = 0;
      voltages[2] = 0.65;
    }

    // Verify SCR is in on-state by checking high conductance (≈ 1/R_on = 100 S)
    const mockCalls: Array<[number, number, number]> = [];
    const mockSolver = {
      stamp: (r: number, c: number, v: number) => mockCalls.push([r, c, v]),
      stampRHS: (_r: number, _v: number) => {},
    } as unknown as SparseSolver;

    scr.stampNonlinear!(mockSolver);

    // On-state: A-K diagonal conductance ≈ 1/R_on
    // nodeA=1→index 0, nodeK=2→index 1 — A-K diagonal is at (0,0) and (1,1)
    const gOn = 1 / SCR_DEFAULTS.rOn; // 100 S
    const diagAK = mockCalls.filter((c) => c[0] === c[1] && c[0] < 2);
    const maxG = Math.max(...diagAK.map((c) => Math.abs(c[2])));
    expect(maxG).toBeGreaterThan(1.0); // >> GMIN, confirms on-state
    expect(maxG).toBeCloseTo(gOn, 0);  // ≈ 100 S

    expect(maxG).toBeGreaterThan(1.0);
  });

  it("holds_after_gate_removed", () => {
    // Trigger SCR first (α₁ + α₂ > 0.95 with gate current)
    // Then drive to steady state at vak=50V, vgate=0 (gate removed)
    // SCR should remain latched because current is above I_hold
    const scr = makeScrElement();

    // First, trigger by driving with gate current to latch it
    driveToOp(scr, 50, 0, 0.7, 200); // gate at 0.7V drives significant gate current

    // Now remove gate (gate = cathode = 0V), keep high anode voltage
    const voltages = new Float64Array(3);
    voltages[0] = 50; // anode
    voltages[1] = 0;  // cathode
    voltages[2] = 0;  // gate = cathode (no gate drive)

    for (let i = 0; i < 50; i++) {
      scr.updateOperatingPoint!(voltages);
      voltages[0] = 50;
      voltages[1] = 0;
      voltages[2] = 0;
    }

    // Check latch state via mock stamp: in on-state, conductance = 1/R_on (high)
    // vs. blocking state, conductance ≈ GMIN (tiny)
    const mockCalls: Array<[number, number, number]> = [];
    const mockSolver = {
      stamp: (r: number, c: number, v: number) => mockCalls.push([r, c, v]),
      stampRHS: (_r: number, _v: number) => {},
    } as unknown as SparseSolver;

    scr.stampNonlinear!(mockSolver);

    // In on-state: conductance should be 1/R_on = 100 S
    const gOn = 1 / SCR_DEFAULTS.rOn;
    const diagCalls = mockCalls.filter((c) => c[0] === c[1]); // diagonal entries
    const maxG = Math.max(...diagCalls.map((c) => Math.abs(c[2])));
    expect(maxG).toBeGreaterThan(1.0);
    expect(maxG).toBeCloseTo(gOn, 0);
  });

  it("turns_off_below_holding_current", () => {
    // Trigger SCR, then reduce V_AK until I_AK < I_hold
    const scr = makeScrElement({ iH: 5e-3, rOn: 0.01, vOn: 1.5 });

    // Trigger the SCR first
    driveToOp(scr, 50, 0, 0.7, 100);

    // Verify it's latched by checking conductance in on-state
    const mockCalls1: Array<[number, number, number]> = [];
    const solver1 = {
      stamp: (r: number, c: number, v: number) => mockCalls1.push([r, c, v]),
      stampRHS: (_r: number, _v: number) => {},
    } as unknown as SparseSolver;
    scr.stampNonlinear!(solver1);
    const diagBefore = mockCalls1.filter((c) => c[0] === c[1] && c[0] < 2);
    const gBefore = Math.max(...diagBefore.map((c) => Math.abs(c[2])));
    expect(gBefore).toBeGreaterThan(1.0); // on-state

    // Now reduce V_AK to 0.1V — current = (0.1 - 1.5) / 0.01 = -140A (negative → below I_hold)
    const voltages = new Float64Array(3);
    voltages[0] = 0.1; // very low anode voltage
    voltages[1] = 0;
    voltages[2] = 0;

    for (let i = 0; i < 100; i++) {
      scr.updateOperatingPoint!(voltages);
      voltages[0] = 0.1;
      voltages[1] = 0;
      voltages[2] = 0;
    }

    // After unlatching, conductance should be very small (blocking state)
    const mockCalls2: Array<[number, number, number]> = [];
    const solver2 = {
      stamp: (r: number, c: number, v: number) => mockCalls2.push([r, c, v]),
      stampRHS: (_r: number, _v: number) => {},
    } as unknown as SparseSolver;
    scr.stampNonlinear!(solver2);

    const diagAfter = mockCalls2.filter((c) => c[0] === c[1] && c[0] < 2);
    const gAfter = Math.max(...diagAfter.map((c) => Math.abs(c[2])));
    expect(gAfter).toBeLessThan(0.1); // very small — blocking state restored
  });

  it("blocks_reverse", () => {
    // V_AK = -50V — reverse blocking, I_AK ≈ -I_S (small reverse leakage)
    const scr = makeScrElement();
    driveToOp(scr, -50, 0, 0, 100);

    const mockCalls: Array<[number, number, number]> = [];
    const mockRhs: Array<[number, number]> = [];
    const mockSolver = {
      stamp: (r: number, c: number, v: number) => mockCalls.push([r, c, v]),
      stampRHS: (r: number, v: number) => mockRhs.push([r, v]),
    } as unknown as SparseSolver;

    scr.stampNonlinear!(mockSolver);

    // In reverse blocking, geq ≈ GMIN (≈ 1e-12)
    const aaDiag = mockCalls.find((c) => c[0] === 0 && c[1] === 0);
    expect(aaDiag).toBeDefined();
    expect(Math.abs(aaDiag![2])).toBeLessThan(1e-3);

    // Norton current at reverse bias: I ≈ -I_S (tiny)
    const rhsA = mockRhs.find((r) => r[0] === 0);
    expect(rhsA).toBeDefined();
    expect(Math.abs(rhsA![1])).toBeLessThan(1e-3);
  });

  it("breakover_voltage", () => {
    // V_AK > V_breakover (100V) should trigger SCR even without gate current
    const scr = makeScrElement({ vBreakover: 100 });

    driveToOp(scr, 110, 0, 0, 100);

    const mockCalls: Array<[number, number, number]> = [];
    const mockSolver = {
      stamp: (r: number, c: number, v: number) => mockCalls.push([r, c, v]),
      stampRHS: (_r: number, _v: number) => {},
    } as unknown as SparseSolver;

    scr.stampNonlinear!(mockSolver);

    const gOn = 1 / SCR_DEFAULTS.rOn;
    const diagCalls = mockCalls.filter((c) => c[0] === c[1] && c[0] < 2);
    const maxG = Math.max(...diagCalls.map((c) => Math.abs(c[2])));
    expect(maxG).toBeGreaterThan(1.0);
    expect(maxG).toBeCloseTo(gOn, 0);
  });

  it("no_writeback: updateOperatingPoint does not modify voltages[]", () => {
    const props = new PropertyBag();
    props.replaceModelParams({ ...SCR_PARAM_DEFAULTS, ...SCR_DEFAULTS });
    const core = createScrElement(new Map([["A", 1], ["K", 2], ["G", 3]]), [], -1, props);
    const { element } = withState(core);

    // Large forward voltage that would trigger pnjlim limiting
    const voltages = new Float64Array([50, 0, 0.65]);
    const snapshot = new Float64Array(voltages);

    element.updateOperatingPoint!(voltages);

    expect(voltages[0]).toBe(snapshot[0]);
    expect(voltages[1]).toBe(snapshot[1]);
    expect(voltages[2]).toBe(snapshot[2]);
  });

  it("pool_state: pool.state0 contains correct slot values after updateOperatingPoint", () => {
    const props = new PropertyBag();
    props.replaceModelParams({ ...SCR_PARAM_DEFAULTS, ...SCR_DEFAULTS });
    const core = createScrElement(new Map([["A", 1], ["K", 2], ["G", 3]]), [], -1, props);
    const { element, pool } = withState(core);

    // Converge at forward-biased gate to trigger latching
    const voltages = new Float64Array([50, 0, 0.65]);
    for (let i = 0; i < 200; i++) {
      element.updateOperatingPoint!(voltages);
      voltages[0] = 50;
      voltages[1] = 0;
      voltages[2] = 0.65;
    }

    // SLOT_LATCHED = 6: should be 1.0 (forward latched)
    expect(pool.state0[SLOT_LATCHED]).toBe(1.0);

    // SLOT_VAK = 0: should hold pnjlim-limited anode-cathode voltage
    const vakInPool = pool.state0[SLOT_VAK];
    expect(Number.isFinite(vakInPool)).toBe(true);
    expect(vakInPool).toBeGreaterThan(0); // positive for forward-biased state

    // SLOT_GEQ = 2: in on-state should be ≈ 1/rOn
    const geqInPool = pool.state0[SLOT_GEQ];
    expect(geqInPool).toBeGreaterThan(1.0); // 1/0.01 = 100 S

    // SLOT_IEQ = 3: should be finite
    expect(Number.isFinite(pool.state0[SLOT_IEQ])).toBe(true);

    // SLOT_G_GATE_GEQ = 4: gate junction conductance, should be positive and finite
    expect(pool.state0[SLOT_G_GATE_GEQ]).toBeGreaterThan(0);
    expect(Number.isFinite(pool.state0[SLOT_G_GATE_GEQ])).toBe(true);
  });

  it("pool_state: SLOT_LATCHED is 0.0 in blocking state", () => {
    const props = new PropertyBag();
    props.replaceModelParams({ ...SCR_PARAM_DEFAULTS, ...SCR_DEFAULTS });
    const core = createScrElement(new Map([["A", 1], ["K", 2], ["G", 3]]), [], -1, props);
    const { element, pool } = withState(core);

    // Drive with forward voltage but no gate → blocking
    const voltages = new Float64Array([10, 0, 0]);
    for (let i = 0; i < 50; i++) {
      element.updateOperatingPoint!(voltages);
      voltages[0] = 10;
      voltages[1] = 0;
      voltages[2] = 0;
    }

    expect(pool.state0[SLOT_LATCHED]).toBe(0.0);
    // In blocking state GEQ should be near GMIN (very small)
    expect(pool.state0[SLOT_GEQ]).toBeLessThan(1e-6);
  });

  it("definition_has_correct_fields", () => {
    expect(ScrDefinition.name).toBe("SCR");
    expect(ScrDefinition.modelRegistry?.["behavioral"]).toBeDefined();
    expect(ScrDefinition.modelRegistry?.["behavioral"]?.kind).toBe("inline");
    expect((ScrDefinition.modelRegistry?.["behavioral"] as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
    expect(ScrDefinition.category).toBe("SEMICONDUCTORS");
  });
});

// ---------------------------------------------------------------------------
// LimitingEvent instrumentation tests — SCR
// ---------------------------------------------------------------------------

import type { LimitingEvent } from "../../../solver/analog/newton-raphson.js";

describe("SCR LimitingEvent instrumentation", () => {
  function makeScrWithState(): any {
    const params = { ...SCR_PARAM_DEFAULTS, ...SCR_DEFAULTS };
    const props = createTestPropertyBag();
    props.replaceModelParams(params);
    const core = createScrElement(new Map([["A", 1], ["K", 2], ["G", 3]]), [], -1, props) as any;
    Object.defineProperty(core, "label", { value: "SCR1", writable: true, configurable: true });
    core.elementIndex = 4;
    const pool = new StatePool(core.stateSize);
    core.stateBaseOffset = 0;
    core.initState(pool);
    return core;
  }

  it("pushes AK and GK pnjlim events when limitingCollector provided", () => {
    const core = makeScrWithState();
    const voltages = new Float64Array(10);
    voltages[0] = 3.0;  // A = node 1
    voltages[1] = 0.0;  // K = node 2
    voltages[2] = 0.5;  // G = node 3

    const collector: LimitingEvent[] = [];
    core.updateOperatingPoint(voltages, collector);

    expect(collector.length).toBeGreaterThanOrEqual(2);
    const akEv = collector.find((e: LimitingEvent) => e.junction === "AK");
    const gkEv = collector.find((e: LimitingEvent) => e.junction === "GK");
    expect(akEv).toBeDefined();
    expect(gkEv).toBeDefined();

    for (const ev of [akEv!, gkEv!]) {
      expect(ev.elementIndex).toBe(4);
      expect(ev.label).toBe("SCR1");
      expect(ev.limitType).toBe("pnjlim");
      expect(Number.isFinite(ev.vBefore)).toBe(true);
      expect(Number.isFinite(ev.vAfter)).toBe(true);
      expect(typeof ev.wasLimited).toBe("boolean");
    }
  });

  it("does not throw when limitingCollector is null or undefined", () => {
    const core = makeScrWithState();
    const voltages = new Float64Array(10);
    voltages[0] = 3.0;
    expect(() => core.updateOperatingPoint(voltages, null)).not.toThrow();
    expect(() => core.updateOperatingPoint(voltages, undefined)).not.toThrow();
  });
});
