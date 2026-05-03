/**
 * Timer555LatchDriver — RS flip-flop + discharge-BJT base driver leaf.
 *
 * Consumed by `buildTimer555Netlist` in `timer-555.ts` as the `latchDrv`
 * sub-element of the 555-timer composite. Reads comparator outputs, drives
 * latch state, stamps the discharge transistor's base voltage via a
 * (disBase, disBase) conductance, and emits the OUT pin's logic level via
 * the `OUTPUT_LOGIC_LEVEL` slot (consumed by the sibling
 * `DigitalOutputPinLoaded` via `siblingState`).
 *
 * ngspice peer: bsrcload.c (behavioural source).
 *
 * Per Composite M5 (phase-composite-architecture.md), J-030
 * (contracts_group_02.md).
 */

import {
  defineStateSchema,
  applyInitialValues,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import type { PoolBackedAnalogElement } from "../../solver/analog/element.js";
import type { StatePoolRef } from "../../solver/analog/state-pool.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { ComponentDefinition } from "../../core/registry.js";
import type { PropertyBag } from "../../core/properties.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

const SCHEMA: StateSchema = defineStateSchema("Timer555LatchDriver", [
  {
    name: "LATCH_Q",
    doc: "RS latch output (0 = reset, 1 = set). Updated each iteration from comparator outputs and RST pin.",
    init: { kind: "zero" },
  },
  {
    name: "OUTPUT_LOGIC_LEVEL",
    doc: "Mirrors LATCH_Q; consumed via siblingState by the OUT pin's BehavioralOutputDriver sub-element.",
    init: { kind: "zero" },
  },
]);

const SLOT_LATCH_Q      = SCHEMA.indexOf.get("LATCH_Q")!;
const SLOT_OUTPUT_LEVEL = SCHEMA.indexOf.get("OUTPUT_LOGIC_LEVEL")!;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------
//
// Order MUST match the buildTimer555Netlist latchDrv connectivity row
// [9, 10, 6, 3, 7, 11, 5] mapping ports to:
// comp1Out, comp2Out, rst, vcc, gnd, disBase, out.

const TIMER_555_LATCH_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "comp1Out", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "comp2Out", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "rst",      defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "vcc",      defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "gnd",      defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "disBase",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "out",      defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// Timer555LatchDriverElement
// ---------------------------------------------------------------------------

export class Timer555LatchDriverElement implements PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly stateSchema = SCHEMA;
  readonly poolBacked = true as const;
  readonly stateSize = SCHEMA.size;

  label = "";
  _pinNodes: Map<string, number>;
  _stateBase = -1;
  branchIndex = -1;

  private _vDrop: number;
  private _pool!: StatePoolRef;
  // TSTALLOC handle for the (disBase, disBase) conductance stamp.
  private _hDisDis = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);
    this._vDrop = props.hasModelParam("vDrop")
      ? props.getModelParam<number>("vDrop")
      : 1.5;
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    const disBase = this._pinNodes.get("disBase")!;
    // TSTALLOC: (disBase, disBase) — conductance stamp for discharge-BJT base clamping.
    this._hDisDis = ctx.solver.allocElement(disBase, disBase);
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    applyInitialValues(SCHEMA, pool, this._stateBase, {});
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    const vComp1 = rhsOld[this._pinNodes.get("comp1Out")!];
    const vComp2 = rhsOld[this._pinNodes.get("comp2Out")!];
    const vRst   = rhsOld[this._pinNodes.get("rst")!];
    const vVcc   = rhsOld[this._pinNodes.get("vcc")!];
    const vGnd   = rhsOld[this._pinNodes.get("gnd")!];

    const lastQ = s1[base + SLOT_LATCH_Q];
    let q = lastQ;
    const reset     = (vRst   - vGnd) < 0.5 * (vVcc - vGnd);
    const set       = (vComp2 - vGnd) > 0.5 * (vVcc - vGnd);
    const reset_set = (vComp1 - vGnd) > 0.5 * (vVcc - vGnd);
    if (reset)          q = 0;
    else if (set)       q = 1;
    else if (reset_set) q = 0;
    // else: hold lastQ

    // Stamp discharge-BJT base voltage: strong conductance clamp to targetV.
    // G_base = 1 S matches existing timer behaviour (bsrcload.c pattern).
    const G_base  = 1;
    const targetV = q ? this._vDrop : 0;
    ctx.solver.stampElement(this._hDisDis, G_base);
    ctx.rhs[this._pinNodes.get("disBase")!] += targetV * G_base;

    s0[base + SLOT_LATCH_Q]      = q;
    s0[base + SLOT_OUTPUT_LEVEL] = q;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this._pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if (key === "vDrop") this._vDrop = value;
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const Timer555LatchDriverDefinition: ComponentDefinition = {
  name: "Timer555LatchDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: TIMER_555_LATCH_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "vDrop", default: 1.5 },
      ],
      params: { vDrop: 1.5 },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new Timer555LatchDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
