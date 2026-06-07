/**
 * DigitalOutputPinLoaded — 3-port linear Thevenin driver port + RC load cap.
 *
 * Outer ports: node (OUTPUT), gnd (OUTPUT), ctrl (INPUT).
 *
 * Architectural contract: the digital→analog rail-voltage translation lives
 * HERE, at the pin boundary. The ctrl port carries a NORMALIZED logic-level
 * signal in [0, 1] V; this composite maps that to the rail-level output via
 * a linear Thevenin source. Upstream behavioural drivers (counter, register,
 * gates, etc.) are migrating to stamp their bit nodes at {0, 1} V to feed
 * this contract — see the "behavioural-driver-normalization" thread.
 *
 * Inner topology (E+V+R+C, all SPICE-faithful primitives so the harness emits
 * the deck bit-exact against ngspice):
 *
 *   vLowRail : DcVoltageSource pinning nLowRail at vOL relative to gnd.
 *   eDrive   : VCVS sensing (ctrl − gnd) and driving (nDriveV − nLowRail)
 *              with gain = (vOH − vOL). Closed-form output:
 *                V(nDriveV) = vOL + V(ctrl) · (vOH − vOL).
 *              ctrl = 0 → nDriveV = vOL;  ctrl = 1 → nDriveV = vOH.
 *   rOut     : Thevenin output resistance from nDriveV to node.
 *   cOut     : Load capacitance from node to gnd; forms an RC with rOut and
 *              any external load.
 *
 * Hot-loadable params:
 *   - rOut  → string-bound to Resistor.resistance.
 *   - cOut  → string-bound to Capacitor.capacitance.
 *   - vOL   → string-bound to DcVoltageSource.voltage.
 *   - vOH   → not directly bound; the analogWrapperHook re-derives
 *             gain = (vOH − vOL) on every setParam("vOH", …) / setParam("vOL", …)
 *             and writes it to eDrive via setParam("gain", …).
 */

import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { ComponentDefinition, AnalogWrapperHookFactory } from "../../core/registry.js";
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

export function buildDigitalOutputPinLoadedNetlist(
  params: import("../../core/properties.js").PropertyBag,
): MnaSubcircuitNetlist {
  // Every key is declared in this model's paramDefs, so the unified
  // instantiation always merges it into the bag — read directly. The subcircuit
  // params map carries the resolved instance values (not literal defaults) so
  // the "rOut"/"cOut"/"vOL" string-refs below bind to user-set values.
  const rOut = params.getModelParam<number>("rOut");
  const cOut = params.getModelParam<number>("cOut");
  const vOH = params.getModelParam<number>("vOH");
  const vOL = params.getModelParam<number>("vOL");
  return {
    ports: ["node", "gnd", "ctrl"],
    params: { rOut, cOut, vOH, vOL },
    elements: [
      // Port indices: node=0, gnd=1, ctrl=2.  Internal nets: nDriveV=3, nLowRail=4.
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
    internalNetCount: 2,
    internalNetLabels: ["nDriveV", "nLowRail"],
    netlist: [
      [1, 4],          // vLowRail: [neg, pos] → neg=gnd(1), pos=nLowRail(4)
      [2, 1, 3, 4],    // eDrive: [ctrl+, ctrl-, out+, out-] → ctrl(2), gnd(1), nDriveV(3), nLowRail(4)
      [3, 0],          // rOut: [pos, neg] → pos=nDriveV(3), neg=node(0)
      [0, 1],          // cOut: [pos, neg] → pos=node(0), neg=gnd(1)
    ],
  };
}

const digitalOutputPinLoadedHook: AnalogWrapperHookFactory = (
  _pinNodes,
  props,
  _getTime,
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

export const DigitalOutputPinLoadedDefinition: ComponentDefinition = {
  name: "DigitalOutputPinLoaded",
  typeId: -1,
  internalOnly: true,
  pinLayout: DIGITAL_OUTPUT_PIN_LOADED_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "netlist",
      netlist: buildDigitalOutputPinLoadedNetlist,
      paramDefs: [
        { key: "rOut", default: 100 },
        { key: "cOut", default: 1e-12 },
        { key: "vOH",  default: 5 },
        { key: "vOL",  default: 0 },
      ],
      params: {},
    },
  },
  defaultModel: "default",
  analogWrapperHook: digitalOutputPinLoadedHook,
};
