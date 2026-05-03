/**
 * 555 Timer IC composite analog model.
 *
 * Architecture: declarative netlist composing R-divider, two VCVS comparators
 * (model `comparator` on VCVSDefinition), discharge BJT, latch driver leaf
 * (`Timer555LatchDriver`), and a `DigitalOutputPinLoaded` for the OUT pin.
 *
 * Pins (pinLayout order): [DIS, TRIG, THR, VCC, CTRL, OUT, RST, GND]
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import { defineModelParams } from "../../core/model-params.js";

// Sub-element: discharge BJT- bjtsetup.c:347-465 (NPN Gummel-Poon)
import {
  createBjtL0Element,
} from "../semiconductors/bjt.js";

// Suppress unused-import warning- kept to anchor the rename gate (J-031 step 1)
void createBjtL0Element;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: TIMER555_PARAM_DEFS, defaults: TIMER555_DEFAULTS } = defineModelParams({
  primary: {
    vDrop:      { default: 1.5, unit: "V", description: "Voltage drop from VCC for high output state" },
    rDischarge: { default: 10,  unit: "Î©", description: "Saturation resistance of the discharge transistor" },
    rOut:       { default: 100, unit: "Î©", description: "Output drive resistance" },
    cOut:       { default: 1e-12, unit: "F", description: "Output companion capacitance" },
    vOH:        { default: 5.0, unit: "V", description: "Output high voltage" },
    vOL:        { default: 0.0, unit: "V", description: "Output low voltage" },
  },
});

// ---------------------------------------------------------------------------
// buildTimer555Netlist- function-form netlist (Composite M5)
//
// Ports: [DIS, TRIG, THR, VCC, CTRL, OUT, RST, GND]
// Internal nets: nLower, nComp1Out, nComp2Out, nDisBase
// ---------------------------------------------------------------------------

export function buildTimer555Netlist(params: PropertyBag): MnaSubcircuitNetlist {
  const elements: any[] = [
    { typeId: "Resistor",            modelRef: "default",    subElementName: "rDiv1", params: { R: 5000 } },
    { typeId: "Resistor",            modelRef: "default",    subElementName: "rDiv2", params: { R: 5000 } },
    { typeId: "Resistor",            modelRef: "default",    subElementName: "rDiv3", params: { R: 5000 } },
    { typeId: "VCVS",                modelRef: "comparator", subElementName: "comp1" },
    { typeId: "VCVS",                modelRef: "comparator", subElementName: "comp2" },
    { typeId: "NpnBJT",              modelRef: "spice",      subElementName: "bjtDis" },
    { typeId: "Timer555LatchDriver", modelRef: "default",    subElementName: "latchDrv",
      params: { vDrop: "vDrop" } },
  ];

  const netlist: number[][] = [
    [3, 4],                           // rDiv1: VCC, CTRL
    [4, 8],                           // rDiv2: CTRL, nLower
    [8, 7],                           // rDiv3: nLower, GND
    [2, 4, 9, 7],                     // comp1: ctrl+ THR, ctrl- CTRL, out+ nComp1Out, out- GND
    [8, 1, 10, 7],                    // comp2: ctrl+ nLower, ctrl- TRIG, out+ nComp2Out, out- GND
    [11, 0, 7],                       // bjtDis: B=nDisBase, C=DIS, E=GND
    [9, 10, 6, 3, 7, 11, 5],          // latchDrv: comp1Out, comp2Out, rst, vcc, gnd, disBase, out
  ];

  // OUT-pin handling- append DigitalOutputPinLoaded driven by latchDrv
  // OUTPUT_LOGIC_LEVEL slot via siblingState.
  elements.push({
    typeId: "DigitalOutputPinLoaded",
    modelRef: "default",
    subElementName: "outPin",
    params: {
      rOut: params.getModelParam<number>("rOut"),
      cOut: params.getModelParam<number>("cOut"),
      vOH:  params.getModelParam<number>("vOH"),
      vOL:  params.getModelParam<number>("vOL"),
      inputLogic: { kind: "siblingState", subElementName: "latchDrv",
                    slotName: "OUTPUT_LOGIC_LEVEL" },
    },
  });
  netlist.push([5 /* OUT port */, 7 /* GND port */]);

  return {
    ports: ["DIS", "TRIG", "THR", "VCC", "CTRL", "OUT", "RST", "GND"],
    params: { vDrop: 1.5, rDischarge: 100 },
    elements,
    internalNetCount: 4,
    internalNetLabels: ["nLower", "nComp1Out", "nComp2Out", "nDisBase"],
    netlist,
  } as MnaSubcircuitNetlist;
}

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

