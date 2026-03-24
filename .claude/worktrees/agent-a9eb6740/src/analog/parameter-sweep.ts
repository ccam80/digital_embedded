/**
 * Parameter sweep runner.
 *
 * Runs one analog simulation per step value of a single parameter, sweeping
 * it linearly or logarithmically between start and stop values.
 *
 * Usage:
 *   const runner = new ParameterSweepRunner(factory, config);
 *   const result = runner.run();
 *   // result.parameterValues: Float64Array of the swept values
 *   // result.outputs: Map<label, Float64Array> of output at each step
 */

import type { ConcreteCompiledAnalogCircuit } from "./compiled-analog-circuit.js";
import { EngineState } from "../core/engine-interface.js";
import { MNAEngine } from "./analog-engine.js";
import { solveDcOperatingPoint } from "./dc-operating-point.js";
import { SparseSolver } from "./sparse-solver.js";
import { DiagnosticCollector } from "./diagnostics.js";
import { DEFAULT_SIMULATION_PARAMS } from "../core/analog-engine-interface.js";
import type { OutputSpec, AcParams, TransientParams } from "./monte-carlo.js";

// ---------------------------------------------------------------------------
// SweepConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for a single-parameter sweep.
 */
export interface SweepConfig {
  /** Label of the component whose property will be swept. */
  componentLabel: string;
  /** Property key to sweep (e.g. 'resistance', 'capacitance'). */
  property: string;
  /** Start value (inclusive). */
  start: number;
  /** Stop value (inclusive). */
  stop: number;
  /** Number of simulation steps (including start and stop). Must be ≥ 2. */
  steps: number;
  /** How to space the parameter values between start and stop. */
  scale: "linear" | "log";
  /** Which analysis to run at each parameter value. */
  analysis: "dc" | "transient" | "ac";
  /** What to measure at each step. */
  outputs: OutputSpec[];
  /** Analysis-specific parameters (required for 'transient' and 'ac'). */
  analysisParams?: AcParams | TransientParams;
}

// ---------------------------------------------------------------------------
// SweepResult
// ---------------------------------------------------------------------------

/**
 * Result of a parameter sweep.
 */
export interface SweepResult {
  /** The swept parameter value at each step. */
  parameterValues: Float64Array;
  /**
   * Output value at each step, keyed by OutputSpec.label.
   * NaN entries indicate steps that failed to converge.
   */
  outputs: Map<string, Float64Array>;
}

// ---------------------------------------------------------------------------
// SweepCircuitFactory
// ---------------------------------------------------------------------------

/**
 * Creates a fresh compiled circuit with a single component property set to
 * the given absolute value (not a multiplier).
 *
 * The map key is the component label; the value is the absolute property value
 * to use for this sweep step.
 */
export type SweepCircuitFactory = (
  overrides: Map<string, Map<string, number>>,
) => ConcreteCompiledAnalogCircuit;

// ---------------------------------------------------------------------------
// Parameter value generation
// ---------------------------------------------------------------------------

/**
 * Generate the parameter values for each step of the sweep.
 *
 * Linear: evenly spaced from start to stop.
 * Log: logarithmically spaced from start to stop (both must be > 0).
 *
 * @param start - First value
 * @param stop  - Last value
 * @param steps - Number of values (≥ 2)
 * @param scale - 'linear' or 'log'
 */
export function generateSweepValues(
  start: number,
  stop: number,
  steps: number,
  scale: "linear" | "log",
): Float64Array {
  const n = Math.max(steps, 2);
  const values = new Float64Array(n);

  if (scale === "log") {
    const logStart = Math.log10(start);
    const logStop = Math.log10(stop);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      values[i] = Math.pow(10, logStart + t * (logStop - logStart));
    }
  } else {
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      values[i] = start + t * (stop - start);
    }
  }

  return values;
}

// ---------------------------------------------------------------------------
// Internal analysis runners (absolute property values, not multipliers)
// ---------------------------------------------------------------------------

