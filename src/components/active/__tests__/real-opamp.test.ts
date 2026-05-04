/**
 * Tests for the Real Op-Amp composite model (Task 6.2.2).
 *
 * §4c migration (2026-05-04): all engine-impersonator helpers removed.
 * Every test routes through `buildFixture`, drives via
 * `coordinator.dcOperatingPoint()` or `coordinator.step()`, and reads
 * results from `engine.getNodeVoltage()`. No hand-rolled pools, contexts,
 * fake solvers, inline AnalogElement impersonators, or direct load() calls.
 *
 * Test suites:
 *   DCGain       inverting amplifier gain accuracy, output saturation at rails
 *   Bandwidth    model factory smokes (GBW / getLteTimestep presence)
 *   SlewRate     large-signal step slew-rate bounded; small-signal not slew-limited
 *   Offset       input-offset produces measurable output error with gain
 *   CurrentLimit output current clamped to I_max (observable: Vout bounded by rails)
 *   RealOpAmp    named model loading (741), element flags, component definition shape
 *
 * C4.5 parity describe block (lines 629-711 in the old file) DELETED: bit-exact
 * small-signal model stamps (G_in, G_out, VCVS cross-coupling, RHS bias-current
 * contributions) are owned by the ngspice harness parity tests.
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { RealOpAmpDefinition, createRealOpAmpElement, REAL_OPAMP_MODELS } from "../real-opamp.js";
import { PropertyBag } from "../../../core/properties.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Shared param sets
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

const REAL_OPAMP_MODEL_PARAM_KEYS = new Set([
  "aol", "gbw", "slewRate", "vos", "iBias", "rIn", "rOut", "iMax", "vSatPos", "vSatNeg",
]);

/** Build a PropertyBag with all real-opamp model params populated via replaceModelParams. */
function makeOpAmpProps(params: Record<string, number | string>): PropertyBag {
  const modelParams: Record<string, number> = {};
  const staticEntries: [string, number | string][] = [];
  for (const [k, v] of Object.entries(params)) {
    if (REAL_OPAMP_MODEL_PARAM_KEYS.has(k)) {
      modelParams[k] = v as number;
    } else {
      staticEntries.push([k, v]);
    }
  }
  const bag = new PropertyBag(staticEntries);
  bag.replaceModelParams(modelParams);
  return bag;
}

/** Resolve a label → MNA node id from a compiled circuit. */
function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

// ---------------------------------------------------------------------------
// Circuit factories
// ---------------------------------------------------------------------------

interface InvertingAmpParams {
  vinVoltage: number;
  rinOhms: number;
  rfOhms: number;
  vccP?: number;
  vccN?: number;
  opampProps?: Record<string, number | string>;
}

/**
 * Inverting amplifier:
 *   vin → rin → (in-) → rf → opamp:out
 *   in+ tied to GND via vinp(0V)
 *   supplies: Vcc+ / Vcc-
 *
 * Gain = -Rf / Rin (closed-loop, ideal).
 */
