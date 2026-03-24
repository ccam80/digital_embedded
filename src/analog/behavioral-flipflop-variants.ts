/**
 * Behavioral analog factories for JK, RS, and T flip-flops.
 *
 * Each factory produces a BehavioralFlipflopElement subclass with the
 * appropriate logic evaluated in updateCompanion() — once per accepted
 * timestep, not per NR iteration.
 *
 * Pin node-ID ordering follows each component's pin declarations:
 *
 *   JK:       nodeIds[0]=J,   nodeIds[1]=C,   nodeIds[2]=K,   nodeIds[3]=Q, nodeIds[4]=~Q
 *   RS:       nodeIds[0]=S,   nodeIds[1]=C,   nodeIds[2]=R,   nodeIds[3]=Q, nodeIds[4]=~Q
 *   T (enable): nodeIds[0]=T, nodeIds[1]=C,                   nodeIds[2]=Q, nodeIds[3]=~Q
 *   T (no-enable): nodeIds[0]=C,                              nodeIds[1]=Q, nodeIds[2]=~Q
 *   JK-Async: nodeIds[0]=Set, nodeIds[1]=J,   nodeIds[2]=C,   nodeIds[3]=K, nodeIds[4]=Clr, nodeIds[5]=Q, nodeIds[6]=~Q
 *   RS-Async (latch): nodeIds[0]=S, nodeIds[1]=R,             nodeIds[2]=Q, nodeIds[3]=~Q
 *   D-Async:  nodeIds[0]=Set, nodeIds[1]=D,   nodeIds[2]=C,   nodeIds[3]=Clr, nodeIds[4]=Q, nodeIds[5]=~Q
 */

import type { SparseSolver } from "./sparse-solver.js";
import type { AnalogElement, AnalogElementCore, IntegrationMethod } from "./element.js";
import type { PropertyBag } from "../core/properties.js";
import type { ResolvedPinElectrical } from "../core/pin-electrical.js";
import {
  DigitalInputPinModel,
  DigitalOutputPinModel,
  readMnaVoltage,
} from "./digital-pin-model.js";
import type { AnalogElementFactory } from "./behavioral-gate.js";
import { makeDiagnostic } from "./diagnostics.js";
import type { SolverDiagnostic } from "../core/analog-engine-interface.js";

// ---------------------------------------------------------------------------
// Default electrical spec (CMOS 3.3 V)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// BehavioralJKFlipflopElement
// ---------------------------------------------------------------------------

/**
 * Analog behavioral model for an edge-triggered JK flip-flop.
 *
 * On rising clock edge:
 *   J=0, K=0 → hold
 *   J=1, K=0 → set (Q=1)
 *   J=0, K=1 → reset (Q=0)
 *   J=1, K=1 → toggle (Q=~Q)
 */
export class BehavioralJKFlipflopElement implements AnalogElementCore {
  private readonly _jPin: DigitalInputPinModel;
  private readonly _clockPin: DigitalInputPinModel;
  private readonly _kPin: DigitalInputPinModel;
  private readonly _qPin: DigitalOutputPinModel;
  private readonly _qBarPin: DigitalOutputPinModel;

  private _latchedQ = false;
  private _prevClockVoltage = 0;
  private readonly _vIH: number;
  private readonly _vIL: number;

  private _solver: SparseSolver | null = null;
  private _cachedVoltages: Float64Array = new Float64Array(0);

  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: true = true;
  readonly isReactive: true = true;
  label?: string;

  constructor(
    jPin: DigitalInputPinModel,
    clockPin: DigitalInputPinModel,
    kPin: DigitalInputPinModel,
    qPin: DigitalOutputPinModel,
    qBarPin: DigitalOutputPinModel,
    vIH: number,
    vIL: number,
  ) {
    this._jPin = jPin;
    this._clockPin = clockPin;
    this._kPin = kPin;
    this._qPin = qPin;
    this._qBarPin = qBarPin;
    this._vIH = vIH;
    this._vIL = vIL;
  }

  stamp(solver: SparseSolver): void {
    this._solver = solver;
    this._jPin.stamp(solver);
    this._clockPin.stamp(solver);
    this._kPin.stamp(solver);
  }

  stampNonlinear(solver: SparseSolver): void {
    this._solver = solver;
    this._qPin.setLogicLevel(this._latchedQ);
    this._qBarPin.setLogicLevel(!this._latchedQ);
    this._qPin.stamp(solver);
    this._qBarPin.stamp(solver);
  }

  updateOperatingPoint(voltages: Float64Array): void {
    if (this._cachedVoltages.length !== voltages.length) {
      this._cachedVoltages = new Float64Array(voltages.length);
    }
    this._cachedVoltages.set(voltages);
  }

  stampCompanion(dt: number, method: IntegrationMethod, _voltages: Float64Array): void {
    const solver = this._solver;
    if (solver === null) return;
    this._jPin.stampCompanion(solver, dt, method);
    this._clockPin.stampCompanion(solver, dt, method);
    this._kPin.stampCompanion(solver, dt, method);
    this._qPin.stampCompanion(solver, dt, method);
    this._qBarPin.stampCompanion(solver, dt, method);
  }

  updateCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    const currentClockV = readMnaVoltage(this._clockPin.nodeId, voltages);

    const risingEdge =
      this._prevClockVoltage < this._vIH && currentClockV >= this._vIH;

    if (risingEdge) {
      const jV = readMnaVoltage(this._jPin.nodeId, voltages);
      const kV = readMnaVoltage(this._kPin.nodeId, voltages);

      const jLevel = this._jPin.readLogicLevel(jV);
      const kLevel = this._kPin.readLogicLevel(kV);

      if (jLevel !== undefined && kLevel !== undefined) {
        if (jLevel && kLevel) {
          this._latchedQ = !this._latchedQ;
        } else if (jLevel) {
          this._latchedQ = true;
        } else if (kLevel) {
          this._latchedQ = false;
        }
      }
    }

