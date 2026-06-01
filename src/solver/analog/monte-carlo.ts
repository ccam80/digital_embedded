/**
 * Monte Carlo simulation runner and supporting types.
 *
 * Runs N independent analog simulations with randomised component parameters,
 * accumulates output statistics, and yields per-trial results for progress
 * reporting or cancellation.
 *
 * Usage:
 *   const runner = new MonteCarloRunner(factory, config);
 *   for await (const trial of runner.run()) {
 *     updateProgress(trial.index, config.trials ?? 100);
 *   }
 *   const result = runner.result;
 */

import { EngineState } from "../../core/engine-interface.js";
import type { ConcreteCompiledAnalogCircuit } from "./compiled-analog-circuit.js";
import { MNAEngine } from "./analog-engine.js";
import { DEFAULT_SIMULATION_PARAMS } from "../../core/analog-engine-interface.js";

// ---------------------------------------------------------------------------
// TransientParams  time span for transient analysis
// ---------------------------------------------------------------------------

/**
 * Parameters for a transient analysis run.
 */
export interface TransientParams {
  /** Start time in seconds. */
  tStart: number;
  /** Stop time in seconds. */
  tStop: number;
  /** Optional maximum timestep in seconds. */
  maxDt?: number;
}

// ---------------------------------------------------------------------------
// AcParams  frequency range for AC small-signal analysis
// ---------------------------------------------------------------------------

/**
 * Parameters for an AC small-signal analysis run.
 */
export interface AcParams {
  /** Start frequency in Hz. */
  fStart: number;
  /** Stop frequency in Hz. */
  fStop: number;
  /** Number of frequency points. */
  points: number;
  /** Frequency scaling: linear or logarithmic. */
  scale: "linear" | "log";
}

// ---------------------------------------------------------------------------
// OutputSpec  what to measure in each trial
// ---------------------------------------------------------------------------

/**
 * Specifies a quantity to record from each simulation trial.
 *
 * For `type: 'voltage'`: record the voltage at MNA node identified by `node`.
 * For `type: 'current'`: record element current for the element identified by
 * `element`.
 */
export interface OutputSpec {
  /** Whether to measure a node voltage or element current. */
  type: "voltage" | "current";
  /** MNA node label to measure (used when type = 'voltage'). */
  node?: string;
  /** Element label to measure current through (used when type = 'current'). */
  element?: string;
  /** Unique label identifying this output in the result maps. */
  label: string;
}

// ---------------------------------------------------------------------------
// ParameterVariation  how to vary one component property
// ---------------------------------------------------------------------------

/**
 * Describes how a single component property varies across Monte Carlo trials.
 */
export interface ParameterVariation {
  /** Label of the component whose property will be varied. */
  componentLabel: string;
  /** Property key to vary (e.g. 'resistance', 'capacitance'). */
  property: string;
  /** Statistical distribution to use for sampling. */
  distribution: "gaussian" | "uniform";
  /** Tolerance as a fraction (e.g. 0.05 for ±5%). */
  tolerance: number;
}

// ---------------------------------------------------------------------------
// MonteCarloConfig
// ---------------------------------------------------------------------------

/**
 * Full configuration for a Monte Carlo simulation run.
 */
export interface MonteCarloConfig {
  /** Number of independent trials to run. Defaults to 100. */
  trials?: number;
  /** Component parameters to vary across trials. */
  variations: ParameterVariation[];
  /** Which analysis to run in each trial. */
  analysis: "dc" | "transient" | "ac";
  /** What to measure at the end of each trial. */
  outputs: OutputSpec[];
  /** Analysis-specific parameters (required for 'transient' and 'ac'). */
  analysisParams?: AcParams | TransientParams;
  /** RNG seed for reproducible runs. Omit for non-reproducible. */
  seed?: number;
}

// ---------------------------------------------------------------------------
// HistogramBin
// ---------------------------------------------------------------------------

/**
 * One bin in a histogram of output values.
 */
export interface HistogramBin {
  /** Left edge of the bin (inclusive). */
  lo: number;
  /** Right edge of the bin (exclusive, except for the last bin). */
  hi: number;
  /** Number of trials whose output fell in this bin. */
  count: number;
}

// ---------------------------------------------------------------------------
// OutputStatistics
// ---------------------------------------------------------------------------

