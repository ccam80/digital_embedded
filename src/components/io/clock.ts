/**
 * Clock component — periodic signal source or manual toggle.
 *
 * When autoRun is true (default), the ClockManager toggles the output
 * automatically at the configured frequency. When autoRun is false, the
 * clock behaves like a manual digital input — user clicks to toggle.
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

const COMP_WIDTH = 2;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildClockPinDeclarations(): PinDeclaration[] {
  // Java ClockShape: pin at (0, 0), body extends to -x.
  return [
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// ClockElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ClockElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Clock", instanceId, position, rotation, mirror, props);
  }

  get frequency(): number {
    return this._properties.getOrDefault<number>("Frequency", 1);
  }

  get autoRun(): boolean {
    return this._properties.getOrDefault<boolean>("autoRun", true);
  }

  get runRealTime(): boolean {
    return this._properties.getOrDefault<boolean>("runRealTime", false);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildClockPinDeclarations(), ["out"]);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x - 1.55,
      y: this.position.y - 0.75,
      width: 1.55,
      height: 1.5,
    };
  }

  draw(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");

    ctx.save();

    // Body rectangle: (-1.55,-0.75) → (-0.05,0.75), closed, NORMAL — same as In
    ctx.setColor("COMPONENT_FILL");
    ctx.drawPolygon([
      { x: -1.55, y: -0.75 },
      { x: -0.05, y: -0.75 },
      { x: -0.05, y:  0.75 },
      { x: -1.55, y:  0.75 },
    ], true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPolygon([
      { x: -1.55, y: -0.75 },
      { x: -0.05, y: -0.75 },
      { x: -0.05, y:  0.75 },
      { x: -1.55, y:  0.75 },
    ], false);

    // Clock waveform (open polyline, THIN): square wave inside the box
    // Points: (-1.25,0.25)→(-1,0.25)→(-1,-0.25)→(-0.75,-0.25)→(-0.75,0.25)→(-0.5,0.25)→(-0.5,-0.25)→(-0.25,-0.25)
    ctx.setLineWidth(0.5);
    const pts = [
      { x: -1.25, y:  0.25 },
      { x: -1.00, y:  0.25 },
      { x: -1.00, y: -0.25 },
      { x: -0.75, y: -0.25 },
      { x: -0.75, y:  0.25 },
      { x: -0.50, y:  0.25 },
      { x: -0.50, y: -0.25 },
      { x: -0.25, y: -0.25 },
    ];
    for (let i = 0; i < pts.length - 1; i++) {
      ctx.drawLine(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    }

    // Label to the left, right-aligned
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(label, -2.25, 0, {
      horizontal: "right",
      vertical: "middle",
    });

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Clock — periodic signal source.\n" +
      "Generates a square wave at the configured frequency.\n" +
      "In real-time mode the frequency corresponds to actual Hz. " +
      "The signal value is managed by ClockManager and set externally."
    );
  }
}

// ---------------------------------------------------------------------------
// executeClock — no-op (clock value managed by ClockManager)
// ---------------------------------------------------------------------------

export function executeClock(_index: number, _state: Uint32Array, _highZs: Uint32Array, _layout: ComponentLayout): void {
  // Clock output is set externally by the engine's ClockManager.
}

// ---------------------------------------------------------------------------
// CLOCK_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const CLOCK_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "Frequency",
    propertyKey: "Frequency",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "autoRun",
    propertyKey: "autoRun",
    convert: (v) => v === "true",
  },
  {
    xmlName: "runRealTime",
    propertyKey: "runRealTime",
    convert: (v) => v === "true",
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const CLOCK_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Label shown on the component",
  },
  {
    key: "Frequency",
    type: PropertyType.INT,
    label: "Frequency",
    defaultValue: 1,
    min: 1,
    description: "Clock frequency (cycles per simulation step, or Hz in real-time mode)",
  },
  {
    key: "autoRun",
    type: PropertyType.BOOLEAN,
    label: "Auto-run",
    defaultValue: true,
    description: "When true, clock toggles automatically at the configured frequency. When false, acts as a manual digital input.",
  },
  {
    key: "runRealTime",
    type: PropertyType.BOOLEAN,
    label: "Real-time",
    defaultValue: false,
    description: "When true, frequency is in Hz and corresponds to wall-clock time",
  },
];

// ---------------------------------------------------------------------------
// ClockDefinition
// ---------------------------------------------------------------------------

function clockFactory(props: PropertyBag): ClockElement {
  return new ClockElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ClockDefinition: ComponentDefinition = {
  name: "Clock",
  typeId: -1,
  factory: clockFactory,
  executeFn: executeClock,
  pinLayout: buildClockPinDeclarations(),
  propertyDefs: CLOCK_PROPERTY_DEFS,
  attributeMap: CLOCK_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "Clock — periodic signal source.\n" +
    "Generates a square wave at the configured frequency.\n" +
    "In real-time mode the frequency corresponds to actual Hz. " +
    "The signal value is managed by ClockManager and set externally.",
};
