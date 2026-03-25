/**
 * Companion model coefficient functions for reactive elements.
 *
 * Capacitors and inductors are modelled as a parallel conductance (geq) plus
 * an independent current source (ieq) — the standard Norton companion model
 * used in SPICE-class simulators.
 *
 * Coefficient formulas (from circuits-engine-spec.md section 4):
 *
 *   BDF-1 (Backward Euler):
 *     capacitor  geq = C/h         ieq = -geq * v(n)
 *     inductor   geq = L/h         ieq = -geq * i(n)       (current branch)
 *
 *   Trapezoidal:
 *     capacitor  geq = 2C/h        ieq = -geq * v(n) - i(n)
 *     inductor   geq = 2L/h        ieq = -geq * i(n) - v(n) (current branch)
 *
 *   BDF-2 (Gear order 2):
 *     capacitor  geq = 3C/(2h)     ieq = -geq * (4/3 * v(n) - 1/3 * v(n-1))
 *     inductor   geq = 3L/(2h)     ieq = -geq * (4/3 * i(n) - 1/3 * i(n-1))
 */

import type { IntegrationMethod } from "./element.js";

// ---------------------------------------------------------------------------
// Capacitor companion model
// ---------------------------------------------------------------------------

/**
 * Companion model conductance for a capacitor.
 *
 * @param C      - Capacitance in farads
 * @param dt     - Timestep in seconds
 * @param method - Integration method
 * @returns Equivalent parallel conductance geq in siemens
 */
export function capacitorConductance(
  C: number,
  dt: number,
  method: IntegrationMethod,
): number {
  switch (method) {
    case "bdf1":
      return C / dt;
    case "trapezoidal":
      return (2 * C) / dt;
    case "bdf2":
      return (3 * C) / (2 * dt);
  }
}

/**
 * Companion model history current for a capacitor.
 *
 * The history current ieq captures the contribution from past state so the
 * companion model correctly integrates the capacitor equation over time.
 *
 * @param C      - Capacitance in farads
 * @param dt     - Timestep in seconds
 * @param method - Integration method
 * @param vNow   - Terminal voltage at the current (most recent accepted) timestep v(n)
 * @param vPrev  - Terminal voltage one timestep earlier v(n-1); used by BDF-2 only
 * @param iNow   - Capacitor current at v(n); used by trapezoidal only
 * @returns Equivalent Norton current source ieq in amperes
 */
export function capacitorHistoryCurrent(
  C: number,
  dt: number,
  method: IntegrationMethod,
  vNow: number,
  vPrev: number,
  iNow: number,
): number {
  const geq = capacitorConductance(C, dt, method);
  switch (method) {
    case "bdf1":
      return -geq * vNow;
    case "trapezoidal":
      return -geq * vNow - iNow;
    case "bdf2":
      return -geq * ((4 / 3) * vNow - (1 / 3) * vPrev);
  }
}

// ---------------------------------------------------------------------------
// Inductor companion model
// ---------------------------------------------------------------------------

/**
 * Companion model conductance for an inductor.
 *
 * The inductor is dual to the capacitor: voltage and current roles are swapped.
 *
 * @param L      - Inductance in henries
 * @param dt     - Timestep in seconds
 * @param method - Integration method
 * @returns Equivalent parallel conductance geq in siemens
 */
export function inductorConductance(
  L: number,
  dt: number,
  method: IntegrationMethod,
): number {
  switch (method) {
    case "bdf1":
      return L / dt;
    case "trapezoidal":
      return (2 * L) / dt;
    case "bdf2":
      return (3 * L) / (2 * dt);
  }
}

/**
 * Companion model history current for an inductor.
 *
 * @param L      - Inductance in henries
 * @param dt     - Timestep in seconds
 * @param method - Integration method
 * @param iNow   - Branch current at the current (most recent accepted) timestep i(n)
 * @param iPrev  - Branch current one timestep earlier i(n-1); used by BDF-2 only
 * @param vNow   - Terminal voltage at i(n); used by trapezoidal only
 * @returns Equivalent Norton current source ieq in amperes
 */
export function inductorHistoryCurrent(
  L: number,
  dt: number,
  method: IntegrationMethod,
  iNow: number,
  iPrev: number,
  vNow: number,
): number {
  const geq = inductorConductance(L, dt, method);
  switch (method) {
    case "bdf1":
      return -geq * iNow;
    case "trapezoidal":
      return -geq * iNow - vNow;
    case "bdf2":
      return -geq * ((4 / 3) * iNow - (1 / 3) * iPrev);
  }
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
