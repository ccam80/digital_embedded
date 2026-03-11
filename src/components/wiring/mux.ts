/**
 * Multiplexer component — selects one of N inputs based on selector bits.
 * Output = input[selector].
 *
 * Properties:
 *   - selectorBits: number of selector bits (default 1, gives 2 inputs)
 *   - bitWidth: bit width of data signals (default 1)
 *
 * Pin layout (pin index order):
 *   0: sel (input, selectorBits wide)
 *   1..2^selectorBits: in_0 .. in_(N-1) (inputs, bitWidth wide)
 *   last: out (output, bitWidth wide)
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

const COMP_WIDTH = 2;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

export function buildMuxPinDeclarations(
  selectorBits: number,
  bitWidth: number,
  flipSelPos = false,
): PinDeclaration[] {
  const inputCount = 1 << selectorBits;

  // Selector pin: bottom center at (1, inputCount)
  const selPin: PinDeclaration = {
    direction: PinDirection.INPUT,
    label: "sel",
    defaultBitWidth: selectorBits,
    position: { x: 1, y: flipSelPos ? 0 : inputCount },
    isNegatable: false,
    isClockCapable: false,
  };

  // Data input pins: left side
  // Special case for 2 inputs: pins at (0,0) and (0,2) — gap at middle
  const inputPins: PinDeclaration[] = [];
  if (inputCount === 2) {
    inputPins.push({
      direction: PinDirection.INPUT,
      label: "in_0",
      defaultBitWidth: bitWidth,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    });
    inputPins.push({
      direction: PinDirection.INPUT,
      label: "in_1",
      defaultBitWidth: bitWidth,
      position: { x: 0, y: 2 },
      isNegatable: false,
      isClockCapable: false,
    });
  } else {
    for (let i = 0; i < inputCount; i++) {
      inputPins.push({
        direction: PinDirection.INPUT,
        label: `in_${i}`,
        defaultBitWidth: bitWidth,
        position: { x: 0, y: i },
        isNegatable: false,
        isClockCapable: false,
      });
    }
  }

  // Output pin: right side, vertically centered at (2, floor(inputCount/2))
  const outPin: PinDeclaration = {
    direction: PinDirection.OUTPUT,
    label: "out",
    defaultBitWidth: bitWidth,
    position: { x: 2, y: Math.floor(inputCount / 2) },
    isNegatable: false,
    isClockCapable: false,
  };

  return [selPin, ...inputPins, outPin];
}

// ---------------------------------------------------------------------------
// MuxElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class MuxElement extends AbstractCircuitElement {
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
    super("Multiplexer", instanceId, position, rotation, mirror, props);

    this._selectorBits = props.getOrDefault<number>("selectorBits", 1);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);

    const flipSelPos = props.getOrDefault<boolean>("flipSelPos", false);
    const decls = buildMuxPinDeclarations(this._selectorBits, this._bitWidth, flipSelPos);
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
    const inputCount = 1 << this._selectorBits;
    // Height spans from y=0 to y=inputCount (selector pin is at bottom)
    // For 2 inputs the bottom pin is at y=2, so height = inputCount
    return {
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: inputCount,
    };
  }

  draw(ctx: RenderContext): void {
    const inputCount = 1 << this._selectorBits;
    // h is the span used for the trapezoid body (inputCount grid units)
    const h = inputCount;

    ctx.save();

    // Trapezoid: (0,-0.2) -> (2,0.25) -> (2,h-0.25) -> (0,h+0.2)
    const poly = [
      { x: 0, y: -0.2 },
      { x: COMP_WIDTH, y: 0.25 },
      { x: COMP_WIDTH, y: h - 0.25 },
      { x: 0, y: h + 0.2 },
    ];

    ctx.setColor("COMPONENT_FILL");
    ctx.drawPolygon(poly, true);

    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPolygon(poly, false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.0, weight: "bold" });
    ctx.drawText("MUX", COMP_WIDTH / 2, h / 2, {
      horizontal: "center",
      vertical: "middle",
    });

    ctx.restore();
  }

  getHelpText(): string {
    const inputCount = 1 << this._selectorBits;
    return (
      `Multiplexer — selects one of ${inputCount} inputs based on the selector.\n` +
      `Output = input[selector].\n` +
      `Selector bits: ${this._selectorBits}, data bit width: ${this._bitWidth}.`
    );
  }
}

// ---------------------------------------------------------------------------
// executeMux — flat simulation function
//
// Pin layout in state array (matching buildMuxPinDeclarations order):
//   input 0: sel
//   inputs 1..N: in_0..in_(N-1)
//   output 0: out
// ---------------------------------------------------------------------------

export function executeMux(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outIdx = layout.outputOffset(index);

  const sel = state[wt[inBase]] >>> 0;
  // input 0 is sel, data inputs start at inBase+1
  const dataBase = inBase + 1;
  state[wt[outIdx]] = state[wt[dataBase + sel]] >>> 0;
}

// ---------------------------------------------------------------------------
// MUX_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const MUX_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
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
  {
    xmlName: "flipSelPos",
    propertyKey: "flipSelPos",
    convert: (v) => v === "true",
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const MUX_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "selectorBits",
    type: PropertyType.INT,
    label: "Selector Bits",
    defaultValue: 1,
    min: 1,
    max: 4,
    description: "Number of selector bits (determines number of inputs: 2^selectorBits)",
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
  {
    key: "flipSelPos",
    type: PropertyType.BOOLEAN,
    label: "Flip Selector Position",
    defaultValue: false,
    description: "When true, selector pin is at top instead of bottom",
  },
];

// ---------------------------------------------------------------------------
// MuxDefinition
// ---------------------------------------------------------------------------

function muxFactory(props: PropertyBag): MuxElement {
  return new MuxElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const MuxDefinition: ComponentDefinition = {
  name: "Multiplexer",
  typeId: -1,
  factory: muxFactory,
  executeFn: executeMux,
  pinLayout: buildMuxPinDeclarations(1, 1, false),
  propertyDefs: MUX_PROPERTY_DEFS,
  attributeMap: MUX_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "Multiplexer — selects one of N inputs based on selector bits.\n" +
    "Output = input[selector]. N = 2^selectorBits.",
};
