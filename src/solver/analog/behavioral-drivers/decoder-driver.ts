/**
 * BehavioralDecoderDriverElement- combinational driver leaf for the K-bit
 * decoder.
 *
 * Reads K selector bit-voltages from rhsOld (relative to gnd), threshold-
 * classifies each with vIH / vIL hysteresis, assembles them into an integer
 * `sel`, and writes a one-hot pattern to OUTPUT_LOGIC_LEVEL_BIT0 ..
 * _BIT(N-1) (N = 2^K) where only OUTPUT_LOGIC_LEVEL_BIT${sel} is 1. Those
 * slots are consumed via siblingState by N sibling DigitalOutputPinLoaded
 * sub-elements in the parent decoder composite.
 *
 * Hold-on-indeterminate is *whole-vector*: if ANY selector bit lands in
 * the indeterminate band (vIL <= v < vIH), every output slot copies its
 * prior value (s1 → s0). Per-bit hold is incoherent for one-hot decoding-
 * the active output bit depends on the entire sel value, so a single
 * unknown bit makes the whole pattern unknown. Mirrors the and-driver
 * "sawIndeterminate ⇒ result = prev" pattern, generalised to a vector of
 * outputs.
 *
 * Variable-arity schema via module-scope memoised factory- one frozen
 * StateSchema per `selectorBits` value, defined the first time it is seen
 * and reused thereafter. Mirrors `counter-driver.ts` shape (the canonical
 * Template A-multi-bit-schema reference). The only Template-A shape diff
 * is that `stateSchema` and `stateSize` are per-instance fields rather than
 * readonly literals.
 *
 * Per Cluster M11 follow-up (j-070-recluster.md), J-143
 * (contracts_group_10.md). Combinational variant of the multi-bit-schema
 * canonical: no LAST_CLOCK, no edge detect, no internal latch- the output
 * bit slots ARE the latch (combinational + hold-on-indeterminate gives the
 * same bottom-of-load write pattern as a sequential driver).
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
//
// All N slots are consumed-by-pin (no internal latch needed because the
// decoder is purely combinational- the output IS the held state).

const DECODER_SCHEMAS = new Map<number, StateSchema>();

function getDecoderSchema(selectorBits: number): StateSchema {
  let cached = DECODER_SCHEMAS.get(selectorBits);
  if (cached !== undefined) return cached;

  const N = 1 << selectorBits;
  const slots: SlotDescriptor[] = [];
  for (let i = 0; i < N; i++) {
    slots.push({
      name: `OUTPUT_LOGIC_LEVEL_BIT${i}`,
      doc: `Output bit ${i} (one-hot, asserted iff sel == ${i}). Consumed via siblingState by the parent composite's outPin_${i} DigitalOutputPinLoaded sub-element.`,
    });
  }
  const schema = defineStateSchema(`BehavioralDecoderDriver_${selectorBits}b`, slots);
  DECODER_SCHEMAS.set(selectorBits, schema);
  return schema;
}

// ---------------------------------------------------------------------------
// Pin layout factory- per-instance variable selector bit count
// ---------------------------------------------------------------------------
//
// Order MUST match the buildDecoderNetlist drv connectivity row:
// `[sel_0..sel_{K-1}, gnd]`. The compiler reads pinLayout[i].label and
// stores it in _pinNodes against the resolved node from connectivity[i]
// (compiler.ts:447-462).

function buildDecoderDriverPinLayout(props: PropertyBag): PinDeclaration[] {
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
    direction: PinDirection.INPUT, label: "gnd",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  });
  return decls;
}

// ---------------------------------------------------------------------------
// BehavioralDecoderDriverElement
// ---------------------------------------------------------------------------

export class BehavioralDecoderDriverElement implements PoolBackedAnalogElement {
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
  private readonly _slotOutBase: number;   // OUTPUT_LOGIC_LEVEL_BIT0 index
  private readonly _selNodes: number[];
  private readonly _gndNode: number;
  private _vIH: number;
  private _vIL: number;
  private _pool!: StatePoolRef;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);
    this._selectorBits = props.getModelParam<number>("selectorBits");
    this._outCount = 1 << this._selectorBits;

    this.stateSchema = getDecoderSchema(this._selectorBits);
    this.stateSize = this.stateSchema.size;
    this._slotOutBase = this.stateSchema.indexOf.get("OUTPUT_LOGIC_LEVEL_BIT0")!;

    this._selNodes = new Array(this._selectorBits);
    for (let i = 0; i < this._selectorBits; i++) {
      this._selNodes[i] = pinNodes.get(`sel_${i}`)!;
    }
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
   * Threshold-classify each selector bit; assemble `sel`; one-hot write.
   *
   * If any selector bit is indeterminate, hold the entire output vector
   * (s1 → s0 copy on the output slots). The active bit depends on the
   * whole sel value, so per-bit hold is incoherent.
   */
  load(_ctx: LoadContext): void {
    const rhsOld = _ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;
    const gnd = rhsOld[this._gndNode];

    let sel = 0;
    let sawIndeterminate = false;
    for (let i = 0; i < this._selectorBits; i++) {
      const v = rhsOld[this._selNodes[i]!]! - gnd;
      if      (v >= this._vIH) sel |= (1 << i);
      else if (v <  this._vIL) { /* bit = 0; no-op */ }
      else                     { sawIndeterminate = true; break; }
    }

    if (sawIndeterminate) {
      for (let i = 0; i < this._outCount; i++) {
        s0[base + this._slotOutBase + i] = s1[base + this._slotOutBase + i]!;
      }
      return;
    }

    sel >>>= 0;
    for (let i = 0; i < this._outCount; i++) {
      s0[base + this._slotOutBase + i] = (i === sel) ? 1 : 0;
    }
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this._pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if      (key === "vIH") this._vIH = value;
    else if (key === "vIL") this._vIL = value;
    // selectorBits is structural (allocates schema, slot indices, _selNodes,
    // _outCount); not setParam-able.
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const BehavioralDecoderDriverDefinition: ComponentDefinition = {
  name: "BehavioralDecoderDriver",
  typeId: -1,
  internalOnly: true,
  pinLayoutFactory: buildDecoderDriverPinLayout,
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
        new BehavioralDecoderDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
