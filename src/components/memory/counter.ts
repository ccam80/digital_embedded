/**
 * Counter — edge-triggered up counter with enable and clear.
 *
 * On rising clock edge:
 *   - If enable=1: increment counter (wraps from maxValue back to 0)
 *   - If clr=1: reset counter to 0 (takes priority over increment)
 * Output ovf=1 when counter==maxValue AND enable=1.
 *
 * Input layout:  [en=0, C=1, clr=2]
 * Output layout: [out=0, ovf=1]
 * State layout:  [counter=0, prevClock=1]
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import { drawGenericShape, genericShapeBounds } from "../generic-shape.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
} from "../../core/pin.js";
import { PropertyBag, PropertyType, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import { makeBehavioralCounterAnalogFactory } from "../../solver/analog/behavioral-sequential.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 3;
// Java GenericShape: 3 inputs, 2 outputs, non-symmetric (offs=0)
// en@y=0, C@y=1, clr@y=2; out@y=0, ovf@y=1

// ---------------------------------------------------------------------------
// Pin declarations — matching Java GenericShape layout
// ---------------------------------------------------------------------------

const COUNTER_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "en",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: true,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.INPUT,
    label: "C",
    defaultBitWidth: 1,
    position: { x: 0, y: 1 },
    isNegatable: false,
    isClockCapable: true,
    kind: "signal",
  },
  {
    direction: PinDirection.INPUT,
    label: "clr",
    defaultBitWidth: 1,
    position: { x: 0, y: 2 },
    isNegatable: true,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.OUTPUT,
    label: "out",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.OUTPUT,
    label: "ovf",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 1 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
];

// ---------------------------------------------------------------------------
// CounterElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class CounterElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Counter", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 4);
    // Override 'out' pin width based on the bitWidth property
    const decls = COUNTER_PIN_DECLARATIONS.map((d) =>
      d.label === "out" ? { ...d, defaultBitWidth: bitWidth } : d,
    );
    return this.derivePins(decls, ["C"]);
  }

  getBoundingBox(): Rect {
    const b = genericShapeBounds(3, 2, COMP_WIDTH);
    return { x: this.position.x + b.localX, y: this.position.y + b.localY, width: b.width, height: b.height };
  }

  draw(ctx: RenderContext): void {
    drawGenericShape(ctx, {
      inputLabels: ["en", "C", "clr"],
      outputLabels: ["out", "ovf"],
      clockInputIndices: [1],
      componentName: "Counter",
      width: 3,
      label: this._visibleLabel(),
      rotation: this.rotation,
    });
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
    getProperty(i: number, key: string): number;
  };
  const stBase = extLayout.stateOffset(index);

  const en = state[wt[inBase]];
  const clock = state[wt[inBase + 1]];
  const clr = state[wt[inBase + 2]];
  const prevClock = state[stBase + 1];

  const bitWidth = extLayout.getProperty(index, "bitWidth") ?? 4;
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
    getProperty(i: number, key: string): number;
  };
  const stBase = extLayout.stateOffset(index);

  const en = state[wt[inBase]];
  const clock = state[wt[inBase + 1]];
  const clr = state[wt[inBase + 2]];
  const prevClock = state[stBase + 1];

  const bitWidth = extLayout.getProperty(index, "bitWidth") ?? 4;
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
    structural: true,
  },
  LABEL_PROPERTY_DEF,
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
  pinLayout: COUNTER_PIN_DECLARATIONS,
  propertyDefs: COUNTER_PROPERTY_DEFS,
  attributeMap: COUNTER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MEMORY,
  helpText:
    "Counter — edge-triggered up counter.\n" +
    "On rising clock edge: if en=1, increments (wraps at maxValue); if clr=1, resets to 0.\n" +
    "ovf output is 1 when counter==maxValue and en=1.",
  models: {
    digital: {
      executeFn: executeCounter,
      sampleFn: sampleCounter,
      // sampleCounter/executeCounter read: inBase+0=en, inBase+1=C, inBase+2=clr
      // writes: outBase+0=out, outBase+1=ovf
      inputSchema: ["en", "C", "clr"],
      outputSchema: ["out", "ovf"],
      stateSlotCount: 2,
      defaultDelay: 10,
    },
  },
  modelRegistry: {
    behavioral: {
      kind: "inline",
      factory: makeBehavioralCounterAnalogFactory(),
      mayCreateInternalNodes: false,
      paramDefs: [],
      params: {},
    },
  },
  defaultModel: "digital",
};
