/**
 * CKTterr -- allocation-free ngspice-correct local truncation error timestep
 * estimation.
 *
 * Operates on charge (Q) history passed as scalar parameters, using
 * unrolled divided differences for order 1 and order 2 (the only orders
 * supported by our trapezoidal and gear integrators).
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

// ngspice cktterr.c:32-35 trapCoeff[]- must match ngspice's truncated decimal
// literals bit-exact, NOT the closer rational fractions. Using `1/12` instead of
// `.08333333333` produces a different double (3.3e-12 apart) which propagates
// through the LTE formula `del = trtol*tol/(factor*|diff|)` and `sqrt(del)` to
// a 2ULP-different proposed dt- visible in rlc-oscillator parity at step=1.
const TRAP_LTE_FACTORS = [0.5, 0.08333333333];

/**
 * LTE error factor for Gear (BDF) methods, indexed by (order - 1).
 * Values are the EXACT decimal literals ngspice ships in cktterr.c:24-31
 * gearCoeff[]. We deliberately do NOT replace them with the closer rational
 * fractions (2/9, 3/22, 10/137, 20/343)- those produce different doubles
 * and break bit-exact parity even though they are mathematically more correct.
 *   [0] = 0.5
 *   [1] = .2222222222   (≈ 2/9)
 *   [2] = .1363636364   (≈ 3/22)
 *   [3] = .096          (= 12/125, exactly representable)
 *   [4] = .07299270073  (≈ 10/137)
 *   [5] = .05830903790  (≈ 20/343)
 */
export const GEAR_LTE_FACTORS = [0.5, 0.2222222222, 0.1363636364, 0.096, 0.07299270073, 0.05830903790];

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
 * @param order     Integration order (1 for trap; 1..6 for gear)
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
  // Convention (matches ngspice CKTdeltaOld[] and engine timestep.ts):
  //   deltaOld[0] = current dt (set by setDeltaOldCurrent before each call)
  //   deltaOld[1] = h_{n-1} (previous accepted step)
  //   deltaOld[2] = h_{n-2}
  //
  // Timestep denominators for divided differences:
  //   h0 = dt = deltaOld[0] (current step)
  //   h1 = deltaOld[1] (step n-1), defaults to dt when absent
  //   h2 = deltaOld[2] (step n-2), defaults to h1 when absent
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
  // Step 3: Unified LTE factor and timestep formula (ngspice cktterr.c:60-75)
  //
  // Both TRAP and GEAR use the same formula, differing only in the
  // coefficient table.  ngspice cktterr.c:69:
  //   del = trtol * tol / MAX(abstol, factor * |diff[0]|)
  // then root extraction by order (not order+1).
  // ------------------------------------------------------------------

  // ngspice cktterr.c:60-68: select factor from method-specific table
  const coeffTable = method === "trapezoidal" ? TRAP_LTE_FACTORS : GEAR_LTE_FACTORS;
  const factor = coeffTable[Math.max(0, Math.min(coeffTable.length - 1, order - 1))];

  if (ddiff === 0) return Infinity;
  const denom = Math.max(params.abstol, factor * ddiff);
  if (!(denom > 0)) return Infinity;
  // ngspice cktterr.c:69
  let del = params.trtol * tol / denom;

  // ------------------------------------------------------------------
  // Step 4: Root extraction (ngspice cktterr.c:70-74)
  //   order == 1: del is the proposed dt directly (no root)
  //   order == 2: del = sqrt(del)
  //   order  > 2: del = exp(log(del) / order)
  // ------------------------------------------------------------------

  if (order === 2) {
    // ngspice cktterr.c:70-71
    del = Math.sqrt(del);
  } else if (order > 2) {
    // ngspice cktterr.c:72-74
    del = Math.exp(Math.log(del) / order);
  }

  // ngspice cktterr.c:74 *timeStep = MIN(*timeStep, del).
  // *timeStep is caller-initialised to CKTmaxStep and threaded across
  // elements. Aggregation + maxStep + 2*dt growth cap are applied by
  // timestep.ts; here we return the per-element LTE-allowed dt only.
  return del;
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

  // GEAR: factor-based formula (orders 1..6)
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
