/**
 * Behavioral analog factory for edge-triggered RS flip-flops.
 */

import type { AnalogElementCore, LoadContext } from "../element.js";
import { readMnaVoltage, delegatePinSetParam } from "../digital-pin-model.js";
import type { DigitalInputPinModel, DigitalOutputPinModel } from "../digital-pin-model.js";
import type { AnalogElementFactory } from "../behavioral-gate.js";
import type { Diagnostic } from "../../../compile/types.js";
import { makeDiagnostic } from "../diagnostics.js";
import { FALLBACK_SPEC, getPinSpecs, getPinLoading, makeInputPin, makeOutputPin } from "./shared.js";

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
 *
 * Unified interface:
 *   load()   — delegates input/output pin stamping to pin models from the
 *              currently latched Q state.
 *   accept() — rising-edge detection, latching, diagnostic emission, and
 *              pin companion state update after each accepted timestep.
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

  /** Collected diagnostics — read by tests via getDiagnostics(). */
  private _diagnostics: Diagnostic[] = [];

  private readonly _pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>;

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
    _vIL: number,
    pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>,
  ) {
    this._sPin = sPin;
    this._clockPin = clockPin;
    this._rPin = rPin;
    this._qPin = qPin;
    this._qBarPin = qBarPin;
    this._vIH = vIH;
    this._pinModelsByLabel = pinModelsByLabel;
  }

  setParam(key: string, value: number): void {
    delegatePinSetParam(this._pinModelsByLabel, key, value);
  }

  initVoltages(rhs: Float64Array): void {
    this._prevClockVoltage = readMnaVoltage(this._clockPin.nodeId, rhs);
  }

  getDiagnostics(): Diagnostic[] {
    return this._diagnostics;
  }

  load(ctx: LoadContext): void {
    // Delegate input stamping to pin models
    this._sPin.load(ctx);
    this._clockPin.load(ctx);
    this._rPin.load(ctx);

    // Stamp output Norton equivalents from the currently latched Q state.
    // Logic evaluation happens only in accept() to prevent mid-NR latching.
    this._qPin.setLogicLevel(this._latchedQ);
    this._qBarPin.setLogicLevel(!this._latchedQ);
    this._qPin.load(ctx);
    this._qBarPin.load(ctx);
  }

  /**
   * Rising-edge detection, latching, and companion state update — called
   * once per accepted timestep with the accepted solution voltages.
   */
  accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
    const voltages = ctx.voltages;

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

    // Delegate companion updates to pin models.
    this._sPin.accept(ctx, readMnaVoltage(this._sPin.nodeId, voltages));
    this._clockPin.accept(ctx, currentClockV);
    this._rPin.accept(ctx, readMnaVoltage(this._rPin.nodeId, voltages));
    this._qPin.accept(ctx, readMnaVoltage(this._qPin.nodeId, voltages));
    this._qBarPin.accept(ctx, readMnaVoltage(this._qBarPin.nodeId, voltages));
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
    const pinLoading = getPinLoading(props);

    const sSpec = pinSpecs?.["S"] ?? FALLBACK_SPEC;
    const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
    const rSpec = pinSpecs?.["R"] ?? FALLBACK_SPEC;
    const qSpec = pinSpecs?.["Q"] ?? FALLBACK_SPEC;
    const qBarSpec = pinSpecs?.["~Q"] ?? FALLBACK_SPEC;

    const sPin = makeInputPin(sSpec, pinNodes.get("S") ?? 0, pinLoading["S"] ?? true);
    const clockPin = makeInputPin(cSpec, pinNodes.get("C") ?? 0, pinLoading["C"] ?? true);
    const rPin = makeInputPin(rSpec, pinNodes.get("R") ?? 0, pinLoading["R"] ?? true);
    const qPin = makeOutputPin(qSpec, pinNodes.get("Q") ?? 0, pinLoading["Q"] ?? false);
    const qBarPin = makeOutputPin(qBarSpec, pinNodes.get("~Q") ?? 0, pinLoading["~Q"] ?? false);

    const pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>([
      ["S", sPin],
      ["C", clockPin],
      ["R", rPin],
      ["Q", qPin],
      ["~Q", qBarPin],
    ]);

    return new BehavioralRSFlipflopElement(
      sPin, clockPin, rPin, qPin, qBarPin,
      cSpec.vIH, cSpec.vIL, pinModelsByLabel,
    );
  };
}
