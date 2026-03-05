/**
 * Tests for SingleValueDialog — Task 7.2.4.
 *
 * Uses a minimal DOM stub so tests run in node without jsdom.
 *
 * Covers:
 *   - displayFormats: value 0xFF, 8-bit → shows "11111111", "255", "-1", "FF"
 *   - highZ: HIGH_Z value → shows "High-Z" indication
 *   - override: enter "0x42" in override field, verify engine.setSignalValue called
 *   - bitWidth: 16-bit signal → shows "16 bits"
 */

import { describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Minimal DOM stub
// ---------------------------------------------------------------------------

type AnyListener = (e: Event) => void;

class StubClassList {
  readonly _classes: Set<string> = new Set();
  add(...tokens: string[]): void { for (const t of tokens) this._classes.add(t); }
  remove(...tokens: string[]): void { for (const t of tokens) this._classes.delete(t); }
  contains(token: string): boolean { return this._classes.has(token); }
}

class StubElement {
  tagName: string;
  private _className: string = "";
  textContent: string | null = "";
  placeholder: string = "";
  type: string = "";
  value: string = "";
  maxLength: number = 0;
  dataset: Record<string, string> = {};
  readonly classList: StubClassList = new StubClassList();
  readonly children: StubElement[] = [];
  parentElement: StubElement | null = null;

  get className(): string { return this._className; }
  set className(v: string) {
    this._className = v;
    (this.classList as unknown as { _classes: Set<string> })._classes.clear();
    for (const t of v.split(/\s+/).filter((s) => s.length > 0)) this.classList.add(t);
  }

  private readonly _listeners: Map<string, AnyListener[]> = new Map();

  constructor(tagName: string) { this.tagName = tagName.toUpperCase(); }

  appendChild(child: StubElement): StubElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: StubElement): void {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentElement = null;
    }
  }

  contains(node: unknown): boolean {
    if (node === this) return true;
    for (const child of this.children) {
      if (child.contains(node)) return true;
    }
    return false;
  }

  addEventListener(event: string, cb: AnyListener): void {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(cb);
  }

  removeEventListener(event: string, cb: AnyListener): void {
    const list = this._listeners.get(event);
    if (list) {
      const idx = list.indexOf(cb);
      if (idx !== -1) list.splice(idx, 1);
    }
  }

  /** Fire a synthetic event on this element. */
  dispatchEvent(event: { type: string; key?: string; target?: unknown }): void {
    const listeners = this._listeners.get(event.type) ?? [];
    for (const cb of listeners) cb(event as unknown as Event);
  }

  querySelectorAll(selector: string): StubElement[] {
    const results: StubElement[] = [];
    this._collect(selector.trim(), results);
    return results;
  }

  querySelector(selector: string): StubElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  private _matches(selector: string): boolean {
    const dotIdx = selector.indexOf(".");
    if (dotIdx === -1) return this.tagName.toLowerCase() === selector.toLowerCase();
    const tag = selector.slice(0, dotIdx);
    const cls = selector.slice(dotIdx + 1);
    const tagOk = tag === "" || this.tagName.toLowerCase() === tag.toLowerCase();
    return tagOk && this.classList.contains(cls);
  }

  private _collect(selector: string, results: StubElement[]): void {
    for (const child of this.children) {
      if (child._matches(selector)) results.push(child);
      child._collect(selector, results);
    }
  }
}

// Global document listeners map (for document.addEventListener)
const _docListeners: Map<string, AnyListener[]> = new Map();

const stubDocument = {
  body: new StubElement("body"),
  createElement(tagName: string): StubElement { return new StubElement(tagName); },
  addEventListener(event: string, cb: AnyListener): void {
    if (!_docListeners.has(event)) _docListeners.set(event, []);
    _docListeners.get(event)!.push(cb);
  },
  removeEventListener(event: string, cb: AnyListener): void {
    const list = _docListeners.get(event);
    if (list) {
      const idx = list.indexOf(cb);
      if (idx !== -1) list.splice(idx, 1);
    }
  },
  dispatchEvent(event: { type: string; key?: string; target?: unknown }): void {
    const listeners = _docListeners.get(event.type) ?? [];
    for (const cb of listeners) cb(event as unknown as Event);
  },
};

(globalThis as Record<string, unknown>)["document"] = stubDocument;

// ---------------------------------------------------------------------------
// Import modules AFTER installing stub
// ---------------------------------------------------------------------------

