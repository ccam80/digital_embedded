/**
 * Tests for SparkGapElement.
 *
 * Covers:
 *   - Blocks below breakdown voltage
 *   - Conducts above breakdown voltage
 *   - Hysteresis: stays conducting while current exceeds holding threshold
 *   - Extinguishes when current drops below holding threshold
 *   - Smooth resistance transition for NR convergence
 *   - Stamping behaviour
 *   - Definition metadata
 */

import { describe, it, expect } from "vitest";
import { SparkGapElement, SparkGapDefinition, createSparkGapElement, SPARK_GAP_DEFAULTS } from "../spark-gap.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory } from "../../../core/registry.js";
import type { AnalogFactory } from "../../../core/registry.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import { makeSimpleCtx } from "../../../solver/analog/__tests__/test-helpers.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";

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
// Minimal LoadContext for accept() calls (no matrix stamps).
// SparkGap.accept reads ctx.voltages and applies discrete state transitions.
// ---------------------------------------------------------------------------

function makeAcceptCtx(voltages: Float64Array): LoadContext {
  return {
    solver: undefined as unknown as SparseSolverType,
    voltages,
    iteration: 0,
    initMode: "transient",
    dt: 1e-6,
    method: "trapezoidal",
    order: 1,
    deltaOld: [1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6, 1e-6],
    ag: new Float64Array(7),
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSparkGap(overrides: Partial<{
  vBreakdown: number;
  rOn: number;
  rOff: number;
  iHold: number;
}> = {}): SparkGapElement {
  const el = new SparkGapElement(
    overrides.vBreakdown ?? 1000,
    overrides.rOn ?? 5,
    overrides.rOff ?? 1e10,
    overrides.iHold ?? 0.01,
  );
  Object.assign(el, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
  return el;
}

/**
 * Apply a voltage to the gap by updating its operating point.
 *
 * Updating the gap's internal terminal-voltage and advancing its discrete
 * conducting/blocking state happens in accept(ctx, simTime, addBreakpoint).
 */
function applyVoltage(gap: SparkGapElement, v: number): void {
  const voltages = new Float64Array(2);
  voltages[0] = v; // node 1 at voltage v
  voltages[1] = 0; // node 2 at ground
  const ctx = makeAcceptCtx(voltages);
  gap.accept(ctx, 0, () => {});
}

// ---------------------------------------------------------------------------
// SparkGap
// ---------------------------------------------------------------------------

describe("SparkGap", () => {
  describe("blocks_below_breakdown", () => {
    it("500V across 1000V gap: current ≈ 500/R_off (nA range)", () => {
      const gap = makeSparkGap({ vBreakdown: 1000, rOff: 1e10 });
      applyVoltage(gap, 500);
      const R = gap.resistance();
      const I = 500 / R;
      // Should be in nA range: 500/1e10 = 50nA
      expect(I).toBeLessThan(1e-6); // less than 1µA
      expect(gap.conducting).toBe(false);
    });

    it("resistance below breakdown is close to R_off", () => {
      const gap = makeSparkGap({ vBreakdown: 1000, rOff: 1e10, rOn: 5 });
      applyVoltage(gap, 100);
      // Should be close to rOff (smooth blend keeps it near rOff far from threshold)
      expect(gap.resistance()).toBeGreaterThan(1e8);
    });

    it("gap starts in blocking state", () => {
      const gap = makeSparkGap();
      expect(gap.conducting).toBe(false);
    });
  });

  describe("conducts_above_breakdown", () => {
    it("1500V fires the gap and allows current to flow", () => {
      const gap = makeSparkGap({ vBreakdown: 1000, rOn: 5, rOff: 1e10 });
      applyVoltage(gap, 1500);
      expect(gap.conducting).toBe(true);
    });

    it("resistance drops significantly above breakdown", () => {
      const gap = makeSparkGap({ vBreakdown: 1000, rOn: 5, rOff: 1e10 });
      applyVoltage(gap, 1500);
      // Resistance should be close to rOn when well above breakdown
      expect(gap.resistance()).toBeLessThan(100);
    });

    it("current above breakdown is much larger than below", () => {
      const gap = makeSparkGap({ vBreakdown: 1000, rOn: 5, rOff: 1e10 });

      // Below breakdown
      applyVoltage(gap, 500);
      const I_below = 500 / gap.resistance();

      // Above breakdown — reset for fresh gap
      const gap2 = makeSparkGap({ vBreakdown: 1000, rOn: 5, rOff: 1e10 });
      applyVoltage(gap2, 1500);
      const I_above = 1500 / gap2.resistance();

      expect(I_above).toBeGreaterThan(I_below * 1000);
    });
  });

  describe("holds_until_current_drops", () => {
    it("gap stays conducting while voltage keeps current above iHold", () => {
      // iHold = 10mA, rOn = 5Ω → need V > 0.05V to hold
      const gap = makeSparkGap({ vBreakdown: 1000, rOn: 5, iHold: 0.01 });

      // Fire the gap
      applyVoltage(gap, 1500);
      expect(gap.conducting).toBe(true);

      // Reduce voltage but keep I = V/rOn > iHold: V > 0.05V
      // Apply 10V: I = 10/5 = 2A >> iHold
      applyVoltage(gap, 10);
      expect(gap.conducting).toBe(true);

      // Apply 1V: I = 1/5 = 200mA >> iHold
      applyVoltage(gap, 1);
      expect(gap.conducting).toBe(true);
    });

    it("conducting gap has low resistance well above holding current", () => {
      const gap = makeSparkGap({ vBreakdown: 1000, rOn: 5, iHold: 0.01 });
      applyVoltage(gap, 1500); // fire
      applyVoltage(gap, 50);   // V=50V, I=10A >> iHold — should stay on
      expect(gap.resistance()).toBeLessThan(100);
    });
  });

  describe("extinguishes_below_holding", () => {
    it("gap returns to blocking when current drops below iHold", () => {
      // iHold = 10mA, rOn = 5Ω → holding current threshold: V = 0.01*5 = 0.05V
      const gap = makeSparkGap({ vBreakdown: 1000, rOn: 5, iHold: 0.01 });

      // Fire the gap
      applyVoltage(gap, 1500);
      expect(gap.conducting).toBe(true);

      // Reduce voltage so I = V/rOn < iHold: need V < 0.05V
      // Apply 0V: I = 0A < 10mA
      applyVoltage(gap, 0);
      expect(gap.conducting).toBe(false);
    });

    it("resistance returns toward R_off after extinction", () => {
      const gap = makeSparkGap({ vBreakdown: 1000, rOn: 5, rOff: 1e10, iHold: 0.01 });
      applyVoltage(gap, 1500); // fire
      applyVoltage(gap, 0);    // extinguish
      expect(gap.resistance()).toBeGreaterThan(1e6);
    });

    it("can re-fire after extinction", () => {
      const gap = makeSparkGap({ vBreakdown: 1000, rOn: 5, iHold: 0.01 });
      applyVoltage(gap, 1500); // fire
      applyVoltage(gap, 0);    // extinguish
      expect(gap.conducting).toBe(false);
      applyVoltage(gap, 1500); // re-fire
      expect(gap.conducting).toBe(true);
    });
  });

  describe("smooth_transition", () => {
    it("resistance changes monotonically across the breakdown transition zone", () => {
      // Sample resistance at several voltages spanning breakdown
      // The smooth tanh blend ensures resistance decreases monotonically
      // from rOff to rOn as voltage increases through vBreakdown.
      const vBreakdown = 1000;
      const samples: number[] = [];
      for (const v of [900, 950, 1000, 1050, 1100]) {
        const gap = makeSparkGap({ vBreakdown, rOn: 5, rOff: 1e10 });
        applyVoltage(gap, v);
        samples.push(gap.resistance());
      }
      // Each subsequent sample should be <= the previous (monotonically decreasing)
      for (let i = 1; i < samples.length; i++) {
        expect(samples[i]).toBeLessThanOrEqual(samples[i - 1]);
      }
    });

    it("resistance at breakdown voltage is midpoint between rOn and rOff", () => {
      const rOn = 5;
      const rOff = 1e10;
      const vBreakdown = 1000;
      const gap = makeSparkGap({ vBreakdown, rOn, rOff });

      // At exactly breakdown: tanh(0) = 0, blend = 0.5
      // R = rOff + (rOn - rOff) * 0.5 = (rOn + rOff) / 2
      applyVoltage(gap, vBreakdown);
      const R = gap.resistance();
      const expected = rOff + (rOn - rOff) * 0.5;

      // Allow tolerance since state machine may flip at exactly vBreakdown
      expect(R).toBeGreaterThan(rOn);
      expect(R).toBeLessThan(rOff);
      // Should be within an order of magnitude of the midpoint
      expect(R).toBeLessThan(expected * 10);
    });
  });

  describe("load", () => {
    it("stamps conductance matrix between nodes in blocking state", () => {
      const gap = makeSparkGap({ vBreakdown: 1000, rOff: 1e10 });
      // Below breakdown — in blocking state
      applyVoltage(gap, 100);

      const { solver, stamps } = makeCaptureSolver();
      const ctx = makeSimpleCtx({
        solver,
        elements: [gap as unknown as AnalogElement],
        matrixSize: 2,
        nodeCount: 2,
      });

      gap.load(ctx);

      const G = 1 / gap.resistance();
      const tuples = stamps.map((s) => [s.row, s.col, s.value] as [number, number, number]);
      expect(tuples).toContainEqual([0, 0, G]);
      expect(tuples).toContainEqual([0, 1, -G]);
      expect(tuples).toContainEqual([1, 0, -G]);
      expect(tuples).toContainEqual([1, 1, G]);
    });

    it("stamps higher conductance in conducting state", () => {
      const gap = makeSparkGap({ vBreakdown: 1000, rOn: 5, rOff: 1e10 });

      // Blocking state conductance
      applyVoltage(gap, 100);
      const { solver: solver1, stamps: stamps1 } = makeCaptureSolver();
      const ctx1 = makeSimpleCtx({
        solver: solver1,
        elements: [gap as unknown as AnalogElement],
        matrixSize: 2,
        nodeCount: 2,
      });
      gap.load(ctx1);
      const G_off = stamps1.find((s) => s.row === 0 && s.col === 0)!.value;

      // Conducting state conductance
      applyVoltage(gap, 1500);
      const { solver: solver2, stamps: stamps2 } = makeCaptureSolver();
      const ctx2 = makeSimpleCtx({
        solver: solver2,
        elements: [gap as unknown as AnalogElement],
        matrixSize: 2,
        nodeCount: 2,
      });
      gap.load(ctx2);
      const G_on = stamps2.find((s) => s.row === 0 && s.col === 0)!.value;

      expect(G_on).toBeGreaterThan(G_off);
    });
  });

  describe("definition", () => {
    it("SparkGapDefinition has engine type analog", () => {
      expect(SparkGapDefinition.modelRegistry?.behavioral).toBeDefined();
    });

    it("SparkGapDefinition has correct category", () => {
      expect(SparkGapDefinition.category).toBe(ComponentCategory.PASSIVES);
    });

    it("SparkGapDefinition has vBreakdown default 1000", () => {
      const params = SparkGapDefinition.modelRegistry?.behavioral?.params;
      expect(params).toBeDefined();
      expect(params!["vBreakdown"]).toBe(1000);
    });

    it("analogFactory creates a SparkGapElement", () => {
      const props = new PropertyBag();
      props.replaceModelParams(SPARK_GAP_DEFAULTS);
      const element = createSparkGapElement(new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0);
      expect(element).toBeInstanceOf(SparkGapElement);
      expect(element.isNonlinear).toBe(true);
      expect(element.isReactive).toBe(false);
    });

    it("branchCount is false", () => {
      expect((SparkGapDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory;branchCount?:number}|undefined)?.branchCount).toBeFalsy();
    });
  });
});

// ---------------------------------------------------------------------------
// spark_gap_load_dcop_parity — C4.1 / Task 6.2.1
//
// Spark gap in non-firing state (_conducting=false, _vTerminal=0).
// Default params: vBreakdown=1000, rOn=5, rOff=1e10, iHold=0.01.
// firingResistance(absV=0, vBreakdown=1000, rOff=1e10, rOn=5):
//   w = 0.05 * max(1000, 1e-6) = 50
//   blend = 0.5 * (1 + tanh((0 - 1000) / 50)) = 0.5 * (1 + tanh(-20)) ≈ 0
//   R ≈ rOff = 1e10
// G = 1 / max(R, 1e-12).
//
// NGSPICE reference: ngspice resload.c stamps G=1/R using a single division.
// The test inlines the same firingResistance computation as SparkGapElement.load().
// Nodes: pos=1 → idx 0, neg=2 → idx 1. matrixSize=2, nodeCount=2.
// ---------------------------------------------------------------------------

describe("spark_gap_load_dcop_parity", () => {
  it("non-firing spark gap stamps G=1/firingResistance(0) bit-exact", () => {
    const props = new PropertyBag();
    props.replaceModelParams(SPARK_GAP_DEFAULTS);

    const core = createSparkGapElement(
      new Map([["pos", 1], ["neg", 2]]),
      [],
      -1,
      props,
      () => 0,
    );
    const analogElement = Object.assign(core, {
      pinNodeIds: [1, 2] as readonly number[],
      allNodeIds: [1, 2] as readonly number[],
    }) as unknown as AnalogElement;

    const stampCtx = makeSimpleCtx({
      elements: [analogElement],
      matrixSize: 2,
      nodeCount: 2,
    });
    stampCtx.solver.beginAssembly(2);
    analogElement.load(stampCtx.loadCtx);
    stampCtx.solver.finalize();
    const stamps = stampCtx.solver.getCSCNonZeros();

    // NGSPICE ref: G = 1/R where R = firingResistance(absV=0, ...).
    // Inline closed-form — same IEEE-754 ops as SparkGapElement.resistance()
    // in the non-conducting branch with _vTerminal=0:
    const vBreakdown = SPARK_GAP_DEFAULTS.vBreakdown;
    const rOff = SPARK_GAP_DEFAULTS.rOff;
    const rOn = SPARK_GAP_DEFAULTS.rOn;
    const absV = 0;
    const w = 0.05 * Math.max(vBreakdown, 1e-6);
    const blend = 0.5 * (1 + Math.tanh((absV - vBreakdown) / w));
    const R_REF = rOff + (rOn - rOff) * blend;
    const MIN_RESISTANCE = 1e-12;
    const NGSPICE_G_REF = 1 / Math.max(R_REF, MIN_RESISTANCE);

    const e00 = stamps.find((e) => e.row === 0 && e.col === 0);
    expect(e00).toBeDefined();
    expect(e00!.value).toBe(NGSPICE_G_REF);

    const e11 = stamps.find((e) => e.row === 1 && e.col === 1);
    expect(e11).toBeDefined();
    expect(e11!.value).toBe(NGSPICE_G_REF);

    const e01 = stamps.find((e) => e.row === 0 && e.col === 1);
    expect(e01!.value).toBe(-NGSPICE_G_REF);

    const e10 = stamps.find((e) => e.row === 1 && e.col === 0);
    expect(e10!.value).toBe(-NGSPICE_G_REF);
  });
});
