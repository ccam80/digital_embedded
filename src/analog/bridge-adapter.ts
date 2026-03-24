/**
 * Bridge adapter elements — MNA stamps for digital/analog engine boundaries.
 *
 * BridgeOutputAdapter wraps a DigitalOutputPinModel for use at a cross-engine
 * boundary. Unlike BehavioralGateElement (which evaluates a truth table to
 * compute its own output), the bridge adapter receives its logic level from
 * the MixedSignalCoordinator after each digital engine step.
 *
 * BridgeInputAdapter wraps a DigitalInputPinModel for use at a cross-engine
 * boundary. It stamps input loading into the analog MNA matrix and exposes
 * threshold detection so the coordinator can convert analog voltages to
 * digital bits.
 */

import type { SparseSolver } from "./sparse-solver.js";
import type { AnalogElement, IntegrationMethod } from "./element.js";
import type { ResolvedPinElectrical } from "../core/pin-electrical.js";
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
 * Stamps a Norton equivalent (conductance 1/rOut + current source V_out/rOut)
 * using DigitalOutputPinModel. The logic level is set externally by the
 * MixedSignalCoordinator — never computed internally.
 *
 * isNonlinear is true because the output level can change between timesteps
 * when the coordinator updates it. stampNonlinear re-stamps the Norton current
 * whenever the coordinator has set a new level.
 *
 * isReactive is true because C_out requires a companion model.
 */
export class BridgeOutputAdapter implements AnalogElement {
  private readonly _pinModel: DigitalOutputPinModel;

  /** Cached solver reference for stampCompanion. */
  private _solver: SparseSolver | null = null;

  readonly pinNodeIds: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: true = true;
  readonly isReactive: true = true;
  label?: string;

  /**
   * @param pinModel - Initialised DigitalOutputPinModel for this bridge pin.
   *                   The caller must have already called pinModel.init() with
   *                   the correct MNA node ID.
   */
  constructor(pinModel: DigitalOutputPinModel) {
    this._pinModel = pinModel;
    this.pinNodeIds = [pinModel.nodeId];
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
   *
   * Replaces the Norton equivalent with 1/rHiZ to ground.
   */
  setHighZ(hiZ: boolean): void {
    this._pinModel.setHighZ(hiZ);
  }

  /**
   * Stamp the linear Norton equivalent into the MNA matrix.
   *
   * Normal mode: conductance 1/rOut on diagonal + current source V_out/rOut on RHS.
   * Hi-Z mode: conductance 1/rHiZ on diagonal only.
   *
   * Caches the solver reference for stampCompanion.
   */
  stamp(solver: SparseSolver): void {
    this._solver = solver;
    this._pinModel.stamp(solver);
  }

  /**
   * Re-stamp the Norton current source at the current logic level.
   *
   * Called every NR iteration by the assembler. Re-stamps the output so the
   * Norton current reflects the level set by the coordinator since the last
   * stamp() call.
   */
  stampNonlinear(solver: SparseSolver): void {
    this._solver = solver;
    this._pinModel.stamp(solver);
  }

  /**
   * Stamp the C_out companion model for this timestep.
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
    this._pinModel.stampCompanion(solver, dt, method);
  }

  /**
   * Update C_out companion state after an accepted timestep.
   *
   * @param dt - Accepted timestep in seconds
   * @param method - Integration method used
   * @param voltages - Accepted MNA solution vector
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
  updateOperatingPoint(_voltages: Float64Array): void {
    // Intentionally empty — logic level is owned by the coordinator.
  }

  /**
   * Per-pin current for the single output node.
   *
   * The Norton equivalent stamps conductance gOut = 1/rOut and a current
   * source V_target * gOut into the node. At convergence:
   *   I_into_node = (V_node - V_target) * gOut
   *
   * Positive = current flowing INTO the element (element is sinking current
   * from the net). Sum is nonzero — the difference flows through the implicit
   * internal supply. This is expected for a bounded output driver.
   *
   * Hi-Z mode: no target voltage, only conductance 1/rHiZ to ground.
   *   I = V_node / rHiZ
   */
  getPinCurrents(voltages: Float64Array): number[] {
    const nodeId = this._pinModel.nodeId;
    const vNode = nodeId > 0 ? voltages[nodeId - 1] : 0;
    let i: number;
    if (this._pinModel.isHiZ) {
      i = vNode / this._pinModel.rHiZ;
    } else {
      const gOut = 1 / this._pinModel.rOut;
      i = (vNode - this._pinModel.currentVoltage) * gOut;
    }
    return [i];
  }

  /** MNA node ID for this output pin. The coordinator reads voltage here. */
  get outputNodeId(): number {
    return this._pinModel.nodeId;
  }
}

// ---------------------------------------------------------------------------
// BridgeInputAdapter
// ---------------------------------------------------------------------------

/**
 * Analog MNA element for a digital engine input pin at an engine boundary.
 *
 * Stamps input loading (conductance 1/rIn to ground) and a C_in companion
 * model using DigitalInputPinModel. Exposes readLogicLevel() so the
 * MixedSignalCoordinator can threshold-detect the analog node voltage and
 * feed the result to the inner digital engine.
 *
 * isNonlinear is false — input loading is a linear resistor.
 * isReactive is true — C_in requires a companion model.
 */
export class BridgeInputAdapter implements AnalogElement {
  private readonly _pinModel: DigitalInputPinModel;

