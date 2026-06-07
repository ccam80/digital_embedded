import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { NTC_SCHEMA } from "../ntc-thermistor.js";
import { PoolBackedAnalogElement } from "../../../solver/analog/element.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// DTS fixture paths (T3 harness) — authored under sensors/__tests__/fixtures.
// Two operating-region configurations:
//   - fixed-temp (selfHeating=false): static resistor stamp; T pinned to ambient.
//   - self-heating (selfHeating=true): dynamic dT/dt integrated bottom-of-load.
// ---------------------------------------------------------------------------

const DTS_FIXED_TEMP = path.resolve(
  "src/components/sensors/__tests__/fixtures/ntc-canon-fixed-temp.dts",
);
const DTS_SELF_HEATING = path.resolve(
  "src/components/sensors/__tests__/fixtures/ntc-canon-self-heating.dts",
);

// ---------------------------------------------------------------------------
// Programmatic circuit factories (T1)
// ---------------------------------------------------------------------------

interface NtcFixedParams {
  vSource?: number;
  r0?: number;
  beta?: number;
  t0?: number;
  temperature?: number;
}

function buildNtcFixedTempCircuit(
  facade: DefaultSimulatorFacade,
  p: NtcFixedParams = {},
): Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: p.vSource ?? 1 } },
      { id: "ntc", type: "NTCThermistor",   props: {
        label:       "ntc",
        model:       "behavioral",
        r0:          p.r0 ?? 100,
        beta:        p.beta ?? 3950,
        t0:          p.t0 ?? 298.15,
        temperature: p.temperature ?? 298.15,
        selfHeating: false,
      } },
      { id: "gnd", type: "Ground",          props: { label: "gnd" } },
    ],
    connections: [
      ["vs:pos",  "ntc:pos"],
      ["ntc:neg", "gnd:out"],
      ["vs:neg",  "gnd:out"],
    ],
  });
}

interface NtcSelfHeatingParams {
  vSource?: number;
  r0?: number;
  beta?: number;
  t0?: number;
  temperature?: number;
  thermalResistance?: number;
  thermalCapacitance?: number;
}

function buildNtcSelfHeatingCircuit(
  facade: DefaultSimulatorFacade,
  p: NtcSelfHeatingParams = {},
): Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: p.vSource ?? 100 } },
      { id: "ntc", type: "NTCThermistor",   props: {
        label:              "ntc",
        model:              "behavioral",
        r0:                 p.r0 ?? 100,
        beta:               p.beta ?? 3950,
        t0:                 p.t0 ?? 298.15,
        temperature:        p.temperature ?? 298.15,
        selfHeating:        true,
        thermalResistance:  p.thermalResistance  ?? 50,
        thermalCapacitance: p.thermalCapacitance ?? 0.001,
      } },
      { id: "gnd", type: "Ground",          props: { label: "gnd" } },
    ],
    connections: [
      ["vs:pos",  "ntc:pos"],
      ["ntc:neg", "gnd:out"],
      ["vs:neg",  "gnd:out"],
    ],
  });
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

function findNtcElement(fix: ReturnType<typeof buildFixture>): PoolBackedAnalogElement {
  const idx = fix.circuit.elements.findIndex(
    (el) =>
      el instanceof PoolBackedAnalogElement &&
      (el as PoolBackedAnalogElement).stateSchema.owner === "NTCThermistorElement",
  );
  if (idx < 0) throw new Error("NTCThermistorElement not found in compiled circuit");
  return fix.circuit.elements[idx] as PoolBackedAnalogElement;
}

// ---------------------------------------------------------------------------
// Cat 1 — Initialization (T1)
// NTC has a single pool slot TEMPERATURE seeded at first load() to the
// _tAmbient boot constant. Post-warm-start the slot must hold the ambient
// temperature and the analog node voltages must reflect a converged DCOP.
// ---------------------------------------------------------------------------

describe("NTCThermistor initialization (T1)", () => {
  const SLOT_TEMPERATURE = NTC_SCHEMA.indexOf.get("TEMPERATURE")!;

  it("init_temperature_slot_seeded_to_ambient", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildNtcFixedTempCircuit(facade, { temperature: 298.15 }),
    });
    const el = findNtcElement(fix);
    const t = fix.pool.state0[el._stateBase + SLOT_TEMPERATURE];
    expect(t).toBeCloseTo(298.15, 6);
    const vPos = fix.engine.getNodeVoltage(nodeOf(fix, "vs:pos"));
    expect(vPos).toBeCloseTo(1, 6);
  });

  it("init_temperature_slot_seeded_to_non_default_ambient", () => {
    // Non-default ambient (350 K) distinguishes from zero-init / boot default.
    const fix = buildFixture({
      build: (_r, facade) => buildNtcFixedTempCircuit(facade, { temperature: 350 }),
    });
    const el = findNtcElement(fix);
    const t = fix.pool.state0[el._stateBase + SLOT_TEMPERATURE];
    expect(t).toBeCloseTo(350, 6);
  });
});

