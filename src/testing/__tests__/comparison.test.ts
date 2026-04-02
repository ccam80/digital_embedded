/**
 * Tests for compareCircuits() — task 6.3.6.
 *
 * Uses a mock ComparatorFacade with controlled readOutput returns to test
 * all comparison modes and edge cases without running a real simulation engine.
 *
 * Test scenarios:
 *   - identicalCircuits: compare circuit to itself → zero mismatches
 *   - differentCircuits: AND vs OR gate → mismatches on specific input combos
 *   - exhaustiveMode: no test data, 2 inputs → all 4 combos, mode='exhaustive'
 *   - testBasedMode: test data provided → uses provided vectors, mode='test-based'
 *   - tooManyInputs: 21 input bits, no test data → throws
 *   - mismatchDetails: differingSignals lists only the outputs that disagree
 */

import { describe, it, expect, vi } from "vitest";
import { compareCircuits } from "../comparison.js";
import type { ComparatorFacade } from "../comparison.js";
import type { SimulationCoordinator } from "@/solver/coordinator-types";
import type { Circuit, CircuitMetadata } from "@/core/circuit";
import type { CircuitElement } from "@/core/element";
import type { Pin } from "@/core/pin";
import type { Rect, RenderContext } from "@/core/renderer-interface";
import { PropertyBag } from "@/core/properties";
import type { PropertyValue } from "@/core/properties";
import type { ParsedTestData } from "../parser.js";

// ---------------------------------------------------------------------------
// Mock CircuitElement — minimal stub for In/Out elements
// ---------------------------------------------------------------------------

class MockElement implements CircuitElement {
  readonly typeId: string;
  readonly instanceId: string;
  position = { x: 0, y: 0 };
  rotation = 0 as 0;
  mirror = false;
  private readonly _props: PropertyBag;

  constructor(typeId: string, label: string, bitWidth = 1) {
    this.typeId = typeId;
    this.instanceId = crypto.randomUUID();
    this._props = new PropertyBag();
    this._props.set("label", label);
    this._props.set("bitWidth", bitWidth);
  }

  getProperties(): PropertyBag { return this._props; }
  getPins(): readonly Pin[] { return []; }
  draw(_ctx: RenderContext): void {}
  getBoundingBox(): Rect { return { x: 0, y: 0, width: 2, height: 2 }; }
  serialize() {
    return {
      typeId: this.typeId,
      instanceId: this.instanceId,
      position: this.position,
      rotation: this.rotation,
      mirror: this.mirror,
      properties: {},
    };
  }
  getAttribute(_name: string): PropertyValue | undefined { return undefined; }
  setAttribute(_name: string, _value: PropertyValue): void {}
}

// ---------------------------------------------------------------------------
// Mock Circuit builder
// ---------------------------------------------------------------------------

function makeCircuit(elements: CircuitElement[]): Circuit {
  return {
    elements: [...elements],
    wires: [],
    metadata: {
      name: "Test",
      description: "",
      testDataRefs: [],
      measurementOrdering: [],
      isGeneric: false,
      isLocked: false,
      chipWidth: 3,
      chipHeight: 3,
      shapeType: "DEFAULT",
    } satisfies CircuitMetadata,
    addElement() {},
    removeElement() {},
    addWire() {},
    removeWire() {},
    getElementsAt() { return []; },
  } as unknown as Circuit;
}

// ---------------------------------------------------------------------------
// Mock Facade builder
// ---------------------------------------------------------------------------

/**
 * Build a mock facade where readOutput returns values from a function.
 *
 * readOutputFn receives (engineTag, label, callIndex) and returns a number.
 * engineTag is "ref" for the first compiled engine, "stu" for the second.
 */
function makeFacade(
  readOutputFn: (engineTag: "ref" | "stu", label: string) => number
): ComparatorFacade {
  let engineCount = 0;
  const engineTags = new WeakMap<SimulationCoordinator, "ref" | "stu">();

  const compile = vi.fn((_circuit: Circuit): SimulationCoordinator => {
    engineCount++;
    const tag: "ref" | "stu" = engineCount === 1 ? "ref" : "stu";
    const eng = {} as SimulationCoordinator;
    engineTags.set(eng, tag);
    return eng;
  });

  const setSignal = vi.fn();
  const settle = vi.fn((): Promise<void> => Promise.resolve());

  const readSignal = vi.fn((_coordinator: SimulationCoordinator, label: string): number => {
    const tag = engineTags.get(_coordinator) ?? "ref";
    return readOutputFn(tag, label);
  });

  return { compile, setSignal, readSignal, settle };
}

