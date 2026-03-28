/**
 * Tests for PropertyPanel.showSpiceModelParameters().
 *
 * Uses a minimal DOM stub (no jsdom) to verify:
 * - Section renders for components with a known deviceType
 * - Section is absent when deviceType is missing
 * - Stored overrides populate input values
 * - Placeholder shows default value for unset fields
 * - Committing an input writes to _spiceModelOverrides JSON
 * - Clearing an input deletes the key from overrides
 * - Fires change callbacks on commit
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PropertyPanel } from "../property-panel.js";
import { PropertyBag } from "@/core/properties.js";
import type { CircuitElement } from "@/core/element.js";
import type { ComponentDefinition } from "@/core/registry.js";

// ---------------------------------------------------------------------------
// Minimal DOM stub
// ---------------------------------------------------------------------------

type AnyListener = (...args: unknown[]) => void;

class StubElement {
  tagName: string;
  className: string = "";
  textContent: string | null = null;
  placeholder: string = "";
  value: string = "";
  type: string = "";
  title: string = "";
  style: Record<string, string> = {};
  children: StubElement[] = [];
  innerHTML: string = "";

  private readonly _listeners: Map<string, AnyListener[]> = new Map();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  appendChild(child: StubElement): StubElement {
    this.children.push(child);
    return child;
  }

  addEventListener(event: string, listener: AnyListener): void {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(listener);
  }

  dispatchEvent(event: string, detail?: unknown): void {
    const listeners = this._listeners.get(event) ?? [];
    for (const l of listeners) l(detail ?? {});
  }

  select(): void { /* stub */ }

  get firstChild(): StubElement | null {
    return this.children[0] ?? null;
  }
}

