import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  DLL_PATH,
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// .dts paths (T3 harness fixtures)
// ---------------------------------------------------------------------------

const DTS_BLOCKING  = path.resolve("src/components/semiconductors/__tests__/fixtures/diac-canon-blocking.dts");
const DTS_BREAKOVER = path.resolve("src/components/semiconductors/__tests__/fixtures/diac-canon-breakover.dts");

// ---------------------------------------------------------------------------
// DIAC parameter profile shared across T1 fixtures
// ---------------------------------------------------------------------------
//
// DIAC behaviour: block until |V| > BV (breakover voltage); above BV the
// device conducts. We suppress the forward-Shockley conduction so that
// the breakdown branch is the only mechanism that puts current through
// the device:
//   IS = 1e-32 (forward saturation current, very small)
//   N  = 40    (stretches the forward knee far above any test voltage)
//   BV = 32    (breakover voltage)
//
// These same numeric defaults seed the Diac netlist's diode sub-elements
// when a `Diac` component is placed in a programmatic build. Identical
// values are baked into the .dts fixtures via circuit_build.

const DIAC_PROPS: Record<string, number | string> = {
  label: "diac",
  IS: 1e-32,
  N: 40,
  BV: 32,
};

// ---------------------------------------------------------------------------
// Programmatic circuit factories (T1)
// ---------------------------------------------------------------------------

interface DiacCircuitParams {
  /** Voltage applied across the diac+sense pair. Sign selects polarity. */
  vSource: number;
  /** Sense resistor (Ω). 1Ω chosen so V_sense ≈ I_diac (in Amps). */
  rSense: number;
}

/**
 * VS:pos → Diac:A → Diac:B → rsense:pos → rsense:neg = GND ; VS:neg = GND.
 *
 * The diac is a netlist composite of two anti-parallel diodes, so the
 * observable is the public node voltage at `diac:B`. With rsense:neg
 * tied to ground, the rsense voltage drop equals V(diac:B), and current
 * through the diac equals V(diac:B) / rSense.
 */
function buildDiacCircuit(facade: DefaultSimulatorFacade, p: DiacCircuitParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",     type: "DcVoltageSource", props: { label: "vs",     voltage: p.vSource } },
      { id: "diac",   type: "Diac",            props: { ...DIAC_PROPS } },
      { id: "rsense", type: "Resistor",        props: { label: "rsense", resistance: p.rSense } },
      { id: "gnd",    type: "Ground" },
    ],
    connections: [
      ["vs:pos",     "diac:A"],
      ["diac:B",     "rsense:pos"],
      ["rsense:neg", "gnd:out"],
      ["vs:neg",     "gnd:out"],
    ],
  });
}

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// Post-warm-start: node voltages at the diac terminals are produced by
// _setup() + _transientDcop(). The Diac element is a netlist composite
// (no own state slots — its sub-element diodes hold the slots), so the
// canonical Cat 1 observable is the public node-voltage reading at the
// step-0 boundary.
// ---------------------------------------------------------------------------

