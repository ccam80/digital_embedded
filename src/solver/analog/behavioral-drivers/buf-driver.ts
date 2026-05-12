/**
 * BehavioralBufDriverElement- pure-truth-function driver leaf for the 1-input
 * BUF (non-inverting buffer) gate.
 *
 * Reads 1 input voltage from rhsOld (relative to gnd), threshold-classifies
 * it against per-instance vIH / vIL, and writes the result (identity truth
 * function: output = input).
 *
 * Canonical reference for **Template A-fixed**: 1-bit pure-truth driver with
 * fixed N=1 input pin count. Mirrors and-driver.ts shape throughout (imports,
 * class layout, schema/load() placement, modelRegistry) with the truth function
 * substituted to identity and pin layout hardcoded as a module-level const.
 *
 * Per Composite M10 (phase-composite-architecture.md), J-137
 * (contracts_group_09.md).
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

const SCHEMA: StateSchema = defineStateSchema("BehavioralBufDriver", []);

// ---------------------------------------------------------------------------
// Pin layout- fixed N=1, module-level const (Template A-fixed)
// ---------------------------------------------------------------------------
//
// Order MUST match the parent's connectivity row for this sub-element. The
// parent emits `[in_1_net, out_net, gnd_net]` and the compiler stores each
// pin label against the resolved node from the matching connectivity index.
//
// The "out" pin is included for parent-port symmetry (the parent's "out" port
// is wired through this driver as well as through the outPin sibling that
// owns the actual VSRC stamp). load() does not read it.

const BUF_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
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
// BehavioralBufDriverElement
// ---------------------------------------------------------------------------

export class BehavioralBufDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private readonly _inNode: number;
  private readonly _gndNode: number;
  private _vIH: number;
  private _vIL: number;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._inNode  = pinNodes.get("in_1")!;
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
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const BehavioralBufDriverDefinition: ComponentDefinition = {
  name: "BehavioralBufDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: BUF_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "vIH", default: 2.0 },
        { key: "vIL", default: 0.8 },
      ],
      params: { vIH: 2.0, vIL: 0.8 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralBufDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
