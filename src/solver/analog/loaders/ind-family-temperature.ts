/**
 * IND_FAMILY temperature handler.
 *
 * Three passes — ORDER MATTERS:
 *
 *   Pass 1 (indtemp.c:69-72):  IND.computeTemperature(ctx)
 *     Sets effective INDinduct = nominalInduct * (1 + tc1*ΔT + tc2*ΔT²) * scale
 *     (the /M divisor is applied at the stamp sites, not here).
 *     ngspice: factor = 1.0 + tc1*difference + tc2*difference*difference;
 *              INDinduct = INDinduct * factor * INDscale;
 *
 *   Pass 2 (muttemp.c:56):  MUT.computeTemperature(ctx)
 *     Reads partner inductors' temp-corrected inductances, sets
 *     MUTfactor = MUTcoupling * sqrt(fabs(ind1 * ind2))
 *     ngspice: ind1 = here->MUTind1->INDinduct;
 *              ind2 = here->MUTind2->INDinduct;
 *              here->MUTfactor = here->MUTcoupling * sqrt(fabs(ind1 * ind2));
 *
 *   Pass 3 (muttemp.c:58-205):  verifyInductiveSystems(...)
 *     Gated on tempCtx._indVerbosity > 0 (ckt->CKTindverbosity > 0). Partitions
 *     the coupled inductor/mutual graph into connected "inductive systems",
 *     assembles each system's inductance matrix, runs an in-place Cholesky
 *     positive-definiteness test, and emits diagnostics for non-positive-
 *     definite / duplicate-K / incomplete-K systems.
 *
 * Pass 1 MUST complete before Pass 2 (MUT reads each partner's temperature-
 * corrected inductance), and Pass 2 MUST complete before Pass 3 (the verify
 * matrix off-diagonals read each MUT's freshly recomputed MUTfactor).
 *
 * cite: ckttemp.c:28-33 — DEVices[i]->DEVtemperature(ckt) loop structure.
 * cite: muttemp.c:35-218 — MUTtemp driver, system-merge bookkeeping, verify pass.
 */

import type { FamilyHandler } from "../family-registry.js";
import type { TempContext } from "../temp-context.js";
import type { AnalogElement } from "../element.js";
import type { DiagnosticCollector } from "../diagnostics.js";
import { makeDiagnostic } from "../diagnostics.js";
import { AnalogInductorElement } from "../../../components/passives/inductor.js";
import {
  MutualInductorElement,
  cholesky,
  type IndSystem,
} from "../../../components/passives/mutual-inductor.js";

export const IndFamilyTempHandler: FamilyHandler = {
  run(ctx: unknown, instances: readonly AnalogElement[]): void {
    const tempCtx = ctx as TempContext;

    // Pass 1 (indtemp.c:69-72): IND.computeTemperature — updates effective inductance
    // factor = 1.0 + tc1*difference + tc2*difference*difference;
    // INDinduct = INDinduct * factor * INDscale;
    for (const el of instances) {
      if (el instanceof AnalogInductorElement) {
        el.computeTemperature?.(tempCtx);
      }
    }

    // Pass 2 (muttemp.c:56): MUT.computeTemperature — reads partner inductances
    // MUTfactor = MUTcoupling * sqrt(fabs(ind1 * ind2))
    // Depends on Pass 1 having updated INDinduct for all partner IND instances.
    for (const el of instances) {
      if (el instanceof MutualInductorElement) {
        el.computeTemperature?.(tempCtx);
      }
    }

    // Pass 3 (muttemp.c:58-205): inductive-system Cholesky verify. Gated on
    // ckt->CKTindverbosity > 0. Runs after Pass 2 so every MUTfactor is current.
    // The diagnostics collector is always present on the engine-supplied
    // TempContext (lazy `tempCtx` accessor); device-local ad-hoc contexts omit
    // it and never carry inductors here, so the guard is a defensive no-op.
    // cite: muttemp.c:58 — if (ckt->CKTindverbosity > 0)
    if (tempCtx._indVerbosity > 0 && tempCtx.diagnostics) {
      const inds: AnalogInductorElement[] = [];
      const muts: MutualInductorElement[] = [];
      for (const el of instances) {
        if (el instanceof AnalogInductorElement) inds.push(el);
        else if (el instanceof MutualInductorElement) muts.push(el);
      }
      verifyInductiveSystems(tempCtx, inds, muts, tempCtx.diagnostics);
    }
  },
};

