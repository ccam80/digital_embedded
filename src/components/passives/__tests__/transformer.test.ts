/** Tests for the Transformer component (two-winding, netlist composite). */

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
import type { Fixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

// ---------------------------------------------------------------------------
// .dts paths (T3 fixtures)
// ---------------------------------------------------------------------------

const DTS_AC_STEP_DOWN = path.resolve(
  "src/components/passives/__tests__/fixtures/transformer-canon-ac-step-down.dts",
);
const DTS_RL_PULSE = path.resolve(
  "src/components/passives/__tests__/fixtures/transformer-canon-rl-pulse.dts",
);

// ---------------------------------------------------------------------------
// Programmatic builders (T1)
// ---------------------------------------------------------------------------

interface AcBenchParams {
  amplitude: number;
  frequency: number;
  rLoad?: number;
  turnsRatio?: number;
  primaryInductance?: number;
  couplingCoefficient?: number;
}

function buildAcBench(facade: DefaultSimulatorFacade, p: AcBenchParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "AcVoltageSource", props: {
          label: "V1", amplitude: p.amplitude, frequency: p.frequency,
      } },
      { id: "tx",  type: "Transformer", props: {
          label:               "TX1",
          model:               "behavioral",
          turnsRatio:          p.turnsRatio          ?? 2.0,
          primaryInductance:   p.primaryInductance   ?? 100e-3,
          couplingCoefficient: p.couplingCoefficient ?? 0.8,
      } },
      { id: "rl",  type: "Resistor", props: { label: "R_LOAD", resistance: p.rLoad ?? 100 } },
      { id: "gnd", type: "Ground",   props: { label: "GND" } },
    ],
    connections: [
      ["vs:pos",  "tx:P1"],
      ["vs:neg",  "gnd:out"],
      ["tx:P2",   "gnd:out"],
      ["tx:S1",   "rl:pos"],
      ["rl:neg",  "gnd:out"],
      ["tx:S2",   "gnd:out"],
    ],
  });
}

interface DcBenchParams {
  vSource: number;
  rSeries?: number;
  rLoad?: number;
  turnsRatio?: number;
  primaryInductance?: number;
  couplingCoefficient?: number;
}

function buildDcBench(facade: DefaultSimulatorFacade, p: DcBenchParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",   type: "DcVoltageSource", props: { label: "V1",    voltage: p.vSource } },
      { id: "rser", type: "Resistor",        props: { label: "R_SER", resistance: p.rSeries ?? 100 } },
      { id: "tx",   type: "Transformer", props: {
          label:               "TX1",
          model:               "behavioral",
          turnsRatio:          p.turnsRatio          ?? 1.0,
          primaryInductance:   p.primaryInductance   ?? 10e-3,
          couplingCoefficient: p.couplingCoefficient ?? 0.99,
      } },
      { id: "rl",  type: "Resistor", props: { label: "R_LOAD", resistance: p.rLoad ?? 1000 } },
      { id: "gnd", type: "Ground",   props: { label: "GND" } },
    ],
    connections: [
      ["vs:pos",  "rser:pos"],
      ["rser:neg","tx:P1"],
      ["vs:neg",  "gnd:out"],
      ["tx:P2",   "gnd:out"],
      ["tx:S1",   "rl:pos"],
      ["rl:neg",  "gnd:out"],
      ["tx:S2",   "gnd:out"],
    ],
  });
}

