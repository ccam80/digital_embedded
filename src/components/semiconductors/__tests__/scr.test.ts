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

const DTS_BLOCKING  = path.resolve("src/components/semiconductors/__tests__/fixtures/scr-canon-blocking.dts");
const DTS_TRIGGERED = path.resolve("src/components/semiconductors/__tests__/fixtures/scr-canon-triggered.dts");

// ---------------------------------------------------------------------------
// Programmatic circuit factories (T1)
//
// SCR is a composite of two BJT sub-elements (Q1 NPN + Q2 PNP) wired in a
// two-transistor latch. Pins on the public composite: A (anode), K (cathode),
// G (gate). Sub-element leaves are labelled `${parentLabel}:Q1` and
// `${parentLabel}:Q2` after compile().
// ---------------------------------------------------------------------------

interface ScrBlockingParams {
  /** Anode supply voltage (V). */
  vAnode: number;
  /** Anode resistor (Ω). */
  rAnode: number;
}

/**
 * Blocking topology: VS:pos -> R_a -> SCR:A; SCR:K -> GND; SCR:G -> GND.
 * Gate tied to ground; SCR remains in the blocking (off) state. Anode current
 * is limited by R_a; the analytical observable is V(SCR:A) ~ V_supply (open
 * latch carries negligible current).
 */
function buildScrBlocking(facade: DefaultSimulatorFacade, p: ScrBlockingParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { label: "VS",  voltage: p.vAnode } },
      { id: "ra",  type: "Resistor",        props: { label: "RA",  resistance: p.rAnode } },
      { id: "scr", type: "SCR",             props: { label: "scr" } },
      { id: "gnd", type: "Ground",          props: { label: "GND" } },
    ],
    connections: [
      ["vs:pos",  "ra:pos"],
      ["ra:neg",  "scr:A"],
      ["scr:K",   "gnd:out"],
      ["scr:G",   "gnd:out"],
      ["vs:neg",  "gnd:out"],
    ],
  });
}

interface ScrTriggeredParams {
  /** Anode supply voltage (V). */
  vAnode: number;
  /** Anode resistor (Ω). */
  rAnode: number;
  /** Gate drive voltage (V) — biases gate above one V_be to inject Q1 base current. */
  vGate: number;
  /** Gate resistor (Ω). */
  rGate: number;
}

/**
 * Triggered topology: VA:pos -> R_a -> SCR:A; SCR:K -> GND; VG:pos -> R_g -> SCR:G;
 * VG:neg -> GND; VA:neg -> GND. Gate biased ~0.65 V above ground injects Q1
 * base current; the latch regenerates and the SCR conducts. Anode current is
 * limited by R_a.
 */
function buildScrTriggered(facade: DefaultSimulatorFacade, p: ScrTriggeredParams): Circuit {
  return facade.build({
    components: [
      { id: "va",  type: "DcVoltageSource", props: { label: "VA",  voltage: p.vAnode } },
      { id: "vg",  type: "DcVoltageSource", props: { label: "VG",  voltage: p.vGate } },
      { id: "ra",  type: "Resistor",        props: { label: "RA",  resistance: p.rAnode } },
      { id: "rg",  type: "Resistor",        props: { label: "RG",  resistance: p.rGate } },
      { id: "scr", type: "SCR",             props: { label: "scr" } },
      { id: "gnd", type: "Ground",          props: { label: "GND" } },
    ],
    connections: [
      ["va:pos",  "ra:pos"],
      ["ra:neg",  "scr:A"],
      ["scr:K",   "gnd:out"],
      ["vg:pos",  "rg:pos"],
      ["rg:neg",  "scr:G"],
      ["vg:neg",  "gnd:out"],
      ["va:neg",  "gnd:out"],
    ],
  });
}

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// SCR is a netlist composite (no own state slots — its sub-element BJTs hold
// the slots). The canonical Cat 1 observable is the public node-voltage
// reading at the step-0 boundary post-warm-start.
// ---------------------------------------------------------------------------

