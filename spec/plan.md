# digiTS analog solver — ngspice Alignment Implementation Plan

> **TESTS-RED PROTOCOL.** Baseline is far from green. Full-suite test passage is **NOT** a phase gate. Implementers run **targeted** vitest commands scoped to their modified files only (e.g. `npx vitest run src/solver/analog/__tests__/sparse-solver.test.ts`). The full suite runs once at the very end of the job. Regression of unrelated tests is expected during early phases; do not chase them.

## Governing Principles (non-negotiable)

1. **Match ngspice, or the job has failed.** The specs listed below are the source of truth. Every diff in them is a literal ngspice-parity specification. Implementers apply those diffs **VERBATIM**.
2. **No substitutions.** No "pragmatic," "minimal," "smallest viable," "simpler version," or "cleaner rewrite" of any diff. If a spec says X, the implementer writes X.
3. **No silent scope narrowing.** If an implementer cannot apply a diff (surrounding code has drifted, assumption violated, etc.), they **STOP** and report. They do not improvise. They do not skip.
4. **Banned concepts** (inherited from `CLAUDE.md`): deferral, scope reduction, pragmatic shortcuts, test-chasing fixes, silent scope narrowing. If a test fails because the architecture is wrong, fix the architecture — not the test.
5. **Regression policy.** If approved work lands and tests regress: **do not revert**. Report the new failures with full output. Reverting destroys diagnosis.
6. **Permitted ngspice deviations** (only these): convergence logging, diagnostics emission, blame tracking. Nothing else.
7. **Zero allocations in hot paths.** No `new`, no object literals, no closures, no allocating array methods inside NR iterations, per-step code, or per-device load code.

## Source-of-Truth Spec Files

| Phase | Spec File | Scope |
|---|---|---|
| 1 | `spec/ngspice-alignment-F1-sparse-solver.md` | spfactor/spbuild/spsmp alignment |
| 2 | `spec/ngspice-alignment-F3-dcop-transient.md` | `ctx.cktMode` bitfield + dcopFinalize + `_seedFromDcop` |
| 2 | `spec/ngspice-alignment-F4-cktload-devices.md` | LoadContext bitfield + MODEINITSMSIG device paths |
| 3 | `spec/ngspice-alignment-F2-nr-reorder-predictor.md` | `NISHOULDREORDER` gate + per-device initPred xfact |
| 4 | `spec/ngspice-alignment-F5-limiting.md` | `pnjlim`/`fetlim` rewrite + limitingCollector wiring |
| 5 | `spec/ngspice-alignment-F-bjt.md` | BJT L0 + L1 full alignment |
| 6 | `spec/ngspice-alignment-F-mos.md` | MOS1 load/temp/conv/trun alignment |
| 7 | `spec/ngspice-alignment-F5ext-jfet.md` | JFET full convergence port (subsumes F5-D/F5-E) |
| 8 | `spec/ngspice-alignment-F6-docs-citations.md` | Citation audit + divergences addendum |

Reference-only (no implementer tasks): `spec/ngspice-alignment-divergences.md`, `spec/ngspice-alignment-verification.md`, `spec/ngspice-alignment-predictor-tracer.md`.

## Goals

- Every analog-solver code path ngspice-aligned to the diffs in the F1–F6 / F-bjt / F-mos specs.
- `LoadContext` reduced to a single `cktMode` bitfield mirroring ngspice `CKTmode`, with all legacy mode booleans (`initMode` / `isDcOp` / `isTransient` / `isTransientDcop` / `isAc` / `iteration`) removed.
- Every charge-storing device exercises the full MODEINITJCT / MODEINITPRED / MODEINITTRAN / MODEINITSMSIG / MODEINITFIX state-machine.
- `pnjlim`/`fetlim` primitives byte-aligned to `devsup.c`; Gillespie negative-bias branch restored; limiting diagnostics reach `limitingCollector`.
- JFET Sydney-University model in place; all banned Vds clamps and `Math.exp(700)` guards removed.
- Every inline ngspice citation in `src/` verified against `ref/ngspice`; `spec/ngspice-citation-audit.md` persisted as the durable citation table.

## Non-Goals

- **Phase 7 (master plan) ngspice parity harness run is not a task in this plan.** It is implicit in "full suite at end of job"; a separate mission owns acceptance-circuit bit-equality.
- MOS2/3/6/9 BSIM/HSPICE extensions (F-MOS explicitly scopes to MOS1 Shichman-Hodges).
- CKTsenInfo sensitivity, noise (mos1noi.c, bjtnoi.c), distortion, BSIM thermal extensions — all out of scope.
- Behavioral-digital element rewrite (flagged in master plan) — not addressed by any F-spec; deferred.
- Persistent-linked-list sparse solver rewrite (master plan Phase 0) — superseded by F1's targeted alignment fixes.
- Three-Surface Testing (headless + MCP + E2E) per phase — `CLAUDE.md` waiver applies: engine-internal refactors satisfy the rule via unit tests + final ngspice parity harness.

## Verification