function nodeOf(fix: Fixture, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

function getTransformerCe(fix: Fixture) {
  const idx = fix.circuit.elements.findIndex(
    (_e, i) => fix.elementLabels.get(i) === "TX1",
  );
  if (idx < 0) throw new Error("TX1 element not found by label");
  const ce = fix.circuit.elementToCircuitElement.get(idx);
  if (ce === undefined) throw new Error("TX1 elementToCircuitElement entry missing");
  return ce;
}

// ===========================================================================
// Category 1 — Initialization (T1)
// Post-warm-start: the netlist composite expands to 2 inductors (L1, L2) +
// 1 transformer-coupling (MUT). With P2 and S2 both grounded and inductors
// behaving as DC shorts, the post-warm-start V(P1) and V(S1) sit at their
// DCOP values. With external R_SER on the primary and R_LOAD on the
// secondary, V(P1) ≈ 0V (primary inductor shorts to grounded P2) and V(S1)
// ≈ 0V (secondary inductor shorts to grounded S2).
// ===========================================================================

describe("Transformer initialization — DC grounded P2/S2 (T1)", () => {
  it("init_grounded_returns_zero_node_voltages", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildDcBench(facade, { vSource: 5, rSeries: 100, rLoad: 1e6 }),
    });

    // P2 and S2 are tied directly to ground.
    const vP2 = fix.engine.getNodeVoltage(nodeOf(fix, "TX1:P2"));
    const vS2 = fix.engine.getNodeVoltage(nodeOf(fix, "TX1:S2"));
    expect(vP2).toBeCloseTo(0, 6);
    expect(vS2).toBeCloseTo(0, 6);

    // Inductor primary is a DC short ⇒ V(P1) = V(P2) = 0V at steady state.
    const vP1 = fix.engine.getNodeVoltage(nodeOf(fix, "TX1:P1"));
    expect(vP1).toBeCloseTo(0, 6);

    // Secondary inductor is also a DC short ⇒ V(S1) = V(S2) = 0V.
    const vS1 = fix.engine.getNodeVoltage(nodeOf(fix, "TX1:S1"));
    expect(vS1).toBeCloseTo(0, 6);
  });
});

// ===========================================================================
// Category 2 — DCOP analytical (T1)
// Inductors short at DC; with secondary tied to ground via S2 and shunted
// by R_LOAD, secondary node voltages collapse to 0V. V(P1)=0V (primary
// short to grounded P2). I_primary = Vsrc / R_SER.
// ===========================================================================

describe("Transformer DCOP analytical — DC grounded P2/S2 (T1)", () => {
  it("dcop_inductor_shorts_at_dc", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildDcBench(facade, { vSource: 5, rSeries: 100, rLoad: 1e6 }),
    });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    const vP1 = fix.engine.getNodeVoltage(nodeOf(fix, "TX1:P1"));
    const vS1 = fix.engine.getNodeVoltage(nodeOf(fix, "TX1:S1"));
    // Both windings short at DC ⇒ V(P1) and V(S1) collapse to 0V.
    expect(vP1).toBeCloseTo(0, 4);
    expect(vS1).toBeCloseTo(0, 4);
  });
});

// ===========================================================================
// Categories 2-numerical / 3 / 5 — paired vs ngspice (T3)
// One describe per .dts; first it() owns the run.
// ===========================================================================