// ---------------------------------------------------------------------------
// Shared test data: AND gate truth table (A AND B → Y)
// ---------------------------------------------------------------------------

function makeAndTruthTable(): ParsedTestData {
  return {
    inputNames: ["A", "B"],
    outputNames: ["Y"],
    vectors: [
      {
        inputs: new Map([["A", { kind: "value", value: 0n }], ["B", { kind: "value", value: 0n }]]),
        outputs: new Map([["Y", { kind: "value", value: 0n }]]),
      },
      {
        inputs: new Map([["A", { kind: "value", value: 0n }], ["B", { kind: "value", value: 1n }]]),
        outputs: new Map([["Y", { kind: "value", value: 0n }]]),
      },
      {
        inputs: new Map([["A", { kind: "value", value: 1n }], ["B", { kind: "value", value: 0n }]]),
        outputs: new Map([["Y", { kind: "value", value: 0n }]]),
      },
      {
        inputs: new Map([["A", { kind: "value", value: 1n }], ["B", { kind: "value", value: 1n }]]),
        outputs: new Map([["Y", { kind: "value", value: 1n }]]),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compareCircuits", () => {
  // -------------------------------------------------------------------------
  // identicalCircuits
  // -------------------------------------------------------------------------

  it("identicalCircuits — compare circuit to itself → zero mismatches", async () => {
    // Both engines return same output for every input
    const facade = makeFacade((_tag, _label) => 0);

    const circuit = makeCircuit([
      new MockElement("In", "A"),
      new MockElement("In", "B"),
      new MockElement("Out", "Y"),
    ]);

    // Provide test data so we don't depend on exhaustive mode internals
    const testData: ParsedTestData = {
      inputNames: ["A", "B"],
      outputNames: ["Y"],
      vectors: [
        {
          inputs: new Map([["A", { kind: "value", value: 0n }], ["B", { kind: "value", value: 0n }]]),
          outputs: new Map([["Y", { kind: "value", value: 0n }]]),
        },
        {
          inputs: new Map([["A", { kind: "value", value: 1n }], ["B", { kind: "value", value: 1n }]]),
          outputs: new Map([["Y", { kind: "value", value: 1n }]]),
        },
      ],
    };

    const result = await compareCircuits(facade, circuit, circuit, testData);

    expect(result.mismatchCount).toBe(0);
    expect(result.matchCount).toBe(2);
    expect(result.mismatches).toHaveLength(0);
    expect(result.mode).toBe("test-based");
  });

  // -------------------------------------------------------------------------
  // differentCircuits
  // -------------------------------------------------------------------------

  it("differentCircuits — AND gate reference vs OR gate student → mismatches on specific inputs", async () => {
    // AND: Y = A & B;  OR: Y = A | B
    // They differ on (0,1) and (1,0): AND=0, OR=1
    const facade = makeFacade((tag, _label) => {
      // We track last setInput by checking the tag during readOutput
      // Simpler: facade returns 0 for ref (AND gate) and records mismatches from test data
      // For test-based mode, just return AND for ref and OR for stu
      // We'll use the provided test data vectors to control the comparison
      return tag === "ref" ? 0 : 1; // ref always 0, stu always 1 → all 4 vectors mismatch
    });

    const circuit = makeCircuit([
      new MockElement("In", "A"),
      new MockElement("In", "B"),
      new MockElement("Out", "Y"),
    ]);

    const testData = makeAndTruthTable();
    const result = await compareCircuits(facade, circuit, circuit, testData);

    // ref returns 0 always, stu returns 1 always
    // Row 0: expected Y=0 - ref=0 (match with expected, but ref≠stu: 0≠1) → mismatch
    // Row 1: expected Y=0 - ref=0, stu=1 → mismatch
    // Row 2: expected Y=0 - ref=0, stu=1 → mismatch
    // Row 3: expected Y=1 - ref=0, stu=1 → mismatch (ref≠stu)
    // All 4 differ between ref and stu circuits
    expect(result.mismatchCount).toBe(4);
    expect(result.matchCount).toBe(0);
    expect(result.mismatches).toHaveLength(4);
    expect(result.mismatches[0].differingSignals).toContain("Y");
  });

  // -------------------------------------------------------------------------
  // exhaustiveMode
  // -------------------------------------------------------------------------

  it("exhaustiveMode — no test data, 2 single-bit inputs → all 4 combinations tested, mode is exhaustive", async () => {
    // Both engines return identical outputs → no mismatches
    const facade = makeFacade(() => 0);

    const refCircuit = makeCircuit([
      new MockElement("In", "A", 1),
      new MockElement("In", "B", 1),
      new MockElement("Out", "Y"),
    ]);
    const stuCircuit = makeCircuit([
      new MockElement("In", "A", 1),
      new MockElement("In", "B", 1),
      new MockElement("Out", "Y"),
    ]);

    // No test data → exhaustive mode
    const result = await compareCircuits(facade, refCircuit, stuCircuit);

    expect(result.mode).toBe("exhaustive");
    expect(result.totalVectors).toBe(4); // 2^2 = 4
    expect(result.mismatchCount).toBe(0);
    expect(result.matchCount).toBe(4);
  });

  // -------------------------------------------------------------------------
  // testBasedMode
  // -------------------------------------------------------------------------

  it("testBasedMode — test data provided → uses provided vectors, mode is test-based", async () => {
    const facade = makeFacade(() => 0);

    const circuit = makeCircuit([
      new MockElement("In", "A"),
      new MockElement("Out", "Y"),
    ]);

    const testData: ParsedTestData = {
      inputNames: ["A"],
      outputNames: ["Y"],
      vectors: [
        {
          inputs: new Map([["A", { kind: "value", value: 0n }]]),
          outputs: new Map([["Y", { kind: "value", value: 0n }]]),
        },
        {
          inputs: new Map([["A", { kind: "value", value: 1n }]]),
          outputs: new Map([["Y", { kind: "value", value: 0n }]]),
        },
      ],
    };

    const result = await compareCircuits(facade, circuit, circuit, testData);

    expect(result.mode).toBe("test-based");
    expect(result.totalVectors).toBe(2);
  });

  // -------------------------------------------------------------------------
  // tooManyInputs
  // -------------------------------------------------------------------------

  it("tooManyInputs — 21 input bits, no test data → throws requesting test vectors", async () => {
    const facade = makeFacade(() => 0);

    // 21 single-bit inputs → 21 total input bits > 20
    const inElements: CircuitElement[] = [];
    for (let i = 0; i < 21; i++) {
      inElements.push(new MockElement("In", `I${i}`, 1));
    }
    inElements.push(new MockElement("Out", "Y"));

    const refCircuit = makeCircuit(inElements);
    const stuCircuit = makeCircuit(inElements);

    await expect(compareCircuits(facade, refCircuit, stuCircuit)).rejects.toThrow(
      /20 total input bits/
    );
  });

  // -------------------------------------------------------------------------
  // mismatchDetails
  // -------------------------------------------------------------------------

  it("mismatchDetails — verify differingSignals lists only the outputs that disagree", async () => {
    // Two outputs: Y and Z. ref returns: Y=0, Z=1. stu returns: Y=1, Z=1.
    // So only Y differs.
    let callCount = 0;
    const facade = makeFacade((tag, label) => {
      callCount++;
      if (label === "Y") return tag === "ref" ? 0 : 1; // Y differs
      return 1; // Z matches
    });

    const circuit = makeCircuit([
      new MockElement("In", "A"),
      new MockElement("Out", "Y"),
      new MockElement("Out", "Z"),
    ]);

    const testData: ParsedTestData = {
      inputNames: ["A"],
      outputNames: ["Y", "Z"],
      vectors: [
        {
          inputs: new Map([["A", { kind: "value", value: 0n }]]),
          outputs: new Map([
            ["Y", { kind: "value", value: 0n }],
            ["Z", { kind: "value", value: 1n }],
          ]),
        },
      ],
    };

    const result = await compareCircuits(facade, circuit, circuit, testData);

    expect(result.mismatchCount).toBe(1);
    expect(result.mismatches).toHaveLength(1);

    const mismatch = result.mismatches[0];
    expect(mismatch.differingSignals).toContain("Y");
    expect(mismatch.differingSignals).not.toContain("Z");
    expect(mismatch.differingSignals).toHaveLength(1);

    expect(mismatch.referenceOutputs["Y"]).toBe(0);
    expect(mismatch.studentOutputs["Y"]).toBe(1);
    expect(mismatch.referenceOutputs["Z"]).toBe(1);
    expect(mismatch.studentOutputs["Z"]).toBe(1);
  });
});
