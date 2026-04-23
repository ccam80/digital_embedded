/**
 * BehavioralGateElement — parameterized analog behavioral model for
 * combinational digital gates.
 *
 * Wraps N DigitalInputPinModels and 1 DigitalOutputPinModel around a truth
 * table function. A single class handles NOT, AND, NAND, OR, NOR, XOR and any
 * other combinational gate via parameterization.
 *
 * Threshold detection inside load() makes the element nonlinear.
 * Pin capacitances require companion models, making it reactive.
 *
 * Indeterminate inputs (voltage between vIL and vIH) latch to the previous
 * logic level so the output does not oscillate when an input slowly crosses a
 * threshold.
 */

import type { AnalogElementCore, LoadContext } from "./element.js";
import type { PropertyBag } from "../../core/properties.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import {
  DigitalInputPinModel,
  DigitalOutputPinModel,
  readMnaVoltage,
  delegatePinSetParam,
} from "./digital-pin-model.js";

// ---------------------------------------------------------------------------
// GateTruthTable — pure function mapping logic levels to output
// ---------------------------------------------------------------------------

/** Maps N input logic levels to a single output logic level. */
export type GateTruthTable = (inputs: boolean[]) => boolean;

// ---------------------------------------------------------------------------
// AnalogElementFactory — type alias used by ComponentDefinition
// ---------------------------------------------------------------------------

/**
 * Factory function signature for analog element creation.
 *
 * Called by the analog compiler for each component instance.
 *   pinNodes       — label → MNA node ID map, one entry per pin in pinLayout order.
 *   internalNodeIds — factory-private MNA node IDs (not pins); positional indexing
 *                    within this array is acceptable because the factory both
 *                    declared the count and consumes them.
 *   branchIdx      — MNA branch-current row index (-1 if none).
 */
export type AnalogElementFactory = (
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  branchIdx: number,
  props: PropertyBag,
  getTime: () => number,
) => AnalogElementCore;

// ---------------------------------------------------------------------------
// BehavioralGateElement
// ---------------------------------------------------------------------------

/**
 * Analog behavioral model for a combinational digital gate.
 *
 * Unified load() protocol (ngspice DEVload):
 *   load()   — delegates input/output pin stamping to pin models, evaluates
 *              the truth table from current NR-iterate voltages.
 *   accept() — delegates companion state update to pin models after each
 *              accepted timestep.
 */
export class BehavioralGateElement implements AnalogElementCore {
  private readonly _inputs: DigitalInputPinModel[];
  private readonly _output: DigitalOutputPinModel;
  private readonly _truthTable: GateTruthTable;
  private readonly _pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>;

  /** Latched logic levels per input — persist across timesteps. */
  private readonly _latchedLevels: boolean[];

  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: true = true;
  readonly isReactive: true = true;
  label?: string;

  constructor(
    inputs: DigitalInputPinModel[],
    output: DigitalOutputPinModel,
    truthTable: GateTruthTable,
    pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>,
  ) {
    this._inputs = inputs;
    this._output = output;
    this._truthTable = truthTable;
    this._latchedLevels = new Array<boolean>(inputs.length).fill(false);
    this._pinModelsByLabel = pinModelsByLabel;
  }

  load(ctx: LoadContext): void {
    const voltages = ctx.rhsOld;

    // Evaluate each input's logic level from the current NR iterate, latching
    // on indeterminate to prevent oscillation as inputs traverse the threshold.
    for (let i = 0; i < this._inputs.length; i++) {
      const nodeId = this._inputs[i].nodeId;
      const voltage = readMnaVoltage(nodeId, voltages);
      const level = this._inputs[i].readLogicLevel(voltage);
      if (level !== undefined) {
        this._latchedLevels[i] = level;
      }
    }

    const outputBit = this._truthTable(this._latchedLevels);
    this._output.setLogicLevel(outputBit);

    // Delegate stamping to pin models.
    for (const inp of this._inputs) {
      inp.load(ctx);
    }
    this._output.load(ctx);
  }

  accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
    if (ctx.dt <= 0) return;
    const voltages = ctx.rhs;
    for (const inp of this._inputs) {
      const v = readMnaVoltage(inp.nodeId, voltages);
      inp.accept(ctx, v);
    }
    const vOut = readMnaVoltage(this._output.nodeId, voltages);
    this._output.accept(ctx, vOut);
  }

  /**
   * Compute per-pin currents from the MNA solution vector.
   *
   * Input pins: I = V_node / rIn (current into element through loading conductance)
   * Output pin: I = (V_node - V_target) / rOut (Norton equivalent current into element)
   * The sum is nonzero — the residual is the implicit supply current.
   *
   * Returns one entry per pin in pinLayout order: [In_1, ..., In_N, out].
   */
  getPinCurrents(voltages: Float64Array): number[] {
    const result: number[] = [];
    for (const inp of this._inputs) {
      const v = readMnaVoltage(inp.nodeId, voltages);
      result.push(v / inp.rIn);
    }
    const vOut = readMnaVoltage(this._output.nodeId, voltages);
    result.push((vOut - this._output.currentVoltage) / this._output.rOut);
    return result;
  }

  setParam(key: string, value: number): void {
    delegatePinSetParam(this._pinModelsByLabel, key, value);
  }
}

