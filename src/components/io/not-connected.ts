/**
 * NotConnected component — marks an intentionally unconnected pin.
 *
 * Suppresses the "unconnected pin" warning from the compiler/net resolver.
 * Has no simulation behavior — no executeFn logic needed.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
  layoutPinsOnFace,
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

const COMP_WIDTH = 1;
const COMP_HEIGHT = 1;

// ---------------------------------------------------------------------------
// Pin layout — single bidirectional pin at the connection point
// ---------------------------------------------------------------------------

function buildNotConnectedPinDeclarations(): PinDeclaration[] {
  const positions = layoutPinsOnFace("west", 1, COMP_WIDTH, COMP_HEIGHT);
  return [
    {
      direction: PinDirection.INPUT,
      label: "nc",
      defaultBitWidth: 1,
      position: positions[0],
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// NotConnectedElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class NotConnectedElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("NotConnected", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildNotConnectedPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x - 0.3,
      y: this.position.y - 0.3,
      width: 0.6,
      height: 0.6,
    };
  }

  draw(ctx: RenderContext): void {
    ctx.save();

    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Java NotConnectedShape: X cross through pin at (0,0)
    // Lines: (-0.3,-0.3) -> (0.3,0.3) and (-0.3,0.3) -> (0.3,-0.3)
    ctx.drawLine(-0.3, -0.3, 0.3, 0.3);
    ctx.drawLine(-0.3,  0.3, 0.3, -0.3);

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "NotConnected — marks an intentionally unconnected pin.\n" +
      "Attach this to a pin to suppress the unconnected-pin warning.\n" +
      "Has no simulation behavior."
    );
  }
}

// ---------------------------------------------------------------------------
// executeNotConnected — no-op (suppresses warning only)
// ---------------------------------------------------------------------------

export function executeNotConnected(
  _index: number,
  _state: Uint32Array,
  _highZs: Uint32Array,
  _layout: ComponentLayout,
): void {
  // No simulation behavior. The compiler uses this component to suppress
  // the unconnected-pin warning during net resolution.
}

// ---------------------------------------------------------------------------
// NOT_CONNECTED_ATTRIBUTE_MAPPINGS — no configurable attributes
// ---------------------------------------------------------------------------

export const NOT_CONNECTED_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [];

// ---------------------------------------------------------------------------
// Property definitions — none
// ---------------------------------------------------------------------------

const NOT_CONNECTED_PROPERTY_DEFS: PropertyDefinition[] = [];

// ---------------------------------------------------------------------------
// NotConnectedDefinition
// ---------------------------------------------------------------------------

function notConnectedFactory(props: PropertyBag): NotConnectedElement {
  return new NotConnectedElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const NotConnectedDefinition: ComponentDefinition = {
  name: "NotConnected",
  typeId: -1,
  factory: notConnectedFactory,
  executeFn: executeNotConnected,
  pinLayout: buildNotConnectedPinDeclarations(),
  propertyDefs: NOT_CONNECTED_PROPERTY_DEFS,
  attributeMap: NOT_CONNECTED_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  inputSchema: ["nc"],
  outputSchema: [],
  helpText:
    "NotConnected — marks an intentionally unconnected pin.\n" +
    "Attach this to a pin to suppress the unconnected-pin warning.\n" +
    "Has no simulation behavior.",
};
