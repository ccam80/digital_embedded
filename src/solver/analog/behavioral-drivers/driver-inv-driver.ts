/**
 * BehavioralDriverInvDriverElement- pure-truth-function driver leaf for the
 * DriverInvSel tri-state buffer (active-LOW enable).
 *
 * Reads `in` and `sel` voltages from rhsOld (relative to gnd), threshold-
 * classifies each against per-instance vIH / vIL with hold-on-indeterminate,
 * and writes:
 *   - OUTPUT_LOGIC_LEVEL        ← pass-through of `in` (0/1)
 *   - OUTPUT_LOGIC_LEVEL_ENABLE ← INVERTED `sel` (sel=0 → enable=1; sel=1 → enable=0)
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

const SCHEMA: StateSchema = defineStateSchema("BehavioralDriverInvDriver", [
  {
    name: "OUTPUT_LOGIC_LEVEL",
    doc: "Pass-through of `in` (0 or 1) consumed via siblingState by the parent's outPin.inputLogic.",
  },
  {
    name: "OUTPUT_LOGIC_LEVEL_ENABLE",
    doc: "Tri-state enable bit (0 = high-Z, 1 = drive) consumed via siblingState by the parent's outPin.enableLogic. Active-LOW: enable = 1 - threshold(sel).",
  },
]);

const SLOT_OUT    = SCHEMA.indexOf.get("OUTPUT_LOGIC_LEVEL")!;
const SLOT_ENABLE = SCHEMA.indexOf.get("OUTPUT_LOGIC_LEVEL_ENABLE")!;

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

export class BehavioralDriverInvDriverElement implements PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly stateSchema = SCHEMA;
  readonly poolBacked = true as const;
  readonly stateSize = SCHEMA.size;

  label = "";
  _pinNodes: Map<string, number>;
  _stateBase = -1;
  branchIndex = -1;

  private _vIH: number;
  private _vIL: number;
  private _pool!: StatePoolRef;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);
    this._vIH = props.hasModelParam("vIH") ? props.getModelParam<number>("vIH") : 2.0;
    this._vIL = props.hasModelParam("vIL") ? props.getModelParam<number>("vIL") : 0.8;
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    const gnd = rhsOld[this._pinNodes.get("gnd")!];
    const vIn  = rhsOld[this._pinNodes.get("in")!]  - gnd;
    const vSel = rhsOld[this._pinNodes.get("sel")!] - gnd;

    const prevOut    = (s1[base + SLOT_OUT]    >= 0.5 ? 1 : 0) as 0 | 1;
    // prevEnable hold value for indeterminate sel: store the pre-invert sel
    // classification so logicLevel's hold semantics line up with the active
    // sense. We invert at the write site only.
    const prevSelBit = (s1[base + SLOT_ENABLE] >= 0.5 ? 0 : 1) as 0 | 1;

    const out    = logicLevel(vIn,  this._vIH, this._vIL, prevOut);
    const selBit = logicLevel(vSel, this._vIH, this._vIL, prevSelBit);
    const enable: 0 | 1 = selBit === 1 ? 0 : 1;

    s0[base + SLOT_OUT]    = out;
    s0[base + SLOT_ENABLE] = enable;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this._pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if      (key === "vIH") this._vIH = value;
    else if (key === "vIL") this._vIL = value;
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
      ],
      params: { vIH: 2.0, vIL: 0.8 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new BehavioralDriverInvDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
