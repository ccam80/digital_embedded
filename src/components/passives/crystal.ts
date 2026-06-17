/**
 * Quartz crystal analog component  Butterworth-Van Dyke (BVD) equivalent circuit.
 *
 * The BVD model represents the mechanical resonance of a quartz crystal as a
 * series RLC branch (motional arm) in parallel with a shunt electrode capacitance:
 *
 *   Series (motional) arm: R_s  L_s  C_s  (between terminal pos and neg)
 *   Shunt arm:             C_0               (directly across pos and neg)
 *
 * This produces two resonant frequencies:
 *   Series resonance:   f_s = 1 / (2π √(L_s · C_s))
 *   Parallel resonance: f_p  f_s · √(1 + C_s / C_0)   (slightly above f_s)
 *
 * Subcircuit factoring (CRYSTAL_NETLIST):
 *   Sub-elements: rS, lS, cS, c0  four canonical primitives.
 *   Internal nets: n1 (rSlS junction), n2 (lScS junction).
 *   Topology:
 *     rS:  pos  n1
 *     lS:  n1  n2
 *     cS:  n2  neg
 *     c0:  pos  neg
 *   No sibling refs  every leaf is independent. SPICE-faithful: paired
 *   comparison emits the exact same R+L+C+C primitives.
 *
 * Derived parameters (computed at netlist-build time from frequency, qualityFactor):
 *   L_s = 1 / (4π² · f² · C_s)
 *   R_s = 2π · f · L_s / Q
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Rect } from "../../core/renderer-interface.js";
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
import { formatSI } from "../../editor/si-format.js";
import { defineModelParams } from "../../core/model-params.js";
import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";

// ---------------------------------------------------------------------------
// Derived parameter helpers
// ---------------------------------------------------------------------------

/**
 * Compute motional inductance from series resonant frequency and motional capacitance.
 * L_s = 1 / (4π² · f² · C_s)
 */
export function crystalMotionalInductance(freqHz: number, Cs: number): number {
  return 1 / (4 * Math.PI * Math.PI * freqHz * freqHz * Cs);
}

/**
 * Compute series resistance from frequency, motional inductance, and quality factor.
 * R_s = 2π · f · L_s / Q
 */
