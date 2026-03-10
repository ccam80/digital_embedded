/**
 * BusSplitter component — variant of Splitter with different visual representation.
 *
 * Functionally identical to Splitter but rendered as a box with labeled ports
 * rather than the diagonal-line splitter symbol. Used when the bus layout
 * needs to be visually distinct from the standard Splitter.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
  createInverterConfig,
  resolvePins,
} from "../../core/pin.js";
import { drawUprightText } from "../../core/upright-text.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import {
  parseSplittingPattern,
  totalBitsFromPattern,
  extractBits,
} from "./splitter.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 2;

function componentHeight(partCount: number): number {
  return Math.max(partCount * 2, 2);
}

// ---------------------------------------------------------------------------
// BusSplitterElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class BusSplitterElement extends AbstractCircuitElement {
  private readonly _outputSplitting: string;
  private readonly _parts: number[];
  private readonly _totalBits: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("BusSplitter", instanceId, position, rotation, mirror, props);

    this._outputSplitting = props.getOrDefault<string>("output splitting", "4,4");
    this._parts = parseSplittingPattern(this._outputSplitting);
    this._totalBits = totalBitsFromPattern(this._parts);

    // Java BusSplitterShape pin layout:
    //   output[0] (combined bus out): (0, 0)
    //   input[0]  (combined bus in):  (0, 1)
    //   output[1..n] (sub-buses):     (1, i * spreading)
    const spreading = props.getOrDefault<number>("spreading", 1);
    const totalName = this._totalBits === 1 ? "0" : `0-${this._totalBits - 1}`;
    const decls: PinDeclaration[] = [
      { direction: PinDirection.OUTPUT, label: totalName, defaultBitWidth: this._totalBits,
        position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
      { direction: PinDirection.INPUT, label: totalName, defaultBitWidth: this._totalBits,
        position: { x: 0, y: 1 }, isNegatable: false, isClockCapable: false },
    ];
    let runPos = 0;
    for (let i = 0; i < this._parts.length; i++) {
      const bits = this._parts[i];
      const name = bits === 1 ? `${runPos}` : `${runPos}-${runPos + bits - 1}`;
      decls.push({
        direction: PinDirection.OUTPUT, label: name, defaultBitWidth: bits,
        position: { x: 1, y: i * spreading }, isNegatable: false, isClockCapable: false,
      });
      runPos += bits;
    }
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
    );
  }

  get parts(): number[] {
    return this._parts;
  }

  get totalBits(): number {
    return this._totalBits;
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    const h = componentHeight(this._parts.length);
    return {
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: h,
    };
  }

  draw(ctx: RenderContext): void {
    const h = componentHeight(this._parts.length);

    ctx.save();

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, h, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, h, false);

    // Label showing total bit width
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    drawUprightText(ctx, `${this._totalBits}`, COMP_WIDTH / 2, h / 2, {
      horizontal: "center",
      vertical: "middle",
    }, this.rotation);

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "BusSplitter — bus splitter with box representation.\n" +
      `Splitting pattern: ${this._outputSplitting} (total ${this._totalBits} bits).`
    );
  }
}

// ---------------------------------------------------------------------------
// executeBusSplitter — identical logic to Splitter
// ---------------------------------------------------------------------------

export function executeBusSplitter(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const outCount = layout.outputCount(index);

  const wideValue = state[wt[inBase]];

  let startBit = 0;
  for (let i = 0; i < outCount; i++) {
    state[wt[outBase + i]] = extractBits(wideValue, startBit, 1);
    startBit += 1;
  }
}

// ---------------------------------------------------------------------------
// BUS_SPLITTER_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const BUS_SPLITTER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "input splitting",
    propertyKey: "input splitting",
    convert: (v) => v,
  },
  {
    xmlName: "output splitting",
    propertyKey: "output splitting",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const BUS_SPLITTER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "output splitting",
    type: PropertyType.STRING,
    label: "Output Splitting",
    defaultValue: "4,4",
    description: "Comma-separated bit widths for each narrow port",
  },
  {
    key: "input splitting",
    type: PropertyType.STRING,
    label: "Input Splitting",
    defaultValue: "",
    description: "Input splitting pattern",
  },
];

// ---------------------------------------------------------------------------
// BusSplitterDefinition
// ---------------------------------------------------------------------------

function busSplitterFactory(props: PropertyBag): BusSplitterElement {
  return new BusSplitterElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const BusSplitterDefinition: ComponentDefinition = {
  name: "BusSplitter",
  typeId: -1,
  factory: busSplitterFactory,
  executeFn: executeBusSplitter,
  pinLayout: [
    { direction: PinDirection.OUTPUT, label: "0-7", defaultBitWidth: 8, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "0-7", defaultBitWidth: 8, position: { x: 0, y: 1 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "0-3", defaultBitWidth: 4, position: { x: 1, y: 0 }, isNegatable: false, isClockCapable: false },
    { direction: PinDirection.OUTPUT, label: "4-7", defaultBitWidth: 4, position: { x: 1, y: 1 }, isNegatable: false, isClockCapable: false },
  ],
  propertyDefs: BUS_SPLITTER_PROPERTY_DEFS,
  attributeMap: BUS_SPLITTER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "BusSplitter — bus splitter with box representation.\n" +
    "Configure the splitting pattern as comma-separated bit widths.",
};
