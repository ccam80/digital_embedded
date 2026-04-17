/**
 * Integration coefficients and history utilities for reactive element companion models.
 *
 * Elements compute NIintegrate-based companion models inline in their load()
 * using ctx.ag[] coefficients computed here by computeNIcomCof.
 */

import type { IntegrationMethod } from "./element.js";

// ---------------------------------------------------------------------------
// HistoryStore
// ---------------------------------------------------------------------------

/**
 * Two-slot rotating history store for BDF-2 reactive element state.
 *
 * BDF-2 requires the value at v(n) and v(n-1) for each reactive element.
 * History is stored in two `Float64Array` buffers (slots A and B). Each
 * element independently tracks which slot is its current (v(n)) slot via a
 * per-element flag in a `Uint8Array`. Rotating history for one element does
 * not disturb any other element — zero array copies occur per push.
 *
 * Slot mapping per element i:
 *   _slotIsA[i] === 1  →  _a[i] holds v(n),   _b[i] holds v(n-1)
 *   _slotIsA[i] === 0  →  _b[i] holds v(n),   _a[i] holds v(n-1)
 *
 * On push(i, value): toggle _slotIsA[i], write value into the new current slot.
 */
export class HistoryStore {
  private _a: Float64Array;
  private _b: Float64Array;
  /** Per-element current-slot flag: 1 = slot A is current, 0 = slot B is current. */
  private _slotIsA: Uint8Array;

  /**
   * @param elementCount - Number of reactive elements whose history is tracked
   */
  constructor(elementCount: number) {
    this._a = new Float64Array(elementCount);
    this._b = new Float64Array(elementCount);
    this._slotIsA = new Uint8Array(elementCount).fill(1); // start with A as current
  }

  /**
   * Return stored history value for an element.
   *
   * @param elementIndex - 0-based reactive element index
   * @param stepsBack    - 0 for v(n), 1 for v(n-1)
   * @returns Stored value
   */
  get(elementIndex: number, stepsBack: 0 | 1): number {
    const aIsCurrent = this._slotIsA[elementIndex] === 1;
    if (stepsBack === 0) {
      return aIsCurrent ? this._a[elementIndex] : this._b[elementIndex];
    } else {
      return aIsCurrent ? this._b[elementIndex] : this._a[elementIndex];
    }
  }

  /**
   * Rotate history and record the new value for an element.
   *
   * Rotation: v(n-1) ← v(n), v(n) ← value.
   * Implemented by toggling this element's current-slot flag and writing into
   * the newly designated current slot — zero array copies per call.
   *
   * @param elementIndex - 0-based reactive element index
   * @param value        - New v(n) value to record
   */
  push(elementIndex: number, value: number): void {
    // Toggle this element's slot: 1→0 or 0→1
    const wasA = this._slotIsA[elementIndex] === 1;
    this._slotIsA[elementIndex] = wasA ? 0 : 1;
    // Write new value into the (newly designated) current slot
    if (!wasA) {
      // now A is current
      this._a[elementIndex] = value;
    } else {
      // now B is current
      this._b[elementIndex] = value;
    }
  }

  /**
   * Reset all history to zero.
   *
   * Called at the start of a new simulation or after a DC operating point
   * solve to clear any pre-existing history.
   */
  reset(): void {
    this._a.fill(0);
    this._b.fill(0);
    this._slotIsA.fill(1);
  }
}

// ---------------------------------------------------------------------------
// NodeVoltageHistory — circular buffer of full node-voltage vectors for NIpred
// ---------------------------------------------------------------------------

/**
 * Depth of the node-voltage history buffer.
 * GEAR-6 requires sols[0..6] (7 entries). ngspice: CKTsols[0..7][].
 */
const NODE_VOLTAGE_HISTORY_DEPTH = 7;

/**
 * Circular buffer of accepted node-voltage snapshots for the NIpred predictor.
 *
 * Equivalent to ngspice's CKTsols[0..7][]. Index 0 = most recently accepted
 * solution, index k = k steps back.
 *
 * Allocation: call initNodeVoltages() once after the matrix size is known.
 * Population: call rotateNodeVoltages() on every accepted transient step.
 * Query: call getNodeVoltage(nodeIndex, stepsBack).
 */
export class NodeVoltageHistory {
  private _buf: Float64Array[] = [];
  private _head: number = 0;
  private _filled: number = 0;

