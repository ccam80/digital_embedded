import { describe, it, expect } from "vitest";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { createDefaultRegistry } from "../../register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

import type { Circuit } from "../../../core/circuit.js";
import type { SignalValue } from "../../../compile/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function digital(value: number): SignalValue {
  return { type: "digital", value };
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

// ---------------------------------------------------------------------------
// Programmatic circuit factories (T1) — analog regime
// ---------------------------------------------------------------------------
//
// NFET / PFET / FGNFET / FGPFET expose three analog ports: G, D, S. Each
// device is wired as a series source-follower:
//   vs (1V) -> fet:D
//   vg (configurable) -> fet:G
//   fet:S -> rload (1k) -> gnd
// With Ron=1Ω, Rload=1k, and the gate biased to drive the channel ON:
//   V(rload:pos) = vs * Rload / (Ron + Rload) = 1 * 1000 / 1001 ≈ 0.999V
// With the gate biased to drive the channel OFF (Roff=1e9):
//   V(rload:pos) ≈ vs * Rload / (Roff + Rload) ≈ 1µV

interface AnalogFetParams {
  vs?: number;
  vg?: number;
  Ron?: number;
  Roff?: number;
  Vth?: number;
  Rload?: number;
}

function buildAnalogNfetCircuit(facade: DefaultSimulatorFacade, p: AnalogFetParams = {}): Circuit {
  return facade.build({
    components: [
      { id: "vs",    type: "DcVoltageSource", props: { label: "vs",    voltage: p.vs ?? 1 } },
      { id: "vg",    type: "DcVoltageSource", props: { label: "vg",    voltage: p.vg ?? 1 } },
      { id: "n1",    type: "NFET",            props: { label: "n1",
                                                       model: "behavioral",
                                                       Ron:  p.Ron  ?? 1,
                                                       Roff: p.Roff ?? 1e9,
                                                       Vth:  p.Vth  ?? 0.5 } },
      { id: "rload", type: "Resistor",        props: { label: "rload", resistance: p.Rload ?? 1000 } },
      { id: "gnd",   type: "Ground",          props: { label: "gnd" } },
    ],
    connections: [
      ["vs:pos",    "n1:D"],
      ["vs:neg",    "gnd:out"],
      ["vg:pos",    "n1:G"],
      ["vg:neg",    "gnd:out"],
      ["n1:S",      "rload:pos"],
      ["rload:neg", "gnd:out"],
    ],
  });
}

function buildAnalogPfetCircuit(facade: DefaultSimulatorFacade, p: AnalogFetParams = {}): Circuit {
  // PFET active-low gate: vg=0V → on, vg=vs → off.
  return facade.build({
    components: [
      { id: "vs",    type: "DcVoltageSource", props: { label: "vs",    voltage: p.vs ?? 1 } },
      { id: "vg",    type: "DcVoltageSource", props: { label: "vg",    voltage: p.vg ?? 0 } },
      { id: "p1",    type: "PFET",            props: { label: "p1",
                                                       model: "behavioral",
                                                       Ron:  p.Ron  ?? 1,
                                                       Roff: p.Roff ?? 1e9,
                                                       Vth:  p.Vth  ?? 0.5 } },
      { id: "rload", type: "Resistor",        props: { label: "rload", resistance: p.Rload ?? 1000 } },
      { id: "gnd",   type: "Ground",          props: { label: "gnd" } },
    ],
    connections: [
      ["vs:pos",    "p1:D"],
      ["vs:neg",    "gnd:out"],
      ["vg:pos",    "p1:G"],
      ["vg:neg",    "gnd:out"],
      ["p1:S",      "rload:pos"],
      ["rload:neg", "gnd:out"],
    ],
  });
}

