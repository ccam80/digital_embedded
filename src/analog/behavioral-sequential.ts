/**
 * Behavioral analog models for edge-triggered sequential components:
 * N-bit counter and N-bit parallel-load register.
 *
 * Edge detection happens in updateCompanion() (once per accepted timestep),
 * never per NR iteration. Multi-bit outputs use one DigitalOutputPinModel
 * per bit, driven by extracting individual bits from the internal count/value.
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
export class BehavioralCounterElement implements AnalogElement {
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
  private readonly _vIL: number;

  private _solver: SparseSolver | null = null;
  private _cachedVoltages: Float64Array = new Float64Array(0);

  readonly nodeIndices: readonly number[];
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
    vIL: number,
  ) {
    this._enPin = enPin;
    this._clockPin = clockPin;
    this._clrPin = clrPin;
    this._outBitPins = outBitPins;
    this._ovfPin = ovfPin;
    this._bitWidth = bitWidth;
    this._maxValue = bitWidth >= 32 ? 0xFFFFFFFF : (1 << bitWidth) - 1;
    this._vIH = vIH;
    this._vIL = vIL;

    const indices: number[] = [
      enPin.nodeId,
      clockPin.nodeId,
      clrPin.nodeId,
      ...outBitPins.map((p) => p.nodeId),
      ovfPin.nodeId,
    ];
    this.nodeIndices = indices;
  }

  stamp(solver: SparseSolver): void {
    this._solver = solver;
    this._enPin.stamp(solver);
    this._clockPin.stamp(solver);
    this._clrPin.stamp(solver);
  }

  stampNonlinear(solver: SparseSolver): void {
    this._solver = solver;
    this._applyOutputLevels(solver);
  }

  private _applyOutputLevels(solver: SparseSolver): void {
    for (let bit = 0; bit < this._bitWidth; bit++) {
      const high = ((this._count >> bit) & 1) === 1;
      this._outBitPins[bit].setLogicLevel(high);
      this._outBitPins[bit].stamp(solver);
    }
    const ovf = this._count === this._maxValue;
    this._ovfPin.setLogicLevel(ovf);
    this._ovfPin.stamp(solver);
  }

  updateOperatingPoint(voltages: Float64Array): void {
    if (this._cachedVoltages.length !== voltages.length) {
      this._cachedVoltages = new Float64Array(voltages.length);
    }
    this._cachedVoltages.set(voltages);
  }

  stampCompanion(
    dt: number,
    method: IntegrationMethod,
    _voltages: Float64Array,
  ): void {
    const solver = this._solver;
    if (solver === null) return;
    this._enPin.stampCompanion(solver, dt, method);
    this._clockPin.stampCompanion(solver, dt, method);
    this._clrPin.stampCompanion(solver, dt, method);
    for (const pin of this._outBitPins) {
      pin.stampCompanion(solver, dt, method);
    }
    this._ovfPin.stampCompanion(solver, dt, method);
  }

  updateCompanion(
    dt: number,
    method: IntegrationMethod,
    voltages: Float64Array,
  ): void {
    const clockNodeId = this._clockPin.nodeId;
    const currentClockV = clockNodeId < voltages.length ? voltages[clockNodeId] : 0;

    const risingEdge =
      this._prevClockVoltage < this._vIH && currentClockV >= this._vIH;

    if (risingEdge) {
      const enNodeId = this._enPin.nodeId;
      const enV = enNodeId < voltages.length ? voltages[enNodeId] : 0;
      const clrNodeId = this._clrPin.nodeId;
      const clrV = clrNodeId < voltages.length ? voltages[clrNodeId] : 0;

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

    const enNodeId = this._enPin.nodeId;
    const enV = enNodeId < voltages.length ? voltages[enNodeId] : 0;
    this._enPin.updateCompanion(dt, method, enV);
    this._clockPin.updateCompanion(dt, method, currentClockV);
    const clrNodeId = this._clrPin.nodeId;
    const clrV = clrNodeId < voltages.length ? voltages[clrNodeId] : 0;
    this._clrPin.updateCompanion(dt, method, clrV);

    for (const pin of this._outBitPins) {
      const nodeId = pin.nodeId;
      const v = nodeId < voltages.length ? voltages[nodeId] : 0;
      pin.updateCompanion(dt, method, v);
    }
    const ovfNodeId = this._ovfPin.nodeId;
    const ovfV = ovfNodeId < voltages.length ? voltages[ovfNodeId] : 0;
    this._ovfPin.updateCompanion(dt, method, ovfV);
  }

  updateState(_dt: number, _voltages: Float64Array): void {
    // intentionally empty
  }

  get count(): number {
    return this._count;
  }

  get vOH(): number {
    return this._outBitPins[0]?.currentVoltage ?? FALLBACK_SPEC.vOH;
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
export class BehavioralRegisterElement implements AnalogElement {
  private readonly _clockPin: DigitalInputPinModel;
  private readonly _enPin: DigitalInputPinModel;
  private readonly _dataPins: DigitalInputPinModel[];
  private readonly _outBitPins: DigitalOutputPinModel[];

  private readonly _bitWidth: number;
  private _storedValue = 0;
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
    dataPins: DigitalInputPinModel[],
    clockPin: DigitalInputPinModel,
    enPin: DigitalInputPinModel,
    outBitPins: DigitalOutputPinModel[],
    bitWidth: number,
    vIH: number,
    vIL: number,
  ) {
    this._dataPins = dataPins;
    this._clockPin = clockPin;
    this._enPin = enPin;
    this._outBitPins = outBitPins;
    this._bitWidth = bitWidth;
    this._vIH = vIH;
    this._vIL = vIL;

    const indices: number[] = [
      ...dataPins.map((p) => p.nodeId),
      clockPin.nodeId,
      enPin.nodeId,
      ...outBitPins.map((p) => p.nodeId),
    ];
    this.nodeIndices = indices;
  }

  stamp(solver: SparseSolver): void {
    this._solver = solver;
    for (const pin of this._dataPins) {
      pin.stamp(solver);
    }
    this._clockPin.stamp(solver);
    this._enPin.stamp(solver);
  }

  stampNonlinear(solver: SparseSolver): void {
    this._solver = solver;
    this._applyOutputLevels(solver);
  }

  private _applyOutputLevels(solver: SparseSolver): void {
    for (let bit = 0; bit < this._bitWidth; bit++) {
      const high = ((this._storedValue >> bit) & 1) === 1;
      this._outBitPins[bit].setLogicLevel(high);
      this._outBitPins[bit].stamp(solver);
    }
  }

  updateOperatingPoint(voltages: Float64Array): void {
    if (this._cachedVoltages.length !== voltages.length) {
      this._cachedVoltages = new Float64Array(voltages.length);
    }
    this._cachedVoltages.set(voltages);
  }

  stampCompanion(
    dt: number,
    method: IntegrationMethod,
    _voltages: Float64Array,
  ): void {
    const solver = this._solver;
    if (solver === null) return;
    for (const pin of this._dataPins) {
      pin.stampCompanion(solver, dt, method);
    }
    this._clockPin.stampCompanion(solver, dt, method);
    this._enPin.stampCompanion(solver, dt, method);
    for (const pin of this._outBitPins) {
      pin.stampCompanion(solver, dt, method);
    }
  }

  updateCompanion(
    dt: number,
    method: IntegrationMethod,
    voltages: Float64Array,
  ): void {
    const clockNodeId = this._clockPin.nodeId;
    const currentClockV = clockNodeId < voltages.length ? voltages[clockNodeId] : 0;

    const risingEdge =
      this._prevClockVoltage < this._vIH && currentClockV >= this._vIH;

    if (risingEdge) {
      const enNodeId = this._enPin.nodeId;
      const enV = enNodeId < voltages.length ? voltages[enNodeId] : 0;
      const enLevel = this._enPin.readLogicLevel(enV);

      if (enLevel === true) {
        let newValue = 0;
        for (let bit = 0; bit < this._bitWidth; bit++) {
          const nodeId = this._dataPins[bit].nodeId;
          const v = nodeId < voltages.length ? voltages[nodeId] : 0;
          const level = this._dataPins[bit].readLogicLevel(v);
          if (level === true) {
            newValue |= (1 << bit);
          }
        }
        this._storedValue = newValue;
      }
    }

    this._prevClockVoltage = currentClockV;

    for (const pin of this._dataPins) {
      const nodeId = pin.nodeId;
      const v = nodeId < voltages.length ? voltages[nodeId] : 0;
      pin.updateCompanion(dt, method, v);
    }
    this._clockPin.updateCompanion(dt, method, currentClockV);
    const enNodeId = this._enPin.nodeId;
    const enV = enNodeId < voltages.length ? voltages[enNodeId] : 0;
    this._enPin.updateCompanion(dt, method, enV);

    for (const pin of this._outBitPins) {
      const nodeId = pin.nodeId;
      const v = nodeId < voltages.length ? voltages[nodeId] : 0;
      pin.updateCompanion(dt, method, v);
    }
  }

  updateState(_dt: number, _voltages: Float64Array): void {
    // intentionally empty
  }

  get storedValue(): number {
    return this._storedValue;
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
  return (nodeIds, _branchIdx, props, _getTime) => {
    const pinSpecs = props.has("_pinElectrical")
      ? (props.get("_pinElectrical") as unknown as Record<string, ResolvedPinElectrical>)
      : undefined;

    const bitWidth = (props.has("bitWidth") ? props.get("bitWidth") as number : undefined) ?? 4;

    const enSpec = pinSpecs?.["en"] ?? FALLBACK_SPEC;
    const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
    const clrSpec = pinSpecs?.["clr"] ?? FALLBACK_SPEC;
    const outSpec = pinSpecs?.["out"] ?? FALLBACK_SPEC;
    const ovfSpec = pinSpecs?.["ovf"] ?? FALLBACK_SPEC;

    const enPin = new DigitalInputPinModel(enSpec);
    enPin.init(nodeIds[0], 0);

    const clockPin = new DigitalInputPinModel(cSpec);
    clockPin.init(nodeIds[1], 0);

    const clrPin = new DigitalInputPinModel(clrSpec);
    clrPin.init(nodeIds[2], 0);

    const outBitPins: DigitalOutputPinModel[] = [];
    for (let bit = 0; bit < bitWidth; bit++) {
      const pin = new DigitalOutputPinModel(outSpec);
      pin.init(nodeIds[3 + bit], -1);
      outBitPins.push(pin);
    }

    const ovfPin = new DigitalOutputPinModel(ovfSpec);
    ovfPin.init(nodeIds[3 + bitWidth], -1);

    return new BehavioralCounterElement(
      enPin,
      clockPin,
      clrPin,
      outBitPins,
      ovfPin,
      bitWidth,
      cSpec.vIH,
      cSpec.vIL,
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
export class BehavioralCounterPresetElement implements AnalogElement {
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
  private readonly _vIL: number;

  private _solver: SparseSolver | null = null;
  private _cachedVoltages: Float64Array = new Float64Array(0);

  readonly nodeIndices: readonly number[];
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
    vIL: number,
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
    this._vIL = vIL;

    const indices: number[] = [
      enPin.nodeId,
      clockPin.nodeId,
      dirPin.nodeId,
      ...inBitPins.map((p) => p.nodeId),
      ldPin.nodeId,
      clrPin.nodeId,
      ...outBitPins.map((p) => p.nodeId),
      ovfPin.nodeId,
    ];
    this.nodeIndices = indices;
  }

  stamp(solver: SparseSolver): void {
    this._solver = solver;
    this._enPin.stamp(solver);
    this._clockPin.stamp(solver);
    this._dirPin.stamp(solver);
    for (const pin of this._inBitPins) pin.stamp(solver);
    this._ldPin.stamp(solver);
    this._clrPin.stamp(solver);
  }

  stampNonlinear(solver: SparseSolver): void {
    this._solver = solver;
    this._applyOutputLevels(solver);
  }

  private _applyOutputLevels(solver: SparseSolver): void {
    for (let bit = 0; bit < this._bitWidth; bit++) {
      const high = ((this._count >> bit) & 1) === 1;
      this._outBitPins[bit].setLogicLevel(high);
      this._outBitPins[bit].stamp(solver);
    }
    const dirHigh = this._dirPin.readLogicLevel(
      this._dirPin.nodeId < this._cachedVoltages.length
        ? this._cachedVoltages[this._dirPin.nodeId]
        : 0,
    );
    const countingDown = dirHigh === true;
    const atOverflow = countingDown
      ? this._count === 0
      : this._count === this._maxValue;
    const enHigh = this._enPin.readLogicLevel(
      this._enPin.nodeId < this._cachedVoltages.length
        ? this._cachedVoltages[this._enPin.nodeId]
        : 0,
    );
    this._ovfPin.setLogicLevel(atOverflow && enHigh === true);
    this._ovfPin.stamp(solver);
  }

  updateOperatingPoint(voltages: Float64Array): void {
    if (this._cachedVoltages.length !== voltages.length) {
      this._cachedVoltages = new Float64Array(voltages.length);
    }
    this._cachedVoltages.set(voltages);
  }

  stampCompanion(
    dt: number,
    method: IntegrationMethod,
    _voltages: Float64Array,
  ): void {
    const solver = this._solver;
    if (solver === null) return;
    this._enPin.stampCompanion(solver, dt, method);
    this._clockPin.stampCompanion(solver, dt, method);
    this._dirPin.stampCompanion(solver, dt, method);
    for (const pin of this._inBitPins) pin.stampCompanion(solver, dt, method);
    this._ldPin.stampCompanion(solver, dt, method);
    this._clrPin.stampCompanion(solver, dt, method);
    for (const pin of this._outBitPins) pin.stampCompanion(solver, dt, method);
    this._ovfPin.stampCompanion(solver, dt, method);
  }

  updateCompanion(
    dt: number,
    method: IntegrationMethod,
    voltages: Float64Array,
  ): void {
    const clockNodeId = this._clockPin.nodeId;
    const currentClockV = clockNodeId < voltages.length ? voltages[clockNodeId] : 0;

    const risingEdge =
      this._prevClockVoltage < this._vIH && currentClockV >= this._vIH;

    if (risingEdge) {
      const enV = this._enPin.nodeId < voltages.length ? voltages[this._enPin.nodeId] : 0;
      const dirV = this._dirPin.nodeId < voltages.length ? voltages[this._dirPin.nodeId] : 0;
      const ldV = this._ldPin.nodeId < voltages.length ? voltages[this._ldPin.nodeId] : 0;
      const clrV = this._clrPin.nodeId < voltages.length ? voltages[this._clrPin.nodeId] : 0;

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
          const v = this._inBitPins[bit].nodeId < voltages.length
            ? voltages[this._inBitPins[bit].nodeId]
            : 0;
          if (this._inBitPins[bit].readLogicLevel(v) === true) {
            loadVal |= (1 << bit);
          }
        }
        const mask = this._bitWidth >= 32 ? 0xFFFFFFFF : (1 << this._bitWidth) - 1;
        this._count = loadVal & mask;
      }
    }

    this._prevClockVoltage = currentClockV;

    const enV = this._enPin.nodeId < voltages.length ? voltages[this._enPin.nodeId] : 0;
    this._enPin.updateCompanion(dt, method, enV);
    this._clockPin.updateCompanion(dt, method, currentClockV);
    const dirV = this._dirPin.nodeId < voltages.length ? voltages[this._dirPin.nodeId] : 0;
    this._dirPin.updateCompanion(dt, method, dirV);
    for (const pin of this._inBitPins) {
      const v = pin.nodeId < voltages.length ? voltages[pin.nodeId] : 0;
      pin.updateCompanion(dt, method, v);
    }
    const ldV = this._ldPin.nodeId < voltages.length ? voltages[this._ldPin.nodeId] : 0;
    this._ldPin.updateCompanion(dt, method, ldV);
    const clrV = this._clrPin.nodeId < voltages.length ? voltages[this._clrPin.nodeId] : 0;
    this._clrPin.updateCompanion(dt, method, clrV);

    for (const pin of this._outBitPins) {
      const v = pin.nodeId < voltages.length ? voltages[pin.nodeId] : 0;
      pin.updateCompanion(dt, method, v);
    }
    const ovfV = this._ovfPin.nodeId < voltages.length ? voltages[this._ovfPin.nodeId] : 0;
    this._ovfPin.updateCompanion(dt, method, ovfV);
  }

  updateState(_dt: number, _voltages: Float64Array): void {
    // intentionally empty
  }

  get count(): number {
    return this._count;
  }
}

// ---------------------------------------------------------------------------
// Factory: makeBehavioralCounterPresetAnalogFactory
// ---------------------------------------------------------------------------

/**
 * Returns an analogFactory for CounterPreset (up/down counter with load and clear).
 *
 * nodeIds layout (matches CounterPresetDefinition pin declarations):
 *   nodeIds[0]              = en input
 *   nodeIds[1]              = C (clock) input
 *   nodeIds[2]              = dir input
 *   nodeIds[3..3+bw-1]      = in bit nodes (LSB first), bitWidth nodes
 *   nodeIds[3+bw]           = ld input
 *   nodeIds[3+bw+1]         = clr input
 *   nodeIds[3+bw+2..3+2bw+1]= out bit pins (LSB first)
 *   nodeIds[3+2bw+2]        = ovf output
 */
