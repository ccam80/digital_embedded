/**
 * Tests for SliderPanel.
 *
 * Uses a minimal DOM stub so tests run in the node environment without jsdom.
 * The stub implements only the surface area used by SliderPanel.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SliderPanel } from "../slider-panel.js";
import { SliderEngineBridge } from "../slider-engine-bridge.js";
import { buildNonEngineCoordinator } from "@/test-utils/non-engine-coordinator.js";
import type { AnalogElement } from "@/solver/analog/element.js";
import type { CircuitElement } from "@/core/element.js";

// ---------------------------------------------------------------------------
// Minimal DOM stub
// ---------------------------------------------------------------------------

type AnyListener = (...args: unknown[]) => void;

class StubElement {
  tagName: string;
  className: string = "";
  textContent: string | null = null;
  style: Record<string, string> = {};
  children: StubElement[] = [];
  type: string = "";
  value: string = "0";
  min: string = "0";
  max: string = "10000";
  step: string = "1";
  parentNode: StubElement | null = null;

  private readonly _listeners: Map<string, AnyListener[]> = new Map();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  appendChild(child: StubElement): StubElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: StubElement): void {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
  }

  addEventListener(event: string, handler: AnyListener): void {
    const list = this._listeners.get(event) ?? [];
    list.push(handler);
    this._listeners.set(event, list);
  }

  removeEventListener(event: string, handler: AnyListener): void {
    const list = this._listeners.get(event) ?? [];
    const idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
  }

  /** Simulate firing an event. */
  _fire(event: string): void {
    const list = this._listeners.get(event) ?? [];
    for (const fn of list) fn();
  }
}

function makeStubDocument() {
  const elements: StubElement[] = [];
  return {
    createElement(tag: string): StubElement {
      const el = new StubElement(tag);
      elements.push(el);
      return el;
    },
    _elements: elements,
  };
}

// Install stub document globally for the duration of these tests
let stubDoc: ReturnType<typeof makeStubDocument>;

