/**
 * Tunnel component — named wire connection.
 *
 * Two Tunnels with the same label in the same circuit are electrically connected.
 * The net resolver (Phase 3) merges same-name Tunnel nets — no simulation behavior needed.
 * The executeFn is a no-op.
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

const COMP_WIDTH = 3;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin layout — single bidirectional pin on west face
// ---------------------------------------------------------------------------

function buildTunnelPinDeclarations(bitWidth: number): PinDeclaration[] {
  const positions = layoutPinsOnFace("west", 1, COMP_WIDTH, COMP_HEIGHT);
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: bitWidth,
      position: positions[0],
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// TunnelElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class TunnelElement extends AbstractCircuitElement {
  private readonly _label: string;
  private readonly _bitWidth: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Tunnel", instanceId, position, rotation, mirror, props);

    this._label = props.getOrDefault<string>("NetName", "");
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);

    const decls = buildTunnelPinDeclarations(this._bitWidth);
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
      this._bitWidth,
    );
  }

  /** The tunnel net name used by the net resolver to merge same-label tunnels. */
  get netName(): string {
    return this._label;
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

    // Pentagon / flag shape pointing right
    const tipX = COMP_WIDTH;
    const midY = COMP_HEIGHT / 2;
    const arrowDepth = 0.5;

    ctx.setColor("COMPONENT_FILL");
    ctx.drawPolygon(
      [
        { x: 0, y: 0 },
        { x: COMP_WIDTH - arrowDepth, y: 0 },
        { x: tipX, y: midY },
        { x: COMP_WIDTH - arrowDepth, y: COMP_HEIGHT },
        { x: 0, y: COMP_HEIGHT },
      ],
      true,
    );
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPolygon(
      [
        { x: 0, y: 0 },
        { x: COMP_WIDTH - arrowDepth, y: 0 },
        { x: tipX, y: midY },
        { x: COMP_WIDTH - arrowDepth, y: COMP_HEIGHT },
        { x: 0, y: COMP_HEIGHT },
      ],
      false,
    );

    if (this._label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(this._label, (COMP_WIDTH - arrowDepth) / 2, midY, {
        horizontal: "center",
        vertical: "middle",
      });
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
  pinLayout: buildTunnelPinDeclarations(1),
  propertyDefs: TUNNEL_PROPERTY_DEFS,
  attributeMap: TUNNEL_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "Tunnel — named wire connection.\n" +
    "All Tunnels with the same label in a circuit are electrically connected.\n" +
    "The net resolver merges same-label nets during compilation.",
};
