/**
 * Tests for executeTests() — task 6.3.2.
 *
 * Uses a mock SimulatorFacade and SimulationEngine to test the executor
 * logic in isolation. The mock facade records calls to setInput/readOutput/
 * runToStable so tests can assert correct sequencing.
 *
 * Test scenarios:
 *   - allPass: correct truth table → all vectors pass
 *   - someFail: deliberate wrong expected value → that vector fails
 *   - dontCareAlwaysPasses: X in output → passes regardless of actual value
 *   - clockToggle: clock input → engine stepped twice (rising + falling edge)
 *   - resultsStructure: verify TestResults shape
 */

import { describe, it, expect, vi } from "vitest";
import { executeTests } from "../executor.js";
import type { ParsedTestData, ParsedVector, TestValue } from "../executor.js";
import type { SimulatorFacade } from "@/headless/facade";
import type { SimulationCoordinator } from "@/solver/coordinator-types";
import type { Circuit } from "@/core/circuit";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock SimulatorFacade that lets tests control what
 * readOutput returns and track calls to setInput/runToStable.
 */
function makeMockFacade(outputValues: Record<string, number> = {}): {
  facade: SimulatorFacade;
  calls: { setInput: Array<[string, number]>; runToStable: number };
} {
  const calls = { setInput: [] as Array<[string, number]>, runToStable: 0 };

  const facade = {
    setInput: vi.fn((_coordinator: SimulationCoordinator, label: string, value: number) => {
      calls.setInput.push([label, value]);
    }),
    readOutput: vi.fn((_coordinator: SimulationCoordinator, label: string): number => {
      return outputValues[label] ?? 0;
    }),
    runToStable: vi.fn((_coordinator: SimulationCoordinator) => {
      calls.runToStable++;
    }),
    // Unused facade methods — present to satisfy the interface
    createCircuit: vi.fn(),
    addComponent: vi.fn(),
    connect: vi.fn(),
    compile: vi.fn(),
    step: vi.fn(),
    run: vi.fn(),
    readAllSignals: vi.fn(),
    runTests: vi.fn(),
    loadDig: vi.fn(),
    serialize: vi.fn(),
    deserialize: vi.fn(),
  } as unknown as SimulatorFacade;

  return { facade, calls };
}

/** A stub coordinator — the executor only passes it through to the facade. */
const stubEngine = {} as SimulationCoordinator;

/** A stub circuit — unused by the executor logic. */
const stubCircuit = {} as Circuit;

/** Helper to build a TestValue with kind='value'. */
function val(n: number | bigint): TestValue {
  return { kind: "value", value: typeof n === "bigint" ? n : BigInt(n) };
}

/** Helper to build a don't-care TestValue. */
function dontCare(): TestValue {
  return { kind: "dontCare" };
}

/** Helper to build a clock TestValue. */
function clock(): TestValue {
  return { kind: "clock" };
}

/**
 * Build a simple ParsedTestData for a 2-input, 1-output truth table.
 * inputs: A, B → output: Y
 */
