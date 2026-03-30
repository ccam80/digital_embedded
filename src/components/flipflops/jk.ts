/**
 * JK Flip-Flop — edge-triggered with J/K control inputs.
 *
 * On rising clock edge:
 *   J=0, K=0 → no change (hold)
 *   J=1, K=0 → set (Q=1)
 *   J=0, K=1 → reset (Q=0)
 *   J=1, K=1 → toggle (Q=~Q)
 *
 * Input layout:  [J=0, C=1, K=2]
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

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 3;
// 3 inputs, 2 outputs, symmetric=false: offs=0, no even correction
// inputs: J@y=0, C@y=1, K@y=2; outputs: Q@y=0, ~Q@y=1
// max(3,2)=3, yBottom=(3-1)+0.5=2.5, height=2.5+0.5=3
const COMP_HEIGHT = 3;

// ---------------------------------------------------------------------------
// Pin declarations — GenericShape positions (symmetric=false, 3 inputs, 2 outputs)
// inputs: J@y=0, C@y=1, K@y=2
// outputs: Q@y=0, ~Q@y=1
// ---------------------------------------------------------------------------

export const JK_FF_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "J",
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
    direction: PinDirection.INPUT,
    label: "K",
    defaultBitWidth: 1,
    position: { x: 0, y: 2 },
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
// JKElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class JKElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("JK_FF", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const decls: PinDeclaration[] = [
      {
        direction: PinDirection.INPUT,
        label: "J",
        defaultBitWidth: bitWidth,
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
        direction: PinDirection.INPUT,
        label: "K",
        defaultBitWidth: bitWidth,
        position: { x: 0, y: 2 },
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
    return {
      x: this.position.x + 0.05,
      y: this.position.y - 0.5,
      width: (COMP_WIDTH - 0.05) - 0.05,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    drawGenericShape(ctx, {
      inputLabels: ["J", "C", "K"],
      outputLabels: ["Q", "~Q"],
      clockInputIndices: [1],
      componentName: "JK",
      width: 3,
      label: this._visibleLabel(),
      rotation: this.rotation,
    });
  }

}

// ---------------------------------------------------------------------------
// executeJK — flat simulation function
//
// Input layout:  [J=0, C=1, K=2]
// Output layout: [Q=0, ~Q=1]
// State layout:  [storedQ=0, prevClock=1]
// ---------------------------------------------------------------------------

export function sampleJK(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const stBase = layout.stateOffset(index);

  const j = state[wt[inBase]];
  const clock = state[wt[inBase + 1]];
  const k = state[wt[inBase + 2]];
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
}

export function executeJK(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const outBase = layout.outputOffset(index);
  const stBase = layout.stateOffset(index);

  const bw = layout.getProperty(index, "bitWidth");
  const bitWidth = typeof bw === "number" && bw > 0 ? bw : 1;
  const mask = bitWidth >= 32 ? 0xFFFFFFFF : ((1 << bitWidth) - 1);

  const q = state[stBase];
  state[wt[outBase]] = q;
  state[wt[outBase + 1]] = (~q & mask) >>> 0;
}

// ---------------------------------------------------------------------------
// JK_FF_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const JK_FF_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "inverterConfig", propertyKey: "_inverterLabels", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const JK_FF_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of J, K, and Q signals",
  },
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// JKDefinition — ComponentDefinition
// ---------------------------------------------------------------------------

function jkFactory(props: PropertyBag): JKElement {
  return new JKElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const JKDefinition: ComponentDefinition = {
  name: "JK_FF",
  typeId: -1,
  factory: jkFactory,
  pinLayout: JK_FF_PIN_DECLARATIONS,
  propertyDefs: JK_FF_PROPERTY_DEFS,
  attributeMap: JK_FF_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.FLIP_FLOPS,
  helpText:
    "JK Flip-Flop — edge-triggered with J/K control inputs.\n" +
    "On rising clock edge: J=0,K=0 → hold; J=1,K=0 → set; J=0,K=1 → reset; J=1,K=1 → toggle.\n" +
    "Q and ~Q outputs are always complementary.",
  modelRegistry: {},
  models: {
    digital: {
      executeFn: executeJK,
      sampleFn: sampleJK,
      inputSchema: ["J", "C", "K"],
      outputSchema: ["Q", "~Q"],
      stateSlotCount: 2,
      defaultDelay: 10,
    },
  },
  defaultModel: "digital",
};