- **Phase 0 done:** `spec/ngspice-alignment-master.md` deleted; banned Vds clamps absent from `njfet.ts`/`pjfet.ts`; no `Math.exp(700)` or `Math.min(..., 700)` in `bjt.ts`; `junctionCap` helper removed from `mosfet.ts`. Governing principles and 8-circuit parity checklist below absorbed into this plan.
- **Phase 1 done:** F1 targeted tests pass (`npx vitest run src/solver/analog/__tests__/sparse-solver.test.ts src/solver/analog/__tests__/complex-sparse-solver.test.ts`); `PIVOT_THRESHOLD`/`PIVOT_ABS_THRESHOLD` module constants gone; `solver.factor(gmin)` atomicity verified by per-step snapshot.
- **Phase 2 done:** `tsc --noEmit` passes; `ctx.cktMode` is the only mode representation in `ckt-context.ts` + `load-context.ts`; grep for `ctx.initMode`/`ctx.isDcOp`/`ctx.isTransient`/`loadCtx.iteration` returns zero production hits; F3+F4 targeted tests run.
- **Phase 3 done:** F2 targeted tests run against `newton-raphson`, `analog-engine`, `diode`, `bjt`; predictor xfact formula present in diode + BJT (L0 and L1).
- **Phase 4 done:** F5 targeted tests run — `npx vitest run src/solver/analog/__tests__/harness/stream-verification.test.ts`; `pnjlim` Gillespie branch present; `limitingCollector` populated end-to-end; LoadContext extensions from F-BJT + F-MOS landed as Wave 4.1 prerequisites.
- **Phases 5–7 done:** F-BJT / F-MOS / F5ext targeted tests run; device-specific diffs applied verbatim; dead-code items deleted per each spec's dead-code list.
- **Phase 8 done:** `spec/ngspice-citation-audit.md` exists; every priority-list citation in `dc-operating-point.ts`, `newton-raphson.ts`, `analog-types.ts` verified against ngspice sources.
- **Phase 9 done:** repo-wide grep for every removed identifier (`PIVOT_THRESHOLD`, `_firsttime`, `statePool.analysisMode`, `loadCtx.iteration`, `SLOT_GD_JUNCTION`, `SLOT_ID_JUNCTION`, `MNAAssembler` if removed, `InitMode` type) returns zero hits outside archived `ref/ngspice` and `spec/`.
- **Final (out-of-plan) acceptance:** 8-circuit ngspice parity harness (resistive divider, diode+resistor, BJT common-emitter, op-amp inverting, RC pulse, RLC oscillator, diode bridge rectifier, MOSFET inverter) produces IEEE-754 bit-identical per-NR-iteration `rhsOld[]`.

## Dependency Graph

```
Phase 0 (Dead Code Removal)                ─── runs first, alone
  │
Phase 1 (F1 — Sparse Solver)               ─── after 0
  │
Phase 2 (F3+F4 — cktMode + LoadContext)    ─── after 1 (atomic pair)
  │
Phase 3 (F2 — NR reorder + predictor)      ─── after 2
  │
Phase 4 (F5 — Voltage Limiting Primitives) ─── after 3
  │
  ├──→ Phase 5 (F-BJT)      ─── parallel after 4 ──┐
  ├──→ Phase 6 (F-MOS)      ─── parallel after 4    │
  └──→ Phase 7 (F5ext-JFET) ─── parallel after 4 ───┘
  │
Phase 8 (F6 — Docs/Citations)              ─── after 5 + 6 + 7
  │
Phase 9 (Legacy Reference Review)          ─── runs last, after all
```

**Serialization rationale:**

- **1 before 2** — both touch `ckt-context.ts` + `newton-raphson.ts`. F1's pivot fields and F1's NR-loop `factor(gmin)` integration land before F3/F4 collapse mode state.
- **2 atomic** — F3 and F4 must land as a single PR: F3 writes `ctx.cktMode`; F4 renames the LoadContext field and migrates every device reader. A split causes an un-buildable intermediate state. Spec states this explicitly.
- **3 after 2** — F2's reorder gate reads `cktMode` helpers; F2's device predictor edits share BJT hot-path with F-BJT (Phase 5) and must land first so F-BJT extends rather than fights.
- **4 after 3** — F5 adds `limitingCollector` field to LoadContext; every consumer (F-BJT, F-MOS, F5ext) reads it.
- **5/6/7 parallel** — disjoint device files (`bjt.ts` | `mosfet.ts`+`fet-base.ts` | `njfet.ts`+`pjfet.ts`). LoadContext field extensions batched in Wave 4.1.
- **8 last** — citation text must reflect final state of the code after all phases. Running earlier risks stale citations.

---

## Phase 0: Dead Code Removal
**Depends on:** (none — runs first)

Limited scope because the F-specs are corrective rewrites, not wholesale replacements; most legacy code is deleted *as part of* its phase. What is pre-purged here is banned code (policy violations) and material the user explicitly flagged.

### Wave 0.1: Pre-Purge
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 0.1.1 | Extract governing principles, 8-circuit parity checklist, `CKTCircuitContext` field inventory, `cktLoad` pseudocode, and SMPpreOrder pseudocode from `ngspice-alignment-master.md` into appendices of this plan *before* deletion; then delete the master file | S | `spec/plan.md`, `spec/ngspice-alignment-master.md` |
| 0.1.2 | Delete banned JFET Vds hard-clamps (`if (vds<-10) vds=-10; if (vds>50) vds=50;`) — violates "SPICE-correct only" rule | S | `src/components/semiconductors/njfet.ts:180-184`, `src/components/semiconductors/pjfet.ts:101-103` |
| 0.1.3 | Delete all 11 `Math.exp(700)` / `Math.min(..., 700)` overflow clamps in BJT — ngspice uses unclamped `exp` | S | `src/components/semiconductors/bjt.ts` (lines ~548, 560, 1016, 1028, 1054, 1075, 1607, 1659, 1703, 1901, 1934) |
| 0.1.4 | Delete unused exported `junctionCap` helper | S | `src/components/semiconductors/mosfet.ts:797-808` |
| 0.1.5 | Working-tree hygiene (user-owned) — user cleans stray `.tsc-*.txt`, `e2e-results.json`, stale `scripts/*` before Phase 1. No agent action. | — | working tree |

---

## Phase 1: F1 — Sparse Solver Alignment
**Depends on:** Phase 0