    this._prevClockVoltage = currentClockV;

    this._jPin.updateCompanion(dt, method, readMnaVoltage(this._jPin.nodeId, voltages));
    this._clockPin.updateCompanion(dt, method, currentClockV);
    this._kPin.updateCompanion(dt, method, readMnaVoltage(this._kPin.nodeId, voltages));
    this._qPin.updateCompanion(dt, method, readMnaVoltage(this._qPin.nodeId, voltages));
    this._qBarPin.updateCompanion(dt, method, readMnaVoltage(this._qBarPin.nodeId, voltages));
  }

  getPinCurrents(voltages: Float64Array): number[] {
    // pinLayout order: J, C, K, Q, ~Q
    const vJ = readMnaVoltage(this._jPin.nodeId, voltages);
    const vC = readMnaVoltage(this._clockPin.nodeId, voltages);
    const vK = readMnaVoltage(this._kPin.nodeId, voltages);
    const vQ = readMnaVoltage(this._qPin.nodeId, voltages);
    const vQBar = readMnaVoltage(this._qBarPin.nodeId, voltages);
    return [
      vJ / this._jPin.rIn,
      vC / this._clockPin.rIn,
      vK / this._kPin.rIn,
      (vQ - this._qPin.currentVoltage) / this._qPin.rOut,
      (vQBar - this._qBarPin.currentVoltage) / this._qBarPin.rOut,
    ];
  }

  updateState(_dt: number, _voltages: Float64Array): void {
    // intentionally empty
  }
}

// ---------------------------------------------------------------------------
// BehavioralRSFlipflopElement
// ---------------------------------------------------------------------------

/**
 * Analog behavioral model for an edge-triggered RS flip-flop.
 *
 * On rising clock edge:
 *   S=0, R=0 → hold
 *   S=1, R=0 → set (Q=1)
 *   S=0, R=1 → reset (Q=0)
 *   S=1, R=1 → forbidden: hold previous value, emit rs-flipflop-both-set diagnostic
 */
export class BehavioralRSFlipflopElement implements AnalogElementCore {
  private readonly _sPin: DigitalInputPinModel;
  private readonly _clockPin: DigitalInputPinModel;
  private readonly _rPin: DigitalInputPinModel;
  private readonly _qPin: DigitalOutputPinModel;
  private readonly _qBarPin: DigitalOutputPinModel;

  private _latchedQ = false;
  private _prevClockVoltage = 0;
  private readonly _vIH: number;
  private readonly _vIL: number;

  private _solver: SparseSolver | null = null;
  private _cachedVoltages: Float64Array = new Float64Array(0);

  /** Collected diagnostics — read by tests via getDiagnostics(). */
  private _diagnostics: SolverDiagnostic[] = [];

  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: true = true;
  readonly isReactive: true = true;
  label?: string;

  constructor(
    sPin: DigitalInputPinModel,
    clockPin: DigitalInputPinModel,
    rPin: DigitalInputPinModel,
    qPin: DigitalOutputPinModel,
    qBarPin: DigitalOutputPinModel,
    vIH: number,
    vIL: number,
  ) {
    this._sPin = sPin;
    this._clockPin = clockPin;
    this._rPin = rPin;
    this._qPin = qPin;
    this._qBarPin = qBarPin;
    this._vIH = vIH;
    this._vIL = vIL;
  }

  getDiagnostics(): SolverDiagnostic[] {
    return this._diagnostics;
  }

  stamp(solver: SparseSolver): void {
    this._solver = solver;
    this._sPin.stamp(solver);
    this._clockPin.stamp(solver);
    this._rPin.stamp(solver);
  }

  stampNonlinear(solver: SparseSolver): void {
    this._solver = solver;
    this._qPin.setLogicLevel(this._latchedQ);
    this._qBarPin.setLogicLevel(!this._latchedQ);
    this._qPin.stamp(solver);
    this._qBarPin.stamp(solver);
  }

  updateOperatingPoint(voltages: Float64Array): void {
    if (this._cachedVoltages.length !== voltages.length) {
      this._cachedVoltages = new Float64Array(voltages.length);
    }
    this._cachedVoltages.set(voltages);
  }

  stampCompanion(dt: number, method: IntegrationMethod, _voltages: Float64Array): void {
    const solver = this._solver;
    if (solver === null) return;
    this._sPin.stampCompanion(solver, dt, method);
    this._clockPin.stampCompanion(solver, dt, method);
    this._rPin.stampCompanion(solver, dt, method);
    this._qPin.stampCompanion(solver, dt, method);
    this._qBarPin.stampCompanion(solver, dt, method);
  }

  updateCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    const currentClockV = readMnaVoltage(this._clockPin.nodeId, voltages);

    const risingEdge =
      this._prevClockVoltage < this._vIH && currentClockV >= this._vIH;

    if (risingEdge) {
      const sV = readMnaVoltage(this._sPin.nodeId, voltages);
      const rV = readMnaVoltage(this._rPin.nodeId, voltages);

      const sLevel = this._sPin.readLogicLevel(sV);
      const rLevel = this._rPin.readLogicLevel(rV);

      if (sLevel !== undefined && rLevel !== undefined) {
        if (sLevel && rLevel) {
          // Forbidden state: hold previous value, emit diagnostic
          this._diagnostics.push(
            makeDiagnostic(
              "rs-flipflop-both-set",
              "warning",
              "RS flip-flop: both S and R are HIGH on clock edge (forbidden state)",
              {
                explanation:
                  "Setting both S (Set) and R (Reset) HIGH simultaneously on a clock edge is a " +
                  "forbidden input combination for an RS flip-flop. The output is undefined in " +
                  "real hardware. This implementation holds the previous Q value.",
              },
            ),
          );
        } else if (sLevel) {
          this._latchedQ = true;
        } else if (rLevel) {
          this._latchedQ = false;
        }
      }
    }

