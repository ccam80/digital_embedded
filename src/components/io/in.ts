/**
 * In component — interactive toggle input.
 *
 * The user clicks this component to change its output value.
 * executeFn is an identity pass-through: the signal value is set externally
 * by the engine when the user interacts with it.
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

function buildInPinDeclarations(bitWidth: number): PinDeclaration[] {
  // Pin at (width, 0) — matching Digital's InputShape where pin is at component origin y=0.
  // The body is drawn centered around y=0.
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
// InElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class InElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _label: string;
  private readonly _small: boolean;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("In", instanceId, position, rotation, mirror, props);

    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    this._label = props.getOrDefault<string>("label", "");
    this._small = props.getOrDefault<boolean>("small", true);

    const decls = buildInPinDeclarations(this._bitWidth);
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
      this._bitWidth,
    );
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    const size = this._small ? 1 : COMP_HEIGHT;
    return {
      x: this.position.x,
      y: this.position.y - size / 2,
      width: COMP_WIDTH,
      height: size,
    };
  }

  draw(ctx: RenderContext): void {
    const size = this._small ? 1 : COMP_HEIGHT;
    const yOff = -size / 2;

    ctx.save();

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, yOff, COMP_WIDTH, size, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, yOff, COMP_WIDTH, size, false);

    // Draw label inside the component body (or type name if no label)
    const displayText = this._label.length > 0 ? this._label : "In";
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: size * 0.6 });
    ctx.drawText(displayText, COMP_WIDTH / 2, 0, {
      horizontal: "center",
      vertical: "middle",
    });

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "In — interactive input component.\n" +
      "Click to toggle the output value (1-bit: toggle 0↔1; multi-bit: opens value editor).\n" +
      "The executeFn is a pass-through; the signal value is set externally by user interaction."
    );
  }
}

// ---------------------------------------------------------------------------
// executeIn — pass-through (value is set externally by engine interaction)
// ---------------------------------------------------------------------------

export function executeIn(_index: number, _state: Uint32Array, _highZs: Uint32Array, _layout: ComponentLayout): void {
  // The output value is set externally via engine.setSignalValue().
  // No computation needed here.
}

// ---------------------------------------------------------------------------
// IN_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const IN_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
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
  {
    xmlName: "Default",
    propertyKey: "defaultValue",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "small",
    propertyKey: "small",
    convert: (v) => v === "true",
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const IN_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Label shown on the component",
  },
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of the output signal",
  },
  {
    key: "defaultValue",
    type: PropertyType.INT,
    label: "Default",
    defaultValue: 0,
    description: "Initial value when simulation starts",
  },
  {
    key: "small",
    type: PropertyType.BOOLEAN,
    label: "Small",
    defaultValue: true,
    description: "Use compact rendering size",
  },
];

// ---------------------------------------------------------------------------
// InDefinition
// ---------------------------------------------------------------------------

function inFactory(props: PropertyBag): InElement {
  return new InElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const InDefinition: ComponentDefinition = {
  name: "In",
  typeId: -1,
  factory: inFactory,
  executeFn: executeIn,
  pinLayout: buildInPinDeclarations(1),
  propertyDefs: IN_PROPERTY_DEFS,
  attributeMap: IN_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "In — interactive input component.\n" +
    "Click to toggle the output value (1-bit: toggle 0↔1; multi-bit: opens value editor).\n" +
    "The executeFn is a pass-through; the signal value is set externally by user interaction.",
};
