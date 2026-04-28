/**
 * InductorSubElement and MutualInductorElement — sub-element classes used
 * internally by AnalogTransformerElement and AnalogTappedTransformerElement.
 *
 * These classes are NOT registered as top-level MNA models; they are
 * constructed and owned by transformer composites.
 *
 * ngspice anchors:
 *   indsetup.c:84-100  — IND branch allocation and TSTALLOC sequence
 *   mutsetup.c:30-70   — MUT branch resolution and TSTALLOC sequence
 *   indload.c          — IND load (companion model)
 *   mutload.c          — MUT load (off-diagonal coupling stamps)
 */

import type { AnalogElementCore, StatePoolRef } from "../../core/analog-types.js";
import { NGSPICE_LOAD_ORDER } from "../../core/analog-types.js";
import type { PoolBackedAnalogElementCore } from "../../core/analog-types.js";
import type { IntegrationMethod, LoadContext } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { defineStateSchema, applyInitialValues } from "../../solver/analog/state-schema.js";
import type { StateSchema } from "../../solver/analog/state-schema.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import type { LteParams } from "../../solver/analog/ckt-terr.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import {
  MODEDC, MODEINITPRED, MODEINITTRAN, MODEUIC,
} from "../../solver/analog/ckt-mode.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";

// ---------------------------------------------------------------------------
// INDUCTOR_SUB_SCHEMA — 2-slot ngspice schema (same semantics as PB-IND)
// ---------------------------------------------------------------------------

const INDUCTOR_SUB_SCHEMA: StateSchema = defineStateSchema("InductorSubElement", [
  { name: "PHI",  doc: "Flux Φ = L·i — ngspice INDflux (INDstate+0)", init: { kind: "zero" } },
  { name: "CCAP", doc: "NIintegrate companion current — ngspice INDvolt (INDstate+1) per niinteg.c:15 `#define ccap qcap+1`", init: { kind: "zero" } },
]);

const SLOT_PHI  = 0;  // ngspice INDflux = INDstate+0
const SLOT_CCAP = 1;  // ngspice INDvolt = INDstate+1 (= NIintegrate ccap)

// ---------------------------------------------------------------------------
// InductorSubElement
// ---------------------------------------------------------------------------

/**
 * Lightweight inductor sub-element for use inside transformer composites.
 * Implements the same setup/load/state/LTE behavior as AnalogInductorElement
 * (PB-IND) but is not registered as a top-level MNA model.
 *
 * Pool-backed per PoolBackedAnalogElementCore interface.
 */
export class InductorSubElement implements PoolBackedAnalogElementCore {
  branchIndex: number = -1;
  readonly poolBacked = true as const;
  readonly stateSchema: StateSchema = INDUCTOR_SUB_SCHEMA;
  readonly stateSize: number = 2;
  stateBaseOffset: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.IND;
  readonly isNonlinear: false = false;
  readonly isReactive: true = true;
  s0: Float64Array<ArrayBufferLike> = new Float64Array(0);
  s1: Float64Array<ArrayBufferLike> = new Float64Array(0);
  s2: Float64Array<ArrayBufferLike> = new Float64Array(0);
  s3: Float64Array<ArrayBufferLike> = new Float64Array(0);
  s4: Float64Array<ArrayBufferLike> = new Float64Array(0);
  s5: Float64Array<ArrayBufferLike> = new Float64Array(0);
  s6: Float64Array<ArrayBufferLike> = new Float64Array(0);
  s7: Float64Array<ArrayBufferLike> = new Float64Array(0);

  private _hPIbr:   number = -1;
  private _hNIbr:   number = -1;
  private _hIbrN:   number = -1;
  private _hIbrP:   number = -1;
  private _hIbrIbr: number = -1;
  private _pool!: StatePoolRef;

  constructor(
    private readonly _posNode: number,    // INDposNode
    private readonly _negNode: number,    // INDnegNode
    private readonly _label: string,      // unique branch label
    private _inductance: number,          // L value at construction time
  ) {}

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const posNode = this._posNode;
    const negNode = this._negNode;

    // indsetup.c:78-79 — *states += 2 (INDflux = state+0, INDvolt = state+1)
    if (this.stateBaseOffset === -1) {
      this.stateBaseOffset = ctx.allocStates(2);
    }

