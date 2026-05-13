/**
 * BoyleOutputStage — unity-gain output buffer with Thevenin output impedance.
 *
 * Two canonical SPICE primitives between the (in, out, gnd) ports:
 *   eBuf : VCVS sensing (V(in) - V(gnd)) and driving (nBuf - gnd) with gain 1
 *   rOut : Thevenin output resistance from nBuf to out
 *
 * Rail-clamping diodes are intentionally NOT included here — they sit in the
 * RealOpAmp / Comparator outer netlist that wraps this stage, alongside the
 * vClampHi / vClampLo voltage rails. Keeping the buffer clamp-free lets the
 * same block serve every macromodel (rail-to-rail, single-supply, ±15 V) with
 * the clamp topology chosen by the consumer.
 *
 * Internal-only — not user-placeable.
 */

import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { ComponentDefinition } from "../../core/registry.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";

const BOYLE_OUTPUT_STAGE_PIN_LAYOUT: PinDeclaration[] = [
  { kind: "signal", direction: PinDirection.INPUT,  label: "in",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
  { kind: "signal", direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
  { kind: "signal", direction: PinDirection.INPUT,  label: "gnd", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
];

export const BOYLE_OUTPUT_STAGE_NETLIST: MnaSubcircuitNetlist = {
  ports: ["in", "out", "gnd"],
  params: { rOut: 75 },
  elements: [
    { typeId: "VCVS",     modelRef: "behavioral", subElementName: "eBuf", params: { gain: 1 } },
    { typeId: "Resistor", modelRef: "behavioral", subElementName: "rOut", params: { resistance: "rOut" } },
  ],
  internalNetCount: 1,
  internalNetLabels: ["nBuf"],
  netlist: [
    [0, 2, 3, 2],   // eBuf: ctrl+=in(0), ctrl-=gnd(2), out+=nBuf(3), out-=gnd(2)
    [3, 1],         // rOut: pos=nBuf(3), neg=out(1)
  ],
};

export const BoyleOutputStageDefinition: ComponentDefinition = {
  name: "BoyleOutputStage",
  typeId: -1,
  internalOnly: true,
  pinLayout: BOYLE_OUTPUT_STAGE_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "netlist",
      netlist: BOYLE_OUTPUT_STAGE_NETLIST,
      paramDefs: [
        { key: "rOut", default: 75 },
      ],
      params: { rOut: 75 },
    },
  },
  defaultModel: "default",
};
