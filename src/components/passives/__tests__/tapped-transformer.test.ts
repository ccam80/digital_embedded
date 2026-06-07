/** Tests for the TappedTransformer component (3-winding, center-tapped). */

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

const DTS_DC_GROUNDED_CT = path.resolve(
  "src/components/passives/__tests__/fixtures/tapped-transformer-canon-dc-grounded-ct.dts",
);
const DTS_AC_SINUSOID = path.resolve(
  "src/components/passives/__tests__/fixtures/tapped-transformer-canon-ac-sinusoid.dts",
);

// ---------------------------------------------------------------------------
// Programmatic builders (T1)
// ---------------------------------------------------------------------------

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
      { id: "vs",   type: "DcVoltageSource", props: { label: "V1", voltage: p.vSource } },
      { id: "rser", type: "Resistor",        props: { label: "R_SER", resistance: p.rSeries ?? 100 } },
      { id: "tx",   type: "TappedTransformer", props: {
          label:               "TX1",
          model:               "behavioral",
          turnsRatio:          p.turnsRatio          ?? 2.0,
          primaryInductance:   p.primaryInductance   ?? 10e-3,
          couplingCoefficient: p.couplingCoefficient ?? 0.99,
      } },
      { id: "rs1", type: "Resistor", props: { label: "R_S1", resistance: p.rLoad ?? 1000 } },
      { id: "rs2", type: "Resistor", props: { label: "R_S2", resistance: p.rLoad ?? 1000 } },
      { id: "gnd", type: "Ground",   props: { label: "GND" } },
    ],
    connections: [
      ["vs:pos",  "rser:pos"],
      ["rser:neg","tx:P1"],
      ["vs:neg",  "gnd:out"],
      ["tx:P2",   "gnd:out"],
      ["tx:CT",   "gnd:out"],
      ["tx:S1",   "rs1:pos"],
      ["rs1:neg", "gnd:out"],
      ["tx:S2",   "rs2:pos"],
      ["rs2:neg", "gnd:out"],
    ],
  });
}

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
      { id: "tx",  type: "TappedTransformer", props: {
          label:               "TX1",
          model:               "behavioral",
          turnsRatio:          p.turnsRatio          ?? 2.0,
          primaryInductance:   p.primaryInductance   ?? 100e-3,
          couplingCoefficient: p.couplingCoefficient ?? 0.8,
      } },
      { id: "rs1", type: "Resistor", props: { label: "R_S1", resistance: p.rLoad ?? 100 } },
      { id: "rs2", type: "Resistor", props: { label: "R_S2", resistance: p.rLoad ?? 100 } },
      { id: "gnd", type: "Ground",   props: { label: "GND" } },
    ],
    connections: [
      ["vs:pos",  "tx:P1"],
      ["vs:neg",  "gnd:out"],
      ["tx:P2",   "gnd:out"],
      ["tx:CT",   "gnd:out"],
      ["tx:S1",   "rs1:pos"],
      ["rs1:neg", "gnd:out"],
      ["tx:S2",   "rs2:pos"],
      ["rs2:neg", "gnd:out"],
    ],
  });
}

function nodeOf(fix: Fixture, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

// ===========================================================================
// Category 1 — Initialization (T1)
// Post-warm-start: the netlist composite expands to 3 inductors + 3 couplings.
// With CT grounded, the leaf inductor branches each act as DC shorts, so the
// post-warm-start V(P1) = 0V (Vsrc drops entirely across R_SER) and V(CT) = 0V.
// ===========================================================================

describe("TappedTransformer initialization — DC grounded CT (T1)", () => {
  it("init_grounded_ct_node_voltages", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildDcBench(facade, { vSource: 10, rSeries: 100, rLoad: 1e6 }),
    });

    // CT and P2 are tied directly to ground.
    const vCT = fix.engine.getNodeVoltage(nodeOf(fix, "TX1:CT"));
    const vP2 = fix.engine.getNodeVoltage(nodeOf(fix, "TX1:P2"));
    expect(vCT).toBeCloseTo(0, 6);
    expect(vP2).toBeCloseTo(0, 6);

    // Inductor primary is a DC short ⇒ V(P1) = V(P2) = 0V at steady state.
    const vP1 = fix.engine.getNodeVoltage(nodeOf(fix, "TX1:P1"));
    expect(vP1).toBeCloseTo(0, 6);
  });
});

// ===========================================================================
// Category 2 — DCOP analytical (T1)
// Inductors short at DC; CT held to ground; symmetric secondary loading.
//   • V(P1) = 0V  (primary inductor shorts, R_SER carries Vsrc/R_SER)
//   • V(S1) = V(S2) = 0V  (secondary halves short to grounded CT)
//   • |V(S1) - V(CT)| ≈ |V(CT) - V(S2)|  (secondary symmetry)
// ===========================================================================