Spec: `spec/ngspice-alignment-F1-sparse-solver.md`. Targeted tests: `npx vitest run src/solver/analog/__tests__/sparse-solver.test.ts src/solver/analog/__tests__/complex-sparse-solver.test.ts src/solver/analog/__tests__/rl-iter0-probe.test.ts`.

### Wave 1.1: Sparse-solver primitives
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.1.1 | Replace `PIVOT_THRESHOLD`/`PIVOT_ABS_THRESHOLD` module constants with `DEFAULT_PIVOT_REL_THRESHOLD=1e-3` / `DEFAULT_PIVOT_ABS_THRESHOLD=0.0`; add `_relThreshold`/`_absThreshold` instance fields + `setPivotTolerances()` setter | S | `src/solver/analog/sparse-solver.ts` |
| 1.1.2 | Fix flag lifecycle: `_initStructure` sets `_needsReorder=true`, `_didPreorder=false`; add ngspice `spalloc.c:170` cite | S | `src/solver/analog/sparse-solver.ts` |
| 1.1.3 | `allocElement` new-entry branch sets `_needsReorder=true` after `_newElement` (ngspice `spbuild.c:788`) | S | `src/solver/analog/sparse-solver.ts` |
| 1.1.4 | `invalidateTopology` sets `_needsReorder=true` (ngspice `spStripMatrix` `sputils.c:1112`) | S | `src/solver/analog/sparse-solver.ts` |
| 1.1.5 | `_applyDiagGmin` zero short-circuit + doc; tighten `addDiagonalGmin` to delegate | S | `src/solver/analog/sparse-solver.ts` |

### Wave 1.2: Factor dispatch atomicity
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.2.1 | Extend `FactorResult` with `needsReorder` sentinel; add `_findLargestInColBelow` helper mirroring `FindLargestInCol` (`spfactor.c:1850`) | S | `src/solver/analog/sparse-solver.ts` |
| 1.2.2 | Rewrite `_numericLUReusePivots` with column-relative guard; return `{success:false, needsReorder:true}` on guard violation (`spfactor.c:214-238`) | M | `src/solver/analog/sparse-solver.ts` |
| 1.2.3 | Rewrite public `factor(diagGmin?)` to accept gmin param, re-dispatch on `needsReorder`, extract `_takePreFactorSnapshotIfEnabled` after `_applyDiagGmin` in both factor paths | M | `src/solver/analog/sparse-solver.ts` |

### Wave 1.3: Markowitz pivot selection
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.3.1 | Replace all `PIVOT_*` constant references in `_searchForPivot`; update doc comments | S | `src/solver/analog/sparse-solver.ts` |
| 1.3.2 | Fix Phase-2 diagonal lookup: replace `i !== k` filter with `_diag[k]` pool-handle lookup | S | `src/solver/analog/sparse-solver.ts` |
| 1.3.3 | Rewrite Phase-3/4 as SearchEntireMatrix: walk every col `j>=k`, compute `largestInCol`, track MinMarkowitzProduct with ratio tie-break, fallback to `pLargestElement`; add `_swapColumnsForPivot` + `_findDiagOnColumn` helpers | L | `src/solver/analog/sparse-solver.ts` |

### Wave 1.4: CKT/NR plumbing
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.4.1 | Extend `SimulationParams` with `pivotAbsTol?`/`pivotRelTol?` + defaults (0, 1e-3) in `DEFAULT_SIMULATION_PARAMS` | S | `src/core/analog-engine-interface.ts` |
| 1.4.2 | Extend `CKTCircuitContext` with `pivotAbsTol`/`pivotRelTol` fields; wire constructor + `refreshTolerances` | S | `src/solver/analog/ckt-context.ts` |
| 1.4.3 | NR-loop integration: remove `addDiagonalGmin` call, call `solver.setPivotTolerances(...)` pre-factor, pass `ctx.diagonalGmin` into `solver.factor(...)`; drop NR-local `didPreorder`; call `solver.preorder()` unconditionally | M | `src/solver/analog/newton-raphson.ts` |

### Wave 1.5: Complex solver mirror
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.5.1 | Complex `invalidateTopology` sets `_needsReorderComplex=true` | S | `src/solver/analog/complex-sparse-solver.ts` |
| 1.5.2 | Complex `allocComplexElement` sets `_needsReorderComplex=true` after `_diag[internalCol]=newE` | S | `src/solver/analog/complex-sparse-solver.ts` |
| 1.5.3 | Complex threshold constants (`PIVOT_THRESHOLD` `0.01 → 1e-3`) + per-instance tolerances mirroring real-solver | M | `src/solver/analog/complex-sparse-solver.ts` |

---

## Phase 2: F3 + F4 — `ctx.cktMode` Bitfield + LoadContext Migration (Atomic)
**Depends on:** Phase 1

Specs: `spec/ngspice-alignment-F3-dcop-transient.md`, `spec/ngspice-alignment-F4-cktload-devices.md`. **Must land as a single PR.** Splitting causes an un-buildable intermediate state.

Targeted tests after landing: `npx vitest run src/solver/analog/__tests__/ckt-load.test.ts src/solver/analog/__tests__/dcop-init-jct.test.ts src/solver/analog/__tests__/newton-raphson.test.ts`.