  /** Cached solver reference for stampCompanion. */
  private _solver: SparseSolver | null = null;

  readonly pinNodeIds: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: false = false;
  readonly isReactive: true = true;
  label?: string;

  /**
   * @param pinModel - Initialised DigitalInputPinModel for this bridge pin.
   *                   The caller must have already called pinModel.init() with
   *                   the correct MNA node ID.
   */
  constructor(pinModel: DigitalInputPinModel) {
    this._pinModel = pinModel;
    this.pinNodeIds = [pinModel.nodeId];
  }

  /**
   * Stamp the input loading conductance 1/rIn into the MNA matrix.
   *
   * Caches the solver reference for stampCompanion.
   */
  stamp(solver: SparseSolver): void {
    this._solver = solver;
    this._pinModel.stamp(solver);
  }

  /**
   * Stamp the C_in companion model for this timestep.
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
   *
   * The coordinator calls this after reading the analog solution at inputNodeId.
   */
  readLogicLevel(voltage: number): boolean | undefined {
    return this._pinModel.readLogicLevel(voltage);
  }

  /**
   * Per-pin current for the single input node.
   *
   * The input loading stamps conductance 1/rIn from the node to ground.
   * At convergence:
   *   I_into_element = V_node / rIn
   *
   * Positive = current flowing INTO the element (element sinks from the net).
   * Sum is nonzero — the difference flows to implicit ground. Expected for
   * a resistive load.
   */
  getPinCurrents(voltages: Float64Array): number[] {
    const nodeId = this._pinModel.nodeId;
    const vNode = nodeId > 0 ? voltages[nodeId - 1] : 0;
    const i = vNode / this._pinModel.rIn;
    return [i];
  }

  /** MNA node ID for this input pin. The coordinator reads voltage here. */
  get inputNodeId(): number {
    return this._pinModel.nodeId;
  }
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Build a BridgeOutputAdapter from a ResolvedPinElectrical spec and a
 * pre-assigned MNA node ID.
 */
export function makeBridgeOutputAdapter(
  spec: ResolvedPinElectrical,
  nodeId: number,
): BridgeOutputAdapter {
  const model = new DigitalOutputPinModel(spec);
  model.init(nodeId, -1);
  return new BridgeOutputAdapter(model);
}

/**
 * Build a BridgeInputAdapter from a ResolvedPinElectrical spec and a
 * pre-assigned MNA node ID.
 */
export function makeBridgeInputAdapter(
  spec: ResolvedPinElectrical,
  nodeId: number,
): BridgeInputAdapter {
  const model = new DigitalInputPinModel(spec);
  model.init(nodeId, 0);
  return new BridgeInputAdapter(model);
}
