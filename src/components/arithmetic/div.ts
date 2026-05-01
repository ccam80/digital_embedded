/**
 * Div component- N-bit divider with quotient and remainder.
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

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

// GenericShape: 2 inputs, 2 outputs, symmetric=false, offs=0
// a@(0,0), b@(0,1), q@(3,0), r@(3,1)
function buildDivPinDeclarations(bitWidth: number): PinDeclaration[] {
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
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "q",
      defaultBitWidth: bitWidth,
      position: { x: 3, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "r",
      defaultBitWidth: bitWidth,
      position: { x: 3, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// DivElement
// ---------------------------------------------------------------------------

export class DivElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Div", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    return this.derivePins(buildDivPinDeclarations(bitWidth), []);
  }

  getBoundingBox(): Rect {
    const b = genericShapeBounds(2, 2, COMP_WIDTH);
    return { x: this.position.x + b.localX, y: this.position.y + b.localY, width: b.width, height: b.height };
  }

  draw(ctx: RenderContext): void {
    drawGenericShape(ctx, {
      inputLabels: ["a", "b"],
      outputLabels: ["q", "r"],
      clockInputIndices: [],
      componentName: "Div",
      width: 3,
      label: this._visibleLabel(),
      rotation: this.rotation,
    });
  }

}

// ---------------------------------------------------------------------------
// makeExecuteDiv- parameterised flat simulation function
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
): (index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout) => void {
  const mask = bitWidth >= 32 ? 0xFFFFFFFF : ((1 << bitWidth) - 1);
  const signBit = 1 << (bitWidth - 1);

  return function executeDiv(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
    const wt = layout.wiringTable;
    const inBase = layout.inputOffset(index);
    const outBase = layout.outputOffset(index);

    const rawA = state[wt[inBase]] & mask;
    const rawB = state[wt[inBase + 1]] & mask;

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

      state[wt[outBase]] = (q & mask) >>> 0;
      state[wt[outBase + 1]] = (r & mask) >>> 0;
    } else {
      const av = rawA >>> 0;
      let bv = rawB >>> 0;

      if (bv === 0) bv = 1;

      const q = Math.floor(av / bv);
      const r = av % bv;

      state[wt[outBase]] = (q & mask) >>> 0;
      state[wt[outBase + 1]] = (r & mask) >>> 0;
    }
  };
}

export function executeDiv(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  makeExecuteDiv(
    (layout.getProperty(index, "bitWidth") as number | undefined) ?? 1,
    (layout.getProperty(index, "signed") as boolean | undefined) ?? false,
    (layout.getProperty(index, "remainderPositive") as boolean | undefined) ?? false,
  )(index, state, _highZs, layout);
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
    structural: true,
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
  LABEL_PROPERTY_DEF,
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
  pinLayout: buildDivPinDeclarations(1),
  propertyDefs: DIV_PROPERTY_DEFS,
  attributeMap: DIV_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.ARITHMETIC,
  helpText:
    "Div- N-bit divider with quotient and remainder.\n" +
    "Inputs: a, b (bitWidth bits each).\n" +
    "Outputs: q (quotient), r (remainder).\n" +
    "Division by zero is treated as division by 1.\n" +
    "Supports signed mode with optional positive-remainder adjustment.",
  models: {
    digital: {
      executeFn: executeDiv,
      inputSchema: ["a", "b"],
      outputSchema: ["q", "r"],
      defaultDelay: 10,
    },
  },
};
