/**
 * BitExtender component — sign-extend or zero-extend from narrower to wider width.
 *
 * Ports from Digital's BitExtender.java:
 *   Input: in (inputBits)
 *   Output: out (outputBits)
 *
 * If MSB of input is 0: out = in (zero-extended)
 * If MSB of input is 1: out = in | ~mask(inputBits) (sign-extended, high bits set to 1)
 *
 * inputBits < outputBits is required.
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

const COMP_WIDTH = 3;
const COMP_HEIGHT = 3;

function buildBitExtenderPinDeclarations(inputBits: number, outputBits: number): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 1, COMP_WIDTH, COMP_HEIGHT);
  const outputPositions = layoutPinsOnFace("east", 1, COMP_WIDTH, COMP_HEIGHT);
  return [
    { direction: PinDirection.INPUT, label: "in", defaultBitWidth: inputBits, position: inputPositions[0], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: outputBits, position: outputPositions[0], isNegatable: false, isClockCapable: false },
  ];
}

export class BitExtenderElement extends AbstractCircuitElement {
  private readonly _inputBits: number;
  private readonly _outputBits: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("BitExtender", instanceId, position, rotation, mirror, props);
    this._inputBits = props.getOrDefault<number>("inputBits", 4);
    this._outputBits = props.getOrDefault<number>("outputBits", 8);
    const decls = buildBitExtenderPinDeclarations(this._inputBits, this._outputBits);
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
    ctx.drawText("ext", COMP_WIDTH / 2, COMP_HEIGHT / 2, { horizontal: "center", vertical: "middle" });
    ctx.restore();
  }

  getHelpText(): string {
    return "BitExtender — sign-extends the input from inputBits to outputBits. MSB of input determines sign fill.";
  }
}

export function makeExecuteBitExtender(
  inputBits: number,
  outputBits: number,
): (index: number, state: Uint32Array, layout: ComponentLayout) => void {
  const inMask = inputBits >= 32 ? 0xFFFFFFFF : ((1 << inputBits) - 1);
  const outMask = outputBits >= 32 ? 0xFFFFFFFF : ((1 << outputBits) - 1);
  const signBit = 1 << (inputBits - 1);
  // Extension mask: bits above inputBits up to outputBits
  const extendMask = (outMask ^ inMask) >>> 0;

  return function executeBitExtender(index: number, state: Uint32Array, layout: ComponentLayout): void {
    const inBase = layout.inputOffset(index);
    const outBase = layout.outputOffset(index);
    const inVal = state[inBase] & inMask;

    if ((inVal & signBit) !== 0) {
      // Sign bit is set: extend with 1s
      state[outBase] = (inVal | extendMask) >>> 0;
    } else {
      // Sign bit is clear: zero-extend
      state[outBase] = inVal >>> 0;
    }
  };
}

export function executeBitExtender(index: number, state: Uint32Array, layout: ComponentLayout): void {
  makeExecuteBitExtender(4, 8)(index, state, layout);
}

export const BIT_EXTENDER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Input_Bits", propertyKey: "inputBits", convert: (v) => parseInt(v, 10) },
  { xmlName: "Output_Bits", propertyKey: "outputBits", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

const BIT_EXTENDER_PROPERTY_DEFS: PropertyDefinition[] = [
  { key: "inputBits", type: PropertyType.BIT_WIDTH, label: "Input bits", defaultValue: 4, min: 1, max: 31 },
  { key: "outputBits", type: PropertyType.BIT_WIDTH, label: "Output bits", defaultValue: 8, min: 2, max: 32 },
  { key: "label", type: PropertyType.STRING, label: "Label", defaultValue: "" },
];

export const BitExtenderDefinition: ComponentDefinition = {
  name: "BitExtender",
  typeId: -1,
  factory: (props) => new BitExtenderElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props),
  executeFn: executeBitExtender,
  pinLayout: buildBitExtenderPinDeclarations(4, 8),
  propertyDefs: BIT_EXTENDER_PROPERTY_DEFS,
  attributeMap: BIT_EXTENDER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.ARITHMETIC,
  helpText: "BitExtender — sign-extends the input from inputBits to outputBits.",
  defaultDelay: 10,
};
