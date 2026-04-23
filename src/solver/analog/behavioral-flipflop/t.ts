/**
 * Behavioral analog factory for edge-triggered T flip-flops.
 */

import type { AnalogElementCore, LoadContext } from "../element.js";
import { readMnaVoltage, delegatePinSetParam } from "../digital-pin-model.js";
import type { DigitalInputPinModel, DigitalOutputPinModel } from "../digital-pin-model.js";
import type { AnalogElementFactory } from "../behavioral-gate.js";
import { FALLBACK_SPEC, getPinSpecs, getPinLoading, makeInputPin, makeOutputPin } from "./shared.js";

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
 *
 * Unified interface:
 *   load()   — delegates input/output pin stamping to pin models from the
 *              currently latched Q state.
 *   accept() — rising-edge detection and conditional toggle, plus pin
 *              companion state update after each accepted timestep.
 */
export class BehavioralTFlipflopElement implements AnalogElementCore {
  private readonly _tPin: DigitalInputPinModel | null;
  private readonly _clockPin: DigitalInputPinModel;
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
    tPin: DigitalInputPinModel | null,
    clockPin: DigitalInputPinModel,
    qPin: DigitalOutputPinModel,
    qBarPin: DigitalOutputPinModel,
    vIH: number,
    _vIL: number,
    pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>,
  ) {
    this._tPin = tPin;
    this._clockPin = clockPin;
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

  load(ctx: LoadContext): void {
    // Delegate input stamping to pin models
    if (this._tPin !== null) this._tPin.load(ctx);
    this._clockPin.load(ctx);

    this._qPin.setLogicLevel(this._latchedQ);
    this._qBarPin.setLogicLevel(!this._latchedQ);
    this._qPin.load(ctx);
    this._qBarPin.load(ctx);
  }

  /**
   * Rising-edge detection, conditional toggle, and companion state update —
   * called once per accepted timestep with the accepted solution voltages.
   */
  accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
    const voltages = ctx.rhs;

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

    // Delegate companion updates to pin models.
    if (this._tPin !== null) {
      this._tPin.accept(ctx, readMnaVoltage(this._tPin.nodeId, voltages));
    }
    this._clockPin.accept(ctx, currentClockV);
    this._qPin.accept(ctx, readMnaVoltage(this._qPin.nodeId, voltages));
    this._qBarPin.accept(ctx, readMnaVoltage(this._qBarPin.nodeId, voltages));
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
    const pinLoading = getPinLoading(props);
    const withEnable = props.has("withEnable")
      ? (props.get("withEnable") as boolean)
      : true;

    if (withEnable) {
      const tSpec = pinSpecs?.["T"] ?? FALLBACK_SPEC;
      const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
      const qSpec = pinSpecs?.["Q"] ?? FALLBACK_SPEC;
      const qBarSpec = pinSpecs?.["~Q"] ?? FALLBACK_SPEC;

      const tPin = makeInputPin(tSpec, pinNodes.get("T") ?? 0, pinLoading["T"] ?? true);
      const clockPin = makeInputPin(cSpec, pinNodes.get("C") ?? 0, pinLoading["C"] ?? true);
      const qPin = makeOutputPin(qSpec, pinNodes.get("Q") ?? 0, pinLoading["Q"] ?? false);
      const qBarPin = makeOutputPin(qBarSpec, pinNodes.get("~Q") ?? 0, pinLoading["~Q"] ?? false);

      const pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>([
        ["T", tPin],
        ["C", clockPin],
        ["Q", qPin],
        ["~Q", qBarPin],
      ]);

      return new BehavioralTFlipflopElement(
        tPin, clockPin, qPin, qBarPin,
        cSpec.vIH, cSpec.vIL, pinModelsByLabel,
      );
    } else {
      const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
      const qSpec = pinSpecs?.["Q"] ?? FALLBACK_SPEC;
      const qBarSpec = pinSpecs?.["~Q"] ?? FALLBACK_SPEC;

      const clockPin = makeInputPin(cSpec, pinNodes.get("C") ?? 0, pinLoading["C"] ?? true);
      const qPin = makeOutputPin(qSpec, pinNodes.get("Q") ?? 0, pinLoading["Q"] ?? false);
      const qBarPin = makeOutputPin(qBarSpec, pinNodes.get("~Q") ?? 0, pinLoading["~Q"] ?? false);

      const pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>([
        ["C", clockPin],
        ["Q", qPin],
        ["~Q", qBarPin],
      ]);

      return new BehavioralTFlipflopElement(
        null, clockPin, qPin, qBarPin,
        cSpec.vIH, cSpec.vIL, pinModelsByLabel,
      );
    }
  };
}
