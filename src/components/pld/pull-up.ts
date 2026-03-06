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
import { PinDirection, resolvePins, createInverterConfig } from "../../core/pin.js";
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

const COMP_WIDTH = 1;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildPullUpPinDeclarations(bitWidth: number): PinDeclaration[] {
  return [
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: bitWidth,
      position: { x: 0, y: COMP_HEIGHT },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// PullUpElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class PullUpElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PullUp", instanceId, position, rotation, mirror, props);

    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);

    const decls = buildPullUpPinDeclarations(this._bitWidth);
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
      this._bitWidth,
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
    ctx.save();

    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // VDD rail (top horizontal bar)
    ctx.drawLine(-0.4, 0, 0.4, 0);

    // Resistor body (zigzag from y=0 to y=1.4)
    ctx.drawPath({
      operations: [
        { op: "moveTo", x: 0, y: 0 },
        { op: "lineTo", x: 0, y: 0.2 },
        { op: "lineTo", x: 0.3, y: 0.35 },
        { op: "lineTo", x: -0.3, y: 0.55 },
        { op: "lineTo", x: 0.3, y: 0.75 },
        { op: "lineTo", x: -0.3, y: 0.95 },
        { op: "lineTo", x: 0.3, y: 1.15 },
        { op: "lineTo", x: 0, y: 1.3 },
        { op: "lineTo", x: 0, y: COMP_HEIGHT },
      ],
    });

    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, 0.6, COMP_HEIGHT / 2, { horizontal: "left", vertical: "middle" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "PullUp — pulls a floating net to logic 1.\n" +
      "Connects a resistor from VDD to the output net.\n" +
      "When no active-low driver overrides, the net reads as logic 1.\n" +
      "Used in open-drain / wired-AND configurations."
    );
  }
}

// ---------------------------------------------------------------------------
// executePullUp — flat simulation function
//
// Writes all-ones mask for the configured bit width.
// The bus resolver gives priority to active drivers; this value is used
// only when the net is otherwise floating.
// ---------------------------------------------------------------------------

export function executePullUp(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const outputIdx = layout.outputOffset(index);
  state[outputIdx] = 0xFFFFFFFF;
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
  executeFn: executePullUp,
  pinLayout: buildPullUpPinDeclarations(1),
  propertyDefs: PULL_UP_PROPERTY_DEFS,
  attributeMap: PULL_UP_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PLD,
  helpText:
    "PullUp — pulls a floating net to logic 1.\n" +
    "Connects a resistor from VDD to the output net.\n" +
    "When no active-low driver overrides, the net reads as logic 1.",
  defaultDelay: 0,
};
