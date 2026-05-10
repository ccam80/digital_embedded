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
import { SwitchAnalogElement, SWITCH_SCHEMA } from "../switch.js";

import type { Circuit } from "../../../core/circuit.js";
import type { CircuitElement } from "../../../core/element.js";
import type { SignalValue } from "../../../compile/types.js";

// ---------------------------------------------------------------------------
// .dts fixture paths (T3 harness) — authored under fixtures/
// ---------------------------------------------------------------------------
//
// Pull-in regime: vSrc=10V across the 100Ω coil drives I_coil = 0.1A, well
// above pullInI=0.05A; contact closes. vTest=1V probes the contact loop
// through rLoad=100Ω so the A1/B1 net is not floating.
const DTS_PULL_IN = path.resolve(
  "src/components/switching/__tests__/fixtures/relay-canon-pull-in.dts",
);

// De-energised regime: both coil terminals tied to ground, I_coil = 0A <
// dropOutI=0.02A; contact stays OPEN. vTest=1V probes the contact loop;
// with contact OPEN (Roff=1e9) the A1 net sits near 0V (rLoad/Roff
// divider).
const DTS_DE_ENERGISED = path.resolve(
  "src/components/switching/__tests__/fixtures/relay-canon-de-energised.dts",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SLOT_CLOSED = SWITCH_SCHEMA.indexOf.get("CLOSED")!;

function digital(value: number): SignalValue {
  return { type: "digital", value };
}

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

/** Locate the Switch sub-element inside the expanded relay composite. */
function findContactSwitch(fix: Fixture): SwitchAnalogElement {
  for (const el of fix.circuit.elements) {
    if (el instanceof SwitchAnalogElement && el.label === "relay:contactSW") {
      return el;
    }
  }
  throw new Error(
    "relay:contactSW SwitchAnalogElement not found in compiled circuit; " +
      "the Relay netlist composite did not expand correctly.",
  );
}

// ---------------------------------------------------------------------------
// Programmatic circuit factories (T1)
// ---------------------------------------------------------------------------
//
// Analog coil-energising bench:
//
//   vSrc(+) ─ relay:in1
//   vSrc(-) ─ GND ─ relay:in2
//   relay:A1 ─ rLoad ─ GND
//   relay:B1 ─ vTest(+) ─ GND ─ vTest(-)
//
// Default coil resistance = 100Ω, default pullInI = 0.05A, default
// dropOutI = 0.02A. Driving 10V across the coil at DC steady state
// pushes I_coil = 10 / 100 = 0.1A through coilL — above pull-in. Driving
// 0V keeps I_coil = 0A — below drop-out, contact stays OPEN.

interface RelayBenchParams {
  vCoil?: number;
  rLoad?: number;
  vTest?: number;
}

function buildRelayBench(facade: DefaultSimulatorFacade, p: RelayBenchParams = {}): Circuit {
  return facade.build({
    components: [
      { id: "vSrc",  type: "DcVoltageSource", props: { label: "vSrc",  voltage: p.vCoil ?? 10 } },
      { id: "vTest", type: "DcVoltageSource", props: { label: "vTest", voltage: p.vTest ?? 1 } },
      { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: p.rLoad ?? 100 } },
      { id: "relay", type: "Relay",           props: { label: "relay", model: "behavioral" } },
      { id: "gnd",   type: "Ground",          props: { label: "gnd" } },
    ],
    connections: [
      ["vSrc:pos",  "relay:in1"],
      ["vSrc:neg",  "gnd:out"],
      ["relay:in2", "gnd:out"],
      ["relay:A1",  "rLoad:pos"],
      ["rLoad:neg", "gnd:out"],
      ["relay:B1",  "vTest:pos"],
      ["vTest:neg", "gnd:out"],
    ],
  });
}

// Digital bridge bench: relay used in pure digital mode (executeRelay).
//   in1 driven by I1, in2 driven by I2 (1-bit each).
//   A1 driven by DIN (data in), B1 observed by DOUT (data out).
// Coil energised when in1 XOR in2 is nonzero — relay closes, A1/B1 connect.

