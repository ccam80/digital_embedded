/**
 * AbstractFetElement — shared base class for FET (Field-Effect Transistor) devices.
 *
 * Factors out the common MNA stamping structure shared by MOSFETs and JFETs:
 *   - Three terminals: gate, drain, source
 *   - Newton-Raphson stamping skeleton: reads V_GS, V_DS; calls device-specific
 *     limitVoltages, computeIds, computeGm, computeGds; stamps Norton equivalent
 *   - Junction/gate capacitance companion models via stampCompanion
 *   - Convergence checking based on V_GS and V_DS changes
 *
 * Concrete subclasses implement the abstract methods for their device's I-V model.
 *
 * MNA stamp convention (3-terminal: D, G, S):
 *   The linearized FET produces conductances gm (transconductance) and gds
 *   (output conductance) between terminals, plus Norton current sources at D and S.
 *   Norton current = ids - gm*vgs_op - gds*vds_op
 */

import type { AnalogElement, AnalogElementCore, IntegrationMethod } from "./element.js";
import type { SparseSolver } from "./sparse-solver.js";
import { stampG, stampRHS } from "./stamp-helpers.js";
import {
  capacitorConductance,
  capacitorHistoryCurrent,
} from "./integration.js";

// ---------------------------------------------------------------------------
// FetCapacitances interface
// ---------------------------------------------------------------------------

/**
 * Gate and junction capacitances for a FET device.
 *
 * cgs and cgd are the primary gate capacitances. cds and cgb are optional
 * (absent in simple JFET models, present in full MOSFET models).
 */
export interface FetCapacitances {
  cgs: number;
  cgd: number;
  cds?: number;
  cgb?: number;
}

// ---------------------------------------------------------------------------
// Stamp helpers — node 0 is ground (skipped)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// AbstractFetElement
// ---------------------------------------------------------------------------

/**
 * Abstract base class for FET analog elements.
 *
 * Subclasses must implement the device-physics methods and set polaritySign.
 * The stamping loop in stampNonlinear and updateOperatingPoint is shared.
 */
export abstract class AbstractFetElement implements AnalogElementCore {
  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: true = true;
  readonly isReactive: boolean;
  setParam(_key: string, _value: number): void {}

  /** Gate node index (MNA node, 0 = ground). */
  readonly gateNode: number;
  /** Drain node index (MNA node, 0 = ground). */
  readonly drainNode: number;
  /** Source node index (MNA node, 0 = ground). */
  readonly sourceNode: number;

  /**
   * +1 for N-channel devices, -1 for P-channel devices.
   * Applied to all junction voltage signs and current directions.
   */
  abstract readonly polaritySign: 1 | -1;

  // NR linearization state — initialized with device off
  protected _vgs: number = 0;
  protected _vds: number = 0;
  protected _gm: number = 1e-12;
  protected _gds: number = 1e-12;
  protected _ids: number = 0;
  protected _swapped: boolean = false;
  protected _sourceScale: number = 1.0;

  // Capacitance companion model state
  private _capGeqGS: number = 0;
  private _capIeqGS: number = 0;
  private _capGeqGD: number = 0;
  private _capIeqGD: number = 0;
  private _vgsPrev: number = NaN;
  private _vgdPrev: number = NaN;
  private _capFirstCall: boolean = true;

  constructor(gateNode: number, drainNode: number, sourceNode: number, _extraNodes?: number[]) {
    this.gateNode = gateNode;
    this.drainNode = drainNode;
    this.sourceNode = sourceNode;

    // isReactive is set after construction based on whether capacitances are present.
    // Subclasses set this via _initReactive().
    this.isReactive = false;
  }

  /**
   * Call after construction to enable reactive stamping when capacitances are present.
   * Sets isReactive to true and attaches stampCompanion.
   */
  protected _initReactive(hasCaps: boolean): void {
    (this as unknown as { isReactive: boolean }).isReactive = hasCaps;
  }

  setSourceScale(factor: number): void {
    this._sourceScale = factor;
  }

  /**
   * Stamp the linear part: topology-constant entries only.
   *
   * For basic FETs there are no purely linear terms (no gate resistance etc.).
   * Subclasses with gate resistance override this method and call super.stamp(solver).
   * Capacitance companion model entries are stamped here from previously
   * computed companion coefficients (updated once per timestep in stampCompanion).
   */
  stamp(solver: SparseSolver): void {
    const nodeG = this.gateNode;
    const nodeD = this.drainNode;
    const nodeS = this.sourceNode;

    if (this._capGeqGS !== 0 || this._capIeqGS !== 0) {
      stampG(solver, nodeG, nodeG, this._capGeqGS);
      stampG(solver, nodeG, nodeS, -this._capGeqGS);
      stampG(solver, nodeS, nodeG, -this._capGeqGS);
      stampG(solver, nodeS, nodeS, this._capGeqGS);
      stampRHS(solver, nodeG, -this._capIeqGS);
      stampRHS(solver, nodeS, this._capIeqGS);
    }

    if (this._capGeqGD !== 0 || this._capIeqGD !== 0) {
      stampG(solver, nodeG, nodeG, this._capGeqGD);
      stampG(solver, nodeG, nodeD, -this._capGeqGD);
      stampG(solver, nodeD, nodeG, -this._capGeqGD);
      stampG(solver, nodeD, nodeD, this._capGeqGD);
      stampRHS(solver, nodeG, -this._capIeqGD);
      stampRHS(solver, nodeD, this._capIeqGD);
    }
  }

