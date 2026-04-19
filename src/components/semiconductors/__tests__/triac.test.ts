/**
 * Tests for the Triac (bidirectional thyristor) component.
 *
 * Covers:
 *   - conducts_positive_when_triggered: positive V, gate pulse → conduction
 *   - conducts_negative_when_triggered: negative V, gate pulse → reverse conduction
 *   - turns_off_at_zero_crossing: triac turns off when current drops below I_hold
 *   - phase_control: trigger at 90° of sine → chopped output starting at 90°
 *   - no_writeback: load(ctx) does not modify voltages[]
 *   - pool_state: pool.state0 slots contain correct values after load(ctx)
 */

import { describe, it, expect } from "vitest";
import { createTriacElement, TriacDefinition, TRIAC_PARAM_DEFAULTS } from "../triac.js";
import { createTestPropertyBag } from "../../../test-fixtures/model-fixtures.js";
import { PropertyBag } from "../../../core/properties.js";
import { withNodeIds } from "../../../solver/analog/__tests__/test-helpers.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";
import type { ReactiveAnalogElement } from "../../../solver/analog/element.js";
import type { AnalogFactory } from "../../../core/registry.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";

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
// Default Triac parameters
// ---------------------------------------------------------------------------

const TRIAC_DEFAULTS = {
  vOn: 1.5,
  iH: 10e-3, // 10mA holding current
  rOn: 0.01,
  iS: 1e-12,
  alpha1: 0.5,
  alpha2_0: 0.3,
  i_ref: 1e-3,
  n: 1,
};

// Slot indices (must match triac.ts)
const SLOT_VAK        = 0;
const SLOT_GEQ        = 2;
const SLOT_LATCHED    = 6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTriac(overrides: Partial<typeof TRIAC_DEFAULTS> = {}): AnalogElement {
  const params = { ...TRIAC_PARAM_DEFAULTS, ...TRIAC_DEFAULTS, ...overrides };
  const props = createTestPropertyBag();
  props.replaceModelParams(params);
  // nodeMT1=1, nodeMT2=2, nodeG=3
  const core = createTriacElement(new Map([["MT1", 1], ["MT2", 2], ["G", 3]]), [], -1, props);
  const { element } = withState(core);
  return withNodeIds(element, [1, 2, 3]);
}

/** Build a DC-OP LoadContext over a fresh SparseSolver sized for 3 matrix rows (nodes 1..3). */
function makeDcOpCtx(voltages: Float64Array): LoadContext {
  const solver = new SparseSolver();
  solver.beginAssembly(3);
  return {
    solver,
    voltages,
    iteration: 1,
    initMode: "initFloat",
    dt: 0,
    method: "trapezoidal",
    order: 1,
    deltaOld: [0, 0, 0, 0, 0, 0, 0],
    ag: new Float64Array(8),
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    isDcOp: true,
    isTransient: false,
    isTransientDcop: false,
    isAc: false,
    xfact: 1,
    gmin: 1e-12,
    uic: false,
    reltol: 1e-3,
    iabstol: 1e-12,
  };
}

/**
 * Drive triac to a steady operating point by calling load(ctx) repeatedly
 * with fixed node voltages, then return the final voltages array.
 * nodeMT1=1 (index 0), nodeMT2=2 (index 1), nodeG=3 (index 2)
 */
function driveToOp(
  element: AnalogElement,
  vMT1: number,
  vMT2: number,
  vGate: number,
  iterations = 150,
): Float64Array {
  const voltages = new Float64Array(3);
  voltages[0] = vMT1;
  voltages[1] = vMT2;
  voltages[2] = vGate;
  for (let i = 0; i < iterations; i++) {
    element.load(makeDcOpCtx(voltages));
    voltages[0] = vMT1;
    voltages[1] = vMT2;
    voltages[2] = vGate;
  }
  return voltages;
}

