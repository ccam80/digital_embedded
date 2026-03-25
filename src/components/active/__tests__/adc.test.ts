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
import { ADCDefinition } from "../adc.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../../../analog/element.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BITS = 8;
const V_REF = 5.0;
const MAX_CODE = (1 << BITS) - 1; // 255
const V_IH = 2.0; // clock high threshold (CMOS 3.3V family)
const V_IL = 0.8; // clock low threshold

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

type ADCElement = AnalogElement & { latchedCode: number; eocActive: boolean };

function makeAdc(props: Record<string, number | string> = {}): ADCElement {
  const defaults: [string, number | string][] = [
    ["bits",           BITS],
    ["vRef",           V_REF],
    ["mode",           "unipolar"],
    ["conversionType", "instant"],
  ];
  const merged = new Map<string, number | string>(defaults);
  for (const [k, v] of Object.entries(props)) merged.set(k, v);

  const bag = new PropertyBag(Array.from(merged.entries()));
  return ADCDefinition.models!.analog!.factory(makeNodeIds(), [], -1, bag, () => 0) as ADCElement;
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
function applyClockEdge(adc: ADCElement, vIn: number): void {
  const dt = 1e-6; // 1 µs timestep

  // Step 1: CLK low — initialise prevClkVoltage to LOW
  const vLow = makeVoltages({ [N_VIN]: vIn, [N_CLK]: V_IL, [N_VREF]: V_REF });
  adc.updateState!(dt, vLow);

  // Step 2: CLK high — rising edge detected, conversion fires
  const vHigh = makeVoltages({ [N_VIN]: vIn, [N_CLK]: V_IH + 0.1, [N_VREF]: V_REF });
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
    // floor((255/256) × 256) = floor(255) = 255
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
    // We use a fresh ADC for each step (each edge is independent).
    const steps = 17;
    const codes: number[] = [];

    for (let i = 0; i <= steps; i++) {
      const vIn = (V_REF * i) / steps;
      const adc = makeAdc();
      applyClockEdge(adc, vIn);
      codes.push(adc.latchedCode);
    }

    // Assert monotonically non-decreasing
    for (let i = 1; i < codes.length; i++) {
      expect(codes[i]).toBeGreaterThanOrEqual(codes[i - 1]);
    }

    // Additionally verify the span: first code = 0, last code = MAX_CODE
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
});
