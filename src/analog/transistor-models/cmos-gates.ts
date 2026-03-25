/**
 * CMOS gate transistor-level subcircuit definitions.
 *
 * Each factory function builds a Circuit containing MOSFET components
 * wired as standard CMOS logic topology. The subcircuits are registered
 * in the TransistorModelRegistry and referenced by the transistorModel
 * field on the corresponding gate ComponentDefinition.
 *
 * Pin labeling conventions for interface elements:
 *   - In "VDD"  — positive supply rail (maps to shared VDD node during expansion)
 *   - In "GND"  — ground rail (maps to node 0)
 *   - In "In_1", In "In_2", In "in" — logic inputs (match outer gate pin labels)
 *   - Out "out" — logic output
 *
 * MOSFET pin order in subcircuit elements: D, G, S (matching mosfet.ts pin layout)
 *
 * Wire connectivity uses unique (x, y) positions: each net is a distinct X
 * coordinate. Wire segments connect components by sharing endpoints at the
 * same X value so they form a single MNA node.
 */

import { Circuit, Wire } from "../../core/circuit.js";
import { PropertyBag } from "../../core/properties.js";
import { PinDirection } from "../../core/pin.js";
import type { Pin, PinDeclaration } from "../../core/pin.js";
import type { CircuitElement } from "../../core/element.js";
import type { Rect, RenderContext } from "../../core/renderer-interface.js";
import type { SerializedElement } from "../../core/element.js";
import type { TransistorModelRegistry } from "../transistor-model-registry.js";

// ---------------------------------------------------------------------------
// Minimal CircuitElement builder for subcircuit elements
// ---------------------------------------------------------------------------

let _elementCounter = 0;

function makePin(x: number, y: number, label: string): Pin {
  return {
    position: { x, y },
    label,
    direction: PinDirection.BIDIRECTIONAL,
    isInverted: false,
    isClock: false,
    bitWidth: 1,
  };
}

function makeSubcircuitElement(
  typeId: string,
  pins: Array<{ x: number; y: number; label: string }>,
  propsEntries: Array<[string, string | number | boolean]> = [],
): CircuitElement {
  const instanceId = `${typeId}-${++_elementCounter}`;
  const resolvedPins = pins.map((p) => makePin(p.x, p.y, p.label));
  const propsMap = new Map<string, import("../../core/properties.js").PropertyValue>(
    propsEntries as Array<[string, import("../../core/properties.js").PropertyValue]>,
  );
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
    draw(_ctx: RenderContext) { /* no-op */ },
    serialize() { return serialized; },
    getHelpText() { return ""; },
    getAttribute(k: string) { return propsMap.get(k); },
  };
}

// ---------------------------------------------------------------------------
// Wire helper — adds a wire to the circuit
// ---------------------------------------------------------------------------

function wire(circuit: Circuit, x1: number, y1: number, x2: number, y2: number): void {
  circuit.addWire(new Wire({ x: x1, y: y1 }, { x: x2, y: y2 }));
}

// ---------------------------------------------------------------------------
// PMOS element: pins D (x=xD, y), G (x=xG, y), S (x=xS, y)
// ---------------------------------------------------------------------------

function makePmos(xD: number, xG: number, xS: number, yRow: number): CircuitElement {
  return makeSubcircuitElement("PMOS", [
    { x: xD, y: yRow, label: "D" },
    { x: xG, y: yRow, label: "G" },
    { x: xS, y: yRow, label: "S" },
  ], [["W", 20e-6]]);
}

// ---------------------------------------------------------------------------
// NMOS element: pins D (x=xD, y), G (x=xG, y), S (x=xS, y)
// ---------------------------------------------------------------------------

function makeNmos(xD: number, xG: number, xS: number, yRow: number): CircuitElement {
  return makeSubcircuitElement("NMOS", [
    { x: xD, y: yRow, label: "D" },
    { x: xG, y: yRow, label: "G" },
    { x: xS, y: yRow, label: "S" },
  ], [["W", 10e-6]]);
}

