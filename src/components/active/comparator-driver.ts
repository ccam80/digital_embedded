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
 * Stamp: G_eff = s1[OUTPUT_WEIGHT] / rSat at (out, out); no RHS (output
 * sinks to GND through rSat when latch=1; otherwise high-Z requires
 * external pull-up).
 *
 * Schema source: `COMPARATOR_SCHEMA` is owned by the parent (the
 * comparator's hysteresis is a chip-level property); this driver imports
 * it. Slot names `OUTPUT_LATCH` / `OUTPUT_WEIGHT` are authoritative; the
 * J-020 spec text "OUTPUT_LOGIC_LEVEL" predates the schema split.
 */

import type { AnalogElement, PoolBackedAnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { StatePoolRef } from "../../solver/analog/state-pool.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
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
  { direction: PinDirection.INPUT,  label: "in+", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "in-", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// Param defs- subset of the parent's COMPARATOR_PARAM_DEFS that this driver
// actually consumes. vOH / vOL are not declared here; they are only consumed
// by the push-pull driver in `comparator-pushpull-driver.ts`.
// ---------------------------------------------------------------------------

const COMPARATOR_DRIVER_PARAM_DEFS: ParamDef[] = [
  { key: "hysteresis",   default: 0 },
  { key: "vos",          default: 0.001 },
  { key: "rSat",         default: 50 },
  { key: "responseTime", default: 1e-6 },
];

const COMPARATOR_DRIVER_DEFAULTS: Record<string, number> = {
  hysteresis: 0,
  vos: 0.001,
  rSat: 50,
  responseTime: 1e-6,
};

const MIN_RSAT = 1e-9;
const MIN_TAU  = 1e-12;

// ---------------------------------------------------------------------------
// ComparatorDriverElement
// ---------------------------------------------------------------------------

export class ComparatorDriverElement implements PoolBackedAnalogElement {
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
  private _pool!: StatePoolRef;

  // Single matrix handle: (out, out). Open-collector model stamps the
  // weighted conductance on the output diagonal only- no cross-coupling
  // to in+/in- (those are pure read-only inputs into the latch logic).
  private _hOutOut = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);
    this._hysteresis = props.hasModelParam("hysteresis")   ? props.getModelParam<number>("hysteresis")   : COMPARATOR_DRIVER_DEFAULTS["hysteresis"]!;
    this._vos        = props.hasModelParam("vos")          ? props.getModelParam<number>("vos")          : COMPARATOR_DRIVER_DEFAULTS["vos"]!;
    this._rSat       = Math.max(props.hasModelParam("rSat") ? props.getModelParam<number>("rSat") : COMPARATOR_DRIVER_DEFAULTS["rSat"]!, MIN_RSAT);
    this._tau        = Math.max(props.hasModelParam("responseTime") ? props.getModelParam<number>("responseTime") : COMPARATOR_DRIVER_DEFAULTS["responseTime"]!, MIN_TAU);
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
  }

  setParam(key: string, value: number): void {
    switch (key) {
      case "hysteresis":   this._hysteresis = value; break;
      case "vos":          this._vos = value; break;
      case "rSat":         this._rSat = Math.max(value, MIN_RSAT); break;
      case "responseTime": this._tau = Math.max(value, MIN_TAU); break;
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

    const vPlus  = rhsOld[this._pinNodes.get("in+")!];
    const vMinus = rhsOld[this._pinNodes.get("in-")!];

    // Hysteresis thresholds.
    const half = this._hysteresis * 0.5;
    const vTh = vMinus + this._vos + half;
    const vTl = vMinus + this._vos - half;

    // Latch transition (hold otherwise).
    const latchOld = s1[base + SLOT_OUTPUT_LATCH] >= 0.5 ? 1 : 0;
    let latchNew: number = latchOld;
    if (latchOld === 0 && vPlus >= vTh)      latchNew = 1;
    else if (latchOld === 1 && vPlus < vTl)  latchNew = 0;

    // Stamp open-collector conductance using prior-step weight (s1).
    // G_eff = w * (1/rSat) at (out, out); no RHS (pulls to GND via rSat).
    const wOld = s1[base + SLOT_OUTPUT_WEIGHT];
    if (this._hOutOut !== -1) {
      const gEff = wOld / this._rSat;
      ctx.solver.stampElement(this._hOutOut, gEff);
    }

    // Weight integration- J-021 trapezoidal recurrence.
    // alpha = dt / (tau + dt); wNew = wOld + alpha * (target - wOld).
    // dt = 0 (DC) -> alpha = 0 -> wNew = wOld (weight held; latch still updates).
    const dt = ctx.dt;
    const alpha = dt > 0 ? dt / (this._tau + dt) : 0;
    const wNew = wOld + alpha * (latchNew - wOld);

    // Bottom-of-load writes- every slot mutated this step writes to s0
    // exactly once.
    s0[base + SLOT_OUTPUT_LATCH]  = latchNew;
    s0[base + SLOT_OUTPUT_WEIGHT] = wNew;
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const outNode = this._pinNodes.get("out")!;
    const s1 = this._pool.states[1];
    const wOld = s1[this._stateBase + SLOT_OUTPUT_WEIGHT];
    const gEff = wOld / this._rSat;
    const I = gEff * rhs[outNode];
    // Inputs are pure reads (no current); output sinks I to ground when active.
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
