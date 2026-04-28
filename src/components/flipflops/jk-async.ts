/**
 * JK Flip-Flop with async Set/Clear.
 *
 * JK logic on rising clock edge, with async Set/Clear inputs taking priority.
 * Set (active-high) forces Q=1. Clear (active-high) forces Q=0.
 *
 * Input layout:  [Set=0, J=1, C=2, K=3, Clr=4]
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
import { drawGenericShape, genericShapeBounds } from "../generic-shape.js";
import { PropertyBag, PropertyType, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import { makeJKAsyncFlipflopAnalogFactory } from "../../solver/analog/behavioral-flipflop/jk-async.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

// Java GenericShape: 5 inputs, 2 outputs, symmetric=false, width=3
// symmetric=false: offs=0, no even correction; outputs start at y=0
// inputs: Set@y=0, J@y=1, C@y=2, K@y=3, Clr@y=4; outputs: Q@y=0, ~Q@y=1
// max(5,2)=5, yBottom=(5-1)+0.5=4.5, height=4.5+0.5=5
const COMP_WIDTH = 3;

// ---------------------------------------------------------------------------
// Pin declarations — symmetric=false, 5 inputs, 2 outputs
// inputs: Set@y=0, J@y=1, C@y=2, K@y=3, Clr@y=4
// outputs: Q@y=0, ~Q@y=1
// ---------------------------------------------------------------------------

const JK_FF_AS_PIN_DECLARATIONS: PinDeclaration[] = [
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
    label: "J",
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
    label: "K",
    defaultBitWidth: 1,
    position: { x: 0, y: 3 },
    isNegatable: true,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.INPUT,
    label: "Clr",
    defaultBitWidth: 1,
    position: { x: 0, y: 4 },
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
// JKAsyncElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class JKAsyncElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("JK_FF_AS", instanceId, position, rotation, mirror, props);
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
        label: "J",
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
        label: "K",
        defaultBitWidth: bitWidth,
        position: { x: 0, y: 3 },
        isNegatable: true,
        isClockCapable: false,
        kind: "signal",
      },
      {
        direction: PinDirection.INPUT,
        label: "Clr",
        defaultBitWidth: 1,
        position: { x: 0, y: 4 },
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
    const b = genericShapeBounds(5, 2, COMP_WIDTH);
    return { x: this.position.x + b.localX, y: this.position.y + b.localY, width: b.width, height: b.height };
  }

  draw(ctx: RenderContext): void {
    drawGenericShape(ctx, {
      inputLabels: ["Set", "J", "C", "K", "Clr"],
      outputLabels: ["Q", "~Q"],
      clockInputIndices: [2],
      componentName: "JK-AS",
      width: 3,
      label: this._visibleLabel(),
      rotation: this.rotation,
    });
  }

}

// ---------------------------------------------------------------------------
// executeJKAsync — flat simulation function
//
// Input layout:  [Set=0, J=1, C=2, K=3, Clr=4]
// Output layout: [Q=0, ~Q=1]
// State layout:  [storedQ=0, prevClock=1]
// ---------------------------------------------------------------------------

export function executeJKAsync(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = layout.stateOffset(index);

  const setIn = state[wt[inBase]];
  const j = state[wt[inBase + 1]];
  const clock = state[wt[inBase + 2]];
  const k = state[wt[inBase + 3]];
  const clr = state[wt[inBase + 4]];
  const prevClock = state[stBase + 1];

  const bw = layout.getProperty(index, "bitWidth");
  const bitWidth = typeof bw === "number" && bw > 0 ? bw : 1;
  const mask = bitWidth >= 32 ? 0xFFFFFFFF : ((1 << bitWidth) - 1);

  if (clock !== 0 && prevClock === 0) {
    const jBit = j !== 0;
    const kBit = k !== 0;

    if (jBit && kBit) {
      state[stBase] = (~state[stBase] & mask) >>> 0;
    } else if (jBit) {
      state[stBase] = mask;
    } else if (kBit) {
      state[stBase] = 0;
    }
  }
  state[stBase + 1] = clock;

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
// JK_FF_AS_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const JK_FF_AS_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "inverterConfig", propertyKey: "_inverterLabels", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const JK_FF_AS_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of J, K, and Q signals",
    structural: true,
  },
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// JKAsyncDefinition — ComponentDefinition
// ---------------------------------------------------------------------------

function jkAsyncFactory(props: PropertyBag): JKAsyncElement {
  return new JKAsyncElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const JKAsyncDefinition: ComponentDefinition = {
  name: "JK_FF_AS",
  typeId: -1,
  factory: jkAsyncFactory,
  pinLayout: JK_FF_AS_PIN_DECLARATIONS,
  propertyDefs: JK_FF_AS_PROPERTY_DEFS,
  attributeMap: JK_FF_AS_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.FLIP_FLOPS,
  helpText:
    "JK Flip-Flop with async Set/Clear.\n" +
    "Set (active-high) forces Q=1 asynchronously.\n" +
    "Clr (active-high) forces Q=0 asynchronously.\n" +
    "On rising clock edge: J=0,K=0 → hold; J=1,K=0 → set; J=0,K=1 → reset; J=1,K=1 → toggle.",
  modelRegistry: {
    behavioral: {
      kind: "inline",
      factory: makeJKAsyncFlipflopAnalogFactory(),
      paramDefs: [],
      params: {},
      mayCreateInternalNodes: false,
    },
  },
  models: {
    digital: {
      executeFn: executeJKAsync,
      inputSchema: ["Set", "J", "C", "K", "Clr"],
      outputSchema: ["Q", "~Q"],
      stateSlotCount: 2,
      defaultDelay: 10,
    },
  },
  defaultModel: "digital",
};
