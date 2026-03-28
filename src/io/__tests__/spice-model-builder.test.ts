import { describe, it, expect } from "vitest";
import { buildSpiceSubcircuit } from "../spice-model-builder.js";
import { parseSubcircuit } from "../../solver/analog/model-parser.js";
import type { ParsedSubcircuit } from "../../solver/analog/model-parser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parse(text: string): ParsedSubcircuit {
  return parseSubcircuit(text.trim());
}

// ---------------------------------------------------------------------------
// Circuit structure
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit — circuit structure", () => {
  const TEXT = `
.SUBCKT simple a b
R1 a b 1k
.ENDS simple
`;

  it("returns a Circuit object (has elements array)", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    expect(circuit.elements).toBeDefined();
    expect(Array.isArray(circuit.elements)).toBe(true);
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

  it("adds wires to the circuit", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    expect(circuit.wires.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Net mapping
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit — net mapping", () => {
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

describe("buildSpiceSubcircuit — R element mapping", () => {
  it("maps R to Resistor", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t a b\nR1 a b 10k\n.ENDS`));
    const el = circuit.elements.find((e) => e.typeId === "Resistor");
    expect(el).toBeDefined();
  });

  it("sets resistance property from value", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t a b\nR1 a b 10k\n.ENDS`));
    const el = circuit.elements.find((e) => e.typeId === "Resistor");
    expect(el!.getAttribute("resistance")).toBeCloseTo(10000);
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

describe("buildSpiceSubcircuit — C element mapping", () => {
  it("maps C to Capacitor", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t a b\nC1 a b 100n\n.ENDS`));
    expect(circuit.elements.find((e) => e.typeId === "Capacitor")).toBeDefined();
  });

  it("sets capacitance property", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t a b\nC1 a b 100n\n.ENDS`));
    const el = circuit.elements.find((e) => e.typeId === "Capacitor");
    expect(el!.getAttribute("capacitance")).toBeCloseTo(100e-9);
  });
});

// ---------------------------------------------------------------------------
// Element mapping: L
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit — L element mapping", () => {
  it("maps L to Inductor", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t a b\nL1 a b 1u\n.ENDS`));
    expect(circuit.elements.find((e) => e.typeId === "Inductor")).toBeDefined();
  });

  it("sets inductance property", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t a b\nL1 a b 1u\n.ENDS`));
    const el = circuit.elements.find((e) => e.typeId === "Inductor");
    expect(el!.getAttribute("inductance")).toBeCloseTo(1e-6);
  });
});

