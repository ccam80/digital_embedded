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
import { makeLoadCtx, makeSimpleCtx } from "../../../solver/analog/__tests__/test-helpers.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { MODEDCOP, MODEINITFLOAT } from "../../../solver/analog/ckt-mode.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";

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
  gain?: number;
  rOut?: number;
}): AnalogElement {
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

    const branchRow = 101; // makeCur called first
    const vint = 102;      // makeVolt called second

    const simCtx = makeSimpleCtx({ elements: [opamp], matrixSize: 200, nodeCount: 3, startBranch: branchRow, startNode: vint });
    const solver = simCtx.solver;

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

    const branchRow = 101; // only makeCur called

    const simCtx = makeSimpleCtx({ elements: [opamp], matrixSize: 200, nodeCount: 3, startBranch: branchRow });
    const solver = simCtx.solver;

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
    // Circuit: Vin=2µV fixes in+, in- grounded, R_load=75Ω on output.
    // With gain=1e6 and rOut=75Ω: Vout ≈ 1V (voltage divider across rOut+R_load).
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "vin",  type: "DcVoltageSource", props: { voltage: 2e-6 } },
        { id: "vinn", type: "DcVoltageSource", props: { voltage: 0 } },
        { id: "rl",   type: "Resistor",        props: { resistance: 75 } },
        { id: "opamp", type: "OpAmp",          props: { gain: 1e6, rOut: 75 } },
        { id: "gnd",  type: "Ground" },
      ],
      connections: [
        ["vin:pos",  "opamp:in+"],
        ["vin:neg",  "gnd:out"],
        ["vinn:pos", "opamp:in-"],
        ["vinn:neg", "gnd:out"],
        ["opamp:out", "rl:A"],
        ["rl:B",     "gnd:out"],
      ],
    });
    const coordinator = facade.compile(circuit);
    const result = facade.getDcOpResult();
    expect(result?.converged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("Integration", () => {
  it("inverting_amplifier", () => {
    // Inverting amplifier: gain = -Rf/Rin = -10kΩ/1kΩ = -10
    // Vin = 1V → Vout ≈ -10V (clamped to supply rails if outside ±15V)
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "vin",   type: "DcVoltageSource", props: { voltage: 1.0 } },
        { id: "vinp",  type: "DcVoltageSource", props: { voltage: 0.0 } },
        { id: "rin",   type: "Resistor",        props: { resistance: 1000 } },
        { id: "rf",    type: "Resistor",        props: { resistance: 10000 } },
        { id: "opamp", type: "OpAmp",           props: { gain: 1e6, rOut: 75 } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vin:pos",   "rin:A"],
        ["rin:B",     "opamp:in-"],
        ["rf:A",      "opamp:in-"],
        ["rf:B",      "opamp:out"],
        ["vinp:pos",  "opamp:in+"],
        ["vin:neg",   "gnd:out"],
        ["vinp:neg",  "gnd:out"],
      ],
    });
    const coordinator = facade.compile(circuit);
    const result = facade.getDcOpResult();
    expect(result?.converged).toBe(true);
  });

  it("voltage_follower", () => {
    // Voltage follower: out fed back to in- via Rf, in+ driven by Vin=3.7V.
    // Expected: Vout ≈ Vin = 3.7V.
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "vin",   type: "DcVoltageSource", props: { voltage: 3.7 } },
        { id: "rf",    type: "Resistor",        props: { resistance: 10000 } },
        { id: "rg",    type: "Resistor",        props: { resistance: 10000 } },
        { id: "opamp", type: "OpAmp",           props: { gain: 1e6, rOut: 75 } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vin:pos",   "opamp:in+"],
        ["vin:neg",   "gnd:out"],
        ["opamp:out", "rf:A"],
        ["rf:B",      "opamp:in-"],
        ["rg:A",      "opamp:in-"],
        ["rg:B",      "gnd:out"],
      ],
    });
    const coordinator = facade.compile(circuit);
    const result = facade.getDcOpResult();
    expect(result?.converged).toBe(true);
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

    const branchRow = 101; // makeCur called first
    const vint = 102;      // makeVolt called second

    const simCtx = makeSimpleCtx({ elements: [opamp], matrixSize: 200, nodeCount: 3, startBranch: branchRow, startNode: vint });
    const solver = simCtx.solver;

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
