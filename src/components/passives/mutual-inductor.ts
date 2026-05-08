/**
 * MutualInductorElement and InductorSubElement â€” class-based leaves used by
 * Transformer composites.
 *
 * After Wave 11a, Transformer (`transformer.ts`) is `kind: "netlist"` and
 * references `Inductor` + `TransformerCoupling` by typeId for the actual
 * compiled topology. The classes in this file remain as the abstract-base
 * forms of the older inline composition primitives, available for any
 * follow-on composite that wants a 1-to-1 paired coil + K element without
 * routing through the registered `Inductor`/`TransformerCoupling` pair.
 *
 * ngspice anchors:
 *   indsetup.c:84-100 - IND branch allocation and TSTALLOC sequence
 *   mutsetup.c:30-70  - MUT branch resolution and TSTALLOC sequence
 *   indload.c         - IND load (companion model)
 *   mutload.c         - MUT load (off-diagonal coupling stamps)
 */

import { AnalogElement, PoolBackedAnalogElement } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import type { IntegrationMethod } from "../../solver/analog/integration.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { defineStateSchema } from "../../solver/analog/state-schema.js";
import type { StateSchema } from "../../solver/analog/state-schema.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import type { LteParams } from "../../solver/analog/ckt-terr.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import {
  MODEDC, MODEINITPRED, MODEINITTRAN, MODEUIC,
} from "../../solver/analog/ckt-mode.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";

// ---------------------------------------------------------------------------
// INDUCTOR_SUB_SCHEMA â€” 2-slot ngspice schema (same semantics as PB-IND)
// ---------------------------------------------------------------------------

const INDUCTOR_SUB_SCHEMA: StateSchema = defineStateSchema("InductorSubElement", [
  { name: "PHI",  doc: "Flux Φ = L·i â€” ngspice INDflux (INDstate+0)" },
  { name: "CCAP", doc: "NIintegrate companion current â€” ngspice INDvolt (INDstate+1) per niinteg.c:15 `#define ccap qcap+1`" },
]);

const SLOT_PHI  = 0;  // ngspice INDflux = INDstate+0
const SLOT_CCAP = 1;  // ngspice INDvolt = INDstate+1 (= NIintegrate ccap)

// ---------------------------------------------------------------------------
// InductorSubElement
// ---------------------------------------------------------------------------

/**
 * Lightweight inductor leaf for use inside transformer composites or any
 * caller that needs a registry-free PB-IND element. Implements the same
 * setup/load/state/LTE behaviour as `AnalogInductorElement` but takes its
 * inductance and branch label through plain constructor arguments rather
 * than a PropertyBag â€” this keeps the class usable from imperative composite
 * factories (e.g. `transformer.ts` ctor body, prior to the netlist-form
 * migration).
 */
