/**
 * Timer555LatchDriver - RS flip-flop + discharge-BJT base driver leaf.
 *
 * Consumed by `buildTimer555Netlist` in `timer-555.ts` as the `latchDrv`
 * sub-element of the 555-timer composite. Reads comparator outputs, drives
 * latch state, stamps the discharge transistor's base voltage via a
 * (disBase, disBase) conductance.
 *
 * ngspice peer: bsrcload.c (behavioural source).
 *
 * Per Composite M5 (phase-composite-architecture.md), J-030
 * (contracts_group_02.md).
 */

import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import { PoolBackedAnalogElement } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import { allocNortonStamp, stampNortonValue } from "../../solver/analog/stamp-helpers.js";
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
  },
]);

const SLOT_LATCH_Q      = SCHEMA.indexOf.get("LATCH_Q")!;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------
//
// Order MUST match the buildTimer555Netlist latchDrv connectivity row
// [9, 10, 6, 3, 7, 11, 12] mapping ports to:
// comp1Out, comp2Out, rst, vcc, gnd, disBase, ctrl_out.

const TIMER_555_LATCH_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "comp1Out", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "comp2Out", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "rst",      defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "vcc",      defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "gnd",      defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "disBase",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_out", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// Timer555LatchDriverElement
// ---------------------------------------------------------------------------

export class Timer555LatchDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private _vDrop: number;
  private _rOut: number;
  private _vOH: number;
  private _vOL: number;
  // TSTALLOC handle for the (disBase, disBase) conductance stamp.
  private _hDisDis = -1;
  private _ctrlOutNode = -1;
  private _gndNode2 = 0;
  private _handles: readonly [number, number, number, number] = [-1, -1, -1, -1];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    // All keys are declared in this driver's paramDefs — read directly.
    this._vDrop = props.getModelParam<number>("vDrop");
    this._rOut = props.getModelParam<number>("rOut");
    this._vOH = props.getModelParam<number>("vOH");
    this._vOL = props.getModelParam<number>("vOL");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    const disBase = this.pinNodes.get("disBase")!;
    // TSTALLOC: (disBase, disBase) - conductance stamp for discharge-BJT base clamping.
    this._hDisDis = ctx.solver.allocElement(disBase, disBase);
    this._ctrlOutNode = this.pinNodes.get("ctrl_out")!;
    this._gndNode2 = this.pinNodes.get("gnd")!;
    this._handles = allocNortonStamp(ctx.solver, this._ctrlOutNode, this._gndNode2);
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    const vComp1 = rhsOld[this.pinNodes.get("comp1Out")!];
    const vComp2 = rhsOld[this.pinNodes.get("comp2Out")!];
    const vRst   = rhsOld[this.pinNodes.get("rst")!];
    const vVcc   = rhsOld[this.pinNodes.get("vcc")!];
    const vGnd   = rhsOld[this.pinNodes.get("gnd")!];

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
    ctx.rhs[this.pinNodes.get("disBase")!] += targetV * G_base;

    // Norton stamp at ctrl_out: drive latched output level.
    const ctrlTarget = q ? this._vOH : this._vOL;
    stampNortonValue(ctx, this._handles, this._ctrlOutNode, this._gndNode2, this._rOut, ctrlTarget);

    s0[base + SLOT_LATCH_Q] = q;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return new Array(this.pinNodes.size).fill(0);
  }

  setParam(key: string, value: number): void {
    if (key === "vDrop") this._vDrop = value;
    else if (key === "rOut") this._rOut = value;
    else if (key === "vOH") this._vOH = value;
    else if (key === "vOL") this._vOL = value;
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
        { key: "rOut", default: 100 },
        { key: "vOH", default: 5 },
        { key: "vOL", default: 0 },
      ],
      params: {},
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number) =>
        new Timer555LatchDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
