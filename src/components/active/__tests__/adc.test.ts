import { describe, it, expect } from "vitest";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ADCDriverElement } from "../adc-driver.js";
import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const BITS = 8;
const V_REF = 5.0;
const MAX_CODE = (1 << BITS) - 1; // 255
const V_IH_DEFAULT = 2.0;
const V_IL_DEFAULT = 0.8;

// ---------------------------------------------------------------------------
// Topology helpers
// ---------------------------------------------------------------------------

interface AdcCircuitParams {
  vIn?: number;
  vRef?: number;
  clkVoltage?: number;
  bits?: number;
  /** Override vIH as a model param on the ADC component. */
  vIH?: number;
}

/**
 * Programmatic ADC bench. Drives VIN/VREF/CLK from DC voltage sources, ties
 * EOC + every D-pin to GND through the bench's GroundElement (the bridge
 * adapters' rOut/rHiZ resistances dominate so the digital output nodes settle
 * at vOH/vOL). All canonical buildFixture() calls in this file route through
 * here.
 */
function buildAdcCircuit(facade: DefaultSimulatorFacade, p: AdcCircuitParams): Circuit {
  const adcProps: Record<string, string | number> = {
    label: "adc1",
    bits:  p.bits ?? BITS,
    model: "default",
  };
  if (p.vIH !== undefined) adcProps.vIH = p.vIH;

  return facade.build({
    components: [
      { id: "vin",  type: "DcVoltageSource", props: { label: "vin",  voltage: p.vIn  ?? 0 } },
      { id: "vref", type: "DcVoltageSource", props: { label: "vref", voltage: p.vRef ?? V_REF } },
      { id: "clk",  type: "DcVoltageSource", props: { label: "clk",  voltage: p.clkVoltage ?? 0 } },
      { id: "adc",  type: "ADC",             props: adcProps },
      { id: "gnd",  type: "Ground" },
    ],
    connections: [
      ["vin:pos",   "adc:VIN"],
      ["vin:neg",   "gnd:out"],
      ["vref:pos",  "adc:VREF"],
      ["vref:neg",  "gnd:out"],
      ["clk:pos",   "adc:CLK"],
      ["clk:neg",   "gnd:out"],
      ["adc:GND",   "gnd:out"],
      ["adc:EOC",   "gnd:out"],
      ["adc:D0",    "gnd:out"],
      ["adc:D1",    "gnd:out"],
      ["adc:D2",    "gnd:out"],
      ["adc:D3",    "gnd:out"],
      ["adc:D4",    "gnd:out"],
      ["adc:D5",    "gnd:out"],
      ["adc:D6",    "gnd:out"],
      ["adc:D7",    "gnd:out"],
    ],
  });
}

function findDriver(elements: ReadonlyArray<unknown>): ADCDriverElement {
  const el = elements.find((e) => e instanceof ADCDriverElement);
  if (el === undefined) throw new Error("ADCDriverElement not found in compiled circuit");
  return el as ADCDriverElement;
}

function readLatchedCode(fix: ReturnType<typeof buildFixture>): number {
  const drv = findDriver(fix.circuit.elements);
  const slot = drv.stateSchema.indexOf.get("OUTPUT_CODE")!;
  return Math.round(fix.pool.state0[drv._stateBase + slot]);
}

function readEocActive(fix: ReturnType<typeof buildFixture>): boolean {
  const drv = findDriver(fix.circuit.elements);
  const slot = drv.stateSchema.indexOf.get("OUTPUT_EOC")!;
  return fix.pool.state0[drv._stateBase + slot] !== 0;
}

/** Drive CLK from low to vHigh and step the simulator once (rising edge). */
function applyRisingEdge(
  fix: ReturnType<typeof buildFixture>,
  vHigh: number = V_IH_DEFAULT + 0.1,
): void {
  fix.facade.setSignal(fix.coordinator, "clk", vHigh);
  fix.coordinator.step();
}

// ---------------------------------------------------------------------------
// Category 1 — Initialization (T1)
// ---------------------------------------------------------------------------

