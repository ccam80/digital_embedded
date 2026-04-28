/**
 * RS Flip-Flop — edge-triggered with S/R control inputs.
 *
 * On rising clock edge:
 *   S=0, R=0 → no change (hold)
 *   S=1, R=0 → set (Q=1)
 *   S=0, R=1 → reset (Q=0)
 *   S=1, R=1 → undefined (random — per Digital's implementation)
 *
 * Input layout:  [S=0, C=1, R=2]
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
import { PropertyBag, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import { makeRSFlipflopAnalogFactory } from "../../solver/analog/behavioral-flipflop/rs.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 3;
// 3 inputs, 2 outputs, symmetric=false: offs=0, no even correction
// inputs: S@y=0, C@y=1, R@y=2; outputs: Q@y=0, ~Q@y=1
// max(3,2)=3, yBottom=(3-1)+0.5=2.5, height=2.5+0.5=3

// ---------------------------------------------------------------------------
// Pin declarations — GenericShape positions (symmetric=false, 3 inputs, 2 outputs)
// inputs: S@y=0, C@y=1, R@y=2
// outputs: Q@y=0, ~Q@y=1
// ---------------------------------------------------------------------------

export const RS_FF_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "S",
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
    label: "R",
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
// RSElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class RSElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("RS_FF", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(RS_FF_PIN_DECLARATIONS, ["C"]);
  }

  getBoundingBox(): Rect {
    const b = genericShapeBounds(3, 2, COMP_WIDTH);
    return { x: this.position.x + b.localX, y: this.position.y + b.localY, width: b.width, height: b.height };
  }

  draw(ctx: RenderContext): void {
    drawGenericShape(ctx, {
      inputLabels: ["S", "C", "R"],
      outputLabels: ["Q", "~Q"],
      clockInputIndices: [1],
      componentName: "RS",
      width: 3,
      label: this._visibleLabel(),
      rotation: this.rotation,
    });
  }

}

// ---------------------------------------------------------------------------
// executeRS — flat simulation function
//
// Input layout:  [S=0, C=1, R=2]
// Output layout: [Q=0, ~Q=1]
// State layout:  [storedQ=0, prevClock=1]
//
// S=1, R=1 on clock edge: undefined behavior — output remains unchanged
// (deterministic undefined: Digital uses random, we use hold for reproducibility in tests)
// ---------------------------------------------------------------------------

export function sampleRS(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const stBase = layout.stateOffset(index);

  const s = state[wt[inBase]];
  const clock = state[wt[inBase + 1]];
  const r = state[wt[inBase + 2]];
  const prevClock = state[stBase + 1];

  if (clock !== 0 && prevClock === 0) {
    const sBit = s !== 0;
    const rBit = r !== 0;

    if (sBit && !rBit) {
      state[stBase] = 1;
    } else if (!sBit && rBit) {
      state[stBase] = 0;
    }
  }
  state[stBase + 1] = clock;
}

export function executeRS(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const outBase = layout.outputOffset(index);
  const stBase = layout.stateOffset(index);

  const q = state[stBase];
  state[wt[outBase]] = q;
  state[wt[outBase + 1]] = q !== 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// RS_FF_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const RS_FF_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "inverterConfig", propertyKey: "_inverterLabels", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const RS_FF_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// RSDefinition — ComponentDefinition
// ---------------------------------------------------------------------------

function rsFactory(props: PropertyBag): RSElement {
  return new RSElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const RSDefinition: ComponentDefinition = {
  name: "RS_FF",
  typeId: -1,
  factory: rsFactory,
  pinLayout: RS_FF_PIN_DECLARATIONS,
  propertyDefs: RS_FF_PROPERTY_DEFS,
  attributeMap: RS_FF_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.FLIP_FLOPS,
  helpText:
    "RS Flip-Flop — edge-triggered with S/R control inputs.\n" +
    "On rising clock edge: S=0,R=0 → hold; S=1,R=0 → set; S=0,R=1 → reset; S=1,R=1 → undefined.\n" +
    "Q and ~Q outputs are always complementary (except on S=R=1).",
  modelRegistry: {
    behavioral: {
      kind: "inline",
      factory: makeRSFlipflopAnalogFactory(),
      paramDefs: [],
      params: {},
      mayCreateInternalNodes: false,
    },
  },
  models: {
    digital: {
      executeFn: executeRS,
      sampleFn: sampleRS,
      inputSchema: ["S", "C", "R"],
      outputSchema: ["Q", "~Q"],
      stateSlotCount: 2,
      defaultDelay: 10,
    },
  },
  defaultModel: "digital",
};
