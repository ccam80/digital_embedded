import { describe, it, expect } from "vitest";

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

// ---------------------------------------------------------------------------
// Programmatic circuit factories (T1) — one per PLD digital component variant
// ---------------------------------------------------------------------------

// PullUp: pullup:out → Out("DOUT"). No drivers other than pullup → DOUT=1.
function buildPullUpCircuit(facade: DefaultSimulatorFacade, props: { bitWidth?: number } = {}): Circuit {
  return facade.build({
    components: [
      { id: "pu",   type: "PullUp", props: { label: "PU", bitWidth: props.bitWidth ?? 1 } },
      { id: "dout", type: "Out",   props: { label: "DOUT", bitWidth: props.bitWidth ?? 1 } },
    ],
    connections: [
      ["pu:out", "dout:in"],
    ],
  });
}

// PullDown: pulldown:out → Out("DOUT"). No drivers other than pulldown → DOUT=0.
function buildPullDownCircuit(facade: DefaultSimulatorFacade, props: { bitWidth?: number } = {}): Circuit {
  return facade.build({
    components: [
      { id: "pd",   type: "PullDown", props: { label: "PD", bitWidth: props.bitWidth ?? 1 } },
      { id: "dout", type: "Out",     props: { label: "DOUT", bitWidth: props.bitWidth ?? 1 } },
    ],
    connections: [
      ["pd:out", "dout:in"],
    ],
  });
}

// PldDiodeBackward: In("DIN") → db:in; db:out → Out("DOUT").
// Backward diode actively drives DOUT to whatever DIN is (in=1 → 1, in=0 → 0).
function buildDiodeBackwardCircuit(facade: DefaultSimulatorFacade, props: { blown?: boolean } = {}): Circuit {
  return facade.build({
    components: [
      { id: "din",  type: "In",               props: { label: "DIN",  bitWidth: 1 } },
      { id: "db",   type: "PldDiodeBackward", props: { label: "DB",   blown: props.blown ?? false } },
      { id: "dout", type: "Out",              props: { label: "DOUT", bitWidth: 1 } },
    ],
    connections: [
      ["din:out", "db:in"],
      ["db:out",  "dout:in"],
    ],
  });
}

// PldDiodeForward + PullDown wired-OR sink:
// In("DIN") → df:in; df:out joined with pulldown net → Out("DOUT").
// Forward diode drives 1 when in=1; goes high-Z when in=0 → pull-down resolves DOUT=0.
function buildDiodeForwardCircuit(facade: DefaultSimulatorFacade, props: { blown?: boolean } = {}): Circuit {
  return facade.build({
    components: [
      { id: "din",  type: "In",              props: { label: "DIN",  bitWidth: 1 } },
      { id: "df",   type: "PldDiodeForward", props: { label: "DF",   blown: props.blown ?? false } },
      { id: "pd",   type: "PullDown",        props: { label: "PD",   bitWidth: 1 } },
      { id: "dout", type: "Out",             props: { label: "DOUT", bitWidth: 1 } },
    ],
    connections: [
      ["din:out", "df:in"],
      ["df:out",  "dout:in"],
      ["df:out",  "pd:out"],
    ],
  });
}

// PldDiode (bidirectional, wired-OR via pull-down on cathode side):
// Anode side (out2) driven by In("ANODE"); cathode side (out1) joined to PullDown
// sink and Out("CATHODE") observer.
// Forward conduction: anode high (driven, not high-Z) → diode pulls cathode to 1.
// Anode low / high-Z → diode does not drive cathode → pull-down resolves cathode to 0.
function buildDiodeBidirectionalCircuit(facade: DefaultSimulatorFacade, props: { blown?: boolean } = {}): Circuit {
  return facade.build({
    components: [
      { id: "ain",   type: "In",       props: { label: "ANODE",   bitWidth: 1 } },
      { id: "diode", type: "PldDiode", props: { label: "D",       blown: props.blown ?? false } },
      { id: "pd",    type: "PullDown", props: { label: "PD",      bitWidth: 1 } },
      { id: "cout",  type: "Out",      props: { label: "CATHODE", bitWidth: 1 } },
    ],
    connections: [
      // Anode side (out2): driven by In so ANODE drives the diode.
      ["ain:out",     "diode:out2"],
      // Cathode side (out1): observed by Out, with PullDown providing the floor.
      ["diode:out1",  "cout:in"],
      ["diode:out1",  "pd:out"],
    ],
  });
}

