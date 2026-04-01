/**
 * Tests for the ADC (Analog-to-Digital Converter) component.
 *
 * The ADC converts an analog input voltage to an N-bit digital output code on
 * each rising clock edge:
 *   code = clamp(floor(V_in / V_ref × 2^N), 0, 2^N - 1)   (unipolar mode)
 *
 * Testing approach: construct the ADC AnalogElement directly via analogFactory,
 * then drive its state via updateState() calls with synthetic Float64Array
 * voltage vectors. The element exposes `latchedCode` and `eocActive` as
 * observable properties for inspection without running the full MNA solver.
 *
 * Node assignment (8-bit, unipolar):
 *   nodeIds[0] = VIN   → node 1  (voltages[0])
 *   nodeIds[1] = CLK   → node 2  (voltages[1])
 *   nodeIds[2] = VREF  → node 3  (voltages[2])
 *   nodeIds[3] = GND   → node 0  (MNA ground, implicit)
 *   nodeIds[4] = EOC   → node 4  (voltages[3])
 *   nodeIds[5] = D0    → node 5  (voltages[4])
 *   ...
 *   nodeIds[12]= D7    → node 12 (voltages[11])
 *
 * The voltages Float64Array is 0-indexed: voltages[nodeId - 1] for nodeId > 0.
 * GND = node 0 is the MNA ground constant (0V, not stored in voltages array).
 */

import { describe, it, expect } from "vitest";
import { ADCDefinition, ADC_DEFAULTS } from "../adc.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BITS = 8;
const V_REF = 5.0;
const MAX_CODE = (1 << BITS) - 1; // 255

// ---------------------------------------------------------------------------
// Node layout (1-based MNA node IDs)
// ---------------------------------------------------------------------------

const N_VIN  = 1;
const N_CLK  = 2;
const N_VREF = 3;
const N_GND  = 0;  // MNA ground — implicit, not in voltages array
const N_EOC  = 4;
// D0..D7 occupy nodes 5..12
const N_D0   = 5;

/** Build the pinNodes Map for an 8-bit ADC. */
function makeNodeIds(): ReadonlyMap<string, number> {
  const m = new Map<string, number>();
  m.set("VIN",  N_VIN);
  m.set("CLK",  N_CLK);
  m.set("VREF", N_VREF);
  m.set("GND",  N_GND);
  m.set("EOC",  N_EOC);
  for (let i = 0; i < BITS; i++) m.set(`D${i}`, N_D0 + i);
  return m;
}

// ---------------------------------------------------------------------------
// Voltage vector helpers
// ---------------------------------------------------------------------------

/** Matrix size: 12 data nodes (nodes 1..12) → voltages[0..11]. */
const MATRIX_SIZE = N_D0 + BITS - 1; // = 12

function makeVoltages(overrides: Partial<Record<string, number>> = {}): Float64Array {
  // nodeId → voltages[nodeId - 1]
  const v = new Float64Array(MATRIX_SIZE);
  v[N_VREF - 1] = V_REF;  // default VREF = 5V
  for (const [key, value] of Object.entries(overrides)) {
    const nodeId = parseInt(key);
    if (nodeId > 0 && nodeId <= MATRIX_SIZE && value !== undefined) v[nodeId - 1] = value;
  }
  return v;
}

// ---------------------------------------------------------------------------
// ADC factory helper
// ---------------------------------------------------------------------------

type ADCElementExt = AnalogElement & { latchedCode: number; eocActive: boolean };

function makeAdc(
  componentProps?: Record<string, number | string>,
  paramOverrides?: Record<string, number>,
): ADCElementExt {
  const bag = new PropertyBag([
    ["bits",           BITS],
    ["mode",           "unipolar"],
    ["conversionType", componentProps?.conversionType ?? "instant"],
  ]);
  bag.replaceModelParams({ ...ADC_DEFAULTS, ...paramOverrides });
  return getFactory(ADCDefinition.modelRegistry!["behavioral"]!)(
    makeNodeIds(), [], -1, bag, () => 0,
  ) as ADCElementExt;
}

// ---------------------------------------------------------------------------
// Clock-edge simulation helpers
// ---------------------------------------------------------------------------

/**
 * Apply a rising clock edge to the ADC with the given V_in.
 *
 * Steps:
 *   1. Drive CLK LOW with the target V_in set — updateState() sees prev=LOW.
 *   2. Drive CLK HIGH — updateState() detects the rising edge and converts.
 */
