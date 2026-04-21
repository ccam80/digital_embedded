/**
 * LoadContext — per-iteration context passed to every element.load() call.
 *
 * Matches ngspice's CKTcircuit fields accessed inside DEVload. Pre-allocated
 * on CKTCircuitContext once; mutated in place before each NR iteration.
 * Never re-created during simulation.
 */

import type { SparseSolver } from "./sparse-solver.js";
import type { IntegrationMethod } from "../../core/analog-types.js";
import type { LimitingEvent } from "./newton-raphson.js";

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
  /** Sparse solver — element stamps conductance and RHS directly into this. */
  solver: SparseSolver;
  /** Previous NR iteration voltages (CKTrhsOld). */
  voltages: Float64Array;
  /** Current timestep in seconds (CKTdelta). 0 during DC-OP. */
  dt: number;
  /** Active numerical integration method. */
  method: IntegrationMethod;
  /** Integration order (1 or 2). */
  order: number;
  /** Timestep history for Vandermonde solve (CKTdeltaOld[7]). */
  deltaOld: readonly number[];
  /** Integration coefficients computed by NIcomCof (CKTag[]). Length 7. */
  ag: Float64Array;
  /** Source stepping scale factor (CKTsrcFact). */
  srcFact: number;
  /** Mutable non-convergence counter (CKTnoncon). Incremented by elements on limiting. */
  noncon: { value: number };
  /** When non-null, elements push LimitingEvent records here during NR. */
  limitingCollector: LimitingEvent[] | null;
  /** Extrapolation factor for predictor (deltaOld[0] / deltaOld[1]). */
  xfact: number;
  /** Diagonal conductance added for numerical stability (CKTgmin). */
  gmin: number;
  /**
   * Use-Initial-Conditions bit mirror. Redundant with (cktMode & MODEUIC)
   * but retained because many call sites already read it; engines MUST keep
   * both in sync. Remove once every reader is migrated to cktMode.
   */
  uic: boolean;
  /** Relative convergence tolerance (CKTreltol). */
  reltol: number;
  /** Absolute current tolerance (CKTabstol). */
  iabstol: number;
}