// ---------------------------------------------------------------------------
// Programmatic circuit factories (T1) — digital bridge regime (Cat 9)
// ---------------------------------------------------------------------------
//
// All four FETs expose a digital execute path on G / D / S. The digital
// model is a switch: G drives the gate; D is the data input; S is the
// observed data output. NFET/FGNFET conduct on G=1; PFET/FGPFET conduct
// on G=0; FGNFET/FGPFET also gate the conduction on the structural
// 'blown' property (compile-time seeded).

function buildDigitalNfetCircuit(facade: DefaultSimulatorFacade): Circuit {
  return facade.build({
    components: [
      { id: "g",   type: "In",   props: { label: "G",   bitWidth: 1 } },
      { id: "d",   type: "In",   props: { label: "D",   bitWidth: 1 } },
      { id: "n1",  type: "NFET", props: { label: "n1" } },
      { id: "s",   type: "Out",  props: { label: "S",   bitWidth: 1 } },
    ],
    connections: [
      ["g:out",  "n1:G"],
      ["d:out",  "n1:D"],
      ["n1:S",   "s:in"],
    ],
  });
}

function buildDigitalPfetCircuit(facade: DefaultSimulatorFacade): Circuit {
  return facade.build({
    components: [
      { id: "g",   type: "In",   props: { label: "G",   bitWidth: 1 } },
      { id: "d",   type: "In",   props: { label: "D",   bitWidth: 1 } },
      { id: "p1",  type: "PFET", props: { label: "p1" } },
      { id: "s",   type: "Out",  props: { label: "S",   bitWidth: 1 } },
    ],
    connections: [
      ["g:out",  "p1:G"],
      ["d:out",  "p1:D"],
      ["p1:S",   "s:in"],
    ],
  });
}

function buildDigitalFgnfetCircuit(facade: DefaultSimulatorFacade, opts: { blown?: boolean } = {}): Circuit {
  return facade.build({
    components: [
      { id: "g",   type: "In",     props: { label: "G",   bitWidth: 1 } },
      { id: "d",   type: "In",     props: { label: "D",   bitWidth: 1 } },
      { id: "fg",  type: "FGNFET", props: { label: "fg",  blown: opts.blown ?? false } },
      { id: "s",   type: "Out",    props: { label: "S",   bitWidth: 1 } },
    ],
    connections: [
      ["g:out",  "fg:G"],
      ["d:out",  "fg:D"],
      ["fg:S",   "s:in"],
    ],
  });
}

function buildDigitalFgpfetCircuit(facade: DefaultSimulatorFacade, opts: { blown?: boolean } = {}): Circuit {
  return facade.build({
    components: [
      { id: "g",   type: "In",     props: { label: "G",   bitWidth: 1 } },
      { id: "s",   type: "In",     props: { label: "S",   bitWidth: 1 } },
      { id: "fg",  type: "FGPFET", props: { label: "fg",  blown: opts.blown ?? false } },
      { id: "d",   type: "Out",    props: { label: "D",   bitWidth: 1 } },
    ],
    connections: [
      ["g:out",  "fg:G"],
      ["s:out",  "fg:S"],
      ["fg:D",   "d:in"],
    ],
  });
}

// ===========================================================================
// NFET — Categories 1, 2 (analytical), 4, 9
// ===========================================================================

describe("NFET initialization (T1)", () => {
  it("init_post_warm_start_node_voltage_pass_through_seed", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogNfetCircuit(facade, {
        vs: 1, vg: 1, Ron: 1, Roff: 1e9, Vth: 0.5, Rload: 1000,
      }),
    });
    // n1:D is on the same net as vs:pos, driven by vs=1V.
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vs:pos"))).toBeCloseTo(1, 3);
    // n1:S is on the same net as rload:pos. With NFET drv ON (vg-Vth>0), the
    // channel conducts: V(rload:pos) ≈ vs * Rload / (Ron + Rload) ≈ 0.999V.
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"))).toBeCloseTo(1000 / 1001, 3);
  });
});

