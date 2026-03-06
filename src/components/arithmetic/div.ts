/**
 * Div component — N-bit divider with quotient and remainder.
 *
 * Ports from Digital's Div.java:
 *   Inputs: a (bitWidth), b (bitWidth)
 *   Outputs: q (bitWidth quotient), r (bitWidth remainder)
 *
 * Division by zero: treated as division by 1 (matches Digital's Java implementation).
 * Supports signed and unsigned modes.
 * Signed mode supports remainderPositive flag: remainder is adjusted to be
 * non-negative (matches Python/floor-division semantics).
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
const COMP_HEIGHT = 5;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildDivPinDeclarations(bitWidth: number): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 2, COMP_WIDTH, COMP_HEIGHT);
  const outputPositions = layoutPinsOnFace("east", 2, COMP_WIDTH, COMP_HEIGHT);

  return [
    {
      direction: PinDirection.INPUT,
      label: "a",
      defaultBitWidth: bitWidth,
      position: inputPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "b",
      defaultBitWidth: bitWidth,
      position: inputPositions[1],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "q",
      defaultBitWidth: bitWidth,
      position: outputPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "r",
      defaultBitWidth: bitWidth,
      position: outputPositions[1],
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// DivElement
// ---------------------------------------------------------------------------

export class DivElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _signed: boolean;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Div", instanceId, position, rotation, mirror, props);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    this._signed = props.getOrDefault<boolean>("signed", false);
    const decls = buildDivPinDeclarations(this._bitWidth);
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
    );
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: COMP_WIDTH, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    ctx.save();

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.2, weight: "bold" });
    ctx.drawText(
      this._signed ? "A/B" : "/",
      COMP_WIDTH / 2,
      COMP_HEIGHT / 2,
      { horizontal: "center", vertical: "middle" },
    );

    this._drawLabel(ctx);
    ctx.restore();
  }

  private _drawLabel(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length === 0) return;
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.0 });
    ctx.drawText(label, COMP_WIDTH / 2, -0.5, { horizontal: "center", vertical: "bottom" });
  }

  getHelpText(): string {
    return (
      "Div — N-bit divider with quotient and remainder.\n" +
      "Inputs: a, b (bitWidth bits each).\n" +
      "Outputs: q (quotient), r (remainder).\n" +
      "Division by zero is treated as division by 1.\n" +
      "Supports signed mode with optional positive-remainder adjustment."
    );
  }
}

// ---------------------------------------------------------------------------
// makeExecuteDiv — parameterised flat simulation function
//
// Inputs: [a, b]    Outputs: [q, r]
//
// Division by zero: b=0 is treated as b=1 (matches Digital Java).
// Signed: inputs are sign-extended from bitWidth, result uses truncated division.
// remainderPositive: if signed and remainder is negative, adjust to make it positive.
// ---------------------------------------------------------------------------

export function makeExecuteDiv(
  bitWidth: number,
  signed: boolean,
  remainderPositive: boolean,
): (index: number, state: Uint32Array, layout: ComponentLayout) => void {
  const mask = bitWidth >= 32 ? 0xFFFFFFFF : ((1 << bitWidth) - 1);
  const signBit = 1 << (bitWidth - 1);

  return function executeDiv(index: number, state: Uint32Array, layout: ComponentLayout): void {
    const inBase = layout.inputOffset(index);
    const outBase = layout.outputOffset(index);

    const rawA = state[inBase] & mask;
    const rawB = state[inBase + 1] & mask;

    if (signed) {
      // Sign-extend from bitWidth
      let av = (rawA & signBit) !== 0 ? rawA - (signBit << 1) : rawA;
      let bv = (rawB & signBit) !== 0 ? rawB - (signBit << 1) : rawB;

      if (bv === 0) bv = 1;

      let q = Math.trunc(av / bv);
      let r = av % bv;

      // Adjust remainder to be positive (floored division)
      if (remainderPositive && r < 0) {
        if (bv >= 0) {
          r += bv;
          q--;
        } else {
          r -= bv;
          q++;
        }
      }

      // Store as unsigned (mask to bitWidth, handle negative via two's complement)
      state[outBase] = (q & mask) >>> 0;
      state[outBase + 1] = (r & mask) >>> 0;
    } else {
      // Unsigned division
      const av = rawA >>> 0;
      let bv = rawB >>> 0;

      if (bv === 0) bv = 1;

      const q = Math.floor(av / bv);
      const r = av % bv;

      state[outBase] = (q & mask) >>> 0;
      state[outBase + 1] = (r & mask) >>> 0;
    }
  };
}

export function executeDiv(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const bitWidth = (layout.getProperty?.(index, "bitWidth") as number | undefined) ?? 1;
  const signed = (layout.getProperty?.(index, "signed") as boolean | undefined) ?? false;
  const remainderPositive = (layout.getProperty?.(index, "remainderPositive") as boolean | undefined) ?? false;
  makeExecuteDiv(bitWidth, signed, remainderPositive)(index, state, layout);
}

// ---------------------------------------------------------------------------
// DIV_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const DIV_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "signed",
    propertyKey: "signed",
    convert: (v) => v === "true",
  },
  {
    xmlName: "remainderPositive",
    propertyKey: "remainderPositive",
    convert: (v) => v === "true",
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const DIV_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of the operands and results",
  },
  {
    key: "signed",
    type: PropertyType.BOOLEAN,
    label: "Signed",
    defaultValue: false,
    description: "Treat inputs as signed (two's complement)",
  },
  {
    key: "remainderPositive",
    type: PropertyType.BOOLEAN,
    label: "Remainder positive",
    defaultValue: false,
    description: "When signed, adjust remainder to be non-negative",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown above the component",
  },
];

// ---------------------------------------------------------------------------
// DivDefinition
// ---------------------------------------------------------------------------

function divFactory(props: PropertyBag): DivElement {
  return new DivElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const DivDefinition: ComponentDefinition = {
  name: "Div",
  typeId: -1,
  factory: divFactory,
  executeFn: executeDiv,
  pinLayout: buildDivPinDeclarations(1),
  propertyDefs: DIV_PROPERTY_DEFS,
  attributeMap: DIV_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.ARITHMETIC,
  helpText:
    "Div — N-bit divider with quotient and remainder.\n" +
    "Inputs: a, b (bitWidth bits each).\n" +
    "Outputs: q (quotient), r (remainder).\n" +
    "Division by zero is treated as division by 1.\n" +
    "Supports signed mode with optional positive-remainder adjustment.",
  defaultDelay: 10,
};
