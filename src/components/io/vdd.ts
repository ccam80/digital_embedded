/**
 * VDD component — always outputs all bits set to 1.
 *
 * executeFn writes a mask of all ones (based on bitWidth) to its output.
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
// Pin layout
// ---------------------------------------------------------------------------

function buildVddPinDeclarations(bitWidth: number): PinDeclaration[] {
  return [
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: bitWidth,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// VddElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class VddElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("VDD", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const decls = buildVddPinDeclarations(bitWidth);
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x - 0.5,
      y: this.position.y - 0.45,
      width: 1,
      height: 0.65,
    };
  }

  draw(ctx: RenderContext): void {
    ctx.save();

    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Upward-pointing triangle (open path, not closed): (-0.5,0.2) → (0,-0.45) → (0.5,0.2)
    // Java fixture: closed=false, style=NORMAL
    ctx.drawPath({
      operations: [
        { op: "moveTo", x: -0.5, y: 0.2 },
        { op: "lineTo", x: 0,    y: -0.45 },
        { op: "lineTo", x: 0.5,  y: 0.2 },
      ],
    }, false);

    // Vertical stem from triangle bottom to pin at (0,0)
    ctx.drawLine(0, -0.3, 0, 0);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executeVdd — writes all-ones mask to output (bit-width masked)
// ---------------------------------------------------------------------------

export function executeVdd(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  // Output all ones. The bit-width mask is applied by the net resolver;
  // writing 0xFFFFFFFF is correct for any width up to 32 bits.
  state[wt[layout.outputOffset(index)]] = 0xFFFFFFFF;
}

// ---------------------------------------------------------------------------
// VDD_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const VDD_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const VDD_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of the output signal",
  },
];

// ---------------------------------------------------------------------------
// VddDefinition
// ---------------------------------------------------------------------------

function vddFactory(props: PropertyBag): VddElement {
  return new VddElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const VddDefinition: ComponentDefinition = {
  name: "VDD",
  typeId: -1,
  factory: vddFactory,
  pinLayout: buildVddPinDeclarations(1),
  propertyDefs: VDD_PROPERTY_DEFS,
  attributeMap: VDD_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "VDD — always outputs logic 1 (all bits set).\n" +
    "Connects the net to the supply voltage in the simulation.\n" +
    "Configurable bit width.",
  models: {
    digital: { executeFn: executeVdd, inputSchema: [], outputSchema: ["out"] },
  },
  modelRegistry: {},
};