describe("NFET DCOP analytical (T1) — gate ON pass-through", () => {
  it("dcop_gate_on_drives_v_s_near_vs", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogNfetCircuit(facade, {
        vs: 1, vg: 1, Ron: 1, Roff: 1e9, Vth: 0.5, Rload: 1000,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    // n1:D on vs:pos = 1V (driven by vs).
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vs:pos"))).toBeCloseTo(1, 6);
    // n1:S on rload:pos. Closed-form: V(S) = vs * Rload / (Ron + Rload).
    const vS = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));
    expect(vS).toBeCloseTo(1 * 1000 / (1 + 1000), 3);
    expect(vS).toBeGreaterThan(1000 / 1001 - 1e-3);
    expect(vS).toBeLessThanOrEqual(1);
  });
});

describe("NFET DCOP analytical (T1) — gate OFF isolation", () => {
  it("dcop_gate_off_drives_v_s_near_zero", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogNfetCircuit(facade, {
        vs: 1, vg: 0, Ron: 1, Roff: 1e9, Vth: 0.5, Rload: 1000,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vs:pos"))).toBeCloseTo(1, 6);
    // Gate OFF → channel high-resistance: V(S) = vs * Rload / (Roff + Rload)
    //   = 1 * 1000 / (1e9 + 1000) ≈ 1e-6 V.
    const vS = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));
    expect(vS).toBeCloseTo(1 * 1000 / (1e9 + 1000), 5);
    expect(vS).toBeLessThan(1e-3);
  });
});

describe("NFET parameter hot-load (T1) — Ron", () => {
  it("hotload_Ron_drops_v_s_under_load", () => {
    // Before: Ron=1, Rload=1k → V(S) ≈ 0.999V.
    // After  Ron=200: V(S) = 1000 / (200 + 1000) ≈ 0.833V.
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogNfetCircuit(facade, {
        vs: 1, vg: 1, Ron: 1, Roff: 1e9, Vth: 0.5, Rload: 1000,
      }),
    });
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));
    expect(before).toBeCloseTo(1000 / 1001, 3);

    fix.coordinator.setComponentProperty(fix.element("n1"), "Ron", 200);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));

    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(1000 / 1200, 2);
  });
});

describe("NFET parameter hot-load (T1) — Roff", () => {
  it("hotload_Roff_lifts_v_s_when_gate_off", () => {
    // Both gate OFF (vg=0). Before Roff=1e9 → V(S) ≈ 1µV.
    // After Roff=10 → V(S) = 1000 / (10 + 1000) ≈ 0.990V.
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogNfetCircuit(facade, {
        vs: 1, vg: 0, Ron: 1, Roff: 1e9, Vth: 0.5, Rload: 1000,
      }),
    });
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));
    expect(before).toBeLessThan(1e-3);

    fix.coordinator.setComponentProperty(fix.element("n1"), "Roff", 10);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));

    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeCloseTo(1000 / 1010, 2);
  });
});

describe("NFET parameter hot-load (T1) — Vth", () => {
  it("hotload_Vth_above_gate_drive_isolates_channel", () => {
    // Before Vth=0.5 with vg=1V → on. After Vth=2 with vg=1V → off.
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogNfetCircuit(facade, {
        vs: 1, vg: 1, Ron: 1, Roff: 1e9, Vth: 0.5, Rload: 1000,
      }),
    });
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));
    expect(before).toBeCloseTo(1000 / 1001, 3);

    fix.coordinator.setComponentProperty(fix.element("n1"), "Vth", 2);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));

    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThan(1e-3);
  });
});

