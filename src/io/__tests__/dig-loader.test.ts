/**
 * Tests for dig-loader.ts — Circuit construction from parsed .dig XML.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseDigXml } from "../dig-parser.js";
import { loadDigCircuit, loadDig, loadDigFromParsed, createElementFromDig, createWireFromDig, extractCircuitMetadata, applyInverterConfig, DigParserError } from "../dig-loader.js";
import { ComponentRegistry, ComponentCategory } from "../../core/registry.js";
import type { ComponentDefinition, AttributeMapping } from "../../core/registry.js";
import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin } from "../../core/pin.js";
import { PinDirection, createInverterConfig, makePin } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import type { DigCircuit, DigVisualElement } from "../dig-schema.js";
import { stringConverter, boolConverter, intConverter, testDataConverter } from "../attribute-map.js";
import { CircuitBuilder } from "../../headless/builder.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readCircuit(name: string): string {
  return readFileSync(join(process.cwd(), "circuits", name), "utf-8");
}

// ---------------------------------------------------------------------------
// Minimal test CircuitElement
// ---------------------------------------------------------------------------

class TestElement extends AbstractCircuitElement {
  getPins(): readonly Pin[] { return []; }
  draw(_ctx: RenderContext): void { /* no-op */ }
  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 4, height: 4 };
  }
  getHelpText(): string { return "test"; }
}

// ---------------------------------------------------------------------------
// Factory helper — creates a TestElement from props, recording label
// ---------------------------------------------------------------------------

function makeFactory(typeName: string) {
  return (props: PropertyBag) =>
    new TestElement(
      typeName,
      crypto.randomUUID(),
      { x: 0, y: 0 },
      0,
      false,
      props,
    );
}

// ---------------------------------------------------------------------------
// Common attribute mappings for test components
// ---------------------------------------------------------------------------

const LABEL_MAPPING: AttributeMapping = stringConverter("Label", "label");
const WIDE_SHAPE_MAPPING: AttributeMapping = boolConverter("wideShape", "wideShape");
const INPUTS_MAPPING: AttributeMapping = intConverter("Inputs", "inputCount");
const BITS_MAPPING: AttributeMapping = intConverter("Bits", "bitWidth");
const TEST_DATA_MAPPING: AttributeMapping = testDataConverter();

function noopExecute(): void { /* no-op */ }

function makeDefinition(name: string, extraMappings: AttributeMapping[] = []): ComponentDefinition {
  return {
    name,
    typeId: -1,
    factory: makeFactory(name),
    executeFn: noopExecute,
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [LABEL_MAPPING, WIDE_SHAPE_MAPPING, INPUTS_MAPPING, BITS_MAPPING, TEST_DATA_MAPPING, ...extraMappings],
    category: ComponentCategory.LOGIC,
    helpText: name,
  };
}

// ---------------------------------------------------------------------------
// Registry builder
// ---------------------------------------------------------------------------

function buildRegistry(names: string[]): ComponentRegistry {
  const registry = new ComponentRegistry();
  for (const name of names) {
    registry.register(makeDefinition(name));
  }
  return registry;
}

function buildAndGateRegistry(): ComponentRegistry {
  return buildRegistry(["In", "And", "Out", "Testcase"]);
}

function buildHalfAdderRegistry(): ComponentRegistry {
  return buildRegistry(["In", "And", "XOr", "Out", "Testcase"]);
}

