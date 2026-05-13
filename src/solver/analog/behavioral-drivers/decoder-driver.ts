/**
 * BehavioralDecoderDriverElement- combinational driver leaf for the K-bit
 * decoder.
 *
 * Reads K selector bit-voltages from rhsOld (relative to gnd), threshold-
 * classifies each with vIH / vIL hysteresis, assembles them into an integer
 * `sel`.
 *
 * Hold-on-indeterminate is *whole-vector*: if ANY selector bit lands in
 * the indeterminate band (vIL <= v < vIH), every output slot copies its
 * prior value (s1 â†’ s0). Per-bit hold is incoherent for one-hot decoding-
 * the active output bit depends on the entire sel value, so a single
 * unknown bit makes the whole pattern unknown. Mirrors the and-driver
 * "sawIndeterminate â‡’ result = prev" pattern, generalised to a vector of
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
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../ngspice-load-order.js";
import { PoolBackedAnalogElement } from "../element.js";
import type { SetupContext } from "../setup-context.js";
import type { LoadContext } from "../load-context.js";
import { allocNortonStamp, stampNortonValue } from "../stamp-helpers.js";
import type { ComponentDefinition } from "../../../core/registry.js";
import type { PropertyBag } from "../../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../../core/pin.js";

// ---------------------------------------------------------------------------
// Memoised arity-indexed schema factory
// ---------------------------------------------------------------------------
//

const DECODER_SCHEMAS = new Map<number, StateSchema>();

function getDecoderSchema(selectorBits: number): StateSchema {
  let cached = DECODER_SCHEMAS.get(selectorBits);
  if (cached !== undefined) return cached;

  const slots: SlotDescriptor[] = [];
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
// stores it in pinNodes against the resolved node from connectivity[i]
// (compiler.ts:447-462).

function buildDecoderDriverPinLayout(props: PropertyBag): PinDeclaration[] {
  const K = props.getModelParam<number>("selectorBits");
  const N = 1 << K;
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
  for (let i = 0; i < N; i++) {
    decls.push({
      direction: PinDirection.OUTPUT, label: `ctrl_${i}`,
      defaultBitWidth: 1, position: { x: 0, y: 0 },
      isNegatable: false, isClockCapable: false, kind: "signal",
    });
  }
  return decls;
}

// ---------------------------------------------------------------------------
// BehavioralDecoderDriverElement
// ---------------------------------------------------------------------------

export class BehavioralDecoderDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema: StateSchema;
  readonly stateSize: number;

  private readonly _selectorBits: number;
  private readonly _outCount: number;
  private readonly _selNodes: number[];
  private readonly _gndNode: number;
  private _vIH: number;
  private _vIL: number;
  private _rOut: number;
  private _vOH: number;
  private _vOL: number;
  private _ctrlNodes: number[];
  private _handlesByBit: readonly (readonly [number, number, number, number])[];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._selectorBits = props.getModelParam<number>("selectorBits");
    this._outCount = 1 << this._selectorBits;

    this.stateSchema = getDecoderSchema(this._selectorBits);
    this.stateSize = this.stateSchema.size;

    this._selNodes = new Array(this._selectorBits);
    for (let i = 0; i < this._selectorBits; i++) {
      this._selNodes[i] = pinNodes.get(`sel_${i}`)!;
    }
    this._gndNode = pinNodes.get("gnd")!;
    this._ctrlNodes = new Array(this._outCount).fill(-1);
    this._handlesByBit = [];

    this._vIH = props.getModelParam<number>("vIH");
    this._vIL = props.getModelParam<number>("vIL");
    this._rOut = props.getModelParam<number>("rOut");
    this._vOH  = props.getModelParam<number>("vOH");
    this._vOL  = props.getModelParam<number>("vOL");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    const handles: (readonly [number, number, number, number])[] = [];
    for (let i = 0; i < this._outCount; i++) {
      this._ctrlNodes[i] = this.pinNodes.get(`ctrl_${i}`)!;
      handles.push(allocNortonStamp(ctx.solver, this._ctrlNodes[i], this._gndNode));
    }
    this._handlesByBit = handles;
  }

  /**
   * Threshold-classify each selector bit; assemble `sel`; one-hot stamp.
   *
   * Selected output stamps vOH; all others stamp vOL.
   * If any selector bit is indeterminate, all outputs stamp vOL (conservative).
   */
  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const gnd = rhsOld[this._gndNode];

    let sel = 0;
    let sawIndeterminate = false;
    for (let i = 0; i < this._selectorBits; i++) {
      const v = rhsOld[this._selNodes[i]!]! - gnd;
      if      (v >= this._vIH) sel |= (1 << i);
      else if (v <  this._vIL) { /* bit = 0; no-op */ }
      else                     { sawIndeterminate = true; break; }
    }

    sel >>>= 0;

    for (let i = 0; i < this._outCount; i++) {
      const target = (!sawIndeterminate && i === sel) ? this._vOH : this._vOL;
      stampNortonValue(ctx, this._handlesByBit[i]!, this._ctrlNodes[i]!, this._gndNode, this._rOut, target);
    }
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if      (key === "vIH") this._vIH = value;
    else if (key === "vIL") this._vIL = value;
    else if (key === "rOut") this._rOut = value;
    else if (key === "vOH") this._vOH = value;
    else if (key === "vOL") this._vOL = value;
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
        { key: "rOut",         default: 100 },
        { key: "vOH",          default: 5 },
        { key: "vOL",          default: 0 },
      ],
      params: { selectorBits: 1, vIH: 2.0, vIL: 0.8, rOut: 100, vOH: 5, vOL: 0 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralDecoderDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
