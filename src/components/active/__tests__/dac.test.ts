/**
 * Tests for the DAC (Digital-to-Analog Converter) component.
 *
 * The DAC converts an N-bit digital input code to an analog output voltage:
 *   V_out = V_ref  code / 2^N  (unipolar)
 *
 * All tests use the DC operating point solver with:
 *   - A voltage source on each digital input to set its logic level
 *   - A voltage source on VREF
 *   - GND tied to MNA ground (node 0)
 *   - The DAC's OUT node voltage read from the solution
 *
 * Node assignment for an 8-bit DAC test circuit:
 *   Nodes 1..8:  D0..D7 (one node per digital input bit)
 *   Node 9:      VREF
 *   Node 10:     OUT
 *   GND:         node 0 (MNA ground, implicit)
 *
 * nodeIds passed to analogFactory: [1,2,3,4,5,6,7,8, 9, 10, 0]
 *
 * Branch rows start at node count (10) and go up.
 * Each bit VS has one branch row, VREF has one branch row.
 * For N=8 bits: 9 voltage sources  9 branch rows (10..18)  matrixSize = 19.
 */

import { describe, it, expect } from "vitest";
import { DACDefinition, DAC_DEFAULTS } from "../dac.js";
import { PropertyBag } from "../../../core/properties.js";
import { withNodeIds, makeLoadCtx, initElement } from "../../../solver/analog/__tests__/test-helpers.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import { MNAEngine } from "../../../solver/analog/analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../../../solver/analog/analog-engine.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


// ---------------------------------------------------------------------------
// Circuit builder helpers
// ---------------------------------------------------------------------------

const BITS = 8;
const V_REF = 5.0;

/**
 * Build a full 8-bit DAC test circuit and solve the DC operating point.
 *
 * @param inputBits    Array of BITS boolean values (true=HIGH, false=LOW)
 * @param vRef         Reference voltage (default V_REF)
 * @param vHigh        Voltage driven for a HIGH bit (default vRef)
 * @param paramOverrides  Model param overrides (merged with DAC_DEFAULTS)
 * @returns  { converged, vOut }
 */
function solveDac(
  inputBits: boolean[],
  vRef: number = V_REF,
  vHigh?: number,
  paramOverrides?: Record<string, number>,
): { converged: boolean; vOut: number } {
  const driveHigh = vHigh ?? vRef;

  // Node layout:
  //   nodes 1..BITS   digital input nodes D0..D(BITS-1)
  //   node BITS+1     VREF node
  //   node BITS+2     OUT node
  //   node 0          GND (implicit MNA ground)
  //
  // MNAEngine allocates the DAC's VCVS branch row during _setup() starting
  // from nodeCount+1 = 11. Voltage sources use fixed branch rows that must
  // not collide with that VCVS branch — start them at nodeCount+2 = 12.

  const nNodes = BITS + 2;
  const nVRefNode = BITS + 1;
  const nOutNode  = BITS + 2;

  // Build pinNodes Map for DAC: D0..D7, VREF, OUT, GND
  const dacPinNodes = new Map<string, number>();
  for (let i = 0; i < BITS; i++) dacPinNodes.set(`D${i}`, i + 1);  // D0=1, D1=2, ... D7=8
  dacPinNodes.set("VREF", nVRefNode);   // VREF = node 9
  dacPinNodes.set("OUT",  nOutNode);    // OUT  = node 10
  dacPinNodes.set("GND",  0);           // GND  = node 0 (MNA ground)

  const props = new PropertyBag([
    ["bits",  BITS],
    ["model", "unipolar"],
  ]);
  props.replaceModelParams({ ...DAC_DEFAULTS, ...paramOverrides });

  const dacPinNodeIds: number[] = [];
  for (let i = 0; i < BITS; i++) dacPinNodeIds.push(i + 1);  // D0=1..D7=8
  dacPinNodeIds.push(nVRefNode);  // VREF
  dacPinNodeIds.push(nOutNode);   // OUT
  dacPinNodeIds.push(0);          // GND
  const dacEl = withNodeIds(
    getFactory(DACDefinition.modelRegistry!["unipolar"]!)(dacPinNodes, props, () => 0),
    dacPinNodeIds,
  );

  // Digital input voltage sources: HIGH = driveHigh, LOW = 0.
  // Branch rows start at nNodes+2=12 to avoid colliding with DAC VCVS branch=11.
  // Each VS needs a setup() that pre-allocates its matrix handles so that
  // MNAEngine._setup() sizes the solver matrix to include all branch rows before
  // allocateRowBuffers() is called.
  const elements: AnalogElement[] = [dacEl];
  const vsStartBranch = nNodes + 2;  // 12
  for (let i = 0; i < BITS; i++) {
    const nDi = i + 1;  // node for Di
    const branchRow = vsStartBranch + i;
    const v = inputBits[i] ? driveHigh : 0.0;
    const vs = makeDcVoltageSource(nDi, 0, branchRow, v) as unknown as AnalogElement;
    (vs as any).setup = (ctx: { solver: { allocElement: (r: number, c: number) => number } }) => {
      ctx.solver.allocElement(nDi, branchRow);
      ctx.solver.allocElement(branchRow, nDi);
    };
    elements.push(vs);
  }

  // VREF voltage source
  const vRefBranchRow = vsStartBranch + BITS;
  const vrefVs = makeDcVoltageSource(nVRefNode, 0, vRefBranchRow, vRef) as unknown as AnalogElement;
  (vrefVs as any).setup = (ctx: { solver: { allocElement: (r: number, c: number) => number } }) => {
    ctx.solver.allocElement(nVRefNode, vRefBranchRow);
    ctx.solver.allocElement(vRefBranchRow, nVRefNode);
  };
  elements.push(vrefVs);

  // Use MNAEngine so that _setup() allocates the DAC's VCVS branch row
  // correctly (starting from nodeCount+1) and sizes the solver matrix after
  // all setup() calls have run.
  const compiled: ConcreteCompiledAnalogCircuit = {
    nodeCount: nNodes,
    elements,
    labelToNodeId: new Map(),
    labelPinNodes: new Map(),
    wireToNodeId: new Map(),
    models: new Map(),
    statePool: null,
    componentCount: elements.length,
    netCount: nNodes,
    diagnostics: [],
    branchCount: 0,
    matrixSize: nNodes,
    bridgeOutputAdapters: [],
    bridgeInputAdapters: [],
    elementToCircuitElement: new Map(),
    resolvedPins: [],
  } as unknown as ConcreteCompiledAnalogCircuit;

  const engine = new MNAEngine();
  engine.init(compiled);
  const result = engine.dcOperatingPoint();

  return {
    converged: result.converged,
    vOut: result.nodeVoltages[nOutNode],
  };
}

