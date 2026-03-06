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

/** Component width in grid units. */
const COMP_WIDTH = 4;

/** Component height in grid units for a given input count. */
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

/**
 * Parse inverterConfig from a PropertyBag.
 *
 * .dig format stores inverterConfig as a comma-separated string of pin labels
 * in the "_inverterLabels" key (set by AND_ATTRIBUTE_MAPPINGS). Programmatic
 * construction may pass a number[] under "inverterConfig" where non-zero
 * entries indicate negated pins. Both forms are accepted.
 */
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
// AndElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class AndElement extends AbstractCircuitElement {
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
    super("And", instanceId, position, rotation, mirror, props);

    this._inputCount = props.getOrDefault<number>("inputCount", 2);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    this._wideShape = props.getOrDefault<boolean>("wideShape", true);
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
   * IEC/DIN shape: rectangle with "&" symbol inside.
   * Input pins on left edge, output pin on right edge.
   */
  private _drawIEC(ctx: RenderContext, h: number): void {
    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, h, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, h, false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.2, weight: "bold" });
    ctx.drawText("&", COMP_WIDTH / 2, h / 2, { horizontal: "center", vertical: "middle" });
  }

  /**
   * IEEE/US shape: classic curved AND gate body.
   * Flat left edge, D-shaped bezier curve on the right ending at the output.
   */
  private _drawIEEE(ctx: RenderContext, h: number): void {
    const halfH = h / 2;

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
        { op: "closePath" },
      ],
    }, false);
  }

  /**
   * Draw inversion bubbles on negated input pins.
   * A small circle is drawn at the pin's connection point on the left edge.
   */
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

  /**
   * Draw the component label (if set) above the component body.
   */
  private _drawLabel(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length === 0) return;

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.0 });
    ctx.drawText(label, COMP_WIDTH / 2, -0.5, { horizontal: "center", vertical: "bottom" });
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

export function executeAnd(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const inputStart = layout.inputOffset(index);
  const inputCount = layout.inputCount(index);
  const outputIdx = layout.outputOffset(index);

  let result = 0xFFFFFFFF;
  for (let i = 0; i < inputCount; i++) {
    result = (result & state[inputStart + i]) >>> 0;
  }
  state[outputIdx] = result;
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
  executeFn: executeAnd,
  pinLayout: buildPinDeclarations(2, 1),
  propertyDefs: AND_PROPERTY_DEFS,
  attributeMap: AND_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.LOGIC,
  helpText:
    "And gate — performs bitwise AND of all inputs.\n" +
    "Configurable input count (2–5) and bit width (1–32).\n" +
    "Both IEEE/US (curved) and IEC/DIN (rectangular with &) shapes are supported.\n" +
    "Individual inputs can be inverted via the inverterConfig property.",
};
