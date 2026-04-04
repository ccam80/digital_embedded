# Spec Review: Analog State Pool & Write-Back Removal — Combined Report

## Overall Verdict: needs-revision

## Summary
| Dimension | Issues |
|-----------|--------|
| Consistency | 4 |
| Completeness | 5 |
| Concreteness | 6 |
| Implementability | 6 |

## Cross-Reference Verification

All 10 write-back locations verified against codebase — spec claims are accurate.
MOSFET/JFET instance-field pattern confirmed. No existing StatePool infrastructure.
Convergence contamination mechanism confirmed in `newton-raphson.ts:315-332`.
Broken rollback confirmed in `analog-engine.ts:212` (voltages restored, device state not).

## Blocking Issues (must fix before implementation)

### 1. Inductor slot layout is wrong
**Location:** Per-device slot layouts, Capacitor/Inductor table
**Problem:** Slot 2 named `V_PREV` for both capacitor and inductor. Actual inductor saves `iPrev` (branch current), not terminal voltage. Implementing as written breaks inductor companion model.
**Suggestion:** Inductor slot 2 -> `I_PREV`. Provide separate slot tables for capacitor and inductor.

### 2. Phase 6 pseudocode diverges from actual engine step()
**Location:** Checkpoint/rollback integration section
**Problem:** Spec stamps companions once before NR retry loop. Actual code re-stamps inside each retry. Following spec literally breaks retry path. Also, rollback semantics don't distinguish NR retry (restore state0 only) from LTE rejection (may need different restore scope).
**Suggestion:** Update pseudocode to match actual re-stamp-per-retry structure. Add separate rollback descriptions for NR retry vs LTE rejection.

### 3. StateCheckpoint ownership unspecified
**Location:** StatePool class design
**Problem:** `checkpoint()` doesn't state whether it copies `state0` or holds a reference. If reference, `rollback()` is a no-op.
**Suggestion:** Explicitly state `checkpoint()` copies via `new Float64Array(this.state0)`.

### 4. No test strategy at all
**Location:** Entire spec
**Problem:** Zero test descriptions despite claiming "5 test files, +80 LOC". Three-Surface Testing Rule (CLAUDE.md) entirely unaddressed. No unit tests for StatePool, no write-back-elimination assertions, no convergence regression tests, no MCP/E2E surface tests.
**Suggestion:** Add a testing section per phase with specific assertions. At minimum: StatePool unit tests, per-device write-back-elimination checks, convergence regression suite, one MCP tool test, one E2E test.

## Quality Issues (should fix for better implementation)

### 5. Varactor slot layout missing
**Location:** Phase 3 migration table
**Problem:** Varactor listed as stateSize 7 but no slot table provided. Implementer must guess whether it mirrors Diode's 7-slot layout exactly.
**Suggestion:** Add explicit Varactor slot table (or state it shares Diode's layout if true).

### 6. JFET stateSize unspecified
**Location:** Phase 4
**Problem:** MOSFET slot table shown (stateSize 12) but JFET not addressed. JFET may not use all capacitance slots.
**Suggestion:** State whether JFET shares MOSFET's 12-slot layout or uses a subset.

### 7. `_swapped` missing from Phase 4 getter/setter migration
**Location:** Phase 4 code snippet
**Problem:** MOSFET slot table includes SWAPPED (slot 5), but getter/setter example omits it. Implementer will leave `_swapped` as a plain field, breaking rollback for swap state.
**Suggestion:** Add `_swapped` getter/setter to the code snippet.

### 8. `Readonly<Float64Array>` scope ambiguous
**Location:** Modified AnalogElement interface section
**Problem:** Spec narrows `updateOperatingPoint` parameter but doesn't clarify that `mna-assembler.ts` call-site must remain mutable (NR damping/line-search writes to `voltages[]`).
**Suggestion:** State explicitly: assembler signature stays `Float64Array`; only device implementations receive `Readonly<Float64Array>`.

### 9. `acceptTimestep()` copy-vs-swap ambiguous
**Location:** StatePool class design
**Problem:** "Rotate history: state2 <- state1 <- state0" could mean data copy or reference swap.
**Suggestion:** State the mechanism: either `state2.set(state1); state1.set(state0)` or pointer rotation with array reuse.

### 10. Diac excluded from migration but has rollback-vulnerable state
**Location:** "Devices already correct" table
**Problem:** Diac uses closure vars `_v`, `_geq`, `_ieq` — no write-back, but also no pool migration planned. After migration, Diac state won't participate in checkpoint/rollback.
**Suggestion:** Either add Diac to Phase 3 migration or explicitly justify its exclusion.

### 11. DC source-stepping path not addressed
**Location:** DC operating point integration section
**Problem:** Source-stepping runs multiple NR sub-solves. Failed sub-solves write into `state0` but spec doesn't address checkpoint/rollback during source-stepping.
**Suggestion:** Add a note on whether checkpoint/rollback applies to DC source-stepping retries.

### 12. `getLteEstimate` not addressed in Phase 5
**Location:** Phase 5 (reactive passives)
**Problem:** Capacitor's `getLteEstimate` reads `this.geq` and `this.vPrev`. After pool migration these must read from pool. Spec doesn't mention updating this method.
**Suggestion:** Add `getLteEstimate` to the Phase 5 migration scope.

### 13. `initState` / `setParam` hot-reload interaction unspecified
**Location:** Phase 1 interface changes
**Problem:** Project requires all params be hot-loadable via `setParam`. Spec doesn't address whether `initState` is idempotent or what happens on recompilation.
**Suggestion:** State that `initState` is called once per compile and is idempotent.

## Informational

### 14. Phase 1 has no acceptance criteria
Phase 1 creates infrastructure but defines no completion signal. Recommend adding: "compiler allocates correct total slots; elements with stateSize 0 get stateBaseOffset -1."

### 15. Phase 3 has no per-device acceptance criteria
Nine devices migrated with "same pattern as diode" — no per-device verification. Recommend at minimum: "after updateOperatingPoint, voltages array is unchanged."

## Per-Phase Details

Full per-phase report: `spec/reviews/spec-analog-state-pool.md`