### Wave 2.1: Foundation (F3/F4 shared prerequisites)
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.1.1 | Create `ckt-mode.ts`: 14 `MODE*` constants with ngspice hex verbatim (`cktdefs.h:165-185`) + `setInitf`/`setAnalysis`/`isDcop`/`isTran`/`isTranOp`/`isAc`/`isUic`/`initf` helpers | S | `src/solver/analog/ckt-mode.ts` (new) |
| 2.1.2 | Migrate `LoadContext`: remove `InitMode` type, `iteration`, `initMode`, `isDcOp`, `isTransient`, `isTransientDcop`, `isAc`; add `cktMode: number` (retain `uic` temporarily) | M | `src/solver/analog/load-context.ts` |
| 2.1.3 | Add `cktMode: number` field to `CKTCircuitContext`; mark legacy mirrors `@deprecated`; init to `MODEDCOP \| MODEINITFLOAT` | S | `src/solver/analog/ckt-context.ts` |
| 2.1.4 | Collapse `ctx.noncon` dual-storage to accessor forwarding `loadCtx.noncon.value`; add `troubleNode: number \| null` field | S | `src/solver/analog/ckt-context.ts` |

### Wave 2.2: `cktLoad` rewrite
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.2.1 | Rewrite `cktLoad` gating: drop `iteration` param, mirror `ctx.cktMode` into `loadCtx.cktMode`; `MODEDC+(INITJCT\|INITFIX)` nodeset gate; `MODETRANOP+!MODEUIC` IC gate; null-guard + troubleNode zero when noncon rises; remove duplicate noncon reset | M | `src/solver/analog/ckt-load.ts` |

### Wave 2.3: Engine rewrite (F3 D1–D5)
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.3.1 | Rewrite `dcopFinalize` to single `cktLoad(ctx)` after `setInitf(ctx.cktMode, MODEINITSMSIG)`; no save/restore dance | M | `src/solver/analog/dc-operating-point.ts` |
| 2.3.2 | Gate all three `dcopFinalize` call sites on `!ctx.isTransientDcop` (derived from cktMode) | S | `src/solver/analog/dc-operating-point.ts` |
| 2.3.3 | Rewrite `_seedFromDcop` as three-statement `dctran.c:346-350` port: set `cktMode`, zero `ag[0..1]`, `states[1].set(states[0])`; remove `el.accept()` sweep and `_firsttime` write | L | `src/solver/analog/analog-engine.ts` |
| 2.3.4 | Delete `_firsttime` field + all 9 read/write sites + `firstNrForThisStep` + `"transient"` initMode sentinel; rewrite step() branches to use `_stepCount === 0`; add post-NIiter `cktMode = MODEINITPRED` write | L | `src/solver/analog/analog-engine.ts` |
| 2.3.5 | Remove `ctx.isTransient = false` in `runNR`; derive mirrors from cktMode | S | `src/solver/analog/dc-operating-point.ts` |
| 2.3.6 | Caller-side cktMode writes: `_transientDcop` → `MODETRANOP\|MODEINITJCT`; `dcOperatingPoint` → `MODEDCOP\|MODEINITJCT`; change `srcFact = params.srcFact ?? 1` to `srcFact = 1` | M | `src/solver/analog/analog-engine.ts`, `src/solver/analog/dc-operating-point.ts` |
| 2.3.7 | Convert B8 initMode writes at ~10 sites (lines 486/507/575/599/635/652/679/710/722/743 cktop counterparts) to `setInitf()` + mirror | M | `src/solver/analog/dc-operating-point.ts` |
| 2.3.8 | Fix `newtonRaphson` UIC early-exit to gate on `isTranOp(cktMode) && isUic(cktMode)` (AD1) | S | `src/solver/analog/newton-raphson.ts` |

### Wave 2.4: Device-load migration (F4 Wave 3)
Parallel mechanical bitfield rewrites. Each subtask is independent.

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.4.1 | Diode MODEINITSMSIG + bitfield (state0/state1 seeding per INIT phase; cap-gate expansion; store-back under INITSMSIG) | M | `src/components/semiconductors/diode.ts` |
| 2.4.2 | BJT (L0 + L1) MODEINITSMSIG + bitfield: INITSMSIG/INITTRAN vbe/vbc seeding; rewrite charge-block gate; small-signal cap store-back | L | `src/components/semiconductors/bjt.ts` |
| 2.4.3 | MOSFET MODEINITSMSIG + cktMode state: rename `_ctxInitMode`→`_ctxCktMode`; MODETRANOP\|MODEINITSMSIG doubling in Meyer-cap; 9 rewrite sites | L | `src/components/semiconductors/mosfet.ts`, `src/solver/analog/fet-base.ts` |
| 2.4.4 | JFET n-/p-channel MODEINITSMSIG + bitfield | M | `src/components/semiconductors/njfet.ts`, `pjfet.ts` |
| 2.4.5 | Capacitor gate fix (A2): drop MODEDCOP from participation gate; INITPRED/INITTRAN bitfield migration | S | `src/components/passives/capacitor.ts` |
| 2.4.6 | Inductor bitfield migration: `!(MODEDC\|MODEINITPRED)` flux gate; `!MODEDC` integrate gate | S | `src/components/passives/inductor.ts` |
| 2.4.7 | Remaining charge/reactive devices (mechanical bitfield rewrite): zener, varactor, scr, tunnel-diode, polarized-cap, transformer, tapped-transformer, transmission-line, crystal, real-opamp, led | L | 11 component files |
| 2.4.8 | Shared solver helpers: `fet-base.ts` capGate; `behavioral-remaining.ts`, `bridge-adapter.ts`, `digital-pin-model.ts` bitfield reads; `harness/capture.ts:294` | M | shared helpers |
| 2.4.9 | `checkConvergence` A7 fix: OFF + (`MODEINITFIX\|MODEINITSMSIG`) short-circuit across diode/bjt/mosfet | S | diode/bjt/mosfet |