// ---------------------------------------------------------------------------
// Interface element helpers
// ---------------------------------------------------------------------------

function makeInEl(label: string, xNet: number, yRow: number): CircuitElement {
  return makeSubcircuitElement("In", [{ x: xNet, y: yRow, label: "out" }], [["label", label]]);
}

function makeOutEl(label: string, xNet: number, yRow: number): CircuitElement {
  return makeSubcircuitElement("Out", [{ x: xNet, y: yRow, label: "in" }], [["label", label]]);
}

// ---------------------------------------------------------------------------
// createCmosInverter
//
// PMOS: source→VDD, gate→in, drain→out
// NMOS: source→GND, gate→in, drain→out
//
// Net assignments (X coordinates):
//   X=10: in net  — In "in", PMOS gate, NMOS gate
//   X=20: out net — PMOS drain, NMOS drain, Out "out"
//   X=30: VDD     — In "VDD", PMOS source
//   X=40: GND     — In "GND", NMOS source
// ---------------------------------------------------------------------------

export function createCmosInverter(_modelRegistry: TransistorModelRegistry): Circuit {
  const circuit = new Circuit({ engineType: "analog" });

  circuit.addElement(makeInEl("in", 10, 0));
  circuit.addElement(makeInEl("VDD", 30, 0));
  circuit.addElement(makeInEl("GND", 40, 0));
  circuit.addElement(makeOutEl("out", 20, 0));
  circuit.addElement(makePmos(20, 10, 30, 2));
  circuit.addElement(makeNmos(20, 10, 40, 4));

  // in net: x=10
  wire(circuit, 10, 0, 10, 2);
  wire(circuit, 10, 2, 10, 4);
  // out net: x=20
  wire(circuit, 20, 0, 20, 2);
  wire(circuit, 20, 2, 20, 4);
  // VDD net: x=30
  wire(circuit, 30, 0, 30, 2);
  // GND net: x=40
  wire(circuit, 40, 0, 40, 4);

  return circuit;
}

// ---------------------------------------------------------------------------
// createCmosNand2
//
// Pull-up network: 2 PMOS in parallel (sources→VDD, gates→A/B, drains→out)
// Pull-down network: 2 NMOS in series (top drain→out, bottom source→GND, mid=internal)
//
// Net assignments:
//   X=10: In_1 (A)
//   X=20: In_2 (B)
//   X=30: out
//   X=40: VDD
//   X=50: GND
//   X=60: internal mid-node between NMOS series stack
// ---------------------------------------------------------------------------

export function createCmosNand2(_modelRegistry: TransistorModelRegistry): Circuit {
  const circuit = new Circuit({ engineType: "analog" });

  circuit.addElement(makeInEl("In_1", 10, 0));
  circuit.addElement(makeInEl("In_2", 20, 0));
  circuit.addElement(makeInEl("VDD", 40, 0));
  circuit.addElement(makeInEl("GND", 50, 0));
  circuit.addElement(makeOutEl("out", 30, 0));

  // PMOS pull-up: PA (gate=In_1), PB (gate=In_2), both drain→out, source→VDD
  circuit.addElement(makePmos(30, 10, 40, 2));  // PA
  circuit.addElement(makePmos(30, 20, 40, 3));  // PB

  // NMOS pull-down series: NA top (drain=out, source=mid, gate=In_1)
  //                        NB bottom (drain=mid, source=GND, gate=In_2)
  circuit.addElement(makeNmos(30, 10, 60, 5));  // NA top
  circuit.addElement(makeNmos(60, 20, 50, 6));  // NB bottom

  // In_1 net: x=10
  wire(circuit, 10, 0, 10, 2);
  wire(circuit, 10, 2, 10, 5);
  // In_2 net: x=20
  wire(circuit, 20, 0, 20, 3);
  wire(circuit, 20, 3, 20, 6);
  // out net: x=30
  wire(circuit, 30, 0, 30, 2);
  wire(circuit, 30, 2, 30, 3);
  wire(circuit, 30, 3, 30, 5);
  // VDD net: x=40
  wire(circuit, 40, 0, 40, 2);
  wire(circuit, 40, 2, 40, 3);
  // GND net: x=50
  wire(circuit, 50, 0, 50, 6);
  // mid net: x=60
  wire(circuit, 60, 5, 60, 6);

  return circuit;
}

