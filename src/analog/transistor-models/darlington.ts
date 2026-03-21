/**
 * NPN/PNP Darlington transistor pair subcircuit definitions.
 *
 * Each Darlington is two BJTs wired so that the collector of Q1 connects to
 * the shared collector terminal, the emitter of Q1 connects to the base of
 * Q2, and Q2's collector also connects to the shared collector terminal.
 * An optional base-emitter resistor R_BE (10 kΩ) across Q2's B-E junction
 * speeds up turn-off by providing a discharge path.
 *
 * Terminal mapping (same as a single BJT):
 *   In "B"   — base terminal → Q1 base
 *   In "C"   — collector terminal → Q1 collector + Q2 collector (shared)
 *   In "E"   — emitter terminal → Q2 emitter
 *
 * Internal nets:
 *   X=10: B   — base terminal
 *   X=20: C   — collector terminal (shared by Q1 and Q2 collectors)
 *   X=30: E   — emitter terminal
 *   X=40: Q1E_Q2B — Q1 emitter / Q2 base (internal node)
 *
 * BJT pin order: C, B, E  (matching bjt.ts pin layout)
 *
 * Net coordinate scheme (X coordinate = net ID):
 *   Q1: C=20, B=10, E=40
 *   Q2: C=20, B=40, E=30
 *   R_BE: between 40 and 30 (Q2 base-emitter)
 *
 * Wire connectivity uses unique (x, y) positions per element.
 * Shared X coordinate → same MNA net.
 */

