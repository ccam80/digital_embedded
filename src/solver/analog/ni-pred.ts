/**
 * NIpred transient predictor - Adams-Gear predictor coefficients and voltage
 * prediction. Matches ngspice nicomcof.c (computeAgp) and nipred.c
 * (predictVoltages) exactly.
 *
 * Variable mapping table (ngspice -> ours):
 *   CKTsols[0..7][]            -> ctx.nodeVoltageHistory (NodeVoltageHistory)
 *   CKTagp[0..6]               -> ctx.agp: Float64Array(7)
 *   CKTpred[] / CKTrhs[]       -> ctx.rhs (written in-place)
 *   NIpred()                   -> predictVoltages()
 *   NIcomCof #ifdef PREDICTOR  -> computeAgp()
 *   CKTdeltaOld[]              -> timestep.deltaOld
 *   CKTorder                   -> timestep.currentOrder
 *   CKTintegrateMethod         -> timestep.currentMethod
 *
 * Note on method mapping:
 *   Our engine uses "bdf1", "trapezoidal", and "bdf2". ALL THREE map to the
 *   TRAPEZOIDAL branch in nicomcof.c/nipred.c (not GEAR). GEAR paths are dead
 *   code for our engine but are implemented for exact ngspice parity.
 */

import type { IntegrationMethod } from "./element.js";
import type { NodeVoltageHistory } from "./integration.js";

// ---------------------------------------------------------------------------
// computeAgp - Adams-Gear predictor coefficients (nicomcof.c:129-206)
// ---------------------------------------------------------------------------

/**
 * Compute Adams-Gear predictor coefficients agp[0..order] for the current timestep.
 *
 * TRAPEZOIDAL path (nicomcof.c:141-145) - covers bdf1, trapezoidal, bdf2:
 *   arg = delta / (2 * deltaOld[1])
 *   agp[0] = 1 + arg
 *   agp[1] = -arg
 *
 * GEAR path (nicomcof.c:147-205) - dead code for our engine, implemented for
 * exact parity. Builds (order+1)x(order+1) collocation matrix, LU-decomposes,
 * solves with RHS [1,0,0,...,0]. Result is agp[0..order].
 *
 * @param method    - Integration method ("bdf1" | "trapezoidal" | "bdf2")
 * @param order     - Integration order (1 or 2 for our engine; 1-6 for GEAR)
 * @param delta     - Current timestep (deltaOld[0] after setDeltaOldCurrent)
 * @param deltaOld  - CKTdeltaOld[]: [delta, h1, h2, h3, ...]
 * @param agp       - Output: agp coefficients are written here
 */
export function computeAgp(
  method: IntegrationMethod,
  order: number,
  delta: number,
  deltaOld: readonly number[],
  agp: Float64Array,
): void {
  // All our methods (bdf1, trapezoidal, bdf2) use the TRAPEZOIDAL predictor
  // branch in nicomcof.c. GEAR branch is provided for completeness.
  if (method !== "gear") {
    // nicomcof.c:141-145 - TRAPEZOIDAL predictor coefficients
    const dOld1 = deltaOld[1] > 0 ? deltaOld[1] : delta;
    const arg = delta / (2.0 * dOld1);
    agp[0] = 1.0 + arg;
    agp[1] = -arg;
  } else {
    // nicomcof.c:147-205 - GEAR predictor coefficients (dead code for our engine)
    _computeAgpGear(order, delta, deltaOld, agp);
  }
}/**
 * GEAR predictor coefficient computation (nicomcof.c:147-205).
 * Builds (order+1)x(order+1) collocation matrix, LU-decomposes in place,
 * then back-substitutes with RHS [1,0,0,...,0].
 * Not used by our engine but implemented for exact ngspice parity.
 */