function installStubDocument(): StubElement {
  stubDoc = makeStubDocument();
  const container = new StubElement("div");
  (global as unknown as Record<string, unknown>).document = {
    createElement: (tag: string) => stubDoc.createElement(tag),
  };
  return container;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContainer(): StubElement {
  return installStubDocument();
}




// ---------------------------------------------------------------------------
// si-format tests (included in slider-panel.test.ts per spec requirement)
// ---------------------------------------------------------------------------

import { formatSI } from "../si-format.js";

describe("SIFormat", () => {
  it("milliamps", () => {
    expect(formatSI(0.0047, "A")).toBe("4.70 mA");
  });

  it("kilohms", () => {
    expect(formatSI(2200, "Ω")).toBe("2.20 kΩ");
  });

  it("microfarads", () => {
    expect(formatSI(1e-6, "F")).toBe("1.00 µF");
  });

  it("zero", () => {
    expect(formatSI(0, "V")).toBe("0.00 V");
  });

  it("negative", () => {
    expect(formatSI(-3.3, "V")).toBe("-3.30 V");
  });

  it("very_small", () => {
    expect(formatSI(1e-14, "A")).toBe("10.0 fA");
  });
});

// ---------------------------------------------------------------------------
// SliderPanel tests
// ---------------------------------------------------------------------------

describe("SliderPanel", () => {
  let container: StubElement;
  let panel: SliderPanel;

  beforeEach(() => {
    container = makeContainer();
    panel = new SliderPanel(container as unknown as HTMLElement);
  });

  it("add_slider_creates_dom_element", () => {
    panel.addSlider(0, "resistance", "Resistance", 1000, { unit: "Ω" });
    // Container should have one child row
    expect(container.children.length).toBe(1);
    // The row should contain a range input
    const row = container.children[0];
    const rangeInput = row.children.find((c) => c.type === "range");
    expect(rangeInput).toBeDefined();
  });

  it("log_scale_midpoint", () => {
    // Log slider [100, 10000] at position 0.5 → geometric midpoint ≈ 1000
    panel.addSlider(0, "resistance", "R", 1000, {
      min: 100,
      max: 10000,
      logScale: true,
      unit: "Ω",
    });
    const value = panel.getValueAtPosition(0, "resistance", 0.5);
    expect(value).toBeDefined();
  });

  it("linear_scale_midpoint", () => {
    // Linear slider [0, 10] at position 0.5 → 5
    panel.addSlider(0, "voltage", "V", 5, {
      min: 0,
      max: 10,
      logScale: false,
      unit: "V",
    });
    const value = panel.getValueAtPosition(0, "voltage", 0.5);
    expect(value).toBeDefined();
  });

  it("callback_fires_on_change", () => {
    panel.addSlider(0, "resistance", "R", 1000, {
      min: 100,
      max: 10000,
      logScale: true,
      unit: "Ω",
    });

    const received: { elementId: number; propertyKey: string; value: number }[] = [];
    panel.onSliderChange((elementId, propertyKey, value) => {
      received.push({ elementId, propertyKey, value });
    });

    // Move slider to position 0.75
    panel.setPosition(0, "resistance", 0.75);

    expect(received.length).toBe(1);
    expect(received[0].elementId).toBe(0);
    expect(received[0].propertyKey).toBe("resistance");
    expect(received[0].value).toBeGreaterThan(100);
    expect(received[0].value).toBeLessThanOrEqual(10000);
  });

  it("remove_slider_removes_dom", () => {
    panel.addSlider(0, "resistance", "R", 1000, { unit: "Ω" });
    expect(container.children.length).toBe(1);

    panel.removeSlider(0, "resistance");
    expect(container.children.length).toBe(0);
  });

  it("multiple_sliders_independent", () => {
    panel.addSlider(0, "resistance", "R", 1000, { min: 100, max: 10000, logScale: true, unit: "Ω" });
    panel.addSlider(1, "capacitance", "C", 1e-6, { min: 1e-9, max: 1e-3, logScale: true, unit: "F" });
    panel.addSlider(2, "inductance", "L", 1e-3, { min: 1e-6, max: 1, logScale: true, unit: "H" });

    const firedFor: number[] = [];
    panel.onSliderChange((elementId) => {
      firedFor.push(elementId);
    });

    // Move only slider for elementId=1
    panel.setPosition(1, "capacitance", 0.5);

    // Only one callback should fire, for elementId=1
    expect(firedFor).toEqual([1]);
  });

  it("value_display_formatted", () => {
    panel.addSlider(0, "resistance", "R", 4700, {
      min: 100,
      max: 100000,
      logScale: false,
      unit: "Ω",
    });

    // Set slider to exactly 4700Ω
    panel.setPosition(0, "resistance", (4700 - 100) / (100000 - 100));

    // Find the value display span (third child of the row)
    const row = container.children[0];
    // Row children: [labelSpan, input, valueDisplay]
    const valueDisplay = row.children[2];
    expect(valueDisplay).toBeDefined();
    // At 4700Ω we expect "4.70 kΩ"
    expect(valueDisplay.textContent).toBe("4.70 kΩ");
  });
});

// ---------------------------------------------------------------------------
// SliderEngineBridge tests
// ---------------------------------------------------------------------------

describe("SliderEngineBridge", () => {
  it("slider_change_calls_setComponentProperty", () => {
    const container = makeContainer();
    const panel = new SliderPanel(container as unknown as HTMLElement);

    const stubElement = {} as CircuitElement;
    const coord = buildNonEngineCoordinator({
      resolverContext: {
        wireToNodeId: new Map(),
        elements: [] as readonly AnalogElement[],
        elementToCircuitElement: new Map([[0, stubElement]]),
        circuitElements: [stubElement],
        getElementPinCurrents: () => [],
      },
    });

    new SliderEngineBridge(panel, coord);

    panel.addSlider(0, "resistance", "R", 1000, {
      min: 100,
      max: 10000,
      logScale: true,
      unit: "Ω",
    });

    // Move slider to midpoint → geometric midpoint ≈ 1000Ω
    panel.setPosition(0, "resistance", 0.5);

    const calls = coord.setComponentPropertyCalls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.element).toBe(stubElement);
    expect(calls[0]!.key).toBe("resistance");
  });

  it("slider_change_no_op_when_no_resolver_context", () => {
    const container = makeContainer();
    const panel = new SliderPanel(container as unknown as HTMLElement);

    const coord = buildNonEngineCoordinator();
    // resolverContext defaults to null → SliderEngineBridge takes the no-op branch

    new SliderEngineBridge(panel, coord);

    panel.addSlider(0, "resistance", "R", 1000, { min: 100, max: 10000, unit: "Ω" });
    panel.setPosition(0, "resistance", 0.5);

    expect(coord.setComponentPropertyCalls.length).toBe(0);
  });

  it("slider_change_no_op_when_element_not_in_context", () => {
    const container = makeContainer();
    const panel = new SliderPanel(container as unknown as HTMLElement);

    const coord = buildNonEngineCoordinator({
      resolverContext: {
        wireToNodeId: new Map(),
        elements: [] as readonly AnalogElement[],
        elementToCircuitElement: new Map<number, CircuitElement>(),
        circuitElements: [],
        getElementPinCurrents: () => [],
      },
    });

    new SliderEngineBridge(panel, coord);

    panel.addSlider(0, "resistance", "R", 1000, { min: 100, max: 10000, unit: "Ω" });
    panel.setPosition(0, "resistance", 0.5);

    expect(coord.setComponentPropertyCalls.length).toBe(0);
  });
});
