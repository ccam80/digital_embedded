import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import { describeIfDll } from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { createDefaultRegistry } from "../../register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

import type { Circuit } from "../../../core/circuit.js";
import type { CircuitElement } from "../../../core/element.js";
import type { SignalValue } from "../../../compile/types.js";

// ---------------------------------------------------------------------------
// .dts fixture paths (T3 harness) — authored under fixtures/
// ---------------------------------------------------------------------------
//
// SPST closed: vs=10V drives sw:A1; sw:B1 -> rload(1k) -> gnd. closed=true,
// Ron=1 -> V(B1) ~ 10*1k/(1+1k) ~ 9.99V.
const DTS_SPST_CLOSED = path.resolve(
  "src/components/switching/__tests__/fixtures/switch-canon-spst-closed.dts",
);

// SPST open: vs=10V drives sw:A1; sw:B1 -> rload(1k) -> gnd. closed=false,
// Roff=1e9 -> V(B1) ~ 10*1k/(1e9+1k) ~ 1e-5V.
const DTS_SPST_OPEN = path.resolve(
  "src/components/switching/__tests__/fixtures/switch-canon-spst-open.dts",
);

// SPDT closed: vs=10V -> sw:A1; sw:B1 -> rb(1k) -> gnd; sw:C1 -> rc(1k) -> gnd.
// closed=true: AB on (Ron=1), AC off (Roff=1e9). V(B1) ~ 9.99V, V(C1) ~ 0.
const DTS_SPDT_CLOSED = path.resolve(
  "src/components/switching/__tests__/fixtures/switch-dt-canon-closed.dts",
);

// SPDT open: vs=10V -> sw:A1; sw:B1 -> rb(1k) -> gnd; sw:C1 -> rc(1k) -> gnd.
// closed=false: AB off (Roff=1e9), AC on (Ron=1). V(B1) ~ 0, V(C1) ~ 9.99V.
const DTS_SPDT_OPEN = path.resolve(
  "src/components/switching/__tests__/fixtures/switch-dt-canon-open.dts",
);

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

function ceByLabel(fix: ReturnType<typeof buildFixture>, label: string): CircuitElement {
  for (const ce of fix.circuit.elementToCircuitElement.values()) {
    if (ce.getProperties().getOrDefault<string>("label", "") === label) return ce;
  }
  throw new Error(`CircuitElement with label '${label}' not found`);
}

// ---------------------------------------------------------------------------
// Programmatic circuit factories (T1)
// ---------------------------------------------------------------------------

interface SpstDividerParams {
  vSource: number;
  closed: boolean;
  Ron?: number;
  Roff?: number;
  normallyClosed?: boolean;
  rLoad?: number;
}