/**
 * Summary statistics for one output across all Monte Carlo trials.
 */
export interface OutputStatistics {
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  /** 5th percentile value. */
  percentile5: number;
  /** 95th percentile value. */
  percentile95: number;
  /** Histogram with up to 20 equal-width bins spanning [min, max]. */
  histogram: HistogramBin[];
}

// ---------------------------------------------------------------------------
// TrialResult  yielded after each trial
// ---------------------------------------------------------------------------

/**
 * Result of a single Monte Carlo trial.
 *
 * Yielded from `MonteCarloRunner.run()` so callers can update progress or
 * check for cancellation between trials.
 */
export interface TrialResult {
  /** Zero-based trial index. */
  index: number;
  /** Whether this trial's simulation converged. */
  converged: boolean;
  /** Output values recorded for this trial (keyed by OutputSpec.label). */
  values: Map<string, number>;
  /** The sampled parameter multipliers applied in this trial. */
  parameterValues: Map<string, Map<string, number>>;
}

// ---------------------------------------------------------------------------
// MonteCarloResult  final result after all trials
// ---------------------------------------------------------------------------

/**
 * Final result returned after all Monte Carlo trials complete.
 */
export interface MonteCarloResult {
  /** Total number of trials attempted. */
  trials: number;
  /** Number of trials that failed to converge. */
  failedTrials: number;
  /** Statistics per output label (computed from converged trials only). */
  outputs: Map<string, OutputStatistics>;
  /** Per-trial raw values for each output. NaN entries indicate failed trials. */
  rawData: Map<string, Float64Array>;
}

// ---------------------------------------------------------------------------
// CircuitFactory  creates a fresh compiled circuit with property overrides
// ---------------------------------------------------------------------------

/**
 * A factory function that creates a fresh compiled analog circuit with
 * specified component property multiplier overrides applied.
 *
 * The outer map key is a component label; the inner map key is a property
 * name; the value is a multiplier applied to the nominal property value
 * (e.g. 1.05 means +5%).
 *
 * The factory must produce a fully independent instance for each call 
 * shared mutable state between trials causes incorrect results.
 */
export type CircuitFactory = (
  overrides: Map<string, Map<string, number>>,
) => ConcreteCompiledAnalogCircuit;

// ---------------------------------------------------------------------------
// SeededRng  combined Tausworthe/LCG generator (ngspice randnumb.c)
// ---------------------------------------------------------------------------

/**
 * Seeded pseudo-random number generator: the combined three-component
 * Tausworthe / LCG generator from ngspice's `randnumb.c`.
 *
 * Two independent state quartets drive two generators that share the same
 * `TauS`/`LGCS` recurrences (`randnumb.c:54-59`):
 *   - `_s1.._s4` feed `combLCGTaus()` (the `[0,1)` double, `randnumb.c:140-148`)
 *     and `drand()` (the `[-1,+1)` uniform, `randnumb.c:95-98`);
 *   - `_s5.._s8` feed `combLCGTausInt()` (the 32-bit unsigned integer variate,
 *     `randnumb.c:154-162`).
 *
 * Gaussian samples use the polar (Marsaglia) Box-Muller form
 * (`gauss0`/`gauss1`/`rgauss`, `randnumb.c:195-254`). `poisson` and `exprand`
 * (`randnumb.c:260-283`) supply the Poisson and exponential variates.
 *
 * The eight state words are 32-bit unsigned quantities in C; every shift, xor,
 * mask, and multiply is forced back to uint32 with `>>> 0` (and the LCG product
 * formed with `Math.imul`) so the advance is bit-identical to C's `unsigned`
 * arithmetic.
 */
export class SeededRng {
  /** Double-generator Tausworthe words (randnumb.c:54). */
  private _s1: number;
  private _s2: number;
  private _s3: number;
  /** Double-generator LCG word (randnumb.c:55). */
  private _s4: number;
  /** Integer-generator Tausworthe words (randnumb.c:58). */
  private _s5: number;
  private _s6: number;
  private _s7: number;
  /** Integer-generator LCG word (randnumb.c:59). */
  private _s8: number;

  /** Polar Box-Muller cached-second-value latch (randnumb.c:197-198). */
  private _gliset = true;
  private _glgset = 0.0;

