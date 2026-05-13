/**
 * ComparatorDriver- open-collector driver leaf for the analog comparator
 * composite. The push-pull variant lives in
 * `comparator-pushpull-driver.ts`.
 *
 * Per Composite M24 (phase-composite-architecture.md), J-020. Emitted by
 * `COMPARATOR_OPEN_COLLECTOR_NETLIST` as the sole sub-element.
 *
 * Hybrid Template D: matrix stamping + state-bearing latch/hysteresis.
 * Reads input voltages from `rhsOld`, applies hysteresis to compute a new
 * latch state, smooths the response via `OUTPUT_WEIGHT` over `responseTime`,
 * and stamps a Norton conductance on the output node based on the prior-step
 * weight (s1, per the StatePool migration shape).
 *
 * Hysteresis (from `comparator.ts` docstring):
 *   V_TH = v_minus + vos + hysteresis/2  (trip on rising V+)
 *   V_TL = v_minus + vos - hysteresis/2  (trip on falling V+)
 *
 * Weight integration:
 *   wNew = wOld + (dt / (tau + dt)) * (target - wOld)
 *   where tau = responseTime, target = latch. At dt=0 (DC) wNew = wOld.
 *
 * Stamp: G_eff = s1[OUTPUT_WEIGHT] / rOut at (out, out); no RHS (output
 * sinks to GND through rOut when latch=1; otherwise high-Z requires
 * external pull-up).
 *
 * Schema source: `COMPARATOR_SCHEMA` is owned by the parent (the
 * comparator's hysteresis is a chip-level property); this driver imports
 * it. Slot names `OUTPUT_LATCH` / `OUTPUT_WEIGHT` are authoritative.
 */

import { PoolBackedAnalogElement, type AnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import { allocNortonStamp, stampNortonValue } from "../../solver/analog/stamp-helpers.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import type { ComponentDefinition, ParamDef } from "../../core/registry.js";
import { COMPARATOR_SCHEMA } from "./comparator.js";

// ---------------------------------------------------------------------------
// Slot constants- resolved from the schema owned by comparator.ts.
// ---------------------------------------------------------------------------

const SLOT_OUTPUT_LATCH  = COMPARATOR_SCHEMA.indexOf.get("OUTPUT_LATCH")!;
const SLOT_OUTPUT_WEIGHT = COMPARATOR_SCHEMA.indexOf.get("OUTPUT_WEIGHT")!;

// ---------------------------------------------------------------------------
// Pin layout- mirrors the parent's COMPARATOR_OPEN_COLLECTOR_NETLIST
// connectivity row `[0, 1, 2]` mapping to ports `[in+, in-, out]`.
// ---------------------------------------------------------------------------

const COMPARATOR_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.INPUT,  label: "in+",     defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "in-",     defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "ctrl_out", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// Param defs- subset of the parent's COMPARATOR_PARAM_DEFS that this driver
// actually consumes. vOH / vOL are not declared here; they are only consumed
// by the push-pull driver in `comparator-pushpull-driver.ts`.
// ---------------------------------------------------------------------------

const COMPARATOR_DRIVER_PARAM_DEFS: ParamDef[] = [
  { key: "hysteresis",   default: 0 },
  { key: "vos",          default: 0.001 },
  { key: "rOut",         default: 50 },
  { key: "responseTime", default: 1e-6 },
  { key: "vOH",          default: 5 },
  { key: "vOL",          default: 0 },
];

const COMPARATOR_DRIVER_DEFAULTS: Record<string, number> = {
  hysteresis: 0,
  vos: 0.001,
  rOut: 50,
  responseTime: 1e-6,
  vOH: 5,
  vOL: 0,
};

const MIN_ROUT = 1e-9;
const MIN_TAU  = 1e-12;

// ---------------------------------------------------------------------------
// ComparatorDriverElement
// ---------------------------------------------------------------------------

export class ComparatorDriverElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly deviceFamily: DeviceFamily = "BEHAVIORAL";
  readonly stateSchema = COMPARATOR_SCHEMA;
  readonly stateSize = COMPARATOR_SCHEMA.size;

  private _hysteresis: number;
  private _vos: number;
  private _tau: number;
  private _rOut: number;
  private _vOH: number;
  private _vOL: number;

  private _ctrlOutNode = -1;
  private _gndNode = 0;
  private _handles: readonly [number, number, number, number] = [-1, -1, -1, -1];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._hysteresis = props.hasModelParam("hysteresis")   ? props.getModelParam<number>("hysteresis")   : COMPARATOR_DRIVER_DEFAULTS["hysteresis"]!;
    this._vos        = props.hasModelParam("vos")          ? props.getModelParam<number>("vos")          : COMPARATOR_DRIVER_DEFAULTS["vos"]!;
    this._rOut       = Math.max(props.hasModelParam("rOut") ? props.getModelParam<number>("rOut") : COMPARATOR_DRIVER_DEFAULTS["rOut"]!, MIN_ROUT);
    this._tau        = Math.max(props.hasModelParam("responseTime") ? props.getModelParam<number>("responseTime") : COMPARATOR_DRIVER_DEFAULTS["responseTime"]!, MIN_TAU);
    this._vOH        = props.hasModelParam("vOH")  ? props.getModelParam<number>("vOH")  : COMPARATOR_DRIVER_DEFAULTS["vOH"]!;
    this._vOL        = props.hasModelParam("vOL")  ? props.getModelParam<number>("vOL")  : COMPARATOR_DRIVER_DEFAULTS["vOL"]!;
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

  /**
   * load()- hybrid Template D shape.
   *
   * Stamp uses s1[OUTPUT_WEIGHT] (J-021 ss1.1 StatePool migration shape:
   * stamp from prior step, integrate forward, write s0 at the bottom).
   * Latch transitions evaluate against the current rhsOld iterate; weight
   * integrates forward via the J-021 trapezoidal recurrence.
   */
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

    // Weight integration- J-021 trapezoidal recurrence.
    // alpha = dt / (tau + dt); wNew = wOld + alpha * (target - wOld).
    // dt = 0 (DC) -> alpha = 0 -> wNew = wOld (weight held; latch still updates).
    const wOld = s1[base + SLOT_OUTPUT_WEIGHT];
    const dt = ctx.dt;
    const alpha = dt > 0 ? dt / (this._tau + dt) : 0;
    const wNew = wOld + alpha * (latchNew - wOld);

    // Norton stamp at ctrl_out: drive latched output level.
    const target = latchNew ? this._vOH : this._vOL;
    stampNortonValue(ctx, this._handles, this._ctrlOutNode, this._gndNode, this._rOut, target);

    // Bottom-of-load writes- every slot mutated this step writes to s0
    // exactly once.
    s0[base + SLOT_OUTPUT_LATCH]  = latchNew;
    s0[base + SLOT_OUTPUT_WEIGHT] = wNew;
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const ctrlOutNode = this.pinNodes.get("ctrl_out")!;
    const G = 1 / this._rOut;
    const s1 = this._pool.states[1];
    const latchOld = s1[this._stateBase + SLOT_OUTPUT_LATCH] >= 0.5 ? 1 : 0;
    const vTarget = latchOld ? this._vOH : this._vOL;
    const I = G * (rhs[ctrlOutNode] - vTarget);
    return [0, 0, I];
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const ComparatorDriverDefinition: ComponentDefinition = {
  name: "ComparatorDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: COMPARATOR_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: COMPARATOR_DRIVER_PARAM_DEFS,
      params: COMPARATOR_DRIVER_DEFAULTS,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new ComparatorDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