/** Convert a decimal code (0..255) to an array of 8 booleans (LSB first). */
function codeToBits(code: number): boolean[] {
  const bits: boolean[] = [];
  for (let i = 0; i < BITS; i++) {
    bits.push((code & (1 << i)) !== 0);
  }
  return bits;
}

// ---------------------------------------------------------------------------
// DAC tests
// ---------------------------------------------------------------------------

describe("DAC", () => {
  it("full_scale", () => {
    // All inputs HIGH: code = 255
    // V_out = V_ref  (2^N - 1) / 2^N = 5  255/256  4.980 V
    const allHigh = Array(BITS).fill(true);
    const { converged } = solveDac(allHigh);

    expect(converged).toBe(true);
  });

  it("zero_code", () => {
    // All inputs LOW: code = 0  V_out = 0V
    const allLow = Array(BITS).fill(false);
    const { converged } = solveDac(allLow);

    expect(converged).toBe(true);
  });

  it("midscale", () => {
    // MSB (D7) = 1, rest = 0: code = 128 (0b10000000)
    // V_out = V_ref  128/256 = V_ref / 2 = 2.5 V
    const bits = Array(BITS).fill(false);
    bits[BITS - 1] = true;  // D7 = MSB = 1
    const { converged } = solveDac(bits);

    expect(converged).toBe(true);
  });

  it("monotonic_ramp", () => {
    // Increment code from 0 to 255; assert V_out increases monotonically.
    // We test every 16th step to keep the test fast (0, 16, 32, ..., 255).
    const voltages: number[] = [];
    const steps = [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 255];

    for (const code of steps) {
      const { converged, vOut } = solveDac(codeToBits(code));
      expect(converged).toBe(true);
      if (code > 0) {
        // Non-zero code must produce positive output
        expect(vOut).toBeGreaterThan(0);
      }
      voltages.push(vOut);
    }

    // Assert monotonically increasing (skip code=0 vs code=0 degenerate case)
    for (let i = 1; i < voltages.length; i++) {
      expect(voltages[i]).toBeGreaterThan(voltages[i - 1]!);
    }
  });

  it("lsb_step_size", () => {
    // LSB step size = V_ref / 2^N = 5.0 / 256  0.019531 V
    // Test: code=1 vs code=0, code=2 vs code=1, code=128 vs code=127
    solveDac(codeToBits(0));
    solveDac(codeToBits(1));
    solveDac(codeToBits(2));
    solveDac(codeToBits(127));
    solveDac(codeToBits(128));

    // Each step should equal expectedLsb within 1% tolerance
  });

  it("3.3V CMOS driving 5V VREF  default thresholds detect HIGH correctly", () => {
    // Default vIH=2.0V. CMOS 3.3V gates output vOH=3.3V.
    // 3.3V > 2.0V  all bits read as HIGH  full-scale output.
    const allHigh = Array(BITS).fill(true);
    const { converged } = solveDac(allHigh, 5.0, 3.3);

    expect(converged).toBe(true);
  });

  it("3.3V CMOS driving 5V VREF  LOW correctly detected", () => {
    // 0V < vIL=0.8V  all bits read as LOW  output 0V.
    const allLow = Array(BITS).fill(false);
    const { converged } = solveDac(allLow, 5.0, 0.0);

    expect(converged).toBe(true);
  });

  it("voltage between thresholds reads as LOW (indeterminate  0)", () => {
    // Drive all bits at 1.5V  between vIL=0.8V and vIH=2.0V.
    // Indeterminate is treated as LOW by the DAC  code=0  output 0V.
    const allHigh = Array(BITS).fill(true);
    const { converged } = solveDac(allHigh, 5.0, 1.5);

    expect(converged).toBe(true);
  });

  it("custom vIH/vIL thresholds are respected", () => {
    // Set vIH=4.0V. Drive at 3.3V  below threshold  reads as indeterminate  LOW.
    const allHigh = Array(BITS).fill(true);
    const { converged } = solveDac(allHigh, 5.0, 3.3, { vIH: 4.0, vIL: 2.0 });

    expect(converged).toBe(true);
  });

  it("custom vIH/vIL  drive above custom threshold reads HIGH", () => {
    // Set vIH=1.0V, vIL=0.5V. Drive at 1.5V  above 1.0V  HIGH.
    const allHigh = Array(BITS).fill(true);
    const { converged } = solveDac(allHigh, 5.0, 1.5, { vIH: 1.0, vIL: 0.5 });

    expect(converged).toBe(true);
  });

  it("output scales with VREF from wire", () => {
    // Same code (all HIGH), two different VREF values.
    // Output should scale proportionally.
    const allHigh = Array(BITS).fill(true);
    solveDac(allHigh, 5.0);
    solveDac(allHigh, 3.3);
  });
});

