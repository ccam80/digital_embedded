/**
 * Tests for LedMatrix component (task 5.2.25).
 *
 * Covers:
 *   - Matrix addressing: pixel set/clear via setColumnData
 *   - executeLedMatrix: reads r-data and c-addr inputs, encodes into output
 *   - getMatrixData: returns snapshot of pixel buffer
 *   - clearData: resets all pixel data
 *   - Rendering: component body and LED dot icon drawn
 *   - Attribute mapping: .dig XML attributes convert correctly
 *   - ComponentDefinition: all required fields present
 */

import { describe, it, expect } from "vitest";
import {
  LedMatrixElement,
  executeLedMatrix,
  LedMatrixDefinition,
  LED_MATRIX_ATTRIBUTE_MAPPINGS,
} from "../led-matrix.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers — ComponentLayout mock
// ---------------------------------------------------------------------------

/**
 * Layout for LedMatrix: 2 inputs (r-data at 0, c-addr at 1), 1 output.
 */
function makeLayout(): ComponentLayout {
  return {
    inputCount: () => 2,
    inputOffset: () => 0,
    outputCount: () => 1,
    outputOffset: () => 2,
    stateOffset: () => 0,
  };
}

/**
 * Build a Uint32Array with given input values.
 * [r-data, c-addr, output_slot]
 */
function makeState(rowData: number, colAddr: number): Uint32Array {
  const arr = new Uint32Array(3);
  arr[0] = rowData >>> 0;
  arr[1] = colAddr >>> 0;
  arr[2] = 0;
  return arr;
}

// ---------------------------------------------------------------------------
// Helpers — RenderContext mock
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers — LedMatrixElement factory
// ---------------------------------------------------------------------------

