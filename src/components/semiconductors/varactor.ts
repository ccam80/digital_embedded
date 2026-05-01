/**
 * Varactor Diode- component definition only.
 *
 * Per spec/architectural-alignment.md ssF2 (APPROVED FIX): the varactor is
 * not a separate device. ngspice has no VARACTOR primitive; vendors use
 * the DIO model with a tuned parameter block to emphasise junction
 * capacitance. digiTS follows the same approach: VaractorDiode's
 * modelRegistry routes through `createDiodeElement` with varactor-tuned
 * defaults for CJO / VJ / M / FC / TT. All load()-time behaviour lives
 * in diode.ts; this file only owns the rendered symbol, pin layout,
 * and property plumbing.
 *
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import { defineModelParams, kelvinToCelsius } from "../../core/model-params.js";
import {
  createDiodeElement,
  DIODE_PARAM_DEFAULTS,
} from "./diode.js";

// ---------------------------------------------------------------------------
// VaractorDiode model parameter block- diode superset with C-V-oriented defaults.
//
// These are the same parameter names the diode exposes (CJO, VJ, M, FC, TT, IS, ...).
// The varactor preset simply biases the defaults to a typical voltage-controlled
// capacitance device (larger CJO, lower VJ, sharper M). All load semantics
// live in createDiodeElement.
// ---------------------------------------------------------------------------

export const { paramDefs: VARACTOR_PARAM_DEFS, defaults: VARACTOR_PARAM_DEFAULTS } =
  defineModelParams({
    primary: {
      CJO: { default: 20e-12, unit: "F",  description: "Zero-bias junction capacitance" },
      VJ:  { default: 0.7,    unit: "V",  description: "Junction built-in potential" },
      M:   { default: 0.5,                 description: "Grading coefficient" },
      IS:  { default: 1e-14,  unit: "A",  description: "Saturation current" },
      FC:  { default: 0.5,                 description: "Forward-bias capacitance coefficient" },
      TT:  { default: 0,      unit: "s",  description: "Transit time" },
    },
    secondary: {
      N:   { default: DIODE_PARAM_DEFAULTS.N,    description: "Emission coefficient" },
      RS:  { default: DIODE_PARAM_DEFAULTS.RS,   unit: "Ω", description: "Ohmic (series) resistance" },
      BV:  { default: DIODE_PARAM_DEFAULTS.BV,   unit: "V", description: "Reverse breakdown voltage" },
      IBV: { default: DIODE_PARAM_DEFAULTS.IBV,  unit: "A", description: "Reverse breakdown current" },
      NBV: { default: DIODE_PARAM_DEFAULTS.NBV,             description: "Breakdown emission coefficient (default=N)" },
      IKF: { default: DIODE_PARAM_DEFAULTS.IKF,  unit: "A", description: "High-injection knee current (forward)" },
      IKR: { default: DIODE_PARAM_DEFAULTS.IKR,  unit: "A", description: "High-injection knee current (reverse)" },
      EG:  { default: DIODE_PARAM_DEFAULTS.EG,   unit: "eV", description: "Activation energy" },
      XTI: { default: DIODE_PARAM_DEFAULTS.XTI,             description: "Saturation current temperature exponent" },
      KF:  { default: DIODE_PARAM_DEFAULTS.KF,              description: "Flicker noise coefficient" },
      AF:  { default: DIODE_PARAM_DEFAULTS.AF,              description: "Flicker noise exponent" },
      TNOM: { default: DIODE_PARAM_DEFAULTS.TNOM, unit: "K", description: "Parameter measurement temperature", spiceConverter: kelvinToCelsius },
    },
    instance: {
      AREA: { default: DIODE_PARAM_DEFAULTS.AREA,           description: "Area scaling factor" },
      OFF:  { default: DIODE_PARAM_DEFAULTS.OFF, emit: "flag", description: "Initial condition: device off" },
      IC:   { default: DIODE_PARAM_DEFAULTS.IC,  unit: "V", description: "Initial condition: junction voltage for UIC" },
    },
  });

// ---------------------------------------------------------------------------
// VaractorElement- visual component (rendering only).
//
// All load() and state behaviour is delegated to createDiodeElement via the
// modelRegistry factory below.
// ---------------------------------------------------------------------------

export class VaractorElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("VaractorDiode", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildVaractorPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.5,
      width: 4,
      height: 1,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const label = this._visibleLabel();

    const vA = signals?.getPinVoltage("A");
    const vK = signals?.getPinVoltage("K");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Anode lead
    drawColoredLead(ctx, signals, vA, 0, 0, 1.5, 0);

    // Cathode lead
    drawColoredLead(ctx, signals, vK, 2.5, 0, 4, 0);

    // Body (triangle, plate bars) stays COMPONENT color
    ctx.setColor("COMPONENT");

    // Diode triangle: tip at platef=0.6 along lead1(1.5)→lead2(2.5) = x:2.1
    const hs = 0.5;
    ctx.drawPolygon([
      { x: 1.5, y: -hs },
      { x: 1.5, y: hs },
      { x: 2.1, y: 0 },
    ], true);

    // plate1 bar at x=2.1 (arrowTip)
    ctx.drawLine(2.1, -hs, 2.1, hs);
    // plate2 bar at x=2.5 (lead2)
    ctx.drawLine(2.5, -hs, 2.5, hs);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, 2, -0.75, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildVaractorPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "A",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "K",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const VARACTOR_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const VARACTOR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// VaractorDefinition- routes through createDiodeElement per F2.
// ---------------------------------------------------------------------------

function varactorCircuitFactory(props: PropertyBag): VaractorElement {
  return new VaractorElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const VaractorDefinition: ComponentDefinition = {
  name: "VaractorDiode",
  typeId: -1,
  factory: varactorCircuitFactory,
  pinLayout: buildVaractorPinDeclarations(),
  propertyDefs: VARACTOR_PROPERTY_DEFS,
  attributeMap: VARACTOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Varactor Diode- voltage-controlled junction capacitance (ngspice DIO model).\n" +
    "C_j(V_R) = CJO / (1 - V_d/VJ)^M\n" +
    "Uses the same load path as the standard Diode with varactor-tuned defaults.",
  ngspiceNodeMap: { A: "pos", K: "neg" },
  models: {},
  modelRegistry: {
    "spice": {
      kind: "inline",
      factory: createDiodeElement,
      paramDefs: VARACTOR_PARAM_DEFS,
      params: VARACTOR_PARAM_DEFAULTS,
      ngspiceNodeMap: { A: "pos", K: "neg" },
    },
  },
  defaultModel: "spice",
};
