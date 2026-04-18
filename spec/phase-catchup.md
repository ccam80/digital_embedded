# phase_catchup: Review-Finding Remediation

## Overview

External catchup phase remediating every finding from the five phase reviews (`spec/reviews/phase-{0,1,2,3,6}.md`) at 100% ngspice-equivalence. Sibling to the main `plan.md`, not embedded in it. Completion of this phase is a hard prerequisite for Phase 4 (DC-OP alignment) start.

## Governing Rules (read before any task)

1. **Full-spec only.** No deferral, no "pragmatic alternative", no scope reduction. If the original spec was not executed as written, this phase finishes it as written.
2. **100% ngspice-equivalent.** Any SPICE-derived algorithm cites an ngspice source file + function. Bit-exact against the reference where the reference exists.
3. **Tests-red is the desired outcome** when the code is to-spec and the test detects real divergence. If a spec-exact test fails after the implementer completes the task as written, the implementer **must surface that failure to the user** — not soften assertions, not weaken tolerances, not relax `toBe` to `toBeCloseTo`, not add `?.` guards, not cast with `as any`. Tight tests stay tight.
4. **No test-chasing.** Code changes whose primary purpose is making a test pass rather than implementing the specified architecture are banned. Fix architecture; surface red tests to the user.
5. **Low file spread per task.** If a task grows past ~8 files or looks like it needs new sub-structure, stop and ask for re-scoping. Atomic-gate tasks (C1, C2.4, C5) explicitly exceed this limit and are flagged as such.
6. **Cross-wave breakage carve-out.** Sibling waves ship serially per the dependency graph; tsc/test breakage in files owned by a not-yet-started wave is expected. Each task lists "Surrounding state while this task is in flight" so implementers recognise which failures are expected vs. caused by their work.

## Wave Dependency Graph

```
C1 (interface) ──► C3 (test-side) ──► C4 (parity tests)
                                  ▲
C2 (production+6.4) ──────────────┘
C2 ──► C5 (SparseSolver.stamp deletion)

C6 (Phase 1 zero-alloc)     — parallel with C3/C4 after C1
C7 (cktLoad parity)         — parallel with C3/C4 after C1
C8 (test hardening)         — parallel with C3/C4 after C1
C9 (mechanical cleanup)     — last; runs after every other wave to avoid churn
```

**Reference-impact ordering.** C1 ships first because every later wave consumes the `AnalogElementCore` shape. C2 ships as early as possible because 7 production modules currently fail to load (importing deleted symbols); until C2 lands, any real runtime test is pointless. C5 is gated behind C2 to avoid conflict on the same element files. C9 runs last so its mechanical edits don't churn files that earlier waves rewrite.

## plan.md Retroactive Updates

The following items land in `spec/plan.md` as part of this phase (not as individual tasks below):

- **Appendix B (cktLoad pseudocode)**: update Step 4 to stamp **both nodesets and ICs** with `srcFact` scaling, matching ngspice `cktload.c:96-136`. The current Appendix B shows only nodesets without `srcFact` — that matches the buggy current implementation, not ngspice. Owner: Task C7.1 implementer updates Appendix B as part of their commit.

---

## Wave C1: AnalogElementCore Interface Migration

**Goal.** Complete Task 6.1.2 as originally written. `src/core/analog-types.ts::AnalogElementCore` and `src/solver/analog/element.ts::AnalogElement` must be identical in method surface; the spec is explicit that "two sibling interfaces with different method sets is a shim by construction".

**Why first.** Every test file migrating in C3 references `AnalogElementCore` (directly or via element implementations that implement it). Every element file rewritten in C2 implements both interfaces. Until C1 lands, migrating anything else means fighting against an old type that still declares the deleted methods.

**Surrounding state while C1 is in flight.** `tsc --noEmit` is red. Element files implementing `load()` (Wave 6.2 output) plus their test files both reference methods that no longer exist on the interface. That is the baseline this wave inherits.

### Task C1.1: Migrate AnalogElementCore to the post-Wave-6.1 shape

- **Description**: Replace `AnalogElementCore` with the same method surface as `AnalogElement` (see `src/solver/analog/element.ts`). Remove `stamp`, `stampNonlinear`, `updateOperatingPoint`, `stampCompanion`, `stampReactiveCompanion`, `updateChargeFlux`, `updateState`, `updateCompanion`, `shouldBypass`, `getBreakpoints`. Add `load(ctx: LoadContext): void`. Change `checkConvergence?(voltages, prevVoltages, reltol, abstol): boolean` to `checkConvergence?(ctx: LoadContext): boolean`. Add `accept?(ctx: LoadContext, simTime: number, addBreakpoint): void`. Delete the JSDoc blocks that describe deleted methods (including every "True if this element implements stampX" doc on `isNonlinear`/`isReactive` — retarget those doc strings to describe the current semantics of those flags without naming a deleted method).

- **Files to create**: none

- **Files to modify**:
  - `src/core/analog-types.ts` — replace `AnalogElementCore` body (lines 115–243+ in the current file) with the post-Wave-6.1 interface. Import `LoadContext` from `../solver/analog/load-context.js`. Update JSDoc to remove every reference to deleted methods.

- **Files to audit (expected to type-check clean after this task)**:
  - All ~65 analog element factories that return an `AnalogElementCore`-shaped object. If any element factory is still exporting a shape that includes a deleted method, that element was incompletely migrated in Wave 6.2 and must be finished here.

- **Tests**:
  - `src/solver/analog/__tests__/element-interface.test.ts::AnalogElementCore::has_load_method` — import `AnalogElementCore`, assert (via a structural-typing test fixture) that a minimal implementation carrying only `load` + required readonly fields type-checks.
  - `src/solver/analog/__tests__/element-interface.test.ts::AnalogElementCore::rejects_deleted_methods` — assert that a fixture declaring `stamp()`/`stampNonlinear()`/`updateOperatingPoint()` as properties **fails** `tsc` against `AnalogElementCore` (ts-expect-error guards — compile-time negative assertion).
  - `src/solver/analog/__tests__/element-interface.test.ts::AnalogElementCore::checkConvergence_is_single_arg` — assert that a fixture implementing `checkConvergence(voltages, prev, reltol, abstol)` fails; a fixture implementing `checkConvergence(ctx: LoadContext)` passes.

- **Acceptance criteria**:
  - `AnalogElementCore` method surface bit-identical to `AnalogElement` method surface (ignoring `pinNodeIds` / `allNodeIds` which Core excludes by design).
  - Grep `stamp\s*\(|stampNonlinear\s*\(|updateOperatingPoint\s*\(|stampCompanion\s*\(|stampReactiveCompanion\s*\(|updateChargeFlux\s*\(|updateState\s*\(|updateCompanion\s*\(|shouldBypass\s*\(|getBreakpoints\s*\(` in `src/core/analog-types.ts` returns zero matches.
  - Full-codebase `tsc --noEmit` **succeeds for all production element files**. Test files are expected to remain red until C3.

