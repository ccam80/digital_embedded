/**
 * Button component — momentary push button.
 *
 * Output is high while held, low when released (or inverted if activeLow=true).
 * Interactive: user holds mouse button down to assert, releases to de-assert.
 * The executeFn is a no-op; the output value is set externally via engine.setSignalValue().
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

const COMP_WIDTH = 2;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildButtonPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// ButtonElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ButtonElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Button", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildButtonPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    // Outer polygon spans x: -1.9 to 0, y: -1.1 to 0.75.
    return {
      x: this.position.x - 1.9,
      y: this.position.y - 1.1,
      width: 1.9,
      height: 1.85,
    };
  }

  get activeLow(): boolean {
    return this._properties.getOrDefault<boolean>("activeLow", false);
  }

  draw(ctx: RenderContext): void {
    const label = this._visibleLabel();

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Outer 3D button polygon (body to left of pin at x=0):
    // (-1.9,-1.1) → (-0.4,-1.1) → (-0.05,-0.75) → (-0.05,0.75) → (-1.55,0.75) → (-1.9,0.4)
    ctx.drawPolygon(
      [
        { x: -1.9, y: -1.1 },
        { x: -0.4, y: -1.1 },
        { x: -0.05, y: -0.75 },
        { x: -0.05, y: 0.75 },
        { x: -1.55, y: 0.75 },
        { x: -1.9, y: 0.4 },
      ],
      true,
    );

    // Inner button face open path: (-0.4,-1.05) → (-0.4,0.4) → (-1.85,0.4)
    ctx.drawLine(-0.4, -1.05, -0.4, 0.4);
    ctx.drawLine(-0.4, 0.4, -1.85, 0.4);

    // Line: (-0.4,0.4) to (-0.1,0.7)
    ctx.drawLine(-0.4, 0.4, -0.1, 0.7);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, -2.25, -0.2, {
        horizontal: "right",
        vertical: "middle",
      });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Button — momentary push button.\n" +
      "Output is high while the button is held down, low when released.\n" +
      "activeLow=true inverts this: output is low while held, high when released.\n" +
      "Interactive: the engine sets the output value on mouse-down/up events."
    );
  }
}

// ---------------------------------------------------------------------------
// executeButton — no-op (value set externally by engine on user interaction)
// ---------------------------------------------------------------------------

export function executeButton(
  _index: number,
  _state: Uint32Array,
  _highZs: Uint32Array,
  _layout: ComponentLayout,
): void {
  // Output value is set externally via engine.setSignalValue() on mouse events.
}

// ---------------------------------------------------------------------------
// BUTTON_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const BUTTON_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "ActiveLow",
    propertyKey: "activeLow",
    convert: (v) => v === "true",
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const BUTTON_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Label shown above the button",
  },
  {
    key: "activeLow",
    type: PropertyType.BOOLEAN,
    label: "Active low",
    defaultValue: false,
    description: "If true, output is low while pressed and high when released",
  },
];

// ---------------------------------------------------------------------------
// ButtonDefinition
// ---------------------------------------------------------------------------

function buttonFactory(props: PropertyBag): ButtonElement {
  return new ButtonElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ButtonDefinition: ComponentDefinition = {
  name: "Button",
  typeId: -1,
  factory: buttonFactory,
  pinLayout: buildButtonPinDeclarations(),
  propertyDefs: BUTTON_PROPERTY_DEFS,
  attributeMap: BUTTON_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "Button — momentary push button.\n" +
    "Output is high while the button is held down, low when released.\n" +
    "activeLow=true inverts this: output is low while held, high when released.\n" +
    "Interactive: the engine sets the output value on mouse-down/up events.",
  models: {
    digital: { executeFn: executeButton, inputSchema: [], outputSchema: ["out"] },
  },
};
