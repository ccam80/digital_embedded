/**
 * Schottky barrier diode analog component.
 *
 * Electrically identical to the standard diode (Shockley equation) but with
 * different default SPICE parameters reflecting the metal-semiconductor
 * junction: higher IS, lower forward voltage drop, lower breakdown voltage.
 *
 * Reuses the standard diode analog element factory- the Schottky behavior
 * comes from the SCHOTTKY_DEFAULTS parameter set.
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
import type { AnalogElement } from "../../solver/analog/element.js";
import { createDiodeElement, defineDiodeVariant } from "./diode.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

// Schottky barrier defaults (metal-semiconductor junction): higher IS, lower
// forward drop, lower breakdown. Every other diode param is inherited from the
// base DIODE_PARAM_SPEC so the bag carries the full schema and createDiodeElement
// reads each param directly (no per-key default lookup).
export const { paramDefs: SCHOTTKY_PARAM_DEFS, defaults: SCHOTTKY_PARAM_DEFAULTS } = defineDiodeVariant({
  primary: {
    IS: { default: 1e-8 },
    N:  { default: 1.05 },
  },
  secondary: {
    RS:  { default: 1 },
    CJO: { default: 1e-12 },
    VJ:  { default: 0.6 },
    BV:  { default: 40 },
    EG:  { default: 0.69, description: "Activation energy (Schottky barrier)" },
    XTI: { default: 2 },
  },
});

// ---------------------------------------------------------------------------
// createSchottkyElement- AnalogElement factory
// ---------------------------------------------------------------------------

/**
 * Factory that creates a standard diode element with SCHOTTKY_DEFAULTS
 * as the base parameter set, merged with any user overrides from the compiler.
 */
export function createSchottkyElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  getTime: () => number,
): AnalogElement {
  return createDiodeElement(pinNodes, props, getTime);
}

// ---------------------------------------------------------------------------
// SchottkyElement- CircuitElement implementation
// ---------------------------------------------------------------------------

export class SchottkyElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SchottkyDiode", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildSchottkyPinDeclarations(), []);
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

    // Body stays COMPONENT color
    ctx.setColor("COMPONENT");

    // Filled diode triangle: anode to cathode
    ctx.drawPolygon([
      { x: 1.5, y: -0.5 },
      { x: 1.5, y: 0.5 },
      { x: 2.5, y: 0 },
    ], true);

    // Schottky cathode bar- vertical bar with inward-bent ends (S-shape)
    // Main vertical bar
    ctx.drawLine(2.5, -0.5, 2.5, 0.5);
    // Top hook bends left (inward toward anode)
    ctx.drawLine(2.5, -0.5, 2.2, -0.5);
    ctx.drawLine(2.2, -0.5, 2.2, -0.3);
    // Bottom hook bends right (outward from anode)
    ctx.drawLine(2.5, 0.5, 2.8, 0.5);
    ctx.drawLine(2.8, 0.5, 2.8, 0.3);

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

function buildSchottkyPinDeclarations(): PinDeclaration[] {
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

const SCHOTTKY_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const SCHOTTKY_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "model",
    propertyKey: "model",
    convert: (v) => v,
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// SchottkyDiodeDefinition
// ---------------------------------------------------------------------------

function schottkyCircuitFactory(props: PropertyBag): SchottkyElement {
  return new SchottkyElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const SchottkyDiodeDefinition: StandaloneComponentDefinition = {
  name: "SchottkyDiode",
  typeId: -1,
  factory: schottkyCircuitFactory,
  pinLayout: buildSchottkyPinDeclarations(),
  voltageProbes: [{ name: "V", pos: "A", neg: "K" }],
  propertyDefs: SCHOTTKY_PROPERTY_DEFS,
  attributeMap: SCHOTTKY_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Schottky Diode \u2014 metal-semiconductor junction with low forward voltage.\n" +
    "Same Shockley equation as standard diode but with Schottky defaults:\n" +
    "IS=1e-8, N=1.05, BV=40V, RS=1\u03A9, CJO=1pF.",
  models: {},
  modelRegistry: {
    "spice": {
      kind: "inline",
      factory: createSchottkyElement,
      paramDefs: SCHOTTKY_PARAM_DEFS,
      params: SCHOTTKY_PARAM_DEFAULTS,
    },
  },
  defaultModel: "spice",
};
