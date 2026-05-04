/**
 * Tests for the ADC (Analog-to-Digital Converter) component.
 *
 * §4c migration: all tests route through `buildFixture`, drive via
 * `coordinator.step()` / `coordinator.dcOperatingPoint()`, and read
 * observable state from the ADCDriverElement's pool slots. No direct
 * element.setup() / element.load() / element.accept() calls, no hand-rolled
 * contexts or state pools.
 *
 * Circuit topology (8-bit, unipolar-instant):
 *   clk  (DcVoltageSource, label "clk")  → adc:CLK
 *   vin  (DcVoltageSource, label "vin")  → adc:VIN
 *   vref (DcVoltageSource, label "vref", voltage=5) → adc:VREF
 *   gnd  → adc:GND
 *
 * Observable surface:
 *   findDriver(fix.circuit.elements) → ADCDriverElement (instanceof)
 *   latchedCode = pool.state0[drv._stateBase + SLOT_OUTPUT_CODE]
 *   eocActive   = pool.state0[drv._stateBase + SLOT_OUTPUT_EOC] !== 0
 *
 * Rising-edge protocol:
 *   1. Build with clk.voltage = 0 (low), step once (warm-start).
 *   2. facade.setSignal(coordinator, "clk", vHigh) to go high.
 *   3. coordinator.step() — ADC detects rising edge, latches code.
 *   4. Read latchedCode / eocActive from pool.
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { ADCDriverElement } from "../adc-driver.js";
import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BITS = 8;
const V_REF = 5.0;
const MAX_CODE = (1 << BITS) - 1; // 255
const V_IH_DEFAULT = 2.0;
const V_IL_DEFAULT = 0.8;

// ---------------------------------------------------------------------------
// Pool slot indices (from ADCDriverElement's schema, 8-bit)
// imported at test construction time via the schema the element carries.
// ---------------------------------------------------------------------------

function getSlots(drv: ADCDriverElement): { outputCode: number; outputEoc: number } {
  return {
    outputCode: drv.stateSchema.indexOf.get("OUTPUT_CODE")!,
    outputEoc:  drv.stateSchema.indexOf.get("OUTPUT_EOC")!,
  };
}

// ---------------------------------------------------------------------------
// Circuit factory
// ---------------------------------------------------------------------------

interface AdcCircuitParams {
  vIn?: number;
  vRef?: number;
  clkVoltage?: number;
  bits?: number;
  /** Override vIH as a model param on the ADC component. */
  vIH?: number;
}

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
      // Pull EOC and all D-pins to GND through high-Z resistors for stability.
      // The ADC output pin models have their own rOut drive; the pull-downs
      // just ensure the open-drain nodes are not floating.
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

// ---------------------------------------------------------------------------
// Element finder
// ---------------------------------------------------------------------------

function findDriver(elements: ReadonlyArray<unknown>): ADCDriverElement {
  const el = elements.find((e) => e instanceof ADCDriverElement);
  if (el === undefined) throw new Error("ADCDriverElement not found in compiled circuit");
  return el as ADCDriverElement;
}

// ---------------------------------------------------------------------------
// Observable ADC state helpers
// ---------------------------------------------------------------------------

function readLatchedCode(fix: ReturnType<typeof buildFixture>): number {
  const drv = findDriver(fix.circuit.elements);
  const { outputCode } = getSlots(drv);
  return Math.round(fix.pool.state0[drv._stateBase + outputCode]);
}

function readEocActive(fix: ReturnType<typeof buildFixture>): boolean {
  const drv = findDriver(fix.circuit.elements);
  const { outputEoc } = getSlots(drv);
  return fix.pool.state0[drv._stateBase + outputEoc] !== 0;
}

/**
 * Apply a rising clock edge in the real circuit.
 *
 * Steps:
 *   1. Fixture is already warm-started with CLK low.
 *   2. Set CLK to vHigh via facade.setSignal.
 *   3. coordinator.step() — engine runs one transient step, ADC detects edge.
 */
function applyRisingEdge(
  fix: ReturnType<typeof buildFixture>,
  vHigh: number = V_IH_DEFAULT + 0.1,
): void {
  fix.facade.setSignal(fix.coordinator, "clk", vHigh);
  fix.coordinator.step();
}

// ---------------------------------------------------------------------------
// ADC tests
// ---------------------------------------------------------------------------