    // indsetup.c:84-88 — CKTmkCur guard (idempotent)
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this._label, "branch");
    }
    const b = this.branchIndex;

    // indsetup.c:96-100 — TSTALLOC sequence, line-for-line.
    this._hPIbr   = solver.allocElement(posNode, b);
    this._hNIbr   = solver.allocElement(negNode, b);
    this._hIbrN   = solver.allocElement(b, negNode);
    this._hIbrP   = solver.allocElement(b, posNode);
    this._hIbrIbr = solver.allocElement(b, b);
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    applyInitialValues(INDUCTOR_SUB_SCHEMA, pool, this.stateBaseOffset, {});
  }

  load(ctx: LoadContext): void {
    const { solver, rhsOld, ag, cktMode: mode } = ctx;
    const b = this.branchIndex;
    const L = this._inductance;
    const base = this.stateBaseOffset;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];

    // indload.c:43-51 — flux-from-current update.
    if (!(mode & (MODEDC | MODEINITPRED))) {
      if ((mode & MODEUIC) && (mode & MODEINITTRAN)) {
        // indload.c:44-46: UIC seed (no IC param on sub-element, so skip IC branch).
        s0[base + SLOT_PHI] = L * rhsOld[b];
      } else {
        // indload.c:48-50: flux from prior NR iterate branch current.
        s0[base + SLOT_PHI] = L * rhsOld[b];
      }
    }

    // indload.c:88-110 — req/veq.
    let req = 0;
    let veq = 0;
    if (mode & MODEDC) {
      // indload.c:88-90.
      req = 0;
      veq = 0;
    } else {
      // indload.c:93-104 (#ifndef PREDICTOR): mutually-exclusive flux copies.
      if (mode & MODEINITPRED) {
        // indload.c:94-96: predictor — s0[INDflux] = s1[INDflux].
        s0[base + SLOT_PHI] = s1[base + SLOT_PHI];
      } else if (mode & MODEINITTRAN) {
        // indload.c:99-102: transient init — s1[INDflux] = s0[INDflux].
        s1[base + SLOT_PHI] = s0[base + SLOT_PHI];
      }
      // indload.c:106-109: NIintegrate(ckt, &geq, &ceq, L, INDflux).
      const phi0 = s0[base + SLOT_PHI];
      const phi1 = s1[base + SLOT_PHI];
      const phi2 = s2[base + SLOT_PHI];
      const phi3 = s3[base + SLOT_PHI];
      const ccapPrev = s1[base + SLOT_CCAP];
      const ni = niIntegrate(
        ctx.method,
        ctx.order,
        L,
        ag,
        phi0, phi1,
        [phi2, phi3, 0, 0, 0],
        ccapPrev,
      );
      req = ni.geq;
      veq = ni.ceq;
      s0[base + SLOT_CCAP] = ni.ccap;
    }

    // indload.c:114-117: state0[INDvolt] → state1[INDvolt] on MODEINITTRAN.
    if (mode & MODEINITTRAN) {
      s1[base + SLOT_CCAP] = s0[base + SLOT_CCAP];
    }

    // indload.c:119-123: unconditional 5-stamp sequence through cached handles.
    solver.stampElement(this._hPIbr, 1);       // *(INDposIbrptr) += 1
    solver.stampElement(this._hNIbr, -1);      // *(INDnegIbrptr) -= 1
    solver.stampElement(this._hIbrP, 1);       // *(INDibrPosptr) += 1
    solver.stampElement(this._hIbrN, -1);      // *(INDibrNegptr) -= 1
    solver.stampElement(this._hIbrIbr, -req);  // *(INDibrIbrptr) -= req
    // indload.c:112: *(CKTrhs + INDbrEq) += veq.
    stampRHS(ctx.rhs, b, veq);
  }

  getLteTimestep(
    dt: number,
    deltaOld: readonly number[],
    order: number,
    method: IntegrationMethod,
    lteParams: LteParams,
  ): number {
    const base = this.stateBaseOffset;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];
    const phi0 = s0[base + SLOT_PHI];
    const phi1 = s1[base + SLOT_PHI];
    const phi2 = s2[base + SLOT_PHI];
    const phi3 = s3[base + SLOT_PHI];
    const ccap0 = s0[base + SLOT_CCAP];
    const ccap1 = s1[base + SLOT_CCAP];
    return cktTerr(dt, deltaOld, order, method, phi0, phi1, phi2, phi3, ccap0, ccap1, lteParams);
  }

  setParam(key: string, value: number): void {
    if (key === "L" || key === "inductance") {
      this._inductance = value;
    }
  }

  findBranchFor(name: string, ctx: SetupContext): number {
    if (name !== this._label) return 0;
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this._label, "branch");
    }
    return this.branchIndex;
  }

  // Package-internal getters for MutualInductorElement.load() only.
  get inductanceForMut(): number { return this._inductance; }
  get statePoolForMut(): { s0: Float64Array; s1: Float64Array; s2: Float64Array; s3: Float64Array; stateBaseOffset: number } {
    return {
      s0: this._pool.states[0],
      s1: this._pool.states[1],
      s2: this._pool.states[2],
      s3: this._pool.states[3],
      stateBaseOffset: this.stateBaseOffset,
    };
  }
}