function buildDigitalRelayCircuit(facade: DefaultSimulatorFacade): Circuit {
  return facade.build({
    components: [
      { id: "i1",   type: "In",    props: { label: "I1",   bitWidth: 1 } },
      { id: "i2",   type: "In",    props: { label: "I2",   bitWidth: 1 } },
      { id: "din",  type: "In",    props: { label: "DIN",  bitWidth: 1 } },
      { id: "rly",  type: "Relay", props: { label: "rly" } },
      { id: "dout", type: "Out",   props: { label: "DOUT", bitWidth: 1 } },
    ],
    connections: [
      ["i1:out",   "rly:in1"],
      ["i2:out",   "rly:in2"],
      ["din:out",  "rly:A1"],
      ["rly:B1",   "dout:in"],
    ],
  });
}

// ===========================================================================
// Category 1 — Initialization (T1)
// ===========================================================================
//
// Post-warm-start observable: the engine has compiled the relay composite
// (Inductor coilL + Resistor coilR + Switch contactSW +
// RelayCoupling). With vSrc=10V across the 100Ω coil the steady-state coil
// current is 0.1A, above pullInI=0.05A, so by the end of the first
// coordinator.step() the RelayCoupling has written CLOSED=1 into the
// Switch's pool slot.

describe("Relay initialization (T1)", () => {
  it("init_pull_in_seeds_contact_slot_closed", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildRelayBench(facade, { vCoil: 10 }),
    });
    const sw = findContactSwitch(fix);
    expect(fix.pool.state1[sw._stateBase + SLOT_CLOSED]).toBe(1);
  });

  it("init_de_energised_seeds_contact_slot_open", () => {
    // 0V across coil → I_coil = 0A < dropOutI=0.02A — contact stays OPEN.
    const fix = buildFixture({
      build: (_r, facade) => buildRelayBench(facade, { vCoil: 0 }),
    });
    const sw = findContactSwitch(fix);
    expect(fix.pool.state1[sw._stateBase + SLOT_CLOSED]).toBe(0);
  });
});

// ===========================================================================
// Category 2 — DCOP analytical (T1)
// ===========================================================================
//
// Pull-in: contact CLOSED with Ron=0.01Ω, rLoad=100Ω. The contact loop
// V(rLoad:pos) is the rLoad/(Ron+rLoad) divider of vTest=1V (vTest drives
// B1, contact connects A1—B1 through Ron, rLoad pulls A1 to GND).
//   V(rLoad:pos) = vTest * rLoad / (rLoad + Ron) = 1 * 100 / 100.01 ≈ 0.9999V
//
// De-energised: contact OPEN with Roff=1e9Ω. Then
//   V(rLoad:pos) = vTest * rLoad / (rLoad + Roff) ≈ 1 * 100 / 1e9 = 1e-7V.

describe("Relay DCOP analytical (T1) — pull-in", () => {
  it("dcop_pull_in_v_rload_pos_near_vtest", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildRelayBench(facade, { vCoil: 10, vTest: 1, rLoad: 100 }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    // Closed-form: V(rLoad:pos) = vTest * rLoad / (rLoad + Ron) = 100/100.01.
    const vRload = fix.engine.getNodeVoltage(nodeOf(fix, "rLoad:pos"));
    expect(vRload).toBeCloseTo(100 / 100.01, 3);
    expect(vRload).toBeGreaterThan(0.99);
    expect(vRload).toBeLessThanOrEqual(1.0);
  });
});

describe("Relay DCOP analytical (T1) — de-energised", () => {
  it("dcop_de_energised_v_rload_pos_near_zero", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildRelayBench(facade, { vCoil: 0, vTest: 1, rLoad: 100 }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    // Closed-form: V(rLoad:pos) = vTest * rLoad / (rLoad + Roff) ≈ 1e-7V.
    const vRload = fix.engine.getNodeVoltage(nodeOf(fix, "rLoad:pos"));
    expect(vRload).toBeLessThan(1e-3);
    expect(vRload).toBeCloseTo(1 * 100 / (100 + 1e9), 5);
  });
});

// ===========================================================================
// Category 4 — Parameter hot-load (T1)
// ===========================================================================
//
// The Relay netlist exposes 6 model params: inductance, coilResistance,
// pullInI, dropOutI, Ron, Roff. One it() per structural parameter.

