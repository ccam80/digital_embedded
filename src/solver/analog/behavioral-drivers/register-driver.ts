/**
 * BehavioralRegisterDriverElement- bus-wide edge-triggered register driver leaf.
 *
 * Reads D (packed bus integer), C, and en from rhsOld (relative to gnd).
 * On rising clock edge when en is high: samples D bus into STORED_VALUE.
 * Q (OUTPUT_LOGIC_LEVEL_Q) combinationally mirrors STORED_VALUE every step.
 *
 * STORED_VALUE and OUTPUT_LOGIC_LEVEL_Q are packed N-bit integers (one slot
 * regardless of bitWidth). The single OUTPUT_LOGIC_LEVEL_Q slot is consumed
 * via siblingState by the parent composite's qPin DigitalOutputPinLoaded
 * sub-element (bitIndex defaults to 0, yielding the full packed value for
 * single-output-pin variants; multi-bit parents emit N qPin instances each
 * with a distinct bitIndex).
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
  applyInitialValues,
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
import { detectRisingEdge, logicLevel } from "./edge-detect.js";

// ---------------------------------------------------------------------------
// Memoised arity-indexed schema factory
// ---------------------------------------------------------------------------
//
// Three slots, independent of bitWidth (bitWidth parameterises masking only).
//
// Slot layout:
//   [0] LAST_CLOCK          - clock voltage at last accepted timestep
//   [1] STORED_VALUE        - packed N-bit integer latch
//   [2] OUTPUT_LOGIC_LEVEL_Q- packed integer mirror; consumed-by-pin

const REGISTER_SCHEMAS = new Map<number, StateSchema>();

function getRegisterSchema(bitWidth: number): StateSchema {
  let cached = REGISTER_SCHEMAS.get(bitWidth);
  if (cached !== undefined) return cached;

  const slots: SlotDescriptor[] = [
    {
      name: "LAST_CLOCK",
      doc: "Clock voltage at last accepted timestep- compared against current rhsOld[C] for rising-edge detection. NaN sentinel on the first sample skips edge detection so a circuit starting with the clock high does not produce a spurious edge.",
      init: { kind: "constant", value: Number.NaN },
    },
    {
      name: "STORED_VALUE",
      doc: "Packed N-bit integer latch. Updated on rising clock edge when en is high by sampling the D bus.",
      init: { kind: "zero" },
    },
    {
      name: "OUTPUT_LOGIC_LEVEL_Q",
      doc: "Packed integer mirror of STORED_VALUE; consumed via siblingState by the parent composite's qPin DigitalOutputPinLoaded sub-element.",
      init: { kind: "zero" },
    },
  ];

  const schema = defineStateSchema(`BehavioralRegisterDriver_${bitWidth}b`, slots);
  REGISTER_SCHEMAS.set(bitWidth, schema);
  return schema;
}

// ---------------------------------------------------------------------------
// Pin layout- fixed 5 pins matching buildRegisterNetlist drv connectivity row
// [D, C, en, Q, gnd] (behavioral-sequential.ts:311-312).
// ---------------------------------------------------------------------------

const REGISTER_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "D",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "C",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: true,  kind: "signal" },
  { direction: PinDirection.INPUT,  label: "en",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "Q",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "gnd", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// BehavioralRegisterDriverElement
// ---------------------------------------------------------------------------

export class BehavioralRegisterDriverElement implements PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly poolBacked = true as const;
  readonly stateSchema: StateSchema;
  readonly stateSize: number;

  label = "";
  _pinNodes: Map<string, number>;
  _stateBase = -1;
  branchIndex = -1;

  private readonly _bitWidth: number;
  private readonly _mask: number;
  private readonly _slotLastClock: number;
  private readonly _slotStoredValue: number;
  private readonly _slotOutQ: number;
  private readonly _dNode: number;
  private readonly _cNode: number;
  private readonly _enNode: number;
  private readonly _gndNode: number;
  private _vIH: number;
  private _vIL: number;
  private _pool!: StatePoolRef;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);
    this._bitWidth = props.getModelParam<number>("bitWidth");
    this._mask = this._bitWidth >= 32 ? 0xFFFFFFFF : ((1 << this._bitWidth) - 1);

    this.stateSchema = getRegisterSchema(this._bitWidth);
    this.stateSize = this.stateSchema.size;
    this._slotLastClock  = this.stateSchema.indexOf.get("LAST_CLOCK")!;
    this._slotStoredValue = this.stateSchema.indexOf.get("STORED_VALUE")!;
    this._slotOutQ       = this.stateSchema.indexOf.get("OUTPUT_LOGIC_LEVEL_Q")!;

    this._dNode   = pinNodes.get("D")!;
    this._cNode   = pinNodes.get("C")!;
    this._enNode  = pinNodes.get("en")!;
    this._gndNode = pinNodes.get("gnd")!;
    this._vIH = props.getModelParam<number>("vIH");
    this._vIL = props.getModelParam<number>("vIL");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    applyInitialValues(this.stateSchema, pool, this._stateBase, {});
  }

  /**
   * Rising-edge detect on C; on edge with en high, sample D bus into STORED_VALUE.
   * Q (OUTPUT_LOGIC_LEVEL_Q) combinationally mirrors STORED_VALUE every step.
   *
   * D bus read: decode bit-by-bit using vIH/vIL hysteresis (logicLevel), then
   * pack into an integer masked to bitWidth bits. This matches executeRegister's
   * packed-integer D read (register.ts:139,163) and applies the held-indeterminate
   * hysteresis from d-flipflop-driver for each bit of the data bus.
   *
   * en-guard uses simple-threshold (v >= vIH) consistent with counter-driver
   * control-input classification; only D uses full vIH/vIL hysteresis.
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

    if (detectRisingEdge(prevClock, vClock, this._vIH)) {
      if (vEn >= this._vIH) {
        // Decode packed D bus bit-by-bit with vIH/vIL hysteresis, then repack.
        // Each bit of vD is extracted by scaling: bit i is (vD >> i) & 1 mapped
        // to a 0.0/1.0 voltage. logicLevel classifies with hysteresis against
        // the prior bit of stored (held value when vD is indeterminate).
        let sampledD = 0;
        for (let i = 0; i < this._bitWidth; i++) {
          const prevBit: 0 | 1 = ((stored >>> i) & 1) as 0 | 1;
          // vD is a packed integer value on the analog node; each bit i is
          // represented as the i-th bit of the integer (same encoding as
          // the DigitalOutputPinLoaded packed-value output).
          const bitVoltage = (vD >>> i) & 1;
          const bit = logicLevel(bitVoltage, this._vIH, this._vIL, prevBit);
          sampledD |= bit << i;
        }
        stored = (sampledD & this._mask) >>> 0;
      }
    }

    s0[base + this._slotLastClock]   = vClock;
    s0[base + this._slotStoredValue] = stored;
    s0[base + this._slotOutQ]        = stored;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this._pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if (key === "vIH") this._vIH = value;
    else if (key === "vIL") this._vIL = value;
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const BehavioralRegisterDriverDefinition: ComponentDefinition = {
  name: "BehavioralRegisterDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: REGISTER_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "bitWidth", default: 8 },
        { key: "vIH",      default: 2.0 },
        { key: "vIL",      default: 0.8 },
      ],
      params: { bitWidth: 8, vIH: 2.0, vIL: 0.8 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralRegisterDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