// PldDiode (bidirectional, INVERTED topology — cathode-driven, anode-observed):
// Cathode side (out1) driven by In("CATHODE"); anode side (out2) joined to PullUp
// floor and Out("ANODE") observer.
// Reverse-direction conduction: cathode driven low → diode actively pulls the
// anode-side net low against the PullUp floor (the canonical reverse-direction
// observable for the bidirectional component).
function buildDiodeBidirectionalReverseCircuit(facade: DefaultSimulatorFacade, props: { blown?: boolean } = {}): Circuit {
  return facade.build({
    components: [
      { id: "cin",   type: "In",       props: { label: "CATHODE", bitWidth: 1 } },
      { id: "diode", type: "PldDiode", props: { label: "D",       blown: props.blown ?? false } },
      { id: "pu",    type: "PullUp",   props: { label: "PU",      bitWidth: 1 } },
      { id: "aout",  type: "Out",      props: { label: "ANODE",   bitWidth: 1 } },
    ],
    connections: [
      // Cathode side (out1): driven by In so CATHODE drives the diode in reverse.
      ["cin:out",     "diode:out1"],
      // Anode side (out2): observed by Out, with PullUp providing the high floor.
      ["diode:out2",  "aout:in"],
      ["diode:out2",  "pu:out"],
    ],
  });
}

// ===========================================================================
// Category 9 — Bridge / digital interaction (T1)
// ===========================================================================

describe("PullUp digital bridge (T1) — Cat 9", () => {
  it("pullup_drives_floating_net_to_one", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildPullUpCircuit(facade));
    coordinator.step();
    expect(coordinator.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 1 });
  });

  it("pullup_4bit_drives_all_ones_mask", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildPullUpCircuit(facade, { bitWidth: 4 }));
    coordinator.step();
    // 4-bit pull-up: every bit pulled high → 0b1111 = 15.
    expect(coordinator.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 0xF });
  });
});

describe("PullDown digital bridge (T1) — Cat 9", () => {
  it("pulldown_drives_floating_net_to_zero", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildPullDownCircuit(facade));
    coordinator.step();
    expect(coordinator.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 0 });
  });

  it("pulldown_8bit_drives_all_zero_mask", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildPullDownCircuit(facade, { bitWidth: 8 }));
    coordinator.step();
    expect(coordinator.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 0 });
  });
});

describe("PldDiodeBackward digital bridge (T1) — Cat 9", () => {
  it("diode_backward_drives_dout_to_din", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDiodeBackwardCircuit(facade));
    coordinator.writeByLabel("DIN", digital(1));
    coordinator.step();
    expect(coordinator.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 1 });

    coordinator.writeByLabel("DIN", digital(0));
    coordinator.step();
    expect(coordinator.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 0 });
  });
});

describe("PldDiodeForward digital bridge (T1) — Cat 9", () => {
  it("diode_forward_drives_dout_high_when_din_high", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDiodeForwardCircuit(facade));
    coordinator.writeByLabel("DIN", digital(1));
    coordinator.step();
    expect(coordinator.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 1 });
  });

  it("diode_forward_yields_to_pulldown_when_din_low", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDiodeForwardCircuit(facade));
    coordinator.writeByLabel("DIN", digital(0));
    coordinator.step();
    // Forward diode high-Z when in=0 → pull-down resolves DOUT to 0.
    expect(coordinator.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 0 });
  });
});

describe("PldDiode bidirectional digital bridge (T1) — Cat 9", () => {
  it("diode_anode_high_pulls_cathode_to_one", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDiodeBidirectionalCircuit(facade));
    coordinator.writeByLabel("ANODE", digital(1));
    coordinator.step();
    // Forward conduction: anode driven high → cathode driven to 1 (overrides pull-down).
    expect(coordinator.readByLabel("CATHODE")).toMatchObject({ type: "digital", value: 1 });
  });

  it("diode_anode_low_yields_cathode_to_pulldown_zero", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDiodeBidirectionalCircuit(facade));
    coordinator.writeByLabel("ANODE", digital(0));
    coordinator.step();
    // Anode low → diode does not drive cathode high → pull-down resolves cathode to 0.
    expect(coordinator.readByLabel("CATHODE")).toMatchObject({ type: "digital", value: 0 });
  });
});

