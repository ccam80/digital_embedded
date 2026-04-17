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
// InitMode — canonical type for pool.initMode values
// ---------------------------------------------------------------------------

/** Pool initMode values used throughout the DCOP and transient flow. */
export type InitMode =
  | "initJct"
  | "initFix"
  | "initFloat"
  | "initTran"
  | "initPred"
  | "initSmsig"
  | "transient";

// ---------------------------------------------------------------------------
// LoadContext
// ---------------------------------------------------------------------------

export interface LoadContext {
  /** Sparse solver — element stamps conductance and RHS directly into this. */
  solver: SparseSolver;
  /** Previous NR iteration voltages (CKTrhsOld). */
  voltages: Float64Array;
  /** Current NR iteration index (0-based). */
  iteration: number;
  /** DC-OP / transient init mode (CKTmode & INITF). */
  initMode: InitMode;
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
  /** True during DC operating point solves. */
  isDcOp: boolean;
  /** True during transient solves. */
  isTransient: boolean;
  /** Extrapolation factor for predictor (deltaOld[0] / deltaOld[1]). */
  xfact: number;
  /** Diagonal conductance added for numerical stability (CKTgmin). */
  gmin: number;
  /** Use initial conditions flag (CKT MODEUIC). */
  uic: boolean;
  /** Relative convergence tolerance (CKTreltol). */
  reltol: number;
  /** Absolute current tolerance (CKTabstol). */
  iabstol: number;
}