describe("ADC", () => {
  it("midscale_input", () => {
    // V_in = V_ref / 2 = 2.5V → code = floor(0.5 × 256) = 128
    const fix = buildFixture({
      build: (_r, facade) => buildAdcCircuit(facade, { vIn: V_REF / 2, vRef: V_REF }),
    });

    expect(readLatchedCode(fix)).toBe(0); // no edge yet

    applyRisingEdge(fix);

    expect(readLatchedCode(fix)).toBe(128);
  });

  it("full_scale", () => {
    // V_in = V_ref × (MAX_CODE / 2^N) → code = 2^N - 1 = 255
    const vIn = V_REF * (MAX_CODE / (1 << BITS));
    const fix = buildFixture({
      build: (_r, facade) => buildAdcCircuit(facade, { vIn, vRef: V_REF }),
    });

    applyRisingEdge(fix);

    expect(readLatchedCode(fix)).toBe(MAX_CODE);
  });

  it("zero_input", () => {
    // V_in = 0V → code = floor(0 × 256) = 0
    const fix = buildFixture({
      build: (_r, facade) => buildAdcCircuit(facade, { vIn: 0, vRef: V_REF }),
    });

    applyRisingEdge(fix);

    expect(readLatchedCode(fix)).toBe(0);
  });

  it("ramp_test", () => {
    // Sweep V_in from 0 to V_ref in 17 steps; assert codes are non-decreasing.
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
    const fix = buildFixture({
      build: (_r, facade) => buildAdcCircuit(facade, { vIn: V_REF / 2, vRef: V_REF }),
    });

    expect(readEocActive(fix)).toBe(false);

    applyRisingEdge(fix);

    expect(readEocActive(fix)).toBe(true);
  });

  it("output scales with VREF from wire", () => {
    // Same V_in ratio, different VREF → code should be the same
    const fix3 = buildFixture({
      build: (_r, facade) => buildAdcCircuit(facade, { vIn: 1.65, vRef: 3.3 }),
    });
    applyRisingEdge(fix3);

    const fix5 = buildFixture({
      build: (_r, facade) => buildAdcCircuit(facade, { vIn: 2.5, vRef: 5.0 }),
    });
    applyRisingEdge(fix5);

    // Both are 0.5 × VREF → code 128
    expect(readLatchedCode(fix3)).toBe(128);
    expect(readLatchedCode(fix5)).toBe(128);
  });

  it("3.3V clock triggers edge detection with default thresholds", () => {
    // Default vIH = 2.0V. A 3.3V clock signal should trigger conversion.
    const fix = buildFixture({
      build: (_r, facade) => buildAdcCircuit(facade, { vIn: V_REF / 2, vRef: V_REF }),
    });
    applyRisingEdge(fix, 3.3);
    expect(readLatchedCode(fix)).toBe(128);
  });

  it("clock below vIH does not trigger conversion", () => {
    // Drive clock to 1.5V — below default vIH=2.0V. No conversion should fire.
    const fix = buildFixture({
      build: (_r, facade) => buildAdcCircuit(facade, { vIn: V_REF / 2, vRef: V_REF }),
    });

    // Step with CLK at 1.5V — below vIH=2.0V, should not trigger
    fix.facade.setSignal(fix.coordinator, "clk", 1.5);
    fix.coordinator.step();

    expect(readLatchedCode(fix)).toBe(0); // no conversion fired
    expect(readEocActive(fix)).toBe(false);
  });

  it("custom vIH threshold changes clock sensitivity", () => {
    // Set vIH = 4.0V. 3.3V clock should NOT trigger conversion.
    // Then drive above 4.0V — should trigger.
    const fix = buildFixture({
      build: (_r, facade) => buildAdcCircuit(facade, { vIn: V_REF / 2, vRef: V_REF, vIH: 4.0 }),
    });

    // Drive CLK to 3.3V — below custom vIH=4.0V
    fix.facade.setSignal(fix.coordinator, "clk", 3.3);
    fix.coordinator.step();

    expect(readLatchedCode(fix)).toBe(0);  // 3.3V < 4.0V → no edge
    expect(readEocActive(fix)).toBe(false);

    // Drive CLK back low so we can get a clean rising edge
    fix.facade.setSignal(fix.coordinator, "clk", V_IL_DEFAULT - 0.1);
    fix.coordinator.step();

    // Now drive above 4.0V → should trigger
    fix.facade.setSignal(fix.coordinator, "clk", 4.5);
    fix.coordinator.step();

    expect(readLatchedCode(fix)).toBe(128);
    expect(readEocActive(fix)).toBe(true);
  });
});
