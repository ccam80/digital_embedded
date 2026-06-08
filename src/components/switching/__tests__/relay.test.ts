import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";

import { buildFixture, type Fixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  describeIfDll,
  DLL_PATH,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { createDefaultRegistry } from "../../register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { CurrentControlledSwitchAnalogElement } from "../current-controlled-switch.js";

import type { Circuit } from "../../../core/circuit.js";
import type { SignalValue } from "../../../compile/types.js";

/**
 * Locate a CurrentControlledSwitchAnalogElement sub-element inside the expanded
 * RelayDT composite by its fully-qualified label (e.g. "relayDT:contactNO").
 * Walks `fix.circuit.elements` for a CurrentControlledSwitchAnalogElement instance
 * with the matching `label`.
 */
function findContactByName(fix: Fixture, label: string): CurrentControlledSwitchAnalogElement {
  for (const el of fix.circuit.elements) {
    if (el instanceof CurrentControlledSwitchAnalogElement && el.label === label) {
      return el;
    }
  }
  throw new Error(
    `CurrentControlledSwitchAnalogElement sub-element with label '${label}' not found in compiled circuit; ` +
      `the RelayDT netlist composite did not expand correctly.`,
  );
}

// ---------------------------------------------------------------------------
// .dts fixture paths (T3 harness) — authored under fixtures/
// ---------------------------------------------------------------------------
//
// RelayDT energised: vSrc=10V across the 100Ω coil drives I_coil=0.1A > pullInI=0.05A,
// the NO contact closes (A1↔B1) and the NC contact opens (A1↔C1). vTest=1V probes the
// contact loop through rLoadB/rLoadC.
const DTS_DT_ENERGISED = path.resolve(
  "src/components/switching/__tests__/fixtures/relay-dt-canon-energised.dts",
);

// RelayDT de-energised: both coil terminals tied to ground; I_coil=0A < dropOutI=0.02A,
// the NO contact stays open and the NC contact stays closed.
const DTS_DT_DE_ENERGISED = path.resolve(
  "src/components/switching/__tests__/fixtures/relay-dt-canon-de-energised.dts",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function digital(value: number): SignalValue {
  return { type: "digital", value };
}

function nodeOf(fix: Fixture, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

// ---------------------------------------------------------------------------
// Programmatic circuit factories (T1)
// ---------------------------------------------------------------------------

// Digital relay bridge: drive in1/in2 to control the coil; A1 is fed by DIN
// and B1 is observed by DOUT. coilEnergised when in1 XOR in2 is nonzero.
function buildDigitalRelay(facade: DefaultSimulatorFacade): Circuit {
  return facade.build({
    components: [
      { id: "i1",   type: "In",    props: { label: "I1",   bitWidth: 1 } },
      { id: "i2",   type: "In",    props: { label: "I2",   bitWidth: 1 } },
      { id: "din",  type: "In",    props: { label: "DIN",  bitWidth: 1 } },
      { id: "rly",  type: "Relay", props: { label: "rly1" } },
      { id: "dout", type: "Out",   props: { label: "DOUT", bitWidth: 1 } },
    ],
    connections: [
      ["i1:out",  "rly:in1"],
      ["i2:out",  "rly:in2"],
      ["din:out", "rly:A1"],
      ["rly:B1",  "dout:in"],
    ],
  });
}

// Digital RelayDT bridge: drive in1/in2 for the coil; A1 fed by DIN, B1 (NO,
// closes when energised) observed by DOUT_B. (The C1 pin is bidirectional
// in the digital model and is left unconnected here.)
function buildDigitalRelayDT(facade: DefaultSimulatorFacade): Circuit {
  return facade.build({
    components: [
      { id: "i1",    type: "In",       props: { label: "I1",    bitWidth: 1 } },
      { id: "i2",    type: "In",       props: { label: "I2",    bitWidth: 1 } },
      { id: "din",   type: "In",       props: { label: "DIN",   bitWidth: 1 } },
      { id: "rly",   type: "RelayDT",  props: { label: "rlyDT" } },
      { id: "doutB", type: "Out",      props: { label: "DOUTB", bitWidth: 1 } },
    ],
    connections: [
      ["i1:out",  "rly:in1"],
      ["i2:out",  "rly:in2"],
      ["din:out", "rly:A1"],
      ["rly:B1",  "doutB:in"],
    ],
  });
}

// Analog SPDT bench (behavioral model): vSrc drives the coil, vTest probes the
// contact loop. rLoadB on B1 (NO contact) and rLoadC on C1 (NC contact).
interface RelayDTBenchParams {
  vCoil?: number;
  rLoad?: number;
  vTest?: number;
}

function buildRelayDTBench(facade: DefaultSimulatorFacade, p: RelayDTBenchParams = {}): Circuit {
  return facade.build({
    components: [
      { id: "vSrc",   type: "DcVoltageSource", props: { label: "vSrc",   voltage: p.vCoil ?? 10 } },
      { id: "vTest",  type: "DcVoltageSource", props: { label: "vTest",  voltage: p.vTest ?? 1 } },
      { id: "rLoadB", type: "Resistor",        props: { label: "rLoadB", resistance: p.rLoad ?? 100 } },
      { id: "rLoadC", type: "Resistor",        props: { label: "rLoadC", resistance: p.rLoad ?? 100 } },
      { id: "relay",  type: "RelayDT",         props: { label: "relayDT", model: "behavioral" } },
      { id: "gnd",    type: "Ground",          props: { label: "gnd" } },
    ],
    connections: [
      ["vSrc:pos",   "relay:in1"],
      ["vSrc:neg",   "gnd:out"],
      ["relay:in2",  "gnd:out"],
      ["relay:A1",   "vTest:pos"],
      ["vTest:neg",  "gnd:out"],
      ["relay:B1",   "rLoadB:pos"],
      ["rLoadB:neg", "gnd:out"],
      ["relay:C1",   "rLoadC:pos"],
      ["rLoadC:neg", "gnd:out"],
    ],
  });
}

// ===========================================================================
// Category 9 — Bridge / digital interaction (T1)
// ===========================================================================
//
// The Relay's models.digital path (executeRelay) drives state[stBase]=1 when
// in1 XOR in2 is nonzero, switchPins=[2,3] => A1↔B1 closes when energised.

describe("Relay digital bridge (T1) — Cat 9 SPST", () => {
  it("digital_relay_in1_xor_in2_high_passes_din_to_dout", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDigitalRelay(facade));

    // Energised: in1=1, in2=0 → XOR=1 → contact CLOSED.
    coordinator.writeByLabel("I1",  digital(1));
    coordinator.writeByLabel("I2",  digital(0));
    coordinator.writeByLabel("DIN", digital(1));
    coordinator.step();
    expect(coordinator.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 1 });

    coordinator.writeByLabel("DIN", digital(0));
    coordinator.step();
    expect(coordinator.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 0 });
  });

  it("digital_relay_in1_eq_in2_de_energised_does_not_pass_din", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDigitalRelay(facade));

    // De-energised: in1=in2=0 → XOR=0 → contact OPEN. Bus resolver leaves DOUT
    // floating; the Out sink reads 0.
    coordinator.writeByLabel("I1",  digital(0));
    coordinator.writeByLabel("I2",  digital(0));
    coordinator.writeByLabel("DIN", digital(1));
    coordinator.step();
    expect(coordinator.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 0 });

    // Both-high also XOR=0 → contact OPEN.
    coordinator.writeByLabel("I1",  digital(1));
    coordinator.writeByLabel("I2",  digital(1));
    coordinator.writeByLabel("DIN", digital(1));
    coordinator.step();
    expect(coordinator.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 0 });
  });
});