/**
 * Returns the peak diagonal conductance for the MT1-MT2 path (solver rows 0
 * and 1). Stamps the already-converged element into a fresh SparseSolver at
 * the given voltages and reads the assembled diagonal entries.
 */
function getMainPathConductance(element: AnalogElement, voltages: Float64Array): number {
  const ctx = makeDcOpCtx(voltages);
  element.load(ctx);
  const entries = ctx.solver.getCSCNonZeros();
  const sumAt = (row: number, col: number) =>
    entries
      .filter((e) => e.row === row && e.col === col)
      .reduce((acc, e) => acc + e.value, 0);
  const diag00 = Math.abs(sumAt(0, 0));
  const diag11 = Math.abs(sumAt(1, 1));
  return Math.max(diag00, diag11);
}

const G_ON = 1 / TRIAC_DEFAULTS.rOn; // 100 S

// ---------------------------------------------------------------------------
// Triac unit tests
// ---------------------------------------------------------------------------

describe("Triac", () => {
  it("conducts_positive_when_triggered", () => {
    // Positive V_MT2-MT1 = 50V, gate forward-biased (0.65V above MT1)
    // Expected: forward path latches, high conductance
    const triac = makeTriac();

    // Gate at 0.65V above MT1 (forward-biased junction) → large α₂ → trigger
    const voltages = driveToOp(triac, 0, 50, 0.65, 200);

    const g = getMainPathConductance(triac, voltages);
    expect(g).toBeGreaterThan(1.0);      // confirms on-state (>> GMIN)
    expect(g).toBeCloseTo(G_ON, 0);      // ≈ 100 S
  });

  it("conducts_negative_when_triggered", () => {
    // Negative V_MT2-MT1 = -50V (reverse polarity), gate forward-biased
    // Expected: reverse path latches, high conductance in reverse direction
    const triac = makeTriac();

    // MT2 negative relative to MT1: V_MT2-MT1 = -50V
    // Gate at 0.65V above MT1 → triggers reverse path
    const voltages = driveToOp(triac, 50, 0, 50.65, 200); // MT1=50, MT2=0, G=50.65 → vg1=0.65V

    const g = getMainPathConductance(triac, voltages);
    expect(g).toBeGreaterThan(1.0);      // on-state in reverse direction
    expect(g).toBeCloseTo(G_ON, 0);      // ≈ 100 S
  });

  it("turns_off_at_zero_crossing", () => {
    // AC 60Hz source (peak 100V), 100Ω load, I_hold = 10mA.
    // Trigger triac at a positive phase, then simulate through zero-crossing.
    const triac = makeTriac({ iH: 10e-3 });

    // Step 1: trigger at positive peak (100V)
    const vOn = driveToOp(triac, 0, 100, 0.65, 200);

    // Verify it's latched
    const gBefore = getMainPathConductance(triac, vOn);
    expect(gBefore).toBeGreaterThan(1.0);

    // Step 2: reduce to near zero voltage (simulate zero-crossing)
    const vOff = driveToOp(triac, 0, 0.001, 0, 100);

    // Verify it unlatched (blocking state — very low conductance)
    const gAfter = getMainPathConductance(triac, vOff);
    expect(gAfter).toBeLessThan(0.1); // << 100 S, confirms blocking state
  });

  it("phase_control", () => {
    // Simulate phase-angle control: trigger at 90° of a 60Hz AC sine.
    const triac = makeTriac();

    // Before 90° — no gate, low voltage: blocking
    const vBefore90 = driveToOp(triac, 0, 0.5, 0, 100); // tiny voltage, no gate
    const gBefore90 = getMainPathConductance(triac, vBefore90);
    expect(gBefore90).toBeLessThan(0.1); // blocking

    // At 90° — apply gate trigger while at peak voltage
    const vAt90 = driveToOp(triac, 0, 100, 0.65, 200);
    const gAt90 = getMainPathConductance(triac, vAt90);
    expect(gAt90).toBeGreaterThan(1.0); // conducting

    // At 120° (V still positive, ~86.6V): still conducting (latched)
    const vAt120 = driveToOp(triac, 0, 86.6, 0, 50); // gate removed, still conducting
    const gAt120 = getMainPathConductance(triac, vAt120);
    expect(gAt120).toBeGreaterThan(1.0); // stays latched

    // At 180°+ (near zero crossing): unlatch
    const vAtZero = driveToOp(triac, 0, 0.001, 0, 100);
    const gAtZero = getMainPathConductance(triac, vAtZero);
    expect(gAtZero).toBeLessThan(0.1); // back to blocking after zero-crossing
  });

  it("no_writeback: load(ctx) does not modify voltages[]", () => {
    const props = new PropertyBag();
    props.replaceModelParams({ ...TRIAC_PARAM_DEFAULTS, ...TRIAC_DEFAULTS });
    const core = createTriacElement(new Map([["MT1", 1], ["MT2", 2], ["G", 3]]), [], -1, props);
    const { element } = withState(core);
    const withPins = withNodeIds(element, [1, 2, 3]);

    // Large voltage step that would trigger pnjlim limiting
    const voltages = new Float64Array([0, 50, 0.65]);
    const snapshot = new Float64Array(voltages);

    withPins.load(makeDcOpCtx(voltages));

    expect(voltages[0]).toBe(snapshot[0]);
    expect(voltages[1]).toBe(snapshot[1]);
    expect(voltages[2]).toBe(snapshot[2]);
  });

  it("pool_state: pool.state0 contains correct slot values after load", () => {
    const props = new PropertyBag();
    props.replaceModelParams({ ...TRIAC_PARAM_DEFAULTS, ...TRIAC_DEFAULTS });
    const core = createTriacElement(new Map([["MT1", 1], ["MT2", 2], ["G", 3]]), [], -1, props);
    const { element, pool } = withState(core);
    const withPins = withNodeIds(element, [1, 2, 3]);

    // Converge at positive polarity with gate to trigger forward latch
    // MT1=0, MT2=50, G=0.65 → vmt = 50, vg1 = 0.65
    const voltages = new Float64Array([0, 50, 0.65]);
    for (let i = 0; i < 200; i++) {
      withPins.load(makeDcOpCtx(voltages));
      voltages[0] = 0;
      voltages[1] = 50;
      voltages[2] = 0.65;
    }

    // SLOT_LATCHED = 6: should be 1.0 (forward latched)
    expect(pool.state0[SLOT_LATCHED]).toBe(1.0);

    // SLOT_VAK = 0: pnjlim-limited MT2-MT1 voltage, should be positive and finite
    const vmtInPool = pool.state0[SLOT_VAK];
    expect(Number.isFinite(vmtInPool)).toBe(true);
    expect(vmtInPool).toBeGreaterThan(0);

    // SLOT_GEQ = 2: in on-state ≈ 1/rOn
    const geqInPool = pool.state0[SLOT_GEQ];
    expect(geqInPool).toBeGreaterThan(1.0);
  });

  it("pool_state: SLOT_LATCHED is -1.0 for reverse-latched state", () => {
    const props = new PropertyBag();
    props.replaceModelParams({ ...TRIAC_PARAM_DEFAULTS, ...TRIAC_DEFAULTS });
    const core = createTriacElement(new Map([["MT1", 1], ["MT2", 2], ["G", 3]]), [], -1, props);
    const { element, pool } = withState(core);
    const withPins = withNodeIds(element, [1, 2, 3]);

    // MT1=50, MT2=0, G=50.65 → vmt = -50 (reverse), vg1 = 0.65 → trigger reverse
    const voltages = new Float64Array([50, 0, 50.65]);
    for (let i = 0; i < 200; i++) {
      withPins.load(makeDcOpCtx(voltages));
      voltages[0] = 50;
      voltages[1] = 0;
      voltages[2] = 50.65;
    }

    // SLOT_LATCHED should be -1.0 (reverse latched)
    expect(pool.state0[SLOT_LATCHED]).toBe(-1.0);
  });

  it("pool_state: SLOT_LATCHED is 0.0 in blocking state", () => {
    const props = new PropertyBag();
    props.replaceModelParams({ ...TRIAC_PARAM_DEFAULTS, ...TRIAC_DEFAULTS });
    const core = createTriacElement(new Map([["MT1", 1], ["MT2", 2], ["G", 3]]), [], -1, props);
    const { element, pool } = withState(core);
    const withPins = withNodeIds(element, [1, 2, 3]);

    // Small voltage, no gate → blocking
    const voltages = new Float64Array([0, 10, 0]);
    for (let i = 0; i < 50; i++) {
      withPins.load(makeDcOpCtx(voltages));
      voltages[0] = 0;
      voltages[1] = 10;
      voltages[2] = 0;
    }

    expect(pool.state0[SLOT_LATCHED]).toBe(0.0);
    expect(pool.state0[SLOT_GEQ]).toBeLessThan(1e-6);
  });

  it("definition_has_correct_fields", () => {
    expect(TriacDefinition.name).toBe("Triac");
    expect(TriacDefinition.modelRegistry?.["behavioral"]).toBeDefined();
    expect(TriacDefinition.modelRegistry?.["behavioral"]?.kind).toBe("inline");
    expect((TriacDefinition.modelRegistry?.["behavioral"] as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
    expect(TriacDefinition.category).toBe("SEMICONDUCTORS");
  });
});

describe("Triac LimitingEvent instrumentation", () => {
  function makeElement() {
    const params = { ...TRIAC_PARAM_DEFAULTS, vOn: 1.5, iH: 10e-3, rOn: 0.01, iS: 1e-12, alpha1: 0.5, alpha2_0: 0.3, i_ref: 1e-3, n: 1 };
    const props = createTestPropertyBag();
    props.replaceModelParams(params);
    const core = createTriacElement(new Map([["MT2", 1], ["MT1", 2], ["G", 3]]), [], -1, props);
    const { pool } = withState(core);
    const withPins = withNodeIds(core, [1, 2, 3]);
    (withPins as unknown as { elementIndex?: number; label?: string }).elementIndex = 7;
    (withPins as unknown as { elementIndex?: number; label?: string }).label = "T1";
    return { element: withPins, pool };
  }

  function makeCtxWithCollector(
    voltages: Float64Array,
    collector: import("../../../solver/analog/newton-raphson.js").LimitingEvent[] | null,
  ): LoadContext {
    const ctx = makeDcOpCtx(voltages);
    return { ...ctx, limitingCollector: collector };
  }

  it("pushes MT2-MT1 and G-MT1 events on each load call", () => {
    const { element } = makeElement();
    const collector: import("../../../solver/analog/newton-raphson.js").LimitingEvent[] = [];
    const voltages = new Float64Array([0, 5, 1]);
    element.load(makeCtxWithCollector(voltages, collector));
    const junctions = collector.map((e) => e.junction);
    expect(junctions).toContain("MT2-MT1");
    expect(junctions).toContain("G-MT1");
  });

  it("events carry correct elementIndex and label", () => {
    const { element } = makeElement();
    const collector: import("../../../solver/analog/newton-raphson.js").LimitingEvent[] = [];
    const voltages = new Float64Array([0, 5, 1]);
    element.load(makeCtxWithCollector(voltages, collector));
    for (const ev of collector) {
      expect(ev.elementIndex).toBe(7);
      expect(ev.label).toBe("T1");
      expect(ev.limitType).toBe("pnjlim");
    }
  });

  it("does not push events when limitingCollector is null", () => {
    const { element } = makeElement();
    const voltages = new Float64Array([0, 5, 1]);
    expect(() => element.load(makeCtxWithCollector(voltages, null))).not.toThrow();
  });
});