  /**
   * Allocate `NODE_VOLTAGE_HISTORY_DEPTH` Float64Arrays, each of length `nodeCount`.
   * Safe to call multiple times — reallocates on each call.
   */
  initNodeVoltages(nodeCount: number): void {
    this._buf = [];
    for (let i = 0; i < NODE_VOLTAGE_HISTORY_DEPTH; i++) {
      this._buf.push(new Float64Array(nodeCount));
    }
    this._head = 0;
    this._filled = 0;
  }

  /**
   * Push a new accepted solution into the circular buffer.
   * _head moves backward (mod depth) so index 0 always maps to _head.
   * ngspice equivalent: CKTsols rotation in dctran.c after NIpred.
   */
  rotateNodeVoltages(voltages: Float64Array): void {
    if (this._buf.length === 0) return;
    // Move head backward: new head holds the most recent solution.
    this._head = (this._head - 1 + NODE_VOLTAGE_HISTORY_DEPTH) % NODE_VOLTAGE_HISTORY_DEPTH;
    this._buf[this._head].set(voltages);
    if (this._filled < NODE_VOLTAGE_HISTORY_DEPTH) {
      this._filled++;
    }
  }

  /**
   * Return voltage at node `nodeIndex` from `stepsBack` accepted steps ago.
   * stepsBack=0 → most recent accepted solution (CKTsols[0]).
   * Returns 0 if insufficient history has been accumulated.
   */
  getNodeVoltage(nodeIndex: number, stepsBack: number): number {
    if (stepsBack >= this._filled || this._buf.length === 0) return 0;
    const idx = (this._head + stepsBack) % NODE_VOLTAGE_HISTORY_DEPTH;
    return this._buf[idx][nodeIndex];
  }

  /** Number of accepted steps stored so far (saturates at NODE_VOLTAGE_HISTORY_DEPTH). */
  get filled(): number {
    return this._filled;
  }

  /** Zero all history and reset counters. */
  reset(): void {
    for (const arr of this._buf) {
      arr.fill(0);
    }
    this._head = 0;
    this._filled = 0;
  }
}

/**
 * Centralized NIcomCof — compute integration coefficients ag[] into shared store.
 *
 * Mirrors ngspice nicomcof.c. Called once per transient retry iteration in
 * analog-engine.ts step(), BEFORE companion stamping. Elements read ag[0] etc.
 * from statePool.ag instead of deriving 1/dt locally.
 *
 * ag[0] = coefficient on Q_n (current timepoint)
 * ag[1] = coefficient on Q_{n-1}
 * ag[2] = coefficient on Q_{n-2} (BDF-2 only)
 */
/**
 * Solve the GEAR Vandermonde system for integration coefficients ag[0..order].
 *
 * Direct port of ngspice NIcomCof() GEAR case (nicomcof.c:53-117).
 *
 * Matrix layout: mat[row][col], row = equation index 0..order,
 *   col = point index 0..order.
 * Column 0 is a special case: mat[0][0]=1, mat[1..order][0]=0.
 * Columns 1..order: arg = cumulative sum deltaOld[0..col-1],
 *   mat[0][col]=1, mat[j][col] = (arg/dt)^j for j=1..order.
 *
 * RHS: ag[1] = -1/dt, all others 0.
 * LU decomposition starts at i=1 (skipping the trivial first column).
 * Forward then backward substitution on ag[0..order].
 *
 * Mapping (ngspice -> ours):
 *   ckt->CKTdelta       -> dt
 *   ckt->CKTdeltaOld[i] -> deltaOld[i]   (i=0..order-1)
 *   ckt->CKTag[i]       -> ag[i]          (i=0..order)
 *   mat[j][i]           -> mat[j][i]      (same layout)
 *
 * @param dt       Current timestep
 * @param deltaOld Timestep history (deltaOld[0]=dt, deltaOld[1]=h_{n-1}, ...)
 * @param order    Integration order (1..6)
 * @param ag       Output coefficient array (length >= order+1)
 */
