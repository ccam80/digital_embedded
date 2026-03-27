/**
 * JK Flip-Flop with async Set/Clear.
 *
 * JK logic on rising clock edge, with async Set/Clear inputs taking priority.
 * Set (active-high) forces Q=1. Clear (active-high) forces Q=0.
 *
 * Ported from ref/Digital/src/main/java/de/neemann/digital/core/flipflops/FlipflopJKAsync.java
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
import { drawGenericShape } from "../generic-shape.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import { makeJKAsyncFlipflopAnalogFactory } from "../../solver/analog/behavioral-flipflop-variants.js";

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
  },
  {
    direction: PinDirection.INPUT,
    label: "J",
    defaultBitWidth: 1,
    position: { x: 0, y: 1 },
    isNegatable: true,
    isClockCapable: false,
  },
  {
    direction: PinDirection.INPUT,
    label: "C",
    defaultBitWidth: 1,
    position: { x: 0, y: 2 },
    isNegatable: true,
    isClockCapable: true,
  },
  {
    direction: PinDirection.INPUT,
    label: "K",
    defaultBitWidth: 1,
    position: { x: 0, y: 3 },
    isNegatable: true,
    isClockCapable: false,
  },
  {
    direction: PinDirection.INPUT,
    label: "Clr",
    defaultBitWidth: 1,
    position: { x: 0, y: 4 },
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
    return this.derivePins(JK_FF_AS_PIN_DECLARATIONS, ["C"]);
  }

  getBoundingBox(): Rect {
    // Java GenericShape: 5 inputs odd → body height=5, topBorder=0.5
    const TOP = 0.5;
    return {
      x: this.position.x + 0.05,
      y: this.position.y - TOP,
      width: (COMP_WIDTH - 0.05) - 0.05,
      height: 5,
    };
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

  getHelpText(): string {
    return (
      "JK Flip-Flop with async Set/Clear.\n" +
      "Set (active-high) forces Q=1 asynchronously.\n" +
      "Clr (active-high) forces Q=0 asynchronously.\n" +
      "On rising clock edge: J=0,K=0 → hold; J=1,K=0 → set; J=0,K=1 → reset; J=1,K=1 → toggle."
    );
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

  if (clock !== 0 && prevClock === 0) {
    const jBit = j !== 0;
    const kBit = k !== 0;
    const qBit = state[stBase] !== 0;

    if (jBit && kBit) {
      state[stBase] = qBit ? 0 : 1;
    } else if (jBit) {
      state[stBase] = 1;
    } else if (kBit) {
      state[stBase] = 0;
    }
  }
  state[stBase + 1] = clock;

  if (setIn !== 0) {
    state[stBase] = 1;
  } else if (clr !== 0) {
    state[stBase] = 0;
  }

  const q = state[stBase];
  state[wt[outBase]] = q;
  state[wt[outBase + 1]] = q !== 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// JK_FF_AS_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const JK_FF_AS_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "inverterConfig", propertyKey: "_inverterLabels", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const JK_FF_AS_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown above the component",
  },
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
  models: {
    digital: {
      executeFn: executeJKAsync,
      inputSchema: ["Set", "J", "C", "K", "Clr"],
      outputSchema: ["Q", "~Q"],
      stateSlotCount: 2,
      defaultDelay: 10,
    },
    analog: {
      factory: makeJKAsyncFlipflopAnalogFactory(),
    },
  },
  defaultModel: "digital",
};
