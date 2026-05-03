/**
 * BehavioralDAsyncFlipflopDriverElement- pure-truth-function driver leaf for
 * the D flip-flop with asynchronous Set / Clr.
 *
 * On rising clock edge: latch D (same as M14 D-FF).
 *
 * After the clocked update, async Set / Clr override the latched state every
 * load() pass. Collision policy preserved from
 * `.recovery/behavioral-flipflop-d-async.ts.orig`'s
 * `BehavioralDAsyncFlipflopElement.accept()`- Set runs first (Set high → q=1),
 * Clr runs second (Clr high → q=0). When both are high, **Clr wins**.
 *
 * Per Composite M20 (phase-composite-architecture.md), J-141
 * (contracts_group_10.md).
 */

import {
  defineStateSchema,
  applyInitialValues,
  type StateSchema,
} from "../state-schema.js";
import { NGSPICE_LOAD_ORDER } from "../ngspice-load-order.js";
import type { PoolBackedAnalogElement } from "../element.js";
import type { StatePoolRef } from "../state-pool.js";
import type { SetupContext } from "../setup-context.js";
import type { LoadContext } from "../load-context.js";
import type { ComponentDefinition } from "../../../core/registry.js";
import type { PropertyBag } from "../../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../../core/pin.js";

const SCHEMA: StateSchema = defineStateSchema("BehavioralDAsyncFlipflopDriver", [
  { name: "LAST_CLOCK",            doc: "Clock voltage at last accepted timestep. NaN sentinel on first sample skips edge detection.", init: { kind: "constant", value: Number.NaN } },
  { name: "Q",                     doc: "Latched output bit.",                                                                          init: { kind: "zero" } },
  { name: "OUTPUT_LOGIC_LEVEL_Q",  doc: "Q output level consumed via siblingState by qPin.",                                             init: { kind: "zero" } },
  { name: "OUTPUT_LOGIC_LEVEL_NQ", doc: "~Q output level consumed via siblingState by nqPin.",                                           init: { kind: "constant", value: 1 } },
]);

const SLOT_LAST_CLOCK = SCHEMA.indexOf.get("LAST_CLOCK")!;
const SLOT_Q          = SCHEMA.indexOf.get("Q")!;
const SLOT_OUT_Q      = SCHEMA.indexOf.get("OUTPUT_LOGIC_LEVEL_Q")!;
const SLOT_OUT_NQ     = SCHEMA.indexOf.get("OUTPUT_LOGIC_LEVEL_NQ")!;

// Pin order matches buildDAsyncFlipflopNetlist drv row [0..6] = Set,D,C,Clr,Q,~Q,gnd.
const D_AS_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "Set", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "D",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "C",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: true,  kind: "signal" },
  { direction: PinDirection.INPUT,  label: "Clr", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "Q",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "~Q",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "gnd", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

export class BehavioralDAsyncFlipflopDriverElement implements PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly stateSchema = SCHEMA;
  readonly poolBacked = true as const;
  readonly stateSize = SCHEMA.size;

  label = "";
  _pinNodes: Map<string, number>;
  _stateBase = -1;
  branchIndex = -1;

  private readonly _vIH: number;
  private readonly _vIL: number;
  private _pool!: StatePoolRef;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);
    this._vIH = props.hasModelParam("vIH") ? props.getModelParam<number>("vIH") : 2.0;
    this._vIL = props.hasModelParam("vIL") ? props.getModelParam<number>("vIL") : 0.8;
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    applyInitialValues(SCHEMA, pool, this._stateBase, {});
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    const gnd    = rhsOld[this._pinNodes.get("gnd")!];
    const vClock = rhsOld[this._pinNodes.get("C")!]   - gnd;
    const vD     = rhsOld[this._pinNodes.get("D")!]   - gnd;
    const vSet   = rhsOld[this._pinNodes.get("Set")!] - gnd;
    const vClr   = rhsOld[this._pinNodes.get("Clr")!] - gnd;

    const prevClock = s1[base + SLOT_LAST_CLOCK];
    let q = s1[base + SLOT_Q] >= 0.5 ? 1 : 0;

    const risingEdge =
      !Number.isNaN(prevClock) &&
      prevClock < this._vIH &&
      vClock >= this._vIH;

    if (risingEdge) {
      if (vD >= this._vIH)     q = 1;
      else if (vD < this._vIL) q = 0;
    }

    if (vSet > this._vIH) q = 1;
    if (vClr > this._vIH) q = 0;

    s0[base + SLOT_LAST_CLOCK] = vClock;
    s0[base + SLOT_Q]          = q;
    s0[base + SLOT_OUT_Q]      = q;
    s0[base + SLOT_OUT_NQ]     = 1 - q;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this._pinNodes.size).fill(0);
  }

  setParam(_key: string, _value: number): void {}
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
      ],
      params: { vIH: 2.0, vIL: 0.8 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralDAsyncFlipflopDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
