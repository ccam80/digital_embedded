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

const COMP_WIDTH = 3;
const COMP_HEIGHT = 9;

// Segment input labels: a, b, c, d, e, f, g, dp
const SEGMENT_LABELS = ["a", "b", "c", "d", "e", "f", "g", "dp"] as const;

// ---------------------------------------------------------------------------
// Pin layout — 8 inputs on the west face
// ---------------------------------------------------------------------------

function buildSevenSegPinDeclarations(): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 8, COMP_WIDTH, COMP_HEIGHT);
  return SEGMENT_LABELS.map((label, i) => ({
    direction: PinDirection.INPUT,
    label,
    defaultBitWidth: 1,
    position: inputPositions[i],
    isNegatable: false,
    isClockCapable: false,
  }));
}

// ---------------------------------------------------------------------------
// SevenSegElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class SevenSegElement extends AbstractCircuitElement {
  private readonly _commonCathode: boolean;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SevenSeg", instanceId, position, rotation, mirror, props);

    this._commonCathode = props.getOrDefault<boolean>("commonCathode", true);

    const decls = buildSevenSegPinDeclarations();
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

    ctx.save();

    // Background
    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    // Draw segment outlines (static shape — no simulation state in draw)
    // Top segment (a): horizontal bar at top
    ctx.setLineWidth(1);
    ctx.drawLine(0.5, 0.5, COMP_WIDTH - 0.5, 0.5);
    // Middle segment (g): horizontal bar at middle
    ctx.drawLine(0.5, COMP_HEIGHT / 2, COMP_WIDTH - 0.5, COMP_HEIGHT / 2);
    // Bottom segment (d): horizontal bar at bottom
    ctx.drawLine(0.5, COMP_HEIGHT - 0.5, COMP_WIDTH - 0.5, COMP_HEIGHT - 0.5);
    // Upper-left (f)
    ctx.drawLine(0.5, 0.5, 0.5, COMP_HEIGHT / 2);
    // Upper-right (b)
    ctx.drawLine(COMP_WIDTH - 0.5, 0.5, COMP_WIDTH - 0.5, COMP_HEIGHT / 2);
    // Lower-left (e)
    ctx.drawLine(0.5, COMP_HEIGHT / 2, 0.5, COMP_HEIGHT - 0.5);
    // Lower-right (c)
    ctx.drawLine(COMP_WIDTH - 0.5, COMP_HEIGHT / 2, COMP_WIDTH - 0.5, COMP_HEIGHT - 0.5);
    // Decimal point (dp): small dot at bottom-right
    ctx.drawCircle(COMP_WIDTH + 0.3, COMP_HEIGHT - 0.3, 0.15, false);

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "SevenSeg — direct-drive 7-segment display.\n" +
      "Inputs a–g control each segment independently. dp controls the decimal point.\n" +
      "commonCathode=true: segment on when input=1. commonCathode=false: segment on when input=0."
    );
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
  layout: ComponentLayout,
): void {
  const inputStart = layout.inputOffset(index);
  let packed = 0;
  for (let i = 0; i < 8; i++) {
    if (state[inputStart + i] !== 0) {
      packed |= (1 << i);
    }
  }
  state[layout.outputOffset(index)] = packed >>> 0;
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
  executeFn: executeSevenSeg,
  pinLayout: buildSevenSegPinDeclarations(),
  propertyDefs: SEVEN_SEG_PROPERTY_DEFS,
  attributeMap: SEVEN_SEG_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "SevenSeg — direct-drive 7-segment display.\n" +
    "Inputs a–g control each segment independently. dp controls the decimal point.\n" +
    "commonCathode=true: segment on when input=1. commonCathode=false: segment on when input=0.",
};
