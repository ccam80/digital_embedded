/**
 * Tests for Terminal and Keyboard components.
 *
 * Covers:
 *   - Terminal: character output to buffer, keyboard queue management,
 *     wr/rd edge detection, pin layout, rendering, attribute mapping,
 *     definition completeness
 *   - Keyboard: key code output, ready flag, rd edge detection, pin layout,
 *     rendering, attribute mapping, definition completeness
 */

import { describe, it, expect } from "vitest";
import {
  TerminalElement,
  executeTerminal,
  TerminalDefinition,
  TERMINAL_ATTRIBUTE_MAPPINGS,
} from "../terminal.js";
import {
  KeyboardElement,
  executeKeyboard,
  KeyboardDefinition,
  KEYBOARD_ATTRIBUTE_MAPPINGS,
} from "../keyboard.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { ComponentLayout } from "../../../core/registry.js";
import type { RenderContext, Point, TextAnchor, FontSpec, PathData } from "../../../core/renderer-interface.js";
import type { ThemeColor } from "../../../core/renderer-interface.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLayout(inputCount: number, outputCount: number): ComponentLayout {
  return {
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => inputCount,
  };
}

function makeState(inputs: number[], extraSlots: number = 8): Uint32Array {
  const arr = new Uint32Array(inputs.length + extraSlots);
  for (let i = 0; i < inputs.length; i++) {
    arr[i] = inputs[i] >>> 0;
  }
  return arr;
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

function makeTerminal(overrides?: {
  label?: string;
  columns?: number;
  rows?: number;
}): TerminalElement {
  const props = new PropertyBag();
  props.set("label", overrides?.label ?? "");
  props.set("columns", overrides?.columns ?? 80);
  props.set("rows", overrides?.rows ?? 24);
  return new TerminalElement("test-terminal-001", { x: 0, y: 0 }, 0, false, props);
}

function makeKeyboard(overrides?: { label?: string }): KeyboardElement {
  const props = new PropertyBag();
  props.set("label", overrides?.label ?? "");
  return new KeyboardElement("test-keyboard-001", { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// Terminal tests
// ---------------------------------------------------------------------------

describe("Terminal", () => {
  describe("characterOutput", () => {
    it("appendChar adds character to buffer", () => {
      const el = makeTerminal();
      el.appendChar(65); // 'A'
      expect(el.getCharBuffer()).toHaveLength(1);
      expect(el.getCharBuffer()[0]).toBe(65);
    });

    it("appendChar accumulates multiple characters", () => {
      const el = makeTerminal();
      el.appendChar(72); // 'H'
      el.appendChar(105); // 'i'
      expect(el.getCharBuffer()).toEqual([72, 105]);
    });

    it("appendChar masks to 8-bit values", () => {
      const el = makeTerminal();
      el.appendChar(0x141); // 321 → 0x41 = 65
      expect(el.getCharBuffer()[0]).toBe(0x41);
    });

    it("buffer is capped at 4096 characters", () => {
      const el = makeTerminal();
      for (let i = 0; i < 4200; i++) {
        el.appendChar(i & 0xff);
      }
      expect(el.getCharBuffer().length).toBeLessThanOrEqual(4096);
    });

    it("clearBuffers empties the character buffer", () => {
      const el = makeTerminal();
      el.appendChar(65);
      el.appendChar(66);
      el.clearBuffers();
      expect(el.getCharBuffer()).toHaveLength(0);
    });
  });

  describe("keyboardQueue", () => {
    it("enqueueKey adds key to terminal's keyboard queue", () => {
      const el = makeTerminal();
      el.enqueueKey(0x41);
      expect(el.keyQueueLength()).toBe(1);
    });

    it("peekKey returns front key code without removing it", () => {
      const el = makeTerminal();
      el.enqueueKey(0x41);
      el.enqueueKey(0x42);
      expect(el.peekKey()).toBe(0x41);
      expect(el.keyQueueLength()).toBe(2);
    });

    it("dequeueKey removes and returns front key", () => {
      const el = makeTerminal();
      el.enqueueKey(0x41);
      el.enqueueKey(0x42);
      const code = el.dequeueKey();
      expect(code).toBe(0x41);
      expect(el.keyQueueLength()).toBe(1);
    });

    it("dequeueKey returns -1 when queue is empty", () => {
      const el = makeTerminal();
      expect(el.dequeueKey()).toBe(-1);
    });

    it("peekKey returns -1 when queue is empty", () => {
      const el = makeTerminal();
      expect(el.peekKey()).toBe(-1);
    });

    it("clearBuffers empties the keyboard queue", () => {
      const el = makeTerminal();
      el.enqueueKey(0x41);
      el.clearBuffers();
      expect(el.keyQueueLength()).toBe(0);
    });

    it("keyboard queue is capped at 64 entries", () => {
      const el = makeTerminal();
      for (let i = 0; i < 100; i++) {
        el.enqueueKey(i & 0xff);
      }
      expect(el.keyQueueLength()).toBeLessThanOrEqual(64);
    });
  });

  describe("executeTerminal", () => {
    it("no wr edge — pending_wr flag not set", () => {
      // wr=0 throughout, prev_wr was already 0
      const layout = makeLayout(3, 7);
      const state = makeState([0x41, 0, 0], 7);
      // outBase = 3, outBase+2=prev_wr=0
      state[3 + 2] = 0; // prev_wr = 0
      executeTerminal(0, state, layout);
      // pending_wr (outBase+5) should be 0
      expect(state[3 + 5]).toBe(0);
    });

    it("rising wr edge — sets pending_wr flag with character", () => {
      const layout = makeLayout(3, 7);
      // inputs: din=0x41, wr=1, rd=0
      const state = makeState([0x41, 1, 0], 7);
      // outBase=3, prev_wr (outBase+2)=0 initially → rising edge
      state[3 + 2] = 0;
      state[3 + 5] = 0;
      executeTerminal(0, state, layout);
      // pending char stored at outBase+4
      expect(state[3 + 4]).toBe(0x41);
      // pending_wr flag set at outBase+5
      expect(state[3 + 5]).toBe(1);
    });

    it("wr=1 stays high — no repeated pending_wr (not a new edge)", () => {
      const layout = makeLayout(3, 7);
      const state = makeState([0x42, 1, 0], 7);
      // prev_wr=1 means wr was already high → no rising edge
      state[3 + 2] = 1;
      state[3 + 4] = 0;
      state[3 + 5] = 0;
      executeTerminal(0, state, layout);
      expect(state[3 + 5]).toBe(0); // pending_wr NOT set
    });

    it("rising rd edge — sets pending_rd flag", () => {
      const layout = makeLayout(3, 7);
      // inputs: din=0, wr=0, rd=1
      const state = makeState([0, 0, 1], 7);
      state[3 + 3] = 0; // prev_rd = 0
      state[3 + 6] = 0;
      executeTerminal(0, state, layout);
      expect(state[3 + 6]).toBe(1); // pending_rd flag
    });

    it("no rd edge — pending_rd flag not set", () => {
      const layout = makeLayout(3, 7);
      const state = makeState([0, 0, 0], 7);
      state[3 + 3] = 0; // prev_rd = 0
      state[3 + 6] = 0;
      executeTerminal(0, state, layout);
      expect(state[3 + 6]).toBe(0);
    });

    it("executeTerminal updates prev_wr after step", () => {
      const layout = makeLayout(3, 7);
      const state = makeState([0x41, 1, 0], 7);
      state[3 + 2] = 0;
      executeTerminal(0, state, layout);
      // prev_wr should now be 1
      expect(state[3 + 2]).toBe(1);
    });

    it("executeTerminal updates prev_rd after step", () => {
      const layout = makeLayout(3, 7);
      const state = makeState([0, 0, 1], 7);
      state[3 + 3] = 0;
      executeTerminal(0, state, layout);
      // prev_rd should now be 1
      expect(state[3 + 3]).toBe(1);
    });
  });

  describe("pinLayout", () => {
    it("Terminal has 3 input pins: din, wr, rd", () => {
      const el = makeTerminal();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(3);
      const labels = inputs.map((p) => p.label);
      expect(labels).toContain("din");
      expect(labels).toContain("wr");
      expect(labels).toContain("rd");
    });

    it("Terminal has 2 output pins: dout, rdy", () => {
      const el = makeTerminal();
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs).toHaveLength(2);
      const labels = outputs.map((p) => p.label);
      expect(labels).toContain("dout");
      expect(labels).toContain("rdy");
    });

    it("columns property accessible", () => {
      const el = makeTerminal({ columns: 40 });
      expect(el.columns).toBe(40);
    });

    it("rows property accessible", () => {
      const el = makeTerminal({ rows: 12 });
      expect(el.rows).toBe(12);
    });
  });

  describe("rendering", () => {
    it("draw calls save and restore", () => {
      const el = makeTerminal();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draw renders component body rect", () => {
      const el = makeTerminal();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const rects = calls.filter((c) => c.method === "drawRect");
      expect(rects.length).toBeGreaterThanOrEqual(1);
    });

    it("draw renders screen symbol rect inside body", () => {
      const el = makeTerminal();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const rects = calls.filter((c) => c.method === "drawRect");
      expect(rects.length).toBeGreaterThanOrEqual(2);
    });

    it("draw renders Terminal label text", () => {
      const el = makeTerminal();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const texts = calls.filter((c) => c.method === "drawText");
      expect(texts.some((c) => (c.args[0] as string).includes("Terminal"))).toBe(true);
    });

    it("draw renders custom label when set", () => {
      const el = makeTerminal({ label: "UART" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const texts = calls.filter((c) => c.method === "drawText");
      expect(texts.some((c) => c.args[0] === "UART")).toBe(true);
    });
  });

  describe("attributeMapping", () => {
    it("Label attribute maps to label property", () => {
      const mapping = TERMINAL_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).toBeDefined();
      expect(mapping!.propertyKey).toBe("label");
      expect(mapping!.convert("UART")).toBe("UART");
    });

    it("Columns attribute maps to columns property", () => {
      const mapping = TERMINAL_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Columns");
      expect(mapping).toBeDefined();
      expect(mapping!.propertyKey).toBe("columns");
      expect(mapping!.convert("40")).toBe(40);
    });

    it("Rows attribute maps to rows property", () => {
      const mapping = TERMINAL_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Rows");
      expect(mapping).toBeDefined();
      expect(mapping!.propertyKey).toBe("rows");
      expect(mapping!.convert("12")).toBe(12);
    });
  });

  describe("definitionComplete", () => {
    it("TerminalDefinition has name='Terminal'", () => {
      expect(TerminalDefinition.name).toBe("Terminal");
    });

    it("TerminalDefinition has typeId=-1", () => {
      expect(TerminalDefinition.typeId).toBe(-1);
    });

    it("TerminalDefinition factory produces TerminalElement", () => {
      const props = new PropertyBag();
      props.set("label", "");
      props.set("columns", 80);
      props.set("rows", 24);
      const el = TerminalDefinition.factory(props);
      expect(el.typeId).toBe("Terminal");
    });

    it("TerminalDefinition executeFn is executeTerminal", () => {
      expect(TerminalDefinition.executeFn).toBe(executeTerminal);
    });

    it("TerminalDefinition category is TERMINAL", () => {
      expect(TerminalDefinition.category).toBe(ComponentCategory.TERMINAL);
    });

    it("TerminalDefinition has non-empty helpText", () => {
      expect(TerminalDefinition.helpText.length).toBeGreaterThan(0);
    });

    it("TerminalDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(TerminalDefinition)).not.toThrow();
    });

    it("TerminalElement.getHelpText() contains 'Terminal'", () => {
      const el = makeTerminal();
      expect(el.getHelpText()).toContain("Terminal");
    });

    it("TerminalDefinition has pinLayout with 3 inputs and 2 outputs", () => {
      const inputs = TerminalDefinition.pinLayout.filter(
        (p) => p.direction === PinDirection.INPUT,
      );
      const outputs = TerminalDefinition.pinLayout.filter(
        (p) => p.direction === PinDirection.OUTPUT,
      );
      expect(inputs).toHaveLength(3);
      expect(outputs).toHaveLength(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Keyboard tests
// ---------------------------------------------------------------------------

describe("Keyboard", () => {
  describe("keyCodeOutput", () => {
    it("currentKeyCode returns 0 when queue is empty", () => {
      const el = makeKeyboard();
      expect(el.currentKeyCode()).toBe(0);
    });

    it("currentKeyCode returns front key code when queue has entries", () => {
      const el = makeKeyboard();
      el.enqueueKey(0x41);
      expect(el.currentKeyCode()).toBe(0x41);
    });

    it("enqueueKey followed by dequeueKey FIFO order", () => {
      const el = makeKeyboard();
      el.enqueueKey(0x41);
      el.enqueueKey(0x42);
      el.enqueueKey(0x43);
      expect(el.dequeueKey()).toBe(0x41);
      expect(el.dequeueKey()).toBe(0x42);
      expect(el.dequeueKey()).toBe(0x43);
    });

    it("enqueueKey masks to 8-bit values", () => {
      const el = makeKeyboard();
      el.enqueueKey(0x141);
      expect(el.currentKeyCode()).toBe(0x41);
    });
  });

  describe("readyFlag", () => {
    it("readyFlag is 0 when queue is empty", () => {
      const el = makeKeyboard();
      expect(el.readyFlag()).toBe(0);
    });

    it("readyFlag is 1 when queue has at least one key", () => {
      const el = makeKeyboard();
      el.enqueueKey(0x41);
      expect(el.readyFlag()).toBe(1);
    });

    it("readyFlag becomes 0 after all keys dequeued", () => {
      const el = makeKeyboard();
      el.enqueueKey(0x41);
      el.dequeueKey();
      expect(el.readyFlag()).toBe(0);
    });

    it("dequeueKey on empty queue returns -1", () => {
      const el = makeKeyboard();
      expect(el.dequeueKey()).toBe(-1);
    });

    it("peekKey does not remove key", () => {
      const el = makeKeyboard();
      el.enqueueKey(0x41);
      el.peekKey();
      expect(el.keyQueueLength()).toBe(1);
    });

    it("clearQueue empties the keyboard queue", () => {
      const el = makeKeyboard();
      el.enqueueKey(0x41);
      el.enqueueKey(0x42);
      el.clearQueue();
      expect(el.keyQueueLength()).toBe(0);
      expect(el.readyFlag()).toBe(0);
    });

    it("queue is capped at 64 entries", () => {
      const el = makeKeyboard();
      for (let i = 0; i < 100; i++) {
        el.enqueueKey(i & 0xff);
      }
      expect(el.keyQueueLength()).toBeLessThanOrEqual(64);
    });
  });

  describe("executeKeyboard", () => {
    it("no rd edge — pending_rd flag not set", () => {
      // rd=0, prev_rd=0 → no edge
      const layout = makeLayout(1, 4);
      const state = makeState([0], 4);
      // outBase=1, outBase+2=prev_rd=0
      state[1 + 2] = 0;
      state[1 + 3] = 0;
      executeKeyboard(0, state, layout);
      expect(state[1 + 3]).toBe(0);
    });

    it("rising rd edge — sets pending_rd flag", () => {
      // rd=1, prev_rd=0 → rising edge
      const layout = makeLayout(1, 4);
      const state = makeState([1], 4);
      state[1 + 2] = 0; // prev_rd = 0
      state[1 + 3] = 0;
      executeKeyboard(0, state, layout);
      expect(state[1 + 3]).toBe(1);
    });

    it("rd=1 stays high — no repeated pending_rd", () => {
      // rd=1, prev_rd=1 → no new edge
      const layout = makeLayout(1, 4);
      const state = makeState([1], 4);
      state[1 + 2] = 1; // prev_rd = 1
      state[1 + 3] = 0;
      executeKeyboard(0, state, layout);
      expect(state[1 + 3]).toBe(0);
    });

    it("executeKeyboard updates prev_rd after step", () => {
      const layout = makeLayout(1, 4);
      const state = makeState([1], 4);
      state[1 + 2] = 0;
      executeKeyboard(0, state, layout);
      expect(state[1 + 2]).toBe(1);
    });

    it("executeKeyboard with rd=0 updates prev_rd to 0", () => {
      const layout = makeLayout(1, 4);
      const state = makeState([0], 4);
      state[1 + 2] = 1; // was high
      executeKeyboard(0, state, layout);
      expect(state[1 + 2]).toBe(0);
    });
  });

  describe("pinLayout", () => {
    it("Keyboard has 1 input pin: rd", () => {
      const el = makeKeyboard();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(1);
      expect(inputs[0].label).toBe("rd");
    });

    it("Keyboard has 2 output pins: dout, rdy", () => {
      const el = makeKeyboard();
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs).toHaveLength(2);
      const labels = outputs.map((p) => p.label);
      expect(labels).toContain("dout");
      expect(labels).toContain("rdy");
    });
  });

  describe("rendering", () => {
    it("draw calls save and restore", () => {
      const el = makeKeyboard();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      expect(calls.some((c) => c.method === "save")).toBe(true);
      expect(calls.some((c) => c.method === "restore")).toBe(true);
    });

    it("draw renders component body rect", () => {
      const el = makeKeyboard();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const rects = calls.filter((c) => c.method === "drawRect");
      expect(rects.length).toBeGreaterThanOrEqual(1);
    });

    it("draw renders keyboard key symbol rects", () => {
      const el = makeKeyboard();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const rects = calls.filter((c) => c.method === "drawRect");
      expect(rects.length).toBeGreaterThanOrEqual(4);
    });

    it("draw renders custom label when set", () => {
      const el = makeKeyboard({ label: "KB" });
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const texts = calls.filter((c) => c.method === "drawText");
      expect(texts.some((c) => c.args[0] === "KB")).toBe(true);
    });
  });

  describe("attributeMapping", () => {
    it("Label attribute maps to label property", () => {
      const mapping = KEYBOARD_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Label");
      expect(mapping).toBeDefined();
      expect(mapping!.propertyKey).toBe("label");
      expect(mapping!.convert("KBD")).toBe("KBD");
    });
  });

  describe("definitionComplete", () => {
    it("KeyboardDefinition has name='Keyboard'", () => {
      expect(KeyboardDefinition.name).toBe("Keyboard");
    });

    it("KeyboardDefinition has typeId=-1", () => {
      expect(KeyboardDefinition.typeId).toBe(-1);
    });

    it("KeyboardDefinition factory produces KeyboardElement", () => {
      const props = new PropertyBag();
      props.set("label", "");
      const el = KeyboardDefinition.factory(props);
      expect(el.typeId).toBe("Keyboard");
    });

    it("KeyboardDefinition executeFn is executeKeyboard", () => {
      expect(KeyboardDefinition.executeFn).toBe(executeKeyboard);
    });

    it("KeyboardDefinition category is TERMINAL", () => {
      expect(KeyboardDefinition.category).toBe(ComponentCategory.TERMINAL);
    });

    it("KeyboardDefinition has non-empty helpText", () => {
      expect(KeyboardDefinition.helpText.length).toBeGreaterThan(0);
    });

    it("KeyboardDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(KeyboardDefinition)).not.toThrow();
    });

    it("KeyboardElement.getHelpText() contains 'Keyboard'", () => {
      const el = makeKeyboard();
      expect(el.getHelpText()).toContain("Keyboard");
    });

    it("KeyboardDefinition has pinLayout with 1 input and 2 outputs", () => {
      const inputs = KeyboardDefinition.pinLayout.filter(
        (p) => p.direction === PinDirection.INPUT,
      );
      const outputs = KeyboardDefinition.pinLayout.filter(
        (p) => p.direction === PinDirection.OUTPUT,
      );
      expect(inputs).toHaveLength(1);
      expect(outputs).toHaveLength(2);
    });
  });
});
