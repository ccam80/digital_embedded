/**
 * Behavioral analog factory for D flip-flops with async Set/Clear.
 */

import type { AnalogElementCore, LoadContext } from "../element.js";
import { readMnaVoltage, delegatePinSetParam } from "../digital-pin-model.js";
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
 *
 * Unified interface:
 *   load()   — stamps input loading, output Norton equivalents from the
 *              currently latched Q state, and pin-capacitance companions
 *              during transient.
 *   accept() — rising-edge D latching, async Set/Clr overrides, and pin
 *              companion state update after each accepted timestep.
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

  private readonly _pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>;

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
    _vIL: number,
    pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>,
  ) {
    this._setPin = setPin;
    this._dPin = dPin;
    this._clockPin = clockPin;
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
    this._dPin.stamp(solver);
    this._clockPin.stamp(solver);
    this._clrPin.stamp(solver);

    this._qPin.setLogicLevel(this._latchedQ);
    this._qBarPin.setLogicLevel(!this._latchedQ);
    this._qPin.stampOutput(solver);
    this._qBarPin.stampOutput(solver);

    if (ctx.isTransient && ctx.dt > 0) {
      this._setPin.stampCompanion(solver, ctx.dt, ctx.method);
      this._dPin.stampCompanion(solver, ctx.dt, ctx.method);
      this._clockPin.stampCompanion(solver, ctx.dt, ctx.method);
      this._clrPin.stampCompanion(solver, ctx.dt, ctx.method);
      this._qPin.stampCompanion(solver, ctx.dt, ctx.method);
      this._qBarPin.stampCompanion(solver, ctx.dt, ctx.method);
    }
  }

  /**
   * Rising-edge D latching, async Set/Clr overrides, and companion state
   * update — called once per accepted timestep with the accepted solution
   * voltages.
   */
  accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
    const voltages = ctx.voltages;
    const dt = ctx.dt;
    const method = ctx.method;

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

    if (dt > 0) {
      this._setPin.updateCompanion(dt, method, setV);
      this._dPin.updateCompanion(dt, method, readMnaVoltage(this._dPin.nodeId, voltages));
      this._clockPin.updateCompanion(dt, method, currentClockV);
      this._clrPin.updateCompanion(dt, method, clrV);
      this._qPin.updateCompanion(dt, method, readMnaVoltage(this._qPin.nodeId, voltages));
      this._qBarPin.updateCompanion(dt, method, readMnaVoltage(this._qBarPin.nodeId, voltages));
    }
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

    const pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>([
      ["Set", setPin],
      ["D", dPin],
      ["C", clockPin],
      ["Clr", clrPin],
      ["Q", qPin],
      ["~Q", qBarPin],
    ]);

    return new BehavioralDAsyncFlipflopElement(
      setPin, dPin, clockPin, clrPin, qPin, qBarPin,
      cSpec.vIH, cSpec.vIL, pinModelsByLabel,
    );
  };
}