function makeLedMatrix(overrides?: {
  rowDataBits?: number;
  colAddrBits?: number;
  label?: string;
}): LedMatrixElement {
  const props = new PropertyBag();
  props.set("rowDataBits", overrides?.rowDataBits ?? 8);
  props.set("colAddrBits", overrides?.colAddrBits ?? 3);
  if (overrides?.label !== undefined) {
    props.set("label", overrides.label);
  }
  return new LedMatrixElement("test-lm-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// Matrix addressing
// ---------------------------------------------------------------------------

describe("LedMatrix", () => {
  describe("matrixAddressing", () => {
    it("setColumnData sets pixel data for addressed column", () => {
      const el = makeLedMatrix({ rowDataBits: 8, colAddrBits: 3 });
      el.setColumnData(0, 0xFF);
      const data = el.getMatrixData();
      expect(data[0]).toBe(0xFF);
    });

    it("setColumnData for different columns sets independently", () => {
      const el = makeLedMatrix({ rowDataBits: 8, colAddrBits: 3 });
      el.setColumnData(0, 0xAA);
      el.setColumnData(1, 0x55);
      el.setColumnData(2, 0xFF);
      const data = el.getMatrixData();
      expect(data[0]).toBe(0xAA);
      expect(data[1]).toBe(0x55);
      expect(data[2]).toBe(0xFF);
    });

    it("setColumnData ignores out-of-range column address", () => {
      const el = makeLedMatrix({ rowDataBits: 8, colAddrBits: 3 });
      el.setColumnData(8, 0xFF); // numCols=8, index 8 is out of range
      const data = el.getMatrixData();
      // All columns should remain 0
      for (let i = 0; i < 8; i++) {
        expect(data[i]).toBe(0);
      }
    });

    it("getMatrixData returns a snapshot (not the live buffer)", () => {
      const el = makeLedMatrix({ rowDataBits: 8, colAddrBits: 3 });
      el.setColumnData(0, 0xAA);
      const snapshot = el.getMatrixData();
      el.setColumnData(0, 0x55); // modify after snapshot
      expect(snapshot[0]).toBe(0xAA); // snapshot unchanged
    });

    it("clearData resets all pixel data to 0", () => {
      const el = makeLedMatrix({ rowDataBits: 8, colAddrBits: 3 });
      el.setColumnData(0, 0xFF);
      el.setColumnData(1, 0xAA);
      el.clearData();
      const data = el.getMatrixData();
      for (let i = 0; i < 8; i++) {
        expect(data[i]).toBe(0);
      }
    });

    it("numCols is 2^colAddrBits", () => {
      const el3 = makeLedMatrix({ colAddrBits: 3 });
      expect(el3.numCols).toBe(8);

      const el4 = makeLedMatrix({ colAddrBits: 4 });
      expect(el4.numCols).toBe(16);
    });

    it("matrix data buffer has numCols entries", () => {
      const el = makeLedMatrix({ colAddrBits: 3 });
      const data = el.getMatrixData();
      expect(data.length).toBe(8);
    });
  });

  // ---------------------------------------------------------------------------
  // executeLedMatrix
  // ---------------------------------------------------------------------------

  describe("executeLedMatrix", () => {
    it("encodes r-data and c-addr into output slot", () => {
      const layout = makeLayout();
      const state = makeState(0xAB, 3);
      const highZs = new Uint32Array(state.length);
      executeLedMatrix(0, state, highZs, layout);
      expect(typeof state[2]).toBe("number");
      // Output encodes both values
      const colAddr = state[2] & 0xFFFF;
      const rowData = (state[2] >>> 16) & 0xFFFF;
      expect(colAddr).toBe(3);
      expect(rowData).toBe(0xAB);
    });

    it("r-data=0, c-addr=0 produces output=0", () => {
      const layout = makeLayout();
      const state = makeState(0, 0);
      const highZs = new Uint32Array(state.length);
      executeLedMatrix(0, state, highZs, layout);
      expect(state[2]).toBe(0);
    });

    it("can be called 1000 times without error (zero-allocation path)", () => {
      const layout = makeLayout();
      const state = makeState(0, 0);
      const highZs = new Uint32Array(state.length);
      for (let i = 0; i < 1000; i++) {
        state[0] = i & 0xFF;
        state[1] = i & 0x7;
        executeLedMatrix(0, state, highZs, layout);
      }
      expect(typeof state[2]).toBe("number");
    });
  });

  // ---------------------------------------------------------------------------
  // Pin layout
  // ---------------------------------------------------------------------------

  describe("pinLayout", () => {
    it("has exactly 2 input pins", () => {
      const el = makeLedMatrix();
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(2);
    });

    it("input pins are labeled r-data and c-addr", () => {
      const el = makeLedMatrix();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      const labels = inputs.map((p) => p.label);
      expect(labels).toContain("r-data");
      expect(labels).toContain("c-addr");
    });

    it("r-data pin has bit width matching rowDataBits", () => {
      const el = makeLedMatrix({ rowDataBits: 16 });
      const pins = el.getPins();
      const rDataPin = pins.find((p) => p.label === "r-data");
      expect(rDataPin?.bitWidth).toBe(16);
    });

    it("c-addr pin has bit width matching colAddrBits", () => {
      const el = makeLedMatrix({ colAddrBits: 4 });
      const pins = el.getPins();
      const cAddrPin = pins.find((p) => p.label === "c-addr");
      expect(cAddrPin?.bitWidth).toBe(4);
    });

    it("has no output pins (display-only component)", () => {
      const el = makeLedMatrix();
      const pins = el.getPins();
      const outputs = pins.filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  describe("rendering", () => {
    it("draw() calls drawRect for the component body", () => {
      const el = makeLedMatrix();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const rectCalls = calls.filter((c) => c.method === "drawRect");
      expect(rectCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("draw() calls drawCircle for the LED dot icons", () => {
      const el = makeLedMatrix();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const circleCalls = calls.filter((c) => c.method === "drawCircle");
      expect(circleCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("draw() calls drawText for label", () => {
      const el = makeLedMatrix();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("draw() calls save and restore", () => {
      const el = makeLedMatrix();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draw() does not translate to component position (ElementRenderer handles that)", () => {
      const props = new PropertyBag();
      props.set("rowDataBits", 8);
      props.set("colAddrBits", 3);
      const el = new LedMatrixElement("inst", { x: 5, y: 3 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const translateCalls = calls.filter((c) => c.method === "translate");
      expect(translateCalls.some((c) => c.args[0] === 5 && c.args[1] === 3)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // getBoundingBox
  // ---------------------------------------------------------------------------

  describe("getBoundingBox", () => {
    it("bounding box x/y matches position", () => {
      const props = new PropertyBag();
      props.set("rowDataBits", 8);
      props.set("colAddrBits", 3);
      const el = new LedMatrixElement("inst", { x: 4, y: 6 }, 0, false, props);
      const box = el.getBoundingBox();
      expect(box.x).toBe(4);
      expect(box.y).toBe(6);
    });

    it("bounding box has positive dimensions", () => {
      const el = makeLedMatrix();
      const box = el.getBoundingBox();
      expect(box.width).toBeGreaterThanOrEqual(2);
      expect(box.height).toBeGreaterThanOrEqual(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Attribute mapping
  // ---------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("rowDataBits xmlName maps to rowDataBits propertyKey as integer", () => {
      const mapping = LED_MATRIX_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "rowDataBits");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("rowDataBits");
      expect(mapping!.convert("16")).toBe(16);
    });

    it("colAddrBits xmlName maps to colAddrBits propertyKey as integer", () => {
      const mapping = LED_MATRIX_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "colAddrBits");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("colAddrBits");
      expect(mapping!.convert("4")).toBe(4);
    });

    it("Label xmlName maps to label propertyKey", () => {
      const mapping = LED_MATRIX_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("label");
      expect(mapping!.convert("Display")).toBe("Display");
    });

    it("applying all mappings produces correct PropertyBag", () => {
      const entries: Record<string, string> = {
        rowDataBits: "8",
        colAddrBits: "3",
        Label: "My Matrix",
      };
      const bag = new PropertyBag();
      for (const mapping of LED_MATRIX_ATTRIBUTE_MAPPINGS) {
        if (entries[mapping.xmlName] !== undefined) {
          bag.set(mapping.propertyKey, mapping.convert(entries[mapping.xmlName]));
        }
      }
      expect(bag.get<number>("rowDataBits")).toBe(8);
      expect(bag.get<number>("colAddrBits")).toBe(3);
      expect(bag.get<string>("label")).toBe("My Matrix");
    });
  });

  // ---------------------------------------------------------------------------
  // ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("LedMatrixDefinition has name='LedMatrix'", () => {
      expect(LedMatrixDefinition.name).toBe("LedMatrix");
    });

    it("LedMatrixDefinition has typeId=-1 (sentinel for auto-assignment)", () => {
      expect(LedMatrixDefinition.typeId).toBe(-1);
    });

    it("LedMatrixDefinition has a factory function", () => {
      expect(typeof LedMatrixDefinition.factory).toBe("function");
    });

    it("LedMatrixDefinition factory produces a LedMatrixElement", () => {
      const props = new PropertyBag();
      props.set("rowDataBits", 8);
      props.set("colAddrBits", 3);
      const el = LedMatrixDefinition.factory(props);
      expect(el.typeId).toBe("LedMatrix");
    });

    it("LedMatrixDefinition executeFn is executeLedMatrix", () => {
      expect(LedMatrixDefinition.executeFn).toBe(executeLedMatrix);
    });

    it("LedMatrixDefinition pinLayout has 2 entries (r-data, c-addr)", () => {
      expect(LedMatrixDefinition.pinLayout).toHaveLength(2);
    });

    it("LedMatrixDefinition propertyDefs include rowDataBits and colAddrBits", () => {
      const keys = LedMatrixDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("rowDataBits");
      expect(keys).toContain("colAddrBits");
    });

    it("LedMatrixDefinition attributeMap covers rowDataBits, colAddrBits, Label", () => {
      const xmlNames = LedMatrixDefinition.attributeMap.map((m) => m.xmlName);
      expect(xmlNames).toContain("rowDataBits");
      expect(xmlNames).toContain("colAddrBits");
      expect(xmlNames).toContain("Label");
    });

    it("LedMatrixDefinition category is GRAPHICS", () => {
      expect(LedMatrixDefinition.category).toBe(ComponentCategory.GRAPHICS);
    });

    it("LedMatrixDefinition has a non-empty helpText", () => {
      expect(typeof LedMatrixDefinition.helpText).toBe("string");
      expect(typeof LedMatrixDefinition.helpText).toBe("string"); expect(LedMatrixDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("LedMatrixElement.getHelpText() returns relevant text", () => {
      const el = makeLedMatrix();
      expect(el.getHelpText()).toContain("LedMatrix");
    });

    it("LedMatrixDefinition can be registered in ComponentRegistry without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(LedMatrixDefinition)).not.toThrow();
    });

    it("After registration, LedMatrixDefinition typeId is non-negative integer", () => {
      const registry = new ComponentRegistry();
      registry.register(LedMatrixDefinition);
      const registered = registry.get("LedMatrix");
      expect(registered).not.toBeUndefined();
      expect(registered!.typeId).toBeGreaterThanOrEqual(0);
    });
  });
});
