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
const BULB_RADIUS = 0.7;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildLightBulbPinDeclarations(): PinDeclaration[] {
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
// LightBulbElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class LightBulbElement extends AbstractCircuitElement {
  private readonly _label: string;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("LightBulb", instanceId, position, rotation, mirror, props);

    this._label = props.getOrDefault<string>("label", "");

    const decls = buildLightBulbPinDeclarations();
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
      y: this.position.y - COMP_HEIGHT / 2,
      width: COMP_WIDTH,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    const cx = COMP_WIDTH / 2;

    ctx.save();

    // Bulb body
    ctx.setColor("COMPONENT_FILL");
    ctx.drawCircle(cx, 0, BULB_RADIUS, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawCircle(cx, 0, BULB_RADIUS, false);

    // Filament cross lines (incandescent bulb symbol)
    const r = BULB_RADIUS * 0.5;
    ctx.setLineWidth(1);
    ctx.drawLine(cx - r, -r, cx + r, r);
    ctx.drawLine(cx + r, -r, cx - r, r);

    if (this._label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(this._label, cx, -0.3, {
        horizontal: "center",
        vertical: "bottom",
      });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "LightBulb — incandescent bulb indicator.\n" +
      "Rendered as a circle with filament cross. On when input is non-zero.\n" +
      "Label is shown above the component."
    );
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
  executeFn: executeLightBulb,
  pinLayout: buildLightBulbPinDeclarations(),
  propertyDefs: LIGHT_BULB_PROPERTY_DEFS,
  attributeMap: LIGHT_BULB_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "LightBulb — incandescent bulb indicator.\n" +
    "Rendered as a circle with filament cross. On when input is non-zero.\n" +
    "Label is shown above the component.",
};