describe("PldDiode bidirectional digital bridge — reverse direction (T1) — Cat 9", () => {
  it("diode_cathode_low_pulls_anode_to_zero", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const coordinator = facade.compile(buildDiodeBidirectionalReverseCircuit(facade));
    coordinator.writeByLabel("CATHODE", digital(0));
    coordinator.step();
    // Reverse-direction conduction: cathode driven low → diode pulls anode-side
    // net to 0, overriding the PullUp floor (which would otherwise resolve to 1).
    expect(coordinator.readByLabel("ANODE")).toMatchObject({ type: "digital", value: 0 });
  });
});

// ===========================================================================
// Category 4 — Compile-time-seeded structural properties (T1)
// ===========================================================================
//
// `blown` is a structural PropertyBag entry consumed at compile() to seed the
// diode's output sentinel slot. It is not hot-loadable post-compile; the
// canonical Cat 4 it() builds the same circuit twice — once with the property
// at default, once with it set — and asserts the documented post-compile
// observable differs.

describe("PldDiodeBackward blown structural prop (T1) — Cat 4 compile-seeded", () => {
  it("blown_property_disables_active_drive_observable_at_dout", () => {
    const registryDefault = createDefaultRegistry();
    const facadeDefault = new DefaultSimulatorFacade(registryDefault);
    const coordDefault = facadeDefault.compile(buildDiodeBackwardCircuit(facadeDefault, { blown: false }));
    coordDefault.writeByLabel("DIN", digital(1));
    coordDefault.step();
    // Not blown: backward diode actively drives DOUT to DIN value.
    expect(coordDefault.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 1 });

    const registryBlown = createDefaultRegistry();
    const facadeBlown = new DefaultSimulatorFacade(registryBlown);
    const coordBlown = facadeBlown.compile(buildDiodeBackwardCircuit(facadeBlown, { blown: true }));
    coordBlown.writeByLabel("DIN", digital(1));
    coordBlown.step();
    // Blown: documented contract is open-circuit / high-Z (no active drive).
    // The observable: DOUT no longer reads DIN's high value; it reads 0
    // (default for an undriven net) instead of the 1 the unblown variant produced.
    expect(coordBlown.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 0 });
  });
});

describe("PldDiodeForward blown structural prop (T1) — Cat 4 compile-seeded", () => {
  it("blown_property_keeps_dout_at_pulldown_default_with_din_high", () => {
    const registryDefault = createDefaultRegistry();
    const facadeDefault = new DefaultSimulatorFacade(registryDefault);
    const coordDefault = facadeDefault.compile(buildDiodeForwardCircuit(facadeDefault, { blown: false }));
    coordDefault.writeByLabel("DIN", digital(1));
    coordDefault.step();
    // Not blown: forward diode drives DOUT high when in=1.
    expect(coordDefault.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 1 });

    const registryBlown = createDefaultRegistry();
    const facadeBlown = new DefaultSimulatorFacade(registryBlown);
    const coordBlown = facadeBlown.compile(buildDiodeForwardCircuit(facadeBlown, { blown: true }));
    coordBlown.writeByLabel("DIN", digital(1));
    coordBlown.step();
    // Blown: forward diode permanently high-Z → pull-down resolves DOUT to 0
    // even with DIN high (the diode no longer contributes a 1 to the wired-OR net).
    expect(coordBlown.readByLabel("DOUT")).toMatchObject({ type: "digital", value: 0 });
  });
});

describe("PldDiode (bidirectional) blown structural prop (T1) — Cat 4 compile-seeded", () => {
  it("blown_property_keeps_cathode_at_pulldown_default_with_anode_high", () => {
    const registryDefault = createDefaultRegistry();
    const facadeDefault = new DefaultSimulatorFacade(registryDefault);
    const coordDefault = facadeDefault.compile(buildDiodeBidirectionalCircuit(facadeDefault, { blown: false }));
    coordDefault.writeByLabel("ANODE", digital(1));
    coordDefault.step();
    // Not blown: anode high pulls cathode to 1.
    expect(coordDefault.readByLabel("CATHODE")).toMatchObject({ type: "digital", value: 1 });

    const registryBlown = createDefaultRegistry();
    const facadeBlown = new DefaultSimulatorFacade(registryBlown);
    const coordBlown = facadeBlown.compile(buildDiodeBidirectionalCircuit(facadeBlown, { blown: true }));
    coordBlown.writeByLabel("ANODE", digital(1));
    coordBlown.step();
    // Blown: diode permanently open → cathode no longer pulled to 1 by the diode;
    // pull-down resolves cathode to 0 even with anode high.
    expect(coordBlown.readByLabel("CATHODE")).toMatchObject({ type: "digital", value: 0 });
  });
});
