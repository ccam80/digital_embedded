/**
 * Analog fuse MNA element — variable-resistance with thermal I²t energy model.
 *
 * Models a fuse as a resistance that transitions from R_cold (intact) to
 * R_blown (open circuit) when the accumulated I²t energy exceeds the rating.
 *
 * Thermal model:
 *   _thermalEnergy accumulates I²·dt each accepted timestep via updateState().
 *   When _thermalEnergy exceeds i2tRating the fuse is permanently blown.
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
 *   pinNodeIds[0] = n_pos  (positive terminal)
 *   pinNodeIds[1] = n_neg  (negative terminal)
 *   branchIndex    = -1     (no branch current row)
 *
 * Stamping:
 *   stamp()         — no-op (all contributions are in stampNonlinear)
 *   stampNonlinear  — stamps conductance 1/R(_thermalEnergy)
 *   updateState     — integrates I²·dt using current terminal voltages
 *
 * Diagnostic:
 *   Emits 'fuse-blown' (info) on the timestep when _blown first becomes true.
 */

import type { AnalogElement, AnalogElementCore } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import type { SolverDiagnostic } from "../../core/analog-engine-interface.js";
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
// Smooth resistance helper
// ---------------------------------------------------------------------------

/**
 * Compute blended resistance using a tanh soft transition near the blow threshold.
 * Ensures NR convergence by avoiding a step discontinuity in conductance.
 */
function smoothResistance(
  thermalEnergy: number,
  i2tRating: number,
  rCold: number,
  rBlown: number,
): number {
  const width = 0.05 * i2tRating;
  const x = (thermalEnergy - i2tRating) / Math.max(width, 1e-30);
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
  readonly isNonlinear: boolean = true;
  readonly isReactive: boolean = false;

  private readonly _rCold: number;
  private readonly _rBlown: number;
  private readonly _i2tRating: number;

  private _thermalEnergy: number = 0;
  private _blown: boolean = false;
  private _blownDiagEmitted: boolean = false;

  private _currentVoltage: number = 0;

  private readonly _emitDiagnostic: (diag: SolverDiagnostic) => void;
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
    emitDiagnostic?: (diag: SolverDiagnostic) => void,
    onStateChange?: (blown: boolean, thermalRatio: number) => void,
  ) {
    this.pinNodeIds = pinNodeIds;
    this.allNodeIds = pinNodeIds;
    this._rCold = Math.max(rCold, 1e-12);
    this._rBlown = Math.max(rBlown, 1e-6);
    this._i2tRating = Math.max(i2tRating, 1e-30);
    this._emitDiagnostic = emitDiagnostic ?? (() => {});
    this._onStateChange = onStateChange ?? null;
  }

  stamp(_solver: SparseSolver): void {
    // All conductance contributions are in stampNonlinear (resistance is state-dependent).
  }

  stampNonlinear(solver: SparseSolver): void {
    const nPos = this.pinNodeIds[0];
    const nNeg = this.pinNodeIds[1];

    const R = smoothResistance(this._thermalEnergy, this._i2tRating, this._rCold, this._rBlown);
    const G = 1 / Math.max(R, MIN_RESISTANCE);

    if (nPos !== 0 && nNeg !== 0) {
      solver.stamp(nPos - 1, nPos - 1, G);
      solver.stamp(nPos - 1, nNeg - 1, -G);
      solver.stamp(nNeg - 1, nPos - 1, -G);
      solver.stamp(nNeg - 1, nNeg - 1, G);
    } else if (nPos !== 0) {
      solver.stamp(nPos - 1, nPos - 1, G);
    } else if (nNeg !== 0) {
      solver.stamp(nNeg - 1, nNeg - 1, G);
    }
  }

  updateOperatingPoint(voltages: Float64Array): void {
    const nPos = this.pinNodeIds[0];
    const nNeg = this.pinNodeIds[1];
    const vPos = nPos > 0 ? voltages[nPos - 1] : 0;
    const vNeg = nNeg > 0 ? voltages[nNeg - 1] : 0;
    this._currentVoltage = vPos - vNeg;
  }

  updateState(dt: number, voltages: Float64Array): void {
    const nPos = this.pinNodeIds[0];
    const nNeg = this.pinNodeIds[1];
    const vPos = nPos > 0 ? voltages[nPos - 1] : 0;
    const vNeg = nNeg > 0 ? voltages[nNeg - 1] : 0;
    const vDiff = vPos - vNeg;

    // Compute current from the current resistance state.
    const R_eff = this._blown ? this._rBlown : this._rCold;
    const I = vDiff / Math.max(R_eff, MIN_RESISTANCE);

    // Integrate thermal energy: I²·dt
    this._thermalEnergy += I * I * dt;

    // Check blow condition after integration
    if (!this._blown && this._thermalEnergy >= this._i2tRating) {
      this._blown = true;
    }

    // Propagate state to the visual/digital layer
    const ratio = Math.min(this._thermalEnergy / this._i2tRating, 1);
    if (this._onStateChange) {
      this._onStateChange(this._blown, ratio);
    }

    // Emit diagnostic once when fuse first blows
    if (this._blown && !this._blownDiagEmitted) {
      this._blownDiagEmitted = true;
      this._emitDiagnostic({
        code: "fuse-blown",
        severity: "info",
        summary: "Fuse blown: accumulated I²t energy exceeded rating.",
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

  /** Current thermal energy state — exposed for testing. */
  get thermalEnergy(): number {
    return this._thermalEnergy;
  }

  /** True if the fuse has blown. */
  get blown(): boolean {
    return this._blown;
  }

  /** Ratio of accumulated thermal energy to i2tRating (0→1). */
  get thermalRatio(): number {
    return Math.min(this._thermalEnergy / this._i2tRating, 1);
  }

  /** Current effective resistance given accumulated thermal energy. */
  get currentResistance(): number {
    return smoothResistance(this._thermalEnergy, this._i2tRating, this._rCold, this._rBlown);
  }

  getPinCurrents(voltages: Float64Array): number[] {
    // No branch row — compute from constitutive equation: I = G_eff * (V_A - V_B).
    // pinNodeIds[0] = n_pos (out1 pin, index 0 in pinLayout).
    // pinNodeIds[1] = n_neg (out2 pin, index 1 in pinLayout).
    const nPos = this.pinNodeIds[0];
    const nNeg = this.pinNodeIds[1];
    const vPos = nPos > 0 ? voltages[nPos - 1] : 0;
    const vNeg = nNeg > 0 ? voltages[nNeg - 1] : 0;
    const R = smoothResistance(this._thermalEnergy, this._i2tRating, this._rCold, this._rBlown);
    const G = 1 / Math.max(R, MIN_RESISTANCE);
    const I = G * (vPos - vNeg);
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// analogFactory — creates AnalogFuseElement with PropertyBag writeback
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
  (el as AnalogElementCore).setParam = function(key: string, value: number): void {
    if (key in p) {
      (p as Record<string, number>)[key] = value;
    }
  };
  return el;
}

export function createAnalogFuseElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElementCore {
  return buildAnalogFuseElement(
    pinNodes,
    props,
    props.getOrDefault<number>("rCold", 0.01),
    props.getOrDefault<number>("rBlown", 1e9),
    props.getOrDefault<number>("i2tRating", 1e-4),
  );
}

export function createAnalogFuseElementFromModelParams(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElementCore {
  return buildAnalogFuseElement(
    pinNodes,
    props,
    props.getModelParam<number>("rCold"),
    props.getModelParam<number>("rBlown"),
    props.getModelParam<number>("i2tRating"),
  );
}