- **Tests-red protocol**: if any production element file fails `tsc` after this task, that element was left on the split interface by Wave 6.2 and must be finished in this task. Do not revert C1; fix the element.

---

## Wave C2: Production Integrate-Helper Migration + Wave 6.4 Pull-Forward

**Goal.** Zero production imports of the deleted `integrateCapacitor` / `integrateInductor`. All reactive-device integration runs inline via `ctx.ag[]` matching the ngspice `NIintegrate` macro in `niinteg.c:28-63`.

**Why.** Seven production modules currently import a symbol that no longer exists. Any runtime test of the engine fails at module-load. Task 6.3.2 acceptance explicitly required "no element imports them".

**Wave 6.4 pull-forward rationale.** `digital-pin-model.ts` is one of the seven broken importers and is Wave 6.4 territory. Per the atomic-migration gate in plan.md, the legacy pin-model methods (`stamp`, `stampOutput`, `stampCompanion`, `updateCompanion`) must be deleted atomically with the `load()`/`accept()` rewrite — so fixing `digital-pin-model.ts`'s `integrateCapacitor` imports in isolation would leave the file in an illegal intermediate state. C2.4 executes the full Wave 6.4 body in one task.

**Surrounding state while C2 is in flight.** After C1 lands, only the 7 files listed below have broken imports; everything else type-checks for production code. Test files remain red until C3 (C3 ships after C2).

### Task C2.1: fet-base.ts inline NIintegrate migration

- **Description**: Replace all 6 `integrateCapacitor(...)` calls in `src/solver/analog/fet-base.ts` with inline `NIintegrate` expansions using `ctx.ag[]`. Pattern per ngspice `niinteg.c:28-63` (trap and BDF orders 1–6): `ccap = ag[0]*q0 + ag[1]*q1 + … + ag[order]*q_order`, `geq = ag[0] * cap_equiv`. Junction charges are already stored in state slots — read them directly from `ctx.statePool` at the per-iteration offsets.

- **Files to create**: none

- **Files to modify**:
  - `src/solver/analog/fet-base.ts` — delete `integrateCapacitor` import (line 22). Replace 6 call sites (lines 512, 531, 597, 606, 926 per review) with inline integration. `ctx.ag[]` is populated by the engine before each `load()` call — consume it directly.

- **Tests**:
  - `src/solver/analog/__tests__/fet-base.test.ts::integration::trap_order2_xmu_nonstandard_no_helper` — transient simulation of a MOS capacitor (Cgs) through fet-base's integration path, with custom `xmu=0.3`, verifying `ccap` matches the ngspice formula `ag0*(q0-q1) + ag1*ccapPrev` where `ag1 = xmu/(1-xmu)`. Bit-exact `toBe`.
  - `src/solver/analog/__tests__/fet-base.test.ts::integration::no_integrateCapacitor_import` — static import-graph assertion: parse the source text of `fet-base.ts` and assert zero matches for `integrateCapacitor`.

- **Acceptance criteria**:
  - Grep `integrateCapacitor|integrateInductor` in `src/solver/analog/fet-base.ts` = 0 matches.
  - File type-checks clean against `AnalogElement` and `AnalogElementCore`.
  - `fet-base.test.ts` tests that previously failed due to the broken import now run (they may still be red for other reasons — see C3.4).

### Task C2.2: mosfet.ts inline NIintegrate migration

- **Description**: Same pattern as C2.1 applied to `src/components/semiconductors/mosfet.ts`. 6 call sites (lines 1699, 1731, 1772, 1883, 1911, 1926).

- **Files to modify**:
  - `src/components/semiconductors/mosfet.ts` — delete import (line 48). Replace 6 call sites with inline NIintegrate.

- **Tests**:
  - `src/components/semiconductors/__tests__/mosfet.test.ts::integration::cgs_cgd_transient_matches_ngspice_mos1` — transient of a MOSFET with Cgs+Cgd, compare accepted-step voltages bit-exact against an ngspice MOS1 reference (use existing `test-baseline.md` reference or harness in `src/solver/analog/__tests__/harness/`).
  - `src/components/semiconductors/__tests__/mosfet.test.ts::integration::no_integrateCapacitor_import` — static import assertion.

- **Acceptance criteria**: zero `integrateCapacitor|integrateInductor` matches in `mosfet.ts`. Type-checks clean. Tests-red protocol applies: if the parity test reveals a numerical divergence from ngspice, **surface the divergence** — do not relax the assertion.

### Task C2.3: diode / varactor / tunnel-diode / led inline NIintegrate migration

- **Description**: Single task covering 4 files with 1 `integrateCapacitor` call site each — low file spread but coherent scope.

- **Files to modify**:
  - `src/components/semiconductors/diode.ts` — delete import (line 34), replace call at line 597.
  - `src/components/semiconductors/varactor.ts` — delete import (line 33), replace call at line 232.
  - `src/components/semiconductors/tunnel-diode.ts` — delete import (line 44), replace call at line 319.
  - `src/components/io/led.ts` — delete import (line 31), replace call at line 310.

- **Tests**:
  - `src/components/semiconductors/__tests__/diode.test.ts::integration::pn_cap_transient_matches_ngspice` — transient of diode junction-cap through inline NIintegrate, bit-exact against ngspice reference.
  - `src/components/semiconductors/__tests__/varactor.test.ts::integration::cvoltage_dependent_transient_matches_ngspice` — voltage-dependent cap transient.
  - `src/components/semiconductors/__tests__/tunnel-diode.test.ts::integration::negative_resistance_transient_matches_ngspice` — tunnel-diode transient.
  - `src/components/io/__tests__/led.test.ts::integration::junction_cap_transient_matches_ngspice`.
  - Static import assertions per file.

- **Acceptance criteria**: zero matches for the deleted symbols in each file. Type-check clean.

### Task C2.4: Wave 6.4 pull-forward — digital pin models atomic migration

- **Description**: Execute the entire Wave 6.4 body from `spec/phase-6-model-rewrites.md` (Tasks 6.4.1 through 6.4.4) as one atomic task. This is an atomic-migration gate — file spread exceeds 8 files by design. The agent for this task must work through the full Wave 6.4 spec without stopping.

- **Files to modify / create** (from phase-6 Wave 6.4 spec):
  - `src/solver/analog/compiler.ts` — add `resolvePinLoading` helper; write `_pinLoading: Record<string, boolean>` into `PropertyBag` for every behavioural element.
  - `src/solver/analog/digital-pin-model.ts` — major rewrite: `load(ctx)/accept(ctx, voltage)` surface, role tag on `DigitalOutputPinModel`, `loaded` getter, handle caching, delete legacy `stamp`/`stampOutput`/`stampCompanion`/`updateCompanion` methods. Delete the 4 `integrateCapacitor` imports/calls at lines 185, 203, 315, 333.
  - `src/solver/analog/behavioral-gate.ts`, `src/solver/analog/behavioral-combinational.ts`, `src/solver/analog/behavioral-flipflop.ts`, `src/solver/analog/behavioral-flipflop/{rs,rs-async,jk,jk-async,d-async,t}.ts`, `src/solver/analog/behavioral-sequential.ts`, `src/solver/analog/behavioral-remaining.ts` — read `_pinLoading` from PropertyBag; delegate element `load()`/`accept()` to pin-model `load()`/`accept()`; drop hardcoded `loaded=true` literals.
  - `src/solver/analog/bridge-adapter.ts` — bridge-output adapter constructs `DigitalOutputPinModel(spec, loaded, role="branch")`. Bridge-input adapter constructs `DigitalInputPinModel(spec, loaded)`.

