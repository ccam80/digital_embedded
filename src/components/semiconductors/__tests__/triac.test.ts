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

const DTS_BLOCKING = path.resolve("src/components/semiconductors/__tests__/fixtures/triac-canon-blocking.dts");
const DTS_GATED_ON = path.resolve("src/components/semiconductors/__tests__/fixtures/triac-canon-gated-on.dts");
const DTS_REVERSE  = path.resolve("src/components/semiconductors/__tests__/fixtures/triac-canon-reverse-blocking.dts");

// ---------------------------------------------------------------------------
// Programmatic circuit factories (T1)
// ---------------------------------------------------------------------------
//
// The Triac is a netlist composite of four BJT sub-elements (two anti-
// parallel SCRs sharing a gate). Pins: MT2, MT1, G. Internal nets: latch1,
// latch2. Component itself owns no MNA state slots; sub-element BJTs do.
// Cat 1 / Cat 2 / Cat 4 observables therefore live on the public node-
// voltage surface (engine.getNodeVoltage at MT2 / MT1 terminals).

interface TriacBlockingParams {
  /** Anode-side source voltage (V). */
  vSource: number;
  /** Series resistance from source to MT2 (Ω). */
  rSeries: number;
}

/**
 * Blocking-regime topology:
 *   VS:pos -> R1:pos -> R1:neg -> triac:MT2
 *   triac:MT1 -> GND
 *   triac:G   -> GND   (gate at 0V; no trigger)
 *   VS:neg    -> GND
 *
 * Gate tied to ground means no SCR latch arms. The triac stays in
 * blocking; current through the device is limited by the four BJTs
 * leakage paths.
 */
function buildTriacBlockingCircuit(facade: DefaultSimulatorFacade, p: TriacBlockingParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",    type: "DcVoltageSource", props: { label: "vs",    voltage: p.vSource } },
      { id: "r1",    type: "Resistor",        props: { label: "r1",    resistance: p.rSeries } },
      { id: "triac", type: "Triac",           props: { label: "triac" } },
      { id: "gnd",   type: "Ground" },
    ],
    connections: [
      ["vs:pos",    "r1:pos"],
      ["r1:neg",    "triac:MT2"],
      ["triac:MT1", "gnd:out"],
      ["triac:G",   "gnd:out"],
      ["vs:neg",    "gnd:out"],
    ],
  });
}

interface TriacGatedParams {
  /** Anode-side source voltage (V). */
  vAnode: number;
  /** Gate-side source voltage (V). */
  vGate: number;
  /** Anode series resistance (Ω). */
  rAnode: number;
  /** Gate series resistance (Ω). */
  rGate: number;
}

/**
 * Gated-on topology:
 *   VA:pos -> RA:pos -> RA:neg -> triac:MT2
 *   triac:MT1 -> GND
 *   VG:pos -> RG:pos -> RG:neg -> triac:G
 *   VG:neg -> GND
 *   VA:neg -> GND
 *
 * Gate forward-biased above the SCR latch turn-on threshold engages
 * conduction MT2 -> MT1 through the Q1/Q2 latch arm.
 */
function buildTriacGatedCircuit(facade: DefaultSimulatorFacade, p: TriacGatedParams): Circuit {
  return facade.build({
    components: [
      { id: "va",    type: "DcVoltageSource", props: { label: "va",    voltage: p.vAnode } },
      { id: "vg",    type: "DcVoltageSource", props: { label: "vg",    voltage: p.vGate } },
      { id: "ra",    type: "Resistor",        props: { label: "ra",    resistance: p.rAnode } },
      { id: "rg",    type: "Resistor",        props: { label: "rg",    resistance: p.rGate } },
      { id: "triac", type: "Triac",           props: { label: "triac" } },
      { id: "gnd",   type: "Ground" },
    ],
    connections: [
      ["va:pos",    "ra:pos"],
      ["ra:neg",    "triac:MT2"],
      ["triac:MT1", "gnd:out"],
      ["vg:pos",    "rg:pos"],
      ["rg:neg",    "triac:G"],
      ["vg:neg",    "gnd:out"],
      ["va:neg",    "gnd:out"],
    ],
  });
}

