/**
 * Analog fuse MNA element — switching resistance with thermal I²t energy model.
 *
 * Models a fuse as a resistance that switches abruptly from R_cold (intact) to
 * R_blown (open circuit) when the accumulated I²t energy reaches the rating.
 *
 * Thermal model:
 *   _i2tAccum accumulates I²·dt each accepted timestep via accept().
 *   When _i2tAccum >= i2tRating the fuse is permanently blown — _conduct
 *   switches in one step from 1/rCold to 1/rBlown.
 *
 * Trip-time breakpoint scheduling:
 *   Each accepted step predicts the time-to-blow from the current operating
 *   point (t_blow = (rating - accum) / i²) and registers it via the engine's
 *   addBreakpoint callback. The transient controller then lands the next step
 *   exactly on the predicted blow instant, so the rCold→rBlown jump never
 *   happens mid-step. This avoids LTE rejection / dt collapse from a
 *   discontinuity inside an integration interval.
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
 *   branchIndex            = -1    (no branch current row — RES topology)
 *
 * Setup/load split (ngspice anchor: res/ressetup.c, res/resload.c):
 *   setup(ctx)   allocates 4 matrix handles (_hPP, _hNN, _hPN, _hNP) via
 *                ressetup.c:46-49 TSTALLOC sequence.
 *   load(ctx)    stamps conductance through cached handles only (no allocElement).
 *   accept(ctx)  integrates I²·dt, updates _conduct, sets _blown when threshold
 *                exceeded, and emits the 'fuse-blown' diagnostic once.
 */

import type { AnalogElement } from "../../core/analog-types.js";
import { NGSPICE_LOAD_ORDER } from "../../core/analog-types.js";
import type { LoadContext } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { Diagnostic } from "../../compile/types.js";
import { PropertyBag } from "../../core/properties.js";
import { defineModelParams } from "../../core/model-params.js";

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
// AnalogFuseElement — MNA implementation
// ---------------------------------------------------------------------------

export class AnalogFuseElement implements AnalogElement {
  label: string = "";
  _pinNodes: Map<string, number> = new Map();
  _stateBase: number = -1;
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.RES;
  setParam(_key: string, _value: number): void {}

  // Handle fields allocated in setup() — port of ressetup.c:46-49
  private _hPP: number = -1;
  private _hNN: number = -1;
  private _hPN: number = -1;
  private _hNP: number = -1;
  // Conductance = 1/R, updated by accept() via the I²t thermal model
  private _conduct: number = 1;

  private _rCold: number;
  private _rBlown: number;
  private _i2tRating: number;

  private _i2tAccum: number = 0;
  private _blown: boolean = false;
  private _blownDiagEmitted: boolean = false;

  private readonly _emitDiagnostic: (diag: Diagnostic) => void;
  private readonly _onStateChange: ((blown: boolean, thermalRatio: number) => void) | null;

  /**
   * @param pinNodes       - Pin map with "out1" (positive) and "out2" (negative) terminals
   * @param rCold          - Cold (intact) resistance in ohms
   * @param rBlown         - Blown (open) resistance in ohms
   * @param i2tRating      - I²t energy rating in A²·s
   * @param emitDiagnostic - Callback invoked when fuse blows
   * @param onStateChange  - Callback invoked each timestep with blown flag and thermal ratio
   */
  constructor(
    pinNodes: ReadonlyMap<string, number>,
    rCold: number,
    rBlown: number,
    i2tRating: number,
    emitDiagnostic?: (diag: Diagnostic) => void,
    onStateChange?: (blown: boolean, thermalRatio: number) => void,
  ) {
    this._pinNodes = new Map(pinNodes);
    this._rCold = Math.max(rCold, 1e-12);
    this._rBlown = Math.max(rBlown, 1e-6);
    this._i2tRating = Math.max(i2tRating, 1e-30);
    this._emitDiagnostic = emitDiagnostic ?? (() => {});
    this._onStateChange = onStateChange ?? null;
    this._conduct = 1 / Math.max(this._rCold, MIN_RESISTANCE);
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const posNode = this._pinNodes.get("out1")!;  // RESposNode
    const negNode = this._pinNodes.get("out2")!;  // RESnegNode

    // Port of ressetup.c:46-49 — TSTALLOC sequence (line-for-line)
    this._hPP = solver.allocElement(posNode, posNode);  // (RESposNode, RESposNode)
    this._hNN = solver.allocElement(negNode, negNode);  // (RESnegNode, RESnegNode)
    this._hPN = solver.allocElement(posNode, negNode);  // (RESposNode, RESnegNode)
    this._hNP = solver.allocElement(negNode, posNode);  // (RESnegNode, RESposNode)

    // Sync conductance from current blown state. Abrupt model — no smooth blend.
    const r = this._blown ? this._rBlown : this._rCold;
    this._conduct = 1 / Math.max(r, MIN_RESISTANCE);
  }

