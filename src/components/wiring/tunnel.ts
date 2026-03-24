/**
 * Tunnel component — named wire connection.
 *
 * Two Tunnels with the same label in the same circuit are electrically connected.
 * The net resolver (Phase 3) merges same-name Tunnel nets — no simulation behavior needed.
 * The executeFn is a no-op.
 *
 * Matches Digital's TunnelShape: a small triangle pointing right from the pin
 * at the component origin (0,0), with the label drawn to the right.
 * Total height is ~1 grid unit (0.4 above + 0.4 below center).
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
// Layout constants — matching Digital's TunnelShape
// ---------------------------------------------------------------------------

/** Triangle half-height in grid units (Digital: SIZE2 - 2 = 8px ≈ 0.4 grid). */
const ARROW_HALF_H = 0.4;

/** Triangle width in grid units (Digital: HEIGHT * sqrt(3) ≈ 0.7 grid). */
const ARROW_W = 0.7;


// ---------------------------------------------------------------------------
// Pin layout — single pin at component origin (0,0)
// ---------------------------------------------------------------------------

function buildTunnelPinDeclarations(bitWidth: number): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: bitWidth,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// TunnelElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class TunnelElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Tunnel", instanceId, position, rotation, mirror, props);
  }

  /** The tunnel net name used by the net resolver to merge same-label tunnels. */
  get netName(): string {
    return this._properties.getOrDefault<string>("NetName", "");
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    return this.derivePins(buildTunnelPinDeclarations(bitWidth), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.4,
      width: 1.0,
      height: 0.8,
    };
  }

  draw(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("NetName", "");

    ctx.save();

    // Triangle pointing right from origin, matching Digital's TunnelShape
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPolygon(
      [
        { x: 0, y: 0 },
        { x: ARROW_W, y: ARROW_HALF_H },
        { x: ARROW_W, y: -ARROW_HALF_H },
      ],
      false,
    );

    // Label to the right of the triangle, counter-rotated at 180° to stay upright
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.6 });
      if (this.rotation === 2) {
        ctx.save();
        ctx.translate(ARROW_W + 0.25, 0);
        ctx.rotate(Math.PI);
        ctx.drawText(label, 0, 0, {
          horizontal: "right",
          vertical: "middle",
        });
        ctx.restore();
      } else {
        ctx.drawText(label, ARROW_W + 0.25, 0, {
          horizontal: "left",
          vertical: "middle",
        });
      }
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Tunnel — named wire connection.\n" +
      "All Tunnels with the same label in a circuit are electrically connected.\n" +
      "The net resolver merges same-label nets during compilation."
    );
  }
}

// ---------------------------------------------------------------------------
// executeTunnel — no-op (net merging handled by the compiler/net resolver)
// ---------------------------------------------------------------------------

export function executeTunnel(
  _index: number,
  _state: Uint32Array,
  _highZs: Uint32Array,
  _layout: ComponentLayout,
): void {
  // Net merging is handled at compile time. No runtime behavior needed.
}

// ---------------------------------------------------------------------------
// TUNNEL_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const TUNNEL_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "NetName",
    propertyKey: "NetName",
    convert: (v) => v,
  },
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TUNNEL_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "NetName",
    type: PropertyType.STRING,
    label: "Net Name",
    defaultValue: "",
    description: "Label connecting this Tunnel to other Tunnels with the same name",
  },
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of the tunnel signal",
  },
];

// ---------------------------------------------------------------------------
// TunnelDefinition
// ---------------------------------------------------------------------------

function tunnelFactory(props: PropertyBag): TunnelElement {
  return new TunnelElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const TunnelDefinition: ComponentDefinition = {
  name: "Tunnel",
  typeId: -1,
  factory: tunnelFactory,
  executeFn: executeTunnel,
  engineType: "both",
  pinLayout: buildTunnelPinDeclarations(1),
  propertyDefs: TUNNEL_PROPERTY_DEFS,
  attributeMap: TUNNEL_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "Tunnel — named wire connection.\n" +
    "All Tunnels with the same label in a circuit are electrically connected.\n" +
    "The net resolver merges same-label nets during compilation.",
};
