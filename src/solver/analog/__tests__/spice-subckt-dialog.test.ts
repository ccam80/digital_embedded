/**
 * Headless tests for the .SUBCKT import flow (W11.2).
 *
 * Verifies:
 * 1. parseSubcircuit() → buildSpiceSubcircuit() → produces a valid Circuit
 * 2. applySpiceSubcktImportResult() registers in SubcircuitModelRegistry
 * 3. simulationModel property is set on the element to the subcircuit name
 * 4. Invalid .SUBCKT text throws a parse error (not stored)
 * 5. Port count and element count are correct after build
 */

import { describe, it, expect } from "vitest";
import { parseSubcircuit } from "../model-parser.js";
import type { ParsedSubcircuit } from "../model-parser.js";
import { buildSpiceSubcircuit } from "../../../io/spice-model-builder.js";
import { applySpiceSubcktImportResult } from "../../../app/spice-model-apply.js";
import { SubcircuitModelRegistry } from "../subcircuit-model-registry.js";
import { Circuit } from "../../../core/circuit.js";
import type { MnaSubcircuitNetlist, SubcircuitElement } from "../../../core/mna-subcircuit-netlist.js";
import { PropertyBag } from "../../../core/properties.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { CircuitElement } from "../../../core/element.js";
import type { Pin } from "../../../core/pin.js";
import { PinDirection } from "../../../core/pin.js";
import type { Rect, RenderContext } from "../../../core/renderer-interface.js";
import type { SerializedElement } from "../../../core/element.js";

function makeNetlist(parsed: ParsedSubcircuit): MnaSubcircuitNetlist {
  const typeMap: Record<string, string> = {
    R: 'Resistor', C: 'Capacitor', L: 'Inductor',
    D: 'Diode', Q: 'NpnBJT', M: 'NMOS',
  };
  return {
    ports: parsed.ports,
    elements: parsed.elements.map((e): SubcircuitElement => {
      const el: SubcircuitElement = { typeId: typeMap[e.type] ?? e.type };
      if (e.modelName !== undefined) el.modelRef = e.modelName;
      return el;
    }),
    internalNetCount: 0,
    netlist: parsed.elements.map(() => []),
  };
}

// ---------------------------------------------------------------------------
// Minimal element builder
// ---------------------------------------------------------------------------

function makePin(x: number, y: number, label = ""): Pin {
  return {
    position: { x, y },
    label,
    direction: PinDirection.BIDIRECTIONAL,
    isInverted: false,
    isClock: false,
    bitWidth: 1,
  };
}

function makeElement(
  typeId: string,
  instanceId: string,
  pins: Array<{ x: number; y: number; label?: string }>,
  propsMap: Map<string, PropertyValue> = new Map(),
): CircuitElement {
  const resolvedPins = pins.map((p) => makePin(p.x, p.y, p.label ?? ""));
  const propertyBag = new PropertyBag(propsMap.entries());
  const serialized: SerializedElement = {
    typeId,
    instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as SerializedElement["rotation"],
    mirror: false,
    properties: {},
  };
  return {
    typeId,
    instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as CircuitElement["rotation"],
    mirror: false,
    getPins() { return resolvedPins; },
    getProperties() { return propertyBag; },
    getBoundingBox(): Rect { return { x: 0, y: 0, width: 10, height: 10 }; },
    draw(_ctx: RenderContext) { },
    serialize() { return serialized; },
    getAttribute(k: string) { return propsMap.get(k); },
  };
}

// ---------------------------------------------------------------------------
// Sample .SUBCKT text
// ---------------------------------------------------------------------------

const SIMPLE_SUBCKT = `
.SUBCKT MYBJT C B E
Q1 C B E MYMODEL
.MODEL MYMODEL NPN(IS=1e-14 BF=200)
.ENDS MYBJT
`.trim();

const RESISTOR_SUBCKT = `
.SUBCKT RDIV IN OUT GND
R1 IN OUT 1K
R2 OUT GND 1K
.ENDS RDIV
`.trim();

