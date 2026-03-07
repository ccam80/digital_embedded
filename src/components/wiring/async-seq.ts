/**
 * AsyncSeq component — marks circuit as asynchronous sequential.
 * Propagation is triggered by input changes only (no explicit clock).
 *
 * This is a marker component with no simulation behavior. Its presence
 * in a circuit tells the engine to use asynchronous propagation mode.
 * Optionally, a real-time frequency can be configured for timed simulation.
 *
 * No input or output pins. No executeFn behavior needed — the engine
 * detects this component's presence during compilation.
 *
 * Properties:
 *   - runAtRealTime: run at real-time frequency (default false)
 *   - frequency: real-time frequency in Hz (default 1)
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
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

const COMP_WIDTH = 3;
const COMP_HEIGHT = 3;

// ---------------------------------------------------------------------------
// Pin layout — no pins
// ---------------------------------------------------------------------------

export function buildAsyncSeqPinDeclarations(): PinDeclaration[] {
  return [];
}

// ---------------------------------------------------------------------------
// AsyncSeqElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class AsyncSeqElement extends AbstractCircuitElement {
  private readonly _runAtRealTime: boolean;
  private readonly _frequency: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("AsyncSeq", instanceId, position, rotation, mirror, props);

    this._runAtRealTime = props.getOrDefault<boolean>("runAtRealTime", false);
    this._frequency = props.getOrDefault<number>("frequency", 1);

    const decls = buildAsyncSeqPinDeclarations();
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
    );
  }

  get runAtRealTime(): boolean {
    return this._runAtRealTime;
  }

  get frequency(): number {
    return this._frequency;
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

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7, weight: "bold" });
    ctx.drawText("AS", COMP_WIDTH / 2, COMP_HEIGHT / 2, {
      horizontal: "center",
      vertical: "middle",
    });

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "AsyncSeq — marks circuit as asynchronous sequential.\n" +
      "Propagation is triggered by input changes only (no explicit clock).\n" +
      (this._runAtRealTime
        ? `Runs at real-time frequency: ${this._frequency} Hz.`
        : "Level-by-level (event-driven) propagation mode.")
    );
  }
}

// ---------------------------------------------------------------------------
// executeAsyncSeq — flat simulation function (no-op marker)
//
// AsyncSeq has no inputs or outputs. Its simulation behavior is solely
// conveyed by its presence to the compiler/engine during compilation.
// ---------------------------------------------------------------------------

export function executeAsyncSeq(
  _index: number,
  _state: Uint32Array,
  _highZs: Uint32Array,
  _layout: ComponentLayout,
): void {
  // No-op: marker component. The engine uses its presence to set async mode.
}

// ---------------------------------------------------------------------------
// ASYNC_SEQ_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const ASYNC_SEQ_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "runRealTime",
    propertyKey: "runAtRealTime",
    convert: (v) => v === "true",
  },
  {
    xmlName: "Frequency",
    propertyKey: "frequency",
    convert: (v) => parseInt(v, 10),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const ASYNC_SEQ_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "runAtRealTime",
    type: PropertyType.BOOLEAN,
    label: "Run at Real Time",
    defaultValue: false,
    description: "Run simulation at configured real-time frequency",
  },
  {
    key: "frequency",
    type: PropertyType.INT,
    label: "Frequency (Hz)",
    defaultValue: 1,
    min: 1,
    description: "Real-time simulation frequency in Hz",
  },
];

// ---------------------------------------------------------------------------
// AsyncSeqDefinition
// ---------------------------------------------------------------------------

function asyncSeqFactory(props: PropertyBag): AsyncSeqElement {
  return new AsyncSeqElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const AsyncSeqDefinition: ComponentDefinition = {
  name: "AsyncSeq",
  typeId: -1,
  factory: asyncSeqFactory,
  executeFn: executeAsyncSeq,
  pinLayout: buildAsyncSeqPinDeclarations(),
  propertyDefs: ASYNC_SEQ_PROPERTY_DEFS,
  attributeMap: ASYNC_SEQ_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "AsyncSeq — marks circuit as asynchronous sequential (no explicit clock).\n" +
    "Propagation triggered by input changes only.",
};
