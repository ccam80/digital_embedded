/**
 * NOr gate component.
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

function componentHeight(inputCount: number): number {
  return Math.max(inputCount * 2, 4);
}

// ---------------------------------------------------------------------------
// Pin layout helpers
// ---------------------------------------------------------------------------

function buildInputLabels(inputCount: number): string[] {
  const labels: string[] = [];
  for (let i = 0; i < inputCount; i++) {
    labels.push(`in${i}`);
  }
  return labels;
}

function buildPinDeclarations(inputCount: number, bitWidth: number): PinDeclaration[] {
  const h = componentHeight(inputCount);
  return standardGatePinLayout(buildInputLabels(inputCount), "out", COMP_WIDTH, h, bitWidth);
}

function parseInvertedPins(props: PropertyBag, inputCount: number): string[] {
  if (props.has("_inverterLabels")) {
    const raw = props.get<string>("_inverterLabels");
    return raw.length > 0 ? raw.split(",") : [];
  }
  if (props.has("inverterConfig")) {
    const cfg = props.get<number[]>("inverterConfig");
    return cfg
      .map((v, i) => (v !== 0 ? `in${i}` : null))
      .filter((x): x is string => x !== null);
  }
  const inputLabels = buildInputLabels(inputCount);
  return inputLabels.filter((label) => {
    const key = `invert_${label}`;
    return props.has(key) && props.get<boolean>(key) === true;
  });
}

// ---------------------------------------------------------------------------
// NOrElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class NOrElement extends AbstractCircuitElement {
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
    super("NOr", instanceId, position, rotation, mirror, props);

    this._inputCount = props.getOrDefault<number>("inputCount", 2);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    this._wideShape = props.getOrDefault<boolean>("wideShape", false);
    this._invertedPins = parseInvertedPins(props, this._inputCount);

    const inverterConfig = createInverterConfig(this._invertedPins);
    const decls = buildPinDeclarations(this._inputCount, this._bitWidth);
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
    const h = componentHeight(this._inputCount);
    return {
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: h,
    };
  }

  draw(ctx: RenderContext): void {
    const h = componentHeight(this._inputCount);

    ctx.save();

    if (this._wideShape) {
      this._drawIEEE(ctx, h);
    } else {
      this._drawIEC(ctx, h);
    }

    this._drawLabel(ctx);
    this._drawInversionBubbles(ctx);

    ctx.restore();
  }

  /**
   * IEC/DIN shape: rectangle with "≥1" symbol inside, output inversion bubble.
   */
  private _drawIEC(ctx: RenderContext, h: number): void {
    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, h, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, h, false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.2, weight: "bold" });
    ctx.drawText("≥1", COMP_WIDTH / 2, h / 2, { horizontal: "center", vertical: "middle" });

    // Output inversion bubble
    const BUBBLE_RADIUS = 0.3;
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawCircle(COMP_WIDTH + BUBBLE_RADIUS, h / 2, BUBBLE_RADIUS, false);
  }

  /**
   * IEEE/US shape: OR gate body with inversion bubble at output.
   */
  private _drawIEEE(ctx: RenderContext, h: number): void {
    const halfH = h / 2;
    const BUBBLE_RADIUS = 0.3;

    ctx.setColor("COMPONENT_FILL");
    ctx.drawPath({
      operations: [
        { op: "moveTo", x: 0, y: 0 },
        { op: "lineTo", x: halfH, y: 0 },
        {
          op: "curveTo",
          cp1x: COMP_WIDTH + 1,
          cp1y: 0,
          cp2x: COMP_WIDTH + 1,
          cp2y: h,
          x: halfH,
          y: h,
        },
        { op: "lineTo", x: 0, y: h },
        {
          op: "curveTo",
          cp1x: halfH * 0.5,
          cp1y: h,
          cp2x: halfH * 0.5,
          cp2y: 0,
          x: 0,
          y: 0,
        },
        { op: "closePath" },
      ],
    }, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPath({
      operations: [
        { op: "moveTo", x: 0, y: 0 },
        { op: "lineTo", x: halfH, y: 0 },
        {
          op: "curveTo",
          cp1x: COMP_WIDTH + 1,
          cp1y: 0,
          cp2x: COMP_WIDTH + 1,
          cp2y: h,
          x: halfH,
          y: h,
        },
        { op: "lineTo", x: 0, y: h },
        {
          op: "curveTo",
          cp1x: halfH * 0.5,
          cp1y: h,
          cp2x: halfH * 0.5,
          cp2y: 0,
          x: 0,
          y: 0,
        },
        { op: "closePath" },
      ],
    }, false);

    ctx.drawCircle(COMP_WIDTH + BUBBLE_RADIUS, halfH, BUBBLE_RADIUS, false);
  }

  private _drawInversionBubbles(ctx: RenderContext): void {
    if (this._invertedPins.length === 0) return;

    const decls = buildPinDeclarations(this._inputCount, this._bitWidth);
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

  private _drawLabel(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length === 0) return;

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.0 });
    ctx.drawText(label, COMP_WIDTH / 2, -0.5, { horizontal: "center", vertical: "bottom" });
  }

  getHelpText(): string {
    return (
      "NOr gate — performs bitwise NOT(OR) of all inputs.\n" +
      "Configurable input count (2–5) and bit width (1–32).\n" +
      "Both IEEE/US (curved with bubble) and IEC/DIN (rectangular with ≥1 and bubble) shapes are supported.\n" +
      "Individual inputs can be inverted via the inverterConfig property."
    );
  }
}

// ---------------------------------------------------------------------------
// executeNOr — flat simulation function
// ---------------------------------------------------------------------------

export function executeNOr(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const inputStart = layout.inputOffset(index);
  const inputCount = layout.inputCount(index);
  const outputIdx = layout.outputOffset(index);

  let result = 0;
  for (let i = 0; i < inputCount; i++) {
    result = (result | state[inputStart + i]) >>> 0;
  }
  state[outputIdx] = (~result) >>> 0;
}

// ---------------------------------------------------------------------------
// NOR_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const NOR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
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

const NOR_PROPERTY_DEFS: PropertyDefinition[] = [
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
    description: "Use IEEE/US (curved with bubble) shape instead of IEC/DIN (rectangular)",
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
// NOrDefinition
// ---------------------------------------------------------------------------

function norFactory(props: PropertyBag): NOrElement {
  return new NOrElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const NOrDefinition: ComponentDefinition = {
  name: "NOr",
  typeId: -1,
  factory: norFactory,
  executeFn: executeNOr,
  pinLayout: buildPinDeclarations(2, 1),
  propertyDefs: NOR_PROPERTY_DEFS,
  attributeMap: NOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.LOGIC,
  helpText:
    "NOr gate — performs bitwise NOT(OR) of all inputs.\n" +
    "Configurable input count (2–5) and bit width (1–32).\n" +
    "Both IEEE/US (curved with bubble) and IEC/DIN (rectangular with ≥1 and bubble) shapes are supported.\n" +
    "Individual inputs can be inverted via the inverterConfig property.",
};
