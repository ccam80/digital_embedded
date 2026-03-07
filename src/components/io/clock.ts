/**
 * Clock component — periodic signal source.
 *
 * The clock value is managed by ClockManager (Phase 3). The executeFn is a
 * no-op: the clock signal value is set by the engine on each tick.
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

const COMP_WIDTH = 2;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildClockPinDeclarations(): PinDeclaration[] {
  const outputPositions = layoutPinsOnFace("east", 1, COMP_WIDTH, COMP_HEIGHT);
  return [
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: 1,
      position: outputPositions[0],
      isNegatable: false,
      isClockCapable: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// ClockElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ClockElement extends AbstractCircuitElement {
  private readonly _label: string;
  private readonly _frequency: number;
  private readonly _runRealTime: boolean;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Clock", instanceId, position, rotation, mirror, props);

    this._label = props.getOrDefault<string>("label", "");
    this._frequency = props.getOrDefault<number>("Frequency", 1);
    this._runRealTime = props.getOrDefault<boolean>("runRealTime", false);

    const decls = buildClockPinDeclarations();
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>(["out"]) },
      1,
    );
  }

  get frequency(): number {
    return this._frequency;
  }

  get runRealTime(): boolean {
    return this._runRealTime;
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

    ctx.save();

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    // Draw clock waveform symbol
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    const mx = COMP_WIDTH / 2;
    const my = COMP_HEIGHT / 2;
    const halfW = 0.6;
    const halfH = 0.4;
    ctx.drawLine(mx - halfW, my + halfH, mx - halfW, my - halfH);
    ctx.drawLine(mx - halfW, my - halfH, mx, my - halfH);
    ctx.drawLine(mx, my - halfH, mx, my + halfH);
    ctx.drawLine(mx, my + halfH, mx + halfW, my + halfH);

    if (this._label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(this._label, COMP_WIDTH / 2, -0.3, {
        horizontal: "center",
        vertical: "bottom",
      });
    }

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
