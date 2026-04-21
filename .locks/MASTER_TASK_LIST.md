# Phase 2 Audit — Master Task List

**Source**: `spec/fix-list-phase-2-audit.md`
**Overriding rule**: Complete match with ngspice. No exceptions. No test-running by agents. Grep-only verification.
**Ambiguity protocol**: If answer to any question is "match ngspice", it is NOT a real ambiguity. Proceed.

## Status legend
- `AVAILABLE` — not yet claimed
- `FETCHED` — claimed by a worker (task lock held)
- `IN_PROGRESS` — worker is actively editing
- `COMPLETED` — worker reported completion
- `BLOCKED` — waiting on dependency or ambiguity

## Wave ordering
- **Wave 1 (parallel)**: A-1..A-4, E-1, E-2, F-1 — independent files
- **Wave 2 (parallel)**: B-1, B-2, B-3, B-4, C-8 — sparse solver + standalone infra
- **Wave 3 (parallel)**: C-1..C-7, C-10, D-9, D-11, D-15 — infra & simple device fixes
- **Wave 4 (sequential/parallel)**: C-9 (24 test files in parallel), D-1, D-3, D-4, D-5, D-6, D-7, D-10, D-12, D-13, D-14
- **Wave 5**: D-2a (diode schema), D-8 (MOSFET regression)
- **Wave 6**: F-2, G (weak-test strengthening — per-test subtasks)

---

## Wave 1 — Parallel, low-risk

| ID | Status | Worker | File | Fix |
|----|--------|--------|------|-----|
| A-1 | AVAILABLE | - | src/components/semiconductors/njfet.ts | Remove Math.min(expArg,80) clamps (4 sites) |
| A-2 | AVAILABLE | - | src/components/semiconductors/pjfet.ts | Remove Math.min(expArg,80) clamps (4 sites) |
| A-3 | AVAILABLE | - | src/components/semiconductors/bjt.ts:55 | Delete historical-provenance comment |
| A-4 | AVAILABLE | - | src/components/semiconductors/bjt.ts:1516 | Replace "fallback" with spec wording |
| E-1 | AVAILABLE | - | src/components/semiconductors/triac.ts | Add MODEINITJCT gate around pnjlim |
| E-2 | AVAILABLE | - | src/components/io/led.ts | Add MODEINITJCT gate around pnjlim |
| F-1 | AVAILABLE | - | (multi-file grep verification) | Verify historical-provenance comments deleted |

## Wave 2 — Sparse solver & standalone infra

| ID | Status | Worker | File | Fix |
|----|--------|--------|------|-----|
| B-1 | AVAILABLE | - | src/solver/analog/sparse-solver.ts | Extract `_takePreFactorSnapshotIfEnabled()`, move after `_applyDiagGmin` |
| B-2 | AVAILABLE | - | src/solver/analog/sparse-solver.ts:1490-1495 | Fix misleading "Do NOT demand reorder" comment |
| B-3 | AVAILABLE | - | src/solver/analog/__tests__/sparse-solver.test.ts:456-478 | Migrate rawCtx literal to cktMode bitfield |
| B-4 | AVAILABLE | - | src/solver/analog/__tests__/sparse-solver.test.ts | Strengthen WT-001/002/003 weak tests |
| C-8 | AVAILABLE | - | src/solver/analog/state-pool.ts:41 | Rewrite comment: `(ctx.cktMode & MODEINITTRAN) !== 0` |

## Wave 3 — Phase 2 infra + simple device fixes

| ID | Status | Worker | File | Fix |
|----|--------|--------|------|-----|
| C-1 | AVAILABLE | - | src/solver/analog/ac-analysis.ts:183-191 | Write `cktMode = MODEAC`, delete legacy writes |
| C-2 | AVAILABLE | - | src/solver/analog/analog-engine.ts:1193 | Delete `cac.statePool.analysisMode = "tran"` |
| C-3 | AVAILABLE | - | src/solver/analog/analog-engine.ts (_seedFromDcop) | Delete refreshElementRefs call |
| C-4 | AVAILABLE | - | src/solver/analog/behavioral-flipflop.ts | Add initState() seeding `_prevClockVoltage` |
| C-5 | AVAILABLE | - | src/solver/analog/ckt-mode.ts:106-108 | Fix `isDcop()` to use MODEDC mask |
| C-6 | AVAILABLE | - | src/solver/analog/dc-operating-point.ts:187-201 | Replace InitMode string param with firstInitf number |
| C-7 | AVAILABLE | - | src/solver/analog/dc-operating-point.ts:239,368 | Rewrite stale isTransientDcop comments |
| C-10 | AVAILABLE | - | src/**/*.ts (production) | Audit legacy mode reads — zero-hits per grep list |
| D-9 | AVAILABLE | - | src/components/semiconductors/mosfet.ts:1196 | Delete duplicate `_ctxCktMode` write |
| D-11 | AVAILABLE | - | src/solver/analog/fet-base.ts:194-196 | Reduce comment to single-line semantics |
| D-15 | AVAILABLE | - | src/components/passives/capacitor.ts | Default `_IC = 0.0`, drop isNaN guard |

