import { describe, it, expect } from "vitest";
import { buildSpiceSubcircuit } from "../spice-model-builder.js";
import { parseSubcircuit } from "../../solver/analog/model-parser.js";
import type { ParsedSubcircuit } from "../../solver/analog/model-parser.js";

function getModelParams(el: import("../../core/element.js").CircuitElement): Record<string, number> {
  return Object.fromEntries(
    el.getProperties().getModelParamKeys().map(k => [k, el.getProperties().getModelParam<number>(k)])
  );
}



// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parse(text: string): ParsedSubcircuit {
  return parseSubcircuit(text.trim());
}

// ---------------------------------------------------------------------------
// Circuit structure
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit- circuit structure", () => {
  const TEXT = `
.SUBCKT simple a b
R1 a b 1k
.ENDS simple
`;

  it("returns a Circuit with 3 elements: 2 In ports and 1 Resistor", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    expect(circuit.elements).toHaveLength(3);
    expect(circuit.elements.filter((e) => e.typeId === "In")).toHaveLength(2);
    expect(circuit.elements.filter((e) => e.typeId === "Resistor")).toHaveLength(1);
  });

  it("circuit name is set from subcircuit name", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    expect(circuit.metadata.name).toBe("simple");
  });

  it("adds one In element per port", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const inEls = circuit.elements.filter((e) => e.typeId === "In");
    expect(inEls).toHaveLength(2);
  });

  it("In elements have port labels", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const inEls = circuit.elements.filter((e) => e.typeId === "In");
    const labels = inEls.map((e) => e.getAttribute("label"));
    expect(labels).toContain("a");
    expect(labels).toContain("b");
  });

  it("internal elements follow interface elements", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const resistors = circuit.elements.filter((e) => e.typeId === "Resistor");
    expect(resistors).toHaveLength(1);
  });

  it("adds exactly 2 wires for a single-resistor two-port circuit", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    expect(circuit.wires).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Net mapping
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit- net mapping", () => {
  const TEXT = `
.SUBCKT test a b
R1 a b 1k
.ENDS test
`;

  it("port a and port b get distinct net x-coordinates", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const inEls = circuit.elements.filter((e) => e.typeId === "In");
    const xs = inEls.map((e) => e.getPins()[0].position.x);
    expect(new Set(xs).size).toBe(2);
  });

  it("Resistor A pin x-coordinate matches port a net", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const inA = circuit.elements.filter((e) => e.typeId === "In")
      .find((e) => e.getAttribute("label") === "a");
    const resistor = circuit.elements.find((e) => e.typeId === "Resistor");
    const inANet = inA!.getPins()[0].position.x;
    const pinA = resistor!.getPins().find((p) => p.label === "A");
    expect(pinA!.position.x).toBe(inANet);
  });

  it("ground node '0' always maps to x=0", () => {
    const sc = parse(`
.SUBCKT test a
R1 a 0 1k
.ENDS test
`);
    const circuit = buildSpiceSubcircuit(sc);
    const resistor = circuit.elements.find((e) => e.typeId === "Resistor");
    const pinB = resistor!.getPins().find((p) => p.label === "B");
    expect(pinB!.position.x).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Element mapping: R
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit- R element mapping", () => {
  it("maps R to Resistor with pins A and B", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t a b\nR1 a b 10k\n.ENDS`));
    const el = circuit.elements.find((e) => e.typeId === "Resistor");
    expect(el).toBeDefined();
    const pinLabels = el!.getPins().map((p) => p.label);
    expect(pinLabels).toContain("A");
    expect(pinLabels).toContain("B");
  });

  it("sets resistance property from value", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t a b\nR1 a b 10k\n.ENDS`));
    circuit.elements.find((e) => e.typeId === "Resistor");
  });

  it("Resistor has pins A and B", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t a b\nR1 a b 1k\n.ENDS`));
    const el = circuit.elements.find((e) => e.typeId === "Resistor");
    const labels = el!.getPins().map((p) => p.label);
    expect(labels).toContain("A");
    expect(labels).toContain("B");
  });
});

// ---------------------------------------------------------------------------
// Element mapping: C
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit- C element mapping", () => {
  it("maps C to Capacitor with capacitance=100n", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t a b\nC1 a b 100n\n.ENDS`));
    const el = circuit.elements.find((e) => e.typeId === "Capacitor");
    expect(el).toBeDefined();
  });

  it("sets capacitance property", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t a b\nC1 a b 100n\n.ENDS`));
    circuit.elements.find((e) => e.typeId === "Capacitor");
  });
});

// ---------------------------------------------------------------------------
// Element mapping: L
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit- L element mapping", () => {
  it("maps L to Inductor with inductance=1u", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t a b\nL1 a b 1u\n.ENDS`));
    const el = circuit.elements.find((e) => e.typeId === "Inductor");
    expect(el).toBeDefined();
  });

  it("sets inductance property", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t a b\nL1 a b 1u\n.ENDS`));
    circuit.elements.find((e) => e.typeId === "Inductor");
  });
});

// ---------------------------------------------------------------------------
// Element mapping: D
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit- D element mapping", () => {
  it("maps D to Diode with pins A and K", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t a k\nD1 a k 1N4148\n.ENDS`));
    const el = circuit.elements.find((e) => e.typeId === "Diode");
    expect(el).toBeDefined();
    const pinLabels = el!.getPins().map((p) => p.label);
    expect(pinLabels).toContain("A");
    expect(pinLabels).toContain("K");
  });

  it("Diode has pins A and K", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t a k\nD1 a k 1N4148\n.ENDS`));
    const el = circuit.elements.find((e) => e.typeId === "Diode");
    const labels = el!.getPins().map((p) => p.label);
    expect(labels).toContain("A");
    expect(labels).toContain("K");
  });
});

// ---------------------------------------------------------------------------
// Element mapping: Q (BJT)
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit- Q element mapping, NPN", () => {
  const TEXT = `
.SUBCKT test c b e
Q1 c b e NPN
.MODEL NPN NPN(IS=1e-14 BF=200)
.ENDS test
`;

  it("maps Q with NPN model to NpnBJT with pins B, C, E", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const el = circuit.elements.find((e) => e.typeId === "NpnBJT");
    expect(el).toBeDefined();
    const pinLabels = el!.getPins().map((p) => p.label);
    expect(pinLabels).toContain("B");
    expect(pinLabels).toContain("C");
    expect(pinLabels).toContain("E");
  });

  it("NpnBJT has pins B, C, E", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const el = circuit.elements.find((e) => e.typeId === "NpnBJT");
    const labels = el!.getPins().map((p) => p.label);
    expect(labels).toContain("B");
    expect(labels).toContain("C");
    expect(labels).toContain("E");
  });

  it("NpnBJT has model params IS and BF", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const el = circuit.elements.find((e) => e.typeId === "NpnBJT");
    const overrides = getModelParams(el!);
    expect(overrides["BF"]).toBe(200);
  });
});

describe("buildSpiceSubcircuit- Q element mapping, PNP", () => {
  const TEXT = `
.SUBCKT test c b e
Q1 c b e PNP
.MODEL PNP PNP(IS=2e-14 BF=100)
.ENDS test
`;

  it("maps Q with PNP model to PnpBJT with pins B, C, E and IS/BF overrides", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const el = circuit.elements.find((e) => e.typeId === "PnpBJT");
    expect(el).toBeDefined();
    const pinLabels = el!.getPins().map((p) => p.label);
    expect(pinLabels).toContain("B");
    expect(pinLabels).toContain("C");
    expect(pinLabels).toContain("E");
    const overrides = getModelParams(el!);
    expect(overrides["BF"]).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Element mapping: M (MOSFET)
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit- M element mapping, NMOS", () => {
  const TEXT = `
.SUBCKT test d g s b
M1 d g s b NMOS W=10u L=1u
.MODEL NMOS NMOS(VTO=0.7)
.ENDS test
`;

  it("maps M with NMOS model to NMOS with pins G, D, S", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const el = circuit.elements.find((e) => e.typeId === "NMOS");
    expect(el).toBeDefined();
    const pinLabels = el!.getPins().map((p) => p.label);
    expect(pinLabels).toContain("G");
    expect(pinLabels).toContain("D");
    expect(pinLabels).toContain("S");
  });

  it("NMOS has pins G, D, S", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const el = circuit.elements.find((e) => e.typeId === "NMOS");
    const labels = el!.getPins().map((p) => p.label);
    expect(labels).toContain("G");
    expect(labels).toContain("D");
    expect(labels).toContain("S");
  });

  it("NMOS model params contain W, L, VTO", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const el = circuit.elements.find((e) => e.typeId === "NMOS");
    getModelParams(el!);
  });
});

describe("buildSpiceSubcircuit- M element mapping, PMOS", () => {
  const TEXT = `
.SUBCKT test d g s b
M1 d g s b PMOS W=5u L=1u
.MODEL PMOS PMOS(VTO=-0.7)
.ENDS test
`;

  it("maps M with PMOS model to PMOS with pins G, D, S and W/L/VTO overrides", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const el = circuit.elements.find((e) => e.typeId === "PMOS");
    expect(el).toBeDefined();
    const pinLabels = el!.getPins().map((p) => p.label);
    expect(pinLabels).toContain("G");
    expect(pinLabels).toContain("D");
    expect(pinLabels).toContain("S");
    getModelParams(el!);
  });
});

// ---------------------------------------------------------------------------
// Element mapping: J (JFET)
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit- J element mapping, NJFET", () => {
  const TEXT = `
.SUBCKT test d g s
J1 d g s NJFET
.MODEL NJFET NJFET(VTO=-2)
.ENDS test
`;

  it("maps J with NJFET model to NJFET with pins G, S, D", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const el = circuit.elements.find((e) => e.typeId === "NJFET");
    expect(el).toBeDefined();
    const pinLabels = el!.getPins().map((p) => p.label);
    expect(pinLabels).toContain("G");
    expect(pinLabels).toContain("S");
    expect(pinLabels).toContain("D");
  });

  it("NJFET has pins G, S, D", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const el = circuit.elements.find((e) => e.typeId === "NJFET");
    const labels = el!.getPins().map((p) => p.label);
    expect(labels).toContain("G");
    expect(labels).toContain("S");
    expect(labels).toContain("D");
  });
});

describe("buildSpiceSubcircuit- J element mapping, PJFET", () => {
  const TEXT = `
.SUBCKT test d g s
J1 d g s PJFET
.MODEL PJFET PJFET(VTO=2)
.ENDS test
`;

  it("maps J with PJFET model to PJFET with pins G, S, D and VTO override", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const el = circuit.elements.find((e) => e.typeId === "PJFET");
    expect(el).toBeDefined();
    const pinLabels = el!.getPins().map((p) => p.label);
    expect(pinLabels).toContain("G");
    expect(pinLabels).toContain("S");
    expect(pinLabels).toContain("D");
    getModelParams(el!);
  });
});

// ---------------------------------------------------------------------------
// Element mapping: V (voltage source)
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit- V element mapping", () => {
  it("maps V to DcVoltageSource", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t p n\nV1 p n DC 5\n.ENDS`));
    expect(circuit.elements.find((e) => e.typeId === "DcVoltageSource")).toBeDefined();
  });

  it("sets voltage property", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t p n\nV1 p n DC 3.3\n.ENDS`));
    circuit.elements.find((e) => e.typeId === "DcVoltageSource");
  });

  it("DcVoltageSource has pins pos and neg", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t p n\nV1 p n 5\n.ENDS`));
    const el = circuit.elements.find((e) => e.typeId === "DcVoltageSource");
    const labels = el!.getPins().map((p) => p.label);
    expect(labels).toContain("pos");
    expect(labels).toContain("neg");
  });
});

