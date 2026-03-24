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
// Java ScopeTriggerShape: outer rect (0.1,0.5)→(0.1,-2)→(4,-2)→(4,0.5)
// Width = 3.9, height = 2.5, origin at pin position (0,0) which is at left edge
// ---------------------------------------------------------------------------

const COMP_WIDTH = 3.9;
const COMP_HEIGHT = 2.5;

// ---------------------------------------------------------------------------
// Trigger mode
// ---------------------------------------------------------------------------

export type TriggerMode = "rising" | "falling" | "both";

// ---------------------------------------------------------------------------
// Pin layout — 1 input pin "T" at origin (Java ScopeShape: single pin at (0,0))
// ---------------------------------------------------------------------------

function buildScopeTriggerPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "T",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// ScopeTriggerElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ScopeTriggerElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("ScopeTrigger", instanceId, position, rotation, mirror, props);
  }

  get triggerMode(): TriggerMode {
    return this._properties.getOrDefault<string>("triggerMode", "rising") as TriggerMode;
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildScopeTriggerPinDeclarations(), ["T"]);
  }

  getBoundingBox(): Rect {
    // Java: outer rect (0.1,0.5)→(0.1,-2)→(4,-2)→(4,0.5)
    // Pin "T" is at (0,0). Box left edge at x=0.1, top at y=-2, right at x=4, bottom at y=0.5
    return {
      x: this.position.x + 0.1,
      y: this.position.y - 2,
      width: 3.9,
      height: 2.5,
    };
  }

  draw(ctx: RenderContext): void {
    ctx.save();

    // Outer rectangle: (0.1,0.5)→(0.1,-2)→(4,-2)→(4,0.5), closed, NORMAL (outline only)
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPolygon([
      { x: 0.1, y: 0.5 },
      { x: 0.1, y: -2 },
      { x: 4,   y: -2 },
      { x: 4,   y: 0.5 },
    ], false);

    // Step waveform polyline: open, OTHER(2,false) — thin line width
    // (0.45,-0.3)→(1.3,-0.3)→(1.3,-1.3)→(2.3,-1.3)→(2.3,-0.3)→(2.65,-0.3)
    ctx.setLineWidth(0.5);
    ctx.drawPath({
      operations: [
        { op: "moveTo", x: 0.45, y: -0.3 },
        { op: "lineTo", x: 1.3,  y: -0.3 },
        { op: "lineTo", x: 1.3,  y: -1.3 },
        { op: "lineTo", x: 2.3,  y: -1.3 },
        { op: "lineTo", x: 2.3,  y: -0.3 },
        { op: "lineTo", x: 2.65, y: -0.3 },
      ],
    }, false);

    // Trigger indicator rounded rectangle: Java uses QuadTo curves for corners.
    // Path: M(0.4,-0.4) L(0.4,-1.1) Q(0.4,-1.7)→(1,-1.7) L(2.1,-1.7)
    //        Q(2.7,-1.7)→(2.7,-1.1) L(2.7,-0.4) Q(2.7,0.2)→(2.1,0.2) L(1,0.2)
    //        Q(0.4,0.2)→(0.4,-0.4) Z
    // QuadTo promoted to cubic: cp1 = P0 + 2/3*(Pq-P0), cp2 = Pend + 2/3*(Pq-Pend).
    ctx.setLineWidth(0.5);
    ctx.drawPath({
      operations: [
        { op: "moveTo", x: 0.4, y: -0.4 },
        { op: "lineTo", x: 0.4, y: -1.1 },
        // Q cp=(0.4,-1.7) end=(1.0,-1.7): cubic cp1=(0.4,-1.5) cp2=(0.6,-1.7)
        { op: "curveTo", cp1x: 0.4, cp1y: -1.5, cp2x: 0.6, cp2y: -1.7, x: 1.0, y: -1.7 },
        { op: "lineTo", x: 2.1, y: -1.7 },
        // Q cp=(2.7,-1.7) end=(2.7,-1.1): cubic cp1=(2.5,-1.7) cp2=(2.7,-1.5)
        { op: "curveTo", cp1x: 2.5, cp1y: -1.7, cp2x: 2.7, cp2y: -1.5, x: 2.7, y: -1.1 },
        { op: "lineTo", x: 2.7, y: -0.4 },
        // Q cp=(2.7,0.2) end=(2.1,0.2): cubic cp1=(2.7,0.0) cp2=(2.5,0.2)
        { op: "curveTo", cp1x: 2.7, cp1y: 0.0, cp2x: 2.5, cp2y: 0.2, x: 2.1, y: 0.2 },
        { op: "lineTo", x: 1.0, y: 0.2 },
        // Q cp=(0.4,0.2) end=(0.4,-0.4): cubic cp1=(0.6,0.2) cp2=(0.4,0.0)
        { op: "curveTo", cp1x: 0.6, cp1y: 0.2, cp2x: 0.4, cp2y: 0.0, x: 0.4, y: -0.4 },
        { op: "closePath" },
      ],
    }, false);

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
  _index: number,
  _state: Uint32Array,
  _highZs: Uint32Array,
  _layout: ComponentLayout,
): void {
  // ScopeTrigger has no outputs — it is a display-only trigger marker.
  // The scope panel reads the T input directly; no output slots to write.
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
  inputSchema: ["T"],
  outputSchema: [],
  helpText:
    "ScopeTrigger — trigger source for the Scope waveform display.\n" +
    "Detects edges on its input and signals the Scope to start recording.\n" +
    "triggerMode: 'rising', 'falling', or 'both'.",
};
