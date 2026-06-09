import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { ComponentDefinition } from "../../core/registry.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";

const DIGITAL_INPUT_PIN_LOADED_PIN_LAYOUT: PinDeclaration[] = [
  { kind: "signal", direction: PinDirection.INPUT,  label: "node",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
  { kind: "signal", direction: PinDirection.OUTPUT, label: "gnd",    defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
  { kind: "signal", direction: PinDirection.OUTPUT, label: "result", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
];

export const DIGITAL_INPUT_PIN_LOADED_NETLIST: MnaSubcircuitNetlist = {
  ports: ["node", "gnd", "result"],
  params: { rIn: 1e6, cIn: 1e-12, vIH: 2.0, vIL: 0.8 },
  elements: [
    { typeId: "Resistor",  modelRef: "behavioral", subElementName: "rIn", params: { resistance: "rIn" } },
    { typeId: "Capacitor", modelRef: "behavioral", subElementName: "cIn", params: { capacitance: "cIn" } },
    // vIH / vIL are carried as controller node voltages (DC sources) so they
    // hot-load via setComponentProperty, and the threshold classifier is an
    // ngspice-faithful B-source: result = (v>vIH) ? 1 : (v<vIL) ? 0 : 0.5.
    { typeId: "DcVoltageSource", modelRef: "behavioral", subElementName: "vihSrc", params: { voltage: "vIH" } },
    { typeId: "DcVoltageSource", modelRef: "behavioral", subElementName: "vilSrc", params: { voltage: "vIL" } },
    {
      typeId: "BehavioralLogic", modelRef: "default", subElementName: "thresh",
      params: { expression: { kind: "literal", value: "gt0(V(in)-V(vih))?1:(lt0(V(in)-V(vil))?0:0.5)" } },
    },
    { typeId: "Resistor", modelRef: "behavioral", subElementName: "threshR", params: { resistance: 1 } },
  ],
  internalNetCount: 2,
  internalNetLabels: ["vih", "vil"],
  netlist: [
    [0, 1],          // rIn:    pos=node(0),  neg=gnd(1)
    [0, 1],          // cIn:    pos=node(0),  neg=gnd(1)
    [1, 3],          // vihSrc: neg=gnd(1),   pos=vih(3)
    [1, 4],          // vilSrc: neg=gnd(1),   pos=vil(4)
    [0, 3, 4, 1, 2], // thresh: in=node(0), vih(3), vil(4), out+=gnd(1), out-=result(2)  (I-mode: current into result)
    [2, 1],          // threshR: pos=result(2), neg=gnd(1) — Norton conductance G=1
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
        { key: "vIH", default: 2.0 },
        { key: "vIL", default: 0.8 },
      ],
      params: { rIn: 1e6, cIn: 1e-12, vIH: 2.0, vIL: 0.8 },
    },
  },
  defaultModel: "default",
};