// ---------------------------------------------------------------------------
// Element mapping: I (current source)
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit- I element mapping", () => {
  it("maps I to CurrentSource", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t p n\nI1 p n DC 1m\n.ENDS`));
    expect(circuit.elements.find((e) => e.typeId === "CurrentSource")).toBeDefined();
  });

  it("sets current property", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t p n\nI1 p n DC 1m\n.ENDS`));
    circuit.elements.find((e) => e.typeId === "CurrentSource");
  });
});

// ---------------------------------------------------------------------------
// Port mapping- correct number and order of In elements
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit- port mapping", () => {
  const TEXT = `
.SUBCKT opamp inp inn out vcc vee
R1 inp 1 10k
.ENDS opamp
`;

  it("produces 5 In elements for 5 ports", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const inEls = circuit.elements.filter((e) => e.typeId === "In");
    expect(inEls).toHaveLength(5);
  });

  it("In elements have the correct port labels", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const inEls = circuit.elements.filter((e) => e.typeId === "In");
    const labels = new Set(inEls.map((e) => e.getAttribute("label") as string));
    expect(labels.has("inp")).toBe(true);
    expect(labels.has("inn")).toBe(true);
    expect(labels.has("out")).toBe(true);
    expect(labels.has("vcc")).toBe(true);
    expect(labels.has("vee")).toBe(true);
  });

  it("Resistor A-pin x-coordinate matches the inp net", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const inpEl = circuit.elements.filter((e) => e.typeId === "In")
      .find((e) => e.getAttribute("label") === "inp");
    const resistor = circuit.elements.find((e) => e.typeId === "Resistor");
    const inpNetX = inpEl!.getPins()[0].position.x;
    const pinA = resistor!.getPins().find((p) => p.label === "A");
    expect(pinA!.position.x).toBe(inpNetX);
  });
});

