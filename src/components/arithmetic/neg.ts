/**
 * Neg component — two's complement negation.
 *
 * Ports from Digital's Neg.java:
 *   Input: in (bitWidth)
 *   Output: out (bitWidth)
 *
 * out = -in (two's complement), masked to bitWidth bits.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  createInverterConfig,
  resolvePins,
  standardGatePinLayout,
} from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";

const COMP_WIDTH = 3;
const COMP_HEIGHT = 3;

function buildNegPinDeclarations(bitWidth: number): PinDeclaration[] {
  return standardGatePinLayout(["in"], "out", COMP_WIDTH, COMP_HEIGHT, bitWidth);
}

export class NegElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Neg", instanceId, position, rotation, mirror, props);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    const decls = buildNegPinDeclarations(this._bitWidth);
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
    ctx.setFont({ family: "sans-serif", size: 1.2, weight: "bold" });
    ctx.drawText("-A", COMP_WIDTH / 2, COMP_HEIGHT / 2, { horizontal: "center", vertical: "middle" });
    ctx.restore();
  }

  getHelpText(): string {
    return "Neg — two's complement negation. Output = -input, masked to bitWidth bits.";
  }
}

export function executeNeg(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const val = state[inBase] >>> 0;
  state[outBase] = (-val) >>> 0;
}

export const NEG_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
];

const NEG_PROPERTY_DEFS: PropertyDefinition[] = [
  { key: "bitWidth", type: PropertyType.BIT_WIDTH, label: "Bits", defaultValue: 1, min: 1, max: 32 },
];

export const NegDefinition: ComponentDefinition = {
  name: "Neg",
  typeId: -1,
  factory: (props) => new NegElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props),
  executeFn: executeNeg,
  pinLayout: buildNegPinDeclarations(1),
  propertyDefs: NEG_PROPERTY_DEFS,
  attributeMap: NEG_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.ARITHMETIC,
  helpText: "Neg — two's complement negation. Output = -input, masked to bitWidth bits.",
  defaultDelay: 10,
};
