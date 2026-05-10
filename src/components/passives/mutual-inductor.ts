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
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
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
import type { TempContext } from "../../solver/analog/temp-context.js";
import type { ComplexSparseSolverStamp } from "../../solver/analog/complex-sparse-solver.js";
import { AnalogInductorElement, type MutSiblingNotifiable } from "./inductor.js";

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
  readonly deviceFamily: DeviceFamily = "IND";
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
 * Mutual inductor (K element) — the canonical MUT.
 *
 * Per Phase 4 of the per-type-orchestration refactor: this element implements
 * the 3-pass IND_FAMILY load contract verbatim from `indload.c:35-127`. The
 * IND_FAMILY load handler (loaders/ind-family-loader.ts) calls this element's
 * `loadCouplingPass(ctx)` between Pass 1 (IND.loadFluxInit) and Pass 3
 * (IND.load NIintegrate + 5-stamp). The MUT's `load(ctx)` itself is intentionally
 * a no-op — all MUT contributions land via `loadCouplingPass` driven by the
 * family handler.
 *
 * NOT pool-backed — MUT allocates no state slots (`mutsetup.c:28` NG_IGNORE(states)).
 * Implements `MutSiblingNotifiable` so partner inductors can notify it of L changes.
 *
 * ngspice anchors:
 *   indload.c:64-76  — coupling pass (flux augmentation + matrix stamps)
 *   muttemp.c:35-41  — MUTfactor = k · sqrt(INDinduct1 * INDinduct2)
 *   mutacld.c:27-30  — AC coupling stamp (-ω·M into imaginary off-diagonals)
 *   mutsetup.c:66-67 — TSTALLOC sequence (2 off-diagonal entries)
 */
export class MutualInductorElement extends AnalogElement implements MutSiblingNotifiable {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.MUT;
  readonly deviceFamily: DeviceFamily = "IND";

  private _coupling: number;
  private _mutFactor: number = 0;
  private readonly _partner1: AnalogInductorElement;
  private readonly _partner2: AnalogInductorElement;
  private _hBr1Br2: number = -1;
  private _hBr2Br1: number = -1;

  get hBr1Br2(): number { return this._hBr1Br2; }
  get hBr2Br1(): number { return this._hBr2Br1; }
  get mutFactor(): number { return this._mutFactor; }

  constructor(
    coupling: number,
    partner1: AnalogInductorElement,
    partner2: AnalogInductorElement,
  ) {
    super(new Map());
    this._coupling = coupling;
    this._partner1 = partner1;
    this._partner2 = partner2;
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;

    // mutsetup.c:44-57 — resolve inductor refs. Pre-condition: both partners' setup()
    // MUST have already run so their branchIndex is allocated.
    const b1 = this._partner1.branchIndex;
    const b2 = this._partner2.branchIndex;
    if (b1 === -1 || b2 === -1) {
      throw new Error(
        "MutualInductorElement.setup(): branchIndex not yet allocated on partner inductor",
      );
    }

    // mutsetup.c:66-67 — TSTALLOC sequence, 2 off-diagonal entries.
    this._hBr1Br2 = solver.allocElement(b1, b2);
    this._hBr2Br1 = solver.allocElement(b2, b1);

    // Register as mutual-inductor sibling so each partner can notify on inductance
    // changes via setParam("inductance", ...) → recomputeMutFactor() cascade.
    this._partner1._mutSiblings.push(this);
    this._partner2._mutSiblings.push(this);

    // Seed _mutFactor from current partner inductances. IND_FAMILY temperature
    // handler will subsequently call computeTemperature() to refresh it from
    // temperature-corrected effective inductances.
    this._mutFactor = this._coupling * Math.sqrt(
      this._partner1.inductance * this._partner2.inductance,
    );
  }

