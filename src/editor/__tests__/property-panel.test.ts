/**
 * Tests for PropertyPanel and property input widgets.
 *
 * Uses a minimal DOM stub so tests run in node environment without jsdom.
 * The stub implements only the surface area used by PropertyPanel and createInput.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { PropertyType, PropertyBag } from "@/core/properties";
import type { PropertyDefinition } from "@/core/properties";
import type { ComponentDefinition } from "@/core/registry";
import { ComponentCategory } from "@/core/registry";

// ---------------------------------------------------------------------------
// Minimal DOM stub
// ---------------------------------------------------------------------------

type EventListener = (event: { target: StubElement }) => void;

class StubElement {
  tagName: string;
  className: string = "";
  textContent: string = "";
  title: string = "";
  innerHTML: string = "";
  style: Record<string, string> = {};
  children: StubElement[] = [];
  dataset: Record<string, string> = {};
  type: string = "";
  value: string = "";
  checked: boolean = false;
  min: string = "";
  max: string = "";
  rows: number = 2;
  placeholder: string = "";
  readonly options: StubElement[] = [];

  private readonly _listeners: Map<string, EventListener[]> = new Map();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  appendChild(child: StubElement): StubElement {
    this.children.push(child);
    return child;
  }

  removeChild(child: StubElement): void {
    const idx = this.children.indexOf(child);
    if (idx !== -1) this.children.splice(idx, 1);
  }

  setAttribute(_name: string, _value: string): void {}

  addEventListener(event: string, cb: EventListener): void {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(cb);
  }

  /** Simulate a DOM event — fires all registered listeners for the event. */
  dispatchEvent(event: string): void {
    for (const cb of this._listeners.get(event) ?? []) {
      cb({ target: this });
    }
  }

  get lastChild(): StubElement | undefined {
    return this.children[this.children.length - 1];
  }
}

// ---------------------------------------------------------------------------
// Install stub document globally before importing modules under test
// ---------------------------------------------------------------------------

const stubDocument = {
  createElement(tagName: string): StubElement {
    return new StubElement(tagName);
  },
};

// Override the global document so property-inputs.ts and property-panel.ts
// get our stub when they call document.createElement().
(globalThis as Record<string, unknown>)["document"] = stubDocument;

// ---------------------------------------------------------------------------
// Import modules AFTER installing stub (dynamic import resolves after setup)
// ---------------------------------------------------------------------------

import { createInput, NumberInput, EnumSelect } from "../property-inputs.js";
import { PropertyPanel } from "../property-panel.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBag(
  defs: PropertyDefinition[],
): PropertyBag {
  const bag = new PropertyBag();
  for (const def of defs) {
    bag.set(def.key, def.defaultValue);
  }
  return bag;
}

/** Minimal CircuitElement stub for PropertyPanel tests. */
function makeElement(defs: PropertyDefinition[]) {
  const bag = makeBag(defs);
  return {
    typeId: "Stub",
    instanceId: "stub-1",
    position: { x: 0, y: 0 },
    rotation: 0 as const,
    mirror: false,
    getPins: () => [],
    getProperties: () => bag,
    draw: () => {},
    getBoundingBox: () => ({ x: 0, y: 0, width: 2, height: 2 }),
    serialize: () => ({
      typeId: "Stub",
      instanceId: "stub-1",
      position: { x: 0, y: 0 },
      rotation: 0 as const,
      mirror: false,
      properties: {},
    }),
    getHelpText: () => "",
    getAttribute: (name: string) =>
      bag.has(name) ? bag.get(name) : undefined,
  };
}

