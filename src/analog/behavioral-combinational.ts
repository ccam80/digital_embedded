/**
 * Behavioral analog models for combinational digital components:
 * multiplexer, demultiplexer, and decoder.
 *
 * All three are purely combinational — they evaluate in stampNonlinear()
 * every NR iteration. Selector bits are read via threshold detection, the
 * appropriate data routing is performed, and output pin Norton equivalents
 * are re-stamped immediately.
 *
 * No edge detection is needed. No updateCompanion() logic gate.
 * Pin capacitance companion models are stamped in stampCompanion() and
 * updated in updateCompanion() for each output and input pin.
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
// Shared fallback electrical spec (CMOS 3.3 V defaults)
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
// BehavioralMuxElement
// ---------------------------------------------------------------------------

/**
 * Analog behavioral model for a multiplexer.
 *
 * Pin layout (nodeIds order, matching buildMuxPinDeclarations):
 *   nodeIds[0]             = sel (selectorBits-wide input — read as integer)
 *   nodeIds[1..inputCount] = in_0 .. in_(N-1) (data inputs)
 *   nodeIds[inputCount+1]  = out (single output)
 *
 * For multi-bit data (bitWidth > 1), each nodeId represents one circuit node
 * corresponding to one bit of the bus. The selector picks which data-input
 * group to route to the output.
 *
 * Selector decoding: each selector bit has its own DigitalInputPinModel.
 * The sel pin nodeId is treated as the first node; additional selector bit
 * nodes follow immediately.
 */
export class BehavioralMuxElement implements AnalogElement {
  private readonly _selPins: DigitalInputPinModel[];
  private readonly _dataPins: DigitalInputPinModel[][];
  private readonly _outPins: DigitalOutputPinModel[];
  private readonly _inputCount: number;
  private readonly _bitWidth: number;

  /** Latched selector value — persists across timesteps. */
  private _latchedSel = 0;

  /** Cached solver reference. */
  private _solver: SparseSolver | null = null;

  /** Cached operating-point voltages. */
  private _cachedVoltages: Float64Array = new Float64Array(0);

  readonly nodeIndices: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: true = true;
  readonly isReactive: true = true;
  label?: string;

  constructor(
    selPins: DigitalInputPinModel[],
    dataPins: DigitalInputPinModel[][],
    outPins: DigitalOutputPinModel[],
    inputCount: number,
    bitWidth: number,
  ) {
    this._selPins = selPins;
    this._dataPins = dataPins;
    this._outPins = outPins;
    this._inputCount = inputCount;
    this._bitWidth = bitWidth;

    const indices: number[] = [];
    for (const p of selPins) indices.push(p.nodeId);
    for (const group of dataPins) {
      for (const p of group) indices.push(p.nodeId);
    }
    for (const p of outPins) indices.push(p.nodeId);
    this.nodeIndices = indices;
  }

  stamp(solver: SparseSolver): void {
    this._solver = solver;
    for (const p of this._selPins) p.stamp(solver);
    for (const group of this._dataPins) {
      for (const p of group) p.stamp(solver);
    }
  }

  stampNonlinear(solver: SparseSolver): void {
    this._solver = solver;
    const v = this._cachedVoltages;

    // Decode selector bits into an integer
    let sel = 0;
    for (let b = 0; b < this._selPins.length; b++) {
      const nodeId = this._selPins[b].nodeId;
      const voltage = nodeId < v.length ? v[nodeId] : 0;
      const level = this._selPins[b].readLogicLevel(voltage);
      if (level !== undefined) {
        if (level) sel |= 1 << b;
        else sel &= ~(1 << b);
      }
    }
    this._latchedSel = sel;

    const selectedGroup = this._dataPins[sel] ?? this._dataPins[0];

    for (let bit = 0; bit < this._bitWidth; bit++) {
      const inputPin = selectedGroup[bit];
      const inputNodeId = inputPin.nodeId;
      const inputVoltage = inputNodeId < v.length ? v[inputNodeId] : 0;
      const level = inputPin.readLogicLevel(inputVoltage);
      const outLevel = level ?? false;
      this._outPins[bit].setLogicLevel(outLevel);
      this._outPins[bit].stamp(solver);
    }
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
    for (const p of this._selPins) p.stampCompanion(solver, dt, method);
    for (const group of this._dataPins) {
      for (const p of group) p.stampCompanion(solver, dt, method);
    }
    for (const p of this._outPins) p.stampCompanion(solver, dt, method);
  }

  updateCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    for (const p of this._selPins) {
      const v = p.nodeId < voltages.length ? voltages[p.nodeId] : 0;
      p.updateCompanion(dt, method, v);
    }
    for (const group of this._dataPins) {
      for (const p of group) {
        const v = p.nodeId < voltages.length ? voltages[p.nodeId] : 0;
        p.updateCompanion(dt, method, v);
      }
    }
    for (const p of this._outPins) {
      const v = p.nodeId < voltages.length ? voltages[p.nodeId] : 0;
      p.updateCompanion(dt, method, v);
    }
  }
}

// ---------------------------------------------------------------------------
// BehavioralDemuxElement
// ---------------------------------------------------------------------------

/**
 * Analog behavioral model for a demultiplexer.
 *
 * Pin layout (nodeIds order, matching buildDemuxPinDeclarations):
 *   nodeIds[0]                    = sel (selectorBits-wide)
 *   nodeIds[1..outputCount]       = out_0 .. out_(N-1) (outputs)
 *   nodeIds[outputCount+1]        = in (data input)
 *
 * The selected output receives the input signal level; all other outputs
 * are driven LOW (vOL).
 */
export class BehavioralDemuxElement implements AnalogElement {
  private readonly _selPins: DigitalInputPinModel[];
  private readonly _inPin: DigitalInputPinModel;
  private readonly _outPins: DigitalOutputPinModel[];
  private readonly _outputCount: number;

  /** Latched selector value. */
  private _latchedSel = 0;

  /** Cached solver reference. */
  private _solver: SparseSolver | null = null;

  /** Cached operating-point voltages. */
  private _cachedVoltages: Float64Array = new Float64Array(0);

  readonly nodeIndices: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: true = true;
  readonly isReactive: true = true;
  label?: string;

  constructor(
    selPins: DigitalInputPinModel[],
    inPin: DigitalInputPinModel,
    outPins: DigitalOutputPinModel[],
    outputCount: number,
  ) {
    this._selPins = selPins;
    this._inPin = inPin;
    this._outPins = outPins;
    this._outputCount = outputCount;

    const indices: number[] = [];
    for (const p of selPins) indices.push(p.nodeId);
    indices.push(inPin.nodeId);
    for (const p of outPins) indices.push(p.nodeId);
    this.nodeIndices = indices;
  }

  stamp(solver: SparseSolver): void {
    this._solver = solver;
    for (const p of this._selPins) p.stamp(solver);
    this._inPin.stamp(solver);
  }

  stampNonlinear(solver: SparseSolver): void {
    this._solver = solver;
    const v = this._cachedVoltages;

    // Decode selector
    let sel = 0;
    for (let b = 0; b < this._selPins.length; b++) {
      const nodeId = this._selPins[b].nodeId;
      const voltage = nodeId < v.length ? v[nodeId] : 0;
      const level = this._selPins[b].readLogicLevel(voltage);
      if (level !== undefined) {
        if (level) sel |= 1 << b;
        else sel &= ~(1 << b);
      }
    }
    this._latchedSel = sel;

    // Read input level
    const inNodeId = this._inPin.nodeId;
    const inVoltage = inNodeId < v.length ? v[inNodeId] : 0;
    const inLevel = this._inPin.readLogicLevel(inVoltage) ?? false;

    // Route: selected output gets input level, all others get LOW
    for (let i = 0; i < this._outputCount; i++) {
      this._outPins[i].setLogicLevel(i === sel ? inLevel : false);
      this._outPins[i].stamp(solver);
    }
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
    for (const p of this._selPins) p.stampCompanion(solver, dt, method);
    this._inPin.stampCompanion(solver, dt, method);
    for (const p of this._outPins) p.stampCompanion(solver, dt, method);
  }

  updateCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    for (const p of this._selPins) {
      const v = p.nodeId < voltages.length ? voltages[p.nodeId] : 0;
      p.updateCompanion(dt, method, v);
    }
    const inV = this._inPin.nodeId < voltages.length ? voltages[this._inPin.nodeId] : 0;
    this._inPin.updateCompanion(dt, method, inV);
    for (const p of this._outPins) {
      const v = p.nodeId < voltages.length ? voltages[p.nodeId] : 0;
      p.updateCompanion(dt, method, v);
    }
  }
}

// ---------------------------------------------------------------------------
// BehavioralDecoderElement
// ---------------------------------------------------------------------------

/**
 * Analog behavioral model for a decoder.
 *
 * Pin layout (nodeIds order, matching buildDecoderPinDeclarations):
 *   nodeIds[0]               = sel (selectorBits-wide input)
 *   nodeIds[1..outputCount]  = out_0 .. out_(N-1)
 *
 * Exactly one output is driven HIGH (the one indexed by the selector value);
 * all others are driven LOW.
 */
