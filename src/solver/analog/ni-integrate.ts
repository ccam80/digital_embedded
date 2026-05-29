import type { IntegrationMethod } from "./integration.js";

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
 *   - ccapPrev      CKTstate1[ccap]- required for TRAP order 2 recursion (niinteg.c:32)
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
    } else if (order === 2) {
      // niinteg.c:32-34- RECURSIVE in ccapPrev
      ccap = -ccapPrev * ag[1] + ag[0] * (q0 - q1);
    } else {
      // niinteg.c:36-39- default: return(E_ORDER)
      throw new Error(`niIntegrate: unsupported TRAP order ${order} (ngspice E_ORDER)`);
    }
  } else if (method === "gear") {
    // GEAR- niinteg.c:43-64. CKTstate0[ccap]=0, then the case fall-through
    // accumulates from the highest order down to ag[0] last (highest-order term
    // first, ag[0]*state0 last). niinteg.c:66-67 returns E_ORDER when CKTorder
    // matches no case 1..6 (order<1 or order>6).
    if (order < 1 || order > 6) {
      throw new Error(`niIntegrate: unsupported BDF/GEAR order ${order} (ngspice E_ORDER)`);
    }
    // niinteg.c:43
    ccap = 0;
    // niinteg.c:47-59- case <order> ... case 2 fall-through, highest order first
    for (let k = order; k >= 2; k--) {
      ccap += ag[k] * (qHistory[k - 2] ?? 0);
    }
    // niinteg.c:62-63- case 1: ag[1]*state1 then ag[0]*state0
    ccap += ag[1] * q1;
    ccap += ag[0] * q0;
  } else {
    // capload.c:69 error path: method integer unrecognised- ngspice returns E_METHOD.
    throw new Error(`niIntegrate: unsupported integration method "${method as string}" (ngspice E_METHOD)`);
  }
  // niinteg.c:77-78- universal exit
  const ceq = ccap - ag[0] * q0;
  const geq = ag[0] * cap;
  return { ccap, ceq, geq };
}