function applyClockEdge(
  adc: ADCElementExt,
  vIn: number,
  vRef: number = V_REF,
  clkHigh?: number,
): void {
  const dt = 1e-6; // 1 µs timestep
  const vIL = ADC_DEFAULTS.vIL;
  const vIH = clkHigh ?? (ADC_DEFAULTS.vIH + 0.1);

  // Step 1: CLK low — initialise prevClkVoltage to LOW
  const vLow = makeVoltages({ [N_VIN]: vIn, [N_CLK]: vIL, [N_VREF]: vRef });
  adc.updateState!(dt, vLow);

  // Step 2: CLK high — rising edge detected, conversion fires
  const vHigh = makeVoltages({ [N_VIN]: vIn, [N_CLK]: vIH, [N_VREF]: vRef });
  adc.updateState!(dt, vHigh);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ADC", () => {
  it("midscale_input", () => {
    // V_in = V_ref / 2 = 2.5V → code = floor(0.5 × 256) = 128
    const adc = makeAdc();
    applyClockEdge(adc, V_REF / 2);
    expect(adc.latchedCode).toBe(128);
  });

  it("full_scale", () => {
    // V_in = V_ref - 1 LSB = V_ref × (1 - 1/2^N) → code = 2^N - 1 = 255
    const vIn = V_REF * (MAX_CODE / (1 << BITS));
    const adc = makeAdc();
    applyClockEdge(adc, vIn);
    expect(adc.latchedCode).toBe(MAX_CODE);
  });

  it("zero_input", () => {
    // V_in = 0V → code = floor(0 × 256) = 0
    const adc = makeAdc();
    applyClockEdge(adc, 0);
    expect(adc.latchedCode).toBe(0);
  });

  it("ramp_test", () => {
    // Sweep V_in from 0 to V_ref in 17 steps; assert codes are non-decreasing.
    const steps = 17;
    const codes: number[] = [];

    for (let i = 0; i <= steps; i++) {
      const vIn = (V_REF * i) / steps;
      const adc = makeAdc();
      applyClockEdge(adc, vIn);
      codes.push(adc.latchedCode);
    }

    // Monotonically non-decreasing
    for (let i = 1; i < codes.length; i++) {
      expect(codes[i]).toBeGreaterThanOrEqual(codes[i - 1]!);
    }

    // Span: first code = 0, last code = MAX_CODE
    expect(codes[0]).toBe(0);
    expect(codes[codes.length - 1]).toBe(MAX_CODE);
  });

  it("eoc_pulses_after_conversion", () => {
    // Before any clock edge EOC should be inactive.
    // After one clock edge EOC should be active (instant conversion type).
    const adc = makeAdc({ conversionType: "instant" });

    expect(adc.eocActive).toBe(false);

    applyClockEdge(adc, V_REF / 2);

    expect(adc.eocActive).toBe(true);
  });

  it("output scales with VREF from wire", () => {
    // Same V_in ratio, different VREF — code should be the same
    const adc3 = makeAdc();
    applyClockEdge(adc3, 1.65, 3.3);  // 1.65/3.3 = 0.5 → code 128

    const adc5 = makeAdc();
    applyClockEdge(adc5, 2.5, 5.0);   // 2.5/5.0 = 0.5 → code 128

    expect(adc3.latchedCode).toBe(128);
    expect(adc5.latchedCode).toBe(128);
  });

  it("3.3V clock triggers edge detection with default thresholds", () => {
    // Default vIH = 2.0V. A 3.3V clock signal should trigger conversion.
    const adc = makeAdc();
    applyClockEdge(adc, V_REF / 2, V_REF, 3.3);
    expect(adc.latchedCode).toBe(128);
  });

  it("clock below vIH does not trigger conversion", () => {
    // Drive clock to 1.5V — below default vIH=2.0V. No conversion should fire.
    const adc = makeAdc();
    const dt = 1e-6;

    // Step 1: CLK low
    const vLow = makeVoltages({ [N_VIN]: V_REF / 2, [N_CLK]: 0.0, [N_VREF]: V_REF });
    adc.updateState!(dt, vLow);

    // Step 2: CLK to 1.5V — still below vIH=2.0V
    const vMid = makeVoltages({ [N_VIN]: V_REF / 2, [N_CLK]: 1.5, [N_VREF]: V_REF });
    adc.updateState!(dt, vMid);

    expect(adc.latchedCode).toBe(0);  // no conversion fired
    expect(adc.eocActive).toBe(false);
  });

  it("custom vIH threshold changes clock sensitivity", () => {
    // Set vIH = 4.0V. 3.3V clock should NOT trigger conversion.
    const adc = makeAdc(undefined, { vIH: 4.0 });
    const dt = 1e-6;

    const vLow = makeVoltages({ [N_VIN]: V_REF / 2, [N_CLK]: 0.0, [N_VREF]: V_REF });
    adc.updateState!(dt, vLow);

    const vHigh = makeVoltages({ [N_VIN]: V_REF / 2, [N_CLK]: 3.3, [N_VREF]: V_REF });
    adc.updateState!(dt, vHigh);

    expect(adc.latchedCode).toBe(0);  // 3.3V < 4.0V → no edge
    expect(adc.eocActive).toBe(false);

    // Now drive above 4.0V — should trigger
    const vHigher = makeVoltages({ [N_VIN]: V_REF / 2, [N_CLK]: 4.5, [N_VREF]: V_REF });
    adc.updateState!(dt, vHigher);

    expect(adc.latchedCode).toBe(128);
    expect(adc.eocActive).toBe(true);
  });
});