  constructor(seed: number) {
    // randnumb.c:101-115 — seed eight generator words into [129, 32767].
    // ngspice draws each from libc rand()/RAND_MAX; digiTS drives a
    // deterministic per-seed expander (a splitmix step) so the same `seed`
    // yields the same eight words, preserving TausSeed's [129, 32767]
    // placement and the >128 floor (randnumb.c:103-104).
    let x = (Math.abs(Math.floor(seed)) >>> 0) || 1;
    const draw = (): number => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      z = (z ^ (z >>> 16)) >>> 0;
      return z / 4294967296;
    };
    // randnumb.c:108-115 — (rand()/RAND_MAX * 32638) + 129, eight words.
    this._s1 = Math.floor(draw() * 32638) + 129;
    this._s2 = Math.floor(draw() * 32638) + 129;
    this._s3 = Math.floor(draw() * 32638) + 129;
    this._s4 = Math.floor(draw() * 32638) + 129;
    this._s5 = Math.floor(draw() * 32638) + 129;
    this._s6 = Math.floor(draw() * 32638) + 129;
    this._s7 = Math.floor(draw() * 32638) + 129;
    this._s8 = Math.floor(draw() * 32638) + 129;
  }

  /**
   * Inject the eight `CombState1..8` words directly, bypassing the per-seed
   * expander. The harness uses this to seed digiTS with ngspice's
   * post-`TausSeed` state so both engines run the identical bit stream
   * (RNG-1 = SEED-INJECTION). Each word is forced to uint32.
   */
  setState(
    s1: number,
    s2: number,
    s3: number,
    s4: number,
    s5: number,
    s6: number,
    s7: number,
    s8: number,
  ): void {
    this._s1 = s1 >>> 0;
    this._s2 = s2 >>> 0;
    this._s3 = s3 >>> 0;
    this._s4 = s4 >>> 0;
    this._s5 = s5 >>> 0;
    this._s6 = s6 >>> 0;
    this._s7 = s7 >>> 0;
    this._s8 = s8 >>> 0;
  }

  // randnumb.c:125-129 — one Tausworthe component: shift-xor-shift mixing word
  // b, then update the state by masking, left-shifting C3, and xoring b. All
  // ops are 32-bit unsigned; >>> 0 forces JS back to uint32 after each step.
  private tauS(state: number, c1: number, c2: number, c3: number, m: number): number {
    const b = (((state << c1) ^ state) >>> c2) >>> 0;
    return (((((state & m) >>> 0) << c3) >>> 0) ^ b) >>> 0;
  }

  // randnumb.c:131-134 — linear-congruential step state = A1*state + A2,
  // wrapped to uint32. Math.imul gives the low-32-bit product C's unsigned
  // multiply yields.
  private lgcs(state: number, a1: number, a2: number): number {
    return (Math.imul(a1, state) + a2) >>> 0;
  }

  // randnumb.c:140-148 — combine three Tausworthe components and one LCG by
  // xor, scale by 1/2^32 to land in [0,1). The xor operands advance their state
  // words in place, left-to-right.
  combLCGTaus(): number {
    this._s1 = this.tauS(this._s1, 13, 19, 12, 0xfffffffe);
    this._s2 = this.tauS(this._s2, 2, 25, 4, 0xfffffff8);
    this._s3 = this.tauS(this._s3, 3, 11, 17, 0xfffffff0);
    this._s4 = this.lgcs(this._s4, 1664525, 1013904223);
    const combined = (this._s1 ^ this._s2 ^ this._s3 ^ this._s4) >>> 0;
    return 2.3283064365387e-10 * combined;
  }

  // randnumb.c:154-162 — 32-bit unsigned variate from the second state quartet;
  // same TauS/LGCS recurrences as combLCGTaus, no [0,1) scaling.
  combLCGTausInt(): number {
    this._s5 = this.tauS(this._s5, 13, 19, 12, 0xfffffffe);
    this._s6 = this.tauS(this._s6, 2, 25, 4, 0xfffffff8);
    this._s7 = this.tauS(this._s7, 3, 11, 17, 0xfffffff0);
    this._s8 = this.lgcs(this._s8, 1664525, 1013904223);
    return (this._s5 ^ this._s6 ^ this._s7 ^ this._s8) >>> 0;
  }

  // randnumb.c:95-98 — map combLCGTaus()'s [0,1) onto [-1,+1).
  drand(): number {
    return 2.0 * this.combLCGTaus() - 1.0;
  }

  /** Return the next value in [0, 1). Re-rooted onto combLCGTaus(). */
  next(): number {
    return this.combLCGTaus();
  }

  // randnumb.c:195-215 — polar (Marsaglia) Box-Muller, two normals per uniform
  // pair. On the cached call return the stored partner value; the
  // gliset/glgset latch is instance state so the consumption pattern matches
  // per stream.
  gauss0(): number {
    if (this._gliset) {
      let v1: number, v2: number, r: number;
      do {
        v1 = 2.0 * this.combLCGTaus() - 1.0; // randnumb.c:202
        v2 = 2.0 * this.combLCGTaus() - 1.0; // randnumb.c:203
        r = v1 * v1 + v2 * v2; // randnumb.c:204
      } while (r >= 1.0); // randnumb.c:205
      const fac = Math.sqrt((-2.0 * Math.log(r)) / r); // randnumb.c:207
      this._glgset = v1 * fac; // randnumb.c:208
      this._gliset = false; // randnumb.c:209
      return v2 * fac; // randnumb.c:210
    } else {
      this._gliset = true; // randnumb.c:212
      return this._glgset; // randnumb.c:213
    }
  }

  // randnumb.c:220-231 — same polar draw as gauss0 but with no caching latch:
  // two uniforms per call, returns v2*fac every call (the reproducible gauss).
  gauss1(): number {
    let v1: number, v2: number, r: number;
    do {
      v1 = 2.0 * this.combLCGTaus() - 1.0;
      v2 = 2.0 * this.combLCGTaus() - 1.0;
      r = v1 * v1 + v2 * v2;
    } while (r >= 1.0);
    const fac = Math.sqrt((-2.0 * Math.log(r)) / r);
    return v2 * fac;
  }

  // randnumb.c:240-254 — polar Box-Muller delivering BOTH normals per call.
  // w = sqrt(-2*log(w)/w); py1 = x1*w, py2 = x2*w.
  rgauss(): [number, number] {
    let x1: number, x2: number, w: number;
    do {
      x1 = 2.0 * this.combLCGTaus() - 1.0;
      x2 = 2.0 * this.combLCGTaus() - 1.0;
      w = x1 * x1 + x2 * x2;
    } while (w >= 1.0);
    w = Math.sqrt((-2.0 * Math.log(w)) / w);
    return [x1 * w, x2 * w];
  }

  /** Sample from N(0, 1). Re-rooted onto the polar gauss0(). */
  gaussian(): number {
    return this.gauss0();
  }

  /** Sample from Uniform(-1, 1). Re-rooted onto drand(). */
  uniform(): number {
    return this.drand();
  }

  // randnumb.c:260-274 — Knuth-style Poisson via one uniform: accumulate the
  // Poisson CDF P*=lambda/k until it meets the uniform draw p; cap at
  // max_k=1000.
  poisson(lambda: number): number {
    const maxK = 1000; // randnumb.c:263
    const p = this.combLCGTaus(); // randnumb.c:264
    let P = Math.exp(-lambda); // randnumb.c:265
    let sum = P; // randnumb.c:266
    if (sum >= p) return 0; // randnumb.c:267
    let k = 1;
    for (; k < maxK; ++k) {
      // randnumb.c:268
      P *= lambda / k; // randnumb.c:269
      sum += P; // randnumb.c:270
      if (sum >= p) break; // randnumb.c:271
    }
    return k; // randnumb.c:273
  }

  // randnumb.c:278-283 — exponential variate -log(u)*mean from one uniform.
  exprand(mean: number): number {
    return -Math.log(this.combLCGTaus()) * mean; // randnumb.c:281
  }
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

