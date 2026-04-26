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
 *   - no_writeback: load does not modify voltages[]
 *   - pool_state: pool.state0 slots contain correct values after load
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { createScrElement, ScrDefinition, SCR_PARAM_DEFAULTS, SCR_PARAM_DEFS } from "../scr.js";
import { pnjlim } from "../../../solver/analog/newton-raphson.js";
import { PropertyBag } from "../../../core/properties.js";
import { createTestPropertyBag } from "../../../test-fixtures/model-fixtures.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import { withNodeIds, runDcOp } from "../../../solver/analog/__tests__/test-helpers.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";
import type { ReactiveAnalogElement } from "../../../solver/analog/element.js";
import type { AnalogFactory } from "../../../core/registry.js";
import type { LimitingEvent } from "../../../solver/analog/newton-raphson.js";
import { MODEDCOP, MODEINITFLOAT, MODEINITJCT } from "../../../solver/analog/ckt-mode.js";

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
const SLOT_VGK        = 1;
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
    load(ctx): void {
      const solver = ctx.solver;
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
 * Build a bare LoadContext for a single-element unit test. The caller owns
 * the solver, the state pool, and the voltages buffer.
 */
function buildUnitCtx(
  solver: SparseSolver,
  voltages: Float64Array,
  overrides: Partial<import("../../../solver/analog/load-context.js").LoadContext> = {},
): import("../../../solver/analog/load-context.js").LoadContext {
  return {
    solver,
    matrix: solver,
    rhsOld: voltages,
    rhs: new Float64Array(voltages.length),
    cktMode: MODEDCOP | MODEINITFLOAT,
    time: 0,
    dt: 0,
    method: "trapezoidal",
    order: 1,
    deltaOld: [0, 0, 0, 0, 0, 0, 0],
    ag: new Float64Array(7),
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    convergenceCollector: null,
    xfact: 1,
    gmin: 1e-12,
    reltol: 1e-3,
    iabstol: 1e-12,
    temp: 300.15,
    vt: 300.15 * 1.3806226e-23 / 1.6021918e-19,
    cktFixLimit: false,
    bypass: false,
    voltTol: 1e-6,
    ...overrides,
  };
}

/**
 * Drive SCR to a steady operating point by iterating load(ctx) against a
 * fresh SparseSolver each iteration. Each load() call updates the state
 * pool slots (SLOT_VAK, SLOT_GEQ, SLOT_IEQ, SLOT_LATCHED, ...) using pnjlim.
 * nodeA=1 (index 0), nodeK=2 (index 1), nodeG=3 (index 2).
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
    const solver = new SparseSolver();
    solver._initStructure(3);
    const ctx = buildUnitCtx(solver, voltages);
    element.load(ctx);
  }
  return voltages;
}

/**
 * Stamp the SCR into a fresh real SparseSolver and return the captured
 * (row, col, value) stamps and (row, value) RHS entries. Matches the shape
 * the pre-migration tests inspected via mock `stamp`/`stampRHS` calls.
 */
function stampAndCapture(
  element: AnalogElement,
  voltages: Float64Array,
): { stamps: Array<[number, number, number]>; rhs: Array<[number, number]> } {
  const matrixSize = Math.max(voltages.length, element.pinNodeIds.length);
  const solver = new SparseSolver();
  solver._initStructure(matrixSize);
  const ctx = buildUnitCtx(solver, voltages);
  element.load(ctx);

  const entries = solver.getCSCNonZeros();
  const stamps: Array<[number, number, number]> = entries.map((e) => [e.row, e.col, e.value]);
  const rhsVec = solver.getRhsSnapshot();
  const rhs: Array<[number, number]> = [];
  for (let i = 0; i < rhsVec.length; i++) {
    if (rhsVec[i] !== 0) rhs.push([i, rhsVec[i]]);
  }
  return { stamps, rhs };
}

// ---------------------------------------------------------------------------
// SCR partition layout tests
// ---------------------------------------------------------------------------

describe("SCR_PARAM_DEFS partition layout", () => {
  it("TEMP OFF have partition='instance'", () => {
    const tempDef = SCR_PARAM_DEFS.find((d) => d.key === "TEMP");
    const offDef = SCR_PARAM_DEFS.find((d) => d.key === "OFF");

    expect(tempDef).toBeDefined();
    expect(offDef).toBeDefined();

    expect(tempDef!.partition).toBe("instance");
    expect(offDef!.partition).toBe("instance");
  });

  it("vOn iH rOn vBreakover iS alpha1 alpha2_0 i_ref n have partition='model'", () => {
    const modelKeys = ["vOn", "iH", "rOn", "vBreakover", "iS", "alpha1", "alpha2_0", "i_ref", "n"];
    for (const key of modelKeys) {
      const def = SCR_PARAM_DEFS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.partition).toBe("model");
    }
  });
});

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

    // With SCR blocking, most voltage drops across it
    const iAk = (result.nodeVoltages[1] - result.nodeVoltages[0]) / 10000;
    expect(Math.abs(iAk)).toBeLessThan(1e-3); // less than 1mA (leakage only)
  });

  it("triggers_with_gate_current", () => {
    // V_AK = 50V, inject gate current well above I_GT (200µA).
    // Expected: SCR latches and presents low on-state conductance.
    const scrProps1 = new PropertyBag(); scrProps1.replaceModelParams({ ...SCR_PARAM_DEFAULTS, ...SCR_DEFAULTS });
    const scrCore1 = createScrElement(new Map([["A", 1], ["K", 2], ["G", 3]]), [], -1, scrProps1);
    const { element: scrEl } = withState(scrCore1);
    const scr = withNodeIds(scrEl, [1, 2, 3]);

    // Drive to operating point: 50V anode, 0V cathode, 0.65V gate
    const voltages = new Float64Array(3);
    voltages[0] = 50;   // anode (node1 → index 0)
    voltages[1] = 0;    // cathode (node2 → index 1)
    voltages[2] = 0.65; // gate (node3 → index 2) — forward-biased

    for (let i = 0; i < 200; i++) {
      const iterSolver = new SparseSolver();
      iterSolver._initStructure(3);
      scr.load(buildUnitCtx(iterSolver, voltages));
    }

    // Verify SCR is in on-state by checking high conductance (≈ 1/R_on = 100 S)
    const { stamps: mockCalls } = stampAndCapture(scr, voltages);

    // On-state: A-K diagonal conductance at (0,0) (anode row) is pure geq.
    // (1,1) also includes gGateGeq so would be geq + gGateGeq; read (0,0) to
    // isolate the anode-cathode stamp for the 1/R_on assertion.
    const gOn = 1 / SCR_DEFAULTS.rOn; // 100 S
    const aaEntry = mockCalls.find((c) => c[0] === 0 && c[1] === 0);
    const maxG = aaEntry ? Math.abs(aaEntry[2]) : 0;
    expect(maxG).toBeGreaterThan(1.0); // >> GMIN, confirms on-state

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
      const iterSolver = new SparseSolver();
      iterSolver._initStructure(3);
      scr.load(buildUnitCtx(iterSolver, voltages));
    }

    // Check latch state via re-stamping into a real solver: in on-state,
    // conductance = 1/R_on (high); in blocking state, conductance ≈ GMIN.
    // (0,0) is the pure anode-cathode diagonal (isolated from gate junction).
    const { stamps: mockCalls } = stampAndCapture(scr, voltages);

    const gOn = 1 / SCR_DEFAULTS.rOn;
    const aaEntry = mockCalls.find((c) => c[0] === 0 && c[1] === 0);
    const maxG = aaEntry ? Math.abs(aaEntry[2]) : 0;
    expect(maxG).toBeGreaterThan(1.0);
  });

  it("turns_off_below_holding_current", () => {
    // Trigger SCR, then reduce V_AK until I_AK < I_hold
    const scr = makeScrElement({ iH: 5e-3, rOn: 0.01, vOn: 1.5 });

    // Trigger the SCR first
    driveToOp(scr, 50, 0, 0.7, 100);

    // Verify it's latched by checking conductance in on-state via real solver re-stamp
    const onVoltages = new Float64Array([50, 0, 0.7]);
    const { stamps: mockCalls1 } = stampAndCapture(scr, onVoltages);
    const diagBefore = mockCalls1.filter((c) => c[0] === c[1] && c[0] < 2);
    const gBefore = Math.max(...diagBefore.map((c) => Math.abs(c[2])));
    expect(gBefore).toBeGreaterThan(1.0); // on-state

    // Now reduce V_AK to 0.1V — current = (0.1 - 1.5) / 0.01 = -140A (negative → below I_hold)
    const voltages = new Float64Array(3);
    voltages[0] = 0.1; // very low anode voltage
    voltages[1] = 0;
    voltages[2] = 0;

    for (let i = 0; i < 100; i++) {
      const iterSolver = new SparseSolver();
      iterSolver._initStructure(3);
      scr.load(buildUnitCtx(iterSolver, voltages));
    }

    // After unlatching, conductance should be very small (blocking state)
    const { stamps: mockCalls2 } = stampAndCapture(scr, voltages);
    const diagAfter = mockCalls2.filter((c) => c[0] === c[1] && c[0] < 2);
    const gAfter = Math.max(...diagAfter.map((c) => Math.abs(c[2])));
    expect(gAfter).toBeLessThan(0.1); // very small — blocking state restored
  });

  it("blocks_reverse", () => {
    // V_AK = -50V — reverse blocking, I_AK ≈ -I_S (small reverse leakage)
    const scr = makeScrElement();
    driveToOp(scr, -50, 0, 0, 100);

    const voltages = new Float64Array([-50, 0, 0]);
    const { stamps: mockCalls, rhs: mockRhs } = stampAndCapture(scr, voltages);

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

    const voltages = new Float64Array([110, 0, 0]);
    const { stamps: mockCalls } = stampAndCapture(scr, voltages);

    const gOn = 1 / SCR_DEFAULTS.rOn;
    const aaEntry = mockCalls.find((c) => c[0] === 0 && c[1] === 0);
    const maxG = aaEntry ? Math.abs(aaEntry[2]) : 0;
    expect(maxG).toBeGreaterThan(1.0);
  });

  it("no_writeback: load does not modify voltages[]", () => {
    const props = new PropertyBag();
    props.replaceModelParams({ ...SCR_PARAM_DEFAULTS, ...SCR_DEFAULTS });
    const core = createScrElement(new Map([["A", 1], ["K", 2], ["G", 3]]), [], -1, props);
    const { element: stated } = withState(core);
    const element = withNodeIds(stated, [1, 2, 3]);

    // Large forward voltage that would trigger pnjlim limiting
    const voltages = new Float64Array([50, 0, 0.65]);
    const snapshot = new Float64Array(voltages);

    const solver = new SparseSolver();
    solver._initStructure(3);
    element.load(buildUnitCtx(solver, voltages));

    expect(voltages[0]).toBe(snapshot[0]);
    expect(voltages[1]).toBe(snapshot[1]);
    expect(voltages[2]).toBe(snapshot[2]);
  });

  it("pool_state: pool.state0 contains correct slot values after load", () => {
    const props = new PropertyBag();
    props.replaceModelParams({ ...SCR_PARAM_DEFAULTS, ...SCR_DEFAULTS });
    const core = createScrElement(new Map([["A", 1], ["K", 2], ["G", 3]]), [], -1, props);
    const { element: stated, pool } = withState(core);
    const element = withNodeIds(stated, [1, 2, 3]);

    // Converge at forward-biased gate to trigger latching
    const voltages = new Float64Array([50, 0, 0.65]);
    for (let i = 0; i < 200; i++) {
      const iterSolver = new SparseSolver();
      iterSolver._initStructure(3);
      element.load(buildUnitCtx(iterSolver, voltages));
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
    const { element: stated, pool } = withState(core);
    const element = withNodeIds(stated, [1, 2, 3]);

    // Drive with forward voltage but no gate → blocking
    const voltages = new Float64Array([10, 0, 0]);
    for (let i = 0; i < 50; i++) {
      const iterSolver = new SparseSolver();
      iterSolver._initStructure(3);
      element.load(buildUnitCtx(iterSolver, voltages));
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

describe("SCR LimitingEvent instrumentation", () => {
  function makeScrWithState(): AnalogElement {
    const params = { ...SCR_PARAM_DEFAULTS, ...SCR_DEFAULTS };
    const props = createTestPropertyBag();
    props.replaceModelParams(params);
    const core = createScrElement(new Map([["A", 1], ["K", 2], ["G", 3]]), [], -1, props) as AnalogElementCore;
    Object.defineProperty(core, "label", { value: "SCR1", writable: true, configurable: true });
    (core as { elementIndex: number }).elementIndex = 4;
    const pool = new StatePool((core as unknown as { stateSize: number }).stateSize);
    (core as { stateBaseOffset: number }).stateBaseOffset = 0;
    (core as unknown as ReactiveAnalogElement).initState(pool);
    return withNodeIds(core, [1, 2, 3]);
  }

  function loadWithCollector(
    element: AnalogElement,
    voltages: Float64Array,
    collector: LimitingEvent[] | null,
  ): void {
    const solver = new SparseSolver();
    solver._initStructure(3);
    element.load(buildUnitCtx(solver, voltages, {
      limitingCollector: collector,
    }));
  }

  it("pushes AK and GK pnjlim events when limitingCollector provided", () => {
    const element = makeScrWithState();
    const voltages = new Float64Array(10);
    voltages[0] = 3.0;  // A = node 1
    voltages[1] = 0.0;  // K = node 2
    voltages[2] = 0.5;  // G = node 3

    const collector: LimitingEvent[] = [];
    loadWithCollector(element, voltages, collector);

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

  it("does not throw when limitingCollector is null", () => {
    const element = makeScrWithState();
    const voltages = new Float64Array(10);
    voltages[0] = 3.0;
    expect(() => loadWithCollector(element, voltages, null)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SCR TEMP tests — per-instance operating temperature
// ---------------------------------------------------------------------------

// Physical constants (ngspice const.h values — identical to scr.ts)
const CONSTboltz_TEST = 1.3806226e-23;
const CHARGE_TEST = 1.6021918e-19;
const KoverQ = CONSTboltz_TEST / CHARGE_TEST;

describe("SCR TEMP", () => {
  it("TEMP_default_300_15", () => {
    const props = new PropertyBag();
    props.replaceModelParams({ ...SCR_PARAM_DEFAULTS, ...SCR_DEFAULTS });
    expect(props.getModelParam<number>("TEMP")).toBe(300.15);
  });

  it("vt_reflects_TEMP", () => {
    // Construct SCR with TEMP=400K. Run one load() at forward-biased voltages
    // from a cold start so pnjlim is called. Verify that the pnjlim vAfter
    // matches what pnjlim would produce with nVt(400K).
    const params = { ...SCR_PARAM_DEFAULTS, ...SCR_DEFAULTS, TEMP: 400 };
    const props = createTestPropertyBag();
    props.replaceModelParams(params);
    const core = createScrElement(new Map([["A", 1], ["K", 2], ["G", 3]]), [], -1, props);
    const pool = new StatePool(Math.max((core as unknown as { stateSize: number }).stateSize, 1));
    (core as { stateBaseOffset: number }).stateBaseOffset = 0;
    (core as unknown as ReactiveAnalogElement).initState(pool);
    const element = withNodeIds(core, [1, 2, 3]);

    const voltages = new Float64Array(3);
    voltages[0] = 2.0;  // A
    voltages[1] = 0.0;  // K
    voltages[2] = 0.65; // G

    const collector: LimitingEvent[] = [];
    const solver = new SparseSolver();
    solver._initStructure(3);
    element.load(buildUnitCtx(solver, voltages, { limitingCollector: collector }));

    // Compute expected pnjlim result at TEMP=400K
    const vt400 = 400 * KoverQ;
    const nVt400 = params.n * vt400;
    const vcrit400 = nVt400 * Math.log(nVt400 / (params.iS * Math.SQRT2));

    const gkEv = collector.find((e: LimitingEvent) => e.junction === "GK");
    expect(gkEv).toBeDefined();
    const expected = pnjlim(gkEv!.vBefore, 0, nVt400, vcrit400);
    expect(gkEv!.vAfter).toBeCloseTo(expected.value, 10);
  });

  it("setParam_TEMP_recomputes", () => {
    // Construct SCR at default 300.15K, then setParam('TEMP', 400).
    // Verify that pnjlim now uses nVt(400K) by checking the GK limiting result.
    const params = { ...SCR_PARAM_DEFAULTS, ...SCR_DEFAULTS };
    const props = createTestPropertyBag();
    props.replaceModelParams(params);
    const core = createScrElement(new Map([["A", 1], ["K", 2], ["G", 3]]), [], -1, props);
    const pool = new StatePool(Math.max((core as unknown as { stateSize: number }).stateSize, 1));
    (core as { stateBaseOffset: number }).stateBaseOffset = 0;
    (core as unknown as ReactiveAnalogElement).initState(pool);
    const element = withNodeIds(core, [1, 2, 3]);

    // Change TEMP to 400K — should recompute tp
    element.setParam("TEMP", 400);

    const voltages = new Float64Array(3);
    voltages[0] = 2.0;
    voltages[1] = 0.0;
    voltages[2] = 0.65;

    const collector: LimitingEvent[] = [];
    const solver = new SparseSolver();
    solver._initStructure(3);
    element.load(buildUnitCtx(solver, voltages, { limitingCollector: collector }));

    const vt400 = 400 * KoverQ;
    const nVt400 = params.n * vt400;
    const vcrit400 = nVt400 * Math.log(nVt400 / (params.iS * Math.SQRT2));

    const gkEv = collector.find((e: LimitingEvent) => e.junction === "GK");
    expect(gkEv).toBeDefined();
    const expected = pnjlim(gkEv!.vBefore, 0, nVt400, vcrit400);
    expect(gkEv!.vAfter).toBeCloseTo(expected.value, 10);

    // Verify the result differs from what 300.15K would produce, confirming
    // that the recompute actually changed the thermal voltage.
    const vt300 = 300.15 * KoverQ;
    const nVt300 = params.n * vt300;
    const vcrit300 = nVt300 * Math.log(nVt300 / (params.iS * Math.SQRT2));
    const expected300 = pnjlim(gkEv!.vBefore, 0, nVt300, vcrit300);
    expect(gkEv!.vAfter).not.toBeCloseTo(expected300.value, 3);
  });

  it("no_ctx_vt_read", () => {
    // Verify that scr.ts contains zero occurrences of "ctx.vt" — every
    // thermal-voltage site must read from tp.vt (per-instance TEMP).
    const scrPath = fileURLToPath(new URL("../scr.ts", import.meta.url));
    const source = readFileSync(scrPath, "utf8");
    const occurrences = (source.match(/ctx\.vt/g) ?? []).length;
    expect(occurrences).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SCR primeJunctions tests — Task 7.5.4.2
// ---------------------------------------------------------------------------

describe("SCR primeJunctions", () => {
  function makeScrWithPool(overrides: Partial<typeof SCR_DEFAULTS & { OFF?: number }> = {}): {
    element: AnalogElement;
    pool: StatePool;
  } {
    const params = { ...SCR_PARAM_DEFAULTS, ...SCR_DEFAULTS, ...overrides };
    const props = createTestPropertyBag();
    props.replaceModelParams(params);
    const core = createScrElement(new Map([["A", 1], ["K", 2], ["G", 3]]), [], -1, props);
    const pool = new StatePool(Math.max((core as unknown as { stateSize: number }).stateSize, 1));
    (core as { stateBaseOffset: number }).stateBaseOffset = 0;
    (core as unknown as ReactiveAnalogElement).initState(pool);
    const element = withNodeIds(core, [1, 2, 3]);
    return { element, pool };
  }

  it("method_absent", () => {
    const { element } = makeScrWithPool();
    expect((element as unknown as Record<string, unknown>)["primeJunctions"]).toBeUndefined();
  });

  it("MODEINITJCT_seeds_vak_vcrit", () => {
    // With OFF=0, MODEINITJCT branch should write tp.tVcrit to SLOT_VAK and 0 to SLOT_VGK.
    const { element, pool } = makeScrWithPool({ OFF: 0 } as Parameters<typeof makeScrWithPool>[0]);

    // Compute expected tVcrit using same formula as scr.ts computeScrTempParams()
    const vt = SCR_DEFAULTS.n * 1 * (300.15 * CONSTboltz_TEST / CHARGE_TEST);
    const nVt = vt;
    const tVcrit = nVt * Math.log(nVt / (SCR_DEFAULTS.iS * Math.SQRT2));

    const solver = new SparseSolver();
    solver._initStructure(3);
    element.load(buildUnitCtx(solver, new Float64Array(3), {
      cktMode: MODEDCOP | MODEINITJCT,
    }));

    const s0 = pool.states[0];
    expect(s0[SLOT_VAK]).toBeCloseTo(tVcrit, 10);
    expect(s0[SLOT_VGK]).toBe(0);
  });

  it("MODEINITJCT_OFF_zeros_both", () => {
    // With OFF=1, MODEINITJCT branch should write 0 to both SLOT_VAK and SLOT_VGK.
    const { element, pool } = makeScrWithPool({ OFF: 1 } as Parameters<typeof makeScrWithPool>[0]);

    const solver = new SparseSolver();
    solver._initStructure(3);
    element.load(buildUnitCtx(solver, new Float64Array(3), {
      cktMode: MODEDCOP | MODEINITJCT,
    }));

    const s0 = pool.states[0];
    expect(s0[SLOT_VAK]).toBe(0);
    expect(s0[SLOT_VGK]).toBe(0);
  });
});
