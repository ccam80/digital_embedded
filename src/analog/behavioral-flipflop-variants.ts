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
import type { AnalogElement, IntegrationMethod } from "./element.js";
import type { PropertyBag } from "../core/properties.js";
import type { ResolvedPinElectrical } from "../core/pin-electrical.js";
import {
  DigitalInputPinModel,
  DigitalOutputPinModel,
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
export class BehavioralJKFlipflopElement implements AnalogElement {
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

  readonly nodeIndices: readonly number[];
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

    this.nodeIndices = [
      jPin.nodeId,
      clockPin.nodeId,
      kPin.nodeId,
      qPin.nodeId,
      qBarPin.nodeId,
    ];
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
    const clockNodeId = this._clockPin.nodeId;
    const currentClockV = clockNodeId < voltages.length ? voltages[clockNodeId] : 0;

    const risingEdge =
      this._prevClockVoltage < this._vIH && currentClockV >= this._vIH;

    if (risingEdge) {
      const jNodeId = this._jPin.nodeId;
      const kNodeId = this._kPin.nodeId;
      const jV = jNodeId < voltages.length ? voltages[jNodeId] : 0;
      const kV = kNodeId < voltages.length ? voltages[kNodeId] : 0;

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

    const jNodeId = this._jPin.nodeId;
    const jV = jNodeId < voltages.length ? voltages[jNodeId] : 0;
    this._jPin.updateCompanion(dt, method, jV);
    this._clockPin.updateCompanion(dt, method, currentClockV);
    const kNodeId = this._kPin.nodeId;
    const kV = kNodeId < voltages.length ? voltages[kNodeId] : 0;
    this._kPin.updateCompanion(dt, method, kV);

    const qNodeId = this._qPin.nodeId;
    const qV = qNodeId < voltages.length ? voltages[qNodeId] : 0;
    this._qPin.updateCompanion(dt, method, qV);

    const qBarNodeId = this._qBarPin.nodeId;
    const qBarV = qBarNodeId < voltages.length ? voltages[qBarNodeId] : 0;
    this._qBarPin.updateCompanion(dt, method, qBarV);
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
export class BehavioralRSFlipflopElement implements AnalogElement {
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

  readonly nodeIndices: readonly number[];
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

    this.nodeIndices = [
      sPin.nodeId,
      clockPin.nodeId,
      rPin.nodeId,
      qPin.nodeId,
      qBarPin.nodeId,
    ];
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
    const clockNodeId = this._clockPin.nodeId;
    const currentClockV = clockNodeId < voltages.length ? voltages[clockNodeId] : 0;

    const risingEdge =
      this._prevClockVoltage < this._vIH && currentClockV >= this._vIH;

    if (risingEdge) {
      const sNodeId = this._sPin.nodeId;
      const rNodeId = this._rPin.nodeId;
      const sV = sNodeId < voltages.length ? voltages[sNodeId] : 0;
      const rV = rNodeId < voltages.length ? voltages[rNodeId] : 0;

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

    const sNodeId = this._sPin.nodeId;
    const sV = sNodeId < voltages.length ? voltages[sNodeId] : 0;
    this._sPin.updateCompanion(dt, method, sV);
    this._clockPin.updateCompanion(dt, method, currentClockV);
    const rNodeId = this._rPin.nodeId;
    const rV = rNodeId < voltages.length ? voltages[rNodeId] : 0;
    this._rPin.updateCompanion(dt, method, rV);

    const qNodeId = this._qPin.nodeId;
    const qV = qNodeId < voltages.length ? voltages[qNodeId] : 0;
    this._qPin.updateCompanion(dt, method, qV);

    const qBarNodeId = this._qBarPin.nodeId;
    const qBarV = qBarNodeId < voltages.length ? voltages[qBarNodeId] : 0;
    this._qBarPin.updateCompanion(dt, method, qBarV);
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
export class BehavioralTFlipflopElement implements AnalogElement {
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

  readonly nodeIndices: readonly number[];
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

    const indices: number[] = [];
    if (tPin !== null) indices.push(tPin.nodeId);
    indices.push(clockPin.nodeId, qPin.nodeId, qBarPin.nodeId);
    this.nodeIndices = indices;
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
    const clockNodeId = this._clockPin.nodeId;
    const currentClockV = clockNodeId < voltages.length ? voltages[clockNodeId] : 0;

    const risingEdge =
      this._prevClockVoltage < this._vIH && currentClockV >= this._vIH;

    if (risingEdge) {
      if (this._tPin === null) {
        // No T enable — always toggle
        this._latchedQ = !this._latchedQ;
      } else {
        const tNodeId = this._tPin.nodeId;
        const tV = tNodeId < voltages.length ? voltages[tNodeId] : 0;
        const tLevel = this._tPin.readLogicLevel(tV);
        if (tLevel === true) {
          this._latchedQ = !this._latchedQ;
        }
      }
    }

    this._prevClockVoltage = currentClockV;

    if (this._tPin !== null) {
      const tNodeId = this._tPin.nodeId;
      const tV = tNodeId < voltages.length ? voltages[tNodeId] : 0;
      this._tPin.updateCompanion(dt, method, tV);
    }
    this._clockPin.updateCompanion(dt, method, currentClockV);

    const qNodeId = this._qPin.nodeId;
    const qV = qNodeId < voltages.length ? voltages[qNodeId] : 0;
    this._qPin.updateCompanion(dt, method, qV);

    const qBarNodeId = this._qBarPin.nodeId;
    const qBarV = qBarNodeId < voltages.length ? voltages[qBarNodeId] : 0;
    this._qBarPin.updateCompanion(dt, method, qBarV);
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
export class BehavioralJKAsyncFlipflopElement implements AnalogElement {
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

  readonly nodeIndices: readonly number[];
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

    this.nodeIndices = [
      setPin.nodeId,
      jPin.nodeId,
      clockPin.nodeId,
      kPin.nodeId,
      clrPin.nodeId,
      qPin.nodeId,
      qBarPin.nodeId,
    ];
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
    const clockNodeId = this._clockPin.nodeId;
    const currentClockV = clockNodeId < voltages.length ? voltages[clockNodeId] : 0;

    const risingEdge =
      this._prevClockVoltage < this._vIH && currentClockV >= this._vIH;

    if (risingEdge) {
      const jNodeId = this._jPin.nodeId;
      const kNodeId = this._kPin.nodeId;
      const jV = jNodeId < voltages.length ? voltages[jNodeId] : 0;
      const kV = kNodeId < voltages.length ? voltages[kNodeId] : 0;
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
    const setNodeId = this._setPin.nodeId;
    const setV = setNodeId < voltages.length ? voltages[setNodeId] : 0;
    if (setV > this._vIH) {
      this._latchedQ = true;
    }

    const clrNodeId = this._clrPin.nodeId;
    const clrV = clrNodeId < voltages.length ? voltages[clrNodeId] : 0;
    if (clrV > this._vIH) {
      this._latchedQ = false;
    }

    this._prevClockVoltage = currentClockV;

    this._setPin.updateCompanion(dt, method, setV);
    const jNodeId = this._jPin.nodeId;
    const jV = jNodeId < voltages.length ? voltages[jNodeId] : 0;
    this._jPin.updateCompanion(dt, method, jV);
    this._clockPin.updateCompanion(dt, method, currentClockV);
    const kNodeId = this._kPin.nodeId;
    const kV = kNodeId < voltages.length ? voltages[kNodeId] : 0;
    this._kPin.updateCompanion(dt, method, kV);
    this._clrPin.updateCompanion(dt, method, clrV);

    const qNodeId = this._qPin.nodeId;
    const qV = qNodeId < voltages.length ? voltages[qNodeId] : 0;
    this._qPin.updateCompanion(dt, method, qV);

    const qBarNodeId = this._qBarPin.nodeId;
    const qBarV = qBarNodeId < voltages.length ? voltages[qBarNodeId] : 0;
    this._qBarPin.updateCompanion(dt, method, qBarV);
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
export class BehavioralRSAsyncLatchElement implements AnalogElement {
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

  readonly nodeIndices: readonly number[];
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

    this.nodeIndices = [
      sPin.nodeId,
      rPin.nodeId,
      qPin.nodeId,
      qBarPin.nodeId,
    ];
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
    const sNodeId = this._sPin.nodeId;
    const rNodeId = this._rPin.nodeId;
    const sV = sNodeId < voltages.length ? voltages[sNodeId] : 0;
    const rV = rNodeId < voltages.length ? voltages[rNodeId] : 0;

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

    const qNodeId = this._qPin.nodeId;
    const qV = qNodeId < voltages.length ? voltages[qNodeId] : 0;
    this._qPin.updateCompanion(dt, method, qV);

    const qBarNodeId = this._qBarPin.nodeId;
    const qBarV = qBarNodeId < voltages.length ? voltages[qBarNodeId] : 0;
    this._qBarPin.updateCompanion(dt, method, qBarV);
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
export class BehavioralDAsyncFlipflopElement implements AnalogElement {
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

  readonly nodeIndices: readonly number[];
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

    this.nodeIndices = [
      setPin.nodeId,
      dPin.nodeId,
      clockPin.nodeId,
      clrPin.nodeId,
      qPin.nodeId,
      qBarPin.nodeId,
    ];
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
    const clockNodeId = this._clockPin.nodeId;
    const currentClockV = clockNodeId < voltages.length ? voltages[clockNodeId] : 0;

    const risingEdge =
      this._prevClockVoltage < this._vIH && currentClockV >= this._vIH;

    if (risingEdge) {
      const dNodeId = this._dPin.nodeId;
      const dV = dNodeId < voltages.length ? voltages[dNodeId] : 0;
      const dLevel = this._dPin.readLogicLevel(dV);
      if (dLevel !== undefined) {
        this._latchedQ = dLevel;
      }
    }

    // Async Set/Clr
    const setNodeId = this._setPin.nodeId;
    const setV = setNodeId < voltages.length ? voltages[setNodeId] : 0;
    if (setV > this._vIH) {
      this._latchedQ = true;
    }

    const clrNodeId = this._clrPin.nodeId;
    const clrV = clrNodeId < voltages.length ? voltages[clrNodeId] : 0;
    if (clrV > this._vIH) {
      this._latchedQ = false;
    }

    this._prevClockVoltage = currentClockV;

    this._setPin.updateCompanion(dt, method, setV);
    const dNodeId = this._dPin.nodeId;
    const dV = dNodeId < voltages.length ? voltages[dNodeId] : 0;
    this._dPin.updateCompanion(dt, method, dV);
    this._clockPin.updateCompanion(dt, method, currentClockV);
    this._clrPin.updateCompanion(dt, method, clrV);

    const qNodeId = this._qPin.nodeId;
    const qV = qNodeId < voltages.length ? voltages[qNodeId] : 0;
    this._qPin.updateCompanion(dt, method, qV);

    const qBarNodeId = this._qBarPin.nodeId;
    const qBarV = qBarNodeId < voltages.length ? voltages[qBarNodeId] : 0;
    this._qBarPin.updateCompanion(dt, method, qBarV);
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
  return (nodeIds, _branchIdx, props, _getTime) => {
    const pinSpecs = getPinSpecs(props);
    const jSpec = pinSpecs?.["J"] ?? FALLBACK_SPEC;
    const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
    const kSpec = pinSpecs?.["K"] ?? FALLBACK_SPEC;
    const qSpec = pinSpecs?.["Q"] ?? FALLBACK_SPEC;
    const qBarSpec = pinSpecs?.["~Q"] ?? FALLBACK_SPEC;

    const jPin = makeInputPin(jSpec, nodeIds[0]);
    const clockPin = makeInputPin(cSpec, nodeIds[1]);
    const kPin = makeInputPin(kSpec, nodeIds[2]);
    const qPin = makeOutputPin(qSpec, nodeIds[3]);
    const qBarPin = makeOutputPin(qBarSpec, nodeIds[4]);

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
  return (nodeIds, _branchIdx, props, _getTime) => {
    const pinSpecs = getPinSpecs(props);
    const sSpec = pinSpecs?.["S"] ?? FALLBACK_SPEC;
    const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
    const rSpec = pinSpecs?.["R"] ?? FALLBACK_SPEC;
    const qSpec = pinSpecs?.["Q"] ?? FALLBACK_SPEC;
    const qBarSpec = pinSpecs?.["~Q"] ?? FALLBACK_SPEC;

    const sPin = makeInputPin(sSpec, nodeIds[0]);
    const clockPin = makeInputPin(cSpec, nodeIds[1]);
    const rPin = makeInputPin(rSpec, nodeIds[2]);
    const qPin = makeOutputPin(qSpec, nodeIds[3]);
    const qBarPin = makeOutputPin(qBarSpec, nodeIds[4]);

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
  return (nodeIds, _branchIdx, props, _getTime) => {
    const pinSpecs = getPinSpecs(props);
    const withEnable = props.has("withEnable")
      ? (props.get("withEnable") as boolean)
      : true;

    if (withEnable) {
      const tSpec = pinSpecs?.["T"] ?? FALLBACK_SPEC;
      const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
      const qSpec = pinSpecs?.["Q"] ?? FALLBACK_SPEC;
      const qBarSpec = pinSpecs?.["~Q"] ?? FALLBACK_SPEC;

      const tPin = makeInputPin(tSpec, nodeIds[0]);
      const clockPin = makeInputPin(cSpec, nodeIds[1]);
      const qPin = makeOutputPin(qSpec, nodeIds[2]);
      const qBarPin = makeOutputPin(qBarSpec, nodeIds[3]);

      return new BehavioralTFlipflopElement(
        tPin, clockPin, qPin, qBarPin,
        cSpec.vIH, cSpec.vIL,
      );
    } else {
      const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
      const qSpec = pinSpecs?.["Q"] ?? FALLBACK_SPEC;
      const qBarSpec = pinSpecs?.["~Q"] ?? FALLBACK_SPEC;

      const clockPin = makeInputPin(cSpec, nodeIds[0]);
      const qPin = makeOutputPin(qSpec, nodeIds[1]);
      const qBarPin = makeOutputPin(qBarSpec, nodeIds[2]);

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
  return (nodeIds, _branchIdx, props, _getTime) => {
    const pinSpecs = getPinSpecs(props);
    const setSpec = pinSpecs?.["Set"] ?? FALLBACK_SPEC;
    const jSpec = pinSpecs?.["J"] ?? FALLBACK_SPEC;
    const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
    const kSpec = pinSpecs?.["K"] ?? FALLBACK_SPEC;
    const clrSpec = pinSpecs?.["Clr"] ?? FALLBACK_SPEC;
    const qSpec = pinSpecs?.["Q"] ?? FALLBACK_SPEC;
    const qBarSpec = pinSpecs?.["~Q"] ?? FALLBACK_SPEC;

    const setPin = makeInputPin(setSpec, nodeIds[0]);
    const jPin = makeInputPin(jSpec, nodeIds[1]);
    const clockPin = makeInputPin(cSpec, nodeIds[2]);
    const kPin = makeInputPin(kSpec, nodeIds[3]);
    const clrPin = makeInputPin(clrSpec, nodeIds[4]);
    const qPin = makeOutputPin(qSpec, nodeIds[5]);
    const qBarPin = makeOutputPin(qBarSpec, nodeIds[6]);

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
  return (nodeIds, _branchIdx, props, _getTime) => {
    const pinSpecs = getPinSpecs(props);
    const sSpec = pinSpecs?.["S"] ?? FALLBACK_SPEC;
    const rSpec = pinSpecs?.["R"] ?? FALLBACK_SPEC;
    const qSpec = pinSpecs?.["Q"] ?? FALLBACK_SPEC;
    const qBarSpec = pinSpecs?.["~Q"] ?? FALLBACK_SPEC;

    const sPin = makeInputPin(sSpec, nodeIds[0]);
    const rPin = makeInputPin(rSpec, nodeIds[1]);
    const qPin = makeOutputPin(qSpec, nodeIds[2]);
    const qBarPin = makeOutputPin(qBarSpec, nodeIds[3]);

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
  return (nodeIds, _branchIdx, props, _getTime) => {
    const pinSpecs = getPinSpecs(props);
    const setSpec = pinSpecs?.["Set"] ?? FALLBACK_SPEC;
    const dSpec = pinSpecs?.["D"] ?? FALLBACK_SPEC;
    const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
    const clrSpec = pinSpecs?.["Clr"] ?? FALLBACK_SPEC;
    const qSpec = pinSpecs?.["Q"] ?? FALLBACK_SPEC;
    const qBarSpec = pinSpecs?.["~Q"] ?? FALLBACK_SPEC;

    const setPin = makeInputPin(setSpec, nodeIds[0]);
    const dPin = makeInputPin(dSpec, nodeIds[1]);
    const clockPin = makeInputPin(cSpec, nodeIds[2]);
    const clrPin = makeInputPin(clrSpec, nodeIds[3]);
    const qPin = makeOutputPin(qSpec, nodeIds[4]);
    const qBarPin = makeOutputPin(qBarSpec, nodeIds[5]);

    return new BehavioralDAsyncFlipflopElement(
      setPin, dPin, clockPin, clrPin, qPin, qBarPin,
      cSpec.vIH, cSpec.vIL,
    );
  };
}
