/**
 * ComparatorPushPullDriver- driver leaf for the analog comparator composite,
 * emitted by `COMPARATOR_PUSH_PULL_NETLIST` as the sole sub-element.
 *
 * Stamp: a fixed Norton G = 1/rOut at ctrl_out carrying the NORMALIZED logic
 * level (in [0,1]). level = 1 - w: at w=0 (latch=0, v+ above threshold) the
 * level is 1; at w=1 (latch=1, asserted) the level is 0. w is a single-pole
 * smoothing of the latch held in the OUTPUT_WEIGHT slot (time constant
 * responseTime). The parent's DigitalOutputPinLoaded maps the [0,1] level to
 * vOL..vOH, so the rail span is applied once, at the pin boundary.
 *
 * Hysteresis thresholds derive from the reference, offset (vos), and hysteresis
 * band; the latch holds until v+ crosses the opposite threshold.
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
// Slot constants- comparator schema.
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

    // Push-pull Norton stamp: fixed G=1/rOut toward the NORMALIZED logic level
    // on ctrl_out. level = w: at w=1 (latch=1, v+ above threshold) level is 1
    // (the outPin maps it to vOH); at w=0 (v+ below) level is 0 (maps to vOL) -
    // a non-inverting comparator. DigitalOutputPinLoaded applies the rail span
    // (vOH-vOL), so stamping a normalized [0,1] level here avoids double-applying
    // it. Smooth ramp via the trapezoidal recurrence above, time-constant
    // responseTime.
    const level = wForStamp;
    stampNortonValue(ctx, this._handles, this._ctrlOutNode, this._gndNode, this._rOut, level);

    // Bottom-of-load writes.
    s0[base + SLOT_OUTPUT_LATCH]  = latchNew;
    s0[base + SLOT_OUTPUT_WEIGHT] = wNew;
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const ctrlOutNode = this.pinNodes.get("ctrl_out")!;
    const s1 = this._pool.states[1];
    const wOld = s1[this._stateBase + SLOT_OUTPUT_WEIGHT];
    const G = 1 / this._rOut;
    const level = wOld;
    const I = G * (rhs[ctrlOutNode] - level);
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
