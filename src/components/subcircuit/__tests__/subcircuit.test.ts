/**
 * Tests for SubcircuitElement, pin derivation, and dynamic registration.
 */

import { describe, it, expect } from "vitest";
import { Circuit } from "../../../core/circuit.js";
import { ComponentRegistry, ComponentCategory } from "../../../core/registry.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import { MockRenderContext } from "../../../test-utils/mock-render-context.js";
import { deriveInterfacePins } from "../pin-derivation.js";
import {
  SubcircuitElement,
  SubcircuitDefinition,
  registerSubcircuit,
  executeSubcircuit,
} from "../subcircuit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInElement(label: string, bitWidth: number = 1) {
  const props = new PropertyBag([
    ["label", label],
    ["bitWidth", bitWidth],
  ]);
  return {
    typeId: "In" as const,
    instanceId: "inst-" + label,
    position: { x: 0, y: 0 },
    rotation: 0 as const,
    mirror: false,
    getPins: () => [],
    getProperties: () => props,
    draw: () => {},
    getBoundingBox: () => ({ x: 0, y: 0, width: 2, height: 2 }),
    serialize: () => ({ typeId: "In", instanceId: "inst-" + label, position: { x: 0, y: 0 }, rotation: 0 as const, mirror: false, properties: {} }),
    getHelpText: () => "",
    getAttribute: (name: string) => props.has(name) ? props.get(name) : undefined,
  };
}

function makeOutElement(label: string, bitWidth: number = 1) {
  const props = new PropertyBag([
    ["label", label],
    ["bitWidth", bitWidth],
  ]);
  return {
    typeId: "Out" as const,
    instanceId: "inst-" + label,
    position: { x: 0, y: 0 },
    rotation: 0 as const,
    mirror: false,
    getPins: () => [],
    getProperties: () => props,
    draw: () => {},
    getBoundingBox: () => ({ x: 0, y: 0, width: 2, height: 2 }),
    serialize: () => ({ typeId: "Out", instanceId: "inst-" + label, position: { x: 0, y: 0 }, rotation: 0 as const, mirror: false, properties: {} }),
    getHelpText: () => "",
    getAttribute: (name: string) => props.has(name) ? props.get(name) : undefined,
  };
}

function makeSubcircuitDefinition(
  inputLabels: string[],
  outputLabels: string[],
  name: string = "TestChip",
): SubcircuitDefinition {
  const circuit = new Circuit({ name });
  for (const label of inputLabels) {
    circuit.addElement(makeInElement(label) as any);
  }
  for (const label of outputLabels) {
    circuit.addElement(makeOutElement(label) as any);
  }
  const pinLayout = deriveInterfacePins(circuit);
  return { circuit, pinLayout, shapeMode: "DEFAULT", name };
}

// ---------------------------------------------------------------------------
// derivesPins
// ---------------------------------------------------------------------------

