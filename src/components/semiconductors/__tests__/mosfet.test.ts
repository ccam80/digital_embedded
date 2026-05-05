/**
 * Tests for the NMOS and PMOS MOSFET components.
 *
 * §4c migration: every test routes through `buildFixture` + the public
 * coordinator/engine surface, or is a static inspection of exported
 * definition objects. No direct element.load()/setup() calls, no
 * hand-rolled LoadContext/StatePool, no deleted test-helpers.ts helpers.
 *
 * Covers:
 *   - Cutoff region: Id ≈ 0 when Vgs < Vth (observable via node voltages)
 *   - Saturation region: DC-OP node voltages match SPICE reference
 *   - PMOS polarity reversal: DC-OP in conducting state
 *   - stamp_nonlinear: matrix entries present in saturation (engine.solver.getCSCNonZeros)
 *   - setParam shifts DC-OP to SPICE reference
 *   - LimitingEvent instrumentation via coordinator.setLimitingCapture/getLimitingEvents
 *   - Static definition structure (NmosfetDefinition, PmosfetDefinition)
 *   - Partition layout correctness
 *   - Source-file structural assertions (no integrateCapacitor, ngspice comment citations)
 */

import { describe, it, expect, vi } from "vitest";
import * as NewtonRaphsonModule from "../../../solver/analog/newton-raphson.js";

import {
  NmosfetDefinition,
  PmosfetDefinition,
  createMosfetElement,
  MOSFET_NMOS_DEFAULTS,
  MOSFET_NMOS_PARAM_DEFS,
  MOSFET_PMOS_PARAM_DEFS,
} from "../mosfet.js";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogFactory } from "../../../core/registry.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Shared NMOS model parameters (W=1µ, L=1µ, KP=120µA/V², VTO=0.7, LAMBDA=0.02)
// ---------------------------------------------------------------------------

const NMOS_TEST_PARAMS = {
  VTO: 0.7,
  KP: 120e-6,
  LAMBDA: 0.02,
  PHI: 0.6,
  GAMMA: 0.37,
  CBD: 0,
  CBS: 0,
  CGDO: 0,
  CGSO: 0,
  W: 1e-6,
  L: 1e-6,
};

/** Assert actual ≈ expected within 0.1% relative tolerance (ngspice reference). */
function expectSpiceRef(actual: number, expected: number, label: string) {
  const rel = Math.abs((actual - expected) / expected);
  if (rel >= 0.001) {
    throw new Error(
      `${label}: relative error ${(rel * 100).toFixed(4)}% exceeds 0.1% ` +
      `(actual=${actual}, expected=${expected})`
    );
  }
}

// ---------------------------------------------------------------------------
// Circuit builders for NMOS tests
// ---------------------------------------------------------------------------

/**
 * Common-source NMOS circuit: Vdd=5V → Rd=1kΩ → drain, NMOS gate=3V, source=gnd.
 * NMOS model: KP=120µA/V², VTO=0.7V, LAMBDA=0.02, W=10µ, L=1µ.
 * ngspice reference: Vdrain≈1.84V, Id≈3.16mA.
 */
function buildNmosCommonSource(facade: DefaultSimulatorFacade): Circuit {
  return facade.build({
    components: [
      { id: "vdd",  type: "DcVoltageSource", props: { label: "Vdd", voltage: 5.0 } },
      { id: "vg",   type: "DcVoltageSource", props: { label: "Vg",  voltage: 3.0 } },
      { id: "rd",   type: "Resistor",        props: { label: "Rd",  resistance: 1000 } },
      { id: "nmos", type: "NMOS",            props: {
        label: "M1",
        model: "spice-l1",
        VTO: 0.7, KP: 120e-6, LAMBDA: 0.02, PHI: 0.6, GAMMA: 0.37,
        W: 10e-6, L: 1e-6,
        CBD: 0, CBS: 0, CGDO: 0, CGSO: 0,
      } },
      { id: "gnd",  type: "Ground" },
    ],
    connections: [
      ["vdd:pos",  "rd:pos"],
      ["rd:neg",   "nmos:D"],
      ["vg:pos",   "nmos:G"],
      ["nmos:S",   "gnd:out"],
      ["vdd:neg",  "gnd:out"],
      ["vg:neg",   "gnd:out"],
    ],
  });
}

/**
 * NMOS circuit with Vgs < Vth: device in cutoff — drain ≈ Vdd.
 * Vgate=0V (< VTO=0.7V), Vdd=5V, Rd=10kΩ.
 */
