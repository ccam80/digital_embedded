/**
 * ButtonLED component — push button with integrated LED indicator.
 *
 * Extends Button with an additional input pin that drives an LED indicator.
 * The button output (out) is set externally by engine on mouse events.
 * The LED (in) input reflects the current LED state from the circuit.
 * executeFn reads the LED input and stores it for display rendering.
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

const COMP_WIDTH = 2;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin layout
// input "in" on west face: LED indicator input
// output "out" on east face: button output
// ---------------------------------------------------------------------------

function buildButtonLEDPinDeclarations(): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 1, COMP_WIDTH, COMP_HEIGHT);
  const outputPositions = layoutPinsOnFace("east", 1, COMP_WIDTH, COMP_HEIGHT);
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: 1,
      position: inputPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: 1,
      position: outputPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// ButtonLEDElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ButtonLEDElement extends AbstractCircuitElement {
  private readonly _label: string;
  private readonly _activeLow: boolean;
  private readonly _color: string;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("ButtonLED", instanceId, position, rotation, mirror, props);

    this._label = props.getOrDefault<string>("label", "");
    this._activeLow = props.getOrDefault<boolean>("activeLow", false);
    this._color = props.getOrDefault<string>("color", "red");

    const decls = buildButtonLEDPinDeclarations();
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
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: COMP_HEIGHT,
    };
  }

  get activeLow(): boolean {
    return this._activeLow;
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

    // Button symbol: inner rect
    ctx.drawRect(0.4, 0.4, COMP_WIDTH - 0.8, COMP_HEIGHT - 0.8, false);

    // LED indicator: small circle in top-right area
    ctx.setColor("LED_OFF");
    ctx.drawCircle(COMP_WIDTH - 0.4, 0.4, 0.25, true);
    ctx.setColor("COMPONENT");
    ctx.drawCircle(COMP_WIDTH - 0.4, 0.4, 0.25, false);

    if (this._label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(this._label, COMP_WIDTH / 2, -0.3, {
        horizontal: "center",
        vertical: "bottom",
      });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "ButtonLED — push button with integrated LED indicator.\n" +
      "The 'in' pin drives the LED; the 'out' pin is the button output.\n" +
      "Button behavior: output high while held, low when released (inverted if activeLow).\n" +
      "Interactive: the engine sets the output value on mouse-down/up events."
    );
  }
}

// ---------------------------------------------------------------------------
// executeButtonLED — reads LED input, stores for display; button output set externally
// ---------------------------------------------------------------------------

export function executeButtonLED(
  index: number,
  state: Uint32Array,
  layout: ComponentLayout,
): void {
  // The LED input (index 0) is read for display; no output computed here.
  // The button output (index 1) is set externally via engine.setSignalValue().
  // Copy LED input to output slot so the display can read it.
  const inputIdx = layout.inputOffset(index);
  const outputIdx = layout.outputOffset(index);
  state[outputIdx] = state[inputIdx];
}

// ---------------------------------------------------------------------------
// BUTTON_LED_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const BUTTON_LED_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
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
  {
    xmlName: "Color",
    propertyKey: "color",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const BUTTON_LED_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Label shown above the component",
  },
  {
    key: "activeLow",
    type: PropertyType.BOOLEAN,
    label: "Active low",
    defaultValue: false,
    description: "If true, button output is low while pressed and high when released",
  },
  {
    key: "color",
    type: PropertyType.COLOR,
    label: "LED color",
    defaultValue: "red",
    description: "Color of the integrated LED indicator",
  },
];

// ---------------------------------------------------------------------------
// ButtonLEDDefinition
// ---------------------------------------------------------------------------

function buttonLEDFactory(props: PropertyBag): ButtonLEDElement {
  return new ButtonLEDElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ButtonLEDDefinition: ComponentDefinition = {
  name: "ButtonLED",
  typeId: -1,
  factory: buttonLEDFactory,
  executeFn: executeButtonLED,
  pinLayout: buildButtonLEDPinDeclarations(),
  propertyDefs: BUTTON_LED_PROPERTY_DEFS,
  attributeMap: BUTTON_LED_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "ButtonLED — push button with integrated LED indicator.\n" +
    "The 'in' pin drives the LED; the 'out' pin is the button output.\n" +
    "Button behavior: output high while held, low when released (inverted if activeLow).\n" +
    "Interactive: the engine sets the output value on mouse-down/up events.",
};
