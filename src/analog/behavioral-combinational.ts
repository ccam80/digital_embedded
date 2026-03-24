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
import type { AnalogElement, AnalogElementCore, IntegrationMethod } from "./element.js";
import type { PropertyBag } from "../core/properties.js";
import type { ResolvedPinElectrical } from "../core/pin-electrical.js";
import {
  DigitalInputPinModel,
  DigitalOutputPinModel,
  readMnaVoltage,
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
export class BehavioralMuxElement implements AnalogElementCore {
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

  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
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
      const voltage = readMnaVoltage(nodeId, v);
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
      const inputVoltage = readMnaVoltage(inputNodeId, v);
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
      p.updateCompanion(dt, method, readMnaVoltage(p.nodeId, voltages));
    }
    for (const group of this._dataPins) {
      for (const p of group) {
        p.updateCompanion(dt, method, readMnaVoltage(p.nodeId, voltages));
      }
    }
    for (const p of this._outPins) {
      p.updateCompanion(dt, method, readMnaVoltage(p.nodeId, voltages));
    }
  }

  /**
   * Compute per-pin currents from the MNA solution vector.
   *
   * Order: selector pins, data input groups (flattened), output pins.
   * Input pins: I = V_node / rIn
   * Output pins: I = (V_node - V_target) / rOut
   * The sum is nonzero — the residual is the implicit supply current.
   */
  getPinCurrents(voltages: Float64Array): number[] {
    const result: number[] = [];
    for (const p of this._selPins) {
      const v = readMnaVoltage(p.nodeId, voltages);
      result.push(v / p.rIn);
    }
    for (const group of this._dataPins) {
      for (const p of group) {
        const v = readMnaVoltage(p.nodeId, voltages);
        result.push(v / p.rIn);
      }
    }
    for (const p of this._outPins) {
      const v = readMnaVoltage(p.nodeId, voltages);
      result.push((v - p.currentVoltage) / p.rOut);
    }
    return result;
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
export class BehavioralDemuxElement implements AnalogElementCore {
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

  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
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
      const voltage = readMnaVoltage(nodeId, v);
      const level = this._selPins[b].readLogicLevel(voltage);
      if (level !== undefined) {
        if (level) sel |= 1 << b;
        else sel &= ~(1 << b);
      }
    }
    this._latchedSel = sel;

    // Read input level
    const inNodeId = this._inPin.nodeId;
    const inVoltage = readMnaVoltage(inNodeId, v);
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
      p.updateCompanion(dt, method, readMnaVoltage(p.nodeId, voltages));
    }
    this._inPin.updateCompanion(dt, method, readMnaVoltage(this._inPin.nodeId, voltages));
    for (const p of this._outPins) {
      p.updateCompanion(dt, method, readMnaVoltage(p.nodeId, voltages));
    }
  }

  /**
   * Compute per-pin currents from the MNA solution vector.
   *
   * Order: selector pins, input pin, output pins.
   * Input pins (sel, in): I = V_node / rIn
   * Output pins: I = (V_node - V_target) / rOut
   * The sum is nonzero — the residual is the implicit supply current.
   */
  getPinCurrents(voltages: Float64Array): number[] {
    const result: number[] = [];
    for (const p of this._selPins) {
      const v = readMnaVoltage(p.nodeId, voltages);
      result.push(v / p.rIn);
    }
    const vIn = readMnaVoltage(this._inPin.nodeId, voltages);
    result.push(vIn / this._inPin.rIn);
    for (const p of this._outPins) {
      const v = readMnaVoltage(p.nodeId, voltages);
      result.push((v - p.currentVoltage) / p.rOut);
    }
    return result;
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
export class BehavioralDecoderElement implements AnalogElementCore {
  private readonly _selPins: DigitalInputPinModel[];
  private readonly _outPins: DigitalOutputPinModel[];
  private readonly _outputCount: number;

  /** Latched selector value. */
  private _latchedSel = 0;

  /** Cached solver reference. */
  private _solver: SparseSolver | null = null;

  /** Cached operating-point voltages. */
  private _cachedVoltages: Float64Array = new Float64Array(0);

  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
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
      const voltage = readMnaVoltage(nodeId, v);
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
      p.updateCompanion(dt, method, readMnaVoltage(p.nodeId, voltages));
    }
    for (const p of this._outPins) {
      p.updateCompanion(dt, method, readMnaVoltage(p.nodeId, voltages));
    }
  }

  /**
   * Per-pin currents in pinNodeIds (pinLayout) order:
   *   [sel, out_0, out_1, ..., out_(N-1)]
   *
   * sel is an input: I = V_node / rIn (current into element).
   * out_i are outputs: I = (V_node - V_target) / rOut (current into element).
   * Sum is nonzero because behavioral outputs have an implicit supply.
   */
  getPinCurrents(voltages: Float64Array): number[] {
    const result: number[] = [];
    // sel pin (input) — all selPins share the same node; use first
    const selPin = this._selPins[0];
    if (selPin !== undefined) {
      const vSel = readMnaVoltage(selPin.nodeId, voltages);
      result.push(vSel / selPin.rIn);
    }
    // output pins
    for (const p of this._outPins) {
      const vNode = readMnaVoltage(p.nodeId, voltages);
      result.push((vNode - p.currentVoltage) / p.rOut);
    }
    return result;
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
 * Pin layout matches buildMuxPinDeclarations:
 *   "sel"              = selector input (multi-bit bus — one MNA node)
 *   "in_0".."in_(N-1)" = data inputs (each multi-bit bus — one MNA node each)
 *   "out"              = output (multi-bit bus — one MNA node)
 *
 * All per-bit pin model arrays share the single bus node for their label.
 */
export function makeBehavioralMuxAnalogFactory(selectorBits: number): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
    const bitWidth = props.has("bitWidth") ? (props.get("bitWidth") as number) : 1;
    const inputCount = 1 << selectorBits;

    // All selector bit pins share the single "sel" bus node
    const selNodeId = pinNodes.get("sel") ?? 0;
    const selSpec = resolveSpec(props, "sel");
    const selPins: DigitalInputPinModel[] = [];
    for (let b = 0; b < selectorBits; b++) {
      const pin = new DigitalInputPinModel(selSpec);
      pin.init(selNodeId, 0);
      selPins.push(pin);
    }

    // Each data input group shares its own "in_i" bus node
    const dataPins: DigitalInputPinModel[][] = [];
    for (let i = 0; i < inputCount; i++) {
      const inNodeId = pinNodes.get(`in_${i}`) ?? 0;
      const spec = resolveSpec(props, `in_${i}`);
      const group: DigitalInputPinModel[] = [];
      for (let bit = 0; bit < bitWidth; bit++) {
        const pin = new DigitalInputPinModel(spec);
        pin.init(inNodeId, 0);
        group.push(pin);
      }
      dataPins.push(group);
    }

    // All output bit pins share the single "out" bus node
    const outNodeId = pinNodes.get("out") ?? 0;
    const outSpec = resolveSpec(props, "out");
    const outPins: DigitalOutputPinModel[] = [];
    for (let bit = 0; bit < bitWidth; bit++) {
      const pin = new DigitalOutputPinModel(outSpec);
      pin.init(outNodeId, -1);
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
 * Pin layout matches buildDemuxPinDeclarations:
 *   "sel"              = selector input (multi-bit bus — one MNA node)
 *   "out_0".."out_(N-1)" = outputs (each 1-bit — one MNA node each)
 *   "in"               = data input (multi-bit bus — one MNA node)
 *
 * All selector bit pins share the single "sel" bus node.
 */
export function makeBehavioralDemuxAnalogFactory(selectorBits: number): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
    const outputCount = 1 << selectorBits;

    // All selector bit pins share the single "sel" bus node
    const selNodeId = pinNodes.get("sel") ?? 0;
    const selSpec = resolveSpec(props, "sel");
    const selPins: DigitalInputPinModel[] = [];
    for (let b = 0; b < selectorBits; b++) {
      const pin = new DigitalInputPinModel(selSpec);
      pin.init(selNodeId, 0);
      selPins.push(pin);
    }

    // Each output pin has its own "out_i" node (1-bit pins)
    const outPins: DigitalOutputPinModel[] = [];
    for (let i = 0; i < outputCount; i++) {
      const spec = resolveSpec(props, `out_${i}`);
      const pin = new DigitalOutputPinModel(spec);
      pin.init(pinNodes.get(`out_${i}`) ?? 0, -1);
      outPins.push(pin);
    }

    // Input pin
    const inSpec = resolveSpec(props, "in");
    const inPin = new DigitalInputPinModel(inSpec);
    inPin.init(pinNodes.get("in") ?? 0, 0);

    return new BehavioralDemuxElement(selPins, inPin, outPins, outputCount);
  };
}

