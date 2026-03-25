/**
 * Out component — display component showing the current signal value.
 *
 * Reads its input and stores it for display. Supports configurable radix
 * (binary, decimal, hexadecimal).
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
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

// ---------------------------------------------------------------------------
// Radix type
// ---------------------------------------------------------------------------

export type IntFormat = "bin" | "dec" | "hex" | "oct";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 2;

// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------

export function formatValue(value: number, bitWidth: number, format: IntFormat): string {
  const unsigned = value >>> 0;
  switch (format) {
    case "bin": {
      const bits = unsigned.toString(2).padStart(bitWidth, "0");
      return `0b${bits}`;
    }
    case "hex": {
      const hexDigits = Math.ceil(bitWidth / 4);
      return `0x${unsigned.toString(16).toUpperCase().padStart(hexDigits, "0")}`;
    }
    case "oct":
      return `0o${unsigned.toString(8)}`;
    case "dec":
    default:
      return unsigned.toString(10);
  }
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildOutPinDeclarations(bitWidth: number): PinDeclaration[] {
  // Pin at (0, 0) — matching Digital's OutputShape where pin is at component origin y=0.
  // The body is drawn centered around y=0.
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: bitWidth,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// OutElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class OutElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Out", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const decls = buildOutPinDeclarations(bitWidth);
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    // Circles at cx=0.8 r=0.75: minX = 0.8-0.75, maxX = 0.8+0.75, minY = -0.75, maxY = 0.75.
    // Use cx-r and cx+r arithmetic to match ellipseSegments cardinal sentinel values exactly.
    const cx = 0.8, r = 0.75;
    return {
      x: this.position.x + (cx - r),
      y: this.position.y - r,
      width: 2 * r,
      height: 2 * r,
    };
  }

  get format(): IntFormat {
    return this._properties.getOrDefault<string>("intFormat", "hex") as IntFormat;
  }

  draw(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");

    ctx.save();

    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    // Outer circle at (0.8, 0) r=0.75
    ctx.drawCircle(0.8, 0, 0.75, false);
    // Inner circle at (0.8, 0) r=0.45
    ctx.drawCircle(0.8, 0, 0.45, false);

    // Label to the right
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    drawUprightText(ctx, label, 2.25, 0, {
      horizontal: "left",
      vertical: "middle",
    }, this.rotation);

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Out — output display component.\n" +
      "Shows the current value of the connected signal.\n" +
      "Configurable display radix: binary, decimal, hexadecimal, octal."
    );
  }
}

// ---------------------------------------------------------------------------
// executeOut — reads input, copies to output slot for display
// ---------------------------------------------------------------------------

export function executeOut(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inputIdx = layout.inputOffset(index);
  const outputIdx = layout.outputOffset(index);
  state[wt[outputIdx]] = state[wt[inputIdx]];
}

// ---------------------------------------------------------------------------
// OUT_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const OUT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "intFormat",
    propertyKey: "intFormat",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const OUT_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Label shown on the component",
  },
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of the input signal",
  },
  {
    key: "intFormat",
    type: PropertyType.INTFORMAT,
    label: "Display format",
    defaultValue: "hex",
    enumValues: ["bin", "dec", "hex", "oct"],
    description: "Radix for displaying the signal value",
  },
];

// ---------------------------------------------------------------------------
// OutDefinition
// ---------------------------------------------------------------------------

function outFactory(props: PropertyBag): OutElement {
  return new OutElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const OutDefinition: ComponentDefinition = {
  name: "Out",
  typeId: -1,
  factory: outFactory,
  pinLayout: buildOutPinDeclarations(1),
  propertyDefs: OUT_PROPERTY_DEFS,
  attributeMap: OUT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "Out — output display component.\n" +
    "Shows the current value of the connected signal.\n" +
    "Configurable display radix: binary, decimal, hexadecimal, octal.",
  models: {
    digital: { executeFn: executeOut, inputSchema: ["in"], outputSchema: [] },
  },
};
