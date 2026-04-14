/**
 * Bridge adapter elements — MNA stamps for digital/analog engine boundaries.
 *
 * BridgeOutputAdapter wraps a DigitalOutputPinModel for use at a cross-engine
 * boundary. It uses an ideal voltage source branch equation. The logic level
 * is set externally by the DefaultSimulationCoordinator after each digital
 * engine step. Re-stamping the branch equation after a level change is
 * sufficient — no NR iteration is required.
 *
 * BridgeInputAdapter wraps a DigitalInputPinModel for use at a cross-engine
 * boundary. It exposes threshold detection so the coordinator can convert
 * analog voltages to digital bits. When unloaded, stamp() is a no-op.
 */

import type { SparseSolver } from "./sparse-solver.js";
import type { AnalogElement, IntegrationMethod } from "./element.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import {
  DigitalOutputPinModel,
  DigitalInputPinModel,
  readMnaVoltage,
} from "./digital-pin-model.js";

// ---------------------------------------------------------------------------
// BridgeOutputAdapter
// ---------------------------------------------------------------------------

/**
 * Analog MNA element for a digital engine output pin at an engine boundary.
 *
 * Stamps an ideal voltage source branch equation using DigitalOutputPinModel.
 * The branch variable at branchIndex carries the source current. The logic
 * level is set externally by the DefaultSimulationCoordinator.
 *
 * isNonlinear is false — the ideal source is linear; logic level changes are
 * handled by re-stamping the branch equation (coordinator calls stamp() after
 * updating the level), not via NR iteration.
 *
 * isReactive is a getter — true only when loaded and cOut > 0.
 */
export class BridgeOutputAdapter implements AnalogElement {
  private readonly _pinModel: DigitalOutputPinModel;
  private readonly _loaded: boolean;

  /** Cached solver reference for stampCompanion. */
  private _solver: SparseSolver | null = null;

  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly internalNodeLabels: readonly string[];
  readonly branchIndex: number;
  readonly isNonlinear: false = false;
  label?: string;

  /**
   * @param pinModel  - Initialised DigitalOutputPinModel for this bridge pin.
   *                    The caller must have already called pinModel.init() with
   *                    the correct MNA node ID and branch index.
   * @param branchIdx - Absolute branch row/col in the augmented MNA matrix.
   * @param loaded    - Whether output loading (rOut, cOut) is stamped.
   */
  constructor(
    pinModel: DigitalOutputPinModel,
    branchIdx: number,
    loaded: boolean,
  ) {
    this._pinModel = pinModel;
    this.branchIndex = branchIdx;
    this._loaded = loaded;
    this.pinNodeIds = [pinModel.nodeId];
    this.allNodeIds = [pinModel.nodeId];
    this.internalNodeLabels = [];
  }

  /**
   * True only when loaded and cOut > 0.
   *
   * The timestep controller reads this flag to decide whether to call
   * stampCompanion. When unloaded, stampCompanion is a no-op.
   */
  get isReactive(): boolean {
    return this._loaded && this._pinModel.capacitance > 0;
  }

  /**
   * Set the output logic level from the coordinator.
   *
   * High → vOH, low → vOL. Delegates to DigitalOutputPinModel.setLogicLevel.
   */
  setLogicLevel(high: boolean): void {
    this._pinModel.setLogicLevel(high);
  }

  /**
   * Switch to Hi-Z state from the coordinator.
   */
  setHighZ(hiZ: boolean): void {
    this._pinModel.setHighZ(hiZ);
  }

  /** Hot-update a single electrical parameter on the underlying pin model. */
  setParam(key: string, value: number): void {
    this._pinModel.setParam(key, value);
  }

  /**
   * Stamp the ideal voltage source branch equation into the MNA matrix.
   *
   * Caches the solver reference for stampCompanion.
   */
  stamp(solver: SparseSolver): void {
    this._solver = solver;
    this._pinModel.stamp(solver);
  }

  /**
   * Stamp the C_out companion model for this timestep.
   *
   * Called once per timestep before the NR iterations begin. No-op when
   * unloaded or cOut === 0.
   */
  stampCompanion(
    dt: number,
    method: IntegrationMethod,
    _voltages: Float64Array,
  ): void {
    const solver = this._solver;
    if (solver === null) return;
    this._pinModel.stampCompanion(solver, dt, method);
  }

  /**
   * Update C_out companion state after an accepted timestep.
   */
  updateCompanion(
    dt: number,
    method: IntegrationMethod,
    voltages: Float64Array,
  ): void {
    const v = readMnaVoltage(this._pinModel.nodeId, voltages);
    this._pinModel.updateCompanion(dt, method, v);
  }

  /**
   * No-op — bridge output operating point is set by the coordinator, not
   * read from the MNA solution.
   */
  updateOperatingPoint(_voltages: Readonly<Float64Array>): void {
    // Intentionally empty — logic level is owned by the coordinator.
  }

  /**
   * Per-pin current for the single output node.
   *
   * With an ideal voltage source, the branch variable at branchIndex carries
   * the source current directly. Reads it from the full solution vector.
   */
  getPinCurrents(voltages: Float64Array): number[] {
    const bIdx = this.branchIndex;
    const i = bIdx >= 0 && bIdx < voltages.length ? voltages[bIdx] : 0;
    return [i];
  }