// ---------------------------------------------------------------------------
// createCmosNor2
//
// Pull-up network: 2 PMOS in series (top source→VDD, bottom drain→out, mid=internal)
// Pull-down network: 2 NMOS in parallel (sources→GND, gates→A/B, drains→out)
//
// Net assignments:
//   X=10: In_1 (A)
//   X=20: In_2 (B)
//   X=30: out
//   X=40: VDD
//   X=50: GND
//   X=60: PMOS series mid-node
// ---------------------------------------------------------------------------

export function createCmosNor2(_modelRegistry: TransistorModelRegistry): Circuit {
  const circuit = new Circuit({ engineType: "analog" });

  circuit.addElement(makeInEl("In_1", 10, 0));
  circuit.addElement(makeInEl("In_2", 20, 0));
  circuit.addElement(makeInEl("VDD", 40, 0));
  circuit.addElement(makeInEl("GND", 50, 0));
  circuit.addElement(makeOutEl("out", 30, 0));

  // PMOS series pull-up: PA top (source=VDD, gate=In_1, drain=mid)
  //                      PB bottom (source=mid, gate=In_2, drain=out)
  circuit.addElement(makePmos(60, 10, 40, 2));  // PA top: D=mid, G=In_1, S=VDD
  circuit.addElement(makePmos(30, 20, 60, 3));  // PB bottom: D=out, G=In_2, S=mid

  // NMOS parallel pull-down: NA (drain=out, gate=In_1, source=GND)
  //                          NB (drain=out, gate=In_2, source=GND)
  circuit.addElement(makeNmos(30, 10, 50, 5));  // NA
  circuit.addElement(makeNmos(30, 20, 50, 6));  // NB

  // In_1 net: x=10
  wire(circuit, 10, 0, 10, 2);
  wire(circuit, 10, 2, 10, 5);
  // In_2 net: x=20
  wire(circuit, 20, 0, 20, 3);
  wire(circuit, 20, 3, 20, 6);
  // out net: x=30
  wire(circuit, 30, 0, 30, 3);
  wire(circuit, 30, 3, 30, 5);
  wire(circuit, 30, 5, 30, 6);
  // VDD net: x=40
  wire(circuit, 40, 0, 40, 2);
  // GND net: x=50
  wire(circuit, 50, 0, 50, 5);
  wire(circuit, 50, 5, 50, 6);
  // PMOS mid net: x=60
  wire(circuit, 60, 2, 60, 3);

  return circuit;
}

// ---------------------------------------------------------------------------
// createCmosAnd2
//
// NAND2 + inverter. 6 MOSFETs total.
//
// Internal node: nand_out (between NAND output and inverter input)
//
// Net assignments:
//   X=10: In_1
//   X=20: In_2
//   X=30: out (inverter output)
//   X=40: VDD
//   X=50: GND
//   X=60: nand_out (NAND output / inverter input)
//   X=70: NAND internal mid-node (series NMOS stack)
// ---------------------------------------------------------------------------