import { BitVector } from "../../core/signal.js";
import { SingleValueDialog } from "../value-dialog.js";
import type { MeasurementObserver, SimulationEngine, CompiledCircuit, EngineState, EngineChangeListener, SnapshotId } from "../../core/engine-interface.js";

// ---------------------------------------------------------------------------
// Mock SimulationEngine
// ---------------------------------------------------------------------------

class MockEngine implements SimulationEngine {
  readonly setSignalCalls: Array<{ netId: number; value: BitVector }> = [];

  setSignalValue(netId: number, value: BitVector): void {
    this.setSignalCalls.push({ netId, value });
  }

  // Unused stubs
  init(_c: CompiledCircuit): void {}
  reset(): void {}
  dispose(): void {}
  step(): void {}
  microStep(): void {}
  runToBreak(): void {}
  start(): void {}
  stop(): void {}
  getState(): EngineState { return "STOPPED" as EngineState; }
  getSignalRaw(_n: number): number { return 0; }
  getSignalValue(_n: number): BitVector { return BitVector.fromNumber(0, 8); }
  addChangeListener(_l: EngineChangeListener): void {}
  removeChangeListener(_l: EngineChangeListener): void {}
  addMeasurementObserver(_o: MeasurementObserver): void {}
  removeMeasurementObserver(_o: MeasurementObserver): void {}
  saveSnapshot(): SnapshotId { return 0; }
  restoreSnapshot(_id: SnapshotId): void {}
  getSnapshotCount(): number { return 0; }
  clearSnapshots(): void {}
  setSnapshotBudget(_b: number): void {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContainer(): StubElement {
  return new StubElement("div");
}

/** Collect all textContent values in the dialog. */
function allTextContent(dialog: StubElement): string[] {
  const texts: string[] = [];
  function walk(el: StubElement): void {
    if (el.textContent !== null && el.textContent !== "") {
      texts.push(el.textContent);
    }
    for (const child of el.children) walk(child);
  }
  walk(dialog);
  return texts;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SingleValueDialog (Task 7.2.4)", () => {
  let container: StubElement;
  let dialog: SingleValueDialog;

  beforeEach(() => {
    container = makeContainer();
    dialog = new SingleValueDialog(container as unknown as HTMLElement);
  });

  describe("displayFormats", () => {
    it("shows binary, unsigned decimal, signed decimal, and hex for 0xFF 8-bit", () => {
      const value = BitVector.fromNumber(0xFF, 8);
      dialog.open(value, 0, null);

      const dlgEl = dialog.getDialogElement() as unknown as StubElement;
      expect(dlgEl).not.toBeNull();

      const texts = allTextContent(dlgEl);

      // binary: "0b" prefix from BitVector.toString("bin"), strip prefix for display
      // BitVector.toString("bin") returns "0b11111111"
      // The dialog shows the raw toString output for bin row
      expect(texts.some((t) => t.includes("11111111"))).toBe(true);

      // unsigned decimal: 255
      expect(texts.some((t) => t === "255")).toBe(true);

      // signed decimal: -1 (0xFF as 8-bit signed)
      expect(texts.some((t) => t === "-1")).toBe(true);

      // hex: "FF" (dialog strips the "0x" prefix from BitVector.toString("hex"))
      expect(texts.some((t) => t === "FF")).toBe(true);
    });

    it("dialog is open after calling open()", () => {
      const value = BitVector.fromNumber(0x42, 8);
      expect(dialog.isOpen()).toBe(false);
      dialog.open(value, 1, null);
      expect(dialog.isOpen()).toBe(true);
    });

    it("dialog is closed after calling close()", () => {
      dialog.open(BitVector.fromNumber(0, 8), 0, null);
      dialog.close();
      expect(dialog.isOpen()).toBe(false);
    });
  });

  describe("highZ", () => {
    it("shows High-Z indication for a fully HIGH_Z BitVector", () => {
      const value = BitVector.allHighZ(8);
      dialog.open(value, 0, null);

      const dlgEl = dialog.getDialogElement() as unknown as StubElement;
      expect(dlgEl).not.toBeNull();

      const texts = allTextContent(dlgEl);
      expect(texts.some((t) => t === "High-Z")).toBe(true);
    });

    it("does not show binary/decimal/hex rows for HIGH_Z value", () => {
      const value = BitVector.allHighZ(8);
      dialog.open(value, 0, null);

      const dlgEl = dialog.getDialogElement() as unknown as StubElement;
      const binRows = (dlgEl as StubElement).querySelectorAll(".value-dialog-bin");
      expect(binRows.length).toBe(0);
    });

    it("shows highz element with correct class", () => {
      const value = BitVector.allHighZ(4);
      dialog.open(value, 0, null);

      const dlgEl = dialog.getDialogElement() as unknown as StubElement;
      const highZEl = dlgEl.querySelector(".value-dialog-highz");
      expect(highZEl).not.toBeNull();
      expect((highZEl as StubElement).textContent).toBe("High-Z");
    });
  });

  describe("override", () => {
    it("calls engine.setSignalValue with correct value when override input fires Enter", () => {
      const engine = new MockEngine();
      const value = BitVector.fromNumber(0x00, 8);
      dialog.open(value, 5, engine as unknown as SimulationEngine);

      const inputEl = dialog.getOverrideInput() as unknown as StubElement;
      expect(inputEl).not.toBeNull();

      // Simulate user typing "0x42" and pressing Enter
      (inputEl as unknown as { value: string }).value = "0x42";
      inputEl.dispatchEvent({ type: "keydown", key: "Enter" });

      expect(engine.setSignalCalls.length).toBe(1);
      expect(engine.setSignalCalls[0].netId).toBe(5);

      // The value should be 0x42 = 66
      const bv = engine.setSignalCalls[0].value;
      expect(bv.toString("hex")).toBe("0x42");
    });

    it("does not call setSignalValue for invalid hex input", () => {
      const engine = new MockEngine();
      dialog.open(BitVector.fromNumber(0, 8), 0, engine as unknown as SimulationEngine);

      const inputEl = dialog.getOverrideInput() as unknown as StubElement;
      (inputEl as unknown as { value: string }).value = "xyz";
      inputEl.dispatchEvent({ type: "keydown", key: "Enter" });

      expect(engine.setSignalCalls.length).toBe(0);
    });

    it("closes dialog after successful override", () => {
      const engine = new MockEngine();
      dialog.open(BitVector.fromNumber(0, 8), 0, engine as unknown as SimulationEngine);
      expect(dialog.isOpen()).toBe(true);

      const inputEl = dialog.getOverrideInput() as unknown as StubElement;
      (inputEl as unknown as { value: string }).value = "0x10";
      inputEl.dispatchEvent({ type: "keydown", key: "Enter" });

      expect(dialog.isOpen()).toBe(false);
    });

    it("override input exists when engine is provided", () => {
      const engine = new MockEngine();
      dialog.open(BitVector.fromNumber(0xFF, 8), 3, engine as unknown as SimulationEngine);

      const inputEl = dialog.getOverrideInput();
      expect(inputEl).not.toBeNull();
    });
  });

  describe("bitWidth", () => {
    it("shows '16 bits' for a 16-bit signal", () => {
      const value = BitVector.fromNumber(0x1234, 16);
      dialog.open(value, 0, null);

      const dlgEl = dialog.getDialogElement() as unknown as StubElement;
      const texts = allTextContent(dlgEl);
      expect(texts.some((t) => t === "16 bits")).toBe(true);
    });

    it("shows '8 bits' for an 8-bit signal", () => {
      const value = BitVector.fromNumber(0xAB, 8);
      dialog.open(value, 0, null);

      const dlgEl = dialog.getDialogElement() as unknown as StubElement;
      const texts = allTextContent(dlgEl);
      expect(texts.some((t) => t === "8 bits")).toBe(true);
    });

    it("shows '1 bits' for a 1-bit signal", () => {
      const value = BitVector.fromNumber(1, 1);
      dialog.open(value, 0, null);

      const dlgEl = dialog.getDialogElement() as unknown as StubElement;
      const texts = allTextContent(dlgEl);
      expect(texts.some((t) => t === "1 bits")).toBe(true);
    });

    it("shows width row with correct class", () => {
      const value = BitVector.fromNumber(0, 32);
      dialog.open(value, 0, null);

      const dlgEl = dialog.getDialogElement() as unknown as StubElement;
      const widthEl = dlgEl.querySelector(".value-dialog-width");
      expect(widthEl).not.toBeNull();
      expect((widthEl as StubElement).textContent).toBe("32 bits");
    });
  });
});
