/**
 * Tests for runBatchTests()- task 7.3.3.
 *
 * Tests:
 *   - multipleFiles:      3 files, all pass → passedFiles: 3
 *   - mixedResults:       2 pass, 1 fail → correct counts
 *   - errorFile:          1 file has invalid XML → status: 'error' with message, others still tested
 *   - externalTestData:   external test vectors applied to all files
 */

import { describe, it, expect, vi } from 'vitest';
import { runBatchTests } from '../batch-runner.js';
import type { BatchTestResults } from '../batch-runner.js';
import type { SimulatorFacade } from '../../headless/facade.js';
import type { Circuit } from '../../core/circuit.js';
import type { SimulationCoordinator } from '../../solver/coordinator-types.js';
import type { TestResults } from '../../headless/types.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Build a TestResults object with the given pass/fail counts. */
function makeTestResults(passed: number, failed: number): TestResults {
  return {
    passed,
    failed,
    total: passed + failed,
    vectors: [],
  };
}

/**
 * Build a mock SimulatorFacade for batch testing.
 *
 * The facade tracks the most-recently loaded content string so that compile()
 * and runTests() can look up per-file behaviour. The facade object is
 * constructed without duplicate keys to avoid the ESBuild duplicate-key warning.
 *
 * @param fileResults   Map from file content string → TestResults to return.
 * @param defaultResults  Returned by runTests when content not in fileResults.
 * @param loadErrors    Set of content strings that cause loadDig to throw.
 * @param compileErrors Set of content strings that cause compile to throw.
 * @param capturedTestData  Object whose .value is set to the testData arg on each runTests call.
 */
