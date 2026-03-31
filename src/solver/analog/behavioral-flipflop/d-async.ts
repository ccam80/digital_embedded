/**
 * Behavioral analog factory for D flip-flops with async Set/Clear.
 */

import type { SparseSolver } from "../sparse-solver.js";
import type { AnalogElementCore, IntegrationMethod } from "../element.js";
import { readMnaVoltage } from "../digital-pin-model.js";
import type { DigitalInputPinModel, DigitalOutputPinModel } from "../digital-pin-model.js";
import type { AnalogElementFactory } from "../behavioral-gate.js";
import { FALLBACK_SPEC, getPinSpecs, makeInputPin, makeOutputPin } from "./shared.js";

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

  private _solver: SparseSolver | null = null;
  private _cachedVoltages: Float64Array = new Float64Array(0);

  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: true = true;
  readonly isReactive: true = true;
  setParam(_key: string, _value: number): void {}
  label?: string;

  constructor(
    setPin: DigitalInputPinModel,
    dPin: DigitalInputPinModel,
    clockPin: DigitalInputPinModel,
    clrPin: DigitalInputPinModel,
    qPin: DigitalOutputPinModel,
    qBarPin: DigitalOutputPinModel,
    vIH: number,
    _vIL: number,
  ) {
    this._setPin = setPin;
    this._dPin = dPin;
    this._clockPin = clockPin;
    this._clrPin = clrPin;
    this._qPin = qPin;
    this._qBarPin = qBarPin;
    this._vIH = vIH;
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