function buildNmosCutoff(facade: DefaultSimulatorFacade): Circuit {
  return facade.build({
    components: [
      { id: "vdd",  type: "DcVoltageSource", props: { label: "Vdd", voltage: 5.0 } },
      { id: "vg",   type: "DcVoltageSource", props: { label: "Vg",  voltage: 0.0 } },
      { id: "rd",   type: "Resistor",        props: { label: "Rd",  resistance: 10000 } },
      { id: "nmos", type: "NMOS",            props: {
        label: "M1",
        model: "spice-l1",
        VTO: 0.7, KP: 120e-6, LAMBDA: 0.02, PHI: 0.6, GAMMA: 0.37,
        W: 1e-6, L: 1e-6,
        CBD: 0, CBS: 0, CGDO: 0, CGSO: 0,
      } },
      { id: "gnd",  type: "Ground" },
    ],
    connections: [
      ["vdd:pos",  "rd:pos"],
      ["rd:neg",   "nmos:D"],
      ["vg:pos",   "nmos:G"],
      ["nmos:S",   "gnd:out"],
      ["vdd:neg",  "gnd:out"],
      ["vg:neg",   "gnd:out"],
    ],
  });
}

/**
 * NMOS saturation circuit: Vgs=3V > Vth=0.7V, Vdd=5V, Rd=1kΩ.
 * Generates non-trivial matrix stamps for introspection.
 */
function buildNmosSaturation(facade: DefaultSimulatorFacade): Circuit {
  return facade.build({
    components: [
      { id: "vdd",  type: "DcVoltageSource", props: { label: "Vdd", voltage: 5.0 } },
      { id: "vg",   type: "DcVoltageSource", props: { label: "Vg",  voltage: 3.0 } },
      { id: "rd",   type: "Resistor",        props: { label: "Rd",  resistance: 1000 } },
      { id: "nmos", type: "NMOS",            props: {
        label: "M1",
        model: "spice-l1",
        VTO: 0.7, KP: 120e-6, LAMBDA: 0.02, PHI: 0.6, GAMMA: 0,
        W: 1e-6, L: 1e-6,
        CBD: 0, CBS: 0, CGDO: 0, CGSO: 0,
      } },
      { id: "gnd",  type: "Ground" },
    ],
    connections: [
      ["vdd:pos",  "rd:pos"],
      ["rd:neg",   "nmos:D"],
      ["vg:pos",   "nmos:G"],
      ["nmos:S",   "gnd:out"],
      ["vdd:neg",  "gnd:out"],
      ["vg:neg",   "gnd:out"],
    ],
  });
}

/**
 * PMOS circuit: Vdd=5V, source at Vdd, drain pulled to gnd through Rd=1kΩ.
 * Vgate=2V → Vgs=-3V → PMOS conducting.
 */
function buildPmosConduction(facade: DefaultSimulatorFacade): Circuit {
  return facade.build({
    components: [
      { id: "vdd",  type: "DcVoltageSource", props: { label: "Vdd", voltage: 5.0 } },
      { id: "vg",   type: "DcVoltageSource", props: { label: "Vg",  voltage: 2.0 } },
      { id: "rd",   type: "Resistor",        props: { label: "Rd",  resistance: 1000 } },
      { id: "pmos", type: "PMOS",            props: {
        label: "M1",
        model: "spice-l1",
        VTO: -0.7, KP: 60e-6, LAMBDA: 0.02, PHI: 0.6, GAMMA: 0.37,
        W: 1e-6, L: 1e-6,
        CBD: 0, CBS: 0, CGDO: 0, CGSO: 0,
      } },
      { id: "gnd",  type: "Ground" },
    ],
    connections: [
      ["vdd:pos",  "pmos:S"],
      ["pmos:D",   "rd:pos"],
      ["rd:neg",   "gnd:out"],
      ["vg:pos",   "pmos:G"],
      ["vdd:neg",  "gnd:out"],
      ["vg:neg",   "gnd:out"],
    ],
  });
}

// ---------------------------------------------------------------------------
// NMOS unit tests
// ---------------------------------------------------------------------------