describe("RelayDT digital bridge (T1) — Cat 9 SPDT", () => {
  it("digital_relaydt_energised_routes_a_to_b_for_din", () => {
    // Energised: in1 XOR in2 = 1 → state[stBase]=1 → A1↔B1 closes.
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDigitalRelayDT(facade));

    coordinator.writeByLabel("I1",  digital(1));
    coordinator.writeByLabel("I2",  digital(0));
    coordinator.writeByLabel("DIN", digital(1));
    coordinator.step();
    expect(coordinator.readByLabel("DOUTB")).toMatchObject({ type: "digital", value: 1 });

    coordinator.writeByLabel("DIN", digital(0));
    coordinator.step();
    expect(coordinator.readByLabel("DOUTB")).toMatchObject({ type: "digital", value: 0 });
  });

  it("digital_relaydt_de_energised_does_not_route_a_to_b", () => {
    // De-energised: in1=in2=0 → state[stBase]=0 → A1↔B1 open. DOUTB reads 0.
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDigitalRelayDT(facade));

    coordinator.writeByLabel("I1",  digital(0));
    coordinator.writeByLabel("I2",  digital(0));
    coordinator.writeByLabel("DIN", digital(1));
    coordinator.step();
    expect(coordinator.readByLabel("DOUTB")).toMatchObject({ type: "digital", value: 0 });
  });
});

