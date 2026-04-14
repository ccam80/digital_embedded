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
import { integrateCapacitor } from "./integration.js";
import { defineStateSchema, applyInitialValues } from "./state-schema.js";
import type { StateSchema } from "./state-schema.js";
import { cktTerr } from "./ckt-terr.js";
import type { LteParams } from "./ckt-terr.js";

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
// Slot layout for state pool (stateSize: 40)
// ---------------------------------------------------------------------------

export const SLOT_VGS       = 0;
export const SLOT_VDS       = 1;
export const SLOT_GM        = 2;
export const SLOT_GDS       = 3;
export const SLOT_IDS       = 4;
export const SLOT_SWAPPED   = 5;  // 0.0 = false, 1.0 = true
export const SLOT_CAP_GEQ_GS = 6;
export const SLOT_CAP_IEQ_GS = 7;
export const SLOT_CAP_GEQ_GD = 8;
export const SLOT_CAP_IEQ_GD = 9;
// Current-step voltages for companion model (replacing _PREV slots)
export const SLOT_V_GS      = 10;  // Gate-source voltage at current step (for companion)
export const SLOT_V_GD      = 11;  // Gate-drain voltage at current step (for companion)
// Junction and gate-bulk cap state (slots 12–19)
export const SLOT_CAP_GEQ_DB            = 12;
export const SLOT_CAP_IEQ_DB            = 13;
export const SLOT_CAP_GEQ_SB            = 14;
export const SLOT_CAP_IEQ_SB            = 15;
export const SLOT_V_DB                  = 16;  // Drain-bulk voltage at current step
export const SLOT_V_SB                  = 17;  // Source-bulk voltage at current step
export const SLOT_CAP_GEQ_GB            = 18;
export const SLOT_CAP_IEQ_GB            = 19;
export const SLOT_V_GB                  = 20;  // Gate-bulk voltage at current step
// Body-effect operating-point state (slots 21–22) — MOSFET-specific, zero-init fine
export const SLOT_VSB                   = 21;
export const SLOT_GMBS                  = 22;
// Bulk junction DC state (slots 23–27) — needed for MOS1convTest convergence check
export const SLOT_GBD                   = 23;  // drain-bulk junction conductance
export const SLOT_GBS                   = 24;  // source-bulk junction conductance
export const SLOT_CBD_I                 = 25;  // drain-bulk junction current
export const SLOT_CBS_I                 = 26;  // source-bulk junction current
export const SLOT_VBD                   = 27;  // drain-bulk voltage (stored)
// MOSFET ngspice-correct limiting state (slots 28–31)
export const SLOT_VON                   = 28;  // previous Vth (for fetlim von)
export const SLOT_VBS_OLD               = 29;  // previous Vbs (for pnjlim)
export const SLOT_VBD_OLD               = 30;  // previous Vbd (for pnjlim)
export const SLOT_MODE                  = 31;  // +1 normal, -1 reverse (for convergence/Norton)
// Charge at current step for CKTterr (history comes from s1/s2/s3 at same offsets)
export const SLOT_Q_GS                  = 32;  // Gate-source charge at current step
export const SLOT_Q_GD                  = 33;  // Gate-drain charge at current step
export const SLOT_Q_GB                  = 34;  // Gate-bulk charge at current step
// Meyer half-cap averaging slots (mos1load.c:769-786)
export const SLOT_MEYER_GS              = 35;  // Meyer half-cap for gate-source
export const SLOT_MEYER_GD              = 36;  // Meyer half-cap for gate-drain
export const SLOT_MEYER_GB              = 37;  // Meyer half-cap for gate-bulk
export const SLOT_CCAP_GS               = 38;  // Gate-source companion current (for LTE)
export const SLOT_CCAP_GD               = 39;  // Gate-drain companion current (for LTE)
export const SLOT_CCAP_GB               = 40;  // Gate-bulk companion current (for LTE)
export const SLOT_Q_DB                  = 41;  // Drain-bulk junction charge
export const SLOT_Q_SB                  = 42;  // Source-bulk junction charge
export const SLOT_CCAP_DB               = 43;  // Drain-bulk companion current (for LTE)
export const SLOT_CCAP_SB               = 44;  // Source-bulk companion current (for LTE)

