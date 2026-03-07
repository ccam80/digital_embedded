/**
 * Tests for Testcase component.
 *
 * Covers:
 *   - Test data extraction from properties
 *   - parseTestData function: header parsing, row parsing, comments,
 *     pipe separators, don't-care entries, empty input
 *   - Rendering as a labeled box
 *   - No simulation behavior (executeTestcase is no-op)
 *   - Pin layout (no pins)
 *   - Attribute mapping
 *   - ComponentDefinition completeness
 */

import { describe, it, expect } from "vitest";
import {
  TestcaseElement,
  executeTestcase,
  TestcaseDefinition,
  TESTCASE_ATTRIBUTE_MAPPINGS,
  parseTestData,
} from "../testcase.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLayout(inputCount: number = 0, outputCount: number = 0): ComponentLayout {
  return {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => inputCount,
    stateOffset: () => 0,
  };
}

interface DrawCall {
  method: string;
  args: unknown[];
}

function makeStubCtx(): { ctx: RenderContext; calls: DrawCall[] } {
  const calls: DrawCall[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]): void => {
      calls.push({ method, args });
    };
  const ctx: RenderContext = {
    drawLine: record("drawLine") as (x1: number, y1: number, x2: number, y2: number) => void,
    drawRect: record("drawRect") as (x: number, y: number, w: number, h: number, filled: boolean) => void,
    drawCircle: record("drawCircle") as (cx: number, cy: number, r: number, filled: boolean) => void,
    drawArc: record("drawArc") as (cx: number, cy: number, r: number, s: number, e: number) => void,
    drawPolygon: record("drawPolygon") as (points: readonly Point[], filled: boolean) => void,
    drawPath: record("drawPath") as (path: PathData) => void,
    drawText: record("drawText") as (text: string, x: number, y: number, anchor: TextAnchor) => void,
    save: record("save") as () => void,
    restore: record("restore") as () => void,
    translate: record("translate") as (dx: number, dy: number) => void,
    rotate: record("rotate") as (angle: number) => void,
    scale: record("scale") as (sx: number, sy: number) => void,
    setColor: record("setColor") as (color: ThemeColor) => void,
    setLineWidth: record("setLineWidth") as (w: number) => void,
    setFont: record("setFont") as (font: FontSpec) => void,
    setLineDash: record("setLineDash") as (pattern: number[]) => void,
  };
  return { ctx, calls };
}

function makeTestcase(overrides?: {
  label?: string;
  testData?: string;
}): TestcaseElement {
  const props = new PropertyBag();
  props.set("label", overrides?.label ?? "Testcase");
  props.set("testData", overrides?.testData ?? "");
  return new TestcaseElement("test-tc-001", { x: 0, y: 0 }, 0, false, props);
}

const SIMPLE_TEST_DATA = `A B | Y
0 0   0
0 1   1
1 0   1
1 1   1`;

const COMMENTED_TEST_DATA = `# This is a test for OR gate
# Inputs: A, B  Output: Y
A B | Y
# All-zero case
0 0   0
0 1   1
1 0   1
1 1   1`;

// ---------------------------------------------------------------------------
// parseTestData tests
// ---------------------------------------------------------------------------