### Wave 2.5: Test migration
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.5.1 | Strip `iteration:` from LoadContext literals; rewrite `ctx.isDcOp`/`initMode` assignments to `ctx.cktMode = MODEDCOP \| MODEINITFLOAT` form | M | `src/solver/analog/__tests__/test-helpers.ts`, `ckt-load.test.ts`, `dcop-init-jct.test.ts`, `newton-raphson.test.ts`, `harness/capture.ts`; `src/components/semiconductors/__tests__/triode.test.ts`, `diac.test.ts` |
| 2.5.2 | Audit behavioral elements for accept() dependency (AD9): `behavioral-flipflop.ts` etc. must seed `_prevClockVoltage` from `initState`, not the removed accept sweep | M | `src/solver/analog/behavioral-*.ts` |

---

## Phase 3: F2 — NR Reorder Gate + Per-Device initPred Predictor
**Depends on:** Phase 2

Spec: `spec/ngspice-alignment-F2-nr-reorder-predictor.md`. Targeted tests: scoped to `newton-raphson`, `analog-engine`, `diode`, `bjt` unit/integration suites under `src/solver/analog/__tests__/` and `src/components/semiconductors/__tests__/`; ngspice comparison harness for per-NR parity on diode/BJT transients.

### Wave 3.1: NR reorder timing
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.1.1 | Pre-factor `NISHOULDREORDER` gate: insert `solver.forceReorder()` between preorder and factor at `newton-raphson.ts:285-303`, gated on `initMode==="initJct" \|\| (initMode==="initTran" && iteration===0)` using cktMode helpers | S | `src/solver/analog/newton-raphson.ts` |
| 3.1.2 | `INITF` dispatcher: add ngspice cross-reference comments to existing `forceReorder()` calls (`niiter.c:474-499`); behavior unchanged | S | `src/solver/analog/newton-raphson.ts` |

### Wave 3.2: Device initPred xfact extrapolation
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.2.1 | Diode xfact: add `else if (initMode==="initPred")` branch: `vdRaw = (1+xfact)*s1[VD] - xfact*s2[VD]` | M | `src/components/semiconductors/diode.ts:464-490` |
| 3.2.2 | BJT behavioral xfact: same pattern for `vbeRaw`/`vbcRaw` | M | `src/components/semiconductors/bjt.ts:774-817` |
| 3.2.3 | BJT L1 xfact: same pattern for `vbeRaw`/`vbcRaw` with `vsubRaw` extrapolation per `bjtload.c:302-305` | M | `src/components/semiconductors/bjt.ts:1460-1509` |
| 3.2.4 | BJT L1 missing state-copy slots: add `s0[RB_EFF]=s1[RB_EFF]` and `s0[VSUB]=s1[VSUB]` to the initPred copy block | S | `src/components/semiconductors/bjt.ts:1475` |
| 3.2.5 | xfact scope audit: grep `.xfact` across device files; confirm none read outside `initMode==="initPred"` guard | S | `src/components/**/*.ts`, `src/solver/analog/load-context.ts` |

### Wave 3.3: Additional divergences
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.3.1 | Unconditional initTran set on first step: move `if (this._firsttime) ctx.initMode="initTran"` equivalent OUTSIDE the `if (statePool)` block so purely-linear circuits also enter with `MODEINITTRAN` | S | `src/solver/analog/analog-engine.ts:422-429` |
| 3.3.2 | NIDIDPREORDER lifecycle audit: compare `solver.invalidateTopology()` call sites vs. ngspice `NIreinit()` trigger points. Report findings; no code change unless divergence confirmed | S | `src/solver/analog/sparse-solver.ts` |

---

## Phase 4: F5 — Voltage Limiting Primitives + Shared LoadContext Extensions
**Depends on:** Phase 3

Spec: `spec/ngspice-alignment-F5-limiting.md` + LoadContext fields for F-BJT (`bypass`, `voltTol`, `gmin`, `deltaOld`, `trouble`) and F-MOS (`cktFixLimit`). Targeted tests: `npx vitest run src/solver/analog/__tests__/harness/stream-verification.test.ts`.

### Wave 4.1: Shared LoadContext extensions (prereq for Phases 5/6)
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.1.1 | Add `limitingCollector: LimitingEvent[] \| null` to `LoadContext` + import `LimitingEvent` | S | `src/solver/analog/element.ts`, `src/solver/analog/load-context.ts` |
| 4.1.2 | Add F-BJT-required fields: `bypass: boolean`, `voltTol: number`, `gmin: number`, `deltaOld: number[]`, `trouble: { element: AnalogElement \| null }` | M | `src/solver/analog/load-context.ts`, all call sites building LoadContext |
| 4.1.3 | Add F-MOS-required `cktFixLimit: boolean` to `LoadContext` and `cktFixLimit` field to `CKTCircuitContext` (default false) | S | `src/solver/analog/load-context.ts`, `src/solver/analog/ckt-context.ts` |
| 4.1.4 | Sync all new fields into `loadCtx` per-iteration inside `cktLoad` | S | `src/solver/analog/ckt-load.ts` |

### Wave 4.2: Core primitive rewrites (no deps)
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.2.1 | D1: Rewrite `pnjlim` body as verbatim `devsup.c:49-84` translation including Gillespie negative-bias branch | S | `src/solver/analog/newton-raphson.ts:89-109` |
| 4.2.2 | D2: Rewrite `fetlim`; fix `vtstlo` coefficient to `Math.abs(vold - vto) + 1` matching `devsup.c:102` | S | `src/solver/analog/newton-raphson.ts:133-176` |
| 4.2.3 | D3: `limvds` parity audit — verified identical to `devsup.c:20-40`, no diff | S | `src/solver/analog/newton-raphson.ts` |
| 4.2.4 | F5-J: Doc-comment citation refresh: update `devsup.c:50-58` → `49-84` | S | `src/solver/analog/newton-raphson.ts:62` |

