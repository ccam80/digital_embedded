/**
 * BoyleDominantPole — RC tank that defines the open-loop bandwidth in op-amp
 * macromodels.
 *
 * Two canonical SPICE primitives between the (node, gnd) port pair:
 *   rP : load resistor
 *   cP : compensation capacitor
 *
 * Pole at ω_p = 1/(rPole · cPole). Drive `node` from a current source (e.g.
 * BoyleInputStage's gM out) to realise the small-signal transfer
 *   V(node)/I_in(node) = rPole / (1 + jω · rPole · cPole).
 *
 * Internal-only — not user-placeable.
 */

import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { ComponentDefinition } from "../../core/registry.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";

const BOYLE_DOMINANT_POLE_PIN_LAYOUT: PinDeclaration[] = [
  { kind: "signal", direction: PinDirection.INPUT,  label: "node", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
  { kind: "signal", direction: PinDirection.INPUT,  label: "gnd",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
];

export const BOYLE_DOMINANT_POLE_NETLIST: MnaSubcircuitNetlist = {
  ports: ["node", "gnd"],
  params: { rPole: 100e3, cPole: 30e-12 },
  elements: [
    { typeId: "Resistor",  modelRef: "behavioral", subElementName: "rP", params: { resistance: "rPole" } },
    { typeId: "Capacitor", modelRef: "behavioral", subElementName: "cP", params: { capacitance: "cPole" } },
  ],
  internalNetCount: 0,
  netlist: [
    [0, 1],   // rP: pos=node(0), neg=gnd(1)
    [0, 1],   // cP: pos=node(0), neg=gnd(1)
  ],
};

export const BoyleDominantPoleDefinition: ComponentDefinition = {
  name: "BoyleDominantPole",
  typeId: -1,
  internalOnly: true,
  pinLayout: BOYLE_DOMINANT_POLE_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "netlist",
      netlist: BOYLE_DOMINANT_POLE_NETLIST,
      paramDefs: [
        { key: "rPole", default: 100e3 },
        { key: "cPole", default: 30e-12 },
      ],
      params: { rPole: 100e3, cPole: 30e-12 },
    },
  },
  defaultModel: "default",
};
