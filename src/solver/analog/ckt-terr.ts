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
 * gear[2..5] = factors for GEAR orders 3-6 (geardefs.h).
 */
export const GEAR_LTE_FACTORS = [0.5, 2 / 9, 3 / 22, 12 / 125, 5 / 72, 20 / 343];

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
// __testHooks -- test-only state for white-box assertions
// ---------------------------------------------------------------------------

/** @internal Test-only hooks. Not part of the public API. */
export const __testHooks = {
  lastChargetol: 0,
};

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
  const h1 = deltaOld.length > 1 ? deltaOld[1] : dt;
  const h2 = deltaOld.length > 2 ? deltaOld[2] : h1;
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
  // Step 2: Tolerance computation (ngspice cktterr.c chargetol path)
  //   volttol   = abstol + reltol * max(|ccap0|, |ccap1|)
  //   chargetol = reltol * max(max(|Q_now|, |Q_prev|), chgtol) / dt
  //   tol = max(volttol, chargetol)
  // ------------------------------------------------------------------

  const volttol = params.abstol + params.reltol * Math.max(Math.abs(ccap0), Math.abs(ccap1));
  // ngspice cktterr.c chargetol path: reltol * MAX(MAX(|q0|,|q1|), chgtol) / delta
  const chargetolRaw = params.reltol * Math.max(Math.max(Math.abs(q0), Math.abs(q1)), params.chgtol);
  __testHooks.lastChargetol = chargetolRaw;
  const chargetol = chargetolRaw / dt;
  const tol = Math.max(volttol, chargetol);

  // ------------------------------------------------------------------
  // Step 3: Method-specific LTE factor and timestep formula
  //
  // ngspice cktterr.c / ckttrunc.c NEWTRUNC path:
  //   TRAP order 1: del = deltaOld[0] * sqrt(|trtol * tol * 2 / diff|)
  //   TRAP order 2: del = |deltaOld[0] * trtol * tol * 3 * (deltaOld[0]+deltaOld[1]) / diff|
  //   GEAR: del = trtol * tol / (factor * ddiff) then root by (order+1)
  // ------------------------------------------------------------------

  if (method === "trapezoidal") {
    if (ddiff === 0) return Infinity;
    if (order <= 1) {
      // ngspice cktterr.c TRAP order 1: del = deltaOld[0] * sqrt(trtol * tol * 2 / diff)
      const d0 = deltaOld.length > 0 ? deltaOld[0] : dt;
      const inner = params.trtol * tol * 2 / ddiff;
      return d0 * Math.sqrt(inner);
    } else {
      // ngspice cktterr.c TRAP order 2: del = |deltaOld[0] * trtol * tol * 3 * (deltaOld[0]+deltaOld[1]) / diff|
      const d0 = deltaOld.length > 0 ? deltaOld[0] : dt;
      const d1 = deltaOld.length > 1 ? deltaOld[1] : d0;
      return Math.abs(d0 * params.trtol * tol * 3 * (d0 + d1) / diff0);
    }
  }

  // GEAR / BDF-1 / BDF-2: factor-based formula with root extraction
  // ngspice geardefs.h: GEAR_LTE_FACTORS indexed by (order-1)
  const factor = GEAR_LTE_FACTORS[Math.min(order - 1, GEAR_LTE_FACTORS.length - 1)];

  const denom = Math.max(params.abstol, factor * ddiff);
  if (!(denom > 0)) return Infinity;
  const del = params.trtol * tol / denom;

  // ------------------------------------------------------------------
  // Step 4: Root extraction (ngspice cktterr.c:70-74, V6 fix)
  //   GEAR order 1: sqrt(del)
  //   GEAR order >= 2: del^(1/(order+1))
  // ------------------------------------------------------------------

  if (order === 1) {
    // ngspice cktterr.c GEAR order 1: Math.sqrt(del)
    return Math.sqrt(del);
  } else {
    // ngspice cktterr.c GEAR order >= 2: exp(log(tmp) / (order+1))
    return Math.exp(Math.log(del) / (order + 1));
  }
}

// ---------------------------------------------------------------------------
// cktTerrVoltage -- NEWTRUNC voltage-based LTE timestep proposal
// ---------------------------------------------------------------------------