function buildSpstDivider(facade: DefaultSimulatorFacade, p: SpstDividerParams): Circuit {
  // vs -> sw(A1->B1) -> rload -> gnd. Closed: V(B1) ~ vs * rLoad/(Ron+rLoad);
  // open: V(B1) ~ vs * rLoad/(Roff+rLoad).
  const swProps: Record<string, string | number | boolean> = {
    label: "sw1",
    model: "behavioral",
    closed: p.closed,
    Ron: p.Ron ?? 1,
    Roff: p.Roff ?? 1e9,
  };
  if (p.normallyClosed !== undefined) swProps.normallyClosed = p.normallyClosed;
  return facade.build({
    components: [
      { id: "vs",   type: "DcVoltageSource", props: { label: "vs",   voltage: p.vSource } },
      { id: "sw",   type: "Switch",          props: swProps },
      { id: "rl",   type: "Resistor",        props: { label: "rl",   resistance: p.rLoad ?? 1000 } },
      { id: "gnd",  type: "Ground",          props: { label: "gnd" } },
    ],
    connections: [
      ["vs:pos", "sw:A1"],
      ["sw:B1",  "rl:pos"],
      ["rl:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

interface SpdtDividerParams {
  vSource: number;
  closed: boolean;
  Ron?: number;
  Roff?: number;
  rLoadB?: number;
  rLoadC?: number;
}

function buildSpdtDivider(facade: DefaultSimulatorFacade, p: SpdtDividerParams): Circuit {
  // vs -> sw(A1); sw(B1) -> rb -> gnd; sw(C1) -> rc -> gnd.
  // closed=true: AB closed (Ron), AC open (Roff). closed=false: inverted.
  return facade.build({
    components: [
      { id: "vs",   type: "DcVoltageSource", props: { label: "vs",  voltage: p.vSource } },
      { id: "sw",   type: "SwitchDT",        props: { label: "sw1", model: "behavioral", closed: p.closed, Ron: p.Ron ?? 1, Roff: p.Roff ?? 1e9 } },
      { id: "rb",   type: "Resistor",        props: { label: "rb",  resistance: p.rLoadB ?? 1000 } },
      { id: "rc",   type: "Resistor",        props: { label: "rc",  resistance: p.rLoadC ?? 1000 } },
      { id: "gnd",  type: "Ground",          props: { label: "gnd" } },
    ],
    connections: [
      ["vs:pos", "sw:A1"],
      ["sw:B1",  "rb:pos"],
      ["rb:neg", "gnd:out"],
      ["sw:C1",  "rc:pos"],
      ["rc:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

// ===========================================================================
// Category 1 — Initialization (T1)
// ===========================================================================
//
// Post-warm-start observable: the engine has compiled the SPST/SPDT divider
// and applied initial node voltages from the seeded CLOSED slot. SPST closed
// seeds B1 to the closed-divider voltage; SPDT closed seeds B1/C1 likewise.

describe("Switch initialization (T1) — SPST closed seed", () => {
  it("init_post_warm_start_node_voltage_spst_closed_seed", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildSpstDivider(facade, {
        vSource: 10, closed: true, Ron: 1, Roff: 1e9, rLoad: 1000,
      }),
    });
    // sw:A1 is on the same net as vs:pos -> 10V at warm start.
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vs:pos"))).toBeCloseTo(10, 3);
    // sw:B1 is on the same net as rl:pos at the closed-divider voltage.
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "rl:pos"))).toBeCloseTo(10 * 1000 / 1001, 3);
  });
});

describe("SwitchDT initialization (T1) — SPDT closed seed", () => {
  it("init_post_warm_start_node_voltage_spdt_closed_seed", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildSpdtDivider(facade, {
        vSource: 10, closed: true, Ron: 1, Roff: 1e9,
      }),
    });
    // sw:A1 is on the same net as vs:pos -> 10V.
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vs:pos"))).toBeCloseTo(10, 3);
    // sw:B1 (closed path) sits at the closed-divider voltage.
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "rb:pos"))).toBeCloseTo(10 * 1000 / 1001, 3);
    // sw:C1 (open path) sits near 0 through Roff.
    expect(Math.abs(fix.engine.getNodeVoltage(nodeOf(fix, "rc:pos")))).toBeLessThan(1e-3);
  });
});

// ===========================================================================
// Category 2 — DCOP analytical (T1)
// ===========================================================================

