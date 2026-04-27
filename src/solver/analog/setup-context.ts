/**
 * SetupContext — per-circuit-lifetime context passed to every element.setup() call.
 *
 * Port of ngspice's DEVsetup signature:
 *   int XXXsetup(SMPmatrix *matrix, GENmodel *inModel, CKTcircuit *ckt, int *states)
 *
 * One SetupContext per MNAEngine._setup() invocation. Constructed inside _setup()
 * and passed to every element's setup(ctx) in NGSPICE_LOAD_ORDER bucket order.
 */

import type { SparseSolver } from "./sparse-solver.js";
import type { AnalogElement } from "./element.js";

export interface SetupContext {
  /** ckt->CKTmatrix surrogate (TSTALLOC target). */
  readonly solver: SparseSolver;

  /** ckt->CKTtemp. */
  readonly temp: number;

  /** ckt->CKTnomTemp. */
  readonly nomTemp: number;

  /** ckt->CKTcopyNodesets. */
  readonly copyNodesets: boolean;

  /** Port of CKTmkVolt (cktmkvol.c:20-41). Allocates a fresh internal
   *  voltage node, returns its 1-based MNA number. */
  makeVolt(deviceLabel: string, suffix: string): number;

  makeCur(deviceLabel: string, suffix: string): number;

  /** Port of `*states += N` semantics (mos1set.c:96-97 etc.). Returns
   *  the offset where this device's state slots start; advances the
   *  running counter by N. */
  allocStates(slotCount: number): number;

  /** Port of CKTfndBranch (cktfbran.c:20-33). LAZY-allocating: if the
   *  controlling source's branch has not yet been allocated by its
   *  setup() call, the source's findBranchFor callback allocates it
   *  via ctx.makeCur. Returns 0 if no device with that label exists. */
  findBranch(sourceLabel: string): number;

  /** Port of CKTfndDev (cktfinddev.c:13-17 → nghash_find). Reads the
   *  device-name → AnalogElement map populated by the compiler at the
   *  end of compileAnalog (parse-time equivalent: ngspice's
   *  DEVnameHash is populated in cktcrte.c at instance creation, well
   *  before CKTsetup). Returns null if not found. */
  findDevice(deviceLabel: string): AnalogElement | null;
}
