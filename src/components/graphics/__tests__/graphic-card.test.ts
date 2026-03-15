/**
 * Tests for GraphicCard component (task 5.2.27).
 *
 * Covers:
 *   - Memory read/write via readMemory/writeMemory
 *   - processInputs: rising clock + str=1 writes data, ld=1 reads data
 *   - Double-buffered bank: getDisplayBank returns correct bank slice
 *   - clearMemory: resets all state
 *   - executeGraphicCard: packs inputs into output slot
 *   - Pin layout: 6 inputs (A, str, C, ld, B, D), 1 output (D)
 *   - Rendering: component body drawn, label present
 *   - Attribute mapping: .dig XML attributes convert correctly
 *   - ComponentDefinition: all required fields present
 */

import { describe, it, expect } from "vitest";
import {
  GraphicCardElement,
  executeGraphicCard,
  GraphicCardDefinition,
  GRAPHIC_CARD_ATTRIBUTE_MAPPINGS,
} from "../graphic-card.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers — ComponentLayout mock (5 inputs, 1 output)
// GraphicCard has 5 inputs (A, str, C, ld, B) and 1 output (D)
// ---------------------------------------------------------------------------

function makeLayout(): ComponentLayout {
  return {
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => 5,
    inputOffset: () => 0,
    outputCount: () => 1,
    outputOffset: () => 5,
    stateOffset: () => 0,
  };
}

/**
 * Build state: [A, str, C, ld, B, output_slot]
 */
