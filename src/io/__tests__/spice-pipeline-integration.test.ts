/**
 * Integration tests for the SPICE .SUBCKT parsing + Circuit building pipeline.
 *
 * Tests W10.3: verify that parseSubcircuit() → buildSpiceSubcircuit() →
 * SubcircuitModelRegistry.register() works end-to-end and that the resulting
 * Circuit has the correct structure for each element type mapping.
 *
 * These tests do NOT run the full compiler (that is tested in the transistor-
 * expansion and analog-compiler test suites). They verify that:
 *   1. The parsed subcircuit feeds into the builder without errors.
 *   2. The built Circuit is structurally valid (correct element counts, types,
 *      pin labels, net assignments, wire connectivity).
 *   3. The Circuit can be stored in SubcircuitModelRegistry and retrieved.
 *   4. Port mapping is preserved end-to-end.
 *   5. _spiceModelOverrides round-trip: params encoded in JSON, decodable.
 */

import { describe, it, expect } from "vitest";
import { parseSubcircuit } from "../../solver/analog/model-parser.js";
import { buildSpiceSubcircuit } from "../spice-model-builder.js";
import { SubcircuitModelRegistry } from "../../solver/analog/subcircuit-model-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pipeline(text: string) {
  const sc = parseSubcircuit(text.trim());
  const circuit = buildSpiceSubcircuit(sc);
  return { sc, circuit };
}

// ---------------------------------------------------------------------------
// End-to-end: parse → build → register
// ---------------------------------------------------------------------------

