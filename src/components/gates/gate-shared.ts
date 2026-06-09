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
import type { PropertyDefinition, PropertyBag } from "../../core/properties.js";
import type { AttributeMapping } from "../../core/registry.js";
import type { MnaSubcircuitNetlist, SubcircuitElement } from "../../core/mna-subcircuit-netlist.js";

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
// Behavioural gate netlist- shared builder for all combinational logic gates
//
// Every behavioural gate (And/Or/NAnd/NOr/XOr/XNOr/Not/Buf) has the identical
// structure: one BehavioralLogic I-mode B-source `drv` evaluating the gate's
// truth function over N normalized input levels V(r1)..V(rN); a 1Ω `drvR`
// Norton resistor (I-source + 1Ω -> V(ctrl_out) = expr); one DigitalInputPin
// per input; one DigitalOutputPin. Only the truth-function expression differs,
// supplied by `buildExpr`. The B-source is a true Newton device (asrcload.c
// stamps the analytic Jacobian) and is harness-comparable bit-exact to ngspice.
// ---------------------------------------------------------------------------

/** Right-fold a binary B-source function over N terms (min/max are 2-ary). */
export function nestBinary(fn: string, terms: string[]): string {
  if (terms.length === 1) return terms[0]!;
  return `${fn}(${terms[0]},${nestBinary(fn, terms.slice(1))})`;
}

/** Left-fold the fuzzy XOR (a XOR b = a + b - 2ab) over N terms. */
export function xorFold(terms: string[]): string {
  let expr = terms[0]!;
  for (let i = 1; i < terms.length; i++) {
    const b = terms[i]!;
    expr = `(${expr}+${b}-2*(${expr})*${b})`;
  }
  return expr;
}

/**
 * Build the behavioural-model netlist for a combinational gate. `buildExpr`
 * receives the controller references `["V(r1)", …, "V(rN)"]` and returns the
 * gate's I-mode B-source truth-function expression.
 */
export function buildBehavioralGateNetlist(
  params: PropertyBag,
  buildExpr: (vars: string[]) => string,
): MnaSubcircuitNetlist {
  const N = params.getModelParam<number>("inputCount");
  const loaded = params.getModelParam<number>("loaded") >= 0.5;
  const inputPinType = loaded ? "DigitalInputPinLoaded" : "DigitalInputPinUnloaded";
  const outputPinType = loaded ? "DigitalOutputPinLoaded" : "DigitalOutputPinUnloaded";

  const ports: string[] = [];
  for (let i = 0; i < N; i++) ports.push(`In_${i + 1}`);
  ports.push("out", "gnd");
  const outIdx = N;
  const gndIdx = N + 1;
  const ctrlOutNet = N + 2;
  const resultNets: number[] = [];
  for (let i = 0; i < N; i++) resultNets.push(N + 3 + i);

  const elements: SubcircuitElement[] = [];
  const netlist: number[][] = [];

  // Truth-function driver: I-mode B-source over controllers r1..rN. Pin order is
  // [controllers…, out+, out-]; out+ -> gnd, out- -> ctrl_out (current injected
  // into ctrl_out) plus the 1Ω drvR Norton (G=1 -> V(ctrl_out) = expr).
  const driverPins: number[] = [];
  for (let i = 0; i < N; i++) driverPins.push(resultNets[i]!);
  const expr = buildExpr(Array.from({ length: N }, (_, i) => `V(r${i + 1})`));
  driverPins.push(gndIdx, ctrlOutNet);
  elements.push({
    typeId: "BehavioralLogic",
    modelRef: "default",
    subElementName: "drv",
    params: { expression: { kind: "literal", value: expr } },
  });
  netlist.push(driverPins);
  elements.push({
    typeId: "Resistor",
    modelRef: "behavioral",
    subElementName: "drvR",
    params: { resistance: 1 },
  });
  netlist.push([ctrlOutNet, gndIdx]);

  for (let i = 0; i < N; i++) {
    elements.push({
      typeId: inputPinType,
      modelRef: "default",
      subElementName: `inPin_${i + 1}`,
      params: { vIH: "vIH", vIL: "vIL", rIn: "rIn", cIn: "cIn" },
    });
    netlist.push([i, gndIdx, resultNets[i]!]);
  }

  elements.push({
    typeId: outputPinType,
    modelRef: "default",
    subElementName: "outPin",
    params: {
      rOut: params.getModelParam<number>("rOut"),
      cOut: params.getModelParam<number>("cOut"),
      vOH: params.getModelParam<number>("vOH"),
      vOL: params.getModelParam<number>("vOL"),
    },
  });
  netlist.push([outIdx, gndIdx, ctrlOutNet]);

  return {
    ports,
    params: {
      vIH: params.getModelParam<number>("vIH"),
      vIL: params.getModelParam<number>("vIL"),
      rIn: params.getModelParam<number>("rIn"),
      cIn: params.getModelParam<number>("cIn"),
    },
    elements,
    internalNetCount: 1 + N,
    internalNetLabels: ["ctrl_out", ...Array.from({ length: N }, (_, i) => `result_${i + 1}`)],
    netlist,
  };
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
