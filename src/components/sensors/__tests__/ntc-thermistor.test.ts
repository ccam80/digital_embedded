import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";

import { buildFixture, type Fixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";

import { NTC_SCHEMA, NTCThermistorElement } from "../ntc-thermistor.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Schema-resolved slot indices (B-3: no raw SLOT_* imports).
// ---------------------------------------------------------------------------

const SLOT_TEMPERATURE = NTC_SCHEMA.indexOf.get("TEMPERATURE")!;

// ---------------------------------------------------------------------------
// DTS fixture paths (T3 harness).
// ---------------------------------------------------------------------------
//
// Authored via MCP circuit_build + circuit_save under
// src/components/sensors/__tests__/fixtures/.
//
// 1. ntc-canon-divider.dts: V1=5V, RP=10k, NTC (defaults: r0=10k,
//    beta=3950, t0=298.15, temperature=298.15, selfHeating=false), GND.
//    R(T)=R0 at T=T0 -> V(mid) ~= Vs/2; flat divider exercises the NTC
//    stamp at fixed ambient.
// 2. ntc-canon-self-heating-transient.dts: V1=5V, RP=1ohm, NTC (r0=100,
//    selfHeating=true; thermalResistance/Capacitance default), GND. Low-
//    impedance arrangement dissipates real power so the bottom-of-load
//    thermal ODE integrates over the transient.

const DTS_DIVIDER = path.resolve(
  "src/components/sensors/__tests__/fixtures/ntc-canon-divider.dts",
);
const DTS_SELF_HEATING = path.resolve(
  "src/components/sensors/__tests__/fixtures/ntc-canon-self-heating-transient.dts",
);

// ---------------------------------------------------------------------------
// Programmatic circuit factories (T1)
// ---------------------------------------------------------------------------
//
// Pull-up divider: VS -> R_pull -> ntc:pos - NTC - ntc:neg -> GND <- VS:neg.
// At DCOP the NTC body is a pure resistor R(T), so the divider node voltage
//   V(ntc:pos) = Vs * R_ntc / (R_pull + R_ntc)
// inverts to
//   R_ntc = R_pull * V_div / (Vs - V_div)
// which lets us read R(T) at the public engine surface.

interface NtcDividerParams {
  vSource?: number;
  rPull?: number;
  r0?: number;
  beta?: number;
  t0?: number;
  temperature?: number;
  selfHeating?: boolean;
  thermalResistance?: number;
  thermalCapacitance?: number;
  shA?: number;
  shB?: number;
  shC?: number;
}

function buildNtcDivider(facade: DefaultSimulatorFacade, p: NtcDividerParams): Circuit {
  const ntcProps: Record<string, number | string | boolean> = { label: "ntc" };
  if (p.r0 !== undefined) ntcProps.r0 = p.r0;
  if (p.beta !== undefined) ntcProps.beta = p.beta;
  if (p.t0 !== undefined) ntcProps.t0 = p.t0;
  if (p.temperature !== undefined) ntcProps.temperature = p.temperature;
  if (p.selfHeating !== undefined) ntcProps.selfHeating = p.selfHeating;
  if (p.thermalResistance !== undefined) ntcProps.thermalResistance = p.thermalResistance;
  if (p.thermalCapacitance !== undefined) ntcProps.thermalCapacitance = p.thermalCapacitance;
  if (p.shA !== undefined) ntcProps.shA = p.shA;
  if (p.shB !== undefined) ntcProps.shB = p.shB;
  if (p.shC !== undefined) ntcProps.shC = p.shC;

  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { label: "vs", voltage: p.vSource ?? 5 } },
      { id: "rp",  type: "Resistor",        props: { label: "rp", resistance: p.rPull ?? 10000 } },
      { id: "ntc", type: "NTCThermistor",   props: ntcProps },
      { id: "gnd", type: "Ground",          props: { label: "gnd" } },
    ],
    connections: [
      ["vs:pos",  "rp:pos"],
      ["rp:neg",  "ntc:pos"],
      ["ntc:neg", "gnd:out"],
      ["vs:neg",  "gnd:out"],
    ],
  });
}