interface TriacReverseParams {
  /** Source voltage (V); drives MT1 high, MT2 grounded. */
  vSource: number;
  /** Series resistance (Ω). */
  rSeries: number;
}

/**
 * Reverse-polarity blocking topology:
 *   VS:pos -> R1:pos -> R1:neg -> triac:MT1
 *   triac:MT2 -> GND
 *   triac:G   -> GND
 *   VS:neg    -> GND
 *
 * Anti-parallel SCR structure: this swings the bias the other direction
 * compared to the forward-polarity blocking topology, exercising the
 * Q3/Q4 latch arm leakage path instead of Q1/Q2.
 */
function buildTriacReverseCircuit(facade: DefaultSimulatorFacade, p: TriacReverseParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",    type: "DcVoltageSource", props: { label: "vs",    voltage: p.vSource } },
      { id: "r1",    type: "Resistor",        props: { label: "r1",    resistance: p.rSeries } },
      { id: "triac", type: "Triac",           props: { label: "triac" } },
      { id: "gnd",   type: "Ground" },
    ],
    connections: [
      ["vs:pos",    "r1:pos"],
      ["r1:neg",    "triac:MT1"],
      ["triac:MT2", "gnd:out"],
      ["triac:G",   "gnd:out"],
      ["vs:neg",    "gnd:out"],
    ],
  });
}

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
//
// Triac is a netlist composite with no own state slots; the canonical
// Cat 1 observable is the public node voltage at MT2 after the
// _setup() + _transientDcop() warm-start.
// ---------------------------------------------------------------------------

