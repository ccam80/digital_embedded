/**
 * BehavioralDemuxDriverElement- combinational driver leaf for the K-bit
 * demultiplexer.
 *
 * Reads K selector bit-voltages and one data input voltage from rhsOld
 * (relative to gnd), threshold-classifies each with vIH / vIL hysteresis,
 * assembles the selector into an integer `sel`, and writes the routing
 * pattern to OUTPUT_LOGIC_LEVEL_BIT0 .. _BIT(N-1) (N = 2^K) where only
 * OUTPUT_LOGIC_LEVEL_BIT${sel} = data and the others are 0. Those slots
 * are consumed via siblingState by N sibling DigitalOutputPinLoaded
 * sub-elements in the parent demux composite.
 *
 * Hold-on-indeterminate is *whole-vector*: if ANY selector bit OR the data
 * input is indeterminate, every output slot copies its prior value
 * (s1 → s0). Per-bit hold is incoherent for routed output- the active
 * bit's value comes from `data`, and which output is active depends on
 * the whole sel value, so any unknown input makes the whole pattern
 * unknown.
 *
 * Analog model treats `data` as 1-bit (matches the mux analog-model
 * limitation: multi-bit demuxes fall through to the digital path).
 *
 * Variable-arity schema via module-scope memoised factory- one frozen
 * StateSchema per `selectorBits` value, defined the first time it is seen
 * and reused thereafter. Mirrors `decoder-driver.ts` (and `counter-driver.ts`,
 * the multi-bit-schema canonical).
 *
 * Per Cluster M11 follow-up (j-070-recluster.md), J-144
 * (contracts_group_10.md).
 */

import {
  defineStateSchema,
  type StateSchema,
  type SlotDescriptor,
} from "../state-schema.js";
import { NGSPICE_LOAD_ORDER } from "../ngspice-load-order.js";
import type { PoolBackedAnalogElement } from "../element.js";
import type { StatePoolRef } from "../state-pool.js";
import type { SetupContext } from "../setup-context.js";
import type { LoadContext } from "../load-context.js";
import type { ComponentDefinition } from "../../../core/registry.js";
import type { PropertyBag } from "../../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../../core/pin.js";

// ---------------------------------------------------------------------------
// Memoised arity-indexed schema factory
// ---------------------------------------------------------------------------
//
// Slot layout for K selector bits, N = 2^K outputs:
//   [0 .. N-1]    OUTPUT_LOGIC_LEVEL_BIT0 .. _BIT(N-1)

const DEMUX_SCHEMAS = new Map<number, StateSchema>();

function getDemuxSchema(selectorBits: number): StateSchema {
  let cached = DEMUX_SCHEMAS.get(selectorBits);
  if (cached !== undefined) return cached;

  const N = 1 << selectorBits;
  const slots: SlotDescriptor[] = [];
  for (let i = 0; i < N; i++) {
    slots.push({
      name: `OUTPUT_LOGIC_LEVEL_BIT${i}`,
      doc: `Output bit ${i} (carries data when sel == ${i}, else 0). Consumed via siblingState by the parent composite's outPin_${i} DigitalOutputPinLoaded sub-element.`,
    });
  }
  const schema = defineStateSchema(`BehavioralDemuxDriver_${selectorBits}b`, slots);
  DEMUX_SCHEMAS.set(selectorBits, schema);
  return schema;
}

// ---------------------------------------------------------------------------
// Pin layout factory- per-instance variable selector bit count
// ---------------------------------------------------------------------------
//
// Order MUST match the buildDemuxNetlist drv connectivity row:
// `[sel_0..sel_{K-1}, in, gnd]`. Compiler maps pinLayout[i].label against the
// resolved node from connectivity[i] (compiler.ts:447-462).

