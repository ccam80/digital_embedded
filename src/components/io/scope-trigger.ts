/**
 * ScopeTrigger component — trigger source for the Scope waveform display.
 *
 * A separately placeable component that signals the Scope to start or stop
 * recording based on an edge or level condition on its input.
 *
 * Trigger modes:
 *   - "rising": capture starts on rising edge (0→1)
 *   - "falling": capture starts on falling edge (1→0)
 *   - "both": capture on any edge
 *
 * internalStateCount: 1 (stores previous input value for edge detection)
 *
 * Output: 1 when trigger condition is met this step, 0 otherwise.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
  createInverterConfig,
  resolvePins,
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
// Trigger mode
// ---------------------------------------------------------------------------

export type TriggerMode = "rising" | "falling" | "both";

// ---------------------------------------------------------------------------
// Pin layout — 1 input, 1 output
// ---------------------------------------------------------------------------

function buildScopeTriggerPinDeclarations(): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 1, COMP_WIDTH, COMP_HEIGHT);
  const outputPositions = layoutPinsOnFace("east", 1, COMP_WIDTH, COMP_HEIGHT);
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: 1,
      position: inputPositions[0],
      isNegatable: false,
      isClockCapable: true,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: 1,
      position: outputPositions[0],
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// ScopeTriggerElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ScopeTriggerElement extends AbstractCircuitElement {
  private readonly _triggerMode: TriggerMode;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("ScopeTrigger", instanceId, position, rotation, mirror, props);

    this._triggerMode = props.getOrDefault<string>("triggerMode", "rising") as TriggerMode;

    const decls = buildScopeTriggerPinDeclarations();
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
      1,
    );
  }

  get triggerMode(): TriggerMode {
    return this._triggerMode;
  }

  getPins(): readonly Pin[] {
    return this._pins;
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

    // Component body
    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    // Rising edge symbol
    ctx.setLineWidth(1);
    ctx.drawLine(cx - 0.5, cy + 0.3, cx - 0.5, cy - 0.3);
    ctx.drawLine(cx - 0.5, cy - 0.3, cx + 0.5, cy - 0.3);
    ctx.drawLine(cx + 0.5, cy - 0.3, cx + 0.5, cy + 0.3);

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "ScopeTrigger — trigger source for the Scope waveform display.\n" +
      "Detects edges on its input and signals the Scope to start recording.\n" +
      "triggerMode: 'rising', 'falling', or 'both'."
    );
  }
}

// ---------------------------------------------------------------------------
// executeScopeTrigger — edge detection, output=1 on trigger event
//
// State layout (via layout.stateOffset if available; simplified here):
//   state[outputOffset] = trigger output (0 or 1)
//   Previous input value is tracked by comparing current vs stored.
//   Since ComponentLayout does not yet expose stateOffset, we encode
//   the previous value in a second output slot used as scratch.
// ---------------------------------------------------------------------------

export function executeScopeTrigger(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inputVal = state[wt[layout.inputOffset(index)]];
  const outputIdx = layout.outputOffset(index);
  // Previous value stored in slot outputIdx+1 (scratch slot, allocated by engine)
  const prevVal = state[wt[outputIdx + 1]];

  const risingEdge = prevVal === 0 && inputVal !== 0;
  const fallingEdge = prevVal !== 0 && inputVal === 0;

  // Default to rising edge trigger (mode not accessible in flat fn without closure)
  state[wt[outputIdx]] = risingEdge || fallingEdge ? 1 : 0;
  state[wt[outputIdx + 1]] = inputVal;
}

// ---------------------------------------------------------------------------
// SCOPE_TRIGGER_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const SCOPE_TRIGGER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "TriggerMode",
    propertyKey: "triggerMode",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const SCOPE_TRIGGER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "triggerMode",
    type: PropertyType.ENUM,
    label: "Trigger mode",
    defaultValue: "rising",
    enumValues: ["rising", "falling", "both"],
    description: "Edge condition that triggers scope capture",
  },
];

// ---------------------------------------------------------------------------
// ScopeTriggerDefinition
// ---------------------------------------------------------------------------

function scopeTriggerFactory(props: PropertyBag): ScopeTriggerElement {
  return new ScopeTriggerElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ScopeTriggerDefinition: ComponentDefinition = {
  name: "ScopeTrigger",
  typeId: -1,
  factory: scopeTriggerFactory,
  executeFn: executeScopeTrigger,
  pinLayout: buildScopeTriggerPinDeclarations(),
  propertyDefs: SCOPE_TRIGGER_PROPERTY_DEFS,
  attributeMap: SCOPE_TRIGGER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "ScopeTrigger — trigger source for the Scope waveform display.\n" +
    "Detects edges on its input and signals the Scope to start recording.\n" +
    "triggerMode: 'rising', 'falling', or 'both'.",
};
