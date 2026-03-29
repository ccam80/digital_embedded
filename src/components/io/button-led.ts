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
} from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import { createButtonLEDAnalogElement } from "../../solver/analog/behavioral-remaining.js";

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

// Java ButtonLEDShape: out(0,0), in(0,SIZE)=(0,1)
function buildButtonLEDPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// ButtonLEDElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ButtonLEDElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("ButtonLED", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildButtonLEDPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    // Drawn geometry: outer polygon x:[-1.9,-0.05], y:[-1.1,0.75]
    // Line (-0.4,0.4)→(-0.1,0.7): inside polygon bounds
    // Circle at cx=-1.15,r=0.5 → x:[-1.65,-0.65], y:[-0.85,0.15]: inside polygon
    return {
      x: this.position.x - 1.9,
      y: this.position.y - 1.1,
      width: 1.85,  // x: -1.9 to -0.05
      height: 1.85, // y: -1.1 to 0.75
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
    ctx.drawPath({
      operations: [
        { op: "moveTo", x: -0.4,  y: -1.05 },
        { op: "lineTo", x: -0.4,  y: 0.4 },
        { op: "lineTo", x: -1.85, y: 0.4 },
      ],
    }, false);

    // Line: (-0.4,0.4) to (-0.1,0.7)
    ctx.drawLine(-0.4, 0.4, -0.1, 0.7);

    // LED circles at (-1.15,-0.35): filled (OTHER(0,true)) then outline (THIN), both r=0.5
    ctx.setColor("WIRE_Z");
    ctx.drawCircle(-1.15, -0.35, 0.5, true);
    ctx.setColor("COMPONENT");
    ctx.drawCircle(-1.15, -0.35, 0.5, false);

    // Text label (always drawn, even if empty — Java always emits text call)
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(label, -2.25, -0.2, {
      horizontal: "right",
      vertical: "middle",
    });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executeButtonLED — reads LED input, stores for display; button output set externally
// ---------------------------------------------------------------------------

export function executeButtonLED(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  // The LED input (index 0) is read for display; no output computed here.
  // The button output (index 1) is set externally via engine.setSignalValue().
  // Copy LED input to output slot so the display can read it.
  const inputIdx = layout.inputOffset(index);
  const outputIdx = layout.outputOffset(index);
  state[wt[outputIdx]] = state[wt[inputIdx]];
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
  pinLayout: buildButtonLEDPinDeclarations(),
  propertyDefs: BUTTON_LED_PROPERTY_DEFS,
  attributeMap: BUTTON_LED_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "ButtonLED — push button with integrated LED indicator.\n" +
    "The 'in' pin drives the LED; the 'out' pin is the button output.\n" +
    "Button behavior: output high while held, low when released (inverted if activeLow).\n" +
    "Interactive: the engine sets the output value on mouse-down/up events.",
  models: {
    digital: { executeFn: executeButtonLED, inputSchema: ["in"], outputSchema: ["out"] },
    mnaModels: {
      behavioral: { factory: createButtonLEDAnalogElement },
    },
  },
  defaultModel: "digital",
};