function runDcSync(compiled: ConcreteCompiledAnalogCircuit): {
  converged: boolean;
  nodeVoltages: Float64Array;
} {
  const solver = new SparseSolver();
  const diagnostics = new DiagnosticCollector();
  const result = solveDcOperatingPoint({
    solver,
    elements: compiled.elements,
    matrixSize: compiled.matrixSize,
    params: DEFAULT_SIMULATION_PARAMS,
    diagnostics,
  });
  return { converged: result.converged, nodeVoltages: result.nodeVoltages };
}

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
  if (!dcResult.converged) {
    return { converged: false, nodeVoltages: new Float64Array(compiled.matrixSize) };
  }

  let steps = 0;
  const maxSteps = 100000;
  while (engine.simTime < tStop && steps < maxSteps) {
    engine.step();
    steps++;
    if (engine.getState() === EngineState.ERROR) {
      return { converged: false, nodeVoltages: new Float64Array(compiled.matrixSize) };
    }
  }

  const voltages = new Float64Array(compiled.matrixSize);
  for (let n = 1; n <= compiled.nodeCount; n++) {
    voltages[n - 1] = engine.getNodeVoltage(n);
  }
  return { converged: true, nodeVoltages: voltages };
}

function measureOutput(
  spec: OutputSpec,
  compiled: ConcreteCompiledAnalogCircuit,
  nodeVoltages: Float64Array,
): number {
  if (spec.type === "voltage" && spec.node !== undefined) {
    const nodeId = compiled.labelToNodeId.get(spec.node);
    if (nodeId === undefined || nodeId === 0) return 0;
    if (nodeId - 1 >= nodeVoltages.length) return 0;
    return nodeVoltages[nodeId - 1];
  }
  return NaN;
}

// ---------------------------------------------------------------------------
// ParameterSweepRunner
// ---------------------------------------------------------------------------

/**
 * Runs a deterministic parameter sweep: simulates the circuit at each of N
 * evenly-spaced (linear) or decade-spaced (log) values of one parameter.
 *
 * The caller provides a `SweepCircuitFactory` that creates a fresh compiled
 * circuit given absolute property value overrides (not multipliers).
 *
 * For each step value `v`, the factory receives:
 *   `{ componentLabel => { property => v } }`
 *
 * The factory must rebuild the circuit from scratch with the given value so
 * that element closures capture the new parameter.
 */
export class ParameterSweepRunner {
  private readonly _factory: SweepCircuitFactory;
  private _config: SweepConfig | null = null;

  constructor(factory: SweepCircuitFactory) {
    this._factory = factory;
  }

  /** Set or replace the sweep configuration. */
  configure(config: SweepConfig): void {
    this._config = config;
  }

  /**
   * Execute the sweep.
   *
   * Runs synchronously from the caller's perspective: all trials complete
   * before the method returns.
   *
   * @throws if `configure()` has not been called.
   */
  run(): SweepResult {
    if (this._config === null) {
      throw new Error("ParameterSweepRunner: configure() must be called before run()");
    }

    const config = this._config;
    const { componentLabel, property, start, stop, steps, scale, analysis, outputs } =
      config;

    const parameterValues = generateSweepValues(start, stop, steps, scale);
    const n = parameterValues.length;

    const outputArrays = new Map<string, Float64Array>();
    for (const spec of outputs) {
      outputArrays.set(spec.label, new Float64Array(n));
    }

    for (let i = 0; i < n; i++) {
      const value = parameterValues[i];

      const overrides = new Map<string, Map<string, number>>([
        [componentLabel, new Map([[property, value]])],
      ]);

      const compiled = this._factory(overrides);

      let analysisResult: { converged: boolean; nodeVoltages: Float64Array };

      if (analysis === "transient") {
        analysisResult = runTransientSync(
          compiled,
          config.analysisParams as TransientParams | undefined,
        );
      } else {
        analysisResult = runDcSync(compiled);
      }

      if (analysisResult.converged) {
        for (const spec of outputs) {
          const v = measureOutput(spec, compiled, analysisResult.nodeVoltages);
          outputArrays.get(spec.label)![i] = v;
        }
      } else {
        for (const spec of outputs) {
          outputArrays.get(spec.label)![i] = NaN;
        }
      }
    }

    return { parameterValues, outputs: outputArrays };
  }
}