import { Circuit, Wire } from "../../core/circuit.js";
import { PropertyBag } from "../../core/properties.js";
import { PinDirection } from "../../core/pin.js";
import type { Pin, PinDeclaration } from "../../core/pin.js";
import type { CircuitElement } from "../../core/element.js";
import type { Rect, RenderContext } from "../../core/renderer-interface.js";
import type { SerializedElement } from "../../core/element.js";
import {
  ComponentCategory,
  noOpAnalogExecuteFn,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { TransistorModelRegistry } from "../transistor-model-registry.js";

// ---------------------------------------------------------------------------
// Minimal CircuitElement builder for subcircuit elements
// (same pattern as cmos-gates.ts)
// ---------------------------------------------------------------------------

let _darlingtonCounter = 0;

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
  const instanceId = `${typeId}-drl-${++_darlingtonCounter}`;
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
// Wire helper
// ---------------------------------------------------------------------------

function wire(circuit: Circuit, x1: number, y1: number, x2: number, y2: number): void {
  circuit.addWire(new Wire({ x: x1, y: y1 }, { x: x2, y: y2 }));
}

// ---------------------------------------------------------------------------
// BJT element helpers
//
// BJT pin order: C (collector), B (base), E (emitter) — from bjt.ts
// Each BJT element has 3 pins, placed at (xC,y), (xB,y), (xE,y).
// ---------------------------------------------------------------------------

function makeNpnBjt(xC: number, xB: number, xE: number, yRow: number): CircuitElement {
  return makeSubcircuitElement("NpnBJT", [
    { x: xC, y: yRow, label: "C" },
    { x: xB, y: yRow, label: "B" },
    { x: xE, y: yRow, label: "E" },
  ]);
}

function makePnpBjt(xC: number, xB: number, xE: number, yRow: number): CircuitElement {
  return makeSubcircuitElement("PnpBJT", [
    { x: xC, y: yRow, label: "C" },
    { x: xB, y: yRow, label: "B" },
    { x: xE, y: yRow, label: "E" },
  ]);
}

// Resistor element: 2 pins at (xA, yRow) and (xB, yRow)
function makeResistor(xA: number, xB: number, yRow: number, resistance: number): CircuitElement {
  return makeSubcircuitElement("Resistor", [
    { x: xA, y: yRow, label: "A" },
    { x: xB, y: yRow, label: "B" },
  ], [["resistance", resistance]]);
}

// Interface element helpers
function makeInEl(label: string, xNet: number, yRow: number): CircuitElement {
  return makeSubcircuitElement("In", [{ x: xNet, y: yRow, label: "out" }], [["label", label]]);
}

// ---------------------------------------------------------------------------
// createNpnDarlington
//
// Two NPN BJTs in Darlington configuration with R_BE across Q2 B-E:
//
//   Terminal B (x=10): Q1 base
//   Terminal C (x=20): Q1 collector + Q2 collector (shared)
//   Terminal E (x=30): Q2 emitter
//   Internal Q1E_Q2B (x=40): Q1 emitter = Q2 base
//   R_BE (10kΩ) across Q2 B-E: between x=40 and x=30
//
// BJT element rows: Q1 at y=2, Q2 at y=4, R_BE at y=6
// ---------------------------------------------------------------------------

export function createNpnDarlington(_registry: TransistorModelRegistry): Circuit {
  const circuit = new Circuit({ engineType: "analog" });

  // Interface elements
  circuit.addElement(makeInEl("B", 10, 0));
  circuit.addElement(makeInEl("C", 20, 0));
  circuit.addElement(makeInEl("E", 30, 0));

  // Q1: NPN BJT, C=20, B=10, E=40
  circuit.addElement(makeNpnBjt(20, 10, 40, 2));

  // Q2: NPN BJT, C=20, B=40, E=30
  circuit.addElement(makeNpnBjt(20, 40, 30, 4));

  // R_BE: 10kΩ between Q2 base (x=40) and Q2 emitter (x=30)
  circuit.addElement(makeResistor(40, 30, 6, 10000));

  // B net: x=10
  wire(circuit, 10, 0, 10, 2);

  // C net: x=20 — shared collector for Q1 and Q2
  wire(circuit, 20, 0, 20, 2);
  wire(circuit, 20, 2, 20, 4);

  // E net: x=30 — Q2 emitter + R_BE terminal B + interface E
  wire(circuit, 30, 0, 30, 4);
  wire(circuit, 30, 4, 30, 6);

  // Q1E_Q2B net: x=40 — Q1 emitter + Q2 base + R_BE terminal A
  wire(circuit, 40, 2, 40, 4);
  wire(circuit, 40, 4, 40, 6);

  return circuit;
}

// ---------------------------------------------------------------------------
// createPnpDarlington
//
// Two PNP BJTs in Darlington configuration with R_BE across Q2 B-E.
// Same topology as NPN but with PnpBJT elements.
// ---------------------------------------------------------------------------

export function createPnpDarlington(_registry: TransistorModelRegistry): Circuit {
  const circuit = new Circuit({ engineType: "analog" });

  // Interface elements
  circuit.addElement(makeInEl("B", 10, 0));
  circuit.addElement(makeInEl("C", 20, 0));
  circuit.addElement(makeInEl("E", 30, 0));

  // Q1: PNP BJT, C=20, B=10, E=40
  circuit.addElement(makePnpBjt(20, 10, 40, 2));

  // Q2: PNP BJT, C=20, B=40, E=30
  circuit.addElement(makePnpBjt(20, 40, 30, 4));

  // R_BE: 10kΩ between Q2 base (x=40) and Q2 emitter (x=30)
  circuit.addElement(makeResistor(40, 30, 6, 10000));

  // B net: x=10
  wire(circuit, 10, 0, 10, 2);

  // C net: x=20 — shared collector for Q1 and Q2
  wire(circuit, 20, 0, 20, 2);
  wire(circuit, 20, 2, 20, 4);

  // E net: x=30 — Q2 emitter + R_BE terminal B + interface E
  wire(circuit, 30, 0, 30, 4);
  wire(circuit, 30, 4, 30, 6);

  // Q1E_Q2B net: x=40 — Q1 emitter + Q2 base + R_BE terminal A
  wire(circuit, 40, 2, 40, 4);
  wire(circuit, 40, 4, 40, 6);

  return circuit;
}

// ---------------------------------------------------------------------------
// Pin layout — same as single BJT (B, C, E terminals)
// ---------------------------------------------------------------------------

function buildDarlingtonPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "B",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "C",
      defaultBitWidth: 1,
      position: { x: 2, y: -1.5 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "E",
      defaultBitWidth: 1,
      position: { x: 2, y: 1.5 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// registerDarlingtonModels
// ---------------------------------------------------------------------------

/**
 * Register NPN and PNP Darlington subcircuits in the TransistorModelRegistry
 * and return the two ComponentDefinitions.
 *
 * The ComponentDefinitions are returned (not registered in ComponentRegistry)
 * so callers can choose when to add them to the component registry.
 */
export function registerDarlingtonModels(registry: TransistorModelRegistry): void {
  registry.register("DarlingtonNPN", createNpnDarlington(registry));
  registry.register("DarlingtonPNP", createPnpDarlington(registry));
}

// ---------------------------------------------------------------------------
// ComponentDefinitions
// ---------------------------------------------------------------------------

export const DarlingtonNpnDefinition: ComponentDefinition = {
  name: "DarlingtonNPN",
  typeId: -1,
  engineType: "analog",
  factory: (_props) => {
    throw new Error("DarlingtonNPN uses transistor-level expansion; no circuit element factory needed");
  },
  executeFn: noOpAnalogExecuteFn,
  pinLayout: buildDarlingtonPinDeclarations(),
  propertyDefs: [],
  attributeMap: [],
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "NPN Darlington transistor pair.\n" +
    "Two NPN BJTs in Darlington configuration with R_BE = 10 kΩ.\n" +
    "Pins: B (base), C (collector), E (emitter).",
  transistorModel: "DarlingtonNPN",
  simulationModes: ["analog-internals"],
};

export const DarlingtonPnpDefinition: ComponentDefinition = {
  name: "DarlingtonPNP",
  typeId: -1,
  engineType: "analog",
  factory: (_props) => {
    throw new Error("DarlingtonPNP uses transistor-level expansion; no circuit element factory needed");
  },
  executeFn: noOpAnalogExecuteFn,
  pinLayout: buildDarlingtonPinDeclarations(),
  propertyDefs: [],
  attributeMap: [],
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "PNP Darlington transistor pair.\n" +
    "Two PNP BJTs in Darlington configuration with R_BE = 10 kΩ.\n" +
    "Pins: B (base), C (collector), E (emitter).",
  transistorModel: "DarlingtonPNP",
  simulationModes: ["analog-internals"],
};
