/**
 * Behavioral analog models for edge-triggered sequential components:
 * N-bit counter and N-bit parallel-load register.
 *
 * Edge detection happens in accept() (once per accepted timestep), never per
 * NR iteration. Multi-bit outputs use one DigitalOutputPinModel per bit,
 * driven by extracting individual bits from the internal count/value.
 */

import type { AnalogElementCore, LoadContext } from "./element.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import {
  DigitalInputPinModel,
  DigitalOutputPinModel,
  readMnaVoltage,
  delegatePinSetParam,
} from "./digital-pin-model.js";
import type { AnalogElementFactory } from "./behavioral-gate.js";

// ---------------------------------------------------------------------------
// Shared fallback spec
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
// BehavioralCounterElement
// ---------------------------------------------------------------------------

/**
 * Analog behavioral model for an N-bit edge-triggered counter.
 *
 * Pin layout matches CounterDefinition pin declarations:
 *   inputs:  en (enable), C (clock), clr (clear)
 *   outputs: out[0..bitWidth-1] (individual bit pins), ovf (overflow)
 *
 * Each output bit is a separate DigitalOutputPinModel. The count is stored
 * as an integer and decomposed into per-bit logic levels on each stamp.
 *
 * Rising-edge detection uses _prevClockVoltage stored after each accepted
 * timestep.
 */
export class BehavioralCounterElement implements AnalogElementCore {
  private readonly _clockPin: DigitalInputPinModel;
  private readonly _enPin: DigitalInputPinModel;
  private readonly _clrPin: DigitalInputPinModel;
  private readonly _outBitPins: DigitalOutputPinModel[];
  private readonly _ovfPin: DigitalOutputPinModel;

  private readonly _bitWidth: number;
  private readonly _maxValue: number;

  private _count = 0;
  private _prevClockVoltage = 0;
  private readonly _vIH: number;

  private readonly _pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>;

  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: true = true;
  readonly isReactive: true = true;
  label?: string;

  constructor(
    enPin: DigitalInputPinModel,
    clockPin: DigitalInputPinModel,
    clrPin: DigitalInputPinModel,
    outBitPins: DigitalOutputPinModel[],
    ovfPin: DigitalOutputPinModel,
    bitWidth: number,
    vIH: number,
    _vIL: number,
    pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>,
  ) {
    this._enPin = enPin;
    this._clockPin = clockPin;
    this._clrPin = clrPin;
    this._outBitPins = outBitPins;
    this._ovfPin = ovfPin;
    this._bitWidth = bitWidth;
    this._maxValue = bitWidth >= 32 ? 0xFFFFFFFF : (1 << bitWidth) - 1;
    this._vIH = vIH;
    this._pinModelsByLabel = pinModelsByLabel;
  }

  initVoltages(rhs: Float64Array): void {
    this._prevClockVoltage = readMnaVoltage(this._clockPin.nodeId, rhs);
  }

  load(ctx: LoadContext): void {
    this._enPin.load(ctx);
    this._clockPin.load(ctx);
    this._clrPin.load(ctx);

    // Stamp output Norton equivalents from current count
    for (let bit = 0; bit < this._bitWidth; bit++) {
      const high = ((this._count >> bit) & 1) === 1;
      this._outBitPins[bit].setLogicLevel(high);
      this._outBitPins[bit].load(ctx);
    }
    const ovf = this._count === this._maxValue;
    this._ovfPin.setLogicLevel(ovf);
    this._ovfPin.load(ctx);
  }

  /**
   * Rising-edge detection, count update, clear handling, and companion state
   * update — called once per accepted timestep with the accepted solution
   * voltages.
   */
  accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
    const voltages = ctx.voltages;

    const currentClockV = readMnaVoltage(this._clockPin.nodeId, voltages);

    const risingEdge =
      this._prevClockVoltage < this._vIH && currentClockV >= this._vIH;

    if (risingEdge) {
      const enV = readMnaVoltage(this._enPin.nodeId, voltages);
      const clrV = readMnaVoltage(this._clrPin.nodeId, voltages);

      const enLevel = this._enPin.readLogicLevel(enV);
      const clrLevel = this._clrPin.readLogicLevel(clrV);

      if (enLevel === true) {
        if (this._count === this._maxValue) {
          this._count = 0;
        } else {
          this._count += 1;
        }
      }
      if (clrLevel === true) {
        this._count = 0;
      }
    }

