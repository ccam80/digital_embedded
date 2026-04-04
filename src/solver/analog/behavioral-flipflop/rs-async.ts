/**
 * Behavioral analog factory for level-sensitive RS latches (no clock).
 */

import type { SparseSolver } from "../sparse-solver.js";
import type { AnalogElementCore, IntegrationMethod } from "../element.js";
import { readMnaVoltage, delegatePinSetParam } from "../digital-pin-model.js";
import type { DigitalInputPinModel, DigitalOutputPinModel } from "../digital-pin-model.js";
import type { AnalogElementFactory } from "../behavioral-gate.js";
import type { Diagnostic } from "../../../compile/types.js";
import { makeDiagnostic } from "../diagnostics.js";
import { FALLBACK_SPEC, getPinSpecs, makeInputPin, makeOutputPin } from "./shared.js";

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

  private _solver: SparseSolver | null = null;
  private _cachedVoltages: Float64Array = new Float64Array(0);

  private _diagnostics: Diagnostic[] = [];

  private readonly _pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>;

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
    _vIH: number,
    _vIL: number,
    pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>,
  ) {
    this._sPin = sPin;
    this._rPin = rPin;
    this._qPin = qPin;
    this._qBarPin = qBarPin;
    this._pinModelsByLabel = pinModelsByLabel;
  }

  setParam(key: string, value: number): void {
    delegatePinSetParam(this._pinModelsByLabel, key, value);
  }

  getDiagnostics(): Diagnostic[] {
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
    this._qPin.stampOutput(solver);
    this._qBarPin.stampOutput(solver);
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

    const pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>([
      ["S", sPin],
      ["R", rPin],
      ["Q", qPin],
      ["~Q", qBarPin],
    ]);

    return new BehavioralRSAsyncLatchElement(
      sPin, rPin, qPin, qBarPin,
      sSpec.vIH, sSpec.vIL, pinModelsByLabel,
    );
  };
}