describe("Switch DCOP analytical (T1) — SPST closed conducts via Ron", () => {
  it("dcop_spst_closed_conducts_via_ron", () => {
    // Vs=10V, Ron=1, rLoad=1k. V(B1) = 10 * 1000 / (1 + 1000) ~ 9.9900V.
    const fix = buildFixture({
      build: (_r, facade) => buildSpstDivider(facade, {
        vSource: 10, closed: true, Ron: 1, Roff: 1e9, rLoad: 1000,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const vB = fix.engine.getNodeVoltage(nodeOf(fix, "rl:pos"));
    expect(vB).toBeCloseTo(10 * 1000 / 1001, 3);
  });
});

describe("Switch DCOP analytical (T1) — SPST open blocks via Roff", () => {
  it("dcop_spst_open_blocks_via_roff", () => {
    // Vs=10V, Roff=1e9, rLoad=1k. V(B1) = 10 * 1000 / (1e9 + 1000) ~ 1e-5V.
    const fix = buildFixture({
      build: (_r, facade) => buildSpstDivider(facade, {
        vSource: 10, closed: false, Ron: 1, Roff: 1e9, rLoad: 1000,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const vB = fix.engine.getNodeVoltage(nodeOf(fix, "rl:pos"));
    expect(Math.abs(vB)).toBeLessThan(1e-3);
  });
});

describe("Switch DCOP analytical (T1) — SPST normallyClosed inverts", () => {
  it("dcop_spst_normally_closed_inverts_conductance", () => {
    // closed=false + normallyClosed=true ⇒ effectively closed at rest, so
    // V(B1) sits at the closed-divider voltage rather than the open one.
    const fix = buildFixture({
      build: (_r, facade) => buildSpstDivider(facade, {
        vSource: 10, closed: false, normallyClosed: true,
        Ron: 1, Roff: 1e9, rLoad: 1000,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const vB = fix.engine.getNodeVoltage(nodeOf(fix, "rl:pos"));
    expect(vB).toBeCloseTo(10 * 1000 / 1001, 3);
  });
});

describe("SwitchDT DCOP analytical (T1) — SPDT closed routes to B", () => {
  it("dcop_spdt_closed_routes_to_b_pin", () => {
    // closed=true: AB on (Ron=1), AC off (Roff=1e9).
    // V(B1) = 10 * 1k/(1 + 1k) ~ 9.99V; V(C1) ~ 0.
    const fix = buildFixture({
      build: (_r, facade) => buildSpdtDivider(facade, {
        vSource: 10, closed: true, Ron: 1, Roff: 1e9,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const vB = fix.engine.getNodeVoltage(nodeOf(fix, "rb:pos"));
    const vC = fix.engine.getNodeVoltage(nodeOf(fix, "rc:pos"));
    expect(vB).toBeCloseTo(10 * 1000 / 1001, 3);
    expect(Math.abs(vC)).toBeLessThan(1e-3);
  });
});

describe("SwitchDT DCOP analytical (T1) — SPDT open routes to C", () => {
  it("dcop_spdt_open_routes_to_c_pin", () => {
    // closed=false: AB off (Roff), AC on (Ron). V(B1) ~ 0, V(C1) ~ 9.99V.
    const fix = buildFixture({
      build: (_r, facade) => buildSpdtDivider(facade, {
        vSource: 10, closed: false, Ron: 1, Roff: 1e9,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const vB = fix.engine.getNodeVoltage(nodeOf(fix, "rb:pos"));
    const vC = fix.engine.getNodeVoltage(nodeOf(fix, "rc:pos"));
    expect(Math.abs(vB)).toBeLessThan(1e-3);
    expect(vC).toBeCloseTo(10 * 1000 / 1001, 3);
  });
});

// ===========================================================================
// Category 4 — Parameter hot-load (T1)
// ===========================================================================
//
// Switch and SwitchDT expose Ron, Roff, closed (toggle), normallyClosed.
// One it() per structural parameter, asserting closed-form post-change.

describe("Switch parameter hot-load (T1) — Ron", () => {
  it("hotload_Ron_changes_v_b_under_closed_load", () => {
    // Before: Ron=1, V(B1) = 10*1000/1001 ~ 9.9900V.
    // After  setComponentProperty(sw, "Ron", 100):
    //   V(B1) = 10*1000/(100+1000) ~ 9.0909V.
    const fix = buildFixture({
      build: (_r, facade) => buildSpstDivider(facade, {
        vSource: 10, closed: true, Ron: 1, Roff: 1e9, rLoad: 1000,
      }),
    });
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "rl:pos"));
    expect(before).toBeCloseTo(10 * 1000 / 1001, 3);

    fix.coordinator.setComponentProperty(ceByLabel(fix, "sw1"), "Ron", 100);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "rl:pos"));

    // Documented contract: raising Ron drops V(B1) toward divider value.
    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(10 * 1000 / 1100, 3);
  });
});

describe("Switch parameter hot-load (T1) — Roff", () => {
  it("hotload_Roff_lifts_v_b_when_open", () => {
    // Both gates OFF at start. Before: Roff=1e9, V(B1) ~ 1e-5V.
    // After Roff=10, V(B1) = 10 * 1000 / (10 + 1000) ~ 9.9V.
    const fix = buildFixture({
      build: (_r, facade) => buildSpstDivider(facade, {
        vSource: 10, closed: false, Ron: 1, Roff: 1e9, rLoad: 1000,
      }),
    });
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "rl:pos"));
    expect(before).toBeLessThan(1e-3);

    fix.coordinator.setComponentProperty(ceByLabel(fix, "sw1"), "Roff", 10);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "rl:pos"));

    // Documented contract: lowering Roff lifts V(B1) when open.
    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeCloseTo(10 * 1000 / 1010, 2);
  });
});

describe("Switch parameter hot-load (T1) — closed toggle", () => {
  it("hotload_closed_true_toggles_conduction", () => {
    // Before: closed=false -> V(B1) ~ 0. After closed=true -> V(B1) ~ 9.99V.
    const fix = buildFixture({
      build: (_r, facade) => buildSpstDivider(facade, {
        vSource: 10, closed: false, Ron: 1, Roff: 1e9, rLoad: 1000,
      }),
    });
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "rl:pos"));
    expect(before).toBeLessThan(1e-3);

    fix.coordinator.setComponentProperty(ceByLabel(fix, "sw1"), "closed", 1);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "rl:pos"));

    // Documented contract: toggling closed=true (1) conducts via Ron.
    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeCloseTo(10 * 1000 / 1001, 3);
  });
});

describe("SwitchDT parameter hot-load (T1) — Ron", () => {
  it("hotload_spdt_Ron_changes_v_b_under_closed", () => {
    // Before: closed=true, Ron=1 -> V(B1) ~ 9.99V.
    // After Ron=100 -> V(B1) ~ 10*1k/1100 ~ 9.0909V.
    const fix = buildFixture({
      build: (_r, facade) => buildSpdtDivider(facade, {
        vSource: 10, closed: true, Ron: 1, Roff: 1e9,
      }),
    });
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nodeOf(fix, "rb:pos"));
    expect(before).toBeCloseTo(10 * 1000 / 1001, 3);

    fix.coordinator.setComponentProperty(ceByLabel(fix, "sw1"), "Ron", 100);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nodeOf(fix, "rb:pos"));

    expect(after).not.toBeCloseTo(before, 2);
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(10 * 1000 / 1100, 3);
  });
});

describe("SwitchDT parameter hot-load (T1) — closed toggle routes pole", () => {
  it("hotload_spdt_closed_toggle_swaps_route", () => {
    // Before: closed=true -> V(B1) ~ 9.99V, V(C1) ~ 0.
    // After  closed=false -> V(B1) ~ 0,    V(C1) ~ 9.99V.
    const fix = buildFixture({
      build: (_r, facade) => buildSpdtDivider(facade, {
        vSource: 10, closed: true, Ron: 1, Roff: 1e9,
      }),
    });
    fix.coordinator.dcOperatingPoint();
    const vbBefore = fix.engine.getNodeVoltage(nodeOf(fix, "rb:pos"));
    const vcBefore = fix.engine.getNodeVoltage(nodeOf(fix, "rc:pos"));
    expect(vbBefore).toBeCloseTo(10 * 1000 / 1001, 3);
    expect(Math.abs(vcBefore)).toBeLessThan(1e-3);

    fix.coordinator.setComponentProperty(ceByLabel(fix, "sw1"), "closed", 0);
    fix.coordinator.dcOperatingPoint();
    const vbAfter = fix.engine.getNodeVoltage(nodeOf(fix, "rb:pos"));
    const vcAfter = fix.engine.getNodeVoltage(nodeOf(fix, "rc:pos"));

    expect(Math.abs(vbAfter)).toBeLessThan(1e-3);
    expect(vcAfter).toBeCloseTo(10 * 1000 / 1001, 3);
    expect(vbAfter).not.toBeCloseTo(vbBefore, 2);
    expect(vcAfter).not.toBeCloseTo(vcBefore, 2);
  });
});

// ===========================================================================
// Category 9 — Bridge / digital interaction (T1)
// ===========================================================================
//
// Switch exposes a digital execute path (executeSwitch). Cat 9 asserts the
// closed/open state propagates as a CLOSED state slot on a single step.

describe("Switch digital bridge (T1) — Cat 9", () => {
  it("digital_executeSwitch_writes_state_slot_when_closed", () => {
    // Pure digital netlist: drive a Switch with closed=true via property,
    // check that a coordinator.step() executes without throwing and that the
    // observable digital partition compiles.
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "din", type: "In",     props: { label: "DIN", bitWidth: 1 } },
        { id: "sw",  type: "Switch", props: { label: "sw1", closed: true } },
        { id: "obs", type: "Out",    props: { label: "OBS", bitWidth: 1 } },
      ],
      connections: [
        ["din:out", "sw:A1"],
        ["sw:B1",   "obs:in"],
      ],
    });
    const coordinator = facade.compile(circuit);
    coordinator.writeByLabel("DIN", digital(1));
    coordinator.step();
    // Closed switch passes DIN -> OBS via bus resolution.
    expect(coordinator.readByLabel("OBS")).toMatchObject({ type: "digital", value: 1 });
  });

  it("digital_executeSwitch_open_does_not_pass_din", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "din", type: "In",     props: { label: "DIN", bitWidth: 1 } },
        { id: "sw",  type: "Switch", props: { label: "sw1", closed: false } },
        { id: "obs", type: "Out",    props: { label: "OBS", bitWidth: 1 } },
      ],
      connections: [
        ["din:out", "sw:A1"],
        ["sw:B1",   "obs:in"],
      ],
    });
    const coordinator = facade.compile(circuit);
    coordinator.writeByLabel("DIN", digital(1));
    coordinator.step();
    // Open switch does not pass DIN -> OBS reads the floating-net default (0).
    expect(coordinator.readByLabel("OBS")).toMatchObject({ type: "digital", value: 0 });
  });
});