    this._prevClockVoltage = currentClockV;

    // Delegate companion updates to pin models.
    this._enPin.accept(ctx, readMnaVoltage(this._enPin.nodeId, voltages));
    this._clockPin.accept(ctx, currentClockV);
    this._clrPin.accept(ctx, readMnaVoltage(this._clrPin.nodeId, voltages));

    for (const pin of this._outBitPins) {
      pin.accept(ctx, readMnaVoltage(pin.nodeId, voltages));
    }
    this._ovfPin.accept(ctx, readMnaVoltage(this._ovfPin.nodeId, voltages));
  }

  /**
   * Per-pin currents in pinNodeIds (pinLayout) order:
   *   [en, C, clr, out[0], ..., out[bitWidth-1], ovf]
   *
   * Input pins (en, C, clr): I = V_node / rIn.
   * Output pins (out bits, ovf): I = (V_node - V_target) / rOut.
   * Sum is nonzero because behavioral outputs have an implicit supply.
   */
  getPinCurrents(voltages: Float64Array): number[] {
    const vEn = readMnaVoltage(this._enPin.nodeId, voltages);
    const vClk = readMnaVoltage(this._clockPin.nodeId, voltages);
    const vClr = readMnaVoltage(this._clrPin.nodeId, voltages);

    const result = [
      vEn / this._enPin.rIn,
      vClk / this._clockPin.rIn,
      vClr / this._clrPin.rIn,
    ];

    for (const pin of this._outBitPins) {
      const vNode = readMnaVoltage(pin.nodeId, voltages);
      result.push((vNode - pin.currentVoltage) / pin.rOut);
    }

    const vOvf = readMnaVoltage(this._ovfPin.nodeId, voltages);
    result.push((vOvf - this._ovfPin.currentVoltage) / this._ovfPin.rOut);

    return result;
  }

  get count(): number {
    return this._count;
  }

  get vOH(): number {
    return this._outBitPins[0]?.currentVoltage ?? FALLBACK_SPEC.vOH;
  }

  setParam(key: string, value: number): void {
    delegatePinSetParam(this._pinModelsByLabel, key, value);
  }
}

// ---------------------------------------------------------------------------
// BehavioralRegisterElement
// ---------------------------------------------------------------------------

/**
 * Analog behavioral model for an N-bit edge-triggered parallel-load register.
 *
 * Pin layout matches RegisterDefinition pin declarations:
 *   inputs:  D[0..bitWidth-1] (individual data bit pins), C (clock), en (enable)
 *   outputs: Q[0..bitWidth-1] (individual output bit pins)
 *
 * On rising clock edge with en=1: latches all data inputs to outputs.
 */
export class BehavioralRegisterElement implements AnalogElementCore {
  private readonly _clockPin: DigitalInputPinModel;
  private readonly _enPin: DigitalInputPinModel;
  private readonly _dataPins: DigitalInputPinModel[];
  private readonly _outBitPins: DigitalOutputPinModel[];

  private readonly _bitWidth: number;
  private _storedValue = 0;
  private _prevClockVoltage = 0;
  private readonly _vIH: number;

  private readonly _pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>;

  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: true = true;
  readonly isReactive: true = true;
  label?: string;

  constructor(
    dataPins: DigitalInputPinModel[],
    clockPin: DigitalInputPinModel,
    enPin: DigitalInputPinModel,
    outBitPins: DigitalOutputPinModel[],
    bitWidth: number,
    vIH: number,
    _vIL: number,
    pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>,
  ) {
    this._dataPins = dataPins;
    this._clockPin = clockPin;
    this._enPin = enPin;
    this._outBitPins = outBitPins;
    this._bitWidth = bitWidth;
    this._vIH = vIH;
    this._pinModelsByLabel = pinModelsByLabel;
  }

  initVoltages(rhs: Float64Array): void {
    this._prevClockVoltage = readMnaVoltage(this._clockPin.nodeId, rhs);
  }

  load(ctx: LoadContext): void {
    for (const pin of this._dataPins) {
      pin.load(ctx);
    }
    this._clockPin.load(ctx);
    this._enPin.load(ctx);

    // Stamp output Norton equivalents from stored value
    for (let bit = 0; bit < this._bitWidth; bit++) {
      const high = ((this._storedValue >> bit) & 1) === 1;
      this._outBitPins[bit].setLogicLevel(high);
      this._outBitPins[bit].load(ctx);
    }
  }

