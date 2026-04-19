/**
 * Tests for Optocoupler analog element.
 *
 * Circuit conventions:
 *   - Input side: voltage source drives LED anode; cathode to GND.
 *   - Output side: voltage source drives collector; emitter to GND.
 *     Current through the load resistor on the collector side represents I_C.
 *
 * Key test: galvanic isolation — the output-side ground can be at any
 * potential independently of the input side. No shared nodes.
 *
 * Node numbering varies per test. General pattern:
 *   Input:  node 1 = anode (driven by Vs_in + R_series), node 2 = cathode
 *   Output: node 3 = collector, node 4 = emitter (often GND=0)
 */

import { describe, it, expect } from "vitest";
import { ConcreteCompiledAnalogCircuit } from "../../../solver/analog/compiled-analog-circuit.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import { MNAEngine } from "../../../solver/analog/analog-engine.js";
import { makeResistor, makeVoltageSource, withNodeIds } from "../../../solver/analog/__tests__/test-helpers.js";
import { OptocouplerDefinition } from "../optocoupler.js";
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

function makeOptocouplerElement(
  nAnode: number,
  nCathode: number,
  nCollector: number,
  nEmitter: number,
  opts: { ctr?: number; vForward?: number; rLed?: number } = {},
): AnalogElement {
  const ctr      = opts.ctr      ?? 1.0;
  const vForward = opts.vForward ?? 1.2;
  const rLed     = opts.rLed     ?? 10;
  const props = new PropertyBag(new Map<string, import("../../../core/properties.js").PropertyValue>([
    ["vceSat",   0.3],
    ["bandwidth", 50000],
    ["label",    ""],
  ]).entries());
  props.replaceModelParams({ ctr, vForward, rLed });
  return withNodeIds(
    getFactory(OptocouplerDefinition.modelRegistry!["behavioral"]!)(
      new Map([["anode", nAnode], ["cathode", nCathode], ["collector", nCollector], ["emitter", nEmitter]]),
      [],
      -1,
      props,
      () => 0,
    ),
    [nAnode, nCathode, nCollector, nEmitter],
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
// Optocoupler tests
// ---------------------------------------------------------------------------

describe("Optocoupler", () => {
  it("current_transfer", () => {
    // Input: V_in = 1.3V, R_series = 10Ω, V_F = 1.2V → I_LED = (1.3-1.2)/10 = 10mA
    // CTR = 1.0 → I_C = 10mA
    // Output: V_supply = 5V, R_load = 100Ω from supply to collector, emitter to GND
    //   I_C = 10mA flows from collector to emitter
    //   V_collector = V_supply - I_C * R_load = 5 - 10e-3 * 100 = 4V...
    //
    // Simpler model: collector is driven by a current source equal to I_C.
    // Use: Vs_out drives collector node; R_load from collector to GND measures I_C.
    //
    // Circuit:
    //   Input: Vs_in = 1.3V driving node1 (anode), cathode = GND (0).
    //          The LED forward-drops 1.2V; R_LED = 10Ω in optocoupler model.
    //          I_LED = (1.3 - 1.2) / 10 = 10mA.
    //
    //   Output: R_load = 1000Ω from collector (node2) to GND.
    //          I_C = CTR * I_LED = 10mA → V(node2) = I_C * R_load = 10V
    //
    // nodeCount=2: 1=anode, 2=collector
    // branchCount=1: row 2 for Vs_in
    const nodeCount  = 2;
    const branchCount = 1;
    const vsBranch   = nodeCount + 0; // row 2

    const vIn   = 1.3;  // V_in > V_forward = 1.2V to forward-bias LED
    const rLed  = 10;   // LED series R in optocoupler
    const vF    = 1.2;  // forward voltage
    const rLoad = 1000; // load on collector

    const vs   = makeVoltageSource(1, 0, vsBranch, vIn);
    const opto = makeOptocouplerElement(1, 0, 2, 0, { ctr: 1.0, vForward: vF, rLed });
    const rL   = makeResistor(2, 0, rLoad);

    const compiled = buildCircuit({ nodeCount, branchCount, elements: [vs, opto, rL] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);

    // I_LED = (V_in - V_F) / R_LED = (1.3 - 1.2) / 10 = 10mA
    const iLed = (vIn - vF) / rLed;
    // I_C = CTR * I_LED = 10mA
    // V(collector) = I_C * R_load = 10mA * 1000 = 10V
    const vCollectorExpected = iLed * rLoad;
    expect(result.nodeVoltages[1]).toBeCloseTo(vCollectorExpected, 2);
  });

  it("galvanic_isolation", () => {
    // Verify I_collector is the same regardless of output-side ground potential.
    //
    // Test at output-side ground = 0V and output-side ground = 100V offset.
    // The LED current is fixed at 10mA (same input circuit).
    // I_C should be ≈ 10mA in both cases.
    //
    // Case 1: emitter at GND (0V) — standard.
    // Case 2: emitter at 100V (driven by a voltage source from emitter to GND).
    //
    // In case 2, node layout:
    //   1=anode (input), 2=collector, 3=emitter (at 100V)
    //   Vs_in: node1→GND [branch row 3]
    //   Vs_emitter: node3→GND [branch row 4], voltage=100V
    //   R_load from collector(node2) to emitter(node3)
    //
    // I_C = CTR * I_LED regardless of emitter potential.
    // V(collector) - V(emitter) = I_C * R_load
    // V(collector) = 100 + I_C * R_load

    const vF    = 1.2;
    const rLed  = 10;
    const vIn   = 1.3;
    const rLoad = 1000;
    const iLedExpected = (vIn - vF) / rLed; // 10mA

    // Case 1: standard (emitter = GND)
    function runCase1(): number {
      const nodeCount   = 2;
      const branchCount = 1;
      const vsBranch    = nodeCount + 0;

      const vs   = makeVoltageSource(1, 0, vsBranch, vIn);
      const opto = makeOptocouplerElement(1, 0, 2, 0, { ctr: 1.0, vForward: vF, rLed });
      const rL   = makeResistor(2, 0, rLoad);

      const compiled = buildCircuit({ nodeCount, branchCount, elements: [vs, opto, rL] });
      const engine = new MNAEngine();
      engine.init(compiled);
      const result = engine.dcOperatingPoint();
      expect(result.converged).toBe(true);
      // I_C = V(collector) / R_load
      return result.nodeVoltages[1] / rLoad;
    }

    // Case 2: emitter at 100V offset
    function runCase2(): number {
      const nodeCount   = 3;   // 1=anode, 2=collector, 3=emitter
      const branchCount = 2;   // branch rows: 3=Vs_in, 4=Vs_emitter
      const vsBranchIn      = nodeCount + 0; // row 3
      const vsBranchEmitter = nodeCount + 1; // row 4

      const vsIn      = makeVoltageSource(1, 0, vsBranchIn,      vIn);
      const vsEmitter = makeVoltageSource(3, 0, vsBranchEmitter,  100); // emitter at 100V
      const opto      = makeOptocouplerElement(1, 0, 2, 3, { ctr: 1.0, vForward: vF, rLed });
      const rL        = makeResistor(2, 3, rLoad); // R_load from collector to emitter

      const compiled = buildCircuit({ nodeCount, branchCount, elements: [vsIn, vsEmitter, opto, rL] });
      const engine = new MNAEngine();
      engine.init(compiled);
      const result = engine.dcOperatingPoint();
      expect(result.converged).toBe(true);
      // I_C = (V(collector) - V(emitter)) / R_load
      const vCollector = result.nodeVoltages[1];
      const vEmitter   = result.nodeVoltages[2];
      return (vCollector - vEmitter) / rLoad;
    }

    const iC1 = runCase1();
    const iC2 = runCase2();

    // Both cases should give the same I_C regardless of output-side potential
    expect(iC1).toBeCloseTo(iLedExpected, 3);
    expect(iC2).toBeCloseTo(iLedExpected, 3);
  });

  it("led_forward_voltage", () => {
    // Input voltage below V_forward → LED does not conduct → I_C ≈ 0.
    //
    // V_in = 0.5V < V_F = 1.2V → LED off → I_LED ≈ 0 → I_C ≈ 0 → V(collector) ≈ 0
    const nodeCount   = 2;
    const branchCount = 1;
    const vsBranch    = nodeCount + 0;

    const vsBelow = makeVoltageSource(1, 0, vsBranch, 0.5);
    const opto    = makeOptocouplerElement(1, 0, 2, 0, { ctr: 1.0, vForward: 1.2, rLed: 10 });
    const rLoad   = makeResistor(2, 0, 1000);

    const compiled = buildCircuit({ nodeCount, branchCount, elements: [vsBelow, opto, rLoad] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    // V_in < V_F → LED off → I_C ≈ 0 → V(collector) ≈ 0
    expect(result.nodeVoltages[1]).toBeCloseTo(0, 3);
  });

  it("zero_input_zero_output", () => {
    // V_in = 0V → I_LED = 0 → I_C = 0 → V(collector) = 0
    const nodeCount   = 2;
    const branchCount = 1;
    const vsBranch    = nodeCount + 0;

    const vs    = makeVoltageSource(1, 0, vsBranch, 0.0);
    const opto  = makeOptocouplerElement(1, 0, 2, 0, { ctr: 1.0, vForward: 1.2, rLed: 10 });
    const rLoad = makeResistor(2, 0, 1000);

    const compiled = buildCircuit({ nodeCount, branchCount, elements: [vs, opto, rLoad] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(result.nodeVoltages[1]).toBeCloseTo(0, 4);
  });

  it("ctr_scaling", () => {
    // CTR = 0.5; I_LED = 20mA → I_C = 0.5 * 20mA = 10mA
    //
    // Input: V_in = 1.4V, V_F = 1.2V, R_LED = 10Ω
    //   I_LED = (1.4 - 1.2) / 10 = 20mA
    // Output: R_load = 1000Ω
    //   I_C = CTR * I_LED = 0.5 * 20mA = 10mA
    //   V(collector) = I_C * R_load = 10mA * 1000 = 10V
    const nodeCount   = 2;
    const branchCount = 1;
    const vsBranch    = nodeCount + 0;

    const vIn   = 1.4;
    const vF    = 1.2;
    const rLed  = 10;
    const rLoad = 1000;

    const vs    = makeVoltageSource(1, 0, vsBranch, vIn);
    const opto  = makeOptocouplerElement(1, 0, 2, 0, { ctr: 0.5, vForward: vF, rLed });
    const rL    = makeResistor(2, 0, rLoad);

    const compiled = buildCircuit({ nodeCount, branchCount, elements: [vs, opto, rL] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);

    const iLed = (vIn - vF) / rLed;          // 20mA
    const iC   = 0.5 * iLed;                  // 10mA
    const vCollectorExpected = iC * rLoad;     // 10V

    expect(result.nodeVoltages[1]).toBeCloseTo(vCollectorExpected, 2);
  });
});

// ---------------------------------------------------------------------------
// C4.5 parity test — optocoupler_load_dcop_parity
// ---------------------------------------------------------------------------
//
// Drives the optocoupler via load(ctx) at a canonical forward-biased operating
// point and asserts LED + phototransistor stamps are bit-exact.
//
// Reference formulas (from optocoupler.ts createOptocouplerElement):
//   vd     = vA - vK
//   On  (vd >= vF): gLed = 1/rLed, iNR = gLed * vForward
//   Off (vd <  vF): gLed = G_OFF = 1e-9, iNR = 0
//   LED stamps:
//     (nA, nA) += gLed, (nA, nK) -= gLed, (nK, nA) -= gLed, (nK, nK) += gLed
//   LED RHS:
//     nA -= iNR, nK += iNR
//   Phototransistor (CCCS: I_C = CTR * I_LED):
//     iLed0 = gLed * vd - iNR
//     iC0   = CTR * iLed0
//     gmCtr = CTR * gLed
//     iCnr  = iC0 - gmCtr * vd
//     (nC, nA) -= gmCtr, (nC, nK) += gmCtr
//     (nE, nA) += gmCtr, (nE, nK) -= gmCtr
//   Phototransistor RHS:
//     nC += iCnr, nE -= iCnr

import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";

interface OptoCaptureStamp { row: number; col: number; value: number; }
interface OptoCaptureRhs { row: number; value: number; }
function makeOptoCaptureSolver(): {
  solver: SparseSolverType;
  stamps: OptoCaptureStamp[];
  rhs: OptoCaptureRhs[];
} {
  const stamps: OptoCaptureStamp[] = [];
  const rhs: OptoCaptureRhs[] = [];
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

function makeOptoParityCtx(voltages: Float64Array, solver: SparseSolverType): LoadContext {
  return {
    solver,
    voltages,
    iteration: 0,
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
<<<<<<< HEAD

    isTransientDcop: false,

=======
>>>>>>> e427e072 (D4: add isAc flag and pass LoadContext to stampAc (ngspice alignment))
    isAc: false,
    xfact: 1,
    gmin: 1e-12,
    uic: false,
    reltol: 1e-3,
    iabstol: 1e-12,
  };
}

describe("Optocoupler parity (C4.5)", () => {
  it("optocoupler_load_dcop_parity", () => {
    const nA = 1, nK = 2, nC = 3, nE = 4;
    const ctr = 0.5;
    const vForward = 1.2;
    const rLed = 10;
    const opto = makeOptocouplerElement(nA, nK, nC, nE, { ctr, vForward, rLed });

    // Forward bias: vd = 3 - 0 = 3 > vForward → on
    const voltages = new Float64Array(4);
    voltages[nA - 1] = 3;
    voltages[nK - 1] = 0;
    voltages[nC - 1] = 5;
    voltages[nE - 1] = 0;

    const { solver, stamps, rhs } = makeOptoCaptureSolver();
    const ctx = makeOptoParityCtx(voltages, solver);
    opto.load(ctx);

    // Closed-form reference:
    const NGSPICE_VD    = 3 - 0;
    const NGSPICE_GLED  = 1 / rLed;
    const NGSPICE_INR   = NGSPICE_GLED * vForward;
    const NGSPICE_ILED0 = NGSPICE_GLED * NGSPICE_VD - NGSPICE_INR;
    const NGSPICE_IC0   = ctr * NGSPICE_ILED0;
    const NGSPICE_GMCTR = ctr * NGSPICE_GLED;
    const NGSPICE_ICNR  = NGSPICE_IC0 - NGSPICE_GMCTR * NGSPICE_VD;

    const sumAt = (row: number, col: number): number =>
      stamps.filter((s) => s.row === row && s.col === col)
            .reduce((a, s) => a + s.value, 0);

    // LED stamps
    expect(sumAt(nA - 1, nA - 1)).toBe(NGSPICE_GLED);
    expect(sumAt(nK - 1, nK - 1)).toBe(NGSPICE_GLED);
    expect(sumAt(nA - 1, nK - 1)).toBe(-NGSPICE_GLED);
    expect(sumAt(nK - 1, nA - 1)).toBe(-NGSPICE_GLED);

    // Phototransistor cross-port stamps
    expect(sumAt(nC - 1, nA - 1)).toBe(-NGSPICE_GMCTR);
    expect(sumAt(nC - 1, nK - 1)).toBe(NGSPICE_GMCTR);
    expect(sumAt(nE - 1, nA - 1)).toBe(NGSPICE_GMCTR);
    expect(sumAt(nE - 1, nK - 1)).toBe(-NGSPICE_GMCTR);

    // RHS stamps (bit-exact)
    const rhsA = rhs.filter((r) => r.row === nA - 1).reduce((a, r) => a + r.value, 0);
    const rhsK = rhs.filter((r) => r.row === nK - 1).reduce((a, r) => a + r.value, 0);
    const rhsC = rhs.filter((r) => r.row === nC - 1).reduce((a, r) => a + r.value, 0);
    const rhsE = rhs.filter((r) => r.row === nE - 1).reduce((a, r) => a + r.value, 0);
    expect(rhsA).toBe(-NGSPICE_INR);
    expect(rhsK).toBe(NGSPICE_INR);
    expect(rhsC).toBe(NGSPICE_ICNR);
    expect(rhsE).toBe(-NGSPICE_ICNR);
  });
});
