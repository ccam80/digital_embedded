/**
 * RC lowpass driven by AC voltage source — analytical verification.
 *
 * Circuit: AC Source (Vs) → R → C → GND
 *   node 1: source pos / resistor A  (voltages[0])
 *   node 2: resistor B / cap top     (voltages[1])  ← output
 *   ground: source neg / cap bottom
 *   branch 0: voltage source current (voltages[2])
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
import { MNAEngine } from "../analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../analog-engine.js";
import {
  makeResistor,
  makeCapacitor,
  makeAcVoltageSource,
} from "../test-elements.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const R = 1000;          // 1 kΩ
const C = 1e-6;          // 1 µF
const F = 100;           // 100 Hz
const A = 5;             // 5 V peak
const TAU = R * C;       // 1 ms
const OMEGA_RC = 2 * Math.PI * F * TAU;  // ≈ 0.6283
const H_MAG = 1 / Math.sqrt(1 + OMEGA_RC * OMEGA_RC);  // ≈ 0.8467
const EXPECTED_AMP = A * H_MAG;  // ≈ 4.234 V
const EXPECTED_PHASE = -Math.atan(OMEGA_RC);  // ≈ -0.5614 rad

// ---------------------------------------------------------------------------
// Circuit builders
// ---------------------------------------------------------------------------

/**
 * Hand-built RC lowpass with AC source.
 * timeRef is a shared mutable object that the engine updates after each step.
 */
