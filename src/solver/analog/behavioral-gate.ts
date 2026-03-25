/**
 * BehavioralGateElement — parameterized analog behavioral model for
 * combinational digital gates.
 *
 * Wraps N DigitalInputPinModels and 1 DigitalOutputPinModel around a truth
 * table function. A single class handles NOT, AND, NAND, OR, NOR, XOR and any
 * other combinational gate via parameterization.
 *
 * Threshold detection in stampNonlinear() makes the element nonlinear.
 * Pin capacitances require companion models, making it reactive.
 *
 * Indeterminate inputs (voltage between vIL and vIH) latch to the previous
 * logic level so the output does not oscillate when an input slowly crosses a
 * threshold.
 */

import type { SparseSolver } from "./sparse-solver.js";
import type { AnalogElement, AnalogElementCore, IntegrationMethod } from "./element.js";
import type { PropertyBag } from "../../core/properties.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import {
  DigitalInputPinModel,
  DigitalOutputPinModel,
  readMnaVoltage,
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
 * Stamp protocol:
 *   stamp()              — stamps input R_in and output R_out/V_out (linear)
 *   stampNonlinear()     — uses cached voltages from updateOperatingPoint to
 *                          evaluate the truth table and re-stamp the output
 *   stampCompanion()     — stamps pin capacitance companion models
 *   updateOperatingPoint() — caches latest solution voltages for stampNonlinear
 *   updateCompanion()    — updates pin companion state after accepted timestep
 */
export class BehavioralGateElement implements AnalogElementCore {
  private readonly _inputs: DigitalInputPinModel[];
  private readonly _output: DigitalOutputPinModel;
  private readonly _truthTable: GateTruthTable;

  /** Latched logic levels per input — persist across timesteps. */
  private readonly _latchedLevels: boolean[];

  /**
   * Cached node voltages from the most recent updateOperatingPoint call.
   * Used by stampNonlinear to evaluate the truth table without needing to
   * read from the solver directly.
   */
  private _cachedVoltages: Float64Array = new Float64Array(0);

  /** Cached solver reference — set on first stamp() call. */
  private _solver: SparseSolver | null = null;

  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: true = true;
  readonly isReactive: true = true;
  label?: string;

  constructor(
    inputs: DigitalInputPinModel[],
    output: DigitalOutputPinModel,
    truthTable: GateTruthTable,
  ) {
    this._inputs = inputs;
    this._output = output;
    this._truthTable = truthTable;
    this._latchedLevels = new Array<boolean>(inputs.length).fill(false);
  }

  /**
   * Stamp linear contributions: input loading resistances only.
   *
   * The output Norton equivalent is fully stamped in stampNonlinear because
   * both the conductance (1/rOut) and the current source (V_out/rOut) are
   * topology-constant and logic-level-dependent respectively. Since
   * beginAssembly clears the matrix before each NR iteration, it is correct
   * and simpler to stamp the entire output in stampNonlinear.
   *
   * Caches the solver reference for use in stampCompanion().
   */
  stamp(solver: SparseSolver): void {
    this._solver = solver;
    for (const inp of this._inputs) {
      inp.stamp(solver);
    }
  }

  /**
   * Evaluate the truth table at the cached operating-point voltages and
   * re-stamp the output Norton equivalent.
   *
   * For each input:
   *   - Read the cached node voltage (set by updateOperatingPoint).
   *   - Apply threshold detection via readLogicLevel().
   *   - If indeterminate, keep the current latched level.
   *   - If clearly HIGH or LOW, update the latch.
   *
   * Then call truthTable(latchedLevels) and update the output logic level.
   * Re-stamp the output so the Norton current source reflects the new state.
   */
  stampNonlinear(solver: SparseSolver): void {
    this._solver = solver;
    const v = this._cachedVoltages;

    for (let i = 0; i < this._inputs.length; i++) {
      const nodeId = this._inputs[i].nodeId;
      const voltage = readMnaVoltage(nodeId, v);
      const level = this._inputs[i].readLogicLevel(voltage);
      if (level !== undefined) {
        this._latchedLevels[i] = level;
      }
    }

    const outputBit = this._truthTable(this._latchedLevels);
    this._output.setLogicLevel(outputBit);
    this._output.stamp(solver);
  }

  /**
   * Cache the current NR solution voltages for use in stampNonlinear.
   *
   * Called after each NR iteration. Grows the cache array lazily to match
   * the solution vector size.
   */
  updateOperatingPoint(voltages: Float64Array): void {
    if (this._cachedVoltages.length !== voltages.length) {
      this._cachedVoltages = new Float64Array(voltages.length);
    }
    this._cachedVoltages.set(voltages);
  }

  /**
   * Stamp companion models for all pin capacitances.
   *
   * Called once per timestep before the NR iterations begin.
   */
  stampCompanion(
    dt: number,
    method: IntegrationMethod,
    _voltages: Float64Array,
  ): void {
    const solver = this._solver;
    if (solver === null) return;
    for (const inp of this._inputs) {
      inp.stampCompanion(solver, dt, method);
    }
    this._output.stampCompanion(solver, dt, method);
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

  /**
   * Update companion model state after an accepted timestep.
   *
   * Calls updateCompanion() on all input and output pin models using the
   * accepted node voltages. Node IDs are 0-based solver indices.
   */
  updateCompanion(
    dt: number,
    method: IntegrationMethod,
    voltages: Float64Array,
  ): void {
    for (const inp of this._inputs) {
      const v = readMnaVoltage(inp.nodeId, voltages);
      inp.updateCompanion(dt, method, v);
    }
    const vOut = readMnaVoltage(this._output.nodeId, voltages);
    this._output.updateCompanion(dt, method, vOut);
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

  const inputPins: DigitalInputPinModel[] = [];
  for (let i = 0; i < inputCount; i++) {
    const label = `In_${i + 1}`;
    const spec = pinSpecs?.[label] ?? fallback;
    const pin = new DigitalInputPinModel(spec);
    pin.init(pinNodes.get(label) ?? 0, 0);
    inputPins.push(pin);
  }

  const outSpec = pinSpecs?.["out"] ?? fallback;
  const outputPin = new DigitalOutputPinModel(outSpec);
  outputPin.init(pinNodes.get("out") ?? 0, -1);

  return new BehavioralGateElement(inputPins, outputPin, truthTable);
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