- **Tests**: as specified in Tasks 6.4.1, 6.4.2, 6.4.3, 6.4.4 — copy the test list verbatim from `spec/phase-6-model-rewrites.md` lines 442–578. All must pass before the task closes.

- **Acceptance criteria**:
  - Full-codebase `tsc --noEmit` succeeds after C2.4 lands (the Wave 6.4 atomic gate per plan.md).
  - Grep `\.(stamp|stampOutput|stampCompanion|updateCompanion)\s*\(` scoped to `src/solver/analog/digital-pin-model.ts` = 0 matches.
  - Zero `integrateCapacitor|integrateInductor` matches in any production file under `src/`.

- **Tests-red protocol**: the atomic gate is non-negotiable. If any file in the Wave 6.4 set does not land in the same commit/branch as the others, this task is not complete. No partial landing.

---

## Wave C3: Test-Side Migration to load(ctx)

**Goal.** Zero test files reference deleted element methods. Every test driving an element exercises `load(ctx)` / `accept(ctx, ...)` / `checkConvergence(ctx)`.

**Why after C1+C2.** Tests driving production elements cannot migrate cleanly until both the interface (C1) and element implementations (C2) stabilise — otherwise a test-migration agent must guess which half of the split interface is "live". C3 completes the picture.

**Surrounding state while C3 is in flight.** `tsc --noEmit` is broken for the test files being migrated. Test suite is not expected to be green. Finishing C3 is what turns tests green for the first time since Wave 6.2 began.

### Task C3.1: test-helpers.ts canonical mock factory migration

- **Description**: Rewrite the mock-element factory in `src/solver/analog/__tests__/test-helpers.ts` (lines 76–82 per review) to return a shape implementing `load(ctx: LoadContext): void`. Delete the `stamp`/`stampNonlinear`/`updateOperatingPoint` fields from the returned object. Delete the historical-provenance block at lines 743–748 (V-10 / LR-01). Retain `makeSimpleCtx`, `runDcOp`, `runNR` as helpers — they are post-migration wrappers, not legacy shims. Ensure their signatures match the post-Wave-6.1 APIs.

- **Files to modify**:
  - `src/solver/analog/__tests__/test-helpers.ts` — mock factory + comment deletion.

- **Tests**:
  - `src/solver/analog/__tests__/test-helpers.test.ts::mock_factory::returns_load_ctx_interface` — construct a mock, assert `typeof mock.load === 'function'` and that `mock.stamp`, `mock.stampNonlinear`, `mock.updateOperatingPoint` are `undefined`.

- **Acceptance criteria**:
  - Grep `stamp\s*:|stampNonlinear\s*:|updateOperatingPoint\s*:` in `test-helpers.ts` = 0 matches.
  - No historical-provenance comments remain in the file.

### Task C3.2: controlled-source-base.test.ts migration

- **Description**: Rewrite the 4 `src.stampNonlinear(nullSolver)` call sites in `src/solver/analog/__tests__/controlled-source-base.test.ts` (lines 89, 100, 111, 122) to drive the element via `load(ctx)`. Build a minimal `LoadContext` fixture via `makeSimpleCtx` (post-C3.1).

- **Files to modify**:
  - `src/solver/analog/__tests__/controlled-source-base.test.ts`

- **Tests** (same file, rewritten): every describe block keeps its existing assertions but drives them through `load(ctx)` instead of `stampNonlinear`.

- **Acceptance criteria**: zero `stamp\s*\(|stampNonlinear\s*\(|updateOperatingPoint\s*\(` matches in this file. All tests in the file pass (they should — this is a test-only migration on already-migrated production code).

### Task C3.3: Behavioral test family migration

- **Description**: Migrate five test files that drive behavioural elements through deleted methods: `behavioral-flipflop.test.ts` (~13 call sites), `behavioral-sequential.test.ts` (~6 sites), `behavioral-remaining.test.ts` (`relay.stampCompanion!` at 384, 397 + surrounding `stamp()` loops), `behavioral-flipflop-variants.test.ts` (multiple `stamp`/`stampNonlinear`/`updateCompanion` sites), `behavioral-integration.test.ts::flushQ` (lines 492–494). Each test drives the element through `load(ctx)`/`accept(ctx, ...)`.

- **Files to modify**:
  - `src/solver/analog/__tests__/behavioral-flipflop.test.ts`
  - `src/solver/analog/__tests__/behavioral-sequential.test.ts`
  - `src/solver/analog/__tests__/behavioral-remaining.test.ts`
  - `src/solver/analog/__tests__/behavioral-flipflop-variants.test.ts`
  - `src/solver/analog/__tests__/behavioral-integration.test.ts` (only the `flushQ` helper + its callers)

- **Tests**: existing tests in these files, with drivers migrated. No assertion changes.

- **Acceptance criteria**: zero matches for the deleted-method patterns across all five files. All behavioural tests pass.

- **Tests-red protocol**: if a behavioural test fails after the driver migration, the test may have been exercising a hidden bug masked by the old interface. Surface the failure; do not weaken the assertion.

### Task C3.4: fet-base.test.ts + dcop-init-jct.test.ts migration

- **Description**: `fet-base.test.ts` has 15 call sites on deleted methods (lines 228, 237, 242, 246, 270, 276, 348, 355, 405, 418, 430, 438, 459, 478, 488). `dcop-init-jct.test.ts` has 10 (lines 126, 143, 168, 192, 227, 240, 262, 274, 292, 294). Rewrite both to drive elements via `load(ctx)`. Several sites use non-null-assertion operators (`element.stampCompanion!`) — those become direct `element.load(ctx)` calls with no assertion.

- **Files to modify**:
  - `src/solver/analog/__tests__/fet-base.test.ts`
  - `src/solver/analog/__tests__/dcop-init-jct.test.ts`

- **Tests**: existing tests, drivers migrated.

- **Acceptance criteria**: zero matches for `updateOperatingPoint\s*!|stampNonlinear\s*!|stampCompanion\s*!|stamp\s*\(`. Both files' tests pass.

### Task C3.5: varactor.test.ts + sparse-solver.test.ts migration

- **Description**: `varactor.test.ts` has 6 sites including 3 with `(varactor as any).methodName!(...)` casts (lines 74, 81, 91–92, 219, 242, 248). Delete the `as any` casts and drive through `load(ctx)`. Also delete the inverse-correctness assertion `expect(v.stampCompanion).toBeDefined()` at line 219 (Phase 6 T-03) — replace with `expect(typeof v.load).toBe('function')`. `sparse-solver.test.ts` has 4 sites calling `el.stamp()` / `el.stampNonlinear()` at lines 456, 461, 481, 482, with a method-presence sniff `if (el.isNonlinear && el.stampNonlinear)` at 461/482 — rewrite to call `el.load(ctx)` unconditionally.

