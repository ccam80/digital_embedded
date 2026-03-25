/**
 * Const component — constant value source.
 *
 * Writes a fixed value to its output on every simulation step.
 * The value is a bigint to support up to 32 bits without signed overflow.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
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

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildConstPinDeclarations(bitWidth: number): PinDeclaration[] {
  // Java ConstShape: pin at (0, 0), body extends to -x.
  return [
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: bitWidth,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// ConstElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ConstElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Const", instanceId, position, rotation, mirror, props);
  }

  get value(): number {
    return this._properties.getOrDefault<number>("value", 1) >>> 0;
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const decls = buildConstPinDeclarations(bitWidth);
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    // draw() is text-only — tsCallsToSegments produces no segments, so the
    // computed draw-bounds collapses to (0,0,0,0) at the pin origin.
    // The bbox must start at x=0 (not negative) to avoid a false overflow on
    // the left side, and extend rightward to cover label text.
    return {
      x: this.position.x,
      y: this.position.y,
      width: 1.5,
      height: 0.5,
    };
  }

  draw(ctx: RenderContext): void {
    const value = this._properties.getOrDefault<number>("value", 1) >>> 0;
    ctx.save();

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.9 });
    ctx.drawText(value.toString(10), -0.15, 0, {
      horizontal: "right",
      vertical: "middle",
    });

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Const — constant value source.\n" +
      "Outputs a fixed value on every simulation step.\n" +
      "Configurable bit width and constant value."
    );
  }
}

// ---------------------------------------------------------------------------
// executeConst — writes the fixed value to the output slot
// ---------------------------------------------------------------------------

export function executeConst(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const outputIdx = layout.outputOffset(index);
  const valueProp = layout.getProperty(index, "value");
  const value = typeof valueProp === "number" ? valueProp >>> 0 : 1;
  state[wt[outputIdx]] = value;
}

// ---------------------------------------------------------------------------
// CONST_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const CONST_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "Value",
    propertyKey: "value",
    convert: (v) => parseInt(v, 10),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const CONST_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of the constant output",
  },
  {
    key: "value",
    type: PropertyType.INT,
    label: "Value",
    defaultValue: 1,
    description: "Constant value to output",
  },
];

// ---------------------------------------------------------------------------
// ConstDefinition
// ---------------------------------------------------------------------------

function constFactory(props: PropertyBag): ConstElement {
  return new ConstElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ConstDefinition: ComponentDefinition = {
  name: "Const",
  typeId: -1,
  factory: constFactory,
  pinLayout: buildConstPinDeclarations(1),
  propertyDefs: CONST_PROPERTY_DEFS,
  attributeMap: CONST_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "Const — constant value source.\n" +
    "Outputs a fixed value on every simulation step.\n" +
    "Configurable bit width and constant value.",
  models: {
    digital: { executeFn: executeConst, inputSchema: [], outputSchema: ["out"] },
  },
};
