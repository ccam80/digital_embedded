/**
 * runAllTests- batch-execute every Testcase component in a circuit.
 *
 * Finds all TestcaseElement instances in the circuit's element list, runs
 * each through the test executor with the circuit's embedded test data, and
 * aggregates the results into an AggregateTestResults summary.
 *
 * This is the backing logic for the "Run All Tests" (F11) action.
 */

import type { Circuit } from '../core/circuit.js';
import type { SimulationCoordinator } from '../solver/coordinator-types.js';
import type { TestResults } from '../headless/types.js';
import { TestcaseElement } from '../components/misc/testcase.js';
import { parseTestData } from './parser.js';
import { executeTests } from './executor.js';
import type { RunnerFacade } from './executor.js';

// ---------------------------------------------------------------------------
// countInputs- derive inputCount from circuit topology
// ---------------------------------------------------------------------------

/**
 * Count the number of top-level input components in the circuit.
 *
 * Counts elements whose typeId is "In"- these correspond to the input pins
 * declared in the test header. The count is used as `inputCount` when parsing
 * embedded test data, so the parser correctly splits signal names into inputs
 * and outputs.
 *
 * Returns 0 if no In elements are found, which causes parseTestData to treat
 * all columns as inputs.
 */
function countInputs(circuit: Circuit): number {
  return circuit.elements.filter((el) => el.typeId === 'In').length;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Per-testcase result entry in an aggregate run.
 */
export interface TestcaseResult {
  /** The TestcaseElement that was executed. */
  testcase: TestcaseElement;
  /** The results from running this testcase's vectors. */
  results: TestResults;
}

/**
 * Aggregate results from running all Testcase components in a circuit.
 */
export interface AggregateTestResults {
  /** Total number of Testcase components found and run. */
  testcaseCount: number;
  /** Total test vectors that passed across all testcases. */
  totalPassed: number;
  /** Total test vectors that failed across all testcases. */
  totalFailed: number;
  /** Total test vectors across all testcases. */
  totalVectors: number;
  /** Per-testcase results, in element order. */
  results: TestcaseResult[];
}

// ---------------------------------------------------------------------------
// runAllTests
// ---------------------------------------------------------------------------

/**
 * Execute every Testcase component in the circuit and aggregate the results.
 *
 * For each TestcaseElement found in circuit.elements:
 *   1. Extract its testData string
 *   2. Parse with parseTestData()
 *   3. Execute with executeTests()
 *   4. Collect into AggregateTestResults
 *
 * If no Testcase components are present, returns an empty aggregate (not an error).
 *
 * @param facade   The simulation runner facade (setSignal/readSignal/settle)
 * @param engine   The compiled simulation engine
 * @param circuit  The circuit to scan for Testcase components
 * @returns        Aggregate test results across all testcases
 */
export async function runAllTests(
  facade: RunnerFacade,
  coordinator: SimulationCoordinator,
  circuit: Circuit,
): Promise<AggregateTestResults> {
  const perTestcase: TestcaseResult[] = [];
  let totalPassed = 0;
  let totalFailed = 0;

  for (const element of circuit.elements) {
    if (!(element instanceof TestcaseElement)) continue;

    const raw = element.testData.trim();
    if (raw.length === 0) continue;

    const inputCount = countInputs(circuit);
    const parsed = parseTestData(raw, inputCount > 0 ? inputCount : undefined);
    const results = await executeTests(facade, coordinator, circuit, parsed);

    perTestcase.push({ testcase: element, results });
    totalPassed += results.passed;
    totalFailed += results.failed;
  }

  return {
    testcaseCount: perTestcase.length,
    totalPassed,
    totalFailed,
    totalVectors: totalPassed + totalFailed,
    results: perTestcase,
  };
}

// ---------------------------------------------------------------------------
// registerRunAllShortcut
// ---------------------------------------------------------------------------

/**
 * Register the F11 keyboard shortcut to trigger run-all tests.
 *
 * Attaches a keydown listener on the given target element (or document).
 * When F11 is pressed, calls the provided callback.
 *
 * Returns an unregister function- call it to remove the listener.
 *
 * @param callback  Function to invoke when F11 is pressed.
 * @param target    Event target (defaults to globalThis document).
 * @returns         Cleanup function to deregister the shortcut.
 */
export function registerRunAllShortcut(
  callback: () => void,
  target: EventTarget = (globalThis as { document?: EventTarget }).document ?? globalThis,
): () => void {
  const handler = (event: Event): void => {
    const keyEvent = event as KeyboardEvent;
    if (keyEvent.key === 'F11') {
      keyEvent.preventDefault();
      callback();
    }
  };

  target.addEventListener('keydown', handler);

  return () => {
    target.removeEventListener('keydown', handler);
  };
}
