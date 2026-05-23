import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";

import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import {
  describeIfDll,
} from "../../../solver/analog/__tests__/ngspice-parity/parity-helpers.js";
import { REAL_OPAMP_SCHEMA } from "../real-opamp.js";
import { PoolBackedAnalogElement } from "../../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// Slot indices — resolved via schema, never raw SLOT_* imports (B-3)
// ---------------------------------------------------------------------------

const SLOT_VINT         = REAL_OPAMP_SCHEMA.indexOf.get("VINT")!;
const SLOT_VOUT         = REAL_OPAMP_SCHEMA.indexOf.get("VOUT")!;
const SLOT_VOUT_LIMITED = REAL_OPAMP_SCHEMA.indexOf.get("VOUT_LIMITED")!;
const SLOT_OUT_SAT_FLAG = REAL_OPAMP_SCHEMA.indexOf.get("OUT_SAT_FLAG")!;

// ---------------------------------------------------------------------------
// .dts paths
// ---------------------------------------------------------------------------

const DTS_UNITY_FOLLOWER  = path.resolve("src/components/active/__tests__/fixtures/real-opamp-canon-unity-follower.dts");
const DTS_RAIL_SATURATION = path.resolve("src/components/active/__tests__/fixtures/real-opamp-canon-rail-saturation.dts");

// ---------------------------------------------------------------------------
// Default behavioral parameters used by all programmatic builds.
// ---------------------------------------------------------------------------

const DEFAULT_OPAMP_PROPS = {
  aol:      100000,
  gbw:      1e6,
  slewRate: 0.5e6,
  vos:      0,
  iBias:    0,
  rIn:      1e12,
  rOut:     75,
  iMax:     25e-3,
  vSatPos:  1.5,
  vSatNeg:  1.5,
};

// ---------------------------------------------------------------------------
// Helper: locate the RealOpAmp pool-backed element by stateSchema.owner.
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

// ---------------------------------------------------------------------------
// Programmatic builders for T1 categories (init / DCOP-analytical / hot-load).
// ---------------------------------------------------------------------------

interface UnityFollowerOpts {
  vinVoltage: number;
  vccP?: number;
  vccN?: number;
  opampProps?: Record<string, number | string>;
}

function buildUnityFollower(opts: UnityFollowerOpts) {
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: "vin",   type: "DcVoltageSource", props: { label: "vin",   voltage: opts.vinVoltage } },
        { id: "vccp",  type: "DcVoltageSource", props: { label: "vccp",  voltage: opts.vccP ?? 15  } },
        { id: "vccn",  type: "DcVoltageSource", props: { label: "vccn",  voltage: opts.vccN ?? -15 } },
        { id: "opamp", type: "RealOpAmp",       props: { label: "opamp", ...(opts.opampProps ?? DEFAULT_OPAMP_PROPS) } },
        { id: "gnd",   type: "Ground" },
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

interface InvertingAmpOpts {
  vinVoltage: number;
  rinOhms: number;
  rfOhms: number;
  vccP?: number;
  vccN?: number;
  opampProps?: Record<string, number | string>;
}

