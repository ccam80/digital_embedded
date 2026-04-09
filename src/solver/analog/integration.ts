/**
 * Companion model coefficient functions for reactive elements.
 *
 * integrateCapacitor / integrateInductor implement the NIintegrate-based
 * companion model used by ngspice (niinteg.c / nicomcof.c). They return
 * geq, ceq, ccap, and ag0 — the full set of coefficients needed to stamp
 * the companion model into the MNA matrix.
 */

import type { IntegrationMethod } from "./element.js";

/**
 * NIintegrate-based companion model for a capacitor.
 * Computes geq, ceq, ccap, and ag0 from charge history.
 *
 * Per-method ccap formulas:
 *   BDF-1 / Trap order 1: ccap = (Q_n - Q_{n-1}) / dt
 *   Trap order 2: ccap = (2/dt)(Q_n - Q_{n-1}) - ccapPrev  [RECURSIVE]
 *   BDF-2: ccap = ag[0]*Q_n + ag[1]*Q_{n-1} + ag[2]*Q_{n-2}
 *
 * Universal companion: geq = ag0 * C, ceq = ccap - geq * vNow
 */
export function integrateCapacitor(
  C: number,
  vNow: number,
  q0: number, q1: number, q2: number,
  dt: number, h1: number, h2: number,
  order: number,
  method: IntegrationMethod,
  ccapPrev: number,
): { geq: number; ceq: number; ccap: number; ag0: number } {
  if (dt <= 0) return { geq: 0, ceq: 0, ccap: 0, ag0: 0 };

  let ag0: number;
  let ccap: number;

  if (order <= 1) {
    ag0 = 1 / dt;
    ccap = (q0 - q1) / dt;
  } else if (method === "trapezoidal") {
    ag0 = 2 / dt;
    ccap = (2 / dt) * (q0 - q1) - ccapPrev;
  } else {
    // BDF-2: ag[] from NIcomCof matrix solve (nicomcof.c:56-117)
    const safeH1 = h1 > 0 ? h1 : dt;
    const safeH2 = h2 > 0 ? h2 : safeH1;
    const r1 = safeH1 / dt;
    const r2 = (safeH1 + safeH2) / dt;
    const u22 = r2 * (r2 - r1);
    if (Math.abs(u22) < 1e-30) {
      ag0 = 1 / dt;
      ccap = (q0 - q1) / dt;
    } else {
      const rhs2 = r1 / dt;
      const ag2 = rhs2 / u22;
      const ag1 = (-1 / dt - r2 * ag2) / r1;
      ag0 = -(ag1 + ag2);
      ccap = ag0 * q0 + ag1 * q1 + ag2 * q2;
    }
  }

  const geq = ag0 * C;
  const ceq = ccap - geq * vNow;
  return { geq, ceq, ccap, ag0 };
}

/**
 * NIintegrate-based companion model for an inductor.
 * Dual of integrateCapacitor: flux instead of charge, L instead of C.
 */
export function integrateInductor(
  L: number,
  iNow: number,
  phi0: number, phi1: number, phi2: number,
  dt: number, h1: number, h2: number,
  order: number,
  method: IntegrationMethod,
  ccapPrev: number,
): { geq: number; ceq: number; ccap: number; ag0: number } {
  if (dt <= 0) return { geq: 0, ceq: 0, ccap: 0, ag0: 0 };

  let ag0: number;
  let ccap: number;

  if (order <= 1) {
    ag0 = 1 / dt;
    ccap = (phi0 - phi1) / dt;
  } else if (method === "trapezoidal") {
    ag0 = 2 / dt;
    ccap = (2 / dt) * (phi0 - phi1) - ccapPrev;
  } else {
    const safeH1 = h1 > 0 ? h1 : dt;
    const safeH2 = h2 > 0 ? h2 : safeH1;
    const r1 = safeH1 / dt;
    const r2 = (safeH1 + safeH2) / dt;
    const u22 = r2 * (r2 - r1);
    if (Math.abs(u22) < 1e-30) {
      ag0 = 1 / dt;
      ccap = (phi0 - phi1) / dt;
    } else {
      const rhs2 = r1 / dt;
      const ag2 = rhs2 / u22;
      const ag1 = (-1 / dt - r2 * ag2) / r1;
      ag0 = -(ag1 + ag2);
      ccap = ag0 * phi0 + ag1 * phi1 + ag2 * phi2;
    }
  }

  const geq = ag0 * L;
  const ceq = ccap - geq * iNow;
  return { geq, ceq, ccap, ag0 };
}

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

/**
 * Compute integration coefficients ag0 and ag1 from step parameters.
 * ag0 is the coefficient on Q_n (or phi_n for inductors).
 * ag1 is the coefficient on Q_{n-1}.
 *
 * Used by StepSnapshot capture to record the coefficients without
 * re-deriving them from element-level calculations.
 */
export function computeIntegrationCoefficients(
  dt: number,
  h1: number,
  h2: number,
  order: number,
  method: IntegrationMethod,
): { ag0: number; ag1: number } {
  if (dt <= 0) return { ag0: 0, ag1: 0 };

  if (order <= 1) {
    return { ag0: 1 / dt, ag1: -1 / dt };
  } else if (method === "trapezoidal") {
    return { ag0: 2 / dt, ag1: -2 / dt };
  } else {
    // BDF-2
    const safeH1 = h1 > 0 ? h1 : dt;
    const safeH2 = h2 > 0 ? h2 : safeH1;
    const r1 = safeH1 / dt;
    const r2 = (safeH1 + safeH2) / dt;
    const u22 = r2 * (r2 - r1);
    if (Math.abs(u22) < 1e-30) {
      return { ag0: 1 / dt, ag1: -1 / dt };
    }
    const rhs2 = r1 / dt;
    const ag2 = rhs2 / u22;
    const ag1val = (-1 / dt - r2 * ag2) / r1;
    const ag0val = -(ag1val + ag2);
    return { ag0: ag0val, ag1: ag1val };
  }
}
