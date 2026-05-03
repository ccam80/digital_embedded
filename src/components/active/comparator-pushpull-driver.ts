/**
 * ComparatorPushPullDriver- push-pull driver leaf for the analog comparator
 * composite. Companion to the open-collector `ComparatorDriver` in
 * `comparator-driver.ts`.
 *
 * Per Composite M24 (phase-composite-architecture.md), J-020. Emitted by
 * `COMPARATOR_PUSH_PULL_NETLIST` as the sole sub-element.
 *
 * Stamp model differs from open-collector:
 * - Open-collector: G = w/rSat at (out, out), no RHS. Active LOW only;
 *   inactive state is high-Z and needs an external pull-up.
 * - Push-pull (this file): G = 1/rSat at (out, out), RHS = G * vTarget.
 *   The output is driven to a smoothed target between vOL and vOH, with
 *   the smoothing tracked by the existing `OUTPUT_WEIGHT` slot:
 *     vTarget = (1 - w) * vOH + w * vOL
 *   When latch=0 (v+ above threshold), w trends 0 and vTarget → vOH.
 *   When latch=1 (v+ below threshold, asserted), w trends 1 and vTarget → vOL.
 *   Latch semantic preserved from the open-collector path: latch=1 means
 *   "asserted/sinking" per the schema doc; in push-pull that maps to "drive
 *   the output low".
 *
 * Hysteresis and weight integration are identical to the open-collector
 * driver- only the matrix/RHS contribution differs.
 */

