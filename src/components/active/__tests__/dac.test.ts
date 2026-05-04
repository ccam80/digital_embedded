/**
 * Tests for the DAC (Digital-to-Analog Converter) component.
 *
 * Post-migration (§4c): all tests route through `buildFixture`, build the
 * circuit via `facade.build` with registered types, and assert observable
 * behaviour via `coordinator.dcOperatingPoint()` + `engine.getNodeVoltage`.
 *
 * No hand-rolled ConcreteCompiledAnalogCircuit, no fake StatePool, no direct
 * element.setup()/load() calls, no engine impersonators.
 *
 * The DAC converts an N-bit digital input code to an analog output voltage:
 *   V_out = V_ref · code / 2^N  (unipolar)
 *
 * Test circuit shape:
 *   DcVoltageSource(V_Di) → DAC:D0..D7
 *   DcVoltageSource(V_REF) → DAC:VREF
 *   DAC:OUT → observed (via labelToNodeId)
 *   DAC:GND, DcVoltageSource:neg → Ground
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BITS = 8;
const V_REF = 5.0;

// ---------------------------------------------------------------------------
// Circuit factory
// ---------------------------------------------------------------------------

interface DacCircuitParams {
  inputBits: boolean[];
  vRef?: number;
  vHigh?: number;
  paramOverrides?: Record<string, number>;
}

function buildDacCircuit(facade: DefaultSimulatorFacade, p: DacCircuitParams): Circuit {
  const vRef = p.vRef ?? V_REF;
  const driveHigh = p.vHigh ?? vRef;
  const overrides = p.paramOverrides ?? {};

  const components: Array<{ id: string; type: string; props: Record<string, unknown> }> = [
    {
      id: "dac",
      type: "DAC",
      props: { label: "dac", bits: BITS, ...overrides },
    },
    {
      id: "vref",
      type: "DcVoltageSource",
      props: { label: "vref", voltage: vRef },
    },
    // Load resistor on OUT so the node is properly resolved in the MNA netlist.
    // High-Z (1MΩ) so it doesn't affect the output voltage significantly.
    {
      id: "rload",
      type: "Resistor",
      props: { label: "rload", resistance: 1e6 },
    },
    { id: "gnd", type: "Ground" },
  ];

  // One DcVoltageSource per bit
  for (let i = 0; i < BITS; i++) {
    const v = p.inputBits[i] ? driveHigh : 0.0;
    components.push({
      id: `vd${i}`,
      type: "DcVoltageSource",
      props: { label: `vd${i}`, voltage: v },
    });
  }

  const connections: Array<[string, string]> = [
    ["vref:pos",  "dac:VREF"],
    ["vref:neg",  "gnd:out"],
    ["dac:GND",   "gnd:out"],
    ["dac:OUT",   "rload:pos"],
    ["rload:neg", "gnd:out"],
  ];

  for (let i = 0; i < BITS; i++) {
    connections.push([`vd${i}:pos`, `dac:D${i}`]);
    connections.push([`vd${i}:neg`, `gnd:out`]);
  }

  return facade.build({ components, connections });
}

// ---------------------------------------------------------------------------
// solveDac — runs DCOP and returns { converged, vOut }
// ---------------------------------------------------------------------------

function solveDac(
  inputBits: boolean[],
  vRef: number = V_REF,
  vHigh?: number,
  paramOverrides?: Record<string, number>,
): { converged: boolean; vOut: number } {
  const fix = buildFixture({
    build: (_r, facade) => buildDacCircuit(facade, { inputBits, vRef, vHigh, paramOverrides }),
  });

  const result = fix.coordinator.dcOperatingPoint();
  // Try dac:OUT first; fall back to rload:pos (same net) if labelToNodeId
  // doesn't carry the DAC's OUT pin label.
  const outNodeId = fix.circuit.labelToNodeId.get("dac:OUT")
    ?? fix.circuit.labelToNodeId.get("rload:pos");
  const vOut = (result && outNodeId !== undefined && outNodeId > 0)
    ? result.nodeVoltages[outNodeId]
    : 0;

  return {
    converged: result?.converged ?? false,
    vOut,
  };
}

/** Convert a decimal code (0..255) to an array of 8 booleans (LSB first). */
function codeToBits(code: number): boolean[] {
  const bits: boolean[] = [];
  for (let i = 0; i < BITS; i++) {
    bits.push((code & (1 << i)) !== 0);
  }
  return bits;
}

// ---------------------------------------------------------------------------
// DAC tests
// ---------------------------------------------------------------------------