// ===========================================================================
// Category 1 — Initialization (T1) — RelayDT (analog/behavioral)
// ===========================================================================
//
// Post-warm-start observable: with vCoil=10V across the 100Ω coil the
// steady-state I_coil=0.1A > pullInI=0.05A, so by the end of the first
// coordinator.step() the NO contact has closed (V(rLoadB:pos) sits at
// the closed-divider voltage) and the NC contact has opened.

describe("RelayDT initialization (T1)", () => {
  it("init_dt_energised_node_voltages_route_to_b", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildRelayDTBench(facade, { vCoil: 10, vTest: 1, rLoad: 100 }),
    });
    // NO contact closed: V(rLoadB:pos) ≈ vTest * rLoad / (rLoad + Ron).
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "rLoadB:pos"))).toBeCloseTo(100 / 100.01, 3);
    // NC contact open: V(rLoadC:pos) ≈ vTest * rLoad / (rLoad + Roff) ≈ 0.
    expect(Math.abs(fix.engine.getNodeVoltage(nodeOf(fix, "rLoadC:pos")))).toBeLessThan(1e-3);
  });

  it("init_dt_de_energised_node_voltages_route_to_c", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildRelayDTBench(facade, { vCoil: 0, vTest: 1, rLoad: 100 }),
    });
    // NO contact open: V(rLoadB:pos) ≈ 0.
    expect(Math.abs(fix.engine.getNodeVoltage(nodeOf(fix, "rLoadB:pos")))).toBeLessThan(1e-3);
    // NC contact closed: V(rLoadC:pos) ≈ vTest * rLoad / (rLoad + Ron).
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "rLoadC:pos"))).toBeCloseTo(100 / 100.01, 3);
  });
});

// ===========================================================================
// Category 2 — DCOP analytical (T1) — RelayDT
// ===========================================================================
//
// Energised regime — NO contact CLOSED with Ron=0.01Ω, rLoadB=100Ω. The
// contact loop V(rLoadB:pos) is the rLoadB/(Ron+rLoadB) divider of vTest=1V.
//   V(rLoadB:pos) = 1 * 100 / 100.01 ≈ 0.9999V
// V(rLoadC:pos) is the rLoadC/(Roff+rLoadC) divider of vTest:
//   V(rLoadC:pos) = 1 * 100 / 1e9 ≈ 1e-7V.

describe("RelayDT DCOP analytical (T1) — energised", () => {
  it("dcop_dt_energised_v_rloadb_near_vtest_and_v_rloadc_near_zero", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildRelayDTBench(facade, { vCoil: 10, vTest: 1, rLoad: 100 }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const vB = fix.engine.getNodeVoltage(nodeOf(fix, "rLoadB:pos"));
    const vC = fix.engine.getNodeVoltage(nodeOf(fix, "rLoadC:pos"));
    expect(vB).toBeCloseTo(100 / 100.01, 3);
    expect(vB).toBeGreaterThan(0.99);
    expect(Math.abs(vC)).toBeLessThan(1e-3);
  });
});

