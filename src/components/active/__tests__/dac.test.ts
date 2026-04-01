/**
 * Tests for the DAC (Digital-to-Analog Converter) component.
 *
 * The DAC converts an N-bit digital input code to an analog output voltage:
 *   V_out = V_ref · code / 2^N  (unipolar)
 *
 * All tests use the DC operating point solver with:
 *   - A voltage source on each digital input to set its logic level
 *   - A voltage source on VREF
 *   - GND tied to MNA ground (node 0)
 *   - The DAC's OUT node voltage read from the solution
 *
 * Node assignment for an 8-bit DAC test circuit:
 *   Nodes 1..8:  D0..D7 (one node per digital input bit)
 *   Node 9:      VREF
 *   Node 10:     OUT
 *   GND:         node 0 (MNA ground, implicit)
 *
 * nodeIds passed to analogFactory: [1,2,3,4,5,6,7,8, 9, 10, 0]
 *
 * Branch rows start at node count (10) and go up.
 * Each bit VS has one branch row, VREF has one branch row.
 * For N=8 bits: 9 voltage sources → 9 branch rows (10..18) → matrixSize = 19.
 */

import { describe, it, expect } from "vitest";
import { DACDefinition, DAC_DEFAULTS } from "../dac.js";
import { PropertyBag } from "../../../core/properties.js";
import { withNodeIds } from "../../../solver/analog/__tests__/test-helpers.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { DiagnosticCollector } from "../../../solver/analog/diagnostics.js";
import { solveDcOperatingPoint } from "../../../solver/analog/dc-operating-point.js";
import { DEFAULT_SIMULATION_PARAMS } from "../../../core/analog-engine-interface.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
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
// Circuit builder helpers
// ---------------------------------------------------------------------------

const BITS = 8;
const V_REF = 5.0;
const MAX_CODE = Math.pow(2, BITS); // 256

/**
 * Build a full 8-bit DAC test circuit and solve the DC operating point.
 *
 * @param inputBits    Array of BITS boolean values (true=HIGH, false=LOW)
 * @param vRef         Reference voltage (default V_REF)
 * @param vHigh        Voltage driven for a HIGH bit (default vRef)
 * @param paramOverrides  Model param overrides (merged with DAC_DEFAULTS)
 * @returns  { converged, vOut }
 */
