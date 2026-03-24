/**
 * Delay component — pass-through with configurable delay.
 *
 * In level-by-level simulation: passes input to output unchanged (combinational).
 * In timed simulation: the engine schedules the output change at currentTime + delayTime.
 * The executeFn implements the level-by-level (pass-through) behavior.
 *
 * Properties:
 *   - bitWidth: bit width of the signal (default 1)
 *   - delayTime: propagation delay in gate-delay units (default 1)
 *
 * Pin layout:
 *   0: in (input)
 *   1: out (output)
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
// Layout constants
// ---------------------------------------------------------------------------

// Java DelayShape: in(0,0), out(SIZE*2,0)=(2,0); SIZE=1 grid unit
const COMP_WIDTH = 2;
const COMP_HEIGHT = 1;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

export function buildDelayPinDeclarations(bitWidth: number): PinDeclaration[] {
  const inPin: PinDeclaration = {
    direction: PinDirection.INPUT,
    label: "in",
    defaultBitWidth: bitWidth,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  };

  const outPin: PinDeclaration = {
    direction: PinDirection.OUTPUT,
    label: "out",
    defaultBitWidth: bitWidth,
    position: { x: COMP_WIDTH, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  };

  return [inPin, outPin];
}

// ---------------------------------------------------------------------------
// DelayElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class DelayElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Delay", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    return this.derivePins(buildDelayPinDeclarations(bitWidth), []);
  }

  getBoundingBox(): Rect {
    // Rectangle polygon: (0.05,-0.5) to (1.95,0.5).
    return {
      x: this.position.x + 0.05,
      y: this.position.y - 0.5,
      width: 1.9,
      height: 1,
    };
  }

  draw(ctx: RenderContext): void {
    ctx.save();

    // Rectangle: (0.05,-0.5) → (1.95,0.5)
    ctx.setColor("COMPONENT_FILL");
    ctx.drawPolygon(
      [
        { x: 0.05, y: -0.5 },
        { x: 1.95, y: -0.5 },
        { x: 1.95, y: 0.5 },
        { x: 0.05, y: 0.5 },
      ],
      true,
    );
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPolygon(
      [
        { x: 0.05, y: -0.5 },
        { x: 1.95, y: -0.5 },
        { x: 1.95, y: 0.5 },
        { x: 0.05, y: 0.5 },
      ],
      false,
    );

    // Three THIN lines forming H-bar delay symbol
    ctx.setLineWidth(0.5); // THIN
    // Horizontal center bar
    ctx.drawLine(0.5, 0, 1.5, 0);
    // Left vertical serif
    ctx.drawLine(0.5, 0.25, 0.5, -0.25);
    // Right vertical serif
    ctx.drawLine(1.5, 0.25, 1.5, -0.25);

    ctx.restore();
  }

  getHelpText(): string {
    const delayTime = this._properties.getOrDefault<number>("delayTime", 1);
    return (
      `Delay — passes input to output with a delay of ${delayTime} gate-delay units.\n` +
      "In level-by-level mode: pass-through (no delay applied).\n" +
      "In timed mode: output is scheduled at currentTime + delayTime."
    );
  }
}

// ---------------------------------------------------------------------------
// executeDelay — flat simulation function (level-by-level: pass-through)
// ---------------------------------------------------------------------------

export function executeDelay(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inIdx = layout.inputOffset(index);
  const outIdx = layout.outputOffset(index);
  state[wt[outIdx]] = state[wt[inIdx]] >>> 0;
}

// ---------------------------------------------------------------------------
// DELAY_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const DELAY_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "DelayTime",
    propertyKey: "delayTime",
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

const DELAY_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of the signal",
  },
  {
    key: "delayTime",
    type: PropertyType.INT,
    label: "Delay Time",
    defaultValue: 1,
    min: 1,
    max: 64,
    description: "Propagation delay in gate-delay units",
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
// DelayDefinition
// ---------------------------------------------------------------------------

function delayFactory(props: PropertyBag): DelayElement {
  return new DelayElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const DelayDefinition: ComponentDefinition = {
  name: "Delay",
  typeId: -1,
  factory: delayFactory,
  executeFn: executeDelay,
  pinLayout: buildDelayPinDeclarations(1),
  propertyDefs: DELAY_PROPERTY_DEFS,
  attributeMap: DELAY_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  inputSchema: ["in"],
  outputSchema: ["out"],
  helpText:
    "Delay — pass-through with configurable propagation delay.\n" +
    "In timed mode: output changes after delayTime gate-delay units.",
};
