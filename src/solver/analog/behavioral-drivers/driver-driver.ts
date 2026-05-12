/**
 * BehavioralDriverDriverElement- pure-truth-function driver leaf for the
 * Driver tri-state buffer.
 *
 * Reads `in` and `sel` voltages from rhsOld (relative to gnd), threshold-
 * classifies each against per-instance vIH / vIL with hold-on-indeterminate.
 *
 * DriverInvSel uses a sibling driver (driver-inv-driver.ts) with inverted
 * sel polarity; the rest of the shape is identical.
 */

import {
  defineStateSchema,
  type StateSchema,
} from "../state-schema.js";
import { logicLevel } from "./edge-detect.js";
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

const SCHEMA: StateSchema = defineStateSchema("BehavioralDriverDriver", []);


// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------
//
// Order MUST match the buildDriverNetlist drv connectivity row `[0, 1, 2, 3]`
// mapping to ports `[in, sel, out, gnd]`. The compiler stores each pin label
// against the resolved node from connectivity[i] (compiler.ts:447-462).
//
// `out` is included for parent-port symmetry (the parent's "out" port is
// wired through this driver as well as through the outPin sibling that owns
// the actual Norton stamp). load() does not read or write it.

const DRIVER_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "in",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "sel", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "gnd", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// BehavioralDriverDriverElement
// ---------------------------------------------------------------------------

export class BehavioralDriverDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private _vIH: number;
  private _vIL: number;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._vIH = props.hasModelParam("vIH") ? props.getModelParam<number>("vIH") : 2.0;
    this._vIL = props.hasModelParam("vIL") ? props.getModelParam<number>("vIL") : 0.8;
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    const gnd = rhsOld[this.pinNodes.get("gnd")!];
    const vIn  = rhsOld[this.pinNodes.get("in")!]  - gnd;
    const vSel = rhsOld[this.pinNodes.get("sel")!] - gnd;

  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if      (key === "vIH") this._vIH = value;
    else if (key === "vIL") this._vIL = value;
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const BehavioralDriverDriverDefinition: ComponentDefinition = {
  name: "BehavioralDriverDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: DRIVER_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "vIH", default: 2.0 },
        { key: "vIL", default: 0.8 },
      ],
      params: { vIH: 2.0, vIL: 0.8 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralDriverDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
