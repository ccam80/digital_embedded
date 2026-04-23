import type { IntegrationMethod } from "../../core/analog-types.js";

/**
 * Exact port of ngspice niinteg.c NIintegrate() (ref/ngspice/src/maths/ni/niinteg.c:17-80).
 *
 * Returns { ccap, ceq, geq } matching niinteg.c lines 25-78 exactly.
 * The caller MUST write the returned `ccap` into state0[ccap] so the next step's
 * ccapPrev (state1[ccap]) is available for TRAP order-2 recursion.
 *
 *   - method        integration method
 *   - order         integration order (>=1)
 *   - cap           device capacitance (C, or L for inductors) passed to NIintegrate as `cap`
 *   - ag            coefficient vector from nicomcof.c (length >= order+1)
 *   - q0            CKTstate0[qcap]
 *   - q1            CKTstate1[qcap]
 *   - qHistory      [q2, q3, q4, q5, q6] for GEAR order >= 2; zeros if unavailable
 *   - ccapPrev      CKTstate1[ccap] — required for TRAP order 2 recursion (niinteg.c:32)
 */
export function niIntegrate(
  method: IntegrationMethod,
  order: number,
  cap: number,
  ag: Readonly<Float64Array> | Readonly<number[]>,
  q0: number,
  q1: number,
  qHistory: Readonly<number[]>,
  ccapPrev: number,
): { ccap: number; ceq: number; geq: number } {
  let ccap: number;
  if (method === "trapezoidal") {
    if (order === 1) {
      // niinteg.c:28-29
      ccap = ag[0] * q0 + ag[1] * q1;
    } else {
      // niinteg.c:32-34 — RECURSIVE in ccapPrev
      ccap = -ccapPrev * ag[1] + ag[0] * (q0 - q1);
    }
  } else if (method === "gear") {
    // GEAR / BDF-n — niinteg.c:43, 47-63
    // capload.c:69: if(error) return(error) — ngspice returns E_ORDER for bad order.
    if (order < 1) {
      throw new Error(`niIntegrate: unsupported GEAR order ${order} (ngspice E_ORDER)`);
    }
    ccap = ag[0] * q0 + ag[1] * q1;
    for (let k = 2; k <= order; k++) {
      ccap += ag[k] * (qHistory[k - 2] ?? 0);
    }
  } else {
    // capload.c:69 error path: unknown integration method.
    throw new Error(`niIntegrate: unsupported integration method "${method as string}" (ngspice E_METHOD)`);
  }
  // niinteg.c:77-78 — universal exit
  const ceq = ccap - ag[0] * q0;
  const geq = ag[0] * cap;
  return { ccap, ceq, geq };
}
