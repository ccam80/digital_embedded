/**
 * Behavioral analog factory for edge-triggered JK flip-flops.
 */

import type { AnalogElementCore, LoadContext } from "../element.js";
import { readMnaVoltage, delegatePinSetParam } from "../digital-pin-model.js";
import type { DigitalInputPinModel, DigitalOutputPinModel } from "../digital-pin-model.js";
import type { AnalogElementFactory } from "../behavioral-gate.js";
import { FALLBACK_SPEC, getPinSpecs, makeInputPin, makeOutputPin } from "./shared.js";

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
 *
 * Unified interface:
 *   load()   — stamps input loading, output Norton equivalents from the
 *              currently latched Q state, and pin-capacitance companions
 *              during transient.
 *   accept() — rising-edge detection, JK latching/toggling, and pin
 *              companion state update after each accepted timestep.
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

  private readonly _pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>;

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
    _vIL: number,
    pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>,
  ) {
    this._jPin = jPin;
    this._clockPin = clockPin;
    this._kPin = kPin;
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

    this._jPin.stamp(solver);
    this._clockPin.stamp(solver);
    this._kPin.stamp(solver);

    this._qPin.setLogicLevel(this._latchedQ);
    this._qBarPin.setLogicLevel(!this._latchedQ);
    this._qPin.stampOutput(solver);
    this._qBarPin.stampOutput(solver);

    if (ctx.isTransient && ctx.dt > 0) {
      this._jPin.stampCompanion(solver, ctx.dt, ctx.method);
      this._clockPin.stampCompanion(solver, ctx.dt, ctx.method);
      this._kPin.stampCompanion(solver, ctx.dt, ctx.method);
      this._qPin.stampCompanion(solver, ctx.dt, ctx.method);
      this._qBarPin.stampCompanion(solver, ctx.dt, ctx.method);
    }
  }

  /**
   * Rising-edge detection, JK latching/toggling, and companion state update
   * — called once per accepted timestep with the accepted solution voltages.
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

    this._prevClockVoltage = currentClockV;

    if (dt > 0) {
      this._jPin.updateCompanion(dt, method, readMnaVoltage(this._jPin.nodeId, voltages));
      this._clockPin.updateCompanion(dt, method, currentClockV);
      this._kPin.updateCompanion(dt, method, readMnaVoltage(this._kPin.nodeId, voltages));
      this._qPin.updateCompanion(dt, method, readMnaVoltage(this._qPin.nodeId, voltages));
      this._qBarPin.updateCompanion(dt, method, readMnaVoltage(this._qBarPin.nodeId, voltages));
    }
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

    const pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>([
      ["J", jPin],
      ["C", clockPin],
      ["K", kPin],
      ["Q", qPin],
      ["~Q", qBarPin],
    ]);

    return new BehavioralJKFlipflopElement(
      jPin, clockPin, kPin, qPin, qBarPin,
      cSpec.vIH, cSpec.vIL, pinModelsByLabel,
    );
  };
}
