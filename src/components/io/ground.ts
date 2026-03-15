/**
 * Ground component — always outputs 0.
 *
 * executeFn writes 0 to its output on every simulation step.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
} from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
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

function buildGroundPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// GroundElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class GroundElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Ground", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildGroundPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    // draw() renders a single horizontal line at y=0 from x=-0.5 to x=0.5.
    // tsBounds.minY=0 so bbox must not start above y=0; starting at y=-0.5
    // caused overflow = tsBounds.minY - by0 = 0 - (-0.5) = 0.5.
    return {
      x: this.position.x - 0.5,
      y: this.position.y,
      width: 1,
      height: 0.5,
    };
  }

  draw(ctx: RenderContext): void {
    ctx.save();

    ctx.setColor("COMPONENT");
    ctx.setLineWidth(3);
    // Single thick horizontal bar through the pin at origin
    ctx.drawLine(-0.5, 0, 0.5, 0);

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Ground — always outputs logic 0.\n" +
      "Connects the net to ground (0 V) in the simulation."
    );
  }
}

// ---------------------------------------------------------------------------
// executeGround — always writes 0 to output
// ---------------------------------------------------------------------------

export function executeGround(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  state[wt[layout.outputOffset(index)]] = 0;
}

// ---------------------------------------------------------------------------
// GROUND_ATTRIBUTE_MAPPINGS — Ground has no configurable attributes
// ---------------------------------------------------------------------------

export const GROUND_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [];

// ---------------------------------------------------------------------------
// Property definitions — none
// ---------------------------------------------------------------------------

const GROUND_PROPERTY_DEFS: PropertyDefinition[] = [];

// ---------------------------------------------------------------------------
// GroundDefinition
// ---------------------------------------------------------------------------

function groundFactory(props: PropertyBag): GroundElement {
  return new GroundElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const GroundDefinition: ComponentDefinition = {
  name: "Ground",
  typeId: -1,
  factory: groundFactory,
  executeFn: executeGround,
  pinLayout: buildGroundPinDeclarations(),
  propertyDefs: GROUND_PROPERTY_DEFS,
  attributeMap: GROUND_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "Ground — always outputs logic 0.\n" +
    "Connects the net to ground (0 V) in the simulation.",
};
