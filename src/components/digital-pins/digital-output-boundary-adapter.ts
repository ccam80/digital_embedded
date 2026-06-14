/**
 * DigitalOutputBoundaryAdapter — single-port (node) analog adapter for a
 * digital OUTPUT pin crossing onto an analog hub net.
 *
 * Two variants share one outer port `node` (OUTPUT) — the shared analog hub.
 * `gnd` is a netlist port that resolves to MNA node 0 via the reserved-port
 * rule in expandCompositeInstance (compiler.ts:487-499: a `gnd`/`GND` port
 * absent from the parent's pinLayout binds to global ground).
 *
 *   Loaded   wraps DigitalOutputPinTriStateLoaded   (rOut Thevenin + cOut load).
 *   Unloaded wraps DigitalOutputPinTriStateUnloaded (rOut Thevenin, no load cap).
 *
 * Inner topology (all SPICE-faithful primitives so the harness emits the deck
 * bit-exact against ngspice):
 *
 *   vCtrl : DcVoltageSource pinning nCtrl at the normalized logic level
 *           {0,1} V (coordinator drives via wrapper.setParam("ctrl", high?1:0)).
 *   vEn   : DcVoltageSource pinning nEn at the normalized enable {0,1} V
 *           (coordinator drives via wrapper.setParam("en", hiZ?0:1)).
 *   pin   : DigitalOutputPinTriState*(node, gnd, ctrl=nCtrl, en=nEn). Maps the
 *           normalized ctrl onto vOL..vOH through rOut, with sEn presenting
 *           rHiZ when en is low.
 *
 * The composite NEVER pins `node`: the inner tri-state pin presents a finite
 * Thevenin (rOut) source — or rHiZ when disabled — onto the hub. Multiple
 * output adapters on one hub combine resistively (parallel Thevenins), and a
 * disabled adapter releases the hub.
 *
 * Hot-loadable params (coordinator-driven, per NR-accepted step):
 *   - ctrl → string-bound to vCtrl.voltage  (logic level, normalized {0,1}).
 *   - en   → string-bound to vEn.voltage     (enable, normalized {0,1}).
 * Static electricals (rOut/cOut/vOH/vOL/rHiZ/midEn) forward to the inner pin.
 */

import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { ComponentDefinition } from "../../core/registry.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";

const DIGITAL_OUTPUT_BOUNDARY_ADAPTER_PIN_LAYOUT: PinDeclaration[] = [
  {
    kind: "signal",
    direction: PinDirection.OUTPUT,
    label: "node",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  },
];

function buildOutputBoundaryNetlist(
  params: import("../../core/properties.js").PropertyBag,
  innerTypeId: "DigitalOutputPinTriStateLoaded" | "DigitalOutputPinTriStateUnloaded",
  loaded: boolean,
): MnaSubcircuitNetlist {
  const rOut = params.getModelParam<number>("rOut");
  const vOH = params.getModelParam<number>("vOH");
  const vOL = params.getModelParam<number>("vOL");
  const rHiZ = params.getModelParam<number>("rHiZ");
  const midEn = params.getModelParam<number>("midEn");
  const ctrl = params.getModelParam<number>("ctrl");
  const en = params.getModelParam<number>("en");
  // cOut only exists on the loaded variant; read it conditionally so the
  // unloaded paramDefs stay free of cOut.
  const cOut = loaded ? params.getModelParam<number>("cOut") : 0;

  const innerPinParams: Record<string, string> = loaded
    ? { rOut: "rOut", cOut: "cOut", vOH: "vOH", vOL: "vOL", rHiZ: "rHiZ", midEn: "midEn" }
    : { rOut: "rOut", vOH: "vOH", vOL: "vOL", rHiZ: "rHiZ", midEn: "midEn" };

  const sharedParams: Record<string, number> = loaded
    ? { rOut, cOut, vOH, vOL, rHiZ, midEn, ctrl, en }
    : { rOut, vOH, vOL, rHiZ, midEn, ctrl, en };

  return {
    // Port indices: node=0, gnd=1 (gnd → node 0). Internal nets: nCtrl=2, nEn=3.
    ports: ["node", "gnd"],
    params: sharedParams,
    elements: [
      {
        typeId: "DcVoltageSource",
        modelRef: "behavioral",
        subElementName: "vCtrl",
        branchCount: 1,
        params: { voltage: "ctrl" },
      },
      {
        typeId: "DcVoltageSource",
        modelRef: "behavioral",
        subElementName: "vEn",
        branchCount: 1,
        params: { voltage: "en" },
      },
      {
        typeId: innerTypeId,
        modelRef: "default",
        subElementName: "pin",
        params: innerPinParams,
      },
    ],
    internalNetCount: 2,
    internalNetLabels: ["nCtrl", "nEn"],
    netlist: [
      [1, 2],          // vCtrl: [neg, pos] → neg=gnd(1→0), pos=nCtrl(2)
      [1, 3],          // vEn:   [neg, pos] → neg=gnd(1→0), pos=nEn(3)
      [0, 1, 2, 3],    // pin: [node, gnd, ctrl, en] → node(0), gnd(1→0), nCtrl(2), nEn(3)
    ],
  };
}

export function buildDigitalOutputBoundaryAdapterLoadedNetlist(
  params: import("../../core/properties.js").PropertyBag,
): MnaSubcircuitNetlist {
  return buildOutputBoundaryNetlist(params, "DigitalOutputPinTriStateLoaded", true);
}

export function buildDigitalOutputBoundaryAdapterUnloadedNetlist(
  params: import("../../core/properties.js").PropertyBag,
): MnaSubcircuitNetlist {
  return buildOutputBoundaryNetlist(params, "DigitalOutputPinTriStateUnloaded", false);
}

export const DigitalOutputBoundaryAdapterLoadedDefinition: ComponentDefinition = {
  name: "DigitalOutputBoundaryAdapterLoaded",
  typeId: -1,
  internalOnly: true,
  pinLayout: DIGITAL_OUTPUT_BOUNDARY_ADAPTER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "netlist",
      netlist: buildDigitalOutputBoundaryAdapterLoadedNetlist,
      paramDefs: [
        { key: "rOut",  default: 100 },
        { key: "cOut",  default: 1e-12 },
        { key: "vOH",   default: 5 },
        { key: "vOL",   default: 0 },
        { key: "rHiZ",  default: 1e9 },
        { key: "midEn", default: 0.5 },
        // Coordinator-driven, normalized {0,1}. Default ctrl=0 (low),
        // en=1 (driven). A plain gate never asserts Hi-Z, so en stays 1.
        { key: "ctrl",  default: 0 },
        { key: "en",    default: 1 },
      ],
      params: {},
    },
  },
  defaultModel: "default",
};

export const DigitalOutputBoundaryAdapterUnloadedDefinition: ComponentDefinition = {
  name: "DigitalOutputBoundaryAdapterUnloaded",
  typeId: -1,
  internalOnly: true,
  pinLayout: DIGITAL_OUTPUT_BOUNDARY_ADAPTER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "netlist",
      netlist: buildDigitalOutputBoundaryAdapterUnloadedNetlist,
      paramDefs: [
        { key: "rOut",  default: 100 },
        { key: "vOH",   default: 5 },
        { key: "vOL",   default: 0 },
        { key: "rHiZ",  default: 1e9 },
        { key: "midEn", default: 0.5 },
        { key: "ctrl",  default: 0 },
        { key: "en",    default: 1 },
      ],
      params: {},
    },
  },
  defaultModel: "default",
};