describe("NFET digital bridge (T1) — Cat 9", () => {
  it("digital_g_high_propagates_d_to_s", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDigitalNfetCircuit(facade));
    coordinator.writeByLabel("G", digital(1));
    coordinator.writeByLabel("D", digital(1));
    coordinator.step();
    expect(coordinator.readByLabel("S")).toMatchObject({ type: "digital", value: 1 });

    coordinator.writeByLabel("D", digital(0));
    coordinator.step();
    expect(coordinator.readByLabel("S")).toMatchObject({ type: "digital", value: 0 });
  });

  it("digital_g_low_isolates_s_from_d", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDigitalNfetCircuit(facade));
    coordinator.writeByLabel("G", digital(0));
    coordinator.writeByLabel("D", digital(1));
    coordinator.step();
    // Gate low → channel open → S disconnected from D, observer reads 0.
    expect(coordinator.readByLabel("S")).toMatchObject({ type: "digital", value: 0 });
  });
});

// ===========================================================================
// PFET — Categories 1, 2 (analytical), 4, 9
// ===========================================================================

describe("PFET initialization (T1)", () => {
  it("init_post_warm_start_node_voltage_pass_through_seed", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogPfetCircuit(facade, {
        vs: 1, vg: 0, Ron: 1, Roff: 1e9, Vth: 0.5, Rload: 1000,
      }),
    });
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vs:pos"))).toBeCloseTo(1, 3);
    // PFET on with vg=0V (V(G)-V(S) < -Vth condition met as channel pulls
    // high). V(rload:pos) ≈ vs * Rload / (Ron + Rload) ≈ 0.999V.
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"))).toBeCloseTo(1000 / 1001, 3);
  });
});

describe("PFET DCOP analytical (T1) — gate ON pass-through", () => {
  it("dcop_gate_low_drives_v_s_near_vs", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogPfetCircuit(facade, {
        vs: 1, vg: 0, Ron: 1, Roff: 1e9, Vth: 0.5, Rload: 1000,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vs:pos"))).toBeCloseTo(1, 6);
    const vS = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));
    expect(vS).toBeCloseTo(1 * 1000 / (1 + 1000), 3);
    expect(vS).toBeLessThanOrEqual(1);
  });
});

describe("PFET DCOP analytical (T1) — gate OFF isolation", () => {
  it("dcop_gate_high_drives_v_s_near_zero", () => {
    // PFET off when V(G)-V(S) >= -Vth: vg=1V, Vth=0.5 → channel off.
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogPfetCircuit(facade, {
        vs: 1, vg: 1, Ron: 1, Roff: 1e9, Vth: 0.5, Rload: 1000,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const vS = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));
    expect(vS).toBeCloseTo(1 * 1000 / (1e9 + 1000), 5);
    expect(vS).toBeLessThan(1e-3);
  });
});

describe("PFET parameter hot-load (T1) — Ron", () => {
  it("hotload_Ron_drops_v_s_under_load", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogPfetCircuit(facade, {
        vs: 1, vg: 0, Ron: 1, Roff: 1e9, Vth: 0.5, Rload: 1000,
      }),
    });
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));
    expect(before).toBeCloseTo(1000 / 1001, 3);

    fix.coordinator.setComponentProperty(fix.element("p1"), "Ron", 200);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));

    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(1000 / 1200, 2);
  });
});

describe("PFET parameter hot-load (T1) — Roff", () => {
  it("hotload_Roff_lifts_v_s_when_gate_off", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogPfetCircuit(facade, {
        vs: 1, vg: 1, Ron: 1, Roff: 1e9, Vth: 0.5, Rload: 1000,
      }),
    });
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));
    expect(before).toBeLessThan(1e-3);

    fix.coordinator.setComponentProperty(fix.element("p1"), "Roff", 10);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));

    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeCloseTo(1000 / 1010, 2);
  });
});

