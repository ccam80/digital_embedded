/**
 * BehavioralCounterPresetDriverElement- edge-triggered up/down counter with
 * parallel-load preset, enable, clear, and direction inputs.
 *
 * Bus-pin shape: the "in" and "out" ports each carry a packed N-bit integer
 * on a single analog node (not N separate 1-bit nodes). The driver reads
 * rhsOld[inNode] as a packed integer.
 *
 * Schema is fixed at 4 slots regardless of bitWidth (contrast with
 * counter-driver.ts which uses 2N+2 slots). The bitWidth value parameterises
 * maxValue calculation only.
 *
 * Per Composite M12 (J-140, contracts_group_10.md).
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
import type { ComponentDefinition } from "../../../core/registry.js";
import type { PropertyBag } from "../../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../../core/pin.js";
import { detectRisingEdge, logicLevel } from "./edge-detect.js";
import { allocNortonStamp, stampNortonValue } from "../stamp-helpers.js";

// ---------------------------------------------------------------------------
// Memoised arity-indexed schema factory
// ---------------------------------------------------------------------------
//
// 4-slot schema, bitWidth-keyed for identity consistency (different bitWidth
// instances get separate frozen schemas, avoiding cross-instance diagnostics).
//
// Slot layout (fixed regardless of bitWidth):
//   [0] LAST_CLOCK           - clock voltage at prior accepted step (NaN sentinel)
//   [1] COUNT                - latched count as packed integer
//   [2] PREV_EN              - prior hysteresis classification of en  (0 or 1)
//   [3] PREV_DIR             - prior hysteresis classification of dir (0 or 1)
//   [4] PREV_LD              - prior hysteresis classification of ld  (0 or 1)
//   [5] PREV_CLR             - prior hysteresis classification of clr (0 or 1)

const COUNTER_PRESET_SCHEMAS = new Map<number, StateSchema>();

function getCounterPresetSchema(bitWidth: number): StateSchema {
  let cached = COUNTER_PRESET_SCHEMAS.get(bitWidth);
  if (cached !== undefined) return cached;

  const slots: SlotDescriptor[] = [
    {
      name: "LAST_CLOCK",
      doc: "Clock voltage at last accepted timestep. NaN sentinel on first sample prevents spurious edges when clock boots high.",
    },
    {
      name: "COUNT",
      doc: "Latched count as packed integer. Read-modify-written each load();.",
    },
    {
      name: "PREV_EN",
      doc: "Prior hysteresis classification of en (0 or 1). Held by logicLevel when v sits in [vIL, vIH).",
    },
    {
      name: "PREV_DIR",
      doc: "Prior hysteresis classification of dir (0 or 1). Held by logicLevel when v sits in [vIL, vIH).",
    },
    {
      name: "PREV_LD",
      doc: "Prior hysteresis classification of ld (0 or 1). Held by logicLevel when v sits in [vIL, vIH).",
    },
    {
      name: "PREV_CLR",
      doc: "Prior hysteresis classification of clr (0 or 1). Held by logicLevel when v sits in [vIL, vIH).",
    },
  ];

  const schema = defineStateSchema(`BehavioralCounterPresetDriver_${bitWidth}b`, slots);
  COUNTER_PRESET_SCHEMAS.set(bitWidth, schema);
  return schema;
}

// ---------------------------------------------------------------------------
// Pin layout factory- per-instance variable bit width
// ---------------------------------------------------------------------------
//
// Order MUST match the parent's connectivity row for this sub-element:
// [en, C, dir, in, ld, clr, gnd, ctrl_bit_0, ..., ctrl_bit_{N-1}, ctrl_ovf]
//
// ctrl_bit_i carry individual logic levels (vOH/vOL) for bit i of the count.
// ctrl_ovf carries vOH/vOL for the overflow signal.

export function buildCounterPresetDriverPinLayout(props: PropertyBag): PinDeclaration[] {
  const N = props.getModelParam<number>("bitWidth");
  const decls: PinDeclaration[] = [
    { direction: PinDirection.INPUT,  label: "en",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT,  label: "C",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: true,  kind: "signal" },
    { direction: PinDirection.INPUT,  label: "dir", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT,  label: "in",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT,  label: "ld",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT,  label: "clr", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT,  label: "gnd", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
  for (let i = 0; i < N; i++) {
    decls.push({
      direction: PinDirection.OUTPUT, label: `ctrl_bit_${i}`,
      defaultBitWidth: 1, position: { x: 0, y: 0 },
      isNegatable: false, isClockCapable: false, kind: "signal",
    });
  }
  decls.push({
    direction: PinDirection.OUTPUT, label: "ctrl_ovf",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  });
  return decls;
}

// ---------------------------------------------------------------------------
// BehavioralCounterPresetDriverElement
// ---------------------------------------------------------------------------

export class BehavioralCounterPresetDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema: StateSchema;
  readonly stateSize: number;

  private readonly _bitWidth: number;
  private readonly _maxValue: number;
  private readonly _slotLastClock: number;
  private readonly _slotCount: number;
  private readonly _slotPrevEn: number;
  private readonly _slotPrevDir: number;
  private readonly _slotPrevLd: number;
  private readonly _slotPrevClr: number;
  private readonly _enNode: number;
  private readonly _cNode: number;
  private readonly _dirNode: number;
  private readonly _inNode: number;
  private readonly _ldNode: number;
  private readonly _clrNode: number;
  private readonly _gndNode: number;
  private _vIH: number;
  private _vIL: number;
  private _rOut: number;
  private _vOH: number;
  private _vOL: number;

  private _firstSample: boolean = true;

  private _handlesByBit: readonly (readonly [number, number, number, number])[] = [];
  private _handlesOvf: readonly [number, number, number, number] = [-1, -1, -1, -1];
  private _ctrlBitNodes: number[] = [];
  private _ctrlOvfNode: number = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._bitWidth = props.getModelParam<number>("bitWidth");
    this._maxValue = this._bitWidth >= 32 ? 0xFFFFFFFF : ((1 << this._bitWidth) - 1);

    this.stateSchema = getCounterPresetSchema(this._bitWidth);
    this.stateSize = this.stateSchema.size;
    this._slotLastClock = this.stateSchema.indexOf.get("LAST_CLOCK")!;
    this._slotCount     = this.stateSchema.indexOf.get("COUNT")!;
    this._slotPrevEn    = this.stateSchema.indexOf.get("PREV_EN")!;
    this._slotPrevDir   = this.stateSchema.indexOf.get("PREV_DIR")!;
    this._slotPrevLd    = this.stateSchema.indexOf.get("PREV_LD")!;
    this._slotPrevClr   = this.stateSchema.indexOf.get("PREV_CLR")!;

    this._enNode  = pinNodes.get("en")!;
    this._cNode   = pinNodes.get("C")!;
    this._dirNode = pinNodes.get("dir")!;
    this._inNode  = pinNodes.get("in")!;
    this._ldNode  = pinNodes.get("ld")!;
    this._clrNode = pinNodes.get("clr")!;
    this._gndNode = pinNodes.get("gnd")!;
    this._vIH  = props.getModelParam<number>("vIH");
    this._vIL  = props.getModelParam<number>("vIL");
    this._rOut = props.getModelParam<number>("rOut");
    this._vOH  = props.getModelParam<number>("vOH");
    this._vOL  = props.getModelParam<number>("vOL");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);

    this._ctrlBitNodes = [];
    const handles: (readonly [number, number, number, number])[] = [];
    for (let i = 0; i < this._bitWidth; i++) {
      const node = this.pinNodes.get(`ctrl_bit_${i}`)!;
      this._ctrlBitNodes.push(node);
      handles.push(allocNortonStamp(ctx.solver, node, this._gndNode));
    }
    this._handlesByBit = handles;

    this._ctrlOvfNode = this.pinNodes.get("ctrl_ovf")!;
    this._handlesOvf = allocNortonStamp(ctx.solver, this._ctrlOvfNode, this._gndNode);
  }

  /**
   * Edge-detect on C; on rising edge apply priority: clr > ld > en-count.
   *
   * The "in" bus pin carries a packed integer voltage on a single node;
   * read rhsOld[inNode] directly as the preset value (matches the digital
   * executeCounterPreset convention where loadVal = state[wt[inBase+3]]).
   *
   * Overflow semantics mirror executeCounterPreset:
   *   - counting up  (dir=0): ovf when count == maxValue and en high
   *   - counting down (dir=1): ovf when count == 0 and en high
   */
  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;
    const gnd    = rhsOld[this._gndNode];
    const vClock = rhsOld[this._cNode]   - gnd;
    const vEn    = rhsOld[this._enNode]  - gnd;
    const vDir   = rhsOld[this._dirNode] - gnd;
    const vIn    = rhsOld[this._inNode]  - gnd;
    const vLd    = rhsOld[this._ldNode]  - gnd;
    const vClr   = rhsOld[this._clrNode] - gnd;

    let count = (s1[base + this._slotCount] | 0) >>> 0;

    const prevClock = s1[base + this._slotLastClock];
    const prevEn  = (s1[base + this._slotPrevEn]  >= 0.5 ? 1 : 0) as 0 | 1;
    const prevDir = (s1[base + this._slotPrevDir] >= 0.5 ? 1 : 0) as 0 | 1;
    const prevLd  = (s1[base + this._slotPrevLd]  >= 0.5 ? 1 : 0) as 0 | 1;
    const prevClr = (s1[base + this._slotPrevClr] >= 0.5 ? 1 : 0) as 0 | 1;
    const en  = logicLevel(vEn,  this._vIH, this._vIL, prevEn);
    const dir = logicLevel(vDir, this._vIH, this._vIL, prevDir);
    const ld  = logicLevel(vLd,  this._vIH, this._vIL, prevLd);
    const clr = logicLevel(vClr, this._vIH, this._vIL, prevClr);

    if (!this._firstSample && detectRisingEdge(prevClock, vClock, this._vIH)) {
      if (clr) {
        count = 0;
      } else if (ld) {
        // vIn is a packed integer value on the analog node; extract directly.
        // The extracted bits are already 0 or 1 — no logicLevel reclassification
        // (analog hysteresis applies to bus-level voltages, not to bits already
        // extracted from the packed integer).
        const loadVal = (vIn >>> 0) >>> 0;
        count = (loadVal & this._maxValue) >>> 0;
      } else if (en) {
        if (dir) {
          count = count === 0 ? this._maxValue : (count - 1) & this._maxValue;
        } else {
          count = count === this._maxValue ? 0 : (count + 1) & this._maxValue;
        }
      }
    }

    this._firstSample = false;

    s0[base + this._slotLastClock] = vClock;
    s0[base + this._slotCount]     = count;
    s0[base + this._slotPrevEn]    = en;
    s0[base + this._slotPrevDir]   = dir;
    s0[base + this._slotPrevLd]    = ld;
    s0[base + this._slotPrevClr]   = clr;

    const ovf = (dir
      ? ((count >>> 0) === 0 && en !== 0)
      : ((count >>> 0) === this._maxValue && en !== 0)) ? 1 : 0;

    for (let i = 0; i < this._bitWidth; i++) {
      const bit = (count >>> i) & 1;
      stampNortonValue(ctx, this._handlesByBit[i], this._ctrlBitNodes[i], this._gndNode, this._rOut, bit ? this._vOH : this._vOL);
    }
    stampNortonValue(ctx, this._handlesOvf, this._ctrlOvfNode, this._gndNode, this._rOut, ovf ? this._vOH : this._vOL);
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

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const BehavioralCounterPresetDriverDefinition: ComponentDefinition = {
  name: "BehavioralCounterPresetDriver",
  typeId: -1,
  internalOnly: true,
  pinLayoutFactory: buildCounterPresetDriverPinLayout,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "bitWidth", default: 4   },
        { key: "vIH",      default: 2.0 },
        { key: "vIL",      default: 0.8 },
        { key: "rOut",     default: 100 },
        { key: "vOH",      default: 5   },
        { key: "vOL",      default: 0   },
      ],
      params: { bitWidth: 4, vIH: 2.0, vIL: 0.8, rOut: 100, vOH: 5, vOL: 0 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralCounterPresetDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};

