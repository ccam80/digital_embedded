/**
 * PolarityAwareLED component — LED with anode/cathode orientation.
 *
 * Lights up when anode input is high AND cathode input is low.
 * Considers signal polarity: current flows from anode to cathode.
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
const LED_RADIUS = 0.7;

// ---------------------------------------------------------------------------
// Pin layout — anode on west, cathode on east
// ---------------------------------------------------------------------------

function buildPolarityLedPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "anode",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "cathode",
      defaultBitWidth: 1,
      position: { x: COMP_WIDTH, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// PolarityLedElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class PolarityLedElement extends AbstractCircuitElement {
  private readonly _label: string;
  private readonly _color: string;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PolarityAwareLED", instanceId, position, rotation, mirror, props);

    this._label = props.getOrDefault<string>("label", "");
    this._color = props.getOrDefault<string>("color", "red");

    const decls = buildPolarityLedPinDeclarations();
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
      1,
    );
  }

  get color(): string {
    return this._color;
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

    ctx.setColor("COMPONENT_FILL");
    ctx.drawCircle(cx, 0, LED_RADIUS, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawCircle(cx, 0, LED_RADIUS, false);

    // Draw A/K polarity markers
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.5 });
    ctx.drawText("A", 0.2, 0, { horizontal: "left", vertical: "middle" });
    ctx.drawText("K", COMP_WIDTH - 0.2, 0, { horizontal: "right", vertical: "middle" });

    if (this._label.length > 0) {
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
      "PolarityAwareLED — LED that considers anode/cathode orientation.\n" +
      "Lights up when anode is high AND cathode is low (current flows anode→cathode).\n" +
      "Color is configurable."
    );
  }
}

// ---------------------------------------------------------------------------
// executePolarityLed — anode=1 and cathode=0 → lit
// ---------------------------------------------------------------------------

export function executePolarityLed(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  const anode = state[wt[inputStart]];
  const cathode = state[wt[inputStart + 1]];
  // Lit when anode is high and cathode is low
  state[wt[layout.outputOffset(index)]] = anode !== 0 && cathode === 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// POLARITY_LED_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const POLARITY_LED_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
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

const POLARITY_LED_PROPERTY_DEFS: PropertyDefinition[] = [
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
// PolarityLedDefinition
// ---------------------------------------------------------------------------

function polarityLedFactory(props: PropertyBag): PolarityLedElement {
  return new PolarityLedElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const PolarityLedDefinition: ComponentDefinition = {
  name: "PolarityAwareLED",
  typeId: -1,
  factory: polarityLedFactory,
  executeFn: executePolarityLed,
  pinLayout: buildPolarityLedPinDeclarations(),
  propertyDefs: POLARITY_LED_PROPERTY_DEFS,
  attributeMap: POLARITY_LED_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "PolarityAwareLED — LED that considers anode/cathode orientation.\n" +
    "Lights up when anode is high AND cathode is low (current flows anode→cathode).\n" +
    "Color is configurable.",
};
