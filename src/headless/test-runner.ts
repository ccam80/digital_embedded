/**
 * TestRunner — wires the test data parser and executor into the SimulatorFacade.
 *
 * Supports both embedded test data (extracted from Testcase components in the
 * circuit) and external test vectors supplied by the caller.
 *
 * Pipeline:
 *   1. Resolve test data string (external override OR extracted from Testcase components)
 *   2. Parse test data → ParsedTestData (via testing/parser)
 *   3. Execute test vectors against the engine (via testing/executor)
 *   4. Return TestResults
 *
 * This module has no browser dependencies and runs in Node.js.
 */

import type { Circuit } from "../core/circuit.js";
import type { SimulationEngine } from "../core/engine-interface.js";
import type { TestResults } from "./types.js";
import { FacadeError } from "./types.js";
import { TestcaseElement } from "../components/misc/testcase.js";
import { parseTestData } from "../testing/parser.js";
import { executeTests } from "../testing/executor.js";
import type { RunnerFacade } from "../testing/executor.js";

export type { RunnerFacade };

// ---------------------------------------------------------------------------
// TestRunner
// ---------------------------------------------------------------------------

/**
 * Headless test runner.
 *
 * Implements the runTests() pipeline for SimulatorFacade:
 *   resolve test data → parse → execute → collect results.
 */
export class TestRunner {
  private readonly _runner: RunnerFacade;

  constructor(runner: RunnerFacade) {
    this._runner = runner;
  }

  /**
   * Run all test vectors against the engine.
   *
   * If testData is provided, it is used directly.
   * Otherwise, test data is extracted from all Testcase components in the circuit.
   * Throws FacadeError if no test data is available from either source.
   *
   * @param engine       The compiled engine.
   * @param circuit      The circuit (used for Testcase component lookup when testData is absent).
   * @param testData     Optional external test vector string (Digital test format).
   * @returns            TestResults with per-vector pass/fail details.
   * @throws FacadeError if no test data is available.
   */
  runTests(
    engine: SimulationEngine,
    circuit: Circuit,
    testData?: string,
  ): TestResults {
    const resolvedData = testData ?? extractEmbeddedTestData(circuit);

    if (resolvedData === null || resolvedData.trim().length === 0) {
      throw new FacadeError(
        "No test data available: circuit contains no Testcase components and no external test data was provided.",
      );
    }

    // Infer inputCount from the circuit's In/Clock elements when the test
    // data doesn't contain an explicit "|" separator.
    let inputCount: number | undefined;
    if (!resolvedData.includes('|')) {
      const inputLabels = new Set<string>();
      for (const el of circuit.elements) {
        if (el.typeId === 'In' || el.typeId === 'Clock') {
          const label = el.getProperties().getOrDefault<string>('label', '');
          if (label) inputLabels.add(label);
        }
      }
      if (inputLabels.size > 0) {
        const headerLine = resolvedData.split('\n').find(l => l.trim().length > 0 && !l.trim().startsWith('#'));
        if (headerLine) {
          const names = headerLine.trim().split(/\s+/);
          let count = 0;
          for (const name of names) {
            if (inputLabels.has(name)) {
              count++;
            } else {
              break;
            }
          }
          if (count > 0 && count < names.length) {
            inputCount = count;
          }
        }
      }
    }

    const parsed = parseTestData(resolvedData, inputCount);
    return executeTests(this._runner, engine, circuit, parsed);
  }
}

// ---------------------------------------------------------------------------
// extractEmbeddedTestData — collect test data from all Testcase elements
// ---------------------------------------------------------------------------

/**
 * Extract and concatenate test data from all Testcase components in the circuit.
 *
 * Multiple Testcase components are supported. Their test data strings are
 * concatenated with a newline separator. If the combined result is empty,
 * returns null.
 *
 * @param circuit  Circuit to search for Testcase elements.
 * @returns        Combined test data string, or null if none found.
 */
export function extractEmbeddedTestData(circuit: Circuit): string | null {
  const parts: string[] = [];

  for (const element of circuit.elements) {
    if (element instanceof TestcaseElement) {
      const data = element.testData.trim();
      if (data.length > 0) {
        parts.push(data);
      }
    }
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join("\n");
}