function buildInvertingAmp(opts: InvertingAmpOpts) {
  return buildFixture({
    build: (_r, facade) => facade.build({
      components: [
        { id: "vin",   type: "DcVoltageSource", props: { label: "vin",   voltage: opts.vinVoltage } },
        { id: "rin",   type: "Resistor",        props: { label: "rin",   resistance: opts.rinOhms } },
        { id: "rf",    type: "Resistor",        props: { label: "rf",    resistance: opts.rfOhms  } },
        { id: "vinp",  type: "DcVoltageSource", props: { label: "vinp",  voltage: 0 } },
        { id: "vccp",  type: "DcVoltageSource", props: { label: "vccp",  voltage: opts.vccP ?? 15  } },
        { id: "vccn",  type: "DcVoltageSource", props: { label: "vccn",  voltage: opts.vccN ?? -15 } },
        { id: "opamp", type: "RealOpAmp",       props: { label: "opamp", ...(opts.opampProps ?? DEFAULT_OPAMP_PROPS) } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vin:pos",   "rin:pos"],
        ["rin:neg",   "opamp:in-"],
        ["rf:pos",    "opamp:in-"],
        ["rf:neg",    "opamp:out"],
        ["vinp:pos",  "opamp:in+"],
        ["vccp:pos",  "opamp:Vcc+"],
        ["vccn:pos",  "opamp:Vcc-"],
        ["vin:neg",   "gnd:out"],
        ["vinp:neg",  "gnd:out"],
        ["vccp:neg",  "gnd:out"],
        ["vccn:neg",  "gnd:out"],
      ],
    }),
    params: { tStop: 1e-4, maxTimeStep: 1e-5 },
  });
}

function getOpAmpCe(fix: ReturnType<typeof buildUnityFollower>) {
  const idx = fix.circuit.elements.findIndex(
    (_e, i) => fix.elementLabels.get(i) === "opamp",
  );
  expect(idx).toBeGreaterThanOrEqual(0);
  const ce = fix.circuit.elementToCircuitElement.get(idx);
  expect(ce).toBeDefined();
  return ce!;
}

// ===========================================================================
// Category 1 — Initialization (T1)
// ===========================================================================

describe("RealOpAmp initialization — unity follower (T1)", () => {
  it("init_unity_follower_state_unsaturated", () => {
    // Vin=2V, ±15V supplies. After warm-start the post-converged state is
    // unsaturated unity-follower: VOUT ≈ Vin, VOUT_LIMITED ≈ Vin, OUT_SAT_FLAG=0.
    const fix = buildUnityFollower({ vinVoltage: 2 });

    const opamp = findOpAmp(fix.circuit.elements);
    const vInt         = fix.pool.state0[opamp._stateBase + SLOT_VINT];
    const vOut         = fix.pool.state0[opamp._stateBase + SLOT_VOUT];
    const vOutLimited  = fix.pool.state0[opamp._stateBase + SLOT_VOUT_LIMITED];
    const outSatFlag   = fix.pool.state0[opamp._stateBase + SLOT_OUT_SAT_FLAG];

    expect(Number.isFinite(vInt)).toBe(true);
    expect(Number.isFinite(vOut)).toBe(true);
    expect(Number.isFinite(vOutLimited)).toBe(true);
    expect(outSatFlag).toBe(0);
    // Unity-follower converged output: ≈ Vin (gain error 2/aol = 2e-5).
    expect(vOut).toBeCloseTo(2, 3);
    expect(vOutLimited).toBeCloseTo(2, 3);

    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    expect(fix.engine.getNodeVoltage(nOut)).toBeCloseTo(2, 3);
  });
});

describe("RealOpAmp initialization — rail-saturated unity follower (T1)", () => {
  it("init_rail_sat_state_out_sat_flag_set", () => {
    // Vin=16V > Vcc+ - vSatPos = 13.5V. Saturation engages.
    const fix = buildUnityFollower({ vinVoltage: 16 });

    const opamp = findOpAmp(fix.circuit.elements);
    const vOutLimited  = fix.pool.state0[opamp._stateBase + SLOT_VOUT_LIMITED];
    const outSatFlag   = fix.pool.state0[opamp._stateBase + SLOT_OUT_SAT_FLAG];

    expect(Number.isFinite(vOutLimited)).toBe(true);
    expect(outSatFlag).toBe(1); // saturated
    // VOUT_LIMITED clamped to vRailPos = Vcc+ - vSatPos = 13.5V.
    expect(vOutLimited).toBeLessThanOrEqual(13.5 + 1e-9);

    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    expect(fix.engine.getNodeVoltage(nOut)).toBeLessThanOrEqual(13.5 + 1e-9);
  });
});

// ===========================================================================
// Category 2 — DCOP analytical (T1)
// ===========================================================================

describe("RealOpAmp DCOP analytical — inverting amplifier (T1)", () => {
  it("dcop_inverting_amplifier_gain_minus_10", () => {
    // Inverting amp: gain = -Rf/Rin = -10kΩ/1kΩ = -10. Vin=0.1V → Vout ≈ -1V.
    // With aol=100000 the closed-loop error is 11/aol ≈ 1.1e-4 of -1V.
    const fix = buildInvertingAmp({
      vinVoltage: 0.1,
      rinOhms: 1000,
      rfOhms:  10000,
    });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    const vOut = fix.engine.getNodeVoltage(nOut);
    // closed-loop gain = -Rf/Rin = -10; expected -1V to better than 0.5%.
    expect(vOut).toBeCloseTo(-1, 2);
  });

  it("dcop_unity_follower_tracks_vin", () => {
    // Vin=3V well within rails. Vout ≈ Vin within unity-gain error 3/aol = 3e-5.
    const fix = buildUnityFollower({ vinVoltage: 3 });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    expect(fix.engine.getNodeVoltage(nOut)).toBeCloseTo(3, 3);
  });
});

// ===========================================================================
// Categories 2-numerical / 3 / 5 — paired vs ngspice (T3)
// One describe per .dts; first it() owns the run. Both circuits share the
// same DLL availability gate via describeIfDll.
// ===========================================================================

describeIfDll("RealOpAmp unity follower vs ngspice — transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_UNITY_FOLLOWER, analysis: "tran", tStop: 1e-5, maxStep: 1e-7 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_unity_follower", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
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

describeIfDll("RealOpAmp rail-saturated vs ngspice — transient + stamp parity (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    session = await ComparisonSession.createSelfCompare({ dtsPath: DTS_RAIL_SATURATION, analysis: "tran", tStop: 1e-5, maxStep: 1e-7 });
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("transient_step_end_paired_rail_saturation", async () => {
    await session.runTransient(0, 1e-5, 1e-7);
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

// ===========================================================================
// Category 4 — Parameter hot-load (T1)
// One it() per primary / derived-recompute parameter the component handles.
// Closed-form post-change observables; no Number.isFinite weakening (B-8).
// ===========================================================================

describe("RealOpAmp parameter hot-load (T1)", () => {
  it("hotload_aol_changes_inverting_gain_error", () => {
    // Inverting amp gain = -Rf/Rin = -10. Closed-loop output:
    //   Vout = -Vin * (Rf/Rin) * aol / (1 + aol*(1 + Rf/Rin))
    // At aol=100  the loop gain is finite and the error is significant;
    // at aol=1e6  the error collapses to ~1.1e-5 of the ideal -1V.
    const fix = buildInvertingAmp({
      vinVoltage: 0.1,
      rinOhms:    1000,
      rfOhms:     10000,
      opampProps: { ...DEFAULT_OPAMP_PROPS, aol: 100 },
    });

    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nOut);
    // Closed-form for finite aol=100: Vout = -Vin*Rf/Rin * aol/(1 + aol*(1+Rf/Rin))
    //   = -1 * 100/(1 + 100*11) = -100/1101 ≈ -0.09083V
    const expectedBefore = -0.1 * 10 * 100 / (1 + 100 * 11);
    expect(before).toBeCloseTo(expectedBefore, 4);

    fix.coordinator.setComponentProperty(getOpAmpCe(fix), "aol", 1e6);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nOut);
    // High aol drives output to the ideal -Rf/Rin*Vin = -1V.
    expect(after).toBeCloseTo(-1, 3);
    expect(Math.abs(after - (-1))).toBeLessThan(Math.abs(before - (-1)));
  });

  it("hotload_vos_shifts_inverting_output", () => {
    // Inverting amp: closed-loop sees Vos as an additive offset at the input,
    // amplified by the noise gain 1 + Rf/Rin = 11. Δ(Vout) ≈ Vos * 11.
    // Set Vos from 0 → 1mV: ΔVout ≈ +0.011V.
    const fix = buildInvertingAmp({
      vinVoltage: 0.1,
      rinOhms:    1000,
      rfOhms:     10000,
      opampProps: { ...DEFAULT_OPAMP_PROPS, vos: 0 },
    });

    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nOut);
    expect(before).toBeCloseTo(-1, 2);

    fix.coordinator.setComponentProperty(getOpAmpCe(fix), "vos", 1e-3);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nOut);
    // Δ ≈ +Vos * (1 + Rf/Rin) = 1e-3 * 11 = 0.011V.
    expect(after - before).toBeCloseTo(0.011, 3);
  });

  it("hotload_rIn_changes_input_loading", () => {
    // Inverting amp: lowering rIn from 1e12Ω down to 1kΩ creates a shunt at
    // in- comparable to Rin, raising the noise-gain divider's denominator.
    // Closed-form for the inverting summing-junction with finite rIn:
    //   Vout = -Vin * Rf / (Rin || rIn-effective ... )  — finite-aol +
    //   finite-rIn analytics get tangled, so the canonical observable is:
    //   raising rIn from low to high moves Vout closer to the ideal -1V.
    const fix = buildInvertingAmp({
      vinVoltage: 0.1,
      rinOhms:    1000,
      rfOhms:     10000,
      opampProps: { ...DEFAULT_OPAMP_PROPS, rIn: 1000 },
    });

    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    fix.coordinator.dcOperatingPoint();
    const beforeLowRin = fix.engine.getNodeVoltage(nOut);

    fix.coordinator.setComponentProperty(getOpAmpCe(fix), "rIn", 1e12);
    fix.coordinator.dcOperatingPoint();
    const afterHighRin = fix.engine.getNodeVoltage(nOut);

    // Higher rIn → less input loading → output closer to ideal -1V.
    expect(Math.abs(afterHighRin - (-1))).toBeLessThan(Math.abs(beforeLowRin - (-1)));
    expect(afterHighRin).toBeCloseTo(-1, 3);
  });

  it("hotload_rOut_no_dc_effect_on_unity_follower", () => {
    // Unity follower with zero DC load draws no current through rOut, so
    // changing rOut has no DC effect on the output node voltage. Vout stays
    // at Vin within unity-gain error.
    const fix = buildUnityFollower({ vinVoltage: 4 });

    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nOut);
    expect(before).toBeCloseTo(4, 3);

    fix.coordinator.setComponentProperty(getOpAmpCe(fix), "rOut", 1000);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nOut);
    expect(after).toBeCloseTo(4, 3);
    expect(Math.abs(after - before)).toBeLessThan(1e-3);
  });

  it("hotload_vSatPos_lowers_clamp_engages_saturation", () => {
    // Unity follower with Vin=10V, ±15V supplies, vSatPos=1.5 → vRailPos=13.5V.
    // Output unsaturated at 10V. Lower vSatPos to 6V → vRailPos=9V; output
    // clamps to 9V and OUT_SAT_FLAG flips to 1.
    const fix = buildUnityFollower({ vinVoltage: 10 });

    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    const opamp = findOpAmp(fix.circuit.elements);

    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nOut);
    expect(before).toBeCloseTo(10, 3);
    expect(fix.pool.state0[opamp._stateBase + SLOT_OUT_SAT_FLAG]).toBe(0);

    fix.coordinator.setComponentProperty(getOpAmpCe(fix), "vSatPos", 6);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nOut);
    // vRailPos = Vcc+ - vSatPos = 15 - 6 = 9V; output clamps at 9V.
    expect(after).toBeCloseTo(9, 1);
    expect(after).toBeLessThan(before);
    expect(fix.pool.state0[opamp._stateBase + SLOT_OUT_SAT_FLAG]).toBe(1);
  });

  it("hotload_vSatNeg_raises_negative_clamp", () => {
    // Unity follower with Vin=-10V. Default vSatNeg=1.5 → vRailNeg=-13.5V;
    // output sits at -10V (unsaturated). Raise vSatNeg to 6V → vRailNeg=-9V;
    // output clamps at -9V.
    const fix = buildUnityFollower({ vinVoltage: -10 });

    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    const opamp = findOpAmp(fix.circuit.elements);

    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nOut);
    expect(before).toBeCloseTo(-10, 3);
    expect(fix.pool.state0[opamp._stateBase + SLOT_OUT_SAT_FLAG]).toBe(0);

    fix.coordinator.setComponentProperty(getOpAmpCe(fix), "vSatNeg", 6);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nOut);
    // vRailNeg = Vcc- + vSatNeg = -15 + 6 = -9V; output clamps at -9V.
    expect(after).toBeCloseTo(-9, 1);
    expect(after).toBeGreaterThan(before);
    expect(fix.pool.state0[opamp._stateBase + SLOT_OUT_SAT_FLAG]).toBe(1);
  });

  it("hotload_iBias_shifts_inverting_output", () => {
    // Inverting amp: input bias current Ibias flows into in-, develops
    // an additional voltage Ibias*Rf at the summing junction → ΔVout ≈ Ibias*Rf.
    // Set Ibias from 0 → 1µA with Rf=10kΩ: |ΔVout| ≈ |iBias| * Rf = 0.01V.
    const fix = buildInvertingAmp({
      vinVoltage: 0.1,
      rinOhms:    1000,
      rfOhms:     10000,
      opampProps: { ...DEFAULT_OPAMP_PROPS, iBias: 0 },
    });

    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nOut);

    fix.coordinator.setComponentProperty(getOpAmpCe(fix), "iBias", 1e-6);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nOut);

    expect(after).not.toBeCloseTo(before, 4);
    // |ΔVout| ≈ |iBias| * Rf = 1e-6 * 10000 = 0.01V.
    expect(Math.abs(after - before)).toBeCloseTo(0.01, 3);
  });

  it("hotload_iMax_does_not_change_unity_follower_dcop", () => {
    // Unity follower with no load draws ~zero output current, so iMax
    // does not engage current limiting; DC output stays at Vin.
    const fix = buildUnityFollower({ vinVoltage: 4 });

    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nOut);

    fix.coordinator.setComponentProperty(getOpAmpCe(fix), "iMax", 1e-3);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nOut);

    expect(after).toBeCloseTo(before, 3);
    expect(after).toBeCloseTo(4, 3);
  });

  it("hotload_gbw_no_dc_effect", () => {
    // GBW affects only transient/AC response. At DCOP it is inert by contract;
    // changing GBW must not change DC Vout.
    const fix = buildUnityFollower({ vinVoltage: 4 });

    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nOut);

    fix.coordinator.setComponentProperty(getOpAmpCe(fix), "gbw", 10e6);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nOut);

    expect(after).toBeCloseTo(before, 6);
    expect(after).toBeCloseTo(4, 3);
  });

  it("hotload_slewRate_no_dc_effect", () => {
    // Slew-rate clamping is transient-only. At DCOP the parameter is inert;
    // output stays at Vin.
    const fix = buildUnityFollower({ vinVoltage: 4 });

    const nOut = fix.circuit.labelToNodeId.get("opamp:out")!;
    fix.coordinator.dcOperatingPoint();
    const before = fix.engine.getNodeVoltage(nOut);

    fix.coordinator.setComponentProperty(getOpAmpCe(fix), "slewRate", 50e6);
    fix.coordinator.dcOperatingPoint();
    const after = fix.engine.getNodeVoltage(nOut);

    expect(after).toBeCloseTo(before, 6);
    expect(after).toBeCloseTo(4, 3);
  });
});