  load(ctx: LoadContext): void {
    // Port of resload.c — stamps through cached handles only (no allocElement)
    const g = this._conduct;
    ctx.solver.stampElement(this._hPP, +g);
    ctx.solver.stampElement(this._hNN, +g);
    ctx.solver.stampElement(this._hPN, -g);
    ctx.solver.stampElement(this._hNP, -g);
  }

  accept(ctx: LoadContext, simTime: number, addBreakpoint: (t: number) => void): void {
    const dt = ctx.dt;
    const posNode = this._pinNodes.get("out1")!;
    const negNode = this._pinNodes.get("out2")!;
    const v = ctx.rhs[posNode] - ctx.rhs[negNode];
    const i = v * this._conduct;

    if (!this._blown) {
      // Integrate I²·dt
      this._i2tAccum += i * i * dt;

      if (this._i2tAccum >= this._i2tRating) {
        // Hard trip: switch resistance from rCold to rBlown next step.
        this._blown = true;
        this._conduct = 1 / Math.max(this._rBlown, MIN_RESISTANCE);
      } else {
        // Schedule a breakpoint at the predicted blow instant so the engine
        // lands exactly on the trip and avoids a discontinuity inside a step.
        //
        // Two guards keep the breakpoint queue bounded:
        //   - i² > 0: no impending trip when the load is open.
        //   - tBlow within a small lookahead of current dt: only schedule
        //     when blow is imminent. Far from blow the prediction is
        //     speculative; with varying current each accept() would push a
        //     distinct tBlow that the engine's dedup window (≈ 5e-5 ×
        //     maxTimeStep) is too tight to absorb. Within the lookahead,
        //     successive predictions stay close enough to coalesce.
        const i2 = i * i;
        if (i2 > 0) {
          const tBlow = simTime + (this._i2tRating - this._i2tAccum) / i2;
          const lookahead = 16 * dt;
          if (tBlow - simTime < lookahead) {
            addBreakpoint(tBlow);
          }
        }
      }
    }

    // Propagate state to the visual/digital layer
    const ratio = Math.min(this._i2tAccum / this._i2tRating, 1);
    if (this._onStateChange) {
      this._onStateChange(this._blown, ratio);
    }

    // Emit diagnostic once when fuse first blows
    if (this._blown && !this._blownDiagEmitted) {
      this._blownDiagEmitted = true;
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
    }
  }

  updatePhysicalParams(rCold: number, rBlown: number, i2tRating: number): void {
    this._rCold = Math.max(rCold, 1e-12);
    this._rBlown = Math.max(rBlown, 1e-6);
    this._i2tRating = Math.max(i2tRating, 1e-30);
  }

  /** Accumulated I²t energy — exposed for testing. */
  get thermalEnergy(): number {
    return this._i2tAccum;
  }

  /** True if the fuse has blown. */
  get blown(): boolean {
    return this._blown;
  }

  /** Ratio of accumulated I²t energy to i2tRating (0→1). */
  get thermalRatio(): number {
    return Math.min(this._i2tAccum / this._i2tRating, 1);
  }

  /** Current effective resistance — abrupt switch on blow. */
  get currentResistance(): number {
    return this._blown ? this._rBlown : this._rCold;
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const nPos = this._pinNodes.get("out1")!;
    const nNeg = this._pinNodes.get("out2")!;
    const vPos = rhs[nPos];
    const vNeg = rhs[nNeg];
    const R = this._blown ? this._rBlown : this._rCold;
    const G = 1 / Math.max(R, MIN_RESISTANCE);
    const I = G * (vPos - vNeg);
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// Factory — creates AnalogFuseElement with PropertyBag writeback
// ---------------------------------------------------------------------------

function buildAnalogFuseElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  rCold: number,
  rBlown: number,
  i2tRating: number,
): AnalogElement {
  const p = { rCold, rBlown, i2tRating };
  const el = new AnalogFuseElement(
    pinNodes,
    p.rCold,
    p.rBlown,
    p.i2tRating,
    undefined,
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
): AnalogElement {
  return buildAnalogFuseElement(
    pinNodes,
    props,
    props.getModelParam<number>("rCold"),
    props.getModelParam<number>("rBlown"),
    props.getModelParam<number>("i2tRating"),
  );
}