describe("DAC", () => {
  it("full_scale", () => {
    // All inputs HIGH: code = 255
    // V_out = V_ref · (2^N - 1) / 2^N = 5 · 255/256 ≈ 4.980 V
    const allHigh = Array(BITS).fill(true);
    const { converged, vOut } = solveDac(allHigh);

    expect(converged).toBe(true);
    expect(vOut).toBeCloseTo(V_REF * 255 / 256, 2);
  });

  it("zero_code", () => {
    // All inputs LOW: code = 0 → V_out = 0V
    const allLow = Array(BITS).fill(false);
    const { converged, vOut } = solveDac(allLow);

    expect(converged).toBe(true);
    expect(vOut).toBeCloseTo(0, 4);
  });

  it("midscale", () => {
    // MSB (D7) = 1, rest = 0: code = 128 (0b10000000)
    // V_out = V_ref · 128/256 = V_ref / 2 = 2.5 V
    const bits = Array(BITS).fill(false);
    bits[BITS - 1] = true;  // D7 = MSB = 1
    const { converged, vOut } = solveDac(bits);

    expect(converged).toBe(true);
    expect(vOut).toBeCloseTo(V_REF / 2, 2);
  });

  it("monotonic_ramp", () => {
    // Increment code from 0 to 255; assert V_out increases monotonically.
    // We test every 16th step to keep the test fast (0, 16, 32, ..., 255).
    const voltages: number[] = [];
    const steps = [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 255];

    for (const code of steps) {
      const { converged, vOut } = solveDac(codeToBits(code));
      expect(converged).toBe(true);
      if (code > 0) {
        // Non-zero code must produce positive output
        expect(vOut).toBeGreaterThan(0);
      }
      voltages.push(vOut);
    }

    // Assert monotonically increasing (skip code=0 vs code=0 degenerate case)
    for (let i = 1; i < voltages.length; i++) {
      expect(voltages[i]).toBeGreaterThan(voltages[i - 1]!);
    }
  });

  it("lsb_step_size", () => {
    // LSB step size = V_ref / 2^N = 5.0 / 256 ≈ 0.019531 V
    // Test: code=1 vs code=0, code=2 vs code=1, code=128 vs code=127
    const v0   = solveDac(codeToBits(0)).vOut;
    const v1   = solveDac(codeToBits(1)).vOut;
    const v2   = solveDac(codeToBits(2)).vOut;
    const v127 = solveDac(codeToBits(127)).vOut;
    const v128 = solveDac(codeToBits(128)).vOut;

    const expectedLsb = V_REF / 256;
    expect(v1 - v0).toBeCloseTo(expectedLsb, 3);
    expect(v2 - v1).toBeCloseTo(expectedLsb, 3);
    expect(v128 - v127).toBeCloseTo(expectedLsb, 3);
  });

  it("3.3V CMOS driving 5V VREF  default thresholds detect HIGH correctly", () => {
    // Default vIH=2.0V. CMOS 3.3V gates output vOH=3.3V.
    // 3.3V > 2.0V → all bits read as HIGH → full-scale output.
    const allHigh = Array(BITS).fill(true);
    const { converged, vOut } = solveDac(allHigh, 5.0, 3.3);

    expect(converged).toBe(true);
    expect(vOut).toBeCloseTo(V_REF * 255 / 256, 2);
  });

  it("3.3V CMOS driving 5V VREF  LOW correctly detected", () => {
    // 0V < vIL=0.8V → all bits read as LOW → output 0V.
    const allLow = Array(BITS).fill(false);
    const { converged, vOut } = solveDac(allLow, 5.0, 0.0);

    expect(converged).toBe(true);
    expect(vOut).toBeCloseTo(0, 4);
  });

  it("voltage between thresholds reads as LOW (indeterminate → 0)", () => {
    // Drive all bits at 1.5V — between vIL=0.8V and vIH=2.0V.
    // Indeterminate is treated as LOW by the DAC → code=0 → output 0V.
    const allHigh = Array(BITS).fill(true);
    const { converged, vOut } = solveDac(allHigh, 5.0, 1.5);

    expect(converged).toBe(true);
    expect(vOut).toBeCloseTo(0, 4);
  });

  it("custom vIH/vIL thresholds are respected", () => {
    // Set vIH=4.0V. Drive at 3.3V → below threshold → reads as indeterminate → LOW.
    const allHigh = Array(BITS).fill(true);
    const { converged, vOut } = solveDac(allHigh, 5.0, 3.3, { vIH: 4.0, vIL: 2.0 });

    expect(converged).toBe(true);
    expect(vOut).toBeCloseTo(0, 4);
  });

  it("custom vIH/vIL  drive above custom threshold reads HIGH", () => {
    // Set vIH=1.0V, vIL=0.5V. Drive at 1.5V → above 1.0V → HIGH.
    const allHigh = Array(BITS).fill(true);
    const { converged, vOut } = solveDac(allHigh, 5.0, 1.5, { vIH: 1.0, vIL: 0.5 });

    expect(converged).toBe(true);
    expect(vOut).toBeCloseTo(V_REF * 255 / 256, 2);
  });

  it("output scales with VREF from wire", () => {
    // Same code (all HIGH), two different VREF values.
    // Output should scale proportionally.
    const allHigh = Array(BITS).fill(true);
    const { converged: c1, vOut: v5 } = solveDac(allHigh, 5.0);
    const { converged: c2, vOut: v33 } = solveDac(allHigh, 3.3);

    expect(c1).toBe(true);
    expect(c2).toBe(true);
    // ratio should be 3.3/5.0 ≈ 0.66
    expect(v33 / v5).toBeCloseTo(3.3 / 5.0, 2);
  });
});
