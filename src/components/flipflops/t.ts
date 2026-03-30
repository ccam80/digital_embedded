/**
 * T Flip-Flop — toggles on rising clock edge when T=1 (or unconditionally if no T input).
 *
 * With T input (withEnable=true):
 *   T=1 → toggle Q on rising clock edge
 *   T=0 → hold Q on rising clock edge
 *
 * Without T input (withEnable=false):
 *   Toggles Q on every rising clock edge.
 *
 * Input layout (withEnable=false): [C=0]
 * Input layout (withEnable=true):  [T=0, C=1]
 * Output layout: [Q=0, ~Q=1]
 * State layout:  [storedQ=0, prevClock=1]
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
} from "../../core/pin.js";
import { drawGenericShape } from "../generic-shape.js";
import { PropertyBag, PropertyType, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import { makeTFlipflopAnalogFactory } from "../../solver/analog/behavioral-flipflop/t.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 3;
// No-enable: 1 input, 2 outputs, symmetric=false: offs=0; input C@y=0; outputs Q@y=0, ~Q@y=1
// max(1,2)=2, yBottom=(2-1)+0.5=1.5, height=1.5+0.5=2
const COMP_HEIGHT_NO_ENABLE = 2;
// With-enable: 2 inputs, 2 outputs, symmetric=false: offs=0, no even correction
// inputs T@y=0, C@y=1; outputs Q@y=0, ~Q@y=1
// max(2,2)=2, yBottom=(2-1)+0.5=1.5, height=1.5+0.5=2
const COMP_HEIGHT_WITH_ENABLE = 2;

// ---------------------------------------------------------------------------
// Pin declarations — GenericShape positions (symmetric=false)
// No-enable: 1 input C@y=0; outputs Q@y=0, ~Q@y=1
// With-enable: inputs T@y=0, C@y=1; outputs Q@y=0, ~Q@y=1
// ---------------------------------------------------------------------------

const T_FF_PINS_NO_ENABLE: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "C",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: true,
    isClockCapable: true,
    kind: "signal",
  },
  {
    direction: PinDirection.OUTPUT,
    label: "Q",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.OUTPUT,
    label: "~Q",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 1 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
];

const T_FF_PINS_WITH_ENABLE: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "T",
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
    isNegatable: true,
    isClockCapable: true,
    kind: "signal",
  },
  {
    direction: PinDirection.OUTPUT,
    label: "Q",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.OUTPUT,
    label: "~Q",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 1 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
];

// ---------------------------------------------------------------------------
// TElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class TElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("T_FF", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const withEnable = this._properties.getOrDefault<boolean>("withEnable", true);
    const decls = withEnable ? T_FF_PINS_WITH_ENABLE : T_FF_PINS_NO_ENABLE;
    return this.derivePins(decls, ["C"]);
  }

  getBoundingBox(): Rect {
    const withEnable = this._properties.getOrDefault<boolean>("withEnable", true);
    const h = withEnable ? COMP_HEIGHT_WITH_ENABLE : COMP_HEIGHT_NO_ENABLE;
    return {
      x: this.position.x + 0.05,
      y: this.position.y - 0.5,
      width: (COMP_WIDTH - 0.05) - 0.05,
      height: h,
    };
  }

  draw(ctx: RenderContext): void {
    const withEnable = this._properties.getOrDefault<boolean>("withEnable", true);
    if (withEnable) {
      drawGenericShape(ctx, {
        inputLabels: ["T", "C"],
        outputLabels: ["Q", "~Q"],
        clockInputIndices: [1],
        componentName: "T",
        width: 3,
        label: this._visibleLabel(),
      rotation: this.rotation,
      });
    } else {
      drawGenericShape(ctx, {
        inputLabels: ["C"],
        outputLabels: ["Q", "~Q"],
        clockInputIndices: [0],
        componentName: "T",
        width: 3,
        label: this._visibleLabel(),
      rotation: this.rotation,
      });
    }
  }

}

// ---------------------------------------------------------------------------
// executeT — flat simulation function
//
// withEnable=false: inputs [C=0],     outputs [Q=0, ~Q=1], state [storedQ=0, prevClock=1]
// withEnable=true:  inputs [T=0, C=1], outputs [Q=0, ~Q=1], state [storedQ=0, prevClock=1]
//
// The withEnable flag is embedded in the component's input count at compile time.
// We detect it from inputCount via layout.inputCount(index).
// ---------------------------------------------------------------------------

export function sampleT(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const stBase = layout.stateOffset(index);

  const inputCount = layout.inputCount(index);
  const withEnable = inputCount === 2;

  let clock: number;
  let t: number;

  if (withEnable) {
    t = state[wt[inBase]];
    clock = state[wt[inBase + 1]];
  } else {
    t = 1;
    clock = state[wt[inBase]];
  }

  const prevClock = state[stBase + 1];

  if (clock !== 0 && prevClock === 0) {
    if (t !== 0) {
      state[stBase] = state[stBase] !== 0 ? 0 : 1;
    }
  }
  state[stBase + 1] = clock;
}

export function executeT(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const outBase = layout.outputOffset(index);
  const stBase = layout.stateOffset(index);

  const q = state[stBase];
  state[wt[outBase]] = q;
  state[wt[outBase + 1]] = q !== 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// T_FF_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const T_FF_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "withEnable", propertyKey: "withEnable", convert: (v) => v === "true" },
  { xmlName: "inverterConfig", propertyKey: "_inverterLabels", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const T_FF_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "withEnable",
    type: PropertyType.BOOLEAN,
    label: "With Enable",
    defaultValue: true,
    description: "Add T (toggle enable) input pin",
  },
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// TDefinition — ComponentDefinition
// ---------------------------------------------------------------------------

function tFactory(props: PropertyBag): TElement {
  return new TElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const TDefinition: ComponentDefinition = {
  name: "T_FF",
  typeId: -1,
  factory: tFactory,
  pinLayout: T_FF_PINS_WITH_ENABLE,
  propertyDefs: T_FF_PROPERTY_DEFS,
  attributeMap: T_FF_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.FLIP_FLOPS,
  helpText:
    "T Flip-Flop — toggles Q on rising clock edge.\n" +
    "With T input: toggles only when T=1.\n" +
    "Without T input: toggles on every rising clock edge.\n" +
    "Q and ~Q are always complementary.",
  modelRegistry: {
    behavioral: {
      kind: "inline",
      factory: makeTFlipflopAnalogFactory(),
      paramDefs: [],
      params: {},
    },
  },
  models: {
    digital: {
      executeFn: executeT,
      sampleFn: sampleT,
      inputSchema: ["T", "C"],
      outputSchema: ["Q", "~Q"],
      stateSlotCount: 2,
      defaultDelay: 10,
    },
  },
  defaultModel: "digital",
};
