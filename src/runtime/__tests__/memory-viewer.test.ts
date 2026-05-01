/**
 * Tests for MemoryEditorDialog live update capability- Task 7.2.2.
 *
 * Uses a minimal DOM stub (shared with memory-editor.test.ts) and a mock
 * SimulationEngine to verify live update behaviour.
 *
 * Covers:
 *   - liveUpdate: enable live, step engine, verify displayed values refreshed
 *   - changedHighlight: step engine (value at 0x10 changes), verify address 0x10 has highlight
 *   - pauseLive: disable live update, step engine, verify display NOT updated
 */

import { describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Minimal DOM stub
// ---------------------------------------------------------------------------

class StubClassList {
  readonly _classes: Set<string> = new Set();

  add(...tokens: string[]): void {
    for (const t of tokens) this._classes.add(t);
  }

  remove(...tokens: string[]): void {
    for (const t of tokens) this._classes.delete(t);
  }

  contains(token: string): boolean {
    return this._classes.has(token);
  }
}

type AnyListener = (...args: unknown[]) => void;

class StubElement {
  tagName: string;
  private _className: string = "";
  textContent: string | null = "";
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  type: string = "";
  value: string = "";
  maxLength: number = 0;
  readonly classList: StubClassList = new StubClassList();
  readonly children: StubElement[] = [];
  parentElement: StubElement | null = null;

  get className(): string {
    return this._className;
  }

  set className(value: string) {
    this._className = value;
    (this.classList as unknown as { _classes: Set<string> })._classes.clear();
    for (const t of value.split(/\s+/).filter((s) => s.length > 0)) {
      this.classList.add(t);
    }
  }

  set innerHTML(_value: string) {
    this.children.length = 0;
  }

  get innerHTML(): string {
    return "";
  }

  private readonly _listeners: Map<string, AnyListener[]> = new Map();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  appendChild(child: StubElement): StubElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  replaceWith(_replacement: StubElement): void {}

  setAttribute(_name: string, _value: string): void {}

  addEventListener(event: string, cb: AnyListener): void {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(cb);
  }

  removeEventListener(_event: string, _cb: AnyListener): void {}

  focus(): void {}
  select(): void {}

  querySelectorAll(selector: string): StubElement[] {
    const results: StubElement[] = [];
    this._collectMatching(selector.trim(), results);
    return results;
  }

  querySelector(selector: string): StubElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  private _matchesSimple(selector: string): boolean {
    const dotIdx = selector.indexOf(".");
    if (dotIdx === -1) {
      return this.tagName.toLowerCase() === selector.toLowerCase();
    }
    const tagPart = selector.slice(0, dotIdx);
    const classPart = selector.slice(dotIdx + 1);
    const tagMatch = tagPart === "" || this.tagName.toLowerCase() === tagPart.toLowerCase();
    return tagMatch && this.classList.contains(classPart);
  }

  private _collectMatching(selector: string, results: StubElement[]): void {
    for (const child of this.children) {
      if (child._matchesSimple(selector)) results.push(child);
      child._collectMatching(selector, results);
    }
  }
}

const stubDocument = {
  body: new StubElement("body"),
  createElement(tagName: string): StubElement {
    return new StubElement(tagName);
  },
};

(globalThis as Record<string, unknown>)["document"] = stubDocument;

// ---------------------------------------------------------------------------
// Import modules AFTER installing stub
// ---------------------------------------------------------------------------

import { DataField } from "../../components/memory/ram.js";
import { MemoryEditorDialog } from "../memory-editor.js";
import type { MeasurementObserver, SimulationEngine, BitVector, CompiledCircuit, EngineState, EngineChangeListener, SnapshotId } from "../../core/engine-interface.js";

// ---------------------------------------------------------------------------
// Mock SimulationEngine
// ---------------------------------------------------------------------------

class MockEngine implements SimulationEngine {
  private readonly _measurementObservers: MeasurementObserver[] = [];
  private _stepCount: number = 0;

  /** Simulate a single step- notifies all registered measurement observers. */
  simulateStep(): void {
    this._stepCount++;
    for (const obs of this._measurementObservers) {
      obs.onStep(this._stepCount);
    }
  }

  /** Simulate an engine reset- notifies all registered observers. */
  simulateReset(): void {
    for (const obs of this._measurementObservers) {
      obs.onReset();
    }
  }

  addMeasurementObserver(observer: MeasurementObserver): void {
    this._measurementObservers.push(observer);
  }

  removeMeasurementObserver(observer: MeasurementObserver): void {
    const idx = this._measurementObservers.indexOf(observer);
    if (idx !== -1) this._measurementObservers.splice(idx, 1);
  }

  getObserverCount(): number {
    return this._measurementObservers.length;
  }

  // Unused SimulationEngine methods- minimal stubs
  init(_circuit: CompiledCircuit): void {}
  reset(): void {}
  dispose(): void {}
  step(): void {}
  microStep(): void {}
  runToBreak(): void {}
  start(): void {}
  stop(): void {}
  getState(): EngineState { return "STOPPED" as EngineState; }
  getSignalRaw(_netId: number): number { return 0; }
  getSignalValue(_netId: number): BitVector { return null as unknown as BitVector; }
  setSignalValue(_netId: number, _value: BitVector): void {}
  addChangeListener(_listener: EngineChangeListener): void {}
  removeChangeListener(_listener: EngineChangeListener): void {}
  saveSnapshot(): SnapshotId { return 0; }
  restoreSnapshot(_id: SnapshotId): void {}
  getSnapshotCount(): number { return 0; }
  clearSnapshots(): void {}
  setSnapshotBudget(_bytes: number): void {}
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeContainer(): StubElement {
  return new StubElement("div");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryEditorDialog live update (Task 7.2.2)", () => {
  let container: StubElement;
  let df: DataField;
  let editor: MemoryEditorDialog;
  let engine: MockEngine;

  beforeEach(() => {
    container = makeContainer();
    df = new DataField(256);
    editor = new MemoryEditorDialog(df as DataField, container as unknown as HTMLElement);
    engine = new MockEngine();
    editor.render();
  });

  describe("liveUpdate", () => {
    it("enabling live update registers as measurement observer on engine", () => {
      expect(engine.getObserverCount()).toBe(0);
      editor.enableLiveUpdate(engine as unknown as SimulationEngine);
      expect(engine.getObserverCount()).toBe(1);
    });

    it("displayed values refresh after engine step when live update is active", () => {
      // Write initial value
      df.write(0, 0x11);
      editor.render();

      // Enable live and confirm initial cell value
      editor.enableLiveUpdate(engine as unknown as SimulationEngine);

      // Change DataField and step engine- editor should refresh
      df.write(0, 0xAA);
      engine.simulateStep();

      // Cell at address 0 should now display "AA"
      const cellEl = editor.getCellElement(0);
      expect(cellEl).not.toBeNull();
      if (cellEl !== null) {
        expect((cellEl as unknown as StubElement).textContent).toBe("AA");
      }
    });

    it("live update is active after enableLiveUpdate", () => {
      expect(editor.isLiveUpdateActive()).toBe(false);
      editor.enableLiveUpdate(engine as unknown as SimulationEngine);
      expect(editor.isLiveUpdateActive()).toBe(true);
    });

    it("calling enableLiveUpdate twice does not register observer twice", () => {
      editor.enableLiveUpdate(engine as unknown as SimulationEngine);
      editor.enableLiveUpdate(engine as unknown as SimulationEngine);
      expect(engine.getObserverCount()).toBe(1);
    });
  });

  describe("changedHighlight", () => {
    it("address 0x10 cell gets hex-changed class when value changes during live step", () => {
      // Write initial value and render
      df.write(0x10, 0x00);
      editor.render();

      // The address 0x10 is in row 1 (addresses 0x10-0x1F); scroll so it's visible
      editor.goToAddress(0x10);

      editor.enableLiveUpdate(engine as unknown as SimulationEngine);

      // Trigger one step so the editor captures the initial prevValues
      engine.simulateStep();

      // Change value at 0x10 and step again- this should trigger highlight
      df.write(0x10, 0xFF);
      engine.simulateStep();

      const cellEl = editor.getCellElement(0x10);
      expect(cellEl).not.toBeNull();
      if (cellEl !== null) {
        const stubCell = cellEl as unknown as StubElement;
        expect(stubCell.classList.contains("hex-changed")).toBe(true);
      }
    });

    it("unchanged addresses do not get hex-changed class", () => {
      df.write(0x10, 0xAB);
      df.write(0x11, 0xCD);
      editor.goToAddress(0x10);

      editor.enableLiveUpdate(engine as unknown as SimulationEngine);
      engine.simulateStep(); // capture initial

      // Change only 0x10, not 0x11
      df.write(0x10, 0xFF);
      engine.simulateStep();

      const cell11 = editor.getCellElement(0x11);
      if (cell11 !== null) {
        expect((cell11 as unknown as StubElement).classList.contains("hex-changed")).toBe(false);
      }
    });
  });

  describe("pauseLive", () => {
    it("disabling live update removes observer from engine", () => {
      editor.enableLiveUpdate(engine as unknown as SimulationEngine);
      expect(engine.getObserverCount()).toBe(1);

      editor.disableLiveUpdate();
      expect(engine.getObserverCount()).toBe(0);
    });

    it("display is NOT updated after disableLiveUpdate when engine steps", () => {
      df.write(0, 0x11);
      editor.render();

      editor.enableLiveUpdate(engine as unknown as SimulationEngine);
      engine.simulateStep(); // step once while live

      // Disable live update
      editor.disableLiveUpdate();
      expect(editor.isLiveUpdateActive()).toBe(false);

      // Change DataField and step- display should NOT update
      df.write(0, 0xBB);
      engine.simulateStep();

      // Cell at address 0 should still show last live-refreshed value (0x11), not 0xBB
      const cellEl = editor.getCellElement(0);
      if (cellEl !== null) {
        expect((cellEl as unknown as StubElement).textContent).toBe("11");
      }
    });

    it("isLiveUpdateActive returns false after disableLiveUpdate", () => {
      editor.enableLiveUpdate(engine as unknown as SimulationEngine);
      editor.disableLiveUpdate();
      expect(editor.isLiveUpdateActive()).toBe(false);
    });
  });
});
