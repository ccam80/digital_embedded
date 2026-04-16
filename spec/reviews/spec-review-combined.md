# Spec Review: Combined Report

## Overall Verdict: needs-revision

Per-phase reports at `spec/reviews/spec-phase-{0..7}.md`. 8 phases × 8 reviewers produced 18 critical, 39 major, 23 minor, and 10 info findings before cross-phase deduplication.

## Per-Phase Verdicts
| Phase | Verdict | critical | major | minor | info |
|-------|---------|----------|-------|-------|------|
| 0 — Sparse Solver Rewrite | needs-revision | 3 | 5 | 2 | 2 |
| 1 — Zero-Alloc Infrastructure | needs-revision | 2 | 5 | 2 | 1 |
| 2 — NR Loop Alignment | needs-revision | 3 | 5 | 3 | 1 |
| 3 — Numerical Fixes | needs-revision | 2 | 5 | 3 | 1 |
| 4 — DC-OP Alignment | needs-revision | 3 | 3 | 2 | 1 |
| 5 — Transient Step Alignment | needs-revision | 2 | 6 | 3 | 2 |
| 6 — Model Rewrites | needs-revision | 1 | 4 | 4 | 1 |
| 7 — Verification | needs-revision | 3 | 6 | 4 | 2 |

## Cross-Phase Findings

### X-D1 (critical) — Missing master plan Appendices A, B, C
Phase 1 §Task 1.1.1 references "plan Appendix A" (CKTCircuitContext fields). Phase 2 §Task 2.2.1 references "plan Appendix B" (cktLoad body). Phase 0 §Task 0.2.1 references "the plan's Appendix C" (SMPpreOrder). None exist in `spec/ngspice-alignment-master.md`.
- **Options**: (A) Delete all three Appendix references, keep inline definitions as canonical; (B) Add Appendices A, B, C to master plan as single source of truth

### X-D2 (critical) — solveGearVandermonde scratch conversion double-owned (Phase 1 ↔ Phase 3)
Phase 1 Task 1.2.1 and Phase 3 Task 3.2.3 both claim to rewrite `solveGearVandermonde` to accept a scratch param. Phase 3 acknowledges overlap but doesn't resolve ownership.
- **Options**: (A) Phase 1 owns conversion, Phase 3 adds only regression test; (B) Phase 3 owns conversion, Phase 1 only allocates buffer; (C) Delete Task 3.2.3, merge entirely into Phase 1

### X-D3 (critical) — E_SINGULAR continue-to-CKTload split across Phase 0 and Phase 2
Master plan resolved decision "E_SINGULAR → continue to CKTload (re-stamp + re-factor)" is partially addressed by Phase 0 Task 0.3.2 (structural change in newton-raphson.ts) but with a test that asserts `stampAll` is called twice — a function Phase 2 deletes. Phase 2 has no task explicitly covering the continue-to-CKTload behavior with the new `cktLoad` function.
- **Options**: (A) Keep Phase 0 structural change, add explicit Phase 2 task re-verifying with cktLoad; (B) Move entire E_SINGULAR fix to Phase 2 (after cktLoad exists); (C) Reword Phase 0 test to verify observable effect, not call count

### X-D4 (critical) — newtonRaphson signature migration split unclear across Phase 1/Phase 2
Master plan File Impact Summary assigns "newton-raphson.ts — Major rewrite, takes ctx, void return" to both Phase 1 and Phase 2. Phase 1 Task 1.1.2 explicitly covers it; Phase 2 references `ctx.noncon`, `ctx.elementsWithConvergence`, `ctx.loadCtx` without defining when the signature change lands. Phase 0 Task 0.3.2 test appears to assume the old NROptions-based interface.
- **Options**: (A) State Phase 1 delivers full signature migration; Phase 2 tasks assume ctx already in place; (B) Split signature migration: Phase 1 delivers partial, Phase 2 completes

### X-D5 (critical) — MNAAssembler field missing from CKTCircuitContext field list (Phase 1 ↔ Phase 2)
Phase 1 Task 1.1.1 field list omits `assembler: MNAAssembler`, but Phase 1 Task 1.1.2 and Phase 2 both reference `ctx.assembler`. Master plan resolved decision explicitly states "Hoisted to ctx in Phase 1." Without the field, Phase 1 Task 1.1.1 produces non-compilable class.
- **Options**: (A) Add `assembler: MNAAssembler` to Task 1.1.1 field list with constructor init; (B) Add to Task 1.1.2 Files to modify

### X-D6 (major) — element.accept() method introduced without interface definition (Phase 5 ↔ Phase 6)
Phase 5 Task 5.1.3 acceptance criterion references `element.accept()` as post-acceptance unified method. Phase 6 Task 6.1.2 interface lists `accept?(simTime, addBreakpoint)` with different signature than Phase 5 implies (which would need dt/method/voltages for companion updates).
- **Options**: (A) Expand Phase 6 accept() signature to absorb updateCompanion/updateState responsibilities; (B) Reword Phase 5 to use existing acceptStep method name

