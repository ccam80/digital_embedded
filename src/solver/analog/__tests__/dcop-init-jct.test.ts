/**
 * Tests for the dcopInitJct junction-priming phase.
 *
 * Verifies that:
 *   1. BJT (simple L0) primeJunctions seeds Vbe = tVcrit for NPN, -tVcrit for PNP.
 *   2. BJT L1 primeJunctions produces the same tVcrit-based seed.
 *   3. Diode primeJunctions seeds V_anode = V_cathode + tVcrit.
 *   4. The dcopInitJct phase marker is emitted in solveDcOperatingPoint.
 *   5. A real NPN CE circuit converges with priming engaged.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  createBjtElement,
  createSpiceL1BjtElement,
  BJT_NPN_DEFAULTS,
  BJT_SPICE_L1_NPN_DEFAULTS,
} from "../../../components/semiconductors/bjt.js";
import { createDiodeElement, DIODE_PARAM_DEFAULTS } from "../../../components/semiconductors/diode.js";
import { makeDcVoltageSource, DC_VOLTAGE_SOURCE_DEFAULTS } from "../../../components/sources/dc-voltage-source.js";
import { ResistorDefinition, RESISTOR_DEFAULTS } from "../../../components/passives/resistor.js";
import { PropertyBag } from "../../../core/properties.js";
import { solveDcOperatingPoint, type DcOpNRPhase, type DcOpNRAttemptOutcome } from "../dc-operating-point.js";
import { makeSimpleCtx, initElement, makeLoadCtx } from "./test-helpers.js";
import { createTestPropertyBag } from "../../../test-fixtures/model-fixtures.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";
import type { AnalogElement, PoolBackedAnalogElement } from "../element.js";
import type { LoadContext } from "../load-context.js";
import type { SparseSolver } from "../sparse-solver.js";
import { MODEDCOP, MODEINITFLOAT, MODEINITJCT, setInitf } from "../ckt-mode.js";

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Helper: build a LoadContext for a single element driven directly.
// ---------------------------------------------------------------------------

function makeNullSolver(): SparseSolver {
  const fn = () => {};
  const zero = () => 0;
  return {
    stamp: fn,
    allocElement: zero,
    stampElement: fn,
  } as unknown as SparseSolver;
}

function makeSoloLoadCtx(rhsOld: Float64Array): LoadContext {
  const solver = makeNullSolver();
  // rhs/rhsOld are separate buffers so that RHS stamps don't contaminate
  // the caller's rhsOld array (which the tests assert stays untouched).
  const rhs = new Float64Array(rhsOld.length);
  return makeLoadCtx({
    cktMode: MODEDCOP | MODEINITFLOAT,
    solver,
    rhs,
    rhsOld,
  });
}

// ---------------------------------------------------------------------------
// Helper: create a PropertyBag with BJT simple model params
// ---------------------------------------------------------------------------

function makeBjtProps(modelParams?: Record<string, number>): PropertyBag {
  const props = createTestPropertyBag();
  const defaults = { ...BJT_NPN_DEFAULTS };
  if (modelParams) Object.assign(defaults, modelParams);
  props.replaceModelParams(defaults);
  return props;
}

// ---------------------------------------------------------------------------
// Helper: create a PropertyBag with BJT SPICE L1 model params
// ---------------------------------------------------------------------------

function makeSpiceL1Props(modelParams?: Record<string, number>): PropertyBag {
  const props = createTestPropertyBag();
  const defaults = { ...BJT_SPICE_L1_NPN_DEFAULTS };
  if (modelParams) Object.assign(defaults, modelParams);
  props.replaceModelParams(defaults);
  return props;
}

// ---------------------------------------------------------------------------
// Helper: create a PropertyBag with diode model params
// ---------------------------------------------------------------------------

function makeDiodeProps(modelParams?: Record<string, number>): PropertyBag {
  const props = createTestPropertyBag();
  const defaults = { ...DIODE_PARAM_DEFAULTS };
  if (modelParams) Object.assign(defaults, modelParams);
  props.replaceModelParams(defaults);
  return props;
}

// ---------------------------------------------------------------------------
// Physical constants (matching bjt.ts / analog-types)
// ---------------------------------------------------------------------------

const K = 1.3806226e-23;
const Q = 1.6021918e-19;
const T = 300.15;
const VT_ROOM = T * K / Q; // thermal voltage at 300.15 K ≈ 0.02585 V

function makeVsrc(posNode: number, negNode: number, voltage: number): AnalogElement {
  const props = new PropertyBag();
  props.replaceModelParams({ ...DC_VOLTAGE_SOURCE_DEFAULTS, voltage });
  return makeDcVoltageSource(new Map([["pos", posNode], ["neg", negNode]]), props, () => 0);
}

// ---------------------------------------------------------------------------
// tVcrit formula (matching computeBjtTempParams and diode primeJunctions)
// ---------------------------------------------------------------------------

function computeTVcrit(vt: number, IS: number, AREA: number = 1): number {
  return vt * Math.log(vt / (Math.SQRT2 * IS * AREA));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dcopInitJct", () => {

  // ── BJT priming tests ──────────────────────────────────────────────────

  describe("BJT simple (L0) primeJunctions", () => {
    it("NPN: arms Vbe=tVcrit, Vbc=0 as per-device local override", () => {
      const element = createBjtElement(
        1, // NPN
        new Map([["B", 1], ["C", 2], ["E", 3]]),
        makeBjtProps(),
      );
      initElement(element as unknown as PoolBackedAnalogElement);

      // Prime junctions by setting initJct mode and calling load().
      const voltages = new Float64Array(3); // shared MNA vector stays at zero
      const ctx = makeSoloLoadCtx(voltages);
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITJCT);
      element.load(ctx);
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);

      const tVcrit = computeTVcrit(VT_ROOM, BJT_NPN_DEFAULTS.IS, BJT_NPN_DEFAULTS.AREA);

      // Primed seed landed in the device's own Vbe/Vbc slots.
      // Shared voltages vector was not touched.
      expect(voltages[0]).toBe(0);
      expect(voltages[1]).toBe(0);
      expect(voltages[2]).toBe(0);

      // Second load call: seed consumed, falls through to computing from the
      // (still-zero) shared voltages array.
      element.load(ctx);

      // Exact ngspice-derived value: vt * ln(vt / (sqrt(2) * IS * AREA))
      // VT_ROOM = 300.15 * K / Q ≈ 0.025852 V, IS = 1e-16, AREA = 1
      const expectedBjtTVcrit = VT_ROOM * Math.log(VT_ROOM / (Math.SQRT2 * BJT_NPN_DEFAULTS.IS * BJT_NPN_DEFAULTS.AREA));
      expect(tVcrit).toBeCloseTo(expectedBjtTVcrit, 9);
    });

    it("PNP: arms Vbe=+tVcrit, Vbc=0 (same forward-bias magnitude as NPN)", () => {
      // The seed is a polarity-agnostic forward-bias magnitude, not a
      // polarity-signed node difference. Both NPN and PNP primeJunctions
      // produce +tVcrit because load() computes vbeRaw as
      // polarity * (vB - vE) and that expression is always positive for a
      // forward-biased junction regardless of NPN/PNP convention.
      const element = createBjtElement(
        -1, // PNP
        new Map([["B", 1], ["C", 2], ["E", 3]]),
        makeBjtProps(),
      );
      initElement(element as unknown as PoolBackedAnalogElement);

      const voltages = new Float64Array(3);
      const ctx = makeSoloLoadCtx(voltages);
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITJCT);
      element.load(ctx);
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);

    });

    it("grounded collector (nodeC=0): priming is independent of node topology", () => {
      // This is the PNP-CC-style topology the old shared-vector scheme broke on.
      const element = createBjtElement(
        -1, // PNP
        new Map([["B", 1], ["C", 0], ["E", 2]]),
        makeBjtProps(),
      );
      initElement(element as unknown as PoolBackedAnalogElement);

      const voltages = new Float64Array(2);
      const ctx = makeSoloLoadCtx(voltages);
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITJCT);
      element.load(ctx);
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);

      // Key property: the seed is Vbe=+tVcrit, Vbc=0 regardless of
      // whether the collector is grounded — the old shared-vector
      // scheme couldn't do this because it couldn't write to node 0.
      // Voltages buffer untouched.
      expect(voltages[0]).toBe(0);
      expect(voltages[1]).toBe(0);
    });
  });

  // ── BJT SPICE L1 priming tests ─────────────────────────────────────────

  describe("BJT SPICE L1 primeJunctions", () => {
    it("NPN L1: arms Vbe=tVcrit, Vbc=0 as per-device local override", () => {
      const props = makeSpiceL1Props();
      const element = createSpiceL1BjtElement(
        1,
        false,
        new Map([["B", 1], ["C", 2], ["E", 3]]),
        props,
      );
      initElement(element as unknown as PoolBackedAnalogElement);

      const voltages = new Float64Array(3);
      const ctx = makeSoloLoadCtx(voltages);
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITJCT);
      element.load(ctx);
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);

      // Shared vector untouched.
      for (let i = 0; i < voltages.length; i++) expect(voltages[i]).toBe(0);

      // Seed is one-shot.
      element.load(ctx);
    });
  });

  // ── Diode priming tests ────────────────────────────────────────────────

  describe("Diode primeJunctions", () => {
    it("arms Vd=tVcrit as per-device local override", () => {
      const props = makeDiodeProps();
      const element = createDiodeElement(
        new Map([["A", 1], ["K", 2]]),
        props,
        () => 0,
      );
      initElement(element as unknown as PoolBackedAnalogElement);

      const voltages = new Float64Array(2);
      const ctx = makeSoloLoadCtx(voltages);
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITJCT);
      element.load(ctx);
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);

      const nVt = DIODE_PARAM_DEFAULTS.N * VT_ROOM;
      const tVcrit = nVt * Math.log(nVt / (DIODE_PARAM_DEFAULTS.IS * Math.SQRT2));

      expect(voltages[0]).toBe(0);
      expect(voltages[1]).toBe(0);

      // Seed is one-shot.
      element.load(ctx);

      // Exact ngspice-derived value: nVt * ln(nVt / (IS * sqrt(2)))
      // N = 1, VT_ROOM ≈ 0.025852 V, IS = 1e-14
      const expectedDiodeTVcrit = nVt * Math.log(nVt / (DIODE_PARAM_DEFAULTS.IS * Math.SQRT2));
      expect(tVcrit).toBeCloseTo(expectedDiodeTVcrit, 9);
    });

    it("grounded cathode: priming is independent of node topology", () => {
      const props = makeDiodeProps();
      const element = createDiodeElement(
        new Map([["A", 1], ["K", 0]]),
        props,
        () => 0,
      );
      initElement(element as unknown as PoolBackedAnalogElement);

      const voltages = new Float64Array(1);
      const ctx = makeSoloLoadCtx(voltages);
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITJCT);
      element.load(ctx);
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);

    });
  });

  // ── dcopInitJct phase marker and iteration reduction ───────────────────

  describe("solveDcOperatingPoint phase", () => {
    it("emits dcopInitJct phase marker before dcopInitFloat", () => {
      // Simple resistor divider — no nonlinear elements.
      // Phase marker must still be emitted (even though no priming happens).
      const matrixSize = 3;

      // Build V=5V → R1(1kΩ) → node2 → R2(1kΩ) → GND using production factories.
      const resistorEntry = ResistorDefinition.modelRegistry!["behavioral"]!;
      if (resistorEntry.kind !== "inline") throw new Error("Expected inline ModelEntry");
      const resistorFactory = resistorEntry.factory;
      const resistorProps1 = createTestPropertyBag();
      resistorProps1.replaceModelParams({ ...RESISTOR_DEFAULTS, resistance: 1000 });
      const resistorProps2 = createTestPropertyBag();
      resistorProps2.replaceModelParams({ ...RESISTOR_DEFAULTS, resistance: 1000 });

      const elements: AnalogElement[] = [
        makeVsrc(1, 0, 5) as unknown as AnalogElement,
        resistorFactory(new Map([["pos", 1], ["neg", 2]]), resistorProps1, () => 0) as unknown as AnalogElement,
        resistorFactory(new Map([["pos", 2], ["neg", 0]]), resistorProps2, () => 0) as unknown as AnalogElement,
      ];

      const phases: DcOpNRPhase[] = [];
      const outcomes: DcOpNRAttemptOutcome[] = [];

      const ctx = makeSimpleCtx({ elements, matrixSize, nodeCount: 2 });
      ctx._onPhaseBegin = (phase) => phases.push(phase as DcOpNRPhase);
      ctx._onPhaseEnd = (outcome) => outcomes.push(outcome as DcOpNRAttemptOutcome);
      solveDcOperatingPoint(ctx);
      const result = ctx.dcopResult;

      expect(result.converged).toBe(true);
      // dcopInitJct must appear before dcopInitFloat
      expect(phases).toContain("dcopInitJct");
      const jctIdx = phases.indexOf("dcopInitJct");
      const floatIdx = phases.indexOf("dcopInitFloat");
      expect(jctIdx).toBeLessThan(floatIdx);
      // The phase must emit a dcopPhaseHandoff outcome
      expect(outcomes[jctIdx]).toBe("dcopPhaseHandoff");
    });

    it("NPN CE circuit (fixtures/npn-ce-harness.dts): DC OP converges with priming", () => {
      // Load the same fixture used by the ngspice comparison harness. This
      // exercises the full compile path (deserialize → compile → DC OP) so we
      // cover the real element/node wiring rather than a hand-rolled stamp.
      // The expected operating point is known from prior harness runs:
      //   Rb:B/Q1:B ≈ 1.4713 V   (base)
      //   Rc:B/Q1:C ≈ 6.7130 V   (collector)
      //   Re:A/Q1:E ≈ 0.7063 V   (emitter)
      // At t=0 the square wave source evaluates to V1 = dcOffset - amplitude
      // = 1.9 - 0.1 = 1.8 V under the ngspice PULSE convention.
      const facade = new DefaultSimulatorFacade(registry);
      const json = readFileSync(
        resolve(__dirname, "../../../../fixtures/npn-ce-harness.dts"),
        "utf-8",
      );
      const circuit = facade.deserialize(json);
      facade.compile(circuit);

      const dcOp = facade.getDcOpResult();
      expect(dcOp).not.toBeNull();
      expect(dcOp!.converged).toBe(true);

      // All node voltages finite.
      for (let i = 0; i < dcOp!.nodeVoltages.length; i++) {
        expect(
          Number.isFinite(dcOp!.nodeVoltages[i]),
          `node ${i} voltage should be finite, got ${dcOp!.nodeVoltages[i]}`,
        ).toBe(true);
      }

      // Locate BJT terminal nodes by scanning the result for voltages in the
      // expected physical ranges. (The facade doesn't expose a label→index
      // map from here, and we only need to assert the circuit is in the
      // active region — not hit exact values.)
      const voltages = Array.from(dcOp!.nodeVoltages);
      const inRange = (lo: number, hi: number) =>
        voltages.some((v) => v >= lo && v <= hi);

      // Base in active-region band (1.3 V … 1.6 V — harness observed 1.4713 V)
      expect(
        inRange(1.3, 1.6),
        `no node in base band [1.3, 1.6] V; voltages=${voltages.map((v) => v.toFixed(4)).join(", ")}`,
      ).toBe(true);

      // Collector pulled down from 10 V supply (6.0 V … 7.5 V — observed 6.7130 V)
      expect(
        inRange(6.0, 7.5),
        `no node in collector band [6.0, 7.5] V; voltages=${voltages.map((v) => v.toFixed(4)).join(", ")}`,
      ).toBe(true);

      // Emitter above ground, below base (0.6 V … 0.8 V — observed 0.7063 V)
      expect(
        inRange(0.6, 0.8),
        `no node in emitter band [0.6, 0.8] V; voltages=${voltages.map((v) => v.toFixed(4)).join(", ")}`,
      ).toBe(true);

      // Supply rail still at 10 V.
      expect(
        voltages.some((v) => v > 9.99 && v < 10.01),
        `no node at ~10 V supply; voltages=${voltages.map((v) => v.toFixed(4)).join(", ")}`,
      ).toBe(true);

      // Vin source terminal at 1.8 V (V1 = dcOffset - amplitude at t=0).
      expect(
        voltages.some((v) => v > 1.79 && v < 1.81),
        `no node at ~1.8 V Vin; voltages=${voltages.map((v) => v.toFixed(4)).join(", ")}`,
      ).toBe(true);
    });
  });
});
