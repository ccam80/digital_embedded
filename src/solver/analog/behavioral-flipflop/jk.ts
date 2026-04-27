/**
 * Behavioral analog factory for edge-triggered JK flip-flops.
 */

import type { LoadContext, StatePoolRef, ReactiveAnalogElementCore } from "../element.js";
import { NGSPICE_LOAD_ORDER } from "../element.js";
import { readMnaVoltage, delegatePinSetParam } from "../digital-pin-model.js";
import type { DigitalInputPinModel, DigitalOutputPinModel } from "../digital-pin-model.js";
import type { AnalogElementFactory } from "../behavioral-gate.js";
import type { AnalogCapacitorElement } from "../../../components/passives/capacitor.js";
import {
  FALLBACK_SPEC,
  getPinSpecs,
  getPinLoading,
  makeInputPin,
  makeOutputPin,
  FLIPFLOP_COMPOSITE_SCHEMA,
  buildChildElements,
  computeChildStateSize,
  initChildState,
  loadChildren,
  checkChildConvergence,
} from "./shared.js";
import type { StateSchema } from "../state-schema.js";

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
 *   load()   — delegates input/output pin stamping to pin models from the
 *              currently latched Q state, then loads capacitor children.
 *   accept() — rising-edge detection and JK latching/toggling.
 */
export class BehavioralJKFlipflopElement implements ReactiveAnalogElementCore {
  private readonly _jPin: DigitalInputPinModel;
  private readonly _clockPin: DigitalInputPinModel;
  private readonly _kPin: DigitalInputPinModel;
  private readonly _qPin: DigitalOutputPinModel;
  private readonly _qBarPin: DigitalOutputPinModel;
  private readonly _childElements: AnalogCapacitorElement[];

  private _latchedQ = false;
  private _prevClockVoltage = 0;
  private readonly _vIH: number;

  private readonly _pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>;

  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  allNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS;
  readonly isNonlinear: true = true;
  label?: string;

  readonly poolBacked = true as const;
  readonly stateSchema: StateSchema = FLIPFLOP_COMPOSITE_SCHEMA;
  stateSize: number;
  stateBaseOffset = -1;
  s0: Float64Array<ArrayBufferLike> = new Float64Array(0) as Float64Array<ArrayBufferLike>;
  s1: Float64Array<ArrayBufferLike> = new Float64Array(0) as Float64Array<ArrayBufferLike>;
  s2: Float64Array<ArrayBufferLike> = new Float64Array(0) as Float64Array<ArrayBufferLike>;
  s3: Float64Array<ArrayBufferLike> = new Float64Array(0) as Float64Array<ArrayBufferLike>;
  s4: Float64Array<ArrayBufferLike> = new Float64Array(0) as Float64Array<ArrayBufferLike>;
  s5: Float64Array<ArrayBufferLike> = new Float64Array(0) as Float64Array<ArrayBufferLike>;
  s6: Float64Array<ArrayBufferLike> = new Float64Array(0) as Float64Array<ArrayBufferLike>;
  s7: Float64Array<ArrayBufferLike> = new Float64Array(0) as Float64Array<ArrayBufferLike>;

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
    this._childElements = buildChildElements([jPin, clockPin, kPin, qPin, qBarPin]);
    this.stateSize = computeChildStateSize(this._childElements);
  }

  get isReactive(): true {
    return (this._childElements.length > 0) as true;
  }

  initState(pool: StatePoolRef): void {
    initChildState(this._childElements, this.stateBaseOffset, pool);
  }

  checkConvergence(ctx: LoadContext): boolean {
    return checkChildConvergence(this._childElements, ctx);
  }

  setParam(key: string, value: number): void {
    delegatePinSetParam(this._pinModelsByLabel, key, value);
  }

  initVoltages(rhs: Float64Array): void {
    this._prevClockVoltage = readMnaVoltage(this._clockPin.nodeId, rhs);
  }

  load(ctx: LoadContext): void {
    // Delegate input stamping to pin models
    this._jPin.load(ctx);
    this._clockPin.load(ctx);
    this._kPin.load(ctx);

    this._qPin.setLogicLevel(this._latchedQ);
    this._qBarPin.setLogicLevel(!this._latchedQ);
    this._qPin.load(ctx);
    this._qBarPin.load(ctx);

    loadChildren(this._childElements, ctx);
  }

  /**
   * Rising-edge detection and JK latching/toggling — called once per accepted
   * timestep with the accepted solution voltages.
   */
  accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
    const voltages = ctx.rhs;

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
    const pinLoading = getPinLoading(props);

    const jSpec = pinSpecs?.["J"] ?? FALLBACK_SPEC;
    const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
    const kSpec = pinSpecs?.["K"] ?? FALLBACK_SPEC;
    const qSpec = pinSpecs?.["Q"] ?? FALLBACK_SPEC;
    const qBarSpec = pinSpecs?.["~Q"] ?? FALLBACK_SPEC;

    const jPin = makeInputPin(jSpec, pinNodes.get("J") ?? 0, pinLoading["J"] ?? true);
    const clockPin = makeInputPin(cSpec, pinNodes.get("C") ?? 0, pinLoading["C"] ?? true);
    const kPin = makeInputPin(kSpec, pinNodes.get("K") ?? 0, pinLoading["K"] ?? true);
    const qPin = makeOutputPin(qSpec, pinNodes.get("Q") ?? 0, pinLoading["Q"] ?? false);
    const qBarPin = makeOutputPin(qBarSpec, pinNodes.get("~Q") ?? 0, pinLoading["~Q"] ?? false);

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