describe("PFET parameter hot-load (T1) — Vth", () => {
  it("hotload_Vth_inverts_channel_state", () => {
    // PFET on-condition: V(G)-V(S) < -Vth.
    // Before Vth=0.5, vg=0, V(S)≈vs=1 → V(G)-V(S)=-1 < -0.5 → ON.
    // After Vth=5,             V(G)-V(S)=-1 > -5  → OFF.
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogPfetCircuit(facade, {
        vs: 1, vg: 0, Ron: 1, Roff: 1e9, Vth: 0.5, Rload: 1000,
      }),
    });
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));
    expect(before).toBeCloseTo(1000 / 1001, 3);

    fix.coordinator.setComponentProperty(fix.element("p1"), "Vth", 5);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "rload:pos"));

    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThan(1e-3);
  });
});

describe("PFET digital bridge (T1) — Cat 9", () => {
  it("digital_g_low_propagates_d_to_s", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDigitalPfetCircuit(facade));
    // PFET digital execute: closed = gate ^ 1, then S follows D.
    coordinator.writeByLabel("G", digital(0));
    coordinator.writeByLabel("D", digital(1));
    coordinator.step();
    expect(coordinator.readByLabel("S")).toMatchObject({ type: "digital", value: 1 });

    coordinator.writeByLabel("D", digital(0));
    coordinator.step();
    expect(coordinator.readByLabel("S")).toMatchObject({ type: "digital", value: 0 });
  });

  it("digital_g_high_isolates_s_from_d", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDigitalPfetCircuit(facade));
    coordinator.writeByLabel("G", digital(1));
    coordinator.writeByLabel("D", digital(1));
    coordinator.step();
    expect(coordinator.readByLabel("S")).toMatchObject({ type: "digital", value: 0 });
  });
});

// ===========================================================================
// FGNFET — Categories 1, 4 (compile-time-seeded structural prop), 9
// ===========================================================================
//
// FGNFET's only model entry is "default" (analog netlist with NMOS spice-l1
// + FGNFETBlownDriver). Cat 2 analytical / Cat 4 numerical hot-loads on the
// SPICE MOSFET parameters are not in scope here (they belong on the MOSFET
// component); FGNFET's distinguishing surface is the structural 'blown'
// property which gates conduction in BOTH the analog (FGNFETBlownDriver
// stamps the floating-gate node) and digital (executeFGNFET reads
// blownFlag) paths. The canonical Cat 4 here is the compile-time-seeded
// variant from the test-tools document: build the same circuit twice
// (blown=false, blown=true) and assert the documented post-compile
// observable differs.

describe("FGNFET digital bridge (T1) — Cat 9", () => {
  it("digital_g_high_blown_false_propagates_d_to_s", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDigitalFgnfetCircuit(facade, { blown: false }));
    coordinator.writeByLabel("G", digital(1));
    coordinator.writeByLabel("D", digital(1));
    coordinator.step();
    expect(coordinator.readByLabel("S")).toMatchObject({ type: "digital", value: 1 });

    coordinator.writeByLabel("D", digital(0));
    coordinator.step();
    expect(coordinator.readByLabel("S")).toMatchObject({ type: "digital", value: 0 });
  });

  it("digital_g_low_blown_false_isolates_s_from_d", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDigitalFgnfetCircuit(facade, { blown: false }));
    coordinator.writeByLabel("G", digital(0));
    coordinator.writeByLabel("D", digital(1));
    coordinator.step();
    expect(coordinator.readByLabel("S")).toMatchObject({ type: "digital", value: 0 });
  });
});

