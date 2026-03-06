/**
 * Not gate component.
 *
 * Follows the And gate exemplar pattern exactly:
 *   1. CircuitElement class (rendering, properties, pin declarations)
 *   2. Standalone flat executeFn (simulation, zero allocations)
 *   3. AttributeMapping[] for .dig XML parsing
 *   4. ComponentDefinition for registry registration
 *
 * Not always has exactly 1 input — inputCount is not configurable.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  createInverterConfig,
  resolvePins,
  standardGatePinLayout,
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

const COMP_WIDTH = 4;
const COMP_HEIGHT = 4;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

/** Output pin offset past the inversion bubble (2 * bubbleRadius). */
const OUTPUT_BUBBLE_OFFSET = 0.6;

function buildPinDeclarations(bitWidth: number): PinDeclaration[] {
  return standardGatePinLayout(["in"], "out", COMP_WIDTH, COMP_HEIGHT, bitWidth, OUTPUT_BUBBLE_OFFSET);
}

// ---------------------------------------------------------------------------
// NotElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class NotElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _wideShape: boolean;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Not", instanceId, position, rotation, mirror, props);

    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    this._wideShape = props.getOrDefault<boolean>("wideShape", true);

    const decls = buildPinDeclarations(this._bitWidth);
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
      this._bitWidth,
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

    ctx.save();

    if (this._wideShape) {
      this._drawIEEE(ctx);
    } else {
      this._drawIEC(ctx);
    }

    this._drawLabel(ctx);

    ctx.restore();
  }

  /**
   * IEC/DIN shape: rectangle with "1" symbol inside, output bubble.
   */
  private _drawIEC(ctx: RenderContext): void {
    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.2, weight: "bold" });
    ctx.drawText("1", COMP_WIDTH / 2, COMP_HEIGHT / 2, { horizontal: "center", vertical: "middle" });

    // Output inversion bubble
    const BUBBLE_RADIUS = 0.3;
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawCircle(COMP_WIDTH + BUBBLE_RADIUS, COMP_HEIGHT / 2, BUBBLE_RADIUS, false);
  }

  /**
   * IEEE/US shape: triangle pointing right, with inversion bubble at output.
   */
  private _drawIEEE(ctx: RenderContext): void {
    const halfH = COMP_HEIGHT / 2;
    const BUBBLE_RADIUS = 0.3;

    ctx.setColor("COMPONENT_FILL");
    ctx.drawPath({
      operations: [
        { op: "moveTo", x: 0, y: 0 },
        { op: "lineTo", x: COMP_WIDTH - BUBBLE_RADIUS * 2, y: halfH },
        { op: "lineTo", x: 0, y: COMP_HEIGHT },
        { op: "closePath" },
      ],
    }, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPath({
      operations: [
        { op: "moveTo", x: 0, y: 0 },
        { op: "lineTo", x: COMP_WIDTH - BUBBLE_RADIUS * 2, y: halfH },
        { op: "lineTo", x: 0, y: COMP_HEIGHT },
        { op: "closePath" },
      ],
    }, false);

    ctx.drawCircle(COMP_WIDTH - BUBBLE_RADIUS, halfH, BUBBLE_RADIUS, false);
  }

  private _drawLabel(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length === 0) return;

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.0 });
    ctx.drawText(label, COMP_WIDTH / 2, -0.5, { horizontal: "center", vertical: "bottom" });
  }

  getHelpText(): string {
    return (
      "Not gate — performs bitwise NOT (inversion) of the input.\n" +
      "Single input, configurable bit width (1–32).\n" +
      "Both IEEE/US (triangle with bubble) and IEC/DIN (rectangular with 1) shapes are supported."
    );
  }
}

// ---------------------------------------------------------------------------
// executeNot — flat simulation function
// ---------------------------------------------------------------------------

export function executeNot(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const inputIdx = layout.inputOffset(index);
  const outputIdx = layout.outputOffset(index);
  state[outputIdx] = (~state[inputIdx]) >>> 0;
}

// ---------------------------------------------------------------------------
// NOT_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const NOT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "wideShape",
    propertyKey: "wideShape",
    convert: (v) => v === "true",
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const NOT_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of each signal",
  },
  {
    key: "wideShape",
    type: PropertyType.BOOLEAN,
    label: "Wide shape",
    defaultValue: false,
    description: "Use IEEE/US (triangle with bubble) shape instead of IEC/DIN (rectangular)",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown above the component",
  },
];

// ---------------------------------------------------------------------------
// NotDefinition
// ---------------------------------------------------------------------------

function notFactory(props: PropertyBag): NotElement {
  return new NotElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const NotDefinition: ComponentDefinition = {
  name: "Not",
  typeId: -1,
  factory: notFactory,
  executeFn: executeNot,
  pinLayout: buildPinDeclarations(1),
  propertyDefs: NOT_PROPERTY_DEFS,
  attributeMap: NOT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.LOGIC,
  helpText:
    "Not gate — performs bitwise NOT (inversion) of the input.\n" +
    "Single input, configurable bit width (1–32).\n" +
    "Both IEEE/US (triangle with bubble) and IEC/DIN (rectangular with 1) shapes are supported.",
};
