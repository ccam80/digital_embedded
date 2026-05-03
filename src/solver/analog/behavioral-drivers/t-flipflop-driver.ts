/**
 * BehavioralTFlipflopDriverElement- pure-truth-function driver leaf for the
 * edge-triggered T flip-flop.
 *
 * Reads clock and T voltages from rhsOld, detects rising clock edge against
 * s1[LAST_CLOCK]; on edge, toggles Q when T is high (vIH) or holds when
 * T is low (vIL). Q / ~Q levels are written to OUTPUT_LOGIC_LEVEL_Q /
 * OUTPUT_LOGIC_LEVEL_NQ for siblingState consumption by the qPin / nqPin
 * DigitalOutputPinLoaded sub-elements.
 *
 * Per Composite M15 (phase-composite-architecture.md), J-159
 * (contracts_group_10.md). Behavior migrated from
 * `.recovery/behavioral-flipflop-t.ts.orig`'s `BehavioralTFlipflopElement`
 * (the `withEnable=true` path; the `withEnable=false` path is not preserved-
 * tie T to vdd in the wrapping netlist for always-toggle behavior).
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

const SCHEMA: StateSchema = defineStateSchema("BehavioralTFlipflopDriver", [
  { name: "LAST_CLOCK",            doc: "Clock voltage at last accepted timestep. NaN sentinel on the first sample skips edge detection.", init: { kind: "constant", value: Number.NaN } },
  { name: "Q",                     doc: "Latched output bit (0 or 1).",                                                                     init: { kind: "zero" } },
  { name: "OUTPUT_LOGIC_LEVEL_Q",  doc: "Q output level consumed via siblingState by qPin.",                                                init: { kind: "zero" } },
  { name: "OUTPUT_LOGIC_LEVEL_NQ", doc: "~Q output level consumed via siblingState by nqPin.",                                              init: { kind: "constant", value: 1 } },
]);

const SLOT_LAST_CLOCK = SCHEMA.indexOf.get("LAST_CLOCK")!;
const SLOT_Q          = SCHEMA.indexOf.get("Q")!;
const SLOT_OUT_Q      = SCHEMA.indexOf.get("OUTPUT_LOGIC_LEVEL_Q")!;
const SLOT_OUT_NQ     = SCHEMA.indexOf.get("OUTPUT_LOGIC_LEVEL_NQ")!;

const T_FF_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "T",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "C",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: true,  kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "Q",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "~Q",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "gnd", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

export class BehavioralTFlipflopDriverElement implements PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly stateSchema = SCHEMA;
  readonly poolBacked = true as const;
  readonly stateSize = SCHEMA.size;

  label = "";
  _pinNodes: Map<string, number>;
  _stateBase = -1;
  branchIndex = -1;

  private _vIH: number;
  private _vIL: number;
  private _pool!: StatePoolRef;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);
    this._vIH = props.getModelParam<number>("vIH");
    this._vIL = props.getModelParam<number>("vIL");
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
    const vClock = rhsOld[this._pinNodes.get("C")!] - gnd;
    const vT     = rhsOld[this._pinNodes.get("T")!] - gnd;

    const prevClock = s1[base + SLOT_LAST_CLOCK];
    let q = s1[base + SLOT_Q] >= 0.5 ? 1 : 0;

    const risingEdge =
      !Number.isNaN(prevClock) &&
      prevClock < this._vIH &&
      vClock >= this._vIH;

    if (risingEdge) {
      // Threshold-detect T with vIH/vIL hysteresis. T high → toggle, T low →
      // hold. Indeterminate → hold (matches recovered original's
      // `if (tLevel === true) toggle` guard- undefined keeps q unchanged).
      if (vT >= this._vIH)     q = 1 - q;
      else if (vT < this._vIL) { /* hold */ }
    }

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

export const BehavioralTFlipflopDriverDefinition: ComponentDefinition = {
  name: "BehavioralTFlipflopDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: T_FF_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "vIH", default: 2.0 },
        { key: "vIL", default: 0.8 },
      ],
      params: { vIH: 2.0, vIL: 0.8 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralTFlipflopDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