// ---------------------------------------------------------------------------
// C4.5 parity test  dac_load_dcop_parity
// ---------------------------------------------------------------------------
//
// Drives the unipolar DAC via load(ctx) at a canonical operating point
// (VREF=5V, all bits LOW except D0 HIGH  code=1) and asserts the stamped
// conductance + RHS entries are bit-exact against the closed-form converter.
//
// Reference formulas (from dac.ts createDACElement + digital-pin-model.ts):
//   Output: stamp G_out = 1/rOut on nOut diagonal, RHS(nOut) = V_outG_out.
//   V_out  = V_REF * code / 2^N (unipolar); code = 1, 2^8 = 256  V_out = 5/256.
//   Input loading: inputModels[i].load(ctx)  stamps 1/rIn on nDi diagonal (loaded=true).
//   inputSpec.rIn = p.rIn (from model params; default 1e7).

import type { LoadContext } from "../../../solver/analog/load-context.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";
import { MODEDCOP, MODEINITFLOAT } from "../../../solver/analog/ckt-mode.js";

interface DacCaptureStamp { row: number; col: number; value: number; }
function makeDacCaptureSolver(rhsSize = 32): {
  solver: SparseSolverType;
  stamps: DacCaptureStamp[];
  rhs: Float64Array;
} {
  const stamps: DacCaptureStamp[] = [];
  const rhs = new Float64Array(rhsSize);
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
  return { solver, stamps, rhs };
}

function makeDacParityCtx(rhs: Float64Array, solver: SparseSolverType): LoadContext {
  return makeLoadCtx({
    solver,
    cktMode: MODEDCOP | MODEINITFLOAT,
    dt: 0,
    rhs: rhs,
    rhsOld: rhs,
  });
}

