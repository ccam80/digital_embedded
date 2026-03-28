/**
 * Port component — domain-agnostic subcircuit interface element.
 *
 * Port is neutral infrastructure (like Ground, Tunnel). It carries no
 * simulation model. The compilation pipeline infers domain from what is
 * connected to it, not from the Port itself.
 *
 * Renders as a diamond (◇) with a stub wire and label text.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { drawUprightText } from "../../core/upright-text.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const DIAMOND_HALF = 0.6;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildPortPinDeclarations(bitWidth: number): PinDeclaration[] {
  return [
    {
      direction: PinDirection.BIDIRECTIONAL,
      label: "port",
      defaultBitWidth: bitWidth,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// PortElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class PortElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Port", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const decls = buildPortPinDeclarations(bitWidth);
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - DIAMOND_HALF,
      width: DIAMOND_HALF * 2 + 0.7,
      height: DIAMOND_HALF * 2,
    };
  }

  draw(ctx: RenderContext): void {
    const label = this._visibleLabel();

    ctx.save();
    ctx.setColor("COMPONENT_FILL");
    ctx.drawPolygon([
      { x: 0,             y: 0 },
      { x: DIAMOND_HALF,  y: -DIAMOND_HALF },
      { x: DIAMOND_HALF * 2, y: 0 },
      { x: DIAMOND_HALF,  y: DIAMOND_HALF },
    ], true);

    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPolygon([
      { x: 0,             y: 0 },
      { x: DIAMOND_HALF,  y: -DIAMOND_HALF },
      { x: DIAMOND_HALF * 2, y: 0 },
      { x: DIAMOND_HALF,  y: DIAMOND_HALF },
    ], false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    drawUprightText(ctx, label, DIAMOND_HALF * 2 + 0.35, 0, {
      horizontal: "left",
      vertical: "middle",
    }, this.rotation);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// PORT_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const PORT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "pinFace",
    propertyKey: "face",
    convert: (v) => v,
  },
  {
    xmlName: "pinOrder",
    propertyKey: "sortOrder",
    convert: (v) => parseInt(v, 10),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const PORT_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Pin name on the chip exterior",
  },
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bit Width",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width (only meaningful for digital buses; analog is always 1)",
  },
  {
    key: "face",
    type: PropertyType.ENUM,
    label: "Face",
    defaultValue: "left",
    enumValues: ["left", "right", "top", "bottom"],
    description: "Which chip face this pin appears on",
  },
  {
    key: "sortOrder",
    type: PropertyType.INT,
    label: "Sort Order",
    defaultValue: 0,
    description: "Position within face (0 = topmost/leftmost)",
  },
];

// ---------------------------------------------------------------------------
// PortDefinition
// ---------------------------------------------------------------------------

function portFactory(props: PropertyBag): PortElement {
  return new PortElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const PortDefinition: ComponentDefinition = {
  name: "Port",
  typeId: -1,
  factory: portFactory,
  pinLayout: buildPortPinDeclarations(1),
  propertyDefs: PORT_PROPERTY_DEFS,
  attributeMap: PORT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "Port — domain-agnostic subcircuit interface element.\n" +
    "Bidirectional pin that connects internal circuit nodes to external parent circuit nets.\n" +
    "Neutral infrastructure: no simulation model. Domain is inferred from connected components.",
  models: {},
};
