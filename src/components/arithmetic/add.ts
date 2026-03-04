/**
 * Add component — N-bit adder with carry in/out.
 *
 * Ports from Digital's Add.java:
 *   Inputs: a (bitWidth), b (bitWidth), c_i (1-bit carry in)
 *   Outputs: s (bitWidth sum), c_o (1-bit carry out)
 *
 * The carry-out bit is the (bitWidth+1)th bit of the full sum.
 * For bitWidth < 32 (our Uint32Array constraint) this is simple:
 *   full = a + b + c_i; sum = full & mask; cout = (full >>> bitWidth) & 1
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
const COMP_HEIGHT = 6;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildAddPinDeclarations(bitWidth: number): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 3, COMP_WIDTH, COMP_HEIGHT);
  const outputPositions = layoutPinsOnFace("east", 2, COMP_WIDTH, COMP_HEIGHT);

  return [
    {
      direction: PinDirection.INPUT,
      label: "a",
      defaultBitWidth: bitWidth,
      position: inputPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "b",
      defaultBitWidth: bitWidth,
      position: inputPositions[1],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "c_i",
      defaultBitWidth: 1,
      position: inputPositions[2],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "s",
      defaultBitWidth: bitWidth,
      position: outputPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "c_o",
      defaultBitWidth: 1,
      position: outputPositions[1],
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// AddElement
// ---------------------------------------------------------------------------

export class AddElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Add", instanceId, position, rotation, mirror, props);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    const decls = buildAddPinDeclarations(this._bitWidth);
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
    return { x: this.position.x, y: this.position.y, width: COMP_WIDTH, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    const { x, y } = this.position;
    ctx.save();
    ctx.translate(x, y);

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.2, weight: "bold" });
    ctx.drawText("+", COMP_WIDTH / 2, COMP_HEIGHT / 2, { horizontal: "center", vertical: "middle" });

    this._drawLabel(ctx);
    ctx.restore();
  }

  private _drawLabel(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length === 0) return;
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.0 });
    ctx.drawText(label, COMP_WIDTH / 2, -0.5, { horizontal: "center", vertical: "bottom" });
  }

  getHelpText(): string {
    return (
      "Add — N-bit adder with carry in/out.\n" +
      "Inputs: a, b (bitWidth bits each), c_i (1-bit carry in).\n" +
      "Outputs: s (bitWidth-bit sum), c_o (1-bit carry out)."
    );
  }
}

// ---------------------------------------------------------------------------
// executeAdd — flat simulation function
//
// Inputs layout (3 slots): [a, b, c_i]
// Outputs layout (2 slots): [s, c_o]
//
// For bitWidth <= 32 we work in 32-bit unsigned arithmetic.
// The carry out is the bit at position bitWidth of the full (bitWidth+1)-bit sum.
// We store bitWidth in the component's property, but the executeFn only has
// access to the state array and layout. We encode bitWidth in the output by
// reading it from the state word count: outputCount gives us no help here, so
// we store the mask in a closure-free way by using a per-component approach.
//
// Since executeFn cannot carry per-instance data, we use a factory that
// closes over bitWidth. This is the same approach used for any parameterised
// component whose execute behaviour depends on a property.
// ---------------------------------------------------------------------------

export function makeExecuteAdd(bitWidth: number): (index: number, state: Uint32Array, layout: ComponentLayout) => void {
  const mask = bitWidth >= 32 ? 0xFFFFFFFF : ((1 << bitWidth) - 1);
  const carryMask = bitWidth >= 32 ? 0 : (1 << bitWidth);

  return function executeAdd(index: number, state: Uint32Array, layout: ComponentLayout): void {
    const inBase = layout.inputOffset(index);
    const outBase = layout.outputOffset(index);

    const a = state[inBase] >>> 0;
    const b = state[inBase + 1] >>> 0;
    const ci = state[inBase + 2] & 1;

    if (bitWidth < 32) {
      const full = (a + b + ci) >>> 0;
      state[outBase] = full & mask;
      state[outBase + 1] = (full & carryMask) !== 0 ? 1 : 0;
    } else {
      // 32-bit: use BigInt for carry detection
      const full = BigInt(a) + BigInt(b) + BigInt(ci);
      state[outBase] = Number(full & BigInt(0xFFFFFFFF)) >>> 0;
      state[outBase + 1] = full > BigInt(0xFFFFFFFF) ? 1 : 0;
    }
  };
}

export function executeAdd(index: number, state: Uint32Array, layout: ComponentLayout): void {
  makeExecuteAdd(1)(index, state, layout);
}

// ---------------------------------------------------------------------------
// ADD_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const ADD_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
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

const ADD_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of the operands",
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
// AddDefinition
// ---------------------------------------------------------------------------

function addFactory(props: PropertyBag): AddElement {
  return new AddElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const AddDefinition: ComponentDefinition = {
  name: "Add",
  typeId: -1,
  factory: addFactory,
  executeFn: executeAdd,
  pinLayout: buildAddPinDeclarations(1),
  propertyDefs: ADD_PROPERTY_DEFS,
  attributeMap: ADD_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.ARITHMETIC,
  helpText:
    "Add — N-bit adder with carry in/out.\n" +
    "Inputs: a, b (bitWidth bits each), c_i (1-bit carry in).\n" +
    "Outputs: s (bitWidth-bit sum), c_o (1-bit carry out).",
  defaultDelay: 10,
};