describe("TappedTransformer DCOP analytical — DC grounded CT (T1)", () => {
  it("dcop_grounded_ct_secondary_shorts_to_ground", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildDcBench(facade, { vSource: 10, rSeries: 100, rLoad: 1e6 }),
    });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    const vS1 = fix.engine.getNodeVoltage(nodeOf(fix, "TX1:S1"));
    const vS2 = fix.engine.getNodeVoltage(nodeOf(fix, "TX1:S2"));
    const vCT = fix.engine.getNodeVoltage(nodeOf(fix, "TX1:CT"));
    // Secondary halves short to CT (grounded) at DC.
    expect(vS1).toBeCloseTo(0, 4);
    expect(vS2).toBeCloseTo(0, 4);
    expect(vCT).toBeCloseTo(0, 6);
  });

  it("dcop_grounded_ct_secondary_halves_symmetric", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildDcBench(facade, { vSource: 5, rSeries: 100, rLoad: 1e6 }),
    });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    const vS1 = fix.engine.getNodeVoltage(nodeOf(fix, "TX1:S1"));
    const vCT = fix.engine.getNodeVoltage(nodeOf(fix, "TX1:CT"));
    const vS2 = fix.engine.getNodeVoltage(nodeOf(fix, "TX1:S2"));
    // Half-symmetric construction (L2 = L3, M12 = M13) plus symmetric loads
    // ⇒ |V(S1,CT)| = |V(CT,S2)| within numerical noise.
    expect(Math.abs(Math.abs(vS1 - vCT) - Math.abs(vCT - vS2))).toBeLessThan(1e-6);
  });
});

// ===========================================================================
// Categories 2-numerical / 3 / 5 — paired vs ngspice (T3)
// One describe per .dts; first it() owns the run.
// ===========================================================================

describeIfDll("TappedTransformer DC grounded CT vs ngspice — paired (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_DC_GROUNDED_CT, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_dc_grounded_ct", async () => {
    // Short transient on the DC bench: τ_L = L1/R_SER = 10mH/100Ω = 100µs.
    // Run 5τ at 100 steps/τ to capture the inductive transient settling.
    await session.runTransient(0, 5e-4, 1e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_dc_grounded_ct", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
    for (const [, comp] of Object.entries(stepEnd.components)) {
      for (const [, cv] of Object.entries(comp.slots ?? {})) expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_dc_grounded_ct", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("TappedTransformer AC sinusoid vs ngspice — paired (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_AC_SINUSOID, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_ac_sinusoid", async () => {
    // f = 1kHz ⇒ period = 1ms. Run 5 cycles at 200 steps/cycle.
    await session.runTransient(0, 5e-3, 5e-6);
    session.compareAllSteps();
  });

  it("dcop_paired_ac_sinusoid", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
    for (const [, comp] of Object.entries(stepEnd.components)) {
      for (const [, cv] of Object.entries(comp.slots ?? {})) expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_ac_sinusoid", () => {
    session.compareAllAttempts();
  });
});

// ===========================================================================
// Category 4 — Parameter hot-load (T1)
// One it() per parameter the netlist composite exposes:
//   - turnsRatio (primary scaling): doubles ⇒ secondary half inductance
//     L2 = L3 = L1·(N/2)² scales by 4 ⇒ AC transient response shifts.
//   - primaryInductance (primary scaling): doubles ⇒ all three inductances
//     scale linearly ⇒ AC transient amplitude/phase shifts.
//   - couplingCoefficient (mutual scaling): drops ⇒ M12, M13, M23 drop
//     proportionally ⇒ secondary peak amplitude drops (less coupled energy).
// Assertions on simulator outputs only (V(tx:S1) under AC drive).
// ===========================================================================

describe("TappedTransformer parameter hot-load (T1)", () => {
  it("hotload_turnsRatio_changes_secondary_voltage", async () => {
    // AC drive: doubling the turns ratio scales L2 = L3 by 4×.
    // V(S1) at the same simTime must change.
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

    fix.coordinator.setComponentProperty(fix.element("TX1"), "turnsRatio", 4.0);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(s1Node);
    expect(after).not.toBeCloseTo(before, 3);
  });

  it("hotload_primaryInductance_changes_secondary_voltage", async () => {
    // Doubling primary inductance scales all three self-inductances 2× and
    // mutual terms by 2× as well (M = k·sqrt(L·L)). Phase/amplitude shifts.
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

    fix.coordinator.setComponentProperty(fix.element("TX1"), "primaryInductance", 200e-3);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(s1Node);
    expect(after).not.toBeCloseTo(before, 3);
  });

  it("hotload_couplingCoefficient_changes_secondary_voltage", async () => {
    // Lower k ⇒ M12, M13, M23 drop proportionally ⇒ less energy coupled to
    // the secondary halves ⇒ V(S1) magnitude shifts at the same simTime.
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

    fix.coordinator.setComponentProperty(fix.element("TX1"), "couplingCoefficient", 0.3);
    fix.coordinator.step();
    const after = fix.engine.getNodeVoltage(s1Node);
    expect(after).not.toBeCloseTo(before, 3);
  });
});