    this._prevClockVoltage = currentClockV;

    this._sPin.updateCompanion(dt, method, readMnaVoltage(this._sPin.nodeId, voltages));
    this._clockPin.updateCompanion(dt, method, currentClockV);
    this._rPin.updateCompanion(dt, method, readMnaVoltage(this._rPin.nodeId, voltages));
    this._qPin.updateCompanion(dt, method, readMnaVoltage(this._qPin.nodeId, voltages));
    this._qBarPin.updateCompanion(dt, method, readMnaVoltage(this._qBarPin.nodeId, voltages));
  }

  getPinCurrents(voltages: Float64Array): number[] {
    // pinLayout order: S, C, R, Q, ~Q
    const vS = readMnaVoltage(this._sPin.nodeId, voltages);
    const vC = readMnaVoltage(this._clockPin.nodeId, voltages);
    const vR = readMnaVoltage(this._rPin.nodeId, voltages);
    const vQ = readMnaVoltage(this._qPin.nodeId, voltages);
    const vQBar = readMnaVoltage(this._qBarPin.nodeId, voltages);
    return [
      vS / this._sPin.rIn,
      vC / this._clockPin.rIn,
      vR / this._rPin.rIn,
      (vQ - this._qPin.currentVoltage) / this._qPin.rOut,
      (vQBar - this._qBarPin.currentVoltage) / this._qBarPin.rOut,
    ];
  }

  updateState(_dt: number, _voltages: Float64Array): void {
    // intentionally empty
  }
}

// ---------------------------------------------------------------------------
// BehavioralTFlipflopElement
// ---------------------------------------------------------------------------

/**
 * Analog behavioral model for an edge-triggered T flip-flop.
 *
 * With T enable input (withEnable=true):
 *   T=1 → toggle Q on rising clock edge
 *   T=0 → hold Q on rising clock edge
 *
 * Without T enable input (withEnable=false):
 *   Toggle Q on every rising clock edge.
 */
export class BehavioralTFlipflopElement implements AnalogElementCore {
  private readonly _tPin: DigitalInputPinModel | null;
  private readonly _clockPin: DigitalInputPinModel;
  private readonly _qPin: DigitalOutputPinModel;
  private readonly _qBarPin: DigitalOutputPinModel;

  private _latchedQ = false;
  private _prevClockVoltage = 0;
  private readonly _vIH: number;
  private readonly _vIL: number;

  private _solver: SparseSolver | null = null;
  private _cachedVoltages: Float64Array = new Float64Array(0);

  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: true = true;
  readonly isReactive: true = true;
  label?: string;

  constructor(
    tPin: DigitalInputPinModel | null,
    clockPin: DigitalInputPinModel,
    qPin: DigitalOutputPinModel,
    qBarPin: DigitalOutputPinModel,
    vIH: number,
    vIL: number,
  ) {
    this._tPin = tPin;
    this._clockPin = clockPin;
    this._qPin = qPin;
    this._qBarPin = qBarPin;
    this._vIH = vIH;
    this._vIL = vIL;

  }

  stamp(solver: SparseSolver): void {
    this._solver = solver;
    if (this._tPin !== null) this._tPin.stamp(solver);
    this._clockPin.stamp(solver);
  }

  stampNonlinear(solver: SparseSolver): void {
    this._solver = solver;
    this._qPin.setLogicLevel(this._latchedQ);
    this._qBarPin.setLogicLevel(!this._latchedQ);
    this._qPin.stamp(solver);
    this._qBarPin.stamp(solver);
  }

  updateOperatingPoint(voltages: Float64Array): void {
    if (this._cachedVoltages.length !== voltages.length) {
      this._cachedVoltages = new Float64Array(voltages.length);
    }
    this._cachedVoltages.set(voltages);
  }

  stampCompanion(dt: number, method: IntegrationMethod, _voltages: Float64Array): void {
    const solver = this._solver;
    if (solver === null) return;
    if (this._tPin !== null) this._tPin.stampCompanion(solver, dt, method);
    this._clockPin.stampCompanion(solver, dt, method);
    this._qPin.stampCompanion(solver, dt, method);
    this._qBarPin.stampCompanion(solver, dt, method);
  }

  updateCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    const currentClockV = readMnaVoltage(this._clockPin.nodeId, voltages);

    const risingEdge =
      this._prevClockVoltage < this._vIH && currentClockV >= this._vIH;

    if (risingEdge) {
      if (this._tPin === null) {
        // No T enable — always toggle
        this._latchedQ = !this._latchedQ;
      } else {
        const tV = readMnaVoltage(this._tPin.nodeId, voltages);
        const tLevel = this._tPin.readLogicLevel(tV);
        if (tLevel === true) {
          this._latchedQ = !this._latchedQ;
        }
      }
    }

    this._prevClockVoltage = currentClockV;

    if (this._tPin !== null) {
      this._tPin.updateCompanion(dt, method, readMnaVoltage(this._tPin.nodeId, voltages));
    }
    this._clockPin.updateCompanion(dt, method, currentClockV);
    this._qPin.updateCompanion(dt, method, readMnaVoltage(this._qPin.nodeId, voltages));
    this._qBarPin.updateCompanion(dt, method, readMnaVoltage(this._qBarPin.nodeId, voltages));
  }

  getPinCurrents(voltages: Float64Array): number[] {
    // pinLayout order: T (optional), C, Q, ~Q
    const result: number[] = [];
    if (this._tPin !== null) {
      result.push(readMnaVoltage(this._tPin.nodeId, voltages) / this._tPin.rIn);
    }
    result.push(readMnaVoltage(this._clockPin.nodeId, voltages) / this._clockPin.rIn);
    const vQ = readMnaVoltage(this._qPin.nodeId, voltages);
    const vQBar = readMnaVoltage(this._qBarPin.nodeId, voltages);
    result.push((vQ - this._qPin.currentVoltage) / this._qPin.rOut);
    result.push((vQBar - this._qBarPin.currentVoltage) / this._qBarPin.rOut);
    return result;
  }

  updateState(_dt: number, _voltages: Float64Array): void {
    // intentionally empty
  }
}

