/**
 * DigitalOutputPinTriStateLoaded — 4-port linear Thevenin driver port with
 * tri-state enable + RC load cap.
 *
 * Outer ports: node (OUTPUT), gnd (OUTPUT), ctrl (INPUT), en (INPUT).
 *
 * Architectural contract: the digital→analog rail-voltage translation lives
 * HERE, at the pin boundary. The ctrl port carries a NORMALIZED logic-level
 * signal in [0, 1] V; the en port also carries a normalized {0, 1} V signal.
 *
 * Inner topology (E+V+S+R+C, all SPICE-faithful primitives so the harness
 * emits the deck bit-exact against ngspice):
 *
 *   vLowRail : DcVoltageSource pinning nLowRail at vOL relative to gnd.
 *   eDrive   : VCVS sensing (ctrl − gnd) and driving (nDriveV − nLowRail)
 *              with gain = (vOH − vOL).
 *   sEn      : SwitchSPST (ngspice SW), in=nDriveV, out=nSwOut, ctrl=en.
 *              VT = midEn, VH = 0, RON = 1mΩ, ROFF = rHiZ.
 *   rOut     : Thevenin output resistance from nSwOut to node.
 *   cOut     : Load capacitance from node to gnd; forms an RC with rOut and
 *              any external load.
 *
 * Hot-loadable params:
 *   - rOut  → string-bound to Resistor.resistance.
 *   - cOut  → string-bound to Capacitor.capacitance.
 *   - vOL   → string-bound to DcVoltageSource.voltage.
 *   - vOH   → hook-bound: re-derives gain = (vOH − vOL).
 *   - midEn → string-bound to SwitchSPST.vThreshold.
 *   - rHiZ  → string-bound to SwitchSPST.rOff.
 */

import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { ComponentDefinition, AnalogWrapperHookFactory } from "../../core/registry.js";
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

export function buildDigitalOutputPinTriStateLoadedNetlist(
  params: import("../../core/properties.js").PropertyBag,
): MnaSubcircuitNetlist {
  // Every key is declared in this model's paramDefs, so the unified
  // instantiation always merges it into the bag — read directly. The subcircuit
  // params map carries resolved instance values (not literal defaults) so the
  // string-refs below ("vOL"/"midEn"/"rHiZ"/"rOut"/"cOut") bind to user-set values.
  const rOut = params.getModelParam<number>("rOut");
  const cOut = params.getModelParam<number>("cOut");
  const vOH = params.getModelParam<number>("vOH");
  const vOL = params.getModelParam<number>("vOL");
  const rHiZ = params.getModelParam<number>("rHiZ");
  const midEn = params.getModelParam<number>("midEn");
  return {
    ports: ["node", "gnd", "ctrl", "en"],
    params: { rOut, cOut, vOH, vOL, rHiZ, midEn },
    elements: [
      // Port indices: node=0, gnd=1, ctrl=2, en=3.
      // Internal nets: nDriveV=4, nLowRail=5, nSwOut=6.
      {
        typeId: "DcVoltageSource",
        modelRef: "behavioral",
        subElementName: "vLowRail",
        branchCount: 1,
        params: { voltage: "vOL" },
      },
      {
        typeId: "VCVS",
        modelRef: "behavioral",
        subElementName: "eDrive",
        branchCount: 1,
        params: { gain: vOH - vOL },
      },
      {
        typeId: "SwitchSPST",
        modelRef: "behavioral",
        subElementName: "sEn",
        params: {
          vThreshold:  "midEn",
          vHysteresis: 0,
          rOn:         1e-3,
          rOff:        "rHiZ",
        },
      },
      {
        typeId: "Resistor",
        modelRef: "behavioral",
        subElementName: "rOut",
        params: { resistance: "rOut" },
      },
      {
        typeId: "Capacitor",
        modelRef: "behavioral",
        subElementName: "cOut",
        params: { capacitance: "cOut" },
      },
    ],
    internalNetCount: 3,
    internalNetLabels: ["nDriveV", "nLowRail", "nSwOut"],
    netlist: [
      [1, 5],          // vLowRail: [neg, pos] → neg=gnd(1), pos=nLowRail(5)
      [2, 1, 4, 5],    // eDrive: [ctrl+, ctrl-, out+, out-] → ctrl(2), gnd(1), nDriveV(4), nLowRail(5)
      [4, 6, 3],       // sEn: [in, out, ctrl] → in=nDriveV(4), out=nSwOut(6), ctrl=en(3)
      [6, 0],          // rOut: [pos, neg] → pos=nSwOut(6), neg=node(0)
      [0, 1],          // cOut: [pos, neg] → pos=node(0), neg=gnd(1)
    ],
  };
}

const digitalOutputPinTriStateLoadedHook: AnalogWrapperHookFactory = (
  _pinNodes,
  props,
  subElementsByName,
) => {
  let vOH = props.getModelParam<number>("vOH");
  let vOL = props.getModelParam<number>("vOL");
  const eDrive = subElementsByName.get("eDrive");
  const writeGain = (): void => {
    eDrive?.setParam("gain", vOH - vOL);
  };
  return {
    setParam(key: string, value: number): void {
      if (key === "vOH") {
        vOH = value;
        writeGain();
      } else if (key === "vOL") {
        vOL = value;
        writeGain();
      }
    },
  };
};

export const DigitalOutputPinTriStateLoadedDefinition: ComponentDefinition = {
  name: "DigitalOutputPinTriStateLoaded",
  typeId: -1,
  internalOnly: true,
  pinLayout: DIGITAL_OUTPUT_PIN_TRISTATE_LOADED_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "netlist",
      netlist: buildDigitalOutputPinTriStateLoadedNetlist,
      paramDefs: [
        { key: "rOut",  default: 100 },
        { key: "cOut",  default: 1e-12 },
        { key: "vOH",   default: 5 },
        { key: "vOL",   default: 0 },
        { key: "rHiZ",  default: 1e9 },
        { key: "midEn", default: 0.5 },
      ],
      params: {},
    },
  },
  defaultModel: "default",
  analogWrapperHook: digitalOutputPinTriStateLoadedHook,
};
