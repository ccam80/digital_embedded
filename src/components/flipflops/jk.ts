/**
 * JK Flip-Flop- edge-triggered with J/K control inputs.
 *
 * On rising clock edge:
 *   J=0, K=0 â†’ no change (hold)
 *   J=1, K=0 â†’ set (Q=1)
 *   J=0, K=1 â†’ reset (Q=0)
 *   J=1, K=1 â†’ toggle (Q=~Q)
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
import { drawGenericShape, genericShapeBounds } from "../generic-shape.js";
import { PropertyBag, PropertyType, LABEL_PROPERTY_DEF } from "../../core/properties.js";
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
// 3 inputs, 2 outputs, symmetric=false: offs=0, no even correction
// inputs: J@y=0, C@y=1, K@y=2; outputs: Q@y=0, ~Q@y=1
// max(3,2)=3, yBottom=(3-1)+0.5=2.5, height=2.5+0.5=3

// ---------------------------------------------------------------------------
// Pin declarations- GenericShape positions (symmetric=false, 3 inputs, 2 outputs)
// inputs: J@y=0, C@y=1, K@y=2
// outputs: Q@y=0, ~Q@y=1
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Behavioural model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: JK_FF_BEHAVIORAL_PARAM_DEFS, defaults: JK_FF_BEHAVIORAL_DEFAULTS } = defineModelParams({
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
// buildJKFlipflopNetlist- function-form netlist for the behavioural model
//
// Ports: J, C, K, Q, ~Q, gnd (indices 0..5)
// Sub-elements:
//   drv  : BehavioralJKFlipflopDriver  (1-bit pure-truth-function leaf)
//   qPin : DigitalOutputPinLoaded      (drives Q  from drv slot OUTPUT_LOGIC_LEVEL_Q)
//   nqPin: DigitalOutputPinLoaded      (drives ~Q from drv slot OUTPUT_LOGIC_LEVEL_NQ)
//
// Strictly 1-bit. Multi-bit composites instantiate this subcircuit per bit;
// bit-width replication is composite-expansion infrastructure.
// ---------------------------------------------------------------------------

export function buildJKFlipflopNetlist(params: PropertyBag): MnaSubcircuitNetlist {
  return {
    ports: ["J", "C", "K", "Q", "~Q", "gnd"],
    params: { ...JK_FF_BEHAVIORAL_DEFAULTS },
    elements: [
      {
        typeId: "BehavioralJKFlipflopDriver",
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
      [0, 1, 2, 3, 4, 5],   // drv: J, C, K, Q, ~Q, gnd
      [3, 5],               // qPin:  Q  to gnd
      [4, 5],               // nqPin: ~Q to gnd
    ],
  } as MnaSubcircuitNetlist;
}

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
// JKElement- CircuitElement implementation
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
    const b = genericShapeBounds(3, 2, COMP_WIDTH);
    return { x: this.position.x + b.localX, y: this.position.y + b.localY, width: b.width, height: b.height };
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
// executeJK- flat simulation function
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
    structural: true,
  },
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// JKDefinition- StandaloneComponentDefinition
// ---------------------------------------------------------------------------

function jkFactory(props: PropertyBag): JKElement {
  return new JKElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const JKDefinition: StandaloneComponentDefinition = {
  name: "JK_FF",
  typeId: -1,
  factory: jkFactory,
  pinLayout: JK_FF_PIN_DECLARATIONS,
  propertyDefs: JK_FF_PROPERTY_DEFS,
  attributeMap: JK_FF_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.FLIP_FLOPS,
  helpText:
    "JK Flip-Flop- edge-triggered with J/K control inputs.\n" +
    "On rising clock edge: J=0,K=0 â†’ hold; J=1,K=0 â†’ set; J=0,K=1 â†’ reset; J=1,K=1 â†’ toggle.\n" +
    "Q and ~Q outputs are always complementary.",
  modelRegistry: {
    behavioral: {
      kind: "netlist",
      netlist: buildJKFlipflopNetlist,
      paramDefs: JK_FF_BEHAVIORAL_PARAM_DEFS,
      params: JK_FF_BEHAVIORAL_DEFAULTS,
    },
  },
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
