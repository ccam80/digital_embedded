import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { ComponentDefinition } from "../../core/registry.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";

const DIGITAL_OUTPUT_PIN_LOADED_PIN_LAYOUT: PinDeclaration[] = [
  {
    kind: "signal",
    direction: PinDirection.OUTPUT,
    label: "node",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    kind: "signal",
    direction: PinDirection.OUTPUT,
    label: "gnd",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  },
];

/**
 * DigitalOutputPinLoaded — behaviourally-driven analog output port with RC load.
 * Inner sub-elements: BehavioralOutputDriver (Norton at node→gnd) + Capacitor (RC).
 * Phase 3 reshapes this to 3-port (node, gnd, ctrl) and wires drv.ctrl ← composite.ctrl.
 */
export const DIGITAL_OUTPUT_PIN_LOADED_NETLIST: MnaSubcircuitNetlist = {
  ports: ["node", "gnd"],
  params: { rOut: 100, cOut: 1e-12, vOH: 5, vOL: 0 },
  elements: [
    { typeId: "BehavioralOutputDriver", modelRef: "default", subElementName: "drv",
      params: { vOH: "vOH", vOL: "vOL", rOut: "rOut" } },
    { typeId: "Capacitor", modelRef: "behavioral", subElementName: "cOut", params: { capacitance: "cOut" } },
  ],
  internalNetCount: 0,
  netlist: [
    [0, 1],   // drv:  pos=node, neg=gnd
    [0, 1],   // cOut: pos=node, neg=gnd
  ],
};

export const DigitalOutputPinLoadedDefinition: ComponentDefinition = {
  name: "DigitalOutputPinLoaded",
  typeId: -1,
  internalOnly: true,
  pinLayout: DIGITAL_OUTPUT_PIN_LOADED_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "netlist",
      netlist: DIGITAL_OUTPUT_PIN_LOADED_NETLIST,
      paramDefs: [
        { key: "rOut",     default: 100 },
        { key: "cOut",     default: 1e-12 },
        { key: "vOH",      default: 5 },
        { key: "vOL",      default: 0 },
      ],
      params: { rOut: 100, cOut: 1e-12, vOH: 5, vOL: 0 },
    },
  },
  defaultModel: "default",
};
