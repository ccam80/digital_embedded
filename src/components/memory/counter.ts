/**
 * Counter — edge-triggered up counter with enable and clear.
 *
 * On rising clock edge:
 *   - If enable=1: increment counter (wraps from maxValue back to 0)
 *   - If clr=1: reset counter to 0 (takes priority over increment)
 * Output ovf=1 when counter==maxValue AND enable=1.
 *
 * Ported from ref/Digital/src/main/java/de/neemann/digital/core/memory/Counter.java
 *
 * Input layout:  [en=0, C=1, clr=2]
 * Output layout: [out=0, ovf=1]
 * State layout:  [counter=0, prevClock=1]
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

const COMP_WIDTH = 3;
// Pins shifted: en@y=0, C@y=1, clr@y=3; out@y=0, ovf@y=3
// bodyHeight = maxPinY + 1 = 3 + 1 = 4
const COMP_HEIGHT = 4;

// ---------------------------------------------------------------------------
// Pin declarations — y-positions shifted down by 1 from previous layout
// ---------------------------------------------------------------------------

const COUNTER_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "en",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: true,
    isClockCapable: false,
  },
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
    label: "clr",
    defaultBitWidth: 1,
    position: { x: 0, y: 3 },
    isNegatable: true,
    isClockCapable: false,
  },
  {
    direction: PinDirection.OUTPUT,
    label: "out",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.OUTPUT,
    label: "ovf",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 3 },
    isNegatable: false,
    isClockCapable: false,
  },
];

// ---------------------------------------------------------------------------
// CounterElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class CounterElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Counter", instanceId, position, rotation, mirror, props);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 4);
    this._pins = resolvePins(
      COUNTER_PIN_DECLARATIONS,
      position,
      rotation,
      createInverterConfig([]),
      createClockConfig(["C"]),
      this._bitWidth,
    );
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.5,
      width: COMP_WIDTH,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    ctx.save();

    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, -0.5, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, -0.5, COMP_WIDTH, COMP_HEIGHT, false);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.9, weight: "bold" });
    ctx.drawText("en", 0.5, 0, { horizontal: "left", vertical: "middle" });
    ctx.drawText("C", 0.5, 1, { horizontal: "left", vertical: "middle" });
    ctx.drawText("clr", 0.5, 3, { horizontal: "left", vertical: "middle" });
    ctx.drawText("out", COMP_WIDTH - 0.5, 0, { horizontal: "right", vertical: "middle" });
    ctx.drawText("ovf", COMP_WIDTH - 0.5, 3, { horizontal: "right", vertical: "middle" });

    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText("CTR", COMP_WIDTH / 2, 1.5, { horizontal: "center", vertical: "middle" });

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
      "Counter — edge-triggered up counter.\n" +
      "On rising clock edge: if en=1, increments (wraps at maxValue); if clr=1, resets to 0.\n" +
      "ovf output is 1 when counter==maxValue and en=1."
    );
  }
}

// ---------------------------------------------------------------------------
// executeCounter — flat simulation function
//
// Input layout:  [en=0, C=1, clr=2]
// Output layout: [out=0, ovf=1]
// State layout:  [counter=0, prevClock=1]
//
// maxValue = (1 << bitWidth) - 1, accessed via getProperty
// ---------------------------------------------------------------------------

export function sampleCounter(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const extLayout = layout as unknown as {
    stateOffset(i: number): number;
    getProperty?(i: number, key: string): number;
  };
  const stBase = extLayout.stateOffset(index);

  const en = state[wt[inBase]];
  const clock = state[wt[inBase + 1]];
  const clr = state[wt[inBase + 2]];
  const prevClock = state[stBase + 1];

  const bitWidth = extLayout.getProperty ? extLayout.getProperty(index, "bitWidth") : 4;
  const maxValue = bitWidth >= 32 ? 0xFFFFFFFF : (1 << bitWidth) - 1;

  if (clock !== 0 && prevClock === 0) {
    if (en !== 0) {
      if (state[stBase] === maxValue) {
        state[stBase] = 0;
      } else {
        state[stBase] += 1;
      }
    }
    if (clr !== 0) {
      state[stBase] = 0;
    }
  }
  state[stBase + 1] = clock;
}

export function executeCounter(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const extLayout = layout as unknown as {
    stateOffset(i: number): number;
    getProperty?(i: number, key: string): number;
  };
  const stBase = extLayout.stateOffset(index);

  const en = state[wt[inBase]];
  const clock = state[wt[inBase + 1]];
  const clr = state[wt[inBase + 2]];
  const prevClock = state[stBase + 1];

  const bitWidth = extLayout.getProperty ? extLayout.getProperty(index, "bitWidth") : 4;
  const maxValue = bitWidth >= 32 ? 0xFFFFFFFF : (1 << bitWidth) - 1;

  if (clock !== 0 && prevClock === 0) {
    if (en !== 0) {
      if (state[stBase] === maxValue) {
        state[stBase] = 0;
      } else {
        state[stBase] += 1;
      }
    }
    if (clr !== 0) {
      state[stBase] = 0;
    }
  }
  state[stBase + 1] = clock;

  state[wt[outBase]] = state[stBase];
  state[wt[outBase + 1]] = (state[stBase] === maxValue && en !== 0) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// COUNTER_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const COUNTER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "inverterConfig", propertyKey: "_inverterLabels", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const COUNTER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 4,
    min: 1,
    max: 32,
    description: "Bit width of the counter",
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
// CounterDefinition — ComponentDefinition
// ---------------------------------------------------------------------------

function counterFactory(props: PropertyBag): CounterElement {
  return new CounterElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const CounterDefinition: ComponentDefinition = {
  name: "Counter",
  typeId: -1,
  factory: counterFactory,
  executeFn: executeCounter,
  sampleFn: sampleCounter,
  pinLayout: COUNTER_PIN_DECLARATIONS,
  propertyDefs: COUNTER_PROPERTY_DEFS,
  attributeMap: COUNTER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText:
    "Counter — edge-triggered up counter.\n" +
    "On rising clock edge: if en=1, increments (wraps at maxValue); if clr=1, resets to 0.\n" +
    "ovf output is 1 when counter==maxValue and en=1.",
  stateSlotCount: 2,
  defaultDelay: 10,
};
