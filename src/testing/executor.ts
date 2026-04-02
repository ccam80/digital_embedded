/**
 * Test Executor — drives the simulation engine with parsed test vectors.
 *
 * For each vector:
 *   1. Set all non-clock inputs via facade.setSignal()
 *   2. For clock inputs: toggle high → settle() → toggle low → settle()
 *   3. For non-clock inputs: settle() to propagate
 *   4. Read all output signals via facade.readSignal()
 *   5. Compare against expected values
 *
 */

import type { Circuit } from '../core/circuit.js';
import type { SimulationCoordinator } from '../solver/coordinator-types.js';
import type { TestResults, TestVector } from '../headless/types.js';
import type { ParsedTestData, ParsedVector, Tolerance } from './parser.js';

export type { ParsedTestData, ParsedVector };
export type { TestValue } from './parser.js';

// ---------------------------------------------------------------------------
// RunnerFacade — minimal interface required by the executor
// ---------------------------------------------------------------------------

/**
 * Minimal simulation facade required by executeTests.
 *
 * Both SimulatorFacade and SimulationRunner satisfy this interface structurally.
 * Defined here to avoid circular imports between executor.ts and test-runner.ts.
 */
export interface RunnerFacade {
  setSignal(coordinator: SimulationCoordinator, label: string, value: number): void;
  readSignal(coordinator: SimulationCoordinator, label: string): number;
  settle(coordinator: SimulationCoordinator, settleTime?: number): Promise<void>;
  step(coordinator: SimulationCoordinator, opts?: { clockAdvance?: boolean }): void;
}

// ---------------------------------------------------------------------------
// HIGH_Z sentinel value used for comparison
// ---------------------------------------------------------------------------

/**
 * Sentinel numeric value used by the engine to represent HIGH_Z state.
 * Matches the encoding used in signal.ts: highZ bits set, value bits zero.
 * In the raw Uint32Array representation, a HIGH_Z signal has value=0
 * with the parallel highZ array bits set — getSignalRaw returns 0xFFFFFFFF
 * when a 1-bit signal is fully HIGH_Z.
 */
const HIGH_Z_SENTINEL = 0xFFFFFFFF;

// ---------------------------------------------------------------------------
// Tolerance comparison
// ---------------------------------------------------------------------------

/**
 * Check whether `actual` is within tolerance of `expected`.
 * If both absolute and relative tolerances are specified, passing either is sufficient.
 */
export function withinTolerance(actual: number, expected: number, tol: Tolerance): boolean {
  const delta = Math.abs(actual - expected);
  if (tol.absolute !== undefined && delta <= tol.absolute) return true;
  if (tol.relative !== undefined && delta <= Math.abs(expected) * tol.relative) return true;
  // If no tolerance fields were set at all, fall back to exact match
  if (tol.absolute === undefined && tol.relative === undefined) return actual === expected;
  return false;
}

/**
 * Format an analog failure message.
 * E.g. `Expected 3.3V ±5% at "Vout", got 2.8V (delta: 500mV)`
 */
function formatAnalogFailure(
  signalName: string,
  expected: number,
  actual: number,
  tol?: Tolerance,
): string {
  const delta = Math.abs(actual - expected);
  const tolStr = tol?.relative !== undefined
    ? ` ±${(tol.relative * 100).toFixed(0)}%`
    : tol?.absolute !== undefined
      ? ` ±${formatSI(tol.absolute)}V`
      : '';
  return `Expected ${formatSI(expected)}V${tolStr} at "${signalName}", got ${formatSI(actual)}V (delta: ${formatSI(delta)}V)`;
}

function formatSI(value: number): string {
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 1e9) return `${+(value / 1e9).toPrecision(3)}G`;
  if (abs >= 1e6) return `${+(value / 1e6).toPrecision(3)}M`;
  if (abs >= 1e3) return `${+(value / 1e3).toPrecision(3)}k`;
  if (abs >= 1)   return `${+value.toPrecision(3)}`;
  if (abs >= 1e-3) return `${+(value * 1e3).toPrecision(3)}m`;
  if (abs >= 1e-6) return `${+(value * 1e6).toPrecision(3)}u`;
  if (abs >= 1e-9) return `${+(value * 1e9).toPrecision(3)}n`;
  return `${+(value * 1e12).toPrecision(3)}p`;
}

// ---------------------------------------------------------------------------
// executeTests
// ---------------------------------------------------------------------------

/**
 * Execute all test vectors from ParsedTestData against the simulation engine.
 *
 * The facade is used for setSignal / readSignal / settle calls.
 * Clock inputs (TestValue kind='clock') receive a full toggle cycle:
 *   drive high → settle → drive low → settle.
 * Non-clock inputs are set directly, then settle() is called once.
 *
 * @param facade   The SimulatorFacade providing setSignal/readSignal/settle
 * @param engine   The compiled simulation engine
 * @param circuit  The circuit (unused for execution, included for future metadata access)
 * @param testData The parsed test vectors to execute
 * @returns        TestResults with pass/fail counts and per-vector details
 */
