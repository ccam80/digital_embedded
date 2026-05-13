/**
 * BehavioralRegisterDriverElement- bus-wide edge-triggered register driver leaf.
 *
 * Reads D (packed bus integer), C, and en from rhsOld (relative to gnd).
 * On rising clock edge when en is high: samples D bus into STORED_VALUE.
 *
 * Canonical reference for bus-pin shape: counter-driver.ts (memoised
 * arity-indexed schema factory). Load() semantic reference: d-flipflop-driver.ts
 * (en-guarded edge sample with vIH/vIL hysteresis on data inputs).
 *
 * Per Composite M12 (phase-composite-architecture.md), J-154
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
import type { ComponentDefinition } from "../../../core/registry.js";
import type { PropertyBag } from "../../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../../core/pin.js";
import { detectRisingEdge, logicLevel } from "./edge-detect.js";
import { allocNortonStamp, stampNortonValue } from "../stamp-helpers.js";

// ---------------------------------------------------------------------------
// Memoised arity-indexed schema factory
// ---------------------------------------------------------------------------
//
// Slots, independent of bitWidth (bitWidth parameterises masking only).
//
// Slot layout:
//   [0] LAST_CLOCK          - clock voltage at last accepted timestep
//   [1] STORED_VALUE        - packed N-bit integer latch
//   [2] PREV_EN             - prior hysteresis classification of en (0 or 1)

const REGISTER_SCHEMAS = new Map<number, StateSchema>();

function getRegisterSchema(bitWidth: number): StateSchema {
  let cached = REGISTER_SCHEMAS.get(bitWidth);
  if (cached !== undefined) return cached;

  const slots: SlotDescriptor[] = [
    {
      name: "LAST_CLOCK",
      doc: "Clock voltage at last accepted timestep- compared against current rhsOld[C] for rising-edge detection. NaN sentinel on the first sample skips edge detection so a circuit starting with the clock high does not produce a spurious edge.",
    },
    {
      name: "STORED_VALUE",
      doc: "Packed N-bit integer latch. Updated on rising clock edge when en is high by sampling the D bus.",
    },
    {
      name: "PREV_EN",
      doc: "Prior hysteresis classification of en (0 or 1). Held by logicLevel when v sits in [vIL, vIH).",
    },
  ];

  const schema = defineStateSchema(`BehavioralRegisterDriver_${bitWidth}b`, slots);
  REGISTER_SCHEMAS.set(bitWidth, schema);
  return schema;
}

// ---------------------------------------------------------------------------
// Pin layout factory- per-instance variable bit width
// ---------------------------------------------------------------------------
//
// Order MUST match the parent's connectivity row for this sub-element:
// [D, C, en, gnd, ctrl_bit_0, ..., ctrl_bit_{N-1}]
//
// ctrl_bit_i carry individual logic levels (vOH/vOL) for bit i of the stored value.

export function buildRegisterDriverPinLayout(props: PropertyBag): PinDeclaration[] {
  const N = props.getModelParam<number>("bitWidth");
  const decls: PinDeclaration[] = [
    { direction: PinDirection.INPUT,  label: "D",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT,  label: "C",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: true,  kind: "signal" },
    { direction: PinDirection.INPUT,  label: "en",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT,  label: "gnd", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
  for (let i = 0; i < N; i++) {
    decls.push({
      direction: PinDirection.OUTPUT, label: `ctrl_bit_${i}`,
      defaultBitWidth: 1, position: { x: 0, y: 0 },
      isNegatable: false, isClockCapable: false, kind: "signal",
    });
  }
  return decls;
}

// ---------------------------------------------------------------------------
// BehavioralRegisterDriverElement
// ---------------------------------------------------------------------------

export class BehavioralRegisterDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema: StateSchema;
  readonly stateSize: number;

  private readonly _bitWidth: number;
  private readonly _mask: number;
  private readonly _slotLastClock: number;
  private readonly _slotStoredValue: number;
  private readonly _slotPrevEn: number;
  private readonly _dNode: number;
  private readonly _cNode: number;
  private readonly _enNode: number;
  private readonly _gndNode: number;
  private _vIH: number;
  private _vIL: number;
  private _rOut: number;
  private _vOH: number;
  private _vOL: number;

  private _firstSample: boolean = true;

  private _handlesByBit: readonly (readonly [number, number, number, number])[] = [];
  private _ctrlBitNodes: number[] = [];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._bitWidth = props.getModelParam<number>("bitWidth");
    this._mask = this._bitWidth >= 32 ? 0xFFFFFFFF : ((1 << this._bitWidth) - 1);

    this.stateSchema = getRegisterSchema(this._bitWidth);
    this.stateSize = this.stateSchema.size;
    this._slotLastClock  = this.stateSchema.indexOf.get("LAST_CLOCK")!;
    this._slotStoredValue = this.stateSchema.indexOf.get("STORED_VALUE")!;
    this._slotPrevEn      = this.stateSchema.indexOf.get("PREV_EN")!;

    this._dNode   = pinNodes.get("D")!;
    this._cNode   = pinNodes.get("C")!;
    this._enNode  = pinNodes.get("en")!;
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
  }

  /**
   * Rising-edge detect on C; on edge with en high, sample D bus into STORED_VALUE.
   *
   * D bus read: extract the packed integer directly from vD, then mask to
   * bitWidth bits. The bus voltage IS the packed integer (encoding shared
   * with DigitalOutputPinLoaded packed-value output); bit-level analog
   * hysteresis is inappropriate because the bits are already discrete.
   *
   * en is classified with vIH/vIL hysteresis via logicLevel, holding the
   * prior class when v sits in [vIL, vIH).
   */
  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    const gnd    = rhsOld[this._gndNode];
    const vClock = rhsOld[this._cNode]  - gnd;
    const vD     = rhsOld[this._dNode]  - gnd;
    const vEn    = rhsOld[this._enNode] - gnd;

    const prevClock = s1[base + this._slotLastClock];
    let stored = s1[base + this._slotStoredValue];
    const prevEn = (s1[base + this._slotPrevEn] >= 0.5 ? 1 : 0) as 0 | 1;
    const en = logicLevel(vEn, this._vIH, this._vIL, prevEn);

    if (!this._firstSample && detectRisingEdge(prevClock, vClock, this._vIH)) {
      if (en) {
        // vD is a packed integer value on the analog node; each bit i is the
        // i-th bit of that integer (same encoding as the DigitalOutputPinLoaded
        // packed-value output). The extracted bit is already 0 or 1 — no
        // logicLevel reclassification is appropriate (analog hysteresis applies
        // to bus-level voltages, not to already-extracted Boolean bits).
        const sampledD = (vD >>> 0) >>> 0;
        stored = (sampledD & this._mask) >>> 0;
      }
    }
    this._firstSample = false;

    s0[base + this._slotLastClock]   = vClock;
    s0[base + this._slotStoredValue] = stored;
    s0[base + this._slotPrevEn]      = en;

    for (let i = 0; i < this._bitWidth; i++) {
      const bit = (stored >>> i) & 1;
      stampNortonValue(ctx, this._handlesByBit[i], this._ctrlBitNodes[i], this._gndNode, this._rOut, bit ? this._vOH : this._vOL);
    }
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

export const BehavioralRegisterDriverDefinition: ComponentDefinition = {
  name: "BehavioralRegisterDriver",
  typeId: -1,
  internalOnly: true,
  pinLayoutFactory: buildRegisterDriverPinLayout,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "bitWidth", default: 8   },
        { key: "vIH",      default: 2.0 },
        { key: "vIL",      default: 0.8 },
        { key: "rOut",     default: 100 },
        { key: "vOH",      default: 5   },
        { key: "vOL",      default: 0   },
      ],
      params: { bitWidth: 8, vIH: 2.0, vIL: 0.8, rOut: 100, vOH: 5, vOL: 0 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralRegisterDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
