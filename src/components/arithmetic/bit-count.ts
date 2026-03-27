/**
 * BitCount component — count number of set bits (popcount).
 *
 * Ports from Digital's BitCount.java:
 *   Input: in (bitWidth)
 *   Output: out (ceil(log2(bitWidth+1)) bits)
 *
 * out = popcount(in)
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
} from "../../core/pin.js";
import { drawGenericShape } from "../generic-shape.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";

// Output bit width: enough to hold max count of bitWidth (= bitWidth itself)
// Java uses Bits.binLn2(bitWidth) which is ceil(log2(bitWidth))
function outBitsFor(bitWidth: number): number {
  let n = bitWidth;
  let bits = 0;
  while (n > 0) {
    bits++;
    n >>= 1;
  }
  return Math.max(1, bits);
}

const COMP_WIDTH = 3;
const COMP_HEIGHT = 1;

// GenericShape: 1 input, 1 output, symmetric=true, even=false, offs=0
// in@(0,0), out@(3,0)
function buildBitCountPinDeclarations(bitWidth: number): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "in", defaultBitWidth: bitWidth, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: outBitsFor(bitWidth), position: { x: 3, y: 0 }, isNegatable: false, isClockCapable: false },
  ];
}

export class BitCountElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("BitCount", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 8);
    return this.derivePins(buildBitCountPinDeclarations(bitWidth), []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x + 0.05, y: this.position.y - 0.5, width: (COMP_WIDTH - 0.05) - 0.05, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    drawGenericShape(ctx, {
      inputLabels: ["in"],
      outputLabels: ["out"],
      clockInputIndices: [],
      componentName: "Bit count",
      width: 3,
      label: this._visibleLabel(),
      rotation: this.rotation,
    });
  }

  getHelpText(): string {
    return "BitCount — counts the number of set (1) bits in the input (population count / popcount).";
  }
}

export function executebitCount(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  let val = state[wt[inBase]] >>> 0;
  let count = 0;
  while (val !== 0) {
    val &= val - 1;
    count++;
  }
  state[wt[outBase]] = count;
}

export { executebitCount as executeBitCount };

export const BIT_COUNT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
];

const BIT_COUNT_PROPERTY_DEFS: PropertyDefinition[] = [
  { key: "bitWidth", type: PropertyType.BIT_WIDTH, label: "Bits", defaultValue: 8, min: 1, max: 32 },
];

export const BitCountDefinition: ComponentDefinition = {
  name: "BitCount",
  typeId: -1,
  factory: (props) => new BitCountElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props),
  pinLayout: buildBitCountPinDeclarations(8),
  propertyDefs: BIT_COUNT_PROPERTY_DEFS,
  attributeMap: BIT_COUNT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.ARITHMETIC,
  helpText: "BitCount — counts the number of set (1) bits in the input (population count).",
  models: {
    digital: {
      executeFn: executebitCount,
      inputSchema: ["in"],
      outputSchema: ["out"],
      defaultDelay: 10,
    },
  },
};