export function createCmosAnd2(modelRegistry: TransistorModelRegistry): Circuit {
  const circuit = new Circuit({ engineType: "analog" });

  circuit.addElement(makeInEl("In_1", 10, 0));
  circuit.addElement(makeInEl("In_2", 20, 0));
  circuit.addElement(makeInEl("VDD", 40, 0));
  circuit.addElement(makeInEl("GND", 50, 0));
  circuit.addElement(makeOutEl("out", 30, 0));

  // NAND2 pull-up: PA (gate=In_1, drain=nand_out, source=VDD)
  //                PB (gate=In_2, drain=nand_out, source=VDD)
  circuit.addElement(makePmos(60, 10, 40, 2));
  circuit.addElement(makePmos(60, 20, 40, 3));

  // NAND2 pull-down: NA top (drain=nand_out, gate=In_1, source=mid)
  //                  NB bottom (drain=mid, gate=In_2, source=GND)
  circuit.addElement(makeNmos(60, 10, 70, 5));
  circuit.addElement(makeNmos(70, 20, 50, 6));

  // Inverter pull-up: PI (gate=nand_out, drain=out, source=VDD)
  circuit.addElement(makePmos(30, 60, 40, 8));

  // Inverter pull-down: NI (drain=out, gate=nand_out, source=GND)
  circuit.addElement(makeNmos(30, 60, 50, 9));

  // In_1 net: x=10
  wire(circuit, 10, 0, 10, 2);
  wire(circuit, 10, 2, 10, 5);
  // In_2 net: x=20
  wire(circuit, 20, 0, 20, 3);
  wire(circuit, 20, 3, 20, 6);
  // out net: x=30
  wire(circuit, 30, 0, 30, 8);
  wire(circuit, 30, 8, 30, 9);
  // VDD net: x=40
  wire(circuit, 40, 0, 40, 2);
  wire(circuit, 40, 2, 40, 3);
  wire(circuit, 40, 3, 40, 8);
  // GND net: x=50
  wire(circuit, 50, 0, 50, 6);
  wire(circuit, 50, 6, 50, 9);
  // nand_out net: x=60
  wire(circuit, 60, 2, 60, 3);
  wire(circuit, 60, 3, 60, 5);
  wire(circuit, 60, 5, 60, 8);
  wire(circuit, 60, 8, 60, 9);
  // NAND mid net: x=70
  wire(circuit, 70, 5, 70, 6);

  return circuit;
}

// ---------------------------------------------------------------------------
// createCmosOr2
//
// NOR2 + inverter. 6 MOSFETs total.
//
// Net assignments:
//   X=10: In_1
//   X=20: In_2
//   X=30: out (inverter output)
//   X=40: VDD
//   X=50: GND
//   X=60: nor_out (NOR2 output / inverter input)
//   X=70: PMOS series mid-node in NOR2
// ---------------------------------------------------------------------------

export function createCmosOr2(_modelRegistry: TransistorModelRegistry): Circuit {
  const circuit = new Circuit({ engineType: "analog" });

  circuit.addElement(makeInEl("In_1", 10, 0));
  circuit.addElement(makeInEl("In_2", 20, 0));
  circuit.addElement(makeInEl("VDD", 40, 0));
  circuit.addElement(makeInEl("GND", 50, 0));
  circuit.addElement(makeOutEl("out", 30, 0));

  // NOR2 PMOS series pull-up: PA (source=VDD, gate=In_1, drain=mid)
  //                           PB (source=mid, gate=In_2, drain=nor_out)
  circuit.addElement(makePmos(70, 10, 40, 2));
  circuit.addElement(makePmos(60, 20, 70, 3));

  // NOR2 NMOS parallel pull-down: NA (drain=nor_out, gate=In_1, source=GND)
  //                               NB (drain=nor_out, gate=In_2, source=GND)
  circuit.addElement(makeNmos(60, 10, 50, 5));
  circuit.addElement(makeNmos(60, 20, 50, 6));

  // Inverter pull-up: PI (gate=nor_out, drain=out, source=VDD)
  circuit.addElement(makePmos(30, 60, 40, 8));

  // Inverter pull-down: NI (drain=out, gate=nor_out, source=GND)
  circuit.addElement(makeNmos(30, 60, 50, 9));

  // In_1 net: x=10
  wire(circuit, 10, 0, 10, 2);
  wire(circuit, 10, 2, 10, 5);
  // In_2 net: x=20
  wire(circuit, 20, 0, 20, 3);
  wire(circuit, 20, 3, 20, 6);
  // out net: x=30
  wire(circuit, 30, 0, 30, 8);
  wire(circuit, 30, 8, 30, 9);
  // VDD net: x=40
  wire(circuit, 40, 0, 40, 2);
  wire(circuit, 40, 2, 40, 8);
  // GND net: x=50
  wire(circuit, 50, 0, 50, 5);
  wire(circuit, 50, 5, 50, 6);
  wire(circuit, 50, 6, 50, 9);
  // nor_out net: x=60
  wire(circuit, 60, 3, 60, 5);
  wire(circuit, 60, 5, 60, 8);
  wire(circuit, 60, 8, 60, 9);
  // PMOS mid net: x=70
  wire(circuit, 70, 2, 70, 3);

  return circuit;
}

