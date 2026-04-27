/**
 * Analog fuse MNA element — variable-resistance with thermal I²t energy model.
 *
 * Models a fuse as a resistance that transitions from R_cold (intact) to
 * R_blown (open circuit) when the accumulated I²t energy exceeds the rating.
 *
 * Thermal model:
 *   _i2tAccum accumulates I²·dt each accepted timestep via accept().
 *   When _i2tAccum exceeds i2tRating the fuse is permanently blown.
 *
 * Smooth resistance transition:
 *   To prevent discontinuous resistance changes that would prevent NR convergence,
 *   the resistance is blended through a soft tanh transition over a small energy
 *   range near the blow threshold. The transition width is 5% of i2tRating.
 *
 *   R(e) = R_cold + (R_blown - R_cold) * 0.5 * (1 + tanh((e - i2t) / w))
 *
 *   where w = 0.05 * i2tRating (transition width).
 *   Below threshold R ≈ R_cold; above threshold R ≈ R_blown.
 *
 * Cross-engine state propagation:
 *   The factory captures the CircuitElement's PropertyBag and writes
 *   `_thermalRatio` (0→1) and `blown` (boolean) into it each timestep.
 *   The visual FuseElement.draw() reads these for heat glow and blown rendering.
 *   The digital executeFuse reads `blown` for the bus resolver closed flag.
 *
 * MNA topology:
 *   pinNodeIds[0] = n_pos  (positive terminal, out1 pin)
 *   pinNodeIds[1] = n_neg  (negative terminal, out2 pin)
 *   branchIndex    = -1     (no branch current row — RES topology)
 *
 * Setup/load split (ngspice anchor: res/ressetup.c, res/resload.c):
 *   setup(ctx)   allocates 4 matrix handles (_hPP, _hNN, _hPN, _hNP) via
 *                ressetup.c:46-49 TSTALLOC sequence.
 *   load(ctx)    stamps conductance through cached handles only (no allocElement).
 *   accept(ctx)  integrates I²·dt, updates _conduct, sets _blown when threshold
 *                exceeded, and emits the 'fuse-blown' diagnostic once.
 */

import type { AnalogElement, AnalogElementCore, LoadContext } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/element.js";
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
// Resistance helper
// ---------------------------------------------------------------------------

/**
 * Compute blended resistance using a tanh soft transition near the blow threshold.
 * Ensures NR convergence by avoiding a step discontinuity in conductance.
 */
function computeFuseResistance(
  i2tAccum: number,
  i2tRating: number,
  rCold: number,
  rBlown: number,
): number {
  const width = 0.05 * i2tRating;
  const x = (i2tAccum - i2tRating) / Math.max(width, 1e-30);
  const blend = 0.5 * (1 + Math.tanh(x));
  return rCold + (rBlown - rCold) * blend;
}

// ---------------------------------------------------------------------------
// AnalogFuseElement — MNA implementation
// ---------------------------------------------------------------------------

export class AnalogFuseElement implements AnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.RES;
  readonly isNonlinear: boolean = true;
  readonly isReactive: boolean = false;
  _stateBase: number = -1;
  _pinNodes: Map<string, number> = new Map();
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
   * @param pinNodeIds    - [n_pos, n_neg]
   * @param rCold          - Cold (intact) resistance in ohms
   * @param rBlown         - Blown (open) resistance in ohms
   * @param i2tRating      - I²t energy rating in A²·s
   * @param emitDiagnostic - Callback invoked when fuse blows
   * @param onStateChange  - Callback invoked each timestep with blown flag and thermal ratio
   */
  constructor(
    pinNodeIds: number[],
    rCold: number,
    rBlown: number,
    i2tRating: number,
    emitDiagnostic?: (diag: Diagnostic) => void,
    onStateChange?: (blown: boolean, thermalRatio: number) => void,
  ) {
    this.pinNodeIds = pinNodeIds;
    this.allNodeIds = pinNodeIds;
    this._rCold = Math.max(rCold, 1e-12);
    this._rBlown = Math.max(rBlown, 1e-6);
    this._i2tRating = Math.max(i2tRating, 1e-30);
    this._emitDiagnostic = emitDiagnostic ?? (() => {});
    this._onStateChange = onStateChange ?? null;
    // Initialise conductance from cold resistance
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

    // Sync conductance from current accumulated energy state
    this._conduct = 1 / Math.max(
      computeFuseResistance(this._i2tAccum, this._i2tRating, this._rCold, this._rBlown),
      MIN_RESISTANCE,
    );
  }

  load(ctx: LoadContext): void {
    // Port of resload.c — stamps through cached handles only (no allocElement)
    const g = this._conduct;
    ctx.solver.stampElement(this._hPP, +g);
    ctx.solver.stampElement(this._hNN, +g);
    ctx.solver.stampElement(this._hPN, -g);
    ctx.solver.stampElement(this._hNP, -g);
  }

  accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
    const dt = ctx.dt;
    const posNode = this._pinNodes.get("out1")!;
    const negNode = this._pinNodes.get("out2")!;
    const v = ctx.rhs[posNode] - ctx.rhs[negNode];
    const i = v * this._conduct;

    // Integrate I²·dt
    this._i2tAccum += i * i * dt;
    const newR = computeFuseResistance(this._i2tAccum, this._i2tRating, this._rCold, this._rBlown);
    this._conduct = 1 / Math.max(newR, MIN_RESISTANCE);

    // Check blow condition after integration
    if (!this._blown && this._i2tAccum >= this._i2tRating) {
      this._blown = true;
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

  /** Current effective resistance given accumulated I²t energy. */
  get currentResistance(): number {
    return computeFuseResistance(this._i2tAccum, this._i2tRating, this._rCold, this._rBlown);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const nPos = this.pinNodeIds[0];
    const nNeg = this.pinNodeIds[1];
    const vPos = rhs[nPos];
    const vNeg = rhs[nNeg];
    const R = computeFuseResistance(this._i2tAccum, this._i2tRating, this._rCold, this._rBlown);
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
): AnalogElementCore {
  const p = { rCold, rBlown, i2tRating };
  const el = new AnalogFuseElement(
    [pinNodes.get("out1")!, pinNodes.get("out2")!],
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
  el._pinNodes = new Map(pinNodes);
  (el as AnalogElementCore).setParam = function(key: string, value: number): void {
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
): AnalogElementCore {
  return buildAnalogFuseElement(
    pinNodes,
    props,
    props.getModelParam<number>("rCold"),
    props.getModelParam<number>("rBlown"),
    props.getModelParam<number>("i2tRating"),
  );
}