// ===========================================================================
// Category 10 — Named model presets (T1)
// Originating CANONISE row: `RealOpAmp > load_741_model`. Authored fresh
// against Cat 10's sanctioned method (build twice — default + preset, DCOP
// both, compare closed-form Δ); the original used out-of-canon patterns
// (default-value snapshots, factory smoke, B-8 weakened DCOP).
//
// REAL_OPAMP_MODELS exposes 4 presets: "741", "LM358", "TL072", "OPA2134".
// The preset-applying path (createRealOpAmpElement) overrides only the
// primary params {aol, gbw, slewRate, vos, iBias}; secondary params (rIn,
// rOut, iMax, vSatPos, vSatNeg) are NOT taken from the preset record and
// stay at the props' values. Of the primary params, gbw / slewRate are
// transient-only (AC/dynamic), and aol / vos / iBias have DC observables.
//
// Closed-form DC observable for unity follower:
//   Vout = (Vin + vos) * aol / (1 + aol)        ≈ Vin + vos for aol ≫ 1
// With baseline DEFAULT_OPAMP_PROPS.vos = 0 and presets' vos in {500e-6,
// 2e-3, 3e-3}, the dominant Δ is exactly the preset vos. The aol increase
// (×2 for 741/TL072, ×10 for OPA2134) further reduces gain error and is
// negligible at the 4-digit precision used here. iBias contributes only
// via input-shunt-resistance loading; with rIn=1e12 in the default props
// and finite iBias up to 80e-9, the additional voltage drop is ≪ 1µV
// (iBias × rIn loading is bounded by the source impedance of the vin
// supply, which is the ideal DC source — i.e. ~0Ω — so iBias produces no
// measurable DC offset on the unity follower).
// ===========================================================================

