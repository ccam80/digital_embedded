/**
 * XOr gate component.
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
  PinDirection,
  createInverterConfig,
  gateBodyMetrics,
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

function parseInvertedPins(props: PropertyBag, inputCount: number): string[] {
  if (props.has("_inverterLabels")) {
    const raw = props.get<string>("_inverterLabels");
    return raw.length > 0 ? raw.split(",") : [];
  }
  if (props.has("inverterConfig")) {
    const cfg = props.get<number[]>("inverterConfig");
    return cfg
      .map((v, i) => (v !== 0 ? `In_${i + 1}` : null))
      .filter((x): x is string => x !== null);
  }
  const inputLabels = buildInputLabels(inputCount);
  return inputLabels.filter((label) => {
    const key = `invert_${label}`;
    return props.has(key) && props.get<boolean>(key) === true;
  });
}

// ---------------------------------------------------------------------------
// XOrElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class XOrElement extends AbstractCircuitElement {
  private readonly _inputCount: number;
  private readonly _bitWidth: number;
  private readonly _wideShape: boolean;
  private readonly _invertedPins: readonly string[];
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("XOr", instanceId, position, rotation, mirror, props);

    this._inputCount = props.getOrDefault<number>("inputCount", 2);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    this._wideShape = props.getOrDefault<boolean>("wideShape", false);
    this._invertedPins = parseInvertedPins(props, this._inputCount);

    const inverterConfig = createInverterConfig(this._invertedPins);
    const decls = buildPinDeclarations(this._inputCount, this._bitWidth, this._wideShape);
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      inverterConfig,
      { clockPins: new Set<string>() },
      this._bitWidth,
    );
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    const { topBorder, bodyHeight } = gateBodyMetrics(this._inputCount);
    return {
      x: this.position.x,
      y: this.position.y - topBorder,
      width: compWidth(this._wideShape),
      height: bodyHeight,
    };
  }

  draw(ctx: RenderContext): void {
    const w = compWidth(this._wideShape);

    ctx.save();

    this._drawIEEE(ctx, w);
    this._drawInputStubs(ctx);
    this._drawLabel(ctx, w);
    this._drawInversionBubbles(ctx);

    ctx.restore();
  }

  /**
   * IEEE/US shape: XOR gate — same as OR but body shifted right by 0.5 grid,
   * plus an extra open-stroke back curve at the original OR position.
   * Coordinates from Java IEEEXOrShape.
   */
  private _drawIEEE(ctx: RenderContext, w: number): void {
    const outputY = Math.floor(this._inputCount / 2);
    const wide = w === 4;

    const bodyOps = wide ? [
      { op: "moveTo" as const, x: 1.0, y: 2.5 },
      { op: "lineTo" as const, x: 0.5, y: 2.5 },
      { op: "curveTo" as const, cp1x: 1.0, cp1y: 1.7, cp2x: 1.0, cp2y: 0.3, x: 0.5, y: -0.5 },
      { op: "lineTo" as const, x: 1.0, y: -0.5 },
      { op: "curveTo" as const, cp1x: 2.0, cp1y: -0.5, cp2x: 3.0, cp2y: 0, x: 4.0, y: outputY },
      { op: "curveTo" as const, cp1x: 3.0, cp1y: 2.0, cp2x: 2.0, cp2y: 2.5, x: 1.0, y: 2.5 },
      { op: "closePath" as const },
    ] : [
      { op: "moveTo" as const, x: 1.0, y: 2.5 },
      { op: "lineTo" as const, x: 0.55, y: 2.5 },
      { op: "curveTo" as const, cp1x: 1.0, cp1y: 2.0, cp2x: 1.0, cp2y: 0, x: 0.55, y: -0.5 },
      { op: "lineTo" as const, x: 1.0, y: -0.5 },
      { op: "curveTo" as const, cp1x: 1.5, cp1y: -0.5, cp2x: 2.0, cp2y: 0, x: 3.0, y: outputY },
      { op: "curveTo" as const, cp1x: 2.0, cp1y: 2.0, cp2x: 1.5, cp2y: 2.5, x: 1.0, y: 2.5 },
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

  /**
   * Draw input wire stubs from pin position to body edge.
   * XOR has longer stubs than OR because of the double-back gap:
   * top/bottom: 0.7 grid, center (odd count): 0.85 grid.
   */
  private _drawInputStubs(ctx: RenderContext): void {
    const n = this._inputCount;
    const even = n > 0 && (n & 1) === 0;

    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    for (let i = 0; i < n; i++) {
      const correct = (even && i >= n / 2) ? 1 : 0;
      const pinY = i + correct;
      const isCenter = !even && i === Math.floor(n / 2);
      const stubLen = isCenter ? 0.85 : 0.7;
      ctx.drawLine(0, pinY, stubLen, pinY);
    }
  }

  private _drawInversionBubbles(ctx: RenderContext): void {
    if (this._invertedPins.length === 0) return;

    const decls = buildPinDeclarations(this._inputCount, this._bitWidth, this._wideShape);
    const invertedSet = new Set(this._invertedPins);
    const BUBBLE_RADIUS = 0.3;

    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    for (const decl of decls) {
      if (decl.direction === PinDirection.INPUT && invertedSet.has(decl.label)) {
        ctx.drawCircle(decl.position.x, decl.position.y, BUBBLE_RADIUS, false);
      }
    }
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
      "XOr gate — performs bitwise XOR of all inputs.\n" +
      "Configurable input count (2–5) and bit width (1–32).\n" +
      "Both IEEE/US (curved with extra line) and IEC/DIN (rectangular with =1) shapes are supported.\n" +
      "Individual inputs can be inverted via the inverterConfig property."
    );
  }
}

// ---------------------------------------------------------------------------
// executeXOr — flat simulation function
// ---------------------------------------------------------------------------

export function executeXOr(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  const inputCount = layout.inputCount(index);
  const outputIdx = layout.outputOffset(index);

  let result = 0;
  for (let i = 0; i < inputCount; i++) {
    result = (result ^ state[wt[inputStart + i]]) >>> 0;
  }
  state[wt[outputIdx]] = result;
}

// ---------------------------------------------------------------------------
// XOR_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const XOR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
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

const XOR_PROPERTY_DEFS: PropertyDefinition[] = [
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
    description: "Use IEEE/US (curved with extra line) shape instead of IEC/DIN (rectangular)",
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
// XOrDefinition
// ---------------------------------------------------------------------------

function xorFactory(props: PropertyBag): XOrElement {
  return new XOrElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const XOrDefinition: ComponentDefinition = {
  name: "XOr",
  typeId: -1,
  factory: xorFactory,
  executeFn: executeXOr,
  pinLayout: buildPinDeclarations(2, 1, false),
  propertyDefs: XOR_PROPERTY_DEFS,
  attributeMap: XOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.LOGIC,
  helpText:
    "XOr gate — performs bitwise XOR of all inputs.\n" +
    "Configurable input count (2–5) and bit width (1–32).\n" +
    "Both IEEE/US (curved with extra line) and IEC/DIN (rectangular with =1) shapes are supported.\n" +
    "Individual inputs can be inverted via the inverterConfig property.",
};
