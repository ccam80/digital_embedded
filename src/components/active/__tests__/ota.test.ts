/**
 * Tests for OTA (Operational Transconductance Amplifier) analog element.
 *
 * Circuit conventions:
 *   - V+ and V- set the differential input voltage.
 *   - Iabc node is driven to a known voltage via a DC voltage source,
 *     so V(Iabc) = I_bias numerically (1 A/V mapping).
 *   - Output current flows into OUT+ and out of OUT-.
 *   - A load resistor R_load from OUT+ to ground converts I_out to V_out.
 *
 * Node numbering (1-based, 0 = ground):
 *   1 = nVp   (V+ non-inverting input)
 *   2 = nVm   (V- inverting input)
 *   3 = nIabc (bias control node)
 *   4 = nOutP (OUT+ output)
 *   OUT- connected directly to ground (node 0)
 */

import { describe, it, expect } from "vitest";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import { withNodeIds, runDcOp, makeLoadCtx } from "../../../solver/analog/__tests__/test-helpers.js";
import { OTADefinition } from "../ota.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { MODEDCOP, MODEINITFLOAT } from "../../../solver/analog/ckt-mode.js";
import { makeSimpleCtx } from "../../../solver/analog/__tests__/test-helpers.js";
import { solveDcOperatingPoint } from "../../../solver/analog/dc-operating-point.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


// ---------------------------------------------------------------------------
// Helper: read a value from sparse solver matrix at (extRow, extCol).
// ---------------------------------------------------------------------------

function readVal(solver: SparseSolver, extRow: number, extCol: number): number {
  const handle = solver.allocElement(extRow, extCol);
  return (solver as unknown as { _elVal: Float64Array })._elVal[handle];
}

// ---------------------------------------------------------------------------
// Helper: create an OTA element with given node assignments
// ---------------------------------------------------------------------------

function makeOTAElement(
  nVp: number,
  nVm: number,
  nIabc: number,
  nOutP: number,
  nOutN: number,
  opts: { gmMax?: number; vt?: number } = {},
): AnalogElement {
  const gmMax = opts.gmMax ?? 0.01;
  const vt = opts.vt ?? 0.026;
  const props = new PropertyBag([]);
  props.replaceModelParams({ gmMax, vt });
  return withNodeIds(
    getFactory(OTADefinition.modelRegistry!["behavioral"]!)(
      new Map([["V+", nVp], ["V-", nVm], ["Iabc", nIabc], ["OUT+", nOutP], ["OUT", nOutN]]),
      props,
      () => 0,
    ),
    [nVp, nVm, nIabc, nOutP, nOutN],
  );
}

// ---------------------------------------------------------------------------
// Inline resistor for integration tests (has no setup(), compatible with runDcOp)
// ---------------------------------------------------------------------------

function makeInlineResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const G = 1 / resistance;
  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: -1, isNonlinear: false, isReactive: false,
    setParam(_key: string, _value: number): void {},
    getPinCurrents(): number[] { return []; },
    ngspiceLoadOrder: 0,
    load(ctx): void {
      const { solver } = ctx;
      if (nodeA > 0) { const h = solver.allocElement(nodeA, nodeA); solver.stampElement(h, G); }
      if (nodeB > 0) { const h = solver.allocElement(nodeB, nodeB); solver.stampElement(h, G); }
      if (nodeA > 0 && nodeB > 0) {
        solver.stampElement(solver.allocElement(nodeA, nodeB), -G);
        solver.stampElement(solver.allocElement(nodeB, nodeA), -G);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// OTA tests
// ---------------------------------------------------------------------------

describe("OTA", () => {
  it("linear_region", () => {
    // Small V_diff = 1mV; I_bias = 1mA; gm = I_bias/(2*V_T) ≈ 19.23 mS
    // I_out = gm * V_diff ≈ 19.23 µA; R_load=1kΩ → V_out ≈ 19.23mV
    //
    // Nodes: 1=vp, 2=vm, 3=iabc, 4=outP; OUT-=gnd(0)
    // Branches: 5=Vs_vp, 6=Vs_vm, 7=Vs_iabc; matrixSize=1010 (OTA setup uses nodeCount≥1000)
    const nVp = 1, nVm = 2, nIabc = 3, nOutP = 4;
    const brVp = 5, brVm = 6, brIabc = 7;
    const matrixSize = 1010;

    const vt = 0.026;
    const iBias = 1e-3;
    const vDiff = 1e-3;
    const rLoad = 1000;

    const vsVp   = makeDcVoltageSource(nVp,   0, brVp,   vDiff);
    const vsVm   = makeDcVoltageSource(nVm,   0, brVm,   0);
    const vsIabc = makeDcVoltageSource(nIabc, 0, brIabc, iBias);
    const ota    = makeOTAElement(nVp, nVm, nIabc, nOutP, 0, { vt });
    const rL     = makeInlineResistor(nOutP, 0, rLoad);

    const elements = [ota, rL, vsVp as unknown as AnalogElement, vsVm as unknown as AnalogElement, vsIabc as unknown as AnalogElement];
    const ctx = makeSimpleCtx({ elements, matrixSize, nodeCount: 4, branchCount: matrixSize - 4 });
    ctx.dcopSavedState0 = new Float64Array(0);
    ctx.dcopOldState0   = new Float64Array(0);
    solveDcOperatingPoint(ctx);

    expect(ctx.dcopResult.converged).toBe(true);
  });

  it("tanh_limiting", () => {
    // Large V_diff = 1V >> 2*V_T; I_out saturates to ≈ I_bias = 5mA
    // V_out ≈ I_bias * R_load = 5V ± 1%
    const nVp = 1, nVm = 2, nIabc = 3, nOutP = 4;
    const brVp = 5, brVm = 6, brIabc = 7;
    const matrixSize = 1010;

    const vt = 0.026;
    const iBias = 5e-3;
    const vDiff = 1.0;
    const rLoad = 1000;

    const vsVp   = makeDcVoltageSource(nVp,   0, brVp,   vDiff);
    const vsVm   = makeDcVoltageSource(nVm,   0, brVm,   0);
    const vsIabc = makeDcVoltageSource(nIabc, 0, brIabc, iBias);
    const ota    = makeOTAElement(nVp, nVm, nIabc, nOutP, 0, { vt });
    const rL     = makeInlineResistor(nOutP, 0, rLoad);

    const elements = [ota, rL, vsVp as unknown as AnalogElement, vsVm as unknown as AnalogElement, vsIabc as unknown as AnalogElement];
    const ctx = makeSimpleCtx({ elements, matrixSize, nodeCount: 4, branchCount: matrixSize - 4 });
    ctx.dcopSavedState0 = new Float64Array(0);
    ctx.dcopOldState0   = new Float64Array(0);
    solveDcOperatingPoint(ctx);

    expect(ctx.dcopResult.converged).toBe(true);
    // V(nOutP) ≈ iBias * rLoad when fully saturated
    const vOut = ctx.dcopResult.nodeVoltages[nOutP];
    expect(vOut).toBeGreaterThan(iBias * rLoad * 0.99);
    expect(vOut).toBeLessThan(iBias * rLoad * 1.01);
  });

  it("gm_proportional_to_ibias", () => {
    // Double I_bias → gm doubles → I_out doubles in linear region.
    const vt = 0.026;
    const vDiff = 0.1e-3; // tiny to stay linear
    const rLoad = 1000;

    function runWithIbias(iBias: number): number {
      const nVp = 1, nVm = 2, nIabc = 3, nOutP = 4;
      const brVp = 5, brVm = 6, brIabc = 7;
      const matrixSize = 1010;

      const vsVp   = makeDcVoltageSource(nVp,   0, brVp,   vDiff);
      const vsVm   = makeDcVoltageSource(nVm,   0, brVm,   0);
      const vsIabc = makeDcVoltageSource(nIabc, 0, brIabc, iBias);
      const ota    = makeOTAElement(nVp, nVm, nIabc, nOutP, 0, { vt });
      const rL     = makeInlineResistor(nOutP, 0, rLoad);

      const elements = [ota, rL, vsVp as unknown as AnalogElement, vsVm as unknown as AnalogElement, vsIabc as unknown as AnalogElement];
      const ctx = makeSimpleCtx({ elements, matrixSize, nodeCount: 4, branchCount: matrixSize - 4 });
      ctx.dcopSavedState0 = new Float64Array(0);
      ctx.dcopOldState0   = new Float64Array(0);
      solveDcOperatingPoint(ctx);
      expect(ctx.dcopResult.converged).toBe(true);
      return ctx.dcopResult.nodeVoltages[nOutP];
    }

    const v1 = runWithIbias(1e-3);
    const v2 = runWithIbias(2e-3);
    // gm ∝ I_bias → V_out doubles when I_bias doubles (in linear region)
    expect(v2 / v1).toBeCloseTo(2, 1);
  });

  it("vca_circuit", () => {
    // OTA as voltage-controlled amplifier: gain ∝ I_bias.
    // I_bias=1mA vs 4mA → gain increases ~4×.
    const vt = 0.026;
    const vDiff = 0.5e-3;
    const rLoad = 1000;

    function gainAtIbias(iBias: number): number {
      const nVp = 1, nVm = 2, nIabc = 3, nOutP = 4;
      const brVp = 5, brVm = 6, brIabc = 7;
      const matrixSize = 1010;

      const vsVp   = makeDcVoltageSource(nVp,   0, brVp,   vDiff);
      const vsVm   = makeDcVoltageSource(nVm,   0, brVm,   0);
      const vsIabc = makeDcVoltageSource(nIabc, 0, brIabc, iBias);
      const ota    = makeOTAElement(nVp, nVm, nIabc, nOutP, 0, { vt });
      const rL     = makeInlineResistor(nOutP, 0, rLoad);

      const elements = [ota, rL, vsVp as unknown as AnalogElement, vsVm as unknown as AnalogElement, vsIabc as unknown as AnalogElement];
      const ctx = makeSimpleCtx({ elements, matrixSize, nodeCount: 4, branchCount: matrixSize - 4 });
      ctx.dcopSavedState0 = new Float64Array(0);
      ctx.dcopOldState0   = new Float64Array(0);
      solveDcOperatingPoint(ctx);
      expect(ctx.dcopResult.converged).toBe(true);
      return ctx.dcopResult.nodeVoltages[nOutP] / vDiff;
    }

    const g1 = gainAtIbias(1e-3);
    const g4 = gainAtIbias(4e-3);
    // Gain scales ~4× when I_bias increases 4×
    expect(g4 / g1).toBeCloseTo(4, 1);
  });
});

// ---------------------------------------------------------------------------
// C4.5 parity test  ota_load_dcop_parity
// ---------------------------------------------------------------------------
//
// Drives the OTA via setup()+load() at a canonical operating point and asserts
// the VCCS stamps and RHS entries match the closed-form transconductance model.
//
// Reference formulas (from ota.ts createOTAElement):
//   twoVt   = 2 * vt
//   xClamp  = clamp(vDiff / twoVt, -50, 50)
//   tanhX   = tanh(xClamp)
//   iOut    = iBias * tanhX
//   sech2   = 1 - tanhX^2
//   gmRaw   = iBias / twoVt * sech2
//   gmEff   = min(|gmRaw|, gmMax)
//   iNR     = iOut - gmEff * vDiff
// Stamps:
//   (OUT+, V+) -= gmEff;  (OUT+, V-) += gmEff
//   (OUT-, *)  suppressed when nOutN=0 (ground)
// RHS:
//   OUT+ += iNR

describe("OTA parity (C4.5)", () => {
  it("ota_load_dcop_parity", () => {
    const nVp = 1, nVm = 2, nIabc = 3, nOutP = 4, nOutN = 0;
    const vt = 0.026;
    const gmMax = 0.01;
    const vDiff = 1e-3;
    const iBias = 1e-3;

    const props = new PropertyBag([]);
    props.replaceModelParams({ gmMax, vt });
    const ota = getFactory(OTADefinition.modelRegistry!["behavioral"]!)(
      new Map([["V+", nVp], ["V-", nVm], ["Iabc", nIabc], ["OUT+", nOutP], ["OUT", nOutN]]),
      props,
      () => 0,
    );

    const voltages = new Float64Array(110);
    voltages[nVp]   = vDiff;
    voltages[nVm]   = 0;
    voltages[nIabc] = iBias;
    voltages[nOutP] = 0;

    const rhs = new Float64Array(110);
    const ctx = makeLoadCtx({
      solver: solver as unknown as import("../../../solver/analog/sparse-solver.js").SparseSolver,
      rhs,
      rhsOld: voltages,
      cktMode: MODEDCOP | MODEINITFLOAT,
      dt: 0,
    });
    ota.load(ctx);

    // Closed-form reference:
    const NGSPICE_TWOVT = 2 * vt;
    const NGSPICE_X     = vDiff / NGSPICE_TWOVT;
    const NGSPICE_TANHX = Math.tanh(NGSPICE_X);
    const NGSPICE_IOUT  = iBias * NGSPICE_TANHX;
    const NGSPICE_SECH2 = 1 - NGSPICE_TANHX * NGSPICE_TANHX;
    const NGSPICE_GMRAW = (iBias / NGSPICE_TWOVT) * NGSPICE_SECH2;
    const NGSPICE_GMEFF = Math.min(Math.abs(NGSPICE_GMRAW), gmMax);
    const NGSPICE_INR   = NGSPICE_IOUT - NGSPICE_GMEFF * vDiff;

    // VCCS stamps: (OUT+, V+) -= gmEff; (OUT+, V-) += gmEff.
    // OUT- is ground (nOutN=0), so (OUT-, *) entries are suppressed.
    expect(readVal(solver, nOutP, nVp)).toBeCloseTo(-NGSPICE_GMEFF, 10);
    expect(readVal(solver, nOutP, nVm)).toBeCloseTo(NGSPICE_GMEFF, 10);

    // RHS: OUT+ += iNR.
    expect(rhs[nOutP]).toBeCloseTo(NGSPICE_INR, 10);
  });
});
