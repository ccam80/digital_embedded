/**
 * DipSwitch component — multi-bit toggle switch array.
 *
 * Each bit of the output is independently toggled by the user.
 * The executeFn is a no-op; each bit's value is set externally
 * via engine.setSignalValue() when the user clicks a bit toggle.
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

const BIT_SLOT_WIDTH = 2.9;
const COMP_HEIGHT = 1;

function componentWidth(bitCount: number): number {
  return bitCount * BIT_SLOT_WIDTH;
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

// Java DipSwitchShape: single output pin at (0,0)
function buildDipSwitchPinDeclarations(bitCount: number): PinDeclaration[] {
  return [
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: bitCount,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// DipSwitchElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class DipSwitchElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("DipSwitch", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitCount = this._properties.getOrDefault<number>("bitCount", 1);
    const decls = buildDipSwitchPinDeclarations(bitCount);
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    const bitCount = this._properties.getOrDefault<number>("bitCount", 1);
    // Use integer arithmetic to match Java fixture coordinates exactly.
    // bodyLeft = -(bitCount * 58 + 1) / 20  (avoids -(bitCount*2.9 + 0.05) float error).
    const bodyLeft = -(bitCount * 58 + 1) / 20;
    return {
      x: this.position.x + bodyLeft,
      y: this.position.y - COMP_HEIGHT / 2,
      width: -bodyLeft,
      height: COMP_HEIGHT,
    };
  }

  get bitCount(): number {
    return this._properties.getOrDefault<number>("bitCount", 1);
  }

  get defaultValue(): number {
    return this._properties.getOrDefault<number>("defaultValue", 0);
  }

  draw(ctx: RenderContext): void {
    const bitCount = this._properties.getOrDefault<number>("bitCount", 1);
    const defaultValue = this._properties.getOrDefault<number>("defaultValue", 0);
    const label = this._properties.getOrDefault<string>("label", "");
    const w = componentWidth(bitCount);

    // Java DipSwitchShape: body is LEFT of pin at (0,0).
    // Outer rect: (-0.05, 0.5) → (-w-0.05, 0.5) → (-w-0.05, -0.5) → (-0.05, -0.5)
    // i.e. x from -(w+0.05) to -0.05, y from -0.5 to 0.5 (height=1)
    const bodyRight = -0.05;
    // Compute bodyLeft via integer arithmetic to avoid float error in -(w + 0.05).
    // w = bitCount * 2.9 = bitCount * 58/20, so w+0.05 = (bitCount*58+1)/20.
    const bodyLeft = -(bitCount * 58 + 1) / 20;

    ctx.save();
    // Use drawPolygon with explicit corner coordinates to avoid drawRect float error
    // (bodyLeft + (bodyRight-bodyLeft) != bodyRight due to IEEE 754).
    const outerCorners = [
      { x: bodyLeft, y: -0.5 },
      { x: bodyRight, y: -0.5 },
      { x: bodyRight, y: 0.5 },
      { x: bodyLeft, y: 0.5 },
    ];
    ctx.setColor("COMPONENT_FILL");
    ctx.drawPolygon(outerCorners, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPolygon(outerCorners, false);

    // Switch slider: Java fixture shows (-2.75,0.3) → (-1.5,0.3) → (-1.5,-0.3) → (-2.75,-0.3)
    // Slider width = 1.25, height = 0.6 (y from -0.3 to 0.3)
    // OFF: slider at left end of body (bodyLeft+0.2)
    // ON:  slider at right end of body (bodyRight-0.2-1.25)
    const defaultOn = (defaultValue & 1) === 1;
    const sliderWidth = 1.25;
    const sliderX = defaultOn
      ? bodyRight - 0.2 - sliderWidth   // right position (ON)
      : bodyLeft + 0.2;                  // left position (OFF)

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(sliderX, -0.3, sliderWidth, 0.6, true);
    ctx.setColor("COMPONENT");
    ctx.drawRect(sliderX, -0.3, sliderWidth, 0.6, false);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, (bodyLeft + bodyRight) / 2, -0.8, {
        horizontal: "center",
        vertical: "bottom",
      });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "DipSwitch — multi-bit toggle switch array.\n" +
      "Each bit is independently toggled by clicking the corresponding switch position.\n" +
      "The bitCount property controls how many individual switches are shown.\n" +
      "Interactive: the engine sets each bit's value when the user clicks."
    );
  }
}

// ---------------------------------------------------------------------------
// executeDipSwitch — no-op (value set externally per-bit by engine)
// ---------------------------------------------------------------------------

export function executeDipSwitch(
  _index: number,
  _state: Uint32Array,
  _highZs: Uint32Array,
  _layout: ComponentLayout,
): void {
  // Output value is set externally via engine.setSignalValue() on click events.
}

// ---------------------------------------------------------------------------
// DIP_SWITCH_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const DIP_SWITCH_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "Bits",
    propertyKey: "bitCount",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "Default",
    propertyKey: "defaultValue",
    convert: (v) => parseInt(v, 10),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const DIP_SWITCH_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Label shown above the switch array",
  },
  {
    key: "bitCount",
    type: PropertyType.INT,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Number of individual switches (bits)",
  },
  {
    key: "defaultValue",
    type: PropertyType.INT,
    label: "Default",
    defaultValue: 0,
    description: "Initial bit pattern when simulation starts",
  },
];

// ---------------------------------------------------------------------------
// DipSwitchDefinition
// ---------------------------------------------------------------------------

function dipSwitchFactory(props: PropertyBag): DipSwitchElement {
  return new DipSwitchElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const DipSwitchDefinition: ComponentDefinition = {
  name: "DipSwitch",
  typeId: -1,
  factory: dipSwitchFactory,
  executeFn: executeDipSwitch,
  pinLayout: buildDipSwitchPinDeclarations(1),
  propertyDefs: DIP_SWITCH_PROPERTY_DEFS,
  attributeMap: DIP_SWITCH_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "DipSwitch — multi-bit toggle switch array.\n" +
    "Each bit is independently toggled by clicking the corresponding switch position.\n" +
    "The bitCount property controls how many individual switches are shown.\n" +
    "Interactive: the engine sets each bit's value when the user clicks.",
};
