/**
 * DigitalPinModel — MNA stamp helpers for digital pins.
 *
 * DigitalOutputPinModel stamps an ideal voltage source branch equation:
 *   - Drive mode: branch equation enforces V_node = V_target.
 *     If loaded, also stamps 1/rOut on the node diagonal.
 *   - Hi-Z mode: branch equation enforces I = 0.
 *     If loaded, stamps 1/rHiZ on the node diagonal.
 *   - Companion model for C_out only when loaded and cOut > 0.
 *
 * DigitalInputPinModel is sense-only by default:
 *   - When loaded, stamps 1/rIn on the node diagonal.
 *   - Companion model for C_in only when loaded and cIn > 0.
 *   - Threshold detection always available regardless of loaded flag.
 */

import type { SparseSolver } from "./sparse-solver.js";
import type { IntegrationMethod } from "./element.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import {
  capacitorConductance,
  capacitorHistoryCurrent,
} from "./integration.js";

/**
 * Read voltage for an MNA node from the solver solution vector.
 * MNA node 0 is ground (always 0 V); non-ground nodes are stored
 * at solver index nodeId - 1.
 */
export function readMnaVoltage(nodeId: number, voltages: Float64Array): number {
  return nodeId > 0 && nodeId - 1 < voltages.length ? voltages[nodeId - 1] : 0;
}

// ---------------------------------------------------------------------------
// DigitalOutputPinModel
// ---------------------------------------------------------------------------

/**
 * Stamps the analog equivalent of one digital output pin into the MNA matrix
 * using an ideal voltage source branch equation.
 *
 * The branch variable at branchIdx represents the current injected by the
 * ideal source. The branch equation selects between drive and Hi-Z modes.
 * Loading (rOut, cOut) is stamped only when the loaded flag is true.
 */
export class DigitalOutputPinModel {
  private _spec: ResolvedPinElectrical;
  private _loaded: boolean;

  /** Node this pin drives. Set by init(). */
  private _nodeId = -1;

  /** Absolute branch row/col in the augmented matrix. Set by init(). */
  private _branchIdx = -1;

  /** True when logic level is high. */
  private _high = false;

  /** True when in Hi-Z state. */
  private _hiZ = false;

  private _prevVoltage = 0;
  private _prevCurrent = 0;

  constructor(spec: ResolvedPinElectrical, loaded = false) {
    this._spec = { ...spec };
    this._loaded = loaded;
  }

  /**
   * Assign the node this pin drives and the branch variable index.
   *
   * branchIdx is the absolute row/col in the augmented MNA matrix
   * (= totalNodeCount + assignedBranchOffset).
   */
  init(nodeId: number, branchIdx: number): void {
    this._nodeId = nodeId;
    this._branchIdx = branchIdx;
  }

  /** Set the output logic level. High → vOH, low → vOL. */
  setLogicLevel(high: boolean): void {
    this._high = high;
  }

  /** Switch between driven and Hi-Z states. */
  setHighZ(hiZ: boolean): void {
    this._hiZ = hiZ;
  }

  /** Hot-update a single electrical parameter on this pin model. */
  setParam(key: string, value: number): void {
    if (key in this._spec) {
      (this._spec as unknown as Record<string, number>)[key] = value;
    }
  }

  /**
   * Stamp the ideal voltage source branch equation into the MNA matrix.
   *
   * Drive mode:
   *   stamp(branchIdx, nodeIdx, 1)   — branch eq: V_node coefficient
   *   stamp(branchIdx, branchIdx, 0) — sparsity pre-allocation
   *   stamp(nodeIdx, branchIdx, 1)   — KCL: branch current into node
   *   stampRHS(branchIdx, V_target)  — branch eq RHS
   *   If loaded: stamp(nodeIdx, nodeIdx, 1/rOut)
   *
   * Hi-Z mode:
   *   stamp(branchIdx, branchIdx, 1) — branch eq: I = 0
   *   stamp(branchIdx, nodeIdx, 0)   — sparsity pre-allocation
   *   stamp(nodeIdx, branchIdx, 1)   — KCL: branch current (= 0)
   *   stampRHS(branchIdx, 0)         — branch eq RHS
   *   If loaded: stamp(nodeIdx, nodeIdx, 1/rHiZ)
   *
   * When branchIdx < 0 (not assigned), this method is a no-op.
   */
  stamp(solver: SparseSolver): void {
    const node = this._nodeId;
    if (node <= 0) return;
    const bIdx = this._branchIdx;
    if (bIdx < 0) return;
    const nodeIdx = node - 1;

    if (this._hiZ) {
      solver.stamp(bIdx, bIdx, 1);
      solver.stamp(bIdx, nodeIdx, 0);
      solver.stamp(nodeIdx, bIdx, 1);
      solver.stampRHS(bIdx, 0);
      if (this._loaded) {
        solver.stamp(nodeIdx, nodeIdx, 1 / this._spec.rHiZ);
      }
    } else {
      solver.stamp(bIdx, nodeIdx, 1);
      solver.stamp(bIdx, bIdx, 0);
      solver.stamp(nodeIdx, bIdx, 1);
      solver.stampRHS(bIdx, this._high ? this._spec.vOH : this._spec.vOL);
      if (this._loaded) {
        solver.stamp(nodeIdx, nodeIdx, 1 / this._spec.rOut);
      }
    }
  }

