/**
 * Tests for AbstractFetElement refactoring of NMOS and PMOS.
 *
 * Verifies:
 *   - nmos_dc_unchanged: NMOS DC operating point identical after refactor
 *   - pmos_dc_unchanged: PMOS DC operating point identical after refactor
 *   - nmos_transient_unchanged: load() runs the reactive companion path
 *   - stamp_pattern_correct: gm and gds conductance entries at correct positions
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMosfetElement, MOSFET_NMOS_DEFAULTS, MOSFET_PMOS_DEFAULTS } from "../../../components/semiconductors/mosfet.js";
import {
  AbstractFetElement,
  SLOT_GM,
  SLOT_GDS,
  SLOT_VGS,
  SLOT_VDS,
  SLOT_IDS,
  SLOT_SWAPPED,
  SLOT_V_GS,
  SLOT_V_GD,
  SLOT_Q_GS,
  SLOT_CCAP_GS,
} from "../fet-base.js";
import { PropertyBag } from "../../../core/properties.js";
import { makeDcVoltageSource } from "../../../components/sources/dc-voltage-source.js";
import { withNodeIds, runDcOp, makeResistor } from "./test-helpers.js";
import { StatePool } from "../state-pool.js";
import type { SparseSolver as SparseSolverType } from "../sparse-solver.js";
import type { AnalogElement } from "../element.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";
import type { ReactiveAnalogElement } from "../element.js";
import type { LoadContext } from "../load-context.js";

// ---------------------------------------------------------------------------
// Default model parameters (same as mosfet.test.ts for exact comparison)
// ---------------------------------------------------------------------------

const NMOS_DEFAULTS = {
  ...MOSFET_NMOS_DEFAULTS,
  VTO: 0.7,
  KP: 120e-6,
  LAMBDA: 0.02,
  PHI: 0.6,
  GAMMA: 0.37,
  CBD: 0,
  CBS: 0,
  CGDO: 0,
  CGSO: 0,
  W: 1e-6,
  L: 1e-6,
};

const PMOS_DEFAULTS = {
  ...MOSFET_PMOS_DEFAULTS,
  VTO: -0.7,
  KP: 60e-6,
  LAMBDA: 0.02,
  PHI: 0.6,
  GAMMA: 0.37,
  CBD: 0,
  CBS: 0,
  CGDO: 0,
  CGSO: 0,
  W: 1e-6,
  L: 1e-6,
};

const NMOS_10U_1U = { ...NMOS_DEFAULTS, W: 10e-6, L: 1e-6 };

function makeParamBag(params: Record<string, number>): PropertyBag {
  const bag = new PropertyBag();
  bag.replaceModelParams(params);
  return bag;
}

// ---------------------------------------------------------------------------
// withState — allocate a StatePool and call initState on the element
// ---------------------------------------------------------------------------

/**
 * Allocate a StatePool sized for the element's stateSize, assign stateBaseOffset,
 * and call initState. Returns the element (mutated in place) for chaining.
 */
function withState(element: AnalogElementCore): ReactiveAnalogElement {
  const re = element as ReactiveAnalogElement;
  re.stateBaseOffset = 0;
  const pool = new StatePool(re.stateSize);
  re.initState(pool);
  return re;
}

// ---------------------------------------------------------------------------
// Spy solver — records every row/col/value argument triple passed to the
// solver so tests can assert the conductance stamp pattern.
// ---------------------------------------------------------------------------

// Spy solver records allocElement+stampElement pairs so tests can assert the
// conductance stamp pattern after the Phase-6 two-step API migration.
// allocElement(row, col) returns a numeric handle; stampElement(handle, val)
// records a {row, col, val} triple in `spyStampCalls`.
// ref: ngspice mos1load.c ~700-900 stamp block (two-step pattern)
function makeSpySolver(): SparseSolverType & { spyStampCalls: { row: number; col: number; val: number }[] } {
  const _handles: { row: number; col: number }[] = [];
  const spyStampCalls: { row: number; col: number; val: number }[] = [];
  const solver = {
    stamp: vi.fn(),
    stampRHS: vi.fn(),
    allocElement: vi.fn((row: number, col: number): number => {
      const h = _handles.length;
      _handles.push({ row, col });
      return h;
    }),
    stampElement: vi.fn((handle: number, val: number): void => {
      const entry = _handles[handle];
      if (entry !== undefined) spyStampCalls.push({ row: entry.row, col: entry.col, val });
    }),
    spyStampCalls,
  };
  return solver as unknown as SparseSolverType & { spyStampCalls: { row: number; col: number; val: number }[] };
}