const OPAMP_SUBCKT = `
.SUBCKT OPAMP INP INN OUT VCC VEE
* simple voltage-controlled voltage source model
Q1 OUT INP INN NMOD
Q2 OUT INN INP PMOD
.MODEL NMOD NPN(IS=1e-15 BF=100)
.MODEL PMOD PNP(IS=1e-15 BF=100)
.ENDS OPAMP
`.trim();

// ---------------------------------------------------------------------------
// Tests: parseSubcircuit
// ---------------------------------------------------------------------------

describe("spice-subckt-dialog: parseSubcircuit", () => {
  it("parses a simple BJT subcircuit with name and ports", () => {
    const parsed = parseSubcircuit(SIMPLE_SUBCKT);

    expect(parsed.name).toBe("MYBJT");
    expect(parsed.ports).toEqual(["C", "B", "E"]);
    expect(parsed.elements.length).toBe(1);
    expect(parsed.elements[0].name).toBe("Q1");
    expect(parsed.elements[0].type).toBe("Q");
  });

  it("parses inline .MODEL statements inside the subcircuit", () => {
    const parsed = parseSubcircuit(SIMPLE_SUBCKT);

    expect(parsed.models.length).toBe(1);
    expect(parsed.models[0].name).toBe("MYMODEL");
    expect(parsed.models[0].deviceType).toBe("NPN");
    expect(parsed.models[0].params["IS"]).toBe(1e-14);
    expect(parsed.models[0].params["BF"]).toBe(200);
  });

  it("parses a resistor divider subcircuit with 2 elements", () => {
    const parsed = parseSubcircuit(RESISTOR_SUBCKT);

    expect(parsed.name).toBe("RDIV");
    expect(parsed.ports).toEqual(["IN", "OUT", "GND"]);
    expect(parsed.elements.length).toBe(2);
    expect(parsed.elements[0].type).toBe("R");
    expect(parsed.elements[1].type).toBe("R");
  });

  it("parses an op-amp subcircuit with 5 ports and 2 inline models", () => {
    const parsed = parseSubcircuit(OPAMP_SUBCKT);

    expect(parsed.name).toBe("OPAMP");
    expect(parsed.ports.length).toBe(5);
    expect(parsed.models.length).toBe(2);
  });

  it("throws ParseError for text missing .SUBCKT header", () => {
    expect(() => parseSubcircuit(".MODEL 2N2222 NPN(IS=1e-14)")).toThrow();
  });

  it("throws ParseError for subcircuit with no ports", () => {
    const text = ".SUBCKT NOPORTS\nR1 A B 1K\n.ENDS";
    expect(() => parseSubcircuit(text)).toThrow();
  });

  it("throws ParseError for subcircuit missing .ENDS", () => {
    const text = ".SUBCKT NOENDSUB A B\nR1 A B 1K";
    expect(() => parseSubcircuit(text)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: buildSpiceSubcircuit
// ---------------------------------------------------------------------------

describe("spice-subckt-dialog: buildSpiceSubcircuit", () => {
  it("builds a Circuit from a parsed subcircuit", () => {
    const parsed = parseSubcircuit(SIMPLE_SUBCKT);
    const circuit = buildSpiceSubcircuit(parsed);

    expect(circuit.elements.length).toBe(parsed.ports.length + parsed.elements.length);
  });

  it("circuit has one interface element per port", () => {
    const parsed = parseSubcircuit(RESISTOR_SUBCKT);
    const circuit = buildSpiceSubcircuit(parsed);

    const interfaceEls = circuit.elements.filter(el => el.typeId === "In");
    expect(interfaceEls.length).toBe(parsed.ports.length);
  });

  it("circuit has one wire per pin of each internal element", () => {
    const parsed = parseSubcircuit(RESISTOR_SUBCKT);
    const circuit = buildSpiceSubcircuit(parsed);

    // RDIV has 2 resistors, each with 2 pins → 4 wires total
    expect(circuit.wires.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Tests: applySpiceSubcktImportResult
// ---------------------------------------------------------------------------

describe("spice-subckt-dialog: applySpiceSubcktImportResult", () => {
  it("registers the netlist in SubcircuitModelRegistry under the subcircuit name", () => {
    const parsed = parseSubcircuit(SIMPLE_SUBCKT);
    const netlist = makeNetlist(parsed);
    const registry = new SubcircuitModelRegistry();
    const metaCircuit = new Circuit();

    const element = makeElement("BJTStub", "q1", [
      { x: 0, y: 0, label: "C" },
      { x: 0, y: 0, label: "B" },
      { x: 0, y: 0, label: "E" },
    ]);

    applySpiceSubcktImportResult(element, { subcktName: parsed.name, netlist }, registry, metaCircuit);

    const stored = registry.get("MYBJT");
    expect(stored!.ports).toEqual(["C", "B", "E"]);
    expect(stored!.elements).toHaveLength(1);
  });

  it("sets simulationModel on the element to the subcircuit name", () => {
    const parsed = parseSubcircuit(SIMPLE_SUBCKT);
    const netlist = makeNetlist(parsed);
    const registry = new SubcircuitModelRegistry();
    const metaCircuit = new Circuit();

    const element = makeElement("BJTStub", "q1", [
      { x: 0, y: 0, label: "C" },
      { x: 0, y: 0, label: "B" },
      { x: 0, y: 0, label: "E" },
    ]);

    applySpiceSubcktImportResult(element, { subcktName: parsed.name, netlist }, registry, metaCircuit);

    expect(element.getProperties().get("simulationModel")).toBe("MYBJT");
  });

  it("re-registering with a new netlist overwrites the old one", () => {
    const parsed1 = parseSubcircuit(SIMPLE_SUBCKT);
    const netlist1 = makeNetlist(parsed1);
    const parsed2 = parseSubcircuit(SIMPLE_SUBCKT);
    const netlist2 = makeNetlist(parsed2);
    const registry = new SubcircuitModelRegistry();
    const metaCircuit = new Circuit();

    const element = makeElement("BJTStub", "q1", [
      { x: 0, y: 0, label: "C" },
      { x: 0, y: 0, label: "B" },
      { x: 0, y: 0, label: "E" },
    ]);

    applySpiceSubcktImportResult(element, { subcktName: "MYBJT", netlist: netlist1 }, registry, metaCircuit);
    applySpiceSubcktImportResult(element, { subcktName: "MYBJT", netlist: netlist2 }, registry, metaCircuit);

    expect(registry.get("MYBJT")).toBe(netlist2);
  });

  it("full flow: parse → make netlist → apply → simulationModel set and netlist registered", () => {
    const subcktText = `
.SUBCKT TESTBJT C B E
Q1 C B E QMOD
.MODEL QMOD NPN(IS=2e-14 BF=150)
.ENDS TESTBJT
    `.trim();

    const parsed = parseSubcircuit(subcktText);
    const netlist = makeNetlist(parsed);
    const registry = new SubcircuitModelRegistry();
    const metaCircuit = new Circuit();

    const element = makeElement("BJTStub", "q1", [
      { x: 0, y: 0, label: "C" },
      { x: 0, y: 0, label: "B" },
      { x: 0, y: 0, label: "E" },
    ]);

    applySpiceSubcktImportResult(element, { subcktName: parsed.name, netlist }, registry, metaCircuit);

    expect(parsed.name).toBe("TESTBJT");
    const stored = registry.get("TESTBJT");
    expect(stored!.ports).toEqual(["C", "B", "E"]);
    expect(element.getProperties().get("simulationModel")).toBe("TESTBJT");
  });

  it("stores MnaSubcircuitNetlist in circuit.metadata.modelDefinitions", () => {
    const parsed = parseSubcircuit(SIMPLE_SUBCKT);
    const netlist = makeNetlist(parsed);
    const registry = new SubcircuitModelRegistry();
    const metaCircuit = new Circuit();

    const element = makeElement("BJTStub", "q1", [
      { x: 0, y: 0, label: "C" },
      { x: 0, y: 0, label: "B" },
      { x: 0, y: 0, label: "E" },
    ]);

    applySpiceSubcktImportResult(element, { subcktName: parsed.name, netlist }, registry, metaCircuit);

    const defs = metaCircuit.metadata.modelDefinitions;
    expect(defs!["MYBJT"].ports).toEqual(["C", "B", "E"]);
    expect(defs!["MYBJT"].elements).toHaveLength(1);
    expect(defs!["MYBJT"].elements[0].typeId).toBe("NpnBJT");
  });
});
