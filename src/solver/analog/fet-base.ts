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

import type { AnalogElementCore, IntegrationMethod, StatePoolRef } from "../../core/analog-types.js";
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
// Slot layout for state pool (stateSize: 12)
// ---------------------------------------------------------------------------

const SLOT_VGS       = 0;
const SLOT_VDS       = 1;
const SLOT_GM        = 2;
const SLOT_GDS       = 3;
const SLOT_IDS       = 4;
const SLOT_SWAPPED   = 5;  // 0.0 = false, 1.0 = true
const SLOT_CAP_GEQ_GS = 6;
const SLOT_CAP_IEQ_GS = 7;
const SLOT_CAP_GEQ_GD = 8;
const SLOT_CAP_IEQ_GD = 9;
const SLOT_VGS_PREV  = 10;
const SLOT_VGD_PREV  = 11;

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

  // State pool slot constants (public for tests)
  static readonly SLOT_VGS       = SLOT_VGS;
  static readonly SLOT_VDS       = SLOT_VDS;
  static readonly SLOT_GM        = SLOT_GM;
  static readonly SLOT_GDS       = SLOT_GDS;
  static readonly SLOT_IDS       = SLOT_IDS;
  static readonly SLOT_SWAPPED   = SLOT_SWAPPED;
  static readonly SLOT_CAP_GEQ_GS = SLOT_CAP_GEQ_GS;
  static readonly SLOT_CAP_IEQ_GS = SLOT_CAP_IEQ_GS;
  static readonly SLOT_CAP_GEQ_GD = SLOT_CAP_GEQ_GD;
  static readonly SLOT_CAP_IEQ_GD = SLOT_CAP_IEQ_GD;
  static readonly SLOT_VGS_PREV  = SLOT_VGS_PREV;
  static readonly SLOT_VGD_PREV  = SLOT_VGD_PREV;

  // State pool backing array — bound in initState()
  private _s0!: Float64Array;

  // Source-stepping scale factor — not stored in pool (not state)
  protected _sourceScale: number = 1.0;

  // State pool interface
  readonly stateSize: number = 12;
  stateBaseOffset: number = -1;

  initState(pool: StatePoolRef): void {
    this._s0 = pool.state0;
    // Initialize device-off linearization values
    this._s0[this.stateBaseOffset + SLOT_VGS]     = 0;
    this._s0[this.stateBaseOffset + SLOT_VDS]     = 0;
    this._s0[this.stateBaseOffset + SLOT_GM]      = 1e-12;
    this._s0[this.stateBaseOffset + SLOT_GDS]     = 1e-12;
    this._s0[this.stateBaseOffset + SLOT_IDS]     = 0;
    this._s0[this.stateBaseOffset + SLOT_SWAPPED] = 0;
    this._s0[this.stateBaseOffset + SLOT_CAP_GEQ_GS] = 0;
    this._s0[this.stateBaseOffset + SLOT_CAP_IEQ_GS] = 0;
    this._s0[this.stateBaseOffset + SLOT_CAP_GEQ_GD] = 0;
    this._s0[this.stateBaseOffset + SLOT_CAP_IEQ_GD] = 0;
    // NaN signals first stampCompanion call — use current voltage as warm start
    this._s0[this.stateBaseOffset + SLOT_VGS_PREV] = NaN;
    this._s0[this.stateBaseOffset + SLOT_VGD_PREV] = NaN;
  }

  // Getters and setters backed by state pool
  protected get _vgs(): number { return this._s0[this.stateBaseOffset + SLOT_VGS]; }
  protected set _vgs(v: number) { this._s0[this.stateBaseOffset + SLOT_VGS] = v; }

  protected get _vds(): number { return this._s0[this.stateBaseOffset + SLOT_VDS]; }
  protected set _vds(v: number) { this._s0[this.stateBaseOffset + SLOT_VDS] = v; }

  protected get _gm(): number { return this._s0[this.stateBaseOffset + SLOT_GM]; }
  protected set _gm(v: number) { this._s0[this.stateBaseOffset + SLOT_GM] = v; }

  protected get _gds(): number { return this._s0[this.stateBaseOffset + SLOT_GDS]; }
  protected set _gds(v: number) { this._s0[this.stateBaseOffset + SLOT_GDS] = v; }

  protected get _ids(): number { return this._s0[this.stateBaseOffset + SLOT_IDS]; }
  protected set _ids(v: number) { this._s0[this.stateBaseOffset + SLOT_IDS] = v; }

  protected get _swapped(): boolean { return this._s0[this.stateBaseOffset + SLOT_SWAPPED] !== 0; }
  protected set _swapped(v: boolean) { this._s0[this.stateBaseOffset + SLOT_SWAPPED] = v ? 1.0 : 0.0; }

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

    const capGeqGS = this._s0[this.stateBaseOffset + SLOT_CAP_GEQ_GS];
    const capIeqGS = this._s0[this.stateBaseOffset + SLOT_CAP_IEQ_GS];
    const capGeqGD = this._s0[this.stateBaseOffset + SLOT_CAP_GEQ_GD];
    const capIeqGD = this._s0[this.stateBaseOffset + SLOT_CAP_IEQ_GD];

    if (capGeqGS !== 0 || capIeqGS !== 0) {
      stampG(solver, nodeG, nodeG, capGeqGS);
      stampG(solver, nodeG, nodeS, -capGeqGS);
      stampG(solver, nodeS, nodeG, -capGeqGS);
      stampG(solver, nodeS, nodeS, capGeqGS);
      stampRHS(solver, nodeG, -capIeqGS);
      stampRHS(solver, nodeS, capIeqGS);
    }

    if (capGeqGD !== 0 || capIeqGD !== 0) {
      stampG(solver, nodeG, nodeG, capGeqGD);
      stampG(solver, nodeG, nodeD, -capGeqGD);
      stampG(solver, nodeD, nodeG, -capGeqGD);
      stampG(solver, nodeD, nodeD, capGeqGD);
      stampRHS(solver, nodeG, -capIeqGD);
      stampRHS(solver, nodeD, capIeqGD);
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

  updateOperatingPoint(voltages: Readonly<Float64Array>): void {
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

    const base = this.stateBaseOffset;
    const vgsPrevStored = this._s0[base + SLOT_VGS_PREV];
    const vgdPrevStored = this._s0[base + SLOT_VGD_PREV];

    // NaN signals first call — use current voltage as warm start
    const isFirstCall = isNaN(vgsPrevStored);
    const prevVgs = isFirstCall ? vgsNow : vgsPrevStored;
    const prevVgd = isFirstCall ? vgdNow : vgdPrevStored;

    // Recover capacitor currents at previous accepted step
    const capGeqGS = this._s0[base + SLOT_CAP_GEQ_GS];
    const capIeqGS = this._s0[base + SLOT_CAP_IEQ_GS];
    const capGeqGD = this._s0[base + SLOT_CAP_GEQ_GD];
    const capIeqGD = this._s0[base + SLOT_CAP_IEQ_GD];
    const iGS = capGeqGS * vgsNow + capIeqGS;
    const iGD = capGeqGD * vgdNow + capIeqGD;

    this._s0[base + SLOT_VGS_PREV] = vgsNow;
    this._s0[base + SLOT_VGD_PREV] = vgdNow;

    const caps = this.computeCapacitances(this._vgs, this._vds);

    if (caps.cgs > 0) {
      this._s0[base + SLOT_CAP_GEQ_GS] = capacitorConductance(caps.cgs, dt, method);
      this._s0[base + SLOT_CAP_IEQ_GS] = capacitorHistoryCurrent(caps.cgs, dt, method, vgsNow, prevVgs, iGS);
    } else {
      this._s0[base + SLOT_CAP_GEQ_GS] = 0;
      this._s0[base + SLOT_CAP_IEQ_GS] = 0;
    }

    if (caps.cgd > 0) {
      this._s0[base + SLOT_CAP_GEQ_GD] = capacitorConductance(caps.cgd, dt, method);
      this._s0[base + SLOT_CAP_IEQ_GD] = capacitorHistoryCurrent(caps.cgd, dt, method, vgdNow, prevVgd, iGD);
    } else {
      this._s0[base + SLOT_CAP_GEQ_GD] = 0;
      this._s0[base + SLOT_CAP_IEQ_GD] = 0;
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
