/**
 * Analog Comparator component.
 *
 * Similar to an op-amp but optimized for switching speed: no linear region,
 * open-collector or push-pull output, optional input hysteresis (Schmitt
 * window), and an input offset voltage (vos).
 *
 * Open-collector model (default):
 *   - Output active (sinking):  R_sat to ground   output pulled LOW
 *   - Output inactive (off):    R_off to ground   output pulled HIGH by
 *                                                   external resistor
 *
 * Push-pull model:
 *   - Stamps a Norton current source driving the output to V_OH or V_OL
 *     through R_out (same model as DigitalOutputPinModel, but simpler).
 *
 * Hysteresis:
 *   - Two thresholds derived from the reference voltage and hysteresis band:
 *       V_TH = V_ref + vos + hysteresis/2   (trip on rising V+)
 *       V_TL = V_ref + vos - hysteresis/2   (trip on falling V+)
 *   - State is held until the input crosses the opposite threshold.
 *
 * Response time is modelled as a single-pole RC filter on the internal
 * _outputHigh state: the effective output conductance ramps between the
 * saturated and off values with time constant responseTime.
 *
 * Node assignment:
 *   nodeIds[0] = V+ (non-inverting input)
 *   nodeIds[1] = V- (inverting input / reference)
 *   nodeIds[2] = out (output)
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
import { defineStateSchema } from "../../solver/analog/state-schema.js";
import type { StateSchema } from "../../solver/analog/state-schema.js";

export const COMPARATOR_SCHEMA: StateSchema = defineStateSchema("Comparator", [
  { name: "OUTPUT_LATCH",  doc: "Hysteresis latch (1.0 = output active/sinking, 0.0 = inactive)", init: { kind: "zero" } },
  { name: "OUTPUT_WEIGHT", doc: "Response-time blend weight [0.0, 1.0]",                          init: { kind: "zero" } },
]);

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: COMPARATOR_PARAM_DEFS, defaults: COMPARATOR_DEFAULTS } = defineModelParams({
  primary: {
    hysteresis:   { default: 0,    unit: "V", description: "Hysteresis band width" },
    vos:          { default: 0.001, unit: "V", description: "Input offset voltage" },
    rSat:         { default: 50,   unit: "Î©", description: "Output saturation resistance" },
    responseTime: { default: 1e-6, unit: "s", description: "Propagation delay time constant" },
    vOH:          { default: 3.3,  unit: "V", description: "Output HIGH voltage" },
    vOL:          { default: 0.0,  unit: "V", description: "Output LOW voltage" },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildComparatorPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in+",
      defaultBitWidth: 1,
      position: { x: 0, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "in-",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
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
// ComparatorElement  CircuitElement implementation
// ---------------------------------------------------------------------------

export class ComparatorElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("VoltageComparator", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildComparatorPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 2,
      width: 4,
      height: 4,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vInp = signals?.getPinVoltage("in+");
    const vInn = signals?.getPinVoltage("in-");
    const vOut = signals?.getPinVoltage("out");

    ctx.save();

    // Triangle body  stays COMPONENT color, thin line
    ctx.setLineWidth(1);
    ctx.setColor("COMPONENT");
    ctx.drawPolygon(
      [{ x: 0.375, y: -2 }, { x: 0.375, y: 2 }, { x: 3.625, y: 0 }],
      false,
    );

    // Input lead in+ (thick)
    ctx.setLineWidth(3);
    drawColoredLead(ctx, signals, vInp, 0, -1, 0.375, -1);

    // Input lead in- (thick)
    drawColoredLead(ctx, signals, vInn, 0, 1, 0.375, 1);

    // Output lead (thick)
    drawColoredLead(ctx, signals, vOut, 3.625, 0, 4, 0);

    // Text labels  body decoration, stays COMPONENT color
    ctx.setLineWidth(1);
    ctx.setColor("COMPONENT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText("-", 1.0, -1.125, { horizontal: "center", vertical: "middle" });
    ctx.drawText("+", 1.0, 1.0, { horizontal: "center", vertical: "middle" });
    ctx.drawText("â‰¥?", 2.0, 0.0, { horizontal: "center", vertical: "middle" });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Netlist
// ---------------------------------------------------------------------------

export const COMPARATOR_OPEN_COLLECTOR_NETLIST: MnaSubcircuitNetlist = {
  ports: ["in+", "in-", "out"],
  params: { ...COMPARATOR_DEFAULTS },
  elements: [
    {
      typeId: "ComparatorDriver",
      modelRef: "default",
      subElementName: "drv",
      params: {
        hysteresis:   "hysteresis",
        vos:          "vos",
        rSat:         "rSat",
        responseTime: "responseTime",
      },
    } as MnaSubcircuitNetlist["elements"][number] & { subElementName: string },
  ],
  internalNetCount: 0,
  netlist: [
    [0, 1, 2], // drv: in+=0, in-=1, out=2
  ],
};

export const COMPARATOR_PUSH_PULL_NETLIST: MnaSubcircuitNetlist = {
  ports: ["in+", "in-", "out"],
  params: { ...COMPARATOR_DEFAULTS },
  elements: [
    {
      typeId: "ComparatorPushPullDriver",
      modelRef: "default",
      subElementName: "drv",
      params: {
        hysteresis:   "hysteresis",
        vos:          "vos",
        rSat:         "rSat",
        responseTime: "responseTime",
        vOH:          "vOH",
        vOL:          "vOL",
      },
    } as MnaSubcircuitNetlist["elements"][number] & { subElementName: string },
  ],
  internalNetCount: 0,
  netlist: [
    [0, 1, 2], // drv: in+=0, in-=1, out=2
  ],
};

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const COMPARATOR_PROPERTY_DEFS: PropertyDefinition[] = [
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

const COMPARATOR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "hysteresis",   propertyKey: "hysteresis",   convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "vos",          propertyKey: "vos",          convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "rSat",         propertyKey: "rSat",         convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "outputType",   propertyKey: "model",         convert: (v) => v },
  { xmlName: "responseTime", propertyKey: "responseTime", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Label",        propertyKey: "label",        convert: (v) => v },
];

// ---------------------------------------------------------------------------
// AnalogComparatorDefinition
// ---------------------------------------------------------------------------

export const VoltageComparatorDefinition: StandaloneComponentDefinition = {
  name: "VoltageComparator",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildComparatorPinDeclarations(),
  propertyDefs: COMPARATOR_PROPERTY_DEFS,
  attributeMap: COMPARATOR_ATTRIBUTE_MAPPINGS,

  helpText:
    "Analog Comparator  3-terminal (in+, in-, out). " +
    "Switches output based on V+ vs V-. Open-collector output requires external pull-up; " +
    "push-pull drives directly to vOH/vOL. " +
    "Optional hysteresis prevents output chatter on noisy inputs.",

  factory(props: PropertyBag): ComparatorElement {
    return new ComparatorElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "open-collector": {
      kind: "netlist",
      netlist: COMPARATOR_OPEN_COLLECTOR_NETLIST,
      paramDefs: COMPARATOR_PARAM_DEFS,
      params: COMPARATOR_DEFAULTS,
    },
    "push-pull": {
      kind: "netlist",
      netlist: COMPARATOR_PUSH_PULL_NETLIST,
      paramDefs: COMPARATOR_PARAM_DEFS,
      params: COMPARATOR_DEFAULTS,
    },
  },
  defaultModel: "open-collector",
};