  /**
   * Rising-edge detection, parallel-load latching on en=high, and companion
   * state update — called once per accepted timestep with the accepted
   * solution voltages.
   */
  accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
    const voltages = ctx.voltages;

    const currentClockV = readMnaVoltage(this._clockPin.nodeId, voltages);

    const risingEdge =
      this._prevClockVoltage < this._vIH && currentClockV >= this._vIH;

    if (risingEdge) {
      const enV = readMnaVoltage(this._enPin.nodeId, voltages);
      const enLevel = this._enPin.readLogicLevel(enV);

      if (enLevel === true) {
        let newValue = 0;
        for (let bit = 0; bit < this._bitWidth; bit++) {
          const v = readMnaVoltage(this._dataPins[bit].nodeId, voltages);
          const level = this._dataPins[bit].readLogicLevel(v);
          if (level === true) {
            newValue |= (1 << bit);
          }
        }
        this._storedValue = newValue;
      }
    }

    this._prevClockVoltage = currentClockV;

    // Delegate companion updates to pin models.
    for (const pin of this._dataPins) {
      pin.accept(ctx, readMnaVoltage(pin.nodeId, voltages));
    }
    this._clockPin.accept(ctx, currentClockV);
    this._enPin.accept(ctx, readMnaVoltage(this._enPin.nodeId, voltages));

    for (const pin of this._outBitPins) {
      pin.accept(ctx, readMnaVoltage(pin.nodeId, voltages));
    }
  }

  get storedValue(): number {
    return this._storedValue;
  }

  setParam(key: string, value: number): void {
    delegatePinSetParam(this._pinModelsByLabel, key, value);
  }

  getPinCurrents(voltages: Float64Array): number[] {
    // Pin layout order: D (bus input), C (clock input), en (enable input), Q (bus output)
    // Input pins: I = V_node / rIn (loading conductance to ground)
    // Output pins: I = (V_node - V_target) / rOut

    // D input — all bits share one bus node; report current for the bus pin once
    const dPin = this._dataPins[0];
    const vD = readMnaVoltage(dPin !== undefined ? dPin.nodeId : 0, voltages);
    const iD = dPin !== undefined ? vD / dPin.rIn : 0;

    // C (clock) input
    const vC = readMnaVoltage(this._clockPin.nodeId, voltages);
    const iC = vC / this._clockPin.rIn;

    // en (enable) input
    const vEn = readMnaVoltage(this._enPin.nodeId, voltages);
    const iEn = vEn / this._enPin.rIn;

    // Q output — all bits share one bus node; report current for the bus pin once
    const qPin = this._outBitPins[0];
    const vQ = readMnaVoltage(qPin !== undefined ? qPin.nodeId : 0, voltages);
    const iQ = qPin !== undefined ? (vQ - qPin.currentVoltage) / qPin.rOut : 0;

    return [iD, iC, iEn, iQ];
  }
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Returns an analogFactory for N-bit counters.
 *
 * nodeIds layout (matches CounterDefinition pin declarations):
 *   nodeIds[0] = en input
 *   nodeIds[1] = C (clock) input
 *   nodeIds[2] = clr input
 *   nodeIds[3..3+bitWidth-1] = out bit pins (LSB first)
 *   nodeIds[3+bitWidth] = ovf output
 */