### Wave 4.3: Call-site fixes
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.3.1 | Sync `ctx.loadCtx.limitingCollector = ctx.limitingCollector` in `cktLoad` | S | `src/solver/analog/ckt-load.ts:45-55` |
| 4.3.2 | F5-B + F5-C: LED initJct skip branch + `ctx.limitingCollector?.push(...)` | S | `src/components/io/led.ts:288` |
| 4.3.3 | F5-F: Zener — swap `params.BV` for temperature-scaled `tBV` in breakdown branch | S | `src/components/semiconductors/zener.ts:195-212` |
| 4.3.4 | F5-G + F5-H: BJT substrate audit — document simple-model divergence; verify L1 `pnjlim(vsubRaw, ..., tp.tSubVcrit)` call | S | `src/components/semiconductors/bjt.ts:1483-1487` |

---

## Phase 5: F-BJT — BJT L0 + L1 Full Alignment
**Depends on:** Phase 4
**Parallel with:** Phase 6, Phase 7

Spec: `spec/ngspice-alignment-F-bjt.md`. Targeted tests: BJT suites under `src/components/semiconductors/__tests__/`; ngspice harness for BJT common-emitter + diode bridge.

### Wave 5.1: Simple model (spice-l0) alignment
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.1.1 | A1: initPred xfact extrapolation + full state1→state0 copy list; route predicted values into pnjlim skip path | M | `bjt.ts` (createBjtElement load()) |
| 5.1.2 | A3: MODEINITJCT priming — 3-branch ngspice priority (UIC / off==0 / zero) | S | `bjt.ts` |
| 5.1.3 | A4: NOBYPASS bypass test — 4-tolerance delvbe/delvbc/cchat/cbhat; gate computeBjtOp on !bypassed | L | `bjt.ts` |
| 5.1.4 | A5: noncon gate INITFIX/off exception | S | `bjt.ts` |
| 5.1.5 | A8: Parameterize NE/NC — add to `BJT_PARAM_DEFS`, plumb through factory + `makeTp` | S | `bjt.ts` |
| 5.1.6 | A2/A9: MODEINITSMSIG + MODEINITTRAN stubs | S | `bjt.ts` |

### Wave 5.2: SPICE-L1 alignment
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.2.1 | B1/B2: initPred xfact + VSUB/GX/RB_EFF copy; route predicted voltages, skip pnjlim under initPred | M | `bjt.ts` |
| 5.2.2 | B3: MODEINITSMSIG block — evaluate OP, write `cexbc=geqcb`, return (skip stamps) | M | `bjt.ts` |
| 5.2.3 | B4: NOBYPASS bypass test — 4-tolerance gate; reload state0 on bypass | L | `bjt.ts` |
| 5.2.4 | B5: noncon gate INITFIX/off | S | `bjt.ts` |
| 5.2.5 | B8: Fix CdBE to use `op.gbe` (not `op.gm`) in diffusion cap | S | `bjt.ts` |
| 5.2.6 | B9: External BC cap node destination: `nodeC_ext` → `nodeC_int` at 4 stamp sites | S | `bjt.ts` |
| 5.2.7 | B10: Add BJTsubs (SUBS) model param; plumb through defs, factory, subs derivation | M | `bjt.ts` |
| 5.2.8 | B11: Add AREAB/AREAC params — VERTICAL/LATERAL area scaling for c4, czsub, czbc | M | `bjt.ts` |
| 5.2.9 | B12: MODEINITTRAN `cqbe`/`cqbc`/`cqbx`/`cqsub` bcopy to s1 | S | `bjt.ts` |
| 5.2.10 | B15: `cexbc` state1/state2 seed on INITTRAN; split shift-history gate on `prevDt > 0` | M | `bjt.ts` |
| 5.2.11 | B22: Excess-phase `cex` uses raw `opIf` not `cbe_mod` | S | `bjt.ts` |
| 5.2.12 | F-BJT-ADD-21: XTF=0 gbe adjustment — run `gbe`/`cbe` mod regardless of XTF when TF>0 && vbe>0 | M | `bjt.ts` |
| 5.2.13 | F-BJT-ADD-23: `geqsub=gcsub+gdsub` aggregation — single Norton stamp | S | `bjt.ts` |
| 5.2.14 | F-BJT-ADD-25: cap gating for initSmsig / UIC-DC-OP | S | `bjt.ts` |
| 5.2.15 | F-BJT-ADD-34: VSUB limiting collector entry | S | `bjt.ts` |

---

## Phase 6: F-MOS — MOSFET MOS1 Alignment
**Depends on:** Phase 4
**Parallel with:** Phase 5, Phase 7

Spec: `spec/ngspice-alignment-F-mos.md`. Targeted tests: MOSFET vitest suites + ngspice harness for MOSFET inverter.

### Wave 6.1: Infrastructure
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.1.1 | B-5: SLOT_VON zero-init — change from `NaN` to `{kind:"zero"}`; drop `isNaN` guard | S | `fet-base.ts`, `mosfet.ts:1153` |
| 6.1.2 | B-4: Extend LTE to bulk charges — add qbs, qbd to MOSFET `getLteTimestep` loop | S | `mosfet.ts:1929-1958` |

