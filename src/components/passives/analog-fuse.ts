/**
 * Analog fuse MNA element- switching resistance with thermal I²t energy model.
 *
 * Models a fuse as a resistance that switches abruptly from R_cold (intact) to
 * R_blown (open circuit) when the accumulated I²t energy reaches the rating.
 *
 * Thermal model:
 *   SLOT_I2T_ACCUM accumulates I²·dt each accepted timestep via the bottom-of-load
 *   history write. When SLOT_I2T_ACCUM >= i2tRating the fuse is permanently blown-
 *   SLOT_CONDUCT switches in one step from 1 to 0.
 *
 * Trip-time breakpoint scheduling:
 *   acceptStep() predicts the time-to-blow from the current operating
 *   point (t_blow = (rating - accum) / i²) and registers it via addBreakpoint.
 *   The transient controller then lands the next step exactly on the predicted
 *   blow instant, so the rCold→rBlown jump never happens mid-step. This avoids
 *   LTE rejection / dt collapse from a discontinuity inside an integration interval.
 *   Mirrors ngspice vsrcacct.c:24-310 (DEVaccept breakpoint-scheduling hook).
 *
 * Cross-engine state propagation:
 *   The factory captures the CircuitElement's PropertyBag and writes
 *   `_thermalRatio` (0→1) and `blown` (boolean) into it each timestep.
 *   The visual FuseElement.draw() reads these for heat glow and blown rendering.
 *   The digital executeFuse reads `blown` for the bus resolver closed flag.
 *
 * MNA topology:
 *   _pinNodes.get("out1") = n_pos  (positive terminal)
 *   _pinNodes.get("out2") = n_neg  (negative terminal)
 *   branchIndex            = -1    (no branch current row- RES topology)
 *
 * Setup/load split (ngspice anchor: res/ressetup.c, res/resload.c):
 *   setup(ctx)      allocates 4 matrix handles (_hPP, _hNN, _hPN, _hNP) via
 *                   ressetup.c:46-49 TSTALLOC sequence.
 *   load(ctx)       stamps conductance through cached handles only (no allocElement).
 *                   Bottom-of-load integrates I²t and updates CONDUCT slot.
 *   acceptStep()    schedules breakpoint at predicted blow instant.
 *                   Mirrors vsrcacct.c:24-310.
 */

import { AbstractPoolBackedAnalogElement, type PoolBackedAnalogElement } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { Diagnostic } from "../../compile/types.js";
import { PropertyBag } from "../../core/properties.js";
import { defineModelParams } from "../../core/model-params.js";
import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";

// ---------------------------------------------------------------------------
// State-pool schema
// ---------------------------------------------------------------------------

export const ANALOG_FUSE_SCHEMA = defineStateSchema("AnalogFuseElement", [
  { name: "I2T_ACCUM", doc: "Accumulated I²t thermal energy in A²·s" },
  { name: "CONDUCT",   doc: "Conductance state: 1 = intact, 0 = blown" },
]) satisfies StateSchema;

