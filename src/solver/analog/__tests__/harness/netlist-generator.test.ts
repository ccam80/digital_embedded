/**
 * Tests for Item 5 (BJT companion current mapping) and Item 12 (netlist generator).
 */
import { describe, it, expect } from "vitest";
import { BJT_MAPPING, DEVICE_MAPPINGS } from "./device-mappings.js";
import { generateSpiceNetlist } from "./netlist-generator.js";
import type { ConcreteCompiledAnalogCircuit } from "../../compiled-analog-circuit.js";
import { PropertyBag } from "../../../../core/properties.js";
import { AbstractCircuitElement } from "../../../../core/element.js";
import type { RenderContext } from "../../../../core/element.js";
import type { Pin } from "../../../../core/pin.js";
import type { AnalogElement } from "../../element.js";
import type { StatePool } from "../../state-pool.js";

describe("BJT_MAPPING companion current slots", () => {
  it("slotToNgspice maps CCAP_BE to offset 9", () => {
    expect(BJT_MAPPING.slotToNgspice["CCAP_BE"]).toBe(9);
  });
  it("slotToNgspice maps CCAP_BC to offset 11", () => {
    expect(BJT_MAPPING.slotToNgspice["CCAP_BC"]).toBe(11);
  });
  it("slotToNgspice maps CCAP_CS to offset 13", () => {
    expect(BJT_MAPPING.slotToNgspice["CCAP_CS"]).toBe(13);
  });
  it("ngspiceToSlot maps offset 9 to CCAP_BE", () => {
    expect(BJT_MAPPING.ngspiceToSlot[9]).toBe("CCAP_BE");
  });
  it("ngspiceToSlot maps offset 11 to CCAP_BC", () => {
    expect(BJT_MAPPING.ngspiceToSlot[11]).toBe("CCAP_BC");
  });
  it("ngspiceToSlot maps offset 13 to CCAP_CS", () => {
    expect(BJT_MAPPING.ngspiceToSlot[13]).toBe("CCAP_CS");
  });
  it("slotToNgspice and ngspiceToSlot are consistent for CCAP slots", () => {
    for (const [slot, offset] of Object.entries(BJT_MAPPING.slotToNgspice)) {
      if (slot.startsWith("CCAP_") && offset !== null) {
        expect(BJT_MAPPING.ngspiceToSlot[offset]).toBe(slot);
      }
    }
  });
  it("CCAP slots do not conflict with Q slots", () => {
    expect(BJT_MAPPING.ngspiceToSlot[8]).toBe("Q_BE");
    expect(BJT_MAPPING.ngspiceToSlot[10]).toBe("Q_BC");
    expect(BJT_MAPPING.ngspiceToSlot[12]).toBe("Q_CS");
  });
  it("DEVICE_MAPPINGS registry bjt entry has CCAP slots", () => {
    const mapping = DEVICE_MAPPINGS["bjt"];
    expect(mapping).toBeDefined();
    expect(mapping.slotToNgspice["CCAP_BE"]).toBe(9);
    expect(mapping.slotToNgspice["CCAP_BC"]).toBe(11);
    expect(mapping.slotToNgspice["CCAP_CS"]).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// Item 12: Netlist generator tests
// ---------------------------------------------------------------------------

class TestCircuitElement extends AbstractCircuitElement {
  constructor(typeId: string, props: PropertyBag) {
    super(typeId, "test-" + typeId, { x: 0, y: 0 }, 0, false, props);
  }
  getPins(): readonly Pin[] { return []; }
  draw(_ctx: RenderContext): void {}
  getBoundingBox() { return { x: 0, y: 0, width: 0, height: 0 }; }
}

function makeAnalogEl(pinNodeIds: number[]): AnalogElement {
  return {
    pinNodeIds, allNodeIds: pinNodeIds, branchIndex: -1,
    stampLinear: () => {}, stampNonlinear: () => {},
    updateOperatingPoint: () => {}, isLinear: true, isReactive: false,
    label: "test", stateSchema: { slots: [] }, stateBaseOffset: 0,
    stateSize: 0, initState: () => {}, getPinCurrents: () => [],
    setParam: () => {}, isPoolBacked: false,
  } as unknown as AnalogElement;
}

type CEMap = Map<number, import("../../../../core/element.js").CircuitElement>;

function makeCompiled(elements: AnalogElement[], ce: CEMap): ConcreteCompiledAnalogCircuit {
  return {
    nodeCount: 3, branchCount: 1, matrixSize: 4,
    elements, labelToNodeId: new Map(), labelPinNodes: new Map(),
    wireToNodeId: new Map(), models: new Map(), elementToCircuitElement: ce,
    elementPinVertices: new Map(), elementResolvedPins: new Map(),
    groupToNodeId: new Map(), elementBridgeAdapters: new Map(),
    bridgeAdaptersByGroupId: new Map(), diagnostics: [],
    timeRef: { value: 0 }, statePool: null as unknown as StatePool,
    netCount: 3, componentCount: elements.length, elementCount: elements.length,
  } as unknown as ConcreteCompiledAnalogCircuit;
}

describe("generateSpiceNetlist", () => {
  it("title line is first line", () => {
    const r = generateSpiceNetlist(makeCompiled([], new Map()), new Map(), "Test");
    expect(r.split("\n")[0]).toBe("Test");
  });

  it("uses default title when not provided", () => {
    const r = generateSpiceNetlist(makeCompiled([], new Map()), new Map());
    expect(r.split("\n")[0]).toBe("Auto-generated netlist");
  });

  it("always ends with .end", () => {
    const ls = generateSpiceNetlist(makeCompiled([], new Map()), new Map()).split("\n");
    expect(ls[ls.length - 1]).toBe(".end");
  });

  it("resistor: R prefix, both nodes, value from model param", () => {
    const props = new PropertyBag();
    props.setModelParam("resistance", 4700);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 2])],
      new Map([[0, new TestCircuitElement("Resistor", props)]]),
    );
    expect(generateSpiceNetlist(compiled, new Map([[0, "R1"]]))).toContain("RR1 1 2 4700");
  });

  it("capacitor: C prefix and value", () => {
    const props = new PropertyBag();
    props.setModelParam("capacitance", 1e-6);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("Capacitor", props)]]),
    );
    expect(generateSpiceNetlist(compiled, new Map([[0, "C1"]]))).toContain("CC1 1 0");
  });

  it("inductor: L prefix and value", () => {
    const props = new PropertyBag();
    props.setModelParam("inductance", 1e-3);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("Inductor", props)]]),
    );
    expect(generateSpiceNetlist(compiled, new Map([[0, "L1"]]))).toContain("LL1 1 0");
  });

  it("DcVoltageSource: V prefix with DC keyword", () => {
    const props = new PropertyBag();
    props.setModelParam("voltage", 5);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("DcVoltageSource", props)]]),
    );
    expect(generateSpiceNetlist(compiled, new Map([[0, "V1"]]))).toContain("VV1 1 0 DC 5");
  });

  it("AcVoltageSource: DC and AC fields", () => {
    const props = new PropertyBag();
    props.setModelParam("amplitude", 1.5);
    props.setModelParam("dcOffset", 0.5);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("AcVoltageSource", props)]]),
    );
    expect(generateSpiceNetlist(compiled, new Map([[0, "VAC"]]))).toContain("VVAC 1 0 DC 0.5 AC 1.5");
  });

  it("DcCurrentSource: I prefix with DC keyword", () => {
    const props = new PropertyBag();
    props.setModelParam("current", 0.01);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("DcCurrentSource", props)]]),
    );
    expect(generateSpiceNetlist(compiled, new Map([[0, "I1"]]))).toContain("II1 1 0 DC 0.01");
  });

  it("NpnBJT: Q prefix, 3 nodes, NPN model card with params", () => {
    const props = new PropertyBag();
    props.setModelParam("BF", 100);
    props.setModelParam("IS", 1e-14);
    const compiled = makeCompiled(
      [makeAnalogEl([3, 2, 1])],
      new Map([[0, new TestCircuitElement("NpnBJT", props)]]),
    );
    const r = generateSpiceNetlist(compiled, new Map([[0, "Q1"]]));
    expect(r).toContain("QQ1 3 2 1 Q1_NPN");
    expect(r).toContain(".model Q1_NPN NPN");
    expect(r).toContain("BF=100");
    expect(r).toContain("IS=1e-14");
  });

  it("PnpBJT: Q prefix, PNP model type", () => {
    const props = new PropertyBag();
    props.setModelParam("BF", 80);
    const compiled = makeCompiled(
      [makeAnalogEl([3, 2, 1])],
      new Map([[0, new TestCircuitElement("PnpBJT", props)]]),
    );
    const r = generateSpiceNetlist(compiled, new Map([[0, "Q2"]]));
    expect(r).toContain("QQ2 3 2 1 Q2_PNP");
    expect(r).toContain(".model Q2_PNP PNP");
  });

  it("Diode: D prefix, A K nodes, model card", () => {
    const props = new PropertyBag();
    props.setModelParam("IS", 1e-14);
    const compiled = makeCompiled(
      [makeAnalogEl([2, 0])],
      new Map([[0, new TestCircuitElement("Diode", props)]]),
    );
    const r = generateSpiceNetlist(compiled, new Map([[0, "D1"]]));
    expect(r).toContain("DD1 2 0 D1_D");
    expect(r).toContain(".model D1_D D");
  });

  it("NMOS: M prefix, 4 nodes, NMOS model type", () => {
    const props = new PropertyBag();
    props.setModelParam("W", 10e-6);
    props.setModelParam("L", 1e-6);
    const compiled = makeCompiled(
      [makeAnalogEl([3, 2, 1, 0])],
      new Map([[0, new TestCircuitElement("NMOS", props)]]),
    );
    const r = generateSpiceNetlist(compiled, new Map([[0, "M1"]]));
    expect(r).toContain("MM1 3 2 1 0 M1_NMOS");
    expect(r).toContain(".model M1_NMOS NMOS");
  });

  it("NJFET: J prefix, NMF model type", () => {
    const props = new PropertyBag();
    props.setModelParam("IDSS", 0.01);
    const compiled = makeCompiled(
      [makeAnalogEl([3, 2, 1])],
      new Map([[0, new TestCircuitElement("NJFET", props)]]),
    );
    const r = generateSpiceNetlist(compiled, new Map([[0, "J1"]]));
    expect(r).toContain("JJ1 3 2 1 J1_NMF");
    expect(r).toContain(".model J1_NMF NMF");
  });

  it("PJFET: J prefix, PMF model type", () => {
    const props = new PropertyBag();
    props.setModelParam("IDSS", 0.005);
    const compiled = makeCompiled(
      [makeAnalogEl([3, 2, 1])],
      new Map([[0, new TestCircuitElement("PJFET", props)]]),
    );
    const r = generateSpiceNetlist(compiled, new Map([[0, "J2"]]));
    expect(r).toContain("JJ2 3 2 1 J2_PMF");
    expect(r).toContain(".model J2_PMF PMF");
  });

  it("falls back to element_N label when elementLabels has no entry", () => {
    const props = new PropertyBag();
    props.setModelParam("resistance", 1000);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("Resistor", props)]]),
    );
    expect(generateSpiceNetlist(compiled, new Map())).toContain("Relement_0");
  });

  it("skips elements with no circuitElement entry", () => {
    const compiled = makeCompiled([makeAnalogEl([1, 0])], new Map());
    const ls = generateSpiceNetlist(compiled, new Map([[0, "X1"]])).split("\n");
    expect(ls).toHaveLength(2);
  });

  it("skips unknown typeId", () => {
    const props = new PropertyBag();
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("UnknownThing", props)]]),
    );
    const ls = generateSpiceNetlist(compiled, new Map([[0, "X1"]])).split("\n");
    expect(ls).toHaveLength(2);
  });

  it("model card has no parens when no model params set", () => {
    const props = new PropertyBag();
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("Diode", props)]]),
    );
    const r = generateSpiceNetlist(compiled, new Map([[0, "D1"]]));
    expect(r).toContain(".model D1_D D");
    expect(r).not.toContain("(");
  });
});