export class BehavioralDecoderElement implements AnalogElement {
  private readonly _selPins: DigitalInputPinModel[];
  private readonly _outPins: DigitalOutputPinModel[];
  private readonly _outputCount: number;

  /** Latched selector value. */
  private _latchedSel = 0;

  /** Cached solver reference. */
  private _solver: SparseSolver | null = null;

  /** Cached operating-point voltages. */
  private _cachedVoltages: Float64Array = new Float64Array(0);

  readonly nodeIndices: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: true = true;
  readonly isReactive: true = true;
  label?: string;

  constructor(
    selPins: DigitalInputPinModel[],
    outPins: DigitalOutputPinModel[],
    outputCount: number,
  ) {
    this._selPins = selPins;
    this._outPins = outPins;
    this._outputCount = outputCount;

    const indices: number[] = [];
    for (const p of selPins) indices.push(p.nodeId);
    for (const p of outPins) indices.push(p.nodeId);
    this.nodeIndices = indices;
  }

  stamp(solver: SparseSolver): void {
    this._solver = solver;
    for (const p of this._selPins) p.stamp(solver);
  }

  stampNonlinear(solver: SparseSolver): void {
    this._solver = solver;
    const v = this._cachedVoltages;

    // Decode selector
    let sel = 0;
    for (let b = 0; b < this._selPins.length; b++) {
      const nodeId = this._selPins[b].nodeId;
      const voltage = nodeId < v.length ? v[nodeId] : 0;
      const level = this._selPins[b].readLogicLevel(voltage);
      if (level !== undefined) {
        if (level) sel |= 1 << b;
        else sel &= ~(1 << b);
      }
    }
    this._latchedSel = sel;

    // One-hot output: only the selected index is HIGH
    for (let i = 0; i < this._outputCount; i++) {
      this._outPins[i].setLogicLevel(i === sel);
      this._outPins[i].stamp(solver);
    }
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
    for (const p of this._selPins) p.stampCompanion(solver, dt, method);
    for (const p of this._outPins) p.stampCompanion(solver, dt, method);
  }

  updateCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    for (const p of this._selPins) {
      const v = p.nodeId < voltages.length ? voltages[p.nodeId] : 0;
      p.updateCompanion(dt, method, v);
    }
    for (const p of this._outPins) {
      const v = p.nodeId < voltages.length ? voltages[p.nodeId] : 0;
      p.updateCompanion(dt, method, v);
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: resolve pin electrical spec from props
// ---------------------------------------------------------------------------

function resolveSpec(
  props: PropertyBag,
  pinLabel: string,
): ResolvedPinElectrical {
  const pinSpecs = props.has("_pinElectrical")
    ? (props.get("_pinElectrical") as unknown as Record<string, ResolvedPinElectrical>)
    : undefined;
  return pinSpecs?.[pinLabel] ?? FALLBACK_SPEC;
}

// ---------------------------------------------------------------------------
// makeBehavioralMuxAnalogFactory
// ---------------------------------------------------------------------------

/**
 * Returns an analogFactory for a multiplexer with the given selectorBits.
 *
 * nodeIds layout (matches buildMuxPinDeclarations with bitWidth=1):
 *   nodeIds[0]             = sel node
 *   nodeIds[1..inputCount] = in_0 .. in_(N-1) data input nodes
 *   nodeIds[inputCount+1]  = out node
 *
 * For selectorBits > 1 the sel pin is multi-bit. The MNA compiler assigns
 * one node per bit of a bus pin; for a selectorBits-wide selector pin the
 * compiler provides selectorBits consecutive node IDs starting at nodeIds[0].
 * Each data input also spans bitWidth nodes. This factory reads selectorBits
 * and bitWidth from props (defaults 1).
 */
export function makeBehavioralMuxAnalogFactory(selectorBits: number): AnalogElementFactory {
  return (nodeIds, _branchIdx, props, _getTime) => {
    const bitWidth = props.has("bitWidth") ? (props.get("bitWidth") as number) : 1;
    const inputCount = 1 << selectorBits;

    // Build selector pin models (one per selector bit node)
    const selPins: DigitalInputPinModel[] = [];
    for (let b = 0; b < selectorBits; b++) {
      const spec = resolveSpec(props, b === 0 ? "sel" : `sel_${b}`);
      const pin = new DigitalInputPinModel(spec);
      pin.init(nodeIds[b], 0);
      selPins.push(pin);
    }

    // Build data input pin models: inputCount groups, each bitWidth wide
    let nodeIdx = selectorBits;
    const dataPins: DigitalInputPinModel[][] = [];
    for (let i = 0; i < inputCount; i++) {
      const group: DigitalInputPinModel[] = [];
      for (let bit = 0; bit < bitWidth; bit++) {
        const spec = resolveSpec(props, `in_${i}`);
        const pin = new DigitalInputPinModel(spec);
        pin.init(nodeIds[nodeIdx++], 0);
        group.push(pin);
      }
      dataPins.push(group);
    }

    // Build output pin models (bitWidth wide)
    const outPins: DigitalOutputPinModel[] = [];
    for (let bit = 0; bit < bitWidth; bit++) {
      const spec = resolveSpec(props, "out");
      const pin = new DigitalOutputPinModel(spec);
      pin.init(nodeIds[nodeIdx++], -1);
      outPins.push(pin);
    }

    return new BehavioralMuxElement(selPins, dataPins, outPins, inputCount, bitWidth);
  };
}

// ---------------------------------------------------------------------------
// makeBehavioralDemuxAnalogFactory
// ---------------------------------------------------------------------------

/**
 * Returns an analogFactory for a demultiplexer with the given selectorBits.
 *
 * nodeIds layout (matches buildDemuxPinDeclarations with bitWidth=1):
 *   nodeIds[0]                 = sel node
 *   nodeIds[1..outputCount]    = out_0 .. out_(N-1) output nodes
 *   nodeIds[outputCount+1]     = in data input node
 *
 * The sel pin may be selectorBits-wide; the compiler provides one nodeId per
 * selector bit starting at nodeIds[0]. The in and out pins are bitWidth wide.
 */
export function makeBehavioralDemuxAnalogFactory(selectorBits: number): AnalogElementFactory {
  return (nodeIds, _branchIdx, props, _getTime) => {
    const bitWidth = props.has("bitWidth") ? (props.get("bitWidth") as number) : 1;
    const outputCount = 1 << selectorBits;

    // Selector pin models
    const selPins: DigitalInputPinModel[] = [];
    for (let b = 0; b < selectorBits; b++) {
      const spec = resolveSpec(props, b === 0 ? "sel" : `sel_${b}`);
      const pin = new DigitalInputPinModel(spec);
      pin.init(nodeIds[b], 0);
      selPins.push(pin);
    }

    // Output pin models: outputCount groups, each bitWidth wide (but for bitWidth=1 just outputCount pins)
    let nodeIdx = selectorBits;
    const outPins: DigitalOutputPinModel[] = [];
    for (let i = 0; i < outputCount; i++) {
      const spec = resolveSpec(props, `out_${i}`);
      const pin = new DigitalOutputPinModel(spec);
      pin.init(nodeIds[nodeIdx++], -1);
      outPins.push(pin);
    }

    // Input pin model
    const inSpec = resolveSpec(props, "in");
    const inPin = new DigitalInputPinModel(inSpec);
    inPin.init(nodeIds[nodeIdx], 0);

    return new BehavioralDemuxElement(selPins, inPin, outPins, outputCount);
  };
}

// ---------------------------------------------------------------------------
// makeBehavioralDecoderAnalogFactory
// ---------------------------------------------------------------------------

/**
 * Returns an analogFactory for a decoder with the given selectorBits.
 *
 * nodeIds layout (matches buildDecoderPinDeclarations):
 *   nodeIds[0]               = sel node (selectorBits-wide)
 *   nodeIds[selectorBits..selectorBits+outputCount-1] = out_0 .. out_(N-1)
 *
 * Decoder outputs are always 1-bit (no bitWidth property).
 */
export function makeBehavioralDecoderAnalogFactory(selectorBits: number): AnalogElementFactory {
  return (nodeIds, _branchIdx, props, _getTime) => {
    const outputCount = 1 << selectorBits;

    // Selector pin models (one per selector bit)
    const selPins: DigitalInputPinModel[] = [];
    for (let b = 0; b < selectorBits; b++) {
      const spec = resolveSpec(props, b === 0 ? "sel" : `sel_${b}`);
      const pin = new DigitalInputPinModel(spec);
      pin.init(nodeIds[b], 0);
      selPins.push(pin);
    }

    // Output pin models
    let nodeIdx = selectorBits;
    const outPins: DigitalOutputPinModel[] = [];
    for (let i = 0; i < outputCount; i++) {
      const spec = resolveSpec(props, `out_${i}`);
      const pin = new DigitalOutputPinModel(spec);
      pin.init(nodeIds[nodeIdx++], -1);
      outPins.push(pin);
    }

    return new BehavioralDecoderElement(selPins, outPins, outputCount);
  };
}
