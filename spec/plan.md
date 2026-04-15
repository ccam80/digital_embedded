# ngspice Engine Alignment — Structural Waves Implementation Plan

## Context

We are aligning our analog simulation engine with ngspice's architecture to eliminate numerical discrepancies caused by subtle structural differences. YAML state machines were generated for both engines, 5 parallel architects identified 68 unique diffs, and the isolated-fix waves (3/6/8/9/11) plus batched changes (W2 mode automaton, W4 DCOP fallback, W5 sparse solver, W6 MOSFET, W7+W9 device INITF/params, W8 NR/acceptance, W10 diode, W11 varactor, W12 zener) are already implemented.

**Remaining:** 6 structural waves that require coordinated implementation because they touch the core NR loop, matrix solver, DCOP flow, and transient loop — all deeply interdependent.

**Specs live at:** `spec/state-machines/impl-spec-wave-{1,2,4,5,7,10}.md`

## Goals

- NR loop body in `newton-raphson.ts` matches ngspice's NIiter ordering: clearNoncon → CKTload → factor → solve → checkIterlim → convergence → damping → INITF → swapRHS
- Sparse matrix solver supports dual-path factorization (reorder + numerical) with Markowitz pivot selection matching ngspice's spOrderAndFactor/spFactor split
- Transient loop state rotation happens before-retry (pointer swap) instead of at acceptance, with centralized `computeNIcomCof()` and shared `ag[]` on StatePool
- DCOP flow wrapped in `cktop()` with direct-solve → gmin → source cascade, plus `dcopFinalize()` and `cktncDump()` diagnostics
- UIC bypass and nodeset/IC application match ngspice's entry paths
- Extended capabilities: NEWTRUNC voltage-based LTE, GEAR orders 3-6, 8-array StatePool, device bypass interface

## Non-Goals

- Reimplementing the digital simulation engine
- Adding new component types not already in the codebase
- Changing the editor/renderer/interaction layer
- Modifying the MCP server or postMessage API contract
- Reworking the already-completed isolated-fix waves (3/6/8/9/11) or batched changes (W2/W4/W5/W6/W7-W9/W8/W10/W11/W12)

## Verification

- **Phase 0**: `npx tsc --noEmit` confirms no stale imports; grep for removed symbols returns zero hits
- **Phase 1 (NR Loop)**: `npm run test:q` on newton-raphson tests; NR iteration order matches NIiter pseudocode in impl-spec-wave-1.md Steps A-K
- **Phase 2 (Matrix)**: `npm run test:q` on sparse-solver tests; Markowitz pivot counts match ngspice on reference circuits via harness
- **Phase 3 (Transient)**: `npm run test:q` on analog-engine tests; state rotation occurs before retry (not at acceptance); ag[] shared via StatePool
- **Phase 4 (DCOP)**: `npm run test:q` on dc-operating-point tests; cktop() cascade exercised with gmin stepping
- **Phase 5 (UIC)**: `npm run test:q` on newton-raphson tests; UIC bypass returns after single CKTload
- **Phase 6 (Extended)**: `npm run test:q` on integration/ckt-terr tests; GEAR order 3-6 coefficients match ngspice tables
- **Phase 7 (Legacy Review)**: repo-wide grep for all removed symbols, old function names, stale comments returns zero hits
- **End-to-end**: ngspice comparison harness (`harness_start` / `harness_run`) on reference circuits with per-NR-iteration voltage comparison

## Markowitz vs Partial Pivoting — Decision

| Dimension | Partial Pivoting (current) | Markowitz (ngspice) |
|-----------|---------------------------|-------------------|
| Code lines | ~120 (pivot search) | ~350-450 new TS lines |
| Fill-in | No minimization | 30-50% less fill-in on circuits |
| Stability | Good (max magnitude) | Excellent (structured selection) |
| Speed | Faster per-step | Slower reorder, faster subsequent (less fill) |
| Circuit suitability | Fair | Excellent (designed for SPICE) |

**Decision:** Implement Markowitz in the reorder path. Partial pivoting stays as the numerical-only path.