export async function executeTests(
  facade: RunnerFacade,
  coordinator: SimulationCoordinator,
  _circuit: Circuit,
  testData: ParsedTestData,
): Promise<TestResults> {
  const vectorResults: TestVector[] = [];
  let passed = 0;
  let failed = 0;

  for (const vector of testData.vectors) {
    const result = await executeVector(facade, coordinator, testData, vector);
    vectorResults.push(result);
    if (result.passed) {
      passed++;
    } else {
      failed++;
    }
  }

  return {
    passed,
    failed,
    total: vectorResults.length,
    vectors: vectorResults,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Execute a single test vector row and return its result.
 */
async function executeVector(
  facade: RunnerFacade,
  coordinator: SimulationCoordinator,
  testData: ParsedTestData,
  vector: ParsedVector,
): Promise<TestVector> {
  const inputRecord: Record<string, number> = {};
  const expectedOutputs: Record<string, number> = {};
  const actualOutputs: Record<string, number> = {};

  // Determine which inputs are clock vs regular
  const clockInputs: string[] = [];
  const regularInputs: string[] = [];

  for (const name of testData.inputNames) {
    const val = vector.inputs.get(name);
    if (val !== undefined && val.kind === 'clock') {
      clockInputs.push(name);
    } else {
      regularInputs.push(name);
    }
  }

  // Set all regular (non-clock) inputs
  for (const name of regularInputs) {
    const val = vector.inputs.get(name);
    if (val === undefined || val.kind === 'dontCare') {
      // Leave input as-is (don't care means we don't set it)
      inputRecord[name] = 0;
      continue;
    }
    if (val.kind === 'highZ') {
      // Setting HIGH_Z on an input — use HIGH_Z_SENTINEL
      facade.setSignal(coordinator, name, HIGH_Z_SENTINEL);
      inputRecord[name] = HIGH_Z_SENTINEL;
      continue;
    }
    // kind === 'value' or 'clock' — clock inputs handled above via regularInputs list
    const numericValue = val.kind === 'value' ? Number(val.value) : 0;
    facade.setSignal(coordinator, name, numericValue);
    inputRecord[name] = numericValue;
  }

  // Propagate regular inputs so combinational paths (decoders, enables,
  // muxes) settle before any clock edge arrives.  Without this, sequential
  // components' sampleFns would see stale enable/data signals.
  const settleTime = testData.analogPragmas?.settle;
  await facade.settle(coordinator, settleTime);

  // Handle clock inputs: toggle high → settle → low → settle
  // Use settle() to allow ripple propagation through cascaded sequential elements.
  if (clockInputs.length > 0) {
    for (const name of clockInputs) {
      facade.setSignal(coordinator, name, 1);
      inputRecord[name] = 1;
    }
    await facade.settle(coordinator);

    for (const name of clockInputs) {
      facade.setSignal(coordinator, name, 0);
    }
    await facade.settle(coordinator);
  }

  // Read all outputs and compare
  let vectorPassed = true;

  for (const name of testData.outputNames) {
    const expected = vector.outputs.get(name);
    const actual = facade.readSignal(coordinator, name);
    actualOutputs[name] = actual;

    if (expected === undefined || expected.kind === 'dontCare') {
      // Don't-care: always passes — record a nominal expected value
      expectedOutputs[name] = actual;
      continue;
    }

    if (expected.kind === 'highZ') {
      expectedOutputs[name] = HIGH_Z_SENTINEL;
      if (actual !== HIGH_Z_SENTINEL) {
        vectorPassed = false;
      }
      continue;
    }

    if (expected.kind === 'analogValue') {
      // Analog comparison: use tolerance if specified, otherwise exact float match
      expectedOutputs[name] = expected.value;
      const tol: Tolerance = expected.tolerance ?? testData.analogPragmas?.tolerance ?? {};
      if (!withinTolerance(actual, expected.value, tol)) {
        vectorPassed = false;
        // Attach failure detail to the vector (stored in actualOutputs for now — message is informational)
        void formatAnalogFailure(name, expected.value, actual, expected.tolerance ?? testData.analogPragmas?.tolerance);
      }
      continue;
    }

    // kind === 'value' — exact numeric match
    const expectedNum = expected.kind === 'value' ? Number(expected.value) : 0;
    expectedOutputs[name] = expectedNum;
    if (actual !== expectedNum) {
      vectorPassed = false;
    }
  }

  return {
    passed: vectorPassed,
    inputs: inputRecord,
    expectedOutputs,
    actualOutputs,
  };
}
