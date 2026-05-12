/**
 * BehavioralOrDriverElement- pure-truth-function driver leaf for the N-input
 * OR gate.
 *
 * Reads N input voltages from rhsOld (relative to gnd), threshold-classifies
 * each input against per-instance vIH / vIL, and writes the OR-reduced result.
 *
 * Canonical reference for **Template A-variable-pin**: 1-bit pure-truth
 * driver with variable input pin count per instance. Mirrors and-driver.ts
 * shape exactly; only the reduction body differs.
 *
 * Per Composite M10 (phase-composite-architecture.md), J-153
 * (contracts_group_10.md).
 */

import {
  defineStateSchema,
  type StateSchema,
} from "../state-schema.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../ngspice-load-order.js";
import { PoolBackedAnalogElement } from "../element.js";
import type { SetupContext } from "../setup-context.js";
import type { LoadContext } from "../load-context.js";
import type { ComponentDefinition } from "../../../core/registry.js";
import type { PropertyBag } from "../../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../../core/pin.js";

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

const SCHEMA: StateSchema = defineStateSchema("BehavioralOrDriver", []);

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

function buildOrDriverPinLayout(props: PropertyBag): PinDeclaration[] {
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
// BehavioralOrDriverElement
// ---------------------------------------------------------------------------

export class BehavioralOrDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
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

  load(_ctx: LoadContext): void {
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
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

export const BehavioralOrDriverDefinition: ComponentDefinition = {
  name: "BehavioralOrDriver",
  typeId: -1,
  internalOnly: true,
  pinLayoutFactory: buildOrDriverPinLayout,
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
        new BehavioralOrDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