**Phasing within Phase 2:**
1. First: dual-path structure + singular retry + pivot reuse (correctness)
2. Then: Markowitz search replacing partial pivoting in reorder path (optimality)

## Dependency Graph

```
Phase 0 (Dead Code Removal)              ─── runs first, alone
│
Phase 1 (NR Loop Restructure)            ─── after 0
├──→ Phase 2 (Matrix Factorization)      ─── parallel after 1 ──┐
├──→ Phase 3 (Transient Loop)            ─── parallel after 1   │
├──→ Phase 5 (UIC + Nodesets)            ─── parallel after 1   │
│                                                                │
│    Phase 4 (DCOP Flow)                 ─── after 1 + 2        │
│                                                                │
│    Phase 6 (Extended Capabilities)     ─── after 2 + 3 ───────┘
│
Phase 7 (Legacy Reference Review)        ─── runs last, after all
```

**Critical path:** Phase 0 → Phase 1 → Phase 2 → Phase 4
**Parallel after Phase 1:** Phases 2, 3, 5 can all run concurrently

---

## Phase 0: Dead Code Removal
**Depends on**: (none — runs first)

Remove all code that will be replaced by the structural wave rewrites. This targets the current NR loop body ordering, the single-path `factor()` method in sparse-solver, the current state rotation in acceptance, and the current DCOP flow without `cktop()` wrapping. This will break the build and tests — subsequent phases build the replacements.

### Wave 0.1: Identify and Remove Dead Code
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 0.1.1 | Remove the linear stamp hoisting path and 7-state dispatch in the NR loop (the code that will be replaced by unified `stampAll`) | M | `src/solver/analog/newton-raphson.ts`, `src/solver/analog/mna-assembler.ts` |
| 0.1.2 | Remove the single-path `factor()` pivot search that will be replaced by dual-path Markowitz (the ~120-line pivot search block) | M | `src/solver/analog/sparse-solver.ts` |
| 0.1.3 | Remove `acceptTimestep()` and `state0.set(state1)` retry-entry copy that will be replaced by `rotateStateVectors()` | S | `src/solver/analog/state-pool.ts`, `src/solver/analog/analog-engine.ts` |

---

## Phase 1: NR Loop Restructure (Wave 1)
**Depends on**: Phase 0

Rewrite the entire NR for-loop body (~lines 468-739) to match ngspice's NIiter ordering:
```
Current:  stamp → factor → solve → updateOP → modeAutomaton → damping → convergence → ladder → gate
Target:   clearNoncon → CKTload(stampAll) → factor → solve → checkIterlim → convergence → damping → INITF → swapRHS
```

### Wave 1.1: Core NR Loop Rewrite
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.1.1 | Remove linear stamp hoisting (7 states → 1 unified `stampAll`); add new `stampAll()` method to MNAAssembler that stamps all elements unconditionally | L | `src/solver/analog/newton-raphson.ts`, `src/solver/analog/mna-assembler.ts` |
| 1.1.2 | Reorder the NR loop body: add explicit noncon=0 reset at loop top, move iteration limit check before convergence (after solve), reorder damping/convergence sequence | L | `src/solver/analog/newton-raphson.ts` |

### Wave 1.2: INITF Dispatch and RHS Swap
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.2.1 | Merge two INITF dispatchers into one unified dispatcher handling all 6 modes; fold convergence return into INITF dispatcher with ipass guard | M | `src/solver/analog/newton-raphson.ts` |
| 1.2.2 | Add RHS pointer swap at loop bottom (O(1) instead of O(n) copy); add `initSmsig` to initMode type union in analog-types | M | `src/solver/analog/newton-raphson.ts`, `src/core/analog-types.ts` |

**Estimated scope:** ~300 lines rewritten in newton-raphson.ts, ~50 lines new in mna-assembler.ts
**Pseudocode reference:** `spec/state-machines/impl-spec-wave-1.md` Steps A-K

---

## Phase 2: Matrix Factorization (Wave 2)
**Depends on**: Phase 1
**Parallel with**: Phases 3, 5

Split `factor()` into dual paths and add Markowitz pivot selection.