/**
 * Voltage-based LTE timestep estimation matching ngspice CKTtrunc with
 * NEWTRUNC enabled. Uses the same divided-difference algorithm as cktTerr
 * but operates on node voltages instead of charge values, and uses
 * lteReltol/lteAbstol tolerance parameters.
 *
 * ngspice reference: CKTtrunc() in src/ckttrunc.c (NEWTRUNC code path)
 *
 * Mapping table (ngspice -> ours):
 *   CKTvoltNow         -> vNow
 *   CKTvolt1           -> v1  (voltage at step n-1)
 *   CKTvolt2           -> v2  (voltage at step n-2)
 *   CKTvolt3           -> v3  (voltage at step n-3)
 *   ckt->CKTdeltaOld[] -> deltaOld
 *   ckt->CKTlteReltol  -> lteReltol
 *   ckt->CKTlteAbstol  -> lteAbstol
 *   ckt->CKTtrtol      -> trtol
 *
 * @param vNow      Voltage at current step V_n
 * @param v1        Voltage at step n-1
 * @param v2        Voltage at step n-2
 * @param v3        Voltage at step n-3
 * @param dt        Current timestep (seconds)
 * @param deltaOld  Timestep history: [h_{n-1}, h_{n-2}, ...]. Length >= order.
 * @param order     Integration order (1..6)
 * @param method    Integration method (determines LTE coefficient)
 * @param lteReltol Relative LTE tolerance (default 1e-3)
 * @param lteAbstol Absolute LTE tolerance in volts (default 1e-6)
 * @param trtol     Truncation error tolerance multiplier (default 7)
 * @returns Proposed maximum timestep in seconds, or Infinity if no constraint.
 */
export function cktTerrVoltage(
  vNow: number, v1: number, v2: number, v3: number,
  dt: number,
  deltaOld: readonly number[],
  order: number,
  method: IntegrationMethod,
  lteReltol: number,
  lteAbstol: number,
  trtol: number,
): number {
  if (dt <= 0) return Infinity;

  // ------------------------------------------------------------------
  // Step 1: Compute the (order+1)-th divided difference of V.
  //
  // Same unrolled algorithm as cktTerr but applied to voltage history.
  // ------------------------------------------------------------------

  let diff0 = vNow, diff1 = v1, diff2 = v2, diff3 = v3;
  const h0 = dt;
  const h1 = deltaOld.length > 1 ? deltaOld[1] : dt;
  const h2 = deltaOld.length > 2 ? deltaOld[2] : h1;
  let ddiff: number;

  if (order === 1) {
    diff0 = (diff0 - diff1) / h0;
    diff1 = (diff1 - diff2) / h1;
    const dt0 = h1 + h0;
    diff0 = (diff0 - diff1) / dt0;
    ddiff = Math.abs(diff0);
  } else {
    // order >= 2: 3rd divided difference from 4 points
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
  // Step 2: Voltage-domain tolerance
  //   tol = lteAbstol + lteReltol * max(|vNow|, |v1|)
  // ------------------------------------------------------------------

  const tol = lteAbstol + lteReltol * Math.max(Math.abs(vNow), Math.abs(v1));

  // ------------------------------------------------------------------
  // Step 3: Method-specific LTE factor and timestep formula
  //
  // GEAR: ngspice ckttrunc.c NEWTRUNC (V5):
  //   tmp = (tol * trtol * delsum) / (diff * delta)
  //   where delsum = sum(deltaOld[0..order])
  //   then root by (order+1), multiply by delta
  //
  // TRAP: same as cktTerr TRAP path
  // ------------------------------------------------------------------

  if (method === "trapezoidal") {
    if (ddiff === 0) return Infinity;
    if (order <= 1) {
      // ngspice ckttrunc.c NEWTRUNC TRAP order 1
      const d0 = deltaOld.length > 0 ? deltaOld[0] : dt;
      const inner = trtol * tol * 2 / ddiff;
      return d0 * Math.sqrt(inner);
    } else {
      // ngspice ckttrunc.c NEWTRUNC TRAP order 2
      const d0 = deltaOld.length > 0 ? deltaOld[0] : dt;
      const d1 = deltaOld.length > 1 ? deltaOld[1] : d0;
      return Math.abs(d0 * trtol * tol * 3 * (d0 + d1) / diff0);
    }
  }

  // GEAR / BDF-1 / BDF-2: factor-based formula
  const idx = Math.min(order - 1, GEAR_LTE_FACTORS.length - 1);
  const factor = GEAR_LTE_FACTORS[idx];

  // ngspice ckttrunc.c NEWTRUNC GEAR (V5):
  // delsum = sum of deltaOld[0..order], tmp = (tol*trtol*delsum)/(diff*delta)
  const delta = dt;
  let delsum = 0;
  for (let i = 0; i <= order && i < deltaOld.length; i++) {
    delsum += deltaOld[i];
  }
  if (delsum <= 0) delsum = dt * (order + 1);

  const denom = Math.max(lteAbstol, factor * ddiff);
  if (!(denom > 0)) return Infinity;
  const tmp = (tol * trtol * delsum) / (denom * delta);

  // ------------------------------------------------------------------
  // Step 4: Root extraction (ngspice ckttrunc.c NEWTRUNC GEAR, V6 fix)
  //   GEAR order 1: delta * sqrt(tmp)
  //   GEAR order >= 2: delta * exp(log(tmp) / (order+1))
  // ------------------------------------------------------------------

  if (order === 1) {
    // ngspice ckttrunc.c GEAR order 1: sqrt
    return delta * Math.sqrt(tmp);
  } else {
    // ngspice ckttrunc.c GEAR order >= 2: exp(log(tmp) / (order+1))
    return delta * Math.exp(Math.log(tmp) / (order + 1));
  }
}
