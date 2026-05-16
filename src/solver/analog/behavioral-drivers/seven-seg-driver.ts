/**
 * BehavioralSevenSegDriverElement — observation + drive driver leaf for the
 * seven-segment display. See and-driver.ts for the normalized-bit
 * driver-chain architecture.
 *
 * Reads eight segment-input voltages (a, b, c, d, e, f, g, dp) from rhsOld
 * relative to gnd, threshold-classifies each at 0.5 V, and writes the logic
 * level to the corresponding SEG_* observation slot (consumed by the parent
 * composite's draw() function) and stamps a Norton source at the matching
 * ctrl_a..ctrl_g output net.
 *
 * pinLayout: 9 INPUT pins (8 segments + gnd) + 7 OUTPUT pins (ctrl_a..ctrl_g).
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

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

const SCHEMA: StateSchema = defineStateSchema("BehavioralSevenSegDriver", [
  { name: "SEG_A",  doc: "Observation-only logic level (0 or 1) for segment a. Written each load(); read by the parent component's draw() to determine illumination." },
  { name: "SEG_B",  doc: "Observation-only logic level (0 or 1) for segment b." },
  { name: "SEG_C",  doc: "Observation-only logic level (0 or 1) for segment c." },
  { name: "SEG_D",  doc: "Observation-only logic level (0 or 1) for segment d." },
  { name: "SEG_E",  doc: "Observation-only logic level (0 or 1) for segment e." },
  { name: "SEG_F",  doc: "Observation-only logic level (0 or 1) for segment f." },
  { name: "SEG_G",  doc: "Observation-only logic level (0 or 1) for segment g." },
  { name: "SEG_DP", doc: "Observation-only logic level (0 or 1) for the decimal point segment (dp)." },
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

  constructor(pinNodes: ReadonlyMap<string, number>, _props: PropertyBag) {
    super(pinNodes);
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
    const base = this._stateBase;

    const gnd  = rhsOld[this._gndNode];
    const segA  = rhsOld[this.pinNodes.get("a")!]  - gnd;
    const segB  = rhsOld[this.pinNodes.get("b")!]  - gnd;
    const segC  = rhsOld[this.pinNodes.get("c")!]  - gnd;
    const segD  = rhsOld[this.pinNodes.get("d")!]  - gnd;
    const segE  = rhsOld[this.pinNodes.get("e")!]  - gnd;
    const segF  = rhsOld[this.pinNodes.get("f")!]  - gnd;
    const segG  = rhsOld[this.pinNodes.get("g")!]  - gnd;
    const segDP = rhsOld[this.pinNodes.get("dp")!] - gnd;

    // Bottom-of-load writes — every slot mutated this step writes to s0 once.
    s0[base + SLOT_SEG_A]  = segA;
    s0[base + SLOT_SEG_B]  = segB;
    s0[base + SLOT_SEG_C]  = segC;
    s0[base + SLOT_SEG_D]  = segD;
    s0[base + SLOT_SEG_E]  = segE;
    s0[base + SLOT_SEG_F]  = segF;
    s0[base + SLOT_SEG_G]  = segG;
    s0[base + SLOT_SEG_DP] = segDP;

    stampNortonValue(ctx, this._handlesA, this._ctrlANode, this._gndNode, 1, segA);
    stampNortonValue(ctx, this._handlesB, this._ctrlBNode, this._gndNode, 1, segB);
    stampNortonValue(ctx, this._handlesC, this._ctrlCNode, this._gndNode, 1, segC);
    stampNortonValue(ctx, this._handlesD, this._ctrlDNode, this._gndNode, 1, segD);
    stampNortonValue(ctx, this._handlesE, this._ctrlENode, this._gndNode, 1, segE);
    stampNortonValue(ctx, this._handlesF, this._ctrlFNode, this._gndNode, 1, segF);
    stampNortonValue(ctx, this._handlesG, this._ctrlGNode, this._gndNode, 1, segG);
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(_key: string, _value: number): void {
    // No hot-loadable params.
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
      paramDefs: [],
      params: {},
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralSevenSegDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