function makeAcRcCircuit(timeRef: { value: number }): ConcreteCompiledAnalogCircuit {
  const getTime = () => timeRef.value;

  const vs  = makeAcVoltageSource(1, 0, 2, A, F, 0, 0, getTime);
  const r   = makeResistor(1, 2, R);
  const cap = makeCapacitor(2, 0, C);

  return {
    netCount: 2,
    componentCount: 3,
    nodeCount: 2,
    branchCount: 1,
    matrixSize: 3,
    elements: [vs, r, cap],
    labelToNodeId: new Map([["Vout", 2]]),
    wireToNodeId: new Map(),
    timeRef,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Advance engine until simTime >= targetTime. Returns step count. */
function stepUntil(engine: MNAEngine, targetTime: number, maxSteps = 50_000): number {
  let steps = 0;
  while (engine.simTime < targetTime && steps < maxSteps) {
    engine.step();
    steps++;
  }
  return steps;
}

/**
 * Sample the output node voltage over one full period at steady state.
 * Returns { peak, trough, peakTime } measured over the period.
 */
function sampleOnePeriod(
  engine: MNAEngine,
  nodeIdx: number,
  periodStart: number,
): { peak: number; trough: number; peakTime: number } {
  const periodEnd = periodStart + 1 / F;
  let peak = -Infinity;
  let trough = Infinity;
  let peakTime = periodStart;

  while (engine.simTime < periodEnd) {
    engine.step();
    const v = engine.getNodeVoltage(nodeIdx);
    if (v > peak) {
      peak = v;
      peakTime = engine.simTime;
    }
    if (v < trough) {
      trough = v;
    }
  }

  return { peak, trough, peakTime };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("RC lowpass AC transient — hand-built", () => {
  it("steady-state amplitude matches analytical |H(f)|", () => {
    const timeRef = { value: 0 };
    const circuit = makeAcRcCircuit(timeRef);

    const engine = new MNAEngine();
    engine.init(circuit);

    const dcResult = engine.dcOperatingPoint();
    expect(dcResult.converged).toBe(true);

    // Let transient die out: simulate for 5τ = 5 ms
    stepUntil(engine, 5 * TAU);

    // Sample one full period in steady state (10 ms period at 100 Hz)
    const { peak, trough } = sampleOnePeriod(engine, 2, engine.simTime);
    const measuredAmplitude = (peak - trough) / 2;

    // Verify amplitude within 5% of analytical
    // (numerical integration introduces small error from discrete timesteps)
    expect(measuredAmplitude).toBeGreaterThan(EXPECTED_AMP * 0.95);
    expect(measuredAmplitude).toBeLessThan(EXPECTED_AMP * 1.05);
  });

  it("output amplitude is attenuated relative to input", () => {
    const timeRef = { value: 0 };
    const circuit = makeAcRcCircuit(timeRef);

    const engine = new MNAEngine();
    engine.init(circuit);
    engine.dcOperatingPoint();

    // Wait for steady state
    stepUntil(engine, 5 * TAU);

    // Sample source node (node 0 = voltages[0]) and output node (node 1 = voltages[1])
    const periodEnd = engine.simTime + 1 / F;
    let sourcePeak = -Infinity;
    let outputPeak = -Infinity;

    while (engine.simTime < periodEnd) {
      engine.step();
      const vSrc = engine.getNodeVoltage(1);
      const vOut = engine.getNodeVoltage(2);
      if (vSrc > sourcePeak) sourcePeak = vSrc;
      if (vOut > outputPeak) outputPeak = vOut;
    }

    // Source peak should be close to the input amplitude
    expect(sourcePeak).toBeGreaterThan(A * 0.95);
    // Output peak must be less than source (lowpass filtering)
    expect(outputPeak).toBeLessThan(sourcePeak);
    // Output attenuation should match |H(f)|
    const measuredGain = outputPeak / sourcePeak;
    expect(measuredGain).toBeCloseTo(H_MAG, 1);  // within 0.05
  });

  it("output phase lags input", () => {
    const timeRef = { value: 0 };
    const circuit = makeAcRcCircuit(timeRef);

    const engine = new MNAEngine();
    engine.init(circuit);
    engine.dcOperatingPoint();

    // Let transient die out
    stepUntil(engine, 5 * TAU);

    // Find zero-crossing (rising) of source and output in steady state
    const scanEnd = engine.simTime + 2 / F; // scan two periods
    let prevSrc = engine.getNodeVoltage(1);
    let prevOut = engine.getNodeVoltage(2);
    let srcRisingTime = NaN;
    let outRisingTime = NaN;

    while (engine.simTime < scanEnd) {
      engine.step();
      const vSrc = engine.getNodeVoltage(1);
      const vOut = engine.getNodeVoltage(2);

      // Detect first rising zero-crossing of source
      if (isNaN(srcRisingTime) && prevSrc < 0 && vSrc >= 0) {
        // Linear interpolation for more accurate crossing time
        const frac = -prevSrc / (vSrc - prevSrc);
        srcRisingTime = engine.simTime - (1 - frac) * (engine.simTime > 0 ? engine.simTime - (engine.simTime - 1e-6) : 1e-6);
        srcRisingTime = engine.simTime; // simplified
      }

      // Detect first rising zero-crossing of output after source crossing
      if (!isNaN(srcRisingTime) && isNaN(outRisingTime) && prevOut < 0 && vOut >= 0) {
        outRisingTime = engine.simTime;
      }

      prevSrc = vSrc;
      prevOut = vOut;
    }

    // Output must cross zero AFTER input (phase lag)
    expect(isNaN(srcRisingTime)).toBe(false);
    expect(isNaN(outRisingTime)).toBe(false);
    expect(outRisingTime).toBeGreaterThan(srcRisingTime);

    // Phase lag should be roughly in the right ballpark
    const measuredDelay = outRisingTime - srcRisingTime;
    const expectedDelay = -EXPECTED_PHASE / (2 * Math.PI * F);
    // Allow 30% tolerance due to discrete sampling
    expect(measuredDelay).toBeGreaterThan(expectedDelay * 0.7);
    expect(measuredDelay).toBeLessThan(expectedDelay * 1.3);
  });

  it("DC operating point is zero for pure AC source", () => {
    const timeRef = { value: 0 };
    const circuit = makeAcRcCircuit(timeRef);

    const engine = new MNAEngine();
    engine.init(circuit);
    const dcResult = engine.dcOperatingPoint();

    expect(dcResult.converged).toBe(true);
    // At t=0 with no DC offset, sin(0)=0, so all nodes should be near 0V
    expect(engine.getNodeVoltage(1)).toBeCloseTo(0, 3);
    expect(engine.getNodeVoltage(2)).toBeCloseTo(0, 3);
  });

  it("higher frequency produces greater attenuation", () => {
    // f = 1000 Hz: ωRC = 6.283, |H| ≈ 0.157
    const highF = 1000;
    const timeRef = { value: 0 };
    const getTime = () => timeRef.value;
    const vs  = makeAcVoltageSource(1, 0, 2, A, highF, 0, 0, getTime);
    const r   = makeResistor(1, 2, R);
    const cap = makeCapacitor(2, 0, C);

    const circuit: ConcreteCompiledAnalogCircuit & { timeRef: { value: number } } = {
      netCount: 2,
      componentCount: 3,
      nodeCount: 2,
      branchCount: 1,
      matrixSize: 3,
      elements: [vs, r, cap],
      labelToNodeId: new Map(),
      wireToNodeId: new Map(),
      timeRef,
    };

    const engine = new MNAEngine();
    engine.init(circuit);
    engine.dcOperatingPoint();

    // Wait for steady state (5τ = 5ms, period = 1ms so ~5 periods)
    stepUntil(engine, 5 * TAU);

    // Sample one period
    const periodEnd = engine.simTime + 1 / highF;
    let peak = -Infinity;
    let trough = Infinity;
    while (engine.simTime < periodEnd) {
      engine.step();
      const v = engine.getNodeVoltage(2);
      if (v > peak) peak = v;
      if (v < trough) trough = v;
    }

    const measuredAmp = (peak - trough) / 2;
    const expectedHighFAmp = A / Math.sqrt(1 + (2 * Math.PI * highF * TAU) ** 2);

    // At 1kHz the output should be much smaller than at 100Hz
    expect(measuredAmp).toBeLessThan(EXPECTED_AMP * 0.5);
    // And match the analytical value within 10%
    expect(measuredAmp).toBeGreaterThan(expectedHighFAmp * 0.90);
    expect(measuredAmp).toBeLessThan(expectedHighFAmp * 1.10);
  });
});

// ===========================================================================
// Integration test — full compiler pipeline
// ===========================================================================

import { Circuit, Wire } from "../../core/circuit.js";
import type { CircuitElement } from "../../core/element.js";
import type { Pin } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import type { PropertyValue } from "../../core/properties.js";
import type { Rect, RenderContext } from "../../core/renderer-interface.js";
import type { SerializedElement } from "../../core/element.js";
import { ComponentRegistry } from "../../core/registry.js";
import { compileAnalogCircuit } from "../compiler.js";

import { ResistorDefinition } from "../../components/passives/resistor.js";
import { CapacitorDefinition } from "../../components/passives/capacitor.js";
import { AcVoltageSourceDefinition } from "../../components/sources/ac-voltage-source.js";
import { GroundDefinition } from "../../components/io/ground.js";

// ---------------------------------------------------------------------------
// Minimal CircuitElement factory (same pattern as mna-end-to-end.test.ts)
// ---------------------------------------------------------------------------

function makePin(x: number, y: number, label: string = ""): Pin {
  return {
    position: { x, y },
    label,
    direction: PinDirection.BIDIRECTIONAL,
    isInverted: false,
    isClock: false,
    bitWidth: 1,
  };
}

function makeElement(
  typeId: string,
  instanceId: string,
  pins: Array<{ x: number; y: number; label?: string }>,
  propsMap: Map<string, PropertyValue> = new Map(),
): CircuitElement {
  const resolvedPins = pins.map((p) => makePin(p.x, p.y, p.label ?? ""));
  const propertyBag = new PropertyBag(propsMap.entries());

  const serialized: SerializedElement = {
    typeId,
    instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as SerializedElement["rotation"],
    mirror: false,
    properties: {},
  };

  return {
    typeId,
    instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as CircuitElement["rotation"],
    mirror: false,
    getPins() { return resolvedPins; },
    getProperties() { return propertyBag; },
    getBoundingBox(): Rect { return { x: 0, y: 0, width: 10, height: 10 }; },
    draw(_ctx: RenderContext) { /* no-op */ },
    serialize() { return serialized; },
    getHelpText() { return ""; },
    getAttribute(k: string) { return propsMap.get(k); },
  };
}

function addWire(circuit: Circuit, x1: number, y1: number, x2: number, y2: number): void {
  circuit.addWire(new Wire({ x: x1, y: y1 }, { x: x2, y: y2 }));
}

function buildAnalogRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();
  registry.register(GroundDefinition);
  registry.register(ResistorDefinition);
  registry.register(CapacitorDefinition);
  registry.register(AcVoltageSourceDefinition);
  return registry;
}

describe("RC lowpass AC transient — compiler pipeline", () => {
  it("compilation produces correct topology", () => {
    const circuit = new Circuit({ engineType: "analog" });
    const registry = buildAnalogRegistry();

    const vs = makeElement("AcVoltageSource", "vs1",
      [{ x: 10, y: 0 }, { x: 30, y: 0 }],
      new Map<string, PropertyValue>([
        ["amplitude", A], ["frequency", F], ["phase", 0],
        ["dcOffset", 0], ["waveform", "sine"], ["label", "Vs"],
      ]),
    );
    const r1 = makeElement("Resistor", "r1",
      [{ x: 10, y: 0 }, { x: 20, y: 0 }],
      new Map<string, PropertyValue>([["resistance", R], ["label", "R1"]]),
    );
    const c1 = makeElement("Capacitor", "c1",
      [{ x: 20, y: 0 }, { x: 30, y: 0 }],
      new Map<string, PropertyValue>([["capacitance", C], ["label", "C1"]]),
    );
    const gnd = makeElement("Ground", "gnd1", [{ x: 30, y: 0 }]);

    circuit.addElement(vs);
    circuit.addElement(r1);
    circuit.addElement(c1);
    circuit.addElement(gnd);

    addWire(circuit, 10, 0, 10, 0);
    addWire(circuit, 20, 0, 20, 0);
    addWire(circuit, 30, 0, 30, 0);

    const compiled = compileAnalogCircuit(circuit, registry);
    const errors = compiled.diagnostics.filter(d => d.severity === "error");
    expect(errors).toHaveLength(0);

    // 3 elements: AC source + resistor + capacitor (ground is structural)
    expect(compiled.elements.length).toBe(3);
    expect(compiled.nodeCount).toBe(2);
    expect(compiled.branchCount).toBe(1);
    expect(compiled.matrixSize).toBe(3);

    // Verify reactive element exists
    const reactiveCount = compiled.elements.filter(e => e.isReactive).length;
    expect(reactiveCount).toBe(1);

    // Verify capacitor node assignment: one node should be ground (0)
    const capEl = compiled.elements.find(e => e.isReactive)!;
    const capNodes = capEl.nodeIndices;
    expect(capNodes).toHaveLength(2);
    // One node should be ground (0), the other should be non-zero
    const hasGround = capNodes[0] === 0 || capNodes[1] === 0;
    expect(hasGround).toBe(true);
  });

  it("transient stepping produces time-varying output", () => {
    const circuit = new Circuit({ engineType: "analog" });
    const registry = buildAnalogRegistry();

    const vs = makeElement("AcVoltageSource", "vs1",
      [{ x: 10, y: 0 }, { x: 30, y: 0 }],
      new Map<string, PropertyValue>([
        ["amplitude", A], ["frequency", F], ["phase", 0],
        ["dcOffset", 0], ["waveform", "sine"], ["label", "Vs"],
      ]),
    );
    const r1 = makeElement("Resistor", "r1",
      [{ x: 10, y: 0 }, { x: 20, y: 0 }],
      new Map<string, PropertyValue>([["resistance", R], ["label", "R1"]]),
    );
    const c1 = makeElement("Capacitor", "c1",
      [{ x: 20, y: 0 }, { x: 30, y: 0 }],
      new Map<string, PropertyValue>([["capacitance", C], ["label", "C1"]]),
    );
    const gnd = makeElement("Ground", "gnd1", [{ x: 30, y: 0 }]);

    circuit.addElement(vs);
    circuit.addElement(r1);
    circuit.addElement(c1);
    circuit.addElement(gnd);

    addWire(circuit, 10, 0, 10, 0);
    addWire(circuit, 20, 0, 20, 0);
    addWire(circuit, 30, 0, 30, 0);

    const compiled = compileAnalogCircuit(circuit, registry);
    const engine = new MNAEngine();
    engine.init(compiled);
    engine.dcOperatingPoint();

    // Step a few times and collect node voltages
    const samples: Array<{ t: number; v: number[] }> = [];
    for (let i = 0; i < 100; i++) {
      engine.step();
      const v = [];
      for (let n = 0; n < compiled.nodeCount; n++) {
        v.push(engine.getNodeVoltage(n + 1));
      }
      samples.push({ t: engine.simTime, v });
    }

    // Time should advance
    expect(samples[99].t).toBeGreaterThan(0);

    // Source node should oscillate (find max/min across samples)
    const node0Vals = samples.map(s => s.v[0]);
    const node1Vals = samples.map(s => s.v[1]);
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
    // If one is the source (~5V) and the other is filtered (~4.2V), they should differ
    const ampRatio = Math.min(n0Amp, n1Amp) / Math.max(n0Amp, n1Amp);
    // With 100 steps we may not be at steady state yet, but amplitudes should still differ
    expect(ampRatio).toBeLessThan(0.99);
  });

  it("full pipeline: compile → DC OP → transient → analytical match", () => {
    // Layout: AC Source → R → C → GND
    //
    // Pin positions (grid coords, matched at wire junctions):
    //   node_src (x=10): AcVoltageSource.pos, Resistor.A
    //   node_out (x=20): Resistor.B, Capacitor.A
    //   node_gnd (x=30): AcVoltageSource.neg, Capacitor.B, Ground
    const circuit = new Circuit({ engineType: "analog" });
    const registry = buildAnalogRegistry();

    const vs = makeElement("AcVoltageSource", "vs1",
      [{ x: 10, y: 0 }, { x: 30, y: 0 }],  // pos, neg
      new Map<string, PropertyValue>([
        ["amplitude", A],
        ["frequency", F],
        ["phase", 0],
        ["dcOffset", 0],
        ["waveform", "sine"],
        ["label", "Vs"],
      ]),
    );
    const r1 = makeElement("Resistor", "r1",
      [{ x: 10, y: 0 }, { x: 20, y: 0 }],  // A, B
      new Map<string, PropertyValue>([
        ["resistance", R],
        ["label", "R1"],
      ]),
    );
    const c1 = makeElement("Capacitor", "c1",
      [{ x: 20, y: 0 }, { x: 30, y: 0 }],  // A, B
      new Map<string, PropertyValue>([
        ["capacitance", C],
        ["label", "C1"],
      ]),
    );
    const gnd = makeElement("Ground", "gnd1", [{ x: 30, y: 0 }]);

    circuit.addElement(vs);
    circuit.addElement(r1);
    circuit.addElement(c1);
    circuit.addElement(gnd);

    // Wires at junction points
    addWire(circuit, 10, 0, 10, 0);  // node_src
    addWire(circuit, 20, 0, 20, 0);  // node_out
    addWire(circuit, 30, 0, 30, 0);  // node_gnd

    // Compile
    const compiled = compileAnalogCircuit(circuit, registry);
    const errors = compiled.diagnostics.filter(d => d.severity === "error");
    expect(errors).toHaveLength(0);

    // Engine init + DC OP
    const engine = new MNAEngine();
    engine.init(compiled);
    const dcResult = engine.dcOperatingPoint();
    expect(dcResult.converged).toBe(true);

    // Let transient die out
    stepUntil(engine, 5 * TAU);

    // Find the output node (should be the capacitor node, not the source node).
    // The source node has amplitude ≈ A, the output node has amplitude < A.
    const periodEnd = engine.simTime + 1 / F;
    const peaks = new Array(compiled.nodeCount).fill(-Infinity);
    const troughs = new Array(compiled.nodeCount).fill(Infinity);

    while (engine.simTime < periodEnd) {
      engine.step();
      for (let i = 0; i < compiled.nodeCount; i++) {
        const v = engine.getNodeVoltage(i + 1);
        if (v > peaks[i]) peaks[i] = v;
        if (v < troughs[i]) troughs[i] = v;
      }
    }

    const amplitudes = peaks.map((p, i) => (p - troughs[i]) / 2);

    const sorted = [...amplitudes].sort((a, b) => b - a);

    // Largest amplitude ≈ A (source node)
    expect(sorted[0]).toBeGreaterThan(A * 0.9);
    // Smaller amplitude ≈ expected RC filtered amplitude
    const outputAmp = sorted[1];
    expect(outputAmp).toBeGreaterThan(EXPECTED_AMP * 0.90);
    expect(outputAmp).toBeLessThan(EXPECTED_AMP * 1.10);
  });
});
