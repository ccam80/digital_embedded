/**
 * Shared helpers and constants for multi-input gate components.
 *
 * Extracted from And, Or, NAnd, NOr, XOr, XNOr to eliminate duplication.
 * NOT gate is excluded- it has a different pin model and shape.
 */

import type { RenderContext } from "../../core/renderer-interface.js";
import type { PinDeclaration } from "../../core/pin.js";
import {
  PinDirection,
  standardGatePinLayout,
  gateBodyMetrics,
} from "../../core/pin.js";
import { PropertyType, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import type { AttributeMapping } from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Layout helpers- identical across all 6 multi-input gates
// ---------------------------------------------------------------------------

/** Gate width: 3 grid units (narrow/IEC) or 4 (wide/IEEE), matching Java GenericShape. */
export function compWidth(wideShape: boolean): number { return wideShape ? 4 : 3; }

/** Component height in grid units for a given input count (Java-compatible). */
export function componentHeight(inputCount: number): number {
  return gateBodyMetrics(inputCount).bodyHeight;
}

// ---------------------------------------------------------------------------
// Pin layout helpers- identical across all 6 multi-input gates
// ---------------------------------------------------------------------------

export function buildInputLabels(inputCount: number): string[] {
  const labels: string[] = [];
  for (let i = 0; i < inputCount; i++) {
    labels.push(`In_${i + 1}`);
  }
  return labels;
}

/**
 * Build pin declarations for gates WITHOUT an inversion bubble
 * (And, Or, XOr).
 */
export function buildStandardPinDeclarations(
  inputCount: number,
  bitWidth: number,
  wideShape: boolean = true,
): PinDeclaration[] {
  const h = componentHeight(inputCount);
  return standardGatePinLayout(buildInputLabels(inputCount), "out", compWidth(wideShape), h, bitWidth);
}

/** Output pin 1 grid unit past body edge (matching Java GenericShape inverted dx=SIZE). */
export const OUTPUT_BUBBLE_OFFSET = 1;

/**
 * Build pin declarations for gates WITH an inversion bubble
 * (NAnd, NOr, XNOr).
 */
export function buildInvertedPinDeclarations(
  inputCount: number,
  bitWidth: number,
  wideShape: boolean = true,
): PinDeclaration[] {
  const h = componentHeight(inputCount);
  return standardGatePinLayout(buildInputLabels(inputCount), "out", compWidth(wideShape), h, bitWidth, OUTPUT_BUBBLE_OFFSET);
}

// ---------------------------------------------------------------------------
// Shared attribute mappings- identical across all 6 multi-input gates
// ---------------------------------------------------------------------------

export const STANDARD_GATE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
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
// Shared property definitions- identical across all 6 multi-input gates
// (wideShape description varies per gate- passed as parameter)
// ---------------------------------------------------------------------------

export function buildStandardGatePropertyDefs(wideShapeDescription: string): PropertyDefinition[] {
  return [
    {
      key: "inputCount",
      type: PropertyType.INT,
      label: "Inputs",
      defaultValue: 2,
      min: 2,
      max: 5,
      description: "Number of input pins (2–5)",
      structural: true,
    },
    {
      key: "bitWidth",
      type: PropertyType.BIT_WIDTH,
      label: "Bits",
      defaultValue: 1,
      min: 1,
      max: 32,
      description: "Bit width of each signal",
      structural: true,
    },
    {
      key: "wideShape",
      type: PropertyType.BOOLEAN,
      label: "Wide shape",
      defaultValue: false,
      description: wideShapeDescription,
      structural: true,
    },
    {
      key: "_inverterLabels",
      type: PropertyType.STRING,
      label: "Invert inputs",
      defaultValue: "",
      description: "Comma-separated inputs to invert: pin labels (e.g. \"In_1,In_3\") or 1-indexed numbers (e.g. \"1,3\")",
    },
    LABEL_PROPERTY_DEF,
  ];
}

// ---------------------------------------------------------------------------
// Shared drawing helpers- identical across all 6 multi-input gates
// ---------------------------------------------------------------------------

/**
 * Draw the component label (if set) above the component body.
 * Identical across all 6 multi-input gates.
 */
export function drawGateLabel(ctx: RenderContext, visibleLabel: string, w: number): void {
  if (visibleLabel.length === 0) return;
  ctx.setColor("TEXT");
  ctx.setFont({ family: "sans-serif", size: 1.0 });
  ctx.drawText(visibleLabel, w / 2, -0.5, { horizontal: "center", vertical: "bottom" });
}

/**
 * Append VDD (top) and GND (bottom) power pins to a pin declaration array.
 *
 * Used by getPins() when the active simulation model is a subcircuit key
 * (e.g., "cmos"). Power pins are centered horizontally on the component body.
 *
 * @param decls   Existing signal pin declarations.
 * @param centerX Horizontal center of the component in grid units.
 * @param topY    Y coordinate for VDD pin (above body).
 * @param bottomY Y coordinate for GND pin (below body).
 */
export function appendPowerPins(
  decls: PinDeclaration[],
  centerX: number,
  topY: number,
  bottomY: number,
): PinDeclaration[] {
  return [
    ...decls,
    {
      direction: PinDirection.INPUT,
      label: "VDD",
      defaultBitWidth: 1,
      position: { x: centerX, y: topY },
      isNegatable: false,
      isClockCapable: false,
      kind: "power",
    },
    {
      direction: PinDirection.INPUT,
      label: "GND",
      defaultBitWidth: 1,
      position: { x: centerX, y: bottomY },
      isNegatable: false,
      isClockCapable: false,
      kind: "power",
    },
  ];
}

/**
 * Draw vertical extension lines for gates with >2 inputs.
 * Java IEEEGenericShape pattern- identical across all 6 multi-input gates.
 */
export function drawGateExtensionLines(ctx: RenderContext, inputCount: number): void {
  const offs = Math.floor(inputCount / 2) - 1;
  if (offs <= 0) return;
  const h = Math.floor(inputCount / 2) * 2;
  ctx.setColor("COMPONENT");
  ctx.setLineWidth(1);
  ctx.drawLine(0.05, 0, 0.05, offs - 0.55);
  ctx.drawLine(0.05, h, 0.05, h - offs + 0.55);
}

// ---------------------------------------------------------------------------
// Shared IEEE body shapes- paired gates share identical shapes
// ---------------------------------------------------------------------------

/**
 * IEEE/US AND gate body- shared by And and NAnd.
 * Flat left edge at x=0.05, straight top/bottom, two cubic bezier curves
 * forming a D-shape on the right. Coordinates from Java IEEEAndShape.
 */
export function drawAndBody(ctx: RenderContext, w: number): void {
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
 * IEEE/US OR gate body- shared by Or and NOr.
 * Concave back (left) edge, pointed front meeting at x=w, output at y=1.
 * Coordinates from Java IEEEOrShape.
 */
export function drawOrBody(ctx: RenderContext, w: number): void {
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
 * IEEE/US XOR gate body (body + back curve)- shared by XOr and XNOr.
 * Same as OR but body shifted right by 0.5 grid, plus an extra
 * open-stroke back curve. Coordinates from Java IEEEXOrShape.
 */
export function drawXorBody(ctx: RenderContext, w: number): void {
  const wide = w === 4;

  const bodyOps = wide ? [
    { op: "moveTo" as const, x: 0.5, y: 2.5 },
    { op: "curveTo" as const, cp1x: 1.0, cp1y: 2.0, cp2x: 1.0, cp2y: 0.0, x: 0.5, y: -0.5 },
    { op: "curveTo" as const, cp1x: 1.0, cp1y: -0.5, cp2x: 2.0, cp2y: 0.0, x: 4.0, y: 1.0 },
    { op: "curveTo" as const, cp1x: 2.0, cp1y: 2.0, cp2x: 1.0, cp2y: 2.5, x: 0.5, y: 2.5 },
    { op: "closePath" as const },
  ] : [
    { op: "moveTo" as const, x: 0.55, y: 2.5 },
    { op: "curveTo" as const, cp1x: 1.0, cp1y: 2.0, cp2x: 1.0, cp2y: 0.0, x: 0.55, y: -0.5 },
    { op: "curveTo" as const, cp1x: 1.0, cp1y: -0.5, cp2x: 2.0, cp2y: 0.0, x: 3.0, y: 1.0 },
    { op: "curveTo" as const, cp1x: 2.0, cp1y: 2.0, cp2x: 1.0, cp2y: 2.5, x: 0.55, y: 2.5 },
    { op: "closePath" as const },
  ];

  ctx.setColor("COMPONENT_FILL");
  ctx.drawPath({ operations: bodyOps }, true);
  ctx.setColor("COMPONENT");
  ctx.setLineWidth(1);
  ctx.drawPath({ operations: bodyOps }, false);

  const backCurveOps = wide ? [
    { op: "moveTo" as const, x: 0.0, y: 2.5 },
    { op: "curveTo" as const, cp1x: 0.5, cp1y: 1.7, cp2x: 0.5, cp2y: 0.3, x: 0.0, y: -0.5 },
  ] : [
    { op: "moveTo" as const, x: 0.0, y: 2.5 },
    { op: "curveTo" as const, cp1x: 0.5, cp1y: 2.0, cp2x: 0.5, cp2y: 0, x: 0.0, y: -0.5 },
  ];

  ctx.drawPath({ operations: backCurveOps }, false);
}