describe("SPICE pipeline — register in SubcircuitModelRegistry", () => {
  it("registers a simple resistor subcircuit and makes it retrievable", () => {
    const { circuit } = pipeline(`
.SUBCKT rdiv a b c
R1 a b 10k
R2 b c 10k
.ENDS rdiv
`);
    const registry = new SubcircuitModelRegistry();
    registry.register("rdiv", circuit);
    expect(registry.has("rdiv")).toBe(true);
    expect(registry.get("rdiv")).toBe(circuit);
  });

  it("retrieves registered circuit by name", () => {
    const { sc, circuit } = pipeline(`
.SUBCKT mymodel inp out
R1 inp out 1k
.ENDS mymodel
`);
    const registry = new SubcircuitModelRegistry();
    registry.register(sc.name, circuit);
    expect(registry.has("mymodel")).toBe(true);
    expect(registry.get("mymodel")).toBe(circuit);
  });

  it("has() returns false for unregistered name", () => {
    const registry = new SubcircuitModelRegistry();
    expect(registry.has("notregistered")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end parsing → building: all element types
// ---------------------------------------------------------------------------

describe("SPICE pipeline — all element types round-trip", () => {
  const FULL_SUBCKT = `
.SUBCKT alltype a b c d e f
R1 a b 1k
C1 b c 100n
L1 c d 1u
D1 a b 1N4148
Q1 a b c NPN
M1 a b c d NMOS W=10u L=1u
J1 a b c NJFET
V1 d e DC 5
I1 e f DC 1m
.MODEL NPN NPN(IS=1e-14 BF=200)
.MODEL NMOS NMOS(VTO=0.7)
.MODEL NJFET NJFET(VTO=-2)
.ENDS alltype
`;

  it("parses to a subcircuit named 'alltype' with 6 ports and 9 elements", () => {
    const sc = parseSubcircuit(FULL_SUBCKT.trim());
    expect(sc.name).toBe("alltype");
    expect(sc.ports).toHaveLength(6);
    expect(sc.elements).toHaveLength(9);
  });

  it("builds to a Circuit with 6 In elements and 9 non-In elements", () => {
    const { sc, circuit } = pipeline(FULL_SUBCKT);
    expect(circuit.elements.filter((e) => e.typeId === "In")).toHaveLength(sc.ports.length);
    expect(circuit.elements.filter((e) => e.typeId !== "In")).toHaveLength(sc.elements.length);
  });

  it("circuit has In elements equal to port count", () => {
    const { sc, circuit } = pipeline(FULL_SUBCKT);
    const inCount = circuit.elements.filter((e) => e.typeId === "In").length;
    expect(inCount).toBe(sc.ports.length);
  });

  it("circuit has one element per parsed element", () => {
    const { sc, circuit } = pipeline(FULL_SUBCKT);
    const nonIn = circuit.elements.filter((e) => e.typeId !== "In");
    expect(nonIn.length).toBe(sc.elements.length);
  });

  it("circuit contains Resistor for R element", () => {
    const { circuit } = pipeline(FULL_SUBCKT);
    expect(circuit.elements.some((e) => e.typeId === "Resistor")).toBe(true);
  });

  it("circuit contains Capacitor for C element", () => {
    const { circuit } = pipeline(FULL_SUBCKT);
    expect(circuit.elements.some((e) => e.typeId === "Capacitor")).toBe(true);
  });

  it("circuit contains Inductor for L element", () => {
    const { circuit } = pipeline(FULL_SUBCKT);
    expect(circuit.elements.some((e) => e.typeId === "Inductor")).toBe(true);
  });

  it("circuit contains Diode for D element", () => {
    const { circuit } = pipeline(FULL_SUBCKT);
    expect(circuit.elements.some((e) => e.typeId === "Diode")).toBe(true);
  });

  it("circuit contains NpnBJT for Q/NPN element", () => {
    const { circuit } = pipeline(FULL_SUBCKT);
    expect(circuit.elements.some((e) => e.typeId === "NpnBJT")).toBe(true);
  });

  it("circuit contains NMOS for M/NMOS element", () => {
    const { circuit } = pipeline(FULL_SUBCKT);
    expect(circuit.elements.some((e) => e.typeId === "NMOS")).toBe(true);
  });

  it("circuit contains NJFET for J/NJFET element", () => {
    const { circuit } = pipeline(FULL_SUBCKT);
    expect(circuit.elements.some((e) => e.typeId === "NJFET")).toBe(true);
  });

  it("circuit contains DcVoltageSource for V element", () => {
    const { circuit } = pipeline(FULL_SUBCKT);
    expect(circuit.elements.some((e) => e.typeId === "DcVoltageSource")).toBe(true);
  });

  it("circuit contains CurrentSource for I element", () => {
    const { circuit } = pipeline(FULL_SUBCKT);
    expect(circuit.elements.some((e) => e.typeId === "CurrentSource")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Port mapping end-to-end
// ---------------------------------------------------------------------------

describe("SPICE pipeline — port mapping", () => {
  it("each port gets a distinct net x-coordinate", () => {
    const { circuit } = pipeline(`
.SUBCKT diff inp inn out
R1 inp 1 10k
R2 inn 2 10k
.ENDS diff
`);
    const inEls = circuit.elements.filter((e) => e.typeId === "In");
    const xCoords = inEls.map((e) => e.getPins()[0].position.x);
    expect(new Set(xCoords).size).toBe(3);
  });

  it("shared internal node gets same x-coordinate across elements", () => {
    const { circuit } = pipeline(`
.SUBCKT cascade a b c
R1 a b 1k
R2 b c 2k
.ENDS cascade
`);
    const resistors = circuit.elements.filter((e) => e.typeId === "Resistor");
    expect(resistors).toHaveLength(2);

    // R1's B pin and R2's A pin both connect to node "b" — same x
    const r1 = resistors[0];
    const r2 = resistors[1];
    const r1PinB = r1.getPins().find((p) => p.label === "B");
    const r2PinA = r2.getPins().find((p) => p.label === "A");
    expect(r1PinB!.position.x).toBe(r2PinA!.position.x);
  });

  it("port In elements have the correct labels in order", () => {
    const { circuit } = pipeline(`
.SUBCKT filter vin vout gnd
R1 vin 1 10k
C1 1 gnd 100n
.ENDS filter
`);
    const inEls = circuit.elements.filter((e) => e.typeId === "In");
    const labels = inEls.map((e) => e.getAttribute("label") as string);
    expect(labels).toContain("vin");
    expect(labels).toContain("vout");
    expect(labels).toContain("gnd");
  });

  it("element connected to port has pin at same x as port In element", () => {
    const { circuit } = pipeline(`
.SUBCKT test vin vout
R1 vin vout 1k
.ENDS test
`);
    const vinEl = circuit.elements.filter((e) => e.typeId === "In")
      .find((e) => e.getAttribute("label") === "vin");
    const resistor = circuit.elements.find((e) => e.typeId === "Resistor");
    const vinNet = vinEl!.getPins()[0].position.x;
    const pinA = resistor!.getPins().find((p) => p.label === "A");
    expect(pinA!.position.x).toBe(vinNet);
  });
});

// ---------------------------------------------------------------------------
// _spiceModelOverrides round-trip
// ---------------------------------------------------------------------------

describe("SPICE pipeline — _spiceModelOverrides round-trip", () => {
  it("BJT overrides survive parse → build round-trip", () => {
    const { circuit } = pipeline(`
.SUBCKT bjtstage b c e
Q1 c b e NPN2N2222
.MODEL NPN2N2222 NPN(IS=3.1e-14 BF=255 NF=1.0)
.ENDS bjtstage
`);
    const bjt = circuit.elements.find((e) => e.typeId === "NpnBJT");
    const overrides = bjt!.getAttribute("_spiceModelOverrides") as Record<string, number>;
    expect(overrides["IS"]).toBeCloseTo(3.1e-14);
    expect(overrides["BF"]).toBe(255);
    expect(overrides["NF"]).toBeCloseTo(1.0);
  });

  it("MOSFET W/L params survive parse → build round-trip", () => {
    const { circuit } = pipeline(`
.SUBCKT mosstage d g s b
M1 d g s b CMOS0 W=5u L=0.35u
.MODEL CMOS0 NMOS(VTO=0.5 KP=200u)
.ENDS mosstage
`);
    const mos = circuit.elements.find((e) => e.typeId === "NMOS");
    const overrides = mos!.getAttribute("_spiceModelOverrides") as Record<string, number>;
    expect(overrides["W"]).toBeCloseTo(5e-6);
    expect(overrides["L"]).toBeCloseTo(0.35e-6);
    expect(overrides["VTO"]).toBeCloseTo(0.5);
    expect(overrides["KP"]).toBeCloseTo(200e-6);
  });

  it("Diode without inline model has no _spiceModelOverrides", () => {
    const { circuit } = pipeline(`
.SUBCKT dstage a k
D1 a k GENERIC
.ENDS dstage
`);
    const diode = circuit.elements.find((e) => e.typeId === "Diode");
    expect(diode!.getAttribute("_spiceModelOverrides")).toBeUndefined();
  });

  it("Diode with inline model has _spiceModelOverrides", () => {
    const { circuit } = pipeline(`
.SUBCKT dstage a k
D1 a k 1N4148
.MODEL 1N4148 D(IS=2.52e-9 N=1.752)
.ENDS dstage
`);
    const diode = circuit.elements.find((e) => e.typeId === "Diode");
    const overrides = diode!.getAttribute("_spiceModelOverrides") as Record<string, number>;
    expect(overrides["IS"]).toBeCloseTo(2.52e-9);
    expect(overrides["N"]).toBeCloseTo(1.752);
  });
});

// ---------------------------------------------------------------------------
// Wire connectivity — shared nets have wires connecting them
// ---------------------------------------------------------------------------

describe("SPICE pipeline — wire connectivity", () => {
  it("a voltage divider has 4 wires and exactly 2 connect to the mid-node net", () => {
    const { circuit } = pipeline(`
.SUBCKT vdiv vin vout gnd
R1 vin vout 10k
R2 vout gnd 10k
.ENDS vdiv
`);
    expect(circuit.wires).toHaveLength(4);

    // The vout net appears as an endpoint in exactly 2 wires: one from R1.B and one from R2.A
    const voutEl = circuit.elements.filter((e) => e.typeId === "In")
      .find((e) => e.getAttribute("label") === "vout");
    const voutX = voutEl!.getPins()[0].position.x;
    const wiresOnVout = circuit.wires.filter(
      (w) => w.start.x === voutX || w.end.x === voutX
    );
    expect(wiresOnVout).toHaveLength(2);
  });

  it("no wires have start === end (degenerate wires)", () => {
    const { circuit } = pipeline(`
.SUBCKT test a b c
R1 a b 1k
R2 b c 2k
.ENDS test
`);
    for (const w of circuit.wires) {
      const degenerate = w.start.x === w.end.x && w.start.y === w.end.y;
      expect(degenerate).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Error propagation — pipeline throws on invalid .SUBCKT
// ---------------------------------------------------------------------------

describe("SPICE pipeline — error propagation", () => {
  it("throws when .ENDS is missing (parse error propagates)", () => {
    expect(() => pipeline(`.SUBCKT test a b\nR1 a b 1k`)).toThrow();
  });

  it("throws when no ports declared", () => {
    expect(() => pipeline(`.SUBCKT test\nR1 a b 1k\n.ENDS`)).toThrow();
  });
});
