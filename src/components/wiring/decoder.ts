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
import { makeBehavioralDecoderAnalogFactory } from "../../solver/analog/behavioral-combinational.js";

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

export function buildDecoderPinDeclarations(selectorBits: number, flipSelPos = false): PinDeclaration[] {
  const outCount = 1 << selectorBits;
  const height = outCount;

  // Java DemuxerShape layout (same as Demultiplexer but without data input)
  const pins: PinDeclaration[] = [];

  // Selector pin
  pins.push({
    direction: PinDirection.INPUT,
    label: "sel",
    defaultBitWidth: selectorBits,
    position: { x: 1, y: flipSelPos ? 0 : height },
    isNegatable: false,
    isClockCapable: false,
  });

  // Output pins — 2 outputs get gap (y=0, y=2), otherwise sequential
  if (outCount === 2) {
    pins.push({ direction: PinDirection.OUTPUT, label: "out_0", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false });
    pins.push({ direction: PinDirection.OUTPUT, label: "out_1", defaultBitWidth: 1, position: { x: 2, y: 2 }, isNegatable: false, isClockCapable: false });
  } else {
    for (let i = 0; i < outCount; i++) {
      pins.push({ direction: PinDirection.OUTPUT, label: `out_${i}`, defaultBitWidth: 1, position: { x: 2, y: i }, isNegatable: false, isClockCapable: false });
    }
  }

  return pins;
}

// ---------------------------------------------------------------------------
// DecoderElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class DecoderElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Decoder", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const selectorBits = this._properties.getOrDefault<number>("selectorBits", 1);
    return this.derivePins(buildDecoderPinDeclarations(selectorBits));
  }

  getBoundingBox(): Rect {
    const selectorBits = this._properties.getOrDefault<number>("selectorBits", 1);
    const outputCount = 1 << selectorBits;
    const h = outputCount;
    // Trapezoid: (0.05,0.25) -> (1.95,-0.2) -> (1.95,h+0.2) -> (0.05,h-0.25).
    // MinX=0.05, maxX=1.95, minY=-0.2, maxY=h+0.2.
    // height = (h+0.2) - (-0.2) to avoid float cancellation in y + height.
    const minY = -0.2;
    const maxY = h + 0.2;
    return {
      x: this.position.x + 0.05,
      y: this.position.y + minY,
      width: 1.9,
      height: maxY - minY,
    };
  }

  draw(ctx: RenderContext): void {
    const selectorBits = this._properties.getOrDefault<number>("selectorBits", 1);
    const outputCount = 1 << selectorBits;
    // Java DecoderShape uses a trapezoid scaled to outputCount outputs.
    // Reference (2-output / selectorBits=1): (0.05,0.25)→(1.95,-0.2)→(1.95,2.2)→(0.05,1.75)
    // Left edge height = 1.5, right edge height = 2.4 for 2 outputs.
    // Scale: left inset = 0.25, right overshoot = 0.2 * h/2
    const h = outputCount; // right-edge total height in grid units
    const leftInset = 0.25;  // how far the left edge is inset from 0 and h
    const rightOver = 0.2;   // how far the right edge extends past 0 and h

    const poly = [
      { x: 0.05, y: leftInset },
      { x: 1.95, y: -rightOver },
      { x: 1.95, y: h + rightOver },
      { x: 0.05, y: h - leftInset },
    ];

    ctx.save();

    ctx.setColor("COMPONENT_FILL");
    ctx.drawPolygon(poly, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPolygon(poly, false);

    // First output label "0" near top-right, RIGHTTOP anchor → (1.85, 0.1)
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.75, weight: "normal" });
    ctx.drawText("0", 1.85, 0.1, { horizontal: "right", vertical: "top" });

    ctx.restore();
  }

  getHelpText(): string {
    const selectorBits = this._properties.getOrDefault<number>("selectorBits", 1);
    const outputCount = 1 << selectorBits;
    return (
      `Decoder — ${selectorBits}-bit input produces ${outputCount} one-hot outputs.\n` +
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
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const outCount = layout.outputCount(index);

  const sel = state[wt[inBase]] >>> 0;

  for (let i = 0; i < outCount; i++) {
    state[wt[outBase + i]] = i === sel ? 1 : 0;
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
    defaultValue: 1,
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
  pinLayout: buildDecoderPinDeclarations(1),
  propertyDefs: DECODER_PROPERTY_DEFS,
  attributeMap: DECODER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "Decoder — N-bit input produces 2^N one-hot outputs.\n" +
    "Only output[input_value] is 1; all others are 0.",
  models: {
    digital: {
      executeFn: executeDecoder,
      inputSchema: ["sel"],
      outputSchema: (props) => {
        const selectorBits = props.getOrDefault<number>("selectorBits", 1);
        const outCount = 1 << selectorBits;
        return Array.from({ length: outCount }, (_, i) => `out_${i}`);
      },
    },
    analog: {
      factory: makeBehavioralDecoderAnalogFactory(1),
    },
  },
  defaultModel: "digital",
};
