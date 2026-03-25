/**
 * And gate component — the exemplar component.
 *
 * Establishes the exact pattern all subsequent components follow:
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
  standardGatePinLayout,
  gateBodyMetrics,
} from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import { makeAndAnalogFactory } from "../../solver/analog/behavioral-gate.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Gate width: 3 grid units (narrow/IEC) or 4 (wide/IEEE), matching Java GenericShape. */
function compWidth(wideShape: boolean): number { return wideShape ? 4 : 3; }

/** Component height in grid units for a given input count (Java-compatible). */
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
// AndElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class AndElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("And", instanceId, position, rotation, mirror, props);
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
    // Body polygon starts at x=0.05 (left flat edge); bbox must match drawn geometry exactly.
    return {
      x: this.position.x + 0.05,
      y: this.position.y - topBorder,
      width: compWidth(wideShape) - 0.05,
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
    if (offs > 0) ctx.restore();

    this._drawLabel(ctx, w);

    ctx.restore();
  }

  /**
   * IEEE/US shape: classic curved AND gate body (fixed 2-input base shape).
   * Flat left edge at x=0.05, straight top/bottom, then two cubic bezier
   * curves forming a D-shape on the right. Coordinates from Java IEEEAndShape.
   * For >2 inputs the body is translated by IEEEGenericShape scaling in draw().
   */
  private _drawIEEE(ctx: RenderContext, w: number): void {
    const midX = w === 3 ? 1.5 : 2.5;
    const ops = [
      { op: "moveTo" as const, x: midX, y: 2.5 },
      { op: "lineTo" as const, x: 0.05, y: 2.5 },
      { op: "lineTo" as const, x: 0.05, y: -0.5 },
      { op: "lineTo" as const, x: midX, y: -0.5 },
      { op: "curveTo" as const, cp1x: midX + 0.5, cp1y: -0.5, cp2x: w - 0.05, cp2y: 0, x: w - 0.05, y: 1.0 },
      { op: "curveTo" as const, cp1x: w - 0.05, cp1y: 2.0, cp2x: midX + 0.5, cp2y: 2.5, x: midX, y: 2.5 },
      { op: "closePath" as const },
    ];

    ctx.setColor("COMPONENT_FILL");
    ctx.drawPath({ operations: ops }, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPath({ operations: ops }, false);
  }

  /**
   * Draw the component label (if set) above the component body.
   */
  private _drawLabel(ctx: RenderContext, w: number): void {
    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length === 0) return;

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.0 });
    ctx.drawText(label, w / 2, -0.5, { horizontal: "center", vertical: "bottom" });
  }

  getHelpText(): string {
    return (
      "And gate — performs bitwise AND of all inputs.\n" +
      "Configurable input count (2–5) and bit width (1–32).\n" +
      "Both IEEE/US (curved) and IEC/DIN (rectangular with &) shapes are supported.\n" +
      "Individual inputs can be inverted via the inverterConfig property."
    );
  }
}

// ---------------------------------------------------------------------------
// executeAnd — flat simulation function (Decision 1)
//
// Called by the engine's inner loop via a function table indexed by typeId.
// Zero allocations. Reads N inputs from the state array, ANDs them together,
// writes the result to the output slot.
// ---------------------------------------------------------------------------

export function executeAnd(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  const inputCount = layout.inputCount(index);
  const outputIdx = layout.outputOffset(index);

  let result = 0xFFFFFFFF;
  for (let i = 0; i < inputCount; i++) {
    result = (result & state[wt[inputStart + i]]) >>> 0;
  }
  state[wt[outputIdx]] = result;
}

// ---------------------------------------------------------------------------
// AND_ATTRIBUTE_MAPPINGS — .dig XML attribute → PropertyBag conversions
//
// The .dig parser reads these mechanically. The component never sees raw XML.
// ---------------------------------------------------------------------------

export const AND_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
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
// Property definitions — used by the property panel UI
// ---------------------------------------------------------------------------

const AND_PROPERTY_DEFS: PropertyDefinition[] = [
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
// AndDefinition — ComponentDefinition for registry registration (Decision 4)
//
// typeId: -1 signals to the registry that it should auto-assign a numeric ID.
// ---------------------------------------------------------------------------

function andFactory(props: PropertyBag): AndElement {
  return new AndElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const AndDefinition: ComponentDefinition = {
  name: "And",
  typeId: -1,
  factory: andFactory,
  pinLayout: buildPinDeclarations(2, 1, false),
  propertyDefs: AND_PROPERTY_DEFS,
  attributeMap: AND_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.LOGIC,
  helpText:
    "And gate — performs bitwise AND of all inputs.\n" +
    "Configurable input count (2–5) and bit width (1–32).\n" +
    "Both IEEE/US (curved) and IEC/DIN (rectangular with &) shapes are supported.\n" +
    "Individual inputs can be inverted via the inverterConfig property.",
  models: {
    digital: {
      executeFn: executeAnd,
      inputSchema: ["In_1", "In_2"],
      outputSchema: ["out"],
    },
    analog: {
      factory: makeAndAnalogFactory(0),
      transistorModel: "CmosAnd2",
    },
  },
  defaultModel: "digital",
};
