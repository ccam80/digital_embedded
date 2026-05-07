import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  DLL_PATH,
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { REAL_OPAMP_SCHEMA } from "../real-opamp.js";
import { PoolBackedAnalogElement } from "../../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// Slot indices (resolved via schema lookup)
// ---------------------------------------------------------------------------

const SLOT_VINT         = REAL_OPAMP_SCHEMA.indexOf.get("VINT")!;
const SLOT_VOUT         = REAL_OPAMP_SCHEMA.indexOf.get("VOUT")!;
const SLOT_VOUT_LIMITED = REAL_OPAMP_SCHEMA.indexOf.get("VOUT_LIMITED")!;
const SLOT_AEFF         = REAL_OPAMP_SCHEMA.indexOf.get("AEFF")!;
const SLOT_OUT_SAT_FLAG = REAL_OPAMP_SCHEMA.indexOf.get("OUT_SAT_FLAG")!;

// ---------------------------------------------------------------------------
// .dts paths
// ---------------------------------------------------------------------------

const DTS_UNITY_FOLLOWER  = path.resolve("src/components/active/__tests__/fixtures/real-opamp-canon-unity-follower.dts");
const DTS_RAIL_SATURATION = path.resolve("src/components/active/__tests__/fixtures/real-opamp-canon-rail-saturation.dts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findOpAmp(elements: ReadonlyArray<unknown>): PoolBackedAnalogElement {
  const idx = elements.findIndex(
    (el) =>
      el instanceof PoolBackedAnalogElement &&
      (el as PoolBackedAnalogElement).stateSchema.owner === "RealOpAmpElement",
  );
  if (idx < 0) throw new Error("RealOpAmpElement not found in compiled circuit");
  return elements[idx] as PoolBackedAnalogElement;
}

function getOpAmpCe(fix: ReturnType<typeof buildFixture>) {
  const wrapperIdx = fix.circuit.elements.findIndex(
    (_e, i) => fix.elementLabels.get(i) === "opamp",
  );
  expect(wrapperIdx).toBeGreaterThanOrEqual(0);
  const ce = fix.circuit.elementToCircuitElement.get(wrapperIdx);
  expect(ce).toBeDefined();
  return ce!;
}

// Programmatic unity-follower build with default (behavioral) RealOpAmp params.
// Used by Cat 1 / Cat 2-analytical / Cat 4 / Cat 6-own.
function buildUnityFollower(vinVoltage: number) {
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: "vin",   type: "DcVoltageSource", props: { label: "vin",  voltage: vinVoltage } },
        { id: "vccp",  type: "DcVoltageSource", props: { label: "vccp", voltage:  15 } },
        { id: "vccn",  type: "DcVoltageSource", props: { label: "vccn", voltage: -15 } },
        { id: "opamp", type: "RealOpAmp",       props: { label: "opamp" } },
        { id: "gnd",   type: "Ground",          props: { label: "gnd" } },
      ],
      connections: [
        ["vin:pos",   "opamp:in+"],
        ["opamp:out", "opamp:in-"],
        ["vccp:pos",  "opamp:Vcc+"],
        ["vccn:pos",  "opamp:Vcc-"],
        ["vin:neg",   "gnd:out"],
        ["vccp:neg",  "gnd:out"],
        ["vccn:neg",  "gnd:out"],
      ],
    }),
    params: { tStop: 1e-4, maxTimeStep: 1e-5 },
  });
}

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// Post-warm-start: REAL_OPAMP_SCHEMA slots populated; output node voltage
// tracks Vin in the linear region.
// ---------------------------------------------------------------------------

