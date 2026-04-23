/**
 * Bridge adapter elements — MNA stamps for digital/analog engine boundaries.
 *
 * BridgeOutputAdapter wraps a DigitalOutputPinModel for use at a cross-engine
 * boundary. It uses an ideal voltage source branch equation. The logic level
 * is set externally by the DefaultSimulationCoordinator after each digital
 * engine step. Re-stamping the branch equation on the next NR iteration is
 * sufficient — no NR convergence is required for a level change.
 *
 * BridgeInputAdapter wraps a DigitalInputPinModel for use at a cross-engine
 * boundary. It exposes threshold detection so the coordinator can convert
 * analog voltages to digital bits. When unloaded, load() performs no matrix
 * writes (the underlying pin model early-exits).
 */

import type { AnalogElement, LoadContext } from "./element.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import {
  DigitalOutputPinModel,
  DigitalInputPinModel,
  readMnaVoltage,
} from "./digital-pin-model.js";
import { MODETRAN } from "./ckt-mode.js";

// ---------------------------------------------------------------------------
// BridgeOutputAdapter
// ---------------------------------------------------------------------------

/**
 * Analog MNA element for a digital engine output pin at an engine boundary.
 *
 * Stamps an ideal voltage source branch equation using DigitalOutputPinModel
 * with role="branch". The branch variable at branchIndex carries the source
 * current. The logic level is set externally by the DefaultSimulationCoordinator.
 *
 * isNonlinear is false — the ideal source is linear; logic level changes are
 * handled by re-stamping the branch equation on the next load() call, not via
 * NR convergence.
 *
 * isReactive is a getter — true only when loaded and cOut > 0.
 */
export class BridgeOutputAdapter implements AnalogElement {
  private readonly _pinModel: DigitalOutputPinModel;

  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly internalNodeLabels: readonly string[];
  readonly branchIndex: number;
  readonly isNonlinear: false = false;
  label?: string;

  /**
   * @param pinModel  - Initialised DigitalOutputPinModel for this bridge pin
   *                    with role="branch". The caller must have already called
   *                    pinModel.init() with the correct MNA node ID and branch index.
   * @param branchIdx - Absolute branch row/col in the augmented MNA matrix.
   */
  constructor(
    pinModel: DigitalOutputPinModel,
    branchIdx: number,
  ) {
    this._pinModel = pinModel;
    this.branchIndex = branchIdx;
    this.pinNodeIds = [pinModel.nodeId];
    this.allNodeIds = [pinModel.nodeId];
    this.internalNodeLabels = [];
  }

  /**
   * True only when loaded and cOut > 0.
   *
   * The timestep controller reads this flag to decide whether to stamp the
   * C_out companion model inside load() during transient solves.
   */
  get isReactive(): boolean {
    return this._pinModel.loaded && this._pinModel.capacitance > 0;
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
   * Unified per-NR-iteration load. Stamps the ideal voltage source branch
   * equation (vOH/vOL or Hi-Z) and, during transient solves, the C_out
   * companion model. Matches ngspice DEVload: one call per element per NR
   * iteration that reads state and writes conductance/RHS.
   *
   * Logic level is owned by the coordinator (setLogicLevel / setHighZ) —
   * load() does not read the MNA solution to drive a Norton/Thevenin choice;
   * the branch equation enforces the coordinator-set target.
   */
  load(ctx: LoadContext): void {
    this._pinModel.load(ctx);
  }

  /**
   * Post-accepted-step update for the C_out companion state.
   *
   * Active for transient solves AND post-DCOP priming (dt=0, ag[0]=0):
   * the ngspice DEVaccept analog runs after CKTop with MODETRAN set so that
   * _prevVoltage is seeded with the DCOP node voltage before the first
   * transient NR stamps a companion. Without this, the companion injects a
   * fictitious step-change from _prevVoltage=0 and LTE destabilises.
   */
  accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
    if (!this._pinModel.loaded || this._pinModel.capacitance <= 0) return;
    if (!(ctx.cktMode & MODETRAN)) return;
    const v = readMnaVoltage(this._pinModel.nodeId, ctx.rhs);
    this._pinModel.accept(ctx, v);
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
   */
  constructor(pinModel: DigitalInputPinModel) {
    this._pinModel = pinModel;
    this.pinNodeIds = [pinModel.nodeId];
    this.allNodeIds = [pinModel.nodeId];
    this.internalNodeLabels = [];
  }

  /**
   * True only when loaded and cIn > 0.
   */
  get isReactive(): boolean {
    return this._pinModel.loaded && this._pinModel.capacitance > 0;
  }

  /** Hot-update a single electrical parameter on the underlying pin model. */
  setParam(key: string, value: number): void {
    this._pinModel.setParam(key, value);
  }

  /**
   * Unified per-NR-iteration load. Stamps the input loading conductance
   * 1/rIn (no-op when unloaded) and, during transient solves, the C_in
   * companion model. Matches ngspice DEVload.
   */
  load(ctx: LoadContext): void {
    this._pinModel.load(ctx);
  }

  /**
   * Post-accepted-step update for the C_in companion state.
   *
   * Active for transient solves AND post-DCOP priming (dt=0, ag[0]=0):
   * the ngspice DEVaccept analog runs after CKTop with MODETRAN set so that
   * _prevVoltage is seeded with the DCOP node voltage before the first
   * transient NR stamps a companion.
   */
  accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
    if (!this._pinModel.loaded || this._pinModel.capacitance <= 0) return;
    if (!(ctx.cktMode & MODETRAN)) return;
    const v = readMnaVoltage(this._pinModel.nodeId, ctx.rhs);
    this._pinModel.accept(ctx, v);
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
    if (!this._pinModel.loaded) return [0];
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
 *
 * The output pin uses role="branch" (ideal voltage source).
 */
export function makeBridgeOutputAdapter(
  spec: ResolvedPinElectrical,
  nodeId: number,
  branchIdx: number,
  loaded: boolean,
): BridgeOutputAdapter {
  const model = new DigitalOutputPinModel(spec, loaded, "branch");
  model.init(nodeId, branchIdx);
  return new BridgeOutputAdapter(model, branchIdx);
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
  return new BridgeInputAdapter(model);
}
