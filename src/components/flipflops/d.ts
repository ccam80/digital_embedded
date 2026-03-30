/**
 * D Flip-Flop component — edge-triggered data storage.
 *
 * Stores D input on rising clock edge. Q and ~Q outputs are complementary.
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
import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";

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
    let decls: PinDeclaration[] = [
      {
        direction: PinDirection.INPUT,
        label: "D",
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
    const activeModel = this._properties.getOrDefault<string>("model", "");
    if (activeModel && DDefinition.modelRegistry?.[activeModel]) {
      decls = [
        ...decls,
        {
          direction: PinDirection.INPUT,
          label: "VDD",
          defaultBitWidth: 1,
          position: { x: COMP_WIDTH / 2, y: -1 },
          isNegatable: false,
          isClockCapable: false,
          kind: "power",
        },
        {
          direction: PinDirection.INPUT,
          label: "GND",
          defaultBitWidth: 1,
          position: { x: COMP_WIDTH / 2, y: 2 },
          isNegatable: false,
          isClockCapable: false,
          kind: "power",
        },
      ];
    }
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
// CMOS_D_FF_NETLIST — master-slave CMOS D flip-flop structural netlist
//
// Topology: two-stage (master + slave) CMOS transmission-gate D flip-flop.
// Ports: D, C, Q, ~Q, VDD, GND
// Master stage: TG1 (C-controlled), INV1, INV2 (master latch)
// Slave stage:  TG2 (~C-controlled), INV3, INV4 (slave latch)
// Each transmission gate: one PMOS + one NMOS in parallel (pass-gate pair).
// ---------------------------------------------------------------------------

const CMOS_D_FF_NETLIST: MnaSubcircuitNetlist = {
  ports: ["D", "C", "Q", "~Q", "VDD", "GND"],
  params: {},
  elements: [
    // Master TG1: passes D when C=1 (PMOS gate=C, NMOS gate=C)
    { typeId: "PMOS", branchCount: 0 }, // m_tg1_p
    { typeId: "NMOS", branchCount: 0 }, // m_tg1_n
    // Master inverter INV1 (PMOS + NMOS)
    { typeId: "PMOS", branchCount: 0 }, // m_inv1_p
    { typeId: "NMOS", branchCount: 0 }, // m_inv1_n
    // Master feedback INV2 (PMOS + NMOS) — closes the master latch
    { typeId: "PMOS", branchCount: 0 }, // m_inv2_p
    { typeId: "NMOS", branchCount: 0 }, // m_inv2_n
    // Slave TG2: passes master output when C=0 (PMOS gate=~C, NMOS gate=C)
    { typeId: "PMOS", branchCount: 0 }, // s_tg2_p
    { typeId: "NMOS", branchCount: 0 }, // s_tg2_n
    // Slave inverter INV3 (PMOS + NMOS) — drives Q
    { typeId: "PMOS", branchCount: 0 }, // s_inv3_p
    { typeId: "NMOS", branchCount: 0 }, // s_inv3_n
    // Slave feedback INV4 (PMOS + NMOS) — closes the slave latch
    { typeId: "PMOS", branchCount: 0 }, // s_inv4_p
    { typeId: "NMOS", branchCount: 0 }, // s_inv4_n
    // Clock buffer INV (PMOS + NMOS) — generates ~C
    { typeId: "PMOS", branchCount: 0 }, // clk_inv_p
    { typeId: "NMOS", branchCount: 0 }, // clk_inv_n
  ],
  // Internal nets (indices >= 6):
  //   6 = ~C (inverted clock)
  //   7 = m_in  (master TG1 output / master latch input)
  //   8 = m_out (master INV1 output / master latch feedback point)
  //   9 = s_in  (slave TG2 output / slave latch input = ~Q internal)
  internalNetCount: 4,
  // Ports: D=0, C=1, Q=2, ~Q=3, VDD=4, GND=5
  // Internal: ~C=6, m_in=7, m_out=8, s_in=9
  // PMOS/NMOS pins: [D, G, S] (Drain, Gate, Source)
  netlist: [
    // Master TG1_p: D=VDD_side(source), G=C, S=m_in  → [VDD, C, m_in] — wait, TG passes D→m_in
    // TG1: D pin connects to D(0), output m_in(7). PMOS: [D=0, G=C_bar=6, S=7], NMOS: [D=0, G=C=1, S=7]
    [0, 6, 7],  // m_tg1_p: D=D(0), G=~C(6), S=m_in(7)
    [0, 1, 7],  // m_tg1_n: D=D(0), G=C(1), S=m_in(7)
    // Master INV1: input=m_in(7), output=m_out(8)
    [4, 7, 8],  // m_inv1_p: D=VDD(4), G=m_in(7), S=m_out(8)
    [8, 7, 5],  // m_inv1_n: D=m_out(8), G=m_in(7), S=GND(5)
    // Master INV2 (feedback): input=m_out(8), output=m_in(7) — latch closure
    [4, 8, 7],  // m_inv2_p: D=VDD(4), G=m_out(8), S=m_in(7)
    [7, 8, 5],  // m_inv2_n: D=m_in(7), G=m_out(8), S=GND(5)
    // Slave TG2: m_out(8)→s_in(9), passes when C=0 (PMOS gate=C, NMOS gate=~C)
    [8, 1, 9],  // s_tg2_p: D=m_out(8), G=C(1), S=s_in(9)
    [8, 6, 9],  // s_tg2_n: D=m_out(8), G=~C(6), S=s_in(9)
    // Slave INV3: input=s_in(9), output=Q(2)
    [4, 9, 2],  // s_inv3_p: D=VDD(4), G=s_in(9), S=Q(2)
    [2, 9, 5],  // s_inv3_n: D=Q(2), G=s_in(9), S=GND(5)
    // Slave INV4 (feedback): input=Q(2), output=s_in(9) → drives ~Q(3) too
    [4, 2, 9],  // s_inv4_p: D=VDD(4), G=Q(2), S=s_in(9)
    [9, 2, 5],  // s_inv4_n: D=s_in(9), G=Q(2), S=GND(5)
    // Clock INV: input=C(1), output=~C(6)
    [4, 1, 6],  // clk_inv_p: D=VDD(4), G=C(1), S=~C(6)
    [6, 1, 5],  // clk_inv_n: D=~C(6), G=C(1), S=GND(5)
  ],
};

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
  modelRegistry: {
    cmos: {
      kind: "netlist",
      netlist: CMOS_D_FF_NETLIST,
      paramDefs: [],
      params: {},
    },
  },
  models: {
    digital: {
      executeFn: executeD,
      sampleFn: sampleD,
      inputSchema: ["D", "C"],
      outputSchema: ["Q", "~Q"],
      stateSlotCount: 2,
      defaultDelay: 10,
    },
  },
  defaultModel: "digital",
};