// ---------------------------------------------------------------------------
// createCmosXor2
//
// Transmission-gate XOR: 8 MOSFETs (4 NMOS + 4 PMOS).
//
// Standard CMOS XOR using two transmission gates:
//   - When A=0: TG1 passes B through to output; TG2 is open
//   - When A=1: TG2 passes complement of B (via inverter) to output; TG1 is open
//
// However, for a proper simulation-compatible XOR we use a simpler topology:
//
// Two complementary transmission gates select between B and ~B based on A/~A:
//   TG1: (NMOS gate=A, PMOS gate=~A) connecting B → out when A=1
//   TG2: (NMOS gate=~A, PMOS gate=A) connecting ~B → out when A=0
//
// A_bar is generated from an inverter on input A.
// B_bar is generated from an inverter on input B.
//
// Net assignments:
//   X=10: In_1 (A)
//   X=20: In_2 (B)
//   X=30: out
//   X=40: VDD
//   X=50: GND
//   X=60: A_bar (complement of A)
//   X=70: B_bar (complement of B)
//   X=80: PMOS mid in A inverter pull-up (internal)  — not needed; inline
//   X=81: PMOS mid in B inverter pull-up
//
// Inverter for A:  PA_inv (D=A_bar, G=A, S=VDD), NA_inv (D=A_bar, G=A, S=GND)
// Inverter for B:  PB_inv (D=B_bar, G=B, S=VDD), NB_inv (D=B_bar, G=B, S=GND)
//
// TG1 passes B to out when A=1 (~A=0):
//   TG1_N: NMOS (D=out, G=A,   S=B)
//   TG1_P: PMOS (D=out, G=A_bar, S=B)
//
// TG2 passes B_bar to out when A=0 (A_bar=1):
//   TG2_N: NMOS (D=out, G=A_bar, S=B_bar)
//   TG2_P: PMOS (D=out, G=A,     S=B_bar)
// ---------------------------------------------------------------------------

