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
  type AnalogWrapperHookFactory,
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
    rOut: { default: 50,  unit: "Ω", description: "Output impedance" },
    transitionWidth: { default: 0.1, unit: "V", description: "Finite-gain input transition width (in_high − in_low)" },
  },
});

// ---------------------------------------------------------------------------
// Schmitt → Hyst parameter derivation
//
// The Schmitt is a digiTS composite over the bit-exact `Hyst` element (the
// ngspice `hyst` code model). The user-facing thresholds map onto hyst's
// continuous transfer: the rising/falling switch centres are vTH / vTL, so the
// hysteresis offset is half the band and the linear region is the finite-gain
// transition width W. Inverting swaps the output rails (negative gain).
//
// Composite shape (ports in(0), out(1), gnd(2); internal net nDrive(3)):
//   hy   - Hyst element (in → nDrive), the continuous hysteresis transfer
//   cIn  - Capacitor on input pin (5pF)
//   rOut - Resistor between hy output (nDrive) and out pin
//   cOut - Capacitor on output pin (5pF)
// ---------------------------------------------------------------------------

interface HystParams {
  in_low: number;
  in_high: number;
  hyst: number;
  out_lower_limit: number;
  out_upper_limit: number;
  input_domain: number;
  fraction: number;
}

function deriveHystParams(
  vTH: number, vTL: number, vOH: number, vOL: number, W: number, inverting: boolean,
): HystParams {
  const center = (vTH + vTL) / 2;
  return {
    in_low: center - W / 2,
    in_high: center + W / 2,
    hyst: (vTH - vTL) / 2,
    out_lower_limit: inverting ? vOH : vOL,
    out_upper_limit: inverting ? vOL : vOH,
    input_domain: 0.1, // fraction of (in_high − in_low); fraction=1 below
    fraction: 1,
  };
}

function buildSchmittNetlist(props: PropertyBag, inverting: boolean): MnaSubcircuitNetlist {
  const h = deriveHystParams(
    props.getModelParam<number>("vTH"),
    props.getModelParam<number>("vTL"),
    props.getModelParam<number>("vOH"),
    props.getModelParam<number>("vOL"),
    props.getModelParam<number>("transitionWidth"),
    inverting,
  );
  const rOut = props.getModelParam<number>("rOut");
  return {
    ports: ["in", "out", "gnd"],
    params: { rOut, cIn: 5e-12, cOut: 5e-12 },
    elements: [
      { typeId: "Hyst", modelRef: "default", subElementName: "hy",
        params: {
          in_low: h.in_low, in_high: h.in_high, hyst: h.hyst,
          out_lower_limit: h.out_lower_limit, out_upper_limit: h.out_upper_limit,
          input_domain: h.input_domain, fraction: h.fraction,
        } },
      { typeId: "Capacitor", modelRef: "behavioral", subElementName: "cIn",  params: { capacitance: "cIn"  } },
      { typeId: "Resistor",  modelRef: "behavioral", subElementName: "rOut", params: { resistance: "rOut" } },
      { typeId: "Capacitor", modelRef: "behavioral", subElementName: "cOut", params: { capacitance: "cOut" } },
    ],
    internalNetCount: 1,
    internalNetLabels: ["nDrive"],
    netlist: [
      [0, 3, 2],   // hy:   in=in(0),     out=nDrive(3), gnd=gnd(2)
      [0, 2],      // cIn:  pos=in(0),     neg=gnd(2)
      [3, 1],      // rOut: pos=nDrive(3), neg=out(1)
      [1, 2],      // cOut: pos=out(1),    neg=gnd(2)
    ],
  };
}

/**
 * Hot-load re-derivation: a change to vTH/vTL/vOH/vOL/transitionWidth on the
 * composite re-derives the Hyst sub-element's params and pushes them by name
 * (mirrors the DOP gain hook, digital-output-pin-unloaded.ts). The wrapper
 * invokes hook.setParam before its binding-map dispatch.
 */
function makeSchmittHook(inverting: boolean): AnalogWrapperHookFactory {
  return (_pinNodes, props, subElementsByName) => {
    let vTH = props.getModelParam<number>("vTH");
    let vTL = props.getModelParam<number>("vTL");
    let vOH = props.getModelParam<number>("vOH");
    let vOL = props.getModelParam<number>("vOL");
    let W = props.getModelParam<number>("transitionWidth");
    const hy = subElementsByName.get("hy");
    const push = (): void => {
      const h = deriveHystParams(vTH, vTL, vOH, vOL, W, inverting);
      hy?.setParam("in_low", h.in_low);
      hy?.setParam("in_high", h.in_high);
      hy?.setParam("hyst", h.hyst);
      hy?.setParam("out_lower_limit", h.out_lower_limit);
      hy?.setParam("out_upper_limit", h.out_upper_limit);
    };
    return {
      setParam(key: string, value: number): void {
        switch (key) {
          case "vTH": vTH = value; push(); break;
          case "vTL": vTL = value; push(); break;
          case "vOH": vOH = value; push(); break;
          case "vOL": vOL = value; push(); break;
          case "transitionWidth": W = value; push(); break;
        }
      },
    };
  };
}

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
  { xmlName: "transitionWidth", propertyKey: "transitionWidth", convert: (v) => parseFloat(v), modelParam: true },
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
      netlist: (props: PropertyBag): MnaSubcircuitNetlist => buildSchmittNetlist(props, true),
      paramDefs: SCHMITT_PARAM_DEFS,
      params: SCHMITT_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
  analogWrapperHook: makeSchmittHook(true),
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
      netlist: (props: PropertyBag): MnaSubcircuitNetlist => buildSchmittNetlist(props, false),
      paramDefs: SCHMITT_PARAM_DEFS,
      params: SCHMITT_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
  analogWrapperHook: makeSchmittHook(false),
};
