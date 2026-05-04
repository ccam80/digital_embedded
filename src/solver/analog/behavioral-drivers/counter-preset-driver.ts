/**
 * BehavioralCounterPresetDriverElement- edge-triggered up/down counter with
 * parallel-load preset, enable, clear, and direction inputs.
 *
 * Bus-pin shape: the "in" and "out" ports each carry a packed N-bit integer
 * on a single analog node (not N separate 1-bit nodes). The driver reads
 * rhsOld[inNode] as a packed integer and writes COUNT (packed integer) to
 * OUTPUT_LOGIC_LEVEL_OUT, consumed by a single DigitalOutputPinLoaded sibling.
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
import { NGSPICE_LOAD_ORDER } from "../ngspice-load-order.js";
import { AbstractPoolBackedAnalogElement } from "../element.js";
import type { SetupContext } from "../setup-context.js";
import type { LoadContext } from "../load-context.js";
import type { ComponentDefinition } from "../../../core/registry.js";
import type { PropertyBag } from "../../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../../core/pin.js";
import { detectRisingEdge, logicLevel } from "./edge-detect.js";

// ---------------------------------------------------------------------------
// Memoised arity-indexed schema factory
// ---------------------------------------------------------------------------
//
// 4-slot schema, bitWidth-keyed for identity consistency (different bitWidth
// instances get separate frozen schemas, avoiding cross-instance diagnostics).
//
// Slot layout (indices 0-3, fixed regardless of bitWidth):
//   [0] LAST_CLOCK           - clock voltage at prior accepted step (NaN sentinel)
//   [1] COUNT                - latched count as packed integer
//   [2] OUTPUT_LOGIC_LEVEL_OUT - packed integer count; consumed by outPin sibling
//   [3] OUTPUT_LOGIC_LEVEL_OVF - 1-bit overflow flag; consumed by ovfPin sibling

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
      doc: "Latched count as packed integer. Read-modify-written each load(); separated from OUTPUT_LOGIC_LEVEL_OUT per d-flipflop latch-vs-output convention.",
    },
    {
      name: "OUTPUT_LOGIC_LEVEL_OUT",
      doc: "Packed integer count output; consumed via siblingState by the outPin DigitalOutputPinLoaded sub-element.",
    },
    {
      name: "OUTPUT_LOGIC_LEVEL_OVF",
      doc: "Overflow flag (1 when at overflow condition and en high); consumed via siblingState by the ovfPin DigitalOutputPinLoaded sub-element.",
    },
  ];

  const schema = defineStateSchema(`BehavioralCounterPresetDriver_${bitWidth}b`, slots);
  COUNTER_PRESET_SCHEMAS.set(bitWidth, schema);
  return schema;
}

// ---------------------------------------------------------------------------
// Pin layout- fixed 9 pins matching buildCounterPresetNetlist port order:
// [en, C, dir, in, ld, clr, out, ovf, gnd]
// ---------------------------------------------------------------------------

const COUNTER_PRESET_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "en",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "C",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: true,  kind: "signal" },
  { direction: PinDirection.INPUT,  label: "dir", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "in",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "ld",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "clr", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ovf", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "gnd", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// BehavioralCounterPresetDriverElement
// ---------------------------------------------------------------------------

export class BehavioralCounterPresetDriverElement extends AbstractPoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly stateSchema: StateSchema;
  readonly stateSize: number;

  private readonly _bitWidth: number;
  private readonly _maxValue: number;
  private readonly _slotLastClock: number;
  private readonly _slotCount: number;
  private readonly _slotOut: number;
  private readonly _slotOvf: number;
  private readonly _enNode: number;
  private readonly _cNode: number;
  private readonly _dirNode: number;
  private readonly _inNode: number;
  private readonly _ldNode: number;
  private readonly _clrNode: number;
  private readonly _gndNode: number;
  private _vIH: number;
  private _vIL: number;

  private _firstSample: boolean = true;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._bitWidth = props.getModelParam<number>("bitWidth");
    this._maxValue = this._bitWidth >= 32 ? 0xFFFFFFFF : ((1 << this._bitWidth) - 1);

    this.stateSchema = getCounterPresetSchema(this._bitWidth);
    this.stateSize = this.stateSchema.size;
    this._slotLastClock = this.stateSchema.indexOf.get("LAST_CLOCK")!;
    this._slotCount     = this.stateSchema.indexOf.get("COUNT")!;
    this._slotOut       = this.stateSchema.indexOf.get("OUTPUT_LOGIC_LEVEL_OUT")!;
    this._slotOvf       = this.stateSchema.indexOf.get("OUTPUT_LOGIC_LEVEL_OVF")!;

    this._enNode  = pinNodes.get("en")!;
    this._cNode   = pinNodes.get("C")!;
    this._dirNode = pinNodes.get("dir")!;
    this._inNode  = pinNodes.get("in")!;
    this._ldNode  = pinNodes.get("ld")!;
    this._clrNode = pinNodes.get("clr")!;
    this._gndNode = pinNodes.get("gnd")!;
    this._vIH = props.getModelParam<number>("vIH");
    this._vIL = props.getModelParam<number>("vIL");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
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
    const en  = vEn  >= this._vIH ? 1 : 0;
    const dir = vDir >= this._vIH ? 1 : 0;
    const ld  = vLd  >= this._vIH ? 1 : 0;
    const clr = vClr >= this._vIH ? 1 : 0;

    if (!this._firstSample && detectRisingEdge(prevClock, vClock, this._vIH)) {
      if (clr) {
        count = 0;
      } else if (ld) {
        let loadVal = 0;
        for (let i = 0; i < this._bitWidth; i++) {
          const prevBit: 0 | 1 = ((s1[base + this._slotCount] >>> i) & 1) as 0 | 1;
          const bitVoltage = (vIn >>> i) & 1;
          const bit = logicLevel(bitVoltage, this._vIH, this._vIL, prevBit);
          loadVal |= bit << i;
        }
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

    const atOverflow = dir ? count === 0 : count === this._maxValue;
    const ovf = (atOverflow && en) ? 1 : 0;

    s0[base + this._slotLastClock] = vClock;
    s0[base + this._slotCount]     = count;
    s0[base + this._slotOut]       = count;
    s0[base + this._slotOvf]       = ovf;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this._pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if (key === "vIH") this._vIH = value;
    if (key === "vIL") this._vIL = value;
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const BehavioralCounterPresetDriverDefinition: ComponentDefinition = {
  name: "BehavioralCounterPresetDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: COUNTER_PRESET_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "bitWidth", default: 4 },
        { key: "vIH",      default: 2.0 },
        { key: "vIL",      default: 0.8 },
      ],
      params: { bitWidth: 4, vIH: 2.0, vIL: 0.8 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralCounterPresetDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