- **Files to modify**:
  - `src/components/semiconductors/__tests__/varactor.test.ts`
  - `src/solver/analog/__tests__/sparse-solver.test.ts`

- **Tests**: existing tests, drivers migrated. The inverse-correctness assertion is replaced (not weakened — it now asserts the correct thing).

- **Acceptance criteria**: zero `as any` or `!` banged-method invocations on element instances in either file. Zero method-presence sniffs. All tests pass.

### Task C3.6: behavioral-flipflop-engine-dispatch.test.ts disposition

- **Description**: The entire file (header comment lines 4–6 + body lines 222–229) narrates a pre-migration engine-dispatch defect and calls `element.updateCompanion(...)`. Post-Wave-6.3.3 the engine no longer has that dispatch path; the defect it exercises does not exist.

  Delete the file outright. The companion-update semantics it was guarding are now covered by `accept(ctx, ...)` paths in each element's implementation and by behavioural-integration tests.

- **Files to delete**:
  - `src/solver/analog/__tests__/behavioral-flipflop-engine-dispatch.test.ts`

- **Acceptance criteria**: file does not exist. Vitest suite still runs green (no test was uniquely covering a behaviour that survived the engine-loop deletion).

- **Tests-red protocol**: if deleting the file reveals that a behaviour was only covered here, that gap is a missing `accept()` test on the underlying behavioural element — add it to `behavioral-integration.test.ts` with the corrected semantics, do not restore the file.

---

## Wave C4: Missing Spec-Required Parity Tests

**Goal.** Every per-element parity test listed in Phase 6 Tasks 6.2.1 through 6.2.5 exists and passes bit-exact against an ngspice reference. Phase 3 Task 3.2.1 and 3.2.2 required tests exist and pass.

**Why after C2+C3.** Parity tests drive the new `load(ctx)` interface. If they run before C2, 7 modules can't load. If they run before C3, the shared test infrastructure (`test-helpers.ts`) still targets the old interface.

**Surrounding state while C4 is in flight.** Production + test code is type-clean. Some parity tests may surface real numerical divergences from ngspice — those are the point of this wave. See Tests-red protocol.

### Task C4.1: Passive DC-OP parity tests (Task 6.2.1)

- **Description**: One parity test per element listed in Task 6.2.1. Each test builds the element at standard bias, runs DC-OP via `DefaultSimulatorFacade`, and compares every accepted NR iteration's `rhsOld[]` bit-exact against an ngspice reference captured via the `ComparisonSession` harness. Use `src/solver/analog/__tests__/harness/` infrastructure.

- **Files to create / modify**:
  - `src/components/passives/__tests__/resistor.test.ts` — add `resistor_load_dcop_parity`.
  - `src/components/passives/__tests__/potentiometer.test.ts` — add `potentiometer_load_dcop_parity`.
  - `src/components/sensors/__tests__/ntc-thermistor.test.ts` — add `ntc_load_dcop_parity`.
  - `src/components/sensors/__tests__/ldr.test.ts` — add `ldr_load_dcop_parity`.
  - `src/components/passives/__tests__/analog-fuse.test.ts` — add `fuse_load_dcop_parity`.
  - `src/components/sensors/__tests__/spark-gap.test.ts` — add `spark_gap_load_dcop_parity`.
  - `src/solver/analog/__tests__/mna-end-to-end.test.ts` — add `resistor_load_interface` test: construct a resistor, call `element.load(ctx)` with a seeded `LoadContext`, assert the solver's G entry equals `1/R` bit-exact.

- **Tests** (exact names, per file):
  - `...::resistor_load_dcop_parity` — 3-resistor divider, Vs=5V, R=1k/1k/1k, compare NR iter 0 rhsOld[] bit-exact.
  - `...::potentiometer_load_dcop_parity` — pot at wiper=0.5 mid-divider, bit-exact.
  - `...::ntc_load_dcop_parity` — NTC at 25°C nominal, self-heating off, bit-exact.
  - `...::ldr_load_dcop_parity` — LDR at 1000 lux, bit-exact.
  - `...::fuse_load_dcop_parity` — fuse in un-blown state, bit-exact.
  - `...::spark_gap_load_dcop_parity` — gap in non-firing state, bit-exact.
  - `mna-end-to-end.test.ts::resistor_load_interface` — `expect(solver.getEntry(0,0)).toBe(1 / 1000)` for R=1kΩ.

- **Acceptance criteria**: each test uses `toBe` or `absDelta === 0` against the ngspice reference. Zero use of `toBeCloseTo`.

- **Tests-red protocol**: if any parity test red-lights, the element has real ngspice divergence. Surface to user; do not soften.

### Task C4.2: Reactive transient parity tests (Task 6.2.2)

- **Description**: One transient parity test per reactive element. Each runs a 10-step transient, compares every accepted step's `dt`, `order`, `method`, and post-step node voltages bit-exact against ngspice.

- **Files to modify**:
  - `src/components/passives/__tests__/capacitor.test.ts` — `capacitor_load_transient_parity`.
  - `src/components/passives/__tests__/polarized-cap.test.ts` — `polarized_cap_load_transient_parity`.
  - `src/components/passives/__tests__/inductor.test.ts` — `inductor_load_transient_parity`.
  - `src/components/passives/__tests__/transformer.test.ts` — `transformer_load_transient_parity`.
  - `src/components/passives/__tests__/tapped-transformer.test.ts` — `tapped_transformer_load_transient_parity`.
  - `src/components/passives/__tests__/crystal.test.ts` — `crystal_load_transient_parity`.
  - `src/components/passives/__tests__/memristor.test.ts` — `memristor_load_transient_parity`.
  - `src/components/passives/__tests__/transmission-line.test.ts` — `transmission_line_load_transient_parity`.

- **Tests**: each test builds the element in a canonical test circuit (cap+R, inductor+R, transformer with load, etc.), runs transient, asserts bit-exact step-by-step match.

- **Acceptance criteria**: `toBe` / `absDelta === 0` on every assertion. Zero `toBeCloseTo`.

### Task C4.3: Semiconductor parity + buckbjt-convergence

- **Description**: Per-family parity tests for diode, BJT (SPICE-L1), JFET, MOSFET (SPICE-L1), plus the `buckbjt-convergence.test.ts` file that Task 6.2.3 required and was never created. The buck circuit is a canonical BJT-based buck converter whose DC-OP convergence history matches ngspice iteration-by-iteration.

- **Files to create**:
  - `src/solver/analog/__tests__/buckbjt-convergence.test.ts` — DC-OP convergence parity test for a BJT-based buck circuit (Vsupply=12V, BJT switch, R_base, R_collector, R_load, C_out). Compare every NR iteration's `rhsOld[]` + `noncon` + `diagGmin` + `srcFact` against ngspice.