function buildSimpleTestData(
  vectors: Array<{ A: number | bigint; B: number | bigint; Y: TestValue }>
): ParsedTestData {
  const parsedVectors: ParsedVector[] = vectors.map(({ A, B, Y }) => ({
    inputs: new Map<string, TestValue>([
      ["A", val(A)],
      ["B", val(B)],
    ]),
    outputs: new Map<string, TestValue>([["Y", Y]]),
  }));

  return {
    inputNames: ["A", "B"],
    outputNames: ["Y"],
    vectors: parsedVectors,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeTests", () => {
  // -------------------------------------------------------------------------
  // allPass
  // -------------------------------------------------------------------------

  it("allPass — AND gate truth table with all correct expected outputs → all vectors pass", () => {
    // AND gate: Y = A AND B
    // Output map: exact match for each input combo
    const { facade } = makeMockFacade({});

    // Make readOutput return the AND of whatever was last set
    let lastA = 0;
    let lastB = 0;
    const andFacade = {
      ...facade,
      setInput: vi.fn((_coordinator: SimulationCoordinator, label: string, value: number) => {
        if (label === "A") lastA = value;
        if (label === "B") lastB = value;
      }),
      readOutput: vi.fn((_coordinator: SimulationCoordinator, _label: string): number => {
        return lastA & lastB;
      }),
      runToStable: vi.fn(),
    } as unknown as SimulatorFacade;

    const testData = buildSimpleTestData([
      { A: 0, B: 0, Y: val(0) },
      { A: 0, B: 1, Y: val(0) },
      { A: 1, B: 0, Y: val(0) },
      { A: 1, B: 1, Y: val(1) },
    ]);

    const results = executeTests(andFacade, stubEngine, stubCircuit, testData);

    expect(results.total).toBe(4);
    expect(results.passed).toBe(4);
    expect(results.failed).toBe(0);
    expect(results.vectors).toHaveLength(4);
    expect(results.vectors.every((v) => v.passed)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // someFail
  // -------------------------------------------------------------------------

  it("someFail — deliberate wrong expected value on row 2 → that vector fails, others pass", () => {
    // readOutput always returns 0
    const { facade } = makeMockFacade({ Y: 0 });

    const testData = buildSimpleTestData([
      { A: 0, B: 0, Y: val(0) }, // correct: expected 0, actual 0
      { A: 0, B: 1, Y: val(1) }, // wrong:   expected 1, actual 0
      { A: 1, B: 0, Y: val(0) }, // correct: expected 0, actual 0
    ]);

    const results = executeTests(facade, stubEngine, stubCircuit, testData);

    expect(results.total).toBe(3);
    expect(results.passed).toBe(2);
    expect(results.failed).toBe(1);
    expect(results.vectors[0].passed).toBe(true);
    expect(results.vectors[1].passed).toBe(false);
    expect(results.vectors[2].passed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // dontCareAlwaysPasses
  // -------------------------------------------------------------------------

  it("dontCareAlwaysPasses — output expectation is X → passes regardless of actual value", () => {
    // readOutput returns arbitrary values
    const { facade } = makeMockFacade({ Y: 42 });

    const testData: ParsedTestData = {
      inputNames: ["A"],
      outputNames: ["Y"],
      vectors: [
        {
          inputs: new Map([["A", val(0)]]),
          outputs: new Map([["Y", dontCare()]]),
        },
        {
          inputs: new Map([["A", val(1)]]),
          outputs: new Map([["Y", dontCare()]]),
        },
      ],
    };

    const results = executeTests(facade, stubEngine, stubCircuit, testData);

    expect(results.total).toBe(2);
    expect(results.passed).toBe(2);
    expect(results.failed).toBe(0);
    expect(results.vectors.every((v) => v.passed)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // clockToggle
  // -------------------------------------------------------------------------

  it("clockToggle — clock input in vector → setInput called with 1 then 0, runToStable called twice", () => {
    const { facade, calls } = makeMockFacade({ Q: 0 });

    const testData: ParsedTestData = {
      inputNames: ["CLK"],
      outputNames: ["Q"],
      vectors: [
        {
          inputs: new Map<string, TestValue>([["CLK", clock()]]),
          outputs: new Map<string, TestValue>([["Q", val(0)]]),
        },
      ],
    };

    executeTests(facade, stubEngine, stubCircuit, testData);

    // Clock toggle: setInput(CLK, 1) then setInput(CLK, 0)
    const clockCalls = calls.setInput.filter(([label]) => label === "CLK");
    expect(clockCalls).toHaveLength(2);
    expect(clockCalls[0]).toEqual(["CLK", 1]);
    expect(clockCalls[1]).toEqual(["CLK", 0]);

    // runToStable called three times: once to propagate regular inputs before
    // clock toggle, once after rising edge, once after falling edge
    expect(calls.runToStable).toBe(3);
  });

  // -------------------------------------------------------------------------
  // resultsStructure
  // -------------------------------------------------------------------------

  it("resultsStructure — TestResults has correct passed, failed, total counts and vectors array length", () => {
    // 5 vectors, readOutput always returns 1, expected values mix of 0 and 1
    const { facade } = makeMockFacade({ Y: 1 });

    const testData = buildSimpleTestData([
      { A: 0, B: 0, Y: val(1) }, // pass
      { A: 0, B: 1, Y: val(0) }, // fail (actual=1, expected=0)
      { A: 1, B: 0, Y: val(1) }, // pass
      { A: 1, B: 1, Y: val(1) }, // pass
      { A: 0, B: 0, Y: val(0) }, // fail (actual=1, expected=0)
    ]);

    const results = executeTests(facade, stubEngine, stubCircuit, testData);

    expect(results.total).toBe(5);
    expect(results.passed).toBe(3);
    expect(results.failed).toBe(2);
    expect(results.vectors).toHaveLength(5);

    // Each vector has the required fields
    for (const v of results.vectors) {
      expect(typeof v.passed).toBe("boolean");
      expect(typeof v.inputs).toBe("object");
      expect(typeof v.expectedOutputs).toBe("object");
      expect(typeof v.actualOutputs).toBe("object");
    }

    // Spot-check individual vector pass/fail
    expect(results.vectors[0].passed).toBe(true);
    expect(results.vectors[1].passed).toBe(false);
    expect(results.vectors[2].passed).toBe(true);
    expect(results.vectors[3].passed).toBe(true);
    expect(results.vectors[4].passed).toBe(false);
  });
});