// ---------------------------------------------------------------------------
// MutualInductorElement
// ---------------------------------------------------------------------------

/**
 * Mutual inductor (K element) sub-element for use inside transformer composites.
 * Reads branch indices from its paired InductorSubElement refs directly.
 * NOT pool-backed (MUT allocates no state slots — mutsetup.c:28 NG_IGNORE(states)).
 */
export class MutualInductorElement implements AnalogElementCore {
  branchIndex: number = -1;   // unused; satisfies AnalogElementCore interface
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.MUT;
  readonly isNonlinear: false = false;
  readonly isReactive: false = false;

  private _hBr1Br2: number = -1;
  private _hBr2Br1: number = -1;

  constructor(
    private _coupling: number,                   // K coupling coefficient (mutable)
    private readonly _l1: InductorSubElement,    // first coupled inductor (ref)
    private readonly _l2: InductorSubElement,    // second coupled inductor (ref)
  ) {}

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;

    // mutsetup.c:44-57 — resolve inductor references via constructor-stored refs.
    // Pre-condition: both _l1.setup(ctx) and _l2.setup(ctx) MUST have run.
    const b1 = this._l1.branchIndex;
    const b2 = this._l2.branchIndex;
    if (b1 === -1 || b2 === -1) {
      throw new Error("MutualInductorElement.setup(): branchIndex not yet allocated on sub-inductor");
    }

    // mutsetup.c:66-67 — TSTALLOC sequence, 2 entries.
    this._hBr1Br2 = solver.allocElement(b1, b2);
    this._hBr2Br1 = solver.allocElement(b2, b1);
  }

  load(ctx: LoadContext): void {
    // Port from mutload.c.
    // MUTfactor = K * sqrt(L1 * L2) is the mutual inductance M.
    // In ngspice mutload.c:
    //   if(!(ckt->CKTmode & (MODEDC|MODEINITPRED))) {
    //     CKTstate0[l1.INDflux] += MUTfactor * CKTrhsOld[l2.INDbrEq]
    //     CKTstate0[l2.INDflux] += MUTfactor * CKTrhsOld[l1.INDbrEq]
    //   }
    //   *(MUTbr1br2) -= MUTfactor * CKTag[0]
    //   *(MUTbr2br1) -= MUTfactor * CKTag[0]
    const { rhsOld, ag, cktMode: mode } = ctx;
    const b1 = this._l1.branchIndex;
    const b2 = this._l2.branchIndex;
    const L1 = this._l1.inductanceForMut;
    const L2 = this._l2.inductanceForMut;
    const mutFactor = this._coupling * Math.sqrt(L1 * L2);

    if (!(mode & (MODEDC | MODEINITPRED))) {
      const pool1 = this._l1.statePoolForMut;
      const pool2 = this._l2.statePoolForMut;
      // CKTstate0[l1.INDflux] += MUTfactor * CKTrhsOld[l2.INDbrEq]
      pool1.s0[pool1.stateBaseOffset + SLOT_PHI] += mutFactor * rhsOld[b2];
      // CKTstate0[l2.INDflux] += MUTfactor * CKTrhsOld[l1.INDbrEq]
      pool2.s0[pool2.stateBaseOffset + SLOT_PHI] += mutFactor * rhsOld[b1];
    }

    // *(MUTbr1br2) -= MUTfactor * CKTag[0]
    ctx.solver.stampElement(this._hBr1Br2, -mutFactor * ag[0]);
    // *(MUTbr2br1) -= MUTfactor * CKTag[0]
    ctx.solver.stampElement(this._hBr2Br1, -mutFactor * ag[0]);
  }

  setParam(key: string, value: number): void {
    if (key === "K" || key === "coupling") {
      this._coupling = value;
    }
  }
}
