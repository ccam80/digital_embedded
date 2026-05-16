import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { ComponentDefinition } from "../../core/registry.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";

const DIGITAL_INPUT_PIN_UNLOADED_PIN_LAYOUT: PinDeclaration[] = [
  { kind: "signal", direction: PinDirection.INPUT,  label: "node",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
  { kind: "signal", direction: PinDirection.OUTPUT, label: "gnd",    defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
  { kind: "signal", direction: PinDirection.OUTPUT, label: "result", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
];

export const DIGITAL_INPUT_PIN_UNLOADED_NETLIST: MnaSubcircuitNetlist = {
  ports: ["node", "gnd", "result"],
  params: { vIH: 2.0, vIL: 0.8 },
  elements: [
    { typeId: "DigitalInputThresholder", modelRef: "default", subElementName: "thresh", params: { vIH: "vIH", vIL: "vIL" } },
  ],
  internalNetCount: 0,
  netlist: [
    [0, 1, 2],
  ],
};

export const DigitalInputPinUnloadedDefinition: ComponentDefinition = {
  name: "DigitalInputPinUnloaded",
  typeId: -1,
  internalOnly: true,
  pinLayout: DIGITAL_INPUT_PIN_UNLOADED_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "netlist",
      netlist: DIGITAL_INPUT_PIN_UNLOADED_NETLIST,
      paramDefs: [
        { key: "vIH", default: 2.0 },
        { key: "vIL", default: 0.8 },
      ],
      params: { vIH: 2.0, vIL: 0.8 },
    },
  },
  defaultModel: "default",
};
