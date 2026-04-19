/**
 * Tests for the Ideal Op-Amp component.
 *
 * The op-amp uses a linear MNA stamp in the unsaturated region:
 *   G[out,out]  += G_out
 *   G[out,in+]  -= gain * G_out
 *   G[out,in-]  += gain * G_out
 *
 * In saturation, only G_out stamps and a Norton current source drives
 * the output to the rail voltage.
 *
 * Unit tests verify the stamp entries directly.
 * Integration tests verify full DC operating point solutions.
 */

import { describe, it, expect } from "vitest";
import { OpAmpDefinition } from "../opamp.js";
import { PropertyBag } from "../../../core/properties.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import { withNodeIds, runDcOp } from "../../../solver/analog/__tests__/test-helpers.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

// ---------------------------------------------------------------------------
// Helper: create an op-amp element
// ---------------------------------------------------------------------------

function makeOpAmp(opts: {
  nInp?: number;
  nInn?: number;
  nOut?: number;
  nVccP?: number;
  nVccN?: number;
  gain?: number;
  rOut?: number;
}): AnalogElement {
  const {
    nInp = 1,
    nInn = 2,
    nOut = 3,
    nVccP: _nVccP = 4,
    nVccN: _nVccN = 5,
    gain = 1e6,
    rOut = 75,
  } = opts;
  const props = new PropertyBag([]);
  props.replaceModelParams({ gain, rOut });
  return getFactory(OpAmpDefinition.modelRegistry!["behavioral"]!)(
    new Map([["in+", nInp], ["in-", nInn], ["out", nOut]]),
    [],
    -1,
    props,
    () => 0,
  ) as unknown as AnalogElement;
}

/**
 * Build a solution vector with given node voltages (1-based node IDs).
 */
function makeSolutionVector(
  size: number,
  nodeVoltages: Record<number, number>,
): Float64Array {
  const v = new Float64Array(size);
  for (const [node, voltage] of Object.entries(nodeVoltages)) {
    const n = parseInt(node);
    if (n > 0 && n <= size) {
      v[n - 1] = voltage;
    }
  }
  return v;
}

// ---------------------------------------------------------------------------
// OpAmp unit tests
// ---------------------------------------------------------------------------

