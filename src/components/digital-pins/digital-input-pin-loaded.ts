import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { ComponentDefinition } from "../../core/registry.js";

export const DIGITAL_INPUT_PIN_LOADED_NETLIST: MnaSubcircuitNetlist = {
  ports: ["node", "gnd"],
  params: { rIn: 1e6, cIn: 1e-12 },
  elements: [
    { typeId: "Resistor",  modelRef: "default", subElementName: "rIn", params: { R: "rIn" } },
    { typeId: "Capacitor", modelRef: "default", subElementName: "cIn", params: { C: "cIn" } },
  ],
  internalNetCount: 0,
  netlist: [
    [0, 1],   // rIn:  pos=node, neg=gnd
    [0, 1],   // cIn:  pos=node, neg=gnd
  ],
};

export const DigitalInputPinLoadedDefinition: ComponentDefinition = {
  name: "DigitalInputPinLoaded",
  typeId: -1,
  internalOnly: true,
  modelRegistry: {
    default: {
      kind: "netlist",
      netlist: DIGITAL_INPUT_PIN_LOADED_NETLIST,
      paramDefs: [
        { key: "rIn", default: 1e6 },
        { key: "cIn", default: 1e-12 },
      ],
      params: { rIn: 1e6, cIn: 1e-12 },
    },
  },
  defaultModel: "default",
  // pin layout / symbol metadata not required for internalOnly leaves
};
