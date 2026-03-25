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
    wiringTable: new Int32Array(64).map((_, i) => i),
    inputCount: () => inputCount,
    inputOffset: () => 0,
    outputCount: () => outputCount,
    outputOffset: () => inputCount,
    stateOffset: () => inputCount + outputCount,
    getProperty: () => undefined,
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
    it("executeTerminal is a no-op — Terminal is a display sink with no outputs", () => {
      // Terminal has 3 inputs (D, C, en) and 0 outputs.
      // The executeFn does nothing — display is driven by engine side-channel.
      const layout = makeLayout(3, 0);
      const state = makeState([0x41, 1, 1], 0);
      const highZs = new Uint32Array(state.length);
      // Should not throw and should not modify state
      const before = [...state];
      executeTerminal(0, state, highZs, layout);
      expect([...state]).toEqual(before);
    });
  });

  describe("pinLayout", () => {
    it("Terminal has 3 input pins: D, C, en", () => {
      const el = makeTerminal();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(3);
      const labels = inputs.map((p) => p.label);
      expect(labels).toContain("D");
      expect(labels).toContain("C");
      expect(labels).toContain("en");
    });

    it("Terminal has 0 output pins", () => {
      const el = makeTerminal();
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs).toHaveLength(0);
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

    it("draw renders component body polygon", () => {
      const el = makeTerminal();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const polys = calls.filter((c) => c.method === "drawPolygon");
      expect(polys.length).toBeGreaterThanOrEqual(1);
    });

    it("draw renders component shape via drawPolygon", () => {
      const el = makeTerminal();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const polys = calls.filter((c) => c.method === "drawPolygon");
      expect(polys.length).toBeGreaterThanOrEqual(2);
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
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("label");
      expect(mapping!.convert("UART")).toBe("UART");
    });

    it("Columns attribute maps to columns property", () => {
      const mapping = TERMINAL_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Columns");
      expect(mapping).not.toBeUndefined();
      expect(mapping!.propertyKey).toBe("columns");
      expect(mapping!.convert("40")).toBe(40);
    });

    it("Rows attribute maps to rows property", () => {
      const mapping = TERMINAL_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "Rows");
      expect(mapping).not.toBeUndefined();
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
      expect(TerminalDefinition.models.digital!.executeFn).toBe(executeTerminal);
    });

    it("TerminalDefinition category is TERMINAL", () => {
      expect(TerminalDefinition.category).toBe(ComponentCategory.TERMINAL);
    });

    it("TerminalDefinition has non-empty helpText", () => {
      expect(typeof TerminalDefinition.helpText).toBe("string"); expect(TerminalDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("TerminalDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(TerminalDefinition)).not.toThrow();
    });

    it("TerminalElement.getHelpText() contains 'Terminal'", () => {
      const el = makeTerminal();
      expect(el.getHelpText()).toContain("Terminal");
    });

    it("TerminalDefinition has pinLayout with 3 inputs and 0 outputs", () => {
      const inputs = TerminalDefinition.pinLayout.filter(
        (p) => p.direction === PinDirection.INPUT,
      );
      const outputs = TerminalDefinition.pinLayout.filter(
        (p) => p.direction === PinDirection.OUTPUT,
      );
      expect(inputs).toHaveLength(3);
      expect(outputs).toHaveLength(0);
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
    // Keyboard: 2 inputs (C at inBase+0, en at inBase+1), 2 outputs (D at outBase+0, av at outBase+1)
    // Scratch: prev_clk at outBase+2, pending_rd at outBase+3
    // inBase=0, outBase=2

    it("no clock edge (C=0, en=1) — pending_rd flag not set", () => {
      const layout = makeLayout(2, 4);
      const state = makeState([0, 1], 4); // C=0, en=1
      const highZs = new Uint32Array(state.length);
      // outBase=2, prev_clk at outBase+2=4
      state[2 + 2] = 0; // prev_clk = 0
      state[2 + 3] = 0; // pending_rd = 0
      executeKeyboard(0, state, highZs, layout);
      expect(state[2 + 3]).toBe(0); // no rising edge → no pending_rd
    });

    it("rising clock edge with en=1 — sets pending_rd flag", () => {
      const layout = makeLayout(2, 4);
      const state = makeState([1, 1], 4); // C=1, en=1
      const highZs = new Uint32Array(state.length);
      state[2 + 2] = 0; // prev_clk = 0 → rising edge
      state[2 + 3] = 0;
      executeKeyboard(0, state, highZs, layout);
      expect(state[2 + 3]).toBe(1); // pending_rd set
    });

    it("rising clock edge with en=0 — pending_rd NOT set", () => {
      const layout = makeLayout(2, 4);
      const state = makeState([1, 0], 4); // C=1, en=0
      const highZs = new Uint32Array(state.length);
      state[2 + 2] = 0; // prev_clk = 0 → rising edge but en=0
      state[2 + 3] = 0;
      executeKeyboard(0, state, highZs, layout);
      expect(state[2 + 3]).toBe(0); // en=0 suppresses pending_rd
    });

    it("C stays high (prev_clk=1) — no repeated pending_rd", () => {
      const layout = makeLayout(2, 4);
      const state = makeState([1, 1], 4); // C=1, en=1
      const highZs = new Uint32Array(state.length);
      state[2 + 2] = 1; // prev_clk = 1 → no new edge
      state[2 + 3] = 0;
      executeKeyboard(0, state, highZs, layout);
      expect(state[2 + 3]).toBe(0);
    });

    it("executeKeyboard updates prev_clk after rising edge", () => {
      const layout = makeLayout(2, 4);
      const state = makeState([1, 1], 4);
      const highZs = new Uint32Array(state.length);
      state[2 + 2] = 0; // prev_clk was 0
      executeKeyboard(0, state, highZs, layout);
      expect(state[2 + 2]).toBe(1); // now updated to C=1
    });

    it("executeKeyboard updates prev_clk to 0 when C=0", () => {
      const layout = makeLayout(2, 4);
      const state = makeState([0, 1], 4);
      const highZs = new Uint32Array(state.length);
      state[2 + 2] = 1; // prev_clk was 1
      executeKeyboard(0, state, highZs, layout);
      expect(state[2 + 2]).toBe(0);
    });
  });

  describe("pinLayout", () => {
    it("Keyboard has 2 input pins: C, en", () => {
      const el = makeKeyboard();
      const inputs = el.getPins().filter((p) => p.direction === PinDirection.INPUT);
      expect(inputs).toHaveLength(2);
      const labels = inputs.map((p) => p.label);
      expect(labels).toContain("C");
      expect(labels).toContain("en");
    });

    it("Keyboard has 2 output pins: D, av", () => {
      const el = makeKeyboard();
      const outputs = el.getPins().filter((p) => p.direction === PinDirection.OUTPUT);
      expect(outputs).toHaveLength(2);
      const labels = outputs.map((p) => p.label);
      expect(labels).toContain("D");
      expect(labels).toContain("av");
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

    it("draw renders component body polygon", () => {
      const el = makeKeyboard();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const polys = calls.filter((c) => c.method === "drawPolygon");
      expect(polys.length).toBeGreaterThanOrEqual(1);
    });

    it("draw renders component name 'Keyboard'", () => {
      const el = makeKeyboard();
      const { ctx, calls } = makeStubCtx();
      el.draw(ctx);
      const textCalls = calls.filter((c) => c.method === "drawText");
      expect(textCalls.some((c) => (c.args[0] as string).includes("Keyboard"))).toBe(true);
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
      expect(mapping).not.toBeUndefined();
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
      expect(KeyboardDefinition.models.digital!.executeFn).toBe(executeKeyboard);
    });

    it("KeyboardDefinition category is TERMINAL", () => {
      expect(KeyboardDefinition.category).toBe(ComponentCategory.TERMINAL);
    });

    it("KeyboardDefinition has non-empty helpText", () => {
      expect(typeof KeyboardDefinition.helpText).toBe("string"); expect(KeyboardDefinition.helpText.length).toBeGreaterThanOrEqual(3);
    });

    it("KeyboardDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(KeyboardDefinition)).not.toThrow();
    });

    it("KeyboardElement.getHelpText() contains 'Keyboard'", () => {
      const el = makeKeyboard();
      expect(el.getHelpText()).toContain("Keyboard");
    });

    it("KeyboardDefinition has pinLayout with 2 inputs and 2 outputs", () => {
      const inputs = KeyboardDefinition.pinLayout.filter(
        (p) => p.direction === PinDirection.INPUT,
      );
      const outputs = KeyboardDefinition.pinLayout.filter(
        (p) => p.direction === PinDirection.OUTPUT,
      );
      expect(inputs).toHaveLength(2);
      expect(outputs).toHaveLength(2);
    });
  });
});
