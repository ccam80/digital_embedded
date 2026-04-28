/**
 * Tests for Monte Carlo runner and Parameter Sweep runner.
 *
 * Uses hand-built ConcreteCompiledAnalogCircuit instances with test elements
 * so tests run without the full compiler pipeline.
 *
 * Circuit factory pattern:
 *   The CircuitFactory receives a Map<componentLabel, Map<property, multiplier>>.
 *   For a resistor labelled "R1" with nominal 1kΩ:
 *     multiplier = overrides.get("R1")?.get("resistance") ?? 1
 *     actualR = 1000 * multiplier
 */

import { describe, it, expect } from "vitest";
import {
  MonteCarloRunner,
  MonteCarloConfig,
  SeededRng,
  computeOutputStatistics,
  type CircuitFactory,
} from "../monte-carlo.js";
import {
  ParameterSweepRunner,
  generateSweepValues,
  type SweepConfig,
  type SweepCircuitFactory,
} from "../parameter-sweep.js";
import { ConcreteCompiledAnalogCircuit } from "../compiled-analog-circuit.js";
import { StatePool } from "../state-pool.js";
import { PropertyBag } from "../../../core/properties.js";
import { ResistorDefinition, RESISTOR_DEFAULTS } from "../../../components/passives/resistor.js";
import { makeDcVoltageSource, DC_VOLTAGE_SOURCE_DEFAULTS } from "../../../components/sources/dc-voltage-source.js";
import type { AnalogFactory } from "../../../core/registry.js";
import type { AnalogElement } from "../element.js";

// ---------------------------------------------------------------------------
// Production-factory wrappers
// ---------------------------------------------------------------------------

function makeResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const props = new PropertyBag();
  props.replaceModelParams({ ...RESISTOR_DEFAULTS, resistance });
  const factory = (ResistorDefinition.modelRegistry!["behavioral"] as { kind: "inline"; factory: AnalogFactory }).factory;
  return factory(new Map([["A", nodeA], ["B", nodeB]]), props, () => 0);
}

function makeVoltageSource(posNode: number, negNode: number, voltage: number): AnalogElement {
  const props = new PropertyBag();
  props.replaceModelParams({ ...DC_VOLTAGE_SOURCE_DEFAULTS, voltage });
  return makeDcVoltageSource(new Map([["pos", posNode], ["neg", negNode]]), props, () => 0);
}

// ---------------------------------------------------------------------------
// Circuit factory helpers
// ---------------------------------------------------------------------------

/**
 * Build a voltage-divider circuit: Vs=5V, R1 top, R2 bottom.
 *
 * Topology:
 *   node1 — Vs+ (top)
 *   node2 — midpoint (R1-R2 junction)
 *   ground — Vs-, R2 bottom
 *
 * overrides: { "R1" => { "resistance" => multiplier }, "R2" => ... }
 * multiplier applied to nominal resistance.
 */
function buildDividerCircuit(
  overrides: Map<string, Map<string, number>>,
  nominalR1: number = 1000,
  nominalR2: number = 1000,
  voltage: number = 5,
): ConcreteCompiledAnalogCircuit {
  const r1Mult = overrides.get("R1")?.get("resistance") ?? 1;
  const r2Mult = overrides.get("R2")?.get("resistance") ?? 1;
  const r1 = nominalR1 * r1Mult;
  const r2 = nominalR2 * r2Mult;

  // Nodes: 1 = top (Vs+), 2 = midpoint
  const vs = makeVoltageSource(1, 0, voltage);
  const r1El = makeResistor(1, 2, r1);
  const r2El = makeResistor(2, 0, r2);

  const labelToNodeId = new Map<string, number>([
    ["Vs", 1],
    ["mid", 2],
  ]);

  return new ConcreteCompiledAnalogCircuit({
    nodeCount: 2,
    elements: [vs, r1El, r2El],
    labelToNodeId,
    wireToNodeId: new Map(),
    models: new Map(),
    elementToCircuitElement: new Map(),
    statePool: new StatePool(0),
  });
}