describe("NMOS", () => {
  it("cutoff_region", () => {
    // Vgs=0V < VTO=0.7V → device off → drain ≈ Vdd (no current through Rd).
    const fix = buildFixture({
      build: (_r, facade) => buildNmosCutoff(facade),
      params: { tStop: 1e-6, maxTimeStep: 1e-7 },
    });

    // In cutoff: drain node ≈ Vdd (no pull-down current through Rd).
    const drainNode = fix.circuit.labelToNodeId.get("M1:D")!;
    const vDrain = fix.engine.getNodeVoltage(drainNode);
    // Vdrain ≈ 5V (device off — only GMIN leakage through the 10kΩ load)
    expect(vDrain).toBeGreaterThan(4.99);
  });

  it("three_terminal_node_indices", () => {
    // pinNodes is the single topology source. No engine construction needed.
    const propsObj = new PropertyBag();
    propsObj.replaceModelParams({ ...MOSFET_NMOS_DEFAULTS, ...NMOS_TEST_PARAMS });
    const element = createMosfetElement(new Map([["G", 2], ["S", 3], ["D", 1]]), propsObj, () => 0);
    expect(element.pinNodes.get("G")).toBe(2);
    expect(element.pinNodes.get("D")).toBe(1);
    expect(element.pinNodes.get("S")).toBe(3);
  });

  it("stamp_nonlinear_has_conductance_entries", () => {
    // Vgs=3V > Vth=0.7V (saturation): the engine solver has nonzero MOSFET stamps.
    const fix = buildFixture({
      build: (_r, facade) => buildNmosSaturation(facade),
      params: { tStop: 1e-6, maxTimeStep: 1e-7 },
    });

    const entries = fix.engine.solver!.getCSCNonZeros();
    expect(entries.length).toBeGreaterThan(0);

    const nonzeroStamps = entries.filter((e: { row: number; col: number; value: number }) => Math.abs(e.value) > 1e-15);
    expect(nonzeroStamps.length).toBeGreaterThan(0);
  });

  // Deleted: srcFact_zero_does_not_scale_mosfet_stamps.
  // Coverage: ngspice-parity/mosfet-inverter.test.ts (dc_op_match)
  // Reason: assertion required direct element.load() with srcFact=0/1 to compare private
  //         matrix stamp entries — no public-surface equivalent (srcFact is an NR-internal
  //         parameter not observable at coordinator or node-voltage level).

  // Deleted: srcFact_default_equals_one.
  // Coverage: ngspice-parity/mosfet-inverter.test.ts (dc_op_match)
  // Reason: same as srcFact_zero — verifies private matrix/RHS stamp equivalence between
  //         two ctx.srcFact values; no public-surface equivalent.
});

// ---------------------------------------------------------------------------
// PMOS unit tests
// ---------------------------------------------------------------------------

describe("PMOS", () => {
  it("polarity_reversed", () => {
    // PMOS with Vgs=-3V (gate=2V, source=5V): device conducts.
    // Drain voltage must be below Vdd (current flowing through Rd to gnd).
    const fix = buildFixture({
      build: (_r, facade) => buildPmosConduction(facade),
      params: { tStop: 1e-6, maxTimeStep: 1e-7 },
    });

    const drainNode = fix.circuit.labelToNodeId.get("M1:D")!;
    const vDrain = fix.engine.getNodeVoltage(drainNode);
    // PMOS conducting → drain pulled below Vdd via Rd current
    expect(vDrain).toBeGreaterThan(0.0);  // not grounded
    expect(vDrain).toBeLessThan(4.9);      // definitely conducting
  });

  it("pmos_definition_has_correct_device_type", () => {
    expect(PmosfetDefinition.modelRegistry?.["spice-l1"]).toBeDefined();
    expect(PmosfetDefinition.modelRegistry?.["spice-l1"]?.kind).toBe("inline");
  });
});

// ---------------------------------------------------------------------------
// ComponentDefinition unit tests
// ---------------------------------------------------------------------------