describe("ADC initialization (T1)", () => {
  it("init_state_pool_post_warm_start", () => {
    // After buildFixture's warm-start, the ADCDriver's PREV_CLK slot should
    // hold the warm-started clock voltage (CLK source at 0V → 0V), FSM_PHASE
    // should still be 0 (idle), OUTPUT_CODE should be 0, OUTPUT_EOC 0, every
    // OUTPUT_D{i} 0. The first sample suppresses any spurious rising-edge
    // detection so no FSM advance has happened yet.
    const fix = buildFixture({
      build: (_r, facade) => buildAdcCircuit(facade, { vIn: V_REF / 2, vRef: V_REF }),
    });

    const drv = findDriver(fix.circuit.elements);
    const sch = drv.stateSchema;
    const base = drv._stateBase;
    const fsm = fix.pool.state0[base + sch.indexOf.get("FSM_PHASE")!];
    const code = fix.pool.state0[base + sch.indexOf.get("OUTPUT_CODE")!];
    const eoc = fix.pool.state0[base + sch.indexOf.get("OUTPUT_EOC")!];

    expect(fsm).toBe(0);   // idle
    expect(code).toBe(0);  // no edge yet → no latched code
    expect(eoc).toBe(0);   // EOC inactive
    for (let i = 0; i < BITS; i++) {
      const d = fix.pool.state0[base + sch.indexOf.get(`OUTPUT_D${i}`)!];
      expect(d).toBe(0);
    }

    // VIN node should sit at the source's 2.5V (voltage divider through the
    // analog input impedance is dominated by rIn=10MΩ vs the source's ideal
    // drive, so the node value tracks the source).
    const vinNode = fix.circuit.labelToNodeId.get("vin:pos");
    expect(vinNode).toBeDefined();
    expect(fix.engine.getNodeVoltage(vinNode!)).toBeCloseTo(V_REF / 2, 6);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — DC operating point (T1, analytical)
// ---------------------------------------------------------------------------

describe("ADC DCOP (T1, analytical)", () => {
  it("dcop_vin_node_tracks_source", () => {
    // With CLK held at 0V no conversion has fired. The analog input node
    // should track the DC source bound to it: closed-form expected = 2.5V.
    const fix = buildFixture({
      build: (_r, facade) => buildAdcCircuit(facade, { vIn: V_REF / 2, vRef: V_REF }),
    });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result?.converged).toBe(true);

    const vinNode = fix.circuit.labelToNodeId.get("vin:pos");
    const vrefNode = fix.circuit.labelToNodeId.get("vref:pos");
    expect(vinNode).toBeDefined();
    expect(vrefNode).toBeDefined();
    // Closed form: ideal voltage source forces node potential = 2.5V / 5.0V.
    expect(fix.engine.getNodeVoltage(vinNode!)).toBeCloseTo(V_REF / 2, 9);
    expect(fix.engine.getNodeVoltage(vrefNode!)).toBeCloseTo(V_REF, 9);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Parameter hot-load (T1)
// ---------------------------------------------------------------------------

describe("ADC parameter hot-load (T1)", () => {
  it("hotload_vIH_changes_clock_sensitivity", () => {
    // Default vIH = 2.0V. A 3.3V CLK rising edge should latch a conversion.
    // After hot-loading vIH = 4.0V, the same 3.3V CLK should NOT trigger
    // (3.3 < 4.0 → no rising edge detected). Then driving CLK above 4.0V
    // should re-arm conversion.
    const fix = buildFixture({
      build: (_r, facade) => buildAdcCircuit(facade, { vIn: V_REF / 2, vRef: V_REF }),
    });

    // Sanity: 3.3V edge under default vIH=2.0V triggers conversion.
    applyRisingEdge(fix, 3.3);
    expect(readLatchedCode(fix)).toBe(128);
    expect(readEocActive(fix)).toBe(true);

    // Drive CLK low so we can hot-load vIH and re-test the threshold.
    fix.facade.setSignal(fix.coordinator, "clk", 0);
    fix.coordinator.step();

    // Hot-load vIH on the ADC composite via the public label-routed
    // setSourceByLabel API. The composite's SubcircuitWrapperElement.setParam
    // fans the model-param change down to the ADCDriver leaf, which mutates
    // its cached _vIH for subsequent edge detection.
    fix.coordinator.setSourceByLabel("adc1", "vIH", 4.0);

    // 3.3V CLK is now below the new vIH threshold → no rising edge → code
    // unchanged from the previous latch (128). What we assert here is that
    // EOC clears (instant-mode SAR clears EOC when CLK falls below vIL) and
    // no further conversion fires when CLK is below the new threshold.
    fix.facade.setSignal(fix.coordinator, "clk", 3.3);
    fix.coordinator.step();
    expect(readEocActive(fix)).toBe(false);

    // Drive CLK back low cleanly so the next edge above 4.0V is detected.
    fix.facade.setSignal(fix.coordinator, "clk", V_IL_DEFAULT - 0.1);
    fix.coordinator.step();

    // Now drive above the new vIH=4.0V threshold and confirm a fresh
    // conversion fires (EOC asserts, code latches the converted value).
    fix.facade.setSignal(fix.coordinator, "clk", 4.5);
    fix.coordinator.step();
    expect(readLatchedCode(fix)).toBe(128);
    expect(readEocActive(fix)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 9 — Bridge / digital interaction (T1)
//
// ADC is a digital-pin component (EOC + D0..D(N-1) routed via
// DigitalOutputPinLoaded bridge adapters). Cat 9 asserts that an analog
// input drives the right code on the digital outputs after a clock edge,
// and that intermediate-input thresholding behaves correctly.
// ---------------------------------------------------------------------------

describe("ADC bridge / digital interaction (T1)", () => {
  it("midscale_input_latches_code_128_on_rising_clock", () => {
    // V_in = V_ref / 2 = 2.5V → code = floor(0.5 × 256) = 128.
    const fix = buildFixture({
      build: (_r, facade) => buildAdcCircuit(facade, { vIn: V_REF / 2, vRef: V_REF }),
    });

    // No edge yet — no latched code.
    expect(readLatchedCode(fix)).toBe(0);

    applyRisingEdge(fix);
    expect(readLatchedCode(fix)).toBe(128);
  });

  it("full_scale_input_latches_max_code", () => {
    // V_in = V_ref × (MAX_CODE / 2^N) → code = 2^N - 1 = 255.
    const vIn = V_REF * (MAX_CODE / (1 << BITS));
    const fix = buildFixture({
      build: (_r, facade) => buildAdcCircuit(facade, { vIn, vRef: V_REF }),
    });

    applyRisingEdge(fix);
    expect(readLatchedCode(fix)).toBe(MAX_CODE);
  });

  it("zero_input_latches_zero_code", () => {
    // V_in = 0V → code = 0.
    const fix = buildFixture({
      build: (_r, facade) => buildAdcCircuit(facade, { vIn: 0, vRef: V_REF }),
    });

    applyRisingEdge(fix);
    expect(readLatchedCode(fix)).toBe(0);
  });

  it("ramp_input_produces_monotonic_codes", () => {
    // Sweep V_in from 0 to V_ref in 17 steps; each fixture is built fresh so
    // each sweep point is an independent conversion. Codes must be
    // non-decreasing with V_in, span 0 → MAX_CODE.
    const steps = 17;
    const codes: number[] = [];

    for (let i = 0; i <= steps; i++) {
      const vIn = (V_REF * i) / steps;
      const fix = buildFixture({
        build: (_r, facade) => buildAdcCircuit(facade, { vIn, vRef: V_REF }),
      });
      applyRisingEdge(fix);
      codes.push(readLatchedCode(fix));
    }

    for (let i = 1; i < codes.length; i++) {
      expect(codes[i]).toBeGreaterThanOrEqual(codes[i - 1]!);
    }
    expect(codes[0]).toBe(0);
    expect(codes[codes.length - 1]).toBe(MAX_CODE);
  });

  it("eoc_asserts_after_rising_clock", () => {
    // EOC inactive before any rising edge; active after instant-mode
    // conversion completes on the rising edge.
    const fix = buildFixture({
      build: (_r, facade) => buildAdcCircuit(facade, { vIn: V_REF / 2, vRef: V_REF }),
    });

    expect(readEocActive(fix)).toBe(false);
    applyRisingEdge(fix);
    expect(readEocActive(fix)).toBe(true);
  });

  it("output_code_scales_with_vref_at_constant_ratio", () => {
    // Same V_in / V_ref ratio (0.5) on two different rails → same code.
    // Closed form: code = floor(0.5 × 256) = 128 regardless of absolute V_ref.
    const fix3 = buildFixture({
      build: (_r, facade) => buildAdcCircuit(facade, { vIn: 1.65, vRef: 3.3 }),
    });
    applyRisingEdge(fix3);

    const fix5 = buildFixture({
      build: (_r, facade) => buildAdcCircuit(facade, { vIn: 2.5, vRef: 5.0 }),
    });
    applyRisingEdge(fix5);

    expect(readLatchedCode(fix3)).toBe(128);
    expect(readLatchedCode(fix5)).toBe(128);
  });

  it("clock_below_vIH_does_not_trigger_conversion", () => {
    // Drive CLK to 1.5V — below default vIH=2.0V. detectRisingEdge should
    // reject it; OUTPUT_CODE stays 0 and EOC stays inactive.
    const fix = buildFixture({
      build: (_r, facade) => buildAdcCircuit(facade, { vIn: V_REF / 2, vRef: V_REF }),
    });

    fix.facade.setSignal(fix.coordinator, "clk", 1.5);
    fix.coordinator.step();

    expect(readLatchedCode(fix)).toBe(0);
    expect(readEocActive(fix)).toBe(false);
  });
});
