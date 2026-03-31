/**
 * PullUp component — pulls a floating net to logic 1.
 *
 * In Digital, PullUp is "only a placeholder. Has no connections to the model!"
 * Its effect is declared via a PullResistor annotation on the output pin.
 * The bus resolution layer (Phase 3) reads the pull-resistor flag and applies
 * the default value when no other driver is active on the net.
 *
 * executeFn: writes all-ones to the output slot. The bus resolver combines this
 * with other drivers using wired-OR priority: active-low driver wins over pull-up.
 *
 * Properties:
 *   bitWidth — width of the net being pulled (default 1)
 *   label    — optional label shown near the component
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
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


// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildPullUpPinDeclarations(bitWidth: number): PinDeclaration[] {
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
// PullUpElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class PullUpElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PullUp", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    return this.derivePins(buildPullUpPinDeclarations(bitWidth), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x - 0.5,
      y: this.position.y - 2.45,
      width: 1,
      height: 2.45,
    };
  }

  draw(ctx: RenderContext): void {
    ctx.save();

    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Pin at (0,0). Everything above is negative y.
    // Java PullUpShape:
    //   Resistor body rectangle: (-0.35,-0.05) -> (-0.35,-1.3) -> (0.35,-1.3) -> (0.35,-0.05)
    //   Lead line: (0,-1.3) to (0,-2.3)
    //   VDD triangle (open, upward): (-0.5,-1.8) -> (0,-2.45) -> (0.5,-1.8)

    // Resistor body (closed rectangle)
    ctx.drawRect(-0.35, -1.3, 0.7, 1.25, false);

    // Lead from top of resistor body up to VDD triangle base
    ctx.drawLine(0, -1.3, 0, -2.3);

    // VDD triangle (open polygon, upward pointing)
    ctx.drawPath({
      operations: [
        { op: "moveTo",  x: -0.5, y: -1.8 },
        { op: "lineTo",  x:  0,   y: -2.45 },
        { op: "lineTo",  x:  0.5, y: -1.8 },
      ],
    });

    const label = this._visibleLabel();
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, 0.6, -1.2, { horizontal: "left", vertical: "middle" });
    }

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executePullUp — flat simulation function
//
// Writes all-ones mask for the configured bit width.
// The bus resolver gives priority to active drivers; this value is used
// only when the net is otherwise floating.
// ---------------------------------------------------------------------------

export function executePullUp(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const outputIdx = layout.outputOffset(index);
  state[wt[outputIdx]] = 0xFFFFFFFF;
}

// ---------------------------------------------------------------------------
// PULL_UP_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const PULL_UP_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
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
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const PULL_UP_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of the pulled net",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown near the component",
  },
];

// ---------------------------------------------------------------------------
// PullUpDefinition
// ---------------------------------------------------------------------------

function pullUpFactory(props: PropertyBag): PullUpElement {
  return new PullUpElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const PullUpDefinition: ComponentDefinition = {
  name: "PullUp",
  typeId: -1,
  factory: pullUpFactory,
  pinLayout: buildPullUpPinDeclarations(1),
  propertyDefs: PULL_UP_PROPERTY_DEFS,
  attributeMap: PULL_UP_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PLD,
  helpText:
    "PullUp — pulls a floating net to logic 1.\n" +
    "Connects a resistor from VDD to the output net.\n" +
    "When no active-low driver overrides, the net reads as logic 1.",
  models: {
    digital: {
      executeFn: executePullUp,
      inputSchema: [],
      outputSchema: ["out"],
      defaultDelay: 0,
    },
  },
};