describe("SwitchDT digital bridge (T1) — Cat 9", () => {
  it("digital_executeSwitchDT_routes_b_when_closed", () => {
    // closed=true: A->B path active. DIN propagates to OBS_B; OBS_C stays low.
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "din",  type: "In",       props: { label: "DIN",  bitWidth: 1 } },
        { id: "sw",   type: "SwitchDT", props: { label: "sw1",  closed: true } },
        { id: "obsB", type: "Out",      props: { label: "OBSB", bitWidth: 1 } },
        { id: "obsC", type: "Out",      props: { label: "OBSC", bitWidth: 1 } },
      ],
      connections: [
        ["din:out", "sw:A1"],
        ["sw:B1",   "obsB:in"],
        ["sw:C1",   "obsC:in"],
      ],
    });
    const coordinator = facade.compile(circuit);
    coordinator.writeByLabel("DIN", digital(1));
    coordinator.step();
    expect(coordinator.readByLabel("OBSB")).toMatchObject({ type: "digital", value: 1 });
    expect(coordinator.readByLabel("OBSC")).toMatchObject({ type: "digital", value: 0 });
  });
});

// ===========================================================================
// Category 2 numerical / 3 / 5 — self-compare (T3, Class B switches)
// ===========================================================================
//
// Switch and SwitchDT are Class B (manual click-toggle). The SPICE deck emits
// a synthesized V_ctrl source that adds an extra branch equation not present
// in our engine, making the matrix structurally incompatible with paired
// ngspice comparison. Tests therefore use createSelfCompare (compares our
// engine against a deep clone of itself), which validates shape, monotonicity,
// and state evolution without requiring ngspice matrix structural parity.
//
// Per the Wave 3 spec: "Tests that toggle Class B switches mid-transient
// migrate to createSelfCompare per-test (NOT as pairedSpiceEquivalent: false
// on the component — that would exclude the static-deck tests too)."
// Static-deck tests (closed=true or closed=false, no toggling) also use
// createSelfCompare for the same structural reason.

