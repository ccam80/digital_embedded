/**
 * In component- interactive toggle input.
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
} from "../../core/pin.js";
import { drawUprightText } from "../../core/upright-text.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type StandaloneComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildInPinDeclarations(bitWidth: number): PinDeclaration[] {
  // Java InputShape: pin at (0, 0), body extends to -x.
  return [
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: bitWidth,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// InElement- CircuitElement implementation
// ---------------------------------------------------------------------------

export class InElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("In", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const decls = buildInPinDeclarations(bitWidth);
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x - 1.55,
      y: this.position.y - 0.75,
      width: 1.55,
      height: 1.5,
    };
  }

  draw(ctx: RenderContext): void {
    const label = this._visibleLabel();

    ctx.save();

    // Body rectangle: (-1.55,-0.75) â†’ (-0.05,0.75), closed, NORMAL fill then stroke
    ctx.setColor("COMPONENT_FILL");
    ctx.drawPolygon([
      { x: -1.55, y: -0.75 },
      { x: -0.05, y: -0.75 },
      { x: -0.05, y:  0.75 },
      { x: -1.55, y:  0.75 },
    ], true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPolygon([
      { x: -1.55, y: -0.75 },
      { x: -0.05, y: -0.75 },
      { x: -0.05, y:  0.75 },
      { x: -1.55, y:  0.75 },
    ], false);

    // Inner circle at (-0.8, 0) r=0.45
    ctx.drawCircle(-0.8, 0, 0.45, false);

    // Label to the left, right-aligned
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    drawUprightText(ctx, label, -2.25, 0, {
      horizontal: "right",
      vertical: "middle",
    }, this.rotation);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executeIn- pass-through (value is set externally by engine interaction)
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
    structural: true,
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

export const InDefinition: StandaloneComponentDefinition = {
  name: "In",
  typeId: -1,
  factory: inFactory,
  pinLayout: buildInPinDeclarations(1),
  propertyDefs: IN_PROPERTY_DEFS,
  attributeMap: IN_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "In- interactive input component.\n" +
    "Click to toggle the output value (1-bit: toggle 0â†”1; multi-bit: opens value editor).\n" +
    "The executeFn is a pass-through; the signal value is set externally by user interaction.",
  models: {
    digital: { executeFn: executeIn, inputSchema: [], outputSchema: ["out"] },
  },
  modelRegistry: {},
};
