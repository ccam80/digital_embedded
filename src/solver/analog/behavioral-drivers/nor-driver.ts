/**
 * BehavioralNorDriverElement- pure-truth-function driver leaf for the N-input
 * NOR gate.
 *
 * Reads N input voltages from rhsOld (relative to gnd), threshold-classifies
 * each input against per-instance vIH / vIL, and writes the NOR-reduced
 * result to OUTPUT_LOGIC_LEVEL. That slot is consumed via siblingState by
 * the parent composite's outPin DigitalOutputPinLoaded sub-element.
 *
 * Canonical reference for **Template A-variable-pin**: 1-bit pure-truth
 * driver with variable input pin count per instance. Mirrors and-driver.ts
 * shape exactly; only the truth function and identifier names differ.
 *
 * Per Composite M10 (phase-composite-architecture.md), J-151
 * (contracts_group_10.md). Strictly 1-bit; multi-bit NOR composites
 * instantiate this subcircuit per bit (parent emits N copies).
 */

import {
  defineStateSchema,
  type StateSchema,
} from "../state-schema.js";
import { NGSPICE_LOAD_ORDER } from "../ngspice-load-order.js";
import { AbstractPoolBackedAnalogElement } from "../element.js";
import type { SetupContext } from "../setup-context.js";
import type { LoadContext } from "../load-context.js";
import type { ComponentDefinition } from "../../../core/registry.js";
import type { PropertyBag } from "../../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../../core/pin.js";

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

const SCHEMA: StateSchema = defineStateSchema("BehavioralNorDriver", [
  {
    name: "OUTPUT_LOGIC_LEVEL",
    doc: "Reduced output level (0 or 1) consumed via siblingState by the parent composite's outPin DigitalOutputPinLoaded sub-element.",
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

function buildNorDriverPinLayout(props: PropertyBag): PinDeclaration[] {
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
// BehavioralNorDriverElement
// ---------------------------------------------------------------------------

export class BehavioralNorDriverElement extends AbstractPoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private readonly _inputCount: number;
  private readonly _inputNodes: number[];
  private readonly _gndNode: number;
  private _vIH: number;
  private _vIL: number;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
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

  /**
   * Per-input threshold-classify with hold-on-indeterminate semantic:
   *
   *   - If any input rises above vIH (a "1" for OR) → output 0 immediately
   *     (NOR inverts: OR absorber "1" → NOR output 0); further inputs do not
   *     matter.
   *   - Else if any input is in the indeterminate band (vIL <= v < vIH) →
   *     hold prior output (CMOS metastability proxy).
   *   - Else (all inputs < vIL, all classified "0") → OR gives 0, NOR inverts
   *     to 1: `inputs.some((b) => b === 1) ? 0 : 1` = 1.
   */
  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;
    const gnd = rhsOld[this._gndNode];
    const prev: 0 | 1 = s1[base + SLOT_OUT] >= 0.5 ? 1 : 0;

    let sawAbsorber = false;       // a "1" for OR short-circuits the reduction
    let sawIndeterminate = false;
    for (let i = 0; i < this._inputCount; i++) {
      const v = rhsOld[this._inputNodes[i]] - gnd;
      if      (v >= this._vIH) { sawAbsorber = true; break; }
      else if (v >= this._vIL) { sawIndeterminate = true; }
      // else v < vIL: pass-through "0" for OR, no state change.
    }

    let result: 0 | 1;
    if      (sawAbsorber)      result = 0;
    else if (sawIndeterminate) result = prev;
    else                       result = 1;  // inputs.some((b) => b === 1) ? 0 : 1 = 1

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

export const BehavioralNorDriverDefinition: ComponentDefinition = {
  name: "BehavioralNorDriver",
  typeId: -1,
  internalOnly: true,
  pinLayoutFactory: buildNorDriverPinLayout,
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
        new BehavioralNorDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