describe("RelayDT DCOP analytical (T1) — de-energised", () => {
  it("dcop_dt_de_energised_v_rloadb_near_zero_and_v_rloadc_near_vtest", () => {
    // 0V across the coil → I_coil=0A < dropOutI; NO open, NC closed.
    const fix = buildFixture({
      build: (_r, facade) => buildRelayDTBench(facade, { vCoil: 0, vTest: 1, rLoad: 100 }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const vB = fix.engine.getNodeVoltage(nodeOf(fix, "rLoadB:pos"));
    const vC = fix.engine.getNodeVoltage(nodeOf(fix, "rLoadC:pos"));
    expect(Math.abs(vB)).toBeLessThan(1e-3);
    expect(vC).toBeCloseTo(100 / 100.01, 3);
  });
});

// ===========================================================================
// Category 4 — Parameter hot-load (T1) — RelayDT
// ===========================================================================
//
// The RelayDT netlist exposes 6 model params: inductance, coilResistance,
// pullInI, dropOutI, Ron, Roff. One it() per structural parameter,
// asserting the documented post-change observable.

describe("RelayDT parameter hot-load (T1) — Ron", () => {
  it("hotload_dt_Ron_changes_v_rloadb_under_energised", () => {
    // Before: energised, Ron=0.01 → V(rLoadB:pos) ≈ 100/100.01.
    // After  setComponentProperty(relayDT, "Ron", 900):
    //   V(rLoadB:pos) = vTest * rLoadB / (rLoadB + Ron) = 100/1000 = 0.1V.
    const fix = buildFixture({
      build: (_r, facade) => buildRelayDTBench(facade, { vCoil: 10, vTest: 1, rLoad: 100 }),
    });
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "rLoadB:pos"));
    expect(before).toBeCloseTo(100 / 100.01, 3);

    fix.coordinator.setComponentProperty(fix.element("relayDT"), "Ron", 900);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "rLoadB:pos"));

    // Documented contract: raising Ron drops V(rLoadB:pos) (more drop across
    // the contact). Closed-form: 100/(100+900) = 0.1V.
    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(100 / 1000, 2);
  });
});

describe("RelayDT parameter hot-load (T1) — Roff", () => {
  it("hotload_dt_Roff_lifts_v_rloadb_when_de_energised", () => {
    // Before: de-energised, Roff=1e9 → V(rLoadB:pos) ≈ 1e-7V.
    // After  setComponentProperty(relayDT, "Roff", 10):
    //   V(rLoadB:pos) = vTest * rLoadB / (rLoadB + Roff) = 100/110 ≈ 0.909V.
    const fix = buildFixture({
      build: (_r, facade) => buildRelayDTBench(facade, { vCoil: 0, vTest: 1, rLoad: 100 }),
    });
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "rLoadB:pos"));
    expect(before).toBeLessThan(1e-3);

    fix.coordinator.setComponentProperty(fix.element("relayDT"), "Roff", 10);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "rLoadB:pos"));

    // Documented contract: lowering Roff lifts V(rLoadB:pos) on the open
    // contact. Closed-form: 100/(100+10) ≈ 0.909V.
    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeCloseTo(100 / 110, 2);
  });
});

describe("RelayDT parameter hot-load (T1) — coilResistance", () => {
  it("hotload_dt_coilResistance_drops_contact_when_above_threshold", () => {
    // Before: coilResistance=100, vCoil=10V → I_coil=0.1A > pullInI → NO closed.
    //   V(rLoadB:pos) ≈ 0.9999V, V(rLoadC:pos) ≈ 0.
    // After raising coilResistance to 1000 → I_coil = 0.01A < dropOutI=0.02A
    // → NO opens, NC closes; V(rLoadB:pos) collapses, V(rLoadC:pos) jumps.
    const fix = buildFixture({
      build: (_r, facade) => buildRelayDTBench(facade, { vCoil: 10, vTest: 1, rLoad: 100 }),
    });
    fix.coordinator.dcOperatingPoint();
    const vbBefore = fix.engine.getNodeVoltage(nodeOf(fix, "rLoadB:pos"));
    const vcBefore = fix.engine.getNodeVoltage(nodeOf(fix, "rLoadC:pos"));
    expect(vbBefore).toBeCloseTo(100 / 100.01, 3);
    expect(Math.abs(vcBefore)).toBeLessThan(1e-3);

    fix.coordinator.setComponentProperty(fix.element("relayDT"), "coilResistance", 1000);
    for (let i = 0; i < 50; i++) fix.coordinator.step();
    const vbAfter = fix.engine.getNodeVoltage(nodeOf(fix, "rLoadB:pos"));
    const vcAfter = fix.engine.getNodeVoltage(nodeOf(fix, "rLoadC:pos"));

    // Documented contract: contact swap; B side collapses, C side rises.
    expect(vbAfter).not.toBeCloseTo(vbBefore, 2);
    expect(vbAfter).toBeLessThan(vbBefore);
    expect(vbAfter).toBeLessThan(1e-2);
    expect(vcAfter).toBeGreaterThan(vcBefore);
    expect(vcAfter).toBeGreaterThan(0.9);
  });
});