function solveGearVandermonde(
  dt: number,
  deltaOld: readonly number[],
  order: number,
  ag: Float64Array,
  scratch: Float64Array,
): void {
  // Use flat 7x7 scratch buffer (index as scratch[row * 7 + col]).
  // Row and col are 0-based, matching ngspice's 1-based indices shifted down by 1.
  const stride = 7;

  // Zero the scratch region for this order.
  const n = order + 1;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      scratch[r * stride + c] = 0;
    }
  }

  // Initialize RHS (ag). ngspice: bzero then ag[1] = -1/delta.
  for (let i = 0; i <= order; i++) ag[i] = 0;
  ag[1] = -1 / dt;

  // Set up matrix columns. ngspice nicomcof.c:70-86.
  // Column 0: scratch[0][0]=1, scratch[j][0]=0 for j>=1 (already zeroed).
  for (let i = 0; i <= order; i++) scratch[0 * stride + i] = 1;
  for (let i = 1; i <= order; i++) scratch[i * stride + 0] = 0;

  // Columns 1..order: arg accumulates deltaOld[i-1], scratch[j][i] = (arg/dt)^j.
  let arg = 0;
  for (let i = 1; i <= order; i++) {
    arg += deltaOld[i - 1] > 0 ? deltaOld[i - 1] : dt;
    let arg1 = 1;
    for (let j = 1; j <= order; j++) {
      arg1 *= arg / dt;
      scratch[j * stride + i] = arg1;
    }
  }

  // LU decomposition, starting at i=1 (column 0 is trivial). nicomcof.c:95-102.
  for (let i = 1; i <= order; i++) {
    for (let j = i + 1; j <= order; j++) {
      if (Math.abs(scratch[i * stride + i]) < 1e-300) {
        ag[0] = 1 / dt; ag[1] = -1 / dt;
        for (let k = 2; k <= order; k++) ag[k] = 0;
        return;
      }
      scratch[j * stride + i] /= scratch[i * stride + i];
      for (let k = i + 1; k <= order; k++) {
        scratch[j * stride + k] -= scratch[j * stride + i] * scratch[i * stride + k];
      }
    }
  }

  // Forward substitution. nicomcof.c:104-108.
  for (let i = 1; i <= order; i++) {
    for (let j = i + 1; j <= order; j++) {
      ag[j] = ag[j] - scratch[j * stride + i] * ag[i];
    }
  }

  // Backward substitution. nicomcof.c:110-116.
  if (Math.abs(scratch[order * stride + order]) < 1e-300) {
    ag[0] = 1 / dt; ag[1] = -1 / dt;
    for (let k = 2; k <= order; k++) ag[k] = 0;
    return;
  }
  ag[order] /= scratch[order * stride + order];
  for (let i = order - 1; i >= 0; i--) {
    for (let j = i + 1; j <= order; j++) {
      ag[i] = ag[i] - scratch[i * stride + j] * ag[j];
    }
    if (Math.abs(scratch[i * stride + i]) < 1e-300) {
      ag[0] = 1 / dt; ag[1] = -1 / dt;
      for (let k = 2; k <= order; k++) ag[k] = 0;
      return;
    }
    ag[i] /= scratch[i * stride + i];
  }
}

export function computeNIcomCof(
  dt: number,
  deltaOld: readonly number[],
  order: number,
  method: IntegrationMethod,
  ag: Float64Array,
  scratch: Float64Array,
): void {
  if (dt <= 0) { ag.fill(0); return; }

  if (method === "trapezoidal") {
    if (order === 1) {
      ag[0] = 1 / dt;
      ag[1] = -1 / dt;
    } else {
      const xmu = 0.5;
      // nicomcof.c trap order 2: two sequential divisions match ngspice operand order
      ag[0] = 1.0 / dt / (1.0 - xmu);
      ag[1] = xmu / (1 - xmu);
    }
  } else if (method === "bdf2") {
    const h1 = deltaOld[1] > 0 ? deltaOld[1] : dt;
    const r1 = 1;
    const r2 = (dt + h1) / dt;
    const u22 = r2 * (r2 - r1);
    if (Math.abs(u22) < 1e-30) {
      ag[0] = 1 / dt;
      ag[1] = -1 / dt;
    } else {
      const rhs2 = r1 / dt;
      const ag2 = rhs2 / u22;
      ag[1] = (-1 / dt - r2 * ag2) / r1;
      ag[0] = -(ag[1] + ag2);
      ag[2] = ag2;
    }
  } else if (method === "gear") {
    solveGearVandermonde(dt, deltaOld, order, ag, scratch);
  } else {
    // BDF-1
    ag[0] = 1 / dt;
    ag[1] = -1 / dt;
  }
}