### X-D7 (major) — xfact addition targets wrong file (Phase 5)
Phase 5 Task 5.3.1 says "Add xfact to LoadContext" but Files to modify is `ckt-context.ts`. Phase 6 Task 6.1.1 places LoadContext in `load-context.ts`. Target mismatch.
- **Options**: (A) Move xfact addition entirely to Phase 6 Wave 6.1; (B) Fix Phase 5 Files-to-modify to reference load-context.ts with Phase 6.1 prerequisite

### X-D8 (major) — checkConvergence signature change not coordinated across phases
Phase 6 Task 6.1.2 changes `checkConvergence(voltages, prevVoltages, reltol, iabstol): boolean` → `checkConvergence(ctx: LoadContext): boolean`. Phase 2 NR-loop caller (which performs convergence checks) has no task covering the caller update. LoadContext interface in Phase 6 Task 6.1.1 doesn't include `reltol`/`iabstol` fields.
- **Options**: (A) Add reltol/iabstol to LoadContext in Phase 6.1.1 + explicit "Changed signatures" note in Task 6.1.2; (B) Add Phase 2 task covering NR caller update

### X-D9 (major) — Phase 5 Task 5.1.3 removes loops before Phase 6 element load() migration
Phase 5 Task 5.1.3 deletes `updateChargeFlux`, `stampCompanion`, `updateCompanion`, `updateState` loops. Phase 5 runs before Phase 6 Wave 6.2 (atomic element load() rewrite). Between Phase 5.1.3 and Phase 6.2 completion, all reactive elements have no companion stamping — every transient simulation is broken.
- **Options**: (A) Move Task 5.1.3 into Phase 6 Wave 6.3 (atomic deletion + replacement); (B) Reorder dependency graph: Phase 6.2 before Phase 5.1.3

### X-D10 (major) — Phase 4 ctx references assume Phase 1 complete without explicit prerequisite
Phase 4 Task 4.1.1 uses `ctx.noncon = 1` but current code uses options-object spread. Phase 4 Tasks 4.1.2–4.5.1 describe existing code with no ctx references. Phase 1 dependency not explicitly called out for each task.
- **Options**: (A) Add explicit "Requires Phase 1 complete" note to Phase 4 overview; (B) Resolve ctx usage task-by-task

### X-D11 (major) — computeIntegrationCoefficients deletion timing (Phase 1 ↔ Phase 3)
Phase 1 Task 1.2.1 deletes `computeIntegrationCoefficients` entirely. Phase 3 Task 3.2.2 fixes trap-order-2 in `integrateCapacitor`/`integrateInductor` but is silent on `computeIntegrationCoefficients` (which has the known `ag1: -ag0` bug). If Phase 3 runs before Phase 1, function remains broken; if after, already gone.
- **Options**: (A) Phase 3 prerequisites Phase 1 Task 1.2.1; (B) Phase 3 also fixes computeIntegrationCoefficients trap-2 (temporary fix before Phase 1 deletes)

### X-D12 (major) — Three-Surface Testing Rule applicability undefined across multiple phases
Phase 0, Phase 1, and Phase 2 reviews all flag that CLAUDE.md's Three-Surface Rule (headless API + MCP + E2E) is not addressed. Phases are engine-internal but modify user-observable numerical behavior. Applicability and gap-coverage strategy are phase-agnostic decisions.
- **Options**: (A) Global exemption for engine-internal phases, citing Phase 7 parity tests as E2E coverage; (B) Per-phase MCP/E2E regression test citations

### X-D13 (minor) — deltaOld type inconsistent across phases (Phase 1 ↔ Phase 5 ↔ Phase 6)
Phase 1 Task 1.1.1 uses invalid `number[7]`. Phase 6 Task 6.1.1 LoadContext defines `deltaOld: readonly number[]`. Phase 5 accesses `ctx.deltaOld[0]` and `[1]` as numbers.
- **Options**: (A) `Float64Array` (length 7) — requires updating computeNIcomCof/solveGearVandermonde API; (B) `number[]` pre-allocated length 7 — compatible with existing APIs; (C) 7-tuple — compile-time safety

### X-D14 (minor) — Tolerance contract for per-NR-iteration parity undefined (master plan vs Phase 7)
Master plan Verification Criteria state "IEEE-754 identical per-NR-iteration node voltages" and "match to 15 significant digits." Phase 7 Task 7.1.1 uses "zero tolerance (exact IEEE-754 match)" but per-task criteria say "15 significant digits." These are different.
- **Options**: (A) Unify as exact IEEE-754 throughout; (B) Define concrete tolerance pair (relTol=1e-14, absTol=1e-12); (C) Two-tier: rhsOld uses 1e-14 relTol, state0[] uses per-slot tolerances

