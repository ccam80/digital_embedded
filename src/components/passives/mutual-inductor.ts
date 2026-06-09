/**
 * MutualInductorElement and MutualInductorDefinition — ngspice K element.
 *
 * Internal-only sub-element used by Transformer / TappedTransformer composites.
 * Resolves its two partner inductors by resolved-label string at setup() time
 * via ctx.findDevice (ngspice CKTfndDev pattern), reads their branch indices,
 * and stamps the two mutual-inductance off-diagonals.
 *
 * Sibling references arrive as `{ kind: "ref", name }` netlist params —
 * the compiler resolves L1_branch / L2_branch to "{parentLabel}:{name}"
 * strings and writes them into the property partition. Same path
 * CurrentControlledSwitch's ctrlBranch and InternalCccs's sense use.
 *
 * ngspice anchors:
 *   mutsetup.c:30-70  — MUT branch resolution + TSTALLOC sequence
 *   indload.c:64-76   — MUT coupling pass (flux augmentation + matrix stamps)
 *   muttemp.c:35-41   — MUTfactor = k · sqrt(INDinduct1 · INDinduct2)
 *   mutacld.c:27-30   — AC coupling stamp
 */

import { AnalogElement } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { TempContext } from "../../solver/analog/temp-context.js";
import type { SparseSolverStamp } from "../../solver/analog/sparse-solver.js";
import { MODEDC, MODEINITPRED, MODEUIC, MODEINITTRAN } from "../../solver/analog/ckt-mode.js";
import { AnalogInductorElement, type MutSiblingNotifiable } from "./inductor.js";
import { PropertyBag } from "../../core/properties.js";
import type { ComponentDefinition } from "../../core/registry.js";

// ---------------------------------------------------------------------------
// IndSystem — file-scope linked-list node for inductive systems.
// cite: inddefs.h:169-174 — struct INDsystem { int size; INDinstance *first_ind;
//   MUTinstance *first_mut; struct INDsystem *next_system; }.
//   `size`       — number of IND members in this system;
//   `firstInd`   — head of the per-system IND chain (chained via _systemNextInd);
//   `firstMut`   — head of the per-system MUT chain (chained via _systemNextMut);
//   `nextSystem` — next system in the driver's pass-local linked list, or null.
//
// Re-exported (type-only) so AnalogInductorElement.system can reference it
// without a runtime import cycle; the inductor module imports it via
// `import type`, which erases at compile time.
// ---------------------------------------------------------------------------

export interface IndSystem {
  size: number;
  firstInd: AnalogInductorElement | null;
  firstMut: MutualInductorElement | null;
  nextSystem: IndSystem | null;
}

// ---------------------------------------------------------------------------
// cholesky — in-place Cholesky positive-definiteness test.
// cite: muttemp.c:13-32 — static int cholesky(double *a, int n).
//
// In-place Cholesky factorisation of a symmetric n×n matrix stored row-major in
// `a` (length n*n), writing the lower-triangular factor over the lower triangle.
// Returns true iff the matrix is positive-definite; returns false on the first
// non-positive diagonal pivot (the `else return 0` of the inner loop). Storage
// layout `a[n*r + c]` (the `#define A(r,c) a[n*r + c]` macro), loop bounds, and
// early-exit shape are line-for-line v41. No allocation; the only side effect is
// the in-place writes to `a`.
// ---------------------------------------------------------------------------

