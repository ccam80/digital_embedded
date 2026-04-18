# ngspice Alignment — Implementation Progress

**Plan:** `spec/plan.md` (main plan); `spec/phase-catchup.md` (remediation phase external to main plan)
**Started:** 2026-04-17
**Last consolidated:** 2026-04-18

> **READ THIS BEFORE ACTING ON ANY TASK STATUS.** The narrative per-task log that was previously accumulated in this file has been deleted, as it contained many "complete" items that were delivered incorrectly. This file now reflects **verified** status — what was genuinely delivered, what was delivered incorrectly, and what was never attempted. 

## Legend

- **complete** — code matches spec and verified by phase review. No outstanding issues.
- **failed** — phase review found the work was incomplete, incorrect, or left sibling files broken. Remediation lives in `spec/phase-catchup.md`.
- **not started** — never attempted. Waiting on dependencies or a scheduled wave.
- **blocked** — dependency not complete; cannot start yet.

## Status Summary by Phase

### Phase 0 — Sparse Solver Rewrite

| Task | Status | Catchup owner | Notes |
|---|---|---|---|
| 0.1.1 Handle-based stamp API | complete | — | Handle-based `allocElement`/`stampElement` API in place. The value-addressed `stamp(row, col, value)` wrapper was retained; its deletion is Task 6.3.4 → catchup C5.1. |
| 0.1.2 Drop AMD ordering | complete | — | |
| 0.1.3 CSC from linked L/U | complete | — | |
| 0.2.1 SMPpreOrder | complete | — | Includes subsequent `phase0-v03-v04-swapcols` remediation. |
| 0.3.1 forceReorder lifecycle | complete | — | |
| 0.3.2 E_SINGULAR recovery | complete | — | |
| 0.4.x Complex sparse solver parity (Wave 0.4) | not started | — | Independent of 0.1–0.3. Runs in parallel with Wave 6. |