describe("RelayDT parameter hot-load (T1) — pullInI", () => {
  it("hotload_dt_pullInI_below_steady_state_pulls_in_contact", () => {
    // I_coil = 4V/100Ω = 0.04A: above default dropOutI=0.02A but below default
    // pullInI=0.05A; from wasClosed=false start the contact does NOT pull in.
    // Lower pullInI to 0.01A → 0.04A > 0.01A → contact pulls in.
    const fix = buildFixture({
      build: (_r, facade) => buildRelayDTBench(facade, { vCoil: 4, vTest: 1, rLoad: 100 }),
    });
    fix.coordinator.dcOperatingPoint();
    const vbBefore = fix.engine.getNodeVoltage(nodeOf(fix, "rLoadB:pos"));
    // NO contact OPEN at start → V(rLoadB:pos) collapses toward 0.
    expect(vbBefore).toBeLessThan(1e-3);

    fix.coordinator.setComponentProperty(fix.element("relayDT"), "pullInI", 0.01);
    for (let i = 0; i < 50; i++) fix.coordinator.step();
    const vbAfter = fix.engine.getNodeVoltage(nodeOf(fix, "rLoadB:pos"));

    // Documented contract: lowering pullInI below |I_coil|=0.04A pulls the NO
    // contact in; V(rLoadB:pos) jumps toward vTest=1V.
    expect(vbAfter).not.toBeCloseTo(vbBefore, 2);
    expect(vbAfter).toBeGreaterThan(vbBefore);
    expect(vbAfter).toBeGreaterThan(0.9);
  });
});

describe("RelayDT parameter hot-load (T1) — dropOutI", () => {
  it("hotload_dt_dropOutI_above_steady_state_drops_contact", () => {
    // Energised at default thresholds (I_coil=0.1A > 0.02A=dropOutI). Raising
    // dropOutI above 0.1A drops the NO contact even though I_coil is unchanged.
    const fix = buildFixture({
      build: (_r, facade) => buildRelayDTBench(facade, { vCoil: 10, vTest: 1, rLoad: 100 }),
    });
    fix.coordinator.dcOperatingPoint();
    const vbBefore = fix.engine.getNodeVoltage(nodeOf(fix, "rLoadB:pos"));
    expect(vbBefore).toBeCloseTo(100 / 100.01, 3);

    fix.coordinator.setComponentProperty(fix.element("relayDT"), "dropOutI", 1.0);
    for (let i = 0; i < 50; i++) fix.coordinator.step();
    const vbAfter = fix.engine.getNodeVoltage(nodeOf(fix, "rLoadB:pos"));

    // Documented contract: raising dropOutI above |I_coil| drops NO contact.
    expect(vbAfter).not.toBeCloseTo(vbBefore, 2);
    expect(vbAfter).toBeLessThan(vbBefore);
    expect(vbAfter).toBeLessThan(1e-2);
  });
});