/**
 * Compute summary statistics from an array of converged trial values.
 */
export function computeOutputStatistics(values: Float64Array): OutputStatistics {
  const n = values.length;
  if (n === 0) {
    return {
      mean: NaN,
      stdDev: NaN,
      min: NaN,
      max: NaN,
      percentile5: NaN,
      percentile95: NaN,
      histogram: [],
    };
  }

  let sum = 0;
  let minVal = values[0];
  let maxVal = values[0];
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (values[i] < minVal) minVal = values[i];
    if (values[i] > maxVal) maxVal = values[i];
  }
  const mean = sum / n;

  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - mean;
    sumSq += d * d;
  }
  const stdDev = Math.sqrt(sumSq / n);

  const sorted = Float64Array.from(values).sort();
  const percentile5 = sorted[Math.floor(0.05 * (n - 1))];
  const percentile95 = sorted[Math.floor(0.95 * (n - 1))];

  const BINS = 20;
  const histogram: HistogramBin[] = [];
  const range = maxVal - minVal;
  const binWidth = range > 0 ? range / BINS : 1;

  for (let b = 0; b < BINS; b++) {
    histogram.push({
      lo: minVal + b * binWidth,
      hi: minVal + (b + 1) * binWidth,
      count: 0,
    });
  }

  for (let i = 0; i < n; i++) {
    if (range === 0) {
      histogram[0].count++;
      continue;
    }
    const binIdx = Math.min(Math.floor((values[i] - minVal) / binWidth), BINS - 1);
    histogram[binIdx].count++;
  }

  return { mean, stdDev, min: minVal, max: maxVal, percentile5, percentile95, histogram };
}