function nodeOf(fix: Fixture, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

function findNtcElement(fix: Fixture): NTCThermistorElement {
  for (const el of fix.circuit.elements) {
    if (el instanceof NTCThermistorElement) return el;
  }
  throw new Error("NTCThermistorElement not found in compiled circuit");
}

/** Closed-form NTC resistance from divider node voltage. */
function rNtcFromDividerVoltage(vDiv: number, vSrc: number, rPull: number): number {
  return (rPull * vDiv) / (vSrc - vDiv);
}

/** Closed-form B-parameter resistance: R(T) = R0 * exp(beta * (1/T - 1/T0)). */
function rBParam(r0: number, beta: number, t0: number, t: number): number {
  return r0 * Math.exp(beta * (1 / t - 1 / t0));
}

// ---------------------------------------------------------------------------
// Cat 1 - Initialization (T1)
// ---------------------------------------------------------------------------

describe("NTCThermistor initialization (T1)", () => {
  it("init_temperature_slot_seeded_to_ambient_at_step_zero", () => {
    // Per ntc-thermistor.ts:245-248, the first load() seeds
    // s0[base + SLOT_TEMPERATURE] to the ambient temperature. After
    // buildFixture's warm-start step we expect that slot value to equal
    // the configured ambient (350K, deliberately non-default to distinguish
    // from zero-init).
    const fix = buildFixture({
      build: (_r, facade) => buildNtcDivider(facade, {
        vSource: 5, rPull: 10000, r0: 10000, t0: 298.15, temperature: 350,
      }),
    });
    const ntc = findNtcElement(fix);
    const slotIdx = ntc._stateBase + SLOT_TEMPERATURE;
    expect(fix.pool.state0[slotIdx]).toBeCloseTo(350, 6);
  });

  it("init_node_voltage_seeded_to_dcop_value", () => {
    // R(T0)=R0, so with R_pull=R0 the divider node lands at Vs/2 after the
    // warm-start step.
    const fix = buildFixture({
      build: (_r, facade) => buildNtcDivider(facade, {
        vSource: 5, rPull: 10000, r0: 10000, t0: 298.15, temperature: 298.15,
      }),
    });
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "ntc:pos"))).toBeCloseTo(2.5, 6);
  });
});

// ---------------------------------------------------------------------------
// Cat 2 - DCOP analytical (T1)
// ---------------------------------------------------------------------------

