/**
 * BitSelector component — selects a single bit from a multi-bit input.
 * Output = (input >> selector) & 1.
 *
 * The input width is 2^selectorBits, so selectorBits=3 → 8-bit input.
 *
 * Properties:
 *   - selectorBits: number of selector bits (default 3, gives 8-bit input)
 *
 * Pin layout:
 *   0: in (input, 2^selectorBits wide)
 *   1: sel (input, selectorBits wide)
 *   2: out (output, 1-bit)
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
const COMP_HEIGHT = 4;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

export function buildBitSelectorPinDeclarations(selectorBits: number): PinDeclaration[] {
  const dataBits = 1 << selectorBits;

  const inPin: PinDeclaration = {
    direction: PinDirection.INPUT,
    label: "in",
    defaultBitWidth: dataBits,
    position: { x: 0, y: 1 },
    isNegatable: false,
    isClockCapable: false,
  };

  const selPin: PinDeclaration = {
    direction: PinDirection.INPUT,
    label: "sel",
    defaultBitWidth: selectorBits,
    position: { x: 0, y: 3 },
    isNegatable: false,
    isClockCapable: false,
  };

  const outPin: PinDeclaration = {
    direction: PinDirection.OUTPUT,
    label: "out",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 2 },
    isNegatable: false,
    isClockCapable: false,
  };

  return [inPin, selPin, outPin];
}

// ---------------------------------------------------------------------------
// BitSelectorElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class BitSelectorElement extends AbstractCircuitElement {
  private readonly _selectorBits: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("BitSelector", instanceId, position, rotation, mirror, props);

    this._selectorBits = props.getOrDefault<number>("selectorBits", 3);

    const decls = buildBitSelectorPinDeclarations(this._selectorBits);
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
    return {
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    const { x, y } = this.position;

    ctx.save();
    ctx.translate(x, y);

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.9, weight: "bold" });
    ctx.drawText("BSel", COMP_WIDTH / 2, COMP_HEIGHT / 2, {
      horizontal: "center",
      vertical: "middle",
    });

    ctx.restore();
  }

  getHelpText(): string {
    const dataBits = 1 << this._selectorBits;
    return (
      `BitSelector — selects a single bit from a ${dataBits}-bit input.\n` +
      `Output = (input >> selector) & 1.\n` +
      `Selector bits: ${this._selectorBits}.`
    );
  }
}

// ---------------------------------------------------------------------------
// executeBitSelector — flat simulation function
//
// Pin layout in state array:
//   input 0: in (the wide data value)
//   input 1: sel (bit index to select)
//   output 0: out (selected bit, 0 or 1)
// ---------------------------------------------------------------------------

export function executeBitSelector(
  index: number,
  state: Uint32Array,
  layout: ComponentLayout,
): void {
  const inBase = layout.inputOffset(index);
  const outIdx = layout.outputOffset(index);

  const value = state[inBase] >>> 0;
  const sel = state[inBase + 1] >>> 0;

  state[outIdx] = (value >>> sel) & 1;
}

// ---------------------------------------------------------------------------
// BIT_SELECTOR_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const BIT_SELECTOR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
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

const BIT_SELECTOR_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "selectorBits",
    type: PropertyType.INT,
    label: "Selector Bits",
    defaultValue: 3,
    min: 1,
    max: 5,
    description: "Number of selector bits (input width = 2^selectorBits)",
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
// BitSelectorDefinition
// ---------------------------------------------------------------------------

function bitSelectorFactory(props: PropertyBag): BitSelectorElement {
  return new BitSelectorElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const BitSelectorDefinition: ComponentDefinition = {
  name: "BitSelector",
  typeId: -1,
  factory: bitSelectorFactory,
  executeFn: executeBitSelector,
  pinLayout: buildBitSelectorPinDeclarations(3),
  propertyDefs: BIT_SELECTOR_PROPERTY_DEFS,
  attributeMap: BIT_SELECTOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "BitSelector — selects a single bit from a multi-bit input.\n" +
    "Output = (input >> selector) & 1.",
};
