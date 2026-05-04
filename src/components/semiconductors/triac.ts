/**
 * Triac analog component  bidirectional thyristor.
 *
 * Composite: two anti-parallel SCRs sharing a gate terminal, each built from
 * the NPN+PNP two-transistor latch per PB-SCR / PB-BJT.
 *
 * Ports: MT2=0, MT1=1, G=2; internal: latch1=3, latch2=4
 *   Q1 NPN SCR1: B=G, C=latch1, E=MT1
 *   Q2 PNP SCR1: B=latch1, C=G, E=MT2
 *   Q3 NPN SCR2: B=G, C=latch2, E=MT2
 *   Q4 PNP SCR2: B=latch2, C=G, E=MT1
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
import { defineModelParams, kelvinToCelsius } from "../../core/model-params.js";

import {
  BJT_NPN_DEFAULTS,
  BJT_PNP_DEFAULTS,
} from "./bjt.js";
import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: TRIAC_PARAM_DEFS, defaults: TRIAC_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    BF:  { default: BJT_NPN_DEFAULTS.BF,  description: "Forward current gain (NPN, Q1/Q3)" },
    IS:  { default: BJT_NPN_DEFAULTS.IS,  unit: "A", description: "Saturation current (all sub-BJTs)" },
  },
  secondary: {
    BR:  { default: BJT_PNP_DEFAULTS.BR,  description: "Reverse current gain (PNP, Q2/Q4)" },
    RC:  { default: 0,                     unit: "Î©", description: "Collector resistance" },
    RB:  { default: 0,                     unit: "Î©", description: "Base resistance" },
    RE:  { default: 0,                     unit: "Î©", description: "Emitter resistance" },
    AREA: { default: 1,                    description: "Device area factor" },
    TEMP: { default: 300.15,               unit: "K", description: "Operating temperature", spiceConverter: kelvinToCelsius },
  },
});

// ---------------------------------------------------------------------------
// TRIAC_NETLIST- declarative MNA subcircuit
// ---------------------------------------------------------------------------

export const TRIAC_NETLIST: MnaSubcircuitNetlist = {
  ports: ["MT2", "MT1", "G"],
  params: { BF: 100, IS: 1e-16, BR: 100, RC: 0, RB: 0, RE: 0, AREA: 1, TEMP: 300.15 },
  elements: [
    { typeId: "NpnBJT", modelRef: "spice", subElementName: "Q1", params: { BF: "BF", IS: "IS", RC: "RC", RB: "RB", RE: "RE", AREA: "AREA", TEMP: "TEMP" } },
    { typeId: "PnpBJT", modelRef: "spice", subElementName: "Q2", params: { BR: "BR", IS: "IS", RC: "RC", RB: "RB", RE: "RE", AREA: "AREA", TEMP: "TEMP" } },
    { typeId: "NpnBJT", modelRef: "spice", subElementName: "Q3", params: { BF: "BF", IS: "IS", RC: "RC", RB: "RB", RE: "RE", AREA: "AREA", TEMP: "TEMP" } },
    { typeId: "PnpBJT", modelRef: "spice", subElementName: "Q4", params: { BR: "BR", IS: "IS", RC: "RC", RB: "RB", RE: "RE", AREA: "AREA", TEMP: "TEMP" } },
  ],
  internalNetCount: 2,
  internalNetLabels: ["latch1", "latch2"],
  netlist: [
    [2, 3, 1],  // Q1 NPN: B=G, C=latch1, E=MT1
    [3, 2, 0],  // Q2 PNP: B=latch1, C=G, E=MT2
    [2, 4, 0],  // Q3 NPN: B=G, C=latch2, E=MT2
    [4, 2, 1],  // Q4 PNP: B=latch2, C=G, E=MT1
  ],
};

// ---------------------------------------------------------------------------
// TriacElement  CircuitElement implementation
// ---------------------------------------------------------------------------

export class TriacElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Triac", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildTriacPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 2,
      width: 4,
      height: 3,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vMT2 = signals?.getPinVoltage("MT2");
    const vMT1 = signals?.getPinVoltage("MT1");
    const vG = signals?.getPinVoltage("G");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Reference pixel coords divided by 16 for grid units
    // Component spans x=0..4, y=-2..0 (pin 2 at (4,-2))
    const bar1x = 24 / 16; // 1.5
    const bar2x = 40 / 16; // 2.5

    // Body: two vertical bars and bidirectional arrow triangles
    // Bar 1 at x=1.5, from y=-1 to y=+1
    ctx.drawLine(bar1x, -1,     bar1x, 1);
    // Bar 2 at x=2.5, from y=-1 to y=+1
    ctx.drawLine(bar2x, -1,     bar2x, 1);

    // Forward arrow triangle (pointing right): (bar1x, 0.5)  (bar2x, 1.0)  (bar2x, 0)
    ctx.drawPolygon([
      { x: bar1x, y:  8 / 16 },
      { x: bar2x, y: 16 / 16 },
      { x: bar2x, y: 0 },
    ], true);

    // Reverse arrow triangle (pointing left): (bar2x, -0.5)  (bar1x, -1.0)  (bar1x, 0)
    ctx.drawPolygon([
      { x: bar2x, y:  -8 / 16 },
      { x: bar1x, y: -16 / 16 },
      { x: bar1x, y: 0 },
    ], true);

    // MT2 lead: pin 0 at (0,0)  bar1 at (1.5,0)
    drawColoredLead(ctx, signals, vMT2, 0, 0, bar1x, 0);

    // MT1 lead: bar2 at (2.5,0)  pin 1 at (4,0)
    drawColoredLead(ctx, signals, vMT1, bar2x, 0, 4, 0);

    // Gate lead: (2.5,0)  (4,-1.5)  (4,-2) to pin 2
    drawColoredLead(ctx, signals, vG, bar2x, 0, 4, -24 / 16);
    ctx.drawLine(4, -24 / 16, 4, -2);

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildTriacPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "MT2",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "MT1",
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
      position: { x: 4, y: -2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TRIAC_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const TRIAC_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// TriacDefinition
// ---------------------------------------------------------------------------

function triacCircuitFactory(props: PropertyBag): TriacElement {
  return new TriacElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const TriacDefinition: StandaloneComponentDefinition = {
  name: "Triac",
  typeId: -1,
  factory: triacCircuitFactory,
  pinLayout: buildTriacPinDeclarations(),
  propertyDefs: TRIAC_PROPERTY_DEFS,
  attributeMap: TRIAC_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Triac  bidirectional thyristor.\n" +
    "Pins: MT1 (main terminal 1), MT2 (main terminal 2), G (gate).\n" +
    "Conducts in both directions when triggered. Turns off at current zero-crossing.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "netlist",
      netlist: TRIAC_NETLIST,
      paramDefs: TRIAC_PARAM_DEFS,
      params: TRIAC_PARAM_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
