/**
 * Behavioral analog factory for JK flip-flops with async Set/Clear.
 */

import type { AnalogElementCore, LoadContext } from "../element.js";
import { readMnaVoltage, delegatePinSetParam } from "../digital-pin-model.js";
import type { DigitalInputPinModel, DigitalOutputPinModel } from "../digital-pin-model.js";
import type { AnalogElementFactory } from "../behavioral-gate.js";
import { FALLBACK_SPEC, getPinSpecs, makeInputPin, makeOutputPin } from "./shared.js";

// ---------------------------------------------------------------------------
// BehavioralJKAsyncFlipflopElement
// ---------------------------------------------------------------------------

/**
 * Analog behavioral model for a JK flip-flop with async Set/Clear.
 *
 * Pin layout: Set=0, J=1, C=2, K=3, Clr=4, Q=5, ~Q=6
 * Async Set (active-high) overrides clock, forces Q=1.
 * Async Clr (active-high) overrides clock, forces Q=0.
 *
 * Unified interface:
 *   load()   — stamps input loading, output Norton equivalents from the
 *              currently latched Q state, and pin-capacitance companions
 *              during transient.
 *   accept() — rising-edge detection, JK latching/toggling, async Set/Clr
 *              overrides, and pin companion state update after each accepted
 *              timestep.
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

  private readonly _pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>;

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
    _vIL: number,
    pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>,
  ) {
    this._setPin = setPin;
    this._jPin = jPin;
    this._clockPin = clockPin;
    this._kPin = kPin;
    this._clrPin = clrPin;
    this._qPin = qPin;
    this._qBarPin = qBarPin;
    this._vIH = vIH;
    this._pinModelsByLabel = pinModelsByLabel;
  }

  setParam(key: string, value: number): void {
    delegatePinSetParam(this._pinModelsByLabel, key, value);
  }

  load(ctx: LoadContext): void {
    const solver = ctx.solver;

    this._setPin.stamp(solver);
    this._jPin.stamp(solver);
    this._clockPin.stamp(solver);
    this._kPin.stamp(solver);
    this._clrPin.stamp(solver);

    this._qPin.setLogicLevel(this._latchedQ);
    this._qBarPin.setLogicLevel(!this._latchedQ);
    this._qPin.stampOutput(solver);
    this._qBarPin.stampOutput(solver);

    if (ctx.isTransient && ctx.dt > 0) {
      this._setPin.stampCompanion(solver, ctx.dt, ctx.method);
      this._jPin.stampCompanion(solver, ctx.dt, ctx.method);
      this._clockPin.stampCompanion(solver, ctx.dt, ctx.method);
      this._kPin.stampCompanion(solver, ctx.dt, ctx.method);
      this._clrPin.stampCompanion(solver, ctx.dt, ctx.method);
      this._qPin.stampCompanion(solver, ctx.dt, ctx.method);
      this._qBarPin.stampCompanion(solver, ctx.dt, ctx.method);
    }
  }

  /**
   * Rising-edge detection, JK latching/toggling, async Set/Clr overrides,
   * and companion state update — called once per accepted timestep with the
   * accepted solution voltages.
   */
  accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
    const voltages = ctx.voltages;
    const dt = ctx.dt;
    const method = ctx.method;

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

    if (dt > 0) {
      this._setPin.updateCompanion(dt, method, setV);
      this._jPin.updateCompanion(dt, method, readMnaVoltage(this._jPin.nodeId, voltages));
      this._clockPin.updateCompanion(dt, method, currentClockV);
      this._kPin.updateCompanion(dt, method, readMnaVoltage(this._kPin.nodeId, voltages));
      this._clrPin.updateCompanion(dt, method, clrV);
      this._qPin.updateCompanion(dt, method, readMnaVoltage(this._qPin.nodeId, voltages));
      this._qBarPin.updateCompanion(dt, method, readMnaVoltage(this._qBarPin.nodeId, voltages));
    }
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

    const pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>([
      ["Set", setPin],
      ["J", jPin],
      ["C", clockPin],
      ["K", kPin],
      ["Clr", clrPin],
      ["Q", qPin],
      ["~Q", qBarPin],
    ]);

    return new BehavioralJKAsyncFlipflopElement(
      setPin, jPin, clockPin, kPin, clrPin, qPin, qBarPin,
      cSpec.vIH, cSpec.vIL, pinModelsByLabel,
    );
  };
}