function makeContainer(): StubElement {
  return new StubElement("div");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PropertyPanel", () => {
  let container: StubElement;
  let panel: PropertyPanel;

  beforeEach(() => {
    container = makeContainer();
    panel = new PropertyPanel(container as unknown as HTMLElement);
  });

  it("showsAllProperties", () => {
    const defs: PropertyDefinition[] = [
      { key: "a", type: PropertyType.INT, label: "A", defaultValue: 1 },
      { key: "b", type: PropertyType.STRING, label: "B", defaultValue: "x" },
      {
        key: "c",
        type: PropertyType.BOOLEAN,
        label: "C",
        defaultValue: false,
      },
    ];
    const el = makeElement(defs);
    panel.showProperties(el as any, defs);

    expect(panel.getInputCount()).toBe(3);
    expect(container.children).toHaveLength(3);
  });

  it("numberInputRespectsMinMax", () => {
    const def: PropertyDefinition = {
      key: "bits",
      type: PropertyType.INT,
      label: "Bits",
      defaultValue: 4,
      min: 1,
      max: 8,
    };

    const input = createInput(def, 4) as NumberInput;
    const el = input.element as unknown as StubElement;

    // Find the actual <input> child
    const innerInput = el.children[0] as StubElement;
    expect(innerInput.min).toBe("1");
    expect(innerInput.max).toBe("8");

    // Set value above max and trigger change event
    innerInput.value = "100";
    innerInput.dispatchEvent("change");

    // Value should be clamped to max
    expect(input.getValue()).toBe(8);
  });

  it("enumInputShowsOptions", () => {
    const def: PropertyDefinition = {
      key: "mode",
      type: PropertyType.ENUM,
      label: "Mode",
      defaultValue: "A",
      enumValues: ["A", "B", "C"],
    };

    const input = createInput(def, "A") as EnumSelect;
    const el = input.element as unknown as StubElement;

    // Find the <select> child
    const select = el.children[0] as StubElement;
    expect(select.children).toHaveLength(3);
    expect(select.children[0]!.value).toBe("A");
    expect(select.children[1]!.value).toBe("B");
    expect(select.children[2]!.value).toBe("C");
  });

  it("changeFiresCallback", () => {
    const def: PropertyDefinition = {
      key: "label",
      type: PropertyType.STRING,
      label: "Label",
      defaultValue: "old",
    };

    const el = makeElement([def]);
    panel.showProperties(el as any, [def]);

    const onChange = vi.fn();
    panel.onPropertyChange(onChange);

    const input = panel.getInput("label")!;
    const inputEl = input.element as unknown as StubElement;
    const innerInput = inputEl.children[0] as StubElement;

    innerInput.value = "new";
    innerInput.dispatchEvent("change");

    expect(onChange).toHaveBeenCalledOnce();
    const [key, oldVal, newVal] = onChange.mock.calls[0]!;
    expect(key).toBe("label");
    expect(oldVal).toBe("old");
    expect(newVal).toBe("new");
  });

  it("clearEmptiesPanel", () => {
    const defs: PropertyDefinition[] = [
      { key: "a", type: PropertyType.INT, label: "A", defaultValue: 1 },
      { key: "b", type: PropertyType.INT, label: "B", defaultValue: 2 },
    ];
    const el = makeElement(defs);
    panel.showProperties(el as any, defs);

    expect(panel.getInputCount()).toBe(2);

    panel.clear();

    expect(panel.getInputCount()).toBe(0);
    // Container innerHTML cleared means no children remain
    expect(container.innerHTML).toBe("");
  });

  it("collapseHidesPanel", () => {
    expect(panel.isCollapsed()).toBe(false);

    panel.setCollapsed(true);

    expect(panel.isCollapsed()).toBe(true);
    expect(container.style["display"]).toBe("none");

    panel.setCollapsed(false);

    expect(panel.isCollapsed()).toBe(false);
    expect(container.style["display"]).toBe("");
  });

  // ---------------------------------------------------------------------------
  // showSimulationModeDropdown tests
  // ---------------------------------------------------------------------------

  it("simulationModelDropdown_multiModelShowsDropdown — multi-model component adds simulationModel row", () => {
    const def: ComponentDefinition = {
      name: "BehavioralAnd",
      typeId: -1,
      factory: () => { throw new Error("stub"); },
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.LOGIC,
      helpText: "",
      models: {
        digital: { executeFn: () => {} },
        analog: { factory: () => ({ pinNodeIds: [], allNodeIds: [], branchIndex: -1, isNonlinear: false, isReactive: false, stamp: () => {}, getPinCurrents: () => [] }) },
      },
    };
    const el = makeElement([]);
    panel.showProperties(el as any, []);
    const countBefore = container.children.length;

    panel.showSimulationModeDropdown(el as any, def as any);

    // One new row should be added
    expect(container.children.length).toBe(countBefore + 1);
    // simulationModel input should be registered
    const input = panel.getInput("simulationModel");
    expect(input).toBeDefined();
    // Initial value should default to "digital" (first available model when no defaultModel set)
    expect(input!.getValue()).toBe("digital");
  });

  it("simulationModelDropdown_singleModelNoDropdown — single-model component does not add dropdown", () => {
    const def: ComponentDefinition = {
      name: "And",
      typeId: -1,
      factory: () => { throw new Error("stub"); },
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.LOGIC,
      helpText: "",
      models: {
        digital: { executeFn: () => {} },
      },
    };
    const el = makeElement([]);
    panel.showProperties(el as any, []);
    const countBefore = container.children.length;

    panel.showSimulationModeDropdown(el as any, def as any);

    // No row added for single-model component
    expect(container.children.length).toBe(countBefore);
    expect(panel.getInput("simulationModel")).toBeUndefined();
  });

  it("simulationModelDropdown_usesDefaultModel — uses def.defaultModel as initial value when no bag entry", () => {
    const def: ComponentDefinition = {
      name: "BehavioralAnd",
      typeId: -1,
      factory: () => { throw new Error("stub"); },
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.LOGIC,
      helpText: "",
      defaultModel: "analog",
      models: {
        digital: { executeFn: () => {} },
        analog: { factory: () => ({ pinNodeIds: [], allNodeIds: [], branchIndex: -1, isNonlinear: false, isReactive: false, stamp: () => {}, getPinCurrents: () => [] }) },
      },
    };
    const el = makeElement([]);
    panel.showProperties(el as any, []);
    panel.showSimulationModeDropdown(el as any, def as any);

    const input = panel.getInput("simulationModel")!;
    expect(input).toBeDefined();
    // Default should be "analog" per def.defaultModel
    expect(input.getValue()).toBe("analog");
  });

  it("simulationModelDropdown_changeUpdatesBagAndFiresCallback — changing dropdown updates PropertyBag and fires callback", () => {
    const def: ComponentDefinition = {
      name: "BehavioralAnd",
      typeId: -1,
      factory: () => { throw new Error("stub"); },
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.LOGIC,
      helpText: "",
      models: {
        digital: { executeFn: () => {} },
        analog: { factory: () => ({ pinNodeIds: [], allNodeIds: [], branchIndex: -1, isNonlinear: false, isReactive: false, stamp: () => {}, getPinCurrents: () => [] }) },
      },
    };
    const el = makeElement([]);
    panel.showProperties(el as any, []);
    panel.showSimulationModeDropdown(el as any, def as any);

    const onChange = vi.fn();
    panel.onPropertyChange(onChange);

    // Find the select element in the dropdown row and trigger change
    const dropdownRow = container.children[container.children.length - 1] as StubElement;
    const select = dropdownRow.children[1] as StubElement;
    select.value = "analog";
    select.dispatchEvent("change");

    // Callback should have fired
    expect(onChange).toHaveBeenCalledOnce();
    const [key, , newVal] = onChange.mock.calls[0]!;
    expect(key).toBe("simulationModel");
    expect(newVal).toBe("analog");

    // PropertyBag should be updated
    const bag = el.getProperties();
    expect(bag.get("simulationModel")).toBe("analog");
  });

  it("simulationModelDropdown_existingBagValueUsedAsDefault — bag value takes precedence over def.defaultModel", () => {
    const def: ComponentDefinition = {
      name: "BehavioralAnd",
      typeId: -1,
      factory: () => { throw new Error("stub"); },
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.LOGIC,
      helpText: "",
      defaultModel: "digital",
      models: {
        digital: { executeFn: () => {} },
        analog: { factory: () => ({ pinNodeIds: [], allNodeIds: [], branchIndex: -1, isNonlinear: false, isReactive: false, stamp: () => {}, getPinCurrents: () => [] }) },
      },
    };
    // Pre-set bag with "analog"
    const el = makeElement([]);
    el.getProperties().set("simulationModel", "analog");
    panel.showProperties(el as any, []);
    panel.showSimulationModeDropdown(el as any, def as any);

    const input = panel.getInput("simulationModel")!;
    expect(input).toBeDefined();
    // Bag value "analog" should override defaultModel "digital"
    expect(input.getValue()).toBe("analog");
  });
});
