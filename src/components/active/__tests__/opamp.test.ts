/**
 * Tests for the Ideal Op-Amp component.
 *
 * Post-migration: VCVS+RES composite per PB-OPAMP spec.
 *   When rOut > 0: RES(vint,out) + VCVS(in+,in-,vint,gnd).
 *   When rOut == 0: VCVS(in+,in-,out,gnd) only.
 *
 * Unit tests verify the stamped conductance matrix entries via setup()+load().
 * Integration tests verify full DC operating point solutions via runDcOp().
 */

import { describe, it, expect } from "vitest";
import { OpAmpDefinition } from "../opamp.js";
import { PropertyBag } from "../../../core/properties.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import { withNodeIds, runDcOp, makeLoadCtx } from "../../../solver/analog/__tests__/test-helpers.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import type { SetupContext } from "../../../solver/analog/setup-context.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";
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
// Helper: run real setup() on a core element with a real SparseSolver.
// Node counter starts at 100 so internal nodes don't collide with pin nodes.
// Returns the solver (post-setup, handles allocated) and allocated node IDs.
// ---------------------------------------------------------------------------

interface SetupResult {
  solver: SparseSolver;
  firstNode: number;  // first node allocated by makeVolt/makeCur = 101
  secondNode: number; // second node allocated = 102
}

function runSetup(core: AnalogElementCore): SetupResult {
  const solver = new SparseSolver();
  solver._initStructure();
  let nodeCount = 100;
  const ctx: SetupContext = {
    solver,
    temp: 300.15,
    nomTemp: 300.15,
    copyNodesets: false,
    makeVolt(_label: string, _suffix: string): number { return ++nodeCount; },
    makeCur(_label: string, _suffix: string): number { return ++nodeCount; },
    allocStates(n: number): number { return 0; },
    findBranch(_label: string): number { return 0; },
    findDevice(_label: string) { return null; },
  };
  (core as { setup(ctx: SetupContext): void }).setup(ctx);
  return { solver, firstNode: 101, secondNode: 102 };
}

// ---------------------------------------------------------------------------
// Helper: create an op-amp element core
// ---------------------------------------------------------------------------

function makeOpAmp(opts: {
  nInp?: number;
  nInn?: number;
  nOut?: number;
  gain?: number;
  rOut?: number;
}): AnalogElementCore {
  const {
    nInp = 1,
    nInn = 2,
    nOut = 3,
    gain = 1e6,
    rOut = 75,
  } = opts;
  const props = new PropertyBag([]);
  props.replaceModelParams({ gain, rOut });
  return getFactory(OpAmpDefinition.modelRegistry!["behavioral"]!)(
    new Map([["in+", nInp], ["in-", nInn], ["out", nOut]]),
    props,
    () => 0,
  );
}

// ---------------------------------------------------------------------------
// Helper: read a value from sparse solver matrix at (extRow, extCol).
// Allocates (finding-or-creating) the element, reads _elVal[handle].
// Must be called before _resetForAssembly wipes values.
// ---------------------------------------------------------------------------

function readVal(solver: SparseSolver, extRow: number, extCol: number): number {
  const handle = solver.allocElement(extRow, extCol);
  return (solver as unknown as { _elVal: Float64Array })._elVal[handle];
}

// ---------------------------------------------------------------------------
// OpAmp unit tests  verify VCVS+RES stamp entries
// ---------------------------------------------------------------------------