export function cholesky(a: Float64Array, n: number): boolean {
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let Summe = a[n * i + j]!;
      for (let k = 0; k < j; k++) {
        Summe -= a[n * i + k]! * a[n * j + k]!;
      }
      if (i > j) {
        a[n * i + j] = Summe / a[n * j + j]!;
      } else if (Summe > 0) {
        a[n * i + i] = Math.sqrt(Summe);
      } else {
        return false;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// MutualInductorElement
// ---------------------------------------------------------------------------

export class MutualInductorElement extends AnalogElement implements MutSiblingNotifiable {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.MUT;
  readonly deviceFamily: DeviceFamily = "IND";

  private _coupling: number;
  private _mutFactor: number = 0;
  /** Resolved global labels of the two partner inductors, compiler-stamped. */
  private readonly _l1Label: string;
  private readonly _l2Label: string;
  // Live partner refs are resolved at setup() time via ctx.findDevice.
  private _partner1!: AnalogInductorElement;
  private _partner2!: AnalogInductorElement;
  private _hBr1Br2: number = -1;
  private _hBr2Br1: number = -1;
  // AC matrix-cell handles, lazily allocated on the first stampAcCoupling()
  // against the AC analysis's solver instance. These are SEPARATE from the
  // DC `_hBr1Br2`/`_hBr2Br1` (which index the DC solver's pool): the AC sweep
  // factors a different solver, so its cells must be allocated there.
  private _hAcBr1Br2: number = -1;
  private _hAcBr2Br1: number = -1;

  // cite: inddefs.h:151 — MUTinstance *system_next_mut. Next MUT in the same
  // inductive system, threaded by the MUTtemp verify-pass chain-insertion
  // branches (muttemp.c:72-114). Written only by the verify driver; setup()
  // does not initialise it (MUTsetup has no such init either — Part C).
  private _systemNextMut: MutualInductorElement | null = null;

  get hBr1Br2(): number { return this._hBr1Br2; }
  get hBr2Br1(): number { return this._hBr2Br1; }
  get mutFactor(): number { return this._mutFactor; }

  // -------------------------------------------------------------------------
  // Package-private accessors consumed by verifyInductiveSystems
  // (ind-family-temperature.ts). The MUTtemp verify pass walks MUT chains,
  // reads partner inductors, the user coupling K, and the scaled MUTfactor.
  // -------------------------------------------------------------------------

  /** ngspice MUTinstance.system_next_mut — next MUT in the same system. */
  get _systemNextMutPtr(): MutualInductorElement | null { return this._systemNextMut; }
  set _systemNextMutPtr(n: MutualInductorElement | null) { this._systemNextMut = n; }

  /** ngspice MUTinstance.MUTind1 — coupled inductor 1 (inddefs.h:142). */
  get _ind1(): AnalogInductorElement { return this._partner1; }
  /** ngspice MUTinstance.MUTind2 — coupled inductor 2 (inddefs.h:143). */
  get _ind2(): AnalogInductorElement { return this._partner2; }

  /**
   * Bind partner inductors + recompute MUTfactor outside the normal setup()
   * path. The production wiring runs in setup() (CKTfndDev resolution); this
   * package-private binder lets the Surface-1 verify-pass tests assemble
   * multi-MUT / multi-IND inductive systems from real compiled inductors
   * without hand-building a SetupContext (forbidden by the test-tools contract).
   */
  _bindPartnersForVerify(p1: AnalogInductorElement, p2: AnalogInductorElement): void {
    this._partner1 = p1;
    this._partner2 = p2;
    this.recomputeMutFactor();
  }
  /** ngspice MUTinstance.MUTcoupling — user coupling K (inddefs.h:138). */
  get _couplingValue(): number { return this._coupling; }
  /** ngspice MUTinstance.MUTfactor — scaled mutual inductance (inddefs.h:139). */
  get _mutFactorValue(): number { return this._mutFactor; }

  constructor(_pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(new Map());
    this._coupling = props.getModelParam<number>("K");
    this._l1Label = props.has("L1_branch") ? props.get<string>("L1_branch") : "";
    this._l2Label = props.has("L2_branch") ? props.get<string>("L2_branch") : "";
    if (!this._l1Label || !this._l2Label) {
      throw new Error(
        "MutualInductorElement: requires L1_branch and L2_branch as " +
        "`{ kind: \"ref\", name }` params (resolved partner inductor labels).",
      );
    }
  }

  setup(ctx: SetupContext): void {
    // mutsetup.c:44-57 — resolve named inductors via CKTfndDev. Both partners'
    // setup() must have already run so their branchIndex is allocated; IND=27
    // < MUT=28 in static_devices[] guarantees this ordering.
    const l1 = ctx.findDevice(this._l1Label);
    const l2 = ctx.findDevice(this._l2Label);
    // mutsetup.c:43-49 — !MUTind1 → ERR_FATAL "coupling to non-existent inductor",
    // then return(E_NOTFOUND) so the missing partner never reaches TSTALLOC. The
    // ERR_FATAL + early-return maps to a thrown Error (the digiTS fatal stop); the
    // message text is the v41 wording.
    if (!(l1 instanceof AnalogInductorElement)) {
      throw new Error(
        `${this.label}: coupling to non-existent inductor ${this._l1Label}.`,
      );
    }
    // mutsetup.c:50-56 — !MUTind2 → ERR_FATAL "coupling to non-existent inductor",
    // then return(E_NOTFOUND).
    if (!(l2 instanceof AnalogInductorElement)) {
      throw new Error(
        `${this.label}: coupling to non-existent inductor ${this._l2Label}.`,
      );
    }
    this._partner1 = l1;
    this._partner2 = l2;

    const b1 = this._partner1.branchIndex;
    const b2 = this._partner2.branchIndex;
    if (b1 === -1 || b2 === -1) {
      throw new Error(
        "MutualInductorElement.setup(): branchIndex not yet allocated on partner inductor " +
        `(${this._l1Label}.branchIndex=${b1}, ${this._l2Label}.branchIndex=${b2}). ` +
        "IND must run setup() before MUT — check ngspiceLoadOrder.",
      );
    }

    // mutsetup.c:66-67 — TSTALLOC sequence, 2 off-diagonal entries.
    this._hBr1Br2 = ctx.solver.allocElement(b1, b2);
    this._hBr2Br1 = ctx.solver.allocElement(b2, b1);

    this._partner1._mutSiblings.push(this);
    this._partner2._mutSiblings.push(this);

    // cite: muttemp.c:56 — MUTfactor = MUTcoupling * sqrt(fabs(ind1 * ind2)).
    this._mutFactor = this._coupling * Math.sqrt(
      Math.abs(this._partner1.inductance * this._partner2.inductance),
    );
  }

  /**
   * IND_FAMILY Pass 2 — MUT coupling per `indload.c:64-76`.
   */
  loadCouplingPass(ctx: LoadContext): void {
    const { ag, rhsOld, cktMode: mode } = ctx;

    if (!(mode & (MODEDC | MODEINITPRED))) {
      // indload.c:62-69 — set initial conditions for the mutual inductance here,
      // if uic is set: each partner's flux is seeded from the OTHER partner's
      // INDinitCond rather than from the previous RHS branch current.
      if ((mode & MODEUIC) && (mode & MODEINITTRAN)) {
        this._partner1.augmentFlux(this._mutFactor * this._partner2.ic);
        this._partner2.augmentFlux(this._mutFactor * this._partner1.ic);
      } else {
        // indload.c:70-77 — companion path: augment from the partner branch
        // current in CKTrhsOld.
        const i_p1 = rhsOld[this._partner1.branchIndex];
        const i_p2 = rhsOld[this._partner2.branchIndex];
        this._partner1.augmentFlux(this._mutFactor * i_p2);
        this._partner2.augmentFlux(this._mutFactor * i_p1);
      }
    }

    const ag0 = ag[0] ?? 0;
    ctx.solver.stampElement(this._hBr1Br2, -this._mutFactor * ag0);
    ctx.solver.stampElement(this._hBr2Br1, -this._mutFactor * ag0);
  }

  load(_ctx: LoadContext): void {
    // intentional no-op — MUT contributions flow through loadCouplingPass()
    // driven by the IND_FAMILY load handler.
  }

  computeTemperature(_ctx: TempContext): void {
    // cite: muttemp.c:50-56 — ind1 = MUTind1->INDinduct; ind2 = MUTind2->INDinduct;
    //   MUTfactor = MUTcoupling * sqrt(fabs(ind1 * ind2)).
    this._mutFactor = this._coupling * Math.sqrt(
      Math.abs(this._partner1.inductance * this._partner2.inductance),
    );
  }

  recomputeMutFactor(): void {
    // cite: muttemp.c:56 — MUTfactor = MUTcoupling * sqrt(fabs(ind1 * ind2)).
    this._mutFactor = this._coupling * Math.sqrt(
      Math.abs(this._partner1.inductance * this._partner2.inductance),
    );
  }

  stampAcCoupling(solver: SparseSolverStamp, omega: number, _ctx: LoadContext): void {
    // Lazily allocate the two off-diagonal coupling cells against the AC
    // solver on first stamp. mutsetup.c:66-67 order (br1br2, br2br1). The
    // partner branch indices are the same MNA branch rows the inductors use.
    if (this._hAcBr1Br2 === -1) {
      const b1 = this._partner1.branchIndex;
      const b2 = this._partner2.branchIndex;
      this._hAcBr1Br2 = solver.allocElement(b1, b2);
      this._hAcBr2Br1 = solver.allocElement(b2, b1);
    }
    // cite: mutacld.c:27-30 — `*(MUTbr1br2+1) -= ω·MUTfactor`: imaginary only.
    const wM = omega * this._mutFactor;
    solver.stampElementImag(this._hAcBr1Br2, -wM);
    solver.stampElementImag(this._hAcBr2Br1, -wM);
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

// ---------------------------------------------------------------------------
// MutualInductorDefinition (internal-only)
// ---------------------------------------------------------------------------

export const MutualInductorDefinition: ComponentDefinition = {
  name: "MutualInductor",
  typeId: -1,
  internalOnly: true,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "K", default: 1 },
      ],
      params: { K: 1 },
      factory: (
        pinNodes: ReadonlyMap<string, number>,
        props: PropertyBag,
        _getTime: () => number,
      ): AnalogElement => new MutualInductorElement(pinNodes, props),
      spice: { device: "MUT", deckNodeTokens: [] },
    },
  },
  defaultModel: "default",
};
