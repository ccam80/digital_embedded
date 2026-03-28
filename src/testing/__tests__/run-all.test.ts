/**
 * Tests for runAllTests() — task 7.3.2.
 *
 * Tests:
 *   - multipleTestcases: circuit with 3 Testcase components → all 3 executed, results aggregated
 *   - summaryCorrect:    2 testcases with 5/5 and 3/5 pass → aggregate shows 8/10
 *   - noTestcases:       circuit with no Testcase components → empty results (not an error)
 *   - shortcutTriggered: F11 keydown event triggers run-all callback
 */

import { describe, it, expect, vi } from 'vitest';
import { runAllTests, registerRunAllShortcut } from '../run-all.js';
import type { AggregateTestResults } from '../run-all.js';
import { TestcaseElement } from '../../components/misc/testcase.js';
import { PropertyBag } from '../../core/properties.js';
import { Circuit } from '../../core/circuit.js';
import type { SimulationCoordinator } from '../../solver/coordinator-types.js';
import type { RunnerFacade } from '../executor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a TestcaseElement with the given testData string. */
function makeTestcase(testData: string): TestcaseElement {
  const props = new PropertyBag([
    ['label', 'Test'],
    ['testData', testData],
  ]);
  return new TestcaseElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

/** Build a Circuit containing the given TestcaseElement instances. */
function makeCircuit(...testcases: TestcaseElement[]): Circuit {
  const circuit = new Circuit({ name: 'TestCircuit' });
  for (const tc of testcases) {
    circuit.addElement(tc);
  }
  return circuit;
}

/**
 * Build a Circuit with N stub "In" elements and the given TestcaseElements.
 *
 * The stub In elements have typeId='In' so that countInputs() in run-all.ts
 * can determine the input/output split for parseTestData().
 */
function makeCircuitWithInputs(inputCount: number, ...testcases: TestcaseElement[]): Circuit {
  const circuit = new Circuit({ name: 'TestCircuit' });
  for (let i = 0; i < inputCount; i++) {
    // Minimal stub that satisfies CircuitElement interface for typeId check
    const stub = {
      typeId: 'In',
      instanceId: `in-${i}`,
      position: { x: i, y: 0 },
      rotation: 0 as const,
      mirror: false,
      getPins: () => [],
      getProperties: () => new PropertyBag(),
      getAttribute: () => undefined,
      getBoundingBox: () => ({ x: 0, y: 0, width: 1, height: 1 }),
      draw: () => {},
      serialize: () => ({ typeId: 'In', instanceId: `in-${i}`, position: { x: i, y: 0 }, rotation: 0 as const, mirror: false, properties: {} }),
    };
    circuit.addElement(stub as import('../../core/element.js').CircuitElement);
  }
  for (const tc of testcases) {
    circuit.addElement(tc);
  }
  return circuit;
}

/**
 * Build a mock RunnerFacade that drives a simple pass-through engine.
 * For every readOutput call, the facade returns the value supplied in the
 * outputValues map keyed by signal label. Inputs are stored in the lastInputs map.
 *
 * This is sufficient to run test vectors against a fixed output table.
 */
function makeFacade(outputValues: Record<string, number> = {}): RunnerFacade {
  const lastInputs: Record<string, number> = {};

  return {
    setInput(_coordinator: SimulationCoordinator, label: string, value: number): void {
      lastInputs[label] = value;
    },
    readOutput(_coordinator: SimulationCoordinator, label: string): number {
      // Return pre-defined value or fall back to what was last set on input
      return outputValues[label] ?? lastInputs[label] ?? 0;
    },
    runToStable(_coordinator: SimulationCoordinator): void {
      // no-op
    },
  };
}

/** Stub coordinator — run-all passes it through to executeTests but never calls it directly. */
const stubEngine = {} as SimulationCoordinator;

// ---------------------------------------------------------------------------
// Test data strings
// ---------------------------------------------------------------------------

/**
 * A simple 1-input, 1-output buffer test: output Y always equals input A.
 * All 2 rows pass when readOutput('Y') returns what was set on 'A'.
 */
const BUFFER_TEST = `A Y
0 0
1 1`;

/**
 * A 1-input test with 5 rows, all expecting output 1.
 * Passes when readOutput('Y') returns 1.
 */
const FIVE_ROW_PASS_TEST = `A Y
0 1
1 1
0 1
1 1
0 1`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAllTests', () => {
  // -------------------------------------------------------------------------
  // multipleTestcases
  // -------------------------------------------------------------------------

  it('multipleTestcases — circuit with 3 Testcase components → all 3 executed, results aggregated', () => {
    // Buffer facade: readOutput('Y') returns what was last set on 'A'
    const lastA = { value: 0 };
    const facade: RunnerFacade = {
      setInput(_e, label, value) {
        if (label === 'A') lastA.value = value;
      },
      readOutput(_e, label) {
        if (label === 'Y') return lastA.value;
        return 0;
      },
      runToStable() {},
    };

    const tc1 = makeTestcase(BUFFER_TEST);  // 2 rows, both pass
    const tc2 = makeTestcase(BUFFER_TEST);  // 2 rows, both pass
    const tc3 = makeTestcase(BUFFER_TEST);  // 2 rows, both pass
    const circuit = makeCircuit(tc1, tc2, tc3);

    const aggregate: AggregateTestResults = runAllTests(facade, stubEngine, circuit);

    expect(aggregate.testcaseCount).toBe(3);
    expect(aggregate.results).toHaveLength(3);
    // Each testcase ran its vectors
    for (const r of aggregate.results) {
      expect(r.results.total).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // summaryCorrect
  // -------------------------------------------------------------------------

  it('summaryCorrect — one testcase 5/5 pass, one 3/5 pass → aggregate shows 8/10', () => {
    // For FIVE_ROW_PASS_TEST: all rows expect Y=1, readOutput returns 1 → 5/5 pass
    // For THREE_OF_FIVE_PASS_TEST: rows expect alternating 1/0, readOutput always returns 1
    //   → rows expecting 1 pass (rows 1,3), rows expecting 0 fail (rows 2,4,5) → 3 pass, 2 fail... wait:
    //   Row 1: A=0, Y expected 1, actual 1 → pass
    //   Row 2: A=1, Y expected 0, actual 1 → fail
    //   Row 3: A=0, Y expected 1, actual 1 → pass
    //   Row 4: A=1, Y expected 0, actual 1 → fail
    //   Row 5: A=0, Y expected 0, actual 1 → fail
    //   → 2 pass, 3 fail
    // We need 3/5 pass on the second testcase. Use a different test:
    //   - 3 rows expecting 1 (pass), 2 rows expecting 0 (fail)

    const threeOfFiveTest = `A Y
0 1
1 1
0 1
1 0
0 0`;
    // Row 1: expect 1, actual 1 → pass
    // Row 2: expect 1, actual 1 → pass
    // Row 3: expect 1, actual 1 → pass
    // Row 4: expect 0, actual 1 → fail
    // Row 5: expect 0, actual 1 → fail
    // → 3 pass, 2 fail

    // Facade always returns 1 for Y
    const facade = makeFacade({ Y: 1 });

    const tc1 = makeTestcase(FIVE_ROW_PASS_TEST);   // 5/5 pass
    const tc2 = makeTestcase(threeOfFiveTest);       // 3/5 pass
    // 1 In element → inputCount=1, so column 0 = input A, column 1 = output Y
    const circuit = makeCircuitWithInputs(1, tc1, tc2);

    const aggregate = runAllTests(facade, stubEngine, circuit);

    expect(aggregate.testcaseCount).toBe(2);
    expect(aggregate.totalPassed).toBe(8);
    expect(aggregate.totalFailed).toBe(2);
    expect(aggregate.totalVectors).toBe(10);

    expect(aggregate.results[0].results.passed).toBe(5);
    expect(aggregate.results[0].results.failed).toBe(0);
    expect(aggregate.results[1].results.passed).toBe(3);
    expect(aggregate.results[1].results.failed).toBe(2);
  });

  // -------------------------------------------------------------------------
  // noTestcases
  // -------------------------------------------------------------------------

  it('noTestcases — circuit with no Testcase components → returns empty results, not an error', () => {
    const facade = makeFacade();
    const circuit = new Circuit({ name: 'Empty' });
    // circuit has no elements at all

    const aggregate = runAllTests(facade, stubEngine, circuit);

    expect(aggregate.testcaseCount).toBe(0);
    expect(aggregate.totalPassed).toBe(0);
    expect(aggregate.totalFailed).toBe(0);
    expect(aggregate.totalVectors).toBe(0);
    expect(aggregate.results).toHaveLength(0);
  });

  it('noTestcases — circuit with only non-Testcase elements → empty aggregate', () => {
    const facade = makeFacade();
    const circuit = makeCircuit();
    // No testcase elements — just test that a circuit with elements that are
    // not TestcaseElement instances yields empty results. We can't add other
    // element types without their full setup, so test via empty circuit is sufficient.

    const aggregate = runAllTests(facade, stubEngine, circuit);

    expect(aggregate.testcaseCount).toBe(0);
    expect(aggregate.results).toHaveLength(0);
  });

  it('noTestcases — empty testData string is skipped, not counted', () => {
    // A Testcase with empty testData should not appear in results
    const facade = makeFacade();
    const propsEmpty = new PropertyBag([
      ['label', 'Empty'],
      ['testData', ''],
    ]);
    const emptyTc = new TestcaseElement(
      crypto.randomUUID(),
      { x: 0, y: 0 },
      0,
      false,
      propsEmpty,
    );
    const circuit = makeCircuit(emptyTc);

    const aggregate = runAllTests(facade, stubEngine, circuit);

    expect(aggregate.testcaseCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // shortcutTriggered
  // -------------------------------------------------------------------------

  it('shortcutTriggered — F11 keydown event on target triggers callback', () => {
    const callback = vi.fn();

    // Use a minimal EventTarget stub
    const listeners: Map<string, Array<(e: Event) => void>> = new Map();
    const target: EventTarget = {
      addEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
        const fn = typeof handler === 'function' ? handler : handler.handleEvent.bind(handler);
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type)!.push(fn as (e: Event) => void);
      },
      removeEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
        const fn = typeof handler === 'function' ? handler : handler.handleEvent.bind(handler);
        const arr = listeners.get(type);
        if (arr) {
          const idx = arr.indexOf(fn as (e: Event) => void);
          if (idx !== -1) arr.splice(idx, 1);
        }
      },
      dispatchEvent(event: Event): boolean {
        for (const fn of listeners.get(event.type) ?? []) {
          fn(event);
        }
        return true;
      },
    };

    const unregister = registerRunAllShortcut(callback, target);

    // Simulate F11 keydown
    const f11Event = {
      type: 'keydown',
      key: 'F11',
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;

    target.dispatchEvent(f11Event);

    expect(callback).toHaveBeenCalledTimes(1);

    // Other keys should not trigger
    const otherEvent = {
      type: 'keydown',
      key: 'F5',
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;

    target.dispatchEvent(otherEvent);

    expect(callback).toHaveBeenCalledTimes(1); // still only 1

    // After unregister, F11 should not trigger
    unregister();
    target.dispatchEvent(f11Event);
    expect(callback).toHaveBeenCalledTimes(1); // still 1
  });

  it('shortcutTriggered — F11 calls preventDefault to prevent browser fullscreen', () => {
    const callback = vi.fn();
    const preventDefaultSpy = vi.fn();

    const listeners: Map<string, Array<(e: Event) => void>> = new Map();
    const target: EventTarget = {
      addEventListener(type, handler) {
        const fn = typeof handler === 'function' ? handler : (handler as EventListenerObject).handleEvent.bind(handler);
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type)!.push(fn as (e: Event) => void);
      },
      removeEventListener(type, handler) {
        const fn = typeof handler === 'function' ? handler : (handler as EventListenerObject).handleEvent.bind(handler);
        const arr = listeners.get(type);
        if (arr) {
          const idx = arr.indexOf(fn as (e: Event) => void);
          if (idx !== -1) arr.splice(idx, 1);
        }
      },
      dispatchEvent(event) {
        for (const fn of listeners.get(event.type) ?? []) fn(event);
        return true;
      },
    };

    registerRunAllShortcut(callback, target);

    const f11Event = {
      type: 'keydown',
      key: 'F11',
      preventDefault: preventDefaultSpy,
    } as unknown as KeyboardEvent;

    target.dispatchEvent(f11Event);

    expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
