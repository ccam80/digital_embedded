/**
 * BehavioralDAsyncFlipflopDriverElement- pure-truth-function driver leaf for
 * the D flip-flop with asynchronous Set / Clr.
 *
 * On rising clock edge: latch D (same as M14 D-FF).
 *
 * After the clocked update, async Set / Clr override the latched state every
 * load() pass. Collision policy preserved from
 * `.recovery/behavioral-flipflop-d-async.ts.orig`'s
 * `BehavioralDAsyncFlipflopElement.accept()`- Set runs first (Set high â†’ q=1),
 * Clr runs second (Clr high â†’ q=0). When both are high, **Clr wins**.
 *
 * Per Composite M20 (phase-composite-architecture.md), J-141
 * (contracts_group_10.md).
 */

import {
  defineStateSchema,
  type StateSchema,
} from "../state-schema.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../ngspice-load-order.js";
import { PoolBackedAnalogElement } from "../element.js";
import type { SetupContext } from "../setup-context.js";
import type { LoadContext } from "../load-context.js";
import type { ComponentDefinition } from "../../../core/registry.js";
import type { PropertyBag } from "../../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../../core/pin.js";
import { allocNortonStamp, stampNortonValue } from "../stamp-helpers.js";

const SCHEMA: StateSchema = defineStateSchema("BehavioralDAsyncFlipflopDriver", [
  { name: "LAST_CLOCK", doc: "Clock voltage at last accepted timestep. NaN sentinel on first sample skips edge detection." },
  { name: "Q",          doc: "Latched output bit." },
]);

const SLOT_LAST_CLOCK = SCHEMA.indexOf.get("LAST_CLOCK")!;
const SLOT_Q          = SCHEMA.indexOf.get("Q")!;

// Pin order matches buildDAsyncFlipflopNetlist drv row [0..6] = Set,D,C,Clr,ctrl_q,ctrl_nq,gnd.
const D_AS_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "Set",     defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "D",       defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "C",       defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: true,  kind: "signal" },
  { direction: PinDirection.INPUT,  label: "Clr",     defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_q",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_nq", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "gnd",     defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

export class BehavioralDAsyncFlipflopDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private _vIH: number;
  private _vIL: number;
  private _rOut: number;
  private _vOH: number;
  private _vOL: number;

  private _firstSample: boolean = true;

  private _ctrlQNode: number = 0;
  private _ctrlNqNode: number = 0;
  private _gndNode: number = 0;
  private _handlesQ: readonly [number, number, number, number] = [-1, -1, -1, -1];
  private _handlesNq: readonly [number, number, number, number] = [-1, -1, -1, -1];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._vIH = props.getModelParam<number>("vIH");
    this._vIL = props.getModelParam<number>("vIL");
    this._rOut = props.getModelParam<number>("rOut");
    this._vOH = props.getModelParam<number>("vOH");
    this._vOL = props.getModelParam<number>("vOL");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    this._ctrlQNode  = this.pinNodes.get("ctrl_q")!;
    this._ctrlNqNode = this.pinNodes.get("ctrl_nq")!;
    this._gndNode    = this.pinNodes.get("gnd")!;
    this._handlesQ  = allocNortonStamp(ctx.solver, this._ctrlQNode,  this._gndNode);
    this._handlesNq = allocNortonStamp(ctx.solver, this._ctrlNqNode, this._gndNode);
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    const gnd    = rhsOld[this._gndNode];
    const vClock = rhsOld[this.pinNodes.get("C")!]   - gnd;
    const vD     = rhsOld[this.pinNodes.get("D")!]   - gnd;
    const vSet   = rhsOld[this.pinNodes.get("Set")!] - gnd;
    const vClr   = rhsOld[this.pinNodes.get("Clr")!] - gnd;

    const prevClock = s1[base + SLOT_LAST_CLOCK];
    let q = s1[base + SLOT_Q] >= 0.5 ? 1 : 0;

    const risingEdge =
      !this._firstSample &&
      prevClock < this._vIH &&
      vClock >= this._vIH;
    this._firstSample = false;

    if (risingEdge) {
      if (vD >= this._vIH)     q = 1;
      else if (vD < this._vIL) q = 0;
    }

    if (vSet > this._vIH) q = 1;
    if (vClr > this._vIH) q = 0;

    stampNortonValue(ctx, this._handlesQ,  this._ctrlQNode,  this._gndNode, this._rOut, q ? this._vOH : this._vOL);
    stampNortonValue(ctx, this._handlesNq, this._ctrlNqNode, this._gndNode, this._rOut, q ? this._vOL : this._vOH);

    s0[base + SLOT_LAST_CLOCK] = vClock;
    s0[base + SLOT_Q]          = q;
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

export const BehavioralDAsyncFlipflopDriverDefinition: ComponentDefinition = {
  name: "BehavioralDAsyncFlipflopDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: D_AS_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "vIH", default: 2.0 },
        { key: "vIL", default: 0.8 },
        { key: "rOut", default: 100 },
        { key: "vOH", default: 5 },
        { key: "vOL", default: 0 },
      ],
      params: { vIH: 2.0, vIL: 0.8, rOut: 100, vOH: 5, vOL: 0 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralDAsyncFlipflopDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
