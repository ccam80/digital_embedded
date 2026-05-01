/**
 * Batch Test Runner- run tests across multiple .dig circuit files.
 *
 * Accepts a map of filename → XML content strings. For each file:
 *   1. Parse the XML into a Circuit (via facade.loadDig)
 *   2. Compile the circuit (via facade.compile)
 *   3. Run tests using either embedded Testcase components or external test data
 *   4. Collect per-file results
 *
 * Errors in one file (parse errors, compile errors) do not stop others.
 * The function returns an aggregate BatchTestResults object.
 *
 * Works in both browser and Node.js environments- no filesystem access is
 * performed here. The caller provides content strings directly.
 */

import type { SimulatorFacade } from '../headless/facade.js';
import type { TestResults } from '../headless/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result for a single .dig file in a batch run.
 */
export interface FileTestResult {
  /** The filename key as supplied in the files map. */
  fileName: string;
  /** Whether all test vectors passed, some failed, or there was a hard error. */
  status: 'passed' | 'failed' | 'error';
  /** Per-vector results (absent when status is 'error'). */
  testResults?: TestResults;
  /** Error message (present when status is 'error'). */
  error?: string;
}

/**
 * Aggregate results from a batch test run across multiple .dig files.
 */
export interface BatchTestResults {
  /** Total number of files processed. */
  totalFiles: number;
  /** Number of files where all test vectors passed. */
  passedFiles: number;
  /** Number of files where one or more test vectors failed. */
  failedFiles: number;
  /** Number of files that could not be loaded or compiled. */
  errorFiles: number;
  /** Per-file results in the order the files map iterates. */
  results: FileTestResult[];
}

// ---------------------------------------------------------------------------
// runBatchTests
// ---------------------------------------------------------------------------

/**
 * Run tests across multiple .dig circuit files.
 *
 * @param facade    The SimulatorFacade (provides loadDig, compile, runTests)
 * @param files     Map of fileName → XML content. Iterated in insertion order.
 * @param testData  Optional external test vectors (same string applied to all files).
 *                  When provided, overrides any embedded Testcase components in
 *                  each file. When absent, each file's embedded Testcase components
 *                  are used.
 * @returns         BatchTestResults aggregate across all files.
 */
export async function runBatchTests(
  facade: SimulatorFacade,
  files: Map<string, string>,
  testData?: string,
): Promise<BatchTestResults> {
  const results: FileTestResult[] = [];
  let passedFiles = 0;
  let failedFiles = 0;
  let errorFiles = 0;

  for (const [fileName, content] of files) {
    const fileResult = await runSingleFile(facade, fileName, content, testData);
    results.push(fileResult);

    switch (fileResult.status) {
      case 'passed': passedFiles++; break;
      case 'failed': failedFiles++; break;
      case 'error':  errorFiles++;  break;
    }
  }

  return {
    totalFiles: files.size,
    passedFiles,
    failedFiles,
    errorFiles,
    results,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Run tests for a single .dig file content string.
 *
 * Returns a FileTestResult. If loading or compilation fails, returns
 * `status: 'error'` with the error message. If tests run and all pass,
 * returns `status: 'passed'`. If any fail, returns `status: 'failed'`.
 */
async function runSingleFile(
  facade: SimulatorFacade,
  fileName: string,
  content: string,
  testData?: string,
): Promise<FileTestResult> {
  let circuit;
  try {
    circuit = facade.loadDigXml(content);
  } catch (err) {
    return {
      fileName,
      status: 'error',
      error: errorMessage(err),
    };
  }

  let engine;
  try {
    engine = facade.compile(circuit);
  } catch (err) {
    return {
      fileName,
      status: 'error',
      error: errorMessage(err),
    };
  }

  let testResults: TestResults;
  try {
    testResults = await facade.runTests(engine, circuit, testData);
  } catch (err) {
    return {
      fileName,
      status: 'error',
      error: errorMessage(err),
    };
  }

  const status = testResults.failed === 0 ? 'passed' : 'failed';
  return {
    fileName,
    status,
    testResults,
  };
}

/**
 * Extract a human-readable message from an unknown error value.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
