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
  private readonly _label: string;
  private readonly _activeLow: boolean;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Button", instanceId, position, rotation, mirror, props);

    this._label = props.getOrDefault<string>("label", "");
    this._activeLow = props.getOrDefault<boolean>("activeLow", false);

    const decls = buildButtonPinDeclarations();
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
      1,
    );
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x - COMP_WIDTH,
      y: this.position.y - COMP_HEIGHT / 2,
      width: COMP_WIDTH,
      height: COMP_HEIGHT,
    };
  }

  get activeLow(): boolean {
    return this._activeLow;
  }

  draw(ctx: RenderContext): void {
    const yOff = -COMP_HEIGHT / 2;

    ctx.save();

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(-COMP_WIDTH, yOff, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(-COMP_WIDTH, yOff, COMP_WIDTH, COMP_HEIGHT, false);

    // Draw button symbol: a smaller filled rect indicating a pushbutton
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(-COMP_WIDTH + 0.4, yOff + 0.4, COMP_WIDTH - 0.8, COMP_HEIGHT - 0.8, false);

    if (this._label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(this._label, -COMP_WIDTH / 2, -0.3, {
        horizontal: "center",
        vertical: "bottom",
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
  executeFn: executeButton,
  pinLayout: buildButtonPinDeclarations(),
  propertyDefs: BUTTON_PROPERTY_DEFS,
  attributeMap: BUTTON_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "Button — momentary push button.\n" +
    "Output is high while the button is held down, low when released.\n" +
    "activeLow=true inverts this: output is low while held, high when released.\n" +
    "Interactive: the engine sets the output value on mouse-down/up events.",
};