describe("NmosfetDefinition", () => {
  it("has_correct_fields", () => {
    expect(NmosfetDefinition.name).toBe("NMOS");
    expect(NmosfetDefinition.modelRegistry?.["spice-l1"]).toBeDefined();
    expect(NmosfetDefinition.modelRegistry?.["spice-l1"]?.kind).toBe("inline");
    expect((NmosfetDefinition.modelRegistry?.["spice-l1"] as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
  });

  it("pin_layout_has_three_pins", () => {
    expect(NmosfetDefinition.pinLayout).toHaveLength(3);
    const labels = NmosfetDefinition.pinLayout.map((p) => p.label);
    expect(labels).toContain("D");
    expect(labels).toContain("G");
    expect(labels).toContain("S");
  });
});

// ---------------------------------------------------------------------------
// Integration test: common-source NMOS DC operating point
//
// Circuit: Vdd=5V → Rd=1kΩ → NMOS drain, NMOS gate=3V, NMOS source=gnd
// NMOS model: KP=120µA/V², VTO=0.7V, LAMBDA=0.02, W=10µ, L=1µ
//
// Expected operating point (ngspice reference):
//   Vds ≈ 1.84V
//   Id  ≈ 3.16mA
// ---------------------------------------------------------------------------

describe("Integration", () => {
  it("common_source_nmos", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildNmosCommonSource(facade),
      params: { tStop: 1e-6, maxTimeStep: 1e-7 },
    });

    const dcResult = fix.coordinator.dcOperatingPoint();
    expect(dcResult).not.toBeNull();
    expect(dcResult!.converged).toBe(true);

    const drainNode = fix.circuit.labelToNodeId.get("M1:D")!;
    const vddNode   = fix.circuit.labelToNodeId.get("Vdd:pos")!;
    const vDrain = fix.engine.getNodeVoltage(drainNode);
    const vDd    = fix.engine.getNodeVoltage(vddNode);

    expectSpiceRef(vDrain, 1.840508e+00, "V(drain)");

    const id = (vDd - vDrain) / 1000;
    expectSpiceRef(id, 3.159492e-03, "Id");
  });
});

// ---------------------------------------------------------------------------
// setParam behavioral verification
// ---------------------------------------------------------------------------

describe("setParam shifts DC OP to match SPICE reference", () => {
  it("setParam('VTO', 2.5) shifts DC OP to match SPICE reference", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildNmosCommonSource(facade),
      params: { tStop: 1e-6, maxTimeStep: 1e-7 },
    });

    // Before: VTO=0.7 — converged drain ≈ 1.84V
    const dcBefore = fix.coordinator.dcOperatingPoint();
    expect(dcBefore!.converged).toBe(true);
    const drainNode = fix.circuit.labelToNodeId.get("M1:D")!;
    expectSpiceRef(fix.engine.getNodeVoltage(drainNode), 1.840508e+00, "V(drain) before");

    // Find the MOSFET element and setParam
    const mosfetEl = fix.circuit.elements.find((el) => el.label === "M1");
    expect(mosfetEl).toBeDefined();
    mosfetEl!.setParam("VTO", 2.5);

    // Re-run DC-OP
    const dcAfter = fix.coordinator.dcOperatingPoint();
    expect(dcAfter!.converged).toBe(true);

    const vddNode = fix.circuit.labelToNodeId.get("Vdd:pos")!;
    const vDrainAfter = fix.engine.getNodeVoltage(drainNode);
    const vDdAfter    = fix.engine.getNodeVoltage(vddNode);

    expectSpiceRef(vDrainAfter, 4.835494e+00, "V(drain) after VTO=2.5");
    expectSpiceRef((vDdAfter - vDrainAfter) / 1000, 1.645065e-04, "Id after VTO=2.5");
  });

  it("setParam('KP', 240µ) shifts DC OP to match SPICE reference", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildNmosCommonSource(facade),
      params: { tStop: 1e-6, maxTimeStep: 1e-7 },
    });

    const dcBefore = fix.coordinator.dcOperatingPoint();
    expect(dcBefore!.converged).toBe(true);
    const drainNode = fix.circuit.labelToNodeId.get("M1:D")!;
    expectSpiceRef(fix.engine.getNodeVoltage(drainNode), 1.840508e+00, "V(drain) before");

    const mosfetEl = fix.circuit.elements.find((el) => el.label === "M1");
    expect(mosfetEl).toBeDefined();
    mosfetEl!.setParam("KP", 240e-6);

    const dcAfter = fix.coordinator.dcOperatingPoint();
    expect(dcAfter!.converged).toBe(true);

    const vddNode = fix.circuit.labelToNodeId.get("Vdd:pos")!;
    const vDrainAfter = fix.engine.getNodeVoltage(drainNode);
    const vDdAfter    = fix.engine.getNodeVoltage(vddNode);

    expectSpiceRef(vDrainAfter, 9.071396e-01, "V(drain) after KP=240µ");
    expectSpiceRef((vDdAfter - vDrainAfter) / 1000, 4.092860e-03, "Id after KP=240µ");
  });
});

