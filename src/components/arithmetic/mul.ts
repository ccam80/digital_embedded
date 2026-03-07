/**
 * Mul component — N-bit multiplier producing a 2N-bit product.
 *
 * Ports from Digital's Mul.java:
 *   Inputs: a (bitWidth), b (bitWidth)
 *   Outputs: mul (2*bitWidth product)
 *
 * Supports signed and unsigned modes.
 * For signed: sign-extend inputs to full signed range before multiplying.
 * Product is 2*bitWidth bits wide.
 *
 * Since our state array is Uint32Array (32-bit slots), and products can be
 * up to 64 bits (32*2), we store the product in two consecutive output slots:
 *   outBase+0 = low 32 bits
 *   outBase+1 = high 32 bits (only non-zero when bitWidth > 16)
 *
 * For simplicity, and matching Digital's constraint (bits <= 32), we use
 * BigInt for the multiplication to avoid overflow in 64-bit product case.
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

function buildMulPinDeclarations(bitWidth: number): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 2, COMP_WIDTH, COMP_HEIGHT);
  // Product is 2*bitWidth bits — store in a single output pin with 2x width
  // The output pin carries the full product (up to 64 bits).
  // In the engine state array the product occupies one slot (low 32 bits)
  // plus a second slot for the high 32 bits when bitWidth > 16.
  // We declare 2 output pins: "mul" (low) and "mul_h" (high, only used when bitWidth > 16).
  const outputPositions = layoutPinsOnFace("east", 1, COMP_WIDTH, COMP_HEIGHT);

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
      label: "mul",
      defaultBitWidth: Math.min(bitWidth * 2, 32),
      position: outputPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// MulElement
// ---------------------------------------------------------------------------

export class MulElement extends AbstractCircuitElement {
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
    super("Mul", instanceId, position, rotation, mirror, props);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    this._signed = props.getOrDefault<boolean>("signed", false);
    const decls = buildMulPinDeclarations(this._bitWidth);
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
      this._signed ? "A*B" : "*",
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
      "Mul — N-bit multiplier producing a 2N-bit product.\n" +
      "Inputs: a, b (bitWidth bits each).\n" +
      "Output: mul (2*bitWidth-bit product).\n" +
      "Supports signed and unsigned modes."
    );
  }
}

// ---------------------------------------------------------------------------
// makeExecuteMul — parameterised flat simulation function
//
// Inputs: [a, b]    Outputs: [mul_low, mul_high] (each 32-bit)
//
// For bitWidth <= 16: product fits in 32 bits, only mul_low used.
// For bitWidth > 16: product can be up to 64 bits; mul_low = low 32 bits,
//   mul_high = high 32 bits. (The layout must allocate 2 output slots.)
//
// The executeFn layout must match: outputCount = 1 for bitWidth <= 16,
// outputCount = 2 for bitWidth > 16. For the default executeFn (bitWidth=1),
// outputCount = 1.
// ---------------------------------------------------------------------------

export function makeExecuteMul(
  bitWidth: number,
  signed: boolean,
): (index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout) => void {
  const inputMask = bitWidth >= 32 ? 0xFFFFFFFF : ((1 << bitWidth) - 1);
  const signBit = 1 << (bitWidth - 1);

  return function executeMul(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
    const inBase = layout.inputOffset(index);
    const outBase = layout.outputOffset(index);

    const rawA = state[inBase] & inputMask;
    const rawB = state[inBase + 1] & inputMask;

    let bigA: bigint;
    let bigB: bigint;

    if (signed) {
      // Sign-extend from bitWidth
      const sA = (rawA & signBit) !== 0 ? rawA - (signBit << 1) : rawA;
      const sB = (rawB & signBit) !== 0 ? rawB - (signBit << 1) : rawB;
      bigA = BigInt(sA);
      bigB = BigInt(sB);
    } else {
      bigA = BigInt(rawA >>> 0);
      bigB = BigInt(rawB >>> 0);
    }

    const product = bigA * bigB;

    // Mask product to 2*bitWidth bits (handles negative BigInt results correctly)
    const outBits = bitWidth * 2;
    const outMask = outBits >= 64
      ? (BigInt(1) << BigInt(64)) - BigInt(1)
      : (BigInt(1) << BigInt(outBits)) - BigInt(1);
    const maskedProduct = ((product % (outMask + BigInt(1))) + (outMask + BigInt(1))) % (outMask + BigInt(1));

    // Store lower 32 bits in outBase
    state[outBase] = Number(maskedProduct & BigInt(0xFFFFFFFF)) >>> 0;

    // Store upper 32 bits in outBase+1 if layout has 2 output slots
    const outCount = layout.outputCount(index);
    if (outCount >= 2) {
      state[outBase + 1] = Number((maskedProduct >> BigInt(32)) & BigInt(0xFFFFFFFF)) >>> 0;
    }
  };
}

export function executeMul(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const bitWidth = (layout.getProperty?.(index, "bitWidth") as number | undefined) ?? 1;
  const signed = (layout.getProperty?.(index, "signed") as boolean | undefined) ?? false;
  makeExecuteMul(bitWidth, signed)(index, state, _highZs, layout);
}

// ---------------------------------------------------------------------------
// MUL_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const MUL_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
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
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const MUL_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of the operands (product is 2x this width)",
  },
  {
    key: "signed",
    type: PropertyType.BOOLEAN,
    label: "Signed",
    defaultValue: false,
    description: "Treat inputs as signed (two's complement)",
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
// MulDefinition
// ---------------------------------------------------------------------------

function mulFactory(props: PropertyBag): MulElement {
  return new MulElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const MulDefinition: ComponentDefinition = {
  name: "Mul",
  typeId: -1,
  factory: mulFactory,
  executeFn: executeMul,
  pinLayout: buildMulPinDeclarations(1),
  propertyDefs: MUL_PROPERTY_DEFS,
  attributeMap: MUL_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.ARITHMETIC,
  helpText:
    "Mul — N-bit multiplier producing a 2N-bit product.\n" +
    "Inputs: a, b (bitWidth bits each).\n" +
    "Output: mul (2*bitWidth-bit product).\n" +
    "Supports signed and unsigned modes.",
  defaultDelay: 10,
};
