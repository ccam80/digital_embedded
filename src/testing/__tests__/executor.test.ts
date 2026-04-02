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
import { executeTests, withinTolerance } from "../executor.js";
import type { ParsedTestData, ParsedVector, TestValue } from "../executor.js";
import type { Tolerance } from "../parser.js";
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
  calls: { setSignal: Array<[string, number]>; settle: number; step: number };
} {
  const calls = { setSignal: [] as Array<[string, number]>, settle: 0, step: 0 };

  const facade = {
    setSignal: vi.fn((_coordinator: SimulationCoordinator, label: string, value: number) => {
      calls.setSignal.push([label, value]);
    }),
    readSignal: vi.fn((_coordinator: SimulationCoordinator, label: string): number => {
      return outputValues[label] ?? 0;
    }),
    settle: vi.fn((_coordinator: SimulationCoordinator) => {
      calls.settle++;
      return Promise.resolve();
    }),
    step: vi.fn((_coordinator: SimulationCoordinator) => {
      calls.step++;
    }),
    // Unused facade methods — present to satisfy the interface
    createCircuit: vi.fn(),
    addComponent: vi.fn(),
    connect: vi.fn(),
    compile: vi.fn(),
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

  it("allPass — AND gate truth table with all correct expected outputs → all vectors pass", async () => {
    // AND gate: Y = A AND B
    // Output map: exact match for each input combo
    const { facade } = makeMockFacade({});

    // Make readOutput return the AND of whatever was last set
    let lastA = 0;
    let lastB = 0;
    const andFacade = {
      ...facade,
      setSignal: vi.fn((_coordinator: SimulationCoordinator, label: string, value: number) => {
        if (label === "A") lastA = value;
        if (label === "B") lastB = value;
      }),
      readSignal: vi.fn((_coordinator: SimulationCoordinator, _label: string): number => {
        return lastA & lastB;
      }),
      settle: vi.fn(() => Promise.resolve()),
    } as unknown as SimulatorFacade;

    const testData = buildSimpleTestData([
      { A: 0, B: 0, Y: val(0) },
      { A: 0, B: 1, Y: val(0) },
      { A: 1, B: 0, Y: val(0) },
      { A: 1, B: 1, Y: val(1) },
    ]);

    const results = await executeTests(andFacade, stubEngine, stubCircuit, testData);

    expect(results.total).toBe(4);
    expect(results.passed).toBe(4);
    expect(results.failed).toBe(0);
    expect(results.vectors).toHaveLength(4);
    expect(results.vectors.every((v) => v.passed)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // someFail
  // -------------------------------------------------------------------------

  it("someFail — deliberate wrong expected value on row 2 → that vector fails, others pass", async () => {
    // readOutput always returns 0
    const { facade } = makeMockFacade({ Y: 0 });

    const testData = buildSimpleTestData([
      { A: 0, B: 0, Y: val(0) }, // correct: expected 0, actual 0
      { A: 0, B: 1, Y: val(1) }, // wrong:   expected 1, actual 0
      { A: 1, B: 0, Y: val(0) }, // correct: expected 0, actual 0
    ]);

    const results = await executeTests(facade, stubEngine, stubCircuit, testData);

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

  it("dontCareAlwaysPasses — output expectation is X → passes regardless of actual value", async () => {
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

    const results = await executeTests(facade, stubEngine, stubCircuit, testData);

    expect(results.total).toBe(2);
    expect(results.passed).toBe(2);
    expect(results.failed).toBe(0);
    expect(results.vectors.every((v) => v.passed)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // clockToggle
  // -------------------------------------------------------------------------

  it("clockToggle — clock input in vector → setSignal called with 1 then 0, settle called three times", async () => {
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

    await executeTests(facade, stubEngine, stubCircuit, testData);

    // Clock toggle: setSignal(CLK, 1) then setSignal(CLK, 0)
    const clockCalls = calls.setSignal.filter(([label]) => label === "CLK");
    expect(clockCalls).toHaveLength(2);
    expect(clockCalls[0]).toEqual(["CLK", 1]);
    expect(clockCalls[1]).toEqual(["CLK", 0]);

    // settle called three times: once to propagate regular inputs before the clock edge,
    // once after rising edge, once after falling edge
    expect(calls.settle).toBe(3);
  });

  // -------------------------------------------------------------------------
  // resultsStructure
  // -------------------------------------------------------------------------

  it("resultsStructure — TestResults has correct passed, failed, total counts and vectors array length", async () => {
    // 5 vectors, readOutput always returns 1, expected values mix of 0 and 1
    const { facade } = makeMockFacade({ Y: 1 });

    const testData = buildSimpleTestData([
      { A: 0, B: 0, Y: val(1) }, // pass
      { A: 0, B: 1, Y: val(0) }, // fail (actual=1, expected=0)
      { A: 1, B: 0, Y: val(1) }, // pass
      { A: 1, B: 1, Y: val(1) }, // pass
      { A: 0, B: 0, Y: val(0) }, // fail (actual=1, expected=0)
    ]);

    const results = await executeTests(facade, stubEngine, stubCircuit, testData);

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

// ---------------------------------------------------------------------------
// withinTolerance unit tests
// ---------------------------------------------------------------------------

describe("withinTolerance", () => {
  it("passes when actual equals expected (no tolerance)", () => {
    expect(withinTolerance(3.3, 3.3, {})).toBe(true);
  });

  it("fails when actual differs and no tolerance specified", () => {
    expect(withinTolerance(3.0, 3.3, {})).toBe(false);
  });

  it("passes within absolute tolerance", () => {
    const tol: Tolerance = { absolute: 0.1 };
    expect(withinTolerance(3.25, 3.3, tol)).toBe(true);
  });

  it("fails outside absolute tolerance", () => {
    const tol: Tolerance = { absolute: 0.1 };
    expect(withinTolerance(3.0, 3.3, tol)).toBe(false);
  });

  it("passes within relative tolerance", () => {
    const tol: Tolerance = { relative: 0.05 }; // 5%
    expect(withinTolerance(3.15, 3.3, tol)).toBe(true); // 4.5% error
  });

  it("fails outside relative tolerance", () => {
    const tol: Tolerance = { relative: 0.05 }; // 5%
    expect(withinTolerance(2.8, 3.3, tol)).toBe(false); // ~15% error
  });

  it("passes when either absolute or relative is satisfied (both specified)", () => {
    const tol: Tolerance = { absolute: 0.5, relative: 0.01 }; // 1% relative, 0.5 absolute
    // 2.8 vs 3.3: delta=0.5 — passes absolute even though relative fails
    expect(withinTolerance(2.8, 3.3, tol)).toBe(true);
  });

  it("fails when both tolerances are missed", () => {
    const tol: Tolerance = { absolute: 0.1, relative: 0.01 };
    expect(withinTolerance(2.8, 3.3, tol)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Analog vector execution tests
// ---------------------------------------------------------------------------

describe("executeTests — analog", () => {
  it("passes analog output within tolerance", async () => {
    const { facade } = makeMockFacade({ Vout: 3.28 });

    const testData: ParsedTestData = {
      inputNames: [],
      outputNames: ["Vout"],
      vectors: [
        {
          inputs: new Map(),
          outputs: new Map<string, TestValue>([
            ["Vout", { kind: "analogValue", value: 3.3, tolerance: { relative: 0.05 } }],
          ]),
        },
      ],
    };

    const results = await executeTests(facade, stubEngine, stubCircuit, testData);
    expect(results.passed).toBe(1);
    expect(results.failed).toBe(0);
  });

  it("fails analog output outside tolerance", async () => {
    const { facade } = makeMockFacade({ Vout: 2.8 });

    const testData: ParsedTestData = {
      inputNames: [],
      outputNames: ["Vout"],
      vectors: [
        {
          inputs: new Map(),
          outputs: new Map<string, TestValue>([
            ["Vout", { kind: "analogValue", value: 3.3, tolerance: { relative: 0.05 } }],
          ]),
        },
      ],
    };

    const results = await executeTests(facade, stubEngine, stubCircuit, testData);
    expect(results.passed).toBe(0);
    expect(results.failed).toBe(1);
  });

  it("uses analogPragmas tolerance when no per-value tolerance", async () => {
    const { facade } = makeMockFacade({ Vout: 3.28 });

    const testData: ParsedTestData = {
      inputNames: [],
      outputNames: ["Vout"],
      vectors: [
        {
          inputs: new Map(),
          outputs: new Map<string, TestValue>([
            ["Vout", { kind: "analogValue", value: 3.3 }], // no tolerance on value
          ]),
        },
      ],
      analogPragmas: { tolerance: { relative: 0.05 } },
    };

    const results = await executeTests(facade, stubEngine, stubCircuit, testData);
    expect(results.passed).toBe(1);
  });

  it("passes settle time from analogPragmas to facade.settle", async () => {
    const calls: number[] = [];
    const facade = {
      setSignal: vi.fn(),
      readSignal: vi.fn(() => 3.3),
      settle: vi.fn((_coord: SimulationCoordinator, settleTime?: number) => {
        calls.push(settleTime ?? -1);
        return Promise.resolve();
      }),
      step: vi.fn(),
      createCircuit: vi.fn(),
      addComponent: vi.fn(),
      connect: vi.fn(),
      compile: vi.fn(),
      run: vi.fn(),
      readAllSignals: vi.fn(),
      runTests: vi.fn(),
      loadDig: vi.fn(),
      serialize: vi.fn(),
      deserialize: vi.fn(),
    } as unknown as SimulatorFacade;

    const testData: ParsedTestData = {
      inputNames: [],
      outputNames: ["Vout"],
      vectors: [
        {
          inputs: new Map(),
          outputs: new Map<string, TestValue>([
            ["Vout", { kind: "analogValue", value: 3.3 }],
          ]),
        },
      ],
      analogPragmas: { settle: 0.01 },
    };

    await executeTests(facade, stubEngine, stubCircuit, testData);
    expect(calls[0]).toBe(0.01);
  });
});