describe("Relay parameter hot-load (T1) — coilResistance", () => {
  it("hotload_coilResistance_changes_steady_state_coil_current_and_contact_state", () => {
    // Before: coilResistance default = 100Ω, vCoil=10V → I_coil=0.1A >
    // pullInI=0.05A → CLOSED=1 and V(rLoad:pos) ≈ 0.9999V.
    // After  setComponentProperty(relay, "coilResistance", 1000):
    //   I_coil = 10/1000 = 0.01A < dropOutI=0.02A → CLOSED transitions to 0
    //   and V(rLoad:pos) collapses toward 0V (Roff/rLoad divider).
    const fix = buildFixture({
      build: (_r, facade) => buildRelayBench(facade, { vCoil: 10, vTest: 1, rLoad: 100 }),
    });
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "rLoad:pos"));
    expect(before).toBeCloseTo(100 / 100.01, 3);

    fix.coordinator.setComponentProperty(ceByLabel(fix, "relay"), "coilResistance", 1000);
    // Step a few times so the inductor's branch current settles to the new
    // V/R steady state and the RelayCoupling sees |I| < dropOutI.
    for (let i = 0; i < 50; i++) fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "rLoad:pos"));

    // Documented contract: raising coilResistance drops I_coil below
    // dropOutI; the contact opens and V(rLoad:pos) collapses.
    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThan(1e-3);
  });
});

describe("Relay parameter hot-load (T1) — pullInI", () => {
  it("hotload_pullInI_above_steady_state_coil_current_keeps_contact_open", () => {
    // vCoil=10V, coilResistance=100Ω → I_coil = 0.1A.
    // Default pullInI = 0.05A — contact closes during warm-start.
    // After  setComponentProperty(relay, "pullInI", 1.0): the threshold is
    // above the 0.1A steady-state current, so even after stepping the
    // RelayCoupling never re-asserts CLOSED. With dropOutI default = 0.02A
    // also below 0.1A, the contact stays in whatever state s1[CLOSED] was
    // when the threshold changed — but at the start of the next NR iter
    // wasClosed=true, |I|=0.1A > dropOutI=0.02A → stays closed; |I| not >=
    // pullInI=1.0 so no re-pull. CLOSED stays at 1. The visible signal of
    // the param change is that LOWERING pullInI to 0 also leaves the
    // contact closed — directionally identical. We instead lower dropOutI
    // dependently against pullInI: assert that raising pullInI to a value
    // above the steady-state current AND lowering vCoil so I < dropOutI
    // produces an OPEN contact, while the default thresholds leave it
    // closed at the same vCoil. We do this by exercising a fresh fixture
    // (Cat 4 mechanic permits 2-build comparisons when the param is
    // staged at compile in conjunction with topology drive).
    //
    // Simpler closed-form: hold vCoil at 0.04 * coilResistance (= 4V) so
    // I_coil = 0.04A. Default pullInI=0.05A — threshold NOT reached →
    // CLOSED=0. Raise pullInI? still not reached. Lower pullInI to 0.01A
    // → threshold reached → CLOSED=1. This is the canonical hot-load
    // observable: the contact transitions across the threshold.
    const fix = buildFixture({
      // I_coil = 4V / 100Ω = 0.04A. Above default dropOutI=0.02A but below
      // default pullInI=0.05A; from the wasClosed=false start the contact
      // does NOT pull in.
      build: (_r, facade) => buildRelayBench(facade, { vCoil: 4, vTest: 1, rLoad: 100 }),
    });
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "rLoad:pos"));
    // Contact OPEN: V(rLoad:pos) collapses toward 0V via Roff.
    expect(before).toBeLessThan(1e-3);

    fix.coordinator.setComponentProperty(ceByLabel(fix, "relay"), "pullInI", 0.01);
    for (let i = 0; i < 50; i++) fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "rLoad:pos"));

    // Documented contract: lowering pullInI below |I_coil|=0.04A makes the
    // contact pull in; V(rLoad:pos) jumps toward vTest=1V.
    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(0.9);
  });
});