describe("FGNFET compile-time-seeded structural property (T1) — Cat 4 (blown)", () => {
  it("blown_property_seeds_state_to_permanently_off", () => {
    // blown=false: gate high → S follows D (data observable as 1).
    const registry1 = createDefaultRegistry();
    const facade1 = new DefaultSimulatorFacade(registry1);
    const coord1 = facade1.compile(buildDigitalFgnfetCircuit(facade1, { blown: false }));
    coord1.writeByLabel("G", digital(1));
    coord1.writeByLabel("D", digital(1));
    coord1.step();
    expect(coord1.readByLabel("S")).toMatchObject({ type: "digital", value: 1 });

    // blown=true: gate high — channel STILL off, S=0 regardless.
    const registry2 = createDefaultRegistry();
    const facade2 = new DefaultSimulatorFacade(registry2);
    const coord2 = facade2.compile(buildDigitalFgnfetCircuit(facade2, { blown: true }));
    coord2.writeByLabel("G", digital(1));
    coord2.writeByLabel("D", digital(1));
    coord2.step();
    expect(coord2.readByLabel("S")).toMatchObject({ type: "digital", value: 0 });
  });

  it("blown_property_seeds_state_to_permanently_off_g_low", () => {
    // blown=true, gate low: still off (regression check that blown gates
    // both gate states identically).
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildDigitalFgnfetCircuit(facade, { blown: true }));
    coord.writeByLabel("G", digital(0));
    coord.writeByLabel("D", digital(1));
    coord.step();
    expect(coord.readByLabel("S")).toMatchObject({ type: "digital", value: 0 });
  });
});

// ===========================================================================
// FGPFET — Categories 1, 4 (compile-time-seeded structural prop), 9
// ===========================================================================
//
// FGPFET's digital outputSchema is ["S", "D"] (note PFET pin order). The
// digital execute reads input G and writes the output D-side via the bus
// resolver based on the gate-S input. The canonical bridge fixture wires
// G + S as inputs and observes D as the output, mirroring the executeFGPFET
// data-flow direction (state[drainNet] = state[sourceNet] when closed).

describe("FGPFET digital bridge (T1) — Cat 9", () => {
  it("digital_g_low_blown_false_propagates_s_to_d", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDigitalFgpfetCircuit(facade, { blown: false }));
    coordinator.writeByLabel("G", digital(0));
    coordinator.writeByLabel("S", digital(1));
    coordinator.step();
    expect(coordinator.readByLabel("D")).toMatchObject({ type: "digital", value: 1 });

    coordinator.writeByLabel("S", digital(0));
    coordinator.step();
    expect(coordinator.readByLabel("D")).toMatchObject({ type: "digital", value: 0 });
  });

  it("digital_g_high_blown_false_isolates_d_from_s", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDigitalFgpfetCircuit(facade, { blown: false }));
    coordinator.writeByLabel("G", digital(1));
    coordinator.writeByLabel("S", digital(1));
    coordinator.step();
    expect(coordinator.readByLabel("D")).toMatchObject({ type: "digital", value: 0 });
  });
});

describe("FGPFET compile-time-seeded structural property (T1) — Cat 4 (blown)", () => {
  it("blown_property_seeds_state_to_permanently_off", () => {
    // blown=false: gate low → D follows S (observed as 1).
    const registry1 = createDefaultRegistry();
    const facade1 = new DefaultSimulatorFacade(registry1);
    const coord1 = facade1.compile(buildDigitalFgpfetCircuit(facade1, { blown: false }));
    coord1.writeByLabel("G", digital(0));
    coord1.writeByLabel("S", digital(1));
    coord1.step();
    expect(coord1.readByLabel("D")).toMatchObject({ type: "digital", value: 1 });

    // blown=true: gate low — channel STILL off, D=0 regardless.
    const registry2 = createDefaultRegistry();
    const facade2 = new DefaultSimulatorFacade(registry2);
    const coord2 = facade2.compile(buildDigitalFgpfetCircuit(facade2, { blown: true }));
    coord2.writeByLabel("G", digital(0));
    coord2.writeByLabel("S", digital(1));
    coord2.step();
    expect(coord2.readByLabel("D")).toMatchObject({ type: "digital", value: 0 });
  });

  it("blown_property_seeds_state_to_permanently_off_g_high", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildDigitalFgpfetCircuit(facade, { blown: true }));
    coord.writeByLabel("G", digital(1));
    coord.writeByLabel("S", digital(1));
    coord.step();
    expect(coord.readByLabel("D")).toMatchObject({ type: "digital", value: 0 });
  });
});
