/**
 * Tests for the Diac (bidirectional trigger diode) component.
 *
 * Covers:
 *   - blocks_below_breakover: |V| < V_BO → I ≈ V/R_off (µA range)
 *   - conducts_above_breakover: |V| >> V_BO → significant current flow
 *   - symmetric: same |V|, opposite polarity → |I| approximately equal
 *   - triggers_triac: diac + triac integration test
 */

import { describe, it, expect } from "vitest";
import { createDiacElement, DiacDefinition, DIAC_PARAM_DEFAULTS } from "../diac.js";
import { createTriacElement, TRIAC_PARAM_DEFAULTS } from "../triac.js";
import { PropertyBag as _PropertyBag } from "../../../core/properties.js";
import { createTestPropertyBag } from "../../../test-fixtures/model-fixtures.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import { withNodeIds, allocateStatePool, makeSimpleCtx } from "../../../solver/analog/__tests__/test-helpers.js";
import type { AnalogFactory } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Capture solver — records stamp tuples via the real allocElement/stampElement
// API so tests can read back what load() wrote.
// ---------------------------------------------------------------------------

interface CaptureStamp { row: number; col: number; value: number; }
interface CaptureRhs { row: number; value: number; }

function makeCaptureSolver(): {
  solver: SparseSolverType;
  stamps: CaptureStamp[];
  rhs: CaptureRhs[];
} {
  const stamps: CaptureStamp[] = [];
  const rhs: CaptureRhs[] = [];
  const handles: { row: number; col: number }[] = [];
  const handleIndex = new Map<string, number>();
  const solver = {
    stampRHS: (row: number, value: number) => {
      rhs.push({ row, value });
    },
    allocElement: (row: number, col: number): number => {
      const key = `${row},${col}`;
      let h = handleIndex.get(key);
      if (h === undefined) {
        h = handles.length;
        handles.push({ row, col });
        handleIndex.set(key, h);
      }
      return h;
    },
    stampElement: (handle: number, value: number) => {
      const { row, col } = handles[handle];
      stamps.push({ row, col, value });
    },
  } as unknown as SparseSolverType;
  return { solver, stamps, rhs };
}

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Default Diac parameters (matching spec defaults)
// ---------------------------------------------------------------------------