  /**
   * Stamp a conductance + current source for the output into the MNA matrix.
   *
   * Drive mode: stamps 1/rOut on diagonal + V_target/rOut current source on RHS.
   * Hi-Z mode: stamps 1/rHiZ on diagonal only.
   *
   * Used by behavioral elements (gates, flipflops, sequential) which model
   * the output as a conductance+current-source in the nonlinear NR loop. These
   * elements do not use a branch variable, so the branch-equation stamp() is not
   * applicable to them.
   */
  stampOutput(solver: SparseSolver): void {
    const node = this._nodeId;
    if (node <= 0) return;
    const nodeIdx = node - 1;
    if (this._hiZ) {
      solver.stamp(nodeIdx, nodeIdx, 1 / this._spec.rHiZ);
    } else {
      const gOut = 1 / this._spec.rOut;
      solver.stamp(nodeIdx, nodeIdx, gOut);
      solver.stampRHS(nodeIdx, (this._high ? this._spec.vOH : this._spec.vOL) * gOut);
    }
  }

  /**
   * Stamp the companion model for C_out.
   *
   * Only active when loaded and cOut > 0.
   */
  stampCompanion(
    solver: SparseSolver,
    dt: number,
    method: IntegrationMethod,
  ): void {
    if (!this._loaded) return;
    const node = this._nodeId;
    if (node <= 0) return;
    const C = this._spec.cOut;
    if (C <= 0) return;
    const idx = node - 1;
    const geq = capacitorConductance(C, dt, method);
    const ieq = capacitorHistoryCurrent(
      C,
      dt,
      method,
      this._prevVoltage,
      0,
      this._prevCurrent,
    );
    solver.stamp(idx, idx, geq);
    solver.stampRHS(idx, -ieq);
  }

  /**
   * Update C_out companion state for the newly accepted timestep voltage.
   */
  updateCompanion(
    dt: number,
    method: IntegrationMethod,
    voltage: number,
  ): void {
    if (!this._loaded) return;
    const C = this._spec.cOut;
    if (C <= 0) return;
    const geq = capacitorConductance(C, dt, method);
    const ieq = capacitorHistoryCurrent(
      C,
      dt,
      method,
      this._prevVoltage,
      0,
      this._prevCurrent,
    );
    const iNow = geq * voltage + ieq;
    this._prevCurrent = iNow;
    this._prevVoltage = voltage;
  }

  /** The node ID assigned by init(). */
  get nodeId(): number {
    return this._nodeId;
  }

  /** The branch index assigned by init(). */
  get branchIndex(): number {
    return this._branchIdx;
  }

  /** The target output voltage (vOH or vOL). */
  get currentVoltage(): number {
    return this._high ? this._spec.vOH : this._spec.vOL;
  }

  /** Output capacitance in farads. */
  get capacitance(): number {
    return this._spec.cOut;
  }

  /** True when the output is in Hi-Z state. */
  get isHiZ(): boolean {
    return this._hiZ;
  }

  /** Output impedance in ohms. */
  get rOut(): number {
    return this._spec.rOut;
  }

  /** Hi-Z impedance in ohms. */
  get rHiZ(): number {
    return this._spec.rHiZ;
  }
}

// ---------------------------------------------------------------------------
// DigitalInputPinModel
// ---------------------------------------------------------------------------

