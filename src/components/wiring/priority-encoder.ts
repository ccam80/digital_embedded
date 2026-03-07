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

function componentHeight(inputCount: number): number {
  return Math.max(inputCount * 2, 4);
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

export function buildPriorityEncoderPinDeclarations(
  selectorBits: number,
): PinDeclaration[] {
  const inputCount = 1 << selectorBits;
  const h = componentHeight(inputCount);

  const inputPositions = layoutPinsOnFace("west", inputCount, COMP_WIDTH, h);
  const inputPins: PinDeclaration[] = [];
  for (let i = 0; i < inputCount; i++) {
    inputPins.push({
      direction: PinDirection.INPUT,
      label: `in${i}`,
      defaultBitWidth: 1,
      position: inputPositions[i],
      isNegatable: false,
      isClockCapable: false,
    });
  }

  const outputPositions = layoutPinsOnFace("east", 2, COMP_WIDTH, h);
  const numPin: PinDeclaration = {
    direction: PinDirection.OUTPUT,
    label: "num",
    defaultBitWidth: selectorBits,
    position: outputPositions[0],
    isNegatable: false,
    isClockCapable: false,
  };

  const anyPin: PinDeclaration = {
    direction: PinDirection.OUTPUT,
    label: "any",
    defaultBitWidth: 1,
    position: outputPositions[1],
    isNegatable: false,
    isClockCapable: false,
  };

  return [...inputPins, numPin, anyPin];
}

// ---------------------------------------------------------------------------
// PriorityEncoderElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class PriorityEncoderElement extends AbstractCircuitElement {
  private readonly _selectorBits: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PriorityEncoder", instanceId, position, rotation, mirror, props);

    this._selectorBits = props.getOrDefault<number>("selectorBits", 2);

    const decls = buildPriorityEncoderPinDeclarations(this._selectorBits);
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
    const inputCount = 1 << this._selectorBits;
    const h = componentHeight(inputCount);
    return {
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: h,
    };
  }

  draw(ctx: RenderContext): void {
    const inputCount = 1 << this._selectorBits;
    const h = componentHeight(inputCount);

    ctx.save();

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, h, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, h, false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.85, weight: "bold" });
    ctx.drawText("PRIO", COMP_WIDTH / 2, h / 2, {
      horizontal: "center",
      vertical: "middle",
    });

    ctx.restore();
  }

  getHelpText(): string {
    const inputCount = 1 << this._selectorBits;
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
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const inputCount = layout.inputCount(index);

  let sel = 0;
  let any = 0;

  for (let i = 0; i < inputCount; i++) {
    if (state[inBase + i] !== 0) {
      sel = i;
      any = 1;
    }
  }

  state[outBase] = sel >>> 0;
  state[outBase + 1] = any;
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
    defaultValue: 2,
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
  pinLayout: buildPriorityEncoderPinDeclarations(2),
  propertyDefs: PRIORITY_ENCODER_PROPERTY_DEFS,
  attributeMap: PRIORITY_ENCODER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "PriorityEncoder — outputs the index of the highest-priority active input.\n" +
    "num: highest active input index. any: 1 if any input is active.",
};