// ---------------------------------------------------------------------------
// LimitingEvent instrumentation tests — MOSFET
//
// Uses coordinator.setLimitingCapture(true) / getLimitingEvents() per §0
// interface contracts (J-181/182/183).
// ---------------------------------------------------------------------------

describe("MOSFET LimitingEvent instrumentation", () => {
  /**
   * Build a fixture with a drive that forces NR to run limiting.
   * Vgate=5V (well above threshold) so fetlim fires from cold start.
   * Vdd=5V, Rd=1kΩ, NMOS VTO=1V.
   */
  function buildLimitingCircuit(facade: DefaultSimulatorFacade): Circuit {
    return facade.build({
      components: [
        { id: "vdd",  type: "DcVoltageSource", props: { label: "Vdd", voltage: 5.0 } },
        { id: "vg",   type: "DcVoltageSource", props: { label: "Vg",  voltage: 5.0 } },
        { id: "rd",   type: "Resistor",        props: { label: "Rd",  resistance: 1000 } },
        { id: "nmos", type: "NMOS",            props: {
          label: "M1",
          model: "spice-l1",
          VTO: 1.0, KP: 2e-5, GAMMA: 0, PHI: 0.6, LAMBDA: 0,
          W: 1e-6, L: 1e-6,
          CBD: 0, CBS: 0, CGDO: 0, CGSO: 0,
        } },
        { id: "gnd",  type: "Ground" },
      ],
      connections: [
        ["vdd:pos",  "rd:pos"],
        ["rd:neg",   "nmos:D"],
        ["vg:pos",   "nmos:G"],
        ["nmos:S",   "gnd:out"],
        ["vdd:neg",  "gnd:out"],
        ["vg:neg",   "gnd:out"],
      ],
    });
  }

  it("pushes GS (fetlim) event to limitingCollector", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildLimitingCircuit(facade),
      params: { tStop: 1e-6, maxTimeStep: 1e-7 },
    });

    // Enable limiting capture, then re-run DC-OP to collect events.
    fix.coordinator.setLimitingCapture(true);
    fix.coordinator.dcOperatingPoint();

    const events = fix.coordinator.getLimitingEvents();
    const gsEv = events.find((e) => e.junction === "GS");
    expect(gsEv).toBeDefined();
    expect(gsEv!.limitType).toBe("fetlim");
    expect(Number.isFinite(gsEv!.vBefore)).toBe(true);
    expect(Number.isFinite(gsEv!.vAfter)).toBe(true);
    expect(typeof gsEv!.wasLimited).toBe("boolean");
  });

  it("pushes DS (limvds) event to limitingCollector", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildLimitingCircuit(facade),
      params: { tStop: 1e-6, maxTimeStep: 1e-7 },
    });

    fix.coordinator.setLimitingCapture(true);
    fix.coordinator.dcOperatingPoint();

    const events = fix.coordinator.getLimitingEvents();
    const dsEv = events.find((e) => e.junction === "DS");
    expect(dsEv).toBeDefined();
    expect(dsEv!.limitType).toBe("limvds");
    expect(Number.isFinite(dsEv!.vBefore)).toBe(true);
    expect(Number.isFinite(dsEv!.vAfter)).toBe(true);
  });

  it("LimitingEvents carry elementIndex and label", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildLimitingCircuit(facade),
      params: { tStop: 1e-6, maxTimeStep: 1e-7 },
    });

    fix.coordinator.setLimitingCapture(true);
    fix.coordinator.dcOperatingPoint();

    const events = fix.coordinator.getLimitingEvents();
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(typeof ev.elementIndex).toBe("number");
      expect(typeof ev.label).toBe("string");
    }
  });

  it("disabling limiting capture clears collection", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildLimitingCircuit(facade),
      params: { tStop: 1e-6, maxTimeStep: 1e-7 },
    });

    fix.coordinator.setLimitingCapture(true);
    fix.coordinator.dcOperatingPoint();
    fix.coordinator.setLimitingCapture(false);

    // After disabling, getLimitingEvents should return empty (collector set to null).
    const events = fix.coordinator.getLimitingEvents();
    expect(events.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// MOSFET primeJunctions — structural / existence tests
// ---------------------------------------------------------------------------

describe("MOSFET primeJunctions", () => {
  it("method absent from element", () => {
    // Task 6.1.4: primeJunctions() deleted — property must be absent.
    // TypeScript enforces this at compile time (MosfetElement has no
    // primeJunctions field); the runtime `in` check is the corresponding
    // structural assertion at test time.
    const bag = new PropertyBag();
    bag.replaceModelParams({ ...MOSFET_NMOS_DEFAULTS });
    const element = createMosfetElement(new Map([["G", 2], ["S", 3], ["D", 1]]), bag, () => 0);
    expect("primeJunctions" in element).toBe(false);
  });

  // Deleted: dc-operating-point skips MOSFET.
  // Coverage: every DC-OP MOSFET test in this file (Integration.common_source_nmos
  //           and friends) exercises dc-operating-point.ts:323-324's
  //           `el.primeJunctions?.()` optional chain on the MOSFET path. If the
  //           property reappeared, those tests' DCOP would behave differently.
  // Reason: structural redundancy — covered by observable DCOP convergence on
  //         every MOSFET integration test in this same file.

  // Deleted: checkConvergence_returns_true_during_initFix_when_OFF.
  // Coverage: ngspice-parity/mosfet-inverter.test.ts (dc_op_match / assertConvergenceFlowMatch)
  // Reason: assertion required direct element.checkConvergence(ctx) call — private lifecycle
  //         method with no public-surface equivalent.

  // Deleted: MODEINITJCT branch primes directly.
  // Coverage: ngspice-parity/mosfet-inverter.test.ts (dc_op_match / assertModeTransitionMatch)
  // Reason: assertion required reading pool.states[0] after calling initElement() from
  //         deleted test-helpers.ts — §3 POISON (fabricates StatePool outside sanctioned fixtures).
});

// ---------------------------------------------------------------------------
// integration: source-file structural assertions
// ---------------------------------------------------------------------------

describe("integration", () => {
  it("no_integrateCapacitor_import", () => {
    const fs = require("fs");
    const src = fs.readFileSync(
      require("path").resolve(__dirname, "../mosfet.ts"),
      "utf8",
    ) as string;
    expect(src).not.toMatch(/integrateCapacitor/);
    expect(src).not.toMatch(/integrateInductor/);
  });
});

// ---------------------------------------------------------------------------
// MOSFET LoadContext precondition — Task 6.1.3
// ---------------------------------------------------------------------------

describe("MOSFET LoadContext precondition", () => {
  it("bypass and voltTol are read through the bypass branch", () => {
    // Verify that a converged NMOS circuit does not call pnjlim/fetlim
    // after convergence (bypass fires). The limiting spies must NOT be
    // called on a second DC-OP call with the same circuit state.
    const fix = buildFixture({
      build: (_r, facade) => buildNmosCommonSource(facade),
      params: { tStop: 1e-6, maxTimeStep: 1e-7 },
    });

    // First DC-OP to reach convergence.
    const dc1 = fix.coordinator.dcOperatingPoint();
    expect(dc1!.converged).toBe(true);

    // Second DC-OP from the same converged state — bypass must suppress limiting.
    const pnjlimSpy = vi.spyOn(NewtonRaphsonModule, "pnjlim");
    const fetlimSpy = vi.spyOn(NewtonRaphsonModule, "fetlim");
    try {
      const dc2 = fix.coordinator.dcOperatingPoint();
      expect(dc2!.converged).toBe(true);

      // Bypass fired — limiting functions not called on a re-solve of converged state.
      expect(pnjlimSpy).not.toHaveBeenCalled();
      expect(fetlimSpy).not.toHaveBeenCalled();
    } finally {
      pnjlimSpy.mockRestore();
      fetlimSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// MOSFET schema — Task 6.1.1 verify-only tests
// ---------------------------------------------------------------------------

describe("MOSFET schema", () => {
  // Deleted: SLOT_VON init kind.
  // Coverage: manual_fix_list.md §4d (schema-init mechanism removal).
  // Reason: references SlotDescriptor.init.kind which was DELETED in §4d
  //         (schema-init mechanism removal). The `init` field no longer exists.

  it("VON read path has no NaN guard", () => {
    const fs = require("fs");
    const src = fs.readFileSync(
      require("path").resolve(__dirname, "../mosfet.ts"),
      "utf8",
    ) as string;
    const isNanVonMatches = src.match(/isNaN[^)]*VON/g) ?? [];
    const numberIsNanVonMatches = src.match(/Number\.isNaN[^)]*VON/g) ?? [];
    expect(isNanVonMatches.length).toBe(0);
    expect(numberIsNanVonMatches.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// MOSFET LTE — Task 6.1.2
// ---------------------------------------------------------------------------

describe("MOSFET LTE", () => {
  // Deleted: includes QBS and QBD.
  // Coverage: ngspice-parity/mosfet-inverter.test.ts (transient_match)
  // Reason: assertion required directly seeding pool.states[0/1] to inject QBS/QBD
  //         charge values outside sanctioned buildFixture path — §3 POISON
  //         (fabricates StatePool contents without running the engine).
});

// ---------------------------------------------------------------------------
// Wave 6.2 tests — M-1 through M-12 and companion-zero
//
// ALL tests below were deleted because they seed pool.states[0/1/2] directly,
// call element.load(ctx) directly, and use makeNmosElement62/makePmosElement62
// (helpers that invoke makeTestSetupContext/setupAll/initElement from the
// deleted test-helpers.ts). These are §3 POISON patterns.
//
// Coverage: ngspice-parity/mosfet-inverter.test.ts covers all stamp-level,
//           NR-iteration, mode-transition, and convergence-flow assertions
//           at the correct parity level.
// ---------------------------------------------------------------------------

// Deleted: MOSFET M-1 (predictor voltages pass through fetlim/pnjlim, INITJCT skips limiting).
// Coverage: ngspice-parity/mosfet-inverter.test.ts (dc_op_match / transient_match)
// Reason: seeded pool.states[1/2] directly to inject predictor voltages; called element.load().

// Deleted: MOSFET M-2 (SMSIG reads voltages from rhsOld, useDouble cap averaging,
//          skips bulk NIintegrate, qgs=c*v, SMSIG stamps run).
// Coverage: ngspice-parity/mosfet-inverter.test.ts (dc_op_match / transient_match)
// Reason: called element.load() via makeNmosElement62 (deleted helpers); read pool.states[0] directly.

// Deleted: MOSFET M-3 IC-handling tests.
// Coverage: ngspice-parity/mosfet-inverter.test.ts (dc_op_match / assertModeTransitionMatch)
// Reason: called element.load() with hand-rolled cktMode; read pool.states[0] directly.

// Deleted: MOSFET M-4 (bypass fires when within tolerances, bypass disabled during predictor/SMSIG,
//          bypass does not fire when delvbs exceeds voltTol, bypass with MODETRAN rebuilds capgs,
//          noncon increments even on bypass).
// Coverage: ngspice-parity/mosfet-inverter.test.ts (dc_op_match / assertConvergenceFlowMatch)
// Reason: seeded pool.states[0/1] directly; called element.load() and used vi.spyOn on
//         private limiting path; no public-surface equivalent for per-slot bypass introspection.

// Deleted: MOSFET M-5 (cktFixLimit=true skips reverse limvds, cktFixLimit=false runs reverse limvds,
//          forward limvds always runs).
// Coverage: ngspice-parity/mosfet-inverter.test.ts (dc_op_match)
// Reason: seeded pool.states[0] directly; called element.load() with cktFixLimit override.

// Deleted: MOSFET M-6 (no pnjlim limit → icheckLimited stays false, pnjlim limit → noncon increments,
//          OFF=1+MODEINITFIX suppresses noncon, MODEINITJCT path does not touch noncon).
// Coverage: ngspice-parity/mosfet-inverter.test.ts (assertConvergenceFlowMatch)
// Reason: called element.load() and read ctx.noncon.value directly; used deleted helpers.

// Deleted: MOSFET M-7 (qgs/qgd/qgb xfact extrapolation, xfact=0 when deltaOld[1]=0,
//          voltage predictor shares xfact formula).
// Coverage: ngspice-parity/mosfet-inverter.test.ts (transient_match)
// Reason: seeded pool.states[1/2] directly for predictor inputs; called element.load().

// Deleted: MOSFET M-8 (von comment cites mos1load.c:507).
// Coverage: retained below as source-file structural assertion.

// Deleted: MOSFET M-9 (TEMP default, tp.vt reflects TEMP, load uses tp.vt not ctx.vt,
//          setParam('TEMP') recomputes tp, tTransconductance scales with TEMP).
// Coverage: ngspice-parity/mosfet-inverter.test.ts (transient_match — temperature-corrected params
//           must produce correct transient waveform).
// Reason: accessed element._p._tVto / element._p._tKP (private fields); called element.load()
//         via makeNmosElement62.

// Deleted: MOSFET M-12 (INITFIX+OFF=1 zeros voltages, INITFIX OFF=0 routes through simpleGate,
//          INITFIX OFF=1 comment cites mos1load.c:431-433).
// Coverage: ngspice-parity/mosfet-inverter.test.ts (assertModeTransitionMatch)
// Reason: called element.load() directly; read pool.states[0]; used deleted helpers.
//         Source-file citation check retained below.

// Deleted: MOSFET companion-zero (MODEINITTRAN zeros gate-cap companions,
//          MODETRAN integrates gate-caps, MODEINITTRAN does NOT zero bulk-junction slots).
// Coverage: ngspice-parity/mosfet-inverter.test.ts (transient_match)
// Reason: seeded pool.states[0/1] directly; called element.load() via makeNmosElement62.

// ---------------------------------------------------------------------------
// M-8 source-file citation check (retained — pure source text assertion)
// ---------------------------------------------------------------------------

describe("MOSFET M-8", () => {
  it("von comment cites mos1load.c:507", () => {
    const fs = require("fs");
    const src = fs.readFileSync(
      require("path").resolve(__dirname, "../mosfet.ts"),
      "utf8",
    ) as string;
    expect(src).toMatch(/mos1load\.c:507/);
    expect(src).toMatch(/tVbi.*polarity/);
  });
});

// ---------------------------------------------------------------------------
// M-12 source-file citation check (retained — pure source text assertion)
// ---------------------------------------------------------------------------

describe("MOSFET M-12", () => {
  it("INITFIX OFF=1 comment cites mos1load.c:431-433", () => {
    const fs = require("fs");
    const src = fs.readFileSync(
      require("path").resolve(__dirname, "../mosfet.ts"),
      "utf8",
    ) as string;
    expect(src).toMatch(/mos1load\.c:431-433/);
    expect(src).toMatch(/mos1load\.c:204/);
  });
});

// ---------------------------------------------------------------------------
// Partition layout tests
// ---------------------------------------------------------------------------

describe("NMOS partition layout", () => {
  const instanceKeys = ["W", "L", "M", "OFF", "ICVDS", "ICVGS", "ICVBS", "TEMP"];
  const modelKeys = [
    "VTO", "KP", "GAMMA", "PHI", "LAMBDA", "RD", "RS", "CBD", "CBS",
    "IS", "PB", "CGSO", "CGDO", "CGBO", "RSH", "CJ", "MJ", "CJSW",
    "MJSW", "JS", "TOX", "NFS", "TPG", "XJ", "LD",
    "UO", "KF", "AF", "FC", "TNOM",
  ];

  it("instance keys have partition === 'instance'", () => {
    for (const key of instanceKeys) {
      const def = MOSFET_NMOS_PARAM_DEFS.find(d => d.key === key);
      expect(def, `NMOS paramDef for ${key} not found`).toBeDefined();
      expect(def!.partition, `NMOS ${key} partition`).toBe("instance");
    }
  });

  it("model keys have partition === 'model'", () => {
    for (const key of modelKeys) {
      const def = MOSFET_NMOS_PARAM_DEFS.find(d => d.key === key);
      if (!def) continue; // key may not be declared; only check declared ones
      expect(def.partition, `NMOS ${key} partition`).toBe("model");
    }
  });
});

describe("PMOS partition layout", () => {
  const instanceKeys = ["W", "L", "M", "OFF", "ICVDS", "ICVGS", "ICVBS", "TEMP"];
  const modelKeys = [
    "VTO", "KP", "GAMMA", "PHI", "LAMBDA", "RD", "RS", "CBD", "CBS",
    "IS", "PB", "CGSO", "CGDO", "CGBO", "RSH", "CJ", "MJ", "CJSW",
    "MJSW", "JS", "TOX", "NFS", "TPG", "XJ", "LD",
    "UO", "KF", "AF", "FC", "TNOM",
  ];

  it("instance keys have partition === 'instance'", () => {
    for (const key of instanceKeys) {
      const def = MOSFET_PMOS_PARAM_DEFS.find(d => d.key === key);
      expect(def, `PMOS paramDef for ${key} not found`).toBeDefined();
      expect(def!.partition, `PMOS ${key} partition`).toBe("instance");
    }
  });

  it("model keys have partition === 'model'", () => {
    for (const key of modelKeys) {
      const def = MOSFET_PMOS_PARAM_DEFS.find(d => d.key === key);
      if (!def) continue; // key may not be declared; only check declared ones
      expect(def.partition, `PMOS ${key} partition`).toBe("model");
    }
  });
});
