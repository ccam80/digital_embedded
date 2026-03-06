/**
 * Monoflop — monostable multivibrator.
 *
 * On rising edge of C: Q goes high and stays high for `timerDelay` clock ticks.
 * After timerDelay ticks, Q returns to low.
 * R (reset) input immediately forces Q=0 and resets the counter.
 *
 * Ported from ref/Digital/src/main/java/de/neemann/digital/core/flipflops/Monoflop.java
 *
 * Input layout:  [C=0, R=1]
 * Output layout: [Q=0, ~Q=1]
 * State layout:  [storedQ=0, prevClock=1, counter=2]
 *   - storedQ:   current output value (0 or 1)
 *   - prevClock: previous clock value for edge detection
 *   - counter:   remaining ticks before Q returns to low (0 = inactive)
 *
 * The counter is decremented each time executeMonoflop is called while Q=1.
 * The caller (engine clock tick) is responsible for calling executeMonoflop
 * once per clock cycle.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
  createInverterConfig,
  createClockConfig,
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
// Pin declarations
// ---------------------------------------------------------------------------

const MONOFLOP_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "C",
    defaultBitWidth: 1,
    position: { x: 0, y: 1 },
    isNegatable: false,
    isClockCapable: true,
  },
  {
    direction: PinDirection.INPUT,
    label: "R",
    defaultBitWidth: 1,
    position: { x: 0, y: 3 },
    isNegatable: true,
    isClockCapable: false,
  },
  {
    direction: PinDirection.OUTPUT,
    label: "Q",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 1 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.OUTPUT,
    label: "~Q",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 3 },
    isNegatable: false,
    isClockCapable: false,
  },
];

// ---------------------------------------------------------------------------
// MonoflopElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class MonoflopElement extends AbstractCircuitElement {
  private readonly _timerDelay: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Monoflop", instanceId, position, rotation, mirror, props);
    this._timerDelay = props.getOrDefault<number>("timerDelay", 1);
    this._pins = resolvePins(
      MONOFLOP_PIN_DECLARATIONS,
      position,
      rotation,
      createInverterConfig([]),
      createClockConfig(["C"]),
      1,
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
    ctx.drawText("C", 0.5, 1, { horizontal: "left", vertical: "middle" });
    ctx.drawText("R", 0.5, 3, { horizontal: "left", vertical: "middle" });
    ctx.drawText("Q", COMP_WIDTH - 0.5, 1, { horizontal: "right", vertical: "middle" });
    ctx.drawText("~Q", COMP_WIDTH - 0.5, 3, { horizontal: "right", vertical: "middle" });

    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText("mono", COMP_WIDTH / 2, COMP_HEIGHT / 2, { horizontal: "center", vertical: "middle" });

    ctx.setColor("COMPONENT");
    ctx.drawLine(0, 0.5, 0.5, 1);
    ctx.drawLine(0.5, 1, 0, 1.5);

    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 1.0 });
      ctx.drawText(label, COMP_WIDTH / 2, -0.5, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Monoflop — monostable multivibrator.\n" +
      "On rising edge of C: Q goes high for timerDelay clock cycles, then returns low.\n" +
      "R (reset) immediately forces Q=0 and cancels any active pulse."
    );
  }
}

// ---------------------------------------------------------------------------
// executeMonoflop — flat simulation function
//
// Input layout:  [C=0, R=1]
// Output layout: [Q=0, ~Q=1]
// State layout:  [storedQ=0, prevClock=1, counter=2]
//
// The timerDelay is read from layout.propertyOf(index, "timerDelay") if the
// engine supports it, otherwise defaults to 1. In practice, the engine
// provides timerDelay via the compiled component's property slot — accessed
// here via the stateOffset extended layout interface.
//
// Pulse timing:
//   - On rising C edge: set storedQ=1, counter=timerDelay
//   - On each call while counter>0: decrement counter; when reaches 0, set storedQ=0
//   - R=1 at any time: reset storedQ=0, counter=0
// ---------------------------------------------------------------------------

export function executeMonoflop(index: number, state: Uint32Array, layout: ComponentLayout): void {
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const extLayout = layout as unknown as {
    stateOffset(i: number): number;
    getProperty?(i: number, key: string): number;
  };
  const stBase = extLayout.stateOffset(index);

  const clock = state[inBase];
  const reset = state[inBase + 1];
  const prevClock = state[stBase + 1];

  if (reset !== 0) {
    state[stBase] = 0;
    state[stBase + 2] = 0;
  } else if (clock !== 0 && prevClock === 0) {
    const timerDelay = extLayout.getProperty ? extLayout.getProperty(index, "timerDelay") : 1;
    state[stBase] = 1;
    state[stBase + 2] = timerDelay;
  } else if (state[stBase + 2] > 0) {
    state[stBase + 2] -= 1;
    if (state[stBase + 2] === 0) {
      state[stBase] = 0;
    }
  }

  state[stBase + 1] = clock;

  const q = state[stBase];
  state[outBase] = q;
  state[outBase + 1] = q !== 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// MONOFLOP_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const MONOFLOP_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "Delay", propertyKey: "timerDelay", convert: (v) => parseInt(v, 10) },
  { xmlName: "inverterConfig", propertyKey: "_inverterLabels", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const MONOFLOP_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "timerDelay",
    type: PropertyType.INT,
    label: "Delay",
    defaultValue: 1,
    min: 1,
    max: 1000,
    description: "Number of clock cycles Q stays high after trigger",
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
// MonoflopDefinition — ComponentDefinition
// ---------------------------------------------------------------------------

function monoflopFactory(props: PropertyBag): MonoflopElement {
  return new MonoflopElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const MonoflopDefinition: ComponentDefinition = {
  name: "Monoflop",
  typeId: -1,
  factory: monoflopFactory,
  executeFn: executeMonoflop,
  pinLayout: MONOFLOP_PIN_DECLARATIONS,
  propertyDefs: MONOFLOP_PROPERTY_DEFS,
  attributeMap: MONOFLOP_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.FLIP_FLOPS,
  helpText:
    "Monoflop — monostable multivibrator.\n" +
    "On rising edge of C: Q goes high for timerDelay clock cycles, then returns low.\n" +
    "R (reset) immediately forces Q=0 and cancels any active pulse.",
  defaultDelay: 10,
};