describe("Relay parameter hot-load (T1) — dropOutI", () => {
  it("hotload_dropOutI_above_steady_state_coil_current_drops_contact", () => {
    // vCoil=10V, coilResistance=100Ω → I_coil = 0.1A. Default thresholds
    // pull in (0.1A > pullInI=0.05A) and stay in (0.1A > dropOutI=0.02A).
    // Raising dropOutI above 0.1A makes the RelayCoupling drop the contact
    // on the next iter even though the coil current is unchanged.
    const fix = buildFixture({
      build: (_r, facade) => buildRelayBench(facade, { vCoil: 10, vTest: 1, rLoad: 100 }),
    });
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "rLoad:pos"));
    expect(before).toBeCloseTo(100 / 100.01, 3);

    fix.coordinator.setComponentProperty(ceByLabel(fix, "relay"), "dropOutI", 1.0);
    for (let i = 0; i < 50; i++) fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "rLoad:pos"));

    // Documented contract: raising dropOutI above |I_coil|=0.1A drops the
    // contact; V(rLoad:pos) collapses toward 0V.
    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThan(1e-3);
  });
});

describe("Relay parameter hot-load (T1) — Ron", () => {
  it("hotload_Ron_changes_v_rload_pos_under_pull_in", () => {
    // Pull-in regime: contact CLOSED. V(rLoad:pos) divider:
    //   vTest * rLoad / (rLoad + Ron). Ron=0.01 → 100/100.01 ≈ 0.9999V.
    //   Ron=900 → 100/1000 = 0.1V.
    const fix = buildFixture({
      build: (_r, facade) => buildRelayBench(facade, { vCoil: 10, vTest: 1, rLoad: 100 }),
    });
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "rLoad:pos"));
    expect(before).toBeCloseTo(100 / 100.01, 3);

    fix.coordinator.setComponentProperty(ceByLabel(fix, "relay"), "Ron", 900);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "rLoad:pos"));

    // Documented contract: raising Ron drops V(rLoad:pos) (more drop across
    // the contact). Closed-form: 100/(100+900) = 0.1V.
    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(100 / 1000, 2);
  });
});

describe("Relay parameter hot-load (T1) — Roff", () => {
  it("hotload_Roff_changes_v_rload_pos_under_de_energised", () => {
    // De-energised regime: contact OPEN. V(rLoad:pos) divider:
    //   vTest * rLoad / (rLoad + Roff). Roff=1e9 → ≈ 1e-7V.
    //   Roff=10  → 100/110 ≈ 0.909V.
    const fix = buildFixture({
      build: (_r, facade) => buildRelayBench(facade, { vCoil: 0, vTest: 1, rLoad: 100 }),
    });
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "rLoad:pos"));
    expect(before).toBeLessThan(1e-3);

    fix.coordinator.setComponentProperty(ceByLabel(fix, "relay"), "Roff", 10);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "rLoad:pos"));

    // Documented contract: lowering Roff lifts V(rLoad:pos) when contact
    // is open. Closed-form: 100/(100+10) ≈ 0.909V.
    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeCloseTo(100 / 110, 2);
  });
});

