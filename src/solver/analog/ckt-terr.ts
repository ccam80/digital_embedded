/**
 * CKTterr -- allocation-free ngspice-correct local truncation error timestep
 * estimation.
 *
 * Operates on charge (Q) history passed as scalar parameters, using
 * unrolled divided differences for order 1 and order 2 (the only orders
 * supported by our BDF-1 / trapezoidal / BDF-2 integrator).
 *
 * ngspice reference: CKTterr() in src/cktterr.c
 *
 * Mapping table (ngspice -> ours):
 *   ckt->CKTdeltaOld[i]       -> deltaOld[i]
 *   *(ckt->CKTstate0 + qcap)  -> q0  (current charge Q_n)
 *   *(ckt->CKTstate1 + qcap)  -> q1  (charge Q_{n-1})
 *   *(ckt->CKTstate2 + qcap)  -> q2  (charge Q_{n-2})
 *   *(ckt->CKTstate3 + qcap)  -> q3  (charge Q_{n-3})
 *   ckt->CKTorder             -> order
 *   ckt->CKTtrtol             -> trtol
 *   ckt->CKTreltol            -> reltol
 *   ckt->CKTabstol            -> abstol
 *   ckt->CKTchgtol            -> chgtol
 *   *(ckt->CKTstate0 + ccap)  -> ccap0 (companion current at current step)
 *   *(ckt->CKTstate1 + ccap)  -> ccap1 (companion current at previous step)
 *   method                    -> method
 */

import type { IntegrationMethod } from "./element.js";

// ---------------------------------------------------------------------------
// Method-specific LTE coefficients (ngspice trdefs.h / geardefs.h)
// ---------------------------------------------------------------------------

/**
 * LTE error factor for trapezoidal method, indexed by (order - 1).
 * trap[0] = 0.5 (order 1), trap[1] = 1/12 (order 2).
 */
const TRAP_LTE_FACTOR_0 = 0.5;
const TRAP_LTE_FACTOR_1 = 1 / 12;

/**
 * LTE error factor for Gear (BDF) methods, indexed by (order - 1).
 * gear[0] = 0.5 (BDF-1), gear[1] = 2/9 (BDF-2).
 */
const GEAR_LTE_FACTOR_0 = 0.5;
const GEAR_LTE_FACTOR_1 = 2 / 9;

// ---------------------------------------------------------------------------
// LteParams -- tolerance parameters passed from TimestepController
// ---------------------------------------------------------------------------

export interface LteParams {
  /** Truncation error tolerance multiplier (ngspice trtol, default 7). */
  readonly trtol: number;
  /** Relative tolerance (ngspice reltol, default 1e-3). */
  readonly reltol: number;
  /** Absolute voltage tolerance in volts (ngspice abstol/VNTOL, default 1e-6). */
  readonly abstol: number;
  /** Absolute charge tolerance in coulombs (ngspice chgtol, default 1e-14). */
  readonly chgtol: number;
}

// ---------------------------------------------------------------------------
// cktTerr -- allocation-free per-junction LTE timestep proposal
// ---------------------------------------------------------------------------

/**
 * Compute the maximum allowed timestep for a single reactive junction
 * using the ngspice CKTterr algorithm. Completely allocation-free:
 * all intermediate values use scalar locals, divided differences are
 * unrolled for order 1 and order 2.
 *
 * @param dt        Current timestep (seconds)
 * @param deltaOld  Timestep history: [h_{n-1}, h_{n-2}, ...]. Length >= order.
 *                  This is the controller's pre-allocated array, never copied.
 * @param order     Integration order (1 for bdf1/trap, 2 for bdf2)
 * @param method    Integration method (determines LTE coefficient)
 * @param q0        Charge at current step Q_n
 * @param q1        Charge at step n-1
 * @param q2        Charge at step n-2
 * @param q3        Charge at step n-3
 * @param ccap0     Companion current at current step
 * @param ccap1     Companion current at previous step
 * @param params    Tolerance parameters (pre-allocated on controller)
 * @returns Proposed maximum timestep in seconds, or Infinity if no constraint.
 */
