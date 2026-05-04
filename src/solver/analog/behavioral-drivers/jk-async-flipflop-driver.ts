/**
 * BehavioralJKAsyncFlipflopDriverElement- pure-truth-function driver leaf for
 * the JK flip-flop with asynchronous Set / Clr.
 *
 * On rising clock edge: same JK behavior as the synchronous variant
 * (M18 / `BehavioralJKFlipflopDriver`).
 *
 * After the clocked update, async Set / Clr override the latched state every
 * load() pass. Collision policy- preserved from
 * `.recovery/behavioral-flipflop-jk-async.ts.orig`'s
 * `BehavioralJKAsyncFlipflopElement.accept()`- Set runs first (Set high → q=1),
 * Clr runs second (Clr high → q=0). When both are high, **Clr wins**.
 *
 * Per Composite M19 (phase-composite-architecture.md), J-147
 * (contracts_group_10.md).
 */

import {
  defineStateSchema,
  type StateSchema,
} from "../state-schema.js";
import { NGSPICE_LOAD_ORDER } from "../ngspice-load-order.js";
import { AbstractPoolBackedAnalogElement } from "../element.js";
import type { SetupContext } from "../setup-context.js";
import type { LoadContext } from "../load-context.js";
import type { ComponentDefinition } from "../../../core/registry.js";
import type { PropertyBag } from "../../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../../core/pin.js";

const SCHEMA: StateSchema = defineStateSchema("BehavioralJKAsyncFlipflopDriver", [
  { name: "LAST_CLOCK",            doc: "Clock voltage at last accepted timestep. NaN sentinel on first sample skips edge detection." },
  { name: "Q",                     doc: "Latched output bit." },
  { name: "OUTPUT_LOGIC_LEVEL_Q",  doc: "Q output level consumed via siblingState by qPin." },
  { name: "OUTPUT_LOGIC_LEVEL_NQ", doc: "~Q output level consumed via siblingState by nqPin." },
]);

const SLOT_LAST_CLOCK = SCHEMA.indexOf.get("LAST_CLOCK")!;
const SLOT_Q          = SCHEMA.indexOf.get("Q")!;
const SLOT_OUT_Q      = SCHEMA.indexOf.get("OUTPUT_LOGIC_LEVEL_Q")!;
const SLOT_OUT_NQ     = SCHEMA.indexOf.get("OUTPUT_LOGIC_LEVEL_NQ")!;

// Pin order matches buildJKAsyncFlipflopNetlist drv row [0..7] = Set,J,C,K,Clr,Q,~Q,gnd.
const JK_AS_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "Set", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "J",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "C",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: true,  kind: "signal" },
  { direction: PinDirection.INPUT,  label: "K",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "Clr", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "Q",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "~Q",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "gnd", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

export class BehavioralJKAsyncFlipflopDriverElement extends AbstractPoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private _vIH: number;
  private _vIL: number;

  private _firstSample: boolean = true;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._vIH = props.getModelParam<number>("vIH");
    this._vIL = props.getModelParam<number>("vIL");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    const gnd    = rhsOld[this._pinNodes.get("gnd")!];
    const vClock = rhsOld[this._pinNodes.get("C")!]   - gnd;
    const vJ     = rhsOld[this._pinNodes.get("J")!]   - gnd;
    const vK     = rhsOld[this._pinNodes.get("K")!]   - gnd;
    const vSet   = rhsOld[this._pinNodes.get("Set")!] - gnd;
    const vClr   = rhsOld[this._pinNodes.get("Clr")!] - gnd;

    const prevClock = s1[base + SLOT_LAST_CLOCK];
    let q = s1[base + SLOT_Q] >= 0.5 ? 1 : 0;

    const risingEdge =
      !this._firstSample &&
      prevClock < this._vIH &&
      vClock >= this._vIH;
    this._firstSample = false;

    if (risingEdge) {
      const jHigh = vJ >= this._vIH;
      const jLow  = vJ <  this._vIL;
      const kHigh = vK >= this._vIH;
      const kLow  = vK <  this._vIL;
      if ((jHigh || jLow) && (kHigh || kLow)) {
        if      (jHigh && kHigh) q = 1 - q;
        else if (jHigh)          q = 1;
        else if (kHigh)          q = 0;
      }
    }

    // Async Set then async Clr- Clr wins on collision (matches recovered
    // original's accept() ordering: setV check, then clrV check, with second
    // assignment overwriting first).
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

  setParam(key: string, value: number): void {
    if (key === "vIH") this._vIH = value;
    else if (key === "vIL") this._vIL = value;
  }
}

export const BehavioralJKAsyncFlipflopDriverDefinition: ComponentDefinition = {
  name: "BehavioralJKAsyncFlipflopDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: JK_AS_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "vIH", default: 2.0 },
        { key: "vIL", default: 0.8 },
      ],
      params: { vIH: 2.0, vIL: 0.8 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralJKAsyncFlipflopDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
