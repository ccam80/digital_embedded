/**
 * SCR (Silicon Controlled Rectifier) analog component.
 *
 * Composite of two BJT sub-elements in a two-transistor latch configuration
 * per PB-SCR spec (bjtsetup.c:347-465 per sub-element).
 *
 *   Q1- NPN (polarity = +1): B=G, C=Vint, E=K
 *   Q2- PNP (polarity = -1): B=Vint, C=G, E=A
 *
 * Internal node: Vint (latch node)- created once by the composite in setup().
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
import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import { defineModelParams, kelvinToCelsius } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: SCR_PARAM_DEFS, defaults: SCR_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    BF: { default: 100,   description: "NPN forward current gain (Q1)" },
    BR: { default: 100,   description: "PNP reverse current gain (Q2)" },
    IS: { default: 1e-16, unit: "A", description: "Saturation current (shared)" },
  },
  secondary: {
    RC: { default: 0,     unit: "Î©", description: "Collector resistance (shared)" },
    RB: { default: 0,     unit: "Î©", description: "Base resistance (shared)" },
    RE: { default: 0,     unit: "Î©", description: "Emitter resistance (shared)" },
  },
  instance: {
    AREA: { default: 1,      description: "Device area factor" },
    TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature", spiceConverter: kelvinToCelsius },
  },
});

// ---------------------------------------------------------------------------
// SCR_NETLIST  MnaSubcircuitNetlist declaration
// ---------------------------------------------------------------------------

export const SCR_NETLIST: MnaSubcircuitNetlist = {
  ports: ["A", "K", "G"],
  params: { BF: 100, BR: 100, IS: 1e-16, RC: 0, RB: 0, RE: 0, AREA: 1, TEMP: 300.15 },
  elements: [
    { typeId: "NpnBJT", modelRef: "spice", subElementName: "Q1",
      params: { BF: "BF", IS: "IS", RC: "RC", RB: "RB", RE: "RE", AREA: "AREA", TEMP: "TEMP" } },
    { typeId: "PnpBJT", modelRef: "spice", subElementName: "Q2",
      params: { BR: "BR", IS: "IS", RC: "RC", RB: "RB", RE: "RE", AREA: "AREA", TEMP: "TEMP" } },
  ],
  internalNetCount: 1,
  internalNetLabels: ["latch"],
  netlist: [
    [2, 3, 1],  // Q1 NPN: B=G, C=latch, E=K
    [3, 2, 0],  // Q2 PNP: B=latch, C=G, E=A
  ],
};

// ---------------------------------------------------------------------------
// ScrElement- CircuitElement implementation
// ---------------------------------------------------------------------------

export class ScrElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SCR", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildScrPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 2,
      width: 4,
      height: 2.5,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vA = signals?.getPinVoltage("A");
    const vK = signals?.getPinVoltage("K");
    const vG = signals?.getPinVoltage("G");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Body (triangle and cathode bar) stays COMPONENT color
    ctx.drawPolygon([
      { x: 1.5, y: -0.5 },
      { x: 1.5, y: 0.5 },
      { x: 2.5, y: 0 },
    ], true);
    ctx.drawLine(2.5, -0.5, 2.5, 0.5);

    // Anode lead
    drawColoredLead(ctx, signals, vA, 0, 0, 1.5, 0);

    // Cathode lead
    drawColoredLead(ctx, signals, vK, 2.5, 0, 4, 0);

    // Gate lead: diagonal from cathode bar to pin G at (3,1)
    drawColoredLead(ctx, signals, vG, 2.5, 0, 3, 1);

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildScrPinDeclarations(): PinDeclaration[] {
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
      direction: PinDirection.INPUT,
      label: "K",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "G",
      defaultBitWidth: 1,
      position: { x: 3, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const SCR_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const SCR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// ScrDefinition
// ---------------------------------------------------------------------------

function scrCircuitFactory(props: PropertyBag): ScrElement {
  return new ScrElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ScrDefinition: StandaloneComponentDefinition = {
  name: "SCR",
  typeId: -1,
  factory: scrCircuitFactory,
  pinLayout: buildScrPinDeclarations(),
  propertyDefs: SCR_PROPERTY_DEFS,
  attributeMap: SCR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "SCR- Silicon Controlled Rectifier.\n" +
    "Pins: A (anode), K (cathode), G (gate).\n" +
    "Two-transistor latch model: Q1 NPN (B=G, C=Vint, E=K) + Q2 PNP (B=Vint, C=G, E=A).",
  models: {},
  modelRegistry: {
    behavioral: { kind: "netlist", netlist: SCR_NETLIST,
                  paramDefs: SCR_PARAM_DEFS, params: SCR_PARAM_DEFAULTS },
  },
  defaultModel: "behavioral",
};