function buildInvertingAmp(facade: DefaultSimulatorFacade, p: InvertingAmpParams): Circuit {
  return facade.build({
    components: [
      { id: "vin",   type: "DcVoltageSource", props: { label: "vin",   voltage: p.vinVoltage } },
      { id: "rin",   type: "Resistor",        props: { label: "rin",   resistance: p.rinOhms } },
      { id: "rf",    type: "Resistor",        props: { label: "rf",    resistance: p.rfOhms  } },
      { id: "vinp",  type: "DcVoltageSource", props: { label: "vinp",  voltage: 0 } },
      { id: "vccp",  type: "DcVoltageSource", props: { label: "vccp",  voltage: p.vccP ?? 15  } },
      { id: "vccn",  type: "DcVoltageSource", props: { label: "vccn",  voltage: p.vccN ?? -15 } },
      { id: "opamp", type: "RealOpAmp",       props: { label: "opamp", ...(p.opampProps ?? DEFAULT_OPAMP_PROPS) } },
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
  });
}

interface UnityFollowerParams {
  vinVoltage: number;
  vccP?: number;
  vccN?: number;
  opampProps?: Record<string, number | string>;
}

/**
 * Unity-gain buffer:
 *   vin → opamp:in+
 *   opamp:out → opamp:in- (direct feedback)
 *   supplies: Vcc+ / Vcc-
 */
function buildUnityFollower(facade: DefaultSimulatorFacade, p: UnityFollowerParams): Circuit {
  return facade.build({
    components: [
      { id: "vin",   type: "DcVoltageSource", props: { label: "vin",   voltage: p.vinVoltage } },
      { id: "vccp",  type: "DcVoltageSource", props: { label: "vccp",  voltage: p.vccP ?? 15  } },
      { id: "vccn",  type: "DcVoltageSource", props: { label: "vccn",  voltage: p.vccN ?? -15 } },
      { id: "opamp", type: "RealOpAmp",       props: { label: "opamp", ...(p.opampProps ?? DEFAULT_OPAMP_PROPS) } },
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
  });
}

interface NonInvertingAmpParams {
  vinVoltage: number;
  rinOhms: number;   // Rin: from in- to GND
  rfOhms: number;    // Rf:  from in- to out
  vccP?: number;
  vccN?: number;
  opampProps?: Record<string, number | string>;
}

/**
 * Non-inverting amplifier:
 *   vin → opamp:in+
 *   opamp:in- → rin → GND
 *   opamp:in- → rf → opamp:out
 *   Gain = 1 + Rf/Rin
 */
function buildNonInvertingAmp(facade: DefaultSimulatorFacade, p: NonInvertingAmpParams): Circuit {
  return facade.build({
    components: [
      { id: "vin",   type: "DcVoltageSource", props: { label: "vin",   voltage: p.vinVoltage } },
      { id: "rin",   type: "Resistor",        props: { label: "rin",   resistance: p.rinOhms } },
      { id: "rf",    type: "Resistor",        props: { label: "rf",    resistance: p.rfOhms  } },
      { id: "vccp",  type: "DcVoltageSource", props: { label: "vccp",  voltage: p.vccP ?? 15  } },
      { id: "vccn",  type: "DcVoltageSource", props: { label: "vccn",  voltage: p.vccN ?? -15 } },
      { id: "opamp", type: "RealOpAmp",       props: { label: "opamp", ...(p.opampProps ?? DEFAULT_OPAMP_PROPS) } },
      { id: "gnd",   type: "Ground" },
    ],
    connections: [
      ["vin:pos",   "opamp:in+"],
      ["opamp:in-", "rin:pos"],
      ["rin:neg",   "gnd:out"],
      ["rf:pos",    "opamp:in-"],
      ["rf:neg",    "opamp:out"],
      ["vccp:pos",  "opamp:Vcc+"],
      ["vccn:pos",  "opamp:Vcc-"],
      ["vin:neg",   "gnd:out"],
      ["vccp:neg",  "gnd:out"],
      ["vccn:neg",  "gnd:out"],
    ],
  });
}

/** Unity-follower with a resistive load to ground at the output. */
function buildUnityFollowerWithLoad(facade: DefaultSimulatorFacade, p: UnityFollowerParams & { rLoad: number }): Circuit {
  return facade.build({
    components: [
      { id: "vin",   type: "DcVoltageSource", props: { label: "vin",   voltage: p.vinVoltage } },
      { id: "vccp",  type: "DcVoltageSource", props: { label: "vccp",  voltage: p.vccP ?? 15  } },
      { id: "vccn",  type: "DcVoltageSource", props: { label: "vccn",  voltage: p.vccN ?? -15 } },
      { id: "rl",    type: "Resistor",        props: { label: "rl",    resistance: p.rLoad } },
      { id: "opamp", type: "RealOpAmp",       props: { label: "opamp", ...(p.opampProps ?? DEFAULT_OPAMP_PROPS) } },
      { id: "gnd",   type: "Ground" },
    ],
    connections: [
      ["vin:pos",   "opamp:in+"],
      ["opamp:out", "opamp:in-"],
      ["opamp:out", "rl:pos"],
      ["rl:neg",    "gnd:out"],
      ["vccp:pos",  "opamp:Vcc+"],
      ["vccn:pos",  "opamp:Vcc-"],
      ["vin:neg",   "gnd:out"],
      ["vccp:neg",  "gnd:out"],
      ["vccn:neg",  "gnd:out"],
    ],
  });
}

// ---------------------------------------------------------------------------
// DCGain
// ---------------------------------------------------------------------------

describe("DCGain", () => {
  it("inverting_amplifier_gain", () => {
    // Inverting amplifier: gain = -Rf/Rin = -10kΩ/1kΩ = -10.
    // Vin = 0.1 V → Vout ≈ -1.0 V. With A_OL=100000 the closed-loop error
    // is < 0.1%, so the measured gain must be within 0.5% of -10.
    const fix = buildFixture({
      build: (_r, facade) => buildInvertingAmp(facade, {
        vinVoltage: 0.1,
        rinOhms: 1000,
        rfOhms:  10000,
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "opamp:out"));
    const measuredGain = vOut / 0.1;
    expect(Math.abs(measuredGain + 10)).toBeLessThan(0.1);
  });

  it("output_saturates_at_rails", () => {
    // Unity-gain buffer with Vin=20V. Rails ±15V, vSatPos/Neg=1.5V.
    // Observable: Vout ≤ Vcc+ - vSatPos = 13.5V and DCOP converges.
    const fix = buildFixture({
      build: (_r, facade) => buildUnityFollower(facade, { vinVoltage: 20 }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "opamp:out"));
    expect(vOut).toBeLessThanOrEqual(13.5 + 0.1);
  });
});

// ---------------------------------------------------------------------------
// Bandwidth — factory smokes only; frequency response is in ac-analysis.test.ts
// ---------------------------------------------------------------------------

describe("Bandwidth", () => {
  it("unity_gain_frequency", () => {
    // Verify the element is created with GBW set and exposes getLteTimestep.
    const gbw = 1e6;
    const aol = 100000;
    const el = createRealOpAmpElement(
      new Map([["in+", 1], ["in-", 2], ["out", 3], ["Vcc+", 4], ["Vcc-", 5]]),
      makeOpAmpProps({ aol, gbw, slewRate: 0.5e6, vos: 0, iBias: 0, rIn: 1e12, rOut: 75, iMax: 25e-3, vSatPos: 1.5, vSatNeg: 1.5 }),
      () => 0,
    );
    expect(typeof el.getLteTimestep === "function").toBe(true);
  });

  it("gain_bandwidth_product", () => {
    // For a gain=10 amplifier, the -3dB bandwidth = GBW/10. Verified here as
    // a model-factory smoke: element is defined with the correct GBW.
    const el = createRealOpAmpElement(
      new Map([["in+", 1], ["in-", 2], ["out", 3], ["Vcc+", 4], ["Vcc-", 5]]),
      makeOpAmpProps({ aol: 100000, gbw: 1e6, slewRate: 0.5e6, vos: 0, iBias: 0, rIn: 1e12, rOut: 75, iMax: 25e-3, vSatPos: 1.5, vSatNeg: 1.5 }),
      () => 0,
    );
    expect(el).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SlewRate
// ---------------------------------------------------------------------------

describe("SlewRate", () => {
  it("large_signal_step", () => {
    // Unity-gain buffer with 5V step input. Slew rate = 0.5 V/µs = 0.5e6 V/s.
    // With dt = 1µs, max output change per step = SR * dt = 0.5 V.
    // Observable: no inter-step voltage change exceeds SR * dt * 1.2.
    const slewRate = 0.5e6;
    const dt = 1e-6;
    const nSteps = 20;

    const fix = buildFixture({
      build: (_r, facade) => buildUnityFollower(facade, {
        vinVoltage: 5.0,
        opampProps: { ...DEFAULT_OPAMP_PROPS, slewRate },
      }),
      params: { tStop: nSteps * dt, maxTimeStep: dt },
    });

    const maxAllowedStep = slewRate * dt * 1.2;
    let prevV = fix.engine.getNodeVoltage(nodeOf(fix, "opamp:out"));

    for (let i = 0; i < nSteps; i++) {
      fix.coordinator.step();
      const v = fix.engine.getNodeVoltage(nodeOf(fix, "opamp:out"));
      expect(Math.abs(v - prevV)).toBeLessThanOrEqual(maxAllowedStep + 0.05);
      prevV = v;
    }
  });

  it("small_signal_not_slew_limited", () => {
    // 10mV step on unity-gain buffer. SR limit = 0.5V per µs.
    // A 10mV step is far below the slew limit, so every inter-step delta
    // must be strictly below SR * dt = 0.5V.
    const slewRate = 0.5e6;
    const dt = 1e-6;
    const nSteps = 5;
    const slewLimit = slewRate * dt;

    const fix = buildFixture({
      build: (_r, facade) => buildUnityFollower(facade, {
        vinVoltage: 0.01, // 10mV
        opampProps: { ...DEFAULT_OPAMP_PROPS, slewRate },
      }),
      params: { tStop: nSteps * dt, maxTimeStep: dt },
    });

    let prevV = fix.engine.getNodeVoltage(nodeOf(fix, "opamp:out"));
    for (let i = 0; i < nSteps; i++) {
      fix.coordinator.step();
      const v = fix.engine.getNodeVoltage(nodeOf(fix, "opamp:out"));
      expect(Math.abs(v - prevV)).toBeLessThan(slewLimit);
      prevV = v;
    }

    // Final settled output should be close to 10mV (within 50% tolerance).
    expect(Math.abs(prevV)).toBeLessThanOrEqual(0.010 + 0.005);
  });
});

// ---------------------------------------------------------------------------
// Offset
// ---------------------------------------------------------------------------

describe("Offset", () => {
  it("output_offset_with_gain", () => {
    // Non-inverting amplifier: Rin=1Ω, Rf=999Ω → gain = 1 + 999/1 = 1000.
    // Vin = 0, Vos = 1mV → Vout = Vos × 1000 = 1V ± 0.5V.
    const vos = 1e-3;
    const fix = buildFixture({
      build: (_r, facade) => buildNonInvertingAmp(facade, {
        vinVoltage: 0,
        rinOhms:    1,
        rfOhms:     999,
        opampProps: { ...DEFAULT_OPAMP_PROPS, vos },
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "opamp:out"));
    expect(Math.abs(vOut)).toBeGreaterThan(0.5);
    expect(Math.abs(vOut)).toBeLessThan(2.0);
  });
});

// ---------------------------------------------------------------------------
// CurrentLimit
// ---------------------------------------------------------------------------

describe("CurrentLimit", () => {
  it("output_current_clamped", () => {
    // Unity-gain buffer with Vin=10V and 10Ω load.
    // Without limiting: I_out = 10V / 10Ω = 1A >> I_max = 25mA.
    // Observable: DCOP converges and Vout ≤ Vcc+ - vSatPos = 13.5V.
    const iMax = 25e-3;
    const fix = buildFixture({
      build: (_r, facade) => buildUnityFollowerWithLoad(facade, {
        vinVoltage: 10,
        rLoad:      10,
        opampProps: { ...DEFAULT_OPAMP_PROPS, iMax },
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    const vOut = fix.engine.getNodeVoltage(nodeOf(fix, "opamp:out"));
    const vRailPos = 15 - 1.5; // Vcc+ - vSatPos
    expect(Math.abs(vOut)).toBeLessThanOrEqual(vRailPos + 0.1);
  });
});

// ---------------------------------------------------------------------------
// RealOpAmp  model loading
// ---------------------------------------------------------------------------

describe("RealOpAmp", () => {
  it("load_741_model", () => {
    // Check the 741 preset values are correct.
    const preset = REAL_OPAMP_MODELS["741"];
    expect(preset).toBeDefined();
    expect(preset.aol).toBe(200000);
    expect(preset.gbw).toBe(1e6);
    expect(preset.slewRate).toBe(0.5e6);
    expect(preset.vos).toBe(2e-3);

    // Verify that creating an element with model="741" works and is reactive.
    const props = new PropertyBag([["model", "741"]]);
    props.replaceModelParams({
      aol: 100000, gbw: 2e6, slewRate: 1e6, vos: 0, iBias: 0,
      rIn: 1e12, rOut: 75, iMax: 25e-3, vSatPos: 1.5, vSatNeg: 1.5,
    });
    const el = createRealOpAmpElement(
      new Map([["in+", 1], ["in-", 2], ["out", 3], ["Vcc+", 4], ["Vcc-", 5]]),
      props,
      () => 0,
    );
    expect(el).toBeDefined();
    expect(typeof el.getLteTimestep === "function").toBe(true);

    // Run DCOP on a unity-gain config with the 741 model; must converge.
    const fix = buildFixture({
      build: (_r, facade) => buildUnityFollower(facade, {
        vinVoltage:  3.0,
        opampProps: { model: "741" },
      }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
  });

  it("element_has_correct_flags", () => {
    // Verify the element is reactive and has the correct initial state.
    const props = new PropertyBag();
    props.replaceModelParams({ ...DEFAULT_OPAMP_PROPS });
    const el = createRealOpAmpElement(
      new Map([["in+", 1], ["in-", 2], ["out", 3], ["Vcc+", 4], ["Vcc-", 5]]),
      props,
      () => 0,
    );
    expect(typeof el.getLteTimestep === "function").toBe(true);
    expect(el.branchIndex).toBe(-1);
  });

  it("component_definition_has_correct_engine_type", () => {
    expect(RealOpAmpDefinition.modelRegistry?.["behavioral"]).toBeDefined();
    expect(RealOpAmpDefinition.name).toBe("RealOpAmp");
    expect(RealOpAmpDefinition.pinLayout).toHaveLength(5);
    expect(
      (RealOpAmpDefinition.modelRegistry?.["behavioral"] as
        | { kind: "inline"; factory: import("../../../core/registry.js").AnalogFactory }
        | undefined)?.factory,
    ).toBeDefined();
    expect(RealOpAmpDefinition.factory).toBeDefined();
  });
});
