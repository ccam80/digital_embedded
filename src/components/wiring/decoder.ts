/**
 * Decoder component — N-bit input → 2^N one-hot outputs.
 * Only output[input_value] is 1; all others are 0.
 *
 * Properties:
 *   - selectorBits: number of input bits (default 2, gives 4 outputs)
 *
 * Pin layout:
 *   0: sel (input, selectorBits wide)
 *   1..2^selectorBits: out_0 .. out_(N-1) (outputs, 1-bit each)
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
  createInverterConfig,
  resolvePins,
  layoutPinsOnFace,
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

function componentHeight(outputCount: number): number {
  return Math.max(outputCount * 2, 4);
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

export function buildDecoderPinDeclarations(selectorBits: number): PinDeclaration[] {
  const outputCount = 1 << selectorBits;
  const h = componentHeight(outputCount);

  const selPin: PinDeclaration = {
    direction: PinDirection.INPUT,
    label: "sel",
    defaultBitWidth: selectorBits,
    position: { x: 0, y: Math.floor(h / 2) },
    isNegatable: false,
    isClockCapable: false,
  };

  const outputPositions = layoutPinsOnFace("east", outputCount, COMP_WIDTH, h);
  const outputPins: PinDeclaration[] = [];
  for (let i = 0; i < outputCount; i++) {
    outputPins.push({
      direction: PinDirection.OUTPUT,
      label: `out_${i}`,
      defaultBitWidth: 1,
      position: outputPositions[i],
      isNegatable: false,
      isClockCapable: false,
    });
  }

  return [selPin, ...outputPins];
}

// ---------------------------------------------------------------------------
// DecoderElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class DecoderElement extends AbstractCircuitElement {
  private readonly _selectorBits: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Decoder", instanceId, position, rotation, mirror, props);

    this._selectorBits = props.getOrDefault<number>("selectorBits", 2);

    const decls = buildDecoderPinDeclarations(this._selectorBits);
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
    );
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    const outputCount = 1 << this._selectorBits;
    const h = componentHeight(outputCount);
    return {
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: h,
    };
  }

  draw(ctx: RenderContext): void {
    const outputCount = 1 << this._selectorBits;
    const h = componentHeight(outputCount);

    ctx.save();

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, h, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, h, false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.0, weight: "bold" });
    ctx.drawText("DEC", COMP_WIDTH / 2, h / 2, {
      horizontal: "center",
      vertical: "middle",
    });

    ctx.restore();
  }

  getHelpText(): string {
    const outputCount = 1 << this._selectorBits;
    return (
      `Decoder — ${this._selectorBits}-bit input produces ${outputCount} one-hot outputs.\n` +
      "Only output[input_value] is 1; all others are 0."
    );
  }
}

// ---------------------------------------------------------------------------
// executeDecoder — flat simulation function
//
// Pin layout in state array (matching buildDecoderPinDeclarations order):
//   input 0: sel
//   outputs 0..N-1: out_0..out_(N-1)
// ---------------------------------------------------------------------------

export function executeDecoder(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const outCount = layout.outputCount(index);

  const sel = state[inBase] >>> 0;

  for (let i = 0; i < outCount; i++) {
    state[outBase + i] = i === sel ? 1 : 0;
  }
}

// ---------------------------------------------------------------------------
// DECODER_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const DECODER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Selector Bits",
    propertyKey: "selectorBits",
    convert: (v) => parseInt(v, 10),
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

const DECODER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "selectorBits",
    type: PropertyType.INT,
    label: "Selector Bits",
    defaultValue: 2,
    min: 1,
    max: 4,
    description: "Number of input bits (determines number of outputs: 2^selectorBits)",
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
// DecoderDefinition
// ---------------------------------------------------------------------------

function decoderFactory(props: PropertyBag): DecoderElement {
  return new DecoderElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const DecoderDefinition: ComponentDefinition = {
  name: "Decoder",
  typeId: -1,
  factory: decoderFactory,
  executeFn: executeDecoder,
  pinLayout: buildDecoderPinDeclarations(2),
  propertyDefs: DECODER_PROPERTY_DEFS,
  attributeMap: DECODER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "Decoder — N-bit input produces 2^N one-hot outputs.\n" +
    "Only output[input_value] is 1; all others are 0.",
};