// ---------------------------------------------------------------------------
// BehavioralJKAsyncFlipflopElement
// ---------------------------------------------------------------------------

/**
 * Analog behavioral model for a JK flip-flop with async Set/Clear.
 *
 * Pin layout: Set=0, J=1, C=2, K=3, Clr=4, Q=5, ~Q=6
 * Async Set (active-high) overrides clock, forces Q=1.
 * Async Clr (active-high) overrides clock, forces Q=0.
 */
export class BehavioralJKAsyncFlipflopElement implements AnalogElementCore {
  private readonly _setPin: DigitalInputPinModel;
  private readonly _jPin: DigitalInputPinModel;
  private readonly _clockPin: DigitalInputPinModel;
  private readonly _kPin: DigitalInputPinModel;
  private readonly _clrPin: DigitalInputPinModel;
  private readonly _qPin: DigitalOutputPinModel;
  private readonly _qBarPin: DigitalOutputPinModel;

  private _latchedQ = false;
  private _prevClockVoltage = 0;
  private readonly _vIH: number;
  private readonly _vIL: number;

  private _solver: SparseSolver | null = null;
  private _cachedVoltages: Float64Array = new Float64Array(0);

  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: true = true;
  readonly isReactive: true = true;
  label?: string;

  constructor(
    setPin: DigitalInputPinModel,
    jPin: DigitalInputPinModel,
    clockPin: DigitalInputPinModel,
    kPin: DigitalInputPinModel,
    clrPin: DigitalInputPinModel,
    qPin: DigitalOutputPinModel,
    qBarPin: DigitalOutputPinModel,
    vIH: number,
    vIL: number,
  ) {
    this._setPin = setPin;
    this._jPin = jPin;
    this._clockPin = clockPin;
    this._kPin = kPin;
    this._clrPin = clrPin;
    this._qPin = qPin;
    this._qBarPin = qBarPin;
    this._vIH = vIH;
    this._vIL = vIL;

  }

  stamp(solver: SparseSolver): void {
    this._solver = solver;
    this._setPin.stamp(solver);
    this._jPin.stamp(solver);
    this._clockPin.stamp(solver);
    this._kPin.stamp(solver);
    this._clrPin.stamp(solver);
  }

  stampNonlinear(solver: SparseSolver): void {
    this._solver = solver;
    this._qPin.setLogicLevel(this._latchedQ);
    this._qBarPin.setLogicLevel(!this._latchedQ);
    this._qPin.stamp(solver);
    this._qBarPin.stamp(solver);
  }

  updateOperatingPoint(voltages: Float64Array): void {
    if (this._cachedVoltages.length !== voltages.length) {
      this._cachedVoltages = new Float64Array(voltages.length);
    }
    this._cachedVoltages.set(voltages);
  }

  stampCompanion(dt: number, method: IntegrationMethod, _voltages: Float64Array): void {
    const solver = this._solver;
    if (solver === null) return;
    this._setPin.stampCompanion(solver, dt, method);
    this._jPin.stampCompanion(solver, dt, method);
    this._clockPin.stampCompanion(solver, dt, method);
    this._kPin.stampCompanion(solver, dt, method);
    this._clrPin.stampCompanion(solver, dt, method);
    this._qPin.stampCompanion(solver, dt, method);
    this._qBarPin.stampCompanion(solver, dt, method);
  }

  updateCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    const currentClockV = readMnaVoltage(this._clockPin.nodeId, voltages);

    const risingEdge =
      this._prevClockVoltage < this._vIH && currentClockV >= this._vIH;

    if (risingEdge) {
      const jV = readMnaVoltage(this._jPin.nodeId, voltages);
      const kV = readMnaVoltage(this._kPin.nodeId, voltages);
      const jLevel = this._jPin.readLogicLevel(jV);
      const kLevel = this._kPin.readLogicLevel(kV);

      if (jLevel !== undefined && kLevel !== undefined) {
        if (jLevel && kLevel) {
          this._latchedQ = !this._latchedQ;
        } else if (jLevel) {
          this._latchedQ = true;
        } else if (kLevel) {
          this._latchedQ = false;
        }
      }
    }

    // Async Set/Clr override clock-triggered state
    const setV = readMnaVoltage(this._setPin.nodeId, voltages);
    if (setV > this._vIH) {
      this._latchedQ = true;
    }

    const clrV = readMnaVoltage(this._clrPin.nodeId, voltages);
    if (clrV > this._vIH) {
      this._latchedQ = false;
    }

    this._prevClockVoltage = currentClockV;