export function crystalSeriesResistance(freqHz: number, Ls: number, Q: number): number {
  return (2 * Math.PI * freqHz * Ls) / Q;
}

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: CRYSTAL_PARAM_DEFS, defaults: CRYSTAL_DEFAULTS } = defineModelParams({
  primary: {
    frequency:           { default: 32768,   unit: "Hz", description: "Series resonant frequency in hertz", min: 1 },
    qualityFactor:       { default: 50000,   description: "Quality factor controlling resonance bandwidth", min: 1 },
  },
  secondary: {
    motionalCapacitance: { default: 12.5e-15, unit: "F", description: "Series motional capacitance in farads", min: 1e-18 },
    shuntCapacitance:    { default: 3e-12,    unit: "F", description: "Parallel electrode capacitance in farads", min: 1e-18 },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildCrystalPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "pos",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "neg",
      defaultBitWidth: 1,
      position: { x: 2, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// CrystalCircuitElement  AbstractCircuitElement (editor/visual layer)
// ---------------------------------------------------------------------------

export class CrystalCircuitElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("QuartzCrystal", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildCrystalPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.5,
      width: 2,
      height: 1,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const freq = this._properties.getModelParam<number>("frequency");
    const label = this._visibleLabel();

    ctx.save();
    ctx.setLineWidth(1);

    const vA = signals?.getPinVoltage("pos");
    const vB = signals?.getPinVoltage("neg");
    const hasVoltage = vA !== undefined && vB !== undefined;

    // Left lead + plate  colored by pos pin voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vA, 0, 0, 0.6, 0);
    ctx.drawLine(0.6, -0.4, 0.6, 0.4);

    // Right lead + plate  colored by neg pin voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vB, 1.4, 0, 2, 0);
    ctx.drawLine(1.4, -0.4, 1.4, 0.4);

    // Rectangular crystal body between the plates  gradient
    if (hasVoltage && ctx.setLinearGradient) {
      ctx.setLinearGradient(0.7, 0, 1.3, 0, [
        { offset: 0, color: signals!.voltageColor(vA) },
        { offset: 1, color: signals!.voltageColor(vB) },
      ]);
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0.7, -0.3, 1.3, -0.3);
    ctx.drawLine(0.7, 0.3, 1.3, 0.3);
    ctx.drawLine(0.7, -0.3, 0.7, 0.3);
    ctx.drawLine(1.3, -0.3, 1.3, 0.3);

    // Value label below body
    const displayLabel = label.length > 0 ? label : (this._shouldShowValue() ? formatSI(freq, "Hz") : "");
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(displayLabel, 1, 0.65, { horizontal: "center", vertical: "top" });

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// buildCrystalNetlist  function-form subcircuit
// ---------------------------------------------------------------------------

/**
 * Builds the MNA subcircuit netlist for the BVD crystal model. Emits four
 * canonical primitives  no sibling refs, no shared state. The motional
 * inductance L_s and series resistance R_s are derived at netlist-build time
 * from the user-facing primary params (frequency, qualityFactor) and the
 * motional capacitance.
 *
 * Port order: pos=0, neg=1. Internal nets: n1=2 (rSlS), n2=3 (lScS).
 */
export const buildCrystalNetlist = (params: PropertyBag): MnaSubcircuitNetlist => {
  const frequency           = params.getModelParam<number>("frequency");
  const qualityFactor       = params.getModelParam<number>("qualityFactor");
  const motionalCapacitance = params.getModelParam<number>("motionalCapacitance");
  const shuntCapacitance    = params.getModelParam<number>("shuntCapacitance");

  const Ls = crystalMotionalInductance(frequency, motionalCapacitance);
  const Rs = crystalSeriesResistance(frequency, Ls, qualityFactor);

  return {
    ports: ["pos", "neg"],
    elements: [
      {
        typeId: "Resistor",
        modelRef: "behavioral",
        subElementName: "rS",
        params: { resistance: Rs },
      },
      {
        typeId: "Inductor",
        modelRef: "behavioral",
        subElementName: "lS",
        branchCount: 1,
        params: { inductance: Ls },
      },
      {
        typeId: "Capacitor",
        modelRef: "behavioral",
        subElementName: "cS",
        params: { capacitance: motionalCapacitance },
      },
      {
        typeId: "Capacitor",
        modelRef: "behavioral",
        subElementName: "c0",
        params: { capacitance: shuntCapacitance },
      },
    ],
    internalNetCount: 2,
    internalNetLabels: ["n1", "n2"],
    netlist: [
      [0, 2],   // rS:  pos=0, n1=2
      [2, 3],   // lS:  n1=2, n2=3
      [3, 1],   // cS:  n2=3, neg=1
      [0, 1],   // c0:  pos=0, neg=1 (shunt arm)
    ],
  };
};

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const CRYSTAL_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "motionalCapacitance",
    type: PropertyType.FLOAT,
    label: "Motional Capacitance C_s (F)",
    unit: "F",
    defaultValue: 12.5e-15,
    min: 1e-18,
    description: "Series motional capacitance in farads",
  },
  {
    key: "shuntCapacitance",
    type: PropertyType.FLOAT,
    label: "Shunt Capacitance C_0 (F)",
    unit: "F",
    defaultValue: 3e-12,
    min: 1e-18,
    description: "Parallel electrode capacitance in farads",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown below the component",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const CRYSTAL_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "frequency",
    propertyKey: "frequency",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "qualityFactor",
    propertyKey: "qualityFactor",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "motionalCapacitance",
    propertyKey: "motionalCapacitance",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "shuntCapacitance",
    propertyKey: "shuntCapacitance",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// CrystalDefinition
// ---------------------------------------------------------------------------

function crystalCircuitFactory(props: PropertyBag): CrystalCircuitElement {
  return new CrystalCircuitElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

const crystalWrapperHook: AnalogWrapperHookFactory = (
  _pinNodes,
  props,
  _getTime,
  subElementsByName,
) => {
  let frequency = props.getModelParam<number>("frequency");
  let qualityFactor = props.getModelParam<number>("qualityFactor");
  let motionalCapacitance = props.getModelParam<number>("motionalCapacitance");
  let shuntCapacitance = props.getModelParam<number>("shuntCapacitance");
  const rS = subElementsByName.get("rS");
  const lS = subElementsByName.get("lS");
  const cS = subElementsByName.get("cS");
  const c0 = subElementsByName.get("c0");
  const push = (): void => {
    const Ls = crystalMotionalInductance(frequency, motionalCapacitance);
    const Rs = crystalSeriesResistance(frequency, Ls, qualityFactor);
    rS?.setParam("resistance", Rs);
    lS?.setParam("inductance", Ls);
    cS?.setParam("capacitance", motionalCapacitance);
    c0?.setParam("capacitance", shuntCapacitance);
  };
  return {
    setParam(key: string, value: number): void {
      if (key === "frequency") frequency = value;
      else if (key === "qualityFactor") qualityFactor = value;
      else if (key === "motionalCapacitance") motionalCapacitance = value;
      else if (key === "shuntCapacitance") shuntCapacitance = value;
      else return;
      push();
    },
  };
};

export const CrystalDefinition: StandaloneComponentDefinition = {
  name: "QuartzCrystal",
  typeId: -1,
  factory: crystalCircuitFactory,
  pinLayout: buildCrystalPinDeclarations(),
  voltageProbes: [{ name: "V", pos: "pos", neg: "neg" }],
  propertyDefs: CRYSTAL_PROPERTY_DEFS,
  attributeMap: CRYSTAL_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Quartz crystal  Butterworth-Van Dyke equivalent circuit model.\n" +
    "Series RLC motional arm in parallel with shunt electrode capacitance.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "netlist",
      netlist: buildCrystalNetlist,
      paramDefs: CRYSTAL_PARAM_DEFS,
      params: CRYSTAL_DEFAULTS,
    },
  },
  analogWrapperHook: crystalWrapperHook,
  defaultModel: "behavioral",
};
