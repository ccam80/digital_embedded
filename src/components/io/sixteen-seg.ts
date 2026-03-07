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
  createInverterConfig,
  resolvePins,
  layoutPinsOnFace,
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
// ---------------------------------------------------------------------------

const COMP_WIDTH = 4;
const COMP_HEIGHT = 10;

// 16 segment labels
const SIXTEEN_SEG_LABELS = [
  "a1", "a2", "b", "c", "d1", "d2", "e", "f",
  "g1", "g2", "h", "i", "j", "k", "l", "dp",
] as const;

// ---------------------------------------------------------------------------
// Pin layout — 16 inputs split across west and east faces (8 each)
// ---------------------------------------------------------------------------

function buildSixteenSegPinDeclarations(): PinDeclaration[] {
  const westPositions = layoutPinsOnFace("west", 8, COMP_WIDTH, COMP_HEIGHT);
  const eastPositions = layoutPinsOnFace("east", 8, COMP_WIDTH, COMP_HEIGHT);
  const decls: PinDeclaration[] = [];

  for (let i = 0; i < 8; i++) {
    decls.push({
      direction: PinDirection.INPUT,
      label: SIXTEEN_SEG_LABELS[i],
      defaultBitWidth: 1,
      position: westPositions[i],
      isNegatable: false,
      isClockCapable: false,
    });
  }
  for (let i = 0; i < 8; i++) {
    decls.push({
      direction: PinDirection.INPUT,
      label: SIXTEEN_SEG_LABELS[8 + i],
      defaultBitWidth: 1,
      position: eastPositions[i],
      isNegatable: false,
      isClockCapable: false,
    });
  }
  return decls;
}

// ---------------------------------------------------------------------------
// SixteenSegElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class SixteenSegElement extends AbstractCircuitElement {
  private readonly _commonCathode: boolean;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SixteenSeg", instanceId, position, rotation, mirror, props);

    this._commonCathode = props.getOrDefault<boolean>("commonCathode", true);

    const decls = buildSixteenSegPinDeclarations();
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
      1,
    );
  }

  get commonCathode(): boolean {
    return this._commonCathode;
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    const halfW = COMP_WIDTH / 2;
    const halfH = COMP_HEIGHT / 2;

    ctx.save();

    // Background
    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    // Static 16-segment shape
    ctx.setLineWidth(1);

    // Top segments (a1, a2)
    ctx.drawLine(0.3, 0.3, halfW, 0.3);       // a1
    ctx.drawLine(halfW, 0.3, COMP_WIDTH - 0.3, 0.3); // a2

    // Middle segments (g1, g2)
    ctx.drawLine(0.3, halfH, halfW, halfH);    // g1
    ctx.drawLine(halfW, halfH, COMP_WIDTH - 0.3, halfH); // g2

    // Bottom segments (d1, d2)
    ctx.drawLine(0.3, COMP_HEIGHT - 0.3, halfW, COMP_HEIGHT - 0.3); // d1
    ctx.drawLine(halfW, COMP_HEIGHT - 0.3, COMP_WIDTH - 0.3, COMP_HEIGHT - 0.3); // d2

    // Left vertical (f, e)
    ctx.drawLine(0.3, 0.3, 0.3, halfH);       // f
    ctx.drawLine(0.3, halfH, 0.3, COMP_HEIGHT - 0.3); // e

    // Right vertical (b, c)
    ctx.drawLine(COMP_WIDTH - 0.3, 0.3, COMP_WIDTH - 0.3, halfH); // b
    ctx.drawLine(COMP_WIDTH - 0.3, halfH, COMP_WIDTH - 0.3, COMP_HEIGHT - 0.3); // c

    // Center vertical (i, k)
    ctx.drawLine(halfW, 0.3, halfW, halfH);    // i (upper center)
    ctx.drawLine(halfW, halfH, halfW, COMP_HEIGHT - 0.3); // k (lower center)

    // Diagonal segments (h: top-left to center, j: center to bottom-right)
    ctx.drawLine(0.3, 0.3, halfW, halfH);      // h
    ctx.drawLine(halfW, halfH, COMP_WIDTH - 0.3, COMP_HEIGHT - 0.3); // j

    // Diagonal segments (l: top-right to center, m: center to bottom-left)
    ctx.drawLine(COMP_WIDTH - 0.3, 0.3, halfW, halfH); // l
    ctx.drawLine(halfW, halfH, 0.3, COMP_HEIGHT - 0.3); // m (mapped to 'l' in layout)

    // Decimal point (dp)
    ctx.drawCircle(COMP_WIDTH + 0.3, COMP_HEIGHT - 0.3, 0.15, false);

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
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const inputStart = layout.inputOffset(index);
  let packed = 0;
  for (let i = 0; i < 16; i++) {
    if (state[inputStart + i] !== 0) {
      packed |= (1 << i);
    }
  }
  state[layout.outputOffset(index)] = packed >>> 0;
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