export function makeBehavioralCounterAnalogFactory(): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
    const pinSpecs = props.has("_pinElectrical")
      ? (props.get("_pinElectrical") as unknown as Record<string, ResolvedPinElectrical>)
      : undefined;

    const pinLoading = props.has("_pinLoading")
      ? (props.get("_pinLoading") as unknown as Record<string, boolean>)
      : {} as Record<string, boolean>;

    const bitWidth = (props.has("bitWidth") ? props.get("bitWidth") as number : undefined) ?? 4;

    const enSpec = pinSpecs?.["en"] ?? FALLBACK_SPEC;
    const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
    const clrSpec = pinSpecs?.["clr"] ?? FALLBACK_SPEC;
    const outSpec = pinSpecs?.["out"] ?? FALLBACK_SPEC;
    const ovfSpec = pinSpecs?.["ovf"] ?? FALLBACK_SPEC;

    const enPin = new DigitalInputPinModel(enSpec, pinLoading["en"] ?? true);
    enPin.init(pinNodes.get("en") ?? 0, 0);

    const clockPin = new DigitalInputPinModel(cSpec, pinLoading["C"] ?? true);
    clockPin.init(pinNodes.get("C") ?? 0, 0);

    const clrPin = new DigitalInputPinModel(clrSpec, pinLoading["clr"] ?? true);
    clrPin.init(pinNodes.get("clr") ?? 0, 0);

    const outBitPins: DigitalOutputPinModel[] = [];
    for (let bit = 0; bit < bitWidth; bit++) {
      const pin = new DigitalOutputPinModel(outSpec, pinLoading["out"] ?? false, "direct");
      pin.init(pinNodes.get("out") ?? 0, -1);
      outBitPins.push(pin);
    }

    const ovfPin = new DigitalOutputPinModel(ovfSpec, pinLoading["ovf"] ?? false, "direct");
    ovfPin.init(pinNodes.get("ovf") ?? 0, -1);

    const pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>([
      ["en", enPin],
      ["C", clockPin],
      ["clr", clrPin],
      ["ovf", ovfPin],
    ]);
    for (let bit = 0; bit < bitWidth; bit++) {
      pinModelsByLabel.set(`out_${bit}`, outBitPins[bit]);
    }

    return new BehavioralCounterElement(
      enPin,
      clockPin,
      clrPin,
      outBitPins,
      ovfPin,
      bitWidth,
      cSpec.vIH,
      cSpec.vIL,
      pinModelsByLabel,
    );
  };
}

// ---------------------------------------------------------------------------
// BehavioralCounterPresetElement
// ---------------------------------------------------------------------------

/**
 * Analog behavioral model for an N-bit edge-triggered up/down counter with
 * preset load and configurable max value.
 *
 * Pin layout matches CounterPresetDefinition pin declarations:
 *   inputs:  en (enable), C (clock), dir (direction), in[0..bitWidth-1] (load value bits),
 *            ld (load), clr (clear)
 *   outputs: out[0..bitWidth-1] (individual bit pins), ovf (overflow)
 *
 * Priority on rising clock edge: clr > ld > count (matching executeCounterPreset).
 * dir=0 → count up; dir=1 → count down.
 * ovf=1 when: counting up and count==maxValue, or counting down and count==0.
 */
export class BehavioralCounterPresetElement implements AnalogElementCore {
  private readonly _enPin: DigitalInputPinModel;
  private readonly _clockPin: DigitalInputPinModel;
  private readonly _dirPin: DigitalInputPinModel;
  private readonly _inBitPins: DigitalInputPinModel[];
  private readonly _ldPin: DigitalInputPinModel;
  private readonly _clrPin: DigitalInputPinModel;
  private readonly _outBitPins: DigitalOutputPinModel[];
  private readonly _ovfPin: DigitalOutputPinModel;

  private readonly _bitWidth: number;
  private readonly _maxValue: number;

  private _count = 0;
  private _prevClockVoltage = 0;
  private readonly _vIH: number;

  private readonly _pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>;

  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: true = true;
  readonly isReactive: true = true;
  label?: string;

  constructor(
    enPin: DigitalInputPinModel,
    clockPin: DigitalInputPinModel,
    dirPin: DigitalInputPinModel,
    inBitPins: DigitalInputPinModel[],
    ldPin: DigitalInputPinModel,
    clrPin: DigitalInputPinModel,
    outBitPins: DigitalOutputPinModel[],
    ovfPin: DigitalOutputPinModel,
    bitWidth: number,
    maxValue: number,
    vIH: number,
    _vIL: number,
    pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>,
  ) {
    this._enPin = enPin;
    this._clockPin = clockPin;
    this._dirPin = dirPin;
    this._inBitPins = inBitPins;
    this._ldPin = ldPin;
    this._clrPin = clrPin;
    this._outBitPins = outBitPins;
    this._ovfPin = ovfPin;
    this._bitWidth = bitWidth;
    this._maxValue = maxValue;
    this._vIH = vIH;
    this._pinModelsByLabel = pinModelsByLabel;
  }

  initVoltages(rhs: Float64Array): void {
    this._prevClockVoltage = readMnaVoltage(this._clockPin.nodeId, rhs);
  }