describe("OpAmp", () => {
  it("linear_region_vcvs_stamps_with_rout", () => {
    // rOut=75: setup() calls makeCur (→101=branchRow) then makeVolt (→102=vint).
    // After load():
    //   RES (G=1/75): (vint,vint)=+G, (nOut,nOut)=+G, (vint,nOut)=-G, (nOut,vint)=-G
    //   VCVS: (vint,branch)=+1, (branch,vint)=+1, (branch,nInp)=-gain, (branch,nInn)=+gain
    const nInp = 1, nInn = 2, nOut = 3;
    const opamp = makeOpAmp({ nInp, nInn, nOut, gain: 1e6, rOut: 75 });

    const { solver } = runSetup(opamp);
    const branchRow = 101; // makeCur called first
    const vint = 102;      // makeVolt called second

    const voltages = new Float64Array(110);
    voltages[nInp] = 1e-3;
    voltages[nInn] = 0;
    voltages[nOut] = 1.0;
    voltages[vint] = 1.0;

    const rhs = new Float64Array(110);
    const ctx = makeLoadCtx({
      solver: solver as unknown as import("../../../solver/analog/sparse-solver.js").SparseSolver,
      rhs,
      rhsOld: voltages,
      cktMode: MODEDCOP | MODEINITFLOAT,
      dt: 0,
    });
    opamp.load(ctx);

    const G = 1 / 75;
    // RES stamps
    expect(readVal(solver, vint, vint)).toBeCloseTo(G, 10);
    expect(readVal(solver, nOut, nOut)).toBeCloseTo(G, 10);
    expect(readVal(solver, vint, nOut)).toBeCloseTo(-G, 10);
    expect(readVal(solver, nOut, vint)).toBeCloseTo(-G, 10);
    // VCVS stamps
    expect(readVal(solver, vint, branchRow)).toBeCloseTo(1, 10);
    expect(readVal(solver, branchRow, vint)).toBeCloseTo(1, 10);
    expect(readVal(solver, branchRow, nInp)).toBeCloseTo(-1e6, 5);
    expect(readVal(solver, branchRow, nInn)).toBeCloseTo(1e6, 5);
    // Linear region (srcFact=1 default): no RHS contributions
    expect(rhs[nOut]).toBe(0);
    expect(rhs[branchRow]).toBe(0);
  });

  it("linear_region_vcvs_stamps_no_rout", () => {
    // rOut=0: no internal node, setup() only calls makeCur (→101=branchRow).
    // VCVS stamps directly at nOut.
    const nInp = 1, nInn = 2, nOut = 3;
    const opamp = makeOpAmp({ nInp, nInn, nOut, gain: 1e6, rOut: 0 });

    const { solver } = runSetup(opamp);
    const branchRow = 101; // only makeCur called

    const voltages = new Float64Array(110);
    voltages[nInp] = 1e-3;
    voltages[nInn] = 0;
    voltages[nOut] = 1.0;

    const rhs = new Float64Array(110);
    const ctx = makeLoadCtx({
      solver: solver as unknown as import("../../../solver/analog/sparse-solver.js").SparseSolver,
      rhs,
      rhsOld: voltages,
      cktMode: MODEDCOP | MODEINITFLOAT,
      dt: 0,
    });
    opamp.load(ctx);

    // VCVS stamps at nOut directly (no RES)
    expect(readVal(solver, nOut, branchRow)).toBeCloseTo(1, 10);
    expect(readVal(solver, branchRow, nOut)).toBeCloseTo(1, 10);
    expect(readVal(solver, branchRow, nInp)).toBeCloseTo(-1e6, 5);
    expect(readVal(solver, branchRow, nInn)).toBeCloseTo(1e6, 5);
    // No RHS contributions
    expect(rhs[nOut]).toBe(0);
    expect(rhs[branchRow]).toBe(0);
  });

  it("output_impedance", () => {
    // Circuit: Vin=2µV fixes in+, in- grounded via VS, R_load=75Ω on output.
    // With VCVS gain=1e6 and rOut=75Ω: Vout_open = gain*Vin = 2V
    // With R_load = rOut = 75Ω: Vout ≈ 1V (voltage divider across rOut+R_load)
    //
    // MNA: nodes 1..5, branches 6..9
    // matrixSize = 1010: large to accommodate opamp internal nodes allocated
    // by setupElements starting at nodeCount=1000 → vint=1001, branch=1002.
    //   node 1 = in+, node 2 = in- (grounded via VS), node 3 = out
    //   node 4 = Vcc+, node 5 = Vcc-
    const nInp = 1, nInn = 2, nOut = 3, nVccP = 4, nVccN = 5;
    const brVin = 6, brVinn = 7, brVccP = 8, brVccN = 9;
    const matrixSize = 1010;

    const props = new PropertyBag([]);
    props.replaceModelParams({ gain: 1e6, rOut: 75 });
    const opampEl = withNodeIds(getFactory(OpAmpDefinition.modelRegistry!["behavioral"]!)(
      new Map([["in+", nInp], ["in-", nInn], ["out", nOut]]), props, () => 0,
    ), [nInn, nInp, nOut]);

    // 75Ω load on output
    const G_load = 1 / 75;
    const rLoadEl: AnalogElement = {
      pinNodeIds: [nOut, 0],
      allNodeIds: [nOut, 0],
      branchIndex: -1, isNonlinear: false, isReactive: false,
      setParam(_key: string, _value: number): void {},
      getPinCurrents(): number[] { return []; },
      ngspiceLoadOrder: 0,
      load(ctx): void {
        const h = ctx.solver.allocElement(nOut, nOut);
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
      branchCount: matrixSize - 5,
    });

    expect(result.converged).toBe(true);
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
      ngspiceLoadOrder: 0,
      load(ctx): void {
        const { solver } = ctx;
        if (nodeA > 0) { const h = solver.allocElement(nodeA, nodeA); solver.stampElement(h, G); }
        if (nodeB > 0) { const h = solver.allocElement(nodeB, nodeB); solver.stampElement(h, G); }
        if (nodeA > 0 && nodeB > 0) {
          const hab = solver.allocElement(nodeA, nodeB); solver.stampElement(hab, -G);
          const hba = solver.allocElement(nodeB, nodeA); solver.stampElement(hba, -G);
        }
      },
    };
  }

  it("inverting_amplifier", () => {
    // Inverting amplifier: gain = -Rf/Rin = -10kΩ/1kΩ = -10
    // Vin = 1V  Vout ≈ -10V
    //
    // Node assignments:
    //   node 1 = Vin terminal
    //   node 2 = in- (inverting, virtual ground)
    //   node 3 = out
    //   node 4 = in+ (grounded via VS)
    //   node 5 = Vcc+
    //   node 6 = Vcc-
    // Branch rows: 7..10  matrixSize = 1010 (large to accommodate opamp internal
    // nodes allocated by setupElements starting at nodeCount=1000 → vint=1001, branch=1002)
    const nVin = 1, nInn = 2, nOut = 3, nInp = 4, nVccP = 5, nVccN = 6;
    const brVin = 7, brInp = 8, brVccP = 9, brVccN = 10;
    const matrixSize = 1010;

    const props = new PropertyBag([]);
    props.replaceModelParams({ gain: 1e6, rOut: 75 });
    const opampEl = withNodeIds(getFactory(OpAmpDefinition.modelRegistry!["behavioral"]!)(
      new Map([["in+", nInp], ["in-", nInn], ["out", nOut]]), props, () => 0,
    ), [nInn, nInp, nOut]);

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
      branchCount: matrixSize - 6,
    });

    expect(result.converged).toBe(true);
  });

  it("voltage_follower", () => {
    // Voltage follower: in- connected to out via resistor Rf, in+ driven by Vin.
    // Topology: Vin → in+ (node1), out (node2) → in- (node3) via Rf=10kΩ,
    // in- also pulled to ground via Rg=10kΩ. Expected: Vout ≈ Vin = 3.7V.
    //
    // Use separate nodes for in- and out to avoid floating-node singularity.
    // Nodes: 1=in+, 2=out, 3=in-, 4=Vcc+, 5=Vcc-
    // Branches: brVin=6, brVccP=7, brVccN=8
    // matrixSize = 1010: large to accommodate internal nodes (vint=1001, branch=1002)
    // allocated by setupElements starting at nodeCount=1000.
    const nInp = 1, nOut = 2, nInn = 3, nVccP = 4, nVccN = 5;
    const brVin = 6, brVccP = 7, brVccN = 8;
    const matrixSize = 1010;

    const props = new PropertyBag([]);
    props.replaceModelParams({ gain: 1e6, rOut: 75 });
    const opampEl = withNodeIds(getFactory(OpAmpDefinition.modelRegistry!["behavioral"]!)(
      new Map([["in+", nInp], ["in-", nInn], ["out", nOut]]), props, () => 0,
    ), [nInn, nInp, nOut]);

    // Rf connects out to in- (feedback); Rg grounds in-
    const rf = makeResistor(nOut, nInn, 10000);
    const rg = makeResistor(nInn, 0, 10000);

    const vsVin  = makeDcVoltageSource(nInp,  0, brVin,  3.7);
    const vsVccP = makeDcVoltageSource(nVccP, 0, brVccP, 15);
    const vsVccN = makeDcVoltageSource(nVccN, 0, brVccN, -15);

    const elements = [opampEl, rf, rg, vsVin as unknown as AnalogElement, vsVccP as unknown as AnalogElement, vsVccN as unknown as AnalogElement];
    // Use makeSimpleCtx so we can patch the dcop snapshot buffers to match the
    // empty statePool (numStates=0) before dynamicGmin runs its save/restore.
    const ctx = makeSimpleCtx({ elements, matrixSize, nodeCount: 5, branchCount: matrixSize - 5 });
    // Resize dcop snapshot buffers from max(0,1)=1 to 0 to match empty statePool.
    ctx.dcopSavedState0 = new Float64Array(0);
    ctx.dcopOldState0   = new Float64Array(0);
    solveDcOperatingPoint(ctx);

    expect(ctx.dcopResult.converged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C4.5 parity test  opamp_load_dcop_parity
// ---------------------------------------------------------------------------
//
// Drives the ideal op-amp via setup()+load() at a canonical operating point
// (linear region, unsaturated) and asserts the stamped conductance matrix
// entries are correct for the VCVS+RES composite.
//
// Post-migration model (rOut=75):
//   setup() order: makeCur first (branch=101), makeVolt second (vint=102).
//   RES(vint,nOut): G=1/75 stamps at (vint,vint),(nOut,nOut),(vint,nOut),(nOut,vint)
//   VCVS: stamps (vint,branch)=1, (branch,vint)=1, (branch,nInp)=-gain, (branch,nInn)=+gain.

describe("OpAmp parity (C4.5)", () => {
  it("opamp_load_dcop_parity", () => {
    const nInp = 1, nInn = 2, nOut = 3;
    const opampProps = new PropertyBag([]);
    opampProps.replaceModelParams({ gain: 1e6, rOut: 75 });
    const opamp = getFactory(OpAmpDefinition.modelRegistry!["behavioral"]!)(
      new Map([["in+", nInp], ["in-", nInn], ["out", nOut]]),
      opampProps,
      () => 0,
    );

    const { solver } = runSetup(opamp);
    const branchRow = 101; // makeCur called first
    const vint = 102;      // makeVolt called second

    const voltages = new Float64Array(110);
    voltages[nInp] = 1e-3;
    voltages[nInn] = 0;
    voltages[nOut] = 1.0;
    voltages[vint] = 1.0;

    const rhs = new Float64Array(110);
    const ctx = makeLoadCtx({
      solver: solver as unknown as import("../../../solver/analog/sparse-solver.js").SparseSolver,
      rhs,
      rhsOld: voltages,
      cktMode: MODEDCOP | MODEINITFLOAT,
      dt: 0,
    });
    opamp.load(ctx);

    const GAIN = 1e6;
    const ROUT = 75;
    const G = 1 / ROUT;

    // RES stamps (ressetup.c:46-49): G between vint and nOut.
    expect(readVal(solver, vint, vint)).toBeCloseTo(G, 10);
    expect(readVal(solver, nOut, nOut)).toBeCloseTo(G, 10);
    expect(readVal(solver, vint, nOut)).toBeCloseTo(-G, 10);
    expect(readVal(solver, nOut, vint)).toBeCloseTo(-G, 10);

    // VCVS stamps: enforce vint - gain*(in+ - in-) = 0.
    expect(readVal(solver, vint, branchRow)).toBeCloseTo(1, 10);
    expect(readVal(solver, branchRow, vint)).toBeCloseTo(1, 10);
    expect(readVal(solver, branchRow, nInp)).toBeCloseTo(-GAIN, 5);
    expect(readVal(solver, branchRow, nInn)).toBeCloseTo(GAIN, 5);

    // Linear region (srcFact=1): no RHS contribution at output nodes.
    expect(rhs[nOut]).toBe(0);
    expect(rhs[branchRow]).toBe(0);
  });
});
