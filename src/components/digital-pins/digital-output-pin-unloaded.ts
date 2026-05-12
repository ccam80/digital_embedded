/**
 * DigitalOutputPinUnloaded — 3-port behaviourally-driven analog output port
 * without RC load capacitor.
 *
 * Outer ports: node (OUTPUT), gnd (OUTPUT), ctrl (INPUT).
 * Inner sub-elements:
 *   drv — BehavioralOutputDriver (3-port Norton stamp, pos=node neg=gnd ctrl=ctrl)
 *
 * The ctrl port is the node-voltage-driven control input that selects between
 * vOH and vOL targets inside the BehavioralOutputDriver leaf. Signal routing
 * is structural (net indices on the inner netlist rows).
 *
 * Source spec: §6.4 (Phase 3 — Consumer Rewrite + DigitalOutputPin Variants).
 */

import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { ComponentDefinition } from "../../core/registry.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";

const DIGITAL_OUTPUT_PIN_UNLOADED_PIN_LAYOUT: PinDeclaration[] = [
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
];

export const DIGITAL_OUTPUT_PIN_UNLOADED_NETLIST: MnaSubcircuitNetlist = {
  ports: ["node", "gnd", "ctrl"],
  params: { rOut: 100, vOH: 5, vOL: 0 },
  elements: [
    { typeId: "BehavioralOutputDriver", modelRef: "default", subElementName: "drv",
      params: { vOH: "vOH", vOL: "vOL", rOut: "rOut" } },
  ],
  internalNetCount: 0,
  netlist: [
    [0, 1, 2],   // drv: pos=node, neg=gnd, ctrl=ctrl
  ],
};

export const DigitalOutputPinUnloadedDefinition: ComponentDefinition = {
  name: "DigitalOutputPinUnloaded",
  typeId: -1,
  internalOnly: true,
  pinLayout: DIGITAL_OUTPUT_PIN_UNLOADED_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "netlist",
      netlist: DIGITAL_OUTPUT_PIN_UNLOADED_NETLIST,
      paramDefs: [
        { key: "rOut", default: 100 },
        { key: "vOH",  default: 5 },
        { key: "vOL",  default: 0 },
      ],
      params: { rOut: 100, vOH: 5, vOL: 0 },
    },
  },
  defaultModel: "default",
};
