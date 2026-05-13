/**
 * BehavioralSevenSegDriverElement- observation-only driver leaf for the
 * seven-segment display.
 *
 * Reads eight segment-input voltages (a, b, c, d, e, f, g, dp) from rhsOld
 * relative to gnd, threshold-classifies each against vIH/vIL hysteresis, and
 * writes the resulting logic level to the corresponding SEG_* observation slot.
 * Those slots are consumed by the parent composite's draw() function to
 * determine which segments to illuminate; no electrical output pins exist on
 * this component (the display itself is the consumer).
 *
 * pinLayout: 8 INPUT-only segment pins + 1 INPUT gnd (no OUTPUT pins).
 * schema: 8 observation-only SEG_* slots.
 * load(): 8 independent threshold classifications, no edge detection, no latching.
 */

import {
  defineStateSchema,
  type StateSchema,
} from "../state-schema.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../ngspice-load-order.js";
import { PoolBackedAnalogElement } from "../element.js";
import type { SetupContext } from "../setup-context.js";
import type { LoadContext } from "../load-context.js";
import { allocNortonStamp, stampNortonValue } from "../stamp-helpers.js";
import type { ComponentDefinition } from "../../../core/registry.js";
import type { PropertyBag } from "../../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../../core/pin.js";
import { logicLevel } from "./edge-detect.js";

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

const SCHEMA: StateSchema = defineStateSchema("BehavioralSevenSegDriver", [
  {
    name: "SEG_A",
    doc: "Observation-only logic level (0 or 1) for segment a. Written each load(); read by the parent component's draw() to determine illumination.",
  },
  {
    name: "SEG_B",
    doc: "Observation-only logic level (0 or 1) for segment b.",
  },
  {
    name: "SEG_C",
    doc: "Observation-only logic level (0 or 1) for segment c.",
  },
  {
    name: "SEG_D",
    doc: "Observation-only logic level (0 or 1) for segment d.",
  },
  {
    name: "SEG_E",
    doc: "Observation-only logic level (0 or 1) for segment e.",
  },
  {
    name: "SEG_F",
    doc: "Observation-only logic level (0 or 1) for segment f.",
  },
  {
    name: "SEG_G",
    doc: "Observation-only logic level (0 or 1) for segment g.",
  },
  {
    name: "SEG_DP",
    doc: "Observation-only logic level (0 or 1) for the decimal point segment (dp).",
  },
]);

const SLOT_SEG_A  = SCHEMA.indexOf.get("SEG_A")!;
const SLOT_SEG_B  = SCHEMA.indexOf.get("SEG_B")!;
const SLOT_SEG_C  = SCHEMA.indexOf.get("SEG_C")!;
const SLOT_SEG_D  = SCHEMA.indexOf.get("SEG_D")!;
const SLOT_SEG_E  = SCHEMA.indexOf.get("SEG_E")!;
const SLOT_SEG_F  = SCHEMA.indexOf.get("SEG_F")!;
const SLOT_SEG_G  = SCHEMA.indexOf.get("SEG_G")!;
const SLOT_SEG_DP = SCHEMA.indexOf.get("SEG_DP")!;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------
//
// Order MUST match the buildSevenSegNetlist drv connectivity row
// `[0, 1, 2, 3, 4, 5, 6, 7, netGnd(8)]` mapping to ports
// `[a, b, c, d, e, f, g, dp, gnd]`. The compiler reads pinLayout[i].label
// and stores it in pinNodes against the resolved node from connectivity[i].
//
// All 9 pins are INPUT direction. There are no OUTPUT pins on this driver;
// the display rendering is the sole consumer of the SEG_* observation slots.

const SEVEN_SEG_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "a",      defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "b",      defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "c",      defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "d",      defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "e",      defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "f",      defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "g",      defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "dp",     defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "gnd",    defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_a", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_b", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_c", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_d", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_e", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_f", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_g", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// BehavioralSevenSegDriverElement
// ---------------------------------------------------------------------------

