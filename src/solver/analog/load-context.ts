/**
 * LoadContext — per-iteration context passed to every element.load() call.
 *
 * Matches ngspice's CKTcircuit fields accessed inside DEVload. Pre-allocated
 * on CKTCircuitContext once; mutated in place before each NR iteration.
 * Never re-created during simulation.
 *
 * Field mapping (ngspice CKTcircuit -> ours):
 *   CKTmode     -> cktMode
 *   CKTmatrix   -> solver (the SparseSolver owns the MNA matrix)
 *   CKTrhs      -> rhs
 *   CKTrhsOld   -> rhsOld (prior NR iterate)
 *   CKTtime     -> time
 *   CKTdelta    -> delta (alias: dt)
 *   CKTintegrateMethod -> method
 *   CKTorder    -> order
 *   CKTag[]     -> agVector (alias: ag) — integration coefficients
 *   CKTdeltaOld -> deltaOld
 *   CKTsrcFact  -> srcFact
 *   CKTnoncon   -> noncon.value
 *   CKTxmu/xfact-> xfact
 *   CKTgmin     -> gmin
 *   CKTreltol   -> reltol
 *   CKTabstol   -> iabstol
 *   CKTtemp     -> temp
 *   CKTvt       -> vt (= k * temp / q)
 */

import type { SparseSolver } from "./sparse-solver.js";
import type { IntegrationMethod } from "../../core/analog-types.js";
import type { LimitingEvent } from "./newton-raphson.js";

// ---------------------------------------------------------------------------
// ConvergenceEvent — per-iteration element-level convergence record
// ---------------------------------------------------------------------------

/**
 * Convergence-check record emitted by devices that implement per-element
 * checkConvergence(). Lives alongside LimitingEvent for harness instrumentation.
 * Populated by elements during load(); drained by NR after iteration.
 */
export interface ConvergenceEvent {
  /** Element index within the compiled elements[] array. */
  elementIndex: number;
  /** Optional element label for human-readable diagnostics. */
  label: string;
  /** True if this element considered itself converged this iteration. */
  converged: boolean;
  /** Delta against this element's tolerance threshold. */
  delta: number;
  /** Element-specific tolerance used for the check. */
  tol: number;
}

// ---------------------------------------------------------------------------
// LoadContext
// ---------------------------------------------------------------------------

export interface LoadContext {
  /**
   * ngspice CKTmode bitfield. OR of MODETRAN|MODEAC|MODEDCOP|MODETRANOP|
   * MODEINITJCT|MODEINITFIX|MODEINITFLOAT|MODEINITSMSIG|MODEINITTRAN|
   * MODEUIC|MODEDCTRANCURVE as defined in ./ckt-mode.ts and
   * ref/ngspice/src/include/ngspice/cktdefs.h:165-185.
   * Tested with `ctx.cktMode & MODEXXX`; never stored as booleans.
   */
  cktMode: number;
  /**
   * Sparse solver owning the MNA matrix (ngspice CKTmatrix surrogate).
   * Elements stamp conductance and RHS directly into this.
   */
  solver: SparseSolver;
  /**
   * Alias for `solver`, provided to match the ngspice CKTmatrix field name.
   * Element ports from ngspice that read CKTmatrix bind to ctx.matrix; the
   * value is identical to ctx.solver (same SparseSolver instance).
   */
  matrix: SparseSolver;
  /** Current NR solution vector (ngspice CKTrhs). Read inside accept() methods. */
  rhs: Float64Array;
  /** Previous NR iteration voltages / prior iterate (ngspice CKTrhsOld). Read inside load() methods. */
  rhsOld: Float64Array;
  /** Current simulation time in seconds (ngspice CKTtime). */
  time: number;
  /** Current timestep in seconds (ngspice CKTdelta). 0 during DC-OP. */
  dt: number;
  /**
   * Alias for `dt`, provided to match the ngspice CKTdelta field name.
   * Element ports from ngspice that read CKTdelta bind to ctx.delta; the
   * value is identical to ctx.dt.
   */
  delta: number;
  /**
   * Active numerical integration method. 0 = Trapezoidal, 1 = Gear per
   * ngspice cktdefs.h. The string form is retained for backwards compatibility
   * with existing IntegrationMethod consumers; use numeric 0/1 when porting
   * directly from ngspice device load functions.
   */
  method: IntegrationMethod;
  /** Integration order (1 or 2). */
  order: number;
  /** Timestep history for Vandermonde solve (CKTdeltaOld[7]). */
  deltaOld: readonly number[];
  /** Integration coefficients computed by NIcomCof (CKTag[]). Length 7. */
  ag: Float64Array;
  /** Alias for `ag` to match ngspice CKTag[] field name. Same Float64Array. */
  agVector: Float64Array;
  /** Source stepping scale factor (CKTsrcFact). */
  srcFact: number;
  /** Mutable non-convergence counter (CKTnoncon). Incremented by elements on limiting. */
  noncon: { value: number };
  /** When non-null, elements push LimitingEvent records here during NR. */
  limitingCollector: LimitingEvent[] | null;
  /**
   * When non-null, elements push ConvergenceEvent records here after per-
   * element checkConvergence() runs. Synced by cktLoad / NR per-iteration.
   */
  convergenceCollector: ConvergenceEvent[] | null;
  /** Extrapolation factor for predictor (deltaOld[0] / deltaOld[1]). */
  xfact: number;
  /** Diagonal conductance added for numerical stability (CKTgmin). */
  gmin: number;
  /** Relative convergence tolerance (CKTreltol). */
  reltol: number;
  /** Absolute current tolerance (CKTabstol). */
  iabstol: number;
  /** Circuit temperature in Kelvin (ngspice CKTtemp). */
  temp: number;
  /** Thermal voltage in volts (ngspice CKTvt = k * temp / q). */
  vt: number;
  /**
   * Fix-limit mode flag (ngspice CKTfixLimit per cktdefs.h).
   * When true, the reverse-mode limvds guard in MOSFET load is skipped.
   * Default false — matches ngspice's default (CKTfixLimit not set).
   * See mos1load.c:385: `if(!(ckt->CKTfixLimit)) { ... limvds(-vds, ...) }`.
   */
  cktFixLimit: boolean;
}
