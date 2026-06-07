/**
 * DigitalOutputPinUnloaded — 3-port linear Thevenin driver port, no load cap.
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
 * Inner topology (E+V+R, all SPICE-faithful primitives so the harness emits
 * the deck bit-exact against ngspice):
 *
 *   vLowRail : DcVoltageSource pinning nLowRail at vOL relative to gnd.
 *   eDrive   : VCVS sensing (ctrl − gnd) and driving (nDriveV − nLowRail)
 *              with gain = (vOH − vOL). Closed-form output:
 *                V(nDriveV) = vOL + V(ctrl) · (vOH − vOL).
 *              ctrl = 0 → nDriveV = vOL;  ctrl = 1 → nDriveV = vOH.
 *   rOut     : Thevenin output resistance from nDriveV to node.
 *
 * The linear E-source replaces the threshold-snap Norton stamp used by the
 * old `BehavioralOutputDriver` leaf. Why linear: the discontinuity-free path
 * lets the Newton iteration converge in normal counts (no dt-collapse at
 * transition edges), and the Thevenin equivalent (target through R_out) is
 * exact at ctrl = 0 / ctrl = 1, which is where the digital-bit input
 * effectively sits in steady state.
 *
 * Hot-loadable params:
 *   - rOut → string-bound to Resistor.resistance.
 *   - vOL  → string-bound to DcVoltageSource.voltage.
 *   - vOH  → not directly bound; the analogWrapperHook re-derives
 *            gain = (vOH − vOL) on every setParam("vOH", …) / setParam("vOL", …)
 *            and writes it to eDrive via setParam("gain", …).
 */

import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { ComponentDefinition, AnalogWrapperHookFactory } from "../../core/registry.js";
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

export function buildDigitalOutputPinUnloadedNetlist(
  params: import("../../core/properties.js").PropertyBag,
): MnaSubcircuitNetlist {
  // Keys are declared in paramDefs and merged into the bag by the unified
  // instantiation — read directly. The subcircuit params map carries resolved
  // instance values so the "vOL"/"rOut" string-refs bind to user-set values.
  const rOut = params.getModelParam<number>("rOut");
  const vOH = params.getModelParam<number>("vOH");
  const vOL = params.getModelParam<number>("vOL");
  return {
    ports: ["node", "gnd", "ctrl"],
    params: { rOut, vOH, vOL },
    elements: [
      // Port indices: node=0, gnd=1, ctrl=2.  Internal nets: nDriveV=3, nLowRail=4.
      {
        typeId: "DcVoltageSource",
        modelRef: "behavioral",
        subElementName: "vLowRail",
        branchCount: 1,
        // String-bound so setParam("vOL", x) on the wrapper routes here.
        params: { voltage: "vOL" },
      },
      {
        typeId: "VCVS",
        modelRef: "behavioral",
        subElementName: "eDrive",
        branchCount: 1,
        // Derived initial value: hook re-derives on subsequent setParam.
        params: { gain: vOH - vOL },
      },
      {
        typeId: "Resistor",
        modelRef: "behavioral",
        subElementName: "rOut",
        // String-bound so setParam("rOut", x) routes here.
        params: { resistance: "rOut" },
      },
    ],
    internalNetCount: 2,
    internalNetLabels: ["nDriveV", "nLowRail"],
    netlist: [
      [1, 4],          // vLowRail: pinLayout [neg, pos] → neg=gnd(1), pos=nLowRail(4)
      [2, 1, 3, 4],    // eDrive: pinLayout [ctrl+, ctrl-, out+, out-] → ctrl(2), gnd(1), nDriveV(3), nLowRail(4)
      [3, 0],          // rOut: pinLayout [pos, neg] → pos=nDriveV(3), neg=node(0)
    ],
  };
}

/**
 * Parent-side hook: keeps the inner VCVS gain in sync with the user-facing
 * (vOH, vOL) pair. Hot-loaded changes to either rail re-derive
 * gain = (vOH − vOL) and push it to the eDrive sub-element by name.
 *
 * The wrapper invokes hook.setParam BEFORE its binding-map dispatch, so by
 * the time the binding map writes the new vOL to vLowRail.voltage, the hook
 * has already updated eDrive.gain consistently.
 */
const digitalOutputPinUnloadedHook: AnalogWrapperHookFactory = (
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

export const DigitalOutputPinUnloadedDefinition: ComponentDefinition = {
  name: "DigitalOutputPinUnloaded",
  typeId: -1,
  internalOnly: true,
  pinLayout: DIGITAL_OUTPUT_PIN_UNLOADED_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "netlist",
      netlist: buildDigitalOutputPinUnloadedNetlist,
      paramDefs: [
        { key: "rOut", default: 100 },
        { key: "vOH",  default: 5 },
        { key: "vOL",  default: 0 },
      ],
      params: {},
    },
  },
  defaultModel: "default",
  analogWrapperHook: digitalOutputPinUnloadedHook,
};
