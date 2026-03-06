/**
 * Tests for TestRunner and CircuitBuilder.runTests — task 6.3.4.
 *
 * Tests cover:
 *   - Embedded test data extraction from Testcase components
 *   - External test data override
 *   - Error when no test data is available
 *   - Multiple Testcase components concatenated
 *   - runTests() wired through CircuitBuilder
 *
 * The parser and executor are mocked so these tests focus on the wiring
 * logic in test-runner.ts and builder.ts without requiring a live engine.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractEmbeddedTestData } from "../test-runner.js";
import { CircuitBuilder } from "../builder.js";
import { FacadeError } from "../types.js";
import { ComponentRegistry } from "@/core/registry";
import { PropertyBag, PropertyType } from "@/core/properties";
import { AbstractCircuitElement } from "@/core/element";
import type { Pin, Rotation } from "@/core/pin";
import { PinDirection } from "@/core/pin";
import type { RenderContext, Rect } from "@/core/renderer-interface";
import type { ComponentLayout } from "@/core/registry";
import { Circuit } from "@/core/circuit";
import { TestcaseElement } from "@/components/misc/testcase";
import type { TestResults } from "../types.js";

// ---------------------------------------------------------------------------
// MockElement — minimal CircuitElement for test helpers
// ---------------------------------------------------------------------------

class MockElement extends AbstractCircuitElement {
  private readonly _pins: Pin[];

  constructor(
    typeId: string,
    instanceId: string,
    position: { x: number; y: number },
    pins: Pin[],
    props: PropertyBag,
  ) {
    super(typeId, instanceId, position, 0 as Rotation, false, props);
    this._pins = pins;
  }

  getPins(): readonly Pin[] { return this._pins; }
  draw(_ctx: RenderContext): void {}
  getBoundingBox(): Rect { return { x: this.position.x, y: this.position.y, width: 4, height: 4 }; }
  getHelpText(): string { return ""; }
}

function makePin(label: string, direction: PinDirection, worldX: number, worldY: number): Pin {
  return { label, direction, position: { x: worldX, y: worldY }, bitWidth: 1, isNegated: false, isClock: false };
}

function makePropBag(entries: Record<string, string | number | boolean> = {}): PropertyBag {
  const bag = new PropertyBag();
  for (const [k, v] of Object.entries(entries)) bag.set(k, v);
  return bag;
}

// ---------------------------------------------------------------------------
// Execute functions for mock registry
// ---------------------------------------------------------------------------

function executePassThrough(_i: number, _s: Uint32Array, _l: ComponentLayout): void {}
function executeNoop(_i: number, _s: Uint32Array, _l: ComponentLayout): void {}

function executeXor2(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const a = state[layout.inputOffset(index)] ?? 0;
  const b = state[layout.inputOffset(index) + 1] ?? 0;
  state[layout.outputOffset(index)] = (a ^ b) >>> 0;
}

function executeAnd2(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const a = state[layout.inputOffset(index)] ?? 0;
  const b = state[layout.inputOffset(index) + 1] ?? 0;
  state[layout.outputOffset(index)] = (a & b) >>> 0;
}

// ---------------------------------------------------------------------------
// buildRegistry — mock component registry
// ---------------------------------------------------------------------------

function buildRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry();

  registry.register({
    name: "In", typeId: -1,
    factory: (props) => new MockElement("In", crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin("out", PinDirection.OUTPUT, 2, 0),
    ], props),
    executeFn: executePassThrough,
    pinLayout: [],
    propertyDefs: [{ key: "label", label: "Label", type: PropertyType.STRING, defaultValue: "", description: "Label" }],
    attributeMap: [], category: "IO" as any, helpText: "In",
  });

  registry.register({
    name: "Out", typeId: -1,
    factory: (props) => new MockElement("Out", crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin("in", PinDirection.INPUT, 0, 0),
    ], props),
    executeFn: executeNoop,
    pinLayout: [],
    propertyDefs: [{ key: "label", label: "Label", type: PropertyType.STRING, defaultValue: "", description: "Label" }],
    attributeMap: [], category: "IO" as any, helpText: "Out",
  });

  registry.register({
    name: "XOR", typeId: -1,
    factory: (props) => new MockElement("XOR", crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin("in0", PinDirection.INPUT, -2, -1),
      makePin("in1", PinDirection.INPUT, -2, 1),
      makePin("out", PinDirection.OUTPUT, 2, 0),
    ], props),
    executeFn: executeXor2, pinLayout: [], propertyDefs: [], attributeMap: [], category: "LOGIC" as any, helpText: "XOR",
  });

  registry.register({
    name: "AND", typeId: -1,
    factory: (props) => new MockElement("AND", crypto.randomUUID(), { x: 0, y: 0 }, [
      makePin("in0", PinDirection.INPUT, -2, -1),
      makePin("in1", PinDirection.INPUT, -2, 1),
      makePin("out", PinDirection.OUTPUT, 2, 0),
    ], props),
    executeFn: executeAnd2, pinLayout: [], propertyDefs: [], attributeMap: [], category: "LOGIC" as any, helpText: "AND",
  });

  return registry;
}

// ---------------------------------------------------------------------------
// buildHalfAdder — circuit with labeled In/Out components
// ---------------------------------------------------------------------------

function buildHalfAdder(): Circuit {
  const circuit = new Circuit();

  const inA = new MockElement("In", "inA", { x: 0, y: 0 }, [
    makePin("out", PinDirection.OUTPUT, 2, 0),
  ], makePropBag({ label: "A" }));

  const inB = new MockElement("In", "inB", { x: 0, y: 2 }, [
    makePin("out", PinDirection.OUTPUT, 2, 2),
  ], makePropBag({ label: "B" }));

  const xor = new MockElement("XOR", "xor", { x: 4, y: 0 }, [
    makePin("in0", PinDirection.INPUT, 4, 0),
    makePin("in1", PinDirection.INPUT, 4, 2),
    makePin("out", PinDirection.OUTPUT, 8, 1),
  ], makePropBag());

  const and = new MockElement("AND", "and", { x: 4, y: 4 }, [
    makePin("in0", PinDirection.INPUT, 4, 0),
    makePin("in1", PinDirection.INPUT, 4, 2),
    makePin("out", PinDirection.OUTPUT, 8, 5),
  ], makePropBag());

  const outS = new MockElement("Out", "outS", { x: 9, y: 1 }, [
    makePin("in", PinDirection.INPUT, 9, 1),
  ], makePropBag({ label: "S" }));

  const outC = new MockElement("Out", "outC", { x: 9, y: 5 }, [
    makePin("in", PinDirection.INPUT, 9, 5),
  ], makePropBag({ label: "C" }));

  circuit.elements.push(inA, inB, xor, and, outS, outC);
  circuit.wires.push({ start: { x: 2, y: 0 }, end: { x: 4, y: 0 } } as any);
  circuit.wires.push({ start: { x: 2, y: 2 }, end: { x: 4, y: 2 } } as any);
  circuit.wires.push({ start: { x: 8, y: 1 }, end: { x: 9, y: 1 } } as any);
  circuit.wires.push({ start: { x: 8, y: 5 }, end: { x: 9, y: 5 } } as any);

  return circuit;
}

// ---------------------------------------------------------------------------
// makeTestcaseElement — create a TestcaseElement with given test data string
// ---------------------------------------------------------------------------

function makeTestcaseElement(testData: string): TestcaseElement {
  const props = makePropBag({ testData });
  return new TestcaseElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

// ---------------------------------------------------------------------------
// Mock parser and executor modules
// ---------------------------------------------------------------------------

vi.mock("../../testing/parser.js", () => ({
  parseTestData: vi.fn(),
}));

vi.mock("../../testing/executor.js", () => ({
  executeTests: vi.fn(),
  RunnerFacade: undefined,
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TestRunner", () => {
  let parseTestDataMock: ReturnType<typeof vi.fn>;
  let executeTestsMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetAllMocks();

    const parserModule = await import("../../testing/parser.js");
    const executorModule = await import("../../testing/executor.js");

    parseTestDataMock = parserModule.parseTestData as ReturnType<typeof vi.fn>;
    executeTestsMock = executorModule.executeTests as ReturnType<typeof vi.fn>;

    // Default: parser returns minimal parsed data, executor returns passing results
    parseTestDataMock.mockReturnValue({
      inputNames: ["A", "B"],
      outputNames: ["Y"],
      vectors: [
        { inputs: new Map([["A", { kind: "value", value: 0n }], ["B", { kind: "value", value: 0n }]]), outputs: new Map([["Y", { kind: "value", value: 0n }]]) },
      ],
    });

    const defaultResults: TestResults = { passed: 1, failed: 0, total: 1, vectors: [{ passed: true, inputs: { A: 0, B: 0 }, expectedOutputs: { Y: 0 }, actualOutputs: { Y: 0 } }] };
    executeTestsMock.mockReturnValue(defaultResults);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // embeddedTests
  // -------------------------------------------------------------------------

  it("embeddedTests — circuit with Testcase component → runTests extracts embedded data and returns results", () => {
    const registry = buildRegistry();
    const builder = new CircuitBuilder(registry);

    const circuit = buildHalfAdder();
    const testData = "A B Y\n0 0 0\n1 1 0";
    circuit.elements.push(makeTestcaseElement(testData));

    const engine = { step: vi.fn(), setSignalValue: vi.fn(), getSignalRaw: vi.fn() } as any;

    const expectedResults: TestResults = { passed: 2, failed: 0, total: 2, vectors: [] };
    executeTestsMock.mockReturnValue(expectedResults);

    const results = builder.runTests(engine, circuit);

    expect(parseTestDataMock).toHaveBeenCalledWith(testData);
    expect(executeTestsMock).toHaveBeenCalled();
    expect(results).toBe(expectedResults);
  });

  // -------------------------------------------------------------------------
  // externalTests
  // -------------------------------------------------------------------------

  it("externalTests — external testData string overrides embedded Testcase data", () => {
    const registry = buildRegistry();
    const builder = new CircuitBuilder(registry);

    const circuit = buildHalfAdder();
    // Add a Testcase with different data that should NOT be used
    circuit.elements.push(makeTestcaseElement("A B Y\n0 0 0\n1 1 1"));

    const externalData = "A B Y\n0 0 0\n1 1 1";
    const engine = { step: vi.fn(), setSignalValue: vi.fn(), getSignalRaw: vi.fn() } as any;

    builder.runTests(engine, circuit, externalData);

    // External data takes precedence — parser called with external string
    expect(parseTestDataMock).toHaveBeenCalledWith(externalData);
  });

  // -------------------------------------------------------------------------
  // noTestData
  // -------------------------------------------------------------------------

  it("noTestData — circuit without Testcase and no external data → throws FacadeError", () => {
    const registry = buildRegistry();
    const builder = new CircuitBuilder(registry);

    const circuit = buildHalfAdder();
    const engine = { step: vi.fn(), setSignalValue: vi.fn(), getSignalRaw: vi.fn() } as any;

    expect(() => builder.runTests(engine, circuit)).toThrow(FacadeError);
    expect(() => builder.runTests(engine, circuit)).toThrow(
      /no test data available/i,
    );
  });

  // -------------------------------------------------------------------------
  // multipleTestcases
  // -------------------------------------------------------------------------

  it("multipleTestcases — circuit with 2 Testcase components → both sets of vectors combined", () => {
    const registry = buildRegistry();
    const builder = new CircuitBuilder(registry);

    const circuit = buildHalfAdder();
    circuit.elements.push(makeTestcaseElement("A B Y\n0 0 0\n0 1 1"));
    circuit.elements.push(makeTestcaseElement("A B Y\n1 0 1\n1 1 0"));

    const engine = { step: vi.fn(), setSignalValue: vi.fn(), getSignalRaw: vi.fn() } as any;

    builder.runTests(engine, circuit);

    // Both test data blocks joined and passed to parser
    const calledWith = parseTestDataMock.mock.calls[0][0] as string;
    expect(calledWith).toContain("0 0 0");
    expect(calledWith).toContain("1 1 0");
  });

  // -------------------------------------------------------------------------
  // extractEmbeddedTestData — unit tests for the helper
  // -------------------------------------------------------------------------

  it("extractEmbeddedTestData — circuit with no Testcase elements → returns null", () => {
    const circuit = buildHalfAdder();
    const result = extractEmbeddedTestData(circuit);
    expect(result).toBeNull();
  });

  it("extractEmbeddedTestData — single Testcase element → returns its test data", () => {
    const circuit = buildHalfAdder();
    const testData = "A B Y\n0 0 0\n1 1 1";
    circuit.elements.push(makeTestcaseElement(testData));

    const result = extractEmbeddedTestData(circuit);
    expect(result).toBe(testData);
  });

  it("extractEmbeddedTestData — two Testcase elements → concatenated with newline", () => {
    const circuit = buildHalfAdder();
    circuit.elements.push(makeTestcaseElement("A B Y\n0 0 0"));
    circuit.elements.push(makeTestcaseElement("A B Y\n1 1 0"));

    const result = extractEmbeddedTestData(circuit);
    expect(result).toBe("A B Y\n0 0 0\nA B Y\n1 1 0");
  });

  it("extractEmbeddedTestData — Testcase with empty testData ignored", () => {
    const circuit = buildHalfAdder();
    circuit.elements.push(makeTestcaseElement(""));
    circuit.elements.push(makeTestcaseElement("A B Y\n1 0 1"));

    const result = extractEmbeddedTestData(circuit);
    expect(result).toBe("A B Y\n1 0 1");
  });
});