function makeDocument() {
  return {
    _elements: [] as StubElement[],
    createElement(tag: string): StubElement {
      const el = new StubElement(tag);
      this._elements.push(el);
      return el;
    },
    findByText(text: string): StubElement | undefined {
      return this._elements.find(e => e.textContent === text);
    },
    findInputs(): StubElement[] {
      return this._elements.filter(e => e.tagName === "INPUT");
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal CircuitElement stub
// ---------------------------------------------------------------------------

function makeElement(overrides?: Record<string, string>): CircuitElement {
  const bag = new PropertyBag();
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      bag.set(k, v);
    }
  }
  return {
    typeId: "test",
    instanceId: "e1",
    position: { x: 0, y: 0 },
    rotation: 0 as never,
    mirror: false,
    getProperties: () => bag,
    getPins: () => [],
    getBoundingBox: () => ({ x: 0, y: 0, width: 10, height: 10 } as never),
    draw: () => {},
    serialize: () => ({} as never),
    getAttribute: () => undefined,
    setAttribute: () => {},
  } as unknown as CircuitElement;
}

// ---------------------------------------------------------------------------
// Minimal ComponentDefinition stubs
// ---------------------------------------------------------------------------

function makeNpnDef(): ComponentDefinition {
  return {
    typeId: "npn",
    label: "NPN",
    category: "semiconductors" as never,
    propertyDefs: [],
    pinLayout: [],
    defaultModel: "behavioral",
    models: {
      mnaModels: {
        behavioral: {
          deviceType: "NPN",
        },
      },
    },
  } as unknown as ComponentDefinition;
}

function makeResistorDef(): ComponentDefinition {
  return {
    typeId: "resistor",
    label: "Resistor",
    category: "passives" as never,
    propertyDefs: [],
    pinLayout: [],
    models: {},
  } as unknown as ComponentDefinition;
}

function makeLogicalGateDef(): ComponentDefinition {
  return {
    typeId: "and",
    label: "AND",
    category: "gates" as never,
    propertyDefs: [],
    pinLayout: [],
    defaultModel: "logical",
    models: {
      logical: {} as never,
    },
  } as unknown as ComponentDefinition;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let doc: ReturnType<typeof makeDocument>;
let container: StubElement;
let panel: PropertyPanel;

beforeEach(() => {
  doc = makeDocument();
  (global as Record<string, unknown>).document = doc;
  container = new StubElement("div");
  panel = new PropertyPanel(container as unknown as HTMLElement);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("showSpiceModelParameters", () => {
  it("renders a collapsible section header for NPN BJT", () => {
    const element = makeElement();
    const def = makeNpnDef();
    panel.showSpiceModelParameters(element, def);

    const toggle = doc.findByText("▶ SPICE Model Parameters");
    expect(toggle).toBeDefined();
  });

  it("renders 26 input fields for NPN BJT (one per param)", () => {
    const element = makeElement();
    const def = makeNpnDef();
    panel.showSpiceModelParameters(element, def);

    const inputs = doc.findInputs();
    expect(inputs.length).toBe(26);
  });

  it("does not render when deviceType is absent (resistor)", () => {
    const element = makeElement();
    const def = makeResistorDef();
    panel.showSpiceModelParameters(element, def);

    const toggle = doc.findByText("▶ SPICE Model Parameters");
    expect(toggle).toBeUndefined();
    expect(doc.findInputs().length).toBe(0);
  });

  it("does not render when def has no mnaModels (logical gate)", () => {
    const element = makeElement();
    const def = makeLogicalGateDef();
    panel.showSpiceModelParameters(element, def);

    expect(doc.findInputs().length).toBe(0);
  });

  it("populates input value from stored _spiceModelOverrides", () => {
    const element = makeElement({ _spiceModelOverrides: JSON.stringify({ IS: 1e-14 }) });
    const def = makeNpnDef();
    panel.showSpiceModelParameters(element, def);

    const inputs = doc.findInputs();
    const isInput = inputs[0];
    expect(isInput).toBeDefined();
    expect(isInput!.value).not.toBe("");
  });

  it("leaves input empty when no override is stored for a param", () => {
    const element = makeElement();
    const def = makeNpnDef();
    panel.showSpiceModelParameters(element, def);

    const inputs = doc.findInputs();
    for (const input of inputs) {
      expect(input.value).toBe("");
    }
  });

  it("sets placeholder to default value for each param", () => {
    const element = makeElement();
    const def = makeNpnDef();
    panel.showSpiceModelParameters(element, def);

    const inputs = doc.findInputs();
    expect(inputs.some(i => i.placeholder !== "")).toBe(true);
  });

  it("commits override to _spiceModelOverrides on blur", () => {
    const element = makeElement();
    const def = makeNpnDef();
    panel.showSpiceModelParameters(element, def);

    const inputs = doc.findInputs();
    const isInput = inputs[0]!;
    isInput.value = "1e-14";
    isInput.dispatchEvent("blur");

    const bag = element.getProperties();
    expect(bag.has("_spiceModelOverrides")).toBe(true);
    const stored = JSON.parse(bag.get("_spiceModelOverrides") as string) as Record<string, number>;
    expect(stored["IS"]).toBeCloseTo(1e-14, 20);
  });

  it("fires change callback on commit", () => {
    const element = makeElement();
    const def = makeNpnDef();
    const changes: string[] = [];
    panel.onPropertyChange((key) => changes.push(key));
    panel.showSpiceModelParameters(element, def);

    const inputs = doc.findInputs();
    const isInput = inputs[0]!;
    isInput.value = "1e-14";
    isInput.dispatchEvent("blur");

    expect(changes).toContain("_spiceModelOverrides");
  });

  it("deletes key from overrides when input is cleared", () => {
    const element = makeElement({ _spiceModelOverrides: JSON.stringify({ IS: 1e-14 }) });
    const def = makeNpnDef();
    panel.showSpiceModelParameters(element, def);

    const inputs = doc.findInputs();
    const isInput = inputs[0]!;
    isInput.value = "";
    isInput.dispatchEvent("blur");

    const bag = element.getProperties();
    const stored = JSON.parse(bag.get("_spiceModelOverrides") as string) as Record<string, number>;
    expect(stored["IS"]).toBeUndefined();
  });
});