    this._setPin.updateCompanion(dt, method, setV);
    this._jPin.updateCompanion(dt, method, readMnaVoltage(this._jPin.nodeId, voltages));
    this._clockPin.updateCompanion(dt, method, currentClockV);
    this._kPin.updateCompanion(dt, method, readMnaVoltage(this._kPin.nodeId, voltages));
    this._clrPin.updateCompanion(dt, method, clrV);
    this._qPin.updateCompanion(dt, method, readMnaVoltage(this._qPin.nodeId, voltages));
    this._qBarPin.updateCompanion(dt, method, readMnaVoltage(this._qBarPin.nodeId, voltages));
  }

  getPinCurrents(voltages: Float64Array): number[] {
    // pinLayout order: Set, J, C, K, Clr, Q, ~Q
    const vSet = readMnaVoltage(this._setPin.nodeId, voltages);
    const vJ = readMnaVoltage(this._jPin.nodeId, voltages);
    const vC = readMnaVoltage(this._clockPin.nodeId, voltages);
    const vK = readMnaVoltage(this._kPin.nodeId, voltages);
    const vClr = readMnaVoltage(this._clrPin.nodeId, voltages);
    const vQ = readMnaVoltage(this._qPin.nodeId, voltages);
    const vQBar = readMnaVoltage(this._qBarPin.nodeId, voltages);
    return [
      vSet / this._setPin.rIn,
      vJ / this._jPin.rIn,
      vC / this._clockPin.rIn,
      vK / this._kPin.rIn,
      vClr / this._clrPin.rIn,
      (vQ - this._qPin.currentVoltage) / this._qPin.rOut,
      (vQBar - this._qBarPin.currentVoltage) / this._qBarPin.rOut,
    ];
  }

  updateState(_dt: number, _voltages: Float64Array): void {
    // intentionally empty
  }
}

// ---------------------------------------------------------------------------
// BehavioralRSAsyncLatchElement (level-sensitive SR latch, no clock)
// ---------------------------------------------------------------------------

/**
 * Analog behavioral model for a level-sensitive RS latch (no clock).
 *
 * Pin layout: S=0, R=1, Q=2, ~Q=3
 * Responds immediately to S/R input levels on each accepted timestep.
 * S=1, R=1 → forbidden: hold previous, emit diagnostic
 */
export class BehavioralRSAsyncLatchElement implements AnalogElementCore {
  private readonly _sPin: DigitalInputPinModel;
  private readonly _rPin: DigitalInputPinModel;
  private readonly _qPin: DigitalOutputPinModel;
  private readonly _qBarPin: DigitalOutputPinModel;

  private _latchedQ = false;
  private readonly _vIH: number;
  private readonly _vIL: number;

  private _solver: SparseSolver | null = null;
  private _cachedVoltages: Float64Array = new Float64Array(0);

  private _diagnostics: SolverDiagnostic[] = [];

  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: true = true;
  readonly isReactive: true = true;
  label?: string;

  constructor(
    sPin: DigitalInputPinModel,
    rPin: DigitalInputPinModel,
    qPin: DigitalOutputPinModel,
    qBarPin: DigitalOutputPinModel,
    vIH: number,
    vIL: number,
  ) {
    this._sPin = sPin;
    this._rPin = rPin;
    this._qPin = qPin;
    this._qBarPin = qBarPin;
    this._vIH = vIH;
    this._vIL = vIL;

  }

  getDiagnostics(): SolverDiagnostic[] {
    return this._diagnostics;
  }

  stamp(solver: SparseSolver): void {
    this._solver = solver;
    this._sPin.stamp(solver);
    this._rPin.stamp(solver);
  }

  stampNonlinear(solver: SparseSolver): void {
    this._solver = solver;
    this._qPin.setLogicLevel(this._latchedQ);
    this._qBarPin.setLogicLevel(!this._latchedQ);
    this._qPin.stamp(solver);
    this._qBarPin.stamp(solver);
  }

  updateOperatingPoint(voltages: Float64Array): void {
    if (this._cachedVoltages.length !== voltages.length) {
      this._cachedVoltages = new Float64Array(voltages.length);
    }
    this._cachedVoltages.set(voltages);
  }

  stampCompanion(dt: number, method: IntegrationMethod, _voltages: Float64Array): void {
    const solver = this._solver;
    if (solver === null) return;
    this._sPin.stampCompanion(solver, dt, method);
    this._rPin.stampCompanion(solver, dt, method);
    this._qPin.stampCompanion(solver, dt, method);
    this._qBarPin.stampCompanion(solver, dt, method);
  }

  updateCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    const sV = readMnaVoltage(this._sPin.nodeId, voltages);
    const rV = readMnaVoltage(this._rPin.nodeId, voltages);

    const sLevel = this._sPin.readLogicLevel(sV);
    const rLevel = this._rPin.readLogicLevel(rV);

    if (sLevel !== undefined && rLevel !== undefined) {
      if (sLevel && rLevel) {
        this._diagnostics.push(
          makeDiagnostic(
            "rs-flipflop-both-set",
            "warning",
            "RS latch: both S and R are HIGH simultaneously (forbidden state)",
            {
              explanation:
                "Setting both S (Set) and R (Reset) HIGH simultaneously is a forbidden " +
                "input combination for an SR latch. The output is undefined in real hardware. " +
                "This implementation holds the previous Q value.",
            },
          ),
        );
      } else if (sLevel) {
        this._latchedQ = true;
      } else if (rLevel) {
        this._latchedQ = false;
      }
    }

    this._sPin.updateCompanion(dt, method, sV);
    this._rPin.updateCompanion(dt, method, rV);
    this._qPin.updateCompanion(dt, method, readMnaVoltage(this._qPin.nodeId, voltages));
    this._qBarPin.updateCompanion(dt, method, readMnaVoltage(this._qBarPin.nodeId, voltages));
  }

  getPinCurrents(voltages: Float64Array): number[] {
    // pinLayout order: S, R, Q, ~Q
    const vS = readMnaVoltage(this._sPin.nodeId, voltages);
    const vR = readMnaVoltage(this._rPin.nodeId, voltages);
    const vQ = readMnaVoltage(this._qPin.nodeId, voltages);
    const vQBar = readMnaVoltage(this._qBarPin.nodeId, voltages);
    return [
      vS / this._sPin.rIn,
      vR / this._rPin.rIn,
      (vQ - this._qPin.currentVoltage) / this._qPin.rOut,
      (vQBar - this._qBarPin.currentVoltage) / this._qBarPin.rOut,
    ];
  }

  updateState(_dt: number, _voltages: Float64Array): void {
    // intentionally empty
  }
}

