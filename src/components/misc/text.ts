/**
 * Text annotation component — non-functional visual label on the canvas.
 *
 * Text has no simulation behavior: no pins, no executeFn state changes.
 * The executeFn is a no-op. Text is purely a visual annotation for labelling
 * circuit sections, documenting designs, or providing instructional content.
 *
 * Properties:
 *   - text: string — the content to display
 *   - fontSize: number — font size in grid units (default 1.0)
 *   - rotation: Rotation — text rotation (0=horizontal, 1=90°CW, etc.)
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
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 4;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// TextElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class TextElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Text", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return [];
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
    const text = this._properties.getOrDefault<string>("text", "");
    const fontSize = this._properties.getOrDefault<number>("fontSize", 1.0);

    ctx.save();

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: fontSize });
    ctx.drawText(text, 0, 0, { horizontal: "left", vertical: "top" });

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Text — visual annotation label on the canvas.\n" +
      "No simulation behavior. Used for documentation and labelling.\n" +
      "text: the content to display.\n" +
      "fontSize: font size in grid units (default 1.0)."
    );
  }
}

// ---------------------------------------------------------------------------
// executeText — no-op (Text has no simulation behavior)
// ---------------------------------------------------------------------------

export function executeText(
  _index: number,
  _state: Uint32Array,
  _highZs: Uint32Array,
  _layout: ComponentLayout,
): void {
  // No simulation behavior.
}

// ---------------------------------------------------------------------------
// TEXT_ATTRIBUTE_MAPPINGS — .dig XML attribute → PropertyBag conversions
// ---------------------------------------------------------------------------

export const TEXT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "text",
    propertyKey: "text",
    convert: (v) => v,
  },
  {
    xmlName: "fontSize",
    propertyKey: "fontSize",
    convert: (v) => parseFloat(v),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TEXT_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "text",
    type: PropertyType.STRING,
    label: "Text",
    defaultValue: "",
    description: "Text content to display on the canvas",
  },
  {
    key: "fontSize",
    type: PropertyType.INT,
    label: "Font size",
    defaultValue: 1.0,
    min: 0.5,
    max: 10,
    description: "Font size in grid units",
  },
];

// ---------------------------------------------------------------------------
// TextDefinition — ComponentDefinition for registry registration
// ---------------------------------------------------------------------------

function textFactory(props: PropertyBag): TextElement {
  return new TextElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const TextDefinition: ComponentDefinition = {
  name: "Text",
  typeId: -1,
  factory: textFactory,
  executeFn: executeText,
  pinLayout: [],
  propertyDefs: TEXT_PROPERTY_DEFS,
  attributeMap: TEXT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MISC,
  helpText:
    "Text — visual annotation label on the canvas.\n" +
    "No simulation behavior. Used for documentation and labelling.\n" +
    "text: the content to display.\n" +
    "fontSize: font size in grid units (default 1.0).",
};