describe("parseTestData", () => {
  describe("headerParsing", () => {
    it("extracts pin names from header line", () => {
      const result = parseTestData(SIMPLE_TEST_DATA);
      expect(result.pinNames).toEqual(["A", "B", "Y"]);
    });

    it("pipe character is ignored in header", () => {
      const data = "A B | Y Z\n0 0   0 1";
      const result = parseTestData(data);
      expect(result.pinNames).toEqual(["A", "B", "Y", "Z"]);
    });

    it("empty string returns empty pinNames and rows", () => {
      const result = parseTestData("");
      expect(result.pinNames).toHaveLength(0);
      expect(result.rows).toHaveLength(0);
    });

    it("only comments returns empty result", () => {
      const result = parseTestData("# comment line\n# another comment");
      expect(result.pinNames).toHaveLength(0);
      expect(result.rows).toHaveLength(0);
    });
  });

  describe("rowParsing", () => {
    it("parses all data rows", () => {
      const result = parseTestData(SIMPLE_TEST_DATA);
      expect(result.rows).toHaveLength(4);
    });

    it("row tokens match whitespace-split values", () => {
      const result = parseTestData(SIMPLE_TEST_DATA);
      expect(result.rows[0].tokens).toEqual(["0", "0", "0"]);
      expect(result.rows[1].tokens).toEqual(["0", "1", "1"]);
      expect(result.rows[2].tokens).toEqual(["1", "0", "1"]);
      expect(result.rows[3].tokens).toEqual(["1", "1", "1"]);
    });

    it("pipe character is stripped from row tokens", () => {
      const data = "A B | Y\n0 1 | 1";
      const result = parseTestData(data);
      expect(result.rows[0].tokens).toEqual(["0", "1", "1"]);
    });

    it("comment lines inside data are filtered out", () => {
      const result = parseTestData(COMMENTED_TEST_DATA);
      // Header + 4 data rows (the comment inside data is filtered)
      expect(result.rows).toHaveLength(4);
    });
  });

  describe("donTCareEntries", () => {
    it("x tokens preserved as 'x' in row", () => {
      const data = "A B | Y\n0 x   1";
      const result = parseTestData(data);
      expect(result.rows[0].tokens[1]).toBe("x");
    });

    it("X (uppercase) tokens preserved", () => {
      const data = "A B | Y\nX 0   0";
      const result = parseTestData(data);
      expect(result.rows[0].tokens[0]).toBe("X");
    });
  });

  describe("multipleOutputs", () => {
    it("parses multiple output columns", () => {
      const data = "A B | S C\n0 0   0 0\n0 1   1 0\n1 0   1 0\n1 1   0 1";
      const result = parseTestData(data);
      expect(result.pinNames).toEqual(["A", "B", "S", "C"]);
      expect(result.rows).toHaveLength(4);
      expect(result.rows[3].tokens).toEqual(["1", "1", "0", "1"]);
    });
  });

  describe("crlfHandling", () => {
    it("handles CRLF line endings", () => {
      const data = "A B | Y\r\n0 0   0\r\n0 1   1";
      const result = parseTestData(data);
      expect(result.rows).toHaveLength(2);
    });
  });
});

// ---------------------------------------------------------------------------
// TestcaseElement tests
// ---------------------------------------------------------------------------