// ---------------------------------------------------------------------------
// BehavioralDAsyncFlipflopElement
// ---------------------------------------------------------------------------

/**
 * Analog behavioral model for a D flip-flop with async Set/Clear.
 *
 * Pin layout: Set=0, D=1, C=2, Clr=3, Q=4, ~Q=5
 * On rising clock edge: latch D.
 * Async Set (active-high) forces Q=1 immediately.
 * Async Clr (active-high) forces Q=0 immediately.
 */
export class BehavioralDAsyncFlipflopElement implements AnalogElementCore {
  private readonly _setPin: DigitalInputPinModel;
  private readonly _dPin: DigitalInputPinModel;
  private readonly _clockPin: DigitalInputPinModel;
  private readonly _clrPin: DigitalInputPinModel;
  private readonly _qPin: DigitalOutputPinModel;
  private readonly _qBarPin: DigitalOutputPinModel;

  private _latchedQ = false;
  private _prevClockVoltage = 0;
  private readonly _vIH: number;
  private readonly _vIL: number;

  private _solver: SparseSolver | null = null;
  private _cachedVoltages: Float64Array = new Float64Array(0);

  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: true = true;
  readonly isReactive: true = true;
  label?: string;

  constructor(
    setPin: DigitalInputPinModel,
    dPin: DigitalInputPinModel,
    clockPin: DigitalInputPinModel,
    clrPin: DigitalInputPinModel,
    qPin: DigitalOutputPinModel,
    qBarPin: DigitalOutputPinModel,
    vIH: number,
    vIL: number,
  ) {
    this._setPin = setPin;
    this._dPin = dPin;
    this._clockPin = clockPin;
    this._clrPin = clrPin;
    this._qPin = qPin;
    this._qBarPin = qBarPin;
    this._vIH = vIH;
    this._vIL = vIL;

  }

  stamp(solver: SparseSolver): void {
    this._solver = solver;
    this._setPin.stamp(solver);
    this._dPin.stamp(solver);
    this._clockPin.stamp(solver);
    this._clrPin.stamp(solver);
  }

  stampNonlinear(solver: SparseSolver): void {
    this._solver = solver;
    this._qPin.setLogicLevel(this._latchedQ);
    this._qBarPin.setLogicLevel(!this._latchedQ);
    this._qPin.stamp(solver);
    this._qBarPin.stamp(solver);
  }

  updateOperatingPoint(voltages: Float64Array): void {
    if (this._cachedVoltages.length !== voltages.length) {
      this._cachedVoltages = new Float64Array(voltages.length);
    }
    this._cachedVoltages.set(voltages);
  }

  stampCompanion(dt: number, method: IntegrationMethod, _voltages: Float64Array): void {
    const solver = this._solver;
    if (solver === null) return;
    this._setPin.stampCompanion(solver, dt, method);
    this._dPin.stampCompanion(solver, dt, method);
    this._clockPin.stampCompanion(solver, dt, method);
    this._clrPin.stampCompanion(solver, dt, method);
    this._qPin.stampCompanion(solver, dt, method);
    this._qBarPin.stampCompanion(solver, dt, method);
  }

  updateCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    const currentClockV = readMnaVoltage(this._clockPin.nodeId, voltages);

    const risingEdge =
      this._prevClockVoltage < this._vIH && currentClockV >= this._vIH;

    if (risingEdge) {
      const dV = readMnaVoltage(this._dPin.nodeId, voltages);
      const dLevel = this._dPin.readLogicLevel(dV);
      if (dLevel !== undefined) {
        this._latchedQ = dLevel;
      }
    }

    // Async Set/Clr
    const setV = readMnaVoltage(this._setPin.nodeId, voltages);
    if (setV > this._vIH) {
      this._latchedQ = true;
    }

    const clrV = readMnaVoltage(this._clrPin.nodeId, voltages);
    if (clrV > this._vIH) {
      this._latchedQ = false;
    }

    this._prevClockVoltage = currentClockV;

    this._setPin.updateCompanion(dt, method, setV);
    this._dPin.updateCompanion(dt, method, readMnaVoltage(this._dPin.nodeId, voltages));
    this._clockPin.updateCompanion(dt, method, currentClockV);
    this._clrPin.updateCompanion(dt, method, clrV);
    this._qPin.updateCompanion(dt, method, readMnaVoltage(this._qPin.nodeId, voltages));
    this._qBarPin.updateCompanion(dt, method, readMnaVoltage(this._qBarPin.nodeId, voltages));
  }

  getPinCurrents(voltages: Float64Array): number[] {
    // pinLayout order: Set, D, C, Clr, Q, ~Q
    const vSet = readMnaVoltage(this._setPin.nodeId, voltages);
    const vD = readMnaVoltage(this._dPin.nodeId, voltages);
    const vC = readMnaVoltage(this._clockPin.nodeId, voltages);
    const vClr = readMnaVoltage(this._clrPin.nodeId, voltages);
    const vQ = readMnaVoltage(this._qPin.nodeId, voltages);
    const vQBar = readMnaVoltage(this._qBarPin.nodeId, voltages);
    return [
      vSet / this._setPin.rIn,
      vD / this._dPin.rIn,
      vC / this._clockPin.rIn,
      vClr / this._clrPin.rIn,
      (vQ - this._qPin.currentVoltage) / this._qPin.rOut,
      (vQBar - this._qBarPin.currentVoltage) / this._qBarPin.rOut,
    ];
  }

  updateState(_dt: number, _voltages: Float64Array): void {
    // intentionally empty
  }
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function getPinSpecs(props: PropertyBag): Record<string, ResolvedPinElectrical> | undefined {
  return props.has("_pinElectrical")
    ? (props.get("_pinElectrical") as unknown as Record<string, ResolvedPinElectrical>)
    : undefined;
}