### Wave 6.2: MOSFET correctness
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.2.1 | M-1: Predictor xfact extrapolation (**CRITICAL**) — replace broken state-copy stub with full `mos1load.c:205-227` xfact formula; evaluate I-V and junction diodes at extrapolated op point; gate on `initPred \|\| initTran` | L | `mosfet.ts:1226-1236` |
| 6.2.2 | M-2: MODEINITSMSIG path + Meyer averaging fix — add `initSmsig` branch; fix Meyer averaging gate in `computeCapacitances` | M | `mosfet.ts:1210,~1293` |
| 6.2.3 | M-3: MODEINITJCT IC_VDS/VGS/VBS — add ICVDS/ICVGS/ICVBS to `MosfetParams`; rewrite `primeJunctions` | M | `mosfet.ts:114-163,1615-1631` |
| 6.2.4 | M-4: Bypass test — NOBYPASS-gated bypass block after node-voltage read; restore cached state when tolerances satisfied | L | `mosfet.ts:~1307` |
| 6.2.5 | M-5: `CKTfixLimit` gate on reverse `limvds` — thread `cktFixLimit` through `limitVoltages()` helper | S | `mosfet.ts:722-750,1143` |
| 6.2.6 | M-6: icheck noncon gate — suppress `ctx.noncon++` when `off && (initFix\|\|initSmsig)` | S | `mosfet.ts:1444` |
| 6.2.7 | M-7: qgs/qgd/qgb xfact extrapolation — extrapolate Meyer charges under predictor at top of `_stampCompanion` | M | `mosfet.ts:1633` |
| 6.2.8 | M-8: `von` formula comment — add justification comment documenting polarity convention; no code change | S | `mosfet.ts:543-547` |
| 6.2.9 | M-9: Per-instance `vt` — replace hardcoded `VT` with `REFTEMP*KoverQ` in bulk-diode `exp(vbs/vt)` paths | S | `mosfet.ts:1418-1436,1266-1284` |
| 6.2.10 | M-12: MODEINITFIX + OFF path — insert branch forcing `vbs=vgs=vds=0` when `initFix && OFF` | M | `mosfet.ts` |
| 6.2.11 | Companion junction zero fix (#32) — stop zeroing SLOT_CCAP_DB/SB on MODEINITTRAN; only zero gate-cap companions | S | `mosfet.ts:1780-1785` |

### Wave 6.3: Verification
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.3.1 | PMOS `tVbi` sign audit (#25) — verify PMOS-with-gamma-nonzero against ngspice via harness; determine if `\|VTO\|` vs signed-VTO causes `tVbi` divergence | M | `mosfet.ts:973,1025` |

---

## Phase 7: F5ext — JFET Full Convergence Port
**Depends on:** Phase 4
**Parallel with:** Phase 5, Phase 6

Spec: `spec/ngspice-alignment-F5ext-jfet.md`. Subsumes F5-D (Vds-clamp removal) + F5-E (pnjlim on vgd). Targeted tests: `src/components/semiconductors/__tests__/jfet.test.ts`; ngspice harness.

### Wave 7.1: NJFET core
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.1.1 | Diff 3.1: State schema rewrite — rename `SLOT_GD_JUNCTION`→`SLOT_GGS_JUNCTION`, `SLOT_ID_JUNCTION`→`SLOT_CG_JUNCTION`; add VGD/GGD/CGD/CD/QGS/QGD/CQGS/CQGD slots (48–55) | M | `njfet.ts:58-71` |
| 7.1.2 | Diff 3.2: Accessor getters/setters for 7 new slots + renames | S | `njfet.ts:160-167` |
| 7.1.3 | Diff 3.3: Add `limitVgd`; `DEVfetlim` + `DEVpnjlim` on vgs via `limitVoltages`; gate-drain pair limiting; import `fetlim` | M | `njfet.ts:169-186` |
| 7.1.4 | Diff 3.4: Rewrite `primeJunctions` — 3-branch MODEINITJCT (UIC/!OFF/OFF) per `jfetload.c:109-122`; seed `_vgs_junction`, `_vgd_junction`, `GMIN` conductances | M | `njfet.ts:258-263` |
| 7.1.5 | Diff 3.5: MODEINITPRED + full `_updateOp` rewrite — state1→state0 copies (9 slots), xfact vgs/vgd extrapolation, delvgs/delvgd/cghat/cdhat predictor, gate-drain Shockley diode, Sydney drain current | L | `njfet.ts:265-285+` |
| 7.1.6 | Diff 3.6: JFET-specific `checkConvergence` — replace inherited MOS1convTest with `icheck \|\| \|cghat-cg\|>=tol \|\| \|cdhat-cd\|>tol` (preserve `>=`/`>` asymmetry) | M | `njfet.ts` |
| 7.1.7 | Diff 3.7: Rewrite `_stampNonlinear` — 16 Y-matrix + 3 RHS stamps per `jfetload.c:521-550`; gate-drain diode Norton; RHS-first ordering with polarity sign | L | `njfet.ts:~300-387` |

### Wave 7.2: PJFET collapse
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.2.1 | Diff 4.2: Delete PJFET `_updateOp` override — delegate to polarity-aware base | S | `pjfet.ts` |
| 7.2.2 | Diff 4.3: Delete PJFET `_stampNonlinear` override — delegate to polarity-aware base | S | `pjfet.ts` |
| 7.2.3 | Diff 4.4: Delete PJFET `primeJunctions` override — delegate to base | S | `pjfet.ts:86-244` |

### Wave 7.3: Test alignment
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.3.1 | Update test imports — replace `SLOT_GD_JUNCTION`/`SLOT_ID_JUNCTION` with `stateSchema.getSlotOffset("GGS_JUNCTION")`/`("CG_JUNCTION")` per schema-lookup rule | S | `src/components/semiconductors/__tests__/jfet.test.ts:19-22` |

---

## Phase 8: F6 — Documentation & Citations
**Depends on:** Phase 5, Phase 6, Phase 7

Spec: `spec/ngspice-alignment-F6-docs-citations.md`. Pure documentation / comment-only edits. No runtime behavior change.

### Wave 8.1: Spec artifacts
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 8.1.1 | Append Wave C5 completion-status block | S | `spec/phase-catchup.md` |
| 8.1.2 | Append 2026-04-20 divergences addendum (sections C1–C5, L1, P1–P4) | M | `spec/ngspice-alignment-divergences.md` |
| 8.1.3 | Create `spec/ngspice-citation-audit.md` verbatim from F6 Deliverable 8 (58-row table, status defs, priority corrections, maintenance protocol) | M | `spec/ngspice-citation-audit.md` (new) |

### Wave 8.2: Citation corrections in source
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 8.2.1 | 6 citation corrections per priority list entries #1–6 | M | `src/solver/analog/dc-operating-point.ts` (lines 4, 8, 10, 18–19, 209, 219–220, 429, 467, 471, 557, 561, 661, 665, 696, 725, 733) |
| 8.2.2 | Correct lines 62/79 (pnjlim divergence — now resolved by Phase 4), 236 → `cktntask.c:97`, 408 → `niiter.c:1012-1046` | S | `src/solver/analog/newton-raphson.ts` |
| 8.2.3 | Replace `niiter.c:991-997` with `niiter.c:1050-1085` on line 82 | S | `src/core/analog-types.ts` |

---

## Phase 9: Legacy Reference Review
**Depends on:** all previous phases

Audit the repo for any remaining stale references. No legacy reference acceptable in any form.

### Wave 9.1: Full audit
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 9.1.1 | Grep for every removed identifier: `PIVOT_THRESHOLD`, `PIVOT_ABS_THRESHOLD`, `_firsttime`, `statePool.analysisMode`, `loadCtx.iteration`, `SLOT_GD_JUNCTION`, `SLOT_ID_JUNCTION`, `InitMode` type, `ctx.initMode`, `ctx.isDcOp` (as field), `ctx.isTransient` (as field), `ctx.isTransientDcop`, `ctx.isAc` (as field), `Math.exp(700)`, `Math.min(..., 700)`, `junctionCap`, banned Vds clamp `(vds < -10)`, `firstNrForThisStep`, `"transient"` initMode sentinel, `predictor` SimulationParams field (if deleted), MNAAssembler (if deleted) | M | repo-wide |
| 9.1.2 | Audit comment citations: random sample 10 ngspice citations from `src/` — verify line numbers against `ref/ngspice/` | S | `src/**/*.ts` |
| 9.1.3 | Run full suite: `npm test`. Capture failures as final acceptance input for the out-of-plan ngspice parity harness mission | S | (project-wide) |

---

## Appendix A: 8-Circuit ngspice Parity Checklist (absorbed from master)

After all phases complete, these 8 circuits must produce IEEE-754 identical per-NR-iteration node voltages compared to ngspice:

1. **Resistive divider** (DC-OP — linear stamp, 1 iteration)
2. **Diode + resistor** (DC-OP — pnjlim, mode transitions)
3. **BJT common-emitter** (DC-OP — multi-junction limiting, gmin stepping)
4. **Op-amp inverting amplifier** (DC-OP — source stepping)
5. **RC series with pulse** (Transient — capacitor integration, LTE, order promotion)
6. **RLC oscillator** (Transient — inductor integration, ringing without method switch)
7. **Diode bridge rectifier** (Transient — multiple junctions, breakpoints)
8. **MOSFET inverter** (DC-OP + Transient — fetlim, FET equations)

Pass criteria per circuit:
- **DC-OP:** every NR iteration's `rhsOld[]` matches exactly (IEEE-754 bit-identical, `absDelta === 0`). Mode transitions match. Iteration count matches.
- **Transient:** every accepted timestep's `dt`, `order`, `method` match. Per-step NR iteration count matches. Node voltages match exactly (`absDelta === 0`).
- **Convergence flow:** `noncon`, `diagGmin`, `srcFact` match at every iteration/step.
- **Device state:** `state0[]` (per DEVICE_MAPPINGS slots) matches exactly at every NR iteration.

This checklist is the acceptance criterion for a **separate mission** that runs after Phase 9.

## Appendix B: Resolved Design Decisions (absorbed from master)

| Decision | Resolution | Rationale |
|---|---|---|
| AMD ordering | Dropped — pure Markowitz on original column order | ngspice doesn't use AMD; required for per-iteration parity |
| NISHOULDREORDER | Explicit `forceReorder()` only, no auto-detection | Match ngspice exactly |
| E_SINGULAR | continue to CKTload (re-stamp + re-factor) | Match `niiter.c:888-891` |
| NR signature | `newtonRaphson(ctx): void`, writes `ctx.nrResult` | Match ngspice NIiter void signature |
| `hadNodeset` gate | Derived from `ctx.nodesets.size > 0` | Match `niiter.c:1051-1052` |
| Method switching | Remove entirely | ngspice sets method once, never changes |
| Initial method | Trapezoidal | ngspice default is TRAPEZOIDAL |
| Element migration | Atomic — all elements at once, no shims | No legacy shims policy |

## Appendix C: Operational Rules for Implementers

- **Run targeted vitest only.** Each wave cites specific test files/suites. Do not run `npm test` at wave close — that's Phase 9.1.3's job.
- **STOP and escalate** if a diff in a spec file cannot be applied cleanly (code has drifted; assumed structure absent). Do not improvise.
- **Do not revert on regression.** Report full output. Reverting destroys diagnostic signal.
- **ngspice comparison harness is the primary tool for numerical issues** — do not theorize about per-iteration divergence; run the harness (see `docs/ngspice-harness-howto.md`) and find the exact iteration where values split.
- **Zero allocations in hot paths.** No `new`/`{}`/`[]`/closures inside `load()`, NR iterations, or per-step code.
- **Schema lookups over slot exports** — tests resolve pool slots by name via `stateSchema.getSlotOffset("NAME")`, not by importing `SLOT_*` constants.