describe("derivesPins", () => {
  it("derives input and output pins from In/Out elements", () => {
    const circuit = new Circuit({ name: "HalfAdder" });
    circuit.addElement(makeInElement("A") as any);
    circuit.addElement(makeInElement("B") as any);
    circuit.addElement(makeOutElement("S") as any);

    const pins = deriveInterfacePins(circuit);

    expect(pins).toHaveLength(3);

    const inputPins = pins.filter((p) => p.direction === PinDirection.INPUT);
    const outputPins = pins.filter((p) => p.direction === PinDirection.OUTPUT);

    expect(inputPins).toHaveLength(2);
    expect(outputPins).toHaveLength(1);

    expect(inputPins[0].label).toBe("A");
    expect(inputPins[0].defaultBitWidth).toBe(1);
    expect(inputPins[1].label).toBe("B");
    expect(outputPins[0].label).toBe("S");
  });

  it("preserves bit widths from In/Out properties", () => {
    const circuit = new Circuit({ name: "Wide" });
    circuit.addElement(makeInElement("data", 8) as any);
    circuit.addElement(makeOutElement("result", 4) as any);

    const pins = deriveInterfacePins(circuit);

    const inputPin = pins.find((p) => p.label === "data")!;
    const outputPin = pins.find((p) => p.label === "result")!;

    expect(inputPin.defaultBitWidth).toBe(8);
    expect(outputPin.defaultBitWidth).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// dynamicRegistration
// ---------------------------------------------------------------------------

describe("dynamicRegistration", () => {
  it("registers a subcircuit definition in the registry", () => {
    const registry = new ComponentRegistry();
    const definition = makeSubcircuitDefinition(["A", "B"], ["Y"], "AndChip");

    registerSubcircuit(registry, "AndChip", definition);

    const def = registry.get("AndChip");
    expect(def).toBeDefined();
    expect(def!.name).toBe("AndChip");
    expect(def!.category).toBe(ComponentCategory.SUBCIRCUIT);
  });

  it("assigns a typeId to the registered subcircuit", () => {
    const registry = new ComponentRegistry();
    const definition = makeSubcircuitDefinition(["X"], ["Z"], "MyChip");

    registerSubcircuit(registry, "MyChip", definition);

    const def = registry.get("MyChip");
    expect(def).toBeDefined();
    expect(def!.typeId).toBeGreaterThanOrEqual(0);
  });

  it("factory creates a SubcircuitElement", () => {
    const registry = new ComponentRegistry();
    const definition = makeSubcircuitDefinition(["IN"], ["OUT"], "TestChip");

    registerSubcircuit(registry, "TestChip", definition);

    const def = registry.get("TestChip")!;
    const element = def.factory(new PropertyBag());

    expect(element).toBeInstanceOf(SubcircuitElement);
    expect(element.typeId).toBe("TestChip");
  });
});

// ---------------------------------------------------------------------------
// drawDefault
// ---------------------------------------------------------------------------

describe("drawDefault", () => {
  it("renders a rectangle and pin labels in DEFAULT mode", () => {
    const definition = makeSubcircuitDefinition(["A", "B"], ["Y"], "Gate");
    const props = new PropertyBag();
    const element = new SubcircuitElement(
      "Gate",
      "inst-1",
      { x: 0, y: 0 },
      0,
      false,
      props,
      definition,
    );

    const ctx = new MockRenderContext();
    element.draw(ctx);

    const rects = ctx.callsOfKind("rect");
    expect(rects.length).toBeGreaterThanOrEqual(1);

    const texts = ctx.callsOfKind("text");
    const textStrings = texts.map((t) => t.text);
    expect(textStrings).toContain("Gate");
    expect(textStrings.some((t) => t === "A" || t === "B" || t === "Y")).toBe(true);
  });

  it("starts with save and ends with restore", () => {
    const definition = makeSubcircuitDefinition(["A"], ["Z"], "Chip");
    const props = new PropertyBag();
    const element = new SubcircuitElement(
      "Chip",
      "inst-2",
      { x: 2, y: 3 },
      0,
      false,
      props,
      definition,
    );

    const ctx = new MockRenderContext();
    element.draw(ctx);

    const calls = ctx.calls.map((c) => c.kind);
    expect(calls[0]).toBe("save");
    expect(calls[calls.length - 1]).toBe("restore");
  });
});

// ---------------------------------------------------------------------------
// drawDIL
// ---------------------------------------------------------------------------

describe("drawDIL", () => {
  it("renders a DIP IC package appearance in DIL mode", () => {
    const circuit = new Circuit({ name: "DilChip" });
    circuit.addElement(makeInElement("VCC") as any);
    circuit.addElement(makeInElement("GND") as any);
    circuit.addElement(makeOutElement("Q") as any);
    const pinLayout = deriveInterfacePins(circuit);

    const definition: SubcircuitDefinition = {
      circuit,
      pinLayout,
      shapeMode: "DIL",
      name: "DilChip",
    };

    const props = new PropertyBag();
    const element = new SubcircuitElement(
      "DilChip",
      "inst-3",
      { x: 0, y: 0 },
      0,
      false,
      props,
      definition,
    );

    const ctx = new MockRenderContext();
    element.draw(ctx);

    const arcs = ctx.callsOfKind("arc");
    expect(arcs.length).toBeGreaterThanOrEqual(1);

    const rects = ctx.callsOfKind("rect");
    expect(rects.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// executeFnNoOp
// ---------------------------------------------------------------------------

describe("executeFnNoOp", () => {
  it("execute function does nothing — no state change", () => {
    const state = new Uint32Array([1, 2, 3, 4]);
    const highZs = new Uint32Array(state.length);
    const snapshot = Uint32Array.from(state);

    const mockLayout = {
      inputCount: () => 1,
      inputOffset: () => 0,
      outputCount: () => 1,
      outputOffset: () => 1,
      stateOffset: () => 0,
    };

    executeSubcircuit(0, state, highZs, mockLayout);

    expect(state).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// pinOrderMatchesInOut
// ---------------------------------------------------------------------------

describe("pinOrderMatchesInOut", () => {
  it("input pins appear in the order In elements are declared in the subcircuit", () => {
    const circuit = new Circuit({ name: "Ordered" });
    circuit.addElement(makeInElement("first") as any);
    circuit.addElement(makeInElement("second") as any);
    circuit.addElement(makeInElement("third") as any);
    circuit.addElement(makeOutElement("result") as any);

    const pins = deriveInterfacePins(circuit);

    const inputPins = pins.filter((p) => p.direction === PinDirection.INPUT);
    expect(inputPins[0].label).toBe("first");
    expect(inputPins[1].label).toBe("second");
    expect(inputPins[2].label).toBe("third");
  });

  it("output pins appear in the order Out elements are declared in the subcircuit", () => {
    const circuit = new Circuit({ name: "MultiOut" });
    circuit.addElement(makeInElement("x") as any);
    circuit.addElement(makeOutElement("sum") as any);
    circuit.addElement(makeOutElement("carry") as any);

    const pins = deriveInterfacePins(circuit);

    const outputPins = pins.filter((p) => p.direction === PinDirection.OUTPUT);
    expect(outputPins[0].label).toBe("sum");
    expect(outputPins[1].label).toBe("carry");
  });
});
