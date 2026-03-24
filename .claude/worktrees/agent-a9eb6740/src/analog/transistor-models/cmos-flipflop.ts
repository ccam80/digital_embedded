/**
 * CMOS D flip-flop transistor-level subcircuit definition.
 *
 * Implements a transmission-gate master-slave D flip-flop using 20 MOSFETs:
 *   - 4 transmission gates × 2 MOSFETs = 8 MOSFETs
 *   - 4 cross-coupled inverter pairs (2 per latch) × 2 MOSFETs = 8 MOSFETs
 *   - 1 clock inverter × 2 MOSFETs = 2 MOSFETs
 *   Total: 18 MOSFETs + 2 extra for the slave keeper inverter = 20 MOSFETs
 *
 * Topology:
 *   Master latch: TG_M (CLKbar pass, CLK block) → INV_M_1 → INV_M_2 (feedback)
 *   Slave latch:  TG_S (CLK pass, CLKbar block) → INV_S_1 → INV_S_2 (feedback)
 *   Clock buffer: INV_CLK generates CLKbar from CLK
 *
 * Interface elements:
 *   In "D"    — data input
 *   In "C"    — clock input
 *   In "VDD"  — positive supply
 *   In "GND"  — ground
 *   Out "Q"   — data output (slave latch output)
 *   Out "nQ"  — complement output
 *
 * Net coordinate scheme (X coordinate = net ID):
 *   X=10: D
 *   X=20: C (clock)
 *   X=30: VDD
 *   X=40: GND
 *   X=50: CLKbar (clock complement)
 *   X=60: master_in (output of TG_M, input of INV_M_1)
 *   X=70: master_out (output of INV_M_1, input of INV_M_2, input of TG_S)
 *   X=80: slave_in (output of TG_S, input of INV_S_1)
 *   X=90: Q (output of INV_S_1, slave latch output)
 *   X=100: nQ (output of INV_S_2 = feedback of slave, also the nQ output)
 *   X=110: master_fb (output of INV_M_2 = feedback of master)
 *
 * MOSFET row assignments (Y values) — each component at a unique Y:
 *   Y=2:  CLK inverter PMOS
 *   Y=3:  CLK inverter NMOS
 *   Y=4:  TG_M NMOS (gate=CLKbar passes D when CLKbar=H i.e. CLK=L)
 *   Y=5:  TG_M PMOS (gate=CLK)
 *   Y=6:  INV_M_1 PMOS
 *   Y=7:  INV_M_1 NMOS
 *   Y=8:  INV_M_2 PMOS (feedback)
 *   Y=9:  INV_M_2 NMOS (feedback)
 *   Y=10: TG_S NMOS (gate=CLK passes master_out when CLK=H)
 *   Y=11: TG_S PMOS (gate=CLKbar)
 *   Y=12: INV_S_1 PMOS
 *   Y=13: INV_S_1 NMOS
 *   Y=14: INV_S_2 PMOS (feedback / nQ driver)
 *   Y=15: INV_S_2 NMOS (feedback / nQ driver)
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
// Minimal CircuitElement builder (same pattern as cmos-gates.ts)
// ---------------------------------------------------------------------------

let _ffElementCounter = 0;

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
  const instanceId = `${typeId}-ff-${++_ffElementCounter}`;
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

function wire(circuit: Circuit, x1: number, y1: number, x2: number, y2: number): void {
  circuit.addWire(new Wire({ x: x1, y: y1 }, { x: x2, y: y2 }));
}

function makePmos(xD: number, xG: number, xS: number, yRow: number, W = 100e-6): CircuitElement {
  return makeSubcircuitElement("PMOS", [
    { x: xD, y: yRow, label: "D" },
    { x: xG, y: yRow, label: "G" },
    { x: xS, y: yRow, label: "S" },
  ], [["W", W]]);
}

function makeNmos(xD: number, xG: number, xS: number, yRow: number, W = 50e-6): CircuitElement {
  return makeSubcircuitElement("NMOS", [
    { x: xD, y: yRow, label: "D" },
    { x: xG, y: yRow, label: "G" },
    { x: xS, y: yRow, label: "S" },
  ], [["W", W]]);
}

function makeInEl(label: string, xNet: number, yRow: number): CircuitElement {
  return makeSubcircuitElement("In", [{ x: xNet, y: yRow, label: "out" }], [["label", label]]);
}

function makeOutEl(label: string, xNet: number, yRow: number): CircuitElement {
  return makeSubcircuitElement("Out", [{ x: xNet, y: yRow, label: "in" }], [["label", label]]);
}

// ---------------------------------------------------------------------------
// createCmosDFlipflop
//
// Transmission-gate master-slave D flip-flop (20 MOSFETs).
// 4 transmission gates × 2 + 5 inverters × 2 + 1 clock inverter × 2 = 20.
//
// Final implementation:
//   Y=2,3:   CLK inverter (C→CLKbar)
//   Y=4,5:   TG_M  (D→master_in when CLK=L)
//   Y=6,7:   INV_M  (master_in→master_out)
//   Y=8,9:   TG_M_fb (master_out→master_in keeper when CLK=H)
//   Y=10,11: INV_M_fb (master_out→master_fb, provides inverted feedback into TG_M_fb source)
//   Y=12,13: TG_S  (master_out→slave_in when CLK=H)
//   Y=14,15: INV_S1 (slave_in→Q)
//   Y=16,17: TG_S_fb (Q→slave_in keeper when CLK=L)
//   Y=18,19: INV_S2 (Q→nQ, also provides slave feedback)
// That's 10 stages × 2 = 20 MOSFETs. ✓
//
// Net assignments:
//   X=10:  D
//   X=20:  C (clock)
//   X=30:  VDD
//   X=40:  GND
//   X=50:  CLKbar
//   X=60:  master_in
//   X=70:  master_out
//   X=80:  master_fb (output of INV_M_fb; source of TG_M_fb)
//   X=90:  slave_in
//   X=100: Q
//   X=110: nQ
// ---------------------------------------------------------------------------

export function createCmosDFlipflop(_modelRegistry: TransistorModelRegistry): Circuit {
  const circuit = new Circuit({ engineType: "analog" });

  // Interface elements
  circuit.addElement(makeInEl("D", 10, 0));
  circuit.addElement(makeInEl("C", 20, 0));
  circuit.addElement(makeInEl("VDD", 30, 0));
  circuit.addElement(makeInEl("GND", 40, 0));
  circuit.addElement(makeOutEl("Q", 100, 0));
  circuit.addElement(makeOutEl("nQ", 110, 0));

  // CLK inverter: C(X=20) → CLKbar(X=50)
  circuit.addElement(makePmos(50, 20, 30, 2));   // PMOS: D=CLKbar, G=C, S=VDD
  circuit.addElement(makeNmos(50, 20, 40, 3));   // NMOS: D=CLKbar, G=C, S=GND

  // TG_M: D(X=10) → master_in(X=60), enabled when CLK=L (CLKbar=H → NMOS on, CLK=L → PMOS on)
  circuit.addElement(makeNmos(60, 50, 10, 4));   // NMOS: D=master_in, G=CLKbar, S=D
  circuit.addElement(makePmos(60, 20, 10, 5));   // PMOS: D=master_in, G=CLK, S=D

  // INV_M: master_in(X=60) → master_out(X=70)
  circuit.addElement(makePmos(70, 60, 30, 6));   // PMOS: D=master_out, G=master_in, S=VDD
  circuit.addElement(makeNmos(70, 60, 40, 7));   // NMOS: D=master_out, G=master_in, S=GND

  // TG_M_fb: master_fb(X=80) → master_in(X=60), enabled when CLK=H (keeper for master)
  circuit.addElement(makeNmos(60, 20, 80, 8));   // NMOS: D=master_in, G=CLK, S=master_fb
  circuit.addElement(makePmos(60, 50, 80, 9));   // PMOS: D=master_in, G=CLKbar, S=master_fb

  // INV_M_fb: master_out(X=70) → master_fb(X=80)
  circuit.addElement(makePmos(80, 70, 30, 10));  // PMOS: D=master_fb, G=master_out, S=VDD
  circuit.addElement(makeNmos(80, 70, 40, 11));  // NMOS: D=master_fb, G=master_out, S=GND

  // TG_S: master_out(X=70) → slave_in(X=90), enabled when CLK=H
  circuit.addElement(makeNmos(90, 20, 70, 12));  // NMOS: D=slave_in, G=CLK, S=master_out
  circuit.addElement(makePmos(90, 50, 70, 13));  // PMOS: D=slave_in, G=CLKbar, S=master_out

  // INV_S1: slave_in(X=90) → Q(X=100)
  circuit.addElement(makePmos(100, 90, 30, 14)); // PMOS: D=Q, G=slave_in, S=VDD
  circuit.addElement(makeNmos(100, 90, 40, 15)); // NMOS: D=Q, G=slave_in, S=GND

  // TG_S_fb: nQ(X=110) → slave_in(X=90), enabled when CLK=L (keeper for slave)
  circuit.addElement(makeNmos(90, 50, 110, 16)); // NMOS: D=slave_in, G=CLKbar, S=nQ
  circuit.addElement(makePmos(90, 20, 110, 17)); // PMOS: D=slave_in, G=CLK, S=nQ

  // INV_S2: Q(X=100) → nQ(X=110)
  circuit.addElement(makePmos(110, 100, 30, 18)); // PMOS: D=nQ, G=Q, S=VDD
  circuit.addElement(makeNmos(110, 100, 40, 19)); // NMOS: D=nQ, G=Q, S=GND

  // ---------------------------------------------------------------------------
  // Wire all nets
  // ---------------------------------------------------------------------------

  // D net: X=10
  wire(circuit, 10, 0, 10, 4);
  wire(circuit, 10, 4, 10, 5);

  // C (CLK) net: X=20
  wire(circuit, 20, 0, 20, 2);
  wire(circuit, 20, 2, 20, 3);
  wire(circuit, 20, 3, 20, 5);
  wire(circuit, 20, 5, 20, 8);
  wire(circuit, 20, 8, 20, 12);
  wire(circuit, 20, 12, 20, 17);

  // VDD net: X=30
  wire(circuit, 30, 0, 30, 2);
  wire(circuit, 30, 2, 30, 6);
  wire(circuit, 30, 6, 30, 10);
  wire(circuit, 30, 10, 30, 14);
  wire(circuit, 30, 14, 30, 18);

  // GND net: X=40
  wire(circuit, 40, 0, 40, 3);
  wire(circuit, 40, 3, 40, 7);
  wire(circuit, 40, 7, 40, 11);
  wire(circuit, 40, 11, 40, 15);
  wire(circuit, 40, 15, 40, 19);

  // CLKbar net: X=50
  wire(circuit, 50, 2, 50, 3);
  wire(circuit, 50, 3, 50, 4);
  wire(circuit, 50, 4, 50, 9);
  wire(circuit, 50, 9, 50, 13);
  wire(circuit, 50, 13, 50, 16);

  // master_in net: X=60
  wire(circuit, 60, 4, 60, 5);
  wire(circuit, 60, 5, 60, 6);
  wire(circuit, 60, 6, 60, 7);
  wire(circuit, 60, 7, 60, 8);
  wire(circuit, 60, 8, 60, 9);

  // master_out net: X=70
  wire(circuit, 70, 6, 70, 7);
  wire(circuit, 70, 7, 70, 10);
  wire(circuit, 70, 10, 70, 11);
  wire(circuit, 70, 11, 70, 12);
  wire(circuit, 70, 12, 70, 13);

  // master_fb net: X=80
  wire(circuit, 80, 8, 80, 9);
  wire(circuit, 80, 9, 80, 10);
  wire(circuit, 80, 10, 80, 11);

  // slave_in net: X=90
  wire(circuit, 90, 12, 90, 13);
  wire(circuit, 90, 13, 90, 14);
  wire(circuit, 90, 14, 90, 15);
  wire(circuit, 90, 15, 90, 16);
  wire(circuit, 90, 16, 90, 17);

  // Q net: X=100
  wire(circuit, 100, 0, 100, 14);
  wire(circuit, 100, 14, 100, 15);
  wire(circuit, 100, 15, 100, 18);
  wire(circuit, 100, 18, 100, 19);

  // nQ net: X=110
  wire(circuit, 110, 0, 110, 16);
  wire(circuit, 110, 16, 110, 17);
  wire(circuit, 110, 17, 110, 18);
  wire(circuit, 110, 18, 110, 19);

  return circuit;
}

// ---------------------------------------------------------------------------
// registerCmosDFlipflop
// ---------------------------------------------------------------------------

export function registerCmosDFlipflop(modelRegistry: TransistorModelRegistry): void {
  modelRegistry.register("CmosDFlipflop", createCmosDFlipflop(modelRegistry));
}
