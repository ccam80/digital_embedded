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
} from "../../core/pin.js";
import { drawGenericShape } from "../generic-shape.js";
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

const COMP_WIDTH = 3;
// 2 inputs, 2 outputs, symmetric=false: offs=0, no even correction
// inputs: C@y=0, R@y=1; outputs: Q@y=0, ~Q@y=1
// max(2,2)=2, yBottom=(2-1)+0.5=1.5, height=1.5+0.5=2
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin declarations — GenericShape positions (symmetric=false, 2 inputs, 2 outputs)
// inputs: C@y=0, R@y=1
// outputs: Q@y=0, ~Q@y=1
// ---------------------------------------------------------------------------

const MONOFLOP_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "C",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: true,
    isClockCapable: true,
  },
  {
    direction: PinDirection.INPUT,
    label: "R",
    defaultBitWidth: 1,
    position: { x: 0, y: 1 },
    isNegatable: true,
    isClockCapable: false,
  },
  {
    direction: PinDirection.OUTPUT,
    label: "Q",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.OUTPUT,
    label: "~Q",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 1 },
    isNegatable: false,
    isClockCapable: false,
  },
];

// ---------------------------------------------------------------------------
// MonoflopElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class MonoflopElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Monoflop", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(MONOFLOP_PIN_DECLARATIONS, ["C"]);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x + 0.05,
      y: this.position.y - 0.5,
      width: (COMP_WIDTH - 0.05) - 0.05,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    drawGenericShape(ctx, {
      inputLabels: ["C", "R"],
      outputLabels: ["Q", "~Q"],
      clockInputIndices: [0],
      componentName: "Mono",
      width: 3,
      label: this._properties.getOrDefault<string>("label", ""),
      rotation: this.rotation,
    });
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

export function sampleMonoflop(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const extLayout = layout as unknown as {
    stateOffset(i: number): number;
    getProperty(i: number, key: string): number;
  };
  const stBase = extLayout.stateOffset(index);

  const clock = state[wt[inBase]];
  const reset = state[wt[inBase + 1]];
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
}

export function executeMonoflop(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const outBase = layout.outputOffset(index);
  const extLayout = layout as unknown as {
    stateOffset(i: number): number;
  };
  const stBase = extLayout.stateOffset(index);

  const q = state[stBase];
  state[wt[outBase]] = q;
  state[wt[outBase + 1]] = q !== 0 ? 0 : 1;
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
  pinLayout: MONOFLOP_PIN_DECLARATIONS,
  propertyDefs: MONOFLOP_PROPERTY_DEFS,
  attributeMap: MONOFLOP_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.FLIP_FLOPS,
  helpText:
    "Monoflop — monostable multivibrator.\n" +
    "On rising edge of C: Q goes high for timerDelay clock cycles, then returns low.\n" +
    "R (reset) immediately forces Q=0 and cancels any active pulse.",
  models: {
    digital: {
      executeFn: executeMonoflop,
      sampleFn: sampleMonoflop,
      inputSchema: ["C", "R"],
      outputSchema: ["Q", "~Q"],
      stateSlotCount: 3,
      defaultDelay: 10,
    },
  },
};
