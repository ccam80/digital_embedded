/**
 * SevenSegHex component — 7-segment display with internal BCD/hex decoder.
 *
 * 4-bit BCD input → internal decoder → segment pattern → display.
 * Displays 0–9 and A–F (hex digits).
 * commonCathode property controls polarity.
 *
 * Segment encoding (standard 7-segment):
 *   bit 0 = a (top), bit 1 = b (upper-right), bit 2 = c (lower-right)
 *   bit 3 = d (bottom), bit 4 = e (lower-left), bit 5 = f (upper-left)
 *   bit 6 = g (middle)
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
// ---------------------------------------------------------------------------

const COMP_WIDTH = 3;
const COMP_HEIGHT = 5;

// ---------------------------------------------------------------------------
// 7-segment decoder table for hex digits 0–F
//
// Bit assignments: a=bit0, b=bit1, c=bit2, d=bit3, e=bit4, f=bit5, g=bit6
// ---------------------------------------------------------------------------

export const HEX_SEGMENT_TABLE: readonly number[] = [
  0b0111111, // 0: a,b,c,d,e,f
  0b0000110, // 1: b,c
  0b1011011, // 2: a,b,d,e,g
  0b1001111, // 3: a,b,c,d,g
  0b1100110, // 4: b,c,f,g
  0b1101101, // 5: a,c,d,f,g
  0b1111101, // 6: a,c,d,e,f,g
  0b0000111, // 7: a,b,c
  0b1111111, // 8: a,b,c,d,e,f,g
  0b1101111, // 9: a,b,c,d,f,g
  0b1110111, // A: a,b,c,e,f,g
  0b1111100, // b: c,d,e,f,g
  0b0111001, // C: a,d,e,f
  0b1011110, // d: b,c,d,e,g
  0b1111001, // E: a,d,e,f,g
  0b1110001, // F: a,e,f,g
];

// ---------------------------------------------------------------------------
// Pin layout — 4-bit input on west face
// ---------------------------------------------------------------------------

function buildSevenSegHexPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: 4,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// SevenSegHexElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class SevenSegHexElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SevenSegHex", instanceId, position, rotation, mirror, props);
  }

  get commonCathode(): boolean {
    return this._properties.getOrDefault<boolean>("commonCathode", true);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildSevenSegHexPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - COMP_HEIGHT / 2,
      width: COMP_WIDTH,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    const yOff = -COMP_HEIGHT / 2;

    ctx.save();

    // Background
    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, yOff, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, yOff, COMP_WIDTH, COMP_HEIGHT, false);

    // Static 7-segment shape
    const top = yOff + 0.3;
    const mid = 0;
    const bot = yOff + COMP_HEIGHT - 0.3;
    // Top (a)
    ctx.drawLine(0.4, top, COMP_WIDTH - 0.4, top);
    // Middle (g)
    ctx.drawLine(0.4, mid, COMP_WIDTH - 0.4, mid);
    // Bottom (d)
    ctx.drawLine(0.4, bot, COMP_WIDTH - 0.4, bot);
    // Upper-left (f)
    ctx.drawLine(0.4, top, 0.4, mid);
    // Upper-right (b)
    ctx.drawLine(COMP_WIDTH - 0.4, top, COMP_WIDTH - 0.4, mid);
    // Lower-left (e)
    ctx.drawLine(0.4, mid, 0.4, bot);
    // Lower-right (c)
    ctx.drawLine(COMP_WIDTH - 0.4, mid, COMP_WIDTH - 0.4, bot);

    // Label indicating hex decoder
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.5 });
    ctx.drawText("hex", COMP_WIDTH / 2, yOff + COMP_HEIGHT + 0.3, {
      horizontal: "center",
      vertical: "top",
    });

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "SevenSegHex — 7-segment display with internal hex decoder.\n" +
      "4-bit input selects which hex digit (0–F) to display.\n" +
      "commonCathode=true: common cathode configuration (active high)."
    );
  }
}

// ---------------------------------------------------------------------------
// executeSevenSegHex — decode 4-bit input, produce segment pattern output
// ---------------------------------------------------------------------------

export function executeSevenSegHex(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const digit = state[wt[layout.inputOffset(index)]] & 0xF;
  state[wt[layout.outputOffset(index)]] = HEX_SEGMENT_TABLE[digit];
}

// ---------------------------------------------------------------------------
// SEVEN_SEG_HEX_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const SEVEN_SEG_HEX_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
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

const SEVEN_SEG_HEX_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "commonCathode",
    type: PropertyType.BOOLEAN,
    label: "Common cathode",
    defaultValue: true,
    description: "If true, common cathode (active high). If false, common anode (active low).",
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
// SevenSegHexDefinition
// ---------------------------------------------------------------------------

function sevenSegHexFactory(props: PropertyBag): SevenSegHexElement {
  return new SevenSegHexElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const SevenSegHexDefinition: ComponentDefinition = {
  name: "SevenSegHex",
  typeId: -1,
  factory: sevenSegHexFactory,
  executeFn: executeSevenSegHex,
  pinLayout: buildSevenSegHexPinDeclarations(),
  propertyDefs: SEVEN_SEG_HEX_PROPERTY_DEFS,
  attributeMap: SEVEN_SEG_HEX_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "SevenSegHex — 7-segment display with internal hex decoder.\n" +
    "4-bit input selects which hex digit (0–F) to display.\n" +
    "commonCathode=true: common cathode configuration (active high).",
};