describe("Diac initialization (T1)", () => {
  it("init_blocking_node_voltage_near_zero", () => {
    // |V|=20V < BV=32V → blocking regime → V(diac:B) ≈ 0V (negligible
    // current through R_sense=1Ω since the diac sinks <1mA in blocking).
    const fix = buildFixture({
      build: (_r, facade) => buildDiacCircuit(facade, { vSource: 20, rSense: 1.0 }),
    });
    const vB = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("diac:B")!);
    // Blocking: V_sense = I_diac * 1Ω with I_diac < 1mA → |V_sense| < 1mV.
    expect(Math.abs(vB)).toBeLessThan(1e-3);
  });

  it("init_blocking_anode_voltage_tracks_source", () => {
    // |V|=20V < BV=32V → blocking → effectively open circuit between A and B
    // → V(diac:A) ≈ vSource (negligible IR drop).
    const fix = buildFixture({
      build: (_r, facade) => buildDiacCircuit(facade, { vSource: 20, rSense: 1.0 }),
    });
    const vA = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("diac:A")!);
    expect(vA).toBeCloseTo(20, 2);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point (T1, analytical)
// Two regimes: sub-BV (blocking) and post-BV (breakover). Both use the
// public engine surface (node voltage). The closed-form expectation is
// derived in a comment beside each assertion.
// ---------------------------------------------------------------------------

describe("Diac DCOP — blocking + breakover (T1)", () => {
  it("dcop_blocking_current_below_one_milliamp", () => {
    // |V|=20V < BV=32V → blocking. R_sense=1kΩ.
    // Closed-form: I_diac = V(diac:B) / R_sense, with V(diac:B) ≈ 0
    // and I_diac ≪ 1mA (the IS=1e-32, N=40 profile suppresses Shockley
    // conduction; sub-BV the only current is the leakage from the
    // reverse-biased anti-parallel diode).
    const fix = buildFixture({
      build: (_r, facade) => buildDiacCircuit(facade, { vSource: 20, rSense: 1000 }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    const vB = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("diac:B")!);
    const iDiac = vB / 1000;
    expect(Math.abs(iDiac)).toBeLessThan(1e-3);
  });

  it("dcop_breakover_conducts_above_threshold", () => {
    // |V|=40V > BV=32V → reverse breakdown of the reverse-biased internal
    // diode → conduction path. R_sense=10Ω.
    // Closed-form bound: post-breakdown I_diac ≈ (vSource - BV) / rSense
    // = (40 - 32) / 10 = 0.8A. We require > 0.1A to confirm the device
    // is past the breakover knee (the exact post-breakdown current depends
    // on the breakdown emission coefficient and IBV defaults of the
    // sub-element diodes; the floor is the conservative analytical bound).
    const fix = buildFixture({
      build: (_r, facade) => buildDiacCircuit(facade, { vSource: 40, rSense: 10 }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    const vB = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("diac:B")!);
    const iDiac = vB / 10;
    expect(iDiac).toBeGreaterThan(0.1);
    // Polarity: vs:pos drives +V into diac:A → current flows A→B (positive).
    expect(iDiac).toBeGreaterThan(0);
  });

  it("dcop_breakover_symmetric_under_polarity_flip", () => {
    // Anti-parallel topology → identical |I| for ±vSource.
    const fixPos = buildFixture({
      build: (_r, facade) => buildDiacCircuit(facade, { vSource: +40, rSense: 10 }),
    });
    const fixNeg = buildFixture({
      build: (_r, facade) => buildDiacCircuit(facade, { vSource: -40, rSense: 10 }),
    });
    expect(fixPos.coordinator.dcOperatingPoint()!.converged).toBe(true);
    expect(fixNeg.coordinator.dcOperatingPoint()!.converged).toBe(true);

    const iPos = fixPos.engine.getNodeVoltage(fixPos.circuit.labelToNodeId.get("diac:B")!) / 10;
    const iNeg = fixNeg.engine.getNodeVoltage(fixNeg.circuit.labelToNodeId.get("diac:B")!) / 10;

    // Both above breakover floor; signs opposite (flips with source polarity).
    expect(iPos).toBeGreaterThan(0.1);
    expect(iNeg).toBeLessThan(-0.1);

    // Magnitudes match within 10% (anti-parallel symmetry; minor asymmetry
    // arises only from the engine's NR limiting path which differs for
    // forward vs reverse traversal, not from the device model).
    const ratio = Math.abs(iPos) / Math.abs(iNeg);
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 — Paired vs ngspice (T3) on blocking regime
// One ComparisonSession per .dts; the run lives in the first it(), siblings
// read the recorded session.
// ---------------------------------------------------------------------------

describeIfDll("Diac blocking vs ngspice — transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_BLOCKING, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_blocking", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_blocking", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
  });

  it("full_iteration_paired_blocking", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 — Paired vs ngspice (T3) on breakover regime
// ---------------------------------------------------------------------------

describeIfDll("Diac breakover vs ngspice — transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_BREAKOVER, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_breakover", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_breakover", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
  });

  it("full_iteration_paired_breakover", () => {
    session.compareAllAttempts();
  });
});