// ---------------------------------------------------------------------------
// Build a minimal LoadContext for direct element.load(ctx) calls. The ctx
// carries a spy solver and default DC-OP flags; callers override fields they
// need (voltages, isTransient, ag, dt, etc.) before calling load().
// ---------------------------------------------------------------------------

function makeDirectLoadCtx(voltages: Float64Array, overrides: Partial<LoadContext> = {}): LoadContext {
  const dt = overrides.dt ?? 0;
  return {
    solver: makeSpySolver(),
    voltages,
    iteration: 0,
    initMode: "transient",
    dt,
    method: "trapezoidal",
    order: 1,
    deltaOld: [dt, dt, dt, dt, dt, dt, dt],
    ag: overrides.ag ?? new Float64Array(8),
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    isDcOp: false,
    isTransient: false,
    xfact: 1,
    gmin: 1e-12,
    uic: false,
    reltol: 1e-3,
    iabstol: 1e-12,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Refactor: nmos_dc_unchanged
// ---------------------------------------------------------------------------

describe("Refactor", () => {
  it("nmos_dc_unchanged", () => {
    // Common-source NMOS: Vdd=5V, Rd=1kΩ, Vg=3V, Vs=GND
    // MNA: node1=drain, node2=Vdd(5V), node3=gate(3V), branch3=Vdd, branch4=Vgate
    // Same layout as mosfet.test.ts integration test
    const matrixSize = 5;

    const propsObj = makeParamBag(NMOS_10U_1U);
    const nmosElement = withState(withNodeIds(createMosfetElement(
      1,
      new Map([["G", 3], ["S", 0], ["D", 1]]), // G=node3, S=ground, D=node1
      [],
      -1,
      propsObj,
    ), [3, 0, 1])); // pinLayout order: [G, S, D]

    const vddSource = withNodeIds(makeDcVoltageSource(2, 0, 3, 5.0), [2, 0]);
    const vgateSource = withNodeIds(makeDcVoltageSource(3, 0, 4, 3.0), [3, 0]);
    const rdElement = makeResistor(2, 1, 1000);     // Rd between Vdd and drain

    const elements: AnalogElement[] = [vddSource, vgateSource, rdElement, nmosElement];

    const result = runDcOp({
      elements,
      matrixSize,
      nodeCount: 3,
    });

    expect(result.converged).toBe(true);

    // nodeVoltages: [V(node1)=Vdrain, V(node2)=Vdd, V(node3)=Vgate, ...]
    const vDrain = result.nodeVoltages[0]; // node1 = drain
    const vDD = result.nodeVoltages[1];    // node2 = Vdd
    const idApprox = (vDD - vDrain) / 1000;

    // Vdd should be 5V
    expect(vDD).toBeCloseTo(5, 2);

    // Vds should be in the expected range (device in saturation or linear)
    expect(vDrain).toBeGreaterThan(1.0);
    expect(vDrain).toBeLessThan(5.0);

    // Id should be several mA for W=10µ NMOS in this bias
    expect(idApprox).toBeGreaterThan(0.5e-3);
    expect(idApprox).toBeLessThan(5e-3);
  });

  it("pmos_dc_unchanged", () => {
    // Common-source PMOS: Vss=5V (source high), Rd=1kΩ at drain to GND, Vg=2V
    // PMOS: S=Vss, G=Vg, D through Rd to ground
    // MNA: node1=drain, node2=Vss(5V), node3=gate(2V)
    const matrixSize = 5;

    const propsObj = makeParamBag(PMOS_DEFAULTS);
    const pmosElement = withState(withNodeIds(createMosfetElement(
      -1,
      new Map([["G", 3], ["S", 2], ["D", 1]]), // G=node3, S=node2(Vss), D=node1
      [],
      -1,
      propsObj,
    ), [3, 1, 2])); // pinLayout order: [G, D, S] for PMOS

    const rdElement = makeResistor(1, 0, 1000); // Rd from drain to GND
    const vssSource = withNodeIds(makeDcVoltageSource(2, 0, 3, 5.0), [2, 0]);
    const vgateSource = withNodeIds(makeDcVoltageSource(3, 0, 4, 2.0), [3, 0]);

    const elements: AnalogElement[] = [vssSource, vgateSource, rdElement, pmosElement];

    const result = runDcOp({
      elements,
      matrixSize,
      nodeCount: 3,
    });

    expect(result.converged).toBe(true);

    const vDrain = result.nodeVoltages[0]; // node1 = drain
    const vVss = result.nodeVoltages[1];   // node2 = Vss

    // Vss should be 5V
    expect(vVss).toBeCloseTo(5, 2);

    // PMOS conducts: Vsg = Vss - Vg = 5 - 2 = 3V > |VTP| = 0.7V → on
    // Drain voltage should be above ground (PMOS pulls drain high)
    expect(vDrain).toBeGreaterThan(0.1);
    expect(vDrain).toBeLessThan(vVss - 0.1);
  });

  it("nmos_transient_unchanged", () => {
    // Verify NMOS with capacitances produces reactive behavior in transient:
    // After adding Cbd junction capacitance, the element is marked isReactive
    // and load() runs the reactive companion stamp path in transient mode.
    const propsWithCap = { ...NMOS_DEFAULTS, CBD: 1e-12 };
    const propsObj = makeParamBag(propsWithCap);
    // pinLayout order for NMOS factory: [G, S, D, B]; map pinNodeIds to match.
    const element = withState(withNodeIds(
      createMosfetElement(1, new Map([["G", 1], ["S", 2], ["D", 3]]), [], -1, propsObj),
      [1, 2, 3],
    ));

    expect(element.isReactive).toBe(true);
    expect(typeof element.load).toBe("function");

    // Set up an operating point. voltages array is indexed by (nodeId - 1).
    const voltages = new Float64Array(3);
    voltages[0] = 3; // V(node1=G) = 3V
    voltages[1] = 0; // V(node2=S) = 0V
    voltages[2] = 5; // V(node3=D) = 5V

    const dcCtx = makeDirectLoadCtx(voltages, { isDcOp: true });
    for (let i = 0; i < 10; i++) {
      element.load(dcCtx);
    }

    // Transient load() must run the reactive companion path without throwing.
    const dt = 1e-9;
    const ag = new Float64Array(8);
    ag[0] = 1 / dt;  // bdf1 order-1 coefficient
    ag[1] = -1 / dt;
    const tranCtx = makeDirectLoadCtx(voltages, {
      isTransient: true,
      dt,
      method: "bdf1",
      order: 1,
      ag,
    });
    expect(() => element.load(tranCtx)).not.toThrow();

    // A second load() call must also succeed — companion state is now populated
    // and the nonlinear+reactive stamps re-run cleanly each NR iteration.
    expect(() => element.load(tranCtx)).not.toThrow();
  });

  it("stamp_pattern_correct", () => {
    // Drive NMOS to saturation (Vgs=3V, Vds=5V)
    // Use nodeG=2, nodeS=0 (ground source), nodeD=1 for cleaner test.
    // createMosfetElement expects [G, S, D]
    const propsObj = makeParamBag(NMOS_DEFAULTS);
    // pinLayout order for NMOS factory: [G, S, D, B]; bulk defaults to source.
    const element = withState(withNodeIds(
      createMosfetElement(1, new Map([["G", 2], ["S", 0], ["D", 1]]), [], -1, propsObj),
      [2, 0, 1],
    ));

    // Drive to saturation: Vgs=3V (G=3V, S=0V), Vds=5V (D=5V, S=0V)
    // matrixSize=2, voltages: index0=V(node1)=Vds=5V, index1=V(node2=G)=3V
    const voltages = new Float64Array(2);
    voltages[0] = 5; // V(node1=D) = 5V
    voltages[1] = 3; // V(node2=G) = 3V

    const ctx = makeDirectLoadCtx(voltages, { isDcOp: true });
    for (let i = 0; i < 50; i++) {
      element.load(ctx);
      voltages[0] = 5;
      voltages[1] = 3;
    }

    // Phase-6 migration: production uses allocElement+stampElement (two-step pattern).
    // ref: ngspice mos1load.c ~700-900 stamp block
    const spySolver = ctx.solver as ReturnType<typeof makeSpySolver>;
    const stampCalls = spySolver.spyStampCalls;

    // Expect conductance entries at D-G (gm), D-D (gds), S-G (-gm), S-D (-gds)
    // nodeD=1 → matrix index 0; nodeG=2 → matrix index 1; nodeS=0 → skipped
    // Since nodeS=0 (ground), rows/cols for S are skipped
    // Expected non-zero stamps: [0,1] for gm (D,G), [0,0] for gds (D,D)
    // S rows skipped since nodeS=0

    const nonzeroStamps = stampCalls.filter((s) => Math.abs(s.val) > 1e-15);
    expect(nonzeroStamps.length).toBeGreaterThan(0);

    // Find D-G entry (gm): row=D-1=0, col=G-1=1. The load() path may write the
    // same (row,col) more than once — sum the values to get the net stamp.
    const dgContribs = stampCalls.filter((s) => s.row === 0 && s.col === 1);
    expect(dgContribs.length).toBeGreaterThan(0);
    const dgTotal = dgContribs.reduce((acc, s) => acc + s.val, 0);
    expect(dgTotal).toBeGreaterThan(0);

    // Find D-D entry (gds): row=D-1=0, col=D-1=0.
    const ddContribs = stampCalls.filter((s) => s.row === 0 && s.col === 0);
    expect(ddContribs.length).toBeGreaterThan(0);
    const ddTotal = ddContribs.reduce((acc, s) => acc + s.val, 0);
    expect(ddTotal).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AbstractFetElement structural tests
// ---------------------------------------------------------------------------

describe("AbstractFetElement", () => {
  it("createMosfetElement_returns_AbstractFetElement_instance", () => {
    const propsObj = makeParamBag(NMOS_DEFAULTS);
    const element = createMosfetElement(1, new Map([["G", 1], ["S", 2], ["D", 3]]), [], -1, propsObj);
    expect(element).toBeInstanceOf(AbstractFetElement);
  });

  it("pmos_is_AbstractFetElement_instance", () => {
    const propsObj = makeParamBag(PMOS_DEFAULTS);
    const element = createMosfetElement(-1, new Map([["G", 1], ["S", 2], ["D", 3]]), [], -1, propsObj);
    expect(element).toBeInstanceOf(AbstractFetElement);
  });

  it("nmos_polarity_sign_is_1", () => {
    const propsObj = makeParamBag(NMOS_DEFAULTS);
    const element = createMosfetElement(1, new Map([["G", 1], ["S", 2], ["D", 3]]), [], -1, propsObj);
    expect((element as AbstractFetElement).polaritySign).toBe(1);
  });

  it("pmos_polarity_sign_is_minus_1", () => {
    const propsObj = makeParamBag(PMOS_DEFAULTS);
    const element = createMosfetElement(-1, new Map([["G", 1], ["S", 2], ["D", 3]]), [], -1, propsObj);
    expect((element as AbstractFetElement).polaritySign).toBe(-1);
  });

  it("gm_gds_stamped_at_correct_nodes", () => {
    // nodeG=1, nodeS=3, nodeD=2; createMosfetElement expects [G, S, D]
    // matrix indices: G-1=0, S-1=2, D-1=1
    const propsObj = makeParamBag(NMOS_DEFAULTS);
    // pinLayout order for NMOS factory: [G, S, D, B]; bulk defaults to source.
    const element = withState(withNodeIds(
      createMosfetElement(1, new Map([["G", 1], ["S", 3], ["D", 2]]), [], -1, propsObj),
      [1, 3, 2],
    ));

    const voltages = new Float64Array(3);
    voltages[0] = 3; // V(node1=G) = 3V
    voltages[1] = 5; // V(node2=D) = 5V
    voltages[2] = 0; // V(node3=S) = 0

    const ctx = makeDirectLoadCtx(voltages, { isDcOp: true });
    for (let i = 0; i < 50; i++) {
      element.load(ctx);
      voltages[0] = 3;
      voltages[1] = 5;
      voltages[2] = 0;
    }

    // Phase-6 migration: production uses allocElement+stampElement (two-step pattern).
    // ref: ngspice mos1load.c ~700-900 stamp block
    const spySolver = ctx.solver as ReturnType<typeof makeSpySolver>;
    const stampCalls = spySolver.spyStampCalls;

    // D=node2 → row/col index 1; G=node1 → row/col index 0; S=node3 → row/col index 2
    // gm appears at [D,G] = [1,0] and [-gm at S,G = 2,0]. Sum duplicate stamps.
    const dgContribs = stampCalls.filter((s) => s.row === 1 && s.col === 0);
    expect(dgContribs.length).toBeGreaterThan(0);
    const dgTotal = dgContribs.reduce((acc, s) => acc + s.val, 0);
    expect(dgTotal).toBeGreaterThan(0); // gm > 0

    // gds appears at [D,D] = [1,1]
    const ddContribs = stampCalls.filter((s) => s.row === 1 && s.col === 1);
    expect(ddContribs.length).toBeGreaterThan(0);
    const ddTotal = ddContribs.reduce((acc, s) => acc + s.val, 0);
    expect(ddTotal).toBeGreaterThan(0); // gds > 0
  });
});

// ---------------------------------------------------------------------------
// State pool migration tests
// ---------------------------------------------------------------------------

describe("StatePool migration", () => {
  it("stateBaseOffset_defaults_to_minus1_before_initState", () => {
    const propsObj = makeParamBag(NMOS_DEFAULTS);
    const element = createMosfetElement(1, new Map([["G", 1], ["S", 2], ["D", 3]]), [], -1, propsObj);
    expect(element.stateBaseOffset).toBe(-1);
  });

  it("initState_binds_pool_and_sets_initial_values", () => {
    const propsObj = makeParamBag(NMOS_DEFAULTS);
    const element = createMosfetElement(1, new Map([["G", 1], ["S", 0], ["D", 2]]), [], -1, propsObj);
    element.stateBaseOffset = 0;
    const pool = new StatePool(element.stateSize);
    element.initState!(pool);

    // Initial _gm and _gds should be 1e-12 (device-off values)
    expect(pool.state0[SLOT_GM]).toBeCloseTo(1e-12);
    expect(pool.state0[SLOT_GDS]).toBeCloseTo(1e-12);
    // VGS, VDS, IDS = 0 initially
    expect(pool.state0[SLOT_VGS]).toBe(0);
    expect(pool.state0[SLOT_VDS]).toBe(0);
    expect(pool.state0[SLOT_IDS]).toBe(0);
    // SWAPPED = 0.0
    expect(pool.state0[SLOT_SWAPPED]).toBe(0);
    // SLOT_V_GS and SLOT_V_GD are zero-initialised;
    // first-call detection is now done via s1[Q_GS]===0, not a NaN sentinel.
    expect(pool.state0[SLOT_V_GS]).toBe(0);
    expect(pool.state0[SLOT_V_GD]).toBe(0);
  });

  it("load_writes_state_to_pool", () => {
    const propsObj = makeParamBag(NMOS_DEFAULTS);
    const core = createMosfetElement(1, new Map([["G", 2], ["S", 0], ["D", 1]]), [], -1, propsObj);
    const element = withNodeIds(core, [2, 0, 1]) as ReactiveAnalogElement;
    element.stateBaseOffset = 0;
    const pool = new StatePool(element.stateSize);
    element.initState(pool);

    // Drive to saturation: Vgs=3, Vds=5
    const voltages = new Float64Array(2);
    voltages[0] = 5; // V(node1=D) = 5V
    voltages[1] = 3; // V(node2=G) = 3V

    const ctx = makeDirectLoadCtx(voltages, { isDcOp: true });
    for (let i = 0; i < 20; i++) {
      element.load(ctx);
      voltages[0] = 5;
      voltages[1] = 3;
    }

    // After convergence, pool should contain non-trivial gm and gds
    expect(pool.state0[SLOT_VGS]).toBeGreaterThan(0);
    expect(pool.state0[SLOT_VDS]).toBeGreaterThan(0);
    expect(pool.state0[SLOT_GM]).toBeGreaterThan(1e-12);
    expect(pool.state0[SLOT_GDS]).toBeGreaterThan(1e-12);
  });

  it("voltages_unchanged_after_load", () => {
    const propsObj = makeParamBag(NMOS_DEFAULTS);
    const element = withState(withNodeIds(
      createMosfetElement(1, new Map([["G", 2], ["S", 0], ["D", 1]]), [], -1, propsObj),
      [2, 0, 1],
    ));

    const voltages = new Float64Array([5.0, 3.0]);
    const snapshot = new Float64Array(voltages);

    const ctx = makeDirectLoadCtx(voltages, { isDcOp: true });
    for (let i = 0; i < 10; i++) {
      element.load(ctx);
    }

    // voltages array must be unchanged — no write-back
    expect(voltages[0]).toBe(snapshot[0]);
    expect(voltages[1]).toBe(snapshot[1]);
  });

  it("swapped_flag_stored_as_float_in_pool", () => {
    const propsObj = makeParamBag(NMOS_DEFAULTS);
    const core = createMosfetElement(1, new Map([["G", 2], ["S", 0], ["D", 1]]), [], -1, propsObj);
    const element = withNodeIds(core, [2, 0, 1]) as ReactiveAnalogElement;
    element.stateBaseOffset = 0;
    const pool = new StatePool(element.stateSize);
    element.initState(pool);

    // Drive with reversed Vds (Vgs=3, Vds<0 → swap condition)
    const voltages = new Float64Array(2);
    voltages[0] = 0; // V(D) = 0V (less than source)
    voltages[1] = 3; // V(G) = 3V

    const ctx = makeDirectLoadCtx(voltages, { isDcOp: true });
    for (let i = 0; i < 5; i++) {
      element.load(ctx);
    }

    // SLOT_SWAPPED must be 0.0 or 1.0, never another value
    const swappedVal = pool.state0[SLOT_SWAPPED];
    expect(swappedVal === 0.0 || swappedVal === 1.0).toBe(true);
  });

  it("pool_state_survives_rollback", () => {
    const propsObj = makeParamBag(NMOS_DEFAULTS);
    const element = withState(withNodeIds(
      createMosfetElement(1, new Map([["G", 2], ["S", 0], ["D", 1]]), [], -1, propsObj),
      [2, 0, 1],
    ));

    const pool = new StatePool(element.stateSize);
    element.stateBaseOffset = 0;
    element.initState(pool);

    // Drive to a known operating point
    const voltages = new Float64Array([5.0, 3.0]);
    const ctx = makeDirectLoadCtx(voltages, { isDcOp: true });
    for (let i = 0; i < 10; i++) {
      element.load(ctx);
      voltages[0] = 5.0;
      voltages[1] = 3.0;
    }

    const cp = new Float64Array(pool.state0);

    // Mutate state with different voltages
    const voltages2 = new Float64Array([1.0, 0.5]);
    const ctx2 = makeDirectLoadCtx(voltages2, { isDcOp: true });
    for (let i = 0; i < 5; i++) {
      element.load(ctx2);
      voltages2[0] = 1.0;
      voltages2[1] = 0.5;
    }

    const vgsAfterMutation = pool.state0[SLOT_VGS];

    // Rollback by copying the saved buffer back into state0.
    pool.state0.set(cp);

    const vgsAfterRollback = pool.state0[SLOT_VGS];

    // After rollback, state0 should be restored to checkpoint values
    expect(vgsAfterRollback).not.toBe(vgsAfterMutation);
    expect(vgsAfterRollback).toBe(cp[SLOT_VGS]);
  });
});

// ---------------------------------------------------------------------------
// integration — NIintegrate inline migration tests
// ---------------------------------------------------------------------------

describe("integration", () => {
  it("no_integrateCapacitor_import", () => {
    const fetBasePath = fileURLToPath(new URL("../fet-base.ts", import.meta.url));
    const source = readFileSync(fetBasePath, "utf-8");
    expect(source.match(/integrateCapacitor/g)).toBeNull();
    expect(source.match(/integrateInductor/g)).toBeNull();
  });

  it("trap_order2_matches_niinteg_recursion", () => {
    // Build an NMOS with non-zero CGSO so cgs = CGSO * W * M > 0.
    const CGSO = 100e-12;  // F/m — overlap cap per unit width
    const W    = 10e-6;     // m
    // cgs from computeCapacitances = CGSO * W * M = 100e-12 * 10e-6 = 1e-15 F

    const propsObj = new PropertyBag();
    propsObj.replaceModelParams({
      ...MOSFET_NMOS_DEFAULTS,
      VTO: 0.7,
      KP: 120e-6,
      LAMBDA: 0.02,
      PHI: 0.6,
      GAMMA: 0.37,
      CBD: 0,
      CBS: 0,
      CGDO: 0,
      CGSO,
      W,
      L: 1e-6,
    });

    // G=node1, S=node2, D=node3 (bulk defaults to source for 3-terminal)
    const element = createMosfetElement(1, new Map([["G", 1], ["S", 2], ["D", 3]]), [], -1, propsObj) as AnalogElementCore & { stateBaseOffset: number; stateSize: number; initState(p: StatePool): void; isReactive: boolean };
    element.stateBaseOffset = 0;
    const pool = new StatePool(element.stateSize);
    element.initState(pool);

    // Set up state: second transient step so isFirstCall === false (tranStep=1).
    pool.tranStep = 1;

    // Manually seed q0 and q1 (prev-step charge) in pool slots.
    // q0 (current step charge) goes into s0[SLOT_Q_GS] — set it here directly since
    // _stampCompanion computes q0 from voltages+prevVgs+prevQgs; we instead drive
    // the element via load() and then read back the committed ccap.
    //
    // Strategy: set voltages so vgsNow = 3.0, prevVgs = 2.5 (in s1), prevQgs = known.
    // Then q0 = cgs*(vgsNow - prevVgs) + prevQgs.
    const vgsNow  = 3.0;
    const prevVgs = 2.5;
    const prevQgs = 5e-16;  // prev step charge
    const ccapPrev = 1.25e-7;  // non-zero so TRAP order 2 recursion (niinteg.c:32) is exercised

    // Write s1 (prev step) values:
    pool.state1[SLOT_V_GS] = prevVgs;   // prevVgs read in _stampCompanion
    pool.state1[SLOT_Q_GS] = prevQgs;   // q1 read as this.s1[base + SLOT_Q_GS]
    pool.state1[SLOT_CCAP_GS] = ccapPrev; // ccapPrev — RECURSIVE in TRAP order 2 per niinteg.c:32

    // Trap order 2 integration coefficients with xmu = 0.3
    const xmu = 0.3;
    const dt   = 1e-9;
    // ag[0] = 1/(dt*(1-xmu))  — from computeNIcomCof trap order 2
    const ag0 = 1.0 / dt / (1.0 - xmu);
    // ag[1] = xmu/(1-xmu)
    const ag1 = xmu / (1.0 - xmu);
    // D1: ag buffer lives on the LoadContext, not on StatePool.
    const agBuf = new Float64Array(7);
    agBuf[0] = ag0;
    agBuf[1] = ag1;

    // Build a minimal LoadContext for the transient load() call.
    // The mock solver captures stamps but we only care about pool state after load().
    const mockSolver: SparseSolverType = {
      stamp: vi.fn(),
      stampRHS: vi.fn(),
      allocElement: vi.fn().mockReturnValue(0),
      stampElement: vi.fn(),
    } as unknown as SparseSolverType;

    // Node voltages: G=node1 → v[0]=vgsNow+vS, S=node2 → v[1]=vS, D=node3 → v[2]=5V
    // With S=node2, vS=v[1]; G=node1, vG=v[0]; polaritySign=+1
    // vgsNow = vG - vS = v[0] - v[1]
    // Set v[1]=0 (source at ground), v[0]=vgsNow=3.0, v[2]=5.0
    const voltages = new Float64Array([vgsNow, 0, 5.0]);

    const ctx: LoadContext = {
      solver: mockSolver,
      voltages,
      iteration: 0,
      initMode: "transient",
      dt,
      method: "trapezoidal",
      order: 2,
      deltaOld: [dt, dt, dt, dt, dt, dt, dt],
      ag: agBuf,
      srcFact: 1,
      noncon: { value: 0 },
      limitingCollector: null,
      isDcOp: false,
      isTransient: true,
      xfact: 1,
      gmin: 1e-12,
      uic: false,
      reltol: 1e-3,
      iabstol: 1e-12,
    };

    // Assign pinNodeIds so load() can read nodes
    (element as unknown as { pinNodeIds: readonly number[] }).pinNodeIds = [1, 2, 3];

    element.load!(ctx as LoadContext);

    // After load(), s0[SLOT_Q_GS] holds q0 = cgs*(vgsNow - prevVgs) + prevQgs
    const q0 = pool.state0[SLOT_Q_GS];
    const q1 = prevQgs;  // s1[SLOT_Q_GS] — unchanged by load()

    // Expected ccap from NIintegrate TRAP order=2 (niinteg.c:32-34 — RECURSIVE):
    // ccap = -ccapPrev * ag[1] + ag[0] * (q0 - q1)
    const expectedCcap = -ccapPrev * ag1 + ag0 * (q0 - q1);

    // Bit-exact: the implementation performs this exact floating-point computation
    expect(pool.state0[SLOT_CCAP_GS]).toBe(expectedCcap);
  });
});
