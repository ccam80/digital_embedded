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
import { createDefaultRegistry } from "../../../../components/register-all.js";

const testRegistry = createDefaultRegistry();

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
    const r = generateSpiceNetlist(makeCompiled([], new Map()), testRegistry, new Map(), "Test");
    expect(r.split("\n")[0]).toBe("Test");
  });

  it("uses default title when not provided", () => {
    const r = generateSpiceNetlist(makeCompiled([], new Map()), testRegistry, new Map());
    expect(r.split("\n")[0]).toBe("Auto-generated netlist");
  });

  it("always ends with .end", () => {
    const ls = generateSpiceNetlist(makeCompiled([], new Map()), testRegistry, new Map()).split("\n");
    expect(ls[ls.length - 1]).toBe(".end");
  });

  it("resistor: R prefix, both nodes, value from model param", () => {
    const props = new PropertyBag();
    props.setModelParam("resistance", 4700);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 2])],
      new Map([[0, new TestCircuitElement("Resistor", props)]]),
    );
    expect(generateSpiceNetlist(compiled, testRegistry, new Map([[0, "R1"]]))).toContain("R1 1 2 4700");
  });

  it("capacitor: C prefix and value", () => {
    const props = new PropertyBag();
    props.setModelParam("capacitance", 1e-6);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("Capacitor", props)]]),
    );
    expect(generateSpiceNetlist(compiled, testRegistry, new Map([[0, "C1"]]))).toContain("C1 1 0");
  });

  it("inductor: L prefix and value", () => {
    const props = new PropertyBag();
    props.setModelParam("inductance", 1e-3);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("Inductor", props)]]),
    );
    expect(generateSpiceNetlist(compiled, testRegistry, new Map([[0, "L1"]]))).toContain("L1 1 0");
  });

  it("DcVoltageSource: V prefix with DC keyword", () => {
    const props = new PropertyBag();
    props.setModelParam("voltage", 5);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("DcVoltageSource", props)]]),
    );
    expect(generateSpiceNetlist(compiled, testRegistry, new Map([[0, "V1"]]))).toContain("V1 0 1 DC 5");
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
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "VAC"]]));
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
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "Vin"]]));
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
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "Vin"]]));
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
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "Vsq"]]));
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
    expect(generateSpiceNetlist(compiled, testRegistry, new Map([[0, "I1"]]))).toContain("I1 1 0 DC 0.01");
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
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "Iac"]]));
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
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "Iac"]]));
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
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "Iac"]]));
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
    const r = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "Q1"]]));
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
    const r = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "Q2"]]));
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
    const r = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "D1"]]));
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
    const r = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "M1"]]));
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
    const r = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "J1"]]));
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
    const r = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "J2"]]));
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
    expect(generateSpiceNetlist(compiled, testRegistry, new Map())).toContain("element_0 1 0");
  });

  it("skips elements with no circuitElement entry", () => {
    const compiled = makeCompiled([makeAnalogEl([1, 0])], new Map());
    const ls = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "X1"]])).split("\n");
    expect(ls).toHaveLength(2);
  });

  it("skips unknown typeId", () => {
    const props = new PropertyBag();
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("UnknownThing", props)]]),
    );
    const ls = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "X1"]])).split("\n");
    expect(ls).toHaveLength(2);
  });

  it("model card has no parens when no model params set", () => {
    const props = new PropertyBag();
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("Diode", props)]]),
    );
    const r = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "D1"]]));
    expect(r).toContain(".model D1_D D");
    expect(r).not.toContain("(");
  });

  // -------------------------------------------------------------------------
  // Task 3.1: Schema-driven partition tests
  // -------------------------------------------------------------------------

  it("diode: instance params emit on element line in paramDefs order, NaN dropped", () => {
    const props = new PropertyBag();
    props.setModelParam("AREA", 2);
    props.setModelParam("OFF", 1);
    props.setModelParam("TEMP", 325);
    // IC left at default NaN — should not appear
    const compiled = makeCompiled(
      [makeAnalogEl([1, 2])],
      new Map([[0, new TestCircuitElement("Diode", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "D1"]]));
    // OFF is a bare-flag instance param in ngspice (`OFF=1` produces a hard
    // "unknown parameter" parse error); emitted as a bare keyword instead.
    expect(netlist).toContain("D1 1 2 D1_D AREA=2 OFF TEMP=325");
    expect(netlist).not.toContain("OFF=");
    expect(netlist).not.toContain("IC=");
  });

  it("diode: model card excludes instance keys", () => {
    const props = new PropertyBag();
    props.setModelParam("AREA", 2);
    props.setModelParam("OFF", 1);
    props.setModelParam("TEMP", 325);
    props.setModelParam("IS", 1e-14);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 2])],
      new Map([[0, new TestCircuitElement("Diode", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "D1"]]));
    // Instance params must not appear on .model line
    const modelLine = netlist.split("\n").find(l => l.startsWith(".model D1_D D"))!;
    expect(modelLine).toBeDefined();
    expect(modelLine).not.toContain("OFF=");
    expect(modelLine).not.toContain("AREA=");
    expect(modelLine).not.toContain("TEMP=");
    expect(modelLine).not.toContain("IC=");
    // Model params must appear on .model line
    expect(modelLine).toContain("IS=");
  });

  it("MOSFET NMOS: non-default instance params emit on element line in paramDefs order", () => {
    // Use NON-default values for every emitted param so each token survives
    // the ngspice "drop default" filter. M=1, ICV*=0, OFF=0, TEMP=300.15 are
    // all ngspice defaults and would be silently omitted.
    const props = new PropertyBag();
    props.setModelParam("W", 2e-6);
    props.setModelParam("L", 1e-6);
    props.setModelParam("M", 2);
    props.setModelParam("OFF", 1);          // truthy → bare OFF
    props.setModelParam("ICVDS", 1.5);
    props.setModelParam("ICVGS", 0.7);
    props.setModelParam("ICVBS", -0.2);
    props.setModelParam("TEMP", 350);
    const compiled = makeCompiled(
      [makeAnalogEl([3, 2, 1, 0])],
      new Map([[0, new TestCircuitElement("NMOS", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "M1"]]));
    const elementLine = netlist.split("\n").find(l => l.startsWith("M1 "))!;
    expect(elementLine).toBeDefined();
    const wPos = elementLine.indexOf("W=");
    const lPos = elementLine.indexOf("L=");
    const mPos = elementLine.indexOf("M=");
    const offPos = elementLine.indexOf(" OFF");
    const icPos = elementLine.indexOf("IC=");
    const tempPos = elementLine.indexOf("TEMP=");
    // Non-default instance values appear in the lift order produced by
    // paramDefs.
    expect(wPos).toBeGreaterThan(-1);
    expect(lPos).toBeGreaterThan(wPos);
    expect(mPos).toBeGreaterThan(lPos);
    expect(offPos).toBeGreaterThan(mPos);
    expect(tempPos).toBeGreaterThan(offPos);
    // OFF emits as a bare keyword (ngspice rejects OFF=1).
    expect(elementLine).not.toMatch(/\bOFF=/);
    // ICVDS/ICVGS/ICVBS collapse to a single combined IC=vds,vgs,vbs token.
    expect(icPos).toBeGreaterThan(-1);
    expect(elementLine).toContain("IC=1.5,0.7,-0.2");
    expect(elementLine).not.toContain("ICVDS=");
    expect(elementLine).not.toContain("ICVGS=");
    expect(elementLine).not.toContain("ICVBS=");
  });

  it("MOSFET NMOS: model card excludes W L M ICV* OFF TEMP", () => {
    const props = new PropertyBag();
    props.setModelParam("W", 2e-6);
    props.setModelParam("L", 1e-6);
    props.setModelParam("M", 1);
    props.setModelParam("OFF", 0);
    props.setModelParam("ICVDS", 0);
    props.setModelParam("ICVGS", 0);
    props.setModelParam("ICVBS", 0);
    props.setModelParam("TEMP", 300.15);
    props.setModelParam("VTO", 1.5);
    const compiled = makeCompiled(
      [makeAnalogEl([3, 2, 1, 0])],
      new Map([[0, new TestCircuitElement("NMOS", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "M1"]]));
    const modelLine = netlist.split("\n").find(l => l.startsWith(".model M1_NMOS NMOS"))!;
    expect(modelLine).toBeDefined();
    expect(modelLine).not.toContain("W=");
    expect(modelLine).not.toContain("L=");
    expect(modelLine).not.toContain("M=");
    expect(modelLine).not.toContain("OFF=");
    expect(modelLine).not.toContain("ICVDS=");
    expect(modelLine).not.toContain("ICVGS=");
    expect(modelLine).not.toContain("ICVBS=");
    expect(modelLine).not.toContain("TEMP=");
    expect(modelLine).toContain("VTO=");
  });

  it("BJT NPN spice variant: element line emits non-default instance params; SUBS dropped, OFF bare", () => {
    // Non-default values for everything ngspice will accept; SUBS=1 is set to
    // verify it is dropped (ngspice has no `subs` instance param at all and
    // emits a hard "unknown parameter (subs)" parse error if surfaced).
    const props = new PropertyBag();
    props.setModelParam("AREA", 2);
    props.setModelParam("AREAB", 1.5);
    props.setModelParam("AREAC", 1.7);
    props.setModelParam("M", 2);
    props.setModelParam("OFF", 1);
    props.setModelParam("ICVBE", 0.7);
    props.setModelParam("ICVCE", 5);
    props.setModelParam("TEMP", 350);
    props.setModelParam("SUBS", 1);
    const compiled = makeCompiled(
      [makeAnalogEl([3, 2, 1])],
      new Map([[0, new TestCircuitElement("NpnBJT", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "Q1"]]));
    const elementLine = netlist.split("\n").find(l => l.startsWith("Q1 "))!;
    expect(elementLine).toBeDefined();
    // Instance keys ngspice accepts: emitted in lift order, with OFF as a
    // bare keyword.
    expect(elementLine).toContain("AREA=2");
    expect(elementLine).toContain("AREAB=1.5");
    expect(elementLine).toContain("AREAC=1.7");
    expect(elementLine).toContain("M=2");
    expect(elementLine).toMatch(/\bOFF\b/);
    expect(elementLine).not.toMatch(/\bOFF=/);
    expect(elementLine).toContain("ICVBE=0.7");
    expect(elementLine).toContain("ICVCE=5");
    expect(elementLine).toContain("TEMP=350");
    // SUBS has no ngspice counterpart — must never reach the netlist.
    expect(elementLine).not.toContain("SUBS");
    // Model card must not contain instance keys
    const modelLine = netlist.split("\n").find(l => l.startsWith(".model Q1_NPN NPN"))!;
    expect(modelLine).toBeDefined();
    expect(modelLine).not.toContain("AREA=");
    expect(modelLine).not.toContain("AREAB=");
    expect(modelLine).not.toContain("AREAC=");
    expect(modelLine).not.toContain("M=");
    expect(modelLine).not.toContain("OFF");
    expect(modelLine).not.toContain("ICVBE=");
    expect(modelLine).not.toContain("ICVCE=");
    expect(modelLine).not.toContain("TEMP=");
    expect(modelLine).not.toContain("SUBS");
  });

  it("non-semiconductor branches are unchanged", () => {
    const props = new PropertyBag();
    props.setModelParam("resistance", 4700);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 2])],
      new Map([[0, new TestCircuitElement("Resistor", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "R1"]]));
    expect(netlist).toContain("R1 1 2 4700");
  });

  // -------------------------------------------------------------------------
  // Task 3.2: Per-device rename table tests
  // -------------------------------------------------------------------------

  it("Diode: ISW renames to JSW on model card", () => {
    const props = new PropertyBag();
    props.setModelParam("ISW", 1e-15);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 2])],
      new Map([[0, new TestCircuitElement("Diode", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "D1"]]));
    expect(netlist).toContain("JSW=1e-15");
    expect(netlist).not.toContain("ISW=");
  });

  it("non-renamed model params emit unchanged", () => {
    const props = new PropertyBag();
    props.setModelParam("IS", 2e-14);
    props.setModelParam("ISW", 1e-15);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 2])],
      new Map([[0, new TestCircuitElement("Diode", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "D1"]]));
    expect(netlist).toContain("IS=2e-14");
    expect(netlist).toContain("JSW=1e-15");
    expect(netlist).not.toContain("ISW=");
  });

  it("BJT model card emits all keys verbatim (no rename leakage)", () => {
    const props = new PropertyBag();
    props.setModelParam("IS", 1e-14);
    const compiled = makeCompiled(
      [makeAnalogEl([3, 2, 1])],
      new Map([[0, new TestCircuitElement("NpnBJT", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "Q1"]]));
    const modelLine = netlist.split("\n").find(l => l.startsWith(".model Q1_NPN NPN"))!;
    expect(modelLine).toBeDefined();
    expect(modelLine).toContain("IS=");
    expect(modelLine).not.toContain("JS=");
  });

  // -------------------------------------------------------------------------
  // Task 3.3: Model-card prefix and drop-if-zero tests
  // -------------------------------------------------------------------------

  it("Diode: emits LEVEL=3 when IBEQ > 0", () => {
    const props = new PropertyBag();
    props.setModelParam("IBEQ", 1e-12);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 2])],
      new Map([[0, new TestCircuitElement("Diode", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "D1"]]));
    expect(netlist).toContain("(LEVEL=3 ");
  });

  it("Diode: emits LEVEL=3 when IBSW > 0", () => {
    const props = new PropertyBag();
    props.setModelParam("IBSW", 1e-12);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 2])],
      new Map([[0, new TestCircuitElement("Diode", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "D1"]]));
    expect(netlist).toContain("(LEVEL=3 ");
  });

  it("Diode: does NOT emit LEVEL=3 when IBEQ=0 and IBSW=0", () => {
    const props = new PropertyBag();
    const compiled = makeCompiled(
      [makeAnalogEl([1, 2])],
      new Map([[0, new TestCircuitElement("Diode", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "D1"]]));
    expect(netlist).not.toContain("LEVEL=3");
  });

  it("Diode: does NOT emit LEVEL=3 for non-default NB alone", () => {
    const props = new PropertyBag();
    props.setModelParam("NB", 2);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 2])],
      new Map([[0, new TestCircuitElement("Diode", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "D1"]]));
    expect(netlist).not.toContain("LEVEL=3");
  });

  it("Zener: never emits LEVEL=3", () => {
    const props = new PropertyBag();
    const compiled = makeCompiled(
      [makeAnalogEl([1, 2])],
      new Map([[0, new TestCircuitElement("ZenerDiode", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "D1"]]));
    expect(netlist).not.toContain("LEVEL=3");
  });

  it("NMOS: NSUB=0 dropped from model card", () => {
    const props = new PropertyBag();
    // NSUB default is 0, do not set it explicitly — default should be dropped
    const compiled = makeCompiled(
      [makeAnalogEl([3, 2, 1, 0])],
      new Map([[0, new TestCircuitElement("NMOS", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "M1"]]));
    const modelLine = netlist.split("\n").find(l => l.startsWith(".model M1_NMOS NMOS"))!;
    expect(modelLine).toBeDefined();
    expect(modelLine).not.toContain("NSUB=");
  });

  it("NMOS: NSUB=1e16 emitted on model card", () => {
    const props = new PropertyBag();
    props.setModelParam("NSUB", 1e16);
    const compiled = makeCompiled(
      [makeAnalogEl([3, 2, 1, 0])],
      new Map([[0, new TestCircuitElement("NMOS", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "M1"]]));
    expect(netlist).toContain("NSUB=" + String(1e16));
  });

  it("NMOS: NSS=0 dropped from model card", () => {
    const props = new PropertyBag();
    // NSS default is 0
    const compiled = makeCompiled(
      [makeAnalogEl([3, 2, 1, 0])],
      new Map([[0, new TestCircuitElement("NMOS", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "M1"]]));
    const modelLine = netlist.split("\n").find(l => l.startsWith(".model M1_NMOS NMOS"))!;
    expect(modelLine).toBeDefined();
    expect(modelLine).not.toContain("NSS=");
  });

  it("NMOS: NSS=2e10 emitted on model card", () => {
    const props = new PropertyBag();
    props.setModelParam("NSS", 2e10);
    const compiled = makeCompiled(
      [makeAnalogEl([3, 2, 1, 0])],
      new Map([[0, new TestCircuitElement("NMOS", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "M1"]]));
    expect(netlist).toContain("NSS=" + String(2e10));
  });

  it("PMOS: NSUB=0 and NSS=0 dropped from model card", () => {
    const props = new PropertyBag();
    const compiled = makeCompiled(
      [makeAnalogEl([3, 2, 1, 0])],
      new Map([[0, new TestCircuitElement("PMOS", props)]]),
    );
    const netlist = generateSpiceNetlist(compiled, testRegistry, new Map([[0, "M1"]]));
    const modelLine = netlist.split("\n").find(l => l.startsWith(".model M1_PMOS PMOS"))!;
    expect(modelLine).toBeDefined();
    expect(modelLine).not.toContain("NSUB=");
    expect(modelLine).not.toContain("NSS=");
  });
});