import type { AnalogElement, PoolBackedAnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { StatePoolRef } from "../../solver/analog/state-pool.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import { applyInitialValues } from "../../solver/analog/state-schema.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import type { ComponentDefinition, ParamDef } from "../../core/registry.js";
import { COMPARATOR_SCHEMA } from "./comparator.js";

// ---------------------------------------------------------------------------
// Slot constants- shared schema with the open-collector driver.
// ---------------------------------------------------------------------------

const SLOT_OUTPUT_LATCH  = COMPARATOR_SCHEMA.indexOf.get("OUTPUT_LATCH")!;
const SLOT_OUTPUT_WEIGHT = COMPARATOR_SCHEMA.indexOf.get("OUTPUT_WEIGHT")!;

// ---------------------------------------------------------------------------
// Pin layout- mirrors the parent's push-pull netlist connectivity row
// `[0, 1, 2]` mapping to ports `[in+, in-, out]`.
// ---------------------------------------------------------------------------

const COMPARATOR_PUSHPULL_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "in+", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "in-", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// Param defs- full param surface including vOH / vOL for push-pull drive.
// ---------------------------------------------------------------------------

const COMPARATOR_PUSHPULL_DRIVER_PARAM_DEFS: ParamDef[] = [
  { key: "hysteresis",   default: 0 },
  { key: "vos",          default: 0.001 },
  { key: "rSat",         default: 50 },
  { key: "responseTime", default: 1e-6 },
  { key: "vOH",          default: 3.3 },
  { key: "vOL",          default: 0 },
];

const COMPARATOR_PUSHPULL_DRIVER_DEFAULTS: Record<string, number> = {
  hysteresis: 0,
  vos: 0.001,
  rSat: 50,
  responseTime: 1e-6,
  vOH: 3.3,
  vOL: 0,
};

const MIN_RSAT = 1e-9;
const MIN_TAU  = 1e-12;

// ---------------------------------------------------------------------------
// ComparatorPushPullDriverElement
// ---------------------------------------------------------------------------

export class ComparatorPushPullDriverElement implements PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly poolBacked = true as const;
  readonly stateSchema = COMPARATOR_SCHEMA;
  readonly stateSize = COMPARATOR_SCHEMA.size;

  label = "";
  _pinNodes: Map<string, number>;
  _stateBase = -1;
  branchIndex = -1;

  private _hysteresis: number;
  private _vos: number;
  private _rSat: number;
  private _tau: number;
  private _vOH: number;
  private _vOL: number;
  private _pool!: StatePoolRef;

  // Single matrix handle: (out, out). Push-pull always stamps the full
  // 1/rSat conductance; the latch/weight steers the RHS injection.
  private _hOutOut = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);
    this._hysteresis = props.hasModelParam("hysteresis")   ? props.getModelParam<number>("hysteresis")   : COMPARATOR_PUSHPULL_DRIVER_DEFAULTS["hysteresis"]!;
    this._vos        = props.hasModelParam("vos")          ? props.getModelParam<number>("vos")          : COMPARATOR_PUSHPULL_DRIVER_DEFAULTS["vos"]!;
    this._rSat       = Math.max(props.hasModelParam("rSat") ? props.getModelParam<number>("rSat") : COMPARATOR_PUSHPULL_DRIVER_DEFAULTS["rSat"]!, MIN_RSAT);
    this._tau        = Math.max(props.hasModelParam("responseTime") ? props.getModelParam<number>("responseTime") : COMPARATOR_PUSHPULL_DRIVER_DEFAULTS["responseTime"]!, MIN_TAU);
    this._vOH        = props.hasModelParam("vOH")          ? props.getModelParam<number>("vOH")          : COMPARATOR_PUSHPULL_DRIVER_DEFAULTS["vOH"]!;
    this._vOL        = props.hasModelParam("vOL")          ? props.getModelParam<number>("vOL")          : COMPARATOR_PUSHPULL_DRIVER_DEFAULTS["vOL"]!;
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    const outNode = this._pinNodes.get("out")!;
    if (outNode !== 0) {
      this._hOutOut = ctx.solver.allocElement(outNode, outNode);
    }
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    applyInitialValues(COMPARATOR_SCHEMA, pool, this._stateBase, {});
  }

  setParam(key: string, value: number): void {
    switch (key) {
      case "hysteresis":   this._hysteresis = value; break;
      case "vos":          this._vos = value; break;
      case "rSat":         this._rSat = Math.max(value, MIN_RSAT); break;
      case "responseTime": this._tau = Math.max(value, MIN_TAU); break;
      case "vOH":          this._vOH = value; break;
      case "vOL":          this._vOL = value; break;
    }
  }

  load(ctx: LoadContext): void {
    const rhsOld = ctx.rhsOld;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    const vPlus  = rhsOld[this._pinNodes.get("in+")!];
    const vMinus = rhsOld[this._pinNodes.get("in-")!];
    const outNode = this._pinNodes.get("out")!;

    // Hysteresis thresholds.
    const half = this._hysteresis * 0.5;
    const vTh = vMinus + this._vos + half;
    const vTl = vMinus + this._vos - half;

    // Latch transition (hold otherwise).
    const latchOld = s1[base + SLOT_OUTPUT_LATCH] >= 0.5 ? 1 : 0;
    let latchNew: number = latchOld;
    if (latchOld === 0 && vPlus >= vTh)      latchNew = 1;
    else if (latchOld === 1 && vPlus < vTl)  latchNew = 0;

    // Push-pull Norton stamp: G = 1/rSat always; RHS injects G*vTarget where
    // vTarget is smoothed between vOH (latch=0, output high) and vOL
    // (latch=1, output asserted low). Smoothing uses the prior-step weight
    // (s1) per the StatePool migration convention.
    const wOld = s1[base + SLOT_OUTPUT_WEIGHT];
    if (this._hOutOut !== -1 && outNode !== 0) {
      const G = 1 / this._rSat;
      const vTarget = (1 - wOld) * this._vOH + wOld * this._vOL;
      ctx.solver.stampElement(this._hOutOut, G);
      stampRHS(ctx.rhs, outNode, G * vTarget);
    }

    // Weight integration- trapezoidal recurrence shared with open-collector.
    const dt = ctx.dt;
    const alpha = dt > 0 ? dt / (this._tau + dt) : 0;
    const wNew = wOld + alpha * (latchNew - wOld);

    // Bottom-of-load writes.
    s0[base + SLOT_OUTPUT_LATCH]  = latchNew;
    s0[base + SLOT_OUTPUT_WEIGHT] = wNew;
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const outNode = this._pinNodes.get("out")!;
    const s1 = this._pool.states[1];
    const wOld = s1[this._stateBase + SLOT_OUTPUT_WEIGHT];
    const G = 1 / this._rSat;
    const vTarget = (1 - wOld) * this._vOH + wOld * this._vOL;
    // Norton-equivalent current at the output port: I_out = G * (vNode - vTarget).
    const I = G * (rhs[outNode] - vTarget);
    return [0, 0, I];
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const ComparatorPushPullDriverDefinition: ComponentDefinition = {
  name: "ComparatorPushPullDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: COMPARATOR_PUSHPULL_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: COMPARATOR_PUSHPULL_DRIVER_PARAM_DEFS,
      params: COMPARATOR_PUSHPULL_DRIVER_DEFAULTS,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new ComparatorPushPullDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
