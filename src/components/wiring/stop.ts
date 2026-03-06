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
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
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
// Pin layout
// ---------------------------------------------------------------------------

export function buildStopPinDeclarations(): PinDeclaration[] {
  const stopPin: PinDeclaration = {
    direction: PinDirection.INPUT,
    label: "stop",
    defaultBitWidth: 1,
    position: { x: 0, y: Math.floor(COMP_HEIGHT / 2) },
    isNegatable: false,
    isClockCapable: false,
  };

  return [stopPin];
}

// ---------------------------------------------------------------------------
// StopElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class StopElement extends AbstractCircuitElement {
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Stop", instanceId, position, rotation, mirror, props);

    const decls = buildStopPinDeclarations();
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
    );
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
    const { x, y } = this.position;

    ctx.save();
    ctx.translate(x, y);

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.8, weight: "bold" });
    ctx.drawText("STP", COMP_WIDTH / 2, COMP_HEIGHT / 2, {
      horizontal: "center",
      vertical: "middle",
    });

    ctx.restore();
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
  layout: ComponentLayout,
): void {
  const inIdx = layout.inputOffset(index);
  const outIdx = layout.outputOffset(index);
  state[outIdx] = state[inIdx] !== 0 ? 1 : 0;
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
  executeFn: executeStop,
  pinLayout: buildStopPinDeclarations(),
  propertyDefs: STOP_PROPERTY_DEFS,
  attributeMap: STOP_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "Stop — terminates simulation entirely when input goes high.\n" +
    "Unlike Break, Stop closes the model rather than pausing.",
};