export class InductorSubElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.IND;
  readonly stateSchema: StateSchema = INDUCTOR_SUB_SCHEMA;
  readonly stateSize: number = INDUCTOR_SUB_SCHEMA.size;

  private _hPIbr:   number = -1;
  private _hNIbr:   number = -1;
  private _hIbrN:   number = -1;
  private _hIbrP:   number = -1;
  private _hIbrIbr: number = -1;
  private readonly _branchLabel: string;
  private _inductance: number;

  /** Package-internal getter for parent composites' load() â€” exposes the
   *  branch-diagonal handle allocated during setup() so the parent can stamp
   *  it directly without calling this leaf's own load(). */
  get hIbrIbr(): number { return this._hIbrIbr; }

  /** Package-internal accessor for `MutualInductorElement.load()` â€” exposes
   *  the inductance value for MUTfactor = K * sqrt(L1 * L2). */
  get inductanceForMut(): number { return this._inductance; }

  /** Package-internal accessor for `MutualInductorElement.load()` â€” exposes
   *  the per-step state arrays + base offset so the K element can update
   *  this coil's flux slot directly (mutload.c off-diagonal contribution). */
  get statePoolForMut(): { s0: Float64Array; s1: Float64Array; s2: Float64Array; s3: Float64Array; base: number } {
    return {
      s0: this._pool.states[0],
      s1: this._pool.states[1],
      s2: this._pool.states[2],
      s3: this._pool.states[3],
      base: this._stateBase,
    };
  }

  constructor(
    pinNodes: ReadonlyMap<string, number>,
    branchLabel: string,
    inductance: number = 0,
  ) {
    super(pinNodes);
    this._branchLabel = branchLabel;
    this._inductance = inductance;
  }

  setup(ctx: SetupContext): void {
    if (!this._branchLabel) {
      throw new Error(
        "InductorSubElement: requires non-empty branch label.",
      );
    }
    const solver = ctx.solver;
    const posNode = this.pinNodes.get("pos")!;
    const negNode = this.pinNodes.get("neg")!;

    // indsetup.c:78-79 â€” *states += 2 (INDflux = state+0, INDvolt = state+1)
    if (this._stateBase === -1) {
      this._stateBase = ctx.allocStates(this.stateSize);
    }

    // indsetup.c:84-88 â€” CKTmkCur guard (idempotent, mirrors VSRCfindBr).
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this._branchLabel, "branch");
    }
    const b = this.branchIndex;

    // indsetup.c:96-100 â€” TSTALLOC sequence, line-for-line.
    this._hPIbr   = solver.allocElement(posNode, b);
    this._hNIbr   = solver.allocElement(negNode, b);
    this._hIbrN   = solver.allocElement(b, negNode);
    this._hIbrP   = solver.allocElement(b, posNode);
    this._hIbrIbr = solver.allocElement(b, b);
  }

  load(ctx: LoadContext): void {
    const { solver, rhsOld, ag, cktMode: mode } = ctx;
    const b = this.branchIndex;
    const L = this._inductance;
    const base = this._stateBase;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];

    // indload.c:43-51 â€” flux-from-current update.
    if (!(mode & (MODEDC | MODEINITPRED))) {
      if ((mode & MODEUIC) && (mode & MODEINITTRAN)) {
        // No IC param on sub-element â€” fall through to flux from rhsOld.
        s0[base + SLOT_PHI] = L * rhsOld[b];
      } else {
        s0[base + SLOT_PHI] = L * rhsOld[b];
      }
    }

    // indload.c:88-110 â€” req/veq.
    let req = 0;
    let veq = 0;
    if (mode & MODEDC) {
      req = 0;
      veq = 0;
    } else {
      if (mode & MODEINITPRED) {
        s0[base + SLOT_PHI] = s1[base + SLOT_PHI];
      } else if (mode & MODEINITTRAN) {
        s1[base + SLOT_PHI] = s0[base + SLOT_PHI];
      }
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

    // indload.c:114-117: state0[INDvolt] â†’ state1[INDvolt] on MODEINITTRAN.
    if (mode & MODEINITTRAN) {
      s1[base + SLOT_CCAP] = s0[base + SLOT_CCAP];
    }

    // indload.c:119-123: unconditional 5-stamp sequence through cached handles.
    solver.stampElement(this._hPIbr, 1);
    solver.stampElement(this._hNIbr, -1);
    solver.stampElement(this._hIbrP, 1);
    solver.stampElement(this._hIbrN, -1);
    solver.stampElement(this._hIbrIbr, -req);
    stampRHS(ctx.rhs, b, veq);
  }

  getLteTimestep(
    dt: number,
    deltaOld: readonly number[],
    order: number,
    method: IntegrationMethod,
    lteParams: LteParams,
  ): number {
    const base = this._stateBase;
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

  getPinCurrents(rhs: Float64Array): number[] {
    const I = rhs[this.branchIndex];
    return [I, -I];
  }

  findBranchFor(_name: string, ctx: SetupContext): number {
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this._branchLabel, "branch");
    }
    return this.branchIndex;
  }
}

// ---------------------------------------------------------------------------
// MutualInductorElement
// ---------------------------------------------------------------------------

/**
 * Mutual inductor (K element) leaf for use inside transformer composites.
 * Reads branch indices from its paired `InductorSubElement` refs directly,
 * stamps the two off-diagonal coupling entries.
 *
 * NOT pool-backed â€” MUT allocates no state slots (mutsetup.c:28
 * `NG_IGNORE(states)`).
 */
export class MutualInductorElement extends AnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.MUT;

  private _coupling: number;
  private readonly _l1: InductorSubElement;
  private readonly _l2: InductorSubElement;
  private _hBr1Br2: number = -1;
  private _hBr2Br1: number = -1;

  /** Package-internal getter â€” exposes the off-diagonal handles allocated
   *  during setup() so a parent composite can stamp them directly. */
  get hBr1Br2(): number { return this._hBr1Br2; }
  get hBr2Br1(): number { return this._hBr2Br1; }

  constructor(
    coupling: number,
    l1: InductorSubElement,
    l2: InductorSubElement,
  ) {
    super(new Map());
    this._coupling = coupling;
    this._l1 = l1;
    this._l2 = l2;
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;

    // mutsetup.c:44-57 â€” resolve inductor refs. Pre-condition: both
    // _l1.setup() and _l2.setup() MUST have run.
    const b1 = this._l1.branchIndex;
    const b2 = this._l2.branchIndex;
    if (b1 === -1 || b2 === -1) {
      throw new Error(
        "MutualInductorElement.setup(): branchIndex not yet allocated on sub-inductor",
      );
    }

    // mutsetup.c:66-67 â€” TSTALLOC sequence, 2 entries.
    this._hBr1Br2 = solver.allocElement(b1, b2);
    this._hBr2Br1 = solver.allocElement(b2, b1);
  }

  load(ctx: LoadContext): void {
    // Port from mutload.c:
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
      pool1.s0[pool1.base + SLOT_PHI] += mutFactor * rhsOld[b2];
      pool2.s0[pool2.base + SLOT_PHI] += mutFactor * rhsOld[b1];
    }

    ctx.solver.stampElement(this._hBr1Br2, -mutFactor * ag[0]!);
    ctx.solver.stampElement(this._hBr2Br1, -mutFactor * ag[0]!);
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return [];
  }

  setParam(key: string, value: number): void {
    if (key === "K" || key === "coupling") {
      this._coupling = value;
    }
  }
}

