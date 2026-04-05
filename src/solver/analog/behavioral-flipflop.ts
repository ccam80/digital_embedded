/**
 * BehavioralDFlipflopElement — analog behavioral model for a D flip-flop.
 *
 * Edge detection happens in updateCompanion() (called once per accepted
 * timestep, not per NR iteration). This ensures Q only latches on a real
 * rising clock edge, never mid-NR due to Newton-Raphson oscillation.
 *
 * Stamp protocol:
 *   stamp()          — stamps all pin R_in and output R_out/V_out (linear)
 *   stampNonlinear() — re-stamps output pins based on _latchedQ
 *   stampCompanion() — stamps pin capacitance companion models
 *   updateCompanion()— edge detection + pin companion state update
 *   updateOperatingPoint() — caches latest NR voltages for stampNonlinear
 */

import type { SparseSolver } from "./sparse-solver.js";
import type { AnalogElementCore, IntegrationMethod } from "./element.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import {
  DigitalInputPinModel,
  DigitalOutputPinModel,
  readMnaVoltage,
  delegatePinSetParam,
} from "./digital-pin-model.js";
import type { AnalogElementFactory } from "./behavioral-gate.js";

// ---------------------------------------------------------------------------
// BehavioralDFlipflopElement
// ---------------------------------------------------------------------------

/**
 * Analog behavioral model for an edge-triggered D flip-flop.
 *
 * Pin layout matches DDefinition pin declarations:
 *   inputs:  clock (C), D
 *   outputs: Q, ~Q (qBar)
 *   optional: set, reset
 *
 * Rising-edge detection uses _prevClockVoltage stored after each accepted
 * timestep. The comparison threshold is vIH from the clock pin's electrical
 * spec.
 *
 * Asynchronous reset convention: resetActiveLevel 'low' means reset asserts
 * when voltage < vIL (active-low, matching standard CMOS CDRST). The set pin
 * uses the opposite active-high convention.
 */
export class BehavioralDFlipflopElement implements AnalogElementCore {
  private readonly _clockPin: DigitalInputPinModel;
  private readonly _dPin: DigitalInputPinModel;
  private readonly _qPin: DigitalOutputPinModel;
  private readonly _qBarPin: DigitalOutputPinModel;
  private readonly _setPin: DigitalInputPinModel | null;
  private readonly _resetPin: DigitalInputPinModel | null;

  /** Current latched Q state. Initial value is false (logic LOW). */
  private _latchedQ = false;

  /**
   * Clock voltage at the previous accepted timestep.
   *
   * Initialized to NaN as a sentinel meaning "no previous sample yet": the
   * first updateCompanion() call seeds this field from the current clock
   * voltage and skips edge detection. Without the sentinel, a DC operating
   * point with clock HIGH would produce a spurious rising edge on the first
   * transient step (prev=0, curr=3.3V).
   */
  private _prevClockVoltage = NaN;

  /**
   * Threshold for rising-edge detection — taken from the clock pin's vIH.
   * Stored at construction so edge detection does not re-read spec on hot path.
   */
  private readonly _vIH: number;
  private readonly _vIL: number;

  /**
   * resetActiveLevel: 'low' means reset asserts when reset pin voltage < vIL.
   * 'high' means reset asserts when reset pin voltage > vIH.
   */
  private readonly _resetActiveLevel: 'high' | 'low';

  /**
   * Cached solver reference — set on first stamp() call so stampCompanion
   * can reach the solver without receiving it as a parameter.
   */
  private _solver: SparseSolver | null = null;

  /** Cached operating-point voltages from the last updateOperatingPoint call. */
  private _cachedVoltages: Float64Array = new Float64Array(0);

  private readonly _pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>;

  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: true = true;
  readonly isReactive: true = true;
  label?: string;

  constructor(
    clockPin: DigitalInputPinModel,
    dPin: DigitalInputPinModel,
    qPin: DigitalOutputPinModel,
    qBarPin: DigitalOutputPinModel,
    setPin: DigitalInputPinModel | null,
    resetPin: DigitalInputPinModel | null,
    resetActiveLevel: 'high' | 'low' = 'low',
    pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel> = new Map(),
  ) {
    this._clockPin = clockPin;
    this._dPin = dPin;
    this._qPin = qPin;
    this._qBarPin = qBarPin;
    this._setPin = setPin;
    this._resetPin = resetPin;
    this._resetActiveLevel = resetActiveLevel;
    this._pinModelsByLabel = pinModelsByLabel;

    this._vIH = 2.0; // overwritten by factory via _setThresholds
    this._vIL = 0.8;
  }

  /**
   * Override threshold values — called by the factory after construction.
   * Necessary because DigitalInputPinModel keeps spec fields private.
   */
  _setThresholds(vIH: number, _vIL: number): void {
    (this as unknown as { _vIH: number })._vIH = vIH;
  }