function buildSrLatchRegistry(): ComponentRegistry {
  return buildRegistry(["In", "NOr", "Out"]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DigLoader", () => {

  it("loadsAndGate", () => {
    const xml = readCircuit("and-gate.dig");
    const parsed = parseDigXml(xml);
    const registry = buildAndGateRegistry();
    const circuit = loadDigCircuit(parsed, registry);

    expect(circuit.elements).toHaveLength(5);
    expect(circuit.wires).toHaveLength(5);

    // In elements have correct labels
    const inElements = circuit.elements.filter((el) => el.typeId === "In");
    expect(inElements).toHaveLength(2);

    const labelA = inElements.find((el) => String(el.getProperties().getOrDefault("label", "")) === "A");
    expect(labelA).not.toBeUndefined();

    const labelB = inElements.find((el) => String(el.getProperties().getOrDefault("label", "")) === "B");
    expect(labelB).not.toBeUndefined();

    // And element has wideShape: true in properties
    const andElements = circuit.elements.filter((el) => el.typeId === "And");
    expect(andElements).toHaveLength(1);
    expect(andElements[0].getProperties().getOrDefault("wideShape", false)).toBe(true);
  });

  it("elementsPositionedCorrectly", () => {
    const xml = readCircuit("and-gate.dig");
    const parsed = parseDigXml(xml);
    const registry = buildAndGateRegistry();
    const circuit = loadDigCircuit(parsed, registry);

    // In "A" is at (200, 200) in .dig pixel coords = (10, 10) grid units
    const inElements = circuit.elements.filter((el) => el.typeId === "In");
    const inA = inElements.find((el) => String(el.getProperties().getOrDefault("label", "")) === "A");
    expect(inA).toBeDefined();
    expect(inA!.position).toEqual({ x: 10, y: 10 });

    // And gate is at (300, 200) in .dig pixel coords = (15, 10) grid units
    const andElement = circuit.elements.find((el) => el.typeId === "And");
    expect(andElement).toBeDefined();
    expect(andElement!.position).toEqual({ x: 15, y: 10 });
  });

  it("wiresCreatedCorrectly", () => {
    const xml = readCircuit("and-gate.dig");
    const parsed = parseDigXml(xml);
    const registry = buildAndGateRegistry();
    const circuit = loadDigCircuit(parsed, registry);

    expect(circuit.wires).toHaveLength(5);

    // First wire: p1=(200,200), p2=(300,200) → grid (10,10) to (15,10)
    const wire0 = circuit.wires[0];
    expect(wire0.start).toEqual({ x: 10, y: 10 });
    expect(wire0.end).toEqual({ x: 15, y: 10 });

    // Last wire: p1=(380,220), p2=(420,220) → grid (19,11) to (21,11)
    const wire4 = circuit.wires[4];
    expect(wire4.start).toEqual({ x: 19, y: 11 });
    expect(wire4.end).toEqual({ x: 21, y: 11 });
  });

  it("unknownElementSkipped", () => {
    const parsed: DigCircuit = {
      version: 2,
      attributes: [],
      visualElements: [
        {
          elementName: "FutureComponent",
          elementAttributes: [],
          pos: { x: 100, y: 200 },
        },
      ],
      wires: [],
    };

    const registry = new ComponentRegistry();

    // Unknown elements are skipped gracefully (not thrown)
    const circuit = loadDigCircuit(parsed, registry);
    expect(circuit.elements).toHaveLength(0);
  });

  it("inverterConfigApplied", () => {
    class PinnedElement extends AbstractCircuitElement {
      private readonly _testPin: Pin;
      constructor(props: PropertyBag) {
        super("And", crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
        this._testPin = makePin(
          {
            direction: PinDirection.INPUT,
            label: "in0",
            defaultBitWidth: 1,
            position: { x: 0, y: 1 },
            isNegatable: true,
            isClockCapable: false,
          },
          { x: 0, y: 1 },
          createInverterConfig([]),
          { clockPins: new Set<string>() },
        );
      }
      getPins(): readonly Pin[] { return [this._testPin]; }
      draw(_ctx: RenderContext): void { /* no-op */ }
      getBoundingBox(): Rect { return { x: 0, y: 0, width: 4, height: 4 }; }
      getHelpText(): string { return ""; }
    }

    const element = new PinnedElement(new PropertyBag());
    const pinsBefore = element.getPins();
    expect(pinsBefore[0].isNegated).toBe(false);

    applyInverterConfig(element, ["in0"]);
    const pinsAfter = element.getPins();
    expect(pinsAfter[0].isNegated).toBe(true);
  });

  it("rotationApplied", () => {
    const parsed: DigCircuit = {
      version: 2,
      attributes: [],
      visualElements: [
        {
          elementName: "And",
          elementAttributes: [
            { key: "rotation", value: { type: "rotation", value: 1 } },
          ],
          pos: { x: 100, y: 100 },
        },
      ],
      wires: [],
    };

    const registry = buildRegistry(["And"]);
    const circuit = loadDigCircuit(parsed, registry);

    expect(circuit.elements).toHaveLength(1);
    expect(circuit.elements[0].rotation).toBe(1);
  });

  it("testDataExtracted", () => {
    const xml = readCircuit("and-gate.dig");
    const parsed = parseDigXml(xml);
    const registry = buildAndGateRegistry();
    const circuit = loadDigCircuit(parsed, registry);

    const testcaseEl = circuit.elements.find((el) => el.typeId === "Testcase");
    expect(testcaseEl).not.toBeUndefined();

    const testData = testcaseEl!.getProperties().getOrDefault<string>("testData", "");
    expect(testData).toContain("A B Y");
  });

  it("circuitMetadataExtracted", () => {
    const parsed: DigCircuit = {
      version: 2,
      attributes: [
        { key: "Description", value: { type: "string", value: "My test circuit" } },
      ],
      visualElements: [],
      wires: [],
    };

    const metadata = extractCircuitMetadata(parsed);
    expect(metadata.description).toBe("My test circuit");
  });

  it("createWireFromDig", () => {
    const dw = { p1: { x: 10, y: 20 }, p2: { x: 30, y: 40 } };
    const wire = createWireFromDig(dw);
    expect(wire.start).toEqual({ x: 0.5, y: 1 });
    expect(wire.end).toEqual({ x: 1.5, y: 2 });
  });

  it("extractCircuitMetadataWithMeasurementOrdering", () => {
    const parsed: DigCircuit = {
      version: 2,
      attributes: [],
      visualElements: [],
      wires: [],
      measurementOrdering: ["A", "B", "Y"],
    };

    const metadata = extractCircuitMetadata(parsed);
    expect(metadata.measurementOrdering).toEqual(["A", "B", "Y"]);
  });

  it("createElementFromDig_throwsForUnknown", () => {
    const ve: DigVisualElement = {
      elementName: "UnknownGate",
      elementAttributes: [],
      pos: { x: 50, y: 60 },
    };
    const registry = new ComponentRegistry();

    expect(() => createElementFromDig(ve, registry)).toThrow(DigParserError);

    let thrown: DigParserError | undefined;
    try {
      createElementFromDig(ve, registry);
    } catch (e) {
      thrown = e as DigParserError;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.elementName).toBe("UnknownGate");
    expect(thrown!.position).toEqual({ x: 50, y: 60 });
    expect(thrown!.message).toContain("UnknownGate");
  });

  it("loadsHalfAdder", () => {
    const xml = readCircuit("half-adder.dig");
    const parsed = parseDigXml(xml);
    const registry = buildHalfAdderRegistry();
    const circuit = loadDigCircuit(parsed, registry);

    expect(circuit.elements).toHaveLength(7);
    expect(circuit.wires).toHaveLength(12);
  });

  it("loadsSrLatch", () => {
    const xml = readCircuit("sr-latch.dig");
    const parsed = parseDigXml(xml);
    const registry = buildSrLatchRegistry();
    const circuit = loadDigCircuit(parsed, registry);

    expect(circuit.elements).toHaveLength(6);
    expect(circuit.wires).toHaveLength(14);
  });

  // ---------------------------------------------------------------------------
  // Phase 6.1.1 spec-named tests
  // ---------------------------------------------------------------------------

  it("loadAndGate", () => {
    const xml = readCircuit("and-gate.dig");
    const registry = buildAndGateRegistry();
    const circuit = loadDig(xml, registry);

    // 2 In, 1 And, 1 Out, 1 Testcase
    expect(circuit.elements).toHaveLength(5);
    const inEls = circuit.elements.filter((el) => el.typeId === "In");
    const andEls = circuit.elements.filter((el) => el.typeId === "And");
    const outEls = circuit.elements.filter((el) => el.typeId === "Out");
    expect(inEls).toHaveLength(2);
    expect(andEls).toHaveLength(1);
    expect(outEls).toHaveLength(1);
    expect(circuit.wires).toHaveLength(5);
  });

  it("loadHalfAdder", () => {
    const xml = readCircuit("half-adder.dig");
    const registry = buildHalfAdderRegistry();
    const circuit = loadDig(xml, registry);

    // 2 In, 1 XOr, 1 And, 2 Out, 1 Testcase = 7 elements
    expect(circuit.elements).toHaveLength(7);
    const inEls = circuit.elements.filter((el) => el.typeId === "In");
    const xorEls = circuit.elements.filter((el) => el.typeId === "XOr");
    const andEls = circuit.elements.filter((el) => el.typeId === "And");
    const outEls = circuit.elements.filter((el) => el.typeId === "Out");
    expect(inEls).toHaveLength(2);
    expect(xorEls).toHaveLength(1);
    expect(andEls).toHaveLength(1);
    expect(outEls).toHaveLength(2);
    expect(circuit.wires).toHaveLength(12);
  });

  it("loadSrLatch", () => {
    const xml = readCircuit("sr-latch.dig");
    const registry = buildSrLatchRegistry();
    const circuit = loadDig(xml, registry);

    expect(circuit.elements).toHaveLength(6);
    expect(circuit.wires).toHaveLength(14);
    const inEls = circuit.elements.filter((el) => el.typeId === "In");
    const norEls = circuit.elements.filter((el) => el.typeId === "NOr");
    const outEls = circuit.elements.filter((el) => el.typeId === "Out");
    expect(inEls).toHaveLength(2);
    expect(norEls).toHaveLength(2);
    expect(outEls).toHaveLength(2);
  });

  it("attributeMapping", () => {
    // Build a .dig XML snippet with Inputs=3, Bits=8, wideShape=true
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<circuit>
  <version>2</version>
  <attributes/>
  <visualElements>
    <visualElement>
      <elementName>TestGate</elementName>
      <elementAttributes>
        <entry>
          <string>Inputs</string>
          <int>3</int>
        </entry>
        <entry>
          <string>Bits</string>
          <int>8</int>
        </entry>
        <entry>
          <string>wideShape</string>
          <boolean>true</boolean>
        </entry>
      </elementAttributes>
      <pos x="100" y="100"/>
    </visualElement>
  </visualElements>
  <wires/>
</circuit>`;

    const registry = new ComponentRegistry();
    registry.register(makeDefinition("TestGate", [
      intConverter("Inputs", "inputCount"),
      intConverter("Bits", "bitWidth"),
      boolConverter("wideShape", "wideShape"),
    ]));

    const circuit = loadDig(xml, registry);
    expect(circuit.elements).toHaveLength(1);
    const el = circuit.elements[0];
    expect(el.getProperties().getOrDefault("inputCount", 0)).toBe(3);
    expect(el.getProperties().getOrDefault("bitWidth", 0)).toBe(8);
    expect(el.getProperties().getOrDefault("wideShape", false)).toBe(true);
  });

  it("positionAndRotation", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<circuit>
  <version>2</version>
  <attributes/>
  <visualElements>
    <visualElement>
      <elementName>And</elementName>
      <elementAttributes>
        <entry>
          <string>rotation</string>
          <rotation rotation="2"/>
        </entry>
      </elementAttributes>
      <pos x="400" y="320"/>
    </visualElement>
  </visualElements>
  <wires/>
</circuit>`;

    const registry = buildRegistry(["And"]);
    const circuit = loadDig(xml, registry);
    expect(circuit.elements).toHaveLength(1);
    const el = circuit.elements[0];
    expect(el.position).toEqual({ x: 20, y: 16 });
    expect(el.rotation).toBe(2);
  });

  it("unknownElementSkipped", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<circuit>
  <version>2</version>
  <attributes/>
  <visualElements>
    <visualElement>
      <elementName>Bogus</elementName>
      <elementAttributes/>
      <pos x="0" y="0"/>
    </visualElement>
  </visualElements>
  <wires/>
</circuit>`;

    const registry = new ComponentRegistry();
    // Unknown elements are skipped gracefully (not thrown)
    const circuit = loadDig(xml, registry);
    expect(circuit.elements).toHaveLength(0);
  });

  it("missingAttributeUsesDefault", () => {
    // Element without a Bits attribute — factory should receive PropertyBag
    // without "bitWidth" and use its own default
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<circuit>
  <version>2</version>
  <attributes/>
  <visualElements>
    <visualElement>
      <elementName>GateWithDefault</elementName>
      <elementAttributes/>
      <pos x="0" y="0"/>
    </visualElement>
  </visualElements>
  <wires/>
</circuit>`;

    const DEFAULT_BIT_WIDTH = 1;
    const registry = new ComponentRegistry();
    registry.register({
      name: "GateWithDefault",
      typeId: -1,
      factory: (props: PropertyBag) => {
        // If bitWidth not in props, use default of 1
        const bitWidth = props.has("bitWidth")
          ? (props.get("bitWidth") as number)
          : DEFAULT_BIT_WIDTH;
        const bag = new PropertyBag([["bitWidth", bitWidth]]);
        return new TestElement("GateWithDefault", crypto.randomUUID(), { x: 0, y: 0 }, 0, false, bag);
      },
      executeFn: noopExecute,
      pinLayout: [],
      propertyDefs: [],
      attributeMap: [intConverter("Bits", "bitWidth")],
      category: ComponentCategory.LOGIC,
      helpText: "GateWithDefault",
    });

    const circuit = loadDig(xml, registry);
    expect(circuit.elements).toHaveLength(1);
    const el = circuit.elements[0];
    expect(el.getProperties().getOrDefault("bitWidth", 0)).toBe(DEFAULT_BIT_WIDTH);
  });

  it("facadeIntegration", () => {
    const xml = readCircuit("and-gate.dig");
    const registry = buildAndGateRegistry();
    const builder = new CircuitBuilder(registry);
    const circuit = builder.loadDig(xml);

    expect(circuit).toBeDefined();
    expect(circuit.elements).toHaveLength(5);
    expect(circuit.wires).toHaveLength(5);
    const andEls = circuit.elements.filter((el) => el.typeId === "And");
    expect(andEls).toHaveLength(1);
  });

  it("loadDigFromParsed", () => {
    const xml = readCircuit("and-gate.dig");
    const parsed = parseDigXml(xml);
    const registry = buildAndGateRegistry();
    const circuit = loadDigFromParsed(parsed, registry);

    expect(circuit.elements).toHaveLength(5);
    expect(circuit.wires).toHaveLength(5);
  });
});
