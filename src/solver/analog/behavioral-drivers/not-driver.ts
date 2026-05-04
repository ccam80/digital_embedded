/**
 * BehavioralNotDriverElement- pure-truth-function driver leaf for the 1-input
 * NOT gate.
 *
 * Reads 1 input voltage from rhsOld (relative to gnd), threshold-classifies
 * it against per-instance vIH / vIL, and writes the NOT result to
 * OUTPUT_LOGIC_LEVEL. That slot is consumed via siblingState by the parent
 * composite's outPin DigitalOutputPinLoaded sub-element.
 *
 * Per Composite M10 (phase-composite-architecture.md), J-152
 * (contracts_group_10.md). N=1 fixed; truth function: 1 - inputs[0].
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

const SCHEMA: StateSchema = defineStateSchema("BehavioralNotDriver", [
  {
    name: "OUTPUT_LOGIC_LEVEL",
    doc: "Inverted output level (0 or 1) consumed via siblingState by the parent composite's outPin DigitalOutputPinLoaded sub-element.",
  },
]);

const SLOT_OUT = SCHEMA.indexOf.get("OUTPUT_LOGIC_LEVEL")!;

// ---------------------------------------------------------------------------
// Pin layout- N=1 fixed, module-level const
// ---------------------------------------------------------------------------
//
// Order MUST match the parent's connectivity row for this sub-element. The
// parent emits [in_1_net, out_net, gnd_net] and the compiler stores each pin
// label against the resolved node from the matching connectivity index.
//
// The "out" pin is included for parent-port symmetry. load() does not read it.

const NOT_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT, label: "in_1",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  },
  {
    direction: PinDirection.OUTPUT, label: "out",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  },
  {
    direction: PinDirection.INPUT, label: "gnd",
    defaultBitWidth: 1, position: { x: 0, y: 0 },
    isNegatable: false, isClockCapable: false, kind: "signal",
  },
];

// ---------------------------------------------------------------------------
// BehavioralNotDriverElement
// ---------------------------------------------------------------------------

export class BehavioralNotDriverElement extends AbstractPoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private readonly _inputNode: number;
  private readonly _gndNode: number;
  private _vIH: number;
  private _vIL: number;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._inputNode = pinNodes.get("in_1")!;
    this._gndNode = pinNodes.get("gnd")!;
    this._vIH = props.getModelParam<number>("vIH");
    this._vIL = props.getModelParam<number>("vIL");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
  }

  /**
   * Threshold-classify the single input with hold-on-indeterminate semantic,
   * then invert: output = 1 - level.
   *
   *   - v >= vIH (logic "1") → output 0 (NOT of 1).
   *   - v <  vIL (logic "0") → output 1 (NOT of 0).
   *   - vIL <= v < vIH (indeterminate) → hold prior output.
   */
  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;
    const v = rhsOld[this._inputNode] - rhsOld[this._gndNode];
    const prev: 0 | 1 = s1[base + SLOT_OUT] >= 0.5 ? 1 : 0;

    let result: 0 | 1;
    if      (v >= this._vIH)  result = 0;    // input is "1" → NOT outputs 0
    else if (v <  this._vIL)  result = 1;    // input is "0" → NOT outputs 1
    else                       result = prev; // indeterminate → hold prior

    s0[base + SLOT_OUT] = result;
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

export const BehavioralNotDriverDefinition: ComponentDefinition = {
  name: "BehavioralNotDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: NOT_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "vIH", default: 2.0 },
        { key: "vIL", default: 0.8 },
      ],
      params: { vIH: 2.0, vIL: 0.8 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralNotDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
