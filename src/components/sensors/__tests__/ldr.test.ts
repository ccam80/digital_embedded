/**
 * Tests for LDRElement (Light Dependent Resistor).
 *
 * Covers:
 *   - Dark resistance at lux=0
 *   - Bright resistance at reference lux
 *   - Power-law formula accuracy
 *   - Slider-adjustable lux changes resistance
 *   - Stamping behaviour
 *   - Definition metadata
 */

import { describe, it, expect } from "vitest";
import { LDRElement, LDRDefinition, createLDRElement, LDR_DEFAULTS } from "../ldr.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory } from "../../../core/registry.js";
import type { AnalogFactory } from "../../../core/registry.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import { makeSimpleCtx } from "../../../solver/analog/__tests__/test-helpers.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Capture solver — records stamp tuples via the real allocElement/stampElement
// API so tests can read back what load() wrote. Used where tests assert on
// the exact matrix entries produced by a single load(ctx) call.
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
// Helpers
// ---------------------------------------------------------------------------

function makeLDR(overrides: Partial<{
  rDark: number;
  luxRef: number;
  gamma: number;
  lux: number;
}> = {}): LDRElement {
  const el = new LDRElement(
    overrides.rDark ?? 1e6,
    overrides.luxRef ?? 1000,
    overrides.gamma ?? 0.7,
    overrides.lux ?? 500,
  );
  Object.assign(el, { pinNodeIds: [1, 2], allNodeIds: [1, 2] });
  return el;
}

// ---------------------------------------------------------------------------
// LDR
// ---------------------------------------------------------------------------

describe("LDR", () => {
  describe("dark_resistance", () => {
    it("lux=0 returns R_dark (not power-law formula)", () => {
      const ldr = makeLDR({ rDark: 1e6, lux: 0 });
      expect(ldr.resistance()).toBeCloseTo(1e6, 0);
    });

    it("lux=0 with custom rDark returns that value", () => {
      const ldr = makeLDR({ rDark: 500000, lux: 0 });
      expect(ldr.resistance()).toBeCloseTo(500000, 0);
    });
  });

  describe("bright_resistance", () => {
    it("lux equals luxRef returns rDark (power-law exponent is 1)", () => {
      // At lux = luxRef: R = rDark * (luxRef/luxRef)^(-γ) = rDark * 1 = rDark
      const rDark = 100; // set rDark to the expected "light" resistance
      const luxRef = 1000;
      const ldr = makeLDR({ rDark, luxRef, gamma: 0.7, lux: luxRef });
      // R ≈ rDark (which equals rLight at reference illumination)
      expect(ldr.resistance()).toBeCloseTo(rDark, 1);
    });

    it("resistance at reference lux matches expected light resistance", () => {
      // Use rDark=100 as the calibrated light resistance at luxRef=1000
      const rLight = 100;
      const luxRef = 1000;
      const ldr = makeLDR({ rDark: rLight, luxRef, gamma: 0.7, lux: luxRef });
      expect(ldr.resistance()).toBeCloseTo(rLight, 1);
    });
  });

  describe("power_law_correct", () => {
    it("lux=100 with luxRef=1000, gamma=0.7 matches formula R_dark*(100/lux_ref)^(-gamma)", () => {
      const rDark = 1e6;
      const luxRef = 1000;
      const gamma = 0.7;
      const lux = 100;
      const expected = rDark * Math.pow(lux / luxRef, -gamma);
      const ldr = makeLDR({ rDark, luxRef, gamma, lux });
      expect(ldr.resistance()).toBeCloseTo(expected, 0);
    });

    it("lower lux gives higher resistance than at reference", () => {
      const ldr100 = makeLDR({ rDark: 1e6, luxRef: 1000, gamma: 0.7, lux: 100 });
      const ldr1000 = makeLDR({ rDark: 1e6, luxRef: 1000, gamma: 0.7, lux: 1000 });
      expect(ldr100.resistance()).toBeGreaterThan(ldr1000.resistance());
    });

    it("higher lux gives lower resistance than at reference", () => {
      const ldr5000 = makeLDR({ rDark: 1e6, luxRef: 1000, gamma: 0.7, lux: 5000 });
      const ldr1000 = makeLDR({ rDark: 1e6, luxRef: 1000, gamma: 0.7, lux: 1000 });
      expect(ldr5000.resistance()).toBeLessThan(ldr1000.resistance());
    });
  });

  describe("slider_changes_resistance", () => {
    it("changing lux via setLux changes resistance", () => {
      const ldr = makeLDR({ rDark: 1e6, luxRef: 1000, gamma: 0.7, lux: 100 });
      const rBefore = ldr.resistance();

      ldr.setLux(5000);
      const rAfter = ldr.resistance();

      expect(rAfter).toBeLessThan(rBefore);
    });

    it("conductance is consistent with new resistance after lux change", () => {
      const ldr = makeLDR({ rDark: 1e6, luxRef: 1000, gamma: 0.7, lux: 500 });

      ldr.setLux(2000);
      const R = ldr.resistance();
      const expectedG = 1 / R;

      const { solver, stamps } = makeCaptureSolver();
      const ctx = makeSimpleCtx({
        solver,
        elements: [ldr as unknown as AnalogElement],
        matrixSize: 2,
        nodeCount: 2,
      });
      ldr.load(ctx);

      // Check that diagonal conductance matches expected
      const diagStamp = stamps.find((s) => s.row === 0 && s.col === 0);
      expect(diagStamp).toBeDefined();
      expect(diagStamp!.value).toBeCloseTo(expectedG, 10);
    });
  });

  describe("load", () => {
    it("stamps conductance between the two nodes", () => {
      const ldr = makeLDR({ rDark: 1e6, luxRef: 1000, gamma: 0.7, lux: 1000 });
      const { solver, stamps } = makeCaptureSolver();
      const ctx = makeSimpleCtx({
        solver,
        elements: [ldr as unknown as AnalogElement],
        matrixSize: 2,
        nodeCount: 2,
      });

      ldr.load(ctx);

      const G = 1 / ldr.resistance();
      const tuples = stamps.map((s) => [s.row, s.col, s.value] as [number, number, number]);
      expect(tuples).toContainEqual([0, 0, G]);
      expect(tuples).toContainEqual([0, 1, -G]);
      expect(tuples).toContainEqual([1, 0, -G]);
      expect(tuples).toContainEqual([1, 1, G]);
    });

    it("lux=0 stamps dark conductance", () => {
      const rDark = 1e6;
      const ldr = makeLDR({ rDark, lux: 0 });
      const { solver, stamps } = makeCaptureSolver();
      const ctx = makeSimpleCtx({
        solver,
        elements: [ldr as unknown as AnalogElement],
        matrixSize: 2,
        nodeCount: 2,
      });

      ldr.load(ctx);

      const G = 1 / rDark;
      const tuples = stamps.map((s) => [s.row, s.col, s.value] as [number, number, number]);
      expect(tuples).toContainEqual([0, 0, G]);
    });
  });

  describe("definition", () => {
    it("LDRDefinition has engine type analog", () => {
      expect(LDRDefinition.modelRegistry?.behavioral).toBeDefined();
    });

    it("LDRDefinition has correct category", () => {
      expect(LDRDefinition.category).toBe(ComponentCategory.PASSIVES);
    });

    it("LDRDefinition has rDark default 1e6", () => {
      const params = LDRDefinition.modelRegistry?.behavioral?.params;
      expect(params).toBeDefined();
      expect(params!["rDark"]).toBe(1e6);
    });

    it("analogFactory creates an LDRElement", () => {
      const props = new PropertyBag();
      props.replaceModelParams(LDR_DEFAULTS);
      const element = createLDRElement(new Map([["pos", 1], ["neg", 2]]), [], -1, props, () => 0);
      expect(element).toBeInstanceOf(LDRElement);
      expect(element.isNonlinear).toBe(true);
      expect(element.isReactive).toBe(false);
    });

    it("branchCount is false", () => {
      expect((LDRDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory;branchCount?:number}|undefined)?.branchCount).toBeFalsy();
    });
  });
});