// ---------------------------------------------------------------------------
// Cat 2 — DCOP analytical (T1)
// Non-self-heating NTC at T=T0 reduces to R(T0)=r0. With VS=1V, R=r0=100Ω,
// the loop current is I = 1/100 = 10 mA and the NTC pin voltages are vs:pos
// = 1V, ntc:neg = 0V. Closed-form check on the resistor stamp.
// ---------------------------------------------------------------------------

describe("NTCThermistor DCOP analytical (T1)", () => {
  it("dcop_fixed_temp_at_t0_node_and_pin_currents_match_closed_form", () => {
    const fix = buildFixture({
      build: (_r, facade) =>
        buildNtcFixedTempCircuit(facade, {
          vSource: 1,
          r0: 100,
          t0: 298.15,
          temperature: 298.15,
        }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    // R(T0) = r0 = 100Ω. V_ntc = 1V across the NTC; I = 1/100 = 0.01 A.
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vs:pos"))).toBeCloseTo(1, 6);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "ntc:neg"))).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// Cat 4 — Parameter hot-load (T1)
// Coverage: one it() per parameter group on the NTCThermistor surface.
//   Structural primary: r0 (scales conductance directly), beta (B-parameter
//                       in R(T) exponent).
//   Derived-state ambient: temperature (sets _tAmbient → R(T) at the pinned T).
//   Reference: t0 (reference T in the exponent).
//   Thermal: thermalResistance, thermalCapacitance (only meaningful in
//            self-heating mode; covered against the self-heating circuit).
// ---------------------------------------------------------------------------

describe("NTCThermistor parameter hot-load (T1)", () => {
  it("hotload_r0_changes_node_voltage", () => {
    // Series circuit: VS=1V → NTC → GND. With selfHeating=false at T=T0,
    // R = r0. Doubling r0 with a series-only loop holds the loop current
    // unchanged across the source-stiff topology, but the pin-level
    // observable on the NTC is its current; assert that scaled.
    // Structural: with VS pinning vs:pos to 1V and ntc:neg to GND, the only
    // observable that scales with r0 in this loop is the conductance and
    // hence the NTC pin current.
    const fix = buildFixture({
      build: (_r, facade) =>
        buildNtcFixedTempCircuit(facade, { vSource: 1, r0: 100 }),
    });
    fix.coordinator.dcOperatingPoint();
    const ntcIdx = fix.circuit.elements.findIndex(
      (el) =>
        el instanceof PoolBackedAnalogElement &&
        (el as PoolBackedAnalogElement).stateSchema.owner === "NTCThermistorElement",
    );
    const before = fix.engine.getElementPinCurrents(ntcIdx);
    // I_before = 1V / 100Ω = 0.01 A (positive into pos pin).
    expect(before[0]).toBeCloseTo(0.01, 6);

    fix.coordinator.setComponentProperty(fix.element("ntc"), "r0", 200);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getElementPinCurrents(ntcIdx);
    // I_after = 1V / 200Ω = 0.005 A. Larger r0 → smaller current.
    expect(after[0]).toBeCloseTo(0.005, 6);
    expect(after[0]).not.toBeCloseTo(before[0], 4);
  });

  it("hotload_beta_changes_resistance_when_t_off_t0", () => {
    // Set ambient T different from T0 so beta enters R(T) = r0 * exp(beta*(1/T - 1/T0))
    // with a non-zero exponent. T=350K, T0=298.15K → 1/T-1/T0<0, so R<r0.
    const fix = buildFixture({
      build: (_r, facade) =>
        buildNtcFixedTempCircuit(facade, {
          vSource: 1,
          r0: 100,
          beta: 3950,
          t0: 298.15,
          temperature: 350,
        }),
    });
    fix.coordinator.dcOperatingPoint();
    const ntcIdx = fix.circuit.elements.findIndex(
      (el) =>
        el instanceof PoolBackedAnalogElement &&
        (el as PoolBackedAnalogElement).stateSchema.owner === "NTCThermistorElement",
    );
    const iBefore = fix.engine.getElementPinCurrents(ntcIdx)[0];

    fix.coordinator.setComponentProperty(fix.element("ntc"), "beta", 6000);
    fix.coordinator.dcOperatingPoint();
    const iAfter = fix.engine.getElementPinCurrents(ntcIdx)[0];

    // Larger beta with T>T0 makes the (1/T-1/T0) exponent more negative →
    // R drops further → loop current rises.
    expect(iAfter).not.toBeCloseTo(iBefore, 4);
    expect(iAfter).toBeGreaterThan(iBefore);
  });

  it("hotload_temperature_changes_resistance_in_fixed_mode", () => {
    // Non-self-heating: setParam("temperature") shifts _tAmbient and the
    // pinned T in R(T). T=298.15K → 350K with r0=100, beta=3950, T0=298.15
    // monotonically lowers R, raising loop current.
    const fix = buildFixture({
      build: (_r, facade) =>
        buildNtcFixedTempCircuit(facade, {
          vSource: 1,
          r0: 100,
          beta: 3950,
          t0: 298.15,
          temperature: 298.15,
        }),
    });
    fix.coordinator.dcOperatingPoint();
    const ntcIdx = fix.circuit.elements.findIndex(
      (el) =>
        el instanceof PoolBackedAnalogElement &&
        (el as PoolBackedAnalogElement).stateSchema.owner === "NTCThermistorElement",
    );
    const iBefore = fix.engine.getElementPinCurrents(ntcIdx)[0];
    // R(T0)=r0=100Ω → I=0.01 A at VS=1V.
    expect(iBefore).toBeCloseTo(0.01, 6);

    fix.coordinator.setComponentProperty(fix.element("ntc"), "temperature", 350);
    fix.coordinator.dcOperatingPoint();
    const iAfter = fix.engine.getElementPinCurrents(ntcIdx)[0];

    // Closed-form: R(350) = 100 * exp(3950 * (1/350 - 1/298.15))
    //                     = 100 * exp(3950 * -0.000497) ≈ 100 * 0.140 ≈ 14.0 Ω
    // I(350) ≈ 1 / 14.0 ≈ 0.0714 A.
    const rExpected =
      100 * Math.exp(3950 * (1 / 350 - 1 / 298.15));
    const iExpected = 1 / rExpected;
    expect(iAfter).toBeCloseTo(iExpected, 4);
    expect(iAfter).not.toBeCloseTo(iBefore, 4);
    expect(iAfter).toBeGreaterThan(iBefore);
  });

  it("hotload_t0_changes_resistance_when_t_off_t0", () => {
    // t0 is the reference temperature in R(T) = r0 * exp(beta*(1/T - 1/T0)).
    // With T fixed at 350K, raising T0 from 298.15 to 350 makes 1/T - 1/T0 = 0
    // so R = r0 exactly. Lowering T0 below T makes the exponent more negative,
    // raising R. We assert directionally.
    const fix = buildFixture({
      build: (_r, facade) =>
        buildNtcFixedTempCircuit(facade, {
          vSource: 1,
          r0: 100,
          beta: 3950,
          t0: 298.15,
          temperature: 350,
        }),
    });
    fix.coordinator.dcOperatingPoint();
    const ntcIdx = fix.circuit.elements.findIndex(
      (el) =>
        el instanceof PoolBackedAnalogElement &&
        (el as PoolBackedAnalogElement).stateSchema.owner === "NTCThermistorElement",
    );
    const iBefore = fix.engine.getElementPinCurrents(ntcIdx)[0];

    fix.coordinator.setComponentProperty(fix.element("ntc"), "t0", 350);
    fix.coordinator.dcOperatingPoint();
    const iAfter = fix.engine.getElementPinCurrents(ntcIdx)[0];

    // t0 = 350 = T → exponent zero → R = r0 = 100Ω → I = 0.01A.
    expect(iAfter).toBeCloseTo(0.01, 6);
    expect(iAfter).not.toBeCloseTo(iBefore, 4);
  });

  it("hotload_thermalResistance_changes_self_heated_temperature_evolution", () => {
    // thermalResistance scales the steady-state self-heating offset:
    //   T_ss - T_amb = P_diss * R_th. Higher R_th → higher T_ss → lower R(T)
    //   → higher loop current. Run a short transient before/after to expose
    //   the effect of the parameter on the integrated thermal state.
    const fix = buildFixture({
      build: (_r, facade) =>
        buildNtcSelfHeatingCircuit(facade, {
          vSource: 100,
          r0: 100,
          thermalResistance: 50,
          thermalCapacitance: 0.001,
        }),
      params: { tStop: 1e-3, maxTimeStep: 1e-5 },
    });
    const SLOT_TEMPERATURE = NTC_SCHEMA.indexOf.get("TEMPERATURE")!;
    const el = findNtcElement(fix);
    for (let i = 0; i < 20; i++) fix.coordinator.step();
    const tBefore = fix.pool.state0[el._stateBase + SLOT_TEMPERATURE];

    fix.coordinator.setComponentProperty(fix.element("ntc"), "thermalResistance", 200);
    for (let i = 0; i < 20; i++) fix.coordinator.step();
    const tAfter = fix.pool.state0[el._stateBase + SLOT_TEMPERATURE];

    // Larger thermal resistance → larger steady-state temperature offset.
    expect(tAfter).not.toBeCloseTo(tBefore, 2);
    expect(tAfter).toBeGreaterThan(tBefore);
  });

  it("hotload_thermalCapacitance_changes_self_heated_temperature_rate", () => {
    // thermalCapacitance scales the integration time-constant of dT/dt.
    // Larger C_th → slower temperature rise. Compare the temperature reached
    // after the same number of steps with two different C_th values.
    const fixSmall = buildFixture({
      build: (_r, facade) =>
        buildNtcSelfHeatingCircuit(facade, {
          vSource: 100,
          r0: 100,
          thermalResistance: 50,
          thermalCapacitance: 1e-4,
        }),
      params: { tStop: 1e-4, maxTimeStep: 1e-6 },
    });
    const SLOT_TEMPERATURE = NTC_SCHEMA.indexOf.get("TEMPERATURE")!;
    const elSmall = findNtcElement(fixSmall);
    for (let i = 0; i < 20; i++) fixSmall.coordinator.step();
    const tSmall = fixSmall.pool.state0[elSmall._stateBase + SLOT_TEMPERATURE];

    const fixLarge = buildFixture({
      build: (_r, facade) =>
        buildNtcSelfHeatingCircuit(facade, {
          vSource: 100,
          r0: 100,
          thermalResistance: 50,
          thermalCapacitance: 1e-1,
        }),
      params: { tStop: 1e-4, maxTimeStep: 1e-6 },
    });
    const elLarge = findNtcElement(fixLarge);
    for (let i = 0; i < 20; i++) fixLarge.coordinator.step();
    const tLarge = fixLarge.pool.state0[elLarge._stateBase + SLOT_TEMPERATURE];

    // Smaller C_th → faster temperature rise → higher T at the same sim time.
    expect(tSmall).not.toBeCloseTo(tLarge, 2);
    expect(tSmall).toBeGreaterThan(tLarge);
  });
});

// ---------------------------------------------------------------------------
// Cat 2-numerical / 3 / 5 — Harness sessions (T3)
// One describe()/session per .dts. Each opens once in beforeAll, runs the
// transient inside the FIRST it() (so a hard throw shows as a failed test
// rather than a silent suite-skip), reuses across categories that share that
// circuit, disposes in afterAll. Gated on canonical dllAvailable() via
// describeIfDll.
// ---------------------------------------------------------------------------

describeIfDll("NTCThermistor fixed-temp paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({
      dtsPath: DTS_FIXED_TEMP,
      analysis: "tran",
      tStop: 1e-4,
      maxStep: 1e-6,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_fixed_temp", async () => {
    await session.runTransient(0, 1e-4, 1e-6);
    session.compareAllSteps();
  }, 120_000);

  it("dcop_paired_fixed_temp", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
    for (const [, comp] of Object.entries(stepEnd.components)) {
      for (const [, cv] of Object.entries(comp.slots ?? {})) {
        expect(cv.withinTol).toBe(true);
      }
    }
  });

  it("full_iteration_paired_fixed_temp", () => {
    session.compareAllAttempts();
  });
});

describeIfDll("NTCThermistor self-heating paired vs ngspice (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({
      dtsPath: DTS_SELF_HEATING,
      analysis: "tran",
      tStop: 1e-4,
      maxStep: 1e-6,
    });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_self_heating", async () => {
    await session.runTransient(0, 1e-4, 1e-6);
    session.compareAllSteps();
  }, 180_000);

  it("dcop_paired_self_heating", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) {
      expect(cv.withinTol).toBe(true);
    }
    for (const [, comp] of Object.entries(stepEnd.components)) {
      for (const [, cv] of Object.entries(comp.slots ?? {})) {
        expect(cv.withinTol).toBe(true);
      }
    }
  });

  it("full_iteration_paired_self_heating", () => {
    session.compareAllAttempts();
  });
});