## Wave 4 — Test migration (C-9 parallel batch) + device D-items

### C-9 sub-tasks (one per test file, individually claimable)
| ID | Status | Worker | File |
|----|--------|--------|------|
| C-9a | AVAILABLE | - | src/components/sensors/__tests__/spark-gap.test.ts |
| C-9b | AVAILABLE | - | src/components/sensors/__tests__/ntc-thermistor.test.ts |
| C-9c | AVAILABLE | - | src/components/passives/__tests__/memristor.test.ts |
| C-9d | AVAILABLE | - | src/components/passives/__tests__/analog-fuse.test.ts |
| C-9e | AVAILABLE | - | src/solver/__tests__/coordinator-bridge.test.ts |
| C-9f | AVAILABLE | - | src/solver/__tests__/coordinator-bridge-hotload.test.ts |
| C-9g | AVAILABLE | - | src/components/semiconductors/__tests__/zener.test.ts |
| C-9h | AVAILABLE | - | src/components/semiconductors/__tests__/triac.test.ts |
| C-9i | AVAILABLE | - | src/components/semiconductors/__tests__/scr.test.ts |
| C-9j | AVAILABLE | - | src/components/sources/__tests__/variable-rail.test.ts |
| C-9k | AVAILABLE | - | src/components/sources/__tests__/ground.test.ts |
| C-9l | AVAILABLE | - | src/components/sources/__tests__/dc-voltage-source.test.ts |
| C-9m | AVAILABLE | - | src/components/sources/__tests__/current-source.test.ts |
| C-9n | AVAILABLE | - | src/components/sources/__tests__/ac-voltage-source.test.ts |
| C-9o | AVAILABLE | - | src/solver/analog/__tests__/behavioral-combinational.test.ts |
| C-9p | AVAILABLE | - | src/solver/analog/__tests__/behavioral-flipflop-variants.test.ts |
| C-9q | AVAILABLE | - | src/solver/analog/__tests__/behavioral-gate.test.ts |
| C-9r | AVAILABLE | - | src/solver/analog/__tests__/behavioral-flipflop.test.ts |
| C-9s | AVAILABLE | - | src/solver/analog/__tests__/behavioral-integration.test.ts |
| C-9t | AVAILABLE | - | src/solver/analog/__tests__/behavioral-remaining.test.ts |
| C-9u | AVAILABLE | - | src/solver/analog/__tests__/behavioral-sequential.test.ts |
| C-9v | AVAILABLE | - | src/solver/analog/__tests__/bridge-adapter.test.ts |
| C-9w | AVAILABLE | - | src/solver/analog/__tests__/bridge-compilation.test.ts |
| C-9x | AVAILABLE | - | src/solver/analog/__tests__/digital-pin-model.test.ts |
| C-9y | AVAILABLE | - | src/solver/analog/__tests__/fet-base.test.ts |
| C-9z | AVAILABLE | - | src/components/active/__tests__/adc.test.ts |
| C-9-ext | AVAILABLE | - | (enumerate remaining via `rg -l '(iteration\|isDcOp\|isTransient\|isTransientDcop\|isAc)\s*:' src/**/__tests__/`) |

### Device D-items (Wave 4)
| ID | Status | Worker | File | Fix |
|----|--------|--------|------|-----|
| D-1 | AVAILABLE | - | src/components/semiconductors/diode.ts:344 | Remove Math.min(vd/nVt,700) clamp |
| D-3 | AVAILABLE | - | src/components/semiconductors/diode.ts:492-514 | Rewrite MODEINITJCT dispatch per dioload.c:129-136 |
| D-4 | AVAILABLE | - | src/components/semiconductors/bjt.ts:1875-1881 | Store capbe/capbc/capsub (not CTOT) per bjtload.c:676-680 |
| D-5 | AVAILABLE | - | src/components/semiconductors/bjt.ts:1789 | Remove `dt > 0` from capGate (MODEINITSMSIG) |
| D-6 | AVAILABLE | - | src/components/semiconductors/bjt.ts:1875-1876 | Use `=== MODETRANOP` form for UIC branch |
| D-7 | AVAILABLE | - | src/components/semiconductors/bjt.ts:1507-1510 | Seed vbx (and vsub if subs) from rhsOld |
| D-10 | AVAILABLE | - | src/solver/analog/fet-base.ts + njfet/pjfet/mosfet | Split capGate into abstract `_capGate(ctx)` overrides |
| D-12 | AVAILABLE | - | src/components/passives/__tests__/capacitor.test.ts:301-323 | Fix test — single solver mock for both load() calls |
| D-13 | AVAILABLE | - | src/components/passives/__tests__/capacitor.test.ts:399-438 | Fix expected -7 → -3 |
| D-14 | AVAILABLE | - | src/components/passives/__tests__/inductor.test.ts:153-191 | Fix expected count 4 → 5 |