  /** MNA node ID for this output pin. The coordinator reads voltage here. */
  get outputNodeId(): number {
    return this._pinModel.nodeId;
  }

  /** Output impedance (Ω) used by this adapter's pin model. */
  get rOut(): number {
    return this._pinModel.rOut;
  }
}

// ---------------------------------------------------------------------------
// BridgeInputAdapter
// ---------------------------------------------------------------------------

/**
 * Analog MNA element for a digital engine input pin at an engine boundary.
 *
 * Exposes readLogicLevel() so the DefaultSimulationCoordinator can
 * threshold-detect the analog node voltage and feed the result to the inner
 * digital engine.
 *
 * isNonlinear is false — input loading is a linear resistor.
 * isReactive is a getter — true only when loaded and cIn > 0.
 */
export class BridgeInputAdapter implements AnalogElement {
  private readonly _pinModel: DigitalInputPinModel;
  private readonly _loaded: boolean;

  /** Cached solver reference for stampCompanion. */
  private _solver: SparseSolver | null = null;

  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly internalNodeLabels: readonly string[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: false = false;
  label?: string;

  /**
   * @param pinModel - Initialised DigitalInputPinModel for this bridge pin.
   *                   The caller must have already called pinModel.init() with
   *                   the correct MNA node ID.
   * @param loaded   - Whether input loading (rIn, cIn) is stamped.
   */
  constructor(pinModel: DigitalInputPinModel, loaded: boolean) {
    this._pinModel = pinModel;
    this._loaded = loaded;
    this.pinNodeIds = [pinModel.nodeId];
    this.allNodeIds = [pinModel.nodeId];
    this.internalNodeLabels = [];
  }

  /**
   * True only when loaded and cIn > 0.
   */
  get isReactive(): boolean {
    return this._loaded && this._pinModel.capacitance > 0;
  }

  /**
   * Stamp the input loading conductance 1/rIn into the MNA matrix.
   *
   * No-op when unloaded. Caches the solver reference for stampCompanion.
   */
  stamp(solver: SparseSolver): void {
    this._solver = solver;
    this._pinModel.stamp(solver);
  }

  /** Hot-update a single electrical parameter on the underlying pin model. */
  setParam(key: string, value: number): void {
    this._pinModel.setParam(key, value);
  }

  /**
   * Stamp the C_in companion model for this timestep.
   *
   * No-op when unloaded or cIn === 0.
   */
  stampCompanion(
    dt: number,
    method: IntegrationMethod,
    _voltages: Float64Array,
  ): void {
    const solver = this._solver;
    if (solver === null) return;
    this._pinModel.stampCompanion(solver, dt, method);
  }

  /**
   * Update C_in companion state after an accepted timestep.
   */
  updateCompanion(
    dt: number,
    method: IntegrationMethod,
    voltages: Float64Array,
  ): void {
    const v = readMnaVoltage(this._pinModel.nodeId, voltages);
    this._pinModel.updateCompanion(dt, method, v);
  }

  /**
   * Threshold-detect the given analog voltage.
   *
   * Returns true  when voltage > vIH  (logic HIGH),
   *         false when voltage < vIL  (logic LOW),
   *         undefined                 (indeterminate — between thresholds).
   */
  readLogicLevel(voltage: number): boolean | undefined {
    return this._pinModel.readLogicLevel(voltage);
  }

  /**
   * Per-pin current for the single input node.
   *
   * When loaded, 1/rIn is stamped from node to ground. At convergence:
   *   I_into_element = V_node / rIn
   *
   * When unloaded, no conductance is stamped, so current contribution is 0.
   */
  getPinCurrents(voltages: Float64Array): number[] {
    if (!this._loaded) return [0];
    const nodeId = this._pinModel.nodeId;
    const vNode = nodeId > 0 ? voltages[nodeId - 1] : 0;
    const i = vNode / this._pinModel.rIn;
    return [i];
  }

  /** MNA node ID for this input pin. The coordinator reads voltage here. */
  get inputNodeId(): number {
    return this._pinModel.nodeId;
  }

  /** Input impedance (Ω) used by this adapter's loading conductance stamp. */
  get rIn(): number {
    return this._pinModel.rIn;
  }
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Build a BridgeOutputAdapter from a ResolvedPinElectrical spec, a
 * pre-assigned MNA node ID, a branch variable index, and a loaded flag.
 */
export function makeBridgeOutputAdapter(
  spec: ResolvedPinElectrical,
  nodeId: number,
  branchIdx: number,
  loaded: boolean,
): BridgeOutputAdapter {
  const model = new DigitalOutputPinModel(spec, loaded);
  model.init(nodeId, branchIdx);
  return new BridgeOutputAdapter(model, branchIdx, loaded);
}

/**
 * Build a BridgeInputAdapter from a ResolvedPinElectrical spec, a
 * pre-assigned MNA node ID, and a loaded flag.
 */
export function makeBridgeInputAdapter(
  spec: ResolvedPinElectrical,
  nodeId: number,
  loaded: boolean,
): BridgeInputAdapter {
  const model = new DigitalInputPinModel(spec, loaded);
  model.init(nodeId, 0);
  return new BridgeInputAdapter(model, loaded);
}