// ---------------------------------------------------------------------------
// Internal DC runner  synchronous, no engine lifecycle
// ---------------------------------------------------------------------------

function runDcSync(compiled: ConcreteCompiledAnalogCircuit): {
  converged: boolean;
  nodeVoltages: Float64Array;
} {
  // MNAEngine.init() calls _setup() which registers TSTALLOC handles on the
  // engine-owned solver before any load() call. Using CKTCircuitContext directly
  // skips _setup() and leaves element handles uninitialized.
  const engine = new MNAEngine();
  engine.init(compiled);
  const dcResult = engine.dcOperatingPoint();
  if (!dcResult.converged) {
    return { converged: false, nodeVoltages: new Float64Array(engine.matrixSize + 1) };
  }
  const voltages = new Float64Array(engine.matrixSize + 1);
  for (let n = 1; n <= compiled.nodeCount; n++) {
    voltages[n] = engine.getNodeVoltage(n);
  }
  return { converged: true, nodeVoltages: voltages };
}

// ---------------------------------------------------------------------------
// Internal transient runner
// ---------------------------------------------------------------------------

function runTransientSync(
  compiled: ConcreteCompiledAnalogCircuit,
  params: TransientParams | undefined,
): { converged: boolean; nodeVoltages: Float64Array } {
  const tStop = params?.tStop ?? 1e-3;
  const maxDt = params?.maxDt ?? DEFAULT_SIMULATION_PARAMS.maxTimeStep;

  const engine = new MNAEngine();
  engine.configure({ maxTimeStep: maxDt });
  engine.init(compiled);

  const dcResult = engine.dcOperatingPoint();
  // matrixSize is only known after engine setup discovers branch rows
  // (ngspice CKTmaxEqNum + 1 pattern).
  if (!dcResult.converged) {
    return { converged: false, nodeVoltages: new Float64Array(engine.matrixSize + 1) };
  }

  let steps = 0;
  const maxSteps = 100000;
  while (engine.simTime < tStop && steps < maxSteps) {
    engine.step();
    steps++;
    if (engine.getState() === EngineState.ERROR) {
      return { converged: false, nodeVoltages: new Float64Array(engine.matrixSize + 1) };
    }
  }

  // Public nodeVoltages mirrors the ngspice 1-based layout: slot 0 is the
  // ground sentinel (always 0), slots 1..nodeCount hold node voltages, and
  // any remaining slots up to matrixSize are reserved for branch currents.
  const voltages = new Float64Array(engine.matrixSize + 1);
  for (let n = 1; n <= compiled.nodeCount; n++) {
    voltages[n] = engine.getNodeVoltage(n);
  }
  return { converged: true, nodeVoltages: voltages };
}

// ---------------------------------------------------------------------------
// Output measurement
// ---------------------------------------------------------------------------

function measureOutput(
  spec: OutputSpec,
  compiled: ConcreteCompiledAnalogCircuit,
  nodeVoltages: Float64Array,
): number {
  if (spec.type === "voltage" && spec.node !== undefined) {
    const nodeId = compiled.labelToNodeId.get(spec.node);
    if (nodeId === undefined || nodeId === 0) return 0;
    if (nodeId >= nodeVoltages.length) return 0;
    return nodeVoltages[nodeId];
  }
  return NaN;
}