  load(ctx: LoadContext): void {
    const voltages = ctx.voltages;

    this._enPin.load(ctx);
    this._clockPin.load(ctx);
    this._dirPin.load(ctx);
    for (const pin of this._inBitPins) pin.load(ctx);
    this._ldPin.load(ctx);
    this._clrPin.load(ctx);

    // Stamp output Norton equivalents from current count
    for (let bit = 0; bit < this._bitWidth; bit++) {
      const high = ((this._count >> bit) & 1) === 1;
      this._outBitPins[bit].setLogicLevel(high);
      this._outBitPins[bit].load(ctx);
    }
    // ovf depends on dir and en levels at the current NR iterate
    const dirHigh = this._dirPin.readLogicLevel(
      readMnaVoltage(this._dirPin.nodeId, voltages),
    );
    const countingDown = dirHigh === true;
    const atOverflow = countingDown
      ? this._count === 0
      : this._count === this._maxValue;
    const enHigh = this._enPin.readLogicLevel(
      readMnaVoltage(this._enPin.nodeId, voltages),
    );
    this._ovfPin.setLogicLevel(atOverflow && enHigh === true);
    this._ovfPin.load(ctx);
  }

  /**
   * Rising-edge detection, up/down count / load / clear priority resolution,
   * and companion state update — called once per accepted timestep with the
   * accepted solution voltages.
   */
  accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
    const voltages = ctx.voltages;

    const currentClockV = readMnaVoltage(this._clockPin.nodeId, voltages);

    const risingEdge =
      this._prevClockVoltage < this._vIH && currentClockV >= this._vIH;

    if (risingEdge) {
      const enV = readMnaVoltage(this._enPin.nodeId, voltages);
      const dirV = readMnaVoltage(this._dirPin.nodeId, voltages);
      const ldV = readMnaVoltage(this._ldPin.nodeId, voltages);
      const clrV = readMnaVoltage(this._clrPin.nodeId, voltages);

      const enLevel = this._enPin.readLogicLevel(enV);
      const dirLevel = this._dirPin.readLogicLevel(dirV);
      const ldLevel = this._ldPin.readLogicLevel(ldV);
      const clrLevel = this._clrPin.readLogicLevel(clrV);

      // Priority: clr > ld > count (matching executeCounterPreset)
      if (enLevel === true) {
        const countingDown = dirLevel === true;
        if (countingDown) {
          if (this._count === 0) {
            this._count = this._maxValue;
          } else {
            this._count -= 1;
          }
        } else {
          if (this._count === this._maxValue) {
            this._count = 0;
          } else {
            this._count += 1;
          }
        }
      }

      if (clrLevel === true) {
        this._count = 0;
      } else if (ldLevel === true) {
        let loadVal = 0;
        for (let bit = 0; bit < this._bitWidth; bit++) {
          const v = readMnaVoltage(this._inBitPins[bit].nodeId, voltages);
          if (this._inBitPins[bit].readLogicLevel(v) === true) {
            loadVal |= (1 << bit);
          }
        }
        const mask = this._bitWidth >= 32 ? 0xFFFFFFFF : (1 << this._bitWidth) - 1;
        this._count = loadVal & mask;
      }
    }

    this._prevClockVoltage = currentClockV;

    // Delegate companion updates to pin models.
    this._enPin.accept(ctx, readMnaVoltage(this._enPin.nodeId, voltages));
    this._clockPin.accept(ctx, currentClockV);
    this._dirPin.accept(ctx, readMnaVoltage(this._dirPin.nodeId, voltages));
    for (const pin of this._inBitPins) {
      pin.accept(ctx, readMnaVoltage(pin.nodeId, voltages));
    }
    this._ldPin.accept(ctx, readMnaVoltage(this._ldPin.nodeId, voltages));
    this._clrPin.accept(ctx, readMnaVoltage(this._clrPin.nodeId, voltages));