  /**
   * IND_FAMILY Pass 2 — MUT coupling per `indload.c:64-76`.
   *
   *   if (!(ckt->CKTmode & (MODEDC | MODEINITPRED))) {
   *     CKTstate0[l1.INDflux] += MUTfactor * CKTrhsOld[l2.INDbrEq];   // line 67
   *     CKTstate0[l2.INDflux] += MUTfactor * CKTrhsOld[l1.INDbrEq];   // line 68
   *   }
   *   *(MUTbr1br2) -= MUTfactor * CKTag[0];                            // line 74 (unconditional)
   *   *(MUTbr2br1) -= MUTfactor * CKTag[0];                            // line 75 (unconditional)
   *
   * Pass 1 (each IND.loadFluxInit) has already initialized partner flux φ = L·i.
   * This pass augments partner flux with the mutual contribution, then stamps
   * the two off-diagonal matrix entries. Pass 3 (each IND.load NIintegrate)
   * then reads the augmented flux to produce the correct branch current.
   */
  loadCouplingPass(ctx: LoadContext): void {
    const { ag, rhsOld, cktMode: mode } = ctx;

    // indload.c:64-71 — gated flux augmentation (transient mode only).
    if (!(mode & (MODEDC | MODEINITPRED))) {
      const i_p1 = rhsOld[this._partner1.branchIndex];
      const i_p2 = rhsOld[this._partner2.branchIndex];
      this._partner1.augmentFlux(this._mutFactor * i_p2);
      this._partner2.augmentFlux(this._mutFactor * i_p1);
    }

    // indload.c:74-75 — unconditional off-diagonal matrix stamps.
    const ag0 = ag[0] ?? 0;
    ctx.solver.stampElement(this._hBr1Br2, -this._mutFactor * ag0);
    ctx.solver.stampElement(this._hBr2Br1, -this._mutFactor * ag0);
  }

  /**
   * IND_FAMILY load Pass 3 routes through `AnalogInductorElement.load()`.
   * MUT contributions are entirely handled by `loadCouplingPass()` driven by
   * the IND_FAMILY load handler. This `load(ctx)` is a no-op so MUT instances
   * do not double-stamp if the family handler erroneously dispatches them as
   * regular elements.
   */
  load(_ctx: LoadContext): void {
    // intentional no-op — see class JSDoc and loadCouplingPass()
  }

  /**
   * IND_FAMILY temperature Pass 2 per `muttemp.c:35-41`.
   *
   *   factor = sqrt(here->MUTind1->INDinduct * here->MUTind2->INDinduct);  // line 38
   *   here->MUTfactor = here->MUTcouple * factor;                          // line 41
   *
   * Pass 1 (each IND.computeTemperature) has already set effective INDinduct on
   * both partners. This pass reads those temperature-corrected inductances and
   * recomputes MUTfactor.
   */
  computeTemperature(_ctx: TempContext): void {
    this._mutFactor = this._coupling * Math.sqrt(
      this._partner1.inductance * this._partner2.inductance,
    );
  }

  /**
   * MutSiblingNotifiable contract — callable from partner inductor's
   * setParam("inductance", v) cascade. Identical formula to computeTemperature
   * but invoked at hot-load time rather than via the temperature pass.
   * cite: muttemp.c:38
   */
  recomputeMutFactor(): void {
    this._mutFactor = this._coupling * Math.sqrt(
      this._partner1.inductance * this._partner2.inductance,
    );
  }

  /**
   * IND_FAMILY AC stamp Pass 2 per `mutacld.c:27-30`.
   *
   *   *(here->MUTbr1br2 + 1) -= here->MUTfactor * omega;  // line 28 (imag at br1×br2)
   *   *(here->MUTbr2br1 + 1) -= here->MUTfactor * omega;  // line 29 (imag at br2×br1)
   *
   * Pure imaginary coupling: stamp -ω·M into the IMAGINARY half of the two
   * off-diagonal entries. Real part is zero (no resistive coupling at AC).
   */
  stampAcCoupling(solver: ComplexSparseSolverStamp, omega: number, _ctx: LoadContext): void {
    const wM = omega * this._mutFactor;
    solver.stampComplex(this._hBr1Br2, 0, -wM);
    solver.stampComplex(this._hBr2Br1, 0, -wM);
  }

  setParam(key: string, value: number): void {
    if (key === "K" || key === "k" || key === "coupling") {
      this._coupling = value;
      this.recomputeMutFactor();
    }
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return [];
  }
}

