import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture, type Fixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  DLL_PATH,
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { CircuitElement } from "../../../core/element.js";

// ---------------------------------------------------------------------------
// .dts paths (T3 harness fixtures)
// ---------------------------------------------------------------------------

const DTS_ACTIVE = path.resolve(
  "src/components/active/__tests__/fixtures/optocoupler-cccs-canon-active.dts",
);
const DTS_LOW = path.resolve(
  "src/components/active/__tests__/fixtures/optocoupler-cccs-canon-low.dts",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nodeOf(fix: Fixture, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

function ceByLabel(fix: Fixture, label: string): CircuitElement {
  for (const ce of fix.circuit.elementToCircuitElement.values()) {
    if (ce.getProperties().getOrDefault<string>("label", "") === label) return ce;
  }
  throw new Error(`CircuitElement with label '${label}' not found`);
}

/**
 * Optocoupler bench used by every programmatic build below:
 *
 *   vLed(+) - rLed - tx:anode      tx:cathode - GND
 *   vCC (+) - rCol - tx:collector  tx:emitter - GND
 *
 * The LED is forward-biased by vLed through rLed. The phototransistor's
 * collector is pulled up to vCC through rCol. With CTR=1.0 the collector
 * current mirrors the LED current; the collector node V drops below vCC
 * by approximately I_C * rCol = I_LED * rCol.
 */
function buildOptocouplerBench(
  facade: DefaultSimulatorFacade,
  opts: { vLed: number; rLed: number; vCC: number; rCol: number; ctr?: number },
): Circuit {
  const txProps: Record<string, string | number> = { label: "tx" };
  if (opts.ctr !== undefined) txProps.ctr = opts.ctr;
  return facade.build({
    components: [
      { id: "vLed", type: "DcVoltageSource", props: { label: "vLed", voltage: opts.vLed } },
      { id: "rLed", type: "Resistor",       props: { label: "rLed", resistance: opts.rLed } },
      { id: "vCC",  type: "DcVoltageSource", props: { label: "vCC",  voltage: opts.vCC } },
      { id: "rCol", type: "Resistor",       props: { label: "rCol", resistance: opts.rCol } },
      { id: "tx",   type: "Optocoupler",    props: txProps },
      { id: "gnd",  type: "Ground" },
    ],
    connections: [
      ["vLed:pos",   "rLed:pos"],
      ["rLed:neg",   "tx:anode"],
      ["tx:cathode", "gnd:out"],
      ["vLed:neg",   "gnd:out"],
      ["vCC:pos",    "rCol:pos"],
      ["rCol:neg",   "tx:collector"],
      ["tx:emitter", "gnd:out"],
      ["vCC:neg",    "gnd:out"],
    ],
  });
}

// ---------------------------------------------------------------------------
// Category 1 - Initialization (T1)
//
// Post-warm-start: the optocoupler bench produces finite node voltages on
// the LED-side anode and the phototransistor collector. With vLed=5V/rLed=1k
// and CTR=1.0 the LED is forward-biased and the collector node sits below
// the +5V rail by I_C * rCol.
// ---------------------------------------------------------------------------

describe("Optocoupler initialization (T1)", () => {
  it("init_active_anode_and_collector_finite", () => {
    const fix = buildFixture({
      build: (_r, facade) =>
        buildOptocouplerBench(facade, { vLed: 5, rLed: 1000, vCC: 5, rCol: 1000 }),
    });

    const vAnode     = fix.engine.getNodeVoltage(nodeOf(fix, "tx:anode"));
    const vCollector = fix.engine.getNodeVoltage(nodeOf(fix, "tx:collector"));

    expect(Number.isFinite(vAnode)).toBe(true);
    expect(Number.isFinite(vCollector)).toBe(true);
    // LED is forward-biased: anode sits well below the 5V rail
    // (the diode drop + rLed*I_LED leaves vAnode in the 0.5..1.5V band).
    expect(vAnode).toBeGreaterThan(0);
    expect(vAnode).toBeLessThan(5);
    // With CTR=1.0 and a 1k collector pull-up, the collector node is
    // pulled below +5V by I_C * rCol.
    expect(vCollector).toBeGreaterThanOrEqual(0);
    expect(vCollector).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// Category 2 - DC operating point analytical (T1)
//
// This is the canonical CCCS-coupling assertion:
// with CTR=1.0 the phototransistor collector current mirrors the LED current.
// I_LED is set by the LED-side closed-form (vLed - vDiode) / rLed; I_C is
// observed at the collector pull-up. The wide CTR ratio band (0.1x..10x)
// accommodates the BJT model's beta-dependent dynamics on top of the CCCS
// algebraic injection.
// ---------------------------------------------------------------------------

describe("Optocoupler DCOP analytical (T1)", () => {
  it("dcop_photocurrent_couples_through_phototransistor_collector", () => {
    const fix = buildFixture({
      build: (_r, facade) =>
        buildOptocouplerBench(facade, { vLed: 5, rLed: 1000, vCC: 5, rCol: 1000 }),
    });

    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    // Closed-form on the LED side: vLed = 5V, rLed = 1k, V_diode ~ 0.7V.
    // I_LED = (vLed - vAnode) / rLed must exceed 1 mA.
    const vAnode = fix.engine.getNodeVoltage(nodeOf(fix, "tx:anode"));
    const iLed = (5.0 - vAnode) / 1000;
    expect(iLed).toBeGreaterThan(1e-3);

    // Closed-form on the collector side: I_C = (vCC - vCollector) / rCol.
    // With CTR=1.0 the photocurrent flows; expect I_C above 0.1 mA.
    const vCollector = fix.engine.getNodeVoltage(nodeOf(fix, "tx:collector"));
    const iCollector = (5.0 - vCollector) / 1000;
    expect(iCollector).toBeGreaterThan(1e-4);

    // CTR=1.0 contract: I_C tracks I_LED within the BJT-beta band.
    expect(iCollector / iLed).toBeGreaterThan(0.1);
    expect(iCollector / iLed).toBeLessThan(10.0);
  });
});

// ---------------------------------------------------------------------------
// Category 3 + 5 - Transient step-end paired + full-iteration paired (T3)
// Category 2 numerical paired - same session, step 0 (DCOP).
//
// Two .dts circuits cover two operating regimes (active LED drive at 5V
// and a low-drive bench at 1.5V). One ComparisonSession per .dts; the
// transient runs in the first it() of each describe and the per-step /
// per-iteration sweeps read from the recorded session.
// ---------------------------------------------------------------------------

describeIfDll("Optocoupler active vs ngspice - transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_ACTIVE, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_active", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_active", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
  });

  it("full_iteration_paired_active", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("Optocoupler low-drive vs ngspice - transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_LOW, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_low", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_low", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
  });

  it("full_iteration_paired_low", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// Category 4 - Parameter hot-load (T1)
//
// The CTR (current transfer ratio) is the optocoupler's primary scaling
// parameter for the CCCS coupling. setComponentProperty("ctr", X) must
// rescale the photocurrent injected into the phototransistor base, and the
// collector node voltage must move accordingly: raising CTR drives more
// I_C, pulling the collector node further below +vCC.
// ---------------------------------------------------------------------------

describe("Optocoupler parameter hot-load (T1)", () => {
  it("hotload_ctr_changes_collector_voltage", () => {
    const fix = buildFixture({
      build: (_r, facade) =>
        buildOptocouplerBench(facade, { vLed: 5, rLed: 1000, vCC: 5, rCol: 1000, ctr: 1.0 }),
    });

    const colNode = nodeOf(fix, "tx:collector");
    const before = fix.engine.getNodeVoltage(colNode);

    // Raise CTR from 1.0 to 5.0: the phototransistor sinks ~5x more
    // base photocurrent, the collector node is pulled lower.
    const tx = ceByLabel(fix, "tx");
    fix.coordinator.setComponentProperty(tx, "ctr", 5.0);
    fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(colNode);
    expect(Number.isFinite(after)).toBe(true);
    expect(after).not.toBeCloseTo(before);
    // Documented contract: raising CTR increases I_C, so the collector
    // node voltage decreases (more drop across the pull-up resistor).
    expect(Math.sign(after - before)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Category 6 - Limiting events (T1, own engine)
//
// The Optocoupler composite contains a Diode (LED) and an NpnBJT
// (phototransistor); both call pnjlim inside their load() paths. With a
// strong LED forward bias (5V across the 1k series resistor) the LED
// junction drives V_diode well past pnjlim's limit threshold during early
// NR iterations, exercising the limiter. The phototransistor's BE/BC
// junctions also see large excursions on the warm-start.
// ---------------------------------------------------------------------------

describe("Optocoupler limiting (T1, own engine)", () => {
  it("limiting_events_recorded_during_dcop", () => {
    const fix = buildFixture({
      build: (_r, facade) =>
        buildOptocouplerBench(facade, { vLed: 5, rLed: 1000, vCC: 5, rCol: 1000 }),
    });

    fix.coordinator.setLimitingCapture(true);
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const events = fix.coordinator.getLimitingEvents();
    // The composite drives at least one junction (LED diode VD or BJT
    // VBE/VBC) into pnjlim during NR; at least one limiting event is
    // captured for the well-driven bench.
    expect(events.length).toBeGreaterThan(0);
    // Every recorded event must carry finite vBefore / vAfter scalars.
    for (const ev of events) {
      expect(Number.isFinite(ev.vBefore)).toBe(true);
      expect(Number.isFinite(ev.vAfter)).toBe(true);
    }
  });
});
