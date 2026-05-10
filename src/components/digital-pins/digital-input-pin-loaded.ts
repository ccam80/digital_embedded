import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { ComponentDefinition } from "../../core/registry.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";

const DIGITAL_INPUT_PIN_LOADED_PIN_LAYOUT: PinDeclaration[] = [
  {
    kind: "signal",
    direction: PinDirection.INPUT,
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
];

export const DIGITAL_INPUT_PIN_LOADED_NETLIST: MnaSubcircuitNetlist = {
  ports: ["node", "gnd"],
  params: { rIn: 1e6, cIn: 1e-12 },
  elements: [
    { typeId: "Resistor",  modelRef: "behavioral", subElementName: "rIn", params: { resistance: "rIn" } },
    { typeId: "Capacitor", modelRef: "behavioral", subElementName: "cIn", params: { capacitance: "cIn" } },
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
  pinLayout: DIGITAL_INPUT_PIN_LOADED_PIN_LAYOUT,
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
};