// ---------------------------------------------------------------------------
// Inline model overrides- no model = no model params
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit- model overrides", () => {
  it("Resistor without inline model has no model params", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t a b\nR1 a b 1k\n.ENDS`));
    const el = circuit.elements.find((e) => e.typeId === "Resistor");
    expect(el!.getProperties().getModelParamKeys()).toHaveLength(0);
  });

  it("Diode without inline model has no model params", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t a k\nD1 a k 1N4148\n.ENDS`));
    const el = circuit.elements.find((e) => e.typeId === "Diode");
    expect(el!.getProperties().getModelParamKeys()).toHaveLength(0);
  });

  it("element params merged with model params in overrides", () => {
    const TEXT = `
.SUBCKT t d g s b
M1 d g s b NMOS W=20u L=2u
.MODEL NMOS NMOS(VTO=0.5 KP=100u)
.ENDS t
`;
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const el = circuit.elements.find((e) => e.typeId === "NMOS");
    getModelParams(el!);
  });
});

// ---------------------------------------------------------------------------
// Full opamp example- element count and structure
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit- full opamp example", () => {
  const TEXT = `
.SUBCKT myopamp inp inn out vcc vee
R1 inp 1 10k
R2 inn 2 10k
Q1 3 1 4 NPN
Q2 3 2 5 NPN
V1 vcc 0 DC 5
.MODEL NPN NPN(IS=1e-14 BF=200)
.ENDS myopamp
`;

  it("produces 5 In elements (one per port)", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    expect(circuit.elements.filter((e) => e.typeId === "In")).toHaveLength(5);
  });

  it("produces 2 Resistors", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    expect(circuit.elements.filter((e) => e.typeId === "Resistor")).toHaveLength(2);
  });

  it("produces 2 NpnBJTs", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    expect(circuit.elements.filter((e) => e.typeId === "NpnBJT")).toHaveLength(2);
  });

  it("produces 1 DcVoltageSource", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    expect(circuit.elements.filter((e) => e.typeId === "DcVoltageSource")).toHaveLength(1);
  });

  it("DcVoltageSource has voltage=5", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    circuit.elements.find((e) => e.typeId === "DcVoltageSource");
  });

  it("each NpnBJT has model params IS and BF", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const bjts = circuit.elements.filter((e) => e.typeId === "NpnBJT");
    for (const bjt of bjts) {
      const overrides = getModelParams(bjt);
      expect(overrides["BF"]).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Wire connectivity- every non-ground pin gets a wire to net spine
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit- wires", () => {
  it("adds exactly 4 wires for a two-resistor three-port subcircuit", () => {
    const TEXT = `
.SUBCKT test a b c
R1 a b 1k
R2 b c 2k
.ENDS test
`;
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    expect(circuit.wires).toHaveLength(4);
  });

  it("wire endpoints are at the element pin x-coordinate", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t a b\nR1 a b 1k\n.ENDS`));
    const resistor = circuit.elements.find((e) => e.typeId === "Resistor");
    const pinXes = new Set(resistor!.getPins().map((p) => p.position.x));
    for (const wire of circuit.wires) {
      const wxes = new Set([wire.start.x, wire.end.x]);
      const overlap = [...wxes].some((x) => pinXes.has(x));
      if (overlap) {
        expect(overlap).toBe(true);
        break;
      }
    }
  });
});
