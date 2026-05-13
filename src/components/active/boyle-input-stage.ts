/**
 * BoyleInputStage — linearised differential input stage for op-amp macromodels.
 *
 * Small-signal Boyle/PSpice OpAmp macromodel input stage, expressed as three
 * canonical SPICE primitives so the netlist generator can emit it bit-exact:
 *
 *   rD  : differential input resistance Rd  between inP and inN
 *   cD  : differential input capacitance Cd  between inP and inN
 *   gM  : VCCS sensing (V(inP)−V(inN)) and driving (out → gnd) with gm
 *
 * Cascade: place a BoyleDominantPole between (out, gnd) to set the dominant
 * pole; the gm·R_p product gives the open-loop DC gain, ω_p = 1/(R_p·C_p)
 * sets the unity-gain bandwidth.
 *
 * Internal-only — not user-placeable. Consumed by RealOpAmp / OpAmp /
 * VoltageComparator composites once their migrations land.
 */

import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { ComponentDefinition } from "../../core/registry.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";

const BOYLE_INPUT_STAGE_PIN_LAYOUT: PinDeclaration[] = [
  { kind: "signal", direction: PinDirection.INPUT,  label: "inP", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
  { kind: "signal", direction: PinDirection.INPUT,  label: "inN", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
  { kind: "signal", direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
  { kind: "signal", direction: PinDirection.INPUT,  label: "gnd", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
];

export const BOYLE_INPUT_STAGE_NETLIST: MnaSubcircuitNetlist = {
  ports: ["inP", "inN", "out", "gnd"],
  params: { rIn: 2e6, cIn: 1.4e-12, gm: 1.88e-4 },
  elements: [
    { typeId: "Resistor",  modelRef: "behavioral", subElementName: "rD", params: { resistance: "rIn" } },
    { typeId: "Capacitor", modelRef: "behavioral", subElementName: "cD", params: { capacitance: "cIn" } },
    { typeId: "VCCS",      modelRef: "behavioral", subElementName: "gM", params: { transconductance: "gm" } },
  ],
  internalNetCount: 0,
  netlist: [
    [0, 1],         // rD: pos=inP(0), neg=inN(1)
    [0, 1],         // cD: pos=inP(0), neg=inN(1)
    [0, 1, 2, 3],   // gM: ctrl+=inP(0), ctrl-=inN(1), out+=out(2), out-=gnd(3)
  ],
};

export const BoyleInputStageDefinition: ComponentDefinition = {
  name: "BoyleInputStage",
  typeId: -1,
  internalOnly: true,
  pinLayout: BOYLE_INPUT_STAGE_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "netlist",
      netlist: BOYLE_INPUT_STAGE_NETLIST,
      paramDefs: [
        { key: "rIn", default: 2e6 },
        { key: "cIn", default: 1.4e-12 },
        { key: "gm",  default: 1.88e-4 },
      ],
      params: { rIn: 2e6, cIn: 1.4e-12, gm: 1.88e-4 },
    },
  },
  defaultModel: "default",
};