export function makeBehavioralCounterPresetAnalogFactory(): AnalogElementFactory {
  return (nodeIds, _branchIdx, props, _getTime) => {
    const pinSpecs = props.has("_pinElectrical")
      ? (props.get("_pinElectrical") as unknown as Record<string, ResolvedPinElectrical>)
      : undefined;

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

    // en
    const enPin = new DigitalInputPinModel(enSpec);
    enPin.init(nodeIds[0], 0);

    // C (clock)
    const clockPin = new DigitalInputPinModel(cSpec);
    clockPin.init(nodeIds[1], 0);

    // dir
    const dirPin = new DigitalInputPinModel(dirSpec);
    dirPin.init(nodeIds[2], 0);

    // in bits [3 .. 3+bitWidth-1]
    const inBitPins: DigitalInputPinModel[] = [];
    for (let bit = 0; bit < bitWidth; bit++) {
      const pin = new DigitalInputPinModel(inSpec);
      pin.init(nodeIds[3 + bit], 0);
      inBitPins.push(pin);
    }

    // ld
    const ldPin = new DigitalInputPinModel(ldSpec);
    ldPin.init(nodeIds[3 + bitWidth], 0);

    // clr
    const clrPin = new DigitalInputPinModel(clrSpec);
    clrPin.init(nodeIds[3 + bitWidth + 1], 0);

    // out bits [3+bitWidth+2 .. 3+2*bitWidth+1]
    const outBitPins: DigitalOutputPinModel[] = [];
    for (let bit = 0; bit < bitWidth; bit++) {
      const pin = new DigitalOutputPinModel(outSpec);
      pin.init(nodeIds[3 + bitWidth + 2 + bit], -1);
      outBitPins.push(pin);
    }

    // ovf
    const ovfPin = new DigitalOutputPinModel(ovfSpec);
    ovfPin.init(nodeIds[3 + 2 * bitWidth + 2], -1);

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
    );
  };
}

