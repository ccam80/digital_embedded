/**
 * Break component- monitors input; when input goes high, signals the engine
 * to halt simulation (run-to-break behavior).
 *
 * The executeFn writes a sentinel value to its output slot when the input is
 * high (non-zero). The engine checks this sentinel after each evaluation step
 * and halts if any Break component has triggered.
 *
 * Properties:
 *   - label: break-point label (default "")
 *   - enabled: whether this break-point is active (default true)
 *   - cycles: maximum cycles before triggering regardless (default 0 = unlimited)
 *
 * Pin layout:
 *   0: brk (input, 1-bit)
 * No output pins.
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
  type StandaloneComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

// Circle at (0.85, 0) radius 0.75, pin at (0, 0) on left edge
// X lines: (0.5, 0.35)â†’(1.2, -0.35) and (0.5, -0.35)â†’(1.2, 0.35)
const CIRCLE_CX = 0.85;
const CIRCLE_R = 0.75;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

export function buildBreakPinDeclarations(): PinDeclaration[] {
  const brkPin: PinDeclaration = {
    direction: PinDirection.INPUT,
    label: "brk",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  };

  return [brkPin];
}

// ---------------------------------------------------------------------------
// BreakElement- CircuitElement implementation
// ---------------------------------------------------------------------------

export class BreakElement extends AbstractCircuitElement {

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Break", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildBreakPinDeclarations());
  }

  getBoundingBox(): Rect {
    // Circle at cx=0.85, r=0.75 â†’ x spans [0.1, 1.6]
    return {
      x: this.position.x + CIRCLE_CX - CIRCLE_R,
      y: this.position.y - CIRCLE_R,
      width: CIRCLE_R * 2,
      height: CIRCLE_R * 2,
    };
  }

  draw(ctx: RenderContext): void {
    ctx.save();

    // Circle body
    ctx.setColor("COMPONENT_FILL");
    ctx.drawCircle(CIRCLE_CX, 0, CIRCLE_R, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawCircle(CIRCLE_CX, 0, CIRCLE_R, false);

    // X lines inside circle
    ctx.drawLine(0.5, 0.35, 1.2, -0.35);
    ctx.drawLine(0.5, -0.35, 1.2, 0.35);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executeBreak- flat simulation function
//
// Writes 1 to its output slot when input is high (non-zero).
// The engine polls output slot for any Break components and halts if non-zero.
//
// Pin layout:
//   input 0: brk (1-bit trigger)
//   output 0: triggered flag (1 = halted, 0 = running)
// ---------------------------------------------------------------------------

export function executeBreak(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inIdx = layout.inputOffset(index);
  const outIdx = layout.outputOffset(index);
  state[wt[outIdx]] = state[wt[inIdx]] !== 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// BREAK_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const BREAK_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "enabled",
    propertyKey: "enabled",
    convert: (v) => v === "true",
  },
  {
    xmlName: "Cycles",
    propertyKey: "cycles",
    convert: (v) => parseInt(v, 10),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const BREAK_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Break-point label for identification",
  },
  {
    key: "enabled",
    type: PropertyType.BOOLEAN,
    label: "Enabled",
    defaultValue: true,
    description: "Whether this break-point is active",
  },
  {
    key: "cycles",
    type: PropertyType.INT,
    label: "Cycles",
    defaultValue: 0,
    min: 0,
    description: "Maximum cycles before triggering (0 = unlimited)",
  },
];

// ---------------------------------------------------------------------------
// BreakDefinition
// ---------------------------------------------------------------------------

function breakFactory(props: PropertyBag): BreakElement {
  return new BreakElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const BreakDefinition: StandaloneComponentDefinition = {
  name: "Break",
  typeId: -1,
  factory: breakFactory,
  pinLayout: buildBreakPinDeclarations(),
  propertyDefs: BREAK_PROPERTY_DEFS,
  attributeMap: BREAK_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "Break- halts simulation when input goes high.\n" +
    "Used for run-to-breakpoint debugging.",
  models: {
    digital: {
      executeFn: executeBreak,
      inputSchema: ["brk"],
      outputSchema: [],
    },
  },
  modelRegistry: {},
};