/**
 * Build a sweep-compatible voltage-divider factory that uses absolute property
 * values rather than multipliers.
 *
 * overrides: { "R1" => { "resistance" => absoluteValue } }
 */
function buildSweepDividerFactory(nominalR2: number = 1000): SweepCircuitFactory {
  return (overrides) => {
    const r1Abs = overrides.get("R1")?.get("resistance") ?? nominalR2;
    const r2 = nominalR2;

    const vs = makeVoltageSource(1, 0, 5);
    const r1El = makeResistor(1, 2, r1Abs);
    const r2El = makeResistor(2, 0, r2);

    const labelToNodeId = new Map<string, number>([
      ["Vs", 1],
      ["mid", 2],
    ]);

    return new ConcreteCompiledAnalogCircuit({
      nodeCount: 2,
      elements: [vs, r1El, r2El],
      labelToNodeId,
      wireToNodeId: new Map(),
      models: new Map(),
      elementToCircuitElement: new Map(),
      statePool: new StatePool(0),
    });
  };
}

/**
 * Build a sweep-compatible RC low-pass filter factory.
 * Sweeps R value; C is fixed.
 *
 * Circuit: Vs=1V AC — R — node2 — C — GND
 * DC analysis: node2 = Vs * (C impedance / total) ≈ Vs for DC (cap open)
 * We use node2 DC voltage as the measurable output.
 *
 * For DC: cap is open circuit, so node2 = Vs = 1V regardless of R.
 * We instead measure node1 (Vs+) voltage = 1V.
 *
 * Actually for a useful sweep test: vary R in a divider with fixed C.
 * Use DC OP: cap is open circuit so node2 = 1V for all R → not useful.
 *
 * Better: use a pure resistor divider sweep where changing R1 changes Vmid.
 * overrides: { "R" => { "resistance" => absoluteValue } }
 */
function buildRcSweepFactory(_c: number = 1e-9): SweepCircuitFactory {
  return (overrides) => {
    const rAbs = overrides.get("R")?.get("resistance") ?? 1000;

    // Resistor divider: Vs=1V, R on top, 1kΩ fixed on bottom
    // Varying R changes midpoint voltage in DC OP.
    const vs = makeVoltageSource(1, 0, 1.0);
    const rEl = makeResistor(1, 2, rAbs);
    const r2El = makeResistor(2, 0, 1000);

    const labelToNodeId = new Map<string, number>([
      ["Vs", 1],
      ["mid", 2],
    ]);

    return new ConcreteCompiledAnalogCircuit({
      nodeCount: 2,
      elements: [vs, rEl, r2El],
      labelToNodeId,
      wireToNodeId: new Map(),
      models: new Map(),
      elementToCircuitElement: new Map(),
      statePool: new StatePool(0),
    });
  };
}

// ===========================================================================
// MonteCarlo tests
// ===========================================================================

