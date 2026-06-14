/**
 * DigitalInputBoundaryAdapter — single-port (node) analog adapter for a
 * digital INPUT pin sensing an analog hub net.
 *
 * Two variants share one outer port `node` (INPUT) — the shared analog hub.
 * `gnd` is a netlist port that resolves to MNA node 0 via the reserved-port
 * rule in expandCompositeInstance (compiler.ts:487-499). `nResult` is an
 * internal net whose voltage the coordinator reads and thresholds back to a
 * digital bit; its MNA node id is resolved from compositeInternalIds keyed
 * `${adapterLabel}#nResult`.
 *
 *   Loaded   wraps DigitalInputPinLoaded   (rIn/cIn input load + threshold).
 *   Unloaded wraps DigitalInputPinUnloaded (high-Z input + threshold).
 *
 * Inner topology:
 *   pin : DigitalInputPin*(node, gnd, result=nResult). Presents rIn/cIn loading
 *         (loaded variant) on the hub and computes the ngspice-faithful
 *         threshold classifier onto nResult:
 *         result = (v>vIH)?1 : (v<vIL)?0 : 0.5.
 *
 * Static electricals (rIn/cIn/vIH/vIL) forward to the inner pin via string
 * binding, so they hot-load through wrapper.setParam.
 */

import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { ComponentDefinition } from "../../core/registry.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";

const DIGITAL_INPUT_BOUNDARY_ADAPTER_PIN_LAYOUT: PinDeclaration[] = [
  {
    kind: "signal",
    direction: PinDirection.INPUT,
    label: "node",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  },
];

function buildInputBoundaryNetlist(
  params: import("../../core/properties.js").PropertyBag,
  innerTypeId: "DigitalInputPinLoaded" | "DigitalInputPinUnloaded",
  loaded: boolean,
): MnaSubcircuitNetlist {
  const vIH = params.getModelParam<number>("vIH");
  const vIL = params.getModelParam<number>("vIL");
  const rIn = loaded ? params.getModelParam<number>("rIn") : 0;
  const cIn = loaded ? params.getModelParam<number>("cIn") : 0;

  const innerPinParams: Record<string, string> = loaded
    ? { rIn: "rIn", cIn: "cIn", vIH: "vIH", vIL: "vIL" }
    : { vIH: "vIH", vIL: "vIL" };

  const sharedParams: Record<string, number> = loaded
    ? { rIn, cIn, vIH, vIL }
    : { vIH, vIL };

  return {
    // Port indices: node=0, gnd=1 (gnd → node 0). Internal net: nResult=2.
    ports: ["node", "gnd"],
    params: sharedParams,
    elements: [
      {
        typeId: innerTypeId,
        modelRef: "default",
        subElementName: "pin",
        params: innerPinParams,
      },
    ],
    internalNetCount: 1,
    internalNetLabels: ["nResult"],
    netlist: [
      [0, 1, 2],       // pin: [node, gnd, result] → node(0), gnd(1→0), nResult(2)
    ],
  };
}

export function buildDigitalInputBoundaryAdapterLoadedNetlist(
  params: import("../../core/properties.js").PropertyBag,
): MnaSubcircuitNetlist {
  return buildInputBoundaryNetlist(params, "DigitalInputPinLoaded", true);
}

export function buildDigitalInputBoundaryAdapterUnloadedNetlist(
  params: import("../../core/properties.js").PropertyBag,
): MnaSubcircuitNetlist {
  return buildInputBoundaryNetlist(params, "DigitalInputPinUnloaded", false);
}

export const DigitalInputBoundaryAdapterLoadedDefinition: ComponentDefinition = {
  name: "DigitalInputBoundaryAdapterLoaded",
  typeId: -1,
  internalOnly: true,
  pinLayout: DIGITAL_INPUT_BOUNDARY_ADAPTER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "netlist",
      netlist: buildDigitalInputBoundaryAdapterLoadedNetlist,
      paramDefs: [
        { key: "rIn", default: 1e6 },
        { key: "cIn", default: 1e-12 },
        { key: "vIH", default: 2.0 },
        { key: "vIL", default: 0.8 },
      ],
      params: {},
    },
  },
  defaultModel: "default",
};

export const DigitalInputBoundaryAdapterUnloadedDefinition: ComponentDefinition = {
  name: "DigitalInputBoundaryAdapterUnloaded",
  typeId: -1,
  internalOnly: true,
  pinLayout: DIGITAL_INPUT_BOUNDARY_ADAPTER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "netlist",
      netlist: buildDigitalInputBoundaryAdapterUnloadedNetlist,
      paramDefs: [
        { key: "vIH", default: 2.0 },
        { key: "vIL", default: 0.8 },
      ],
      params: {},
    },
  },
  defaultModel: "default",
};