// ---------------------------------------------------------------------------
// makeBehavioralDecoderAnalogFactory
// ---------------------------------------------------------------------------

/**
 * Returns an analogFactory for a decoder with the given selectorBits.
 *
 * Pin layout matches buildDecoderPinDeclarations:
 *   "sel"              = selector input (multi-bit bus — one MNA node)
 *   "out_0".."out_(N-1)" = outputs (each 1-bit — one MNA node each)
 *
 * All selector bit pins share the single "sel" bus node.
 * Decoder outputs are always 1-bit (no bitWidth property).
 */
export function makeBehavioralDecoderAnalogFactory(selectorBits: number): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
    const outputCount = 1 << selectorBits;

    // All selector bit pins share the single "sel" bus node
    const selNodeId = pinNodes.get("sel") ?? 0;
    const selSpec = resolveSpec(props, "sel");
    const selPins: DigitalInputPinModel[] = [];
    for (let b = 0; b < selectorBits; b++) {
      const pin = new DigitalInputPinModel(selSpec);
      pin.init(selNodeId, 0);
      selPins.push(pin);
    }

    // Each output pin has its own "out_i" node (1-bit pins)
    const outPins: DigitalOutputPinModel[] = [];
    for (let i = 0; i < outputCount; i++) {
      const spec = resolveSpec(props, `out_${i}`);
      const pin = new DigitalOutputPinModel(spec);
      pin.init(pinNodes.get(`out_${i}`) ?? 0, -1);
      outPins.push(pin);
    }

    return new BehavioralDecoderElement(selPins, outPins, outputCount);
  };
}
