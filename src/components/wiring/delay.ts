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
const COMP_HEIGHT = 3;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

export function buildDelayPinDeclarations(bitWidth: number): PinDeclaration[] {
  const inPin: PinDeclaration = {
    direction: PinDirection.INPUT,
    label: "in",
    defaultBitWidth: bitWidth,
    position: { x: 0, y: Math.floor(COMP_HEIGHT / 2) },
    isNegatable: false,
    isClockCapable: false,
  };

  const outPin: PinDeclaration = {
    direction: PinDirection.OUTPUT,
    label: "out",
    defaultBitWidth: bitWidth,
    position: { x: COMP_WIDTH, y: Math.floor(COMP_HEIGHT / 2) },
    isNegatable: false,
    isClockCapable: false,
  };

  return [inPin, outPin];
}

// ---------------------------------------------------------------------------
// DelayElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class DelayElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _delayTime: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Delay", instanceId, position, rotation, mirror, props);

    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    this._delayTime = props.getOrDefault<number>("delayTime", 1);

    const decls = buildDelayPinDeclarations(this._bitWidth);
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

    ctx.save();

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.9, weight: "bold" });
    ctx.drawText(`D${this._delayTime}`, COMP_WIDTH / 2, COMP_HEIGHT / 2, {
      horizontal: "center",
      vertical: "middle",
    });

    ctx.restore();
  }

  getHelpText(): string {
    return (
      `Delay — passes input to output with a delay of ${this._delayTime} gate-delay units.\n` +
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
  helpText:
    "Delay — pass-through with configurable propagation delay.\n" +
    "In timed mode: output changes after delayTime gate-delay units.",
};
