/**
 * D Flip-Flop component — edge-triggered data storage.
 *
 * Stores D input on rising clock edge. Q and ~Q outputs are complementary.
 * Ported from ref/Digital/src/main/java/de/neemann/digital/core/flipflops/FlipflopD.java
 *
 * Internal state layout (stateOffset):
 *   slot 0: stored Q value (0 or 1)
 *
 * Signal array layout per instance:
 *   inputs:  [D, C]
 *   outputs: [Q, ~Q]
 *   state:   [storedQ, prevClock]
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
import { makeDFlipflopAnalogFactory } from "../../solver/analog/behavioral-flipflop.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

// Java GenericShape: 2 inputs, 2 outputs, symmetric=false (multiple outputs), width=3
// symmetric=false: offs=0, no even-input gap correction
// inputs: D@y=0, C@y=1; outputs: Q@y=0, ~Q@y=1
// max(2,2)=2, yBottom=(2-1)+0.5=1.5, height=1.5+0.5=2
const COMP_WIDTH = 3;

// ---------------------------------------------------------------------------
// Pin declarations — matches Java GenericShape.createPins() exactly
// ---------------------------------------------------------------------------

const D_FF_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "D",
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
    isNegatable: true,
    isClockCapable: true,
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
// DElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class DElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("D_FF", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const decls: PinDeclaration[] = [
      {
        direction: PinDirection.INPUT,
        label: "D",
        defaultBitWidth: bitWidth,
        position: { x: 0, y: 0 },
        isNegatable: true,
        isClockCapable: false,
      },
      {
        direction: PinDirection.INPUT,
        label: "C",
        defaultBitWidth: 1,
        position: { x: 0, y: 1 },
        isNegatable: true,
        isClockCapable: true,
      },
      {
        direction: PinDirection.OUTPUT,
        label: "Q",
        defaultBitWidth: bitWidth,
        position: { x: COMP_WIDTH, y: 0 },
        isNegatable: false,
        isClockCapable: false,
      },
      {
        direction: PinDirection.OUTPUT,
        label: "~Q",
        defaultBitWidth: bitWidth,
        position: { x: COMP_WIDTH, y: 1 },
        isNegatable: false,
        isClockCapable: false,
      },
    ];
    return this.derivePins(decls, ["C"]);
  }

  getBoundingBox(): Rect {
    // Java GenericShape: symmetric=false, max(2,2)=2, yBottom=(2-1)+0.5=1.5, height=1.5+0.5=2
    const TOP = 0.5;
    return {
      x: this.position.x + 0.05,
      y: this.position.y - TOP,
      width: (COMP_WIDTH - 0.05) - 0.05,
      height: 2,
    };
  }

  draw(ctx: RenderContext): void {
    drawGenericShape(ctx, {
      inputLabels: ["D", "C"],
      outputLabels: ["Q", "~Q"],
      clockInputIndices: [1],
      componentName: "D",
      width: 3,
      label: this._visibleLabel(),
      rotation: this.rotation,
    });
  }

  getHelpText(): string {
    return (
      "D Flip-Flop — stores the D input on the rising clock edge.\n" +
      "Q is the stored value, ~Q is its complement.\n" +
      "Edge-triggered: only samples D when clock transitions from 0 to 1."
    );
  }
}

// ---------------------------------------------------------------------------
// executeD — flat simulation function
//
// State layout:
//   stateOffset(index) + 0: stored Q value
//   stateOffset(index) + 1: previous clock value (for edge detection)
//
// Input layout:  [D=0, C=1]
// Output layout: [Q=0, ~Q=1]
// ---------------------------------------------------------------------------

export function sampleD(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const stBase = layout.stateOffset(index);

  const d = state[wt[inBase]];
  const clock = state[wt[inBase + 1]];
  const prevClock = state[stBase + 1];

  if (clock !== 0 && prevClock === 0) {
    state[stBase] = d;
  }
  state[stBase + 1] = clock;
}

export function executeD(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const outBase = layout.outputOffset(index);
  const stBase = layout.stateOffset(index);

  const bw = layout.getProperty(index, "bitWidth");
  const bitWidth = typeof bw === "number" ? bw : 1;
  const mask = bitWidth >= 32 ? 0xFFFFFFFF : ((1 << bitWidth) - 1);

  const q = state[stBase];
  state[wt[outBase]] = q;
  state[wt[outBase + 1]] = (~q & mask) >>> 0;
}

// ---------------------------------------------------------------------------
// D_FF_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const D_FF_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "inverterConfig", propertyKey: "_inverterLabels", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const D_FF_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of D and Q signals",
  },
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// DDefinition — ComponentDefinition
// ---------------------------------------------------------------------------

function dFactory(props: PropertyBag): DElement {
  return new DElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const DDefinition: ComponentDefinition = {
  name: "D_FF",
  typeId: -1,
  factory: dFactory,
  pinLayout: D_FF_PIN_DECLARATIONS,
  propertyDefs: D_FF_PROPERTY_DEFS,
  attributeMap: D_FF_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.FLIP_FLOPS,
  helpText:
    "D Flip-Flop — stores the D input on the rising clock edge.\n" +
    "Q is the stored value, ~Q is its complement.\n" +
    "Edge-triggered: only samples D when clock transitions from 0 to 1.",
  models: {
    digital: {
      executeFn: executeD,
      sampleFn: sampleD,
      inputSchema: ["D", "C"],
      outputSchema: ["Q", "~Q"],
      stateSlotCount: 2,
      defaultDelay: 10,
    },
    analog: {
      factory: makeDFlipflopAnalogFactory(),
      transistorModel: 'CmosDFlipflop',
    },
  },
  defaultModel: "digital",
};
