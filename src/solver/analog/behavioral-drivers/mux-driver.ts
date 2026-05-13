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
// Each distinct selectorBits value maps to exactly one frozen StateSchema.
//
// Slot layout for selectorBits K (N = 2^K data inputs):
//   [0 .. K-1]       SEL_LATCH_0 .. SEL_LATCH_{K-1}       â† latched sel inputs
//   [K .. K+N-1]     DATA_LATCH_0 .. DATA_LATCH_{N-1}      â† latched data inputs

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
    direction: PinDirection.OUTPUT, label: "ctrl_out",
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

export class BehavioralMuxDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema: StateSchema;
  readonly stateSize: number;

  private readonly _selectorBits: number;
  private readonly _dataCount: number;
  private readonly _selNodes: number[];
  private readonly _dataNodes: number[];
  private readonly _gndNode: number;
  private readonly _slotSelBase: number;   // SEL_LATCH_0 index
  private readonly _slotDataBase: number;  // DATA_LATCH_0 index
  private _vIH: number;
  private _vIL: number;
  private _rOut: number;
  private _vOH: number;
  private _vOL: number;
  private _ctrlOutNode: number;
  private _handles: readonly [number, number, number, number];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._selectorBits = props.getModelParam<number>("selectorBits");
    this._dataCount = 1 << this._selectorBits;

    this.stateSchema = getMuxSchema(this._selectorBits);
    this.stateSize = this.stateSchema.size;
    this._slotSelBase  = this.stateSchema.indexOf.get("SEL_LATCH_0")!;
    this._slotDataBase = this.stateSchema.indexOf.get("DATA_LATCH_0")!;

    this._selNodes = new Array(this._selectorBits);
    for (let i = 0; i < this._selectorBits; i++) {
      this._selNodes[i] = pinNodes.get(`sel_${i}`)!;
    }
    this._dataNodes = new Array(this._dataCount);
    for (let i = 0; i < this._dataCount; i++) {
      this._dataNodes[i] = pinNodes.get(`data_${i}`)!;
    }
    this._gndNode = pinNodes.get("gnd")!;
    this._ctrlOutNode = pinNodes.get("ctrl_out")!;
    this._handles = [-1, -1, -1, -1];
    this._vIH = props.getModelParam<number>("vIH");
    this._vIL = props.getModelParam<number>("vIL");
    this._rOut = props.getModelParam<number>("rOut");
    this._vOH  = props.getModelParam<number>("vOH");
    this._vOL  = props.getModelParam<number>("vOL");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    this._ctrlOutNode = this.pinNodes.get("ctrl_out")!;
    this._handles = allocNortonStamp(ctx.solver, this._ctrlOutNode, this._gndNode);
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;
    const gnd = rhsOld[this._gndNode];

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
      result = 0;
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
        result = 0;
      }
    }

    // Bottom-of-load writes.
    for (let i = 0; i < this._selectorBits; i++) {
      s0[base + this._slotSelBase + i] = selBits[i];
    }
    // Latch all data input levels to s0 (classification; indeterminate â†’ hold s1).
    for (let i = 0; i < this._dataCount; i++) {
      const dv = rhsOld[this._dataNodes[i]] - gnd;
      let dataLatch: 0 | 1;
      if (dv >= this._vIH)       dataLatch = 1;
      else if (dv < this._vIL)   dataLatch = 0;
      else                        dataLatch = s1[base + this._slotDataBase + i] >= 0.5 ? 1 : 0;
      s0[base + this._slotDataBase + i] = dataLatch;
    }

    stampNortonValue(ctx, this._handles, this._ctrlOutNode, this._gndNode, this._rOut, result ? this._vOH : this._vOL);
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
        { key: "rOut",         default: 100 },
        { key: "vOH",          default: 5 },
        { key: "vOL",          default: 0 },
      ],
      params: { selectorBits: 1, vIH: 2.0, vIL: 0.8, rOut: 100, vOH: 5, vOL: 0 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralMuxDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