// Keep legacy names as aliases so mosfet.ts imports still resolve during transition
/** @deprecated Use SLOT_V_GS */
export const SLOT_VGS_PREV              = SLOT_V_GS;
/** @deprecated Use SLOT_V_GD */
export const SLOT_VGD_PREV              = SLOT_V_GD;
/** @deprecated Use SLOT_V_DB */
export const SLOT_VDB_PREV              = SLOT_V_DB;
/** @deprecated Use SLOT_V_SB */
export const SLOT_VSB_PREV              = SLOT_V_SB;
/** @deprecated Use SLOT_V_GB */
export const SLOT_VGB_PREV              = SLOT_V_GB;
/** @deprecated Eliminated — first call detection via s1[Q]===0 */
export const SLOT_CAP_JUNCTION_FIRST_CALL = -1;
/** @deprecated Eliminated — first call detection via s1[Q]===0 */
export const SLOT_CAP_GB_FIRST_CALL     = -1;
/** @deprecated Use SLOT_Q_GS */
export const SLOT_Q_GS_NOW              = SLOT_Q_GS;
/** @deprecated History from s1[SLOT_Q_GS] */
export const SLOT_Q_GS_PREV             = SLOT_Q_GS;
/** @deprecated History from s2[SLOT_Q_GS] */
export const SLOT_Q_GS_PREV2            = SLOT_Q_GS;
/** @deprecated History from s3[SLOT_Q_GS] */
export const SLOT_Q_GS_PREV3            = SLOT_Q_GS;
/** @deprecated Use SLOT_Q_GD */
export const SLOT_Q_GD_NOW              = SLOT_Q_GD;
/** @deprecated History from s1[SLOT_Q_GD] */
export const SLOT_Q_GD_PREV             = SLOT_Q_GD;
/** @deprecated History from s2[SLOT_Q_GD] */
export const SLOT_Q_GD_PREV2            = SLOT_Q_GD;
/** @deprecated History from s3[SLOT_Q_GD] */
export const SLOT_Q_GD_PREV3            = SLOT_Q_GD;
/** @deprecated Use SLOT_Q_GB */
export const SLOT_Q_GB_NOW              = SLOT_Q_GB;
/** @deprecated History from s1[SLOT_Q_GB] */
export const SLOT_Q_GB_PREV             = SLOT_Q_GB;
/** @deprecated History from s2[SLOT_Q_GB] */
export const SLOT_Q_GB_PREV2            = SLOT_Q_GB;
/** @deprecated History from s3[SLOT_Q_GB] */
export const SLOT_Q_GB_PREV3            = SLOT_Q_GB;
/** @deprecated Eliminated — history from s1/s2 */
export const SLOT_CAP_I_GS_PREV         = -1;
/** @deprecated Eliminated — history from s1/s2 */
export const SLOT_CAP_I_GS_PREV_PREV    = -1;
/** @deprecated Eliminated — history from s1/s2 */
export const SLOT_CAP_I_GD_PREV         = -1;
/** @deprecated Eliminated — history from s1/s2 */
export const SLOT_CAP_I_GD_PREV_PREV    = -1;
/** @deprecated Eliminated — history from s1/s2 */
export const SLOT_CAP_I_GB_PREV         = -1;
/** @deprecated Eliminated — history from s1/s2 */
export const SLOT_CAP_I_GB_PREV_PREV    = -1;

