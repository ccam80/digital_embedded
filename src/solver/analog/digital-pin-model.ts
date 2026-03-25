/**
 * DigitalPinModel — reusable MNA stamp helpers for digital pins.
 *
 * DigitalOutputPinModel stamps the Norton equivalent of a digital output:
 *   - Normal mode: conductance 1/rOut from node to ground + current source
 *     V_out/rOut into the node (RHS). No branch variable required.
 *   - Hi-Z mode: conductance 1/rHiZ from node to ground only.
 *   - Companion model for C_out using the same coefficients as the Phase 1
 *     capacitor companion (trapezoidal: 2C/h, BDF-1: C/h, BDF-2: 3C/2h).
 *
 * DigitalInputPinModel stamps the load of a digital input:
 *   - Conductance 1/rIn from node to ground (input loading).
 *   - Companion model for C_in.
 *   - Threshold detection: voltage > vIH → true, voltage < vIL → false,
 *     between → undefined (indeterminate).
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
 * Stamps the analog equivalent of one digital output pin into the MNA matrix.
 *
 * Normal mode uses a Norton equivalent (conductance + current source) so no
 * branch variable is needed. Hi-Z mode replaces the Norton equivalent with a
 * single pull-down conductance 1/rHiZ.
 *
 * A companion model for the output capacitance C_out is maintained using the
 * same coefficients as the Phase 1 capacitor companion model.
 */
export class DigitalOutputPinModel {
  private readonly _spec: ResolvedPinElectrical;

  /** Node this pin drives. Set by init(). */
  private _nodeId = -1;

  /** Target output voltage — vOH when high, vOL when low. */
  private _targetVoltage: number;

  /** True when in Hi-Z state. */
  private _hiZ = false;

  // Companion model state for C_out
  private _prevVoltage = 0;
  private _prevCurrent = 0;

  constructor(spec: ResolvedPinElectrical) {
    this._spec = spec;
    this._targetVoltage = spec.vOL;
  }

  /**
   * Assign the node this pin drives.
   *
   * branchIdx is accepted for compatibility with bridge adapter callers that
   * track branch variables; Norton-equivalent outputs do not use a branch
   * variable, so it is accepted but not stored.
   */
  init(nodeId: number, _branchIdx: number): void {
    this._nodeId = nodeId;
  }

  /** Set the output logic level. High → vOH, low → vOL. */
  setLogicLevel(high: boolean): void {
    this._targetVoltage = high ? this._spec.vOH : this._spec.vOL;
  }

  /**
   * Switch between driven and Hi-Z states.
   *
   * When hiZ is true the Norton equivalent is replaced by 1/rHiZ to ground.
   */
  setHighZ(hiZ: boolean): void {
    this._hiZ = hiZ;
  }

  /**
   * Stamp the linear (topology-constant) portion into the MNA matrix.
   *
   * Normal mode: conductance 1/rOut on the diagonal + current source
   *   V_out/rOut into the node (RHS).
   * Hi-Z mode: conductance 1/rHiZ on the diagonal only.
   *
   * No allocation on this path.
   */
  stamp(solver: SparseSolver): void {
    const node = this._nodeId;
    if (node <= 0) return;
    const idx = node - 1;
    if (this._hiZ) {
      solver.stamp(idx, idx, 1 / this._spec.rHiZ);
    } else {
      const gOut = 1 / this._spec.rOut;
      solver.stamp(idx, idx, gOut);
      solver.stampRHS(idx, this._targetVoltage * gOut);
    }
  }

  /**
   * Stamp the companion model for C_out.
   *
   * Stamps conductance geq = 2C/h (trapezoidal), C/h (BDF-1), or 3C/2h
   * (BDF-2) plus the history current source ieq into the node.
   */
  stampCompanion(
    solver: SparseSolver,
    dt: number,
    method: IntegrationMethod,
  ): void {
    const node = this._nodeId;
    if (node <= 0) return;
    const idx = node - 1;
    const C = this._spec.cOut;
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
   *
   * Stores the voltage and recomputes the companion current so the next
   * stampCompanion() call uses correct history values.
   */
  updateCompanion(
    dt: number,
    method: IntegrationMethod,
    voltage: number,
  ): void {
    const C = this._spec.cOut;
    const geq = capacitorConductance(C, dt, method);
    const ieq = capacitorHistoryCurrent(
      C,
      dt,
      method,
      this._prevVoltage,
      0,
      this._prevCurrent,
    );
    // Current through C_out at the accepted timestep
    const iNow = geq * voltage + ieq;
    this._prevCurrent = iNow;
    this._prevVoltage = voltage;
  }

  /** The node ID assigned by init(). */
  get nodeId(): number {
    return this._nodeId;
  }

  /** The target output voltage (vOH or vOL). */
  get currentVoltage(): number {
    return this._targetVoltage;
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
 * Stamps a conductance 1/rIn from the node to ground (input loading) plus a
 * companion model for C_in. Provides threshold detection via readLogicLevel().
 */
export class DigitalInputPinModel {
  private readonly _spec: ResolvedPinElectrical;

  /** Node this pin reads. Set by init(). */
  private _nodeId = -1;

  // Companion model state for C_in
  private _prevVoltage = 0;
  private _prevCurrent = 0;

  constructor(spec: ResolvedPinElectrical) {
    this._spec = spec;
  }

  /**
   * Assign the node this pin reads.
   *
   * groundNode is accepted for interface symmetry but the conductance is
   * always stamped relative to the MNA ground node (row/col 0 is not
   * explicitly stamped — ground is implicit in MNA formulation).
   */
  init(nodeId: number, _groundNode: number): void {
    this._nodeId = nodeId;
  }

  /**
   * Stamp the input loading conductance 1/rIn from node to ground.
   *
   * In MNA, ground is node 0 and is not represented in the matrix. The
   * conductance stamps as a self-conductance on the node's diagonal only.
   */
  stamp(solver: SparseSolver): void {
    const node = this._nodeId;
    if (node <= 0) return;
    solver.stamp(node - 1, node - 1, 1 / this._spec.rIn);
  }

  /**
   * Stamp the companion model for C_in.
   *
   * Same coefficient formulas as the Phase 1 capacitor companion.
   */
  stampCompanion(
    solver: SparseSolver,
    dt: number,
    method: IntegrationMethod,
  ): void {
    const node = this._nodeId;
    if (node <= 0) return;
    const idx = node - 1;
    const C = this._spec.cIn;
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
    const C = this._spec.cIn;
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
}
