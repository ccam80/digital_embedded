/**
 * SevenSegHex component- 7-segment display with internal BCD/hex decoder.
 *
 * 4-bit BCD input â†’ internal decoder â†’ segment pattern â†’ display.
 * Displays 0â€“9 and Aâ€“F (hex digits).
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
import { drawSevenSegShape } from "./seven-seg.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
} from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type StandaloneComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 4;

// ---------------------------------------------------------------------------
// 7-segment decoder table for hex digits 0â€“F
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
// Pin layout- 4-bit input on west face
// ---------------------------------------------------------------------------

function buildSevenSegHexPinDeclarations(): PinDeclaration[] {
  // Java SevenSegHexShape: d@(2,7), dp@(3,7)
  return [
    {
      direction: PinDirection.INPUT,
      label: "d",
      defaultBitWidth: 4,
      position: { x: 2, y: 7 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "dp",
      defaultBitWidth: 1,
      position: { x: 3, y: 7 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// SevenSegHexElement- CircuitElement implementation
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
    // Outer rect spans x: -0.5 to 3.5, y: 0.05 to 6.95 (same shape as SevenSeg).
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
// executeSevenSegHex- decode 4-bit input, produce segment pattern output
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

export const SevenSegHexDefinition: StandaloneComponentDefinition = {
  name: "SevenSegHex",
  typeId: -1,
  factory: sevenSegHexFactory,
  pinLayout: buildSevenSegHexPinDeclarations(),
  propertyDefs: SEVEN_SEG_HEX_PROPERTY_DEFS,
  attributeMap: SEVEN_SEG_HEX_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "SevenSegHex- 7-segment display with internal hex decoder.\n" +
    "4-bit input selects which hex digit (0â€“F) to display.\n" +
    "commonCathode=true: common cathode configuration (active high).",
  models: {
    digital: { executeFn: executeSevenSegHex, inputSchema: ["d", "dp"], outputSchema: [] },
  },
  // Behavioural analog model is a future scoped job (NEW driver leaf with
  // HEX_SEGMENT_TABLE decode required, distinct from BehavioralSevenSegDriver
  // whose 8-input shape doesn't accommodate this component's 4-bit `d` input).
  defaultModel: "digital",
};