export class BehavioralSevenSegDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private _vIH: number;
  private _vIL: number;
  private _rOut: number;
  private _vOH: number;
  private _vOL: number;

  private _ctrlANode: number;
  private _ctrlBNode: number;
  private _ctrlCNode: number;
  private _ctrlDNode: number;
  private _ctrlENode: number;
  private _ctrlFNode: number;
  private _ctrlGNode: number;
  private _gndNode: number;

  private _handlesA: readonly [number, number, number, number];
  private _handlesB: readonly [number, number, number, number];
  private _handlesC: readonly [number, number, number, number];
  private _handlesD: readonly [number, number, number, number];
  private _handlesE: readonly [number, number, number, number];
  private _handlesF: readonly [number, number, number, number];
  private _handlesG: readonly [number, number, number, number];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._vIH = props.getModelParam<number>("vIH");
    this._vIL = props.getModelParam<number>("vIL");
    this._rOut = props.getModelParam<number>("rOut");
    this._vOH  = props.getModelParam<number>("vOH");
    this._vOL  = props.getModelParam<number>("vOL");
    this._ctrlANode = -1;
    this._ctrlBNode = -1;
    this._ctrlCNode = -1;
    this._ctrlDNode = -1;
    this._ctrlENode = -1;
    this._ctrlFNode = -1;
    this._ctrlGNode = -1;
    this._gndNode = -1;
    this._handlesA = [-1, -1, -1, -1];
    this._handlesB = [-1, -1, -1, -1];
    this._handlesC = [-1, -1, -1, -1];
    this._handlesD = [-1, -1, -1, -1];
    this._handlesE = [-1, -1, -1, -1];
    this._handlesF = [-1, -1, -1, -1];
    this._handlesG = [-1, -1, -1, -1];
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    this._gndNode   = this.pinNodes.get("gnd")!;
    this._ctrlANode = this.pinNodes.get("ctrl_a")!;
    this._ctrlBNode = this.pinNodes.get("ctrl_b")!;
    this._ctrlCNode = this.pinNodes.get("ctrl_c")!;
    this._ctrlDNode = this.pinNodes.get("ctrl_d")!;
    this._ctrlENode = this.pinNodes.get("ctrl_e")!;
    this._ctrlFNode = this.pinNodes.get("ctrl_f")!;
    this._ctrlGNode = this.pinNodes.get("ctrl_g")!;
    this._handlesA = allocNortonStamp(ctx.solver, this._ctrlANode, this._gndNode);
    this._handlesB = allocNortonStamp(ctx.solver, this._ctrlBNode, this._gndNode);
    this._handlesC = allocNortonStamp(ctx.solver, this._ctrlCNode, this._gndNode);
    this._handlesD = allocNortonStamp(ctx.solver, this._ctrlDNode, this._gndNode);
    this._handlesE = allocNortonStamp(ctx.solver, this._ctrlENode, this._gndNode);
    this._handlesF = allocNortonStamp(ctx.solver, this._ctrlFNode, this._gndNode);
    this._handlesG = allocNortonStamp(ctx.solver, this._ctrlGNode, this._gndNode);
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    const gnd = rhsOld[this.pinNodes.get("gnd")!];
    const vA  = rhsOld[this.pinNodes.get("a")!]  - gnd;
    const vB  = rhsOld[this.pinNodes.get("b")!]  - gnd;
    const vC  = rhsOld[this.pinNodes.get("c")!]  - gnd;
    const vD  = rhsOld[this.pinNodes.get("d")!]  - gnd;
    const vE  = rhsOld[this.pinNodes.get("e")!]  - gnd;
    const vF  = rhsOld[this.pinNodes.get("f")!]  - gnd;
    const vG  = rhsOld[this.pinNodes.get("g")!]  - gnd;
    const vDP = rhsOld[this.pinNodes.get("dp")!] - gnd;

    // Threshold-classify each segment voltage with vIH/vIL hysteresis.
    // logicLevel holds the previous value when the input sits in the
    // indeterminate band (same convention as d-flipflop driver).
    const segA  = logicLevel(vA,  this._vIH, this._vIL, s1[base + SLOT_SEG_A]  >= 0.5 ? 1 : 0);
    const segB  = logicLevel(vB,  this._vIH, this._vIL, s1[base + SLOT_SEG_B]  >= 0.5 ? 1 : 0);
    const segC  = logicLevel(vC,  this._vIH, this._vIL, s1[base + SLOT_SEG_C]  >= 0.5 ? 1 : 0);
    const segD  = logicLevel(vD,  this._vIH, this._vIL, s1[base + SLOT_SEG_D]  >= 0.5 ? 1 : 0);
    const segE  = logicLevel(vE,  this._vIH, this._vIL, s1[base + SLOT_SEG_E]  >= 0.5 ? 1 : 0);
    const segF  = logicLevel(vF,  this._vIH, this._vIL, s1[base + SLOT_SEG_F]  >= 0.5 ? 1 : 0);
    const segG  = logicLevel(vG,  this._vIH, this._vIL, s1[base + SLOT_SEG_G]  >= 0.5 ? 1 : 0);
    const segDP = logicLevel(vDP, this._vIH, this._vIL, s1[base + SLOT_SEG_DP] >= 0.5 ? 1 : 0);

    // Bottom-of-load writes — every slot mutated this step writes to s0
    // exactly once (no pre-stamp s0 mutations).
    s0[base + SLOT_SEG_A]  = segA;
    s0[base + SLOT_SEG_B]  = segB;
    s0[base + SLOT_SEG_C]  = segC;
    s0[base + SLOT_SEG_D]  = segD;
    s0[base + SLOT_SEG_E]  = segE;
    s0[base + SLOT_SEG_F]  = segF;
    s0[base + SLOT_SEG_G]  = segG;
    s0[base + SLOT_SEG_DP] = segDP;

    stampNortonValue(ctx, this._handlesA, this._ctrlANode, this._gndNode, this._rOut, segA ? this._vOH : this._vOL);
    stampNortonValue(ctx, this._handlesB, this._ctrlBNode, this._gndNode, this._rOut, segB ? this._vOH : this._vOL);
    stampNortonValue(ctx, this._handlesC, this._ctrlCNode, this._gndNode, this._rOut, segC ? this._vOH : this._vOL);
    stampNortonValue(ctx, this._handlesD, this._ctrlDNode, this._gndNode, this._rOut, segD ? this._vOH : this._vOL);
    stampNortonValue(ctx, this._handlesE, this._ctrlENode, this._gndNode, this._rOut, segE ? this._vOH : this._vOL);
    stampNortonValue(ctx, this._handlesF, this._ctrlFNode, this._gndNode, this._rOut, segF ? this._vOH : this._vOL);
    stampNortonValue(ctx, this._handlesG, this._ctrlGNode, this._gndNode, this._rOut, segG ? this._vOH : this._vOL);
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if (key === "vIH") this._vIH = value;
    else if (key === "vIL") this._vIL = value;
    else if (key === "rOut") this._rOut = value;
    else if (key === "vOH") this._vOH = value;
    else if (key === "vOL") this._vOL = value;
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const BehavioralSevenSegDriverDefinition: ComponentDefinition = {
  name: "BehavioralSevenSegDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: SEVEN_SEG_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "vIH",  default: 2.0 },
        { key: "vIL",  default: 0.8 },
        { key: "rOut", default: 100  },
        { key: "vOH",  default: 5    },
        { key: "vOL",  default: 0    },
      ],
      params: { vIH: 2.0, vIL: 0.8, rOut: 100, vOH: 5, vOL: 0 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralSevenSegDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