function makeBatchFacade(options: {
  fileResults?: Map<string, TestResults>;
  defaultResults?: TestResults;
  loadErrors?: Set<string>;
  compileErrors?: Set<string>;
  capturedTestData?: { value: string | undefined };
} = {}): SimulatorFacade {
  const {
    fileResults = new Map(),
    defaultResults = makeTestResults(1, 0),
    loadErrors = new Set(),
    compileErrors = new Set(),
    capturedTestData,
  } = options;

  // Track the content string loaded in the most recent loadDig call,
  // so compile() and runTests() can look up per-file behaviour.
  let lastContent = '';

  const facade: Partial<SimulatorFacade> = {
    loadDigXml(content: string): Circuit {
      if (loadErrors.has(content)) {
        throw new Error(`XML parse error: invalid content for ${content}`);
      }
      lastContent = content;
      return {} as Circuit;
    },

    compile(_circuit: Circuit): SimulationCoordinator {
      if (compileErrors.has(lastContent)) {
        throw new Error(`Compile error for: ${lastContent}`);
      }
      return {} as SimulationCoordinator;
    },

    runTests(_engine: SimulationCoordinator, _circuit: Circuit, testData?: string): Promise<TestResults> {
      if (capturedTestData !== undefined) {
        capturedTestData.value = testData;
      }
      return Promise.resolve(fileResults.get(lastContent) ?? defaultResults);
    },

    // Stub the remaining facade methods
    createCircuit: vi.fn(),
    addComponent: vi.fn(),
    connect: vi.fn(),
    step: vi.fn(),
    run: vi.fn(),
    settle: vi.fn(),
    setSignal: vi.fn(),
    readSignal: vi.fn(),
    readAllSignals: vi.fn(),
    serialize: vi.fn(),
    deserialize: vi.fn(),
  };

  return facade as SimulatorFacade;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runBatchTests', () => {
  // -------------------------------------------------------------------------
  // multipleFiles
  // -------------------------------------------------------------------------

  it('multipleFiles- 3 files, all pass → passedFiles: 3', async () => {
    const facade = makeBatchFacade({
      defaultResults: makeTestResults(5, 0),
    });

    const files = new Map([
      ['circuit1.dig', '<circuit1>'],
      ['circuit2.dig', '<circuit2>'],
      ['circuit3.dig', '<circuit3>'],
    ]);

    const batch: BatchTestResults = await runBatchTests(facade, files);

    expect(batch.totalFiles).toBe(3);
    expect(batch.passedFiles).toBe(3);
    expect(batch.failedFiles).toBe(0);
    expect(batch.errorFiles).toBe(0);
    expect(batch.results).toHaveLength(3);
    for (const r of batch.results) {
      expect(r.status).toBe('passed');
      expect(r.testResults).toBeDefined();
    }
  });

  it('multipleFiles- file names preserved in results in insertion order', async () => {
    const facade = makeBatchFacade({ defaultResults: makeTestResults(1, 0) });

    const files = new Map([
      ['alpha.dig', '<a>'],
      ['beta.dig', '<b>'],
      ['gamma.dig', '<c>'],
    ]);

    const batch = await runBatchTests(facade, files);

    expect(batch.results[0].fileName).toBe('alpha.dig');
    expect(batch.results[1].fileName).toBe('beta.dig');
    expect(batch.results[2].fileName).toBe('gamma.dig');
  });

  // -------------------------------------------------------------------------
  // mixedResults
  // -------------------------------------------------------------------------

  it('mixedResults- 2 pass, 1 fail → correct counts', async () => {
    const fileResults = new Map([
      ['<pass1>', makeTestResults(5, 0)],
      ['<pass2>', makeTestResults(3, 0)],
      ['<fail1>', makeTestResults(2, 3)],
    ]);

    const facade = makeBatchFacade({ fileResults });

    const files = new Map([
      ['pass1.dig', '<pass1>'],
      ['pass2.dig', '<pass2>'],
      ['fail1.dig', '<fail1>'],
    ]);

    const batch = await runBatchTests(facade, files);

    expect(batch.totalFiles).toBe(3);
    expect(batch.passedFiles).toBe(2);
    expect(batch.failedFiles).toBe(1);
    expect(batch.errorFiles).toBe(0);

    const failResult = batch.results.find((r) => r.fileName === 'fail1.dig');
    expect(failResult).toBeDefined();
    expect(failResult!.status).toBe('failed');
    expect(failResult!.testResults?.failed).toBe(3);
    expect(failResult!.testResults?.passed).toBe(2);
  });

  it('mixedResults- failed file still has testResults attached', async () => {
    const fileResults = new Map([
      ['<fail>', makeTestResults(1, 4)],
    ]);

    const facade = makeBatchFacade({ fileResults, defaultResults: makeTestResults(5, 0) });

    const files = new Map([
      ['passing.dig', '<pass>'],
      ['failing.dig', '<fail>'],
    ]);

    const batch = await runBatchTests(facade, files);

    const failResult = batch.results.find((r) => r.fileName === 'failing.dig');
    expect(failResult!.status).toBe('failed');
    expect(failResult!.testResults).toBeDefined();
    expect(failResult!.testResults!.passed).toBe(1);
    expect(failResult!.testResults!.failed).toBe(4);
  });

  // -------------------------------------------------------------------------
  // errorFile
  // -------------------------------------------------------------------------

  it('errorFile- 1 file has invalid XML → status: error with message, others still tested', async () => {
    const facade = makeBatchFacade({
      defaultResults: makeTestResults(3, 0),
      loadErrors: new Set(['<INVALID_XML>']),
    });

    const files = new Map([
      ['good1.dig', '<circuit1>'],
      ['bad.dig', '<INVALID_XML>'],
      ['good2.dig', '<circuit2>'],
    ]);

    const batch = await runBatchTests(facade, files);

    expect(batch.totalFiles).toBe(3);
    expect(batch.passedFiles).toBe(2);
    expect(batch.failedFiles).toBe(0);
    expect(batch.errorFiles).toBe(1);

    const errResult = batch.results.find((r) => r.fileName === 'bad.dig');
    expect(errResult).toBeDefined();
    expect(errResult!.status).toBe('error');
    expect(errResult!.error).toBeDefined();
    expect(errResult!.error!.length).toBeGreaterThan(0);
    expect(errResult!.testResults).toBeUndefined();

    const good1 = batch.results.find((r) => r.fileName === 'good1.dig');
    const good2 = batch.results.find((r) => r.fileName === 'good2.dig');
    expect(good1!.status).toBe('passed');
    expect(good2!.status).toBe('passed');
  });

  it('errorFile- compile error counts as error, does not block other files', async () => {
    const facade = makeBatchFacade({
      defaultResults: makeTestResults(2, 0),
      compileErrors: new Set(['<bad-circuit>']),
    });

    const files = new Map([
      ['good.dig', '<good-circuit>'],
      ['broken.dig', '<bad-circuit>'],
    ]);

    const batch = await runBatchTests(facade, files);

    expect(batch.totalFiles).toBe(2);
    expect(batch.passedFiles).toBe(1);
    expect(batch.errorFiles).toBe(1);

    const brokenResult = batch.results.find((r) => r.fileName === 'broken.dig');
    expect(brokenResult!.status).toBe('error');
    expect(brokenResult!.error).toContain('Compile error');
  });

  it('errorFile- all files are errors → passedFiles: 0, errorFiles: N', async () => {
    const facade = makeBatchFacade({
      defaultResults: makeTestResults(1, 0),
      loadErrors: new Set(['<bad1>', '<bad2>']),
    });

    const files = new Map([
      ['bad1.dig', '<bad1>'],
      ['bad2.dig', '<bad2>'],
    ]);

    const batch = await runBatchTests(facade, files);

    expect(batch.totalFiles).toBe(2);
    expect(batch.passedFiles).toBe(0);
    expect(batch.errorFiles).toBe(2);
  });

  // -------------------------------------------------------------------------
  // externalTestData
  // -------------------------------------------------------------------------

  it('externalTestData- external test vectors passed to all files\' runTests calls', async () => {
    const capturedTestData: { value: string | undefined } = { value: undefined };
    const facade = makeBatchFacade({
      defaultResults: makeTestResults(4, 0),
      capturedTestData,
    });

    const externalVectors = 'A B Y\n0 0 0\n1 1 1\n';

    const files = new Map([
      ['circuit1.dig', '<c1>'],
      ['circuit2.dig', '<c2>'],
    ]);

    const batch = await runBatchTests(facade, files, externalVectors);

    expect(batch.passedFiles).toBe(2);
    expect(capturedTestData.value).toBe(externalVectors);
  });

  it('externalTestData- without external data, testData is undefined in runTests', async () => {
    const capturedTestData: { value: string | undefined } = { value: 'not-undefined' };
    const facade = makeBatchFacade({
      defaultResults: makeTestResults(2, 0),
      capturedTestData,
    });

    const files = new Map([['circuit.dig', '<c>']]);

    await runBatchTests(facade, files);

    expect(capturedTestData.value).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // emptyFiles
  // -------------------------------------------------------------------------

  it('emptyFiles- empty files map → zero everything', async () => {
    const facade = makeBatchFacade();

    const batch = await runBatchTests(facade, new Map());

    expect(batch.totalFiles).toBe(0);
    expect(batch.passedFiles).toBe(0);
    expect(batch.failedFiles).toBe(0);
    expect(batch.errorFiles).toBe(0);
    expect(batch.results).toHaveLength(0);
  });
});
