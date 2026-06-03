/**
 * TempContext- ambient and reference temperatures passed to DEVtemperature callbacks.
 *
 * Matches the ngspice CKT fields read by every surveyed DEVtemperature
 * implementation (ckttemp.c:28-33, mos1temp.c:44-289, bjttemp.c, diotemp.c,
 * jfettemp.c, muttemp.c:35-41). No surveyed device reads CKTtime or CKTmode
 * in its temperature callback, so those fields are not included here.
 * Add fields only when a real device requires them.
 *
 * Spec ref: spec/refactor-per-type-orchestration.md §4.2 / §4.3
 */

import type { DiagnosticCollector } from "./diagnostics.js";

export interface TempContext {
  /** Ambient circuit temperature in Kelvin (ngspice: CKTtemp). */
  cktTemp: number;
  /** Nominal (reference) temperature in Kelvin (ngspice: CKTnomTemp). */
  cktNomTemp: number;
  /**
   * Relative tolerance (ngspice CKTreltol, cktdefs.h). Read by the diode
   * breakdown-voltage matching iteration (diotemp.c:208 — `tol =
   * ckt->CKTreltol*cbv`) to set the convergence band of the brkdEmissionCoeff
   * fixed-point solve. Threaded through the temperature pass because
   * DIOtempUpdate runs inside the temperature callback, not load().
   */
  reltol: number;
  /**
   * Minimum log-argument floor (ngspice CKTepsmin, cktdefs.h:323). Read by the
   * diode saturation-current and high-injection knee floors (diosetup.c:92-103,
   * 190-191) so the subsequent log/exp evaluations stay in-domain.
   */
  epsmin: number;
  /**
   * ngspice CKTindverbosity (cktdefs.h:111). Diagnostic-level integer
   * controlling the `MUTtemp` Cholesky-verify pass:
   *   0 = no verification;
   *   1 = verify, emit on non-positive-definite / duplicate K / |K|>1 / L<0;
   *   2 = also emit on incomplete K coupling sets (missing K's implicitly 0).
   * Default 2 per cktinit.c:65.
   */
  _indVerbosity: number;
  /**
   * Diagnostic collector the MUTtemp verify pass routes its emissions through
   * (muttemp.c:184-203). Forwarded from CKTCircuitContext.diagnostics by the
   * lazy `tempCtx` accessor so Pass 3 of IndFamilyTempHandler can emit without
   * reaching the full CKTcircuit. Optional because device-local hot-load
   * recomputes (diode/MOSFET setParam paths) construct an ad-hoc TempContext
   * that never reaches the IND-family verify pass; the verify driver only runs
   * when the lazy accessor (which always populates this) supplies the context.
   */
  diagnostics?: DiagnosticCollector;
}
