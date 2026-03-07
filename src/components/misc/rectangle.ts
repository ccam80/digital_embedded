/**
 * Rectangle annotation component — visual grouping box on the canvas.
 *
 * Rectangle has no simulation behavior: no pins, no executeFn state changes.
 * The executeFn is a no-op. Rectangle is purely a visual annotation for
 * grouping related circuit sections with an optional label.
 *
 * Properties:
 *   - label: string — optional label displayed inside or above the rectangle
 *   - rectWidth: number — width in grid units (default 6)
 *   - rectHeight: number — height in grid units (default 4)
 *   - lineWidth: number — border line width (default 1)
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, Rotation } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Layout defaults
// ---------------------------------------------------------------------------

const DEFAULT_WIDTH = 6;
const DEFAULT_HEIGHT = 4;

// ---------------------------------------------------------------------------
// RectangleElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class RectangleElement extends AbstractCircuitElement {
  private readonly _label: string;
  private readonly _rectWidth: number;
  private readonly _rectHeight: number;
  private readonly _lineWidth: number;

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Rectangle", instanceId, position, rotation, mirror, props);

    this._label = props.getOrDefault<string>("label", "");
    this._rectWidth = props.getOrDefault<number>("rectWidth", DEFAULT_WIDTH);
    this._rectHeight = props.getOrDefault<number>("rectHeight", DEFAULT_HEIGHT);
    this._lineWidth = props.getOrDefault<number>("lineWidth", 1);
  }

  getPins(): readonly Pin[] {
    return [];
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y,
      width: this._rectWidth,
      height: this._rectHeight,
    };
  }

  draw(ctx: RenderContext): void {

    ctx.save();

    ctx.setColor("COMPONENT");
    ctx.setLineWidth(this._lineWidth);
    ctx.drawRect(0, 0, this._rectWidth, this._rectHeight, false);

    if (this._label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 1.0 });
      ctx.drawText(this._label, this._rectWidth / 2, -0.5, {
        horizontal: "center",
        vertical: "bottom",
      });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Rectangle — visual grouping box on the canvas.\n" +
      "No simulation behavior. Used to group related circuit sections.\n" +
      "label: optional label displayed above the rectangle.\n" +
      "rectWidth/rectHeight: dimensions in grid units.\n" +
      "lineWidth: border thickness."
    );
  }
}

// ---------------------------------------------------------------------------
// executeRectangle — no-op (Rectangle has no simulation behavior)
// ---------------------------------------------------------------------------

export function executeRectangle(
  _index: number,
  _state: Uint32Array,
  _highZs: Uint32Array,
  _layout: ComponentLayout,
): void {
  // No simulation behavior.
}

// ---------------------------------------------------------------------------
// RECTANGLE_ATTRIBUTE_MAPPINGS — .dig XML attribute → PropertyBag conversions
// ---------------------------------------------------------------------------

export const RECTANGLE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "rectWidth",
    propertyKey: "rectWidth",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "rectHeight",
    propertyKey: "rectHeight",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "lineWidth",
    propertyKey: "lineWidth",
    convert: (v) => parseInt(v, 10),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const RECTANGLE_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label displayed above the rectangle",
  },
  {
    key: "rectWidth",
    type: PropertyType.INT,
    label: "Width",
    defaultValue: DEFAULT_WIDTH,
    min: 1,
    max: 200,
    description: "Rectangle width in grid units",
  },
  {
    key: "rectHeight",
    type: PropertyType.INT,
    label: "Height",
    defaultValue: DEFAULT_HEIGHT,
    min: 1,
    max: 200,
    description: "Rectangle height in grid units",
  },
  {
    key: "lineWidth",
    type: PropertyType.INT,
    label: "Line width",
    defaultValue: 1,
    min: 1,
    max: 10,
    description: "Border line thickness",
  },
];

// ---------------------------------------------------------------------------
// RectangleDefinition — ComponentDefinition for registry registration
// ---------------------------------------------------------------------------

function rectangleFactory(props: PropertyBag): RectangleElement {
  return new RectangleElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const RectangleDefinition: ComponentDefinition = {
  name: "Rectangle",
  typeId: -1,
  factory: rectangleFactory,
  executeFn: executeRectangle,
  pinLayout: [],
  propertyDefs: RECTANGLE_PROPERTY_DEFS,
  attributeMap: RECTANGLE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MISC,
  helpText:
    "Rectangle — visual grouping box on the canvas.\n" +
    "No simulation behavior. Used to group related circuit sections.\n" +
    "label: optional label displayed above the rectangle.\n" +
    "rectWidth/rectHeight: dimensions in grid units.\n" +
    "lineWidth: border thickness.",
};