  /**
   * Stamp linear contributions: input loading resistances.
   *
   * Output pins are stamped in stampNonlinear because their Norton current
   * depends on the latched Q state. Since beginAssembly clears the matrix
   * before each NR iteration, stamping the full output in stampNonlinear is
   * correct and avoids double-counting.
   */
  stamp(solver: SparseSolver): void {
    this._solver = solver;
    this._clockPin.stamp(solver);
    this._dPin.stamp(solver);
    if (this._setPin !== null) this._setPin.stamp(solver);
    if (this._resetPin !== null) this._resetPin.stamp(solver);
  }

  /**
   * Re-stamp output pins based on the current latched Q state.
   *
   * Called every NR iteration. Does NOT evaluate logic — that happens
   * exclusively in updateCompanion() to prevent mid-NR latching.
   */
  stampNonlinear(solver: SparseSolver): void {
    this._solver = solver;
    this._qPin.setLogicLevel(this._latchedQ);
    this._qBarPin.setLogicLevel(!this._latchedQ);
    this._qPin.stampOutput(solver);
    this._qBarPin.stampOutput(solver);
  }

  /**
   * Cache NR solution voltages for stampNonlinear.
   *
   * Grows the cache array lazily to match the solution vector size.
   */
  updateOperatingPoint(voltages: Readonly<Float64Array>): void {
    if (this._cachedVoltages.length !== voltages.length) {
      this._cachedVoltages = new Float64Array(voltages.length);
    }
    this._cachedVoltages.set(voltages);
  }

  /**
   * Stamp companion models for all pin capacitances.
   *
   * Called once per timestep before the NR iterations begin.
   */
  stampCompanion(
    dt: number,
    method: IntegrationMethod,
    _voltages: Float64Array,
  ): void {
    const solver = this._solver;
    if (solver === null) return;
    this._clockPin.stampCompanion(solver, dt, method);
    this._dPin.stampCompanion(solver, dt, method);
    this._qPin.stampCompanion(solver, dt, method);
    this._qBarPin.stampCompanion(solver, dt, method);
    if (this._setPin !== null) this._setPin.stampCompanion(solver, dt, method);
    if (this._resetPin !== null) this._resetPin.stampCompanion(solver, dt, method);
  }

  /**
   * Edge detection and companion state update — called once per accepted
   * timestep with the accepted solution voltages.
   *
   * Steps:
   *   1. Read current clock voltage.
   *   2. Detect rising edge: _prevClockVoltage < vIH && currentClockV >= vIH.
   *   3. On rising edge: sample D, update _latchedQ.
   *   4. Handle async set/reset (override clock-triggered state).
   *   5. Update _prevClockVoltage.
   *   6. Update all pin companion models.
   */
  updateCompanion(
    dt: number,
    method: IntegrationMethod,
    voltages: Float64Array,
  ): void {
    const clockNodeId = this._clockPin.nodeId;
    const dNodeId = this._dPin.nodeId;
    const currentClockV = readMnaVoltage(clockNodeId, voltages);
    const dVoltage = readMnaVoltage(dNodeId, voltages);

    // Rising edge detection. On the first call _prevClockVoltage is NaN
    // (sentinel): skip edge detection and just seed from the current sample
    // — edge detection requires two samples, and the DC steady-state value
    // must not be interpreted as a transition from LOW.
    const risingEdge =
      !Number.isNaN(this._prevClockVoltage) &&
      this._prevClockVoltage < this._vIH &&
      currentClockV >= this._vIH;

    if (risingEdge) {
      const dLevel = this._dPin.readLogicLevel(dVoltage);
      // If D is indeterminate, latch holds its current value
      if (dLevel !== undefined) {
        this._latchedQ = dLevel;
      }
    }

    // Asynchronous set/reset — override latched state
    if (this._setPin !== null) {
      const setV = readMnaVoltage(this._setPin.nodeId, voltages);
      // Set is active-high
      if (setV > this._vIH) {
        this._latchedQ = true;
      }
    }

    if (this._resetPin !== null) {
      const resetV = readMnaVoltage(this._resetPin.nodeId, voltages);
      if (this._resetActiveLevel === 'low') {
        if (resetV < this._vIL) {
          this._latchedQ = false;
        }
      } else {
        if (resetV > this._vIH) {
          this._latchedQ = false;
        }
      }
    }

    this._prevClockVoltage = currentClockV;

    // Update all pin companion models with accepted voltages
    this._clockPin.updateCompanion(dt, method, currentClockV);
    this._dPin.updateCompanion(dt, method, dVoltage);

    this._qPin.updateCompanion(dt, method, readMnaVoltage(this._qPin.nodeId, voltages));
    this._qBarPin.updateCompanion(dt, method, readMnaVoltage(this._qBarPin.nodeId, voltages));

    if (this._setPin !== null) {
      this._setPin.updateCompanion(dt, method, readMnaVoltage(this._setPin.nodeId, voltages));
    }

    if (this._resetPin !== null) {
      this._resetPin.updateCompanion(dt, method, readMnaVoltage(this._resetPin.nodeId, voltages));
    }
  }