function solveDac(
  inputBits: boolean[],
  vRef: number = V_REF,
  vHigh?: number,
  paramOverrides?: Record<string, number>,
): { converged: boolean; vOut: number } {
  const driveHigh = vHigh ?? vRef;

  // Node layout:
  //   nodes 1..BITS  → digital input nodes D0..D(BITS-1)
  //   node BITS+1    → VREF node
  //   node BITS+2    → OUT node
  //   node 0         → GND (implicit MNA ground)
  //
  // Voltage sources:
  //   branchRows BITS+2 .. 2*BITS+1  → one per digital input (BITS sources)
  //   branchRow  2*BITS+2            → VREF source
  //
  // matrixSize = numNodes + numBranches = (BITS+2) + (BITS+1)

  const nNodes = BITS + 2;
  const nVRefNode = BITS + 1;
  const nOutNode  = BITS + 2;

  const nBranches = BITS + 1;  // BITS digital input VSes + 1 VREF VS
  const matrixSize = nNodes + nBranches;

  // Build pinNodes Map for DAC: D0..D7, VREF, OUT, GND
  const dacPinNodes = new Map<string, number>();
  for (let i = 0; i < BITS; i++) dacPinNodes.set(`D${i}`, i + 1);  // D0=1, D1=2, ... D7=8
  dacPinNodes.set("VREF", nVRefNode);   // VREF = node 9
  dacPinNodes.set("OUT",  nOutNode);    // OUT  = node 10
  dacPinNodes.set("GND",  0);           // GND  = node 0 (MNA ground)

  const props = new PropertyBag([
    ["bits",  BITS],
    ["model", "unipolar"],
  ]);
  props.replaceModelParams({ ...DAC_DEFAULTS, ...paramOverrides });

  const dacPinNodeIds: number[] = [];
  for (let i = 0; i < BITS; i++) dacPinNodeIds.push(i + 1);  // D0=1..D7=8
  dacPinNodeIds.push(nVRefNode);  // VREF
  dacPinNodeIds.push(nOutNode);   // OUT
  dacPinNodeIds.push(0);          // GND
  const dacEl = withNodeIds(
    getFactory(DACDefinition.modelRegistry!["unipolar"]!)(dacPinNodes, [], -1, props, () => 0),
    dacPinNodeIds,
  );

  // Digital input voltage sources: HIGH = driveHigh, LOW = 0
  const elements: AnalogElement[] = [dacEl];
  for (let i = 0; i < BITS; i++) {
    const nDi = i + 1;  // node for Di
    const branchRow = nNodes + i;  // branch rows start after node rows
    const v = inputBits[i] ? driveHigh : 0.0;
    elements.push(makeDcVoltageSource(nDi, 0, branchRow, v) as unknown as AnalogElement);
  }

  // VREF voltage source
  const vRefBranchRow = nNodes + BITS;
  elements.push(makeDcVoltageSource(nVRefNode, 0, vRefBranchRow, vRef) as unknown as AnalogElement);

  const solver = new SparseSolver();
  const diagnostics = new DiagnosticCollector();
  const result = solveDcOperatingPoint({
    solver,
    elements,
    matrixSize,
    params: DEFAULT_SIMULATION_PARAMS,
    diagnostics,
  });

  return {
    converged: result.converged,
    vOut: result.nodeVoltages[nOutNode - 1],
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
    const expected = V_REF * (MAX_CODE - 1) / MAX_CODE;
    expect(vOut).toBeCloseTo(expected, 3);
  });

  it("zero_code", () => {
    // All inputs LOW: code = 0 → V_out = 0V
    const allLow = Array(BITS).fill(false);
    const { converged, vOut } = solveDac(allLow);

    expect(converged).toBe(true);
    expect(vOut).toBeCloseTo(0.0, 4);
  });

  it("midscale", () => {
    // MSB (D7) = 1, rest = 0: code = 128 (0b10000000)
    // V_out = V_ref · 128/256 = V_ref / 2 = 2.5 V
    const bits = Array(BITS).fill(false);
    bits[BITS - 1] = true;  // D7 = MSB = 1
    const { converged, vOut } = solveDac(bits);

    expect(converged).toBe(true);
    const expected = V_REF / 2;
    expect(vOut).toBeCloseTo(expected, 3);
  });

  it("monotonic_ramp", () => {
    // Increment code from 0 to 255; assert V_out increases monotonically.
    // We test every 16th step to keep the test fast (0, 16, 32, ..., 255).
    const voltages: number[] = [];
    const steps = [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 255];

    for (const code of steps) {
      const { converged, vOut } = solveDac(codeToBits(code));
      expect(converged).toBe(true);
      voltages.push(vOut);
    }

    // Assert monotonically increasing
    for (let i = 1; i < voltages.length; i++) {
      expect(voltages[i]).toBeGreaterThan(voltages[i - 1]!);
    }
  });

  it("lsb_step_size", () => {
    // LSB step size = V_ref / 2^N = 5.0 / 256 ≈ 0.019531 V
    // Test: code=1 vs code=0, code=2 vs code=1, code=128 vs code=127
    const expectedLsb = V_REF / MAX_CODE;

    const { vOut: v0 } = solveDac(codeToBits(0));
    const { vOut: v1 } = solveDac(codeToBits(1));
    const { vOut: v2 } = solveDac(codeToBits(2));
    const { vOut: v127 } = solveDac(codeToBits(127));
    const { vOut: v128 } = solveDac(codeToBits(128));

    // Each step should equal expectedLsb within 1% tolerance
    expect(v1 - v0).toBeCloseTo(expectedLsb, 4);
    expect(v2 - v1).toBeCloseTo(expectedLsb, 4);
    expect(v128 - v127).toBeCloseTo(expectedLsb, 4);
  });

  it("3.3V CMOS driving 5V VREF — default thresholds detect HIGH correctly", () => {
    // Default vIH=2.0V. CMOS 3.3V gates output vOH=3.3V.
    // 3.3V > 2.0V → all bits read as HIGH → full-scale output.
    const allHigh = Array(BITS).fill(true);
    const { converged, vOut } = solveDac(allHigh, 5.0, 3.3);

    expect(converged).toBe(true);
    const expected = 5.0 * (MAX_CODE - 1) / MAX_CODE;
    expect(vOut).toBeCloseTo(expected, 3);
  });

  it("3.3V CMOS driving 5V VREF — LOW correctly detected", () => {
    // 0V < vIL=0.8V → all bits read as LOW → output 0V.
    const allLow = Array(BITS).fill(false);
    const { converged, vOut } = solveDac(allLow, 5.0, 0.0);

    expect(converged).toBe(true);
    expect(vOut).toBeCloseTo(0.0, 4);
  });

  it("voltage between thresholds reads as LOW (indeterminate → 0)", () => {
    // Drive all bits at 1.5V — between vIL=0.8V and vIH=2.0V.
    // Indeterminate is treated as LOW by the DAC → code=0 → output 0V.
    const allHigh = Array(BITS).fill(true);
    const { converged, vOut } = solveDac(allHigh, 5.0, 1.5);

    expect(converged).toBe(true);
    expect(vOut).toBeCloseTo(0.0, 4);
  });

  it("custom vIH/vIL thresholds are respected", () => {
    // Set vIH=4.0V. Drive at 3.3V → below threshold → reads as indeterminate → LOW.
    const allHigh = Array(BITS).fill(true);
    const { converged, vOut } = solveDac(allHigh, 5.0, 3.3, { vIH: 4.0, vIL: 2.0 });

    expect(converged).toBe(true);
    expect(vOut).toBeCloseTo(0.0, 4);
  });

  it("custom vIH/vIL — drive above custom threshold reads HIGH", () => {
    // Set vIH=1.0V, vIL=0.5V. Drive at 1.5V → above 1.0V → HIGH.
    const allHigh = Array(BITS).fill(true);
    const { converged, vOut } = solveDac(allHigh, 5.0, 1.5, { vIH: 1.0, vIL: 0.5 });

    expect(converged).toBe(true);
    const expected = 5.0 * (MAX_CODE - 1) / MAX_CODE;
    expect(vOut).toBeCloseTo(expected, 3);
  });

  it("output scales with VREF from wire", () => {
    // Same code (all HIGH), two different VREF values.
    // Output should scale proportionally.
    const allHigh = Array(BITS).fill(true);
    const { vOut: v5 } = solveDac(allHigh, 5.0);
    const { vOut: v3 } = solveDac(allHigh, 3.3);

    const scale = (MAX_CODE - 1) / MAX_CODE;
    expect(v5).toBeCloseTo(5.0 * scale, 3);
    expect(v3).toBeCloseTo(3.3 * scale, 3);
  });
});