function buildDemuxDriverPinLayout(props: PropertyBag): PinDeclaration[] {
  const K = props.getModelParam<number>("selectorBits");
  const decls: PinDeclaration[] = [];
  for (let i = 0; i < K; i++) {
    decls.push({
      direction: PinDirection.INPUT, label: `sel_${i}`,
      defaultBitWidth: 1, position: { x: 0, y: 0 },
      isNegatable: false, isClockCapable: false, kind: "signal",
    });
  }
  decls.push({
    direction: PinDirection.INPUT, label: "in",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  });
  decls.push({
    direction: PinDirection.INPUT, label: "gnd",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  });
  return decls;
}

// ---------------------------------------------------------------------------
// BehavioralDemuxDriverElement
// ---------------------------------------------------------------------------

export class BehavioralDemuxDriverElement implements PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly poolBacked = true as const;
  readonly stateSchema: StateSchema;
  readonly stateSize: number;

  label = "";
  _pinNodes: Map<string, number>;
  _stateBase = -1;
  branchIndex = -1;

  private readonly _selectorBits: number;
  private readonly _outCount: number;
  private readonly _slotOutBase: number;
  private readonly _selNodes: number[];
  private readonly _inNode: number;
  private readonly _gndNode: number;
  private _vIH: number;
  private _vIL: number;
  private _pool!: StatePoolRef;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);
    this._selectorBits = props.getModelParam<number>("selectorBits");
    this._outCount = 1 << this._selectorBits;

    this.stateSchema = getDemuxSchema(this._selectorBits);
    this.stateSize = this.stateSchema.size;
    this._slotOutBase = this.stateSchema.indexOf.get("OUTPUT_LOGIC_LEVEL_BIT0")!;

    this._selNodes = new Array(this._selectorBits);
    for (let i = 0; i < this._selectorBits; i++) {
      this._selNodes[i] = pinNodes.get(`sel_${i}`)!;
    }
    this._inNode  = pinNodes.get("in")!;
    this._gndNode = pinNodes.get("gnd")!;

    this._vIH = props.getModelParam<number>("vIH");
    this._vIL = props.getModelParam<number>("vIL");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
  }

  /**
   * Threshold-classify K selector bits + 1 data bit; route data → output `sel`.
   *
   * Whole-vector hold-on-indeterminate: any indeterminate input → all
   * output slots copy prior. The routed output's value comes from `data`
   * and the route comes from `sel`; either being unknown makes the whole
   * pattern unknown.
   */
  load(_ctx: LoadContext): void {
    const rhsOld = _ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;
    const gnd = rhsOld[this._gndNode];

    // Classify selector bits.
    let sel = 0;
    let sawIndeterminate = false;
    for (let i = 0; i < this._selectorBits; i++) {
      const v = rhsOld[this._selNodes[i]!]! - gnd;
      if      (v >= this._vIH) sel |= (1 << i);
      else if (v <  this._vIL) { /* bit = 0; no-op */ }
      else                     { sawIndeterminate = true; break; }
    }

    // Classify data bit.
    let data: 0 | 1 = 0;
    if (!sawIndeterminate) {
      const vIn = rhsOld[this._inNode] - gnd;
      if      (vIn >= this._vIH) data = 1;
      else if (vIn <  this._vIL) data = 0;
      else                       sawIndeterminate = true;
    }

    if (sawIndeterminate) {
      for (let i = 0; i < this._outCount; i++) {
        s0[base + this._slotOutBase + i] = s1[base + this._slotOutBase + i]!;
      }
      return;
    }

    sel >>>= 0;
    for (let i = 0; i < this._outCount; i++) {
      s0[base + this._slotOutBase + i] = (i === sel) ? data : 0;
    }
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this._pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if      (key === "vIH") this._vIH = value;
    else if (key === "vIL") this._vIL = value;
    // selectorBits is structural; not setParam-able.
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const BehavioralDemuxDriverDefinition: ComponentDefinition = {
  name: "BehavioralDemuxDriver",
  typeId: -1,
  internalOnly: true,
  pinLayoutFactory: buildDemuxDriverPinLayout,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "selectorBits", default: 1 },
        { key: "vIH",          default: 2.0 },
        { key: "vIL",          default: 0.8 },
      ],
      params: { selectorBits: 1, vIH: 2.0, vIL: 0.8 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralDemuxDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
