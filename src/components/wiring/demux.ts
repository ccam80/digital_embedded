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

export function buildDemuxPinDeclarations(
  selectorBits: number,
  bitWidth: number,
): PinDeclaration[] {
  const outputCount = 1 << selectorBits;
  const h = componentHeight(outputCount);

  const selPin: PinDeclaration = {
    direction: PinDirection.INPUT,
    label: "sel",
    defaultBitWidth: selectorBits,
    position: { x: Math.floor(COMP_WIDTH / 2), y: h },
    isNegatable: false,
    isClockCapable: false,
  };

  const inputPositions = layoutPinsOnFace("west", 1, COMP_WIDTH, h);
  const inPin: PinDeclaration = {
    direction: PinDirection.INPUT,
    label: "in",
    defaultBitWidth: bitWidth,
    position: inputPositions[0],
    isNegatable: false,
    isClockCapable: false,
  };

  const outputPositions = layoutPinsOnFace("east", outputCount, COMP_WIDTH, h);
  const outputPins: PinDeclaration[] = [];
  for (let i = 0; i < outputCount; i++) {
    outputPins.push({
      direction: PinDirection.OUTPUT,
      label: `out_${i}`,
      defaultBitWidth: bitWidth,
      position: outputPositions[i],
      isNegatable: false,
      isClockCapable: false,
    });
  }

  return [selPin, inPin, ...outputPins];
}

// ---------------------------------------------------------------------------
// DemuxElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class DemuxElement extends AbstractCircuitElement {
  private readonly _selectorBits: number;
  private readonly _bitWidth: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Demultiplexer", instanceId, position, rotation, mirror, props);

    this._selectorBits = props.getOrDefault<number>("selectorBits", 1);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);

    const decls = buildDemuxPinDeclarations(this._selectorBits, this._bitWidth);
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
    ctx.drawPolygon(
      [
        { x: 0, y: 1 },
        { x: COMP_WIDTH, y: 0 },
        { x: COMP_WIDTH, y: h },
        { x: 0, y: h - 1 },
      ],
      true,
    );

    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPolygon(
      [
        { x: 0, y: 1 },
        { x: COMP_WIDTH, y: 0 },
        { x: COMP_WIDTH, y: h },
        { x: 0, y: h - 1 },
      ],
      false,
    );

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.0, weight: "bold" });
    ctx.drawText("DEMUX", COMP_WIDTH / 2, h / 2, {
      horizontal: "center",
      vertical: "middle",
    });

    ctx.restore();
  }

  getHelpText(): string {
    const outputCount = 1 << this._selectorBits;
    return (
      `Demultiplexer — routes input to one of ${outputCount} outputs based on selector.\n` +
      `Selected output = input, all others = 0.\n` +
      `Selector bits: ${this._selectorBits}, data bit width: ${this._bitWidth}.`
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
