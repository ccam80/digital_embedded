/**
 * SixteenSeg component — direct-drive 16-segment alphanumeric display.
 *
 * 16 segment inputs (a1, a2, b, c, d1, d2, e, f, g, h, i, j, k, l, m, dp).
 * Each segment is independently controlled (no internal decoder).
 * commonCathode property controls polarity.
 *
 * 16-segment layout (standard alphanumeric):
 *   a1  a2
 *  f  i  b
 *  f  i  b
 *   g1  g2 (h, j diagonals)
 *  e  k  c
 *  e  k  c
 *   d1  d2  .dp
 *
 * Segment labels match Digital's Java implementation:
 * a1=0, a2=1, b=2, c=3, d1=4, d2=5, e=6, f=7, g1=8, g2=9, h=10, i=11, j=12, k=13, l=14, dp=15
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
} from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Layout constants
// Java SixteenShape: same size as SevenSegHex — width=4, height=7
// ---------------------------------------------------------------------------

const COMP_HEIGHT = 7;

// ---------------------------------------------------------------------------
// Pin layout — 2 inputs matching Java SixteenShape (same as SevenSegHexShape):
//   led (16-bit) at (2, 7) — bottom-left of display
//   dp  (1-bit)  at (3, 7) — bottom-right of display
// ---------------------------------------------------------------------------

function buildSixteenSegPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "led",
      defaultBitWidth: 16,
      position: { x: 2, y: COMP_HEIGHT },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "dp",
      defaultBitWidth: 1,
      position: { x: 3, y: COMP_HEIGHT },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// SixteenSegElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class SixteenSegElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SixteenSeg", instanceId, position, rotation, mirror, props);
  }

  get commonCathode(): boolean {
    return this._properties.getOrDefault<boolean>("commonCathode", true);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildSixteenSegPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x - 0.5,
      y: this.position.y + 0.05,
      width: 4,
      height: 6.9,
    };
  }

  draw(ctx: RenderContext): void {
    ctx.save();

    // Outer rectangle background (filled then outlined)
    const outerRect = [
      { x: -0.5, y: 0.05 },
      { x: 3.5,  y: 0.05 },
      { x: 3.5,  y: 6.95 },
      { x: -0.5, y: 6.95 },
    ];
    ctx.setColor("COMPONENT_FILL");
    ctx.drawPolygon(outerRect, true);
    ctx.setColor("COMPONENT");
    ctx.drawPolygon(outerRect, false);

    // Segment a1 (top-left horizontal)
    ctx.drawPolygon([
      { x: 0.602, y: 0.25 }, { x: 1.27,  y: 0.25 }, { x: 1.538, y: 0.53 },
      { x: 1.244, y: 0.811 }, { x: 0.576, y: 0.811 }, { x: 0.309, y: 0.53 },
    ], false);

    // Segment a2 (top-right horizontal)
    ctx.drawPolygon([
      { x: 1.972, y: 0.25 }, { x: 2.64,  y: 0.25 }, { x: 2.908, y: 0.53 },
      { x: 2.614, y: 0.811 }, { x: 1.945, y: 0.811 }, { x: 1.678, y: 0.53 },
    ], false);

    // Segment b (upper-right vertical)
    ctx.drawPolygon([
      { x: 2.975, y: 0.601 }, { x: 3.242, y: 0.881 }, { x: 3.137, y: 3.15 },
      { x: 2.843, y: 3.43 }, { x: 2.576, y: 3.15 }, { x: 2.681, y: 0.881 },
    ], false);

    // Segment c (lower-right vertical)
    ctx.drawPolygon([
      { x: 2.837, y: 3.57 }, { x: 3.105, y: 3.851 }, { x: 3.0,   y: 6.119 },
      { x: 2.707, y: 6.399 }, { x: 2.439, y: 6.119 }, { x: 2.544, y: 3.851 },
    ], false);

    // Segment d2 (bottom-right horizontal)
    ctx.drawPolygon([
      { x: 1.697, y: 6.189 }, { x: 2.366, y: 6.189 }, { x: 2.633, y: 6.469 },
      { x: 2.34,  y: 6.75 }, { x: 1.672, y: 6.75 }, { x: 1.404, y: 6.469 },
    ], false);

    // Segment d1 (bottom-left horizontal)
    ctx.drawPolygon([
      { x: 0.328, y: 6.189 }, { x: 0.997, y: 6.189 }, { x: 1.264, y: 6.469 },
      { x: 0.97,  y: 6.75 }, { x: 0.302, y: 6.75 }, { x: 0.034, y: 6.469 },
    ], false);

    // Segment e (lower-left vertical)
    ctx.drawPolygon([
      { x: 0.098,  y: 3.57 }, { x: 0.365,  y: 3.851 }, { x: 0.261,  y: 6.119 },
      { x: -0.032, y: 6.399 }, { x: -0.299, y: 6.119 }, { x: -0.195, y: 3.851 },
    ], false);

    // Segment f (upper-left vertical)
    ctx.drawPolygon([
      { x: 0.235,  y: 0.601 }, { x: 0.503,  y: 0.881 }, { x: 0.398,  y: 3.15 },
      { x: 0.104,  y: 3.43 }, { x: -0.162, y: 3.15 }, { x: -0.057, y: 0.881 },
    ], false);

    // Segment g1 (middle-left horizontal)
    ctx.drawPolygon([
      { x: 0.464, y: 3.219 }, { x: 1.134, y: 3.219 }, { x: 1.401, y: 3.5 },
      { x: 1.107, y: 3.781 }, { x: 0.439, y: 3.781 }, { x: 0.172, y: 3.5 },
    ], false);

    // Segment g2 (middle-right horizontal)
    ctx.drawPolygon([
      { x: 1.834, y: 3.219 }, { x: 2.503, y: 3.219 }, { x: 2.77,  y: 3.5 },
      { x: 2.477, y: 3.781 }, { x: 1.808, y: 3.781 }, { x: 1.541, y: 3.5 },
    ], false);

    // Segment h (upper-left diagonal)
    ctx.drawPolygon([
      { x: 0.601, y: 0.91 }, { x: 0.853, y: 0.91 }, { x: 1.137, y: 2.524 },
      { x: 1.109, y: 3.121 }, { x: 0.857, y: 3.121 }, { x: 0.573, y: 1.507 },
    ], false);

    // Segment i (upper center vertical)
    ctx.drawPolygon([
      { x: 1.605, y: 0.601 }, { x: 1.872, y: 0.881 }, { x: 1.768, y: 3.15 },
      { x: 1.474, y: 3.43 }, { x: 1.207, y: 3.15 }, { x: 1.312, y: 0.881 },
    ], false);

    // Segment j (upper-right diagonal)
    ctx.drawPolygon([
      { x: 2.328, y: 0.91 }, { x: 2.581, y: 0.91 }, { x: 2.553, y: 1.507 },
      { x: 2.121, y: 3.121 }, { x: 1.868, y: 3.121 }, { x: 1.896, y: 2.524 },
    ], false);

    // Segment m (lower-right diagonal)
    ctx.drawPolygon([
      { x: 1.833, y: 3.880 }, { x: 2.085, y: 3.880 }, { x: 2.369, y: 5.494 },
      { x: 2.342, y: 6.09 }, { x: 2.089, y: 6.09 }, { x: 1.806, y: 4.476 },
    ], false);

    // Segment k (lower center vertical)
    ctx.drawPolygon([
      { x: 1.468, y: 3.57 }, { x: 1.735, y: 3.851 }, { x: 1.631, y: 6.119 },
      { x: 1.337, y: 6.400 }, { x: 1.070, y: 6.119 }, { x: 1.175, y: 3.851 },
    ], false);

    // Segment l (lower-left diagonal)
    ctx.drawPolygon([
      { x: 0.822, y: 3.880 }, { x: 1.074, y: 3.880 }, { x: 1.047, y: 4.476 },
      { x: 0.614, y: 6.09 }, { x: 0.361, y: 6.09 }, { x: 0.389, y: 5.494 },
    ], false);

    // Decimal point (dp) — filled circle
    ctx.setColor("COMPONENT");
    ctx.drawCircle(3.1, 6.55, 0.2, true);

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "SixteenSeg — direct-drive 16-segment alphanumeric display.\n" +
      "16 independent segment inputs for full alphanumeric character display.\n" +
      "commonCathode=true: segments light when input=1."
    );
  }
}

// ---------------------------------------------------------------------------
// executeSixteenSeg — reads 16 inputs, packs into 16-bit output word
// ---------------------------------------------------------------------------

export function executeSixteenSeg(
  _index: number,
  _state: Uint32Array,
  _highZs: Uint32Array,
  _layout: ComponentLayout,
): void {
  // SixteenSeg has no outputs — it is a display-only component.
  // The display panel reads "led" (16-bit packed segments) and "dp" inputs directly.
}

// ---------------------------------------------------------------------------
// SIXTEEN_SEG_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const SIXTEEN_SEG_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "CommonCathode",
    propertyKey: "commonCathode",
    convert: (v) => v === "true",
  },
  {
    xmlName: "Color",
    propertyKey: "color",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const SIXTEEN_SEG_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "commonCathode",
    type: PropertyType.BOOLEAN,
    label: "Common cathode",
    defaultValue: true,
    description: "If true, segments light when input=1 (common cathode).",
  },
  {
    key: "color",
    type: PropertyType.COLOR,
    label: "Color",
    defaultValue: "red",
    description: "Segment color when active",
  },
];

// ---------------------------------------------------------------------------
// SixteenSegDefinition
// ---------------------------------------------------------------------------

function sixteenSegFactory(props: PropertyBag): SixteenSegElement {
  return new SixteenSegElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const SixteenSegDefinition: ComponentDefinition = {
  name: "SixteenSeg",
  typeId: -1,
  factory: sixteenSegFactory,
  executeFn: executeSixteenSeg,
  pinLayout: buildSixteenSegPinDeclarations(),
  propertyDefs: SIXTEEN_SEG_PROPERTY_DEFS,
  attributeMap: SIXTEEN_SEG_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "SixteenSeg — direct-drive 16-segment alphanumeric display.\n" +
    "16 independent segment inputs for full alphanumeric character display.\n" +
    "commonCathode=true: segments light when input=1.",
};