// ---------------------------------------------------------------------------
// Truth table helpers
// ---------------------------------------------------------------------------

function andTruth(inputs: boolean[]): boolean {
  return inputs.every(Boolean);
}

function nandTruth(inputs: boolean[]): boolean {
  return !inputs.every(Boolean);
}

function orTruth(inputs: boolean[]): boolean {
  return inputs.some(Boolean);
}

function norTruth(inputs: boolean[]): boolean {
  return !inputs.some(Boolean);
}

function xorTruth(inputs: boolean[]): boolean {
  let count = 0;
  for (const v of inputs) {
    if (v) count++;
  }
  return count % 2 === 1;
}

function xnorTruth(inputs: boolean[]): boolean {
  return !xorTruth(inputs);
}

function notTruth(inputs: boolean[]): boolean {
  return !inputs[0];
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/**
 * Build input and output pin models from the resolved electrical specs in
 * props, then construct a BehavioralGateElement.
 *
 * The compiler injects resolved specs via props._pinElectrical keyed by pin
 * label. Input pins are labelled "In_1", "In_2", ... (matching the gate's
 * PinDeclaration labels). The output pin is labelled "out".
 *
 * Falls back to CMOS 3.3V defaults when _pinElectrical is absent (allows
 * tests to call factories without a full compiler context).
 *
 * When inputCount is 0, reads the count from props.inputCount (defaulting to
 * 2) — used by multi-input gate factories where the count is instance-defined.
 */
function buildGateElement(
  pinNodes: ReadonlyMap<string, number>,
  inputCount: number,
  truthTable: GateTruthTable,
  props: PropertyBag,
): BehavioralGateElement {
  // When inputCount is 0, resolve from instance props (for variable-input gates)
  if (inputCount === 0) {
    inputCount = (props.has("inputCount")
      ? (props.get("inputCount") as number)
      : 2);
  }
  const pinSpecs = props.has("_pinElectrical")
    ? (props.get("_pinElectrical") as unknown as Record<string, ResolvedPinElectrical>)
    : undefined;

  const pinLoading = props.has("_pinLoading")
    ? (props.get("_pinLoading") as unknown as Record<string, boolean>)
    : {} as Record<string, boolean>;

  const fallback: ResolvedPinElectrical = {
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

  const pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>();

  const inputPins: DigitalInputPinModel[] = [];
  for (let i = 0; i < inputCount; i++) {
    const label = `In_${i + 1}`;
    const spec = pinSpecs?.[label] ?? fallback;
    const loaded = pinLoading[label] ?? true;
    const pin = new DigitalInputPinModel(spec, loaded);
    pin.init(pinNodes.get(label) ?? 0, 0);
    inputPins.push(pin);
    pinModelsByLabel.set(label, pin);
  }

  const outSpec = pinSpecs?.["out"] ?? fallback;
  const outLoaded = pinLoading["out"] ?? false;
  const outputPin = new DigitalOutputPinModel(outSpec, outLoaded, "direct");
  outputPin.init(pinNodes.get("out") ?? 0, -1);
  pinModelsByLabel.set("out", outputPin);

  return new BehavioralGateElement(inputPins, outputPin, truthTable, pinModelsByLabel);
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Returns an analogFactory closure for NOT gates (always 1 input).
 */
export function makeNotAnalogFactory(): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) =>
    buildGateElement(pinNodes, 1, notTruth, props);
}

/**
 * Returns an analogFactory closure for AND gates.
 *
 * When called with inputCount=0 the factory reads inputCount from props
 * at instantiation time (supports variable-input-count gates in the registry).
 */
export function makeAndAnalogFactory(inputCount: number): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) =>
    buildGateElement(pinNodes, inputCount, andTruth, props);
}

/**
 * Returns an analogFactory closure for NAND gates.
 */
export function makeNandAnalogFactory(
  inputCount: number,
): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) =>
    buildGateElement(pinNodes, inputCount, nandTruth, props);
}

/**
 * Returns an analogFactory closure for OR gates.
 */
export function makeOrAnalogFactory(inputCount: number): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) =>
    buildGateElement(pinNodes, inputCount, orTruth, props);
}

/**
 * Returns an analogFactory closure for NOR gates.
 */
export function makeNorAnalogFactory(inputCount: number): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) =>
    buildGateElement(pinNodes, inputCount, norTruth, props);
}

/**
 * Returns an analogFactory closure for XOR gates.
 */
export function makeXorAnalogFactory(inputCount: number): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) =>
    buildGateElement(pinNodes, inputCount, xorTruth, props);
}

/**
 * Returns an analogFactory closure for XNOR gates.
 *
 * Uses XNOR truth table (XOR output inverted): true when an even number of
 * inputs are HIGH.
 */
export function makeXnorAnalogFactory(
  inputCount: number,
): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) =>
    buildGateElement(pinNodes, inputCount, xnorTruth, props);
}
