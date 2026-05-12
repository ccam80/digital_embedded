/**
 * BehavioralDriverInvDriverElement- pure-truth-function driver leaf for the
 * DriverInvSel tri-state buffer (active-LOW enable).
 *
 * Reads `in` and `sel` voltages from rhsOld (relative to gnd), threshold-
 * classifies each against per-instance vIH / vIL with hold-on-indeterminate,
 * and writes:
 *
 * Mirror of driver-driver.ts; the only behavioural difference is the final
 * invert on the enable line so the parent's outPin sees enable=1 when sel
 * is asserted LOW. Per Composite M13 (phase-composite-architecture.md),
 * J-146 (contracts_group_10.md). See driver-driver.ts and
 * behavioral-output-driver.ts for tri-state mechanism details.
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

const SCHEMA: StateSchema = defineStateSchema("BehavioralDriverInvDriver", []);


// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------
//
// Order MUST match the buildDriverInvNetlist drv connectivity row
// `[0, 1, 2, 3]` mapping to ports `[in, sel, out, gnd]`. `out` is included
// for parent-port symmetry; load() does not read or write it.

const DRIVER_INV_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "in",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "sel", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "gnd", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// BehavioralDriverInvDriverElement
// ---------------------------------------------------------------------------

export class BehavioralDriverInvDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private _vIH: number;
  private _vIL: number;
  private _rOut: number;
  private _vOH: number;
  private _vOL: number;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._vIH = props.hasModelParam("vIH") ? props.getModelParam<number>("vIH") : 2.0;
    this._vIL = props.hasModelParam("vIL") ? props.getModelParam<number>("vIL") : 0.8;
    this._rOut = props.hasModelParam("rOut") ? props.getModelParam<number>("rOut") : 100;
    this._vOH = props.hasModelParam("vOH") ? props.getModelParam<number>("vOH") : 5;
    this._vOL = props.hasModelParam("vOL") ? props.getModelParam<number>("vOL") : 0;
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
    else if (key === "rOut") this._rOut = value;
    else if (key === "vOH") this._vOH = value;
    else if (key === "vOL") this._vOL = value;
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const BehavioralDriverInvDriverDefinition: ComponentDefinition = {
  name: "BehavioralDriverInvDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: DRIVER_INV_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "vIH", default: 2.0 },
        { key: "vIL", default: 0.8 },
        { key: "rOut", default: 100 },
        { key: "vOH", default: 5 },
        { key: "vOL", default: 0 },
      ],
      params: { vIH: 2.0, vIL: 0.8, rOut: 100, vOH: 5, vOL: 0 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralDriverInvDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
