/**
 * LED component — single-color indicator.
 *
 * Circle shape, configurable color, lights up when input is non-zero.
 * 1-bit input: on when input = 1, off when input = 0.
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
const LED_RADIUS = 0.7;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildLedPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// LedElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class LedElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("LED", instanceId, position, rotation, mirror, props);
  }

  get color(): string {
    return this._properties.getOrDefault<string>("color", "red");
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildLedPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    // Circle at cx=0.8 r=0.75: minX = 0.8-0.75, maxX = 0.8+0.75, minY = -0.75, maxY = 0.75.
    // Use cx-r arithmetic to match ellipseSegments cardinal sentinel values exactly.
    const cx = 0.8, r = 0.75;
    return {
      x: this.position.x + (cx - r),
      y: this.position.y - r,
      width: 2 * r,
      height: 2 * r,
    };
  }

  draw(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");

    ctx.save();

    // Outer filled circle (body) at (0.8, 0) r=0.75
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawCircle(0.8, 0, 0.75, true);

    // Inner color zone circle at (0.8, 0) r=0.65 (OTHER/filled)
    ctx.drawCircle(0.8, 0, 0.65, true);

    // Label to the right
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(label, 2.25, 0, {
      horizontal: "left",
      vertical: "middle",
    });

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "LED — single-color light-emitting diode indicator.\n" +
      "Lights up (filled circle) when the input is non-zero.\n" +
      "Color is configurable. Label is shown above the component."
    );
  }
}

// ---------------------------------------------------------------------------
// executeLed — reads input, writes to output slot for display state
// ---------------------------------------------------------------------------

export function executeLed(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inputVal = state[wt[layout.inputOffset(index)]];
  state[wt[layout.outputOffset(index)]] = inputVal !== 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// LED_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const LED_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
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

const LED_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Label shown above the LED",
  },
  {
    key: "color",
    type: PropertyType.COLOR,
    label: "Color",
    defaultValue: "red",
    description: "LED color when lit",
  },
];

// ---------------------------------------------------------------------------
// LedDefinition
// ---------------------------------------------------------------------------

function ledFactory(props: PropertyBag): LedElement {
  return new LedElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const LedDefinition: ComponentDefinition = {
  name: "LED",
  typeId: -1,
  factory: ledFactory,
  executeFn: executeLed,
  pinLayout: buildLedPinDeclarations(),
  propertyDefs: LED_PROPERTY_DEFS,
  attributeMap: LED_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "LED — single-color light-emitting diode indicator.\n" +
    "Lights up (filled circle) when the input is non-zero.\n" +
    "Color is configurable. Label is shown above the component.",
};