### Wave 2.1: Dual-Path Structure
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.1.1 | Add `preorder()` — one-time static column permutation (~30 lines) | S | `src/solver/analog/sparse-solver.ts` |
| 2.1.2 | Add `factorNumerical(diagGmin)` — reuse pivot order from last reorder with `_numericLUReusePivots()` (~80 lines); skip pivot search, use stored `pinv[]/q[]` | M | `src/solver/analog/sparse-solver.ts` |
| 2.1.3 | Add singular retry: `factorNumerical` on E_SINGULAR returns failure → NR loop sets `shouldReorder=true` and continues | S | `src/solver/analog/sparse-solver.ts`, `src/solver/analog/newton-raphson.ts` |

### Wave 2.2: Markowitz Pivot Selection
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.2.1 | Add Markowitz data structures: `_markowitzRow: Int32Array(n)`, `_markowitzCol: Int32Array(n)`, `_markowitzProd: Float64Array(n)`, `_singletons: number` | S | `src/solver/analog/sparse-solver.ts` |
| 2.2.2 | Implement `_countMarkowitz()` (~40 lines) and `_markowitzProducts()` (~25 lines) | M | `src/solver/analog/sparse-solver.ts` |
| 2.2.3 | Implement `_searchForPivot()` — 4-phase dispatcher (~250 lines) matching ngspice's spOrderAndFactor pivot strategy | L | `src/solver/analog/sparse-solver.ts` |
| 2.2.4 | Implement `_updateMarkowitzNumbers()` — recount after elimination (~70 lines); wire into `factorWithReorder(diagGmin)` (~400 lines total for reorder path) | M | `src/solver/analog/sparse-solver.ts` |

**Estimated scope:** ~550 lines new/changed in sparse-solver.ts

---

## Phase 3: Transient Loop (Wave 5)
**Depends on**: Phase 1
**Parallel with**: Phases 2, 5

Restructure state rotation and integration coefficient computation.

### Wave 3.1: State Rotation Restructure
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.1.1 | Replace `acceptTimestep()` with `rotateStateVectors()` in state-pool.ts — pointer swap, not copy; move state rotation from acceptance to before-retry | M | `src/solver/analog/state-pool.ts`, `src/solver/analog/analog-engine.ts` |
| 3.1.2 | Remove `state0.set(state1)` at retry entry; fix state copy ordering: ag-zero before state0→state1 | S | `src/solver/analog/analog-engine.ts` |

### Wave 3.2: Integration Coefficients
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.2.1 | Add centralized `computeNIcomCof()` in integration.ts (~50 lines); store `ag[]` on StatePool so elements read from shared store | M | `src/solver/analog/integration.ts`, `src/solver/analog/state-pool.ts` |
| 3.2.2 | Move LTE order promotion inside LTE check (before accept/reject); add `ag: Float64Array` to StatePool | S | `src/solver/analog/analog-engine.ts`, `src/solver/analog/state-pool.ts` |

**Estimated scope:** ~150 lines changed in analog-engine.ts, ~30 in state-pool.ts, ~50 new in integration.ts

---

## Phase 4: DCOP Flow (Wave 4)
**Depends on**: Phase 1, Phase 2 (for factorization paths)

Wrap DCOP in `cktop()` cascade matching ngspice's structure.

### Wave 4.1: DCOP Wrapper and Finalization
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.1.1 | Add `cktop()` wrapper (~40 lines) — wraps direct-solve → gmin → source cascade; add `dcopFinalize()` (~20 lines) — initSmsig → final load → output | M | `src/solver/analog/dc-operating-point.ts` |
| 4.1.2 | Add `cktncDump()` (~30 lines) — per-node non-convergence diagnostics on failure; fix premature initMode reset | M | `src/solver/analog/dc-operating-point.ts` |
| 4.1.3 | Add separate transient DCOP entry with MODETRANOP flags | S | `src/solver/analog/dc-operating-point.ts`, `src/core/analog-engine-interface.ts` |

**Estimated scope:** ~120 lines new/changed

---

## Phase 5: UIC + Nodesets (Wave 7)
**Depends on**: Phase 1
**Parallel with**: Phases 2, 3