    for (const pin of this._outBitPins) {
      pin.accept(ctx, readMnaVoltage(pin.nodeId, voltages));
    }
    this._ovfPin.accept(ctx, readMnaVoltage(this._ovfPin.nodeId, voltages));
  }

  getPinCurrents(voltages: Float64Array): number[] {
    // pinLayout order: en, C, dir, in[0..bitWidth-1], ld, clr, out[0..bitWidth-1], ovf
    const result: number[] = [];
    result.push(readMnaVoltage(this._enPin.nodeId, voltages) / this._enPin.rIn);
    result.push(readMnaVoltage(this._clockPin.nodeId, voltages) / this._clockPin.rIn);
    result.push(readMnaVoltage(this._dirPin.nodeId, voltages) / this._dirPin.rIn);
    for (const pin of this._inBitPins) {
      result.push(readMnaVoltage(pin.nodeId, voltages) / pin.rIn);
    }
    result.push(readMnaVoltage(this._ldPin.nodeId, voltages) / this._ldPin.rIn);
    result.push(readMnaVoltage(this._clrPin.nodeId, voltages) / this._clrPin.rIn);
    for (const pin of this._outBitPins) {
      const v = readMnaVoltage(pin.nodeId, voltages);
      result.push((v - pin.currentVoltage) / pin.rOut);
    }
    const vOvf = readMnaVoltage(this._ovfPin.nodeId, voltages);
    result.push((vOvf - this._ovfPin.currentVoltage) / this._ovfPin.rOut);
    return result;
  }

  get count(): number {
    return this._count;
  }

  setParam(key: string, value: number): void {
    delegatePinSetParam(this._pinModelsByLabel, key, value);
  }
}

// ---------------------------------------------------------------------------
// Factory: makeBehavioralCounterPresetAnalogFactory
// ---------------------------------------------------------------------------

/**
 * Returns an analogFactory for CounterPreset (up/down counter with load and clear).
 *
 * Pin layout matches CounterPresetDefinition pin declarations:
 *   inputs:  en, C (clock), dir, in (multi-bit bus), ld, clr
 *   outputs: out (multi-bit bus), ovf
 *
 * The multi-bit "in" and "out" pins each map to a single MNA node in pinNodes
 * (one bus node). All per-bit pin models share the same node ID.
 */
export function makeBehavioralCounterPresetAnalogFactory(): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
    const pinSpecs = props.has("_pinElectrical")
      ? (props.get("_pinElectrical") as unknown as Record<string, ResolvedPinElectrical>)
      : undefined;

    const pinLoading = props.has("_pinLoading")
      ? (props.get("_pinLoading") as unknown as Record<string, boolean>)
      : {} as Record<string, boolean>;

    const bitWidth = (props.has("bitWidth") ? props.get("bitWidth") as number : undefined) ?? 4;
    let maxValue = (props.has("maxValue") ? props.get("maxValue") as number : undefined) ?? 0;
    const mask = bitWidth >= 32 ? 0xFFFFFFFF : (1 << bitWidth) - 1;
    if (maxValue === 0) maxValue = mask;
    maxValue = maxValue & mask;

    const enSpec = pinSpecs?.["en"] ?? FALLBACK_SPEC;
    const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
    const dirSpec = pinSpecs?.["dir"] ?? FALLBACK_SPEC;
    const inSpec = pinSpecs?.["in"] ?? FALLBACK_SPEC;
    const ldSpec = pinSpecs?.["ld"] ?? FALLBACK_SPEC;
    const clrSpec = pinSpecs?.["clr"] ?? FALLBACK_SPEC;
    const outSpec = pinSpecs?.["out"] ?? FALLBACK_SPEC;
    const ovfSpec = pinSpecs?.["ovf"] ?? FALLBACK_SPEC;

    const enPin = new DigitalInputPinModel(enSpec, pinLoading["en"] ?? true);
    enPin.init(pinNodes.get("en") ?? 0, 0);

    const clockPin = new DigitalInputPinModel(cSpec, pinLoading["C"] ?? true);
    clockPin.init(pinNodes.get("C") ?? 0, 0);

    const dirPin = new DigitalInputPinModel(dirSpec, pinLoading["dir"] ?? true);
    dirPin.init(pinNodes.get("dir") ?? 0, 0);

    // All in-bit pins share the single "in" bus node
    const inBitPins: DigitalInputPinModel[] = [];
    const inNodeId = pinNodes.get("in") ?? 0;
    for (let bit = 0; bit < bitWidth; bit++) {
      const pin = new DigitalInputPinModel(inSpec, pinLoading["in"] ?? true);
      pin.init(inNodeId, 0);
      inBitPins.push(pin);
    }

    const ldPin = new DigitalInputPinModel(ldSpec, pinLoading["ld"] ?? true);
    ldPin.init(pinNodes.get("ld") ?? 0, 0);

    const clrPin = new DigitalInputPinModel(clrSpec, pinLoading["clr"] ?? true);
    clrPin.init(pinNodes.get("clr") ?? 0, 0);

    // All out-bit pins share the single "out" bus node
    const outBitPins: DigitalOutputPinModel[] = [];
    const outNodeId = pinNodes.get("out") ?? 0;
    for (let bit = 0; bit < bitWidth; bit++) {
      const pin = new DigitalOutputPinModel(outSpec, pinLoading["out"] ?? false, "direct");
      pin.init(outNodeId, -1);
      outBitPins.push(pin);
    }

    const ovfPin = new DigitalOutputPinModel(ovfSpec, pinLoading["ovf"] ?? false, "direct");
    ovfPin.init(pinNodes.get("ovf") ?? 0, -1);

    const pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>([
      ["en", enPin],
      ["C", clockPin],
      ["dir", dirPin],
      ["ld", ldPin],
      ["clr", clrPin],
      ["ovf", ovfPin],
    ]);
    for (let bit = 0; bit < bitWidth; bit++) {
      pinModelsByLabel.set(`in_${bit}`, inBitPins[bit]);
      pinModelsByLabel.set(`out_${bit}`, outBitPins[bit]);
    }

    return new BehavioralCounterPresetElement(
      enPin,
      clockPin,
      dirPin,
      inBitPins,
      ldPin,
      clrPin,
      outBitPins,
      ovfPin,
      bitWidth,
      maxValue,
      cSpec.vIH,
      cSpec.vIL,
      pinModelsByLabel,
    );
  };
}