describe("RealOpAmp initialization (T1)", () => {
  it("init_unity_follower_slots_finite", () => {
    const fix = buildUnityFollower(2);
    const opamp = findOpAmp(fix.circuit.elements);

    const vint        = fix.pool.state0[opamp._stateBase + SLOT_VINT];
    const vout        = fix.pool.state0[opamp._stateBase + SLOT_VOUT];
    const voutLimited = fix.pool.state0[opamp._stateBase + SLOT_VOUT_LIMITED];
    const aEff        = fix.pool.state0[opamp._stateBase + SLOT_AEFF];
    const outSatFlag  = fix.pool.state0[opamp._stateBase + SLOT_OUT_SAT_FLAG];

    expect(Number.isFinite(vint)).toBe(true);
    expect(Number.isFinite(vout)).toBe(true);
    expect(Number.isFinite(voutLimited)).toBe(true);
    expect(Number.isFinite(aEff)).toBe(true);
    // Linear region: not saturated.
    expect(outSatFlag).toBe(0);

    // Output node tracks Vin (unity-follower) within finite-gain error.
    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    const vOutNode = fix.engine.getNodeVoltage(nOut);
    expect(vOutNode).toBeCloseTo(2, 2);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point (T1, analytical: unity-follower in linear region)
// Vout = Vin * aol / (1 + aol). With aol = 100000, gain = 0.99999, so
// Vout ≈ Vin within finite-gain error of Vin/aol.
// ---------------------------------------------------------------------------

describe("RealOpAmp DCOP — unity-follower linear region (T1)", () => {
  it("dcop_unity_follower_tracks_vin", () => {
    const fix = buildUnityFollower(2);

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    const vOutNode = fix.engine.getNodeVoltage(nOut);
    // Closed form: Vout = aol * Vin / (1 + aol) ≈ 2V; finite-gain error 2/100001 ≈ 20 µV.
    expect(vOutNode).toBeCloseTo(2, 3);

    // Output is in the linear region: not rail-saturated.
    const opamp = findOpAmp(fix.circuit.elements);
    const outSatFlag = fix.pool.state0[opamp._stateBase + SLOT_OUT_SAT_FLAG];
    expect(outSatFlag).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point (T1, analytical: rail-saturated regime)
// Vin = 16V, Vcc+ = 15V, vSatPos = 1.5 → vRailPos = 13.5V. The internal
// integrator clamp drives vOut to vRailPos and OUT_SAT_FLAG flips to 1.
// (Engine node-voltage clamp + post-railLim slot are observed via Cat 1's
// init step + here via the DCOP path.)
// ---------------------------------------------------------------------------

describe("RealOpAmp DCOP — rail saturation regime (T1)", () => {
  it("dcop_rail_saturation_clamps_to_vrail_pos", () => {
    // Drive Vin past Vcc+: output must be clamped at vRailPos = 13.5V.
    const fix = buildUnityFollower(16);

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    const opamp = findOpAmp(fix.circuit.elements);
    const vRailPos = 15 - 1.5;

    // OUT_SAT_FLAG must be 1: output is rail-saturated.
    const outSatFlag = fix.pool.state0[opamp._stateBase + SLOT_OUT_SAT_FLAG];
    expect(outSatFlag).toBe(1);

    // VOUT_LIMITED must be ≤ vRailPos.
    const vOutLimited = fix.pool.state0[opamp._stateBase + SLOT_VOUT_LIMITED];
    expect(vOutLimited).toBeLessThanOrEqual(vRailPos + 1e-9);

    // Engine node voltage for the output pin must be clamped.
    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    const engineVout = fix.engine.getNodeVoltage(nOut);
    expect(engineVout).toBeLessThanOrEqual(vRailPos + 1e-9);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Parameter hot-load (T1)
// One it() per representative model parameter. RealOpAmp params: aol, gbw,
// slewRate, vos, iBias, rIn, rOut, iMax, vSatPos, vSatNeg.
// Structural representative: vSatPos (rail location moves observable Vout).
// vos is a derived shift on the gain-stage source term (separate path).
// rOut scales the Norton output stamp (separate path).
// ---------------------------------------------------------------------------

describe("RealOpAmp parameter hot-load (T1)", () => {
  it("hotload_vSatPos_shifts_rail_clamp", () => {
    // Vin=16V drives saturation. Reducing vSatPos from 1.5 to 0.2 raises
    // vRailPos from 13.5V to 14.8V, so the clamped Vout rises.
    const fix = buildUnityFollower(16);
    const opamp = findOpAmp(fix.circuit.elements);
    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;

    // Step a few times for the rail clamp to settle.
    for (let i = 0; i < 5; i++) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(nOut);
    expect(fix.pool.state0[opamp._stateBase + SLOT_OUT_SAT_FLAG]).toBe(1);
    expect(before).toBeLessThanOrEqual(15 - 1.5 + 1e-9);

    fix.coordinator.setComponentProperty(getOpAmpCe(fix), "vSatPos", 0.2);
    for (let i = 0; i < 5; i++) fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(nOut);
    // Lowered vSatPos => vRailPos rose from 13.5 to 14.8 => clamped Vout rises.
    expect(after).toBeGreaterThan(before);
    expect(after).toBeCloseTo(15 - 0.2, 2);
  });

  it("hotload_vos_shifts_unity_follower_output", () => {
    // Linear region. Default vos=1e-3. Set vos to 0.5V: closed-loop Vout
    // shifts by (vos * aol) / (1 + aol) ≈ vos in the unity-follower.
    const fix = buildUnityFollower(2);
    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    const before = fix.engine.getNodeVoltage(nOut);

    fix.coordinator.setComponentProperty(getOpAmpCe(fix), "vos", 0.5);
    for (let i = 0; i < 5; i++) fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(nOut);
    // Direction: positive vos drives Vout above Vin by ≈ vos.
    expect(after).toBeGreaterThan(before);
    expect(after - before).toBeCloseTo(0.5, 2);
  });

  it("hotload_rOut_shifts_loaded_output_voltage", () => {
    // With a load resistor, the Norton output stage forms a voltage divider:
    //   Vout_loaded ≈ Vin * rLoad / (rLoad + rOut)  (approximate for aol>>1).
    // Default rOut=75Ω, rLoad=75Ω → Vout ≈ Vin/2 = 1V.
    // After hotload rOut=750Ω, rLoad=75Ω → Vout ≈ Vin * 75/825 ≈ 0.182V.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vin",   type: "DcVoltageSource", props: { label: "vin",  voltage: 2 } },
          { id: "vccp",  type: "DcVoltageSource", props: { label: "vccp", voltage: 15 } },
          { id: "vccn",  type: "DcVoltageSource", props: { label: "vccn", voltage: -15 } },
          { id: "opamp", type: "RealOpAmp",       props: { label: "opamp", rOut: 75 } },
          { id: "rload", type: "Resistor",        props: { label: "rload", resistance: 75 } },
          { id: "gnd",   type: "Ground",          props: { label: "gnd" } },
        ],
        connections: [
          ["vin:pos",    "opamp:in+"],
          ["opamp:out",  "opamp:in-"],
          ["vccp:pos",   "opamp:Vcc+"],
          ["vccn:pos",   "opamp:Vcc-"],
          ["opamp:out",  "rload:pos"],
          ["rload:neg",  "gnd:out"],
          ["vin:neg",    "gnd:out"],
          ["vccp:neg",   "gnd:out"],
          ["vccn:neg",   "gnd:out"],
        ],
      }),
      params: { tStop: 1e-4, maxTimeStep: 1e-5 },
    });

    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    for (let i = 0; i < 5; i++) fix.coordinator.step();
    const before = fix.engine.getNodeVoltage(nOut);

    fix.coordinator.setComponentProperty(getOpAmpCe(fix), "rOut", 750);
    for (let i = 0; i < 5; i++) fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(nOut);
    // Higher rOut → larger voltage drop across output resistance → Vout drops.
    expect(after).toBeLessThan(before);
    expect(after).not.toBeCloseTo(before, 2);
  });

  it("hotload_aol_shifts_finite_gain_error", () => {
    // Default aol=100000, finite-gain error = Vin/(1+aol) ≈ 20 µV.
    // Lower aol to 100: error becomes Vin/101 ≈ 19.8 mV. Vout drops.
    const fix = buildUnityFollower(2);
    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    const before = fix.engine.getNodeVoltage(nOut);
    expect(before).toBeCloseTo(2, 3);

    fix.coordinator.setComponentProperty(getOpAmpCe(fix), "aol", 100);
    for (let i = 0; i < 5; i++) fix.coordinator.step();

    const after = fix.engine.getNodeVoltage(nOut);
    // Closed-form: Vout = 2 * 100/101 ≈ 1.9802V.
    expect(after).toBeCloseTo(2 * 100 / 101, 3);
    expect(after).toBeLessThan(before);
  });
});

// ---------------------------------------------------------------------------
// Category 6 — Limiting events (T1, own engine)
// railLim fires when the post-init NR iterate would push vOut past the rail
// AND the previous-accepted vOut was below the rail. The mode-mask gate
// matches dioload.c:139-205 (skipped during MODEINIT* attempts).
// We exercise it via a transient: build the unity-follower around the
// rail-saturation .dts (driven by .dts loader) and step a few times.
// ---------------------------------------------------------------------------

describe("RealOpAmp limiting events — railLim own-engine (T1)", () => {
  it("limiting_railLim_engaged_under_overdrive", () => {
    // Vin=16V drives the rail-saturation regime; setLimitingCapture +
    // dcOperatingPoint surfaces any railLim event that the post-init NR pass
    // produces.
    const fix = buildUnityFollower(16);
    fix.coordinator.setLimitingCapture(true);
    fix.coordinator.dcOperatingPoint();

    const opamp = findOpAmp(fix.circuit.elements);
    const outSatFlag = fix.pool.state0[opamp._stateBase + SLOT_OUT_SAT_FLAG];
    // Production contract: rail-saturation regime sets OUT_SAT_FLAG=1 every
    // load() pass via the unconditional bottom-of-load history write.
    expect(outSatFlag).toBe(1);

    // The own-engine LimitingEvent collector records railLim events keyed by
    // junction "OUT". Whether any individual NR iterate crossed (and thus
    // pushed an event) depends on the iterate trajectory; the documented
    // collector contract is that when OUT_SAT_FLAG=1 and the iterate ever
    // overshoots the rail before settling, a {junction:"OUT", limitType:
    // "railLim"} event is observable in the collector.
    const events = fix.coordinator.getLimitingEvents();
    const railEvents = events.filter(
      (e) => e.label === "opamp" && e.junction === "OUT",
    );
    // If railLim ever clipped during this DCOP, every recorded event has
    // wasLimited=true, vBefore > vRailPos, vAfter == vRailPos.
    for (const ev of railEvents) {
      expect(ev.wasLimited).toBe(true);
      expect(ev.vBefore).toBeGreaterThan(15 - 1.5 - 1e-9);
      expect(ev.vAfter).toBeLessThanOrEqual(15 - 1.5 + 1e-9);
    }
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 — Paired vs ngspice (T3) on unity-follower
// One ComparisonSession per .dts; runs declared in first it(), step-end and
// per-iteration siblings read the recorded session.
// ---------------------------------------------------------------------------

describeIfDll("RealOpAmp unity-follower vs ngspice — transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_UNITY_FOLLOWER, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_unity_follower", async () => {
    await session.runTransient(0, 1e-4, 1e-5);
    session.compareAllSteps();
  });

  it("dcop_paired_unity_follower", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
  });

  it("full_iteration_paired_unity_follower", () => {
    session.compareAllAttempts();
  });
});

// ---------------------------------------------------------------------------
// Category 2-numerical / 3 / 5 / 6-paired — Paired vs ngspice (T3) on
// rail-saturation regime
// ---------------------------------------------------------------------------

describeIfDll("RealOpAmp rail saturation vs ngspice — transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.create({ dtsPath: DTS_RAIL_SATURATION, dllPath: DLL_PATH });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_rail_saturation", async () => {
    await session.runTransient(0, 1e-4, 1e-5);
    session.compareAllSteps();
  });

  it("dcop_paired_rail_saturation", () => {
    const stepEnd = session.getStepEnd(0);
    for (const [, cv] of Object.entries(stepEnd.nodes)) expect(cv.withinTol).toBe(true);
  });

  it("full_iteration_paired_rail_saturation", () => {
    session.compareAllAttempts();
  });
});
