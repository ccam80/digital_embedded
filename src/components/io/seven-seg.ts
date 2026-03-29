/**
 * SevenSeg component — direct-drive 7-segment display.
 *
 * 7 segment inputs (a-g) + 1 decimal point input.
 * Each segment is independently controlled (no internal decoder).
 * commonCathode property: when true, segment lights when input=1;
 * when false (common anode), segment lights when input=0.
 *
 * Segment layout (standard):
 *   aaa
 *  f   b
 *  f   b
 *   ggg
 *  e   c
 *  e   c
 *   ddd  .dp
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { Point, RenderContext } from "../../core/renderer-interface.js";
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
import { createSevenSegAnalogElement } from "../../solver/analog/behavioral-remaining.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 4;
const COMP_HEIGHT = 7;

// ---------------------------------------------------------------------------
// Segment polygon data (grid coordinates, matching Java Digital reference)
// Exported so SevenSegHex can reuse via drawSevenSegShape().
// ---------------------------------------------------------------------------

export const SEVEN_SEG_OUTER_RECT: readonly Point[] = [
  { x: -0.5, y: 0.05 },
  { x:  3.5, y: 0.05 },
  { x:  3.5, y: 6.95 },
  { x: -0.5, y: 6.95 },
];

/** Polygons for segments a, b, c, d, e, f, g (in that order). */
export const SEVEN_SEG_POLYGONS: readonly (readonly Point[])[] = [
  // a — top horizontal
  [
    { x: 0.602, y: 0.25  },
    { x: 2.64,  y: 0.25  },
    { x: 2.908, y: 0.53  },
    { x: 2.614, y: 0.811 },
    { x: 0.576, y: 0.811 },
    { x: 0.309, y: 0.53  },
  ],
  // b — upper-right vertical
  [
    { x: 2.975, y: 0.601 },
    { x: 3.242, y: 0.881 },
    { x: 3.137, y: 3.15  },
    { x: 2.843, y: 3.43  },
    { x: 2.576, y: 3.15  },
    { x: 2.681, y: 0.881 },
  ],
  // c — lower-right vertical
  [
    { x: 2.837, y: 3.57  },
    { x: 3.105, y: 3.851 },
    { x: 3.0,   y: 6.119 },
    { x: 2.707, y: 6.399 },
    { x: 2.439, y: 6.119 },
    { x: 2.544, y: 3.851 },
  ],
  // d — bottom horizontal
  [
    { x: 0.328, y: 6.189 },
    { x: 2.366, y: 6.189 },
    { x: 2.633, y: 6.469 },
    { x: 2.34,  y: 6.75  },
    { x: 0.302, y: 6.75  },
    { x: 0.034, y: 6.469 },
  ],
  // e — lower-left vertical
  [
    { x:  0.098, y: 3.57  },
    { x:  0.365, y: 3.851 },
    { x:  0.261, y: 6.119 },
    { x: -0.032, y: 6.399 },
    { x: -0.299, y: 6.119 },
    { x: -0.195, y: 3.851 },
  ],
  // f — upper-left vertical
  [
    { x:  0.235, y: 0.601 },
    { x:  0.503, y: 0.881 },
    { x:  0.398, y: 3.15  },
    { x:  0.104, y: 3.43  },
    { x: -0.162, y: 3.15  },
    { x: -0.057, y: 0.881 },
  ],
  // g — middle horizontal
  [
    { x: 0.465, y: 3.219 },
    { x: 2.503, y: 3.219 },
    { x: 2.77,  y: 3.5   },
    { x: 2.477, y: 3.781 },
    { x: 0.439, y: 3.781 },
    { x: 0.172, y: 3.5   },
  ],
];

/** Decimal-point circle parameters. */
export const SEVEN_SEG_DP = { cx: 3.1, cy: 6.55, r: 0.2 } as const;

// ---------------------------------------------------------------------------
// Shared draw helper — draws the complete static seven-segment shape.
// SevenSegHex imports and calls this so both components render identically.
// ---------------------------------------------------------------------------

