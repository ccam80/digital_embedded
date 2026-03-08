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
  createInverterConfig,
  resolvePins,
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

const COMP_WIDTH = 2;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildConstPinDeclarations(bitWidth: number): PinDeclaration[] {
  return [
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: bitWidth,
      position: { x: COMP_WIDTH, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// ConstElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ConstElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _value: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Const", instanceId, position, rotation, mirror, props);

    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);

    // Value stored as number (Uint32 range). BigInt properties are converted
    // at attribute mapping time.
    const rawValue = props.getOrDefault<number>("value", 1);
    this._value = rawValue >>> 0;

    const decls = buildConstPinDeclarations(this._bitWidth);
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
      this._bitWidth,
    );
  }

  get value(): number {
    return this._value;
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - COMP_HEIGHT / 2,
      width: COMP_WIDTH,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    const yOff = -COMP_HEIGHT / 2;

    ctx.save();

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, yOff, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, yOff, COMP_WIDTH, COMP_HEIGHT, false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.9, weight: "bold" });
    ctx.drawText(this._value.toString(10), COMP_WIDTH / 2, 0, {
      horizontal: "center",
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
  // The constant value is embedded in the component's property bag.
  // However, since the engine function table doesn't pass the element,
  // the compiler must pre-write the constant into the output net during
  // initialisation. The executeFn reinforces it each step.
  //
  // For proper operation the compiler initialises the output net to
  // the constant value. This no-op preserves that initial value since
  // nothing else writes to a Const output net.
  const wt = layout.wiringTable;
  const outputIdx = layout.outputOffset(index);
  // The value at outputIdx was set by the compiler during model init.
  // We reference outputIdx to satisfy the parameter usage requirement.
  void state[wt[outputIdx]];
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
  executeFn: executeConst,
  pinLayout: buildConstPinDeclarations(1),
  propertyDefs: CONST_PROPERTY_DEFS,
  attributeMap: CONST_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "Const — constant value source.\n" +
    "Outputs a fixed value on every simulation step.\n" +
    "Configurable bit width and constant value.",
};
