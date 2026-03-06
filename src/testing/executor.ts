/**
 * Test Executor — drives the simulation engine with parsed test vectors.
 *
 * For each vector:
 *   1. Set all non-clock inputs via facade.setInput()
 *   2. For clock inputs: toggle high → runToStable() → toggle low → runToStable()
 *   3. For non-clock inputs: runToStable() to propagate
 *   4. Read all output signals via facade.readOutput()
 *   5. Compare against expected values
 *
 */

import type { SimulationEngine } from '../core/engine-interface.js';
import type { Circuit } from '../core/circuit.js';
import type { TestResults, TestVector } from '../headless/types.js';
import type { ParsedTestData, ParsedVector } from './parser.js';

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
  setInput(engine: SimulationEngine, label: string, value: number): void;
  readOutput(engine: SimulationEngine, label: string): number;
  runToStable(engine: SimulationEngine, maxIterations?: number): void;
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
// executeTests
// ---------------------------------------------------------------------------

/**
 * Execute all test vectors from ParsedTestData against the simulation engine.
 *
 * The facade is used for setInput / readOutput / runToStable calls.
 * Clock inputs (TestValue kind='clock') receive a full toggle cycle:
 *   drive high → runToStable → drive low → runToStable.
 * Non-clock inputs are set directly, then runToStable() is called once.
 *
 * @param facade   The SimulatorFacade providing setInput/readOutput/runToStable
 * @param engine   The compiled simulation engine
 * @param circuit  The circuit (unused for execution, included for future metadata access)
 * @param testData The parsed test vectors to execute
 * @returns        TestResults with pass/fail counts and per-vector details
 */
export function executeTests(
  facade: RunnerFacade,
  engine: SimulationEngine,
  _circuit: Circuit,
  testData: ParsedTestData,
): TestResults {
  const vectorResults: TestVector[] = [];
  let passed = 0;
  let failed = 0;

  for (const vector of testData.vectors) {
    const result = executeVector(facade, engine, testData, vector);
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
function executeVector(
  facade: RunnerFacade,
  engine: SimulationEngine,
  testData: ParsedTestData,
  vector: ParsedVector,
): TestVector {
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
      facade.setInput(engine, name, HIGH_Z_SENTINEL);
      inputRecord[name] = HIGH_Z_SENTINEL;
      continue;
    }
    // kind === 'value'
    const numericValue = Number(val.value);
    facade.setInput(engine, name, numericValue);
    inputRecord[name] = numericValue;
  }

  // Handle clock inputs: toggle high → stable → low → stable
  if (clockInputs.length > 0) {
    for (const name of clockInputs) {
      facade.setInput(engine, name, 1);
      inputRecord[name] = 1;
    }
    facade.runToStable(engine);

    for (const name of clockInputs) {
      facade.setInput(engine, name, 0);
    }
    facade.runToStable(engine);
  } else {
    // No clock inputs — propagate the regular inputs
    facade.runToStable(engine);
  }

  // Read all outputs and compare
  let vectorPassed = true;

  for (const name of testData.outputNames) {
    const expected = vector.outputs.get(name);
    const actual = facade.readOutput(engine, name);
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

    // kind === 'value' — exact numeric match
    const expectedNum = Number(expected.value);
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