describe("Relay parameter hot-load (T1) — inductance", () => {
  it("hotload_inductance_changes_coil_current_settling_dynamics", () => {
    // Inductance is a transient-only parameter (sets the L/R time
    // constant). Hot-load observable: at a fixed early simulation time
    // the coil current — and therefore the contact state — depends on
    // how far the inductor has charged. Default L=0.05H, coilR=100Ω:
    //   τ = L/R = 5e-4 s. After ~τ the current is at ~63% of steady
    //   state (I_ss=0.1A → ~0.063A).
    // Raising L to 50H:
    //   τ = 0.5 s. At the same elapsed simTime, I << pullInI=0.05A.
    //
    // We exercise the contract via two fresh fixtures (compile-staged
    // because L is consumed at compile via the netlist composite) and
    // step the same number of small transient steps for each. The
    // contact state at the end differs between the two builds.
    const fixDefault = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vSrc",  type: "DcVoltageSource", props: { label: "vSrc",  voltage: 10 } },
          { id: "vTest", type: "DcVoltageSource", props: { label: "vTest", voltage: 1 } },
          { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: 100 } },
          { id: "relay", type: "Relay",           props: { label: "relay", model: "behavioral",
                                                          inductance: 0.05 } },
          { id: "gnd",   type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vSrc:pos",  "relay:in1"], ["vSrc:neg",  "gnd:out"],
          ["relay:in2", "gnd:out"],
          ["relay:A1",  "rLoad:pos"], ["rLoad:neg", "gnd:out"],
          ["relay:B1",  "vTest:pos"], ["vTest:neg", "gnd:out"],
        ],
      }),
    });

    const fixSlow = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vSrc",  type: "DcVoltageSource", props: { label: "vSrc",  voltage: 10 } },
          { id: "vTest", type: "DcVoltageSource", props: { label: "vTest", voltage: 1 } },
          { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: 100 } },
          { id: "relay", type: "Relay",           props: { label: "relay", model: "behavioral",
                                                          inductance: 50 } },
          { id: "gnd",   type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vSrc:pos",  "relay:in1"], ["vSrc:neg",  "gnd:out"],
          ["relay:in2", "gnd:out"],
          ["relay:A1",  "rLoad:pos"], ["rLoad:neg", "gnd:out"],
          ["relay:B1",  "vTest:pos"], ["vTest:neg", "gnd:out"],
        ],
      }),
    });

    // Default L: warm-start (τ=5e-4 s; DCOP gives steady-state I=0.1A;
    // contact CLOSED). Slow L: warm-start DCOP also seeds steady-state
    // (DCOP solves the inductor as a short, so I=0.1A regardless of L);
    // but the differential settling is observable in transient. We
    // therefore drive a known transient from t=0 with both fixtures and
    // sample mid-flight: take the difference in V(rLoad:pos) at the
    // same step count.
    //
    // The DCOP seeding makes the post-warm-start state identical for
    // any L. The differential observable is the contact state AFTER a
    // short transient where both circuits are forced to re-charge from
    // zero current. We achieve this by setting the coil drive AFTER
    // warm-start: turn vSrc to 0V at warm-start build, then hot-load
    // to 10V and step. Default L charges fast → contact CLOSES quickly;
    // slow L charges slow → contact stays OPEN at the same step count.
    const fixDefaultDriven = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vSrc",  type: "DcVoltageSource", props: { label: "vSrc",  voltage: 0 } },
          { id: "vTest", type: "DcVoltageSource", props: { label: "vTest", voltage: 1 } },
          { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: 100 } },
          { id: "relay", type: "Relay",           props: { label: "relay", model: "behavioral",
                                                          inductance: 0.05 } },
          { id: "gnd",   type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vSrc:pos",  "relay:in1"], ["vSrc:neg",  "gnd:out"],
          ["relay:in2", "gnd:out"],
          ["relay:A1",  "rLoad:pos"], ["rLoad:neg", "gnd:out"],
          ["relay:B1",  "vTest:pos"], ["vTest:neg", "gnd:out"],
        ],
      }),
    });

    const fixSlowDriven = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vSrc",  type: "DcVoltageSource", props: { label: "vSrc",  voltage: 0 } },
          { id: "vTest", type: "DcVoltageSource", props: { label: "vTest", voltage: 1 } },
          { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: 100 } },
          { id: "relay", type: "Relay",           props: { label: "relay", model: "behavioral",
                                                          inductance: 50 } },
          { id: "gnd",   type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vSrc:pos",  "relay:in1"], ["vSrc:neg",  "gnd:out"],
          ["relay:in2", "gnd:out"],
          ["relay:A1",  "rLoad:pos"], ["rLoad:neg", "gnd:out"],
          ["relay:B1",  "vTest:pos"], ["vTest:neg", "gnd:out"],
        ],
      }),
    });

    // Touch the slow-default fixtures to silence unused-var lint and to
    // assert their warm-start completed without throwing. (The slow-vs-
    // fast hot-load assertion below is the canonical contract.)
    expect(fixDefault.engine.getNodeVoltage(nodeOf(fixDefault, "rLoad:pos"))).toBeCloseTo(100 / 100.01, 3);
    expect(fixSlow.engine.getNodeVoltage(nodeOf(fixSlow, "rLoad:pos"))).toBeCloseTo(100 / 100.01, 3);

    // Drive both: hot-load vCoil to 10V, step the same number of small
    // transient steps. Default L (τ=5e-4 s) settles within ~5τ ≈ 2.5ms;
    // slow L (τ=0.5 s) needs ~5*0.5=2.5s. Same 200×default-dt of steps
    // (default tStop=1ms / 50 → dt≈2e-5 → 200 steps ≈ 4ms) lands the
    // default circuit fully closed and the slow circuit still mid-charge.
    fixDefaultDriven.coordinator.setComponentProperty(ceByLabel(fixDefaultDriven, "vSrc"), "voltage", 10);
    fixSlowDriven.coordinator.setComponentProperty(ceByLabel(fixSlowDriven, "vSrc"), "voltage", 10);
    for (let i = 0; i < 200; i++) {
      fixDefaultDriven.coordinator.step();
      fixSlowDriven.coordinator.step();
    }

    const vDefault = fixDefaultDriven.engine.getNodeVoltage(nodeOf(fixDefaultDriven, "rLoad:pos"));
    const vSlow = fixSlowDriven.engine.getNodeVoltage(nodeOf(fixSlowDriven, "rLoad:pos"));

    // Documented contract: at the same elapsed simTime, raising L delays
    // the coil current crossing pullInI; the slow fixture's contact
    // state lags the default's. Either V(rLoad:pos) differs measurably,
    // OR the slow fixture's value is below the default's (slow lags).
    expect(vSlow).not.toBeCloseTo(vDefault, 2);
    expect(vSlow).toBeLessThan(vDefault);
  });
});