export function createCmosXor2(_modelRegistry: TransistorModelRegistry): Circuit {
  const circuit = new Circuit({ engineType: "analog" });

  circuit.addElement(makeInEl("In_1", 10, 0));
  circuit.addElement(makeInEl("In_2", 20, 0));
  circuit.addElement(makeInEl("VDD", 40, 0));
  circuit.addElement(makeInEl("GND", 50, 0));
  circuit.addElement(makeOutEl("out", 30, 0));

  // Inverter for A: A_bar at x=60
  circuit.addElement(makePmos(60, 10, 40, 2));   // PA_inv: D=A_bar, G=A, S=VDD
  circuit.addElement(makeNmos(60, 10, 50, 3));   // NA_inv: D=A_bar, G=A, S=GND

  // Inverter for B: B_bar at x=70
  circuit.addElement(makePmos(70, 20, 40, 4));   // PB_inv: D=B_bar, G=B, S=VDD
  circuit.addElement(makeNmos(70, 20, 50, 5));   // NB_inv: D=B_bar, G=B, S=GND

  // TG1: passes B to out when A=1 (A_bar=0 for PMOS gate)
  circuit.addElement(makeNmos(30, 10, 20, 6));   // TG1_N: D=out, G=A, S=B
  circuit.addElement(makePmos(30, 60, 20, 7));   // TG1_P: D=out, G=A_bar, S=B

  // TG2: passes B_bar to out when A=0 (A_bar=1 for NMOS gate)
  circuit.addElement(makeNmos(30, 60, 70, 8));   // TG2_N: D=out, G=A_bar, S=B_bar
  circuit.addElement(makePmos(30, 10, 70, 9));   // TG2_P: D=out, G=A, S=B_bar

  // In_1 (A) net: x=10
  wire(circuit, 10, 0, 10, 2);
  wire(circuit, 10, 2, 10, 3);
  wire(circuit, 10, 3, 10, 6);
  wire(circuit, 10, 6, 10, 9);
  // In_2 (B) net: x=20
  wire(circuit, 20, 0, 20, 4);
  wire(circuit, 20, 4, 20, 5);
  wire(circuit, 20, 5, 20, 6);
  wire(circuit, 20, 6, 20, 7);
  // out net: x=30
  wire(circuit, 30, 0, 30, 6);
  wire(circuit, 30, 6, 30, 7);
  wire(circuit, 30, 7, 30, 8);
  wire(circuit, 30, 8, 30, 9);
  // VDD net: x=40
  wire(circuit, 40, 0, 40, 2);
  wire(circuit, 40, 2, 40, 4);
  // GND net: x=50
  wire(circuit, 50, 0, 50, 3);
  wire(circuit, 50, 3, 50, 5);
  // A_bar net: x=60
  wire(circuit, 60, 2, 60, 3);
  wire(circuit, 60, 3, 60, 7);
  wire(circuit, 60, 7, 60, 8);
  // B_bar net: x=70
  wire(circuit, 70, 4, 70, 5);
  wire(circuit, 70, 5, 70, 8);
  wire(circuit, 70, 8, 70, 9);

  return circuit;
}

// ---------------------------------------------------------------------------
// createCmosXnor2
//
// Transmission-gate XOR (from createCmosXor2) followed by CMOS inverter.
// 10 MOSFETs total (8 from XOR + 2 from inverter).
//
// Net assignments (extending XOR assignments):
//   X=10..70: same as XOR
//   X=30: xor_out (XOR output / inverter input)
//   X=80: final out
// ---------------------------------------------------------------------------

export function createCmosXnor2(_modelRegistry: TransistorModelRegistry): Circuit {
  const circuit = new Circuit({ engineType: "analog" });

  circuit.addElement(makeInEl("In_1", 10, 0));
  circuit.addElement(makeInEl("In_2", 20, 0));
  circuit.addElement(makeInEl("VDD", 40, 0));
  circuit.addElement(makeInEl("GND", 50, 0));
  circuit.addElement(makeOutEl("out", 80, 0));

  // Inverter for A: A_bar at x=60
  circuit.addElement(makePmos(60, 10, 40, 2));
  circuit.addElement(makeNmos(60, 10, 50, 3));

  // Inverter for B: B_bar at x=70
  circuit.addElement(makePmos(70, 20, 40, 4));
  circuit.addElement(makeNmos(70, 20, 50, 5));

  // TG1: passes B to xor_out when A=1
  circuit.addElement(makeNmos(30, 10, 20, 6));
  circuit.addElement(makePmos(30, 60, 20, 7));

  // TG2: passes B_bar to xor_out when A=0
  circuit.addElement(makeNmos(30, 60, 70, 8));
  circuit.addElement(makePmos(30, 10, 70, 9));

  // Inverter: xor_out (x=30) → final out (x=80)
  circuit.addElement(makePmos(80, 30, 40, 11));
  circuit.addElement(makeNmos(80, 30, 50, 12));

  // In_1 (A) net: x=10
  wire(circuit, 10, 0, 10, 2);
  wire(circuit, 10, 2, 10, 3);
  wire(circuit, 10, 3, 10, 6);
  wire(circuit, 10, 6, 10, 9);
  // In_2 (B) net: x=20
  wire(circuit, 20, 0, 20, 4);
  wire(circuit, 20, 4, 20, 5);
  wire(circuit, 20, 5, 20, 6);
  wire(circuit, 20, 6, 20, 7);
  // xor_out net: x=30
  wire(circuit, 30, 6, 30, 7);
  wire(circuit, 30, 7, 30, 8);
  wire(circuit, 30, 8, 30, 9);
  wire(circuit, 30, 9, 30, 11);
  wire(circuit, 30, 11, 30, 12);
  // VDD net: x=40
  wire(circuit, 40, 0, 40, 2);
  wire(circuit, 40, 2, 40, 4);
  wire(circuit, 40, 4, 40, 11);
  // GND net: x=50
  wire(circuit, 50, 0, 50, 3);
  wire(circuit, 50, 3, 50, 5);
  wire(circuit, 50, 5, 50, 12);
  // A_bar net: x=60
  wire(circuit, 60, 2, 60, 3);
  wire(circuit, 60, 3, 60, 7);
  wire(circuit, 60, 7, 60, 8);
  // B_bar net: x=70
  wire(circuit, 70, 4, 70, 5);
  wire(circuit, 70, 5, 70, 8);
  wire(circuit, 70, 8, 70, 9);
  // out net: x=80
  wire(circuit, 80, 0, 80, 11);
  wire(circuit, 80, 11, 80, 12);

  return circuit;
}