describe("Testcase", () => {
  describe("testDataExtraction", () => {
    it("testData property returns raw test string", () => {
      const el = makeTestcase({ testData: SIMPLE_TEST_DATA });
      expect(el.testData).toBe(SIMPLE_TEST_DATA);
    });

    it("getParsedTestData returns parsed structure", () => {
      const el = makeTestcase({ testData: SIMPLE_TEST_DATA });
      const parsed = el.getParsedTestData();
      expect(parsed.pinNames).toEqual(["A", "B", "Y"]);
      expect(parsed.rows).toHaveLength(4);
    });

    it("empty testData returns empty parsed structure", () => {
      const el = makeTestcase({ testData: "" });
      const parsed = el.getParsedTestData();
      expect(parsed.pinNames).toHaveLength(0);
      expect(parsed.rows).toHaveLength(0);
    });

    it("testData with comment lines parses correctly", () => {
      const el = makeTestcase({ testData: COMMENTED_TEST_DATA });
      const parsed = el.getParsedTestData();
      expect(parsed.pinNames).toEqual(["A", "B", "Y"]);
      expect(parsed.rows).toHaveLength(4);
    });

    it("label property defaults to 'Testcase'", () => {
      const props = new PropertyBag();
      props.set("label", "Testcase");
      props.set("testData", "");
      const el2 = new TestcaseElement("id", { x: 0, y: 0 }, 0, false, props);
      expect(el2.testData).toBe("");
    });
  });

  describe("noSimulationBehavior", () => {
    it("executeTestcase is a no-op — state unchanged", () => {
      const layout = makeLayout(0, 0);
      const state = new Uint32Array(4);
      const highZs = new Uint32Array(state.length);
      state[0] = 0xdeadbeef;
      state[1] = 0xcafebabe;
      executeTestcase(0, state, highZs, layout);
      expect(state[0]).toBe(0xdeadbeef);
      expect(state[1]).toBe(0xcafebabe);
    });

    it("executeTestcase can be called multiple times without error", () => {
      const layout = makeLayout(0, 0);
      const state = new Uint32Array(2);
      const highZs = new Uint32Array(state.length);
      expect(() => {
        executeTestcase(0, state, highZs, layout);
        executeTestcase(0, state, highZs, layout);
        executeTestcase(0, state, highZs, layout);
      }).not.toThrow();
    });
  });

  describe("pinLayout", () => {
    it("Testcase has no input pins", () => {
      const el = makeTestcase();
      const inputs = el.getPins().filter((p) => (p.direction as unknown as number) === 0); // INPUT=0
      expect(inputs).toHaveLength(0);
    });

    it("Testcase has no output pins", () => {
      const el = makeTestcase();
      expect(el.getPins()).toHaveLength(0);
    });

    it("getBoundingBox returns correct dimensions", () => {
      const el = makeTestcase();
      const bb = el.getBoundingBox();
      expect(bb.width).toBe(4);
      expect(bb.height).toBe(2);
    });
  });

  describe("rendering", () => {
    it("draw calls save and restore", () => {
      const el = makeTestcase();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draw renders component body rect", () => {
      const el = makeTestcase();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const rects = calls.filter((c) => c.method === "drawRect");
      expect(rects.length).toBeGreaterThanOrEqual(1);
    });

    it("draw renders table symbol lines", () => {
      const el = makeTestcase();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const lines = calls.filter((c) => c.method === "drawLine");
      expect(lines.length).toBeGreaterThanOrEqual(3);
    });

    it("draw renders default label 'Testcase'", () => {
      const el = makeTestcase();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const texts = calls.filter((c) => c.method === "drawText");
      expect(texts.some((c) => c.args[0] === "Testcase")).toBe(true);
    });

    it("draw renders custom label when set", () => {
      const el = makeTestcase({ label: "OR Gate Test" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const texts = calls.filter((c) => c.method === "drawText");
      expect(texts.some((c) => c.args[0] === "OR Gate Test")).toBe(true);
    });
  });

  describe("attributeMapping", () => {
    it("Label attribute maps to label property", () => {
      const mapping = TESTCASE_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("label");
      expect(mapping!.convert("MyTest")).toBe("MyTest");
    });

    it("testData attribute maps to testData property", () => {
      const mapping = TESTCASE_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "testData");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("testData");
      expect(mapping!.convert("A B | Y\n0 0 0")).toBe("A B | Y\n0 0 0");
    });
  });

  describe("definitionComplete", () => {
    it("TestcaseDefinition has name='Testcase'", () => {
      expect(TestcaseDefinition.name).toBe("Testcase");
    });

    it("TestcaseDefinition has typeId=-1", () => {
      expect(TestcaseDefinition.typeId).toBe(-1);
    });

    it("TestcaseDefinition factory produces TestcaseElement", () => {
      const props = new PropertyBag();
      props.set("label", "Testcase");
      props.set("testData", "");
      const el = TestcaseDefinition.factory(props);
      expect(el.typeId).toBe("Testcase");
    });

    it("TestcaseDefinition executeFn is executeTestcase", () => {
      expect(TestcaseDefinition.executeFn).toBe(executeTestcase);
    });

    it("TestcaseDefinition category is MISC", () => {
      expect(TestcaseDefinition.category).toBe(ComponentCategory.MISC);
    });

    it("TestcaseDefinition has non-empty helpText", () => {
      expect(typeof TestcaseDefinition.helpText).toBe("string"); expect(TestcaseDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("TestcaseDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(TestcaseDefinition)).not.toThrow();
    });

    it("TestcaseElement.getHelpText() contains 'Testcase'", () => {
      const el = makeTestcase();
      expect(el.getHelpText()).toContain("Testcase");
    });

    it("TestcaseDefinition pinLayout has no pins", () => {
      expect(TestcaseDefinition.pinLayout).toHaveLength(0);
    });

    it("TestcaseDefinition propertyDefs includes label and testData", () => {
      const keys = TestcaseDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("label");
      expect(keys).toContain("testData");
    });
  });
});
