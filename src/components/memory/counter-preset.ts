/**
 * CounterPreset — edge-triggered up/down counter with load, clear, and configurable max.
 *
 * On rising clock edge:
 *   - If en=1:
 *     - dir=0 (up): increment; wraps from maxValue back to 0
 *     - dir=1 (down): decrement; wraps from 0 back to maxValue
 *   - If clr=1 (takes priority): reset to 0
 *   - Else if ld=1: load preset value from 'in' input
 * ovf output: when counting up, ovf=1 at maxValue; when counting down, ovf=1 at 0.
 *
 * Ported from ref/Digital/src/main/java/de/neemann/digital/core/memory/CounterPreset.java
 *
 * Input layout:  [en=0, C=1, dir=2, in=3, ld=4, clr=5]
 * Output layout: [out=0, ovf=1]
 * State layout:  [counter=0, prevClock=1]
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import { drawGenericShape } from "../generic-shape.js";
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

const COMP_WIDTH = 3;
// Java GenericShape: 6 inputs, 2 outputs, non-symmetric (offs=0)
// en@y=0, C@y=1, dir@y=2, in@y=3, ld@y=4, clr@y=5; out@y=0, ovf@y=1
const COMP_HEIGHT = 6;

// ---------------------------------------------------------------------------
// Pin declarations — matching Java GenericShape layout
// ---------------------------------------------------------------------------

const COUNTER_PRESET_PIN_DECLARATIONS: PinDeclaration[] = [
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
    label: "dir",
    defaultBitWidth: 1,
    position: { x: 0, y: 2 },
    isNegatable: true,
    isClockCapable: false,
  },
  {
    direction: PinDirection.INPUT,
    label: "in",
    defaultBitWidth: 1,
    position: { x: 0, y: 3 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.INPUT,
    label: "ld",
    defaultBitWidth: 1,
    position: { x: 0, y: 4 },
    isNegatable: true,
    isClockCapable: false,
  },
  {
    direction: PinDirection.INPUT,
    label: "clr",
    defaultBitWidth: 1,
    position: { x: 0, y: 5 },
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
    position: { x: COMP_WIDTH, y: 1 },
    isNegatable: false,
    isClockCapable: false,
  },
];

// ---------------------------------------------------------------------------
// CounterPresetElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class CounterPresetElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("CounterPreset", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 4);
    const decls = COUNTER_PRESET_PIN_DECLARATIONS.map((d) =>
      d.label === "in" || d.label === "out"
        ? { ...d, defaultBitWidth: bitWidth }
        : d,
    );
    return this.derivePins(decls, ["C"]);
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
      inputLabels: ["en", "C", "dir", "in", "ld", "clr"],
      outputLabels: ["out", "ovf"],
      clockInputIndices: [1],
      componentName: "Counter",
      width: 3,
      label: this._properties.getOrDefault<string>("label", ""),
      rotation: this.rotation,
    });
  }

  getHelpText(): string {
    return (
      "CounterPreset — edge-triggered up/down counter with preset load.\n" +
      "dir=0: counts up; dir=1: counts down. clr clears to 0, ld loads from 'in'.\n" +
      "maxValue property sets the wrap-around value."
    );
  }
}

// ---------------------------------------------------------------------------
// executeCounterPreset — flat simulation function
//
// Input layout:  [en=0, C=1, dir=2, in=3, ld=4, clr=5]
// Output layout: [out=0, ovf=1]
// State layout:  [counter=0, prevClock=1]
//
// Priority on clock edge: clr > ld > count
// ---------------------------------------------------------------------------

export function sampleCounterPreset(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const extLayout = layout as unknown as {
    stateOffset(i: number): number;
    getProperty(i: number, key: string): number;
  };
  const stBase = extLayout.stateOffset(index);

  const en = state[wt[inBase]];
  const clock = state[wt[inBase + 1]];
  const dir = state[wt[inBase + 2]];
  const loadVal = state[wt[inBase + 3]];
  const ld = state[wt[inBase + 4]];
  const clr = state[wt[inBase + 5]];
  const prevClock = state[stBase + 1];

  const bitWidth = extLayout.getProperty(index, "bitWidth") ?? 4;
  const mask = bitWidth >= 32 ? 0xFFFFFFFF : (1 << bitWidth) - 1;
  let maxValue = extLayout.getProperty(index, "maxValue") ?? 0;
  if (maxValue === 0) maxValue = mask;
  maxValue = maxValue & mask;

  if (clock !== 0 && prevClock === 0) {
    if (en !== 0) {
      if (dir !== 0) {
        if (state[stBase] === 0) {
          state[stBase] = maxValue;
        } else {
          state[stBase] -= 1;
        }
      } else {
        if (state[stBase] === maxValue) {
          state[stBase] = 0;
        } else {
          state[stBase] += 1;
        }
      }
    }

    if (clr !== 0) {
      state[stBase] = 0;
    } else if (ld !== 0) {
      state[stBase] = loadVal & mask;
    }
  }
  state[stBase + 1] = clock;
}

export function executeCounterPreset(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const extLayout = layout as unknown as {
    stateOffset(i: number): number;
    getProperty(i: number, key: string): number;
  };
  const stBase = extLayout.stateOffset(index);

  const en = state[wt[inBase]];
  const clock = state[wt[inBase + 1]];
  const dir = state[wt[inBase + 2]];
  const loadVal = state[wt[inBase + 3]];
  const ld = state[wt[inBase + 4]];
  const clr = state[wt[inBase + 5]];
  const prevClock = state[stBase + 1];

  const bitWidth = extLayout.getProperty(index, "bitWidth") ?? 4;
  const mask = bitWidth >= 32 ? 0xFFFFFFFF : (1 << bitWidth) - 1;
  let maxValue = extLayout.getProperty(index, "maxValue") ?? 0;
  if (maxValue === 0) maxValue = mask;
  maxValue = maxValue & mask;

  if (clock !== 0 && prevClock === 0) {
    if (en !== 0) {
      if (dir !== 0) {
        if (state[stBase] === 0) {
          state[stBase] = maxValue;
        } else {
          state[stBase] -= 1;
        }
      } else {
        if (state[stBase] === maxValue) {
          state[stBase] = 0;
        } else {
          state[stBase] += 1;
        }
      }
    }

    if (clr !== 0) {
      state[stBase] = 0;
    } else if (ld !== 0) {
      state[stBase] = loadVal & mask;
    }
  }
  state[stBase + 1] = clock;

  state[wt[outBase]] = state[stBase];

  const atOverflow = dir !== 0
    ? state[stBase] === 0
    : state[stBase] === maxValue;
  state[wt[outBase + 1]] = (atOverflow && en !== 0) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// COUNTER_PRESET_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const COUNTER_PRESET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "maxValue", propertyKey: "maxValue", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "inverterConfig", propertyKey: "_inverterLabels", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const COUNTER_PRESET_PROPERTY_DEFS: PropertyDefinition[] = [
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
    key: "maxValue",
    type: PropertyType.INT,
    label: "Max Value",
    defaultValue: 0,
    min: 0,
    description: "Maximum counter value (0 = use full bit-width range)",
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
// CounterPresetDefinition — ComponentDefinition
// ---------------------------------------------------------------------------

function counterPresetFactory(props: PropertyBag): CounterPresetElement {
  return new CounterPresetElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const CounterPresetDefinition: ComponentDefinition = {
  name: "CounterPreset",
  typeId: -1,
  factory: counterPresetFactory,
  executeFn: executeCounterPreset,
  sampleFn: sampleCounterPreset,
  pinLayout: COUNTER_PRESET_PIN_DECLARATIONS,
  propertyDefs: COUNTER_PRESET_PROPERTY_DEFS,
  attributeMap: COUNTER_PRESET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText:
    "CounterPreset — edge-triggered up/down counter with preset load.\n" +
    "dir=0: counts up; dir=1: counts down. clr clears to 0, ld loads from 'in'.\n" +
    "maxValue property sets the wrap-around value.",
  stateSlotCount: 2,
  defaultDelay: 10,
};