const DIAC_DEFAULTS = {
  vBreakover: 32,
  vHold: 28,
  rOn: 10,
  rOff: 1e7,
  iH: 1e-3,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiac(overrides: Partial<typeof DIAC_DEFAULTS> = {}): AnalogElement {
  const params = { ...DIAC_PARAM_DEFAULTS, ...DIAC_DEFAULTS, ...overrides };
  const props = createTestPropertyBag();
  props.replaceModelParams(params);
  // nodeA=1, nodeB=2
  return withNodeIds(createDiacElement(new Map([["A", 1], ["B", 2]]), [], -1, props), [1, 2]);
}

/**
 * Drive diac to a steady operating point by calling load() repeatedly with
 * a ctx whose voltages are pinned to (vA, vB). Each load() iteration reads
 * the current voltages, recomputes the linearization, and stamps; after
 * enough iterations the internal linearization is steady.
 *
 * nodeA=1 (index 0), nodeB=2 (index 1)
 */
function driveToOp(element: AnalogElement, vA: number, vB: number, iterations = 50): Float64Array {
  const voltages = new Float64Array(2);
  voltages[0] = vA;
  voltages[1] = vB;
  for (let i = 0; i < iterations; i++) {
    const { solver } = makeCaptureSolver();
    const ctx = makeSimpleCtx({
      solver,
      elements: [element],
      matrixSize: 2,
      nodeCount: 2,
    });
    // ctx.voltages is the rhsOld buffer; overwrite it so the diac sees (vA, vB).
    ctx.loadCtx.voltages[0] = vA;
    ctx.loadCtx.voltages[1] = vB;
    element.load(ctx.loadCtx);
    voltages[0] = vA;
    voltages[1] = vB;
  }
  return voltages;
}

/**
 * Compute steady-state current I(V) through diac at given voltage by evaluating
 * the Norton equivalent: I = geq * V + ieq.
 * Returns the current from terminal A to terminal B.
 */
function getCurrentAtV(element: AnalogElement, v: number): number {
  driveToOp(element, v, 0, 50);

  const { solver, stamps, rhs } = makeCaptureSolver();
  const ctx = makeSimpleCtx({
    solver,
    elements: [element],
    matrixSize: 2,
    nodeCount: 2,
  });
  ctx.loadCtx.voltages[0] = v;
  ctx.loadCtx.voltages[1] = 0;
  element.load(ctx.loadCtx);

  // geq is the (0,0) diagonal entry, ieq = RHS[0] (negated)
  const geqEntry = stamps.find((s) => s.row === 0 && s.col === 0);
  const ieqEntry = rhs.find((r) => r.row === 0);

  if (!geqEntry || !ieqEntry) return 0;

  const geq = geqEntry.value;
  const ieq = -ieqEntry.value; // stampRHS stamps -ieq at row 0
  return geq * v + ieq;
}

// ---------------------------------------------------------------------------
// Diac unit tests
// ---------------------------------------------------------------------------

describe("Diac", () => {
  it("blocks_below_breakover", () => {
    // |V| = 20V < V_BO = 32V → blocking state → I ≈ V/R_off
    // Expected: |I| ≈ 20 / 1e7 = 2µA (µA range)
    const diac = makeDiac();

    const iPosV = getCurrentAtV(diac, 20);
    expect(Math.abs(iPosV)).toBeLessThan(1e-3); // less than 1mA confirms blocking

    // Also check that |I| ≈ V/R_off
    const expected = 20 / DIAC_DEFAULTS.rOff;
    expect(Math.abs(iPosV)).toBeCloseTo(expected, 5);
  });

  it("conducts_above_breakover", () => {
    // |V| = 40V > V_BO = 32V → conducting state → significant current
    // In on-state: I ≈ (40 - V_hold) / R_on = (40 - 28) / 10 = 1.2A
    const diac = makeDiac();

    const iV = getCurrentAtV(diac, 40);
    // Significant current >> blocking
    expect(Math.abs(iV)).toBeGreaterThan(0.1); // well above µA leakage

    // Current should be in the direction of voltage (positive V → positive I)
    expect(iV).toBeGreaterThan(0);
  });

  it("symmetric", () => {
    // Same |V| positive and negative → |I| approximately equal (symmetric device)
    const posV = 40;
    const negV = -40;

    const diacPos = makeDiac();
    const diacNeg = makeDiac();

    const iPos = getCurrentAtV(diacPos, posV);
    const iNeg = getCurrentAtV(diacNeg, negV);

    // Both currents should have same magnitude within 5%
    expect(Math.abs(iPos)).toBeGreaterThan(0.01); // conducting
    expect(Math.abs(iNeg)).toBeGreaterThan(0.01); // conducting in reverse

    const ratio = Math.abs(iPos) / Math.abs(iNeg);
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);

    // Signs are opposite (current flows opposite ways)
    expect(iPos).toBeGreaterThan(0);
    expect(iNeg).toBeLessThan(0);
  });

  it("triggers_triac", () => {
    // Integration test: diac + triac circuit.
    // At V_supply > V_BO, diac conducts and delivers gate current to triac.
    // The triac should then latch.
    //
    // Topology (direct NR iteration simulation):
    //   Voltage source at MT2=120V (via resistor), MT1=gnd, Gate via diac
    //   When V_gate > V_BO = 32V: diac conducts → gate current → triac triggers.
    //
    // Simplified unit test: verify diac produces gate current > triac I_GT
    // when driven by V_BO voltage, then manually check triac triggers.

    const triacProps = createTestPropertyBag();
    triacProps.replaceModelParams({ ...TRIAC_PARAM_DEFAULTS, vOn: 1.5, iH: 10e-3, rOn: 0.01, iS: 1e-12, alpha1: 0.5, alpha2_0: 0.3, i_ref: 1e-3, n: 1 });
    const triac = createTriacElement(
      new Map([["MT1", 1], ["MT2", 2], ["G", 3]]),
      [],
      -1,
      triacProps,
    );
    allocateStatePool([triac]);

    // Step 1: verify diac at V=40V (above V_BO=32V) produces current that can trigger triac
    const diac = makeDiac();
    const iDiac = getCurrentAtV(diac, 40);
    // I_GT for triac ≈ 200µA; diac at V=40V should produce >> 200µA
    expect(iDiac).toBeGreaterThan(200e-6); // diac produces trigger current

    // Step 2: with that gate current level (simulated by 0.65V gate bias which
    // corresponds to a forward-biased gate junction), triac should trigger.
    // The triac element has three pins MT1=1, MT2=2, G=3; matrixSize=3.
    // Share the StatePool and solver across iterations so the triac's latch
    // state persists (pool-backed state0 slots, local closure state in load()).
    const triacEl = withNodeIds(triac, [1, 2, 3]);
    const { solver: drivingSolver } = makeCaptureSolver();
    const drivingCtx = makeSimpleCtx({
      solver: drivingSolver,
      elements: [triacEl],
      matrixSize: 3,
      nodeCount: 3,
    });
    for (let i = 0; i < 200; i++) {
      drivingCtx.loadCtx.voltages[0] = 0;    // MT1
      drivingCtx.loadCtx.voltages[1] = 100;  // MT2 (100V positive)
      drivingCtx.loadCtx.voltages[2] = 0.65; // Gate (forward-biased, simulating diac delivery)
      triacEl.load(drivingCtx.loadCtx);
    }

    // Verify triac is now conducting (high conductance) via a fresh capture.
    const { solver: readoutSolver, stamps } = makeCaptureSolver();
    drivingCtx.loadCtx.solver = readoutSolver;
    drivingCtx.loadCtx.voltages[0] = 0;
    drivingCtx.loadCtx.voltages[1] = 100;
    drivingCtx.loadCtx.voltages[2] = 0.65;
    triacEl.load(drivingCtx.loadCtx);

    const diagMT = stamps.filter((s) => s.row === s.col && s.row < 2);
    const maxG = Math.max(...diagMT.map((s) => Math.abs(s.value)));
    expect(maxG).toBeGreaterThan(1.0); // triac in on-state — diac triggered it
  });

  it("definition_has_correct_fields", () => {
    expect(DiacDefinition.name).toBe("Diac");
    expect(DiacDefinition.modelRegistry?.["behavioral"]).toBeDefined();
    expect(DiacDefinition.modelRegistry?.["behavioral"]?.kind).toBe("inline");
    expect((DiacDefinition.modelRegistry?.["behavioral"] as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
    expect(DiacDefinition.category).toBe("SEMICONDUCTORS");
  });
});