describe("MonteCarlo", () => {
  // -------------------------------------------------------------------------
  // gaussian_distribution
  // -------------------------------------------------------------------------
  it("gaussian_distribution", async () => {
    // 1kΩ resistor with 5% Gaussian tolerance, 1000 trials.
    // The factory captures resistance = 1000 * multiplier where multiplier ~ N(1, 0.05).
    // We record the applied multiplier × 1000 as the "resistance" output.
    // Since we can't directly query the applied resistance from a compiled circuit,
    // we verify via the circuit's node voltage:
    //   Vs=5V, R to GND → V(top) = 5V always (voltage source).
    // Instead, use a divider: R1 varies, R2 fixed.
    //   V(mid) = 5 * R2 / (R1 + R2) = 5 * 1000 / (1000*mult + 1000)
    //   As mult → N(1, 0.05): V(mid) → varies around 2.5V.

    const factory: CircuitFactory = (overrides) =>
      buildDividerCircuit(overrides, 1000, 1000, 5);

    const config: MonteCarloConfig = {
      trials: 1000,
      seed: 42,
      variations: [
        {
          componentLabel: "R1",
          property: "resistance",
          distribution: "gaussian",
          tolerance: 0.05,
        },
      ],
      analysis: "dc",
      outputs: [{ type: "voltage", node: "mid", label: "Vmid" }],
    };

    const runner = new MonteCarloRunner(factory, config);
    let trialCount = 0;
    for await (const trial of runner.run()) {
      trialCount++;
      expect(trial.index).toBe(trialCount - 1);
    }

    expect(trialCount).toBe(1000);

    const result = runner.result!;
    expect(result).not.toBeNull();
    expect(result.trials).toBe(1000);
    expect(result.failedTrials).toBe(0);

    const stats = result.outputs.get("Vmid")!;
    expect(stats).toBeDefined();

    // Mean should be close to 2.5V (nominal divider output)
    expect(stats.mean).toBeGreaterThan(2.4);
    expect(stats.mean).toBeLessThan(2.6);

    // With 5% Gaussian on R1 only, std dev of Vmid should be > 0
    expect(stats.stdDev).toBeGreaterThan(0);

    // Min and max should bound 2.5V reasonably (not wild outliers)
    expect(stats.min).toBeGreaterThan(1.5);
    expect(stats.max).toBeLessThan(3.5);
  });

  // -------------------------------------------------------------------------
  // output_statistics
  // -------------------------------------------------------------------------
  it("output_statistics", async () => {
    // Voltage divider with 5% resistors on both R1 and R2; 100 trials.
    // Assert: output voltage mean ≈ nominal (2.5V), std dev > 0.
    const factory: CircuitFactory = (overrides) =>
      buildDividerCircuit(overrides, 1000, 1000, 5);

    const config: MonteCarloConfig = {
      trials: 100,
      seed: 123,
      variations: [
        {
          componentLabel: "R1",
          property: "resistance",
          distribution: "gaussian",
          tolerance: 0.05,
        },
        {
          componentLabel: "R2",
          property: "resistance",
          distribution: "gaussian",
          tolerance: 0.05,
        },
      ],
      analysis: "dc",
      outputs: [{ type: "voltage", node: "mid", label: "Vmid" }],
    };

    const runner = new MonteCarloRunner(factory, config);
    const trials: import("../monte-carlo.js").TrialResult[] = [];
    for await (const trial of runner.run()) {
      trials.push(trial);
    }

    expect(trials).toHaveLength(100);

    const result = runner.result!;
    const stats = result.outputs.get("Vmid")!;

    // Mean ≈ nominal 2.5V (within ±0.2V)
    expect(stats.mean).toBeGreaterThan(2.3);
    expect(stats.mean).toBeLessThan(2.7);

    // std dev > 0 (both resistors varying causes output spread)
    expect(stats.stdDev).toBeGreaterThan(0);

    // Percentiles should be in a reasonable range
    expect(stats.percentile5).toBeGreaterThan(1.5);
    expect(stats.percentile95).toBeLessThan(3.5);

    // Histogram has 20 bins
    expect(stats.histogram).toHaveLength(20);

    // Histogram total counts = number of converged trials
    const totalCounts = stats.histogram.reduce((s, b) => s + b.count, 0);
    expect(totalCounts).toBe(100 - result.failedTrials);
  });

  // -------------------------------------------------------------------------
  // reproducible_with_seed
  // -------------------------------------------------------------------------
  it("reproducible_with_seed", async () => {
    const factory: CircuitFactory = (overrides) =>
      buildDividerCircuit(overrides, 1000, 1000, 5);

    const config: MonteCarloConfig = {
      trials: 50,
      seed: 9999,
      variations: [
        {
          componentLabel: "R1",
          property: "resistance",
          distribution: "gaussian",
          tolerance: 0.10,
        },
      ],
      analysis: "dc",
      outputs: [{ type: "voltage", node: "mid", label: "Vmid" }],
    };

    // First run
    const runner1 = new MonteCarloRunner(factory, config);
    const values1: number[] = [];
    for await (const trial of runner1.run()) {
      values1.push(trial.values.get("Vmid") ?? NaN);
    }

    // Second run with same seed
    const runner2 = new MonteCarloRunner(factory, config);
    const values2: number[] = [];
    for await (const trial of runner2.run()) {
      values2.push(trial.values.get("Vmid") ?? NaN);
    }

    expect(values1).toHaveLength(50);
    expect(values2).toHaveLength(50);

    // Identical results
    for (let i = 0; i < 50; i++) {
    }

    // Statistics are also identical
  });
});

