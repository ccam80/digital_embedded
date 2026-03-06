/**
 * PullDown component — pulls a floating net to logic 0.
 *
 * In Digital, PullDown is "only a placeholder. Has no connections to the model!"
 * Its effect is declared via a PullResistor annotation on the output pin.
 * The bus resolution layer (Phase 3) reads the pull-resistor flag and applies
 * the default value when no other driver is active on the net.
 *
 * executeFn: writes zero to the output slot. The bus resolver combines this
 * with other drivers using wired-OR priority: active-high driver wins over pull-down.
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

function buildPullDownPinDeclarations(bitWidth: number): PinDeclaration[] {
  return [
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: bitWidth,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// PullDownElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class PullDownElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PullDown", instanceId, position, rotation, mirror, props);

    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);

    const decls = buildPullDownPinDeclarations(this._bitWidth);
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

    // GND rail (bottom horizontal bar)
    ctx.drawLine(-0.4, COMP_HEIGHT, 0.4, COMP_HEIGHT);

    // Resistor body (zigzag from y=0 to y=1.8)
    ctx.drawPath({
      operations: [
        { op: "moveTo", x: 0, y: 0 },
        { op: "lineTo", x: 0, y: 0.7 },
        { op: "lineTo", x: 0.3, y: 0.85 },
        { op: "lineTo", x: -0.3, y: 1.05 },
        { op: "lineTo", x: 0.3, y: 1.25 },
        { op: "lineTo", x: -0.3, y: 1.45 },
        { op: "lineTo", x: 0.3, y: 1.65 },
        { op: "lineTo", x: 0, y: 1.8 },
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
      "PullDown — pulls a floating net to logic 0.\n" +
      "Connects a resistor from GND to the output net.\n" +
      "When no active-high driver overrides, the net reads as logic 0.\n" +
      "Used in open-collector / wired-OR configurations."
    );
  }
}

// ---------------------------------------------------------------------------
// executePullDown — flat simulation function
//
// Writes zero to the output slot.
// The bus resolver gives priority to active drivers; this value is used
// only when the net is otherwise floating.
// ---------------------------------------------------------------------------

export function executePullDown(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const outputIdx = layout.outputOffset(index);
  state[outputIdx] = 0;
}

// ---------------------------------------------------------------------------
// PULL_DOWN_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const PULL_DOWN_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
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

const PULL_DOWN_PROPERTY_DEFS: PropertyDefinition[] = [
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
// PullDownDefinition
// ---------------------------------------------------------------------------

function pullDownFactory(props: PropertyBag): PullDownElement {
  return new PullDownElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const PullDownDefinition: ComponentDefinition = {
  name: "PullDown",
  typeId: -1,
  factory: pullDownFactory,
  executeFn: executePullDown,
  pinLayout: buildPullDownPinDeclarations(1),
  propertyDefs: PULL_DOWN_PROPERTY_DEFS,
  attributeMap: PULL_DOWN_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PLD,
  helpText:
    "PullDown — pulls a floating net to logic 0.\n" +
    "Connects a resistor from GND to the output net.\n" +
    "When no active-high driver overrides, the net reads as logic 0.",
  defaultDelay: 0,
};
