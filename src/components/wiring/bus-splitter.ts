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
import { drawUprightText } from "../../core/upright-text.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import { extractBits } from "./splitter.js";

// ---------------------------------------------------------------------------
// BusSplitterElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class BusSplitterElement extends AbstractCircuitElement {
  private readonly _bits: number;
  private readonly _spreading: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("BusSplitter", instanceId, position, rotation, mirror, props);

    this._bits = props.getOrDefault<number>("bits", 8);
    this._spreading = props.getOrDefault<number>("spreading", 1);

    const decls: PinDeclaration[] = [
      {
        direction: PinDirection.OUTPUT,
        label: "D",
        defaultBitWidth: this._bits,
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

    for (let i = 0; i < this._bits; i++) {
      decls.push({
        direction: PinDirection.OUTPUT,
        label: `D${i}`,
        defaultBitWidth: 1,
        position: { x: 1, y: i * this._spreading },
        isNegatable: false,
        isClockCapable: false,
      });
    }

    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
    );
  }

  get bits(): number {
    return this._bits;
  }

  get spreading(): number {
    return this._spreading;
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    const h = Math.max(2, (this._bits - 1) * this._spreading + 1);
    return {
      x: this.position.x,
      y: this.position.y,
      width: 1,
      height: h,
    };
  }

  draw(ctx: RenderContext): void {
    const lastY = (this._bits - 1) * this._spreading;

    ctx.save();

    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Vertical spine on left at x=0 from y=0 to y=lastY
    ctx.drawLine(0, 0, 0, lastY);

    // Horizontal stubs from x=0 to x=1 at each bit position
    for (let i = 0; i < this._bits; i++) {
      const y = i * this._spreading;
      ctx.drawLine(0, y, 1, y);
    }

    // Label "BS" centered on the spine
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.6 });
    drawUprightText(ctx, "BS", 0, lastY / 2, {
      horizontal: "center",
      vertical: "middle",
    }, this.rotation);

    ctx.restore();
  }

  getHelpText(): string {
    return (
      `BusSplitter — bidirectional bus splitter with OE control.\n` +
      `${this._bits} bits, spreading ${this._spreading}.`
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
    propertyKey: "bits",
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
    key: "bits",
    type: PropertyType.INT,
    label: "Bits",
    defaultValue: 8,
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
  executeFn: executeBusSplitter,
  pinLayout: buildDefaultPinLayout(8, 1),
  propertyDefs: BUS_SPLITTER_PROPERTY_DEFS,
  attributeMap: BUS_SPLITTER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "BusSplitter — bidirectional bus splitter with Output Enable control.\n" +
    "Splits a common bus into individual bit lines gated by OE.",
};