// ---------------------------------------------------------------------------
// verifyInductiveSystems — MUTtemp inductive-system verify pass.
// cite: muttemp.c:35-205 — system-merge bookkeeping + per-system Cholesky check.
//
// Ports the MUTtemp driver above the level of identifier rename and C↔TS
// syntax: the 5-way if/else-if/.../else system-merge chain (muttemp.c:62-117),
// the per-system matrix assembly (muttemp.c:140-164), the cholesky() call
// (muttemp.c:166), the |K|=1 ∧ L≥0 waiver (muttemp.c:168-181), and the gated
// diagnostic emit (muttemp.c:183-203). The C `tfree` teardown
// (muttemp.c:207-214) has no TS counterpart — GC reclaims the pass-local
// IndSystem nodes once the function returns.
// ---------------------------------------------------------------------------

// Exported for the Surface-1 headless verify-pass tests (criteria 10-13), which
// drive the driver directly with real compiled IND/MUT elements to control K
// precisely (the Transformer property clamps couplingCoefficient to [0, 1]).
// Production callers reach it only through IndFamilyTempHandler Pass 3.
export function verifyInductiveSystems(
  tempCtx: TempContext,
  inds: readonly AnalogInductorElement[],
  muts: readonly MutualInductorElement[],
  diagnostics: DiagnosticCollector,
): void {
  // cite: indsetup.c:103-104 — here->system = NULL; here->system_next_ind = NULL.
  // ngspice INDsetup runs this init once, then MUTtemp builds the systems and
  // tfree's them at the end (muttemp.c:207-214) WITHOUT re-nulling here->system.
  // digiTS re-runs the verify pass on every setCircuitTemp() (Decision (ii)) but
  // never re-runs setup(), so the prior pass's IndSystem references would still
  // be attached. Reset the per-instance bookkeeping here to reproduce the clean
  // INDsetup state that v41's single-MUTtemp flow assumes at each pass entry.
  for (const ind of inds) {
    ind._systemPtr = null;
    ind._systemNextIndPtr = null;
    ind._systemIdxPtr = -1;
  }
  for (const mut of muts) {
    mut._systemNextMutPtr = null;
  }

  // cite: muttemp.c:41 — struct INDsystem *first_system = NULL;
  let firstSystem: IndSystem | null = null;

  // cite: muttemp.c:45-118 — for each MUT in walk order, perform the system-
  // merge bookkeeping (the MUTfactor recompute itself, muttemp.c:56, already
  // happened in Pass 2). The CKTindverbosity > 0 gate (muttemp.c:58) is hoisted
  // to the Pass-3 call site, so every MUT here is already inside the gate.
  for (const here of muts) {
    const ind1 = here._ind1;
    const ind2 = here._ind2;

    if (!ind1._systemPtr && !ind2._systemPtr) {
      // cite: muttemp.c:62-73 — fresh system; both IND are first members.
      const system: IndSystem = {
        size: 2,
        firstInd: ind1,
        firstMut: here,
        nextSystem: firstSystem,
      };
      firstSystem = system;
      ind1._systemNextIndPtr = ind2;
      ind2._systemNextIndPtr = null;
      ind1._systemPtr = system;
      ind2._systemPtr = system;
      here._systemNextMutPtr = null;
    } else if (ind1._systemPtr && !ind2._systemPtr) {
      // cite: muttemp.c:74-81 — ind1 has a system, ind2 joins.
      const system = ind1._systemPtr;
      system.size++;
      ind2._systemNextIndPtr = system.firstInd;
      system.firstInd = ind2;
      here._systemNextMutPtr = system.firstMut;
      system.firstMut = here;
      ind2._systemPtr = system;
    } else if (!ind1._systemPtr && ind2._systemPtr) {
      // cite: muttemp.c:82-89 — ind2 has a system, ind1 joins. Mirror of above.
      const system = ind2._systemPtr;
      system.size++;
      ind1._systemNextIndPtr = system.firstInd;
      system.firstInd = ind1;
      here._systemNextMutPtr = system.firstMut;
      system.firstMut = here;
      ind1._systemPtr = system;
    } else if (ind1._systemPtr === ind2._systemPtr) {
      // cite: muttemp.c:90-93 — both ends already in the same system; only
      // thread `here` into the system's MUT chain.
      const system = ind2._systemPtr!;
      here._systemNextMutPtr = system.firstMut;
      system.firstMut = here;
    } else {
      // cite: muttemp.c:94-117 — merge two distinct systems s1 (ind1's) and
      // s2 (ind2's). s2 is appended to s1 and left consumed (size=0).
      const s1 = ind1._systemPtr!;
      const s2 = ind2._systemPtr!;
      // cite: muttemp.c:100-101 — s1->size += s2->size; s2->size = 0;
      s1.size += s2.size;
      s2.size = 0;
      // cite: muttemp.c:102-106 — walk s2's IND chain to its tail, re-pointing
      // every member's system at s1; `ind` ends at the tail of s2's IND chain.
      let ind: AnalogInductorElement | null = s2.firstInd;
      for (; ind; ind = ind._systemNextIndPtr) {
        ind._systemPtr = s1;
        if (!ind._systemNextIndPtr) break;
      }
      // cite: muttemp.c:107-109 — splice s2's IND chain at the head of s1's.
      ind!._systemNextIndPtr = s1.firstInd;
      s1.firstInd = s2.firstInd;
      s2.firstInd = null;
      // cite: muttemp.c:110-112 — walk s2's MUT chain to its tail.
      let mut: MutualInductorElement | null = s2.firstMut;
      for (; mut; mut = mut._systemNextMutPtr) {
        if (!mut._systemNextMutPtr) break;
      }
      // cite: muttemp.c:113-116 — splice s2's MUT chain into s1, then prepend
      // `here` at the head of the merged MUT chain.
      mut!._systemNextMutPtr = s1.firstMut;
      here._systemNextMutPtr = s2.firstMut;
      s1.firstMut = here;
      s2.firstMut = null;
    }
  }

  // cite: muttemp.c:121 — if (first_system) — the entire verify pass is
  // conditional on at least one MUT having contributed a system.
  if (firstSystem) {
    // cite: muttemp.c:123-127 — find the max system size for scratch sizing.
    let sz = 0;
    for (let system: IndSystem | null = firstSystem; system; system = system.nextSystem) {
      if (sz < system.size) sz = system.size;
    }

    // cite: muttemp.c:129-130 — char *pop = TMALLOC(char, sz*sz);
    //   double *INDmatrix = TMALLOC(double, sz*sz);
    const pop = new Uint8Array(sz * sz);
    const INDmatrix = new Float64Array(sz * sz);

    // cite: muttemp.c:132 — for each system, run the verify.
    for (let system: IndSystem | null = firstSystem; system; system = system.nextSystem) {
      // cite: muttemp.c:133-134 — if (!system->size) continue;
      if (!system.size) continue;

      let positive: boolean;
      let i: number;

      // cite: muttemp.c:138 — sz = system->size;
      sz = system.size;

      // cite: muttemp.c:140-141 — memset(pop, 0, sz*sz);
      //   memset(INDmatrix, 0, sz*sz*sizeof(double));
      pop.fill(0, 0, sz * sz);
      INDmatrix.fill(0, 0, sz * sz);

      // cite: muttemp.c:143-147 — write the diagonal from each IND's INDinduct
      // and assign system_idx.
      let ind: AnalogInductorElement | null = system.firstInd;
      for (i = 0; ind; ind = ind._systemNextIndPtr) {
        INDmatrix[i * sz + i] = ind._effectiveLForVerify;
        ind._systemIdxPtr = i++;
      }

      // cite: muttemp.c:149-164 — walk the MUT chain, write symmetric
      // off-diagonals, count duplicates (repetitions) and missing cells (expect).
      let mut: MutualInductorElement | null = system.firstMut;
      let expect = (sz * sz - sz) / 2;
      let repetitions = 0;
      for (; mut; mut = mut._systemNextMutPtr) {
        let j = mut._ind1._systemIdxPtr;
        let k = mut._ind2._systemIdxPtr;
        // cite: muttemp.c:155-156 — if (j < k) SWAP(int, j, k);
        if (j < k) {
          const tmp = j;
          j = k;
          k = tmp;
        }
        // cite: muttemp.c:157-162 — pop tracks already-seen off-diagonal cells.
        if (pop[j * sz + k]) {
          repetitions++;
        } else {
          pop[j * sz + k] = 1;
          expect--;
        }
        // cite: muttemp.c:163 — INDmatrix[j*sz+k] = INDmatrix[k*sz+j] = MUTfactor.
        INDmatrix[j * sz + k] = INDmatrix[k * sz + j] = mut._mutFactorValue;
      }

      // cite: muttemp.c:166 — positive = cholesky(INDmatrix, sz);
      positive = cholesky(INDmatrix, sz);

      // cite: muttemp.c:168-181 — |K|=1 ∧ L≥0 waiver: a non-positive-definite
      // verdict is ignored when every coupling is perfect (|K| == 1) and every
      // inductance is non-negative.
      if (!positive) {
        positive = true;
        // cite: muttemp.c:171-175 — for each MUT: if |K| != 1, positive = 0; break.
        for (mut = system.firstMut; mut; mut = mut._systemNextMutPtr) {
          if (Math.abs(mut._couplingValue) !== 1.0) {
            positive = false;
            break;
          }
        }
        // cite: muttemp.c:176-180 — for each IND: if L < 0, positive = 0; break.
        for (ind = system.firstInd; ind; ind = ind._systemNextIndPtr) {
          if (ind._effectiveLForVerify < 0) {
            positive = false;
            break;
          }
        }
      }

      // cite: muttemp.c:183 — if (!positive || repetitions ||
      //   (expect && ckt->CKTindverbosity > 1))
      if (!positive || repetitions || (expect && tempCtx._indVerbosity > 1)) {
        emitVerifyDiagnostics(diagnostics, system, positive, repetitions, expect, tempCtx._indVerbosity);
      }
    }
    // No TS counterpart for muttemp.c:207-214 (tfree pop / INDmatrix / system
    // list): GC reclaims the pass-local buffers and IndSystem nodes on return.
  }
}

