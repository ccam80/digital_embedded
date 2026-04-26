/**
 * Bridge adapter elements â€” MNA stamps for digital/analog engine boundaries.
 *
 * BridgeOutputAdapter wraps a DigitalOutputPinModel for use at a cross-engine
 * boundary. It uses an ideal voltage source branch equation. The logic level
 * is set externally by the DefaultSimulationCoordinator after each digital
 * engine step. Re-stamping the branch equation on the next NR iteration is
 * sufficient â€” no NR convergence is required for a level change.
 *
 * BridgeInputAdapter wraps a DigitalInputPinModel for use at a cross-engine
 * boundary. It exposes threshold detection so the coordinator can convert
 * analog voltages to digital bits. When unloaded, load() performs no matrix
 * writes (the underlying pin model early-exits).
 */

import type { AnalogElement, ReactiveAnalogElement } from "./element.js";
import { isPoolBacked } from "./element.js";
import type { LoadContext, StatePoolRef } from "./element.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import {
  DigitalOutputPinModel,
  DigitalInputPinModel,
  readMnaVoltage,
  collectPinModelChildren,
} from "./digital-pin-model.js";
import type { AnalogCapacitorElement } from "../../components/passives/capacitor.js";
import { defineStateSchema } from "./state-schema.js";
import type { StateSchema } from "./state-schema.js";

// Empty composite schema for adapter elements â€” children carry their own schemas.
const BRIDGE_COMPOSITE_SCHEMA: StateSchema = defineStateSchema("BridgeAdapterComposite", []);

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
 * isNonlinear is false â€” the ideal source is linear; logic level changes are
 * handled by re-stamping the branch equation on the next load() call, not via
 * NR convergence.
 *
 * isReactive is a getter â€” true only when the capacitor child is present.
 */
export class BridgeOutputAdapter implements AnalogElement {
  private readonly _pinModel: DigitalOutputPinModel;
  private readonly _childElements: AnalogCapacitorElement[];

  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly internalNodeLabels: readonly string[];
  readonly branchIndex: number;
  readonly isNonlinear: false = false;
  label?: string;

  readonly poolBacked = true as const;
  readonly stateSchema: StateSchema = BRIDGE_COMPOSITE_SCHEMA;
  stateSize: number;
  stateBaseOffset = -1;
  private _pool!: StatePoolRef;

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
    this._childElements = collectPinModelChildren([pinModel]);
    this.stateSize = this._childElements.reduce((s, c) => s + c.stateSize, 0);
  }

  /**
   * True only when the capacitor child is present (loaded and cOut > 0).
   */
  get isReactive(): boolean {
    return this._childElements.length > 0;
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    let offset = this.stateBaseOffset;
    for (const child of this._childElements) {
      child.stateBaseOffset = offset;
      child.initState(pool);
      offset += child.stateSize;
    }
  }

  /**
   * Set the output logic level from the coordinator.
   *
   * High â†’ vOH, low â†’ vOL. Delegates to DigitalOutputPinModel.setLogicLevel.
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
   * companion model via child elements.
   */
  load(ctx: LoadContext): void {
    this._pinModel.load(ctx);
    for (const child of this._childElements) {
      child.load(ctx);
    }
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

  /** Output impedance (Î©) used by this adapter's pin model. */
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
 * isNonlinear is false â€” input loading is a linear resistor.
 * isReactive is a getter â€” true only when the capacitor child is present.
 */
export class BridgeInputAdapter implements AnalogElement {
  private readonly _pinModel: DigitalInputPinModel;
  private readonly _childElements: AnalogCapacitorElement[];

  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly internalNodeLabels: readonly string[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: false = false;
  label?: string;

  readonly poolBacked = true as const;
  readonly stateSchema: StateSchema = BRIDGE_COMPOSITE_SCHEMA;
  stateSize: number;
  stateBaseOffset = -1;
  private _pool!: StatePoolRef;

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
    this._childElements = collectPinModelChildren([pinModel]);
    this.stateSize = this._childElements.reduce((s, c) => s + c.stateSize, 0);
  }

  /**
   * True only when the capacitor child is present (loaded and cIn > 0).
   */
  get isReactive(): boolean {
    return this._childElements.length > 0;
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    let offset = this.stateBaseOffset;
    for (const child of this._childElements) {
      child.stateBaseOffset = offset;
      child.initState(pool);
      offset += child.stateSize;
    }
  }

  /** Hot-update a single electrical parameter on the underlying pin model. */
  setParam(key: string, value: number): void {
    this._pinModel.setParam(key, value);
  }

  /**
   * Unified per-NR-iteration load. Stamps the input loading conductance
   * 1/rIn (no-op when unloaded) and, during transient solves, the C_in
   * companion model via child elements.
   */
  load(ctx: LoadContext): void {
    this._pinModel.load(ctx);
    for (const child of this._childElements) {
      child.load(ctx);
    }
  }

  /**
   * Threshold-detect the given analog voltage.
   *
   * Returns true  when voltage > vIH  (logic HIGH),
   *         false when voltage < vIL  (logic LOW),
   *         undefined                 (indeterminate â€” between thresholds).
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
    const vNode = voltages[nodeId];
    const i = vNode / this._pinModel.rIn;
    return [i];
  }

  /** MNA node ID for this input pin. The coordinator reads voltage here. */
  get inputNodeId(): number {
    return this._pinModel.nodeId;
  }

  /** Input impedance (Î©) used by this adapter's loading conductance stamp. */
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