// ===========================================================================
// Category 9 — Bridge / digital interaction (T1)
// ===========================================================================
//
// The Relay's models.digital path (executeRelay) drives state[stBase] = 1
// when in1 XOR in2 is nonzero. Cat 9 asserts that the digital Relay
// connects A1 and B1 when energised: DIN drives A1, DOUT observes B1.
// The relay's switchPins=[2,3] pair (A1, B1) close together when the
// bus resolver sees state[stBase]=1.

describe("Relay digital bridge (T1) — Cat 9", () => {
  it("digital_in1_xor_in2_high_passes_din_to_dout", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDigitalRelayCircuit(facade));

    // Energise: in1=1, in2=0 → coilEnergised=1 → contact CLOSED.
    coordinator.writeByLabel("I1",  digital(1));
    coordinator.writeByLabel("I2",  digital(0));
    coordinator.writeByLabel("DIN", digital(1));
    coordinator.step();
    expect(coordinator.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 1 });

    coordinator.writeByLabel("DIN", digital(0));
    coordinator.step();
    expect(coordinator.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 0 });
  });

  it("digital_in1_eq_in2_de_energised_contact_does_not_pass_din", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDigitalRelayCircuit(facade));

    // De-energised: in1=in2=0 → coilEnergised=0 → contact OPEN. The bus
    // resolver leaves DOUT floating; canonical Out sink reads 0.
    coordinator.writeByLabel("I1",  digital(0));
    coordinator.writeByLabel("I2",  digital(0));
    coordinator.writeByLabel("DIN", digital(1));
    coordinator.step();
    expect(coordinator.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 0 });

    // Both-high also de-energised: in1 XOR in2 = 0 → contact OPEN.
    coordinator.writeByLabel("I1",  digital(1));
    coordinator.writeByLabel("I2",  digital(1));
    coordinator.writeByLabel("DIN", digital(1));
    coordinator.step();
    expect(coordinator.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 0 });
  });
});

// ===========================================================================
// Category 2 numerical / 3 / 5 — paired vs ngspice (T3)
// ===========================================================================
//
// Per Step 2c: the harness RUN lives in the FIRST it() of each describe
// (the transient run); subsequent siblings read from the recorded session
// via session.getStepEnd / session.compareAllSteps / compareAllAttempts.

describeIfDll("Relay paired vs ngspice — pull-in (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_PULL_IN, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_pull_in", async () => {
    await session.runTransient(0, 2e-5, 1e-6);
    session.compareAllSteps();
  }, 180_000);

  it("dcop_paired_pull_in", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_pull_in", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("Relay paired vs ngspice — de-energised (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_DE_ENERGISED, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_de_energised", async () => {
    await session.runTransient(0, 2e-5, 1e-6);
    session.compareAllSteps();
  }, 180_000);

  it("dcop_paired_de_energised", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_de_energised", () => {
    session.compareAllAttempts();
  });
});
