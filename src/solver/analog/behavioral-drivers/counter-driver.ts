/**
 * BehavioralCounterDriverElement- multi-bit driver leaf for the edge-triggered
 * up-counter with enable, clear, and overflow outputs.
 *
 * Reads en, C, clr from rhsOld (relative to gnd), detects rising clock edge
 * against s1[LAST_CLOCK], increments / clears the bit-slot encoded count,
 * and writes each output bit to its own OUTPUT_LOGIC_LEVEL_BITi slot plus
 * OUTPUT_LOGIC_LEVEL_OVF for the overflow flag. Those slots are consumed
 * via siblingState by N+1 sibling DigitalOutputPinLoaded sub-elements
 * (one per output bit + one for ovf) in the parent counter composite.
 *
 * Canonical reference for **Template A-multi-bit-schema**: 1-bit-per-pin
 * pure-truth driver whose output is intrinsically multi-bit (the bits are
 * coupled to a single integer count, so they cannot be decomposed into
 * independent 1-bit drivers). The pin layout is fixed (the driver itself
 * has only control inputs and gnd; no output pins, because there is no
 * such thing as a wide analog wire and each output net hangs off its own
 * DigitalOutputPinLoaded sibling). The state schema is variable: one
 * COUNT_BITi internal-latch slot per output bit, one OUTPUT_LOGIC_LEVEL_BITi
 * consumed-by-pin slot per output bit, plus LAST_CLOCK and
 * OUTPUT_LOGIC_LEVEL_OVF.
 *
 * Variable-arity schemas are realised via a module-scope memoised factory:
 * each distinct bitWidth value gets exactly one frozen StateSchema, defined
 * the first time that bitWidth is observed and reused thereafter. The schema
 * invariants (frozen, fixed-size, defined-once-per-identity) are preserved-
 * the only Template-A shape diff is that `stateSchema` and `stateSize` are
 * per-instance fields rather than readonly literals.
 *
 * COUNT is stored as N bit slots (`COUNT_BIT0`..`COUNT_BIT(N-1)`) per spec
 * (J-139 acceptance criteria). load() assembles the bits into an integer,
 * applies edge-triggered increment / clear, then writes both COUNT_BITi
 * (internal latch) and OUTPUT_LOGIC_LEVEL_BITi (consumed-by-pin) slots from
 * the new value- mirrors the d-flipflop driver's separation of latched
 * Q vs. OUTPUT_LOGIC_LEVEL_Q.
 *
 * Other Template A-multi-bit-schema drivers (register, counter-preset, shift
 * register) follow this file's shape with these per-driver substitutions:
 *   - per-driver schema factory (different slot list / control inputs)
 *   - per-driver pinLayout (fixed control inputs + gnd)
 *   - per-driver load() math (storage, shift, preset-load, etc.)
 *
 * Per Composite M12 (phase-composite-architecture.md), J-139
 * (contracts_group_09.md). OUTPUT_LOGIC_LEVEL_OVF is an extension beyond
 * the J-139 acceptance criteria, required because the user-facing Counter
 * component has an ovf output pin (matches `executeCounter` digital-mode
 * behaviour: ovf asserts when count == maxValue and en is high).
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
import { detectRisingEdge } from "./edge-detect.js";

// ---------------------------------------------------------------------------
// Memoised arity-indexed schema factory
// ---------------------------------------------------------------------------
//
// Each distinct bitWidth value maps to exactly one frozen StateSchema. The
// first time a bitWidth is observed (during a constructor call), the schema
// is built via defineStateSchema() and cached. Subsequent constructions for
// the same bitWidth reuse the cached schema by reference- preserves frozen-
// schema identity invariants and lets the engine's diagnostics
// (assertPoolIsSoleMutableState) treat all instances of the same bitWidth as
// homogeneous.
//
// Slot layout for bitWidth N:
//   [0]              LAST_CLOCK
//   [1 .. N]         COUNT_BIT0 ..  COUNT_BIT(N-1)              ← internal latch
//   [N+1 .. 2N]      OUTPUT_LOGIC_LEVEL_BIT0 .. _BIT(N-1)       ← consumed-by-pin
//   [2N+1]           OUTPUT_LOGIC_LEVEL_OVF                     ← consumed-by-pin

const COUNTER_SCHEMAS = new Map<number, StateSchema>();

function getCounterSchema(bitWidth: number): StateSchema {
  let cached = COUNTER_SCHEMAS.get(bitWidth);
  if (cached !== undefined) return cached;

  const slots: SlotDescriptor[] = [
    {
      name: "LAST_CLOCK",
      doc: "Clock voltage at last accepted timestep- compared against current rhsOld[C] for rising-edge detection. NaN sentinel on the first sample skips edge detection so a circuit starting with the clock high does not produce a spurious edge.",
    },
  ];
  for (let i = 0; i < bitWidth; i++) {
    slots.push({
      name: `COUNT_BIT${i}`,
      doc: `Internal counter latch bit ${i} (LSB=0). Read-modify-written each load(); separated from OUTPUT_LOGIC_LEVEL_BIT${i} per the d-flipflop convention (latch state vs. consumed-by-pin output).`,
    });
  }
  for (let i = 0; i < bitWidth; i++) {
    slots.push({
      name: `OUTPUT_LOGIC_LEVEL_BIT${i}`,
      doc: `Output bit ${i} (LSB=0); consumed via siblingState by the parent composite's outBit${i} DigitalOutputPinLoaded sub-element.`,
    });
  }
  slots.push({
    name: "OUTPUT_LOGIC_LEVEL_OVF",
    doc: "Overflow flag- 1 when count == 2^bitWidth - 1 AND en is high. Consumed via siblingState by the parent composite's ovfPin DigitalOutputPinLoaded sub-element.",
  });

  const schema = defineStateSchema(`BehavioralCounterDriver_${bitWidth}b`, slots);
  COUNTER_SCHEMAS.set(bitWidth, schema);
  return schema;
}

// ---------------------------------------------------------------------------
// Pin layout- fixed (control inputs + gnd; no output pins on the driver
// itself, because outputs are owned by N+1 sibling DigitalOutputPinLoaded
// sub-elements that consume the OUTPUT_LOGIC_LEVEL_BITi / _OVF slots).
// ---------------------------------------------------------------------------
//
// Order MUST match the parent's connectivity row for this sub-element
// (compiler.ts:447-462).

const COUNTER_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT, label: "en",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT, label: "C",   defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: true,  kind: "signal" },
  { direction: PinDirection.INPUT, label: "clr", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT, label: "gnd", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// BehavioralCounterDriverElement
// ---------------------------------------------------------------------------

export class BehavioralCounterDriverElement extends AbstractPoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  // Per-instance schema- the only Template-A shape diff. The schema is still
  // a frozen module-scope object (just one per bitWidth instead of one for
  // all instances).
  readonly stateSchema: StateSchema;
  readonly stateSize: number;

  private readonly _bitWidth: number;
  private readonly _maxValue: number;
  // Slot indices into the per-instance schema. Cached at construction so
  // load() does the indexOf lookups exactly once.
  private readonly _slotLastClock: number;
  private readonly _slotCountBase: number;     // COUNT_BIT0 index
  private readonly _slotOutBase: number;       // OUTPUT_LOGIC_LEVEL_BIT0 index
  private readonly _slotOvf: number;
  private readonly _enNode: number;
  private readonly _cNode: number;
  private readonly _clrNode: number;
  private readonly _gndNode: number;
  private _vIH: number;
  private _firstSample: boolean = true;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._bitWidth = props.getModelParam<number>("bitWidth");
    this._maxValue = this._bitWidth >= 32 ? 0xFFFFFFFF : ((1 << this._bitWidth) - 1);

    this.stateSchema = getCounterSchema(this._bitWidth);
    this.stateSize = this.stateSchema.size;
    this._slotLastClock = this.stateSchema.indexOf.get("LAST_CLOCK")!;
    this._slotCountBase = this.stateSchema.indexOf.get("COUNT_BIT0")!;
    this._slotOutBase   = this.stateSchema.indexOf.get("OUTPUT_LOGIC_LEVEL_BIT0")!;
    this._slotOvf       = this.stateSchema.indexOf.get("OUTPUT_LOGIC_LEVEL_OVF")!;

    this._enNode  = pinNodes.get("en")!;
    this._cNode   = pinNodes.get("C")!;
    this._clrNode = pinNodes.get("clr")!;
    this._gndNode = pinNodes.get("gnd")!;
    this._vIH = props.getModelParam<number>("vIH");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
  }

  /**
   * Edge-detect on C; on rising edge, clr (priority) or increment (when en).
   *
   * Control-input classification is simple-threshold (v >= vIH → 1, else 0)
   * rather than the held-indeterminate hysteresis used for edge-sampled data
   * in d-flipflop. Reason: en / clr are slow-changing control signals where
   * the metastability proxy is not load-bearing; the increment / clear
   * decision is gated on a clean clock edge regardless. Derivative drivers
   * (counter-preset, shift register) that need vIL hysteresis on data
   * inputs add the field, the constructor read, and the setParam branch.
   *
   * COUNT_BITi slots store the latched count in bit form. load() assembles
   * them into an integer for arithmetic, then writes the new value back as
   * bits. OUTPUT_LOGIC_LEVEL_BITi slots get the same bits (separation per
   * d-flipflop convention). OVF asserts when the post-update count is at
   * maxValue AND en is high (matches `executeCounter` in counter.ts).
   */
  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;
    const gnd    = rhsOld[this._gndNode];
    const vClock = rhsOld[this._cNode]   - gnd;
    const vEn    = rhsOld[this._enNode]  - gnd;
    const vClr   = rhsOld[this._clrNode] - gnd;

    // Assemble integer count from N bit slots (s1 == prior step).
    let count = 0;
    for (let i = 0; i < this._bitWidth; i++) {
      const bit = s1[base + this._slotCountBase + i] >= 0.5 ? 1 : 0;
      count |= bit << i;
    }
    count >>>= 0;  // unsigned 32-bit

    const prevClock = s1[base + this._slotLastClock];
    const en  = vEn  >= this._vIH ? 1 : 0;
    const clr = vClr >= this._vIH ? 1 : 0;

    if (!this._firstSample && detectRisingEdge(prevClock, vClock, this._vIH)) {
      if      (clr) count = 0;
      else if (en)  count = (count + 1) & this._maxValue;
    }
    this._firstSample = false;

    const ovf = (count === this._maxValue && en) ? 1 : 0;

    // Bottom-of-load writes- every slot mutated this step writes to s0
    // exactly once (no pre-stamp s0 mutations). Both COUNT_BITi (internal
    // latch) and OUTPUT_LOGIC_LEVEL_BITi (consumed-by-pin) get the same bit.
    s0[base + this._slotLastClock] = vClock;
    for (let i = 0; i < this._bitWidth; i++) {
      const bit = (count >>> i) & 1;
      s0[base + this._slotCountBase + i] = bit;
      s0[base + this._slotOutBase   + i] = bit;
    }
    s0[base + this._slotOvf] = ovf;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this._pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if (key === "vIH") this._vIH = value;
    // bitWidth is structural (allocates schema, slot indices, _maxValue);
    // not setParam-able.
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const BehavioralCounterDriverDefinition: ComponentDefinition = {
  name: "BehavioralCounterDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: COUNTER_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "bitWidth", default: 4 },
        { key: "vIH",      default: 2.0 },
      ],
      params: { bitWidth: 4, vIH: 2.0 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralCounterDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