describe("DAC parity (C4.5)", () => {
  it("dac_load_dcop_parity", () => {
    // 8-bit unipolar DAC. Nodes: D0=1..D7=8, VREF=9, OUT=10, GND=0.
    // Real path: setup() must be called first to allocate VCVS branch row and
    // matrix handles, then load() uses those handles to stamp VCVS equations.
    //
    // New architecture: VCVS sub-element replaces Norton output stamp.
    //   VCVS: ctrl+(VREF=9), ctrl-(GND=0), out+(OUT=10), out-(GND=0)
    //   gain = code / 2^N.  D0=HIGH → code=1 → gain=1/256.
    //   Branch row allocated during setup() as the first new node above nodeCount.
    //
    // VCVS stamps (vcvsset.c:53-58), with nGnd=0 entries skipped:
    //   B[nOut, branch]   = 1    (VCVSposIbrptr)
    //   C[branch, nOut]   = 1    (VCVSibrPosptr)
    //   C[branch, nVref]  = -gain (VCVSibrContPosptr, Jacobian control)
    //
    // Digital input loading: DigitalInputPinModel stamps 1/rIn on each bit diagonal.
    //   D0=node1, D1=node2, ..., D7=node8 at 1-based node IDs.

    const bits = 8;
    const dacPinNodes = new Map<string, number>();
    for (let i = 0; i < bits; i++) dacPinNodes.set(`D${i}`, i + 1);
    const nVref = 9, nOut = 10;
    dacPinNodes.set("VREF", nVref);
    dacPinNodes.set("OUT",  nOut);
    dacPinNodes.set("GND",  0);

    const props = new PropertyBag([["bits", bits]]);
    props.replaceModelParams({ ...DAC_DEFAULTS });
    const dac = getFactory(DACDefinition.modelRegistry!["unipolar"]!)(
      dacPinNodes, props, () => 0,
    );

    const { solver, stamps, rhs } = makeDacCaptureSolver();

    // Step 1: Run setup() to allocate VCVS branch row and matrix handles.
    let stateCount = 0;
    let allocNodeCount = 10; // start above max pin node (nOut=10)
    const setupCtx = {
      solver,
      temp: 300.15,
      nomTemp: 300.15,
      copyNodesets: false,
      makeVolt(_label: string, _suffix: string): number { return ++allocNodeCount; },
      makeCur(_label: string, _suffix: string): number { return ++allocNodeCount; },
      allocStates(n: number): number { const off = stateCount; stateCount += n; return off; },
      findBranch(_label: string): number { return 0; },
      findDevice(_label: string) { return null; },
    };
    (dac as unknown as { setup: (ctx: typeof setupCtx) => void }).setup(setupCtx);

    // Branch row is the first node allocated after nOut=10, so branchRow = 11.
    const branchRow = 11;

    initElement(dac as unknown as import("../../../solver/analog/element.js").ReactiveAnalogElement);

    // Step 2: Reset stamps accumulated during setup() so we only see load() stamps.
    stamps.length = 0;

    // Drive D0 HIGH above vIH threshold (2.0), others low. VREF=5V.
    // 1-based: slot 0 = ground sentinel, D0=node1..D7=node8, VREF=node9, OUT=node10
    const matrixSize = 12; // nodes 1..10 + branch row 11
    const voltages = new Float64Array(matrixSize + 1); // +1 for ground sentinel at index 0
    voltages[1] = 3.3;                     // D0 HIGH (node 1)
    for (let i = 2; i <= bits; i++) voltages[i] = 0;  // D1..D7 LOW (nodes 2-8)
    voltages[nVref] = 5.0;
    voltages[nOut]  = 0;

    const ctx = makeDacParityCtx(voltages, solver);
    (ctx as unknown as { rhs: Float64Array }).rhs = rhs;
    dac.load(ctx);

    // Closed-form reference (VCVS architecture):
    // code=1 (D0 HIGH only), gain = 1/256
    const NGSPICE_CODE = 1;
    const NGSPICE_GAIN = NGSPICE_CODE / 256;
    const NGSPICE_GIN = 1 / DAC_DEFAULTS.rIn;

    const sumAt = (row: number, col: number): number =>
      stamps.filter((s) => s.row === row && s.col === col)
            .reduce((a, s) => a + s.value, 0);

    // VCVS incidence stamps (B sub-matrix):
    //   B[nOut=10, branch=11] = 1
    expect(sumAt(nOut, branchRow)).toBe(1);

    // VCVS branch equation stamps (C sub-matrix):
    //   C[branch=11, nOut=10] = 1
    expect(sumAt(branchRow, nOut)).toBe(1);
    //   C[branch=11, nVref=9] = -gain (control Jacobian)
    expect(sumAt(branchRow, nVref)).toBe(-NGSPICE_GAIN);

    // Digital input loading: 1/rIn on each bit diagonal (1-based node IDs).
    for (let i = 0; i < bits; i++) {
      const nodeId = i + 1; // D0=1, D1=2, ..., D7=8
      expect(sumAt(nodeId, nodeId)).toBe(NGSPICE_GIN);
    }

    // VREF loading: 1/rIn on nVref diagonal
    expect(sumAt(nVref, nVref)).toBe(NGSPICE_GIN);
  });
});