describe("RelayDT parameter hot-load (T1) — inductance", () => {
  it("hotload_dt_inductance_changes_settling_dynamics_at_fixed_step_count", () => {
    // Inductance is a transient-only parameter (sets L/R time constant). Two
    // fresh fixtures with different L: at the same simTime, the slow circuit
    // lags the fast one across the contact threshold.
    const fixFast = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vSrc",   type: "DcVoltageSource", props: { label: "vSrc",   voltage: 0 } },
          { id: "vTest",  type: "DcVoltageSource", props: { label: "vTest",  voltage: 1 } },
          { id: "rLoadB", type: "Resistor",        props: { label: "rLoadB", resistance: 100 } },
          { id: "rLoadC", type: "Resistor",        props: { label: "rLoadC", resistance: 100 } },
          { id: "relay",  type: "RelayDT",         props: { label: "relayDT", model: "behavioral",
                                                            inductance: 0.05 } },
          { id: "gnd",    type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vSrc:pos",   "relay:in1"], ["vSrc:neg",   "gnd:out"],
          ["relay:in2",  "gnd:out"],
          ["relay:A1",   "vTest:pos"], ["vTest:neg",  "gnd:out"],
          ["relay:B1",   "rLoadB:pos"], ["rLoadB:neg", "gnd:out"],
          ["relay:C1",   "rLoadC:pos"], ["rLoadC:neg", "gnd:out"],
        ],
      }),
    });
    const fixSlow = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vSrc",   type: "DcVoltageSource", props: { label: "vSrc",   voltage: 0 } },
          { id: "vTest",  type: "DcVoltageSource", props: { label: "vTest",  voltage: 1 } },
          { id: "rLoadB", type: "Resistor",        props: { label: "rLoadB", resistance: 100 } },
          { id: "rLoadC", type: "Resistor",        props: { label: "rLoadC", resistance: 100 } },
          { id: "relay",  type: "RelayDT",         props: { label: "relayDT", model: "behavioral",
                                                            inductance: 50 } },
          { id: "gnd",    type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vSrc:pos",   "relay:in1"], ["vSrc:neg",   "gnd:out"],
          ["relay:in2",  "gnd:out"],
          ["relay:A1",   "vTest:pos"], ["vTest:neg",  "gnd:out"],
          ["relay:B1",   "rLoadB:pos"], ["rLoadB:neg", "gnd:out"],
          ["relay:C1",   "rLoadC:pos"], ["rLoadC:neg", "gnd:out"],
        ],
      }),
    });

    // Both warm-started with vSrc=0 (de-energised); hot-load vCoil=10V and
    // step. Fast L (τ=5e-4s) charges quickly → NO closes; slow L (τ=0.5s)
    // lags → NO still open at the same step count.
    fixFast.coordinator.setComponentProperty(fixFast.element("vSrc"), "voltage", 10);
    fixSlow.coordinator.setComponentProperty(fixSlow.element("vSrc"), "voltage", 10);
    for (let i = 0; i < 200; i++) {
      fixFast.coordinator.step();
      fixSlow.coordinator.step();
    }

    const vbFast = fixFast.engine.getNodeVoltage(nodeOf(fixFast, "rLoadB:pos"));
    const vbSlow = fixSlow.engine.getNodeVoltage(nodeOf(fixSlow, "rLoadB:pos"));

    // Documented contract: at the same elapsed simTime, raising L delays the
    // coil current crossing pullInI; the slow fixture lags the fast one.
    expect(vbSlow).not.toBeCloseTo(vbFast, 2);
    expect(vbSlow).toBeLessThan(vbFast);
  });
});

// ===========================================================================
// RelayDT ctrlBranch path — T1 cases against existing fixtures.
//
// The contract: both contactNO and contactNC Switch sub-elements
// read the coilSense V-source's branch current via the ngspice CSW path.
// contactNO has normallyClosed=false (closes when energised); contactNC has
// normallyClosed=true + closed=true (closed at rest, opens when energised).
// ===========================================================================

describe("RelayDT ctrlBranch path", () => {
  it("contactNO closes when energised", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildRelayDTBench(facade, { vCoil: 10, vTest: 1, rLoad: 100 }),
    });
    const contactNO = findContactByName(fix, "relayDT:contactNO");
    expect(contactNO.isClosed()).toBe(true);
  });

  it("contactNC opens when energised", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildRelayDTBench(facade, { vCoil: 10, vTest: 1, rLoad: 100 }),
    });
    const contactNC = findContactByName(fix, "relayDT:contactNC");
    expect(contactNC.isClosed()).toBe(false);
  });

  it("contactNO opens when de-energised", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildRelayDTBench(facade, { vCoil: 0, vTest: 1, rLoad: 100 }),
    });
    const contactNO = findContactByName(fix, "relayDT:contactNO");
    expect(contactNO.isClosed()).toBe(false);
  });

  it("contactNC closes when de-energised", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildRelayDTBench(facade, { vCoil: 0, vTest: 1, rLoad: 100 }),
    });
    const contactNC = findContactByName(fix, "relayDT:contactNC");
    expect(contactNC.isClosed()).toBe(true);
  });
});

// ===========================================================================
// Category 2 numerical / 3 / 5 — paired vs ngspice (T3) — RelayDT
// ===========================================================================
//
// Per Step 2c: harness RUN lives in the FIRST it() of each describe (the
// transient run); subsequent siblings read from the recorded session.

describeIfDll("RelayDT paired vs ngspice — energised (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_DT_ENERGISED, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_dt_energised", async () => {
    await session.runTransient(0, 2e-5, 1e-6);
    session.compareAllSteps();
  }, 180_000);

  it("dcop_paired_dt_energised", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_dt_energised", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("RelayDT paired vs ngspice — de-energised (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_DT_DE_ENERGISED, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_dt_de_energised", async () => {
    await session.runTransient(0, 2e-5, 1e-6);
    session.compareAllSteps();
  }, 180_000);

  it("dcop_paired_dt_de_energised", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_dt_de_energised", () => {
    session.compareAllAttempts();
  });
});
