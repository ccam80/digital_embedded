/**
 * DigitalOutputPinTriStateLoaded — 4-port behaviourally-driven analog output port with
 * tri-state enable and RC load capacitor. Pins: node (OUT), gnd (OUT), ctrl (IN), en (IN).
 * Inner sub-elements: BehavioralOutputDriverTriState (Norton at node→gnd, high-Z when en
 * low) + Capacitor (RC load). Source spec §6.4.
 */

import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { ComponentDefinition } from "../../core/registry.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";

const DIGITAL_OUTPUT_PIN_TRISTATE_LOADED_PIN_LAYOUT: PinDeclaration[] = [
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
  {
    kind: "signal",
    direction: PinDirection.INPUT,
    label: "ctrl",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    kind: "signal",
    direction: PinDirection.INPUT,
    label: "en",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  },
];

export const DIGITAL_OUTPUT_PIN_TRISTATE_LOADED_NETLIST: MnaSubcircuitNetlist = {
  ports: ["node", "gnd", "ctrl", "en"],
  params: { rOut: 100, cOut: 1e-12, vOH: 5, vOL: 0, rHiZ: 1e9 },
  elements: [
    {
      typeId: "BehavioralOutputDriverTriState",
      modelRef: "default",
      subElementName: "drv",
      params: { vOH: "vOH", vOL: "vOL", rOut: "rOut", rHiZ: "rHiZ" },
    },
    {
      typeId: "Capacitor",
      modelRef: "behavioral",
      subElementName: "cOut",
      params: { capacitance: "cOut" },
    },
  ],
  internalNetCount: 0,
  netlist: [
    [0, 1, 2, 3], // drv:  pos=node, neg=gnd, ctrl=ctrl, en=en
    [0, 1],       // cOut: pos=node, neg=gnd
  ],
};

export const DigitalOutputPinTriStateLoadedDefinition: ComponentDefinition = {
  name: "DigitalOutputPinTriStateLoaded",
  typeId: -1,
  internalOnly: true,
  pinLayout: DIGITAL_OUTPUT_PIN_TRISTATE_LOADED_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "netlist",
      netlist: DIGITAL_OUTPUT_PIN_TRISTATE_LOADED_NETLIST,
      paramDefs: [
        { key: "rOut", default: 100 },
        { key: "cOut", default: 1e-12 },
        { key: "vOH",  default: 5 },
        { key: "vOL",  default: 0 },
        { key: "rHiZ", default: 1e9 },
      ],
      params: { rOut: 100, cOut: 1e-12, vOH: 5, vOL: 0, rHiZ: 1e9 },
    },
  },
  defaultModel: "default",
};