// ---------------------------------------------------------------------------
// MonteCarloRunner
// ---------------------------------------------------------------------------

/**
 * Runs Monte Carlo analysis by performing N independent trials with
 * randomised component parameter variations.
 *
 * The caller provides a `CircuitFactory` that creates a fresh compiled
 * circuit given a map of component property multiplier overrides. This
 * decouples the runner from how circuits are cloned or rebuilt.
 *
 * Each variation specifies:
 *   - which component and property to vary
 *   - a distribution (gaussian or uniform)
 *   - a tolerance fraction (e.g. 0.05 = ±5%)
 *
 * The sampled multiplier is `1 + tolerance * sample`, where `sample` is drawn
 * from N(0,1) for gaussian or Uniform(-1,1) for uniform.
 */
export class MonteCarloRunner {
  private readonly _factory: CircuitFactory;
  private readonly _config: MonteCarloConfig;
  private _cancelled: boolean = false;
  private _result: MonteCarloResult | null = null;

  constructor(factory: CircuitFactory, config: MonteCarloConfig) {
    this._factory = factory;
    this._config = config;
  }

  /** Signal cancellation. The generator stops after the current trial. */
  cancel(): void {
    this._cancelled = true;
  }

  /** The final result after all trials complete. Null until `run()` finishes. */
  get result(): MonteCarloResult | null {
    return this._result;
  }

  /**
   * Run all Monte Carlo trials.
   *
   * Yields a `TrialResult` after each trial. Access `runner.result` for the
   * final statistics after the loop finishes.
   */
  async *run(): AsyncGenerator<TrialResult, MonteCarloResult> {
    const config = this._config;
    const trialCount = config.trials ?? 100;
    const outputLabels = config.outputs.map((o) => o.label);

    const rawData = new Map<string, Float64Array>();
    for (const label of outputLabels) {
      rawData.set(label, new Float64Array(trialCount));
    }

    const rng =
      config.seed !== undefined
        ? new SeededRng(config.seed)
        : new SeededRng(Date.now() ^ (Math.random() * 0xffffffff));

    let failedTrials = 0;

    for (let i = 0; i < trialCount; i++) {
      if (this._cancelled) break;

      const overrides = new Map<string, Map<string, number>>();
      const parameterValues = new Map<string, Map<string, number>>();

      for (const variation of config.variations) {
        const { componentLabel, property, distribution, tolerance } = variation;
        const sample =
          distribution === "gaussian" ? rng.gaussian() : rng.uniform();
        const multiplier = 1 + tolerance * sample;

        if (!overrides.has(componentLabel)) {
          overrides.set(componentLabel, new Map());
          parameterValues.set(componentLabel, new Map());
        }
        overrides.get(componentLabel)!.set(property, multiplier);
        parameterValues.get(componentLabel)!.set(property, multiplier);
      }

      const compiled = this._factory(overrides);
      const outputValues = new Map<string, number>();
      let converged = false;

      let analysisResult: { converged: boolean; nodeVoltages: Float64Array };

      if (config.analysis === "transient") {
        analysisResult = runTransientSync(
          compiled,
          config.analysisParams as TransientParams | undefined,
        );
      } else {
        // DC and AC both use DC operating-point for output measurement
        analysisResult = runDcSync(compiled);
      }

      converged = analysisResult.converged;
      if (converged) {
        for (const outputSpec of config.outputs) {
          const v = measureOutput(outputSpec, compiled, analysisResult.nodeVoltages);
          outputValues.set(outputSpec.label, v);
        }
      } else {
        failedTrials++;
        for (const label of outputLabels) {
          outputValues.set(label, NaN);
        }
      }

      for (const label of outputLabels) {
        rawData.get(label)![i] = outputValues.get(label) ?? NaN;
      }

      yield {
        index: i,
        converged,
        values: outputValues,
        parameterValues,
      };
    }

    const outputs = new Map<string, OutputStatistics>();
    for (const label of outputLabels) {
      const all = rawData.get(label)!;
      const convergedValues = Float64Array.from(
        Array.from(all).filter((v) => !Number.isNaN(v)),
      );
      outputs.set(label, computeOutputStatistics(convergedValues));
    }

    const finalResult: MonteCarloResult = {
      trials: trialCount,
      failedTrials,
      outputs,
      rawData,
    };

    this._result = finalResult;
    return finalResult;
  }
}