- **Files to modify**:
  - `src/components/semiconductors/__tests__/diode.test.ts` — add `diode_load_dcop_parity` (DC-OP forward bias) + `diode_load_transient_parity`.
  - `src/components/semiconductors/__tests__/bjt.test.ts` — add `bjt_spicel1_load_dcop_parity` (common-emitter, multi-junction limiting).
  - `src/components/semiconductors/__tests__/jfet.test.ts` — add `jfet_load_dcop_parity`.
  - `src/components/semiconductors/__tests__/mosfet.test.ts` — add `mosfet_spicel1_load_dcop_parity`.

- **Tests**: each listed above. All bit-exact against ngspice.

- **Acceptance criteria**: every test uses bit-exact matching. Zero `toBeCloseTo`.

### Task C4.4: Source parity tests (Task 6.2.4)

- **Description**: Parity tests for every source type (DC voltage, AC voltage, current source, variable rail, clock) covering `srcFact` scaling during DC-OP source-stepping and breakpoint scheduling during transient.

- **Files to modify**:
  - `src/components/sources/__tests__/dc-voltage-source.test.ts` — `dc_vsource_load_srcfact_parity` (verify srcFact=0.5 halves the stamped RHS).
  - `src/components/sources/__tests__/ac-voltage-source.test.ts` — `ac_vsource_load_srcfact_parity` + `ac_vsource_breakpoints_parity`.
  - `src/components/sources/__tests__/current-source.test.ts` — `isource_load_srcfact_parity`.
  - `src/components/sources/__tests__/variable-rail.test.ts` — `variable_rail_load_srcfact_parity`.
  - `src/components/io/__tests__/analog-clock.test.ts` — `clock_load_srcfact_parity` + `clock_breakpoints_parity`.

- **Acceptance criteria**: each test asserts bit-exact RHS entry == `nominal * srcFact`. Breakpoints asserted as exact `=== expected` arrays.

### Task C4.5: Active element parity tests (Task 6.2.5)

- **Description**: Parity test per active element. Each test drives the element at a canonical operating point and compares stamps against an ngspice reference.

- **Files to modify**:
  - `src/components/active/__tests__/opamp.test.ts` — `opamp_load_dcop_parity`.
  - `src/components/active/__tests__/real-opamp.test.ts` — `real_opamp_load_dcop_parity` (includes slew + finite gain).
  - `src/components/active/__tests__/comparator.test.ts` — `comparator_load_dcop_parity`.
  - `src/components/active/__tests__/ota.test.ts` — `ota_load_dcop_parity`.
  - `src/components/active/__tests__/analog-switch.test.ts` — `analog_switch_load_dcop_parity`.
  - `src/components/active/__tests__/timer-555.test.ts` — `timer555_load_transient_parity`.
  - `src/components/active/__tests__/optocoupler.test.ts` — `optocoupler_load_dcop_parity`.
  - `src/components/active/__tests__/schmitt-trigger.test.ts` — `schmitt_load_dcop_parity`.
  - `src/components/active/__tests__/dac.test.ts` — `dac_load_dcop_parity`.
  - `src/components/active/__tests__/adc.test.ts` — `adc_load_dcop_parity`.

- **Acceptance criteria**: each test bit-exact.

### Task C4.6: Phase 3 rounding tests

- **Description**: The two rounding tests from Phase 3 G-01 and G-02, retargeted per Q4 decision (element-level xmu ≠ 0.5 exercise rather than helper-function exercise).