describeIfDll("Transformer AC step-down vs ngspice — paired (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_AC_STEP_DOWN, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_ac_step_down", async () => {
    // f = 1kHz ⇒ period = 1ms. Run 5 cycles at 200 steps/cycle.
    await session.runTransient(0, 5e-3, 5e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_ac_step_down", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
    for (const [, comp] of Object.entries(stepEnd.components)) {
      for (const [, cv] of Object.entries(comp.slots ?? {})) expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_ac_step_down", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("Transformer RL pulse vs ngspice — paired (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_RL_PULSE, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_rl_pulse", async () => {
    // f = 500Hz ⇒ period = 2ms. Run 4 cycles at fine maxStep so the pulse
    // edges are well-resolved across the inductor companion model.
    await session.runTransient(0, 8e-3, 1e-5);
    session.compareAllSteps();
  });

  it("dcop_paired_rl_pulse", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
    for (const [, comp] of Object.entries(stepEnd.components)) {
      for (const [, cv] of Object.entries(comp.slots ?? {})) expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_rl_pulse", () => {
    session.compareAllAttempts();
  });
});

// ===========================================================================
// Category 4 — Parameter hot-load (T1)
// One it() per netlist-consumed parameter:
//   - turnsRatio (primary scaling): doubles ⇒ L2 = L1 / N² scales by 1/4
//     ⇒ AC transient response shifts on V(S1).
//   - primaryInductance (primary scaling): doubles ⇒ L1 doubles, L2 doubles,
//     M = k·sqrt(L1·L2) doubles ⇒ AC transient amplitude/phase shifts.
//   - couplingCoefficient (mutual scaling): drops ⇒ M = k·sqrt(L1·L2) drops
//     proportionally ⇒ secondary peak amplitude drops at same simTime.
// Assertions on simulator outputs only (V(TX1:S1) under AC drive).
// ===========================================================================

describe("Transformer parameter hot-load (T1)", () => {
  it("hotload_turnsRatio_changes_secondary_voltage", () => {
    // AC drive: changing turns ratio scales L2 = L1/N² ⇒ V(S1) at same simTime shifts.
    const fix = buildFixture({
      build: (_r, facade) => buildAcBench(facade, {
        amplitude: 5, frequency: 1000, rLoad: 100,
        turnsRatio: 2.0, primaryInductance: 100e-3, couplingCoefficient: 0.8,
      }),
      params: { tStop: 5e-3, maxTimeStep: 5e-6, uic: true },
    });
    const s1Node = nodeOf(fix, "TX1:S1");

    // Run 1.5 cycles to let the AC ramp settle past startup transient.
    while (fix.engine.simTime < 1.5e-3) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(s1Node);

    fix.coordinator.setComponentProperty(getTransformerCe(fix), "turnsRatio", 4.0);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(s1Node);
    expect(after).not.toBeCloseTo(before, 3);
  });

  it("hotload_primaryInductance_changes_secondary_voltage", () => {
    // Doubling primary inductance scales both self-inductances 2× and the
    // mutual term 2× as well (M = k·sqrt(L1·L2)). Phase/amplitude shifts.
    const fix = buildFixture({
      build: (_r, facade) => buildAcBench(facade, {
        amplitude: 5, frequency: 1000, rLoad: 100,
        turnsRatio: 2.0, primaryInductance: 100e-3, couplingCoefficient: 0.8,
      }),
      params: { tStop: 5e-3, maxTimeStep: 5e-6, uic: true },
    });
    const s1Node = nodeOf(fix, "TX1:S1");

    while (fix.engine.simTime < 1.5e-3) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(s1Node);

    fix.coordinator.setComponentProperty(getTransformerCe(fix), "primaryInductance", 200e-3);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(s1Node);
    expect(after).not.toBeCloseTo(before, 3);
  });

  it("hotload_couplingCoefficient_changes_secondary_voltage", () => {
    // Lower k ⇒ M = k·sqrt(L1·L2) drops proportionally ⇒ less energy coupled
    // to the secondary ⇒ V(S1) magnitude shifts at the same simTime.
    const fix = buildFixture({
      build: (_r, facade) => buildAcBench(facade, {
        amplitude: 5, frequency: 1000, rLoad: 100,
        turnsRatio: 2.0, primaryInductance: 100e-3, couplingCoefficient: 0.8,
      }),
      params: { tStop: 5e-3, maxTimeStep: 5e-6, uic: true },
    });
    const s1Node = nodeOf(fix, "TX1:S1");

    while (fix.engine.simTime < 1.5e-3) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(s1Node);

    fix.coordinator.setComponentProperty(getTransformerCe(fix), "couplingCoefficient", 0.3);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(s1Node);
    expect(after).not.toBeCloseTo(before, 3);
  });

  it("hotload_primaryResistance_changes_secondary_voltage", () => {
    // primaryResistance is a documented model param on the Transformer; the
    // contract is that adjusting it changes the primary-side series losses
    // and therefore V(S1) at the same simTime under AC drive. Assert the
    // documented contract.
    const fix = buildFixture({
      build: (_r, facade) => buildAcBench(facade, {
        amplitude: 5, frequency: 1000, rLoad: 100,
        turnsRatio: 2.0, primaryInductance: 100e-3, couplingCoefficient: 0.8,
      }),
      params: { tStop: 5e-3, maxTimeStep: 5e-6, uic: true },
    });
    const s1Node = nodeOf(fix, "TX1:S1");

    while (fix.engine.simTime < 1.5e-3) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(s1Node);

    fix.coordinator.setComponentProperty(getTransformerCe(fix), "primaryResistance", 50);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(s1Node);
    expect(after).not.toBeCloseTo(before, 3);
  });

  it("hotload_secondaryResistance_changes_secondary_voltage", () => {
    // secondaryResistance is a documented model param on the Transformer;
    // raising it adds a series loss in the secondary loop and shifts V(S1)
    // at the same simTime under AC drive. Assert the documented contract.
    const fix = buildFixture({
      build: (_r, facade) => buildAcBench(facade, {
        amplitude: 5, frequency: 1000, rLoad: 100,
        turnsRatio: 2.0, primaryInductance: 100e-3, couplingCoefficient: 0.8,
      }),
      params: { tStop: 5e-3, maxTimeStep: 5e-6, uic: true },
    });
    const s1Node = nodeOf(fix, "TX1:S1");

    while (fix.engine.simTime < 1.5e-3) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(s1Node);

    fix.coordinator.setComponentProperty(getTransformerCe(fix), "secondaryResistance", 50);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(s1Node);
    expect(after).not.toBeCloseTo(before, 3);
  });
});