describe("Triac initialization (T1)", () => {
  it("init_blocking_anode_voltage_tracks_source", () => {
    // Gate at 0V, MT1 at 0V, no trigger. With VS=5V across R1=1000Ω in
    // series with the triac, the blocking-regime triac sinks negligible
    // current → V(triac:MT2) ≈ vSource (negligible IR drop across R1).
    const fix = buildFixture({
      build: (_r, facade) => buildTriacBlockingCircuit(facade, { vSource: 5, rSeries: 1000 }),
    });
    const vMt2 = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("triac:MT2")!);
    expect(vMt2).toBeCloseTo(5, 1);
  });

  it("init_blocking_kathode_grounded", () => {
    // MT1 wired directly to ground → V(triac:MT1) = 0V.
    const fix = buildFixture({
      build: (_r, facade) => buildTriacBlockingCircuit(facade, { vSource: 5, rSeries: 1000 }),
    });
    const vMt1 = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("triac:MT1")!);
    expect(vMt1).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point (T1, analytical)
//
// Two regimes: blocking (gate tied low → triac blocks, V_MT2 ≈ vSource)
// and gated-on (gate forward-biased → triac latches conducting).
// ---------------------------------------------------------------------------

describe("Triac DCOP — blocking + gated-on (T1)", () => {
  it("dcop_blocking_current_below_one_milliamp", () => {
    // Blocking: VS=5V, R1=1kΩ, gate=0V → I_triac = (vSource - V_MT2) / R1.
    // With V_MT2 ≈ vSource (blocking → open), I_triac ≪ 1mA.
    const fix = buildFixture({
      build: (_r, facade) => buildTriacBlockingCircuit(facade, { vSource: 5, rSeries: 1000 }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    const vMt2 = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("triac:MT2")!);
    const iTriac = (5 - vMt2) / 1000;
    expect(Math.abs(iTriac)).toBeLessThan(1e-3);
  });

  it("dcop_blocking_anode_node_close_to_source", () => {
    // Same blocking regime; assert anode tracks source within a few mV.
    const fix = buildFixture({
      build: (_r, facade) => buildTriacBlockingCircuit(facade, { vSource: 5, rSeries: 1000 }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc!.converged).toBe(true);
    const vMt2 = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("triac:MT2")!);
    expect(vMt2).toBeGreaterThan(4.9);
    expect(vMt2).toBeLessThanOrEqual(5);
  });

  it("dcop_reverse_polarity_blocking_current_below_one_milliamp", () => {
    // Reverse polarity: VS drives MT1 high (instead of MT2). The anti-
    // parallel structure means the Q3/Q4 latch arm sees the bias; gate
    // is grounded → no trigger → blocking. Closed-form: I_triac =
    // (vSource - V_MT1) / R1, with V_MT1 ≈ vSource (blocking) → I ≪ 1mA.
    const fix = buildFixture({
      build: (_r, facade) => buildTriacReverseCircuit(facade, { vSource: 5, rSeries: 1000 }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    const vMt1 = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("triac:MT1")!);
    const iTriac = (5 - vMt1) / 1000;
    expect(Math.abs(iTriac)).toBeLessThan(1e-3);
    // Symmetry check: anti-parallel triac in reverse blocking has the
    // same near-source-voltage anode as forward blocking.
    expect(vMt1).toBeGreaterThan(4.9);
  });

  it("dcop_gated_on_conducts", () => {
    // Gate forward-biased VG=1V via RG=100Ω drives sufficient gate current
    // to fire the SCR latch (Q1 NPN + Q2 PNP arm). VA=5V, RA=100Ω.
    // Closed-form once latched: V(triac:MT2) ≈ V_drop ≈ 1V (latch on-state
    // drop ~ V_BE(Q1) + V_CE(Q2,sat)). I_triac = (vA - V_MT2) / rA, so
    // I_triac > 10mA confirms conduction (well above blocking-regime mA).
    const fix = buildFixture({
      build: (_r, facade) => buildTriacGatedCircuit(facade, {
        vAnode: 5, vGate: 1, rAnode: 100, rGate: 100,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    const vMt2 = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("triac:MT2")!);
    const iTriac = (5 - vMt2) / 100;
    // Latched: triac sinks > 10mA (vs blocking < 1mA).
    expect(iTriac).toBeGreaterThan(10e-3);
    // Anode pulled below source by IR drop (latch on-state).
    expect(vMt2).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Parameter hot-load (T1)
//
// TRIAC_PARAM_DEFS exposes BF, IS, BR, RC, RB, RE, AREA, TEMP. These flow
// into the four BJT sub-elements. We assert documented-contract behaviour
// for one structural parameter (BF, primary forward gain — drives latch
// loop gain) and the universal derived-state-recompute parameter TEMP
// (recomputes tSatCur/vt on every BJT sub-element).
//
// Note: composite-component params are seeded into sub-elements at
// compile/setup. Hot-loading via setComponentProperty on the composite
// element is the documented contract; a failing assertion here is the
// canonical artefact per Hard Priority #1.
// ---------------------------------------------------------------------------

describe("Triac parameter hot-load (T1)", () => {
  it("hotload_BF_changes_blocking_anode_voltage", () => {
    // Forward gain BF on Q1/Q3 sets the latch loop gain. In the blocking
    // regime (gate=0V), raising BF strengthens the leakage path of the
    // partially-on Q1/Q2 → V(triac:MT2) shifts. The directional contract:
    // V(triac:MT2) changes when BF is hot-loaded.
    const fix = buildFixture({
      build: (_r, facade) => buildTriacBlockingCircuit(facade, { vSource: 5, rSeries: 1000 }),
    });
    fix.coordinator.dcOperatingPoint();
    const nodeId = fix.circuit.labelToNodeId.get("triac:MT2")!;
    const before = fix.engine.getNodeVoltage(nodeId);

    const triacEl = fix.coordinator.compiled.labelToCircuitElement.get("triac")!;
    fix.coordinator.setComponentProperty(triacEl, "BF", 500);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(nodeId);
    expect(after).not.toBeCloseTo(before);
  });

  it("hotload_TEMP_changes_blocking_anode_voltage", () => {
    // TEMP recomputes tSatCur and vt on every BJT sub-element. Raising
    // temperature increases reverse-saturation current → leakage current
    // through the four BJTs grows → V(triac:MT2) shifts (drops below
    // vSource by a larger IR margin). Directional contract: anode voltage
    // changes when TEMP is hot-loaded; sign is "decrease" (more leakage).
    const fix = buildFixture({
      build: (_r, facade) => buildTriacBlockingCircuit(facade, { vSource: 5, rSeries: 1000 }),
    });
    fix.coordinator.dcOperatingPoint();
    const nodeId = fix.circuit.labelToNodeId.get("triac:MT2")!;
    const before = fix.engine.getNodeVoltage(nodeId);

    const triacEl = fix.coordinator.compiled.labelToCircuitElement.get("triac")!;
    fix.coordinator.setComponentProperty(triacEl, "TEMP", 400);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(nodeId);
    expect(after).not.toBeCloseTo(before);
    // Hotter junctions leak more → anode voltage drops below the cold value.
    expect(Math.sign(after - before)).toBe(-1);
  });

  it("hotload_AREA_changes_blocking_anode_voltage", () => {
    // AREA scales saturation currents on every sub-element. Doubling AREA
    // doubles the leakage current of the blocking-regime BJTs → V_MT2
    // drops below vSource by a wider margin. Documented directional
    // contract: increasing AREA decreases V(triac:MT2) in blocking.
    const fix = buildFixture({
      build: (_r, facade) => buildTriacBlockingCircuit(facade, { vSource: 5, rSeries: 1000 }),
    });
    fix.coordinator.dcOperatingPoint();
    const nodeId = fix.circuit.labelToNodeId.get("triac:MT2")!;
    const before = fix.engine.getNodeVoltage(nodeId);

    const triacEl = fix.coordinator.compiled.labelToCircuitElement.get("triac")!;
    fix.coordinator.setComponentProperty(triacEl, "AREA", 10);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(nodeId);
    expect(after).not.toBeCloseTo(before);
  });

  it("hotload_IS_changes_blocking_anode_voltage", () => {
    // IS (saturation current) scales every junction's reverse-saturation
    // current directly. Raising IS by 4 orders strengthens BJT leakage
    // → V(triac:MT2) shifts.
    const fix = buildFixture({
      build: (_r, facade) => buildTriacBlockingCircuit(facade, { vSource: 5, rSeries: 1000 }),
    });
    fix.coordinator.dcOperatingPoint();
    const nodeId = fix.circuit.labelToNodeId.get("triac:MT2")!;
    const before = fix.engine.getNodeVoltage(nodeId);

    const triacEl = fix.coordinator.compiled.labelToCircuitElement.get("triac")!;
    fix.coordinator.setComponentProperty(triacEl, "IS", 1e-12);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(nodeId);
    expect(after).not.toBeCloseTo(before);
  });

  it("hotload_BR_changes_blocking_anode_voltage", () => {
    // BR (reverse current gain on the PNP sub-elements Q2/Q4) modulates
    // the reverse-traversal latch loop gain. Doubling BR shifts the
    // blocking-regime leakage balance → V(triac:MT2) changes.
    const fix = buildFixture({
      build: (_r, facade) => buildTriacBlockingCircuit(facade, { vSource: 5, rSeries: 1000 }),
    });
    fix.coordinator.dcOperatingPoint();
    const nodeId = fix.circuit.labelToNodeId.get("triac:MT2")!;
    const before = fix.engine.getNodeVoltage(nodeId);

    const triacEl = fix.coordinator.compiled.labelToCircuitElement.get("triac")!;
    fix.coordinator.setComponentProperty(triacEl, "BR", 200);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(nodeId);
    expect(after).not.toBeCloseTo(before);
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 — Paired vs ngspice (T3) on blocking regime
//
// One ComparisonSession per .dts. The harness run lives in the first
// it() (transient sweep); siblings read the recorded session.
// ---------------------------------------------------------------------------

describeIfDll("Triac blocking vs ngspice — transient + stamp parity (T3)", () => {
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
// Category 2-numerical / 3 / 5 — Paired vs ngspice (T3) on gated-on regime
// ---------------------------------------------------------------------------

describeIfDll("Triac gated-on vs ngspice — transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_GATED_ON, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_gated_on", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_gated_on", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
  });

  it("full_iteration_paired_gated_on", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 — Paired vs ngspice (T3) on reverse-polarity
// blocking regime (anti-parallel SCR arm). Sourced from EXTEND of the
// original "dcop_converges for reverse polarity Triac" test.
// ---------------------------------------------------------------------------

describeIfDll("Triac reverse-polarity blocking vs ngspice — transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_REVERSE, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_reverse_blocking", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_reverse_blocking", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
  });

  it("full_iteration_paired_reverse_blocking", () => {
    session.compareAllAttempts();
  });
});