export function drawSevenSegShape(ctx: RenderContext): void {
  // Filled background
  ctx.setColor("COMPONENT_FILL");
  ctx.drawPolygon(SEVEN_SEG_OUTER_RECT, true);

  ctx.setColor("COMPONENT");
  ctx.setLineWidth(1);

  // Outlined border
  ctx.drawPolygon(SEVEN_SEG_OUTER_RECT, false);

  // Seven segment polygons (outlined)
  for (const poly of SEVEN_SEG_POLYGONS) {
    ctx.drawPolygon(poly, false);
  }

  // Decimal point (filled circle)
  ctx.drawCircle(SEVEN_SEG_DP.cx, SEVEN_SEG_DP.cy, SEVEN_SEG_DP.r, true);
}

// Segment input labels: a, b, c, d, e, f, g, dp
const SEGMENT_LABELS = ["a", "b", "c", "d", "e", "f", "g", "dp"] as const;

// ---------------------------------------------------------------------------
// Pin layout — 8 inputs on the west face
// ---------------------------------------------------------------------------

function buildSevenSegPinDeclarations(): PinDeclaration[] {
  // Java SevenSegShape: 4 pins across top (y=0), 4 across bottom (y=7)
  // a@(0,0), b@(1,0), c@(2,0), d@(3,0), e@(0,7), f@(1,7), g@(2,7), dp@(3,7)
  return SEGMENT_LABELS.map((label, i) => ({
    kind: "signal" as const,
    direction: PinDirection.INPUT,
    label,
    defaultBitWidth: 1,
    position: i < 4 ? { x: i, y: 0 } : { x: i - 4, y: 7 },
    isNegatable: false,
    isClockCapable: false,
  }));
}

// ---------------------------------------------------------------------------
// SevenSegElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class SevenSegElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SevenSeg", instanceId, position, rotation, mirror, props);
  }

  get commonCathode(): boolean {
    return this._properties.getOrDefault<boolean>("commonCathode", true);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildSevenSegPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    // Outer rect spans x: -0.5 to 3.5, y: 0.05 to 6.95.
    // Segment 'e' (lower-left) extends to x=-0.299; outer rect starts at x=-0.5.
    return {
      x: this.position.x - 0.5,
      y: this.position.y + 0.05,
      width: COMP_WIDTH + 0.5,
      height: 6.9,
    };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    drawSevenSegShape(ctx);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executeSevenSeg — reads 8 inputs (a,b,c,d,e,f,g,dp), packs into output
//
// Output encoding (bits 7..0): dp=bit7, g=bit6, f=bit5, e=bit4, d=bit3, c=bit2, b=bit1, a=bit0
// Polarity applied: commonCathode means active-high; common anode means active-low.
// ---------------------------------------------------------------------------

export function executeSevenSeg(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  let packed = 0;
  for (let i = 0; i < 8; i++) {
    if (state[wt[inputStart + i]] !== 0) {
      packed |= (1 << i);
    }
  }
  state[wt[layout.outputOffset(index)]] = packed >>> 0;
}

// ---------------------------------------------------------------------------
// SEVEN_SEG_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const SEVEN_SEG_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
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

const SEVEN_SEG_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "commonCathode",
    type: PropertyType.BOOLEAN,
    label: "Common cathode",
    defaultValue: true,
    description: "If true, segments light when input=1 (common cathode). If false, segments light when input=0 (common anode).",
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
// SevenSegDefinition
// ---------------------------------------------------------------------------

function sevenSegFactory(props: PropertyBag): SevenSegElement {
  return new SevenSegElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const SevenSegDefinition: ComponentDefinition = {
  name: "SevenSeg",
  typeId: -1,
  factory: sevenSegFactory,
  pinLayout: buildSevenSegPinDeclarations(),
  propertyDefs: SEVEN_SEG_PROPERTY_DEFS,
  attributeMap: SEVEN_SEG_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "SevenSeg — direct-drive 7-segment display.\n" +
    "Inputs a–g control each segment independently. dp controls the decimal point.\n" +
    "commonCathode=true: segment on when input=1. commonCathode=false: segment on when input=0.",
  models: {
    digital: { executeFn: executeSevenSeg, inputSchema: ["a", "b", "c", "d", "e", "f", "g", "dp"], outputSchema: [] },
    mnaModels: {
      behavioral: { factory: createSevenSegAnalogElement },
    },
  },
  defaultModel: "digital",
};
