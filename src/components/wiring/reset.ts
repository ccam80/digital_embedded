/**
 * Reset component — during initialization, output is held low (or high if inverted).
 * After init, output transitions to its post-reset state.
 *
 * Based on Digital's Java implementation: the Reset element has one output pin.
 * During the init phase, it holds the output in the reset state. After init,
 * the engine calls clearReset() and the output transitions.
 *
 * internalStateCount: 1 (init flag — 0 = in init phase, 1 = init complete)
 *
 * Properties:
 *   - invertOutput: invert the output polarity (default false)
 *   - label: label for identification (default "")
 *
 * Pin layout:
 *   0: Reset (output, 1-bit)
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

// Body: rect from (-2.55, -0.75) to (-1.05, 0.75) — 1.5 wide, 1.5 tall
// Inversion bubble: circle at (-0.5, 0) r=0.45
// Pin at (0, 0) on the right edge
const BODY_X1 = -2.55;
const BODY_Y1 = -0.75;
const BODY_X2 = -1.05;
const BODY_Y2 = 0.75;
const BODY_W = BODY_X2 - BODY_X1; // 1.5
const BODY_H = BODY_Y2 - BODY_Y1; // 1.5
const BUBBLE_CX = -0.5;
const BUBBLE_R = 0.45;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

export function buildResetPinDeclarations(): PinDeclaration[] {
  const resetPin: PinDeclaration = {
    direction: PinDirection.OUTPUT,
    label: "Reset",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  };

  return [resetPin];
}

// ---------------------------------------------------------------------------
// ResetElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ResetElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Reset", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildResetPinDeclarations());
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x + BODY_X1,
      y: this.position.y + BODY_Y1,
      width: -BODY_X1, // from BODY_X1 to pin at 0
      height: BODY_H,
    };
  }

  draw(ctx: RenderContext): void {
    ctx.save();

    // Body rectangle to the left of pin
    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(BODY_X1, BODY_Y1, BODY_W, BODY_H, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(BODY_X1, BODY_Y1, BODY_W, BODY_H, false);

    // "R" text centered in body
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.8, weight: "bold" });
    const bodyCx = BODY_X1 + BODY_W / 2;
    const bodyCy = (BODY_Y1 + BODY_Y2) / 2;
    ctx.drawText("R", bodyCx, bodyCy, {
      horizontal: "center",
      vertical: "middle",
    });

    // Inversion bubble between body and pin
    ctx.setColor("COMPONENT");
    ctx.drawCircle(BUBBLE_CX, 0, BUBBLE_R, false);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executeReset — flat simulation function
//
// Uses internal state slot 0 as the init flag.
//   state[stateOffset+0] = 0: in init phase, output = !invertOutput (reset active)
//   state[stateOffset+0] = 1: init complete, output = invertOutput (reset released)
//
// The engine sets state[stateOffset+0] = 1 after the init phase completes.
//
// For this flat function, we read the output polarity from the output slot
// directly. The engine initialises the output to the reset value before
// simulation starts.
//
// Pin layout:
//   No inputs
//   output 0: Reset signal
// ---------------------------------------------------------------------------

export function executeReset(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  // Reset is a source component: its output is managed by the engine's
  // init/clear-reset protocol. The executeFn is a no-op — the engine
  // writes the output directly via the init sequence.
  // This satisfies the interface requirement while the engine handles
  // the actual reset/release logic.
  const outIdx = layout.outputOffset(index);
  // Preserve whatever value the engine has written — do not overwrite.
  void state[outIdx];
}

// ---------------------------------------------------------------------------
// RESET_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const RESET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "invertOutput",
    propertyKey: "invertOutput",
    convert: (v) => v === "true",
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const RESET_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "invertOutput",
    type: PropertyType.BOOLEAN,
    label: "Invert Output",
    defaultValue: false,
    description: "Invert the output polarity (active-low reset)",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label for identification",
  },
];

// ---------------------------------------------------------------------------
// ResetDefinition
// ---------------------------------------------------------------------------

function resetFactory(props: PropertyBag): ResetElement {
  return new ResetElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ResetDefinition: ComponentDefinition = {
  name: "Reset",
  typeId: -1,
  factory: resetFactory,
  pinLayout: buildResetPinDeclarations(),
  propertyDefs: RESET_PROPERTY_DEFS,
  attributeMap: RESET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "Reset — output held in reset state during init, then released.\n" +
    "Used to reset sequential circuits to a known state at startup.",
  models: {
    digital: {
      executeFn: executeReset,
      inputSchema: [],
      outputSchema: ["Reset"],
    },
  },
};
