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
const COMP_HEIGHT = 3;
const LED_RADIUS = 0.7;

// ---------------------------------------------------------------------------
// Pin layout — R, G, B inputs on the west face, evenly spaced
// ---------------------------------------------------------------------------

function buildRgbLedPinDeclarations(): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 3, COMP_WIDTH, COMP_HEIGHT);
  return [
    {
      direction: PinDirection.INPUT,
      label: "R",
      defaultBitWidth: 1,
      position: inputPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "G",
      defaultBitWidth: 1,
      position: inputPositions[1],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "B",
      defaultBitWidth: 1,
      position: inputPositions[2],
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
      y: this.position.y,
      width: COMP_WIDTH,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    const cx = COMP_WIDTH / 2;
    const cy = COMP_HEIGHT / 2;

    ctx.save();

    // Outer circle body
    ctx.setColor("COMPONENT_FILL");
    ctx.drawCircle(cx, cy, LED_RADIUS, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawCircle(cx, cy, LED_RADIUS, false);

    // Three arcs representing R, G, B sectors
    // R: top-right third (0 to 2π/3)
    // G: bottom-right third (2π/3 to 4π/3)
    // B: left third (4π/3 to 2π)
    const TWO_PI = Math.PI * 2;
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawArc(cx, cy, LED_RADIUS * 0.6, 0, TWO_PI / 3);
    ctx.drawArc(cx, cy, LED_RADIUS * 0.6, TWO_PI / 3, (2 * TWO_PI) / 3);
    ctx.drawArc(cx, cy, LED_RADIUS * 0.6, (2 * TWO_PI) / 3, TWO_PI);

    // Channel labels
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.4 });
    ctx.drawText("R", cx + LED_RADIUS * 0.4, cy - LED_RADIUS * 0.4, {
      horizontal: "center",
      vertical: "middle",
    });
    ctx.drawText("G", cx + LED_RADIUS * 0.4, cy + LED_RADIUS * 0.4, {
      horizontal: "center",
      vertical: "middle",
    });
    ctx.drawText("B", cx - LED_RADIUS * 0.5, cy, {
      horizontal: "center",
      vertical: "middle",
    });

    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length > 0) {
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, cx, -0.3, {
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
  executeFn: executeRgbLed,
  pinLayout: buildRgbLedPinDeclarations(),
  propertyDefs: RGB_LED_PROPERTY_DEFS,
  attributeMap: RGB_LED_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "RGBLED — three-color LED with independent R, G, B channel inputs.\n" +
    "Each channel is 1-bit: channel lights when input is non-zero.\n" +
    "All three channels active produces white light.",
};