describe("NTCThermistor DCOP analytical (T1)", () => {
  it("dcop_at_t0_yields_r0_via_divider_observation", () => {
    // At T=T0 the B-parameter exponent is zero so R(T0)=R0. With R_pull=R0
    // the divider sits at exactly Vs/2 and the inverted formula returns R0.
    const fix = buildFixture({
      build: (_r, facade) => buildNtcDivider(facade, {
        vSource: 5, rPull: 10000, r0: 10000, beta: 3950, t0: 298.15, temperature: 298.15,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const vDiv = fix.engine.getNodeVoltage(nodeOf(fix, "ntc:pos"));
    expect(vDiv).toBeCloseTo(2.5, 6);

    const rNtc = rNtcFromDividerVoltage(vDiv, 5, 10000);
    expect(rNtc).toBeCloseTo(10000, 0);
  });

  it("dcop_at_350K_matches_b_parameter_closed_form", () => {
    // Closed-form: R(350K, R0=10k, beta=3950, T0=298.15) ~= 1405 ohm.
    // The divider voltage is then Vs * R/(R_pull+R) and inverting matches.
    const fix = buildFixture({
      build: (_r, facade) => buildNtcDivider(facade, {
        vSource: 5, rPull: 10000, r0: 10000, beta: 3950, t0: 298.15, temperature: 350,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc!.converged).toBe(true);

    const vDiv = fix.engine.getNodeVoltage(nodeOf(fix, "ntc:pos"));
    const rNtc = rNtcFromDividerVoltage(vDiv, 5, 10000);
    const rExpected = rBParam(10000, 3950, 298.15, 350);
    // Engine-observed R within 0.1% of closed-form.
    expect(Math.abs(rNtc - rExpected) / rExpected).toBeLessThan(1e-3);
  });

  it("dcop_below_t0_resistance_rises_above_r0_steinhart_hart", () => {
    // Steinhart-Hart coefficient set lands R(298.15K) ~= 10k for a typical
    // 10k NTC; at lower T (273.15K) R rises. Closed-form S-H inversion is
    // intractable here so assert directionally + within sanity envelope.
    const shA = 1.1e-3, shB = 2.4e-4, shC = 7.5e-8;
    const fix25 = buildFixture({
      build: (_r, facade) => buildNtcDivider(facade, {
        vSource: 5, rPull: 10000, temperature: 298.15, shA, shB, shC,
      }),
    });
    const fix0 = buildFixture({
      build: (_r, facade) => buildNtcDivider(facade, {
        vSource: 5, rPull: 10000, temperature: 273.15, shA, shB, shC,
      }),
    });
    const r25 = rNtcFromDividerVoltage(
      fix25.engine.getNodeVoltage(nodeOf(fix25, "ntc:pos")), 5, 10000,
    );
    const r0K = rNtcFromDividerVoltage(
      fix0.engine.getNodeVoltage(nodeOf(fix0, "ntc:pos")), 5, 10000,
    );
    expect(r25).toBeGreaterThan(8000);
    expect(r25).toBeLessThan(12000);
    expect(r0K).toBeGreaterThan(r25);
  });
});

// ---------------------------------------------------------------------------
// Cat 4 - Parameter hot-load (T1)
// ---------------------------------------------------------------------------
//
// NTC primary params: r0, beta, temperature. Secondary: t0, thermalResistance,
// thermalCapacitance. Hot-load through setComponentProperty exercises the
// element setParam(...) path. One it() per param whose post-change observable
// has a tractable closed-form prediction or strictly-monotonic direction.

describe("NTCThermistor parameter hot-load (T1)", () => {
  it("hotload_r0_changes_divider_midpoint_voltage", () => {
    // At T=T0 R(T)=R0. Halving R0 from 10k -> 5k while R_pull stays at 10k
    // shifts the divider from Vs/2 to Vs * 5k/15k = Vs/3.
    const fix = buildFixture({
      build: (_r, facade) => buildNtcDivider(facade, {
        vSource: 5, rPull: 10000, r0: 10000, beta: 3950, t0: 298.15, temperature: 298.15,
      }),
    });
    const midNode = nodeOf(fix, "ntc:pos");
    const before = fix.engine.getNodeVoltage(midNode);
    expect(before).toBeCloseTo(2.5, 4);

    const ntcEl = fix.element("ntc");
    fix.coordinator.setComponentProperty(ntcEl, "r0", 5000);
    fix.coordinator.dcOperatingPoint();

    const after = fix.engine.getNodeVoltage(midNode);
    expect(after).not.toBeCloseTo(before, 4);
    expect(after).toBeCloseTo(5 * 5000 / 15000, 6);
  });

  it("hotload_beta_at_offset_temperature_changes_divider_voltage", () => {
    // At T != T0, R(T) = R0 * exp(beta*(1/T - 1/T0)) depends on beta. With
    // T=350K, T0=298.15K, raising beta from 3950 -> 4500 lowers R(350K)
    // (the exponent is more negative), so V(ntc:pos) drops.
    const fix = buildFixture({
      build: (_r, facade) => buildNtcDivider(facade, {
        vSource: 5, rPull: 10000, r0: 10000, beta: 3950, t0: 298.15, temperature: 350,
      }),
    });
    const midNode = nodeOf(fix, "ntc:pos");
    const before = fix.engine.getNodeVoltage(midNode);

    const ntcEl = fix.element("ntc");
    fix.coordinator.setComponentProperty(ntcEl, "beta", 4500);
    fix.coordinator.dcOperatingPoint();

    const after = fix.engine.getNodeVoltage(midNode);
    const rExpected = rBParam(10000, 4500, 298.15, 350);
    const vExpected = 5 * rExpected / (10000 + rExpected);
    expect(after).not.toBeCloseTo(before, 4);
    expect(after).toBeCloseTo(vExpected, 4);
  });

  it("hotload_temperature_changes_divider_voltage", () => {
    // Raising temperature (NTC contract) decreases R(T), pulling V(ntc:pos)
    // toward 0. Closed-form check against the B-parameter formula at the
    // new temperature.
    const fix = buildFixture({
      build: (_r, facade) => buildNtcDivider(facade, {
        vSource: 5, rPull: 10000, r0: 10000, beta: 3950, t0: 298.15, temperature: 298.15,
      }),
    });
    const midNode = nodeOf(fix, "ntc:pos");
    const before = fix.engine.getNodeVoltage(midNode);

    const ntcEl = fix.element("ntc");
    fix.coordinator.setComponentProperty(ntcEl, "temperature", 348.15);
    fix.coordinator.dcOperatingPoint();

    const after = fix.engine.getNodeVoltage(midNode);
    const rExpected = rBParam(10000, 3950, 298.15, 348.15);
    const vExpected = 5 * rExpected / (10000 + rExpected);
    expect(after).not.toBeCloseTo(before, 4);
    expect(after).toBeCloseTo(vExpected, 4);
    expect(after).toBeLessThan(before);
  });

  it("hotload_t0_shifts_reference_temperature_and_changes_divider_voltage", () => {
    // R(T) depends on T0 through (1/T - 1/T0). With T held at 298.15 and
    // T0 raised from 298.15 -> 310, the exponent becomes positive so R
    // grows above R0 and V(ntc:pos) rises.
    const fix = buildFixture({
      build: (_r, facade) => buildNtcDivider(facade, {
        vSource: 5, rPull: 10000, r0: 10000, beta: 3950, t0: 298.15, temperature: 298.15,
      }),
    });
    const midNode = nodeOf(fix, "ntc:pos");
    const before = fix.engine.getNodeVoltage(midNode);

    const ntcEl = fix.element("ntc");
    fix.coordinator.setComponentProperty(ntcEl, "t0", 310);
    fix.coordinator.dcOperatingPoint();

    const after = fix.engine.getNodeVoltage(midNode);
    const rExpected = rBParam(10000, 3950, 310, 298.15);
    const vExpected = 5 * rExpected / (10000 + rExpected);
    expect(after).not.toBeCloseTo(before, 4);
    expect(after).toBeCloseTo(vExpected, 4);
    expect(after).toBeGreaterThan(before);
  });

  it("hotload_thermalResistance_changes_steady_state_temperature_under_self_heating", () => {
    // Steady-state temperature under self-heating: T_eq = T_amb + P*R_th.
    // Doubling R_th (with the same dissipation) raises T_eq, which (NTC
    // contract) drops R and therefore raises P slightly. After a number of
    // thermal time constants the s0[TEMPERATURE] slot must rise vs the
    // baseline. Directional assertion - closed-form depends on the R(T)/P(T)
    // feedback fixed point and is not tractable in closed form.
    const baseProps = {
      vSource: 1, rPull: 1, r0: 100, beta: 3950, t0: 298.15, temperature: 298.15,
      selfHeating: true, thermalCapacitance: 0.001,
    } as const;
    const fixLow = buildFixture({
      build: (_r, facade) => buildNtcDivider(facade, { ...baseProps, thermalResistance: 50 }),
      params: { tStop: 5.0, maxTimeStep: 1e-3 },
    });
    const fixHigh = buildFixture({
      build: (_r, facade) => buildNtcDivider(facade, { ...baseProps, thermalResistance: 200 }),
      params: { tStop: 5.0, maxTimeStep: 1e-3 },
    });
    while (fixLow.engine.simTime < 1.0) fixLow.coordinator.step();
    while (fixHigh.engine.simTime < 1.0) fixHigh.coordinator.step();

    const ntcLow = findNtcElement(fixLow);
    const ntcHigh = findNtcElement(fixHigh);
    const tLow = fixLow.pool.state0[ntcLow._stateBase + SLOT_TEMPERATURE];
    const tHigh = fixHigh.pool.state0[ntcHigh._stateBase + SLOT_TEMPERATURE];

    expect(tHigh).toBeGreaterThan(tLow);
    expect(tLow).toBeGreaterThan(298.15);
  });

  it("hotload_thermalCapacitance_changes_self_heating_time_constant", () => {
    // Higher thermal capacitance => longer thermal time constant (tau =
    // R_th * C_th) => less temperature rise after a fixed wall-clock window.
    const baseProps = {
      vSource: 1, rPull: 1, r0: 100, beta: 3950, t0: 298.15, temperature: 298.15,
      selfHeating: true, thermalResistance: 50,
    } as const;
    const fixFast = buildFixture({
      build: (_r, facade) => buildNtcDivider(facade, { ...baseProps, thermalCapacitance: 0.001 }),
      params: { tStop: 5.0, maxTimeStep: 1e-4 },
    });
    const fixSlow = buildFixture({
      build: (_r, facade) => buildNtcDivider(facade, { ...baseProps, thermalCapacitance: 0.1 }),
      params: { tStop: 5.0, maxTimeStep: 1e-4 },
    });
    while (fixFast.engine.simTime < 0.05) fixFast.coordinator.step();
    while (fixSlow.engine.simTime < 0.05) fixSlow.coordinator.step();

    const ntcFast = findNtcElement(fixFast);
    const ntcSlow = findNtcElement(fixSlow);
    const tFast = fixFast.pool.state0[ntcFast._stateBase + SLOT_TEMPERATURE];
    const tSlow = fixSlow.pool.state0[ntcSlow._stateBase + SLOT_TEMPERATURE];

    expect(tFast).toBeGreaterThan(tSlow);
  });
});

// ---------------------------------------------------------------------------
// Cat 2 num / 3 / 5 - paired vs ngspice on the divider .dts (T3)
// ---------------------------------------------------------------------------

describeIfDll("NTCThermistor paired vs ngspice - divider (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_DIVIDER, analysis: "tran", tStop: 1e-3, maxStep: 10e-6 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  // Per Step 2c: the FIRST it() owns the run; siblings read from the
  // recorded session. A throw inside runTransient surfaces as a visible
  // failed test instead of a silent skip across the whole describe.
  it("transient_step_end_paired_divider", async () => {
    await session.runTransient(0, 1e-3, 10e-6);
    session.compareAllSteps();
  }, 180_000);

  it("dcop_paired_divider", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_divider", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// Cat 2 num / 3 / 5 - paired vs ngspice on the self-heating .dts (T3)
// ---------------------------------------------------------------------------

describeIfDll("NTCThermistor paired vs ngspice - self-heating transient (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_SELF_HEATING, analysis: "tran", tStop: 1e-3, maxStep: 10e-6 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_self_heating", async () => {
    await session.runTransient(0, 1e-3, 10e-6);
    session.compareAllSteps();
  }, 180_000);

  it("dcop_paired_self_heating", () => {
    const stepEnd = session.getStepEnd(0);
    for (const cv of Object.values(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
  });

  it("full_iteration_paired_self_heating", () => {
    session.compareAllAttempts();
  });
});