## Wave 5 — Complex device fixes

| ID | Status | Worker | File | Fix |
|----|--------|--------|------|-----|
| D-2a | AVAILABLE | - | src/components/semiconductors/diode.ts + tests | Delete SLOT_CAP_GEQ/IEQ; add SLOT_CAP_CURRENT w/ dual semantics; MODEINITSMSIG body |
| D-8 | AVAILABLE | - | src/components/semiconductors/mosfet.ts | Fix cgs_cgd_transient regression (DB junction cap companion); verbatim port from mos1load.c:789-795 + state-1 seeding |

## Wave 6 — Strengthening + verification

| ID | Status | Worker | File | Fix |
|----|--------|--------|------|-----|
| F-2 | AVAILABLE | - | spec/progress.md | Verify IMPLEMENTATION FAILURE entries per audit |
| G-* | AVAILABLE | - | src/**/__tests__/* (per review files) | Per-test strengthening using ngspice harness values |

---

## Dependencies

- Wave N blocks Wave N+1 only in the listed ordering rules; within a wave, tasks are independent unless they share a file.
- Shared file pairs (take file lock, coordinate via team-lead):
  - `bjt.ts`: A-3, A-4, D-4, D-5, D-6, D-7 — serialize via file lock.
  - `diode.ts`: D-1, D-2a, D-3 — serialize.
  - `mosfet.ts`: D-8, D-9, D-10-mosfet-part — serialize.
  - `fet-base.ts`: D-10, D-11 — serialize.
  - `sparse-solver.ts`: B-1, B-2 — serialize.
  - `sparse-solver.test.ts`: B-3, B-4 — serialize.
  - `dc-operating-point.ts`: C-6, C-7 — serialize.
  - `analog-engine.ts`: C-2, C-3 — serialize.
  - `capacitor.test.ts`: D-12, D-13 — serialize.
  - `capacitor.ts`: D-15 — lone.

## Completion ledger
- A-1 done by worker-1: Math.min(expArg,80) removed from all 4 sites in njfet.ts.
- A-2 done by worker-2: Math.min(expArg,80) removed from all 4 sites in pjfet.ts.
- A-3+A-4 done by worker-3: bjt.ts:55 comment deleted; bjt.ts:1516 "fallback" replaced with dispatch wording.
- C-2+C-3 done by worker-5: `statePool.analysisMode="tran"` deleted; `refreshElementRefs` + "defensive resync" comment deleted from _seedFromDcop. 3-statement port per dctran.c:346-350.
- E-2 done by worker-2: led.ts pnjlim gated on MODEINITJCT; seeds vdRaw=vcrit (or 0 if OFF) per dioload.c:133-136.
- C-5 done by worker-2: isDcop() now uses MODEDC mask. Caller audit clean.
- D-1 done by worker-7: Math.min(vd/nVt,700) clamp removed; raw Math.exp per dioload.c:247.
- D-3 done by worker-7: MODEINITJCT dispatch rewritten per dioload.c:130-138; added MODEINITFIX+OFF branch; removed pool.uic.
- D-2a done by worker-7: SLOT_CAP_GEQ/IEQ deleted; SLOT_CAP_CURRENT added w/ dual MODETRAN+MODEINITSMSIG semantics; MODEINITSMSIG block per dioload.c:362-374; schema 9→8 slots; test slot indices updated.
- B-1 done by worker-4: `_takePreFactorSnapshotIfEnabled()` extracted; called after `_applyDiagGmin` in both factorWithReorder and factorNumerical.
- B-2 done by worker-4: Misleading "Do NOT demand reorder" comment fixed.
- B-3 done by worker-4: sparse-solver.test.ts rawCtx migrated to cktMode bitfield.
- B-4 done by worker-4: WT-001/002/003 strengthened (needsReorder.toBe(true), singularRow exact index, initial-state comment fixed).

## Ambiguity log
(team-lead records unresolved ambiguities here.)
