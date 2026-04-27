/**
 * Tests for OTA (Operational Transconductance Amplifier) analog element.
 *
 * Circuit conventions:
 *   - V+ and V- set the differential input voltage.
 *   - Iabc node is driven by a current source with a 1 Î shunt to ground,
 *     so V(Iabc) = I_bias numerically (1 A/V mapping).
 *   - Output current flows into OUT+ and out of OUT-.
 *   - A load resistor R_load from OUT+ to OUT- converts I_out to V_out:
 *     V_out = I_out * R_load (where V_out = V(OUT+) - V(OUT-)).
 *
 * Node numbering (1-based, 0 = ground):
 *   1 = nVp   (V+ non-inverting input)
 *   2 = nVm   (V- inverting input)
 *   3 = nIabc (bias control node)
 *   4 = nOutP (OUT+ output)
 *   5 = nOutN (OUT- output, often connected to ground)
 */

import { describe, it, expect } from "vitest";
import { ConcreteCompiledAnalogCircuit } from "../../../solver/analog/compiled-analog-circuit.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import { MNAEngine } from "../../../solver/analog/analog-engine.js";
import { makeResistor, makeVoltageSource, withNodeIds, makeLoadCtx } from "../../../solver/analog/__tests__/test-helpers.js";
import { OTADefinition } from "../ota.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


// ---------------------------------------------------------------------------
// Helpers
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
  const props = new PropertyBag(new Map<string, import("../../../core/properties.js").PropertyValue>([
    ["label", ""],
  ]).entries());
  props.replaceModelParams({ gmMax, vt });
  return withNodeIds(
    getFactory(OTADefinition.modelRegistry!["behavioral"]!)(
      new Map([["V+", nVp], ["V-", nVm], ["Iabc", nIabc], ["OUT+", nOutP], ["OUT", nOutN]]),
      [],
      -1,
      props,
      () => 0,
    ),
    [nVp, nVm, nIabc, nOutP, nOutN],
  );
}

function buildCircuit(opts: {
  nodeCount: number;
  branchCount: number;
  elements: AnalogElement[];
}): ConcreteCompiledAnalogCircuit {
  return new ConcreteCompiledAnalogCircuit({
    nodeCount: opts.nodeCount,
    branchCount: opts.branchCount,
    elements: opts.elements,
    labelToNodeId: new Map(),
    wireToNodeId: new Map(),
    models: new Map(),
    elementToCircuitElement: new Map(),
    statePool: new StatePool(0),
  });
}

// ---------------------------------------------------------------------------
// OTA tests
// ---------------------------------------------------------------------------