- **Files to modify**:
  - `src/solver/analog/__tests__/integration.test.ts` — add `nicomcof_trap_order2_matches_ngspice_rounding`: call `computeNIcomCof` with `dt=1.23456789e-7`, `xmu=1/3`, order=2, method="trapezoidal". Assert `ag[0]` is bit-exactly the value produced by `1.0/dt/(1.0-xmu)` (the post-Task-3.2.1 formula). Also compute the pre-fix formula `1/(dt*(1-xmu))` and assert the two differ (the test's whole purpose is to detect regressions of the rounding change).
  - `src/components/passives/__tests__/capacitor.test.ts` — add `capacitor_trap_order2_xmu_nonstandard_ccap_parity`: transient step with `xmu=0.3`, `q0=1e-12`, `q1=0.9e-12`, `ccapPrev=1e-6`, `dt=1e-9`. Assert the element's stamped companion current equals the ngspice formula `ag0*(q0-q1) + ag1*ccapPrev` with `ag1=xmu/(1-xmu)` bit-exact.

- **Acceptance criteria**: both tests use `toBe`. The `nicomcof` test's differential assertion asserts two distinct IEEE-754 values.

---

## Wave C5: SparseSolver.stamp(row, col, value) Deletion (Task 6.3.4 catchup)

**Goal.** Task 6.3.4 deletes the value-addressed `stamp(row, col, value)` method on `SparseSolver`. All 50+ callers migrate to the handle-based API (`allocElement` + `stampElement`). Method no longer exists post-task.

**Why after C2.** C2 rewrites element files that currently call `solver.stamp(row, col, value)`. Running C5 in parallel creates merge conflicts. C2 first, C5 second.

**Surrounding state while C5 is in flight.** Only the caller files are being rewritten; the solver itself gains no new API (it already exposes handles since Phase 0). Test files driving elements should continue passing.

### Task C5.1: Delete SparseSolver.stamp + migrate all callers

- **Description**: Delete the `stamp(row, col, value)` method on `SparseSolver`. Every production and test caller rewritten to cache a handle via `allocElement(row, col)` at element-construction / test-setup time, then call `stampElement(handle, value)` in the hot path. This is the atomic-migration gate originally planned for Wave 6.3 Task 6.3.4.

- **Files to modify** (not exhaustive — implementer greps for every `\.stamp\s*\(` call on a `SparseSolver` instance):
  - `src/solver/analog/sparse-solver.ts` — delete `stamp(row, col, value)` method (currently a thin wrapper over `allocElement` + `stampElement`).
  - All element files under `src/components/**` and `src/solver/analog/**` that stamp matrix entries — cache handles in the element's private state at `init()` time.
  - `src/solver/analog/__tests__/test-helpers.ts` — the `G()` wrapper on line 74–78 (per Phase 6 review G-08) currently routes through `solver.stamp()`; rewrite it.
  - All test files that construct ad-hoc stamps.

- **Tests**:
  - `src/solver/analog/__tests__/sparse-solver.test.ts::stamp_method_removed` — import `SparseSolver`, assert `(solver as any).stamp` is `undefined`.
  - Existing tests continue passing unchanged.

- **Acceptance criteria**:
  - Grep `\.stamp\s*\(` across the codebase (excluding `stampElement`, `stampRHS`, `stampNonlinear`, `stampCompanion`, `stampAc`) returns zero matches.
  - `tsc --noEmit` clean.
  - All tests pass.

- **File-spread note**: this task exceeds the 8-file limit by design. Agent works through the caller list systematically; does not stop part-way. If a particular caller's migration is unclear, the agent asks the user rather than shimming.

---

## Wave C6: Phase 1 Buffer Consolidation & Zero-Alloc Fixes

**Goal.** Complete Task 1.1.1 as originally written: `analog-engine.ts` maintains a single `_ctx: CKTCircuitContext` field, no parallel per-field buffers. Plus the four distinct zero-alloc violations from the Phase 1 review.

**Why independent.** No dependency on other waves beyond C1. Can run in parallel with C3/C4.

**Surrounding state.** Analog engine is being restructured. Tests driving the engine via the external facade (`DefaultSimulatorFacade`) continue working because the facade hides engine internals. Tests that directly probe engine private fields (should be rare; if any exist, they're violations of encapsulation and get rewritten here).

### Task C6.1: analog-engine.ts buffer field deletion

- **Description**: Delete `_voltages`, `_prevVoltages`, `_agp`, `_nodeVoltageHistory` fields from `AnalogEngine` (lines 92–100 per review). Route every read and write through `_ctx` (which is `CKTCircuitContext`). Delete the 12+ `.set()` sync sites that kept the dual buffers in lockstep. `_ctx.rhs`, `_ctx.rhsOld`, `_ctx.agp`, and whatever field holds node-voltage history become the single source of truth.

  The `NodeVoltageHistory` class may need to live on `CKTCircuitContext` — if it doesn't already, add it to the field inventory in plan.md Appendix A as part of this task.

- **Files to modify**:
  - `src/solver/analog/analog-engine.ts` — delete fields, rewrite every read/write site.
  - `src/solver/analog/ckt-context.ts` — add `nodeVoltageHistory` field if not already present.

- **Tests**:
  - `src/solver/analog/__tests__/analog-engine.test.ts::buffer_consolidation::no_parallel_voltage_buffer` — construct engine, `init()` a circuit, assert `(engine as any)._voltages` is `undefined` and `(engine as any)._ctx.rhs` is a `Float64Array`.
  - Existing `rc_transient_without_separate_loops` continues passing.

- **Acceptance criteria**:
  - Grep `_voltages\b|_prevVoltages\b|_agp\b|_nodeVoltageHistory\b` in `src/solver/analog/analog-engine.ts` = 0 matches (other than via `this._ctx.`).
  - Grep `\.set\s*\(` in the engine reduced to sites that genuinely copy between `Float64Array`s, not sync-sites.
  - All tests pass.

### Task C6.2: DcOpResult.reset() diagnostics allocation fix

- **Description**: `DcOpResult.reset()` in `src/solver/analog/ckt-context.ts:93` does `this.diagnostics = [];`, allocating a fresh array per DC-OP call. Change to `this.diagnostics.length = 0` (in-place clear). `diagnostics` remains declared as `DiagnosticEvent[]` on the class.

- **Files to modify**: `src/solver/analog/ckt-context.ts`

- **Tests**:
  - `src/solver/analog/__tests__/ckt-context.test.ts::DcOpResult::reset_preserves_array_identity` — capture `const arr = dcopResult.diagnostics; dcopResult.reset(); expect(dcopResult.diagnostics).toBe(arr);`.

- **Acceptance criteria**: test passes. Zero `this.diagnostics = \[\]` matches in `ckt-context.ts`.

### Task C6.3: cktncDump scratch buffer on ctx

- **Description**: `cktncDump` in `src/solver/analog/dc-operating-point.ts:238-250` allocates a new array + per-node object literals every call. Add a pre-allocated scratch buffer on `CKTCircuitContext`: `ncDumpScratch: { node: number; delta: number; tol: number }[]` allocated at ctx construction with length `matrixSize`, reused via `.length = 0` + push-mutate. The object literals themselves become reusable — pre-allocate `matrixSize` entries and mutate their fields.

- **Files to modify**:
  - `src/solver/analog/ckt-context.ts` — add `ncDumpScratch` field + pre-allocation.
  - `src/solver/analog/dc-operating-point.ts` — `cktncDump` consumes the scratch.

- **Tests**:
  - `src/solver/analog/__tests__/dc-operating-point.test.ts::cktncDump::zero_alloc_on_failure_path` — call `cktncDump` twice, assert returned array identity is the same (`.toBe`).

- **Acceptance criteria**: test passes. Grep `new Array|\[\]` inside `cktncDump` body = 0 matches (except the one-time pre-allocation in the ctx constructor).

### Task C6.4: SparseSolver double-allocation reconciliation

- **Description**: `CKTCircuitContext` constructor creates a `SparseSolver`; the engine constructor creates another one and overwrites `ctx.solver` with its own instance. The ctx-internal solver is wasted. Resolve by accepting a `SparseSolver` as a constructor parameter on `CKTCircuitContext` — engine passes its own. Remove the `ctx.solver = this._solver` overwrite on the engine side.

- **Files to modify**:
  - `src/solver/analog/ckt-context.ts` — constructor signature gains a `solver: SparseSolver` parameter; drop the internal `new SparseSolver()`.
  - `src/solver/analog/analog-engine.ts` — pass `this._solver` into the ctx constructor; delete the post-construct assignment.

- **Tests**:
  - `src/solver/analog/__tests__/ckt-context.test.ts::solver::single_allocation` — construct a ctx with an explicit solver instance; assert `ctx.solver === passedSolver` with `.toBe` identity.

- **Acceptance criteria**: test passes. Grep `new SparseSolver` in `ckt-context.ts` = 0 matches.

### Task C6.5: dcopResult.method failure-path reset

- **Description**: `src/solver/analog/dc-operating-point.ts:439` resets `dcopResult.method = "direct"` after all three fallback strategies fail. Remove the reset so `method` reflects the last strategy attempted.

- **Files to modify**: `src/solver/analog/dc-operating-point.ts`

- **Tests**:
  - `src/solver/analog/__tests__/dc-operating-point.test.ts::failure_path::method_reflects_last_strategy` — construct a circuit that fails all three strategies (unbounded-gain non-convergent topology), assert `dcopResult.method` is `"sourceStepping"` (or whatever the last-attempted strategy name is), not `"direct"`.

- **Acceptance criteria**: test passes.

### Task C6.6: Delete dead rawMaxIter ternary

- **Description**: `src/solver/analog/newton-raphson.ts:276-278` computes `const rawMaxIter = ctx.exactMaxIterations ? ctx.maxIterations : ctx.maxIterations;` — a tautological ternary where both branches are identical. Replace with `const rawMaxIter = ctx.maxIterations;`.

- **Files to modify**: `src/solver/analog/newton-raphson.ts`

- **Tests**: none required; this is a dead-code simplification with no behaviour change. Existing NR tests continue passing.

- **Acceptance criteria**: line exists in simplified form. All tests pass.

---

## Wave C7: cktLoad ngspice Parity + Dead Code

**Goal.** `cktLoad` stamps nodesets and ICs with `srcFact` scaling during initJct / initFix, matching ngspice `cktload.c:96-136`. Dead helper `applyNodesetsAndICs` + its 5 tests deleted.

**Why independent.** No dependency beyond C1.

### Task C7.1: cktLoad srcFact + IC stamping

- **Description**: Rewrite the nodeset-stamping block in `src/solver/analog/ckt-load.ts` (currently lines 55–57 per review) to:
  1. Iterate `ctx.nodesets` and stamp each with `srcFact` scaling: `ctx.solver.stampRHS(node, G_NODESET * value * ctx.srcFact)` (where `G_NODESET = 1e10` matching ngspice).
  2. Iterate `ctx.ics` (initial conditions map) and stamp each the same way.
  3. Both loops execute only when `ctx.isDcOp && (ctx.initMode === "initJct" || ctx.initMode === "initFix")`, matching ngspice.

  Mapping table (ngspice → ours):

  | ngspice (cktload.c) | ours |
  |---|---|
  | `ckt->CKTnodeset` | `ctx.nodesets` |
  | `ckt->CKTnodeValues` (IC) | `ctx.ics` |
  | `1e10` nodeset pin | same literal, define const `CKTNS_PIN = 1e10` |
  | `*ckt->CKTrhs` += ... | `ctx.solver.stampRHS(node, val)` |
  | `CKTsrcFact` | `ctx.srcFact` |

- **Files to modify**:
  - `src/solver/analog/ckt-load.ts` — rewrite Step 4 per above.
  - `spec/plan.md` Appendix B — update pseudocode to include IC stamping and `srcFact` scaling. Commit Appendix B change in the same commit.

- **Tests**:
  - `src/solver/analog/__tests__/ckt-load.test.ts::nodesets::srcFact_scales_nodeset_rhs` — build a ctx with nodeset `{nodeA: 2.5}` and `srcFact = 0.5`. Call `cktLoad` with `initMode = "initJct"`. Assert the RHS entry for `nodeA` equals `1e10 * 2.5 * 0.5` bit-exact (`.toBe`).
  - `src/solver/analog/__tests__/ckt-load.test.ts::ics::ic_stamped_in_initJct` — build a ctx with IC `{nodeB: 1.2}`. Call `cktLoad` with `initMode = "initJct"`, `srcFact = 1.0`. Assert the RHS entry for `nodeB` equals `1e10 * 1.2` bit-exact.
  - `src/solver/analog/__tests__/ckt-load.test.ts::ics::ic_not_stamped_outside_init_modes` — `initMode = "floating"`, assert IC does NOT stamp the RHS.

- **Acceptance criteria**: three tests pass bit-exact. Appendix B updated.

### Task C7.2: Delete applyNodesetsAndICs + 5 tests

- **Description**: Delete the `applyNodesetsAndICs` function from `src/solver/analog/newton-raphson.ts` (currently lines 61–79 per review) and its export. Delete the 5 tests that exercise it in `src/solver/analog/__tests__/newton-raphson.test.ts` (lines 384–443 per review).

  The nodeset/IC behaviour is now fully covered by C7.1's cktLoad tests; `applyNodesetsAndICs` is dead code.

- **Files to modify**:
  - `src/solver/analog/newton-raphson.ts` — delete function + export.
  - `src/solver/analog/__tests__/newton-raphson.test.ts` — delete 5 test blocks.

- **Acceptance criteria**: grep `applyNodesetsAndICs` across the codebase = 0 matches. All remaining tests pass.

- **Tests-red protocol**: if the grep returns a non-test match, that's a caller we missed — migrate that caller to rely on cktLoad's built-in nodeset/IC stamping, do not restore the function.

---

## Wave C8: Test Assertion Hardening

**Goal.** Every numerical test in `integration.test.ts` and `ckt-terr.test.ts` uses `toBe` (bit-exact) or an `absDelta === 0` assertion against a captured ngspice reference. Weak tests (positivity-only) get reference values. The inverse-correctness assertion in `varactor.test.ts` is corrected. The `integrateCapacitor_does_not_exist` test is strengthened to catch production imports too.

**Why independent.** No dependency beyond C1.

**Tests-red protocol — critical for this wave.** Hardening assertions frequently surfaces real numerical divergences. If `toBe` reveals a last-bit mismatch with ngspice, the implementer surfaces it — does not revert to `toBeCloseTo`, does not pick a "close enough" reference, does not silently regenerate the baseline. User adjudicates each red finding.

### Task C8.1: integration.test.ts toBeCloseTo → toBe

- **Description**: Rewrite every `toBeCloseTo(expected, precision)` call in `src/solver/analog/__tests__/integration.test.ts` to `toBe(expected)`. Affected call sites per Phase 3 review V-06..V-12:
  - Lines 46–47, 71–74, 91–92 (HistoryStore values)
  - Lines 113–115, 221–223 (GEAR order 2)
  - Lines 123–126, 233–236 (GEAR order 3)
  - Lines 131–133, 245–249 (GEAR order 4)
  - Lines 138–139, 144–145, 257–262, 269–276 (GEAR orders 5–6)
  - Lines 174–175, 181–182 (BDF-1, trap order 1)
  - Lines 189–190, 199–201, 210–212 (trap order 2, BDF-2)

- **Files to modify**: `src/solver/analog/__tests__/integration.test.ts`

- **Tests**: existing tests, assertions tightened.

- **Acceptance criteria**: grep `toBeCloseTo` in `integration.test.ts` = 0 matches.

- **Tests-red protocol**: if tightening a closed-form coefficient assertion (e.g. `ag[0] === 25/(12*h)`) reveals a last-bit mismatch, that is a numerical divergence from the closed-form or ngspice and **must be surfaced**. Known pre-existing divergence: the comment at lines 316–320 describes a 1-ULP drift on GEAR order 4 `ag[0]`. That comment is deleted by C9, but the assertion stays tight — if it fails, surface to user with the measured value and the closed-form value so the user can decide whether to adjust the closed-form, fix the Vandermonde solver, or accept the divergence.

### Task C8.2: cktTerr.test.ts weak tests → reference values

- **Description**: 10 weak tests in `src/solver/analog/__tests__/ckt-terr.test.ts` assert only `toBeGreaterThan(0)` and `isFinite`. Replace each with a bit-exact assertion against a captured ngspice `CKTterr` reference. For each test, run the equivalent scenario through the ngspice comparison harness (`ComparisonSession`), capture the ngspice output, and bake it in as a `const NGSPICE_REF = ...; expect(actual).toBe(NGSPICE_REF);` assertion.

  Affected tests (Phase 3 review W-01..W-09, excluding W-10 which is covered by C8.1):
  - `cktTerr::order 1 bdf1: returns finite positive timestep for non-trivial charges`
  - `cktTerr::order 2 bdf2: returns sqrt-scaled timestep`
  - `cktTerr::constant charge history produces finite timestep`
  - `cktTerr::bdf2 order 2 returns positive finite timestep for cubic charge data`
  - `cktTerrVoltage::constant voltages produce finite timestep`
  - `cktTerrVoltage::order 1 bdf1 linear voltage`
  - `cktTerrVoltage::order 2 bdf2 sqrt root extraction`
  - `cktTerrVoltage::order 2 linear data`
  - `cktTerrVoltage::trapezoidal order 2 and bdf2 order 2 cubic data`

- **Files to modify**: `src/solver/analog/__tests__/ckt-terr.test.ts`

- **Acceptance criteria**: every named test above has at least one `toBe` or `absDelta === 0` assertion against a captured ngspice reference. Zero `toBeGreaterThan(0)` + `isFinite`-only assertions remain in the file.

### Task C8.3: Strengthen integrateCapacitor_does_not_exist

- **Description**: The existing test in `src/solver/analog/__tests__/integration.test.ts` asserts the module export is gone. Augment it to also statically verify no production file imports the symbol. Implementation: read the source text of every `src/**/*.ts` production file (non-test), assert zero matches for `import {.*integrateCapacitor.*}` or `import {.*integrateInductor.*}`. This catches the Phase 6 V-02 regression class at test time.

- **Files to modify**:
  - `src/solver/analog/__tests__/integration.test.ts` — strengthen the test.

- **Acceptance criteria**: test passes after C2 completes. Test fails if any production file re-introduces the deleted import.

### Task C8.4: Delete varactor.test.ts inverse-correctness assertion

- **Description**: The assertion `expect(v.stampCompanion).toBeDefined()` at `src/components/semiconductors/__tests__/varactor.test.ts:219` asserts the deleted pre-migration method still exists — it passes only when migration is incomplete. This is also addressed by C3.5; if C3.5 lands first, this task is a no-op. Otherwise it deletes the assertion standalone.

- **Files to modify**: `src/components/semiconductors/__tests__/varactor.test.ts` (if C3.5 has not already done it).

- **Acceptance criteria**: assertion removed. Replacement (`expect(typeof v.load).toBe('function')`) is in place.

---

## Wave C9: Mechanical Cleanup

**Goal.** Zero historical-provenance / migration-narrative / legacy-reference / banned-word / TODO comments. Scorched-earth per `rules.md`. Progress.md inconsistencies reconciled.

**Why last.** Runs after every other wave to avoid churning files that earlier waves rewrite. Every edit in this wave is subtractive (deletions only); no behaviour change.

**Per rules.md**: if a historical-provenance comment decorates dead or transitional code, the code itself is deleted alongside the comment. Every task below follows that rule — if a comment points to dead code, delete the code.

### Task C9.1: Phase 0 — "fallback" word removal

- **Files to modify**: `src/solver/analog/newton-raphson.ts:262` — remove the banned word "fallback" from the JSDoc, replace with neutral phrasing (e.g. "next strategy").

- **Acceptance criteria**: grep `fallback` case-insensitive in `newton-raphson.ts` = 0 matches. Code the comment decorates is examined: if it's dead, delete it; if it's live, just fix the comment.

### Task C9.2: Phase 1 — historical-provenance block removal

- **Files to modify**:
  - `src/solver/analog/__tests__/ckt-load.test.ts:5, 24` — remove "migrated from mna-assembler.test.ts" header + describe-block comment.
  - `src/solver/analog/__tests__/test-helpers.ts:743-748` — remove migration-helper narrative block (already partly handled by C3.1; this task ensures complete removal if any fragment survives).
  - `src/solver/analog/__tests__/newton-raphson.test.ts:297` — remove "// Change 6 ensures assembler.noncon" comment referencing deleted MNAAssembler.
  - `src/solver/analog/analog-engine.ts:1038` — remove "// DcOpOptions" comment referencing deleted interface.

- **Acceptance criteria**: grep `migrated from|previously called|Change \d+|DcOpOptions` across the five files = 0 matches.

### Task C9.3: Phase 2 — historical-provenance comments

- **Files to modify**:
  - `src/solver/analog/newton-raphson.ts:50` — remove "(stampAll)" parenthetical referencing deleted MNAAssembler method.
  - `src/solver/analog/ckt-load.ts:2` — remove "replacing MNAAssembler.stampAll()" from file header docstring.
  - `src/solver/analog/sparse-solver.ts:225` — remove "Called at compile time by every caller (element factories, MNAAssembler)" — MNAAssembler is deleted.

- **Acceptance criteria**: grep `MNAAssembler|stampAll` in the three files = 0 matches.

### Task C9.4: Phase 3 — historical-provenance + deferred-narrative comments

- **Files to modify**:
  - `src/solver/analog/ckt-terr.ts:133-134` — remove "fallback" usage (banned word).
  - `src/solver/analog/__tests__/ckt-terr.test.ts:53, 123, 310-312` — remove "After formula fix (Phase 3)", "After Phase 3 formula fixes", and "batch-3 at commit ecdc34a" comments.
  - `src/solver/analog/__tests__/integration.test.ts:316-320` — remove the "Known divergence at commit ecdc34a... batch-4 remediation" comment block. The tight assertion stays; the comment goes.

- **Acceptance criteria**: grep `Phase 3|batch-3|batch-4|commit ecdc34a|fallback` across the three files = 0 matches (file paths and identifier names are fine — only comment content matters).

### Task C9.5: Phase 6 — narrative and TODO comments

- **Files to modify**:
  - `src/solver/analog/__tests__/behavioral-remaining.test.ts:319-336` — delete the 18-line pre-migration transient-flow narrative block.
  - `src/solver/analog/__tests__/harness/netlist-generator.ts:269, 281, 298` — remove the three `// TODO:` comments. For each: if the TODO points to dead code (waveform not implemented), delete the dead code; if it points to a live limitation, ask the user whether to surface the limitation as a thrown error or as a documented constraint.
  - `src/core/analog-types.ts` — remove any JSDoc fragments that survived C1 referencing `stampNonlinear`/`stampCompanion`/etc. by name.
  - `src/solver/analog/__tests__/test-helpers.ts:744-748` — redundant with C3.1 but confirm the migration-helper narrative is fully gone.

- **Acceptance criteria**: grep `stampNonlinear|stampCompanion|updateOperatingPoint|updateCompanion|shouldBypass|getBreakpoints` in JSDoc-comment lines across `src/core/analog-types.ts` = 0 matches. Grep `TODO` in `netlist-generator.ts` = 0 matches. Grep `migrated from|previously called|Change \d+|batch-\d+|commit [0-9a-f]{7,}` across all test files = 0 matches.

---

## Closeout

Phase is complete when:

1. Every task above is marked complete in a catchup-specific progress tracker (`spec/progress-catchup.md`, created by the first implementer).
2. Full-codebase `tsc --noEmit` succeeds.
3. Full test suite passes, **unless** a spec-exact test is red because it detected a real ngspice divergence — in that case the red test is documented in `spec/progress-catchup.md` with the measured value vs. ngspice reference and routed to the user for adjudication. Under no circumstances is a red-detecting-real-divergence test softened to make it pass.
4. Every finding ID from the five review reports (`phase-0.md` V-01..V-08, `phase-1.md` V-01..V-08/G/T/L, etc.) traces to a task in this spec. No finding is silently dropped.
5. `spec/plan.md` Appendix B is updated to include IC stamping + srcFact scaling (committed in the C7.1 commit).

After closeout, Phase 4 (DC-OP alignment) of the main plan may begin.
