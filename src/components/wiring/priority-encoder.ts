/**
 * PriorityEncoder component — outputs the index of the highest-priority
 * (most significant) active input.
 *
 * Based on Digital's Java implementation: scans from lowest to highest index,
 * so the LAST active input (highest index) wins (matches Java's loop behavior
 * which sets sel = i for every active input, ending at the highest active one).
 *
 * Outputs:
 *   - num: index of highest-priority active input (selectorBits wide)
 *   - any: 1 if any input is active, 0 otherwise
 *
 * Properties:
 *   - selectorBits: controls number of inputs (2^selectorBits inputs)
 *
 * Pin layout:
 *   0..N-1: in0..in(N-1) (inputs, 1-bit each)
 *   N: num (output, selectorBits wide)
 *   N+1: any (output, 1-bit)
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import { drawGenericShape } from "../generic-shape.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
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

function componentHeight(inputCount: number): number {
  // Java GenericShape height = max(inputCount, outputCount + offs)
  // For non-symmetric (2 outputs): height = inputCount (no gap correction)
  return inputCount;
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

export function buildPriorityEncoderPinDeclarations(
  selectorBits: number,
): PinDeclaration[] {
  const inputCount = 1 << selectorBits;

  // Java GenericShape(inputCount inputs, 2 outputs, width=3, non-symmetric):
  // offs = 0 (non-symmetric), inputs at (0, i), outputs at (3, i)
  const inputPins: PinDeclaration[] = [];
  for (let i = 0; i < inputCount; i++) {
    inputPins.push({
      direction: PinDirection.INPUT,
      label: `in${i}`,
      defaultBitWidth: 1,
      position: { x: 0, y: i },
      isNegatable: false,
      isClockCapable: false,
    });
  }

  const numPin: PinDeclaration = {
    direction: PinDirection.OUTPUT,
    label: "num",
    defaultBitWidth: selectorBits,
    position: { x: 3.9, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  };

  const anyPin: PinDeclaration = {
    direction: PinDirection.OUTPUT,
    label: "any",
    defaultBitWidth: 1,
    position: { x: 3.9, y: 1 },
    isNegatable: false,
    isClockCapable: false,
  };

  return [...inputPins, numPin, anyPin];
}

// ---------------------------------------------------------------------------
// PriorityEncoderElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class PriorityEncoderElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PriorityEncoder", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const selectorBits = this._properties.getOrDefault<number>("selectorBits", 1);
    return this.derivePins(buildPriorityEncoderPinDeclarations(selectorBits));
  }

  getBoundingBox(): Rect {
    const selectorBits = this._properties.getOrDefault<number>("selectorBits", 1);
    const inputCount = 1 << selectorBits;
    const h = componentHeight(inputCount);
    return {
      x: this.position.x + 0.05,
      y: this.position.y - 0.5,
      width: (COMP_WIDTH - 0.05) - 0.05,
      height: h,
    };
  }

  draw(ctx: RenderContext): void {
    const selectorBits = this._properties.getOrDefault<number>("selectorBits", 1);
    const inputCount = 1 << selectorBits;
    const inputLabels: string[] = [];
    for (let i = 0; i < inputCount; i++) {
      inputLabels.push(`in${i}`);
    }
    const label = this._properties.getOrDefault<string>("label", "");
    drawGenericShape(ctx, {
      inputLabels,
      outputLabels: ["num", "any"],
      clockInputIndices: [],
      componentName: "Priority",
      width: COMP_WIDTH,
      ...(label.length > 0 ? { label } : {}),
    });
  }

  getHelpText(): string {
    const selectorBits = this._properties.getOrDefault<number>("selectorBits", 1);
    const inputCount = 1 << selectorBits;
    return (
      `PriorityEncoder — ${inputCount} inputs, outputs index of highest-priority active input.\n` +
      "num: index of highest active input (last active wins).\n" +
      "any: 1 if any input is active."
    );
  }
}

// ---------------------------------------------------------------------------
// executePriorityEncoder — flat simulation function
//
// Mirrors Digital's Java implementation: scans all inputs, the last active
// input (highest index) wins. Sets any=1 if any input is active.
//
// Pin layout in state array:
//   inputs 0..N-1: in0..in(N-1)
//   output 0: num
//   output 1: any
// ---------------------------------------------------------------------------

export function executePriorityEncoder(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const inputCount = layout.inputCount(index);

  let sel = 0;
  let any = 0;

  for (let i = 0; i < inputCount; i++) {
    if (state[wt[inBase + i]] !== 0) {
      sel = i;
      any = 1;
    }
  }

  state[wt[outBase]] = sel >>> 0;
  state[wt[outBase + 1]] = any;
}

// ---------------------------------------------------------------------------
// PRIORITY_ENCODER_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const PRIORITY_ENCODER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Selector Bits",
    propertyKey: "selectorBits",
    convert: (v) => parseInt(v, 10),
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

const PRIORITY_ENCODER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "selectorBits",
    type: PropertyType.INT,
    label: "Selector Bits",
    defaultValue: 1,
    min: 1,
    max: 4,
    description: "Number of output bits (input count = 2^selectorBits)",
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
// PriorityEncoderDefinition
// ---------------------------------------------------------------------------

function priorityEncoderFactory(props: PropertyBag): PriorityEncoderElement {
  return new PriorityEncoderElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const PriorityEncoderDefinition: ComponentDefinition = {
  name: "PriorityEncoder",
  typeId: -1,
  factory: priorityEncoderFactory,
  executeFn: executePriorityEncoder,
  pinLayout: buildPriorityEncoderPinDeclarations(1),
  propertyDefs: PRIORITY_ENCODER_PROPERTY_DEFS,
  attributeMap: PRIORITY_ENCODER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "PriorityEncoder — outputs the index of the highest-priority active input.\n" +
    "num: highest active input index. any: 1 if any input is active.",
};
