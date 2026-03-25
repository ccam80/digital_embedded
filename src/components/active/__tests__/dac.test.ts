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
import { DACDefinition } from "../dac.js";
import { PropertyBag } from "../../../core/properties.js";
import { withNodeIds } from "../../../analog/test-elements.js";
import { SparseSolver } from "../../../analog/sparse-solver.js";
import { DiagnosticCollector } from "../../../analog/diagnostics.js";
import { solveDcOperatingPoint } from "../../../analog/dc-operating-point.js";
import { DEFAULT_SIMULATION_PARAMS } from "../../../core/analog-engine-interface.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import type { AnalogElement } from "../../../analog/element.js";

// ---------------------------------------------------------------------------
// Circuit builder helpers
// ---------------------------------------------------------------------------

const BITS = 8;
const V_REF = 5.0;
const MAX_CODE = Math.pow(2, BITS); // 256

/**
 * Build a full 8-bit DAC test circuit and solve the DC operating point.
 *
 * @param inputBits  Array of BITS boolean values (true=HIGH, false=LOW)
 * @param vRef       Reference voltage (default V_REF)
 * @returns  { converged, vOut }
 */
function solveDac(
  inputBits: boolean[],
  vRef: number = V_REF,
): { converged: boolean; vOut: number } {
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
    ["vRef",  vRef],
    ["mode",  "unipolar"],
    ["rOut",  100],
  ]);

  const dacPinNodeIds: number[] = [];
  for (let i = 0; i < BITS; i++) dacPinNodeIds.push(i + 1);  // D0=1..D7=8
  dacPinNodeIds.push(nVRefNode);  // VREF
  dacPinNodeIds.push(nOutNode);   // OUT
  dacPinNodeIds.push(0);          // GND
  const dacEl = withNodeIds(
    DACDefinition.models!.analog!.factory(dacPinNodes, [], -1, props, () => 0),
    dacPinNodeIds,
  );

  // Digital input voltage sources: HIGH = vRef, LOW = 0
  const elements: AnalogElement[] = [dacEl];
  for (let i = 0; i < BITS; i++) {
    const nDi = i + 1;  // node for Di
    const branchRow = nNodes + i;  // branch rows start after node rows
    const vHigh = inputBits[i] ? vRef : 0.0;
    elements.push(makeDcVoltageSource(nDi, 0, branchRow, vHigh));
  }

  // VREF voltage source
  const vRefBranchRow = nNodes + BITS;
  elements.push(makeDcVoltageSource(nVRefNode, 0, vRefBranchRow, vRef));

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
      expect(voltages[i]).toBeGreaterThan(voltages[i - 1]);
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
});
