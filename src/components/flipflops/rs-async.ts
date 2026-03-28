/**
 * RS Flip-Flop Async — level-sensitive (no clock), SR latch.
 *
 * Level-sensitive SR latch behavior (no clock):
 *   S=0, R=0 → hold (or recover from forbidden state)
 *   S=1, R=0 → Q=1, ~Q=0
 *   S=0, R=1 → Q=0, ~Q=1
 *   S=1, R=1 → forbidden (Q=0, ~Q=0 per Digital's implementation)
 *
 * Ported from ref/Digital/src/main/java/de/neemann/digital/core/flipflops/FlipflopRSAsync.java
 *
 * Input layout:  [S=0, R=1]
 * Output layout: [Q=0, ~Q=1]
 * State layout:  [storedQ=0, storedQn=1]
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
} from "../../core/pin.js";
import { drawGenericShape } from "../generic-shape.js";
import { PropertyBag, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import { makeRSAsyncLatchAnalogFactory } from "../../solver/analog/behavioral-flipflop-variants.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 3;
// 2 inputs, 2 outputs, symmetric=false: offs=0, no even correction
// inputs: S@y=0, R@y=1; outputs: Q@y=0, ~Q@y=1
// max(2,2)=2, yBottom=(2-1)+0.5=1.5, height=1.5+0.5=2
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin declarations — GenericShape positions (symmetric=false, 2 inputs, 2 outputs)
// inputs: S@y=0, R@y=1
// outputs: Q@y=0, ~Q@y=1
// ---------------------------------------------------------------------------

const RS_FF_AS_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "S",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: true,
    isClockCapable: false,
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
// RSAsyncElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class RSAsyncElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("RS_FF_AS", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(RS_FF_AS_PIN_DECLARATIONS, []);
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
      inputLabels: ["S", "R"],
      outputLabels: ["Q", "~Q"],
      clockInputIndices: [],
      componentName: "RS",
      width: 3,
      label: this._visibleLabel(),
      rotation: this.rotation,
    });
  }

}

// ---------------------------------------------------------------------------
// executeRSAsync — flat simulation function
//
// Level-sensitive SR latch: responds to S/R inputs directly without clock.
//
// Input layout:  [S=0, R=1]
// Output layout: [Q=0, ~Q=1]
// State layout:  [storedQ=0, storedQn=1]
//
// Matches Digital's FlipflopRSAsync: S=R=1 forces Q=0, ~Q=0 (forbidden state).
// S=R=0 after forbidden state: stays in undefined until driven.
// ---------------------------------------------------------------------------

export function executeRSAsync(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = layout.stateOffset(index);

  const s = state[wt[inBase]] !== 0;
  const r = state[wt[inBase + 1]] !== 0;

  if (s && r) {
    state[stBase] = 0;
    state[stBase + 1] = 0;
  } else if (s) {
    state[stBase] = 1;
    state[stBase + 1] = 0;
  } else if (r) {
    state[stBase] = 0;
    state[stBase + 1] = 1;
  }

  state[wt[outBase]] = state[stBase];
  state[wt[outBase + 1]] = state[stBase + 1];
}

// ---------------------------------------------------------------------------
// RS_FF_AS_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const RS_FF_AS_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "inverterConfig", propertyKey: "_inverterLabels", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const RS_FF_AS_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// RSAsyncDefinition — ComponentDefinition
// ---------------------------------------------------------------------------

function rsAsyncFactory(props: PropertyBag): RSAsyncElement {
  return new RSAsyncElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const RSAsyncDefinition: ComponentDefinition = {
  name: "RS_FF_AS",
  typeId: -1,
  factory: rsAsyncFactory,
  pinLayout: RS_FF_AS_PIN_DECLARATIONS,
  propertyDefs: RS_FF_AS_PROPERTY_DEFS,
  attributeMap: RS_FF_AS_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.FLIP_FLOPS,
  helpText:
    "RS Flip-Flop Async — level-sensitive SR latch (no clock).\n" +
    "S=1, R=0 → Q=1; S=0, R=1 → Q=0; S=0, R=0 → hold; S=1, R=1 → forbidden (Q=~Q=0).\n" +
    "Changes propagate immediately without a clock edge.",
  models: {
    digital: {
      executeFn: executeRSAsync,
      inputSchema: ["S", "R"],
      outputSchema: ["Q", "~Q"],
      stateSlotCount: 2,
      defaultDelay: 10,
    },
    analog: {
      factory: makeRSAsyncLatchAnalogFactory(),
    },
  },
  defaultModel: "digital",
};
