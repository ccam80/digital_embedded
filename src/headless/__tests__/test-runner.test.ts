/**
 * Tests for CircuitBuilder/facade runTests and extractEmbeddedTestData.
 *
 * These drive a REAL compiled coordinator via the shared `buildDigital` fixture
 * (facade.build -> facade.compile) and the REAL parser/executor — no engine mock
 * and no module mocks. An earlier version hand-rolled a bare `{ step, ... }`
 * engine stub and `vi.mock`-ed the parser/executor; when runTests was refactored
 * to resolve signals through `coordinator.compiled.labelSignalMap`, the stub
 * (which had no `compiled`) crashed and the executor mock silently stopped
 * intercepting. Running against a real coordinator removes both failure modes.
 *
 * Circuit under test: a 2-input AND with labelled inputs A, B and output Y, so a
 * Testcase row `A B Y` exercises real signal-set -> step -> read.
 */

import { describe, it, expect } from "vitest";
import { extractEmbeddedTestData } from "../test-runner.js";
import { FacadeError } from "../types.js";
import { buildDigital, type DigitalFixture } from "@/test-fixtures/build-digital";
import { TestcaseElement } from "@/components/misc/testcase";
import { PropertyBag } from "@/core/properties";

// A real 2-input AND: A,B -> Y. AND truth → Y = A & B.
function buildAndCircuit(): DigitalFixture {
  return buildDigital({
    components: [
      { id: "a", type: "In",  props: { label: "A", bitWidth: 1 } },
      { id: "b", type: "In",  props: { label: "B", bitWidth: 1 } },
      { id: "g", type: "And", props: { inputCount: 2, bitWidth: 1 } },
      { id: "y", type: "Out", props: { label: "Y", bitWidth: 1 } },
    ],
    connections: [
      ["a:out", "g:In_1"],
      ["b:out", "g:In_2"],
      ["g:out", "y:in"],
    ],
  });
}

function makeTestcaseElement(testData: string): TestcaseElement {
  const props = new PropertyBag();
  props.set("testData", testData);
  return new TestcaseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

describe("runTests (real coordinator)", () => {
  it("embeddedTests- extracts embedded Testcase data and runs it against the compiled circuit", async () => {
    const fix = buildAndCircuit();
    // AND truth: 0&0=0, 1&1=1.
    fix.circuit.elements.push(makeTestcaseElement("A B Y\n0 0 0\n1 1 1"));

    const results = await fix.facade.runTests(fix.coordinator, fix.circuit);

    expect(results.total).toBe(2);
    expect(results.passed).toBe(2);
    expect(results.failed).toBe(0);
  });

  it("externalTests- external testData overrides embedded Testcase data", async () => {
    const fix = buildAndCircuit();
    // Embedded data is correct (would pass); the external override is wrong on
    // purpose, so a failing vector proves the external string was used instead.
    fix.circuit.elements.push(makeTestcaseElement("A B Y\n0 0 0\n1 1 1"));

    const results = await fix.facade.runTests(fix.coordinator, fix.circuit, "A B Y\n1 1 0");

    // 1 AND 1 = 1, but the override expects 0 → the override drove a failing run.
    expect(results.total).toBe(1);
    expect(results.failed).toBe(1);
  });

  it("noTestData- no Testcase and no external data → throws FacadeError", async () => {
    const fix = buildAndCircuit();

    await expect(fix.facade.runTests(fix.coordinator, fix.circuit)).rejects.toThrow(FacadeError);
    await expect(fix.facade.runTests(fix.coordinator, fix.circuit)).rejects.toThrow(
      /no test data available/i,
    );
  });

  it("multipleTestcases- two Testcase components → both sets of vectors run", async () => {
    const fix = buildAndCircuit();
    // extractEmbeddedTestData concatenates Testcase blocks raw with a newline, and
    // the parser takes one header line, so a second block must be a HEADERLESS
    // continuation of the first (a repeated `A B Y` header would parse as a data
    // row — "Not a valid test value: 'A'"). Together: header + 4 rows.
    fix.circuit.elements.push(makeTestcaseElement("A B Y\n0 0 0\n0 1 0"));
    fix.circuit.elements.push(makeTestcaseElement("1 0 0\n1 1 1"));

    const results = await fix.facade.runTests(fix.coordinator, fix.circuit);

    expect(results.total).toBe(4);
    expect(results.passed).toBe(4);
  });
});

describe("extractEmbeddedTestData", () => {
  it("no Testcase elements → returns null", () => {
    const fix = buildAndCircuit();
    expect(extractEmbeddedTestData(fix.circuit)).toBeNull();
  });

  it("single Testcase element → returns its test data", () => {
    const fix = buildAndCircuit();
    const testData = "A B Y\n0 0 0\n1 1 1";
    fix.circuit.elements.push(makeTestcaseElement(testData));
    expect(extractEmbeddedTestData(fix.circuit)).toBe(testData);
  });

  it("two Testcase elements → concatenated with newline (raw)", () => {
    const fix = buildAndCircuit();
    fix.circuit.elements.push(makeTestcaseElement("A B Y\n0 0 0"));
    fix.circuit.elements.push(makeTestcaseElement("A B Y\n1 1 0"));
    expect(extractEmbeddedTestData(fix.circuit)).toBe("A B Y\n0 0 0\nA B Y\n1 1 0");
  });

  it("Testcase with empty testData ignored", () => {
    const fix = buildAndCircuit();
    fix.circuit.elements.push(makeTestcaseElement(""));
    fix.circuit.elements.push(makeTestcaseElement("A B Y\n1 0 1"));
    expect(extractEmbeddedTestData(fix.circuit)).toBe("A B Y\n1 0 1");
  });
});