// ---------------------------------------------------------------------------
// createCmosBuffer
//
// Two inverters in series. 4 MOSFETs total.
//
// Net assignments:
//   X=10: in
//   X=20: out
//   X=30: VDD
//   X=40: GND
//   X=50: mid (between inverter 1 and inverter 2)
// ---------------------------------------------------------------------------

export function createCmosBuffer(_modelRegistry: TransistorModelRegistry): Circuit {
  const circuit = new Circuit({ engineType: "analog" });

  circuit.addElement(makeInEl("in", 10, 0));
  circuit.addElement(makeInEl("VDD", 30, 0));
  circuit.addElement(makeInEl("GND", 40, 0));
  circuit.addElement(makeOutEl("out", 20, 0));

  // Inverter 1: in → mid
  circuit.addElement(makePmos(50, 10, 30, 2));
  circuit.addElement(makeNmos(50, 10, 40, 3));

  // Inverter 2: mid → out
  circuit.addElement(makePmos(20, 50, 30, 5));
  circuit.addElement(makeNmos(20, 50, 40, 6));

  // in net: x=10
  wire(circuit, 10, 0, 10, 2);
  wire(circuit, 10, 2, 10, 3);
  // out net: x=20
  wire(circuit, 20, 0, 20, 5);
  wire(circuit, 20, 5, 20, 6);
  // VDD net: x=30
  wire(circuit, 30, 0, 30, 2);
  wire(circuit, 30, 2, 30, 5);
  // GND net: x=40
  wire(circuit, 40, 0, 40, 3);
  wire(circuit, 40, 3, 40, 6);
  // mid net: x=50
  wire(circuit, 50, 2, 50, 3);
  wire(circuit, 50, 3, 50, 5);
  wire(circuit, 50, 5, 50, 6);

  return circuit;
}

// ---------------------------------------------------------------------------
// registerAllCmosGateModels
//
// Creates and registers all CMOS gate subcircuit Circuit objects in the
// TransistorModelRegistry. Called once at application startup or test setup.
// ---------------------------------------------------------------------------

export function registerAllCmosGateModels(modelRegistry: TransistorModelRegistry): void {
  modelRegistry.register("CmosInverter", createCmosInverter(modelRegistry));
  modelRegistry.register("CmosNand2", createCmosNand2(modelRegistry));
  modelRegistry.register("CmosNor2", createCmosNor2(modelRegistry));
  modelRegistry.register("CmosAnd2", createCmosAnd2(modelRegistry));
  modelRegistry.register("CmosOr2", createCmosOr2(modelRegistry));
  modelRegistry.register("CmosXor2", createCmosXor2(modelRegistry));
  modelRegistry.register("CmosXnor2", createCmosXnor2(modelRegistry));
  modelRegistry.register("CmosBuffer", createCmosBuffer(modelRegistry));
}