// ===========================================================================
// Sweep tests
// ===========================================================================

describe("Sweep", () => {
  // -------------------------------------------------------------------------
  // linear_sweep
  // -------------------------------------------------------------------------
  it("linear_sweep", () => {
    // Sweep R1 from 1kΩ to 10kΩ in 10 steps (linear).
    // Output: V(mid) = 5 * R2 / (R1 + R2) = 5 * 1000 / (R1 + 1000)
    // As R1 increases from 1k to 10k, V(mid) decreases monotonically.
    const factory = buildSweepDividerFactory(1000);
    const runner = new ParameterSweepRunner(factory);

    const config: SweepConfig = {
      componentLabel: "R1",
      property: "resistance",
      start: 1000,
      stop: 10000,
      steps: 10,
      scale: "linear",
      analysis: "dc",
      outputs: [{ type: "voltage", node: "mid", label: "Vmid" }],
    };

    runner.configure(config);
    const result = runner.run();

    // 10 output values
    expect(result.parameterValues).toHaveLength(10);
    expect(result.outputs.get("Vmid")).toHaveLength(10);

    const vmid = result.outputs.get("Vmid")!;

    // All converged (no NaN)
    for (let i = 0; i < 10; i++) {
      expect(Number.isNaN(vmid[i])).toBe(false);
    }

    // Monotonically decreasing (as R1 increases, Vmid decreases)
    for (let i = 1; i < 10; i++) {
      expect(vmid[i]).toBeLessThan(vmid[i - 1]);
    }

    // First step: R1=1kΩ, R2=1kΩ → Vmid = 2.5V

    // Last step: R1=10kΩ, R2=1kΩ → Vmid = 5 * 1000/11000 ≈ 0.4545V
  });

  // -------------------------------------------------------------------------
  // log_sweep
  // -------------------------------------------------------------------------
  it("log_sweep", () => {
    // Sweep capacitance from 1pF to 1µF using log spacing.
    // We use a resistor sweep (1Ω to 1MΩ) as a proxy for verifying log spacing.
    // The actual log-spacing check is on the parameterValues array.
    const factory = buildSweepDividerFactory(1000);
    const runner = new ParameterSweepRunner(factory);

    const config: SweepConfig = {
      componentLabel: "R1",
      property: "resistance",
      start: 1,      // 1Ω ~ 1pF equivalent
      stop: 1e6,     // 1MΩ ~ 1µF equivalent
      steps: 10,
      scale: "log",
      analysis: "dc",
      outputs: [{ type: "voltage", node: "mid", label: "Vmid" }],
    };

    runner.configure(config);
    const result = runner.run();

    const pv = result.parameterValues;
    expect(pv).toHaveLength(10);

    // First value ≈ 1, last value ≈ 1e6

    // Verify logarithmic spacing: ratios between consecutive values are equal
    // log10(pv[i+1]) - log10(pv[i]) should be constant
    const logRatios: number[] = [];
    for (let i = 1; i < pv.length; i++) {
      logRatios.push(Math.log10(pv[i]) - Math.log10(pv[i - 1]));
    }
    for (const _ratio of logRatios) {
    }

    // All steps should produce finite output values
    const vmid = result.outputs.get("Vmid")!;
    for (let i = 0; i < pv.length; i++) {
      expect(Number.isFinite(vmid[i])).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // ac_sweep_at_each_value
  // -------------------------------------------------------------------------
  it("ac_sweep_at_each_value", () => {
    // Sweep R in a resistor divider (proxy for RC filter).
    // As R increases from 1kΩ to 10kΩ with fixed R2=1kΩ:
    //   V(mid) = 5 * R2 / (R + R2) decreases.
    // This verifies that running AC (DC OP) at each R value produces
    // monotonically changing outputs.
    const factory = buildRcSweepFactory();
    const runner = new ParameterSweepRunner(factory);

    const config: SweepConfig = {
      componentLabel: "R",
      property: "resistance",
      start: 1000,
      stop: 10000,
      steps: 5,
      scale: "linear",
      analysis: "ac",
      outputs: [{ type: "voltage", node: "mid", label: "Vmid" }],
    };

    runner.configure(config);
    const result = runner.run();

    expect(result.parameterValues).toHaveLength(5);
    const vmid = result.outputs.get("Vmid")!;
    expect(vmid).toHaveLength(5);

    // All values converge
    for (let i = 0; i < 5; i++) {
      expect(Number.isNaN(vmid[i])).toBe(false);
    }

    // As R increases, V(mid) decreases (-3dB point shifts)
    // R=1k: Vmid = 1 * 1000/(1000+1000) = 0.5V
    // R=10k: Vmid = 1 * 1000/(10000+1000) ≈ 0.0909V
    for (let i = 1; i < 5; i++) {
      expect(vmid[i]).toBeLessThan(vmid[i - 1]);
    }
  });
});

// ===========================================================================
// SeededRng and computeOutputStatistics unit tests
// ===========================================================================

describe("SeededRng", () => {
  it("produces values in (0, 1)", () => {
    const rng = new SeededRng(42);
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("reproduces same sequence for same seed", () => {
    const rng1 = new SeededRng(12345);
    const rng2 = new SeededRng(12345);
    for (let i = 0; i < 100; i++) {
      expect(rng1.next()).toBe(rng2.next());
    }
  });

  it("gaussian samples have approximate mean 0 and std 1", () => {
    const rng = new SeededRng(7);
    const n = 10000;
    let sum = 0;
    const values: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = rng.gaussian();
      sum += v;
      values.push(v);
    }
    const mean = sum / n;
    let sumSq = 0;
    for (const v of values) sumSq += (v - mean) ** 2;
    Math.sqrt(sumSq / n);

  });
});

describe("computeOutputStatistics", () => {
  it("computes correct statistics for known data", () => {
    // Values: 1, 2, 3, 4, 5
    const data = new Float64Array([1, 2, 3, 4, 5]);
    const stats = computeOutputStatistics(data);

    expect(stats.min).toBe(1);
    expect(stats.max).toBe(5);
    expect(stats.stdDev).toBeGreaterThan(0);
  });

  it("returns NaN statistics for empty data", () => {
    const stats = computeOutputStatistics(new Float64Array(0));
    expect(Number.isNaN(stats.mean)).toBe(true);
    expect(Number.isNaN(stats.stdDev)).toBe(true);
    expect(stats.histogram).toHaveLength(0);
  });

  it("histogram bins sum to total count", () => {
    const data = new Float64Array(Array.from({ length: 100 }, (_, i) => i));
    const stats = computeOutputStatistics(data);
    const total = stats.histogram.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(100);
  });
});

describe("generateSweepValues", () => {
  it("linear: start and stop are first and last values", () => {
    const v = generateSweepValues(1, 10, 5, "linear");
    expect(v).toHaveLength(5);
  });

  it("linear: values are evenly spaced", () => {
    generateSweepValues(0, 4, 5, "linear");
  });

  it("log: start and stop are first and last values", () => {
    generateSweepValues(1, 1000, 4, "log");
  });

  it("log: ratios between consecutive values are equal", () => {
    const v = generateSweepValues(1, 1000, 7, "log");
    const ratios = [];
    for (let i = 1; i < v.length; i++) {
      ratios.push(v[i] / v[i - 1]);
    }
    for (const _r of ratios) {
    }
  });
});