### Wave 5.1: UIC Bypass and Nodeset Application
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.1.1 | Add UIC bypass at NR entry (~15 lines) — single CKTload, return OK | S | `src/solver/analog/newton-raphson.ts` |
| 5.1.2 | Add `applyNodesetsAndICs()` (~30 lines) — 1e10 conductance stamps for nodeset/IC nodes; plumb nodeset/IC data from compiled circuit through NR options | S | `src/solver/analog/newton-raphson.ts`, `src/core/analog-engine-interface.ts` |

**Estimated scope:** ~60 lines new

---

## Phase 6: Extended Capabilities (Wave 10)
**Depends on**: Phase 2, Phase 3

Extended numerical capabilities that build on the dual-factorization and transient restructure.

### Wave 6.1: LTE and Integration Extensions
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.1.1 | Implement NEWTRUNC voltage-based LTE (~60 lines) | M | `src/solver/analog/ckt-terr.ts` |
| 6.1.2 | Implement GEAR integration orders 3-6 (~80 lines) | M | `src/solver/analog/integration.ts` |

### Wave 6.2: StatePool and Device Bypass
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.2.1 | Expand StatePool from 4 to 8 arrays (~20 lines) | S | `src/solver/analog/state-pool.ts` |
| 6.2.2 | Add device bypass interface (~15 lines in analog-types.ts + stampAll check) | S | `src/core/analog-types.ts`, `src/solver/analog/mna-assembler.ts` |

**Estimated scope:** ~175 lines new

---

## Phase 7: Legacy Reference Review
**Depends on**: all previous phases

Audit the entire repository for any remaining references to removed code: imports, type annotations, string literals, config values, documentation, test fixtures, and comments. No legacy references are acceptable in any form.

### Wave 7.1: Full Legacy Audit
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.1.1 | Search for and remove all stale references to code removed in Phase 0 and replaced in subsequent phases — old function names (`acceptTimestep`, single-path `factor`, linear stamp hoisting symbols), removed type union members, stale test helpers, dead imports | M | (repo-wide) |

---

## Execution Summary

| Phase | Wave(s) | Parallelizable | Estimated Lines | Dependencies |
|-------|---------|---------------|-----------------|-------------|
| 0 | Dead Code | No — runs first | ~100 removed | None |
| 1 | 1 (NR Loop) | No — foundation | ~350 | Phase 0 |
| 2 | 2 (Matrix) | Yes, with 3+5 | ~550 | Phase 1 |
| 3 | 5 (Transient) | Yes, with 2+5 | ~230 | Phase 1 |
| 4 | 4 (DCOP) | After 1+2 | ~120 | Phase 1, Phase 2 |
| 5 | 7 (UIC) | Yes, with 2+3 | ~60 | Phase 1 |
| 6 | 10 (Extended) | Last impl phase | ~175 | Phase 2, Phase 3 |
| 7 | Legacy Review | Runs last | ~0 (removals) | All |

**Total new/changed code:** ~1,485 lines across 8 files

## Files Modified (Complete List)

| File | Phases | Nature of Change |
|------|--------|-----------------|
| `src/solver/analog/newton-raphson.ts` | 0, 1, 5 | Complete loop rewrite + UIC bypass |
| `src/solver/analog/mna-assembler.ts` | 0, 1, 6 | New `stampAll()` method + bypass check |
| `src/solver/analog/sparse-solver.ts` | 0, 2 | Dual factorization + Markowitz |
| `src/solver/analog/analog-engine.ts` | 0, 3 | Transient restructure |
| `src/solver/analog/state-pool.ts` | 0, 3, 6 | rotateStateVectors + ag[] + 8 arrays |
| `src/solver/analog/integration.ts` | 3, 6 | computeNIcomCof + GEAR 3-6 |
| `src/solver/analog/dc-operating-point.ts` | 4 | CKTop wrapper + finalization |
| `src/solver/analog/ckt-terr.ts` | 6 | NEWTRUNC LTE |
| `src/core/analog-types.ts` | 1, 6 | initSmsig in type union + bypass interface |
| `src/core/analog-engine-interface.ts` | 4, 5 | MODETRANOP + nodeset plumbing |
