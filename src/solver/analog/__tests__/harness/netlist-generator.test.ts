/**
 * Tests for Item 5 (BJT companion current mapping) and Item 12 (netlist generator).
 */
import { describe, it, expect } from "vitest";
import {
  BJT_MAPPING,
  DEVICE_MAPPINGS,
  DIODE_MAPPING,
  JFET_MAPPING,
  TUNNEL_DIODE_MAPPING,
  VARACTOR_MAPPING,
} from "./device-mappings.js";
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
    expect(generateSpiceNetlist(compiled, new Map([[0, "V1"]]))).toContain("V1 1 0 DC 5");
  });

  it("AcVoltageSource: DC and AC fields", () => {
    const props = new PropertyBag();
    props.setModelParam("amplitude", 1.5);
    props.setModelParam("dcOffset", 0.5);
    const compiled = makeCompiled(
      [makeAnalogEl([1, 0])],
      new Map([[0, new TestCircuitElement("AcVoltageSource", props)]]),
    );
    expect(generateSpiceNetlist(compiled, new Map([[0, "VAC"]]))).toContain("VAC 1 0 DC 0.5 AC 1.5");
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

  it("NpnBJT: Q prefix, 3 nodes, NPN model card with params", () => {
    const props = new PropertyBag();
    props.setModelParam("BF", 100);
    props.setModelParam("IS", 1e-14);
    const compiled = makeCompiled(
      [makeAnalogEl([3, 2, 1])],
      new Map([[0, new TestCircuitElement("NpnBJT", props)]]),
    );
    const r = generateSpiceNetlist(compiled, new Map([[0, "Q1"]]));
    expect(r).toContain("Q1 3 2 1 Q1_NPN");
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
    expect(r).toContain("Q2 3 2 1 Q2_PNP");
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
    expect(r).toContain("M1 3 2 1 0 M1_NMOS");
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
    expect(r).toContain("J1 3 2 1 J1_NMF");
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
    expect(r).toContain("J2 3 2 1 J2_PMF");
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

// ---------------------------------------------------------------------------
// Derived ngspice slots — synthesize BJT quantities (RB_EFF, Norton currents)
// from raw CKTstate so they can be compared against our engine.
// ---------------------------------------------------------------------------

describe("BJT_MAPPING.derivedNgspiceSlots", () => {
  // Build a synthetic per-device state slice mimicking CKTstate0 layout.
  // Offsets used by the formulas:
  //   0 vbe, 1 vbc, 2 cc, 3 cb, 4 gpi, 5 gmu, 6 gm, 7 go, 16 gx, 18 geqcb
  function makeState(overrides: Partial<Record<number, number>>): Float64Array {
    const s = new Float64Array(21);
    for (const [k, v] of Object.entries(overrides)) s[Number(k)] = v as number;
    return s;
  }

  it("defines the four derived slots", () => {
    const d = BJT_MAPPING.derivedNgspiceSlots!;
    expect(d).toBeDefined();
    expect(Object.keys(d).sort()).toEqual(["IB_NORTON", "IC_NORTON", "IE_NORTON", "RB_EFF"]);
  });

  it("RB_EFF = 1 / gx", () => {
    const s = makeState({ 16: 0.01 }); // gx = 10 mS → rb = 100 Ω
    expect(BJT_MAPPING.derivedNgspiceSlots!.RB_EFF.compute(s, 0)).toBeCloseTo(100, 10);
  });

  it("RB_EFF returns +Infinity when gx is zero", () => {
    const s = makeState({});
    expect(BJT_MAPPING.derivedNgspiceSlots!.RB_EFF.compute(s, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("IC_NORTON matches cc - (gm+go)*vbe + (gmu+go)*vbc", () => {
    const s = makeState({
      0: 0.7,    // vbe
      1: -0.3,   // vbc
      2: 1e-3,   // cc (ic)
      5: 2e-6,   // gmu
      6: 40e-3,  // gm
      7: 1e-5,   // go
    });
    const expected = 1e-3 - (40e-3 + 1e-5) * 0.7 + (2e-6 + 1e-5) * -0.3;
    expect(BJT_MAPPING.derivedNgspiceSlots!.IC_NORTON.compute(s, 0)).toBeCloseTo(expected, 15);
  });

  it("IB_NORTON matches cb - gpi*vbe - gmu*vbc - geqcb*vbc", () => {
    const s = makeState({
      0: 0.65,   // vbe
      1: -0.4,   // vbc
      3: 5e-6,   // cb (ib)
      4: 5e-4,   // gpi
      5: 1e-7,   // gmu
      18: 1e-8,  // geqcb
    });
    const expected = 5e-6 - 5e-4 * 0.65 - 1e-7 * -0.4 - 1e-8 * -0.4;
    expect(BJT_MAPPING.derivedNgspiceSlots!.IB_NORTON.compute(s, 0)).toBeCloseTo(expected, 15);
  });

  it("IE_NORTON matches -(cc+cb) + (gm+go+gpi)*vbe - (go-geqcb)*vbc", () => {
    const s = makeState({
      0: 0.68,
      1: -0.2,
      2: 2e-3,
      3: 2e-5,
      4: 5e-4,
      6: 30e-3,
      7: 2e-5,
      18: 3e-9,
    });
    const expected = -(2e-3 + 2e-5)
      + (30e-3 + 2e-5 + 5e-4) * 0.68
      - (2e-5 - 3e-9) * -0.2;
    expect(BJT_MAPPING.derivedNgspiceSlots!.IE_NORTON.compute(s, 0)).toBeCloseTo(expected, 14);
  });

  it("respects the base offset — reads from state[base+offset], not state[offset]", () => {
    const s = new Float64Array(42);
    // Write device 2's state starting at offset 21.
    s[21 + 16] = 0.005; // gx
    expect(BJT_MAPPING.derivedNgspiceSlots!.RB_EFF.compute(s, 21)).toBeCloseTo(200, 10);
    // Device at base 0 has gx=0 so gets Infinity.
    expect(BJT_MAPPING.derivedNgspiceSlots!.RB_EFF.compute(s, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("DIODE_MAPPING.derivedNgspiceSlots", () => {
  // ngspice diode state layout (diodefs.h): 0 vd, 1 cd, 2 gd, 3 qcap, 4 ccap.
  function makeDioState(vd: number, id: number, geq: number): Float64Array {
    const s = new Float64Array(5);
    s[0] = vd;
    s[1] = id;
    s[2] = geq;
    return s;
  }

  it("defines IEQ", () => {
    expect(DIODE_MAPPING.derivedNgspiceSlots).toBeDefined();
    expect(Object.keys(DIODE_MAPPING.derivedNgspiceSlots!)).toEqual(["IEQ"]);
  });

  it("IEQ = ID - GEQ*VD (matches dioload.c cdeq = cd - gd*vd)", () => {
    // Forward-biased silicon diode at typical operating point:
    // vd = 0.65 V, id = 1 mA, gd ≈ id/Vt ≈ 1e-3/25.85e-3 ≈ 0.0387 S
    const vd = 0.65;
    const id = 1e-3;
    const geq = id / 25.85e-3;
    const s = makeDioState(vd, id, geq);
    const expected = id - geq * vd;
    expect(DIODE_MAPPING.derivedNgspiceSlots!.IEQ.compute(s, 0)).toBeCloseTo(expected, 15);
  });

  it("IEQ is zero when diode is at VD=0, ID=0", () => {
    const s = makeDioState(0, 0, 0);
    expect(DIODE_MAPPING.derivedNgspiceSlots!.IEQ.compute(s, 0)).toBe(0);
  });

  it("IEQ respects base offset", () => {
    const s = new Float64Array(15);
    s[10 + 0] = 0.7;    // vd
    s[10 + 1] = 2e-3;   // id
    s[10 + 2] = 0.05;   // geq
    const expected = 2e-3 - 0.05 * 0.7;
    expect(DIODE_MAPPING.derivedNgspiceSlots!.IEQ.compute(s, 10)).toBeCloseTo(expected, 15);
  });

  it("tunnel-diode and varactor share the same IEQ formula", () => {
    const s = new Float64Array(5);
    s[0] = 0.55;
    s[1] = 5e-4;
    s[2] = 0.02;
    const dio = DIODE_MAPPING.derivedNgspiceSlots!.IEQ.compute(s, 0);
    const td  = TUNNEL_DIODE_MAPPING.derivedNgspiceSlots!.IEQ.compute(s, 0);
    const var_ = VARACTOR_MAPPING.derivedNgspiceSlots!.IEQ.compute(s, 0);
    expect(td).toBe(dio);
    expect(var_).toBe(dio);
  });
});

describe("JFET_MAPPING.derivedNgspiceSlots", () => {
  // ngspice jfet state offsets: 0 vgs, 1 vgd, 2 cg, 3 cd, 4 cgd,
  //                             5 gm, 6 gds, 7 ggs, 8 ggd,
  //                             9 qgs, 10 cqgs, 11 qgd, 12 cqgd.
  it("defines VDS", () => {
    expect(JFET_MAPPING.derivedNgspiceSlots).toBeDefined();
    expect(Object.keys(JFET_MAPPING.derivedNgspiceSlots!)).toEqual(["VDS"]);
  });

  it("VDS = VGS - VGD", () => {
    const s = new Float64Array(13);
    s[0] = 3.0;  // vgs
    s[1] = -2.0; // vgd → vds = 5
    expect(JFET_MAPPING.derivedNgspiceSlots!.VDS.compute(s, 0)).toBe(5);
  });

  it("VDS respects base offset", () => {
    const s = new Float64Array(26);
    s[13 + 0] = 1.5;
    s[13 + 1] = 0.3;
    expect(JFET_MAPPING.derivedNgspiceSlots!.VDS.compute(s, 13)).toBeCloseTo(1.2, 15);
  });
});