/**
 * Mul component- N-bit multiplier producing a 2N-bit product.
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
} from "../../core/pin.js";
import { drawGenericShape, genericShapeBounds } from "../generic-shape.js";
import { PropertyBag, PropertyType, LABEL_PROPERTY_DEF } from "../../core/properties.js";
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
// Java Mul uses GenericShape: 2 inputs (a, b), 1 output (mul), width=3
// Inputs a@(0,0), b@(0,2) [even gap], output mul@(3,1) [offs=1]
// Java rect: (0.05,-0.5)→(2.95,2.5) = height 3

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildMulPinDeclarations(bitWidth: number): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "a",
      defaultBitWidth: bitWidth,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "b",
      defaultBitWidth: bitWidth,
      position: { x: 0, y: 2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "mul",
      defaultBitWidth: Math.min(bitWidth * 2, 32),
      position: { x: 3, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// MulElement
// ---------------------------------------------------------------------------

export class MulElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Mul", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    return this.derivePins(buildMulPinDeclarations(bitWidth), []);
  }

  getBoundingBox(): Rect {
    const b = genericShapeBounds(2, 1, COMP_WIDTH);
    return { x: this.position.x + b.localX, y: this.position.y + b.localY, width: b.width, height: b.height };
  }

  draw(ctx: RenderContext): void {
    drawGenericShape(ctx, {
      inputLabels: ["a", "b"],
      outputLabels: ["mul"],
      clockInputIndices: [],
      componentName: "Mul",
      width: 3,
      label: this._visibleLabel(),
      rotation: this.rotation,
    });
  }

}

// ---------------------------------------------------------------------------
// makeExecuteMul- parameterised flat simulation function
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
    const wt = layout.wiringTable;
    const inBase = layout.inputOffset(index);
    const outBase = layout.outputOffset(index);

    const rawA = state[wt[inBase]] & inputMask;
    const rawB = state[wt[inBase + 1]] & inputMask;

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

    state[wt[outBase]] = Number(maskedProduct & BigInt(0xFFFFFFFF)) >>> 0;

    const outCount = layout.outputCount(index);
    if (outCount >= 2) {
      state[wt[outBase + 1]] = Number((maskedProduct >> BigInt(32)) & BigInt(0xFFFFFFFF)) >>> 0;
    }
  };
}

export function executeMul(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  makeExecuteMul(
    (layout.getProperty(index, "bitWidth") as number | undefined) ?? 1,
    (layout.getProperty(index, "signed") as boolean | undefined) ?? false,
  )(index, state, _highZs, layout);
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
    structural: true,
  },
  {
    key: "signed",
    type: PropertyType.BOOLEAN,
    label: "Signed",
    defaultValue: false,
    description: "Treat inputs as signed (two's complement)",
  },
  LABEL_PROPERTY_DEF,
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
  pinLayout: buildMulPinDeclarations(1),
  propertyDefs: MUL_PROPERTY_DEFS,
  attributeMap: MUL_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.ARITHMETIC,
  helpText:
    "Mul- N-bit multiplier producing a 2N-bit product.\n" +
    "Inputs: a, b (bitWidth bits each).\n" +
    "Output: mul (2*bitWidth-bit product).\n" +
    "Supports signed and unsigned modes.",
  models: {
    digital: {
      executeFn: executeMul,
      inputSchema: ["a", "b"],
      outputSchema: ["mul"],
      defaultDelay: 10,
    },
  },
};
