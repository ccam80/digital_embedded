import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { ComponentDefinition } from "../../core/registry.js";

export const DIGITAL_INPUT_PIN_UNLOADED_NETLIST: MnaSubcircuitNetlist = {
  ports: ["node", "gnd"],
  params: {},
  elements: [],
  internalNetCount: 0,
  netlist: [],
};

export const DigitalInputPinUnloadedDefinition: ComponentDefinition = {
  name: "DigitalInputPinUnloaded",
  typeId: -1,
  internalOnly: true,
  modelRegistry: {
    default: {
      kind: "netlist",
      netlist: DIGITAL_INPUT_PIN_UNLOADED_NETLIST,
      paramDefs: [],
      params: {},
    },
  },
  defaultModel: "default",
};