// ---------------------------------------------------------------------------

/**
 * Returns an analogFactory for N-bit parallel-load registers.
 *
 * Pin layout matches RegisterDefinition pin declarations:
 *   inputs:  D (multi-bit bus), C (clock), en
 *   outputs: Q (multi-bit bus)
 *
 * The multi-bit "D" and "Q" pins each map to a single MNA node in pinNodes
 * (one bus node). All per-bit pin models share the same node ID.
 */
export function makeBehavioralRegisterAnalogFactory(): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
    const pinSpecs = props.has("_pinElectrical")
      ? (props.get("_pinElectrical") as unknown as Record<string, ResolvedPinElectrical>)
      : undefined;

    const pinLoading = props.has("_pinLoading")
      ? (props.get("_pinLoading") as unknown as Record<string, boolean>)
      : {} as Record<string, boolean>;

    const bitWidth = (props.has("bitWidth") ? props.get("bitWidth") as number : undefined) ?? 8;

    const dSpec = pinSpecs?.["D"] ?? FALLBACK_SPEC;
    const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
    const enSpec = pinSpecs?.["en"] ?? FALLBACK_SPEC;
    const qSpec = pinSpecs?.["Q"] ?? FALLBACK_SPEC;

    // All data-bit pins share the single "D" bus node
    const dataPins: DigitalInputPinModel[] = [];
    const dNodeId = pinNodes.get("D") ?? 0;
    for (let bit = 0; bit < bitWidth; bit++) {
      const pin = new DigitalInputPinModel(dSpec, pinLoading["D"] ?? true);
      pin.init(dNodeId, 0);
      dataPins.push(pin);
    }

    const clockPin = new DigitalInputPinModel(cSpec, pinLoading["C"] ?? true);
    clockPin.init(pinNodes.get("C") ?? 0, 0);

    const enPin = new DigitalInputPinModel(enSpec, pinLoading["en"] ?? true);
    enPin.init(pinNodes.get("en") ?? 0, 0);

    // All output-bit pins share the single "Q" bus node
    const outBitPins: DigitalOutputPinModel[] = [];
    const qNodeId = pinNodes.get("Q") ?? 0;
    for (let bit = 0; bit < bitWidth; bit++) {
      const pin = new DigitalOutputPinModel(qSpec, pinLoading["Q"] ?? false, "direct");
      pin.init(qNodeId, -1);
      outBitPins.push(pin);
    }

    const pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>([
      ["C", clockPin],
      ["en", enPin],
    ]);
    for (let bit = 0; bit < bitWidth; bit++) {
      pinModelsByLabel.set(`D_${bit}`, dataPins[bit]);
      pinModelsByLabel.set(`Q_${bit}`, outBitPins[bit]);
    }

    return new BehavioralRegisterElement(
      dataPins,
      clockPin,
      enPin,
      outBitPins,
      bitWidth,
      cSpec.vIH,
      cSpec.vIL,
      pinModelsByLabel,
    );
  };
}
