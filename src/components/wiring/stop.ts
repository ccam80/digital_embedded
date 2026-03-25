/**
 * Stop component — like Break but terminates simulation entirely.
 * When input goes high, the engine closes (terminates) the simulation model.
 *
 * Properties:
 *   - label: label for identification (default "")
 *
 * Pin layout:
 *   0: stop (input, 1-bit)
 * No output pins.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import { drawGenericShape } from "../generic-shape.js";
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
// Java Stop uses GenericShape: 1 input (stop), 0 outputs, width=3
// Non-symmetric → offs=0. stop@(0,0)
// → COMP_WIDTH=3, COMP_HEIGHT=1
// ---------------------------------------------------------------------------

const COMP_WIDTH = 3;
const COMP_HEIGHT = 1;

// ---------------------------------------------------------------------------
// Pin layout — Java GenericShape(1 input, 0 outputs, width=3):
//   stop at (0, 0)
// ---------------------------------------------------------------------------

export function buildStopPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "stop",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// StopElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class StopElement extends AbstractCircuitElement {

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Stop", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildStopPinDeclarations());
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x + 0.05,
      y: this.position.y - 0.5,
      width: (COMP_WIDTH - 0.05) - 0.05,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");
    drawGenericShape(ctx, {
      inputLabels: ["stop"],
      outputLabels: [],
      clockInputIndices: [],
      componentName: "Stop",
      width: COMP_WIDTH,
      ...(label.length > 0 ? { label } : {}),
    });
  }

  getHelpText(): string {
    return (
      "Stop — terminates simulation when input goes high.\n" +
      "Unlike Break, Stop closes the model entirely rather than just pausing."
    );
  }
}

// ---------------------------------------------------------------------------
// executeStop — flat simulation function
//
// Writes 1 to output slot when input is high. Engine polls this and
// terminates the simulation model when non-zero.
//
// Pin layout:
//   input 0: stop (1-bit trigger)
//   output 0: terminate flag
// ---------------------------------------------------------------------------

export function executeStop(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  // Stop has no output pins declared, but the engine allocates an internal
  // output slot used to signal termination. Write 1 when input is non-zero.
  const wt = layout.wiringTable;
  const inIdx = layout.inputOffset(index);
  const outIdx = layout.outputOffset(index);
  state[wt[outIdx]] = state[wt[inIdx]] !== 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// STOP_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const STOP_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const STOP_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label for identification",
  },
];

// ---------------------------------------------------------------------------
// StopDefinition
// ---------------------------------------------------------------------------

function stopFactory(props: PropertyBag): StopElement {
  return new StopElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const StopDefinition: ComponentDefinition = {
  name: "Stop",
  typeId: -1,
  factory: stopFactory,
  pinLayout: buildStopPinDeclarations(),
  propertyDefs: STOP_PROPERTY_DEFS,
  attributeMap: STOP_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "Stop — terminates simulation entirely when input goes high.\n" +
    "Unlike Break, Stop closes the model rather than pausing.",
  models: {
    digital: {
      executeFn: executeStop,
      inputSchema: ["stop"],
      outputSchema: [],
    },
  },
};
