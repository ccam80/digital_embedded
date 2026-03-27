/**
 * RGBLED component — three-color LED with independent R, G, B channel inputs.
 *
 * Rendered as a circle divided into three arcs (red/green/blue sectors).
 * Each channel is 1-bit: on when input is non-zero.
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

const LED_OUTER_RADIUS = 0.75;
const LED_INNER_RADIUS = 0.65;

// ---------------------------------------------------------------------------
// Pin layout — R, G, B inputs at Java RGBLEDShape positions: R(0,-1), G(0,0), B(0,1)
// ---------------------------------------------------------------------------

function buildRgbLedPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "R",
      defaultBitWidth: 1,
      position: { x: 0, y: -1 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "G",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "B",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// RgbLedElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class RgbLedElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("RGBLED", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildRgbLedPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 1,
      width: 0.8 + LED_OUTER_RADIUS,
      height: 2,
    };
  }

  draw(ctx: RenderContext): void {
    // LED center at (0.8, 0) — pins R@(0,-1), G@(0,0), B@(0,1)
    const cx = 0.8;
    const cy = 0;

    ctx.save();

    // Lead lines converging to LED center
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawLine(0, -1, cx, cy);
    ctx.drawLine(0, 1, cx, cy);

    // Filled outer circle (LED body)
    ctx.setColor("COMPONENT_FILL");
    ctx.drawCircle(cx, cy, LED_OUTER_RADIUS, true);
    ctx.setColor("COMPONENT");
    ctx.drawCircle(cx, cy, LED_OUTER_RADIUS, false);

    // Inner circle (color zone)
    ctx.drawCircle(cx, cy, LED_INNER_RADIUS, false);

    const label = this._visibleLabel();
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, cx, -1.3, {
        horizontal: "center",
        vertical: "bottom",
      });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "RGBLED — three-color LED with independent R, G, B channel inputs.\n" +
      "Each channel is 1-bit: channel lights when input is non-zero.\n" +
      "All three channels active produces white light."
    );
  }
}

// ---------------------------------------------------------------------------
// executeRgbLed — pack R/G/B channel states into output slot
// ---------------------------------------------------------------------------

export function executeRgbLed(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  const r = state[wt[inputStart]] !== 0 ? 1 : 0;
  const g = state[wt[inputStart + 1]] !== 0 ? 1 : 0;
  const b = state[wt[inputStart + 2]] !== 0 ? 1 : 0;
  // Pack channels into output: bits 2=R, 1=G, 0=B
  state[wt[layout.outputOffset(index)]] = (r << 2) | (g << 1) | b;
}

// ---------------------------------------------------------------------------
// RGB_LED_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const RGB_LED_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const RGB_LED_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Label shown above the RGB LED",
  },
];

// ---------------------------------------------------------------------------
// RgbLedDefinition
// ---------------------------------------------------------------------------

function rgbLedFactory(props: PropertyBag): RgbLedElement {
  return new RgbLedElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const RgbLedDefinition: ComponentDefinition = {
  name: "RGBLED",
  typeId: -1,
  factory: rgbLedFactory,
  pinLayout: buildRgbLedPinDeclarations(),
  propertyDefs: RGB_LED_PROPERTY_DEFS,
  attributeMap: RGB_LED_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "RGBLED — three-color LED with independent R, G, B channel inputs.\n" +
    "Each channel is 1-bit: channel lights when input is non-zero.\n" +
    "All three channels active produces white light.",
  models: {
    digital: { executeFn: executeRgbLed, inputSchema: ["R", "G", "B"], outputSchema: [] },
  },
};