describe("OpAmp", () => {
  it("linear_region", () => {
    // In linear region: load() places VCVS entries and no RHS.
    // G[out,out] += G_out
    // G[out,in+] -= gain*G_out
    // G[out,in-] += gain*G_out
    const opamp = makeOpAmp({ gain: 1e6, rOut: 75 });
    const G_out = 1 / 75;

    // Set operating point with Vout in linear range (not at rail)
    const voltages = makeSolutionVector(6, {
      1: 1e-6,   // in+
      2: 0,      // in-
      3: 1.0,    // out — within linear range (between -15 and +15)
      4: 15,     // Vcc+
      5: -15,    // Vcc-
    });

    const { solver, stamps, rhs } = makeCaptureSolver();
    opamp.load(makeOpAmpParityCtx(voltages, solver));

    const sumAt = (row: number, col: number): number =>
      stamps.filter((s) => s.row === row && s.col === col).reduce((a, s) => a + s.value, 0);

    // G_out on out diagonal: stamp(out-1, out-1, G_out) = stamp(2, 2, G_out)
    expect(sumAt(2, 2)).toBeCloseTo(G_out, 10);

    // VCVS: G[out, in+] -= gain*G_out → stamp(2, 0, -gain*G_out)
    expect(sumAt(2, 0)).toBeCloseTo(-1e6 * G_out, 10);

    // VCVS: G[out, in-] += gain*G_out → stamp(2, 1, +gain*G_out)
    expect(sumAt(2, 1)).toBeCloseTo(1e6 * G_out, 10);

    // Linear region: no RHS contribution at the output node
    const rhsAtOut = rhs.filter((r) => r.row === 2);
    expect(rhsAtOut).toHaveLength(0);
  });

  it("positive_saturation", () => {
    // When Vout >= Vcc+: saturated, load() omits VCVS and drives a Norton current to the rail.
    const opamp = makeOpAmp({ gain: 1e6, rOut: 75 });
    const G_out = 1 / 75;

    // Set Vout = 20V > Vcc+ = 15V → saturated
    const voltages = makeSolutionVector(6, {
      1: 1e-3,   // in+
      2: 0,      // in-
      3: 20,     // out — above Vcc+
      4: 15,     // Vcc+
      5: -15,    // Vcc-
    });

    const { solver: stampSolver, stamps: stampCapture, rhs } = makeCaptureSolver();
    opamp.load(makeOpAmpParityCtx(voltages, stampSolver));
    const sumAt2 = (row: number, col: number): number =>
      stampCapture.filter((s) => s.row === row && s.col === col).reduce((a, s) => a + s.value, 0);
    expect(sumAt2(2, 2)).toBeCloseTo(G_out, 10);
    // No large Jacobian entries (no VCVS in saturation)
    const hasVcvsEntry = stampCapture.some(
      (s) => s.row === 2 && (s.col === 0 || s.col === 1) && Math.abs(s.value) > 1,
    );
    expect(hasVcvsEntry).toBe(false);

    // Norton current to clamp output to Vcc+=15V
    const rhsAtOut = rhs.find((r) => r.row === 2);
    expect(rhsAtOut).toBeDefined();
    expect(rhsAtOut!.value).toBeCloseTo(15 * G_out, 6);
  });

  it("negative_saturation", () => {
    // When Vout <= Vcc-: saturated, load() drives output to Vcc- via a Norton current.
    const opamp = makeOpAmp({ gain: 1e6, rOut: 75 });
    const G_out = 1 / 75;

    // Set Vout = -20V < Vcc- = -15V → saturated
    const voltages = makeSolutionVector(6, {
      1: -1e-3,  // in+
      2: 0,      // in-
      3: -20,    // out — below Vcc-
      4: 15,     // Vcc+
      5: -15,    // Vcc-
    });

    const { solver, rhs } = makeCaptureSolver();
    opamp.load(makeOpAmpParityCtx(voltages, solver));
    const rhsAtOut = rhs.find((r) => r.row === 2);
    expect(rhsAtOut).toBeDefined();
    expect(rhsAtOut!.value).toBeCloseTo(-15 * G_out, 6);
  });

  it("output_impedance", () => {
    // Circuit: Vin=2µV fixes in+, in- grounded by VS, R_load=75Ω on output.
    // Vout_open = gain * Vin = 1e6 * 2e-6 = 2V
    // With R_load = R_out = 75Ω: Vout = 2 * R_load/(R_out+R_load) = 1V ± 0.1V
    //
    // MNA: nodes 1..5, branches 5..8 → matrixSize = 9
    //   node 1 = in+, node 2 = in- (grounded via VS), node 3 = out
    //   node 4 = Vcc+, node 5 = Vcc-
    const nInp = 1, nInn = 2, nOut = 3, nVccP = 4, nVccN = 5;
    const brVin = 5, brVinn = 6, brVccP = 7, brVccN = 8;
    const matrixSize = 9;

    const props = new PropertyBag([]);
    props.replaceModelParams({ gain: 1e6, rOut: 75 });
    const opampEl = withNodeIds(getFactory(OpAmpDefinition.modelRegistry!["behavioral"]!)(
      new Map([["in+", nInp], ["in-", nInn], ["out", nOut]]), [], -1, props, () => 0,
    ), [nInn, nInp, nOut]); // pinLayout order: [in-, in+, out]

    // 75Ω load on output
    const G_load = 1 / 75;
    const rLoadEl: AnalogElement = {
      pinNodeIds: [nOut, 0],
      allNodeIds: [nOut, 0],
      branchIndex: -1, isNonlinear: false, isReactive: false,
      setParam(_key: string, _value: number): void {},
      getPinCurrents(): number[] { return []; },
      load(ctx): void {
        const h = ctx.solver.allocElement(nOut - 1, nOut - 1);
        ctx.solver.stampElement(h, G_load);
      },
    };

    const vinSource  = makeDcVoltageSource(nInp,  0, brVin,  2e-6);
    const vinnSource = makeDcVoltageSource(nInn,  0, brVinn, 0);
    const vccPSource = makeDcVoltageSource(nVccP, 0, brVccP, 15);
    const vccNSource = makeDcVoltageSource(nVccN, 0, brVccN, -15);

    const result = runDcOp({
      elements: [opampEl, rLoadEl, vinSource as unknown as AnalogElement, vinnSource as unknown as AnalogElement, vccPSource as unknown as AnalogElement, vccNSource as unknown as AnalogElement],
      matrixSize,
      nodeCount: 5,
    });

    expect(result.converged).toBe(true);
    const vOut = result.nodeVoltages[nOut - 1];
    // Vout = 2V * (75/(75+75)) = 1V ± 0.1V
    expect(vOut).toBeCloseTo(1.0, 0);
  });
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("Integration", () => {
  function makeResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement {
    const G = 1 / resistance;
    return {
      pinNodeIds: [nodeA, nodeB],
      allNodeIds: [nodeA, nodeB],
      branchIndex: -1, isNonlinear: false, isReactive: false,
      setParam(_key: string, _value: number): void {},
      getPinCurrents(): number[] { return []; },
      load(ctx): void {
        const { solver } = ctx;
        if (nodeA > 0) { const h = solver.allocElement(nodeA - 1, nodeA - 1); solver.stampElement(h, G); }
        if (nodeB > 0) { const h = solver.allocElement(nodeB - 1, nodeB - 1); solver.stampElement(h, G); }
        if (nodeA > 0 && nodeB > 0) {
          const hab = solver.allocElement(nodeA - 1, nodeB - 1); solver.stampElement(hab, -G);
          const hba = solver.allocElement(nodeB - 1, nodeA - 1); solver.stampElement(hba, -G);
        }
      },
    };
  }

  it("inverting_amplifier", () => {
    // Inverting amplifier: gain = -Rf/Rin = -10kΩ/1kΩ = -10
    // Vin = 1V → Vout ≈ -10V ± 0.01V
    //
    // Node assignments:
    //   node 1 = Vin terminal
    //   node 2 = in- (inverting, virtual ground)
    //   node 3 = out
    //   node 4 = in+ (grounded via VS)
    //   node 5 = Vcc+
    //   node 6 = Vcc-
    // Branch rows: 6..9 → matrixSize = 10
    const nVin = 1, nInn = 2, nOut = 3, nInp = 4, nVccP = 5, nVccN = 6;
    const brVin = 6, brInp = 7, brVccP = 8, brVccN = 9;
    const matrixSize = 10;

    const props = new PropertyBag([]);
    props.replaceModelParams({ gain: 1e6, rOut: 75 });
    const opampEl = withNodeIds(getFactory(OpAmpDefinition.modelRegistry!["behavioral"]!)(
      new Map([["in+", nInp], ["in-", nInn], ["out", nOut]]), [], -1, props, () => 0,
    ), [nInn, nInp, nOut]); // pinLayout order: [in-, in+, out]

    const rin = makeResistor(nVin, nInn, 1000);
    const rf  = makeResistor(nInn, nOut, 10000);

    const vsVin  = makeDcVoltageSource(nVin,  0, brVin,  1.0);
    const vsInp  = makeDcVoltageSource(nInp,  0, brInp,  0.0);
    const vsVccP = makeDcVoltageSource(nVccP, 0, brVccP, 15);
    const vsVccN = makeDcVoltageSource(nVccN, 0, brVccN, -15);

    const result = runDcOp({
      elements: [opampEl, rin, rf, vsVin as unknown as AnalogElement, vsInp as unknown as AnalogElement, vsVccP as unknown as AnalogElement, vsVccN as unknown as AnalogElement],
      matrixSize,
      nodeCount: 6,
    });

    expect(result.converged).toBe(true);
    const vOut = result.nodeVoltages[nOut - 1];
    // Ideal inverting gain = -Rf/Rin = -10 → Vout = -10V ± 0.05V
    expect(vOut).toBeCloseTo(-10, 1);
  });

  it("voltage_follower", () => {
    // Voltage follower: in- connected to out → Vout = Vin = 3.7V ± 0.001V
    //
    // Model: in- and out share the same node (node 2).
    // Node 1 = in+, node 2 = in- = out, node 3 = Vcc+, node 4 = Vcc-
    // Branches: brVin=4, brVccP=5, brVccN=6 → matrixSize = 7
    const nInp = 1, nFeedback = 2, nVccP = 3, nVccN = 4;
    const brVin = 4, brVccP = 5, brVccN = 6;
    const matrixSize = 7;

    const props = new PropertyBag([]);
    props.replaceModelParams({ gain: 1e6, rOut: 75 });
    // in- and out share nFeedback (voltage follower)
    const opampEl = withNodeIds(getFactory(OpAmpDefinition.modelRegistry!["behavioral"]!)(
      new Map([["in+", nInp], ["in-", nFeedback], ["out", nFeedback]]), [], -1, props, () => 0,
    ), [nFeedback, nInp, nFeedback]); // pinLayout order: [in-, in+, out]

    const vsVin  = makeDcVoltageSource(nInp,  0, brVin,  3.7);
    const vsVccP = makeDcVoltageSource(nVccP, 0, brVccP, 15);
    const vsVccN = makeDcVoltageSource(nVccN, 0, brVccN, -15);

    const result = runDcOp({
      elements: [opampEl, vsVin as unknown as AnalogElement, vsVccP as unknown as AnalogElement, vsVccN as unknown as AnalogElement],
      matrixSize,
      nodeCount: 4,
    });

    expect(result.converged).toBe(true);
    const vOut = result.nodeVoltages[nFeedback - 1];
    // Voltage follower: Vout = Vin = 3.7V ± 0.005V
    expect(vOut).toBeCloseTo(3.7, 2);
  });
});

// ---------------------------------------------------------------------------
// C4.5 parity test — opamp_load_dcop_parity
// ---------------------------------------------------------------------------
//
// Drives the ideal op-amp via load(ctx) at a canonical operating point (linear
// region, unsaturated) and asserts the stamped conductance matrix and RHS
// entries are bit-exact against the closed-form Norton approximation.
//
// Reference formulas (from opamp.ts createOpAmpElement):
//   G_out     = 1 / rOut
//   Effective = gain * srcFact
//   Stamp on nOut diagonal:  + G_out
//   Stamp on (nOut, nInp):   - Effective * G_out
//   Stamp on (nOut, nInn):   + Effective * G_out
//   RHS in linear region:      (nothing)
//
// Operating point is chosen with V_out inside the rails (linear region) so
// saturation is not triggered.

import type { LoadContext } from "../../../solver/analog/load-context.js";
import { OpAmpDefinition as _OpAmpDefinitionForParity } from "../opamp.js";

interface CaptureStamp { row: number; col: number; value: number; }
interface CaptureRhs { row: number; value: number; }
function makeCaptureSolver(): { solver: SparseSolverType; stamps: CaptureStamp[]; rhs: CaptureRhs[]; } {
  const stamps: CaptureStamp[] = [];
  const rhs: CaptureRhs[] = [];
  const handles: { row: number; col: number }[] = [];
  const handleIndex = new Map<string, number>();
  const solver = {
    stamp: (row: number, col: number, value: number) => {
      stamps.push({ row, col, value });
    },
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

function makeOpAmpParityCtx(voltages: Float64Array, solver: SparseSolverType): LoadContext {
  return {
    solver,
    voltages,
    iteration: 0,
    initMode: "initFloat",
    dt: 0,
    method: "trapezoidal",
    order: 1,
    deltaOld: [0, 0, 0, 0, 0, 0, 0],
    ag: new Float64Array(7),
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

describe("OpAmp parity (C4.5)", () => {
  it("opamp_load_dcop_parity", () => {
    // Canonical operating point: V+ = 1mV, V- = 0, V_out = 1V (within ±15V rails).
    // gain=1e6, rOut=75 (defaults).
    const nInp = 1, nInn = 2, nOut = 3;
    const opamp = getFactory(_OpAmpDefinitionForParity.modelRegistry!["behavioral"]!)(
      new Map([["in+", nInp], ["in-", nInn], ["out", nOut]]),
      [],
      -1,
      (() => {
        const props = new PropertyBag([]);
        props.replaceModelParams({ gain: 1e6, rOut: 75 });
        return props;
      })(),
      () => 0,
    );

    const voltages = new Float64Array(3);
    voltages[nInp - 1] = 1e-3;
    voltages[nInn - 1] = 0;
    voltages[nOut - 1] = 1.0; // linear region, between -15 and +15
    const { solver, stamps, rhs } = makeCaptureSolver();
    const ctx = makeOpAmpParityCtx(voltages, solver);
    opamp.load(ctx);

    // Closed-form reference (ngspice-equivalent Norton VCVS approximation):
    const NGSPICE_GAIN = 1e6;
    const NGSPICE_ROUT = 75;
    const NGSPICE_GOUT = 1 / NGSPICE_ROUT;
    const NGSPICE_EFF = NGSPICE_GAIN * 1; // srcFact = 1

    // Sum stamps by (row, col) — element may fold stamps through handle reuse.
    const outRow = nOut - 1;
    const sumAt = (row: number, col: number): number =>
      stamps.filter((s) => s.row === row && s.col === col)
            .reduce((a, s) => a + s.value, 0);
    expect(sumAt(outRow, outRow)).toBe(NGSPICE_GOUT);
    expect(sumAt(outRow, nInp - 1)).toBe(-NGSPICE_EFF * NGSPICE_GOUT);
    expect(sumAt(outRow, nInn - 1)).toBe(NGSPICE_EFF * NGSPICE_GOUT);

    // Linear region: no RHS stamps from the op-amp.
    const rhsAtOut = rhs.filter((r) => r.row === outRow);
    expect(rhsAtOut.length).toBe(0);
  });
});