  stampNonlinear(solver: SparseSolver): void {
    const nodeG = this.gateNode;
    const effectiveD = this._swapped ? this.sourceNode : this.drainNode;
    const effectiveS = this._swapped ? this.drainNode : this.sourceNode;

    const gmS = this._gm * this._sourceScale;
    const gdsS = this._gds * this._sourceScale;

    // Transconductance gm (Vgs): current flows from effectiveS to effectiveD
    stampG(solver, effectiveD, nodeG, gmS);
    stampG(solver, effectiveD, effectiveS, -gmS);
    stampG(solver, effectiveS, nodeG, -gmS);
    stampG(solver, effectiveS, effectiveS, gmS);

    // Output conductance gds (Vds): current flows from effectiveS to effectiveD
    stampG(solver, effectiveD, effectiveD, gdsS);
    stampG(solver, effectiveD, effectiveS, -gdsS);
    stampG(solver, effectiveS, effectiveD, -gdsS);
    stampG(solver, effectiveS, effectiveS, gdsS);

    // Norton current sources (KCL at drain and source)
    // Positive Id flows from D to S in N-channel
    const nortonId = this.polaritySign * (this._ids - this._gm * this._vgs - this._gds * this._vds) * this._sourceScale;
    stampRHS(solver, effectiveD, -nortonId);
    stampRHS(solver, effectiveS, nortonId);
  }

  updateOperatingPoint(voltages: Float64Array): void {
    const nodeD = this.drainNode;
    const nodeG = this.gateNode;
    const nodeS = this.sourceNode;

    const vD = nodeD > 0 ? voltages[nodeD - 1] : 0;
    const vG = nodeG > 0 ? voltages[nodeG - 1] : 0;
    const vS = nodeS > 0 ? voltages[nodeS - 1] : 0;

    // Apply polarity: all junction voltages are sign-flipped for P-channel
    const vGraw = this.polaritySign * (vG - vS);
    const vDraw = this.polaritySign * (vD - vS);

    // Device-specific voltage limiting
    const limited = this.limitVoltages(this._vgs, this._vds, vGraw, vDraw);
    this._vgs = limited.vgs;
    this._vds = limited.vds;
    this._swapped = limited.swapped ?? false;

    // Recompute operating point at limited voltages
    this._ids = this.computeIds(this._vgs, this._vds);
    this._gm = this.computeGm(this._vgs, this._vds);
    this._gds = this.computeGds(this._vgs, this._vds);
  }

  /**
   * Per-pin currents: [I_gate, I_drain, I_source].
   *
   * Positive = current flowing **into** the element at that pin.
   * For the DC/resistive model the gate current is zero; all current
   * flows drain → source. Companion capacitor currents are stamped as
   * separate conductance entries and are already captured by the MNA
   * solution at each node.
   *
   * pinNodeIds order: [gate, drain, source, ...extraNodes]
   */
  getPinCurrents(_voltages: Float64Array): number[] {
    // Drain-source current with polarity and source-stepping scale.
    // Positive _ids = current flows D→S for N-channel (polaritySign = +1).
    const ids = this.polaritySign * this._ids * this._sourceScale;

    // When _swapped, the internal "drain" and "source" roles are reversed
    // relative to the physical pins.
    const iGate = 0;                              // gate draws no DC current
    const iDrain = this._swapped ? -ids : ids;   // into drain
    const iSource = -iDrain;                      // KCL: sum = 0

    // Match pinNodeIds order: [gate, drain, source, ...extra]
    const result = [iGate, iDrain, iSource];
    // Pad any extra nodes (e.g. bulk in 4-terminal MOSFETs) with zero
    for (let i = 3; i < this.pinNodeIds.length; i++) {
      result.push(0);
    }
    return result;
  }

