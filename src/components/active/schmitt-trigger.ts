/**
 * Schmitt Trigger components  Inverting and Non-Inverting.
 *
 * Output switches between V_OH and V_OL based on input voltage relative to
 * two thresholds: V_TH (upper, triggers on rising input) and V_TL (lower,
 * triggers on falling input). The hysteresis band V_TH - V_TL prevents
 * spurious switching on noisy inputs.
 *
 * Architecture: declarative netlist composing one `SchmittTriggerDriver`
 * leaf with explicit `Capacitor` instances for input/output companion
 * capacitance. The driver carries the hysteresis state in StatePool slots;
 * the parent composite has no MNA math.
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

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: SCHMITT_PARAM_DEFS, defaults: SCHMITT_DEFAULTS } = defineModelParams({
  primary: {
    vTH:  { default: 2.0, unit: "V", description: "Rising input threshold" },
    vTL:  { default: 1.0, unit: "V", description: "Falling input threshold" },
    vOH:  { default: 3.3, unit: "V", description: "Output high voltage" },
    vOL:  { default: 0.0, unit: "V", description: "Output low voltage" },
    rOut: { default: 50,  unit: "Î©", description: "Output impedance" },
  },
});

// ---------------------------------------------------------------------------
// SCHMITT_INVERTING_NETLIST / SCHMITT_NON_INVERTING_NETLIST
//
// Ports: in, out, gnd. Internal nets: nDrive (driver output before rOut).
// Sub-elements:
//   drv  - SchmittTriggerDriver (behavioural leaf, holds hysteresis state)
//   cIn  - Capacitor on input pin (5pF default)
//   rOut - Resistor between driver output and out pin
//   cOut - Capacitor on output pin (5pF default)
// ---------------------------------------------------------------------------

export const SCHMITT_INVERTING_NETLIST: MnaSubcircuitNetlist = {
  ports: ["in", "out", "gnd"],
  params: { vTH: 2.0, vTL: 1.0, vOH: 3.3, vOL: 0.0, rOut: 50, cIn: 5e-12, cOut: 5e-12 },
  elements: [
    { typeId: "SchmittTriggerDriver", modelRef: "default", subElementName: "drv",
      params: { vTH: "vTH", vTL: "vTL", vOH: "vOH", vOL: "vOL", inverting: 1 } },
    { typeId: "Capacitor", modelRef: "default", subElementName: "cIn",  params: { C: "cIn"  } },
    { typeId: "Resistor",  modelRef: "default", subElementName: "rOut", params: { R: "rOut" } },
    { typeId: "Capacitor", modelRef: "default", subElementName: "cOut", params: { C: "cOut" } },
  ],
  internalNetCount: 1,
  internalNetLabels: ["nDrive"],
  netlist: [
    [0, 3, 2],   // drv:  in=in(0), out=nDrive(3), gnd=gnd(2)
    [0, 2],      // cIn:  pos=in(0),    neg=gnd(2)
    [3, 1],      // rOut: pos=nDrive(3), neg=out(1)
    [1, 2],      // cOut: pos=out(1),   neg=gnd(2)
  ],
} as MnaSubcircuitNetlist;

export const SCHMITT_NON_INVERTING_NETLIST: MnaSubcircuitNetlist = {
  ports: ["in", "out", "gnd"],
  params: { vTH: 2.0, vTL: 1.0, vOH: 3.3, vOL: 0.0, rOut: 50, cIn: 5e-12, cOut: 5e-12 },
  elements: [
    { typeId: "SchmittTriggerDriver", modelRef: "default", subElementName: "drv",
      params: { vTH: "vTH", vTL: "vTL", vOH: "vOH", vOL: "vOL", inverting: 0 } },
    { typeId: "Capacitor", modelRef: "default", subElementName: "cIn",  params: { C: "cIn"  } },
    { typeId: "Resistor",  modelRef: "default", subElementName: "rOut", params: { R: "rOut" } },
    { typeId: "Capacitor", modelRef: "default", subElementName: "cOut", params: { C: "cOut" } },
  ],
  internalNetCount: 1,
  internalNetLabels: ["nDrive"],
  netlist: [
    [0, 3, 2],   // drv:  in=in(0), out=nDrive(3), gnd=gnd(2)
    [0, 2],      // cIn:  pos=in(0),    neg=gnd(2)
    [3, 1],      // rOut: pos=nDrive(3), neg=out(1)
    [1, 2],      // cOut: pos=out(1),   neg=gnd(2)
  ],
} as MnaSubcircuitNetlist;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

function buildSchmittPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// CircuitElement classes
// ---------------------------------------------------------------------------

export class SchmittInvertingElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SchmittInverting", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildSchmittPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y - 1, width: 4, height: 2 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const PX = 1 / 16;

    const triLeft  = 1.0;
    const triTip   = 43 * PX;
    const triH     = 1.0;
    const bubCx    = 46 * PX;
    const bubR     = 2.94 * PX;
    const lead2x   = 50 * PX;

    const vIn  = signals?.getPinVoltage("in");
    const vOut = signals?.getPinVoltage("out");

    ctx.save();
    ctx.setLineWidth(1);

    drawColoredLead(ctx, signals, vIn, 0, 0, triLeft, 0);
    drawColoredLead(ctx, signals, vOut, lead2x, 0, 4, 0);

    ctx.setColor("COMPONENT");
    ctx.drawLine(triLeft, -triH, triLeft, triH);
    ctx.drawLine(triLeft,  triH, triTip,  0);
    ctx.drawArc(bubCx, 0, bubR, 0, 2 * Math.PI);

    const hx1 = 20 * PX;
    const hx2 = 29 * PX;
    const hx3 = 32 * PX;
    const hx4 = 23 * PX;
    const hy  =  3 * PX;
    ctx.drawLine(hx1, -hy, hx2, -hy);
    ctx.drawLine(hx2, -hy, hx2,  hy);
    ctx.drawLine(hx2,  hy, hx3,  hy);
    ctx.drawLine(hx3,  hy, hx4,  hy);
    ctx.drawLine(hx4,  hy, hx4, -hy);

    ctx.restore();
  }
}

export class SchmittNonInvertingElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SchmittNonInverting", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildSchmittPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y - 1, width: 4, height: 2 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const PX = 1 / 16;

    const triLeft  = 1.0;
    const triTip   = 43 * PX;
    const triH     = 1.0;
    const lead2x   = 45 * PX;

    const vIn  = signals?.getPinVoltage("in");
    const vOut = signals?.getPinVoltage("out");

    ctx.save();
    ctx.setLineWidth(1);

    drawColoredLead(ctx, signals, vIn, 0, 0, triLeft, 0);
    drawColoredLead(ctx, signals, vOut, lead2x, 0, 4, 0);

    ctx.setColor("COMPONENT");
    ctx.drawLine(triLeft, -triH, triLeft, triH);
    ctx.drawLine(triLeft,  triH, triTip,  0);

    const hx1 = 20 * PX;
    const hx2 = 29 * PX;
    const hx3 = 32 * PX;
    const hx4 = 23 * PX;
    const hy  =  3 * PX;
    ctx.drawLine(hx1, -hy, hx2, -hy);
    ctx.drawLine(hx2, -hy, hx2,  hy);
    ctx.drawLine(hx2,  hy, hx3,  hy);
    ctx.drawLine(hx3,  hy, hx4,  hy);
    ctx.drawLine(hx4,  hy, hx4, -hy);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const SCHMITT_PROPERTY_DEFS: PropertyDefinition[] = [
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

const SCHMITT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "vTH",   propertyKey: "vTH",   convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "vTL",   propertyKey: "vTL",   convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "vOH",   propertyKey: "vOH",   convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "vOL",   propertyKey: "vOL",   convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "rOut",  propertyKey: "rOut",  convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// ComponentDefinitions
// ---------------------------------------------------------------------------

export const SchmittInvertingDefinition: StandaloneComponentDefinition = {
  name: "SchmittInverting",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildSchmittPinDeclarations(),
  propertyDefs: SCHMITT_PROPERTY_DEFS,
  attributeMap: SCHMITT_ATTRIBUTE_MAPPINGS,

  helpText:
    "Schmitt Trigger (Inverting)  two-terminal analog component with hysteresis. " +
    "V_TH and V_TL define the upper and lower switching thresholds.",

  factory(props: PropertyBag): SchmittInvertingElement {
    return new SchmittInvertingElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "netlist",
      netlist: SCHMITT_INVERTING_NETLIST,
      paramDefs: SCHMITT_PARAM_DEFS,
      params: SCHMITT_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};

export const SchmittNonInvertingDefinition: StandaloneComponentDefinition = {
  name: "SchmittNonInverting",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildSchmittPinDeclarations(),
  propertyDefs: SCHMITT_PROPERTY_DEFS,
  attributeMap: SCHMITT_ATTRIBUTE_MAPPINGS,

  helpText:
    "Schmitt Trigger (Non-Inverting)  two-terminal analog component with hysteresis. " +
    "Output tracks input sense; V_TH and V_TL define the upper and lower switching thresholds.",

  factory(props: PropertyBag): SchmittNonInvertingElement {
    return new SchmittNonInvertingElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "netlist",
      netlist: SCHMITT_NON_INVERTING_NETLIST,
      paramDefs: SCHMITT_PARAM_DEFS,
      params: SCHMITT_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