const SLOT_I2T_ACCUM = 0;
const SLOT_CONDUCT   = 1;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: ANALOG_FUSE_PARAM_DEFS, defaults: ANALOG_FUSE_DEFAULTS } = defineModelParams({
  primary: {
    rCold:     { default: 0.01,  unit: "Ω", description: "Cold (intact) resistance in ohms", min: 1e-12 },
    rBlown:    { default: 1e9,   unit: "Ω", description: "Blown (open) resistance in ohms", min: 1e-6 },
    i2tRating: { default: 1e-4,  unit: "A²s", description: "I²t energy rating in A²·s", min: 1e-30 },
  },
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_RESISTANCE = 1e-12;

// ---------------------------------------------------------------------------
// AnalogFuseElement- MNA implementation
// ---------------------------------------------------------------------------

export class AnalogFuseElement extends AbstractPoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.RES;
  readonly stateSchema = ANALOG_FUSE_SCHEMA;
  readonly stateSize = ANALOG_FUSE_SCHEMA.size;
  setParam(_key: string, _value: number): void {}

  // Handle fields allocated in setup()- port of ressetup.c:46-49
  private _hPP: number = -1;
  private _hNN: number = -1;
  private _hPN: number = -1;
  private _hNP: number = -1;

  private _rCold: number;
  private _rBlown: number;
  private _i2tRating: number;

  private _intact: boolean = true;
  private _diagEmitted: boolean = false;

  private _emitDiagnostic: (diag: Diagnostic) => void = () => {};
  private readonly _onStateChange: ((blown: boolean, thermalRatio: number) => void) | null;

  /**
   * @param pinNodes       - Pin map with "out1" (positive) and "out2" (negative) terminals
   * @param rCold          - Cold (intact) resistance in ohms
   * @param rBlown         - Blown (open) resistance in ohms
   * @param i2tRating      - I²t energy rating in A²·s
   * @param onStateChange  - Callback invoked each timestep with blown flag and thermal ratio
   *
   * The runtime diagnostic channel is installed by the engine via
   * `setDiagnosticEmitter()` after construction (RuntimeDiagnosticAware).
   */
  constructor(
    pinNodes: ReadonlyMap<string, number>,
    rCold: number,
    rBlown: number,
    i2tRating: number,
    onStateChange?: (blown: boolean, thermalRatio: number) => void,
  ) {
    super(pinNodes);
    this._rCold = Math.max(rCold, 1e-12);
    this._rBlown = Math.max(rBlown, 1e-6);
    this._i2tRating = Math.max(i2tRating, 1e-30);
    this._onStateChange = onStateChange ?? null;
  }

  /** RuntimeDiagnosticAware: engine wires this in MNAEngine.init() so that
   *  fuse-blown emissions reach coordinator.getRuntimeDiagnostics(). */
  setDiagnosticEmitter(emit: (diag: Diagnostic) => void): void {
    this._emitDiagnostic = emit;
  }

  setup(ctx: SetupContext): void {
    if (this._stateBase === -1) {
      this._stateBase = ctx.allocStates(this.stateSize);
    }

    const solver = ctx.solver;
    const posNode = this._pinNodes.get("out1")!;  // RESposNode
    const negNode = this._pinNodes.get("out2")!;  // RESnegNode

    // Port of ressetup.c:46-49- TSTALLOC sequence (line-for-line)
    this._hPP = solver.allocElement(posNode, posNode);  // (RESposNode, RESposNode)
    this._hNN = solver.allocElement(negNode, negNode);  // (RESnegNode, RESnegNode)
    this._hPN = solver.allocElement(posNode, negNode);  // (RESposNode, RESnegNode)
    this._hNP = solver.allocElement(negNode, posNode);  // (RESnegNode, RESposNode)
  }

  load(ctx: LoadContext): void {
    const base = this._stateBase;
    const s1 = this._pool.states[1];
    const s0 = this._pool.states[0];

    const accumOld = s1[base + SLOT_I2T_ACCUM];
    const conductOld = this._intact ? 1 : 0;

    // Stamp conductance derived from last-accepted state (stable across NR loop)
    const r = this._intact ? this._rCold : this._rBlown;
    const g = 1 / Math.max(r, MIN_RESISTANCE);
    ctx.solver.stampElement(this._hPP, +g);
    ctx.solver.stampElement(this._hNN, +g);
    ctx.solver.stampElement(this._hPN, -g);
    ctx.solver.stampElement(this._hNP, -g);

    // ngspice CKTstate0 idiom - bjtload.c:744-746, dioload.c:325-326
    const posNode = this._pinNodes.get("out1")!;
    const negNode = this._pinNodes.get("out2")!;
    const voltages = ctx.rhsOld;
    const v = voltages[posNode] - voltages[negNode];
    const iIter = g * v;
    const dt = ctx.dt ?? 0;

    const accumNew = accumOld + iIter * iIter * dt;

    s0[base + SLOT_I2T_ACCUM] = accumNew;
    s0[base + SLOT_CONDUCT]   = conductOld;

    // Propagate state to the visual/digital layer
    const ratio = Math.min(accumNew / this._i2tRating, 1);
    if (this._onStateChange) {
      this._onStateChange(!this._intact, ratio);
    }
  }

  /**
   * Flip _intact on the first accepted step where I²t crosses the rating,
   * emit the fuse-blown diagnostic exactly once, and schedule a breakpoint
   * at the predicted blow instant. acceptStep is the canonical mutation
   * site for _intact / _diagEmitted (post-LTE-acceptance).
   *
   * Mirrors ngspice DEVaccept dispatch (vsrcacct.c:24-310).
   */
  acceptStep(
    simTime: number,
    addBreakpoint: (t: number) => void,
    _atBreakpoint: boolean,
  ): void {
    const base = this._stateBase;
    const s1 = this._pool.states[1];
    const accumNow = s1[base + SLOT_I2T_ACCUM];

    if (this._intact && accumNow >= this._i2tRating) {
      this._intact = false;
      this._pool.states[1][base + SLOT_CONDUCT] = 0;
    }

    if (!this._intact && !this._diagEmitted) {
      this._emitDiagnostic({
        code: "fuse-blown",
        severity: "info",
        message: "Fuse blown: accumulated I²t energy exceeded rating.",
        explanation:
          "The fuse thermal energy (I²·t integral) exceeded the specified i2tRating. " +
          "The fuse is now permanently open (high resistance). " +
          "Replace the fuse or reduce the current to prevent recurrence.",
        suggestions: [
          {
            text: "Increase i2tRating or reduce load current.",
            automatable: false,
          },
        ],
      });
      this._diagEmitted = true;
    }

    if (!this._intact) return;

    if (accumNow >= this._i2tRating * 0.95) {
      const posNode = this._pinNodes.get("out1")!;
      const negNode = this._pinNodes.get("out2")!;
      const rhs = this._pool.state0;
      const v = rhs[posNode] - rhs[negNode];
      const g = 1 / Math.max(this._rCold, MIN_RESISTANCE);
      const i = g * v;
      const i2 = i * i;
      if (i2 > 0) {
        const tBlow = simTime + (this._i2tRating - accumNow) / i2;
        addBreakpoint(tBlow);
      }
    }
  }

  updatePhysicalParams(rCold: number, rBlown: number, i2tRating: number): void {
    this._rCold = Math.max(rCold, 1e-12);
    this._rBlown = Math.max(rBlown, 1e-6);
    this._i2tRating = Math.max(i2tRating, 1e-30);
  }

  /** Accumulated I²t energy- exposed for testing. */
  get thermalEnergy(): number {
    if (this._stateBase === -1 || !this._pool) return 0;
    return this._pool.states[1][this._stateBase + SLOT_I2T_ACCUM];
  }

  /** True if the fuse has blown. */
  get blown(): boolean {
    return !this._intact;
  }

  /** Ratio of accumulated I²t energy to i2tRating (0→1). */
  get thermalRatio(): number {
    if (this._stateBase === -1 || !this._pool) return 0;
    const accum = this._pool.states[1][this._stateBase + SLOT_I2T_ACCUM];
    return Math.min(accum / this._i2tRating, 1);
  }

  /** Current effective resistance- abrupt switch on blow. */
  get currentResistance(): number {
    return this.blown ? this._rBlown : this._rCold;
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const nPos = this._pinNodes.get("out1")!;
    const nNeg = this._pinNodes.get("out2")!;
    const vPos = rhs[nPos];
    const vNeg = rhs[nNeg];
    const R = this._intact ? this._rCold : this._rBlown;
    const G = 1 / Math.max(R, MIN_RESISTANCE);
    const I = G * (vPos - vNeg);
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// Factory- creates AnalogFuseElement with PropertyBag writeback
// ---------------------------------------------------------------------------

function buildAnalogFuseElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  rCold: number,
  rBlown: number,
  i2tRating: number,
): PoolBackedAnalogElement {
  const p = { rCold, rBlown, i2tRating };
  const el = new AnalogFuseElement(
    pinNodes,
    p.rCold,
    p.rBlown,
    p.i2tRating,
    (blown, thermalRatio) => {
      props.set("_thermalRatio", thermalRatio);
      if (blown) {
        props.set("blown", true);
      }
    },
  );
  el.setParam = function(key: string, value: number): void {
    if (key in p) {
      (p as Record<string, number>)[key] = value;
      el.updatePhysicalParams(p.rCold, p.rBlown, p.i2tRating);
    }
  };
  return el;
}

export function createAnalogFuseElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): PoolBackedAnalogElement {
  return buildAnalogFuseElement(
    pinNodes,
    props,
    props.getModelParam<number>("rCold"),
    props.getModelParam<number>("rBlown"),
    props.getModelParam<number>("i2tRating"),
  );
}