  checkConvergence(voltages: Float64Array, prevVoltages: Float64Array): boolean {
    const nodeD = this.drainNode;
    const nodeG = this.gateNode;
    const nodeS = this.sourceNode;

    const vD = nodeD > 0 ? voltages[nodeD - 1] : 0;
    const vG = nodeG > 0 ? voltages[nodeG - 1] : 0;
    const vS = nodeS > 0 ? voltages[nodeS - 1] : 0;
    const vDp = nodeD > 0 ? prevVoltages[nodeD - 1] : 0;
    const vGp = nodeG > 0 ? prevVoltages[nodeG - 1] : 0;
    const vSp = nodeS > 0 ? prevVoltages[nodeS - 1] : 0;

    const vgsNew = this.polaritySign * (vG - vS);
    const vdsNew = this.polaritySign * (vD - vS);
    const vgsPrev = this.polaritySign * (vGp - vSp);
    const vdsPrev = this.polaritySign * (vDp - vSp);

    const TOL = 0.01;
    return Math.abs(vgsNew - vgsPrev) <= TOL && Math.abs(vdsNew - vdsPrev) <= TOL;
  }

  stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    const nodeG = this.gateNode;
    const nodeD = this.drainNode;
    const nodeS = this.sourceNode;

    const vG = nodeG > 0 ? voltages[nodeG - 1] : 0;
    const vD = nodeD > 0 ? voltages[nodeD - 1] : 0;
    const vS = nodeS > 0 ? voltages[nodeS - 1] : 0;

    const vgsNow = vG - vS;
    const vgdNow = vG - vD;

    const prevVgs = this._capFirstCall ? vgsNow : this._vgsPrev;
    const prevVgd = this._capFirstCall ? vgdNow : this._vgdPrev;

    // Recover capacitor currents at previous accepted step
    const iGS = this._capGeqGS * vgsNow + this._capIeqGS;
    const iGD = this._capGeqGD * vgdNow + this._capIeqGD;

    this._vgsPrev = vgsNow;
    this._vgdPrev = vgdNow;
    this._capFirstCall = false;

    const caps = this.computeCapacitances(this._vgs, this._vds);

    if (caps.cgs > 0) {
      this._capGeqGS = capacitorConductance(caps.cgs, dt, method);
      this._capIeqGS = capacitorHistoryCurrent(caps.cgs, dt, method, vgsNow, prevVgs, iGS);
    } else {
      this._capGeqGS = 0;
      this._capIeqGS = 0;
    }

    if (caps.cgd > 0) {
      this._capGeqGD = capacitorConductance(caps.cgd, dt, method);
      this._capIeqGD = capacitorHistoryCurrent(caps.cgd, dt, method, vgdNow, prevVgd, iGD);
    } else {
      this._capGeqGD = 0;
      this._capIeqGD = 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Abstract device-physics methods — implemented by each device subclass
  // ---------------------------------------------------------------------------

  /**
   * Apply device-specific voltage limiting to proposed V_GS and V_DS.
   *
   * @param vgsOld - Previous V_GS (internal linearization state)
   * @param vdsOld - Previous V_DS (internal linearization state)
   * @param vgsNew - Proposed new V_GS from NR solution
   * @param vdsNew - Proposed new V_DS from NR solution
   * @returns Limited { vgs, vds, swapped? } — swapped indicates source/drain role reversal
   */
  abstract limitVoltages(
    vgsOld: number,
    vdsOld: number,
    vgsNew: number,
    vdsNew: number,
  ): { vgs: number; vds: number; swapped?: boolean };

  /**
   * Compute drain-source current I_DS at the given operating point.
   *
   * @param vgs - Gate-source voltage (polarity-corrected, limiting applied)
   * @param vds - Drain-source voltage (polarity-corrected, limiting applied)
   * @returns Drain current in amps (positive = flows drain to source for N-channel)
   */
  abstract computeIds(vgs: number, vds: number): number;

  /**
   * Compute transconductance gm = ∂I_DS/∂V_GS at the given operating point.
   *
   * @param vgs - Gate-source voltage (polarity-corrected)
   * @param vds - Drain-source voltage (polarity-corrected)
   * @returns Transconductance in siemens (always >= GMIN)
   */
  abstract computeGm(vgs: number, vds: number): number;

  /**
   * Compute output conductance gds = ∂I_DS/∂V_DS at the given operating point.
   *
   * @param vgs - Gate-source voltage (polarity-corrected)
   * @param vds - Drain-source voltage (polarity-corrected)
   * @returns Output conductance in siemens (always >= GMIN)
   */
  abstract computeGds(vgs: number, vds: number): number;

  /**
   * Compute gate and junction capacitances at the given operating point.
   *
   * Called by stampCompanion to update the reactive companion models.
   *
   * @param vgs - Gate-source voltage (polarity-corrected)
   * @param vds - Drain-source voltage (polarity-corrected)
   * @returns FetCapacitances with cgs, cgd, and optional cds/cgb
   */
  abstract computeCapacitances(vgs: number, vds: number): FetCapacitances;
}