Phase 0 review notable items (not listed above because they're not Phase 0 task failures):
- Phase 0 V-01 (`sparse-solver.test.ts` calling deleted element methods) → catchup **C3.5**.
- Phase 0 V-02 ("fallback" banned word in `newton-raphson.ts:262` JSDoc) → catchup **C9.1**.

### Phase 1 — Zero-Alloc Infrastructure

| Task | Status | Catchup owner | Notes |
|---|---|---|---|
| 1.1.1 CKTCircuitContext god-object | **failed** | C6.1 | Ctx created, but `analog-engine.ts` was never stripped of `_voltages` / `_prevVoltages` / `_agp` / `_nodeVoltageHistory`. Spec required single-field `_ctx` with all IO routed through it; current code maintains parallel buffers synced via `.set()`. |
| 1.1.2 newtonRaphson ctx conversion | complete | — | |
| 1.1.3 solveDcOperatingPoint ctx conversion | **failed** | C6.2, C6.3, C6.4, C6.5 | Core conversion landed, but four zero-alloc / correctness sub-violations remain: `DcOpResult.reset()` reallocates the diagnostics array every call; `cktncDump` allocates on every failure path; `CKTCircuitContext` constructs an orphan `SparseSolver` the engine then replaces; DC-OP failure path resets `dcopResult.method = "direct"` instead of reflecting the last strategy tried. |
| 1.2.1 Integration zero-alloc | complete | — | |
| 1.2.2 Per-step closure elimination | complete | — | |
| 1.2.3 LTE path allocations | complete | — | |
| part-a cascade caller migration | complete | — | 19 production + test files migrated to `solveDcOperatingPoint(ctx)`. |
| 1.1-fix (batch-2 verifier remediation) | complete | — | |

Additional Phase 1 catchup items (found by review, not in original task list):
- Dead `rawMaxIter` tautological ternary at `newton-raphson.ts:276-278` → catchup **C6.6**.
- 5 historical-provenance / dead-reference comments in `ckt-load.test.ts`, `test-helpers.ts`, `newton-raphson.test.ts`, `analog-engine.ts` → catchup **C9.2**.
- 2 weak tests in `ckt-context.test.ts` (element-list `toBeGreaterThan(0)` without content verification; `zero_allocations_on_reuse` not exercising NR) → currently unassigned; add to C4 or C8 if user wants tightened. *(Out of current catchup scope — flag for future if desired.)*

### Phase 2 — NR Loop Alignment

| Task | Status | Catchup owner | Notes |
|---|---|---|---|
| 2.1.1 pnjlim (ngspice DEVpnjlim) | complete | — | |
| 2.1.2 fetlim formula fix | complete | — | |
| 2.1.3 hadNodeset gate | complete | — | |
| 2.2.1 cktLoad function | **failed** | C7.1 | Single-pass body is correct, but the nodeset-stamping block drops the `srcFact` scaling that ngspice `cktload.c:96-136` applies, and initial-conditions (`ctx.ics`) are never stamped. Both regressions vs. the helper it replaced and vs. ngspice. |
| 2.2.2 Delete MNAAssembler | complete | — | |
| 2.2.3 E_SINGULAR continue-to-cktLoad | complete | — | |
| 2.2_6.3-fix (batch-5 verifier remediation) | complete | — | xfact guard removed; E_SINGULAR recovery test rewritten with proxy solver. |

Additional Phase 2 catchup items:
- Dead `applyNodesetsAndICs` function + its 5 tests (retained but unreachable from production after cktLoad) → catchup **C7.2** (delete per Q2/rules scorched-earth).
- 2 historical-provenance comments (`newton-raphson.ts:50` stampAll ref; `ckt-load.ts:2` MNAAssembler ref) → catchup **C9.3**.
- 3 weak tests in `ckt-load.test.ts` (`Number.isFinite`-only assertions) → folded into C4 (parity tests supersede) and C8.

### Phase 3 — Numerical Fixes

| Task | Status | Catchup owner | Notes |
|---|---|---|---|
| 3.1.1 chargetol formula (Bug C1) | complete | — | |
| 3.1.2 GEAR LTE factor (Bug C2) | complete | — | Scope-creep test `gear_lte_factor_order_5` kept per explicit decision. |
| 3.1.3 cktTerr/cktTerrVoltage V3-V6 | complete | — | |
| 3.2.1 NIcomCof trap order 2 rounding | **failed** | C4.6 | Formula change applied, but required differential test `nicomcof_trap_order2_matches_ngspice_rounding` (xmu=1/3 to distinguish rounding paths) was never written. The only existing trap-order-2 test uses xmu=0.5 + `toBeCloseTo` — cannot detect regressions of the rounding change. |
| 3.2.2 NIintegrate trap order 2 ccapPrev | **failed** | C4.6 | Target functions `integrateCapacitor`/`integrateInductor` were subsequently deleted in Task 6.3.2; the acceptance criterion ("all xmu values match ngspice") has no live code path. Required test `trap_order2_ccap_with_nonstandard_xmu` also missing. Catchup retargets the test to element-level inline NIintegrate (C4.6). |
| 3.2.3 Gear Vandermonde regression test | complete | — | |

Additional Phase 3 catchup items:
- 14 `toBeCloseTo` call sites across GEAR orders 2-6, BDF-1/2, trap orders 1-2, HistoryStore in `integration.test.ts` → catchup **C8.1**.
- 9 weak `toBeGreaterThan(0)`+`isFinite`-only tests in `ckt-terr.test.ts` → catchup **C8.2**.
- 4 historical-provenance comments + banned word "fallback" across `ckt-terr.ts`, `ckt-terr.test.ts`, `integration.test.ts` → catchup **C9.4**.

### Phase 4 — DC-OP Alignment

| Task | Status | Catchup owner | Notes |
|---|---|---|---|
| 4.x all tasks | blocked | — | Depends on Phase 2 Wave 2.1 (done) and Phase 1 (see failed items). Cannot start until Phase 1 and catchup finish. |

### Phase 5 — Transient Step Alignment

| Task | Status | Catchup owner | Notes |
|---|---|---|---|
| 5.x all tasks | blocked | — | Depends on Phase 4. |

### Phase 6 — Model Rewrites

| Task | Status | Catchup owner | Notes |
|---|---|---|---|
| 6.1.1 LoadContext interface | complete | — | |
| 6.1.2 AnalogElement interface redesign | **failed** | C1.1 | `src/solver/analog/element.ts` was migrated, but the sibling interface `src/core/analog-types.ts::AnalogElementCore` was never touched. Spec was explicit: "Two sibling interfaces with different method sets is a shim by construction — both must reflect the post-Wave-6.1 shape atomically." `AnalogElementCore` still carries the full pre-migration split method set (`stamp`, `stampNonlinear`, `updateOperatingPoint`, `stampCompanion`, `stampReactiveCompanion`, `updateChargeFlux`, `updateState`, `updateCompanion`, `shouldBypass`, `getBreakpoints`, 4-arg `checkConvergence`). No `load(ctx)`. |
| 6.2.a Passive linear + bridge/probes/switches | complete | — | All 11 files audited — `load(ctx)` present, no banned element-class methods. |
| 6.2.b Reactives + sources + controlled sources | complete | — | All element-class surfaces migrated. Test-side fallout (`controlled-source-base.test.ts` calling deleted methods) flagged for 6.3.1. |
| 6.2.c BJT / FET / schottky | **failed** | C2.1, C2.2, C2.3 | `createSpiceL1BjtElement` in `bjt.ts` migrated, and FET base classes carry `load(ctx)`. But `fet-base.ts`, `mosfet.ts`, `diode.ts`, `varactor.ts`, `tunnel-diode.ts`, `led.ts`, `digital-pin-model.ts` still import and call the now-deleted `integrateCapacitor`. These modules fail to load at runtime. The task's acceptance criterion "No calls to `integrateCapacitor()` from element code" was not met. |
| 6.2.d Active + behavioral | complete | — | 21 files audited — all carry `load(ctx)`, no banned element-class methods. Test-side fallout flagged for 6.3.1. |
| 6.3.1 Rewrite test mock elements | **failed** | C3.1, C3.2, C3.3, C3.4, C3.5, C3.6 | Canonical mock factory in `test-helpers.ts` still returns `{stamp, stampNonlinear, updateOperatingPoint}` with no `load`. Test files still driving elements through deleted methods: `controlled-source-base.test.ts` (4 sites), `behavioral-flipflop.test.ts` (~13), `behavioral-sequential.test.ts` (~6), `behavioral-remaining.test.ts`, `behavioral-flipflop-variants.test.ts`, `behavioral-integration.test.ts::flushQ`, `fet-base.test.ts` (15), `dcop-init-jct.test.ts` (10), `varactor.test.ts` (6, some with `as any` casts), `sparse-solver.test.ts` (4, incl. method-presence sniffs), `behavioral-flipflop-engine-dispatch.test.ts` (entire file obsolete). |
| 6.3.2 Delete integrateCapacitor/integrateInductor | **failed** | C2.1, C2.2, C2.3, C2.4 | Symbols deleted from `integration.ts` and a `integrateCapacitor_does_not_exist` export-check test landed. But 7 production files still import them — modules will throw at load. The unit test creates false-green coverage. |
| 6.3.3 Delete engine-side companion/charge/state loops | complete | — | `analog-engine.ts` free of the four post-NR loops; `preIterationHook` closure gone; `ctx.loadCtx.xfact` assignment present. |
| 6.3.4 Delete SparseSolver.stamp(row, col, value) | not started | C5.1 | Not attempted. `stamp` still exists; ~50+ callers across passive elements + `test-helpers.ts::G()` wrapper still use it. |
| 6.4.x Digital pin models | not started | C2.4 | Wave 6.4 pulled forward into catchup (Q1 decision) so `digital-pin-model.ts` ships its `load(ctx)`/`accept(ctx, voltage)` migration atomically with the broken-import fix. Tasks 6.4.1 → 6.4.4 execute as one atomic task (C2.4). |

Additional Phase 6 catchup items (spec-required work identified by review but not tracked as its own task here):
- Missing parity tests from Task 6.2.1 (6 passive DC-OP) → **C4.1**.
- Missing parity tests from Task 6.2.2 (8 reactive transient) → **C4.2**.
- Missing parity tests from Task 6.2.3 (semiconductor family + `buckbjt-convergence.test.ts`) → **C4.3**.
- Missing parity tests from Task 6.2.4 (source parity) → **C4.4**.
- Missing parity tests from Task 6.2.5 (10 active elements) → **C4.5**.
- `resistor_load_interface` test missing from `mna-end-to-end.test.ts` → **C4.1**.
- Historical-provenance / narrative / TODO comments across `test-helpers.ts`, `behavioral-flipflop-engine-dispatch.test.ts`, `behavioral-remaining.test.ts`, `core/analog-types.ts`, `netlist-generator.ts` → **C9.5**.
- Varactor inverse-correctness assertion (`expect(v.stampCompanion).toBeDefined()`) → **C8.4** / **C3.5**.
- `integrateCapacitor_does_not_exist` test strengthening (static-verify no production imports) → **C8.3**.

### Phase 7 — Verification

| Task | Status | Catchup owner | Notes |
|---|---|---|---|
| 7.x all tasks | blocked | — | Depends on all prior phases. |

## Catchup Phase (phase_catchup)

See `spec/phase-catchup.md` for the full remediation spec. Waves:

| Wave | Scope | Depends on |
|---|---|---|
| C1 | `AnalogElementCore` interface migration | — |
| C2 | Production integrate-helper migration + Wave 6.4 pull-forward | C1 |
| C3 | Test-side migration to `load(ctx)` | C1, C2 |
| C4 | Missing spec-required parity tests | C2, C3 |
| C5 | `SparseSolver.stamp(row, col, value)` deletion (Task 6.3.4) | C2 |
| C6 | Phase 1 buffer consolidation + zero-alloc fixes | C1 |
| C7 | cktLoad srcFact + IC stamping + dead code removal | C1 |
| C8 | Test assertion hardening | C1 |
| C9 | Mechanical cleanup | all of the above |

All catchup tasks carry the tests-red protocol: if a spec-exact test detects real divergence when the code is to-spec, surface the divergence to the user rather than softening assertions.

## Implementer Reminders


- **Do not re-attempt "complete" tasks** to re-verify them. They were verified by dedicated review agents; re-running the verification burns context. If you discover a divergence, flag it — do not silently redo.
- **Task log appends** go under `## Task Log — phase_catchup` in a new file `spec/progress-catchup.md`, created by the first catchup implementer.