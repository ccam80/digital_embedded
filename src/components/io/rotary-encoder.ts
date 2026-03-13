/**
 * RotEncoder component — rotary encoder with quadrature output.
 *
 * Interactive component: user rotates the encoder (CW or CCW) via
 * clicks on the component. Each detent step produces a quadrature
 * pulse sequence on outputs A and B.
 *
 * Quadrature encoding (standard Gray code):
 *   Position 0: A=0, B=0
 *   Position 1: A=1, B=0
 *   Position 2: A=1, B=1
 *   Position 3: A=0, B=1
 *   (then wraps back to 0)
 *
 * The encoder has no simulation executeFn beyond producing the
 * current quadrature state from an internal position counter.
 * internalStateCount: 1 (current position 0–3)
 *
 * Output A = bit 1 of Gray(position), Output B = bit 0 of Gray(position).
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

const COMP_WIDTH = 3;
const COMP_HEIGHT = 3;

// ---------------------------------------------------------------------------
// Quadrature table: position (0-3) → [A, B]
// ---------------------------------------------------------------------------

export const QUADRATURE_TABLE: readonly [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

// ---------------------------------------------------------------------------
// Pin layout — outputs A and B on east face
// ---------------------------------------------------------------------------

function buildRotaryEncoderPinDeclarations(): PinDeclaration[] {
  const outputPositions = layoutPinsOnFace("east", 2, COMP_WIDTH, COMP_HEIGHT);
  return [
    {
      direction: PinDirection.OUTPUT,
      label: "A",
      defaultBitWidth: 1,
      position: outputPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "B",
      defaultBitWidth: 1,
      position: outputPositions[1],
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// RotaryEncoderElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class RotaryEncoderElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("RotEncoder", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildRotaryEncoderPinDeclarations(), []);
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

    // Component body — circle representing the encoder knob
    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    // Encoder knob circle
    ctx.drawCircle(cx, cy, 0.8, false);

    // Direction arrow indicator
    ctx.setLineWidth(1);
    ctx.drawLine(cx, cy - 0.4, cx + 0.3, cy);
    ctx.drawLine(cx, cy - 0.4, cx - 0.3, cy);

    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length > 0) {
      ctx.setColor("TEXT");
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
      "RotEncoder — rotary encoder with quadrature output.\n" +
      "Outputs A and B follow a Gray-code quadrature sequence.\n" +
      "Interactive: user rotates the encoder by clicking CW or CCW."
    );
  }
}

// ---------------------------------------------------------------------------
// executeRotaryEncoder — output A and B based on internal position state
//
// State layout: state[outputOffset] = A, state[outputOffset+1] = B
// Internal position is stored at state[outputOffset+2] (scratch slot).
// The engine increments/decrements this on user interaction.
// Here we just read the position and produce the quadrature outputs.
// ---------------------------------------------------------------------------

export function executeRotaryEncoder(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const outputStart = layout.outputOffset(index);
  // Position stored in scratch slot (outputStart + 2)
  const position = state[wt[outputStart + 2]] & 3;
  const [a, b] = QUADRATURE_TABLE[position];
  state[wt[outputStart]] = a;
  state[wt[outputStart + 1]] = b;
}

// ---------------------------------------------------------------------------
// ROTARY_ENCODER_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const ROTARY_ENCODER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const ROTARY_ENCODER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Label shown above the encoder",
  },
];

// ---------------------------------------------------------------------------
// RotaryEncoderDefinition
// ---------------------------------------------------------------------------

function rotaryEncoderFactory(props: PropertyBag): RotaryEncoderElement {
  return new RotaryEncoderElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const RotaryEncoderDefinition: ComponentDefinition = {
  name: "RotEncoder",
  typeId: -1,
  factory: rotaryEncoderFactory,
  executeFn: executeRotaryEncoder,
  pinLayout: buildRotaryEncoderPinDeclarations(),
  propertyDefs: ROTARY_ENCODER_PROPERTY_DEFS,
  attributeMap: ROTARY_ENCODER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "RotEncoder — rotary encoder with quadrature output.\n" +
    "Outputs A and B follow a Gray-code quadrature sequence.\n" +
    "Interactive: user rotates the encoder by clicking CW or CCW.",
};
