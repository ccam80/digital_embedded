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
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import {
  createDiodeElement,
  defineDiodeVariant,
} from "./diode.js";

// ---------------------------------------------------------------------------
// VaractorDiode model parameter block- diode superset with C-V-oriented defaults.
//
// These are the same parameter names the diode exposes (CJO, VJ, M, FC, TT, IS, ...).
// The varactor preset simply biases the defaults to a typical voltage-controlled
// capacitance device (larger CJO, lower VJ, sharper M). All load semantics
// live in createDiodeElement.
// ---------------------------------------------------------------------------

// Voltage-controlled-capacitance defaults: larger CJO, lower VJ. Every other
// diode param is inherited from the base DIODE_PARAM_SPEC so the bag carries the
// full schema and createDiodeElement reads each param directly (no per-key default lookup).
export const { paramDefs: VARACTOR_PARAM_DEFS, defaults: VARACTOR_PARAM_DEFAULTS } =
  defineDiodeVariant({
    secondary: {
      CJO: { default: 20e-12 },
      VJ:  { default: 0.7 },
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

    // Diode triangle: tip at platef=0.6 along lead1(1.5)â†’lead2(2.5) = x:2.1
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

export const VaractorDefinition: StandaloneComponentDefinition = {
  name: "VaractorDiode",
  typeId: -1,
  factory: varactorCircuitFactory,
  pinLayout: buildVaractorPinDeclarations(),
  voltageProbes: [{ name: "V", pos: "A", neg: "K" }],
  propertyDefs: VARACTOR_PROPERTY_DEFS,
  attributeMap: VARACTOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Varactor Diode- voltage-controlled junction capacitance (ngspice DIO model).\n" +
    "C_j(V_R) = CJO / (1 - V_d/VJ)^M\n" +
    "Uses the same load path as the standard Diode with varactor-tuned defaults.",
  models: {},
  modelRegistry: {
    "spice": {
      kind: "inline",
      factory: createDiodeElement,
      paramDefs: VARACTOR_PARAM_DEFS,
      params: VARACTOR_PARAM_DEFAULTS,
    },
  },
  defaultModel: "spice",
};
