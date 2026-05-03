/**
 * BehavioralMuxDriverElement- selector-indexed pick driver leaf for the
 * N-input MUX (where N = 2^selectorBits).
 *
 * Template A-variable-pin shape (per and-driver.ts canonical). Variable
 * arity in both pin layout and schema; schema factory is memoised per
 * selectorBits (per counter-driver.ts memoised-factory pattern).
 *
 * Per Composite M10 (phase-composite-architecture.md), J-149
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
// Each distinct selectorBits value maps to exactly one frozen StateSchema.
//
// Slot layout for selectorBits K (N = 2^K data inputs):
//   [0 .. K-1]       SEL_LATCH_0 .. SEL_LATCH_{K-1}       ← latched sel inputs
//   [K .. K+N-1]     DATA_LATCH_0 .. DATA_LATCH_{N-1}      ← latched data inputs
//   [K+N]            OUTPUT_LOGIC_LEVEL                    ← consumed-by-pin

const MUX_SCHEMAS = new Map<number, StateSchema>();

function getMuxSchema(selectorBits: number): StateSchema {
  let cached = MUX_SCHEMAS.get(selectorBits);
  if (cached !== undefined) return cached;

  const N = 1 << selectorBits;
  const slots: SlotDescriptor[] = [];

  for (let i = 0; i < selectorBits; i++) {
    slots.push({
      name: `SEL_LATCH_${i}`,
      doc: `Latched level of selector bit ${i}. Written each load(); held on indeterminate input.`,
    });
  }
  for (let i = 0; i < N; i++) {
    slots.push({
      name: `DATA_LATCH_${i}`,
      doc: `Latched level of data input ${i}. Written each load(); held on indeterminate input.`,
    });
  }
  slots.push({
    name: "OUTPUT_LOGIC_LEVEL",
    doc: "Selected output level (0 or 1) consumed via siblingState by the parent composite's outPin DigitalOutputPinLoaded sub-element.",
  });

  const schema = defineStateSchema(`BehavioralMuxDriver_${selectorBits}sel`, slots);
  MUX_SCHEMAS.set(selectorBits, schema);
  return schema;
}

// ---------------------------------------------------------------------------
// Pin layout factory- per-instance variable arity
// ---------------------------------------------------------------------------
//
// Pin order: data_0 .. data_{N-1}, sel_0 .. sel_{K-1}, out, gnd
// Order MUST match the parent's connectivity row for this sub-element.

function buildMuxDriverPinLayout(props: PropertyBag): PinDeclaration[] {
  const K = props.getModelParam<number>("selectorBits");
  const N = 1 << K;
  const decls: PinDeclaration[] = [];

  for (let i = 0; i < N; i++) {
    decls.push({
      direction: PinDirection.INPUT, label: `data_${i}`,
      defaultBitWidth: 1, position: { x: 0, y: 0 },
      isNegatable: false, isClockCapable: false, kind: "signal",
    });
  }
  for (let i = 0; i < K; i++) {
    decls.push({
      direction: PinDirection.INPUT, label: `sel_${i}`,
      defaultBitWidth: 1, position: { x: 0, y: 0 },
      isNegatable: false, isClockCapable: false, kind: "signal",
    });
  }
  decls.push({
    direction: PinDirection.OUTPUT, label: "out",
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
// BehavioralMuxDriverElement
// ---------------------------------------------------------------------------

export class BehavioralMuxDriverElement implements PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly poolBacked = true as const;
  readonly stateSchema: StateSchema;
  readonly stateSize: number;

  label = "";
  _pinNodes: Map<string, number>;
  _stateBase = -1;
  branchIndex = -1;

  private readonly _selectorBits: number;
  private readonly _dataCount: number;
  private readonly _selNodes: number[];
  private readonly _dataNodes: number[];
  private readonly _gndNode: number;
  private readonly _slotSelBase: number;   // SEL_LATCH_0 index
  private readonly _slotDataBase: number;  // DATA_LATCH_0 index
  private readonly _slotOut: number;       // OUTPUT_LOGIC_LEVEL index
  private _vIH: number;
  private _vIL: number;
  private _pool!: StatePoolRef;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);
    this._selectorBits = props.getModelParam<number>("selectorBits");
    this._dataCount = 1 << this._selectorBits;

    this.stateSchema = getMuxSchema(this._selectorBits);
    this.stateSize = this.stateSchema.size;
    this._slotSelBase  = this.stateSchema.indexOf.get("SEL_LATCH_0")!;
    this._slotDataBase = this.stateSchema.indexOf.get("DATA_LATCH_0")!;
    this._slotOut      = this.stateSchema.indexOf.get("OUTPUT_LOGIC_LEVEL")!;

    this._selNodes = new Array(this._selectorBits);
    for (let i = 0; i < this._selectorBits; i++) {
      this._selNodes[i] = pinNodes.get(`sel_${i}`)!;
    }
    this._dataNodes = new Array(this._dataCount);
    for (let i = 0; i < this._dataCount; i++) {
      this._dataNodes[i] = pinNodes.get(`data_${i}`)!;
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
   * Selector-indexed pick with hold-on-indeterminate semantic:
   *
   *   - Classify each sel_i: if ANY sel falls in the indeterminate band
   *     (vIL <= v < vIH) → hold previous OUTPUT_LOGIC_LEVEL (cannot form a
   *     valid selector index).
   *   - Build selIdx = sum(sel_i_bit << i for i in 0..K-1).
   *   - Classify data_${selIdx}: if indeterminate → hold previous
   *     OUTPUT_LOGIC_LEVEL.
   *   - Otherwise write classified data bit to OUTPUT_LOGIC_LEVEL.
   *
   * Bottom-of-load: write all latch slots + OUTPUT_LOGIC_LEVEL to s0.
   */
  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;
    const gnd = rhsOld[this._gndNode];
    const prev: 0 | 1 = s1[base + this._slotOut] >= 0.5 ? 1 : 0;

    // Classify each selector bit; hold if any are indeterminate.
    let selIndeterminate = false;
    const selBits = new Array<0 | 1>(this._selectorBits);
    for (let i = 0; i < this._selectorBits; i++) {
      const v = rhsOld[this._selNodes[i]] - gnd;
      if (v >= this._vIH) {
        selBits[i] = 1;
      } else if (v < this._vIL) {
        selBits[i] = 0;
      } else {
        selIndeterminate = true;
        selBits[i] = s1[base + this._slotSelBase + i] >= 0.5 ? 1 : 0;
      }
    }

    let result: 0 | 1;
    if (selIndeterminate) {
      result = prev;
    } else {
      // Build selector index from classified bits (LSB = sel_0).
      let selIdx = 0;
      for (let i = 0; i < this._selectorBits; i++) {
        selIdx |= selBits[i] << i;
      }

      // Classify the chosen data input.
      const dv = rhsOld[this._dataNodes[selIdx]] - gnd;
      if (dv >= this._vIH) {
        result = 1;
      } else if (dv < this._vIL) {
        result = 0;
      } else {
        result = prev;
      }
    }

    // Bottom-of-load writes.
    for (let i = 0; i < this._selectorBits; i++) {
      s0[base + this._slotSelBase + i] = selBits[i];
    }
    // Latch all data input levels to s0 (classification; indeterminate → hold s1).
    for (let i = 0; i < this._dataCount; i++) {
      const dv = rhsOld[this._dataNodes[i]] - gnd;
      let dataLatch: 0 | 1;
      if (dv >= this._vIH)       dataLatch = 1;
      else if (dv < this._vIL)   dataLatch = 0;
      else                        dataLatch = s1[base + this._slotDataBase + i] >= 0.5 ? 1 : 0;
      s0[base + this._slotDataBase + i] = dataLatch;
    }
    s0[base + this._slotOut] = result;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this._pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if (key === "vIH") this._vIH = value;
    else if (key === "vIL") this._vIL = value;
    // selectorBits is structural (allocates schema, slot indices, _dataCount);
    // not setParam-able.
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const BehavioralMuxDriverDefinition: ComponentDefinition = {
  name: "BehavioralMuxDriver",
  typeId: -1,
  internalOnly: true,
  pinLayoutFactory: buildMuxDriverPinLayout,
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
        new BehavioralMuxDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