// ---------------------------------------------------------------------------

/**
 * Returns an analogFactory for N-bit parallel-load registers.
 *
 * nodeIds layout (matches RegisterDefinition pin declarations):
 *   nodeIds[0] = D input (single multi-bit pin in digital mode, but in analog
 *                each bit gets its own node — the compiler expands multi-bit
 *                pins). For behavioral mode the register treats the input as
 *                bitWidth individual 1-bit nodes.
 *   nodeIds[0..bitWidth-1] = D bit nodes (LSB first)
 *   nodeIds[bitWidth]   = C (clock) input
 *   nodeIds[bitWidth+1] = en input
 *   nodeIds[bitWidth+2..2*bitWidth+1] = Q bit output nodes (LSB first)
 */
export function makeBehavioralRegisterAnalogFactory(): AnalogElementFactory {
  return (nodeIds, _branchIdx, props, _getTime) => {
    const pinSpecs = props.has("_pinElectrical")
      ? (props.get("_pinElectrical") as unknown as Record<string, ResolvedPinElectrical>)
      : undefined;

    const bitWidth = (props.has("bitWidth") ? props.get("bitWidth") as number : undefined) ?? 8;

    const dSpec = pinSpecs?.["D"] ?? FALLBACK_SPEC;
    const cSpec = pinSpecs?.["C"] ?? FALLBACK_SPEC;
    const enSpec = pinSpecs?.["en"] ?? FALLBACK_SPEC;
    const qSpec = pinSpecs?.["Q"] ?? FALLBACK_SPEC;

    const dataPins: DigitalInputPinModel[] = [];
    for (let bit = 0; bit < bitWidth; bit++) {
      const pin = new DigitalInputPinModel(dSpec);
      pin.init(nodeIds[bit], 0);
      dataPins.push(pin);
    }

    const clockPin = new DigitalInputPinModel(cSpec);
    clockPin.init(nodeIds[bitWidth], 0);

    const enPin = new DigitalInputPinModel(enSpec);
    enPin.init(nodeIds[bitWidth + 1], 0);

    const outBitPins: DigitalOutputPinModel[] = [];
    for (let bit = 0; bit < bitWidth; bit++) {
      const pin = new DigitalOutputPinModel(qSpec);
      pin.init(nodeIds[bitWidth + 2 + bit], -1);
      outBitPins.push(pin);
    }

    return new BehavioralRegisterElement(
      dataPins,
      clockPin,
      enPin,
      outBitPins,
      bitWidth,
      cSpec.vIH,
      cSpec.vIL,
    );
  };
}