describeIfDll("Switch self-compare — SPST closed (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({
      dtsPath: DTS_SPST_CLOSED,
      analysis: "tran",
      tStop: 2e-5,
      maxStep: 1e-6,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_self_compare_spst_closed", () => {
    session.compareAllSteps();
  }, 180_000);

  it("dcop_self_compare_spst_closed", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_self_compare_spst_closed", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("Switch self-compare — SPST open (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({
      dtsPath: DTS_SPST_OPEN,
      analysis: "tran",
      tStop: 2e-5,
      maxStep: 1e-6,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_self_compare_spst_open", () => {
    session.compareAllSteps();
  }, 180_000);

  it("dcop_self_compare_spst_open", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_self_compare_spst_open", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("SwitchDT self-compare — SPDT closed (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({
      dtsPath: DTS_SPDT_CLOSED,
      analysis: "tran",
      tStop: 2e-5,
      maxStep: 1e-6,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_self_compare_spdt_closed", () => {
    session.compareAllSteps();
  }, 180_000);

  it("dcop_self_compare_spdt_closed", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_self_compare_spdt_closed", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("SwitchDT self-compare — SPDT open (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({
      dtsPath: DTS_SPDT_OPEN,
      analysis: "tran",
      tStop: 2e-5,
      maxStep: 1e-6,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_self_compare_spdt_open", () => {
    session.compareAllSteps();
  }, 180_000);

  it("dcop_self_compare_spdt_open", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_self_compare_spdt_open", () => {
    session.compareAllAttempts();
  });
});