describe("SCR initialization (T1)", () => {
  it("init_blocking_anode_voltage_tracks_supply", () => {
    // Gate at GND -> latch off -> negligible anode current -> V(SCR:A) ~ V_supply.
    const fix = buildFixture({
      build: (_r, facade) => buildScrBlocking(facade, { vAnode: 5, rAnode: 1000 }),
    });
    const vA = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("scr:A")!);
    expect(vA).toBeCloseTo(5, 2);
  });

  it("init_blocking_cathode_voltage_at_ground", () => {
    // SCR:K is wired straight to ground.
    const fix = buildFixture({
      build: (_r, facade) => buildScrBlocking(facade, { vAnode: 5, rAnode: 1000 }),
    });
    const vK = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("scr:K")!);
    expect(vK).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point (T1, analytical)
// Two regimes: blocking (gate at GND) and triggered (gate biased above V_be).
// Both use the public engine surface (node voltage). The closed-form
// expectation is derived in a comment beside each assertion.
// ---------------------------------------------------------------------------

describe("SCR DCOP — blocking + triggered (T1)", () => {
  it("dcop_blocking_anode_current_below_one_milliamp", () => {
    // Gate at GND, V_supply = 5 V, R_a = 1 kΩ. SCR off -> I_anode = (V_supply - V(scr:A)) / R_a.
    // With V(scr:A) ~ V_supply and the only leakage path being the OFF NPN's
    // collector saturation current (IS=1e-16, scaled by area=1), I_anode << 1 mA.
    const fix = buildFixture({
      build: (_r, facade) => buildScrBlocking(facade, { vAnode: 5, rAnode: 1000 }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    const vA = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("scr:A")!);
    const iAnode = (5 - vA) / 1000;
    expect(Math.abs(iAnode)).toBeLessThan(1e-3);
  });

  it("dcop_triggered_anode_voltage_drops_when_gate_biased", () => {
    // V_anode = 10 V, R_a = 100 Ω, V_gate = 0.65 V (above Q1 V_be threshold) via R_g = 100 Ω.
    // Gate injection latches the regenerative pair; conducting SCR pulls
    // V(scr:A) far below V_supply. Closed-form: an idealised on-state SCR has
    // V_AK ~ 1-2 V; with R_a = 100 Ω and V_supply = 10 V the anode node sits
    // well below 8 V (i.e. > 2 V drop across R_a confirms conduction).
    const fix = buildFixture({
      build: (_r, facade) => buildScrTriggered(facade, {
        vAnode: 10, rAnode: 100, vGate: 0.65, rGate: 100,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    const vA = fix.engine.getNodeVoltage(fix.circuit.labelToNodeId.get("scr:A")!);
    expect(vA).toBeLessThan(8);
    expect(vA).toBeGreaterThan(0);
  });

  it("dcop_blocking_vs_triggered_anode_current_ordering", () => {
    // Same V_supply, same R_a; gate-off vs gate-on must have I_off < I_on.
    const VS = 10;
    const RA = 100;
    const fixOff = buildFixture({
      build: (_r, facade) => buildScrBlocking(facade, { vAnode: VS, rAnode: RA }),
    });
    const fixOn = buildFixture({
      build: (_r, facade) => buildScrTriggered(facade, {
        vAnode: VS, rAnode: RA, vGate: 0.65, rGate: 100,
      }),
    });
    expect(fixOff.coordinator.dcOperatingPoint()!.converged).toBe(true);
    expect(fixOn.coordinator.dcOperatingPoint()!.converged).toBe(true);

    const vAoff = fixOff.engine.getNodeVoltage(fixOff.circuit.labelToNodeId.get("scr:A")!);
    const vAon  = fixOn.engine.getNodeVoltage(fixOn.circuit.labelToNodeId.get("scr:A")!);
    const iOff = (VS - vAoff) / RA;
    const iOn  = (VS - vAon)  / RA;
    // Conduction injects orders-of-magnitude more anode current than the off-state leakage.
    expect(iOn).toBeGreaterThan(iOff);
    expect(iOn - iOff).toBeGreaterThan(1e-3);
  });
});

// ---------------------------------------------------------------------------
// Category 6 — Limiting events (T1, own engine)
// SCR is a netlist composite of two BJT sub-elements; each BJT calls pnjlim
// on its VBE / VBC junctions. The composite leaves are labelled scr:Q1 and
// scr:Q2 by the compiler. Drive into the triggered regime so junction
// limiting fires during NR.
// ---------------------------------------------------------------------------

describe("SCR limiting (T1, own engine)", () => {
  it("limiting_pnjlim_fires_on_q1_or_q2_junction_during_dcop", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildScrTriggered(facade, {
        vAnode: 10, rAnode: 100, vGate: 0.65, rGate: 100,
      }),
    });
    fix.coordinator.setLimitingCapture(true);
    fix.coordinator.dcOperatingPoint();
    const events = fix.coordinator.getLimitingEvents();
    // Filter to BJT-junction events on the SCR's sub-elements (labels scr:Q1 / scr:Q2).
    const subEvents = events.filter(
      (e) => e.label === "scr:Q1" || e.label === "scr:Q2",
    );
    // At least one sub-element junction must have fired pnjlim during convergence.
    const anyLimited = subEvents.some((e) => e.wasLimited === true);
    expect(anyLimited).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 — Paired vs ngspice (T3) on blocking regime
// One ComparisonSession per .dts; the run lives in the first it(), siblings
// read the recorded session.
// ---------------------------------------------------------------------------

describeIfDll("SCR blocking vs ngspice — transient + stamp parity (T3)", () => {
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
// Category 2-numerical / 3 / 5 — Paired vs ngspice (T3) on triggered regime
// ---------------------------------------------------------------------------

describeIfDll("SCR triggered vs ngspice — transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_TRIGGERED, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_triggered", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
    session.compareAllSteps();
  });

  it("dcop_paired_triggered", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
  });

  it("full_iteration_paired_triggered", () => {
    session.compareAllAttempts();
  });
});
