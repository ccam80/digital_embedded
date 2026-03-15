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
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("AsyncSeq", instanceId, position, rotation, mirror, props);
  }

  get runAtRealTime(): boolean {
    return this._properties.getOrDefault<boolean>("runAtRealTime", false);
  }

  get frequency(): number {
    return this._properties.getOrDefault<number>("frequency", 1);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildAsyncSeqPinDeclarations());
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x + 0.5,
      y: this.position.y + 0.5,
      width: 4,
      height: 2,
    };
  }

  draw(ctx: RenderContext): void {

    ctx.save();

    // Filled rectangle: (0.5,0.5) → (4.5,2.5) — 4x2 box
    ctx.setColor("COMPONENT_FILL");
    ctx.drawPolygon(
      [
        { x: 0.5, y: 0.5 },
        { x: 4.5, y: 0.5 },
        { x: 4.5, y: 2.5 },
        { x: 0.5, y: 2.5 },
      ],
      true,
    );

    // Outline rectangle: same coords, THIN
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(0.5); // THIN
    ctx.drawPolygon(
      [
        { x: 0.5, y: 0.5 },
        { x: 4.5, y: 0.5 },
        { x: 4.5, y: 2.5 },
        { x: 0.5, y: 2.5 },
      ],
      false,
    );

    // Text "Async" centered at (2.5, 1.5)
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText("Async", 2.5, 1.5, {
      horizontal: "center",
      vertical: "middle",
    });

    // Empty label text at (2.5, 0)
    ctx.drawText("", 2.5, 0, {
      horizontal: "center",
      vertical: "middle",
    });

    ctx.restore();
  }

  getHelpText(): string {
    const runAtRealTime = this._properties.getOrDefault<boolean>("runAtRealTime", false);
    const frequency = this._properties.getOrDefault<number>("frequency", 1);
    return (
      "AsyncSeq — marks circuit as asynchronous sequential.\n" +
      "Propagation is triggered by input changes only (no explicit clock).\n" +
      (runAtRealTime
        ? `Runs at real-time frequency: ${frequency} Hz.`
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
