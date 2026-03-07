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
const COMP_HEIGHT = 3;

function buildBitCountPinDeclarations(bitWidth: number): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 1, COMP_WIDTH, COMP_HEIGHT);
  const outputPositions = layoutPinsOnFace("east", 1, COMP_WIDTH, COMP_HEIGHT);
  return [
    { direction: PinDirection.INPUT, label: "in", defaultBitWidth: bitWidth, position: inputPositions[0], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: outBitsFor(bitWidth), position: outputPositions[0], isNegatable: false, isClockCapable: false },
  ];
}

export class BitCountElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("BitCount", instanceId, position, rotation, mirror, props);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 8);
    const decls = buildBitCountPinDeclarations(this._bitWidth);
    this._pins = resolvePins(decls, position, rotation, createInverterConfig([]), { clockPins: new Set<string>() });
  }

  getPins(): readonly Pin[] { return this._pins; }

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
    ctx.setFont({ family: "sans-serif", size: 0.9, weight: "bold" });
    ctx.drawText("#1", COMP_WIDTH / 2, COMP_HEIGHT / 2, { horizontal: "center", vertical: "middle" });
    ctx.restore();
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
  executeFn: executebitCount,
  pinLayout: buildBitCountPinDeclarations(8),
  propertyDefs: BIT_COUNT_PROPERTY_DEFS,
  attributeMap: BIT_COUNT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.ARITHMETIC,
  helpText: "BitCount — counts the number of set (1) bits in the input (population count).",
  defaultDelay: 10,
};