function _computeAgpGear(
  order: number,
  delta: number,
  deltaOld: readonly number[],
  agp: Float64Array,
): void {
  const n = order + 1;
  const mat = new Float64Array(n * n);
  const rhs = new Float64Array(n);
  rhs[0] = 1.0;

  // Build collocation matrix: mat[i][j] = (tBack/delta)^j / j!
  // Row 0 = t=0 (current); row i = i steps back. nicomcof.c:155-175
  for (let i = 0; i < n; i++) {
    let tBack = 0.0;
    for (let k = 0; k < i; k++) {
      tBack += (k + 1 < deltaOld.length ? deltaOld[k + 1] : delta);
    }
    const t = tBack / delta;
    let factorial = 1.0;
    mat[i * n + 0] = 1.0;
    let tPow = 1.0;
    for (let j = 1; j < n; j++) {
      tPow *= t;
      factorial *= j;
      mat[i * n + j] = tPow / factorial;
    }
  }

  // LU decomposition - Gaussian elimination without pivoting (nicomcof.c:177-195)
  for (let k = 0; k < n; k++) {
    const pivot = mat[k * n + k];
    if (Math.abs(pivot) < 1e-30) {
      agp.fill(0);
      return;
    }
    for (let i = k + 1; i < n; i++) {
      const factor = mat[i * n + k] / pivot;
      for (let j = k; j < n; j++) {
        mat[i * n + j] -= factor * mat[k * n + j];
      }
      rhs[i] -= factor * rhs[k];
    }
  }

  // Back substitution (nicomcof.c:197-205)
  for (let i = n - 1; i >= 0; i--) {
    let sum = rhs[i];
    for (let j = i + 1; j < n; j++) {
      sum -= mat[i * n + j] * agp[j];
    }
    agp[i] = sum / mat[i * n + i];
  }
}
// ---------------------------------------------------------------------------
// predictVoltages - NIpred (nipred.c) full implementation
// ---------------------------------------------------------------------------

/**
 * Predict node voltages for the current timestep using the Adams-Gear predictor.
 * Writes predicted values directly into out (== ctx.rhs in the engine).
 *
 * Returns true when prediction written (sufficient history exists).
 * Returns false when fewer than (order+1) accepted steps available -
 * caller leaves out unchanged (NR seeds from DC op result).
 *
 * TRAPEZOIDAL order 1 (nipred.c:46-52):
 *   dd0 = (sols[0][i] - sols[1][i]) / deltaOld[1]
 *   pred[i] = sols[0][i] + deltaOld[0] * dd0
 *
 * TRAPEZOIDAL order 2 (nipred.c:55-66):
 *   b = -deltaOld[0] / (2 * deltaOld[1])
 *   a = 1 - b
 *   dd0 = (sols[0][i] - sols[1][i]) / deltaOld[1]
 *   dd1 = (sols[1][i] - sols[2][i]) / deltaOld[2]
 *   pred[i] = sols[0][i] + (b*dd1 + a*dd0) * deltaOld[0]
 *
 * GEAR order k (nipred.c:79-137):
 *   pred[i] = sum_{j=0}^{k} agp[j] * sols[j][i]
 *
 * @param history   - Circular buffer of accepted node-voltage snapshots
 * @param deltaOld  - CKTdeltaOld[] - deltaOld[0]=current delta after setDeltaOldCurrent
 * @param order     - Integration order (1 or 2 for our engine)
 * @param method    - Integration method
 * @param agp       - Predictor coefficients computed by computeAgp()
 * @param out       - Output: predicted voltages written here (== ctx.rhs)
 * @returns true if prediction written; false if insufficient history
 */
