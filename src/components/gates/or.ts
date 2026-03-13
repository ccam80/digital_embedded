/**
 * Or gate component.
 *
 * Follows the And gate exemplar pattern exactly:
 *   1. CircuitElement class (rendering, properties, pin declarations)
 *   2. Standalone flat executeFn (simulation, zero allocations)
 *   3. AttributeMapping[] for .dig XML parsing
 *   4. ComponentDefinition for registry registration
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  gateBodyMetrics,
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

/** Gate width: 3 grid units (narrow/IEC) or 4 (wide/IEEE), matching Java GenericShape. */
function compWidth(wideShape: boolean): number { return wideShape ? 4 : 3; }

function componentHeight(inputCount: number): number {
  return gateBodyMetrics(inputCount).bodyHeight;
}

// ---------------------------------------------------------------------------
// Pin layout helpers
// ---------------------------------------------------------------------------

function buildInputLabels(inputCount: number): string[] {
  const labels: string[] = [];
  for (let i = 0; i < inputCount; i++) {
    labels.push(`In_${i + 1}`);
  }
  return labels;
}

function buildPinDeclarations(inputCount: number, bitWidth: number, wideShape: boolean = true): PinDeclaration[] {
  const h = componentHeight(inputCount);
  return standardGatePinLayout(buildInputLabels(inputCount), "out", compWidth(wideShape), h, bitWidth);
}

// ---------------------------------------------------------------------------
// OrElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class OrElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Or", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const inputCount = this._properties.getOrDefault<number>("inputCount", 2);
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const wideShape = this._properties.getOrDefault<boolean>("wideShape", false);
    const decls = buildPinDeclarations(inputCount, bitWidth, wideShape);
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    const inputCount = this._properties.getOrDefault<number>("inputCount", 2);
    const wideShape = this._properties.getOrDefault<boolean>("wideShape", false);
    const { topBorder, bodyHeight } = gateBodyMetrics(inputCount);
    return {
      x: this.position.x,
      y: this.position.y - topBorder,
      width: compWidth(wideShape),
      height: bodyHeight,
    };
  }

  draw(ctx: RenderContext): void {
    const inputCount = this._properties.getOrDefault<number>("inputCount", 2);
    const wideShape = this._properties.getOrDefault<boolean>("wideShape", false);
    const w = compWidth(wideShape);
    const offs = Math.floor(inputCount / 2) - 1;

    ctx.save();

    // Java IEEEGenericShape: vertical extension lines for >2 inputs
    if (offs > 0) {
      const h = Math.floor(inputCount / 2) * 2;
      ctx.setColor("COMPONENT");
      ctx.setLineWidth(1);
      ctx.drawLine(0.05, 0, 0.05, offs - 0.55);
      ctx.drawLine(0.05, h, 0.05, h - offs + 0.55);
    }

    // Draw body translated to center position
    if (offs > 0) ctx.save();
    if (offs > 0) ctx.translate(0, offs);
    this._drawIEEE(ctx, w);
    this._drawBodyStubs(ctx, inputCount);
    if (offs > 0) ctx.restore();

    this._drawLabel(ctx, w);

    ctx.restore();
  }

  /**
   * IEEE/US shape: classic curved OR gate body (fixed 2-input base shape).
   * Concave back (left) edge, pointed front meeting at x=w, output at y=1.
   * For >2 inputs the body is translated by IEEEGenericShape scaling in draw().
   * Coordinates from Java IEEEOrShape.
   */
  private _drawIEEE(ctx: RenderContext, w: number): void {
    const wide = w === 4;

    const ops = wide ? [
      { op: "moveTo" as const, x: 0.5, y: 2.5 },
      { op: "lineTo" as const, x: 0.0, y: 2.5 },
      { op: "curveTo" as const, cp1x: 0.5, cp1y: 1.7, cp2x: 0.5, cp2y: 0.3, x: 0.0, y: -0.5 },
      { op: "lineTo" as const, x: 0.5, y: -0.5 },
      { op: "curveTo" as const, cp1x: 1.5, cp1y: -0.5, cp2x: 3.0, cp2y: 0, x: 4.0, y: 1.0 },
      { op: "curveTo" as const, cp1x: 3.0, cp1y: 2.0, cp2x: 1.5, cp2y: 2.5, x: 0.5, y: 2.5 },
      { op: "closePath" as const },
    ] : [
      { op: "moveTo" as const, x: 0.5, y: 2.5 },
      { op: "lineTo" as const, x: 0.0, y: 2.5 },
      { op: "curveTo" as const, cp1x: 0.5, cp1y: 2.0, cp2x: 0.5, cp2y: 0, x: 0.0, y: -0.5 },
      { op: "lineTo" as const, x: 0.5, y: -0.5 },
      { op: "curveTo" as const, cp1x: 1.0, cp1y: -0.5, cp2x: 2.0, cp2y: 0, x: 3.0, y: 1.0 },
      { op: "curveTo" as const, cp1x: 2.0, cp1y: 2.0, cp2x: 1.0, cp2y: 2.5, x: 0.5, y: 2.5 },
      { op: "closePath" as const },
    ];

    ctx.setColor("COMPONENT_FILL");
    ctx.drawPath({ operations: ops }, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPath({ operations: ops }, false);
  }

  /**
   * Draw short input wire stubs for pins adjacent to the body (in body-local
   * coordinates). Java IEEEOrShape draws stubs at y=0, y=2, and optionally y=1.
   * Outer pins connect to extension lines instead.
   */
  private _drawBodyStubs(ctx: RenderContext, inputCount: number): void {
    const center = (inputCount & 1) !== 0;
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawLine(0, 0, 0.2, 0);
    ctx.drawLine(0, 2, 0.2, 2);
    if (center) ctx.drawLine(0, 1, 0.35, 1);
  }

  private _drawLabel(ctx: RenderContext, w: number): void {
    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length === 0) return;

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.0 });
    ctx.drawText(label, w / 2, -0.5, { horizontal: "center", vertical: "bottom" });
  }

  getHelpText(): string {
    return (
      "Or gate — performs bitwise OR of all inputs.\n" +
      "Configurable input count (2–5) and bit width (1–32).\n" +
      "Both IEEE/US (curved) and IEC/DIN (rectangular with ≥1) shapes are supported.\n" +
      "Individual inputs can be inverted via the inverterConfig property."
    );
  }
}