describe("RealOpAmp Cat 10 — named model presets (T1)", () => {
  it("preset_741_shifts_dc_output_by_vos_delta", () => {
    // Cat 10, preset "741". Documented param delta vs default:
    //   aol: 100000 → 200000 (DC inert at this precision; gain error halves
    //                          from 4e-5 to 2e-5 of Vin=4V → ≪ 1e-4)
    //   gbw, slewRate: AC/transient only
    //   vos: 0 → 2e-3 V       ← only DC-observable delta
    //   iBias: 0 → 80e-9 A    (no DC effect on unity follower with ideal Vin)
    // Closed-form Δ at unity follower output: ΔVout = vos_741 - vos_default = +2e-3 V.
    const fixDefault = buildUnityFollower({
      vinVoltage: 4,
      opampProps: { ...DEFAULT_OPAMP_PROPS },
    });
    fixDefault.coordinator.dcOperatingPoint();
    const vDefault = fixDefault.engine.getNodeVoltage(
      fixDefault.circuit.labelToNodeId.get("opamp:out")!,
    );

    const fixPreset = buildUnityFollower({
      vinVoltage: 4,
      opampProps: { ...DEFAULT_OPAMP_PROPS, model: "741" },
    });
    fixPreset.coordinator.dcOperatingPoint();
    const vPreset = fixPreset.engine.getNodeVoltage(
      fixPreset.circuit.labelToNodeId.get("opamp:out")!,
    );

    // Δ ≈ vos_741 = 2e-3 V (4 decimal places ⇒ ±0.5e-4 tolerance).
    expect(vPreset - vDefault).toBeCloseTo(2e-3, 4);
  });

  it("preset_LM358_shifts_dc_output_by_vos_delta", () => {
    // Cat 10, preset "LM358". Documented param delta vs default:
    //   aol: 100000 (=)
    //   gbw: 1e6 (=)
    //   slewRate: 0.5e6 → 0.3e6 (AC/transient only)
    //   vos: 0 → 2e-3 V       ← only DC-observable delta
    //   iBias: 0 → 45e-9 A    (no DC effect on unity follower with ideal Vin)
    // Closed-form Δ: ΔVout = vos_LM358 - vos_default = +2e-3 V.
    const fixDefault = buildUnityFollower({
      vinVoltage: 3,
      opampProps: { ...DEFAULT_OPAMP_PROPS },
    });
    fixDefault.coordinator.dcOperatingPoint();
    const vDefault = fixDefault.engine.getNodeVoltage(
      fixDefault.circuit.labelToNodeId.get("opamp:out")!,
    );

    const fixPreset = buildUnityFollower({
      vinVoltage: 3,
      opampProps: { ...DEFAULT_OPAMP_PROPS, model: "LM358" },
    });
    fixPreset.coordinator.dcOperatingPoint();
    const vPreset = fixPreset.engine.getNodeVoltage(
      fixPreset.circuit.labelToNodeId.get("opamp:out")!,
    );

    expect(vPreset - vDefault).toBeCloseTo(2e-3, 4);
  });

  it("preset_TL072_shifts_dc_output_by_vos_delta", () => {
    // Cat 10, preset "TL072". Documented param delta vs default:
    //   aol: 100000 → 200000 (DC inert at 4-decimal precision)
    //   gbw: 1e6 → 3e6        (AC/transient only)
    //   slewRate: 0.5e6 → 13e6 (AC/transient only)
    //   vos: 0 → 3e-3 V       ← only DC-observable delta
    //   iBias: 0 → 30e-12 A   (no DC effect on unity follower with ideal Vin)
    // Closed-form Δ: ΔVout = vos_TL072 - vos_default = +3e-3 V.
    const fixDefault = buildUnityFollower({
      vinVoltage: 2,
      opampProps: { ...DEFAULT_OPAMP_PROPS },
    });
    fixDefault.coordinator.dcOperatingPoint();
    const vDefault = fixDefault.engine.getNodeVoltage(
      fixDefault.circuit.labelToNodeId.get("opamp:out")!,
    );

    const fixPreset = buildUnityFollower({
      vinVoltage: 2,
      opampProps: { ...DEFAULT_OPAMP_PROPS, model: "TL072" },
    });
    fixPreset.coordinator.dcOperatingPoint();
    const vPreset = fixPreset.engine.getNodeVoltage(
      fixPreset.circuit.labelToNodeId.get("opamp:out")!,
    );

    expect(vPreset - vDefault).toBeCloseTo(3e-3, 4);
  });

  it("preset_OPA2134_shifts_dc_output_by_vos_delta", () => {
    // Cat 10, preset "OPA2134". Documented param delta vs default:
    //   aol: 100000 → 1e6     (DC inert at 5-decimal precision; gain error
    //                          drops from 4e-5 to 4e-6 of Vin=4V)
    //   gbw: 1e6 → 8e6        (AC/transient only)
    //   slewRate: 0.5e6 → 20e6 (AC/transient only)
    //   vos: 0 → 500e-6 V     ← only DC-observable delta
    //   iBias: 0 → 5e-12 A    (no DC effect on unity follower with ideal Vin)
    // Closed-form Δ: ΔVout = vos_OPA2134 - vos_default = +500e-6 V.
    const fixDefault = buildUnityFollower({
      vinVoltage: 4,
      opampProps: { ...DEFAULT_OPAMP_PROPS },
    });
    fixDefault.coordinator.dcOperatingPoint();
    const vDefault = fixDefault.engine.getNodeVoltage(
      fixDefault.circuit.labelToNodeId.get("opamp:out")!,
    );

    const fixPreset = buildUnityFollower({
      vinVoltage: 4,
      opampProps: { ...DEFAULT_OPAMP_PROPS, model: "OPA2134" },
    });
    fixPreset.coordinator.dcOperatingPoint();
    const vPreset = fixPreset.engine.getNodeVoltage(
      fixPreset.circuit.labelToNodeId.get("opamp:out")!,
    );

    // Δ ≈ vos_OPA2134 = 500e-6 V (5 decimal places ⇒ ±0.5e-5 tolerance).
    expect(vPreset - vDefault).toBeCloseTo(500e-6, 5);
  });
});
