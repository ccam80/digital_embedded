import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { ComponentDefinition } from "../../core/registry.js";

export const DIGITAL_OUTPUT_PIN_LOADED_NETLIST: MnaSubcircuitNetlist = {
  ports: ["node", "gnd"],
  params: { rOut: 100, cOut: 1e-12, vOH: 5, vOL: 0 },
  // The parent composite's behavioural driver leaf must expose a
  // stateSchema slot named OUTPUT_LOGIC_LEVEL. The parent's netlist
  // (e.g. AND-gate netlist) will inject the resolved siblingState
  // ref for inputLogic via the netlist-builder function.
  elements: [
    { typeId: "BehavioralOutputDriver", modelRef: "default", subElementName: "drv",
      params: { vOH: "vOH", vOL: "vOL" /* inputLogic injected by parent */ } },
    { typeId: "Resistor",  modelRef: "default", subElementName: "rOut", params: { R: "rOut" } },
    { typeId: "Capacitor", modelRef: "default", subElementName: "cOut", params: { C: "cOut" } },
  ],
  internalNetCount: 1,
  internalNetLabels: ["driveNode"],
  netlist: [
    [2, 1],   // drv:  pos=driveNode, neg=gnd
    [2, 0],   // rOut: pos=driveNode, neg=node
    [0, 1],   // cOut: pos=node, neg=gnd
  ],
};

export const DigitalOutputPinLoadedDefinition: ComponentDefinition = {
  name: "DigitalOutputPinLoaded",
  typeId: -1,
  internalOnly: true,
  modelRegistry: {
    default: {
      kind: "netlist",
      netlist: DIGITAL_OUTPUT_PIN_LOADED_NETLIST,
      paramDefs: [
        { key: "rOut",  default: 100 },
        { key: "cOut",  default: 1e-12 },
        { key: "vOH",   default: 5 },
        { key: "vOL",   default: 0 },
      ],
      params: { rOut: 100, cOut: 1e-12, vOH: 5, vOL: 0 },
    },
  },
  defaultModel: "default",
};
