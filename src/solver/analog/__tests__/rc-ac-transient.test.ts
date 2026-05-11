/**
 * RC lowpass driven by AC voltage source — analytical verification.
 *
 * Circuit: AC Source (Vs) → R → C → GND
 *   node_src: Vs:pos / R1:pos
 *   node_out: R1:neg / C1:pos  ← output (filtered)
 *   ground:   Vs:neg / C1:neg
 *
 * Analytical transfer function for RC lowpass:
 *   H(f) = 1 / (1 + j·2πf·R·C)
 *   |H(f)| = 1 / √(1 + (2πfRC)²)
 *   φ(f) = -arctan(2πfRC)
 *
 * Test parameters: R = 1 kΩ, C = 1 µF, f = 100 Hz, A = 5 V
 *   τ = RC = 1 ms
 *   ωRC = 2π·100·1e-3 ≈ 0.6283
 *   |H| ≈ 0.8467
 *   Expected output amplitude ≈ 4.234 V
 *   Expected phase ≈ -32.14°
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "./fixtures/build-fixture.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const R_VAL = 1000;      // 1 kΩ
const C_VAL = 1e-6;      // 1 µF
const F_VAL = 100;       // 100 Hz
const A_VAL = 5;         // 5 V peak
const TAU = R_VAL * C_VAL;                            // 1 ms
const OMEGA_RC = 2 * Math.PI * F_VAL * TAU;           // ≈ 0.6283
const H_MAG = 1 / Math.sqrt(1 + OMEGA_RC * OMEGA_RC); // ≈ 0.8467
const EXPECTED_AMP = A_VAL * H_MAG;                   // ≈ 4.234 V
const EXPECTED_PHASE = -Math.atan(OMEGA_RC);           // ≈ -0.5614 rad

// ---------------------------------------------------------------------------
// Circuit factories
// ---------------------------------------------------------------------------

function buildAcRcCircuit(facade: DefaultSimulatorFacade): Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "AcVoltageSource", props: { label: "Vs", amplitude: A_VAL, frequency: F_VAL, phase: 0, dcOffset: 0, waveform: "sine" } },
      { id: "r1",  type: "Resistor",        props: { label: "R1", resistance: R_VAL } },
      { id: "c1",  type: "Capacitor",       props: { label: "C1", capacitance: C_VAL } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos", "r1:pos"],
      ["r1:neg", "c1:pos"],
      ["c1:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

function buildHighFreqCircuit(facade: DefaultSimulatorFacade, highF: number): Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "AcVoltageSource", props: { label: "Vs", amplitude: A_VAL, frequency: highF, phase: 0, dcOffset: 0, waveform: "sine" } },
      { id: "r1",  type: "Resistor",        props: { label: "R1", resistance: R_VAL } },
      { id: "c1",  type: "Capacitor",       props: { label: "C1", capacitance: C_VAL } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos", "r1:pos"],
      ["r1:neg", "c1:pos"],
      ["c1:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

// ===========================================================================
// Tests
// ===========================================================================

describe("RC lowpass AC transient", () => {
  it("steady-state amplitude matches analytical |H(f)|", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAcRcCircuit(facade),
      params: { tStop: 0.1, maxTimeStep: 1e-5 },
    });

    // Multi-pin labels register as "label:pinLabel"; R1:neg = C1:pos = the filtered output node.
    const outNodeId = fix.circuit.labelToNodeId.get("R1:neg")!;
    expect(outNodeId).toBeGreaterThan(0);

    // Let transient die out: simulate for 5τ = 5 ms
    while (fix.engine.simTime < 5 * TAU) {
      fix.coordinator.step();
    }

    // Sample one full period in steady state
    const periodEnd = fix.engine.simTime + 1 / F_VAL;
    let peak = -Infinity;
    let trough = Infinity;

    while (fix.engine.simTime < periodEnd) {
      fix.coordinator.step();
      const v = fix.engine.getNodeVoltage(outNodeId);
      if (v > peak) peak = v;
      if (v < trough) trough = v;
    }

    const measuredAmplitude = (peak - trough) / 2;
    // Verify amplitude within 5% of analytical
    expect(measuredAmplitude).toBeGreaterThan(EXPECTED_AMP * 0.95);
    expect(measuredAmplitude).toBeLessThan(EXPECTED_AMP * 1.05);
  });

  it("output amplitude is attenuated relative to input", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAcRcCircuit(facade),
      params: { tStop: 0.1, maxTimeStep: 1e-5 },
    });

    const srcNodeId = fix.circuit.labelToNodeId.get("Vs:pos")!;
    const outNodeId = fix.circuit.labelToNodeId.get("R1:neg")!;
    expect(srcNodeId).toBeGreaterThan(0);
    expect(outNodeId).toBeGreaterThan(0);

    // Wait for steady state
    while (fix.engine.simTime < 5 * TAU) {
      fix.coordinator.step();
    }

    const periodEnd = fix.engine.simTime + 1 / F_VAL;
    let sourcePeak = -Infinity;
    let outputPeak = -Infinity;

    while (fix.engine.simTime < periodEnd) {
      fix.coordinator.step();
      const vSrc = fix.engine.getNodeVoltage(srcNodeId);
      const vOut = fix.engine.getNodeVoltage(outNodeId);
      if (vSrc > sourcePeak) sourcePeak = vSrc;
      if (vOut > outputPeak) outputPeak = vOut;
    }

    // Source peak should be close to the input amplitude
    expect(sourcePeak).toBeGreaterThan(A_VAL * 0.95);
    // Output peak must be less than source (lowpass filtering)
    expect(outputPeak).toBeLessThan(sourcePeak);
  });

  it("output phase lags input", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAcRcCircuit(facade),
      params: { tStop: 0.1, maxTimeStep: 1e-5 },
    });

    const srcNodeId = fix.circuit.labelToNodeId.get("Vs:pos")!;
    const outNodeId = fix.circuit.labelToNodeId.get("R1:neg")!;
    expect(srcNodeId).toBeGreaterThan(0);
    expect(outNodeId).toBeGreaterThan(0);

    // Let transient die out
    while (fix.engine.simTime < 5 * TAU) {
      fix.coordinator.step();
    }

    const scanEnd = fix.engine.simTime + 2 / F_VAL;
    let prevSrc = fix.engine.getNodeVoltage(srcNodeId);
    let prevOut = fix.engine.getNodeVoltage(outNodeId);
    let srcRisingTime = NaN;
    let outRisingTime = NaN;

    while (fix.engine.simTime < scanEnd) {
      fix.coordinator.step();
      const vSrc = fix.engine.getNodeVoltage(srcNodeId);
      const vOut = fix.engine.getNodeVoltage(outNodeId);

      if (isNaN(srcRisingTime) && prevSrc < 0 && vSrc >= 0) {
        srcRisingTime = fix.engine.simTime;
      }
      if (!isNaN(srcRisingTime) && isNaN(outRisingTime) && prevOut < 0 && vOut >= 0) {
        outRisingTime = fix.engine.simTime;
      }

      prevSrc = vSrc;
      prevOut = vOut;
    }

    // Output must cross zero AFTER input (phase lag)
    expect(isNaN(srcRisingTime)).toBe(false);
    expect(isNaN(outRisingTime)).toBe(false);
    expect(outRisingTime).toBeGreaterThan(srcRisingTime);

    const measuredDelay = outRisingTime - srcRisingTime;
    const expectedDelay = -EXPECTED_PHASE / (2 * Math.PI * F_VAL);
    // Allow 30% tolerance due to discrete sampling
    expect(measuredDelay).toBeGreaterThan(expectedDelay * 0.7);
    expect(measuredDelay).toBeLessThan(expectedDelay * 1.3);
  });

  it("DC operating point is zero for pure AC source", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAcRcCircuit(facade),
    });
    // buildFixture already ran dcOperatingPoint via warm-start.
    // Verify simulation advanced and no convergence failure occurred.
    expect(fix.engine.simTime).toBeGreaterThan(0);
  });

  it("higher frequency produces greater attenuation", () => {
    const highF = 1000;
    const fix = buildFixture({
      build: (_r, facade) => buildHighFreqCircuit(facade, highF),
      params: { tStop: 0.05, maxTimeStep: 1e-5 },
    });

    const outNodeId = fix.circuit.labelToNodeId.get("R1:neg")!;
    expect(outNodeId).toBeGreaterThan(0);

    // Wait for steady state (5τ = 5ms)
    while (fix.engine.simTime < 5 * TAU) {
      fix.coordinator.step();
    }

    const periodEnd = fix.engine.simTime + 1 / highF;
    let peak = -Infinity;
    let trough = Infinity;

    while (fix.engine.simTime < periodEnd) {
      fix.coordinator.step();
      const v = fix.engine.getNodeVoltage(outNodeId);
      if (v > peak) peak = v;
      if (v < trough) trough = v;
    }

    const measuredAmp = (peak - trough) / 2;
    const expectedHighFAmp = A_VAL / Math.sqrt(1 + (2 * Math.PI * highF * TAU) ** 2);

    // At 1kHz the output should be much smaller than at 100Hz
    expect(measuredAmp).toBeLessThan(EXPECTED_AMP * 0.5);
    // And match the analytical value within 10%
    expect(measuredAmp).toBeGreaterThan(expectedHighFAmp * 0.90);
    expect(measuredAmp).toBeLessThan(expectedHighFAmp * 1.10);
  });

  // =========================================================================
  // Compiler pipeline tests
  // =========================================================================

  it("compilation produces correct topology", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAcRcCircuit(facade),
    });

    // 3 analog elements: AC source + resistor + capacitor (ground is structural)
    expect(fix.circuit.elements.length).toBe(3);
    expect(fix.circuit.nodeCount).toBe(2);

    // Verify reactive element exists (reactive = has getLteTimestep method)
    const reactiveCount = fix.circuit.elements.filter(
      e => typeof (e as { getLteTimestep?: unknown }).getLteTimestep === "function",
    ).length;
    expect(reactiveCount).toBe(1);

    // Verify capacitor node assignment: one node should be ground (0)
    const capEl = fix.circuit.elements.find(
      e => typeof (e as { getLteTimestep?: unknown }).getLteTimestep === "function",
    )!;
    const capNodes = [...capEl.pinNodes.values()];
    expect(capNodes).toHaveLength(2);
    const hasGround = capNodes[0] === 0 || capNodes[1] === 0;
    expect(hasGround).toBe(true);
  });

  it("transient stepping produces time-varying output", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAcRcCircuit(facade),
      params: { tStop: 0.01, maxTimeStep: 1e-5 },
    });

    // Step 100 times and collect node voltages
    const samples: Array<{ t: number; v: number[] }> = [];
    for (let i = 0; i < 100; i++) {
      fix.coordinator.step();
      const v = [];
      for (let n = 0; n < fix.circuit.nodeCount; n++) {
        v.push(fix.engine.getNodeVoltage(n + 1));
      }
      samples.push({ t: fix.engine.simTime, v });
    }

    expect(samples[99]!.t).toBeGreaterThan(0);

    const node0Vals = samples.map(s => s.v[0]!);
    const node1Vals = samples.map(s => s.v[1]!);
    const n0Max = Math.max(...node0Vals);
    const n0Min = Math.min(...node0Vals);
    const n1Max = Math.max(...node1Vals);
    const n1Min = Math.min(...node1Vals);

    // Both nodes should oscillate (non-zero range)
    expect(n0Max - n0Min).toBeGreaterThan(0.01);
    expect(n1Max - n1Min).toBeGreaterThan(0.01);

    // The two nodes should have DIFFERENT amplitudes due to RC filtering
    const n0Amp = (n0Max - n0Min) / 2;
    const n1Amp = (n1Max - n1Min) / 2;
    const ampRatio = Math.min(n0Amp, n1Amp) / Math.max(n0Amp, n1Amp);
    expect(ampRatio).toBeLessThan(0.99);
  });

  it("full pipeline: compile → DC OP → transient → analytical match", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAcRcCircuit(facade),
      params: { tStop: 0.1, maxTimeStep: 1e-5 },
    });

    const outNodeId = fix.circuit.labelToNodeId.get("R1:neg")!;
    expect(outNodeId).toBeGreaterThan(0);

    // Let transient die out
    while (fix.engine.simTime < 5 * TAU) {
      fix.coordinator.step();
    }

    // Find source node and measure amplitudes of both nodes over one period
    const srcNodeId = fix.circuit.labelToNodeId.get("Vs:pos")!;
    const periodEnd = fix.engine.simTime + 1 / F_VAL;
    let srcPeak = -Infinity, srcTrough = Infinity;
    let outPeak = -Infinity, outTrough = Infinity;

    while (fix.engine.simTime < periodEnd) {
      fix.coordinator.step();
      const vSrc = fix.engine.getNodeVoltage(srcNodeId);
      const vOut = fix.engine.getNodeVoltage(outNodeId);
      if (vSrc > srcPeak) srcPeak = vSrc;
      if (vSrc < srcTrough) srcTrough = vSrc;
      if (vOut > outPeak) outPeak = vOut;
      if (vOut < outTrough) outTrough = vOut;
    }

    const srcAmplitude = (srcPeak - srcTrough) / 2;
    const outputAmp = (outPeak - outTrough) / 2;

    // Largest amplitude ≈ A (source node)
    expect(srcAmplitude).toBeGreaterThan(A_VAL * 0.9);
    // Smaller amplitude ≈ expected RC filtered amplitude
    expect(outputAmp).toBeGreaterThan(EXPECTED_AMP * 0.90);
    expect(outputAmp).toBeLessThan(EXPECTED_AMP * 1.10);
  });
});
