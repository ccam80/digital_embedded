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
} from "../../core/pin.js";
import { PropertyBag, PropertyType, LABEL_PROPERTY_DEF } from "../../core/properties.js";
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

// Java BitSelShape: width=2, in@(0,0), sel@(1,flip?-1:1), out@(2,0)
const COMP_WIDTH = 2;
const COMP_HEIGHT = 1;

// ---------------------------------------------------------------------------
// Pin layout — y-positions shifted down by 1 from previous layout
// ---------------------------------------------------------------------------

export function buildBitSelectorPinDeclarations(selectorBits: number): PinDeclaration[] {
  const dataBits = 1 << selectorBits;

  const inPin: PinDeclaration = {
    direction: PinDirection.INPUT,
    label: "in",
    defaultBitWidth: dataBits,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  };

  const selPin: PinDeclaration = {
    direction: PinDirection.INPUT,
    label: "sel",
    defaultBitWidth: selectorBits,
    position: { x: 1, y: 1 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  };

  const outPin: PinDeclaration = {
    direction: PinDirection.OUTPUT,
    label: "out",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  };

  return [inPin, selPin, outPin];
}

// ---------------------------------------------------------------------------
// BitSelectorElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class BitSelectorElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("BitSelector", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const selectorBits = this._properties.getOrDefault<number>("selectorBits", 3);
    return this.derivePins(buildBitSelectorPinDeclarations(selectorBits));
  }

  getBoundingBox(): Rect {
    // Trapezoid: (0.05,-1.2) -> (1.95,-0.75) -> (1.95,0.75) -> (0.05,1.2).
    // MinX=0.05, maxX=1.95, minY=-1.2, maxY=1.2.
    return {
      x: this.position.x + 0.05,
      y: this.position.y - 1.2,
      width: 1.9,
      height: 2.4,
    };
  }

  draw(ctx: RenderContext): void {
    // Java BitSelShape trapezoid: wider on left, narrower on right.
    // Exact Java coords: (0.05,-1.2)→(1.95,-0.75)→(1.95,0.75)→(0.05,1.2)
    const poly = [
      { x: 0.05, y: -1.2 },
      { x: 1.95, y: -0.75 },
      { x: 1.95, y: 0.75 },
      { x: 0.05, y: 1.2 },
    ];

    ctx.save();

    ctx.setColor("COMPONENT_FILL");
    ctx.drawPolygon(poly, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPolygon(poly, false);

    ctx.restore();
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
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outIdx = layout.outputOffset(index);

  const value = state[wt[inBase]] >>> 0;
  const sel = state[wt[inBase + 1]] >>> 0;

  state[wt[outIdx]] = (value >>> sel) & 1;
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
  LABEL_PROPERTY_DEF,
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
  pinLayout: buildBitSelectorPinDeclarations(3),
  propertyDefs: BIT_SELECTOR_PROPERTY_DEFS,
  attributeMap: BIT_SELECTOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "BitSelector — selects a single bit from a multi-bit input.\n" +
    "Output = (input >> selector) & 1.",
  models: {
    digital: {
      executeFn: executeBitSelector,
      inputSchema: ["in", "sel"],
      outputSchema: ["out"],
    },
  },
};
