/**
 * D Flip-Flop with async Set/Clear — edge-triggered with async preset/clear.
 *
 * Stores D on rising clock edge. Async Set (active-high) forces Q=1.
 * Async Clear (active-high) forces Q=0. Set/Clear take priority over clock.
 *
 * Input pin order: [Set, D, C, Clr]
 * Output pin order: [Q, ~Q]
 * State slots: [storedQ, prevClock]
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
} from "../../core/pin.js";
import { drawGenericShape, genericShapeBounds } from "../generic-shape.js";
import { PropertyBag, PropertyType, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import { makeDAsyncFlipflopAnalogFactory } from "../../solver/analog/behavioral-flipflop/d-async.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 3;
// 4 inputs, 2 outputs, symmetric=false: offs=0, no even correction
// inputs: Set@y=0, D@y=1, C@y=2, Clr@y=3; outputs: Q@y=0, ~Q@y=1
// max(4,2)=4, yBottom=(4-1)+0.5=3.5, height=3.5+0.5=4
const COMP_HEIGHT = 4;

// ---------------------------------------------------------------------------
// Pin declarations — GenericShape positions (symmetric=false, 4 inputs, 2 outputs)
// inputs: Set@y=0, D@y=1, C@y=2, Clr@y=3
// outputs: Q@y=0, ~Q@y=1
// ---------------------------------------------------------------------------

const D_FF_AS_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "Set",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: true,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.INPUT,
    label: "D",
    defaultBitWidth: 1,
    position: { x: 0, y: 1 },
    isNegatable: true,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.INPUT,
    label: "C",
    defaultBitWidth: 1,
    position: { x: 0, y: 2 },
    isNegatable: true,
    isClockCapable: true,
    kind: "signal",
  },
  {
    direction: PinDirection.INPUT,
    label: "Clr",
    defaultBitWidth: 1,
    position: { x: 0, y: 3 },
    isNegatable: true,
    isClockCapable: false,
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
// DAsyncElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class DAsyncElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("D_FF_AS", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const decls: PinDeclaration[] = [
      {
        direction: PinDirection.INPUT,
        label: "Set",
        defaultBitWidth: 1,
        position: { x: 0, y: 0 },
        isNegatable: true,
        isClockCapable: false,
        kind: "signal",
      },
      {
        direction: PinDirection.INPUT,
        label: "D",
        defaultBitWidth: bitWidth,
        position: { x: 0, y: 1 },
        isNegatable: true,
        isClockCapable: false,
        kind: "signal",
      },
      {
        direction: PinDirection.INPUT,
        label: "C",
        defaultBitWidth: 1,
        position: { x: 0, y: 2 },
        isNegatable: true,
        isClockCapable: true,
        kind: "signal",
      },
      {
        direction: PinDirection.INPUT,
        label: "Clr",
        defaultBitWidth: 1,
        position: { x: 0, y: 3 },
        isNegatable: true,
        isClockCapable: false,
        kind: "signal",
      },
      {
        direction: PinDirection.OUTPUT,
        label: "Q",
        defaultBitWidth: bitWidth,
        position: { x: COMP_WIDTH, y: 0 },
        isNegatable: false,
        isClockCapable: false,
        kind: "signal",
      },
      {
        direction: PinDirection.OUTPUT,
        label: "~Q",
        defaultBitWidth: bitWidth,
        position: { x: COMP_WIDTH, y: 1 },
        isNegatable: false,
        isClockCapable: false,
        kind: "signal",
      },
    ];
    return this.derivePins(decls, ["C"]);
  }

  getBoundingBox(): Rect {
    const b = genericShapeBounds(4, 2, COMP_WIDTH);
    return { x: this.position.x + b.localX, y: this.position.y + b.localY, width: b.width, height: b.height };
  }

  draw(ctx: RenderContext): void {
    drawGenericShape(ctx, {
      inputLabels: ["Set", "D", "C", "Clr"],
      outputLabels: ["Q", "~Q"],
      clockInputIndices: [2],
      componentName: "D-AS",
      width: 3,
      label: this._visibleLabel(),
      rotation: this.rotation,
    });
  }

}

// ---------------------------------------------------------------------------
// executeDAsync — flat simulation function
//
// Input layout:  [Set=0, D=1, C=2, Clr=3]
// Output layout: [Q=0, ~Q=1]
// State layout:  [storedQ=0, prevClock=1]
// ---------------------------------------------------------------------------

export function executeDAsync(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = layout.stateOffset(index);

  const setIn = state[wt[inBase]];
  const d = state[wt[inBase + 1]];
  const clock = state[wt[inBase + 2]];
  const clr = state[wt[inBase + 3]];
  const prevClock = state[stBase + 1];

  if (clock !== 0 && prevClock === 0) {
    state[stBase] = d;
  }
  state[stBase + 1] = clock;

  const bw = layout.getProperty(index, "bitWidth");
  const bitWidth = typeof bw === "number" ? bw : 1;
  const mask = bitWidth >= 32 ? 0xFFFFFFFF : ((1 << bitWidth) - 1);

  if (setIn !== 0) {
    state[stBase] = mask;
  } else if (clr !== 0) {
    state[stBase] = 0;
  }

  const q = state[stBase];
  state[wt[outBase]] = q;
  state[wt[outBase + 1]] = (~q & mask) >>> 0;
}

// ---------------------------------------------------------------------------
// D_FF_AS_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const D_FF_AS_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "inverterConfig", propertyKey: "_inverterLabels", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const D_FF_AS_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of D and Q signals",
    structural: true,
  },
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// DAsyncDefinition — ComponentDefinition
// ---------------------------------------------------------------------------

function dAsyncFactory(props: PropertyBag): DAsyncElement {
  return new DAsyncElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const DAsyncDefinition: ComponentDefinition = {
  name: "D_FF_AS",
  typeId: -1,
  factory: dAsyncFactory,
  pinLayout: D_FF_AS_PIN_DECLARATIONS,
  propertyDefs: D_FF_AS_PROPERTY_DEFS,
  attributeMap: D_FF_AS_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.FLIP_FLOPS,
  helpText:
    "D Flip-Flop with async Set/Clear — edge-triggered with async preset/clear.\n" +
    "Set (active-high) forces Q=1 asynchronously.\n" +
    "Clr (active-high) forces Q=0 asynchronously.\n" +
    "When Set and Clr are both inactive, stores D on rising clock edge.",
  modelRegistry: {
    behavioral: {
      kind: "inline",
      factory: makeDAsyncFlipflopAnalogFactory(),
      paramDefs: [],
      params: {},
    },
  },
  models: {
    digital: {
      executeFn: executeDAsync,
      inputSchema: ["Set", "D", "C", "Clr"],
      outputSchema: ["Q", "~Q"],
      stateSlotCount: 2,
      defaultDelay: 10,
    },
  },
  defaultModel: "digital",
};
