/**
 * BehavioralRSAsyncLatchDriverElement- pure-truth-function driver leaf for the
 * level-sensitive RS latch (no clock).
 *
 * Every load() pass:
 *   S=0, R=0 → hold
 *   S=1, R=0 → q=1, ~q=0
 *   S=0, R=1 → q=0, ~q=1
 *   S=1, R=1 → forbidden state Q=~Q=0 (matches parent's digital `executeRSAsync`
 *              behavior; both outputs forced low when both inputs are high).
 *
 * Per Composite M17 (phase-composite-architecture.md), J-155
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

const SCHEMA: StateSchema = defineStateSchema("BehavioralRSAsyncLatchDriver", [
  { name: "Q",                     doc: "Latched output bit.",                                            init: { kind: "zero" } },
  { name: "OUTPUT_LOGIC_LEVEL_Q",  doc: "Q output level consumed via siblingState by qPin.",              init: { kind: "zero" } },
  { name: "OUTPUT_LOGIC_LEVEL_NQ", doc: "~Q output level consumed via siblingState by nqPin.",            init: { kind: "constant", value: 1 } },
]);

const SLOT_Q       = SCHEMA.indexOf.get("Q")!;
const SLOT_OUT_Q   = SCHEMA.indexOf.get("OUTPUT_LOGIC_LEVEL_Q")!;
const SLOT_OUT_NQ  = SCHEMA.indexOf.get("OUTPUT_LOGIC_LEVEL_NQ")!;

const RS_AS_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "S",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "R",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "Q",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "~Q",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "gnd", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

export class BehavioralRSAsyncLatchDriverElement implements PoolBackedAnalogElement {
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

    const gnd = rhsOld[this._pinNodes.get("gnd")!];
    const vS  = rhsOld[this._pinNodes.get("S")!] - gnd;
    const vR  = rhsOld[this._pinNodes.get("R")!] - gnd;

    let q  = s1[base + SLOT_Q]        >= 0.5 ? 1 : 0;
    let nq = s1[base + SLOT_OUT_NQ]   >= 0.5 ? 1 : 0;

    const sHigh = vS >= this._vIH;
    const sLow  = vS <  this._vIL;
    const rHigh = vR >= this._vIH;
    const rLow  = vR <  this._vIL;

    if ((sHigh || sLow) && (rHigh || rLow)) {
      if (sHigh && rHigh) {
        // Forbidden state: both outputs forced LOW (matches parent
        // executeRSAsync). The Q/~Q invariant breaks here on purpose -
        // SLOT_OUT_NQ is the source of truth for ~Q so it can hold 0
        // independently across steps.
        q  = 0;
        nq = 0;
      } else if (sHigh) {
        q  = 1;
        nq = 0;
      } else if (rHigh) {
        q  = 0;
        nq = 1;
      }
      // both low → hold (q and nq retain prior s1 values)
    }

    s0[base + SLOT_Q]      = q;
    s0[base + SLOT_OUT_Q]  = q;
    s0[base + SLOT_OUT_NQ] = nq;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this._pinNodes.size).fill(0);
  }

  setParam(_key: string, _value: number): void {}
}

export const BehavioralRSAsyncLatchDriverDefinition: ComponentDefinition = {
  name: "BehavioralRSAsyncLatchDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: RS_AS_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "vIH", default: 2.0 },
        { key: "vIL", default: 0.8 },
      ],
      params: { vIH: 2.0, vIL: 0.8 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralRSAsyncLatchDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
