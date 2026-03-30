/**
 * LightBulb component — incandescent bulb indicator.
 *
 * Rendered as a circle with filament cross lines.
 * Brightness is conceptually proportional to input value; visually it is
 * either off (input=0) or on (input≠0) since the canvas renderer is binary.
 * 1-bit input.
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

const BULB_RADIUS = 0.9;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildLightBulbPinDeclarations(): PinDeclaration[] {
  // Java LightBulbShape: A at (0,0), B at (0,2)
  return [
    {
      direction: PinDirection.INPUT,
      label: "A",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "B",
      defaultBitWidth: 1,
      position: { x: 0, y: 2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// LightBulbElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class LightBulbElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("LightBulb", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildLightBulbPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    // Circle at cx=0, cy=1, r=0.9: minX=-0.9, maxX=0.9, minY=1-0.9, maxY=1+0.9.
    // Use cy-r arithmetic to match ellipseSegments cardinal sentinel values exactly.
    const cy = 1, r = BULB_RADIUS;
    return {
      x: this.position.x - r,
      y: this.position.y + (cy - r),
      width: 2 * r,
      height: 2 * r,
    };
  }

  draw(ctx: RenderContext): void {
    ctx.save();

    // Bulb body — centered between pins A@(0,0) and B@(0,2)
    ctx.setColor("COMPONENT_FILL");
    ctx.drawCircle(0, 1, BULB_RADIUS, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawCircle(0, 1, BULB_RADIUS, false);

    // Diagonal X cross lines inside the bulb
    ctx.drawLine(-0.55, 0.45, 0.55, 1.55);
    ctx.drawLine(-0.55, 1.55, 0.55, 0.45);

    // Label text at right side
    const label = this._visibleLabel();
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, 1.5, 1, {
        horizontal: "left",
        vertical: "middle",
      });
    }

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executeLightBulb — on when input is non-zero
// ---------------------------------------------------------------------------

export function executeLightBulb(
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
// LIGHT_BULB_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const LIGHT_BULB_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const LIGHT_BULB_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Label shown above the light bulb",
  },
];

// ---------------------------------------------------------------------------
// LightBulbDefinition
// ---------------------------------------------------------------------------

function lightBulbFactory(props: PropertyBag): LightBulbElement {
  return new LightBulbElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const LightBulbDefinition: ComponentDefinition = {
  name: "LightBulb",
  typeId: -1,
  factory: lightBulbFactory,
  pinLayout: buildLightBulbPinDeclarations(),
  propertyDefs: LIGHT_BULB_PROPERTY_DEFS,
  attributeMap: LIGHT_BULB_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "LightBulb — incandescent bulb indicator.\n" +
    "Rendered as a circle with filament cross. On when input is non-zero.\n" +
    "Label is shown above the component.",
  models: {
    digital: { executeFn: executeLightBulb, inputSchema: ["A", "B"], outputSchema: [] },
  },
  modelRegistry: {},
};