function buildTimer555PinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "DIS",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "TRIG",
      defaultBitWidth: 1,
      position: { x: 0, y: 3 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "THR",
      defaultBitWidth: 1,
      position: { x: 0, y: 5 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "VCC",
      defaultBitWidth: 1,
      position: { x: 3, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "CTRL",
      defaultBitWidth: 1,
      position: { x: 6, y: 5 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "OUT",
      defaultBitWidth: 1,
      position: { x: 6, y: 3 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "RST",
      defaultBitWidth: 1,
      position: { x: 6, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "GND",
      defaultBitWidth: 1,
      position: { x: 3, y: 7 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Timer555Element- CircuitElement implementation
// ---------------------------------------------------------------------------

export class Timer555Element extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Timer555", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildTimer555PinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 1,
      width: 6,
      height: 8,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vVcc  = signals?.getPinVoltage("VCC");
    const vGnd  = signals?.getPinVoltage("GND");
    const vTrig = signals?.getPinVoltage("TRIG");
    const vThr  = signals?.getPinVoltage("THR");
    const vCtrl = signals?.getPinVoltage("CTRL");
    const vRst  = signals?.getPinVoltage("RST");
    const vDis  = signals?.getPinVoltage("DIS");
    const vOut  = signals?.getPinVoltage("OUT");

    ctx.save();
    ctx.setLineWidth(1);

    ctx.setColor("COMPONENT");
    ctx.drawRect(1, 0, 4, 6, false);

    drawColoredLead(ctx, signals, vDis,  0, 1, 1, 1);
    drawColoredLead(ctx, signals, vTrig, 0, 3, 1, 3);
    drawColoredLead(ctx, signals, vThr,  0, 5, 1, 5);

    drawColoredLead(ctx, signals, vRst,  6, 1, 5, 1);
    drawColoredLead(ctx, signals, vOut,  6, 3, 5, 3);
    drawColoredLead(ctx, signals, vCtrl, 6, 5, 5, 5);

    drawColoredLead(ctx, signals, vVcc, 3, -1, 3, 0);
    drawColoredLead(ctx, signals, vGnd, 3, 7, 3, 6);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText("555", 3, 2, { horizontal: "center", vertical: "middle" });

    ctx.setFont({ family: "sans-serif", size: 0.65 });
    ctx.drawText("DIS",  1.2, 1, { horizontal: "left", vertical: "middle" });
    ctx.drawText("TRIG", 1.2, 3, { horizontal: "left", vertical: "middle" });
    ctx.drawText("THR",  1.2, 5, { horizontal: "left", vertical: "middle" });
    ctx.drawText("RST",  4.8, 1, { horizontal: "right", vertical: "middle" });
    ctx.drawText("OUT",  4.8, 3, { horizontal: "right", vertical: "middle" });
    ctx.drawText("CTRL", 4.8, 5, { horizontal: "right", vertical: "middle" });
    ctx.drawText("VCC",  3, 0.4, { horizontal: "center", vertical: "top" });
    ctx.drawText("GND",  3, 5.6, { horizontal: "center", vertical: "top" });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TIMER555_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional display label.",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

const TIMER555_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "vDrop",      propertyKey: "vDrop",      convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "rDischarge", propertyKey: "rDischarge", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "variant",    propertyKey: "model",      convert: (v) => v },
  { xmlName: "Label",      propertyKey: "label",      convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Timer555Definition
// ---------------------------------------------------------------------------

export const Timer555Definition: StandaloneComponentDefinition = {
  name: "Timer555",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildTimer555PinDeclarations(),
  propertyDefs: TIMER555_PROPERTY_DEFS,
  attributeMap: TIMER555_ATTRIBUTE_MAPPINGS,

  helpText:
    "555 Timer IC composite model (three R-divider arms + two VCVS comparators + " +
    "BJT discharge transistor + latch driver + output driver). Textbook NE555 internal schematic. " +
    "Pins: VCC, GND, TRIG, THR, CTRL, RST, DIS, OUT.",

  factory(props: PropertyBag): Timer555Element {
    return new Timer555Element(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "default": {
      kind: "netlist",
      netlist: buildTimer555Netlist,
      paramDefs: TIMER555_PARAM_DEFS,
      params: TIMER555_DEFAULTS,
    },
  },
  defaultModel: "default",
};
