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
import type { AnalogElement, LoadContext } from "../../element.js";
import type { StatePool } from "../../state-pool.js";

describe("BJT_MAPPING companion current slots", () => {
  it("slotToNgspice maps CQBE to offset 9", () => {
    expect(BJT_MAPPING.slotToNgspice["CQBE"]).toBe(9);
  });
  it("slotToNgspice maps CQBC to offset 11", () => {
    expect(BJT_MAPPING.slotToNgspice["CQBC"]).toBe(11);
  });
  it("slotToNgspice maps CQSUB to offset 13", () => {
    expect(BJT_MAPPING.slotToNgspice["CQSUB"]).toBe(13);
  });
  it("ngspiceToSlot maps offset 9 to CQBE", () => {
    expect(BJT_MAPPING.ngspiceToSlot[9]).toBe("CQBE");
  });
  it("ngspiceToSlot maps offset 11 to CQBC", () => {
    expect(BJT_MAPPING.ngspiceToSlot[11]).toBe("CQBC");
  });
  it("ngspiceToSlot maps offset 13 to CQSUB", () => {
    expect(BJT_MAPPING.ngspiceToSlot[13]).toBe("CQSUB");
  });
  it("slotToNgspice and ngspiceToSlot are consistent for CQ slots", () => {
    for (const [slot, offset] of Object.entries(BJT_MAPPING.slotToNgspice)) {
      if (slot.startsWith("CQ") && offset !== null) {
        expect(BJT_MAPPING.ngspiceToSlot[offset]).toBe(slot);
      }
    }
  });
  it("CQ slots do not conflict with Q slots", () => {
    expect(BJT_MAPPING.ngspiceToSlot[8]).toBe("QBE");
    expect(BJT_MAPPING.ngspiceToSlot[10]).toBe("QBC");
    expect(BJT_MAPPING.ngspiceToSlot[12]).toBe("QSUB");
  });
  it("DEVICE_MAPPINGS registry bjt entry has CQ slots", () => {
    const mapping = DEVICE_MAPPINGS["bjt"];
    expect(mapping).toBeDefined();
    expect(mapping.slotToNgspice["CQBE"]).toBe(9);
    expect(mapping.slotToNgspice["CQBC"]).toBe(11);
    expect(mapping.slotToNgspice["CQSUB"]).toBe(13);
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
    load: (_ctx: LoadContext) => void 0, isNonlinear: false, isReactive: false,
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
    expect(generateSpiceNetlist(compiled, new Map([[0, "R1"]]))).toContain("R1 1 2 4700");
  });

  it("capacitor: C prefix and value", () => {
    const props = new PropertyBag();
    props.setModelParam("capacitance", 1e-6);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("Capacitor", props)]]),
    );
    expect(generateSpiceNetlist(compiled, new Map([[0, "C1"]]))).toContain("C1 1 0");
  });

  it("inductor: L prefix and value", () => {
    const props = new PropertyBag();
    props.setModelParam("inductance", 1e-3);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("Inductor", props)]]),
    );
    expect(generateSpiceNetlist(compiled, new Map([[0, "L1"]]))).toContain("L1 1 0");
  });

  it("DcVoltageSource: V prefix with DC keyword", () => {
    const props = new PropertyBag();
    props.setModelParam("voltage", 5);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("DcVoltageSource", props)]]),
    );
    expect(generateSpiceNetlist(compiled, new Map([[0, "V1"]]))).toContain("V1 0 1 DC 5");
  });

  it("AcVoltageSource sine: emits SIN transient specifier", () => {
    const props = new PropertyBag();
    props.setModelParam("amplitude", 1.5);
    props.setModelParam("dcOffset", 0.5);
    props.setModelParam("frequency", 1000);
    props.setModelParam("phase", 0);
    props.set("waveform", "sine");
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("AcVoltageSource", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, new Map([[0, "VAC"]]));
    // Should emit SIN(VO VA FREQ TD THETA PHASE_DEG), NOT the old "DC 0.5 AC 1.5"
    expect(netlist).toContain("VAC 0 1 SIN(0.5 1.5 1000 0 0 0)");
    expect(netlist).not.toContain("DC 0.5 AC 1.5");
  });

  it("AcVoltageSource sine with non-zero phase: converts radians to degrees", () => {
    const props = new PropertyBag();
    props.setModelParam("amplitude", 2);
    props.setModelParam("dcOffset", 0);
    props.setModelParam("frequency", 500);
    props.setModelParam("phase", Math.PI / 2); // 90 degrees
    props.set("waveform", "sine");
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("AcVoltageSource", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, new Map([[0, "Vin"]]));
    expect(netlist).toContain("Vin 0 1 SIN(0 2 500 0 0 90)");
  });

  it("AcVoltageSource square: emits PULSE transient specifier", () => {
    // dcOffset=1.9, amplitude=0.1, frequency=1000, riseTime=1e-9, fallTime=1e-9, phase=0
    // ngspice PULSE semantics:
    //   period = 1e-3, halfPeriod = 5e-4
    //   phaseShift = 0 / (2π*1000) = 0
    //   TD = ((-0 % 1e-3) + 1e-3) % 1e-3 = 0
    //   PW = halfPeriod - riseTime = 5e-4 - 1e-9 = 4.99999e-4
    //   V1 = 1.9 - 0.1 = 1.7999999999999998, V2 = 2.0
    const props = new PropertyBag();
    props.setModelParam("amplitude", 0.1);
    props.setModelParam("dcOffset", 1.9);
    props.setModelParam("frequency", 1000);
    props.setModelParam("phase", 0);
    props.setModelParam("riseTime", 1e-9);
    props.setModelParam("fallTime", 1e-9);
    props.set("waveform", "square");
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("AcVoltageSource", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, new Map([[0, "Vin"]]));
    // V1 = 1.9 - 0.1 = 1.7999999999999998 (floating point), V2 = 2, PER = 0.001
    expect(netlist).toContain("Vin 0 1 PULSE(");
    expect(netlist).toContain("1.7999999999999998"); // V1 = dc - amp (floating point)
    expect(netlist).toContain("1e-9");  // TR and TF
    expect(netlist).toContain("0.001)"); // PER at end of PULSE args
    expect(netlist).not.toContain("DC 1.9 AC 0.1");
  });

  it("AcVoltageSource square: V1/V2 values and PER are exact", () => {
    // Verify the exact PULSE string for a simple square wave with phase=0
    const props = new PropertyBag();
    props.setModelParam("amplitude", 5);
    props.setModelParam("dcOffset", 0);
    props.setModelParam("frequency", 1000);
    props.setModelParam("phase", 0);
    props.setModelParam("riseTime", 0);
    props.setModelParam("fallTime", 0);
    props.set("waveform", "square");
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("AcVoltageSource", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, new Map([[0, "Vsq"]]));
    // period=0.001, halfPeriod=0.0005
    // riseTime=0, fallTime=0
    // phaseShift=0, rawTD=-0, td=(0%0.001+0.001)%0.001=0
    // PW = 0.0005 - 0 - 0 = 0.0005
    expect(netlist).toContain("Vsq 0 1 PULSE(-5 5 0 0 0 0.0005 0.001)");
  });

  it("DcCurrentSource: I prefix with DC keyword", () => {
    const props = new PropertyBag();
    props.setModelParam("current", 0.01);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("DcCurrentSource", props)]]),
    );
    expect(generateSpiceNetlist(compiled, new Map([[0, "I1"]]))).toContain("I1 1 0 DC 0.01");
  });

  it("AcCurrentSource square: emits PULSE transient specifier with correct values", () => {
    // amplitude=2, dcOffset=0, frequency=1000, riseTime=0, fallTime=0, phase=0
    // period=0.001, halfPeriod=0.0005
    // phaseShift=0, rawTD=0, td=0
    // PW = 0.0005 - 0 - 0 = 0.0005
    // V1 = 0-2 = -2, V2 = 0+2 = 2
    // pins: [neg=1, pos=0] → posNode=nodes[1]=0, negNode=nodes[0]=1
    const props = new PropertyBag();
    props.setModelParam("amplitude", 2);
    props.setModelParam("dcOffset", 0);
    props.setModelParam("frequency", 1000);
    props.setModelParam("phase", 0);
    props.setModelParam("riseTime", 0);
    props.setModelParam("fallTime", 0);
    props.set("waveform", "square");
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("AcCurrentSource", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, new Map([[0, "Iac"]]));
    expect(netlist).toContain("Iac 0 1 PULSE(-2 2 0 0 0 0.0005 0.001)");
    expect(netlist).not.toContain("AC 2");
  });

  it("AcCurrentSource sine with phase=0: emits SIN specifier", () => {
    const props = new PropertyBag();
    props.setModelParam("amplitude", 1.5);
    props.setModelParam("dcOffset", 0);
    props.setModelParam("frequency", 500);
    props.setModelParam("phase", 0);
    props.set("waveform", "sine");
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("AcCurrentSource", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, new Map([[0, "Iac"]]));
    expect(netlist).toContain("Iac 0 1 SIN(0 1.5 500 0 0 0)");
    expect(netlist).not.toContain("AC 1.5");
  });

  it("AcCurrentSource sine with phase=π/2: converts radians to degrees (90°)", () => {
    const props = new PropertyBag();
    props.setModelParam("amplitude", 3);
    props.setModelParam("dcOffset", 0);
    props.setModelParam("frequency", 1000);
    props.setModelParam("phase", Math.PI / 2);
    props.set("waveform", "sine");
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("AcCurrentSource", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, new Map([[0, "Iac"]]));
    expect(netlist).toContain("Iac 0 1 SIN(0 3 1000 0 0 90)");
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
    expect(r).toContain("Q1 2 3 1 Q1_NPN");
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
    expect(r).toContain("Q2 2 3 1 Q2_PNP");
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
    expect(r).toContain("D1 2 0 D1_D");
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
    expect(r).toContain("M1 1 3 2 2 M1_NMOS");
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
    expect(r).toContain("J1 1 3 2 J1_NMF");
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
    expect(r).toContain("J2 1 3 2 J2_PMF");
    expect(r).toContain(".model J2_PMF PMF");
  });

  it("falls back to element_N label when elementLabels has no entry", () => {
    const props = new PropertyBag();
    props.setModelParam("resistance", 1000);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("Resistor", props)]]),
    );
    expect(generateSpiceNetlist(compiled, new Map())).toContain("element_0 1 0");
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