// ---------------------------------------------------------------------------
// ldr_load_dcop_parity — C4.1 / Task 6.2.1
//
// LDR at 1000 lux. Default params: rDark=1e6, luxRef=100, gamma=0.7, lux=1000.
// R(1000lux) = rDark * (lux / luxRef)^(-gamma) = 1e6 * (1000/100)^(-0.7)
//            = 1e6 * 10^(-0.7)
// G = 1 / R(1000lux).
//
// NGSPICE reference: ngspice resload.c stamps G=1/R using a single division.
// This test constructs the element via its factory with lux=1000 and asserts
// the diagonal stamp equals the closed-form G bit-exact.
// Nodes: pos=1 → idx 0, neg=2 → idx 1. matrixSize=2, nodeCount=2.
// ---------------------------------------------------------------------------

describe("ldr_load_dcop_parity", () => {
  it("LDR at 1000lux G=1/(rDark*(lux/luxRef)^(-gamma)) bit-exact", () => {
    const props = new PropertyBag();
    props.replaceModelParams(LDR_DEFAULTS);
    props.setModelParam("lux", 1000);

    const core = createLDRElement(
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

    // NGSPICE ref: G = 1/R where R = rDark * (lux/luxRef)^(-gamma).
    // Inline closed-form — same IEEE-754 operations as LDRElement.resistance():
    const rDark = LDR_DEFAULTS.rDark;
    const luxRef = LDR_DEFAULTS.luxRef;
    const gamma = LDR_DEFAULTS.gamma;
    const lux = 1000;
    const R_REF = rDark * Math.pow(lux / luxRef, -gamma);
    const NGSPICE_G_REF = 1 / R_REF;

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
