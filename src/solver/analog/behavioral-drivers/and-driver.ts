/**
 * BehavioralAndDriverElement- pure-truth-function driver leaf for the N-input
 * AND gate.
 *
 * Reads N input voltages from rhsOld (relative to gnd), threshold-classifies
 * each input against per-instance vIH / vIL, and writes the AND-reduced
 * result to OUTPUT_LOGIC_LEVEL. That slot is consumed via siblingState by
 * the parent composite's outPin DigitalOutputPinLoaded sub-element.
 *
 * Canonical reference for **Template A-variable-pin**: 1-bit pure-truth
 * driver with variable input pin count per instance. Every other gate
 * driver (or, nand, nor, xor, xnor) and the mux driver mirror this file's
 * shape (imports, class layout, schema/load() placement, modelRegistry).
 * The only per-driver variation is:
 *   - the reduction body in load() (AND vs. OR vs. XOR vs. selector pick)
 *   - the optional final invert (NAND, NOR, XNOR)
 *   - class name, definition export name, schema owner string, definition
 *     `name` field
 *   - for mux: an additional `selectorBits` param + sel-pin handling
 *
 * Per Composite M10 (phase-composite-architecture.md), J-134
 * (contracts_group_09.md). Strictly 1-bit; multi-bit AND composites
 * instantiate this subcircuit per bit (parent emits N copies).
 */

import {
  defineStateSchema,
  applyInitialValues,
  type StateSchema,
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
// State schema
// ---------------------------------------------------------------------------

const SCHEMA: StateSchema = defineStateSchema("BehavioralAndDriver", [
  {
    name: "OUTPUT_LOGIC_LEVEL",
    doc: "Reduced output level (0 or 1) consumed via siblingState by the parent composite's outPin DigitalOutputPinLoaded sub-element.",
    init: { kind: "zero" },
  },
]);

const SLOT_OUT = SCHEMA.indexOf.get("OUTPUT_LOGIC_LEVEL")!;

// ---------------------------------------------------------------------------
// Pin layout factory- per-instance variable input count
// ---------------------------------------------------------------------------
//
// Order MUST match the parent's connectivity row for this sub-element. The
// parent emits `[in_1_net, in_2_net, ..., in_N_net, out_net, gnd_net]` and
// the compiler stores each pin label against the resolved node from the
// matching connectivity index (compiler.ts:447-462).
//
// The "out" pin is included for parent-port symmetry (the parent's "out" port
// is wired through this driver as well as through the outPin sibling that
// owns the actual VSRC stamp). load() does not read it.

function buildAndDriverPinLayout(props: PropertyBag): PinDeclaration[] {
  const N = props.getModelParam<number>("inputCount");
  const decls: PinDeclaration[] = [];
  for (let i = 0; i < N; i++) {
    decls.push({
      direction: PinDirection.INPUT, label: `In_${i + 1}`,
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
// BehavioralAndDriverElement
// ---------------------------------------------------------------------------

export class BehavioralAndDriverElement implements PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly stateSchema = SCHEMA;
  readonly poolBacked = true as const;
  readonly stateSize = SCHEMA.size;

  label = "";
  _pinNodes: Map<string, number>;
  _stateBase = -1;
  branchIndex = -1;

  private readonly _inputCount: number;
  private readonly _inputNodes: number[];
  private readonly _gndNode: number;
  private _vIH: number;
  private _vIL: number;
  private _pool!: StatePoolRef;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);
    this._inputCount = props.getModelParam<number>("inputCount");
    this._inputNodes = new Array(this._inputCount);
    for (let i = 0; i < this._inputCount; i++) {
      this._inputNodes[i] = pinNodes.get(`In_${i + 1}`)!;
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
    applyInitialValues(SCHEMA, pool, this._stateBase, {});
  }

  /**
   * Per-input threshold-classify with hold-on-indeterminate semantic:
   *
   *   - If any input falls below vIL (a "0" for AND) → output 0 immediately;
   *     0 is the absorbing element for AND so further inputs do not matter.
   *   - Else if any input is in the indeterminate band (vIL <= v < vIH) →
   *     hold prior output (CMOS metastability proxy: indeterminate inputs
   *     produce indeterminate output, modelled as steady-state retention).
   *   - Else (all inputs >= vIH) → output 1.
   *
   * Per-gate variation surface for OR / NAND / NOR / XOR / XNOR:
   *   - OR:   absorber is "1" (v >= vIH), pass-through is "0", default 0.
   *   - NAND: AND body, final invert (0 -> 1, 1 -> 0).
   *   - NOR:  OR body, final invert.
   *   - XOR:  count "1"s; if any indeterminate hold prior, else output (count % 2).
   *   - XNOR: XOR body, final invert.
   *
   * Mux is the same shape but replaces the reduction with a selector-indexed
   * pick: read sel bits, classify them, index into data inputs, output that
   * data input's classified bit (or hold prior on any indeterminate sel/data).
   */
  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;
    const gnd = rhsOld[this._gndNode];
    const prev: 0 | 1 = s1[base + SLOT_OUT] >= 0.5 ? 1 : 0;

    let sawAbsorber = false;       // a "0" for AND short-circuits the reduction
    let sawIndeterminate = false;
    for (let i = 0; i < this._inputCount; i++) {
      const v = rhsOld[this._inputNodes[i]] - gnd;
      if      (v <  this._vIL) { sawAbsorber = true; break; }
      else if (v <  this._vIH) { sawIndeterminate = true; }
      // else v >= vIH: pass-through "1" for AND, no state change.
    }

    let result: 0 | 1;
    if      (sawAbsorber)        result = 0;
    else if (sawIndeterminate)   result = prev;
    else                         result = 1;

    s0[base + SLOT_OUT] = result;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this._pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if (key === "vIH") this._vIH = value;
    else if (key === "vIL") this._vIL = value;
    // inputCount is structural (allocates _inputNodes); not setParam-able.
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const BehavioralAndDriverDefinition: ComponentDefinition = {
  name: "BehavioralAndDriver",
  typeId: -1,
  internalOnly: true,
  pinLayoutFactory: buildAndDriverPinLayout,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "inputCount", default: 2 },
        { key: "vIH",        default: 2.0 },
        { key: "vIL",        default: 0.8 },
      ],
      params: { inputCount: 2, vIH: 2.0, vIL: 0.8 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralAndDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
