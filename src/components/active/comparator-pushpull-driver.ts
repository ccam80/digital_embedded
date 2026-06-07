/**
 * ComparatorPushPullDriver- push-pull driver leaf for the analog comparator
 * composite. Companion to the open-collector `ComparatorDriver` in
 * `comparator-driver.ts`.
 *
 * Per Composite M24 (phase-composite-architecture.md), J-020. Emitted by
 * `COMPARATOR_PUSH_PULL_NETLIST` as the sole sub-element.
 *
 * Stamp model differs from open-collector:
 * - Open-collector: G = w/rOut at (out, out), no RHS. Active LOW only;
 *   inactive state is high-Z and needs an external pull-up.
 * - Push-pull (this file): G = 1/rOut at (out, out), RHS = G * vTarget.
 *   The output is driven to a smoothed target between vOL and vOH, with
 *   the smoothing tracked by the existing `OUTPUT_WEIGHT` slot:
 *     vTarget = (1 - w) * vOH + w * vOL
 *   When latch=0 (v+ above threshold), w trends 0 and vTarget -> vOH.
 *   When latch=1 (v+ below threshold, asserted), w trends 1 and vTarget -> vOL.
 *   Latch semantic preserved from the open-collector path: latch=1 means
 *   "asserted/sinking" per the schema doc; in push-pull that maps to "drive
 *   the output low".
 *
 * Hysteresis and weight integration are identical to the open-collector
 * driver- only the matrix/RHS contribution differs.
 */

import { PoolBackedAnalogElement, type AnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import { MODEDC } from "../../solver/analog/ckt-mode.js";
import { allocNortonStamp, stampNortonValue } from "../../solver/analog/stamp-helpers.js";
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
  { direction: PinDirection.INPUT,  label: "in+",      defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "in-",      defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_out", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// Param defs- full param surface including vOH / vOL for push-pull drive.
// ---------------------------------------------------------------------------

const COMPARATOR_PUSHPULL_DRIVER_PARAM_DEFS: ParamDef[] = [
  { key: "hysteresis",   default: 0 },
  { key: "vos",          default: 0.001 },
  { key: "rOut",         default: 50 },
  { key: "responseTime", default: 1e-6 },
  { key: "vOH",          default: 3.3 },
  { key: "vOL",          default: 0 },
];

const MIN_ROUT = 1e-9;
const MIN_TAU  = 1e-12;

// ---------------------------------------------------------------------------
// ComparatorPushPullDriverElement
// ---------------------------------------------------------------------------

export class ComparatorPushPullDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = COMPARATOR_SCHEMA;
  readonly stateSize = COMPARATOR_SCHEMA.size;

  private _hysteresis: number;
  private _vos: number;
  private _tau: number;
  private _vOH: number;
  private _vOL: number;
  private _rOut: number;

  private _ctrlOutNode = -1;
  private _gndNode = 0;
  private _handles: readonly [number, number, number, number] = [-1, -1, -1, -1];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    // Keys are declared in COMPARATOR_PUSHPULL_DRIVER_PARAM_DEFS, always merged
    // into the bag by the unified instantiation — read directly.
    this._hysteresis = props.getModelParam<number>("hysteresis");
    this._vos        = props.getModelParam<number>("vos");
    this._rOut       = Math.max(props.getModelParam<number>("rOut"), MIN_ROUT);
    this._tau        = Math.max(props.getModelParam<number>("responseTime"), MIN_TAU);
    this._vOH        = props.getModelParam<number>("vOH");
    this._vOL        = props.getModelParam<number>("vOL");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    this._ctrlOutNode = this.pinNodes.get("ctrl_out")!;
    this._gndNode = 0;
    this._handles = allocNortonStamp(ctx.solver, this._ctrlOutNode, this._gndNode);
  }

  setParam(key: string, value: number): void {
    switch (key) {
      case "hysteresis":   this._hysteresis = value; break;
      case "vos":          this._vos = value; break;
      case "rOut":         this._rOut = Math.max(value, MIN_ROUT); break;
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

    const vPlus  = rhsOld[this.pinNodes.get("in+")!];
    const vMinus = rhsOld[this.pinNodes.get("in-")!];

    // Hysteresis thresholds.
    const half = this._hysteresis * 0.5;
    const vTh = vMinus + this._vos + half;
    const vTl = vMinus + this._vos - half;

    // Latch transition (hold otherwise).
    const latchOld = s1[base + SLOT_OUTPUT_LATCH] >= 0.5 ? 1 : 0;
    let latchNew: number = latchOld;
    if (latchOld === 0 && vPlus >= vTh)      latchNew = 1;
    else if (latchOld === 1 && vPlus < vTl)  latchNew = 0;

    // Weight integration- trapezoidal recurrence in transient, DC steady
    // state in DC-family modes. Mirrors comparator-driver.ts:144-160; the
    // filter's time derivative collapses at DCOP just like a capacitor's
    // dv/dt term, so w follows latch directly.
    const wOld = s1[base + SLOT_OUTPUT_WEIGHT];
    let wNew: number;
    let wForStamp: number;
    if ((ctx.cktMode & MODEDC) !== 0) {
      wNew = latchNew;
      wForStamp = latchNew;
    } else {
      const dt = ctx.dt;
      const alpha = dt / (this._tau + dt);
      wNew = wOld + alpha * (latchNew - wOld);
      wForStamp = wOld;
    }

    // Push-pull Norton stamp: fixed G=1/rOut, vTarget blended by weight.
    // vTarget = (1-w)*vOH + w*vOL: at w=0 (inactive) drives vOH, at w=1
    // (asserted) drives vOL. Smooth ramp between rails via the trapezoidal
    // recurrence above, time-constant responseTime.
    const vTarget = (1 - wForStamp) * this._vOH + wForStamp * this._vOL;
    stampNortonValue(ctx, this._handles, this._ctrlOutNode, this._gndNode, this._rOut, vTarget);

    // Bottom-of-load writes.
    s0[base + SLOT_OUTPUT_LATCH]  = latchNew;
    s0[base + SLOT_OUTPUT_WEIGHT] = wNew;
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const ctrlOutNode = this.pinNodes.get("ctrl_out")!;
    const s1 = this._pool.states[1];
    const wOld = s1[this._stateBase + SLOT_OUTPUT_WEIGHT];
    const G = 1 / this._rOut;
    const vTarget = (1 - wOld) * this._vOH + wOld * this._vOL;
    const I = G * (rhs[ctrlOutNode] - vTarget);
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
      params: {},
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new ComparatorPushPullDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