  /** No-op: threshold detection manages state in updateCompanion. */
  updateState(_dt: number, _voltages: Float64Array): void {
    // intentionally empty
  }

  /**
   * Per-pin currents in pinNodeIds (pinLayout) order:
   *   [D, C, Q, ~Q] (and optionally set, reset if present)
   *
   * Input pins (D, C, set, reset): I = V_node / rIn.
   * Output pins (Q, ~Q): I = (V_node - V_target) / rOut.
   * Sum is nonzero because behavioral outputs have an implicit supply.
   */
  getPinCurrents(voltages: Float64Array): number[] {
    const vD = readMnaVoltage(this._dPin.nodeId, voltages);
    const vC = readMnaVoltage(this._clockPin.nodeId, voltages);
    const vQ = readMnaVoltage(this._qPin.nodeId, voltages);
    const vQBar = readMnaVoltage(this._qBarPin.nodeId, voltages);

    const result = [
      vD / this._dPin.rIn,
      vC / this._clockPin.rIn,
      (vQ - this._qPin.currentVoltage) / this._qPin.rOut,
      (vQBar - this._qBarPin.currentVoltage) / this._qBarPin.rOut,
    ];

    if (this._setPin !== null) {
      const vSet = readMnaVoltage(this._setPin.nodeId, voltages);
      result.push(vSet / this._setPin.rIn);
    }
    if (this._resetPin !== null) {
      const vReset = readMnaVoltage(this._resetPin.nodeId, voltages);
      result.push(vReset / this._resetPin.rIn);
    }

    return result;
  }

  setParam(key: string, value: number): void {
    delegatePinSetParam(this._pinModelsByLabel, key, value);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Default CMOS 3.3V electrical spec used when no _pinElectrical is injected
 * by the compiler. Allows tests to call the factory without a full compiler
 * context.
 */
const FALLBACK_SPEC: ResolvedPinElectrical = {
  rOut: 50,
  cOut: 5e-12,
  rIn: 1e7,
  cIn: 5e-12,
  vOH: 3.3,
  vOL: 0.0,
  vIH: 2.0,
  vIL: 0.8,
  rHiZ: 1e7,
};

/**
 * Returns an analogFactory closure for D flip-flops.
 *
 * Pin order matches DDefinition pin declarations:
 *   nodeIds[0] = D input node
 *   nodeIds[1] = C (clock) input node
 *   nodeIds[2] = Q output node
 *   nodeIds[3] = ~Q output node
 *
 * No set/reset pins in the standard D flip-flop configuration.
 * The factory reads resolved pin electrical specs from props._pinElectrical
 * (injected by the analog compiler). Pin labels match D_FF_PIN_DECLARATIONS:
 *   "D", "C", "Q", "~Q".
 */
export function makeDFlipflopAnalogFactory(): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
    const pinSpecs = props.has("_pinElectrical")
      ? (props.get("_pinElectrical") as unknown as Record<string, ResolvedPinElectrical>)
      : undefined;

    const dSpec = pinSpecs?.["D"] ?? FALLBACK_SPEC;
    const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
    const qSpec = pinSpecs?.["Q"] ?? FALLBACK_SPEC;
    const qBarSpec = pinSpecs?.["~Q"] ?? FALLBACK_SPEC;

    const dPin = new DigitalInputPinModel(dSpec, true);
    dPin.init(pinNodes.get("D") ?? 0, 0);

    const clockPin = new DigitalInputPinModel(cSpec, true);
    clockPin.init(pinNodes.get("C") ?? 0, 0);

    const qPin = new DigitalOutputPinModel(qSpec);
    qPin.init(pinNodes.get("Q") ?? 0, -1);

    const qBarPin = new DigitalOutputPinModel(qBarSpec);
    qBarPin.init(pinNodes.get("~Q") ?? 0, -1);

    const pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>([
      ["D", dPin],
      ["C", clockPin],
      ["Q", qPin],
      ["~Q", qBarPin],
    ]);

    const element = new BehavioralDFlipflopElement(
      clockPin,
      dPin,
      qPin,
      qBarPin,
      null,
      null,
      'low',
      pinModelsByLabel,
    );
    element._setThresholds(cSpec.vIH, cSpec.vIL);
    return element;
  };
}