export const FET_BASE_SCHEMA: StateSchema = defineStateSchema("AbstractFetElement", [
  { name: "VGS",       doc: "Gate-source voltage",                               init: { kind: "zero" } },
  { name: "VDS",       doc: "Drain-source voltage",                              init: { kind: "zero" } },
  { name: "GM",        doc: "Transconductance",                                  init: { kind: "constant", value: 1e-12 } },
  { name: "GDS",       doc: "Output conductance",                                init: { kind: "constant", value: 1e-12 } },
  { name: "IDS",       doc: "Drain-source current",                              init: { kind: "zero" } },
  { name: "SWAPPED",   doc: "Source/drain swap flag (0=false, 1=true)",          init: { kind: "zero" } },
  { name: "CAP_GEQ_GS", doc: "Gate-source companion conductance",               init: { kind: "zero" } },
  { name: "CAP_IEQ_GS", doc: "Gate-source companion history current",           init: { kind: "zero" } },
  { name: "CAP_GEQ_GD", doc: "Gate-drain companion conductance",                init: { kind: "zero" } },
  { name: "CAP_IEQ_GD", doc: "Gate-drain companion history current",            init: { kind: "zero" } },
  { name: "V_GS",      doc: "Gate-source voltage at current step (companion)",   init: { kind: "zero" } },
  { name: "V_GD",      doc: "Gate-drain voltage at current step (companion)",    init: { kind: "zero" } },
  { name: "CAP_GEQ_DB", doc: "Drain-bulk companion conductance",                init: { kind: "zero" } },
  { name: "CAP_IEQ_DB", doc: "Drain-bulk companion history current",            init: { kind: "zero" } },
  { name: "CAP_GEQ_SB", doc: "Source-bulk companion conductance",               init: { kind: "zero" } },
  { name: "CAP_IEQ_SB", doc: "Source-bulk companion history current",           init: { kind: "zero" } },
  { name: "V_DB",      doc: "Drain-bulk voltage at current step (companion)",    init: { kind: "zero" } },
  { name: "V_SB",      doc: "Source-bulk voltage at current step (companion)",   init: { kind: "zero" } },
  { name: "CAP_GEQ_GB", doc: "Gate-bulk companion conductance",                 init: { kind: "zero" } },
  { name: "CAP_IEQ_GB", doc: "Gate-bulk companion history current",             init: { kind: "zero" } },
  { name: "V_GB",      doc: "Gate-bulk voltage at current step (companion)",     init: { kind: "zero" } },
  { name: "VSB",       doc: "Source-bulk voltage (MOSFET body effect)",          init: { kind: "zero" } },
  { name: "GMBS",      doc: "Body-effect transconductance",                      init: { kind: "zero" } },
  { name: "GBD",       doc: "Drain-bulk junction conductance",                   init: { kind: "zero" } },
  { name: "GBS",       doc: "Source-bulk junction conductance",                  init: { kind: "zero" } },
  { name: "CBD_I",     doc: "Drain-bulk junction current",                       init: { kind: "zero" } },
  { name: "CBS_I",     doc: "Source-bulk junction current",                      init: { kind: "zero" } },
  { name: "VBD",       doc: "Drain-bulk voltage (stored)",                       init: { kind: "zero" } },
  { name: "VON",       doc: "Previous threshold voltage (for fetlim von)",       init: { kind: "constant", value: NaN } },
  { name: "VBS_OLD",   doc: "Previous Vbs (for pnjlim)",                         init: { kind: "zero" } },
  { name: "VBD_OLD",   doc: "Previous Vbd (for pnjlim)",                         init: { kind: "zero" } },
  { name: "MODE",      doc: "Normal (+1) or reverse (-1) mode",                  init: { kind: "constant", value: 1.0 } },
  { name: "Q_GS",      doc: "Gate-source charge at current step",                init: { kind: "zero" } },
  { name: "Q_GD",      doc: "Gate-drain charge at current step",                 init: { kind: "zero" } },
  { name: "Q_GB",      doc: "Gate-bulk charge at current step",                  init: { kind: "zero" } },
  { name: "MEYER_GS",  doc: "Meyer half-cap for gate-source averaging",          init: { kind: "zero" } },
  { name: "MEYER_GD",  doc: "Meyer half-cap for gate-drain averaging",           init: { kind: "zero" } },
  { name: "MEYER_GB",  doc: "Meyer half-cap for gate-bulk averaging",            init: { kind: "zero" } },
  { name: "CCAP_GS",   doc: "Gate-source companion current",                     init: { kind: "zero" } },
  { name: "CCAP_GD",   doc: "Gate-drain companion current",                      init: { kind: "zero" } },
  { name: "CCAP_GB",   doc: "Gate-bulk companion current",                       init: { kind: "zero" } },
  { name: "Q_DB",      doc: "Drain-bulk junction charge",                        init: { kind: "zero" } },
  { name: "Q_SB",      doc: "Source-bulk junction charge",                       init: { kind: "zero" } },
  { name: "CCAP_DB",   doc: "Drain-bulk companion current",                      init: { kind: "zero" } },
  { name: "CCAP_SB",   doc: "Source-bulk companion current",                     init: { kind: "zero" } },
]);

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
  label?: string;        // set by compiler via Object.assign after factory returns
  elementIndex?: number; // set by compiler via Object.assign after factory returns
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

  // State pool backing arrays — bound in initState(), refreshed by StatePool.refreshElementRefs()
  protected _s0!: Float64Array;
  s0!: Float64Array;
  s1!: Float64Array;
  s2!: Float64Array;
  s3!: Float64Array;
  protected _pool!: StatePoolRef;

  // Source-stepping scale factor — not stored in pool (not state)
  protected _sourceScale: number = 1.0;

  // Ephemeral per-iteration pnjlim limiting flag (ngspice icheck, sets CKTnoncon++)
  protected _pnjlimLimited: boolean = false;

  // State pool interface
  readonly poolBacked = true as const;
  readonly stateSchema = FET_BASE_SCHEMA;
  readonly stateSize = FET_BASE_SCHEMA.size;
  stateBaseOffset: number = -1;

  initState(pool: StatePoolRef): void {
    this._s0 = pool.state0;
    this.s0 = pool.state0;
    this.s1 = pool.state1;
    this.s2 = pool.state2;
    this.s3 = pool.state3;
    this._pool = pool;
    applyInitialValues(FET_BASE_SCHEMA, pool, this.stateBaseOffset, {});
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
   * Base FET has no topology-constant entries. Subclasses may override.
   * Capacitance companion model entries are stamped in stampReactiveCompanion().
   */
  stamp(_solver: SparseSolver): void {
    // Base FET has no topology-constant entries. Subclasses may override.
  }

  /**
   * Stamp GS and GD gate capacitance companion model entries.
   *
   * Called every NR iteration after stampNonlinear. Subclasses with additional
   * junction capacitances (e.g. MOSFET GB, DB, SB) override this and call super.
   */
  stampReactiveCompanion(solver: SparseSolver): void {
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

  checkConvergence(voltages: Float64Array, _prevVoltages: Float64Array, reltol: number, abstol: number): boolean {
    // ngspice icheck gate: if voltage was limited in updateOperatingPoint,
    // declare non-convergence immediately (MOSload/JFETload sets CKTnoncon++)
    if (this._pnjlimLimited) return false;

    const nodeD = this.drainNode;
    const nodeG = this.gateNode;
    const nodeS = this.sourceNode;

    const vD = nodeD > 0 ? voltages[nodeD - 1] : 0;
    const vG = nodeG > 0 ? voltages[nodeG - 1] : 0;
    const vS = nodeS > 0 ? voltages[nodeS - 1] : 0;

    // Raw junction voltages from current NR iterate (polarity-corrected)
    const vgsRaw = this.polaritySign * (vG - vS);
    const vdsRaw = this.polaritySign * (vD - vS);
    // Compute VBS from raw node voltages (ngspice mos1conv.c:36-43)
    const nodeBulk = this.pinNodeIds.length > 3 ? this.pinNodeIds[3] : nodeS;
    const vBulk = nodeBulk > 0 ? voltages[nodeBulk - 1] : 0;
    const vbsRaw = this.polaritySign * (vBulk - vS);
    const vbdRaw = vbsRaw - vdsRaw;

    // Stored operating-point values from last updateOperatingPoint
    const storedVgs = this._vgs;
    const storedVds = this._vds;
    const storedVbs = -this._s0[this.stateBaseOffset + SLOT_VSB]; // stored VBS = -VSB
    const storedVbd = this._s0[this.stateBaseOffset + SLOT_VBD];

    // Deltas between raw iterate and stored (limited) values
    const delvgs = vgsRaw - storedVgs;
    const delvds = vdsRaw - storedVds;
    const delvbs = vbsRaw - storedVbs;
    const delvbd = vbdRaw - storedVbd;

    // Read small-signal parameters from pool
    const base = this.stateBaseOffset;
    const s0 = this._s0;
    const gm   = s0[base + SLOT_GM];
    const gds  = s0[base + SLOT_GDS];
    const gmbs = s0[base + SLOT_GMBS];
    const ids  = s0[base + SLOT_IDS];
    const gbd  = s0[base + SLOT_GBD];
    const gbs  = s0[base + SLOT_GBS];
    const cbdI = s0[base + SLOT_CBD_I];
    const cbsI = s0[base + SLOT_CBS_I];

    // cd = mode * channel current minus drain junction current (ngspice MOS1convTest mos1load.c:543)
    const mode = s0[base + SLOT_MODE];
    const cd = mode * ids - cbdI;
    // Subtract drain junction cap companion current (ngspice mos1load.c:699)
    const cqbd = s0[base + SLOT_CAP_IEQ_DB];
    const cdFinal = cd - cqbd;

    // MOS1convTest: predicted drain current — mode-dependent formula
    let cdhat: number;
    if (mode >= 0) {
      // Normal mode
      cdhat = cdFinal + gm * delvgs + gds * delvds + gmbs * delvbs - gbd * delvbd;
    } else {
      // Reverse mode: vgd = vgs - vds
      const delvgd = delvgs - delvds;
      cdhat = cdFinal - (gbd - gmbs) * delvbd - gm * delvgd + gds * delvds;
    }

    // MOS1convTest: predicted bulk current
    const cbhat = cbsI + cbdI + gbd * delvbd + gbs * delvbs;

    const tolD = reltol * Math.max(Math.abs(cdhat), Math.abs(cdFinal)) + abstol;
    const tolB = reltol * Math.max(Math.abs(cbhat), Math.abs(cbsI + cbdI)) + abstol;

    return Math.abs(cdhat - cdFinal) <= tolD && Math.abs(cbhat - (cbsI + cbdI)) <= tolB;
  }

  stampCompanion(dt: number, method: IntegrationMethod, _voltages: Float64Array, order: number, deltaOld: readonly number[]): void {
    // Compute vgs/vgd freshly from current node voltages (ngspice mos1load.c
    // single-pass semantics). Voltage limiting is a mid-NR stabilizer applied
    // in updateOperatingPoint; at step boundaries / post-convergence,
    // raw == limited. Never read a cross-phase cached field/slot.
    const nodeG_sc = this.gateNode;
    const nodeD_sc = this.drainNode;
    const nodeS_sc = this.sourceNode;
    const vG_sc = nodeG_sc > 0 ? _voltages[nodeG_sc - 1] : 0;
    const vD_sc = nodeD_sc > 0 ? _voltages[nodeD_sc - 1] : 0;
    const vS_sc = nodeS_sc > 0 ? _voltages[nodeS_sc - 1] : 0;
    const vgsNow = this.polaritySign * (vG_sc - vS_sc);
    const vdsNow = this.polaritySign * (vD_sc - vS_sc);
    const vgdNow = vgsNow - vdsNow;

    const base = this.stateBaseOffset;
    const isFirstCall = this._pool.tranStep === 0;

    // Write current voltages to s0
    this._s0[base + SLOT_V_GS] = vgsNow;
    this._s0[base + SLOT_V_GD] = vgdNow;

    const caps = this.computeCapacitances(vgsNow, vdsNow);
    const h1 = deltaOld.length > 1 ? deltaOld[1] : dt;
    const h2 = deltaOld.length > 2 ? deltaOld[2] : h1;

    if (caps.cgs > 0) {
      // Meyer incremental charge: Q = cgs*(vgs - prevVgs) + prevQ
      const prevVgs = this.s1[base + SLOT_V_GS];
      const prevQgs = this.s1[base + SLOT_Q_GS];
      const q0 = isFirstCall ? caps.cgs * vgsNow : caps.cgs * (vgsNow - prevVgs) + prevQgs;
      const q1 = this.s1[base + SLOT_Q_GS];
      const q2 = this.s2[base + SLOT_Q_GS];
      const ccapPrev = this.s1[base + SLOT_CCAP_GS];
      const res = integrateCapacitor(caps.cgs, vgsNow, q0, q1, q2, dt, h1, h2, order, method, ccapPrev);
      this._s0[base + SLOT_CAP_GEQ_GS] = res.geq;
      this._s0[base + SLOT_CAP_IEQ_GS] = res.ceq;
      this._s0[base + SLOT_CCAP_GS] = res.ccap;
      this._s0[base + SLOT_Q_GS] = q0;
    } else {
      this._s0[base + SLOT_CAP_GEQ_GS] = 0;
      this._s0[base + SLOT_CAP_IEQ_GS] = 0;
      this._s0[base + SLOT_CCAP_GS] = 0;
    }

    if (caps.cgd > 0) {
      // Meyer incremental charge: Q = cgd*(vgd - prevVgd) + prevQ
      const prevVgd = this.s1[base + SLOT_V_GD];
      const prevQgd = this.s1[base + SLOT_Q_GD];
      const q0 = isFirstCall ? caps.cgd * vgdNow : caps.cgd * (vgdNow - prevVgd) + prevQgd;
      const q1 = this.s1[base + SLOT_Q_GD];
      const q2 = this.s2[base + SLOT_Q_GD];
      const ccapPrev = this.s1[base + SLOT_CCAP_GD];
      const res = integrateCapacitor(caps.cgd, vgdNow, q0, q1, q2, dt, h1, h2, order, method, ccapPrev);
      this._s0[base + SLOT_CAP_GEQ_GD] = res.geq;
      this._s0[base + SLOT_CAP_IEQ_GD] = res.ceq;
      this._s0[base + SLOT_CCAP_GD] = res.ccap;
      this._s0[base + SLOT_Q_GD] = q0;
    } else {
      this._s0[base + SLOT_CAP_GEQ_GD] = 0;
      this._s0[base + SLOT_CAP_IEQ_GD] = 0;
      this._s0[base + SLOT_CCAP_GD] = 0;
    }

    // ngspice mos1load.c:842-853 — zero gate cap companions during MODEINITTRAN
    if (isFirstCall) {
      this._s0[base + SLOT_CAP_GEQ_GS] = 0;
      this._s0[base + SLOT_CAP_IEQ_GS] = 0;
      this._s0[base + SLOT_CCAP_GS] = 0;
      this._s0[base + SLOT_CAP_GEQ_GD] = 0;
      this._s0[base + SLOT_CAP_IEQ_GD] = 0;
      this._s0[base + SLOT_CCAP_GD] = 0;
    }
  }

  updateChargeFlux(voltages: Float64Array, dt: number, method: IntegrationMethod, order: number, deltaOld: readonly number[]): void {
    const nodeG = this.gateNode;
    const nodeD = this.drainNode;
    const nodeS = this.sourceNode;

    // Compute vgs/vgd freshly from converged node voltages — single-pass,
    // no cross-phase cache dependency. At post-NR convergence raw == limited,
    // so this matches what updateOperatingPoint wrote on the last iteration.
    const vG = nodeG > 0 ? voltages[nodeG - 1] : 0;
    const vD = nodeD > 0 ? voltages[nodeD - 1] : 0;
    const vS = nodeS > 0 ? voltages[nodeS - 1] : 0;
    const vgsNow = this.polaritySign * (vG - vS);
    const vdsNow = this.polaritySign * (vD - vS);
    const vgdNow = vgsNow - vdsNow;

    const base = this.stateBaseOffset;
    const caps = this.computeCapacitances(vgsNow, vdsNow);

    const isFirstCall = this._pool.tranStep === 0;
    const prevVgs = this.s1[base + SLOT_V_GS];
    const prevVgd = this.s1[base + SLOT_V_GD];
    const prevQgs = this.s1[base + SLOT_Q_GS];
    const prevQgd = this.s1[base + SLOT_Q_GD];

    if (isFirstCall) {
      // TRANOP: Q = C*V (mos1load.c:829-831)
      this._s0[base + SLOT_Q_GS] = caps.cgs * vgsNow;
      this._s0[base + SLOT_Q_GD] = caps.cgd * vgdNow;
    } else {
      // Transient: incremental accumulation (mos1load.c:820-826)
      this._s0[base + SLOT_Q_GS] = caps.cgs * (vgsNow - prevVgs) + prevQgs;
      this._s0[base + SLOT_Q_GD] = caps.cgd * (vgdNow - prevVgd) + prevQgd;
    }

    // Recompute ccap from converged charges so the next step's trapezoidal
    // recursion starts from the correct companion current (fixes stale CCAP_GS/GD).
    if (dt > 0) {
      const h1 = deltaOld.length > 1 ? deltaOld[1] : dt;
      const h2 = deltaOld.length > 2 ? deltaOld[2] : h1;

      if (caps.cgs > 0) {
        const q0gs = this._s0[base + SLOT_Q_GS];
        const q1gs = this.s1[base + SLOT_Q_GS];
        const q2gs = this.s2[base + SLOT_Q_GS];
        const ccapPrevGs = this.s1[base + SLOT_CCAP_GS];
        const resGs = integrateCapacitor(caps.cgs, vgsNow, q0gs, q1gs, q2gs, dt, h1, h2, order, method, ccapPrevGs);
        this._s0[base + SLOT_CCAP_GS] = resGs.ccap;
      }

      if (caps.cgd > 0) {
        const q0gd = this._s0[base + SLOT_Q_GD];
        const q1gd = this.s1[base + SLOT_Q_GD];
        const q2gd = this.s2[base + SLOT_Q_GD];
        const ccapPrevGd = this.s1[base + SLOT_CCAP_GD];
        const resGd = integrateCapacitor(caps.cgd, vgdNow, q0gd, q1gd, q2gd, dt, h1, h2, order, method, ccapPrevGd);
        this._s0[base + SLOT_CCAP_GD] = resGd.ccap;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // LTE timestep estimation — GS and GD gate charges
  // ---------------------------------------------------------------------------

  getLteTimestep(dt: number, deltaOld: readonly number[], order: number, method: IntegrationMethod, lteParams: LteParams): number {
    const base = this.stateBaseOffset;
    let minDt = Infinity;

    // Gate-source
    {
      const ccap0 = this._s0[base + SLOT_CCAP_GS];
      const ccap1 = this.s1[base + SLOT_CCAP_GS];
      const q0 = this._s0[base + SLOT_Q_GS];
      const q1 = this.s1[base + SLOT_Q_GS];
      const q2 = this.s2[base + SLOT_Q_GS];
      const q3 = this.s3[base + SLOT_Q_GS];
      const dtGS = cktTerr(dt, deltaOld, order, method, q0, q1, q2, q3, ccap0, ccap1, lteParams);
      if (dtGS < minDt) minDt = dtGS;
    }

    // Gate-drain
    {
      const ccap0 = this._s0[base + SLOT_CCAP_GD];
      const ccap1 = this.s1[base + SLOT_CCAP_GD];
      const q0 = this._s0[base + SLOT_Q_GD];
      const q1 = this.s1[base + SLOT_Q_GD];
      const q2 = this.s2[base + SLOT_Q_GD];
      const q3 = this.s3[base + SLOT_Q_GD];
      const dtGD = cktTerr(dt, deltaOld, order, method, q0, q1, q2, q3, ccap0, ccap1, lteParams);
      if (dtGD < minDt) minDt = dtGD;
    }

    return minDt;
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