/**
 * Stamps the analog equivalent of one digital input pin into the MNA matrix.
 *
 * Sense-only by default — threshold detection is always available.
 * When loaded, stamps 1/rIn on the node diagonal and cIn companion model.
 */
export class DigitalInputPinModel {
  private _spec: ResolvedPinElectrical;
  private _loaded: boolean;

  /** Node this pin reads. Set by init(). */
  private _nodeId = -1;

  private _prevVoltage = 0;
  private _prevCurrent = 0;

  constructor(spec: ResolvedPinElectrical, loaded: boolean) {
    this._spec = { ...spec };
    this._loaded = loaded;
  }

  /**
   * Assign the node this pin reads.
   */
  init(nodeId: number, _groundNode: number): void {
    this._nodeId = nodeId;
  }

  /** Hot-update a single electrical parameter on this pin model. */
  setParam(key: string, value: number): void {
    if (key in this._spec) {
      (this._spec as unknown as Record<string, number>)[key] = value;
    }
  }

  /**
   * Stamp the input loading conductance 1/rIn from node to ground.
   *
   * No-op when not loaded.
   */
  stamp(solver: SparseSolver): void {
    if (!this._loaded) return;
    const node = this._nodeId;
    if (node <= 0) return;
    solver.stamp(node - 1, node - 1, 1 / this._spec.rIn);
  }

  /**
   * Stamp the companion model for C_in.
   *
   * No-op when not loaded or cIn === 0.
   */
  stampCompanion(
    solver: SparseSolver,
    dt: number,
    method: IntegrationMethod,
  ): void {
    if (!this._loaded) return;
    const node = this._nodeId;
    if (node <= 0) return;
    const C = this._spec.cIn;
    if (C <= 0) return;
    const idx = node - 1;
    const geq = capacitorConductance(C, dt, method);
    const ieq = capacitorHistoryCurrent(
      C,
      dt,
      method,
      this._prevVoltage,
      0,
      this._prevCurrent,
    );
    solver.stamp(idx, idx, geq);
    solver.stampRHS(idx, -ieq);
  }

  /**
   * Update C_in companion state for the newly accepted timestep voltage.
   */
  updateCompanion(
    dt: number,
    method: IntegrationMethod,
    voltage: number,
  ): void {
    if (!this._loaded) return;
    const C = this._spec.cIn;
    if (C <= 0) return;
    const geq = capacitorConductance(C, dt, method);
    const ieq = capacitorHistoryCurrent(
      C,
      dt,
      method,
      this._prevVoltage,
      0,
      this._prevCurrent,
    );
    const iNow = geq * voltage + ieq;
    this._prevCurrent = iNow;
    this._prevVoltage = voltage;
  }

  /**
   * Apply threshold detection to a node voltage.
   *
   * Returns true  when voltage > vIH  (logic HIGH),
   *         false when voltage < vIL  (logic LOW),
   *         undefined               (indeterminate — between thresholds).
   */
  readLogicLevel(voltage: number): boolean | undefined {
    if (voltage > this._spec.vIH) return true;
    if (voltage < this._spec.vIL) return false;
    return undefined;
  }

  /** The node ID assigned by init(). */
  get nodeId(): number {
    return this._nodeId;
  }

  /** Input impedance in ohms. */
  get rIn(): number {
    return this._spec.rIn;
  }

  /** Input capacitance in farads. */
  get capacitance(): number {
    return this._spec.cIn;
  }
}

// ---------------------------------------------------------------------------
// Shared delegation helper for elements that own pin models
// ---------------------------------------------------------------------------

/**
 * Route a composite pin-param key ("A.rOut", "D.vIH") to the correct
 * pin model's setParam. Returns true if the key was handled.
 *
 * Elements that hold DigitalInputPinModel / DigitalOutputPinModel instances
 * build a label→model map at construction time and delegate from setParam:
 *
 *   setParam(key: string, value: number): void {
 *     delegatePinSetParam(this._pinModelsByLabel, key, value);
 *   }
 */
export function delegatePinSetParam(
  pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>,
  key: string,
  value: number,
): boolean {
  const dot = key.indexOf('.');
  if (dot === -1) return false;
  const pinLabel = key.slice(0, dot);
  const paramName = key.slice(dot + 1);
  const model = pinModelsByLabel.get(pinLabel);
  if (model !== undefined) {
    model.setParam(paramName, value);
    return true;
  }
  return false;
}