// ---------------------------------------------------------------------------
// emitVerifyDiagnostics — route the MUTtemp verify findings through the
// DiagnosticCollector.
// cite: muttemp.c:184-203 — the multi-line stderr warning block. v41 prints one
// multi-line message per non-passing system; digiTS emits one Diagnostic per
// condition (not-positive-definite / duplicate-K / incomplete-K), each carrying
// the system's element IDs in v41 traversal order (IND chain then MUT chain).
// ---------------------------------------------------------------------------

function emitVerifyDiagnostics(
  diagnostics: DiagnosticCollector,
  system: IndSystem,
  positive: boolean,
  repetitions: number,
  expect: number,
  indVerbosity: number,
): void {
  // cite: muttemp.c:184-190 — "The Inductive System consisting of\n <ind names>\n
  //   <mut names>\n". Collect the system's IND and MUT names in chain order, and
  //   the element IDs in the same order for involvedElements.
  const indNames: string[] = [];
  const mutNames: string[] = [];
  const involvedElements: number[] = [];

  for (let ind: AnalogInductorElement | null = system.firstInd; ind; ind = ind._systemNextIndPtr) {
    indNames.push(ind.label);
    if (ind.elementIndex !== undefined) involvedElements.push(ind.elementIndex);
  }
  for (let mut: MutualInductorElement | null = system.firstMut; mut; mut = mut._systemNextMutPtr) {
    mutNames.push(mut.label);
    if (mut.elementIndex !== undefined) involvedElements.push(mut.elementIndex);
  }

  const indList = indNames.join(" ");
  const mutList = mutNames.join(" ");

  // cite: muttemp.c:191-198 — "is not positive definite", plus one "|<mut>| > 1"
  // line per MUT with |K| > 1 and one "<ind> < 0" line per IND with L < 0.
  if (!positive) {
    const explanationLines: string[] = [];
    for (let mut: MutualInductorElement | null = system.firstMut; mut; mut = mut._systemNextMutPtr) {
      if (Math.abs(mut._couplingValue) > 1.0) {
        explanationLines.push(`|${mut.label}| > 1`);
      }
    }
    for (let ind: AnalogInductorElement | null = system.firstInd; ind; ind = ind._systemNextIndPtr) {
      if (ind._effectiveLForVerify < 0) {
        explanationLines.push(`${ind.label} < 0`);
      }
    }
    diagnostics.emit(
      makeDiagnostic(
        "inductive-system-not-positive-definite",
        "warning",
        `The inductive system consisting of ${indList} with mutual couplings ${mutList} is not positive definite`,
        {
          explanation: explanationLines.join("\n"),
          involvedElements,
        },
      ),
    );
  }

  // cite: muttemp.c:199-200 — if (repetitions) "has duplicate K instances".
  if (repetitions) {
    diagnostics.emit(
      makeDiagnostic(
        "inductive-system-duplicate-k",
        "warning",
        `The inductive system consisting of ${indList} has duplicate K instances`,
        { involvedElements },
      ),
    );
  }

  // cite: muttemp.c:201-202 — if (expect && CKTindverbosity > 1)
  //   "has an incomplete set of K couplings, (missing ones are implicitly 0)".
  if (expect && indVerbosity > 1) {
    diagnostics.emit(
      makeDiagnostic(
        "inductive-system-incomplete-k",
        "info",
        `The inductive system consisting of ${indList} has an incomplete set of K couplings, (missing ones are implicitly 0)`,
        { involvedElements },
      ),
    );
  }
}