function makeState(
  addr: number,
  str: number,
  clk: number,
  ld: number,
  bank: number,
  _dataIn: number,
): Uint32Array {
  const arr = new Uint32Array(6);
  arr[0] = addr >>> 0;
  arr[1] = str & 1;
  arr[2] = clk & 1;
  arr[3] = ld & 1;
  arr[4] = bank & 1;
  arr[5] = 0; // output slot
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
// Helpers — GraphicCardElement factory
// ---------------------------------------------------------------------------

function makeCard(overrides?: {
  dataBits?: number;
  graphicWidth?: number;
  graphicHeight?: number;
  label?: string;
}): GraphicCardElement {
  const props = new PropertyBag();
  props.set("dataBits", overrides?.dataBits ?? 8);
  props.set("graphicWidth", overrides?.graphicWidth ?? 8);  // small for tests
  props.set("graphicHeight", overrides?.graphicHeight ?? 4);
  if (overrides?.label !== undefined) {
    props.set("label", overrides.label);
  }
  return new GraphicCardElement("test-gc-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// Memory access
// ---------------------------------------------------------------------------

describe("GraphicCard", () => {
  describe("memoryAccess", () => {
    it("writeMemory and readMemory round-trip", () => {
      const el = makeCard({ graphicWidth: 8, graphicHeight: 4 });
      el.writeMemory(0, 0xAB);
      expect(el.readMemory(0)).toBe(0xAB);
    });

    it("readMemory returns 0 for unwritten address", () => {
      const el = makeCard({ graphicWidth: 8, graphicHeight: 4 });
      expect(el.readMemory(5)).toBe(0);
    });

    it("writeMemory ignores out-of-bounds address", () => {
      const el = makeCard({ graphicWidth: 8, graphicHeight: 4 });
      const memSize = 8 * 4 * 2; // 64
      el.writeMemory(memSize, 0xFF); // exactly at size = out of bounds
      el.writeMemory(-1, 0xFF);
      // All memory still 0
      const snap = el.getMemorySnapshot();
      for (let i = 0; i < snap.length; i++) {
        expect(snap[i]).toBe(0);
      }
    });

    it("writeMemory can write to bank 0 and bank 1 addresses", () => {
      // graphicWidth=4, graphicHeight=2 → bankSize=8, total=16
      const el = makeCard({ graphicWidth: 4, graphicHeight: 2 });
      el.writeMemory(0, 0x11);  // bank 0, pixel 0
      el.writeMemory(8, 0x22);  // bank 1, pixel 0
      expect(el.readMemory(0)).toBe(0x11);
      expect(el.readMemory(8)).toBe(0x22);
    });

    it("getMemorySnapshot returns a copy, not the live buffer", () => {
      const el = makeCard({ graphicWidth: 4, graphicHeight: 2 });
      el.writeMemory(0, 0x42);
      const snap = el.getMemorySnapshot();
      el.writeMemory(0, 0xFF);
      expect(snap[0]).toBe(0x42); // snapshot unaffected
    });

    it("memory has 2 * graphicWidth * graphicHeight entries", () => {
      const el = makeCard({ graphicWidth: 6, graphicHeight: 3 });
      const snap = el.getMemorySnapshot();
      expect(snap.length).toBe(6 * 3 * 2);
    });

    it("clearMemory resets all memory to 0", () => {
      const el = makeCard({ graphicWidth: 4, graphicHeight: 2 });
      el.writeMemory(0, 0xFF);
      el.writeMemory(8, 0xAA);
      el.clearMemory();
      const snap = el.getMemorySnapshot();
      for (let i = 0; i < snap.length; i++) {
        expect(snap[i]).toBe(0);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // processInputs — write on rising clock + str
  // ---------------------------------------------------------------------------

  describe("processInputs", () => {
    it("rising clock with str=1 writes data to memory[addr]", () => {
      const el = makeCard({ graphicWidth: 8, graphicHeight: 4 });
      // Rising clock (lastClk=false → clk=true) with str=1, addr=3, data=0xAB
      el.processInputs(3, true, true, false, false, 0xAB);
      expect(el.readMemory(3)).toBe(0xAB);
    });

    it("rising clock with str=0 does not write", () => {
      const el = makeCard({ graphicWidth: 8, graphicHeight: 4 });
      el.processInputs(3, false, true, false, false, 0xAB);
      expect(el.readMemory(3)).toBe(0);
    });

    it("non-rising clock (stays high) with str=1 does not write again", () => {
      const el = makeCard({ graphicWidth: 8, graphicHeight: 4 });
      // First rising edge: write 0xAB
      el.processInputs(3, true, true, false, false, 0xAB);
      // Clock stays high (not a rising edge): write 0xCD — should NOT update
      el.processInputs(3, true, true, false, false, 0xCD);
      expect(el.readMemory(3)).toBe(0xAB);
    });

    it("falling edge with str=1 does not write", () => {
      const el = makeCard({ graphicWidth: 8, graphicHeight: 4 });
      // Establish clock high with first call
      el.processInputs(0, true, true, false, false, 0x11);
      // Falling edge
      el.processInputs(0, true, false, false, false, 0x22);
      // Memory retains first written value
      expect(el.readMemory(0)).toBe(0x11);
    });

    it("ld=1 sets dataOut to memory[addr]", () => {
      const el = makeCard({ graphicWidth: 8, graphicHeight: 4 });
      el.writeMemory(5, 0x77);
      el.processInputs(5, false, false, true, false, 0);
      expect(el.dataOut).toBe(0x77);
    });

    it("ld=0 sets dataOut to 0 (high-Z)", () => {
      const el = makeCard({ graphicWidth: 8, graphicHeight: 4 });
      el.writeMemory(5, 0x77);
      // First set ld=1 to verify it would be non-zero
      el.processInputs(5, false, false, true, false, 0);
      expect(el.dataOut).toBe(0x77);
      // Now ld=0: high-Z
      el.processInputs(5, false, false, false, false, 0);
      expect(el.dataOut).toBe(0);
    });

    it("write then read at same address", () => {
      const el = makeCard({ graphicWidth: 8, graphicHeight: 4 });
      // Write 0xCC to addr=2 on rising clock
      el.processInputs(2, true, true, false, false, 0xCC);
      // Falling clock, then read with ld=1
      el.processInputs(2, false, false, true, false, 0);
      expect(el.dataOut).toBe(0xCC);
    });

    it("clearMemory resets dataOut to 0", () => {
      const el = makeCard({ graphicWidth: 8, graphicHeight: 4 });
      el.writeMemory(0, 0xFF);
      el.processInputs(0, false, false, true, false, 0);
      expect(el.dataOut).toBe(0xFF);
      el.clearMemory();
      expect(el.dataOut).toBe(0);
    });

    it("addr wraps around with modulo (no out-of-bounds crash)", () => {
      const el = makeCard({ graphicWidth: 4, graphicHeight: 2 }); // total=16
      // addr=16 wraps to 0
      el.processInputs(16, true, true, false, false, 0x55);
      expect(el.readMemory(0)).toBe(0x55);
    });
  });

  // ---------------------------------------------------------------------------
  // Double-buffered bank display
  // ---------------------------------------------------------------------------

  describe("displayBank", () => {
    it("getDisplayBank(false) returns bank 0 slice", () => {
      // 4x2=8 per bank, total 16
      const el = makeCard({ graphicWidth: 4, graphicHeight: 2 });
      el.writeMemory(0, 0x11);
      el.writeMemory(1, 0x22);
      el.writeMemory(8, 0x33); // bank 1
      const bank0 = el.getDisplayBank(false);
      expect(bank0.length).toBe(8); // bankSize = 8
      expect(bank0[0]).toBe(0x11);
      expect(bank0[1]).toBe(0x22);
    });

    it("getDisplayBank(true) returns bank 1 slice", () => {
      const el = makeCard({ graphicWidth: 4, graphicHeight: 2 });
      el.writeMemory(8, 0x55);
      el.writeMemory(9, 0x66);
      const bank1 = el.getDisplayBank(true);
      expect(bank1.length).toBe(8);
      expect(bank1[0]).toBe(0x55);
      expect(bank1[1]).toBe(0x66);
    });

    it("getDisplayBank returns bankSize entries", () => {
      const el = makeCard({ graphicWidth: 6, graphicHeight: 3 }); // bankSize=18
      expect(el.getDisplayBank(false).length).toBe(18);
      expect(el.getDisplayBank(true).length).toBe(18);
    });
  });

  // ---------------------------------------------------------------------------
  // executeGraphicCard
  // ---------------------------------------------------------------------------

  describe("executeGraphicCard", () => {
    it("all-zero inputs produce output=0", () => {
      const layout = makeLayout();
      const state = makeState(0, 0, 0, 0, 0, 0);
      const highZs = new Uint32Array(state.length);
      executeGraphicCard(0, state, highZs, layout);
      expect(state[5]).toBe(0);
    });

    it("non-zero inputs produce non-zero output slot", () => {
      const layout = makeLayout();
      const state = makeState(5, 1, 1, 0, 0, 0);
      const highZs = new Uint32Array(state.length);
      executeGraphicCard(0, state, highZs, layout);
      expect(state[5]).not.toBe(0);
    });

    it("str flag is encoded in output slot", () => {
      const layout = makeLayout();
      const stateStr = makeState(0, 1, 0, 0, 0, 0);
      executeGraphicCard(0, stateStr, new Uint32Array(stateStr.length), layout);
      const withStr = stateStr[5];

      const stateNoStr = makeState(0, 0, 0, 0, 0, 0);
      executeGraphicCard(0, stateNoStr, new Uint32Array(stateNoStr.length), layout);
      const withoutStr = stateNoStr[5];

      expect(withStr).not.toBe(withoutStr);
    });

    it("ld flag is encoded in output slot", () => {
      const layout = makeLayout();
      const stateLd = makeState(0, 0, 0, 1, 0, 0);
      executeGraphicCard(0, stateLd, new Uint32Array(stateLd.length), layout);
      const withLd = stateLd[5];

      const stateNoLd = makeState(0, 0, 0, 0, 0, 0);
      executeGraphicCard(0, stateNoLd, new Uint32Array(stateNoLd.length), layout);
      const withoutLd = stateNoLd[5];

      expect(withLd).not.toBe(withoutLd);
    });

    it("bank flag is encoded in output slot", () => {
      const layout = makeLayout();
      const stateB1 = makeState(0, 0, 0, 0, 1, 0);
      executeGraphicCard(0, stateB1, new Uint32Array(stateB1.length), layout);
      const withB1 = stateB1[5];

      const stateB0 = makeState(0, 0, 0, 0, 0, 0);
      executeGraphicCard(0, stateB0, new Uint32Array(stateB0.length), layout);
      const withB0 = stateB0[5];

      expect(withB1).not.toBe(withB0);
    });

    it("can be called 1000 times without error (zero-allocation path)", () => {
      const layout = makeLayout();
      const state = makeState(0, 0, 0, 0, 0, 0);
      const highZs = new Uint32Array(state.length);
      for (let i = 0; i < 1000; i++) {
        state[0] = i & 0xFFFF;
        state[2] = i & 1;
        executeGraphicCard(0, state, highZs, layout);
      }
      expect(typeof state[5]).toBe("number");
    });
  });

  // ---------------------------------------------------------------------------
  // Pin layout
  // ---------------------------------------------------------------------------

  describe("pinLayout", () => {
    it("has exactly 5 input pins", () => {
      const el = makeCard();
      const pins = el.getPins();
      const inputs = pins.filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(5);
    });

    it("input pins are labeled A, str, C, ld, B", () => {
      const el = makeCard();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      const labels = inputs.map((p) => p.label);
      expect(labels).toContain("A");
      expect(labels).toContain("str");
      expect(labels).toContain("C");
      expect(labels).toContain("ld");
      expect(labels).toContain("B");
    });

    it("has exactly 1 output pin labeled D", () => {
      const el = makeCard();
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].label).toBe("D");
    });

    it("D output pin has bit width matching dataBits", () => {
      const el = makeCard({ dataBits: 16 });
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs[0].bitWidth).toBe(16);
    });

    it("C pin is marked as clock-capable", () => {
      const el = makeCard();
      const cPin = el.getPins().find(
        (p) => p.label === "C" && p.direction === PinDirection.INPUT,
      );
      expect(cPin?.isClock).toBe(true);
    });

    it("str, ld, B pins are 1-bit", () => {
      const el = makeCard();
      for (const label of ["str", "ld", "B", "C"]) {
        const pin = el.getPins().find(
          (p) => p.label === label && p.direction === PinDirection.INPUT,
        );
        expect(pin?.bitWidth).toBe(1);
      }
    });

    it("A pin bit width matches computed addrBits", () => {
      // graphicWidth=8, graphicHeight=4 → bankSize=32, total=64 → addrBits=6
      const el = makeCard({ graphicWidth: 8, graphicHeight: 4 });
      const aPin = el.getPins().find(
        (p) => p.label === "A" && p.direction === PinDirection.INPUT,
      );
      expect(aPin?.bitWidth).toBe(el.addrBits);
    });

    it("GraphicCardDefinition.pinLayout has 6 entries (5 in + 1 out)", () => {
      expect(GraphicCardDefinition.pinLayout).toHaveLength(6);
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  describe("rendering", () => {
    it("draw() calls drawRect for the component body", () => {
      const el = makeCard();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const rectCalls = calls.filter((c) => c.method === "drawRect");
      expect(rectCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("draw() calls drawText containing 'Gr-RAM'", () => {
      const el = makeCard();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(
        textCalls.some((c) => (c.args[0] as string).includes("Gr-RAM")),
      ).toBe(true);
    });

    it("draw() calls save and restore", () => {
      const el = makeCard();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draw() does not translate to component position (ElementRenderer handles that)", () => {
      const props = new PropertyBag();
      props.set("dataBits", 8);
      props.set("graphicWidth", 8);
      props.set("graphicHeight", 4);
      const el = new GraphicCardElement("inst", { x: 5, y: 3 }, 0, false, props);
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);

      const translateCalls = calls.filter((c) => c.method === "translate");
      expect(
        translateCalls.some((c) => c.args[0] === 5 && c.args[1] === 3),
      ).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // getBoundingBox
  // ---------------------------------------------------------------------------

  describe("getBoundingBox", () => {
    it("bounding box x/y matches position", () => {
      const props = new PropertyBag();
      props.set("dataBits", 8);
      props.set("graphicWidth", 8);
      props.set("graphicHeight", 4);
      const el = new GraphicCardElement("inst", { x: 2, y: 7 }, 0, false, props);
      const box = el.getBoundingBox();
      expect(box.x).toBe(2);
      expect(box.y).toBe(7 - 0.5);
    });

    it("bounding box has positive dimensions", () => {
      const el = makeCard();
      const box = el.getBoundingBox();
      expect(box.width).toBeGreaterThanOrEqual(2);
      expect(box.height).toBeGreaterThanOrEqual(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Attribute mapping
  // ---------------------------------------------------------------------------

  describe("attributeMapping", () => {
    it("Label xmlName maps to label propertyKey", () => {
      const mapping = GRAPHIC_CARD_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("label");
      expect(mapping!.convert("Display")).toBe("Display");
    });

    it("Bits xmlName maps to dataBits propertyKey as integer", () => {
      const mapping = GRAPHIC_CARD_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Bits");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("dataBits");
      expect(mapping!.convert("16")).toBe(16);
    });

    it("graphicWidth xmlName maps to graphicWidth propertyKey as integer", () => {
      const mapping = GRAPHIC_CARD_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "graphicWidth");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("graphicWidth");
      expect(mapping!.convert("320")).toBe(320);
    });

    it("graphicHeight xmlName maps to graphicHeight propertyKey as integer", () => {
      const mapping = GRAPHIC_CARD_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "graphicHeight");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("graphicHeight");
      expect(mapping!.convert("200")).toBe(200);
    });

    it("applying all mappings produces correct PropertyBag", () => {
      const entries: Record<string, string> = {
        Label: "Frame Buffer",
        Bits: "8",
        graphicWidth: "160",
        graphicHeight: "100",
      };
      const bag = new PropertyBag();
      for (const mapping of GRAPHIC_CARD_ATTRIBUTE_MAPPINGS) {
        if (entries[mapping.xmlName] !== undefined) {
          bag.set(mapping.propertyKey, mapping.convert(entries[mapping.xmlName]));
        }
      }
      expect(bag.get<string>("label")).toBe("Frame Buffer");
      expect(bag.get<number>("dataBits")).toBe(8);
      expect(bag.get<number>("graphicWidth")).toBe(160);
      expect(bag.get<number>("graphicHeight")).toBe(100);
    });
  });

  // ---------------------------------------------------------------------------
  // ComponentDefinition completeness
  // ---------------------------------------------------------------------------

  describe("definitionComplete", () => {
    it("GraphicCardDefinition has name='GraphicCard'", () => {
      expect(GraphicCardDefinition.name).toBe("GraphicCard");
    });

    it("GraphicCardDefinition has typeId=-1 (sentinel for auto-assignment)", () => {
      expect(GraphicCardDefinition.typeId).toBe(-1);
    });

    it("GraphicCardDefinition has a factory function", () => {
      expect(typeof GraphicCardDefinition.factory).toBe("function");
    });

    it("GraphicCardDefinition factory produces a GraphicCardElement", () => {
      const props = new PropertyBag();
      props.set("dataBits", 8);
      props.set("graphicWidth", 8);
      props.set("graphicHeight", 4);
      const el = GraphicCardDefinition.factory(props);
      expect(el.typeId).toBe("GraphicCard");
    });

    it("GraphicCardDefinition executeFn is executeGraphicCard", () => {
      expect(GraphicCardDefinition.executeFn).toBe(executeGraphicCard);
    });

    it("GraphicCardDefinition pinLayout has 6 entries", () => {
      expect(GraphicCardDefinition.pinLayout).toHaveLength(6);
    });

    it("GraphicCardDefinition propertyDefs include dataBits, graphicWidth, graphicHeight", () => {
      const keys = GraphicCardDefinition.propertyDefs.map((d) => d.key);
      expect(keys).toContain("dataBits");
      expect(keys).toContain("graphicWidth");
      expect(keys).toContain("graphicHeight");
    });

    it("GraphicCardDefinition attributeMap covers Label, Bits, graphicWidth, graphicHeight", () => {
      const xmlNames = GraphicCardDefinition.attributeMap.map((m) => m.xmlName);
      expect(xmlNames).toContain("Label");
      expect(xmlNames).toContain("Bits");
      expect(xmlNames).toContain("graphicWidth");
      expect(xmlNames).toContain("graphicHeight");
    });

    it("GraphicCardDefinition category is GRAPHICS", () => {
      expect(GraphicCardDefinition.category).toBe(ComponentCategory.GRAPHICS);
    });

    it("GraphicCardDefinition has a non-empty helpText", () => {
      expect(typeof GraphicCardDefinition.helpText).toBe("string");
      expect(typeof GraphicCardDefinition.helpText).toBe("string"); expect(GraphicCardDefinition.helpText!.length).toBeGreaterThanOrEqual(3);
    });

    it("GraphicCardElement.getHelpText() returns relevant text", () => {
      const el = makeCard();
      expect(el.getHelpText()).toContain("GraphicCard");
    });

    it("GraphicCardDefinition can be registered in ComponentRegistry without throwing", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(GraphicCardDefinition)).not.toThrow();
    });

    it("After registration, GraphicCardDefinition typeId is non-negative integer", () => {
      const registry = new ComponentRegistry();
      registry.register(GraphicCardDefinition);
      const registered = registry.get("GraphicCard");
      expect(registered).not.toBeUndefined();
      expect(registered!.typeId).toBeGreaterThanOrEqual(0);
    });
  });
});
