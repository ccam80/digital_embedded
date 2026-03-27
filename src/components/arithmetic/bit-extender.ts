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
const COMP_HEIGHT = 1;

// GenericShape: 1 input, 1 output, symmetric=true, even=false, offs=0
// in@(0,0), out@(3,0)
function buildBitExtenderPinDeclarations(inputBits: number, outputBits: number): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "in", defaultBitWidth: inputBits, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: outputBits, position: { x: 3, y: 0 }, isNegatable: false, isClockCapable: false },
  ];
}

export class BitExtenderElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("BitExtender", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const inputBits = this._properties.getOrDefault<number>("inputBits", 4);
    const outputBits = this._properties.getOrDefault<number>("outputBits", 8);
    return this.derivePins(buildBitExtenderPinDeclarations(inputBits, outputBits), []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x + 0.05, y: this.position.y - 0.5, width: (COMP_WIDTH - 0.05) - 0.05, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    drawGenericShape(ctx, {
      inputLabels: ["in"],
      outputLabels: ["out"],
      clockInputIndices: [],
      componentName: "SignEx",
      width: 3,
      label: this._visibleLabel(),
      rotation: this.rotation,
    });
  }

  getHelpText(): string {
    return "BitExtender — sign-extends the input from inputBits to outputBits. MSB of input determines sign fill.";
  }
}

export function makeExecuteBitExtender(
  inputBits: number,
  outputBits: number,
): (index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout) => void {
  const inMask = inputBits >= 32 ? 0xFFFFFFFF : ((1 << inputBits) - 1);
  const outMask = outputBits >= 32 ? 0xFFFFFFFF : ((1 << outputBits) - 1);
  const signBit = 1 << (inputBits - 1);
  // Extension mask: bits above inputBits up to outputBits
  const extendMask = (outMask ^ inMask) >>> 0;

  return function executeBitExtender(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
    const wt = layout.wiringTable;
    const inBase = layout.inputOffset(index);
    const outBase = layout.outputOffset(index);
    const inVal = state[wt[inBase]] & inMask;

    if ((inVal & signBit) !== 0) {
      state[wt[outBase]] = (inVal | extendMask) >>> 0;
    } else {
      state[wt[outBase]] = inVal >>> 0;
    }
  };
}

const _bitExtenderCache = new Map<string, (index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout) => void>();

export function executeBitExtender(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const inProp = layout.getProperty(index, "inputBits");
  const outProp = layout.getProperty(index, "outputBits");
  const inputBits = typeof inProp === "number" ? inProp : 4;
  const outputBits = typeof outProp === "number" ? outProp : 8;
  const key = `${inputBits},${outputBits}`;
  let fn = _bitExtenderCache.get(key);
  if (fn === undefined) {
    fn = makeExecuteBitExtender(inputBits, outputBits);
    _bitExtenderCache.set(key, fn);
  }
  fn(index, state, _highZs, layout);
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
  pinLayout: buildBitExtenderPinDeclarations(4, 8),
  propertyDefs: BIT_EXTENDER_PROPERTY_DEFS,
  attributeMap: BIT_EXTENDER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.ARITHMETIC,
  helpText: "BitExtender — sign-extends the input from inputBits to outputBits.",
  models: {
    digital: {
      executeFn: executeBitExtender,
      inputSchema: ["in"],
      outputSchema: ["out"],
      defaultDelay: 10,
    },
  },
};
