/**
 * Demultiplexer component — routes one input to one of N outputs based on selector.
 * Selected output = input, all other outputs = 0.
 *
 * Properties:
 *   - selectorBits: number of selector bits (default 1, gives 2 outputs)
 *   - bitWidth: bit width of data signals (default 1)
 *
 * Pin layout (pin index order):
 *   0: sel (input, selectorBits wide)
 *   1: in (input, bitWidth wide)
 *   2..2+N-1: out_0 .. out_(N-1) (outputs, bitWidth wide)
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
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

const COMP_WIDTH = 2;

/**
 * Body height matching Java DemuxerShape:
 *   height = hasInput || (outputCount <= 2) ? outputCount * SIZE : (outputCount - 1) * SIZE
 * We always have an input pin, so height = outputCount (in grid units).
 */
function componentHeight(outputCount: number): number {
  return outputCount;
}

// ---------------------------------------------------------------------------
// Pin layout — matches Java DemuxerShape.getPins() order:
//   sel (input[0]), outputs, then in (input[1]).
//
// Java positions (in SIZE=20px = 1 grid unit):
//   sel: (SIZE, flip ? 0 : height) → (1, flip ? 0 : h)
//   out_i: (SIZE*2, i*SIZE) → (2, i)  [special case for 2 outputs: y=0 and y=2]
//   in: (0, (outputCount/2)*SIZE) → (0, floor(outputCount/2))
// ---------------------------------------------------------------------------

export function buildDemuxPinDeclarations(
  selectorBits: number,
  bitWidth: number,
  flipSelPos = false,
): PinDeclaration[] {
  const outputCount = 1 << selectorBits;
  const h = componentHeight(outputCount);
  const inY = Math.floor(outputCount / 2);

  const pins: PinDeclaration[] = [];

  // 1. Selector pin (Java: inputs.get(0))
  pins.push({
    direction: PinDirection.INPUT,
    label: "sel",
    defaultBitWidth: selectorBits,
    position: { x: 1, y: flipSelPos ? 0 : h },
    isNegatable: false,
    isClockCapable: false,
  });

  // 2. Output pins (Java: outputs)
  if (outputCount === 2) {
    // Java special case: 2 outputs at y=0 and y=2*SIZE
    pins.push({
      direction: PinDirection.OUTPUT, label: "out_0", defaultBitWidth: bitWidth,
      position: { x: COMP_WIDTH, y: 0 }, isNegatable: false, isClockCapable: false,
    });
    pins.push({
      direction: PinDirection.OUTPUT, label: "out_1", defaultBitWidth: bitWidth,
      position: { x: COMP_WIDTH, y: 2 }, isNegatable: false, isClockCapable: false,
    });
  } else {
    for (let i = 0; i < outputCount; i++) {
      pins.push({
        direction: PinDirection.OUTPUT,
        label: `out_${i}`,
        defaultBitWidth: bitWidth,
        position: { x: COMP_WIDTH, y: i },
        isNegatable: false,
        isClockCapable: false,
      });
    }
  }

  // 3. Input pin LAST (Java: inputs.get(1), added after outputs)
  pins.push({
    direction: PinDirection.INPUT,
    label: "in",
    defaultBitWidth: bitWidth,
    position: { x: 0, y: inY },
    isNegatable: false,
    isClockCapable: false,
  });

  return pins;
}

// ---------------------------------------------------------------------------
// DemuxElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class DemuxElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Demultiplexer", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const selectorBits = this._properties.getOrDefault<number>("selectorBits", 1);
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const flipSelPos = this._properties.getOrDefault<boolean>("flipSelPos", false);
    return this.derivePins(buildDemuxPinDeclarations(selectorBits, bitWidth, flipSelPos), []);
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
    // Java DemuxerShape uses same trapezoid as DecoderShape: narrower left, wider right.
    // Reference (2 outputs / selectorBits=1): (0.05,0.25)→(1.95,-0.2)→(1.95,2.2)→(0.05,1.75)
    const h = outputCount; // right-edge total height in grid units
    const leftInset = 0.25;
    const rightOver = 0.2;

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
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const outputCount = 1 << selectorBits;
    return (
      `Demultiplexer — routes input to one of ${outputCount} outputs based on selector.\n` +
      `Selected output = input, all others = 0.\n` +
      `Selector bits: ${selectorBits}, data bit width: ${bitWidth}.`
    );
  }
}

// ---------------------------------------------------------------------------
// executeDemux — flat simulation function
//
// Pin layout in state array (matching buildDemuxPinDeclarations order):
//   input 0: sel
//   input 1: in
//   outputs 0..N-1: out_0..out_(N-1)
// ---------------------------------------------------------------------------

export function executeDemux(
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
  const value = state[wt[inBase + 1]] >>> 0;

  for (let i = 0; i < outCount; i++) {
    state[wt[outBase + i]] = i === sel ? value : 0;
  }
}

// ---------------------------------------------------------------------------
// DEMUX_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const DEMUX_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
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

const DEMUX_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "selectorBits",
    type: PropertyType.INT,
    label: "Selector Bits",
    defaultValue: 1,
    min: 1,
    max: 4,
    description: "Number of selector bits (determines number of outputs: 2^selectorBits)",
  },
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of each data signal",
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
// DemuxDefinition
// ---------------------------------------------------------------------------

function demuxFactory(props: PropertyBag): DemuxElement {
  return new DemuxElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const DemuxDefinition: ComponentDefinition = {
  name: "Demultiplexer",
  typeId: -1,
  factory: demuxFactory,
  executeFn: executeDemux,
  pinLayout: buildDemuxPinDeclarations(1, 1),
  propertyDefs: DEMUX_PROPERTY_DEFS,
  attributeMap: DEMUX_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "Demultiplexer — routes one input to one of N outputs based on selector.\n" +
    "Selected output = input, all others = 0. N = 2^selectorBits.",
};
