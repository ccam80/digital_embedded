/**
 * RS Flip-Flop Async- level-sensitive (no clock), SR latch.
 *
 * Level-sensitive SR latch behavior (no clock):
 *   S=0, R=0 â†’ hold (or recover from forbidden state)
 *   S=1, R=0 â†’ Q=1, ~Q=0
 *   S=0, R=1 â†’ Q=0, ~Q=1
 *   S=1, R=1 â†’ forbidden (Q=0, ~Q=0 per Digital's implementation)
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
import { drawGenericShape, genericShapeBounds } from "../generic-shape.js";
import { PropertyBag, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type StandaloneComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 3;
// 2 inputs, 2 outputs, symmetric=false: offs=0, no even correction
// inputs: S@y=0, R@y=1; outputs: Q@y=0, ~Q@y=1
// max(2,2)=2, yBottom=(2-1)+0.5=1.5, height=1.5+0.5=2

// ---------------------------------------------------------------------------
// Pin declarations- GenericShape positions (symmetric=false, 2 inputs, 2 outputs)
// inputs: S@y=0, R@y=1
// outputs: Q@y=0, ~Q@y=1
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Behavioural model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: RS_FF_AS_BEHAVIORAL_PARAM_DEFS, defaults: RS_FF_AS_BEHAVIORAL_DEFAULTS } = defineModelParams({
  primary: {
    vIH:  { default: 2.0,   unit: "V", description: "Input high threshold (CMOS spec)" },
    vIL:  { default: 0.8,   unit: "V", description: "Input low threshold (CMOS spec)" },
    rOut: { default: 100,   unit: "Î©", description: "Output drive resistance" },
    cOut: { default: 1e-12, unit: "F", description: "Output companion capacitance" },
    vOH:  { default: 5.0,   unit: "V", description: "Output high voltage" },
    vOL:  { default: 0.0,   unit: "V", description: "Output low voltage" },
  },
});

// ---------------------------------------------------------------------------
// buildRSAsyncLatchNetlist- function-form netlist for the behavioural model
//
// Ports: S, R, Q, ~Q, gnd (indices 0..4) -- level-sensitive, no clock
// Sub-elements:
//   drv  : BehavioralRSAsyncLatchDriver  (1-bit pure-truth-function leaf)
//   qPin : DigitalOutputPinLoaded        (drives Q  from drv slot OUTPUT_LOGIC_LEVEL_Q)
//   nqPin: DigitalOutputPinLoaded        (drives ~Q from drv slot OUTPUT_LOGIC_LEVEL_NQ)
//
// Strictly 1-bit. Multi-bit composites instantiate this subcircuit per bit;
// bit-width replication is composite-expansion infrastructure.
// ---------------------------------------------------------------------------

export function buildRSAsyncLatchNetlist(params: PropertyBag): MnaSubcircuitNetlist {
  return {
    ports: ["S", "R", "Q", "~Q", "gnd"],
    params: { ...RS_FF_AS_BEHAVIORAL_DEFAULTS },
    elements: [
      {
        typeId: "BehavioralRSAsyncLatchDriver",
        modelRef: "default",
        subElementName: "drv",
        params: {
          vIH: params.getModelParam<number>("vIH"),
          vIL: params.getModelParam<number>("vIL"),
        },
      },
      {
        typeId: "DigitalOutputPinLoaded",
        modelRef: "default",
        subElementName: "qPin",
        params: {
          rOut: params.getModelParam<number>("rOut"),
          cOut: params.getModelParam<number>("cOut"),
          vOH:  params.getModelParam<number>("vOH"),
          vOL:  params.getModelParam<number>("vOL"),
          inputLogic: { kind: "siblingState", subElementName: "drv",
                        slotName: "OUTPUT_LOGIC_LEVEL_Q" },
        },
      },
      {
        typeId: "DigitalOutputPinLoaded",
        modelRef: "default",
        subElementName: "nqPin",
        params: {
          rOut: params.getModelParam<number>("rOut"),
          cOut: params.getModelParam<number>("cOut"),
          vOH:  params.getModelParam<number>("vOH"),
          vOL:  params.getModelParam<number>("vOL"),
          inputLogic: { kind: "siblingState", subElementName: "drv",
                        slotName: "OUTPUT_LOGIC_LEVEL_NQ" },
        },
      },
    ],
    internalNetCount: 0,
    netlist: [
      [0, 1, 2, 3, 4],   // drv: S, R, Q, ~Q, gnd
      [2, 4],            // qPin:  Q  to gnd
      [3, 4],            // nqPin: ~Q to gnd
    ],
  } as MnaSubcircuitNetlist;
}

const RS_FF_AS_PIN_DECLARATIONS: PinDeclaration[] = [
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
    label: "R",
    defaultBitWidth: 1,
    position: { x: 0, y: 1 },
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
// RSAsyncElement- CircuitElement implementation
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
    const b = genericShapeBounds(2, 2, COMP_WIDTH);
    return { x: this.position.x + b.localX, y: this.position.y + b.localY, width: b.width, height: b.height };
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
// executeRSAsync- flat simulation function
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
// RSAsyncDefinition- StandaloneComponentDefinition
// ---------------------------------------------------------------------------

function rsAsyncFactory(props: PropertyBag): RSAsyncElement {
  return new RSAsyncElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const RSAsyncDefinition: StandaloneComponentDefinition = {
  name: "RS_FF_AS",
  typeId: -1,
  factory: rsAsyncFactory,
  pinLayout: RS_FF_AS_PIN_DECLARATIONS,
  propertyDefs: RS_FF_AS_PROPERTY_DEFS,
  attributeMap: RS_FF_AS_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.FLIP_FLOPS,
  helpText:
    "RS Flip-Flop Async- level-sensitive SR latch (no clock).\n" +
    "S=1, R=0 â†’ Q=1; S=0, R=1 â†’ Q=0; S=0, R=0 â†’ hold; S=1, R=1 â†’ forbidden (Q=~Q=0).\n" +
    "Changes propagate immediately without a clock edge.",
  modelRegistry: {
    behavioral: {
      kind: "netlist",
      netlist: buildRSAsyncLatchNetlist,
      paramDefs: RS_FF_AS_BEHAVIORAL_PARAM_DEFS,
      params: RS_FF_AS_BEHAVIORAL_DEFAULTS,
    },
  },
  models: {
    digital: {
      executeFn: executeRSAsync,
      inputSchema: ["S", "R"],
      outputSchema: ["Q", "~Q"],
      stateSlotCount: 2,
      defaultDelay: 10,
    },
  },
  defaultModel: "digital",
};