### X-D15 (minor) — LTE zero-alloc coverage gap (Phase 1 governing principle)
Master plan principle 2 requires zero allocations in hot paths. Phase 1 coverage excludes LTE path (`ckt-terr.ts`, per-accepted-step). Phase 3 touches `ckt-terr.ts` for formula fixes but doesn't audit allocations. No phase owns LTE zero-alloc.
- **Options**: (A) Add LTE audit task to Phase 1 (new Task 1.2.3); (B) Explicitly defer to Phase 3 with added task; (C) Confirm LTE already allocation-free (spec note)

## Combined Mechanical Fixes
(Consolidated across all phases)

| ID | Severity | Phase | Location | Problem | Proposed Fix |
|----|----------|-------|----------|---------|--------------|
| P0-M1 | major | 0 | §Task 0.2.1 Description | Dangling "plan's Appendix C" reference | Delete sentence — algorithm described inline |
| P1-M1 | minor | 1 | §Task 1.2.2 Files to modify | Line-number anchor "analog-engine.ts:347" fragile | Replace with code-fragment anchor: "the `elements.filter(isPoolBacked)` call inside `refreshElementRefs`" |
| P2-M1 | major | 2 | §Task 2.2.2 Tests | "Existing MNA end-to-end tests must pass" is not a test spec | Replace with explicit migration directive (see phase-2 report) |
| P2-M2 | minor | 2 | §Task 2.2.2 Files to modify | "Delete or migrate" ambiguous | Move to "Files to delete or migrate" with explicit outcome |
| P3-M1 | minor | 3 | §Task 3.1.3 title + V3/V4 labels | Title says cktTerrVoltage but V3/V4 describe cktTerr paths | Retitle to "Fix cktTerr and cktTerrVoltage formulas"; prefix each sub-bug with target function |
| P3-M2 | minor | 3 | §Task 3.2.3 Files to modify | solveGearVandermonde caller (computeNIcomCof) not listed | Add: "Update computeNIcomCof signature to accept scratch: Float64Array and thread into solveGearVandermonde call" |
| P5-M1 | major | 5 | §Task 5.2.1 | "timestep.ts:402" is in accept(), not getClampedDt() | Change description to "timestep.ts `accept()` (line 402) — breakpoint hit detection in the breakpoint-pop loop"; remove implication that fix is in getClampedDt() |
| P5-M2 | minor | 5 | §Task 5.1.1 | "Delete BDF-2 history push loop" ambiguous target | Clarify: "Delete the reactive-element terminal-voltage history push loop (feeds this._history for checkMethodSwitch, also being deleted)" |
| P6-M1 | minor | 6 | §Task 6.2.4 Description | Says "12 elements" but lists 9 files + 1 base | Change to "9 elements" or enumerate full 12 |
| P7-M1 | minor | 7 | §Task 7.1.1 Tests | Self-referential vacuous sentence | Replace with: "parity-helpers.ts contains no independently-runnable tests; helper correctness is transitively validated through Tasks 7.2.1–7.4.1" |

## Decision-Required Items Summary

**18 critical + 39 major + 23 minor** decision-required items across all phases and 15 cross-phase items. Full details in each `spec/reviews/spec-phase-{n}.md`. Highlights:

**Critical (architectural/blocking):**
- Phase 0: Ambiguous persistent linked-list scope; "linked L/U structure" undefined; E_SINGULAR test unverifiable
- Phase 1: LTE coverage gap; MNAAssembler field missing from CKTCircuitContext
- Phase 2: Missing E_SINGULAR-to-CKTload task; missing signature migration task; pnjlim formula inconsistency
- Phase 3: solveGearVandermonde ownership conflict with Phase 1; Task 3.1.3 scope ambiguous
- Phase 4: ctx references assume Phase 1 complete; Task 4.1.2 contradicts existing test; Task 4.2.1 self-contradicting
- Phase 5: `_updateMethodForStartup()` removal breaks tryOrderPromotion(); Task 5.1.3 deletes loops before Phase 6 replacements
- Phase 6: behavioral-flipflop/t.ts missing from Task 6.2.6
- Phase 7: Tolerance contract contradiction; state0[] match not required; noncon/diagGmin/srcFact only partial

**Major (implementation-blocking but resolvable):**
- Dangling cross-references (Appendix A, B, C in master plan)
- Interface signatures undefined (parity-helpers.ts, checkConvergence migration, element.accept())
- Missing circuit fixtures/parameters in Phase 7
- Three-Surface Testing Rule applicability unresolved

## Recommended Resolution Order

Given 15 cross-phase items, ~18 criticals, and tightly coupled dependencies:

1. **Resolve X-D1 through X-D5 first** — these are foundation-level contract issues (master plan appendices, cross-phase ownership, interface boundaries) that determine how individual phase items resolve.
2. **Then resolve per-phase critical items** that survive cross-phase resolution.
3. **Mechanical fixes** (10 items) can be applied in a single batch.
4. **Minor/info items** can be deferred or batched.

Overall verdict: **needs-revision**. The ngspice alignment work is architecturally sound at the master plan level, but individual phase specs have substantial gaps at phase boundaries, missing appendices, and undefined interfaces that would block implementation as written.