function makeInputPin(spec: ResolvedPinElectrical, nodeId: number): DigitalInputPinModel {
  const pin = new DigitalInputPinModel(spec);
  pin.init(nodeId, 0);
  return pin;
}

function makeOutputPin(spec: ResolvedPinElectrical, nodeId: number): DigitalOutputPinModel {
  const pin = new DigitalOutputPinModel(spec);
  pin.init(nodeId, -1);
  return pin;
}

// ---------------------------------------------------------------------------
// makeJKFlipflopAnalogFactory
// ---------------------------------------------------------------------------

/**
 * Returns an analogFactory closure for edge-triggered JK flip-flops.
 *
 * Pin order matches JK_FF_PIN_DECLARATIONS:
 *   nodeIds[0]=J, nodeIds[1]=C, nodeIds[2]=K, nodeIds[3]=Q, nodeIds[4]=~Q
 */
export function makeJKFlipflopAnalogFactory(): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
    const pinSpecs = getPinSpecs(props);
    const jSpec = pinSpecs?.["J"] ?? FALLBACK_SPEC;
    const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
    const kSpec = pinSpecs?.["K"] ?? FALLBACK_SPEC;
    const qSpec = pinSpecs?.["Q"] ?? FALLBACK_SPEC;
    const qBarSpec = pinSpecs?.["~Q"] ?? FALLBACK_SPEC;

    const jPin = makeInputPin(jSpec, pinNodes.get("J") ?? 0);
    const clockPin = makeInputPin(cSpec, pinNodes.get("C") ?? 0);
    const kPin = makeInputPin(kSpec, pinNodes.get("K") ?? 0);
    const qPin = makeOutputPin(qSpec, pinNodes.get("Q") ?? 0);
    const qBarPin = makeOutputPin(qBarSpec, pinNodes.get("~Q") ?? 0);

    return new BehavioralJKFlipflopElement(
      jPin, clockPin, kPin, qPin, qBarPin,
      cSpec.vIH, cSpec.vIL,
    );
  };
}

// ---------------------------------------------------------------------------
// makeRSFlipflopAnalogFactory
// ---------------------------------------------------------------------------

/**
 * Returns an analogFactory closure for edge-triggered RS flip-flops.
 *
 * Pin order matches RS_FF_PIN_DECLARATIONS:
 *   nodeIds[0]=S, nodeIds[1]=C, nodeIds[2]=R, nodeIds[3]=Q, nodeIds[4]=~Q
 */
export function makeRSFlipflopAnalogFactory(): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
    const pinSpecs = getPinSpecs(props);
    const sSpec = pinSpecs?.["S"] ?? FALLBACK_SPEC;
    const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
    const rSpec = pinSpecs?.["R"] ?? FALLBACK_SPEC;
    const qSpec = pinSpecs?.["Q"] ?? FALLBACK_SPEC;
    const qBarSpec = pinSpecs?.["~Q"] ?? FALLBACK_SPEC;

    const sPin = makeInputPin(sSpec, pinNodes.get("S") ?? 0);
    const clockPin = makeInputPin(cSpec, pinNodes.get("C") ?? 0);
    const rPin = makeInputPin(rSpec, pinNodes.get("R") ?? 0);
    const qPin = makeOutputPin(qSpec, pinNodes.get("Q") ?? 0);
    const qBarPin = makeOutputPin(qBarSpec, pinNodes.get("~Q") ?? 0);

    return new BehavioralRSFlipflopElement(
      sPin, clockPin, rPin, qPin, qBarPin,
      cSpec.vIH, cSpec.vIL,
    );
  };
}

// ---------------------------------------------------------------------------
// makeTFlipflopAnalogFactory
// ---------------------------------------------------------------------------

/**
 * Returns an analogFactory closure for edge-triggered T flip-flops.
 *
 * withEnable=true (default, 2 inputs):
 *   nodeIds[0]=T, nodeIds[1]=C, nodeIds[2]=Q, nodeIds[3]=~Q
 *
 * withEnable=false (1 input, toggle on every edge):
 *   nodeIds[0]=C, nodeIds[1]=Q, nodeIds[2]=~Q
 */
export function makeTFlipflopAnalogFactory(): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
    const pinSpecs = getPinSpecs(props);
    const withEnable = props.has("withEnable")
      ? (props.get("withEnable") as boolean)
      : true;

    if (withEnable) {
      const tSpec = pinSpecs?.["T"] ?? FALLBACK_SPEC;
      const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
      const qSpec = pinSpecs?.["Q"] ?? FALLBACK_SPEC;
      const qBarSpec = pinSpecs?.["~Q"] ?? FALLBACK_SPEC;

      const tPin = makeInputPin(tSpec, pinNodes.get("T") ?? 0);
      const clockPin = makeInputPin(cSpec, pinNodes.get("C") ?? 0);
      const qPin = makeOutputPin(qSpec, pinNodes.get("Q") ?? 0);
      const qBarPin = makeOutputPin(qBarSpec, pinNodes.get("~Q") ?? 0);

      return new BehavioralTFlipflopElement(
        tPin, clockPin, qPin, qBarPin,
        cSpec.vIH, cSpec.vIL,
      );
    } else {
      const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
      const qSpec = pinSpecs?.["Q"] ?? FALLBACK_SPEC;
      const qBarSpec = pinSpecs?.["~Q"] ?? FALLBACK_SPEC;

      const clockPin = makeInputPin(cSpec, pinNodes.get("C") ?? 0);
      const qPin = makeOutputPin(qSpec, pinNodes.get("Q") ?? 0);
      const qBarPin = makeOutputPin(qBarSpec, pinNodes.get("~Q") ?? 0);

      return new BehavioralTFlipflopElement(
        null, clockPin, qPin, qBarPin,
        cSpec.vIH, cSpec.vIL,
      );
    }
  };
}