export function cktTerr(
  dt: number,
  deltaOld: readonly number[],
  order: number,
  method: IntegrationMethod,
  q0: number,
  q1: number,
  q2: number,
  q3: number,
  ccap0: number,
  ccap1: number,
  params: LteParams,
): number {
  if (dt <= 0) return Infinity;

  // ------------------------------------------------------------------
  // Step 1: Compute the (order+1)-th divided difference of Q.
  //
  // Unrolled for order=1 (2nd divided difference, 3 points) and
  // order=2 (3rd divided difference, 4 points). No arrays allocated.
  //
  // ngspice cktterr.c:43-59
  //
  // Timestep denominators:
  //   h0 = dt (current step)
  //   h1 = deltaOld[0] (step n-1), fallback to dt
  //   h2 = deltaOld[1] (step n-2), fallback to h1
  // ------------------------------------------------------------------

  let diff0 = q0, diff1 = q1, diff2 = q2, diff3 = q3;
  const h0 = dt;
  const h1 = deltaOld.length > 0 ? deltaOld[0] : dt;
  const h2 = deltaOld.length > 1 ? deltaOld[1] : h1;
  let ddiff: number;

  if (order === 1) {
    diff0 = (diff0 - diff1) / h0;
    diff1 = (diff1 - diff2) / h1;
    const dt0 = h1 + h0;
    diff0 = (diff0 - diff1) / dt0;
    ddiff = Math.abs(diff0);
  } else {
    // order === 2: 3rd divided difference from 4 points
    diff0 = (diff0 - diff1) / h0;
    diff1 = (diff1 - diff2) / h1;
    diff2 = (diff2 - diff3) / h2;
    let dt0 = h1 + h0;
    let dt1 = h2 + h1;
    diff0 = (diff0 - diff1) / dt0;
    diff1 = (diff1 - diff2) / dt1;
    dt0 = dt1 + h0;
    diff0 = (diff0 - diff1) / dt0;
    ddiff = Math.abs(diff0);
  }

  // ------------------------------------------------------------------
  // Step 2: Method-specific LTE factor
  // ------------------------------------------------------------------

  let factor: number;
  if (method === "trapezoidal") {
    factor = order <= 1 ? TRAP_LTE_FACTOR_0 : TRAP_LTE_FACTOR_1;
  } else {
    // BDF-1 or BDF-2
    factor = order <= 1 ? GEAR_LTE_FACTOR_0 : GEAR_LTE_FACTOR_1;
  }

  // ------------------------------------------------------------------
  // Step 3: Tolerance computation (ngspice CKTterr dual tolerance)
  //   volttol   = abstol + reltol * max(|ccap0|, |ccap1|)
  //   chargetol = reltol * max(|Q_now|, |Q_prev|, chgtol) / dt
  //   tol = max(volttol, chargetol)
  // ------------------------------------------------------------------

  const volttol = params.abstol + params.reltol * Math.max(Math.abs(ccap0), Math.abs(ccap1));
  const chargetol = params.reltol * Math.max(Math.abs(q0), Math.abs(q1), params.chgtol) / dt;
  const tol = Math.max(volttol, chargetol);

  // ------------------------------------------------------------------
  // Step 4: Timestep formula
  //   del = trtol * tol / max(abstol, factor * |ddiff|)
  // ------------------------------------------------------------------

  const denom = Math.max(params.abstol, factor * ddiff);
  if (!(denom > 0)) return Infinity;
  const del = params.trtol * tol / denom;

  // ------------------------------------------------------------------
  // Step 5: Root extraction (ngspice cktterr.c:70-74)
  //   order=1: no root (return del directly)
  //   order=2: square root del^(1/2)
  //   order>2: del^(1/order)
  // ------------------------------------------------------------------

  // ngspice cktterr.c:70-74
  if (order === 2) {
    return Math.sqrt(del);           // del^(1/2)
  } else if (order > 2) {
    return Math.exp(Math.log(del) / order);  // del^(1/order)
  }
  return del;                         // order=1: no root
}