// ---------------------------------------------------------------------------
// executeOr — flat simulation function
// ---------------------------------------------------------------------------

export function executeOr(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  const inputCount = layout.inputCount(index);
  const outputIdx = layout.outputOffset(index);

  let result = 0;
  for (let i = 0; i < inputCount; i++) {
    result = (result | state[wt[inputStart + i]]) >>> 0;
  }
  state[wt[outputIdx]] = result;
}

// ---------------------------------------------------------------------------
// OR_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const OR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Inputs",
    propertyKey: "inputCount",
    convert: (v) => parseInt(v, 10),
  },
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
    xmlName: "inverterConfig",
    propertyKey: "_inverterLabels",
    convert: (v) => v,
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

const OR_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "inputCount",
    type: PropertyType.INT,
    label: "Inputs",
    defaultValue: 2,
    min: 2,
    max: 5,
    description: "Number of input pins (2–5)",
  },
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
    description: "Use IEEE/US (curved) shape instead of IEC/DIN (rectangular)",
  },
  {
    key: "_inverterLabels",
    type: PropertyType.STRING,
    label: "Invert inputs",
    defaultValue: "",
    description: "Comma-separated inputs to invert: pin labels (e.g. \"In_1,In_3\") or 1-indexed numbers (e.g. \"1,3\")",
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
// OrDefinition
// ---------------------------------------------------------------------------

function orFactory(props: PropertyBag): OrElement {
  return new OrElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const OrDefinition: ComponentDefinition = {
  name: "Or",
  typeId: -1,
  factory: orFactory,
  executeFn: executeOr,
  pinLayout: buildPinDeclarations(2, 1, false),
  propertyDefs: OR_PROPERTY_DEFS,
  attributeMap: OR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.LOGIC,
  helpText:
    "Or gate — performs bitwise OR of all inputs.\n" +
    "Configurable input count (2–5) and bit width (1–32).\n" +
    "Both IEEE/US (curved) and IEC/DIN (rectangular with ≥1) shapes are supported.\n" +
    "Individual inputs can be inverted via the inverterConfig property.",
};