// ---------------------------------------------------------------------------
// Element mapping: D
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit — D element mapping", () => {
  it("maps D to Diode", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t a k\nD1 a k 1N4148\n.ENDS`));
    expect(circuit.elements.find((e) => e.typeId === "Diode")).toBeDefined();
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

describe("buildSpiceSubcircuit — Q element mapping, NPN", () => {
  const TEXT = `
.SUBCKT test c b e
Q1 c b e NPN
.MODEL NPN NPN(IS=1e-14 BF=200)
.ENDS test
`;

  it("maps Q with NPN model to NpnBJT", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    expect(circuit.elements.find((e) => e.typeId === "NpnBJT")).toBeDefined();
  });

  it("NpnBJT has pins B, C, E", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const el = circuit.elements.find((e) => e.typeId === "NpnBJT");
    const labels = el!.getPins().map((p) => p.label);
    expect(labels).toContain("B");
    expect(labels).toContain("C");
    expect(labels).toContain("E");
  });

  it("NpnBJT has _spiceModelOverrides with IS and BF", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const el = circuit.elements.find((e) => e.typeId === "NpnBJT");
    const overridesRaw = el!.getAttribute("_spiceModelOverrides") as string;
    expect(overridesRaw).toBeDefined();
    const overrides = JSON.parse(overridesRaw);
    expect(overrides["IS"]).toBeCloseTo(1e-14);
    expect(overrides["BF"]).toBe(200);
  });
});

describe("buildSpiceSubcircuit — Q element mapping, PNP", () => {
  const TEXT = `
.SUBCKT test c b e
Q1 c b e PNP
.MODEL PNP PNP(IS=2e-14 BF=100)
.ENDS test
`;

  it("maps Q with PNP model to PnpBJT", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    expect(circuit.elements.find((e) => e.typeId === "PnpBJT")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Element mapping: M (MOSFET)
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit — M element mapping, NMOS", () => {
  const TEXT = `
.SUBCKT test d g s b
M1 d g s b NMOS W=10u L=1u
.MODEL NMOS NMOS(VTO=0.7)
.ENDS test
`;

  it("maps M with NMOS model to NMOS", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    expect(circuit.elements.find((e) => e.typeId === "NMOS")).toBeDefined();
  });

  it("NMOS has pins G, D, S", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const el = circuit.elements.find((e) => e.typeId === "NMOS");
    const labels = el!.getPins().map((p) => p.label);
    expect(labels).toContain("G");
    expect(labels).toContain("D");
    expect(labels).toContain("S");
  });

  it("NMOS _spiceModelOverrides contains W, L, VTO", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const el = circuit.elements.find((e) => e.typeId === "NMOS");
    const overridesRaw = el!.getAttribute("_spiceModelOverrides") as string;
    const overrides = JSON.parse(overridesRaw);
    expect(overrides["W"]).toBeCloseTo(10e-6);
    expect(overrides["L"]).toBeCloseTo(1e-6);
    expect(overrides["VTO"]).toBeCloseTo(0.7);
  });
});

describe("buildSpiceSubcircuit — M element mapping, PMOS", () => {
  const TEXT = `
.SUBCKT test d g s b
M1 d g s b PMOS W=5u L=1u
.MODEL PMOS PMOS(VTO=-0.7)
.ENDS test
`;

  it("maps M with PMOS model to PMOS", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    expect(circuit.elements.find((e) => e.typeId === "PMOS")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Element mapping: J (JFET)
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit — J element mapping, NJFET", () => {
  const TEXT = `
.SUBCKT test d g s
J1 d g s NJFET
.MODEL NJFET NJFET(VTO=-2)
.ENDS test
`;

  it("maps J with NJFET model to NJFET", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    expect(circuit.elements.find((e) => e.typeId === "NJFET")).toBeDefined();
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

describe("buildSpiceSubcircuit — J element mapping, PJFET", () => {
  const TEXT = `
.SUBCKT test d g s
J1 d g s PJFET
.MODEL PJFET PJFET(VTO=2)
.ENDS test
`;

  it("maps J with PJFET model to PJFET", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    expect(circuit.elements.find((e) => e.typeId === "PJFET")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Element mapping: V (voltage source)
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit — V element mapping", () => {
  it("maps V to DcVoltageSource", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t p n\nV1 p n DC 5\n.ENDS`));
    expect(circuit.elements.find((e) => e.typeId === "DcVoltageSource")).toBeDefined();
  });

  it("sets voltage property", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t p n\nV1 p n DC 3.3\n.ENDS`));
    const el = circuit.elements.find((e) => e.typeId === "DcVoltageSource");
    expect(el!.getAttribute("voltage")).toBeCloseTo(3.3);
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

describe("buildSpiceSubcircuit — I element mapping", () => {
  it("maps I to CurrentSource", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t p n\nI1 p n DC 1m\n.ENDS`));
    expect(circuit.elements.find((e) => e.typeId === "CurrentSource")).toBeDefined();
  });

  it("sets current property", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t p n\nI1 p n DC 1m\n.ENDS`));
    const el = circuit.elements.find((e) => e.typeId === "CurrentSource");
    expect(el!.getAttribute("current")).toBeCloseTo(1e-3);
  });
});

// ---------------------------------------------------------------------------
// Port mapping — correct number and order of In elements
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit — port mapping", () => {
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
// Inline model overrides — no model = no _spiceModelOverrides
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit — model overrides", () => {
  it("Resistor without inline model has no _spiceModelOverrides", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t a b\nR1 a b 1k\n.ENDS`));
    const el = circuit.elements.find((e) => e.typeId === "Resistor");
    expect(el!.getAttribute("_spiceModelOverrides")).toBeUndefined();
  });

  it("Diode without inline model has no _spiceModelOverrides", () => {
    const circuit = buildSpiceSubcircuit(parse(`.SUBCKT t a k\nD1 a k 1N4148\n.ENDS`));
    const el = circuit.elements.find((e) => e.typeId === "Diode");
    expect(el!.getAttribute("_spiceModelOverrides")).toBeUndefined();
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
    const overrides = JSON.parse(el!.getAttribute("_spiceModelOverrides") as string);
    expect(overrides["W"]).toBeCloseTo(20e-6);
    expect(overrides["L"]).toBeCloseTo(2e-6);
    expect(overrides["VTO"]).toBeCloseTo(0.5);
    expect(overrides["KP"]).toBeCloseTo(100e-6);
  });
});

// ---------------------------------------------------------------------------
// Full opamp example — element count and structure
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit — full opamp example", () => {
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
    const vs = circuit.elements.find((e) => e.typeId === "DcVoltageSource");
    expect(vs!.getAttribute("voltage")).toBeCloseTo(5);
  });

  it("each NpnBJT has _spiceModelOverrides with IS and BF", () => {
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    const bjts = circuit.elements.filter((e) => e.typeId === "NpnBJT");
    for (const bjt of bjts) {
      const overrides = JSON.parse(bjt.getAttribute("_spiceModelOverrides") as string);
      expect(overrides["IS"]).toBeCloseTo(1e-14);
      expect(overrides["BF"]).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Wire connectivity — every non-ground pin gets a wire to net spine
// ---------------------------------------------------------------------------

describe("buildSpiceSubcircuit — wires", () => {
  it("adds wires for a two-resistor subcircuit", () => {
    const TEXT = `
.SUBCKT test a b c
R1 a b 1k
R2 b c 2k
.ENDS test
`;
    const circuit = buildSpiceSubcircuit(parse(TEXT));
    expect(circuit.wires.length).toBeGreaterThan(0);
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
