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
  gateBodyMetrics,
  standardGatePinLayout,
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

const COMP_WIDTH = 3;

function buildNegPinDeclarations(bitWidth: number): PinDeclaration[] {
  const { bodyHeight } = gateBodyMetrics(1);
  return standardGatePinLayout(["in"], "out", COMP_WIDTH, bodyHeight, bitWidth);
}

export class NegElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Neg", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    return this.derivePins(buildNegPinDeclarations(bitWidth), []);
  }

  getBoundingBox(): Rect {
    // GenericShape: 1 input, 1 output, symmetric, odd → maxY=1, height=1
    return { x: this.position.x + 0.05, y: this.position.y - 0.5, width: (COMP_WIDTH - 0.05) - 0.05, height: 1 };
  }

  draw(ctx: RenderContext): void {
    drawGenericShape(ctx, {
      inputLabels: ["in"],
      outputLabels: ["out"],
      clockInputIndices: [],
      componentName: "Neg",
      width: 3,
      label: this._properties.getOrDefault<string>("label", ""),
    });
  }

  getHelpText(): string {
    return "Neg — two's complement negation. Output = -input, masked to bitWidth bits.";
  }
}

export function executeNeg(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const val = state[wt[inBase]] >>> 0;
  state[wt[outBase]] = (-val) >>> 0;
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
