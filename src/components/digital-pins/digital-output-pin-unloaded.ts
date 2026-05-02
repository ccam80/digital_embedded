import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { ComponentDefinition } from "../../core/registry.js";

export const DIGITAL_OUTPUT_PIN_UNLOADED_NETLIST: MnaSubcircuitNetlist = {
  ports: ["node", "gnd"],
  params: { vOH: 5, vOL: 0, bitIndex: 0 },
  // bitIndex (per A1, defaults to 0): selects which bit of the sibling
  // inputLogic slot's value this pin represents. See `digital-output-pin-
  // loaded.ts` for the full multi-bit emission contract.
  elements: [
    { typeId: "BehavioralOutputDriver", modelRef: "default", subElementName: "drv",
      params: { vOH: "vOH", vOL: "vOL", bitIndex: "bitIndex" } },
  ],
  internalNetCount: 0,
  netlist: [
    [0, 1],   // drv: pos=node, neg=gnd
  ],
};

export const DigitalOutputPinUnloadedDefinition: ComponentDefinition = {
  name: "DigitalOutputPinUnloaded",
  typeId: -1,
  internalOnly: true,
  modelRegistry: {
    default: {
      kind: "netlist",
      netlist: DIGITAL_OUTPUT_PIN_UNLOADED_NETLIST,
      paramDefs: [
        { key: "vOH",      default: 5 },
        { key: "vOL",      default: 0 },
        { key: "bitIndex", default: 0 },
      ],
      params: { vOH: 5, vOL: 0, bitIndex: 0 },
    },
  },
  defaultModel: "default",
};