// ---------------------------------------------------------------------------
// makeJKAsyncFlipflopAnalogFactory
// ---------------------------------------------------------------------------

/**
 * Returns an analogFactory closure for JK flip-flops with async Set/Clear.
 *
 * Pin order matches JK_FF_AS_PIN_DECLARATIONS:
 *   nodeIds[0]=Set, nodeIds[1]=J, nodeIds[2]=C, nodeIds[3]=K,
 *   nodeIds[4]=Clr, nodeIds[5]=Q, nodeIds[6]=~Q
 */
export function makeJKAsyncFlipflopAnalogFactory(): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
    const pinSpecs = getPinSpecs(props);
    const setSpec = pinSpecs?.["Set"] ?? FALLBACK_SPEC;
    const jSpec = pinSpecs?.["J"] ?? FALLBACK_SPEC;
    const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
    const kSpec = pinSpecs?.["K"] ?? FALLBACK_SPEC;
    const clrSpec = pinSpecs?.["Clr"] ?? FALLBACK_SPEC;
    const qSpec = pinSpecs?.["Q"] ?? FALLBACK_SPEC;
    const qBarSpec = pinSpecs?.["~Q"] ?? FALLBACK_SPEC;

    const setPin = makeInputPin(setSpec, pinNodes.get("Set") ?? 0);
    const jPin = makeInputPin(jSpec, pinNodes.get("J") ?? 0);
    const clockPin = makeInputPin(cSpec, pinNodes.get("C") ?? 0);
    const kPin = makeInputPin(kSpec, pinNodes.get("K") ?? 0);
    const clrPin = makeInputPin(clrSpec, pinNodes.get("Clr") ?? 0);
    const qPin = makeOutputPin(qSpec, pinNodes.get("Q") ?? 0);
    const qBarPin = makeOutputPin(qBarSpec, pinNodes.get("~Q") ?? 0);

    return new BehavioralJKAsyncFlipflopElement(
      setPin, jPin, clockPin, kPin, clrPin, qPin, qBarPin,
      cSpec.vIH, cSpec.vIL,
    );
  };
}

// ---------------------------------------------------------------------------
// makeRSAsyncLatchAnalogFactory
// ---------------------------------------------------------------------------

/**
 * Returns an analogFactory closure for level-sensitive RS latches (no clock).
 *
 * Pin order matches RS_FF_AS_PIN_DECLARATIONS:
 *   nodeIds[0]=S, nodeIds[1]=R, nodeIds[2]=Q, nodeIds[3]=~Q
 */
export function makeRSAsyncLatchAnalogFactory(): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
    const pinSpecs = getPinSpecs(props);
    const sSpec = pinSpecs?.["S"] ?? FALLBACK_SPEC;
    const rSpec = pinSpecs?.["R"] ?? FALLBACK_SPEC;
    const qSpec = pinSpecs?.["Q"] ?? FALLBACK_SPEC;
    const qBarSpec = pinSpecs?.["~Q"] ?? FALLBACK_SPEC;

    const sPin = makeInputPin(sSpec, pinNodes.get("S") ?? 0);
    const rPin = makeInputPin(rSpec, pinNodes.get("R") ?? 0);
    const qPin = makeOutputPin(qSpec, pinNodes.get("Q") ?? 0);
    const qBarPin = makeOutputPin(qBarSpec, pinNodes.get("~Q") ?? 0);

    return new BehavioralRSAsyncLatchElement(
      sPin, rPin, qPin, qBarPin,
      sSpec.vIH, sSpec.vIL,
    );
  };
}

// ---------------------------------------------------------------------------
// makeDAsyncFlipflopAnalogFactory
// ---------------------------------------------------------------------------

/**
 * Returns an analogFactory closure for D flip-flops with async Set/Clear.
 *
 * Pin order matches D_FF_AS_PIN_DECLARATIONS:
 *   nodeIds[0]=Set, nodeIds[1]=D, nodeIds[2]=C, nodeIds[3]=Clr,
 *   nodeIds[4]=Q, nodeIds[5]=~Q
 */
export function makeDAsyncFlipflopAnalogFactory(): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
    const pinSpecs = getPinSpecs(props);
    const setSpec = pinSpecs?.["Set"] ?? FALLBACK_SPEC;
    const dSpec = pinSpecs?.["D"] ?? FALLBACK_SPEC;
    const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
    const clrSpec = pinSpecs?.["Clr"] ?? FALLBACK_SPEC;
    const qSpec = pinSpecs?.["Q"] ?? FALLBACK_SPEC;
    const qBarSpec = pinSpecs?.["~Q"] ?? FALLBACK_SPEC;

    const setPin = makeInputPin(setSpec, pinNodes.get("Set") ?? 0);
    const dPin = makeInputPin(dSpec, pinNodes.get("D") ?? 0);
    const clockPin = makeInputPin(cSpec, pinNodes.get("C") ?? 0);
    const clrPin = makeInputPin(clrSpec, pinNodes.get("Clr") ?? 0);
    const qPin = makeOutputPin(qSpec, pinNodes.get("Q") ?? 0);
    const qBarPin = makeOutputPin(qBarSpec, pinNodes.get("~Q") ?? 0);

    return new BehavioralDAsyncFlipflopElement(
      setPin, dPin, clockPin, clrPin, qPin, qBarPin,
      cSpec.vIH, cSpec.vIL,
    );
  };
}
