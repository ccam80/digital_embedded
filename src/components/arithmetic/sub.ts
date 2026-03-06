/**
 * Sub component — N-bit subtractor with borrow in/out.
 *
 * Ports from Digital's Sub.java:
 *   Inputs: a (bitWidth), b (bitWidth), c_i (1-bit borrow in)
 *   Outputs: s (bitWidth difference), c_o (1-bit borrow out)
 *
 * sub = a - b - borrow_in
 * borrow_out = 1 if the subtraction underflowed (result would be negative unsigned)
 *
 * For unsigned bitWidth-bit subtraction:
 *   full = a - b - borrow_in
 *   If full < 0 (i.e., bit at position bitWidth is set), borrow_out = 1
 *   result = full & mask
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

function buildSubPinDeclarations(bitWidth: number): PinDeclaration[] {
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
// SubElement
// ---------------------------------------------------------------------------

export class SubElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Sub", instanceId, position, rotation, mirror, props);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    const decls = buildSubPinDeclarations(this._bitWidth);
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
    ctx.save();

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.2, weight: "bold" });
    ctx.drawText("-", COMP_WIDTH / 2, COMP_HEIGHT / 2, { horizontal: "center", vertical: "middle" });

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
      "Sub — N-bit subtractor with borrow in/out.\n" +
      "Inputs: a, b (bitWidth bits each), c_i (1-bit borrow in).\n" +
      "Outputs: s (bitWidth-bit difference), c_o (1-bit borrow out)."
    );
  }
}

// ---------------------------------------------------------------------------
// executeSubWithWidth — parameterised flat simulation function
//
// Inputs: [a, b, c_i]   Outputs: [s, c_o]
//
// s = a - b - borrow_in  (truncated to bitWidth)
// c_o (borrow out) = 1 if the result underflowed unsigned range
//
// For bitWidth < 32: compute in signed 32-bit space then check the borrow bit.
// For bitWidth == 32: use BigInt to detect underflow across the 32-bit boundary.
// ---------------------------------------------------------------------------

export function makeExecuteSub(bitWidth: number): (index: number, state: Uint32Array, layout: ComponentLayout) => void {
  const mask = bitWidth >= 32 ? 0xFFFFFFFF : ((1 << bitWidth) - 1);

  return function executeSub(index: number, state: Uint32Array, layout: ComponentLayout): void {
    const inBase = layout.inputOffset(index);
    const outBase = layout.outputOffset(index);

    const a = state[inBase] >>> 0;
    const b = state[inBase + 1] >>> 0;
    const ci = state[inBase + 2] & 1;

    if (bitWidth < 32) {
      const full = a - b - ci;
      state[outBase] = (full & mask) >>> 0;
      // borrow out: if result went negative in unsigned space
      state[outBase + 1] = full < 0 ? 1 : 0;
    } else {
      // 32-bit: use BigInt for borrow detection
      const bigA = BigInt(a);
      const bigB = BigInt(b);
      const bigCI = BigInt(ci);
      const full = bigA - bigB - bigCI;
      state[outBase] = Number(((full % BigInt(0x100000000)) + BigInt(0x100000000)) % BigInt(0x100000000)) >>> 0;
      state[outBase + 1] = full < BigInt(0) ? 1 : 0;
    }
  };
}

export function executeSub(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const bitWidth = (layout.getProperty?.(index, "bitWidth") as number | undefined) ?? 1;
  makeExecuteSub(bitWidth)(index, state, layout);
}

// ---------------------------------------------------------------------------
// SUB_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const SUB_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
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

const SUB_PROPERTY_DEFS: PropertyDefinition[] = [
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
// SubDefinition
// ---------------------------------------------------------------------------

function subFactory(props: PropertyBag): SubElement {
  return new SubElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const SubDefinition: ComponentDefinition = {
  name: "Sub",
  typeId: -1,
  factory: subFactory,
  executeFn: executeSub,
  pinLayout: buildSubPinDeclarations(1),
  propertyDefs: SUB_PROPERTY_DEFS,
  attributeMap: SUB_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.ARITHMETIC,
  helpText:
    "Sub — N-bit subtractor with borrow in/out.\n" +
    "Inputs: a, b (bitWidth bits each), c_i (1-bit borrow in).\n" +
    "Outputs: s (bitWidth-bit difference), c_o (1-bit borrow out).",
  defaultDelay: 10,
};