export function predictVoltages(
  history: NodeVoltageHistory,
  deltaOld: readonly number[],
  order: number,
  method: IntegrationMethod,
  agp: Float64Array,
  out: Float64Array,
): boolean {
  const nodeCount = out.length;
  const filled = history.filled;

  // All our methods (bdf1, trapezoidal, bdf2) use TRAPEZOIDAL predictor branch.
  if (method !== "gear") {
    if (order <= 1) {
      // nipred.c:46-52 - TRAPEZOIDAL order 1
      // Requires sols[0] and sols[1] (2 accepted steps).
      if (filled < 2) return false;
      const dOld1 = deltaOld[1] > 0 ? deltaOld[1] : deltaOld[0];
      const dOld0 = deltaOld[0];
      for (let i = 0; i < nodeCount; i++) {
        const s0 = history.getNodeVoltage(i, 0);
        const s1 = history.getNodeVoltage(i, 1);
        const dd0 = (s0 - s1) / dOld1;
        out[i] = s0 + dOld0 * dd0;
      }
      return true;
    } else {
      // nipred.c:55-66 - TRAPEZOIDAL order 2
      // Requires sols[0], sols[1], sols[2] (3 accepted steps).
      if (filled < 3) return false;
      const dOld0 = deltaOld[0];
      const dOld1 = deltaOld[1] > 0 ? deltaOld[1] : dOld0;
      const dOld2 = deltaOld[2] > 0 ? deltaOld[2] : dOld1;
      const b = -dOld0 / (2.0 * dOld1);
      const a = 1.0 - b;
      for (let i = 0; i < nodeCount; i++) {
        const s0 = history.getNodeVoltage(i, 0);
        const s1 = history.getNodeVoltage(i, 1);
        const s2 = history.getNodeVoltage(i, 2);
        const dd0 = (s0 - s1) / dOld1;
        const dd1 = (s1 - s2) / dOld2;
        out[i] = s0 + (b * dd1 + a * dd0) * dOld0;
      }
      return true;
    }
  } else {
    // nipred.c:79-137 - GEAR predictor (dead code for our engine)
    return _predictVoltagesGear(history, order, agp, out, filled);
  }
}
/**
 * GEAR predictor (nipred.c:79-137) - dead code for our engine.
 * pred[i] = sum_{j=0}^{order} agp[j] * sols[j][i]
 * Unrolled switch for orders 1-6 matching nipred.c.
 */
function _predictVoltagesGear(
  history: NodeVoltageHistory,
  order: number,
  agp: Float64Array,
  out: Float64Array,
  filled: number,
): boolean {
  if (filled < order + 1) return false;
  const nodeCount = out.length;

  switch (order) {
    case 1:
      for (let i = 0; i < nodeCount; i++) {
        out[i] = agp[0] * history.getNodeVoltage(i, 0)
               + agp[1] * history.getNodeVoltage(i, 1);
      }
      return true;
    case 2:
      for (let i = 0; i < nodeCount; i++) {
        out[i] = agp[0] * history.getNodeVoltage(i, 0)
               + agp[1] * history.getNodeVoltage(i, 1)
               + agp[2] * history.getNodeVoltage(i, 2);
      }
      return true;
    case 3:
      for (let i = 0; i < nodeCount; i++) {
        out[i] = agp[0] * history.getNodeVoltage(i, 0)
               + agp[1] * history.getNodeVoltage(i, 1)
               + agp[2] * history.getNodeVoltage(i, 2)
               + agp[3] * history.getNodeVoltage(i, 3);
      }
      return true;
    case 4:
      for (let i = 0; i < nodeCount; i++) {
        out[i] = agp[0] * history.getNodeVoltage(i, 0)
               + agp[1] * history.getNodeVoltage(i, 1)
               + agp[2] * history.getNodeVoltage(i, 2)
               + agp[3] * history.getNodeVoltage(i, 3)
               + agp[4] * history.getNodeVoltage(i, 4);
      }
      return true;
    case 5:
      for (let i = 0; i < nodeCount; i++) {
        out[i] = agp[0] * history.getNodeVoltage(i, 0)
               + agp[1] * history.getNodeVoltage(i, 1)
               + agp[2] * history.getNodeVoltage(i, 2)
               + agp[3] * history.getNodeVoltage(i, 3)
               + agp[4] * history.getNodeVoltage(i, 4)
               + agp[5] * history.getNodeVoltage(i, 5);
      }
      return true;
    case 6:
    default:
      for (let i = 0; i < nodeCount; i++) {
        out[i] = agp[0] * history.getNodeVoltage(i, 0)
               + agp[1] * history.getNodeVoltage(i, 1)
               + agp[2] * history.getNodeVoltage(i, 2)
               + agp[3] * history.getNodeVoltage(i, 3)
               + agp[4] * history.getNodeVoltage(i, 4)
               + agp[5] * history.getNodeVoltage(i, 5)
               + agp[6] * history.getNodeVoltage(i, 6);
      }
      return true;
  }
}
