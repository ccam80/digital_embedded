/**
 * Bridge adapter elements  MNA stamps for digital/analog engine boundaries.
 *
 * BridgeOutputAdapter wraps a DigitalOutputPinModel for use at a cross-engine
 * boundary. It uses an ideal voltage source branch equation. The logic level
 * is set externally by the DefaultSimulationCoordinator after each digital
 * engine step. Re-stamping the branch equation on the next NR iteration is
 * sufficient  no NR convergence is required for a level change.
 *
 * BridgeInputAdapter wraps a DigitalInputPinModel for use at a cross-engine
 * boundary. It exposes threshold detection so the coordinator can convert
 * analog voltages to digital bits. When unloaded, load() performs no matrix
 * writes (the underlying pin model early-exits).
 */

import type { AnalogElement } from "./element.js";
import { NGSPICE_LOAD_ORDER } from "./element.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import {
  DigitalOutputPinModel,
  DigitalInputPinModel,
  collectPinModelChildren,
} from "./digital-pin-model.js";
import { CompositeElement } from "./composite-element.js";
import { defineStateSchema } from "./state-schema.js";
import type { StateSchema } from "./state-schema.js";

// Empty composite schema for adapter elements  children carry their own schemas.
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
 * The element is linear; logic level changes are handled by re-stamping the
 * branch equation on the next load() call, not via NR convergence.
 *
 * Reactivity is method-presence: this element is reactive iff any child
 * element exposes getLteTimestep (delegated via CompositeElement base).
 */
export class BridgeOutputAdapter extends CompositeElement {
  private readonly _pinModel: DigitalOutputPinModel;
  private readonly _childElements: AnalogElement[];

  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VSRC;
  readonly stateSchema: StateSchema = BRIDGE_COMPOSITE_SCHEMA;

  constructor(
    pinModel: DigitalOutputPinModel,
    branchIdx: number,
  ) {
    super();
    this._pinModel = pinModel;
    this.branchIndex = branchIdx;
    this._pinNodes = new Map([["out", pinModel.nodeId]]);
    this._childElements = collectPinModelChildren([pinModel]);
  }

  protected getSubElements(): readonly AnalogElement[] {
    return [this._pinModel as unknown as AnalogElement, ...this._childElements];
  }

  /**
   * Set the output logic level from the coordinator.
   *
   * High  vOH, low  vOL. Delegates to DigitalOutputPinModel.setLogicLevel.
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
   * Per-pin current for the single output node.
   *
   * With an ideal voltage source, the branch variable at branchIndex carries
   * the source current directly. Reads it from the full solution vector.
   */
  getPinCurrents(rhs: Float64Array): number[] {
    const bIdx = this.branchIndex;
    const i = bIdx >= 0 && bIdx < rhs.length ? rhs[bIdx] : 0;
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
 * Input loading is a linear resistor. Reactivity is method-presence:
 * this element is reactive iff any child element exposes getLteTimestep.
 */
export class BridgeInputAdapter extends CompositeElement {
  private readonly _pinModel: DigitalInputPinModel;
  private readonly _childElements: AnalogElement[];

  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.ISRC;
  readonly stateSchema: StateSchema = BRIDGE_COMPOSITE_SCHEMA;

  constructor(pinModel: DigitalInputPinModel) {
    super();
    this._pinModel = pinModel;
    this._pinNodes = new Map([["in", pinModel.nodeId]]);
    this._childElements = collectPinModelChildren([pinModel]);
  }

  protected getSubElements(): readonly AnalogElement[] {
    return [this._pinModel as unknown as AnalogElement, ...this._childElements];
  }

  /** Hot-update a single electrical parameter on the underlying pin model. */
  setParam(key: string, value: number): void {
    this._pinModel.setParam(key, value);
  }

  /**
   * Threshold-detect the given analog voltage.
   *
   * Returns true  when voltage > vIH  (logic HIGH),
   *         false when voltage < vIL  (logic LOW),
   *         undefined                 (indeterminate  between thresholds).
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
  getPinCurrents(rhs: Float64Array): number[] {
    if (!this._pinModel.loaded) return [0];
    const nodeId = this._pinModel.nodeId;
    const vNode = rhs[nodeId];
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
