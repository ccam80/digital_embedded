import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  parseDigXml,
  parseAttributeValue,
  migrateVersion,
} from "../dig-parser.js";
import { createDomParser } from "../dom-parser.js";
import type { DigCircuit } from "../dig-schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readCircuit(name: string): string {
  return readFileSync(join(process.cwd(), "circuits", name), "utf-8");
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DigParser", () => {
  it("parsesAndGateCircuit", () => {
    const xml = readCircuit("and-gate.dig");
    const circuit = parseDigXml(xml);

    expect(circuit.version).toBe(2);
    expect(circuit.visualElements).toHaveLength(5);
    expect(circuit.wires).toHaveLength(5);

    // Verify element names
    const names = circuit.visualElements.map((ve) => ve.elementName);
    expect(names).toContain("In");
    expect(names).toContain("And");
    expect(names).toContain("Out");
    expect(names).toContain("Testcase");

    // And element has wideShape: true
    const andEl = circuit.visualElements.find((ve) => ve.elementName === "And");
    expect(andEl).not.toBeUndefined();
    const wideShapeEntry = andEl!.elementAttributes.find((e) => e.key === "wideShape");
    expect(wideShapeEntry).not.toBeUndefined();
    expect(wideShapeEntry!.value).toEqual({ type: "boolean", value: true });

    // In elements have exact count and include label "A"
    const inElements = circuit.visualElements.filter((ve) => ve.elementName === "In");
    expect(inElements).toHaveLength(2);
    const inA = inElements.find((ve) =>
      ve.elementAttributes.some(
        (e) => e.key === "Label" && e.value.type === "string" && e.value.value === "A",
      ),
    );
    expect(inA).not.toBeUndefined();
  });

  it("parsesHalfAdder", () => {
    const xml = readCircuit("half-adder.dig");
    const circuit = parseDigXml(xml);

    expect(circuit.visualElements).toHaveLength(7);
    expect(circuit.wires).toHaveLength(12);

    // XOr and And gates both have wideShape: true
    const gates = circuit.visualElements.filter(
      (ve) => ve.elementName === "XOr" || ve.elementName === "And",
    );
    expect(gates).toHaveLength(2);
    for (const gate of gates) {
      const wideShapeEntry = gate.elementAttributes.find((e) => e.key === "wideShape");
      expect(wideShapeEntry).toBeDefined();
      expect(wideShapeEntry!.value).toEqual({ type: "boolean", value: true });
    }
  });

  it("parsesSrLatch", () => {
    const xml = readCircuit("sr-latch.dig");
    const circuit = parseDigXml(xml);

    // 2 In, 2 NOr, 2 Out = 6 elements
    expect(circuit.visualElements).toHaveLength(6);

    const norCount = circuit.visualElements.filter((ve) => ve.elementName === "NOr").length;
    expect(norCount).toBe(2);

    const inCount = circuit.visualElements.filter((ve) => ve.elementName === "In").length;
    expect(inCount).toBe(2);

    const outCount = circuit.visualElements.filter((ve) => ve.elementName === "Out").length;
    expect(outCount).toBe(2);

    // SR latch has exactly 14 feedback wires
    expect(circuit.wires).toHaveLength(14);
  });

  it("parsesTestData", () => {
    const xml = readCircuit("and-gate.dig");
    const circuit = parseDigXml(xml);

    const testcase = circuit.visualElements.find((ve) => ve.elementName === "Testcase");
    expect(testcase).not.toBeUndefined();

    const testDataEntry = testcase!.elementAttributes.find((e) => e.key === "Testdata");
    expect(testDataEntry).not.toBeUndefined();
    expect(testDataEntry!.value.type).toBe("testData");
    // Assert unconditionally — type was already verified above
    expect((testDataEntry!.value as { type: "testData"; value: string }).value).toContain("A B Y");
  });

  it("parsesRotation", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<circuit>
  <version>2</version>
  <attributes/>
  <visualElements>
    <visualElement>
      <elementName>Not</elementName>
      <elementAttributes>
        <entry>
          <string>rotation</string>
          <rotation rotation="3"/>
        </entry>
      </elementAttributes>
      <pos x="100" y="100"/>
    </visualElement>
    <visualElement>
      <elementName>Not</elementName>
      <elementAttributes>
        <entry>
          <string>rotation</string>
          <rotation rotation="1"/>
        </entry>
      </elementAttributes>
      <pos x="200" y="100"/>
    </visualElement>
  </visualElements>
  <wires/>
</circuit>`;
    const circuit = parseDigXml(xml);

    // mux.dig has exactly 2 Not elements; first has rotation 3
    const notElements = circuit.visualElements.filter((ve) => ve.elementName === "Not");
    expect(notElements).toHaveLength(2);

    const firstNot = notElements[0];
    const rotEntry = firstNot.elementAttributes.find((e) => e.key === "rotation");
    expect(rotEntry).not.toBeUndefined();
    expect(rotEntry!.value).toEqual({ type: "rotation", value: 3 });
  });

  it("resolvesXStreamReference", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<circuit>
  <version>2</version>
  <attributes/>
  <visualElements>
    <visualElement>
      <elementName>Not</elementName>
      <elementAttributes>
        <entry>
          <string>rotation</string>
          <rotation rotation="3"/>
        </entry>
      </elementAttributes>
      <pos x="100" y="100"/>
    </visualElement>
    <visualElement>
      <elementName>Not</elementName>
      <elementAttributes>
        <entry>
          <string>rotation</string>
          <rotation reference="../../../../visualElement[1]/elementAttributes/entry/rotation"/>
        </entry>
      </elementAttributes>
      <pos x="200" y="100"/>
    </visualElement>
  </visualElements>
  <wires/>
</circuit>`;
    const circuit = parseDigXml(xml);

    // mux.dig version 1 → gets migrated to 2, but we check the reference was resolved.
    // The second Not element uses an XML reference to the first Not's rotation.
    const notElements = circuit.visualElements.filter((ve) => ve.elementName === "Not");
    expect(notElements).toHaveLength(2);

    const secondNot = notElements[1];
    const rotEntry = secondNot.elementAttributes.find((e) => e.key === "rotation");
    expect(rotEntry).not.toBeUndefined();
    // Should resolve to the same value as the first Not — rotation 3
    expect(rotEntry!.value).toEqual({ type: "rotation", value: 3 });
  });

  it("parsesInputCount", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<circuit>
  <version>2</version>
  <attributes/>
  <visualElements>
    <visualElement>
      <elementName>And</elementName>
      <elementAttributes>
        <entry>
          <string>Inputs</string>
          <int>3</int>
        </entry>
      </elementAttributes>
      <pos x="100" y="100"/>
    </visualElement>
    <visualElement>
      <elementName>And</elementName>
      <elementAttributes>
        <entry>
          <string>Inputs</string>
          <int>3</int>
        </entry>
      </elementAttributes>
      <pos x="200" y="100"/>
    </visualElement>
    <visualElement>
      <elementName>And</elementName>
      <elementAttributes>
        <entry>
          <string>Inputs</string>
          <int>3</int>
        </entry>
      </elementAttributes>
      <pos x="300" y="100"/>
    </visualElement>
    <visualElement>
      <elementName>And</elementName>
      <elementAttributes>
        <entry>
          <string>Inputs</string>
          <int>3</int>
        </entry>
      </elementAttributes>
      <pos x="400" y="100"/>
    </visualElement>
  </visualElements>
  <wires/>
</circuit>`;
    const circuit = parseDigXml(xml);

    // And gates in mux.dig have Inputs: 3
    // mux.dig has exactly 4 And elements, each with Inputs: 3
    const andElements = circuit.visualElements.filter((ve) => ve.elementName === "And");
    expect(andElements).toHaveLength(4);

    for (const andEl of andElements) {
      const inputsEntry = andEl.elementAttributes.find((e) => e.key === "Inputs");
      expect(inputsEntry).not.toBeUndefined();
      expect(inputsEntry!.value).toEqual({ type: "int", value: 3 });
    }
  });

  it("parsesColor", () => {
    // Build a minimal XML with an awt-color element to test color parsing.
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<circuit>
  <version>2</version>
  <attributes/>
  <visualElements>
    <visualElement>
      <elementName>LED</elementName>
      <elementAttributes>
        <entry>
          <string>Color</string>
          <awt-color>
            <red>255</red>
            <green>0</green>
            <blue>128</blue>
            <alpha>255</alpha>
          </awt-color>
        </entry>
      </elementAttributes>
      <pos x="100" y="100"/>
    </visualElement>
  </visualElements>
  <wires/>
</circuit>`;

    const circuit = parseDigXml(xml);
    const led = circuit.visualElements.find((ve) => ve.elementName === "LED");
    expect(led).not.toBeUndefined();

    const colorEntry = led!.elementAttributes.find((e) => e.key === "Color");
    expect(colorEntry).not.toBeUndefined();
    expect(colorEntry!.value.type).toBe("color");
    // Assert unconditionally — type was verified above
    expect((colorEntry!.value as { type: "color"; value: { r: number; g: number; b: number; a: number } }).value).toEqual({ r: 255, g: 0, b: 128, a: 255 });
  });

  it("migratesVersion0", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<circuit>
  <version>0</version>
  <attributes/>
  <visualElements>
    <visualElement>
      <elementName>In</elementName>
      <elementAttributes/>
      <pos x="100" y="100"/>
    </visualElement>
  </visualElements>
  <wires>
    <wire>
      <p1 x="50" y="60"/>
      <p2 x="70" y="80"/>
    </wire>
  </wires>
</circuit>`;

    const circuit = parseDigXml(xml);

    expect(circuit.version).toBe(2);

    // Coordinates doubled: (100,100) → (200,200)
    expect(circuit.visualElements[0].pos).toEqual({ x: 200, y: 200 });

    // Wire endpoints doubled
    expect(circuit.wires[0].p1).toEqual({ x: 100, y: 120 });
    expect(circuit.wires[0].p2).toEqual({ x: 140, y: 160 });
  });

  it("handlesEmptyCircuit", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<circuit>
  <version>2</version>
  <attributes/>
  <visualElements/>
  <wires/>
</circuit>`;

    const circuit = parseDigXml(xml);

    expect(circuit.version).toBe(2);
    expect(circuit.visualElements).toEqual([]);
    expect(circuit.wires).toEqual([]);
    expect(circuit.attributes).toEqual([]);
    expect(circuit.measurementOrdering).toBeUndefined();
  });

  it("domParserNodeJs", () => {
    // Verify createDomParser() returns a working parser in Node.js.
    const parser = createDomParser();
    expect(typeof parser.parse).toBe("function");

    const doc = parser.parse("<root><child>hello</child></root>");
    expect(doc).not.toBeNull();

    const root = doc.documentElement;
    expect(root.tagName).toBe("root");

    // Find the child element.
    let childEl: Element | null = null;
    let node = root.firstChild;
    while (node) {
      if (node.nodeType === 1) {
        childEl = node as Element;
        break;
      }
      node = node.nextSibling;
    }
    expect(childEl).not.toBeNull();
    expect(childEl!.tagName).toBe("child");
    expect((childEl!.textContent ?? "").trim()).toBe("hello");
  });

  it("migrateVersionLeavesV2Unchanged", () => {
    const circuit: DigCircuit = {
      version: 2,
      attributes: [],
      visualElements: [
        {
          elementName: "In",
          elementAttributes: [],
          pos: { x: 100, y: 200 },
        },
      ],
      wires: [{ p1: { x: 10, y: 20 }, p2: { x: 30, y: 40 } }],
    };

    const result = migrateVersion(circuit);
    expect(result).toBe(circuit); // same reference — no mutation
    expect(result.version).toBe(2);
    expect(result.visualElements[0].pos).toEqual({ x: 100, y: 200 });
  });

  it("migrateVersionFrom1", () => {
    const circuit: DigCircuit = {
      version: 1,
      attributes: [],
      visualElements: [
        {
          elementName: "In",
          elementAttributes: [],
          pos: { x: 80, y: 90 },
        },
      ],
      wires: [{ p1: { x: 10, y: 20 }, p2: { x: 30, y: 40 } }],
    };

    const result = migrateVersion(circuit);
    // Version 1 → 2: no coordinate doubling, just version bump.
    expect(result.version).toBe(2);
    expect(result.visualElements[0].pos).toEqual({ x: 80, y: 90 });
    expect(result.wires[0].p1).toEqual({ x: 10, y: 20 });
  });

  it("parseAttributeValueHandlesAllTypes", () => {
    // Test parseAttributeValue by constructing a minimal XML doc with each value type.
    const parser = createDomParser();

    // string
    const strDoc = parser.parse("<root><string>hello</string></root>");
    const strEl = strDoc.documentElement.firstChild as Element;
    expect(parseAttributeValue(strEl, strDoc.documentElement)).toEqual({
      type: "string",
      value: "hello",
    });

    // int
    const intDoc = parser.parse("<root><int>42</int></root>");
    const intEl = intDoc.documentElement.firstChild as Element;
    expect(parseAttributeValue(intEl, intDoc.documentElement)).toEqual({
      type: "int",
      value: 42,
    });

    // long
    const longDoc = parser.parse("<root><long>9007199254740993</long></root>");
    const longEl = longDoc.documentElement.firstChild as Element;
    expect(parseAttributeValue(longEl, longDoc.documentElement)).toEqual({
      type: "long",
      value: 9007199254740993n,
    });

    // boolean
    const boolDoc = parser.parse("<root><boolean>true</boolean></root>");
    const boolEl = boolDoc.documentElement.firstChild as Element;
    expect(parseAttributeValue(boolEl, boolDoc.documentElement)).toEqual({
      type: "boolean",
      value: true,
    });

    // rotation
    const rotDoc = parser.parse('<root><rotation rotation="2"/></root>');
    const rotEl = rotDoc.documentElement.firstChild as Element;
    expect(parseAttributeValue(rotEl, rotDoc.documentElement)).toEqual({
      type: "rotation",
      value: 2,
    });

    // inValue
    const inValDoc = parser.parse('<root><value v="255" z="false"/></root>');
    const inValEl = inValDoc.documentElement.firstChild as Element;
    expect(parseAttributeValue(inValEl, inValDoc.documentElement)).toEqual({
      type: "inValue",
      value: { value: 255n, highZ: false },
    });

    // enum (unknown tag)
    const enumDoc = parser.parse("<root><someNewType>foo</someNewType></root>");
    const enumEl = enumDoc.documentElement.firstChild as Element;
    expect(parseAttributeValue(enumEl, enumDoc.documentElement)).toEqual({
      type: "enum",
      xmlTag: "someNewType",
      value: "foo",
    });
  });
});