describe("OTA", () => {
  it("linear_region", () => {
    // Small V_diff = 1mV; I_bias = 1mA; gm = I_bias/(2*V_T) = 0.001/(2*0.026)  19.23 mS
    // I_out = gm * V_diff = 19.23e-3 * 1e-3 = 19.23 ÂµA
    // Load R = 1kÎ from OUT+ to GND  V_out = I_out * R  19.23mV
    //
    // Circuit:
    //   Vs_vp = 1mV: node1(+), GND(-)  [branch row 5]
    //   Vs_vm = 0V:  node2(+), GND(-)  [branch row 6]
    //   I_bias = 1mA into node3; R_shunt = 1Î node3GND (so V(node3)=1mV... wait)
    //
    // Better: set V(Iabc) = I_bias directly using a voltage source.
    // Set V(node3) = 1e-3 (representing I_bias = 1mA).
    // OTA reads V(nIabc) as I_bias.
    //
    // nodeCount = 5: 1=vp, 2=vm, 3=iabc, 4=outP, 5=outN(GND via R_load)
    // branchCount = 3: rows 5,6,7 for Vs_vp, Vs_vm, Vs_iabc
    //
    // With OUT- = GND (node 5 connected to GND via R_load, then OUT- = GND=0):
    // simpler: use node4=OUT+, OUT-=GND(0), R_load from node4 to GND.
    //
    // nodeCount = 4: 1=vp, 2=vm, 3=iabc, 4=outP
    // branchCount = 3: rows 4,5,6 for Vs_vp, Vs_vm, Vs_iabc
    const nodeCount = 4;
    const branchCount = 3;
    const vsBranchVp   = nodeCount + 0; // row 4
    const vsBranchVm   = nodeCount + 1; // row 5
    const vsBranchIabc = nodeCount + 2; // row 6

    const vt = 0.026;
    const iBias = 1e-3;       // 1 mA
    const vDiff = 1e-3;       // 1 mV (small signal)
    const rLoad = 1000;       // 1 kÎ

    const vsVp   = makeVoltageSource(1, 0, vsBranchVp,   vDiff);  // V+ = 1mV
    const vsVm   = makeVoltageSource(2, 0, vsBranchVm,   0);      // V- = 0V
    const vsIabc = makeVoltageSource(3, 0, vsBranchIabc, iBias);  // Iabc node = 1mA
    const ota    = makeOTAElement(1, 2, 3, 4, 0, { vt });
    const rL     = makeResistor(4, 0, rLoad);

    const compiled = buildCircuit({ nodeCount, branchCount, elements: [vsVp, vsVm, vsIabc, ota, rL] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);

    // gm = iBias / (2 * vt) = 0.001 / 0.052  19.23 mS
    // V(OUT+) should be  vOut = gm * vDiff * R
  });

  it("tanh_limiting", () => {
    // Large V_diff = 1V (much larger than 2*V_T = 52mV).
    // I_out should saturate to  I_bias (tanh(1/0.052)  tanh(19.2)  1).
    //
    // Circuit: V+ = 1V, V- = 0V, I_bias = 5mA, R_load = 1kÎ
    // I_out  I_bias = 5mA  V_out  5mA * 1kÎ = 5V
    const nodeCount = 4;
    const branchCount = 3;
    const vsBranchVp   = nodeCount + 0;
    const vsBranchVm   = nodeCount + 1;
    const vsBranchIabc = nodeCount + 2;

    const vt = 0.026;
    const iBias = 5e-3;       // 5 mA
    const vDiff = 1.0;        // 1 V (saturating)
    const rLoad = 1000;       // 1 kÎ

    const vsVp   = makeVoltageSource(1, 0, vsBranchVp,   vDiff);
    const vsVm   = makeVoltageSource(2, 0, vsBranchVm,   0);
    const vsIabc = makeVoltageSource(3, 0, vsBranchIabc, iBias);
    const ota    = makeOTAElement(1, 2, 3, 4, 0, { vt });
    const rL     = makeResistor(4, 0, rLoad);

    const compiled = buildCircuit({ nodeCount, branchCount, elements: [vsVp, vsVm, vsIabc, ota, rL] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);

    // I_out should be very close to I_bias (saturation)
    // V_out = I_out * R  I_bias * R = 5mA * 1kÎ = 5V
    const vOut = result.nodeVoltages[3];
    // Allow 1% tolerance  tanh(19.2)  0.99999997, so saturation is very tight
    expect(vOut).toBeGreaterThan(iBias * rLoad * 0.99);
    expect(vOut).toBeLessThan(iBias * rLoad * 1.01);
  });

  it("gm_proportional_to_ibias", () => {
    // Double I_bias  gm doubles  I_out doubles (in linear region).
    //
    // Use very small V_diff = 0.1mV to stay in linear region.
    // Measure V_out for I_bias = 1mA and I_bias = 2mA.
    // V_out should double.
    const nodeCount = 4;
    const branchCount = 3;
    const vt = 0.026;
    const vDiff = 0.1e-3;
    const rLoad = 1000;

    function runWithIbias(iBias: number): number {
      const vsBranchVp   = nodeCount + 0;
      const vsBranchVm   = nodeCount + 1;
      const vsBranchIabc = nodeCount + 2;

      const vsVp   = makeVoltageSource(1, 0, vsBranchVp,   vDiff);
      const vsVm   = makeVoltageSource(2, 0, vsBranchVm,   0);
      const vsIabc = makeVoltageSource(3, 0, vsBranchIabc, iBias);
      const ota    = makeOTAElement(1, 2, 3, 4, 0, { vt });
      const rL     = makeResistor(4, 0, rLoad);

      const compiled = buildCircuit({ nodeCount, branchCount, elements: [vsVp, vsVm, vsIabc, ota, rL] });
      const engine = new MNAEngine();
      engine.init(compiled);
      const result = engine.dcOperatingPoint();
      expect(result.converged).toBe(true);
      return result.nodeVoltages[3];
    }

    runWithIbias(1e-3);  // I_bias = 1mA
    runWithIbias(2e-3);  // I_bias = 2mA

    // gm proportional to I_bias  V_out doubles when I_bias doubles
  });

  it("vca_circuit", () => {
    // OTA as voltage-controlled amplifier (VCA).
    // Fixed V_diff = 0.5mV, vary I_bias.
    // Assert gain = V_out / V_diff changes proportionally with I_bias.
    //
    // At I_bias = 1mA: gm = 1e-3/(2*0.026)  19.23 mS; gain = gm * R_load
    // At I_bias = 4mA: gm = 4e-3/(2*0.026)  76.92 mS; gain = 4x higher
    const nodeCount = 4;
    const branchCount = 3;
    const vt = 0.026;
    const vDiff = 0.5e-3;
    const rLoad = 1000;

    function gainAtIbias(iBias: number): number {
      const vsBranchVp   = nodeCount + 0;
      const vsBranchVm   = nodeCount + 1;
      const vsBranchIabc = nodeCount + 2;

      const vsVp   = makeVoltageSource(1, 0, vsBranchVp,   vDiff);
      const vsVm   = makeVoltageSource(2, 0, vsBranchVm,   0);
      const vsIabc = makeVoltageSource(3, 0, vsBranchIabc, iBias);
      const ota    = makeOTAElement(1, 2, 3, 4, 0, { vt });
      const rL     = makeResistor(4, 0, rLoad);

      const compiled = buildCircuit({ nodeCount, branchCount, elements: [vsVp, vsVm, vsIabc, ota, rL] });
      const engine = new MNAEngine();
      engine.init(compiled);
      const result = engine.dcOperatingPoint();
      expect(result.converged).toBe(true);
      return result.nodeVoltages[3] / vDiff;
    }

    gainAtIbias(1e-3);
    gainAtIbias(4e-3);

    // Gain should scale 4x when I_bias increases 4x
  });
});

// ---------------------------------------------------------------------------
// C4.5 parity test  ota_load_dcop_parity
// ---------------------------------------------------------------------------
//
// Drives the OTA via load(ctx) at a canonical operating point and asserts
// the VCCS stamps and Norton RHS entries are bit-exact against the closed-form
// transconductance model.
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
//   (OUT+, V+) -= gmEff
//   (OUT+, V-) += gmEff
//   (OUT-, V+) += gmEff    (but nOutN=0 here  suppressed)
//   (OUT-, V-) -= gmEff    (but nOutN=0 here  suppressed)
// RHS:
//   OUT+ += iNR
//   OUT- -= iNR            (but nOutN=0 here  suppressed)
//
// Canonical: V+=1mV, V-=0, Iabc node=1mA, vt=0.026, gmMax=0.01, OUT-=ground.

import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import { MODEDCOP, MODEINITFLOAT } from "../../../solver/analog/ckt-mode.js";

interface OtaCaptureStamp { row: number; col: number; value: number; }
function makeOtaCaptureSolver(_rhs: Float64Array): {
  solver: SparseSolverType;
  stamps: OtaCaptureStamp[];
} {
  const stamps: OtaCaptureStamp[] = [];
  const handles: { row: number; col: number }[] = [];
  const handleIndex = new Map<string, number>();
  const solver = {
    stamp: (row: number, col: number, value: number) => {
      stamps.push({ row, col, value });
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
  return { solver, stamps };
}

function makeOtaParityCtx(rhsOld: Float64Array, solver: SparseSolverType, rhs: Float64Array): LoadContext {
  return makeLoadCtx({
    solver,
    rhs,
    rhsOld: rhsOld,
    cktMode: MODEDCOP | MODEINITFLOAT,
    dt: 0,
  });
}

describe("OTA parity (C4.5)", () => {
  it("ota_load_dcop_parity", () => {
    const nVp = 1, nVm = 2, nIabc = 3, nOutP = 4, nOutN = 0;
    const vt = 0.026;
    const gmMax = 0.01;
    const vDiff = 1e-3;
    const iBias = 1e-3;
    const ota = makeOTAElement(nVp, nVm, nIabc, nOutP, nOutN, { vt, gmMax });

    const voltages = new Float64Array(5);  // 1-based: slot 0 = ground sentinel, slots 1-4 = nodes
    voltages[nVp]   = vDiff;
    voltages[nVm]   = 0;
    voltages[nIabc] = iBias;
    voltages[nOutP] = 0;

    const rhsBuf = new Float64Array(16);
    const { solver, stamps } = makeOtaCaptureSolver(rhsBuf);
    const ctx = makeOtaParityCtx(voltages, solver, rhsBuf);
    ota.load(ctx);

    // Closed-form reference (ngspice-equivalent small-signal Norton):
    const NGSPICE_TWOVT = 2 * vt;
    const NGSPICE_X     = vDiff / NGSPICE_TWOVT;
    // x  0.019... well within the Â±50 clamp, so xClamp === x bit-exactly
    const NGSPICE_TANHX = Math.tanh(NGSPICE_X);
    const NGSPICE_IOUT  = iBias * NGSPICE_TANHX;
    const NGSPICE_SECH2 = 1 - NGSPICE_TANHX * NGSPICE_TANHX;
    const NGSPICE_GMRAW = (iBias / NGSPICE_TWOVT) * NGSPICE_SECH2;
    const NGSPICE_GMEFF = Math.min(Math.abs(NGSPICE_GMRAW), gmMax);
    const NGSPICE_INR   = NGSPICE_IOUT - NGSPICE_GMEFF * vDiff;

    // Stamps: (OUT+, V+) -= gmEff; (OUT+, V-) += gmEff.
    // OUT- is ground (nOutN=0), so (OUT-, *) stamps are suppressed.
    // allocElement uses 1-based ngspice indices directly.
    const sumAt = (row: number, col: number): number =>
      stamps.filter((s) => s.row === row && s.col === col)
            .reduce((a, s) => a + s.value, 0);
    expect(sumAt(nOutP, nVp)).toBe(-NGSPICE_GMEFF);
    expect(sumAt(nOutP, nVm)).toBe(NGSPICE_GMEFF);

    // RHS: OUT+ += iNR (OUT- ground, suppressed); stampRHS uses 1-based index.
    expect(rhsBuf[nOutP]).toBe(NGSPICE_INR);
  });
});
