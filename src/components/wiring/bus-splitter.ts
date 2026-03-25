/**
 * BusSplitter component — bidirectional bus splitter with Output Enable control.
 *
 * Splits a multi-bit common bus D into individual bit lines D0..D(n-1),
 * gated by an OE (Output Enable) input pin.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
  createInverterConfig,
  resolvePins,
} from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import { drawTextUpright } from "../generic-shape.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import { createSplitterAnalogElement } from "../../solver/analog/behavioral-remaining.js";
import { extractBits } from "./splitter.js";

// ---------------------------------------------------------------------------
// BusSplitterElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class BusSplitterElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("BusSplitter", instanceId, position, rotation, mirror, props);
  }

  get bits(): number {
    return this._properties.getOrDefault<number>("bitWidth", 1);
  }

  get spreading(): number {
    return this._properties.getOrDefault<number>("spreading", 1);
  }

  getPins(): readonly Pin[] {
    const bits = this._properties.getOrDefault<number>("bitWidth", 1);
    const spreading = this._properties.getOrDefault<number>("spreading", 1);
    const decls: PinDeclaration[] = [
      {
        direction: PinDirection.OUTPUT,
        label: "D",
        defaultBitWidth: bits,
        position: { x: 0, y: 0 },
        isNegatable: false,
        isClockCapable: false,
      },
      {
        direction: PinDirection.INPUT,
        label: "OE",
        defaultBitWidth: 1,
        position: { x: 0, y: 1 },
        isNegatable: false,
        isClockCapable: false,
      },
    ];
    for (let i = 0; i < bits; i++) {
      decls.push({
        direction: PinDirection.OUTPUT,
        label: `D${i}`,
        defaultBitWidth: 1,
        position: { x: 1, y: i * spreading },
        isNegatable: false,
        isClockCapable: false,
      });
    }
    return resolvePins(
      decls,
      { x: 0, y: 0 },
      0,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
    );
  }

  getBoundingBox(): Rect {
    const bits = this._properties.getOrDefault<number>("bitWidth", 1);
    const spreading = this._properties.getOrDefault<number>("spreading", 1);
    // Original height formula covers OE pin at y=1 and all bit pins
    const h = Math.max(2, (bits - 1) * spreading + 1);
    // Filled bar top extends to y=-0.1 above origin, so shift bbox top up by 0.1.
    // Keep height = h so the bottom edge is unchanged.
    return {
      x: this.position.x,
      y: this.position.y - 0.1,
      width: 1,
      height: h,
    };
  }

  draw(ctx: RenderContext): void {
    const bits = this._properties.getOrDefault<number>("bitWidth", 1);
    const spreading = this._properties.getOrDefault<number>("spreading", 1);
    const lastBitY = (bits - 1) * spreading;
    const flip = this.rotation === 2;

    ctx.save();

    const labelFont = { family: "sans-serif", size: 0.35 };

    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Left side: D pin lead (0,0)→(0.5,0) and OE pin lead (0,1)→(0.5,1)
    ctx.drawLine(0, 0, 0.5, 0);
    ctx.drawLine(0, 1, 0.5, 1);

    // Text labels for D and OE on the left (RIGHTBOTTOM anchor → right,bottom)
    ctx.setFont(labelFont);
    ctx.setColor("TEXT");
    drawTextUpright(ctx, "D",  -0.1, -0.15, { horizontal: "right", vertical: "bottom" }, flip);
    drawTextUpright(ctx, "OE", -0.1,  0.85, { horizontal: "right", vertical: "bottom" }, flip);

    // Right side: lead lines from (1,y)→(0.5,y) and labels for each bit
    ctx.setColor("COMPONENT");
    for (let i = 0; i < bits; i++) {
      const y = i * spreading;
      ctx.drawLine(1, y, 0.5, y);
      ctx.setFont(labelFont);
      ctx.setColor("TEXT");
      // LEFTBOTTOM anchor → left,bottom; label offset mirrors Java: x=1.1, y=bitY-0.15
      drawTextUpright(ctx, `D${i}`, 1.1, y - 0.15, { horizontal: "left", vertical: "bottom" }, flip);
      ctx.setColor("COMPONENT");
    }

    // Filled vertical bar: (0.4,-0.1)→(0.6,-0.1)→(0.6,barBottom)→(0.4,barBottom), FILLED
    // Use drawPolygon with explicit coords to avoid drawRect float error
    // (0.4+0.2 != 0.6 and -0.1+barHeight != barBottom in IEEE 754).
    const barBottom = Math.max(1, lastBitY) + 0.1;
    ctx.setColor("COMPONENT");
    ctx.drawPolygon([
      { x: 0.4, y: -0.1 },
      { x: 0.6, y: -0.1 },
      { x: 0.6, y: barBottom },
      { x: 0.4, y: barBottom },
    ], true);

    ctx.restore();
  }

  getHelpText(): string {
    const bits = this._properties.getOrDefault<number>("bitWidth", 1);
    const spreading = this._properties.getOrDefault<number>("spreading", 1);
    return (
      `BusSplitter — bidirectional bus splitter with OE control.\n` +
      `${bits} bits, spreading ${spreading}.`
    );
  }
}

// ---------------------------------------------------------------------------
// executeBusSplitter
// ---------------------------------------------------------------------------

export function executeBusSplitter(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const outCount = layout.outputCount(index);

  // Input: OE at inBase+0
  const oe = state[wt[inBase]];

  if (oe) {
    // OE=1: read common bus D (output slot 0) as source, split to individual bits
    // In this unidirectional mode, D is treated as a source value
    const dValue = state[wt[outBase]];
    for (let i = 1; i < outCount; i++) {
      state[wt[outBase + i]] = extractBits(dValue, i - 1, 1);
    }
  } else {
    // OE=0: all individual bit outputs = 0
    for (let i = 1; i < outCount; i++) {
      state[wt[outBase + i]] = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// BUS_SPLITTER_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const BUS_SPLITTER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "spreading",
    propertyKey: "spreading",
    convert: (v) => parseInt(v, 10),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const BUS_SPLITTER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    description: "Number of bits in the common bus",
  },
  {
    key: "spreading",
    type: PropertyType.INT,
    label: "Spreading",
    defaultValue: 1,
    description: "Vertical spacing between individual bit pins",
  },
];

// ---------------------------------------------------------------------------
// BusSplitterDefinition
// ---------------------------------------------------------------------------

function busSplitterFactory(props: PropertyBag): BusSplitterElement {
  return new BusSplitterElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

function buildDefaultPinLayout(bits: number, spreading: number): PinDeclaration[] {
  const decls: PinDeclaration[] = [
    {
      direction: PinDirection.OUTPUT,
      label: "D",
      defaultBitWidth: bits,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "OE",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
  for (let i = 0; i < bits; i++) {
    decls.push({
      direction: PinDirection.OUTPUT,
      label: `D${i}`,
      defaultBitWidth: 1,
      position: { x: 1, y: i * spreading },
      isNegatable: false,
      isClockCapable: false,
    });
  }
  return decls;
}

export const BusSplitterDefinition: ComponentDefinition = {
  name: "BusSplitter",
  typeId: -1,
  factory: busSplitterFactory,
  pinLayout: buildDefaultPinLayout(1, 1),
  propertyDefs: BUS_SPLITTER_PROPERTY_DEFS,
  attributeMap: BUS_SPLITTER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "BusSplitter — bidirectional bus splitter with Output Enable control.\n" +
    "Splits a common bus into individual bit lines gated by OE.",
  models: {
    digital: {
      executeFn: executeBusSplitter,
      // Schema for default bitWidth=1; direction-filter order matches for all configs.
      inputSchema: ["OE"],
      outputSchema: ["D", "D0"],
    },
    analog: {
      factory: createSplitterAnalogElement,
    },
  },
  defaultModel: "digital",
};
