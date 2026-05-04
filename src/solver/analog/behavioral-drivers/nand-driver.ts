/**
 * BehavioralNandDriverElement- pure-truth-function driver leaf for the N-input
 * NAND gate.
 *
 * Reads N input voltages from rhsOld (relative to gnd), threshold-classifies
 * each input against per-instance vIH / vIL, and writes the NAND-reduced
 * result to OUTPUT_LOGIC_LEVEL. That slot is consumed via siblingState by
 * the parent composite's outPin DigitalOutputPinLoaded sub-element.
 *
 * Template A-variable-pin shape mirror of and-driver.ts. Truth function:
 * `inputs.every((b) => b === 1) ? 0 : 1`.
 *
 * Per Composite M10 (phase-composite-architecture.md), J-150
 * (contracts_group_10.md).
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

const SCHEMA: StateSchema = defineStateSchema("BehavioralNandDriver", [
  {
    name: "OUTPUT_LOGIC_LEVEL",
    doc: "Reduced output level (0 or 1) consumed via siblingState by the parent composite's outPin DigitalOutputPinLoaded sub-element.",
  },
]);

const SLOT_OUT = SCHEMA.indexOf.get("OUTPUT_LOGIC_LEVEL")!;

// ---------------------------------------------------------------------------
// Pin layout factory- per-instance variable input count
// ---------------------------------------------------------------------------

function buildNandDriverPinLayout(props: PropertyBag): PinDeclaration[] {
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
// BehavioralNandDriverElement
// ---------------------------------------------------------------------------

export class BehavioralNandDriverElement extends AbstractPoolBackedAnalogElement {
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

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;
    const gnd = rhsOld[this._gndNode];
    const prev: 0 | 1 = s1[base + SLOT_OUT] >= 0.5 ? 1 : 0;

    let sawAbsorber = false;       // a "1" for NAND short-circuits (any 0 input -> NAND output 1)
    let sawIndeterminate = false;
    for (let i = 0; i < this._inputCount; i++) {
      const v = rhsOld[this._inputNodes[i]] - gnd;
      if      (v <  this._vIL) { sawAbsorber = true; break; }
      else if (v <  this._vIH) { sawIndeterminate = true; }
    }

    let result: 0 | 1;
    if      (sawAbsorber)        result = 1;
    else if (sawIndeterminate)   result = prev;
    else                         result = 0;

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

export const BehavioralNandDriverDefinition: ComponentDefinition = {
  name: "BehavioralNandDriver",
  typeId: -1,
  internalOnly: true,
  pinLayoutFactory: buildNandDriverPinLayout,
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
        new BehavioralNandDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
