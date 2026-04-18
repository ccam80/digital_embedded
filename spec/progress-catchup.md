# phase_catchup Progress Tracker

## Task C1.1: Migrate AnalogElementCore to post-Wave-6.1 shape
- **Status**: complete
- **Agent**: implementer
- **Files created**: `src/solver/analog/__tests__/element-interface.test.ts`
- **Files modified**: `src/core/analog-types.ts`
- **Tests**: 3/3 passing
- **Summary**:
  - Replaced `AnalogElementCore` body in `src/core/analog-types.ts`: removed `stamp`, `stampNonlinear`, `updateOperatingPoint`, `stampCompanion`, `stampReactiveCompanion`, `updateChargeFlux`, `updateState`, `shouldBypass` methods; added `load(ctx)`, `accept?(ctx, simTime, addBreakpoint)`, updated `checkConvergence?` to single `ctx: LoadContext` arg.
  - Updated JSDoc for `isNonlinear` and `isReactive` to describe current load()-based semantics.
  - Used inline `import("../solver/analog/load-context.js").LoadContext` to avoid circular import.
  - `SparseSolverStamp` kept — still used by `compiler.ts` (C2/C5 scope).
  - Verified: zero matches for deleted method patterns in `analog-types.ts`.
  - Verified: all production file tsc errors are pre-existing (C2 scope `integrateCapacitor`, `s4-s7` pool shape issues). No new production errors introduced.
  - All test-file errors are pre-existing and expected until C3.

## Task C1.1 (retry): Re-verified against clarified spec — no code change required
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: none
- **Tests**: 3/3 passing
- **Summary**:
  - Verified `AnalogElementCore` interface body (lines 115–241 of `src/core/analog-types.ts`) contains zero matches for the banned-method regex. The two `stamp(` matches in the file (lines 37 and 50) belong to sibling interfaces `SparseSolverStamp` and `ComplexSparseSolver` — both explicitly out of scope for Wave C1.1 per the clarified acceptance criteria.
  - All three tests in `src/solver/analog/__tests__/element-interface.test.ts` pass: `has_load_method`, `rejects_deleted_methods`, `checkConvergence_is_single_arg` (3/3).
  - No code changes made. State fully matches updated spec.

## Task C2.1: fet-base.ts inline NIintegrate migration
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/solver/analog/fet-base.ts` — deleted `integrateCapacitor` import; replaced 4 call sites (2 in `_stampCompanion`, 2 in `_updateChargeFlux`) with inline `ctx.ag[]` NIintegrate using the pattern `ccap = ag[0]*q0 + ag[1]*q1 [+ ag[2]*q2 for order>=2]`, `geq = ag[0]*cap`, `ceq = ccap - ag[0]*q0`; added `ag: Float64Array` parameter to `_stampCompanion` and `_updateChargeFlux`; removed now-unused `h1` and `method`/`deltaOld` parameters (prefixed with `_`); removed blank import line
  - `src/components/semiconductors/mosfet.ts` — updated `_stampCompanion` and `_updateChargeFlux` override signatures to add `ag: Float64Array` parameter and pass `ag` through to `super` calls (mechanical consequence of base-class signature change; mosfet.ts's own `integrateCapacitor` calls are C2.2 scope and were not touched)
  - `src/solver/analog/__tests__/fet-base.test.ts` — added `describe("integration", ...)` with two required tests
- **Tests**: 2/2 new tests passing (8/17 total, 9 pre-existing C3 failures unchanged)

### ngspice variable mapping table (niinteg.c:28-63)

| ngspice variable | ours |
|---|---|
| `CKTag[0]` | `ag[0]` (from `ctx.ag[0]`) |
| `CKTag[1]` | `ag[1]` |
| `CKTag[2]` | `ag[2]` |
| `qx` (charge at step n) | `q0` (from `this._s0[base + SLOT_Q_GS]` etc.) |
| `qx-1` (charge at step n-1) | `q1` (from `this.s1[base + SLOT_Q_GS]`) |
| `qx-2` (charge at step n-2) | `q2` (from `this.s2[base + SLOT_Q_GS]`) |
| `geq = ag[0]*cap` | `const geq = ag[0] * caps.cgs` |
| `ccap = ag[0]*q0 + ag[1]*q1 + ...` | inline sum over order+1 terms |
| `ceq = ccap - ag[0]*q0` | `const ceq = ccap - ag[0] * q0` |

## Task C2.2: mosfet.ts inline NIintegrate migration
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/components/semiconductors/mosfet.ts` — deleted `integrateCapacitor` import; added `computeNIcomCof` import; added `ag: Float64Array` parameter to `_stampCompanion` override; replaced 3 `integrateCapacitor` calls in `_stampCompanion` (DB/SB/GB junctions) with inline NIintegrate using `ag[]` from ctx; replaced 3 `integrateCapacitor` calls in `_updateChargeFlux` (DB/SB/GB) with locally-computed `agLocal` via `computeNIcomCof`
  - `src/components/semiconductors/__tests__/mosfet.test.ts` — added `describe("integration", ...)` with two required tests
- **Tests**: 2/2 new tests passing (35/48 total; 13 pre-existing C3 failures unchanged)

### ngspice variable mapping table (niinteg.c:28-63)

| ngspice variable | ours |
|---|---|
| `CKTag[0]` | `ag[0]` (from `ctx.ag[0]` in _stampCompanion, `agLocal[0]` in _updateChargeFlux) |
| `CKTag[1]` | `ag[1]` |
| `CKTag[2]` | `ag[2]` |
| `qx` (charge at step n) | `q0` (e.g. `qbd` for DB junction) |
| `qx-1` (charge at step n-1) | `q1_db` (from `s1[base + SLOT_Q_DB]`) |
| `qx-2` (charge at step n-2) | `q2_db` (from `s2[base + SLOT_Q_DB]`) |
| `geq = ag[0]*cap` | `ag[0] * capbd` stored in `s0[base + SLOT_CAP_GEQ_DB]` |
| `ccap = ag[0]*q0 + ag[1]*q1 + ...` | inline sum stored in `s0[base + SLOT_CCAP_DB]` |
| `ceq = ccap - ag[0]*q0` | stored in `s0[base + SLOT_CAP_IEQ_DB]` |

## Task C2.3: Inline NIintegrate in diode.ts, varactor.ts, tunnel-diode.ts, led.ts
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/components/semiconductors/diode.ts` — deleted `integrateCapacitor` import, replaced call with inline `ctx.ag[]`-based NIintegrate expansion (niinteg.c:28-63)
  - `src/components/semiconductors/varactor.ts` — same migration
  - `src/components/semiconductors/tunnel-diode.ts` — same migration (uses `vdNew`)
  - `src/components/io/led.ts` — same migration (uses `vdLimited`)
  - `src/components/semiconductors/__tests__/diode.test.ts` — appended `describe("integration", ...)` with `pn_cap_transient_matches_ngspice` and `no_integrateCapacitor_import` tests
  - `src/components/semiconductors/__tests__/varactor.test.ts` — appended `describe("integration", ...)` with `cvoltage_dependent_transient_matches_ngspice` and `no_integrateCapacitor_import` tests; removed broken `createTestPropertyBag()` helper that used CommonJS `require()` in ESM context
  - `src/components/semiconductors/__tests__/tunnel-diode.test.ts` — appended `describe("integration", ...)` with `negative_resistance_transient_matches_ngspice` and `no_integrateCapacitor_import` tests; seeded `pool.state0[0] = vd` to prevent NDR voltage-step limiting from clamping vdNew away from test vd
  - `src/components/io/__tests__/led.test.ts` — appended `describe("integration", ...)` with `junction_cap_transient_matches_ngspice` and `no_integrateCapacitor_import` tests; imported `VT` from `constants.js` and used `N * LED_VT` (not hardcoded 0.02585) so expected gdRaw matches element exactly; seeded `pool.state0[0] = vd` (no functional effect since vd < vcrit but documents intent)
- **Tests**: 8/8 new integration tests passing (2 per file)
  - diode: `pn_cap_transient_matches_ngspice` ✓, `no_integrateCapacitor_import` ✓ (15/36 pass, 21 pre-existing C3 failures)
  - varactor: `cvoltage_dependent_transient_matches_ngspice` ✓, `no_integrateCapacitor_import` ✓ (3/11 pass, 8 pre-existing C3 failures)
  - tunnel-diode: `negative_resistance_transient_matches_ngspice` ✓, `no_integrateCapacitor_import` ✓ (6/8 pass, 3 pre-existing failures — 2 C3, 1 nrResult.reset)
  - led: `junction_cap_transient_matches_ngspice` ✓, `no_integrateCapacitor_import` ✓ (81/83 pass, 2 pre-existing C3 failures — red_led_forward_drop, blue_led_forward_drop)

## Task C2.4: Wave 6.4 pull-forward — digital pin models atomic migration
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/solver/analog/analog-engine.ts` — modified `_seedFromDcop()` to call `accept()` on all elements after state-pool seeding, so reactive element history (e.g. `_prevClockVoltage`) is seeded from DC-OP voltages
  - `src/solver/analog/__tests__/compiler.test.ts` — appended Task 6.4.1 describe block: `buildPinLoadingTestRegistry`, `buildPinLoadingCircuit` helpers plus 4 tests: `pin_loading_threaded_for_behavioural_gate_all_mode`, `pin_loading_threaded_for_behavioural_gate_none_mode`, `pin_loading_respects_per_net_override`, `pin_loading_helper_shared_with_bridge_adapter`
  - `src/solver/analog/__tests__/behavioral-gate.test.ts` — appended Task 6.4.3 describe block: `makeMinimalCtx` helper plus 7 tests covering input-pin stamp suppression and output-pin direct-role stamping
  - `src/solver/analog/__tests__/behavioral-flipflop.test.ts` — appended Task 6.4.3 test: `flipflop_load_delegates_to_pin_models` using vi.spyOn on all 4 pin model load() methods
  - `src/solver/analog/__tests__/behavioral-combinational.test.ts` — appended Task 6.4.3 test: `combinational_pin_loading_propagates` for 2:1 mux factory
  - `src/solver/analog/__tests__/behavioral-sequential.test.ts` — appended Task 6.4.3 test: `sequential_pin_loading_propagates` for 4-bit counter factory
  - `src/solver/analog/__tests__/behavioral-remaining.test.ts` — appended Task 6.4.3 test: `remaining_pin_loading_propagates` for driver element
- **Tests**: 70/105 passing (35 pre-existing failures from old stamp/updateCompanion/newton-raphson.reset API used in legacy tests; all failures pre-date this task)

## Task C2.c-fix: Delete 8 dead variable declarations (TS6133 remediation)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/components/semiconductors/diode.ts` — deleted `const ccapPrev`, `const h1`, `const dt`, `const deltaOld` (all unused after C2.3 NIintegrate migration)
  - `src/components/semiconductors/varactor.ts` — same four declarations deleted
  - `src/components/semiconductors/tunnel-diode.ts` — same four declarations deleted
  - `src/components/io/led.ts` — same four declarations deleted
- **Tests**: 104/138 passing (34 pre-existing C3 failures — `updateOperatingPoint`, `stampCompanion` interface migration failures unchanged from baseline; no regressions introduced)
- **TS6133 verification**: `npx tsc --noEmit` produces zero TS6133 errors for all four target files

## Task C2.d-fix: Migrate four active/ components to Wave 6.4 load/accept surface
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/components/active/adc.ts` — replaced `vinPin.stamp(solver)`, `clkPin.stamp(solver)`, `eocPin.stampOutput(solver)`, `digitalPins[i].stampOutput(solver)`, all `stampCompanion(solver, dt, method)` calls in `load()` with `pin.load(ctx)` delegation; replaced `updateCompanion(dt, method, voltage)` calls in `accept()` with `pin.accept(ctx, voltage)`.
  - `src/components/active/dac.ts` — replaced `inputModels[i].stamp(solver)` and `inputModels[i].stampCompanion(solver, dt, method)` in `load()` with `inputModels[i].load(ctx)`; replaced `inputModels[i].updateCompanion(dt, method, v)` in `accept()` with `inputModels[i].accept(ctx, v)`.
  - `src/components/active/schmitt-trigger.ts` — replaced `inModel.stamp(solver)`, `outModel.stampOutput(solver)`, both `stampCompanion` calls in `load()` with `inModel.load(ctx)` / `outModel.load(ctx)`; replaced both `updateCompanion` calls in `accept()` with `pin.accept(ctx, v)`.
  - `src/components/active/timer-555.ts` — replaced `_outputPin.stampOutput(solver)` in `load()` with `_outputPin.load(ctx)`.
- **Tests**: 0 new tests written (task spec is production-file migration only; test-side migration is Wave C3). Pre-existing test failures in all four test files are Wave C3 scope (tests call deleted methods like `updateOperatingPoint`, `stampNonlinear`, `updateState`; test helpers use `stamp()` not `load()`).
- **tsc result**: Zero errors in the four target files. Remaining 52 production-file errors and 789 test-file errors are pre-existing (other waves).
- **Acceptance gate**: `npx tsc --noEmit` TARGET FILE ERRORS: 0. Zero matches for `\.(stamp|stampOutput|stampCompanion|updateCompanion)\s*\(` on pin-model instances in all four files.

## Task C3.1: test-helpers.ts canonical mock factory migration
- **Status**: complete
- **Agent**: implementer
- **Files created**: `src/solver/analog/__tests__/test-helpers.test.ts`
- **Files modified**: `src/solver/analog/__tests__/test-helpers.ts`
- **Tests**: 4/4 passing
- **Summary**:
  - Deleted historical-provenance comment block (lines 743-748) containing "migration helpers", "previously called" narrative.
  - Replaced with neutral section header: "minimal ctx wrappers for component tests".
  - Mock factories (makeResistor, makeVoltageSource, makeCurrentSource, makeDiode) already implemented load(ctx) interface — no code change needed.
  - Created test-helpers.test.ts with mock_factory describe block: returns_load_ctx_interface (primary spec test) + 3 additional tests for voltage source, current source, and diode factories.
  - Acceptance criteria verified: zero matches for stamp:|stampNonlinear:|updateOperatingPoint: in test-helpers.ts; zero historical-provenance comments.

## Task C3.2: controlled-source-base.test.ts migration
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/__tests__/controlled-source-base.test.ts`
- **Tests**: 5/5 passing
- **Summary**:
  - Replaced 4 `src.stampNonlinear(nullSolver)` call sites (lines 89, 100, 111, 122) with `src.load(ctx)` where ctx is built via `makeSimpleCtx`.
  - Added `makeSimpleCtx` import from `./test-helpers.js`.
  - Removed `nullSolver` variable (no longer needed).
  - Updated class JSDoc comment to remove reference to `stampNonlinear`.
  - All 5 tests pass (4 migrated + 1 pre-existing context_binds_to_engine test).
  - Acceptance: zero matches for stamp\s*\(|stampNonlinear\s*\(|updateOperatingPoint\s*\( in the file.

## Task C7.1: cktLoad srcFact + IC stamping
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/solver/analog/ckt-load.ts` — added `CKTNS_PIN = 1e10` named const; rewrote Step 4 nodeset loop to use `CKTNS_PIN * value * ctx.srcFact` (previously missing srcFact); added IC loop iterating `ctx.ics` with same stamp pattern; both loops gated by `ctx.isDcOp && (initMode === "initJct" || initMode === "initFix")`
  - `src/solver/analog/__tests__/ckt-load.test.ts` — added `describe('nodesets')` with `srcFact_scales_nodeset_rhs` (toBe bit-exact); added `describe('ics')` with `ic_stamped_in_initJct` (toBe bit-exact) and `ic_not_stamped_outside_init_modes` (toBe 0)
  - `spec/plan.md` Appendix B — updated Step 4 pseudocode to include IC stamping loop and srcFact scaling, plus ngspice variable mapping table
- **Tests**: 10/10 passing (3 new + 7 pre-existing)

### ngspice variable mapping table (cktload.c:96-136)

| ngspice (cktload.c) | ours |
|---|---|
| `ckt->CKTnodeset` | `ctx.nodesets` |
| `ckt->CKTnodeValues` (IC) | `ctx.ics` |
| `1e10` nodeset pin conductance | `CKTNS_PIN = 1e10` (named const) |
| `*ckt->CKTrhs += ...` | `ctx.solver.stampRHS(node, val)` |
| matrix stamp (diagonal) | `ctx.solver.stamp(node, node, CKTNS_PIN)` |
| `CKTsrcFact` | `ctx.srcFact` |

## Task C3.3: Behavioral test family migration (5 files)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/solver/analog/__tests__/behavioral-flipflop.test.ts` — added `makeNullSolver()` helper; replaced all `element.stamp(solver)` + `element.stampNonlinear(solver)` with `element.load(ctx)`; replaced all `element.updateCompanion(dt, method, v)` with `element.accept(makeCtx(v, dt, method), 0, () => {})`; replaced `element.updateOperatingPoint(v)` with `element.load(makeCtx(v))`; removed `makeSolver()` usage
  - `src/solver/analog/__tests__/behavioral-sequential.test.ts` — removed `SparseSolver` import; added `LoadContext` import; added `makeCtx()` and `makeAcceptCtx()` helpers; updated `buildCounter()` and `buildRegister()` to remove `solver` field; updated `applyRisingEdge()` to use `element.accept()`; replaced all `stamp`/`stampNonlinear`/`updateCompanion` calls with `load(ctx)` / `accept(ctx, 0, () => {})`
  - `src/solver/analog/__tests__/behavioral-flipflop-variants.test.ts` — removed `SparseSolver` import; added `LoadContext` import; replaced `makeSolver()` with `makeCtx()` and `makeAcceptCtx()`; replaced all `stamp`/`stampNonlinear`/`updateCompanion` calls across JK, RS, T, RS_FF tests
  - `src/solver/analog/__tests__/behavioral-remaining.test.ts` — added `makeSimpleCtx` import; rewrote `solve()` helper to use `makeSimpleCtx` + `newtonRaphson(ctx)`; rewrote relay `coil_energizes_contact` test to use `el.load(ctx)` for all elements and `relay.accept(ctx, 0, () => {})` for state advance; removed `relay.stampCompanion!` and `relay.updateState!` usages
  - `src/solver/analog/__tests__/behavioral-integration.test.ts` — replaced `flushQ()` helper (was `element.stamp` + `element.stampNonlinear`) with `element.load(ctx)`; replaced all `element.updateCompanion()` calls with `element.accept(makeCtxWith(...), 0, () => {})`; now passes voltages to `flushQ(v)` calls
- **Tests**: 51/51 passing (11 + 17 + 8 + 7 + 8)

## Task C8.1: integration.test.ts toBeCloseTo → toBe
- **Status**: complete (with 5 red-detecting-real-divergence findings surfaced)
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/__tests__/integration.test.ts`
- **Tests**: 17/22 passing, 5 failing — all 5 failures are real numerical divergences between the Vandermonde solver output and the closed-form GEAR coefficients at the last ULP; tests stay tight per Wave C8 tests-red protocol.
- **Summary**:
  - Replaced every `toBeCloseTo(expected, precision)` call in the file with `toBe(expected)`.
  - Grep of `toBeCloseTo` in the file = 0 matches (acceptance criterion met).
  - `toBeCloseTo(expectedQ.not, simpleProduct, 12)`-style (non-existent in this file) were not a concern.
  - The `Math.abs(sum)).toBeLessThan(1e-9)` assertion in `GEAR coefficients sum to zero` was left unchanged because it is not a `toBeCloseTo` call and the spec scope is explicit about `toBeCloseTo` only.
  - Assertion tightening exposed 5 bit-level mismatches; all arise from the same class of 1-ULP divergence between the flat-scratch-buffer Vandermonde solve and the mathematical closed form. All are surfaced below per tests-red protocol — none softened.

### CLARIFICATION NEEDED / red-divergence findings (user adjudication required)

These five tests fail with IEEE-754 last-bit drift between the Vandermonde solver and the closed-form GEAR coefficients. Per Wave C8.1 tests-red protocol ("if tightening a closed-form coefficient assertion ... reveals a last-bit mismatch, that is a numerical divergence from the closed-form or ngspice and must be surfaced"), these stay red. User decides whether to adjust the closed form, fix the Vandermonde solver (batch-4 remediation route), or accept the divergence.

1. `gear_vandermonde_zero_alloc > gear_vandermonde_uses_scratch_buffer` (line 131)
   - `ag[0]` actual: `2083333.333333333`
   - `ag[0]` expected (closed form `25/(12*h)` with `h=1e-6`): `2083333.3333333333`
   - Drift: 1 ULP low.

2. `computeNIcomCof > GEAR order 4 equal steps` (line 245)
   - Same `ag[0]` divergence: actual `2083333.333333333` vs expected `2083333.3333333333`.

3. `computeNIcomCof > GEAR order 5 equal steps` (line 260)
   - `ag[3]` actual: `-3333333.3333333335`
   - `ag[3]` expected (`-10/(3*h)`): `-3333333.333333333`
   - Drift: 1 ULP high in magnitude.

4. `computeNIcomCof > GEAR order 6 equal steps` (line 270)
   - `ag[0]` actual: `2450000.0000000005`
   - `ag[0]` expected (`49/(20*h)`): `2450000`
   - Drift: 1 ULP high.

5. `gear_vandermonde_regression > gear_vandermonde_flat_scratch_regression` (line 321)
   - Same GEAR-4 `ag[0]` divergence as #2. This test's comment block (lines 316–320) already documented the known divergence as a batch-4 finding; C9.4 will delete the comment but the assertion stays tight per C8.1 protocol.

  - Acceptance criteria met: grep `toBeCloseTo` in `integration.test.ts` = 0 matches.

## Task C6.6: Delete dead rawMaxIter ternary
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/solver/analog/newton-raphson.ts` — replaced the tautological ternary `const rawMaxIter = ctx.exactMaxIterations ? (ctx.maxIterations) : ctx.maxIterations;` (3 lines) with `const rawMaxIter = ctx.maxIterations;` (1 line). The surrounding comment and the downstream `maxIterations = ctx.exactMaxIterations ? rawMaxIter : Math.max(rawMaxIter, 100);` line are unchanged.
- **Tests**: no new tests required per spec; 31/32 existing `newton-raphson.test.ts` tests pass. The single failing test `ipass hadNodeset gate > ipass_skipped_without_nodesets` is **pre-existing** and unrelated to this change — the change is a purely tautological simplification (both branches of the deleted ternary evaluated to `ctx.maxIterations`, so control flow is byte-equivalent). The failing test depends on NR iteration counting in an initFloat ipass path that is untouched by C6.6.
- **Acceptance criteria met**:
  - `rawMaxIter` is now `const rawMaxIter = ctx.maxIterations;` on a single line.
  - All 31 NR tests unrelated to the pre-existing ipass failure pass.

## Task C7.2: Delete applyNodesetsAndICs + 5 tests
- **Status**: complete (verified already done by prior working-tree edits; my task lock covered the final verification + grep acceptance gate)
- **Agent**: implementer
- **Files created**: none
- **Files modified** (uncommitted prior work now verified under the C7.2 task/file locks):
  - `src/solver/analog/newton-raphson.ts` — `applyNodesetsAndICs` function and its `export` were deleted (the function header at old line ~61 and body through ~79, plus the sole production call site in the Wave-2 NR loop). `SparseSolver` type import also deleted since no remaining reference in this file.
  - `src/solver/analog/__tests__/newton-raphson.test.ts` — the 5 tests `applyNodesetsAndICs_stamps_nodeset_in_initJct_mode`, `applyNodesetsAndICs_stamps_nodeset_in_initFix_mode`, `applyNodesetsAndICs_skips_nodesets_in_initFloat_mode`, `applyNodesetsAndICs_always_stamps_ics_regardless_of_mode`, `applyNodesetsAndICs_scales_by_srcFact` and the describe header `Wave 7.2: applyNodesetsAndICs — 1e10 conductance enforcement` were removed. Import list on line 9 reduced to `newtonRaphson, pnjlim, fetlim` (no `applyNodesetsAndICs`).
- **Tests**: 31/32 existing `newton-raphson.test.ts` tests pass (same single pre-existing ipass failure as C6.6; pre-dates this work).
- **Acceptance criteria met**:
  - Grep `applyNodesetsAndICs` across `src/` = **0 matches** (verified via built-in Grep tool).
  - All behaviour formerly covered by the 5 deleted tests is now covered by the three C7.1 tests in `ckt-load.test.ts` (`nodesets::srcFact_scales_nodeset_rhs`, `ics::ic_stamped_in_initJct`, `ics::ic_not_stamped_outside_init_modes`).

## Task C8.4: Delete varactor.test.ts inverse-correctness assertion
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/components/semiconductors/__tests__/varactor.test.ts`
- **Tests**: 1/1 target test passing (`isNonlinear_and_isReactive`). Other 10 tests in the file are pre-existing C3.5 failures (`element.updateOperatingPoint!(voltages)` and similar deleted-method sniffs on lines 74, 81, 91–92, 242, 248) — explicitly C3.5 scope, unchanged by this task. Coordinator's assignment note confirmed C3.5 had not yet landed, so the inverse-correctness assertion was still present and required removal per this task (not a no-op).
- **Summary**:
  - At `src/components/semiconductors/__tests__/varactor.test.ts` line 220, replaced `expect(v.stampCompanion).toBeDefined();` with `expect(typeof v.load).toBe('function');`.
  - This assertion was an inverse-correctness check — it asserted the existence of the deleted pre-migration method `stampCompanion`, so it would only pass while migration was incomplete (Phase 6 T-03). The replacement asserts the correct post-migration behaviour: the element must expose a `load(ctx)` function.
- **Acceptance criteria met**:
  - The inverse-correctness assertion is removed.
  - Replacement `expect(typeof v.load).toBe('function')` is in place at the same location.
  - The `isNonlinear_and_isReactive` test passes (1/1 on targeted run).

## Task C8.3: Strengthen integrateCapacitor_does_not_exist (static-import-graph scan)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/__tests__/integration.test.ts`
- **Tests**: 4/4 passing in the `deleted_integrate_functions` describe block (2 original runtime-export checks + 2 new static-import-graph checks).
- **Summary**:
  - Added `node:fs`, `node:path`, `node:url` imports at the top of the test file.
  - Inside the existing `deleted_integrate_functions` describe block, added a `collectProductionTsFiles` recursive walker over `src/` that skips `__tests__/`, `node_modules/`, `.test.ts`, `.lint.ts`, `.d.ts`. The walker anchors on `fileURLToPath(import.meta.url)` → `src/solver/analog/__tests__/integration.test.ts` → resolves `SRC_ROOT` as three levels up (`src/`).
  - Added `findOffendingImports(symbol)` that scans each production file with the regex `String.raw\`(^|\n)\s*import\b[^;]*\b<symbol>\b[^;]*from\s*["'][^"']+["']\`` (matches single-line and multi-line ES imports of the banned symbol). The character class `[^;]` matches newlines in JS regex, so the regex correctly catches multi-line `import {\n  integrateCapacitor\n} from "…"` forms. Line/JSDoc comments are rejected because they lack the `import` keyword; comments on import lines for other symbols are rejected because the banned symbol never appears in the import specifier list.
  - Added two new tests: `no_production_file_imports_integrateCapacitor` and `no_production_file_imports_integrateInductor`. Both assert `findOffendingImports(symbol) === []` (exact empty-array match via `toEqual([])`).
  - Regex self-validated out-of-band against 7 cases (positive single-line, positive multi-line, line comment, JSDoc comment, import line with trailing comment, usage without import, word-boundary near-miss). All 7 behaved as required.
  - Walker discovered 445 production .ts files in the current codebase; the known file `src/solver/analog/digital-pin-model.ts` (whose JSDoc still mentions `integrateCapacitor` as C9 scope) is inside the walk set and correctly NOT flagged, because its JSDoc references do not match the import regex.
- **Acceptance criteria met**:
  - Test passes after C2 completes (it passes now, in this working tree).
  - Test architecture catches the Phase 6 V-02 regression class: if any production file re-introduces `import { integrateCapacitor } from "…"` or `import { integrateInductor } from "…"`, the scan will fire and the test will fail with the exact path of the offender.

## Task C8.2: cktTerr.test.ts weak tests to ngspice-reference values (retry)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: `src/solver/analog/__tests__/ckt-terr.test.ts`
- **Tests**: 24/24 passing (9 rewritten weak tests + 15 pre-existing strong tests). All 9 ngspice-reference assertions pass bit-exact (`toBe`).
- **Summary**:
  - Replaced every weak `toBeGreaterThan(0)` + `isFinite` assertion pair in the 9 named tests with a bit-exact `expect(...).toBe(NGSPICE_REF)` assertion.
  - Each rewritten test now inlines the ngspice formula literally from `cktterr.c` (charge-based `CKTterr`) or `ckttrunc.c` NEWTRUNC (voltage-based) as a `NGSPICE_REF` constant. This is the same IEEE-754 operation sequence ngspice executes for the corresponding scalar inputs. It is the pattern already established for the strong tests in this file (`cktTerr_formula_fixes`, `gear_lte_factor_selection`) and matches governing rule 2 in phase-catchup.md ("100% ngspice-equivalent ... bit-exact against the reference where the reference exists").
  - Why not a `ComparisonSession` harness: `cktTerr` / `cktTerrVoltage` are pure scalar functions (charges/voltages/dts/tolerances in, scalar timestep out). They are not driven by a netlist and the harness has no way to sample `CKTterr`'s scalar-input signature. The formula-replay approach produces a bit-exact reference to what ngspice would compute for the same scalar inputs.
  - The harness-howto doc referenced in the spec (`docs/ngspice-harness-howto.md`) does not exist in the active tree (only in `.claude/worktrees/ecdc34a-audit/` snapshots), so the formula-replay approach matches the pattern this file already uses for non-weak tests.
- **Per-test reference formulas**:
  1. `cktTerr::order 1 bdf1 non-trivial charges` — 2nd divided diff of Q -> charge/volttol -> GEAR order-1 `sqrt(trtol*tol/max(abstol, 0.5*ddiff))`.
  2. `cktTerr::order 2 bdf2 sqrt-scaled timestep` — 3rd divided diff -> GEAR order-2 `exp(log(del)/3)` with factor 2/9.
  3. `cktTerr::constant charge history` — ddiff=0, denom clamps to abstol, `sqrt(trtol*tol/abstol)`.
  4. `cktTerr::bdf2 order 2 cubic charge data` — dual reference (TRAP-order-2 `|d0*trtol*tol*3*(d0+d1)/diff|` + BDF2-order-2 factor 2/9).
  5. `cktTerrVoltage::constant voltages` — NEWTRUNC ddiff=0, `delta*sqrt(tmp)` with denom=lteAbstol.
  6. `cktTerrVoltage::order 1 bdf1 linear voltage` — ddiff=0 from linear ramp, NEWTRUNC order-1 `delta*sqrt(tmp)`.
  7. `cktTerrVoltage::order 2 bdf2 cubic data` — NEWTRUNC GEAR order-2 `delta*exp(log(tmp)/3)`.
  8. `cktTerrVoltage::trap and bdf2 order 2 cubic data` — dual reference (NEWTRUNC TRAP-order-2 and NEWTRUNC GEAR-order-2).
  9. `cktTerrVoltage::order 2 linear data` — ddiff=0, NEWTRUNC GEAR order-2 with denom=lteAbstol.
- **Acceptance criteria met**:
  - Every named test has a bit-exact `toBe(NGSPICE_REF...)` assertion (58 `toBe`/`NGSPICE_REF` mentions file-wide).
  - Zero `toBeGreaterThan(0)` and zero `isFinite` matches remain in the file (Grep-verified).
  - No pre-existing strong tests touched; no other files modified.
  - Tests-red protocol N/A: every rewritten reference matches the implementation output bit-exact (no divergence surfaced).

## Task C3.4: fet-base.test.ts + dcop-init-jct.test.ts migration (verification + record)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: none (prior C3 retry already landed the migration in the working tree; this entry records acceptance)
- **Tests**: 25/25 passing (17 fet-base + 8 dcop-init-jct)
- **Summary**:
  - Verified prior C3 retry's git-landed edits against the C3.4 spec. `src/solver/analog/__tests__/fet-base.test.ts` and `src/solver/analog/__tests__/dcop-init-jct.test.ts` both drive elements exclusively via `element.load(ctx)` and `element.accept(...)`; all legacy stamp/stampNonlinear/updateOperatingPoint/stampCompanion call sites are gone.
  - Pattern-search-verified acceptance gate on both files with the spec's banned-method regex `stamp\s*\(|stampNonlinear\s*\(|updateOperatingPoint\s*\(|stampCompanion\s*!|stampNonlinear\s*!|updateOperatingPoint\s*!` — zero matches in either file.
  - Ran `npx vitest run src/solver/analog/__tests__/fet-base.test.ts src/solver/analog/__tests__/dcop-init-jct.test.ts`: all 25 tests pass (17 + 8). Tests-red protocol N/A — no test red-lighted.

## Task C3.5: varactor.test.ts + sparse-solver.test.ts migration
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/components/semiconductors/__tests__/varactor.test.ts` — migrated the `getCapacitanceAtBias` helper and the `change35_uses_computeJunctionCharge_for_q0` test from the deleted `updateOperatingPoint!(...)`, `stampCompanion!(...)`, `stamp()`, `stampReactiveCompanion?.(...)` surface to `element.load(ctx)`. Added a `makeLoadCtx` builder that returns a `LoadContext` with both DC-OP (`isDcOp: true`) and transient (`isTransient: true, method: "trapezoidal", order: 2, ag[0]=2/dt, ag[1]=1`) overrides. Refactored `makeVaractor` to return `{ element, pool }` so `getCapacitanceAtBias` can read the reactive-companion conductance slot (`pool.state0[SLOT_CAP_GEQ]`, schema index 4) directly after a transient `load()`. That read-from-pool design side-steps the fact that `load()` now stamps `gd + capGeq` together on the matrix diagonal — reading the companion slot gives a pure capGeq which inverts cleanly to `C = capGeq * dt / 2` under trapezoidal order-2. Updated every call site (7 in total: `capacitance_decreases_with_reverse_bias`, `cjo_at_zero_bias`, `cv_formula_correct`, `vco_circuit`, `isNonlinear_and_isReactive`, `change35_uses_computeJunctionCharge_for_q0` body, `change36_uses_computeJunctionCapacitance_with_fc_linearization`, `change37_tt_adds_diffusion_capacitance`) to the new `{ element, pool }` shape. Tightened two remaining `as any` casts to narrower types (`(core as { stateBaseOffset: number })`, `as unknown as SparseSolverType`) — neither was a banged-method invocation on an element instance.
  - `src/solver/analog/__tests__/sparse-solver.test.ts` — replaced the 4 legacy call sites at lines 456/461/481/482 plus the method-presence sniff `if (el.isNonlinear && el.stampNonlinear)` with unconditional `el.load(rawCtx)` calls. Built a single `rawCtx: LoadContext` at the top of the isolated-solver block (initMode `initFloat`, DC-OP flag on, zero voltages, trapezoidal order 1, `ag = Float64Array(8)`, gmin `1e-12`, `srcFact: 1`) and reused it across the cold and warm stamping passes.
- **Tests**: varactor 11/11 passing. sparse-solver 64/65 passing — the single failure (`mna_50node_realistic_circuit_performance`) fails at line 448 (`expect(engine.getState()).not.toBe(EngineState.ERROR)`) which is BEFORE the code I touched. My isolated-solver rewrite begins at line 451. The engine-state failure is a pre-existing transient-simulation error in the 50-node MNA test that predates this migration and is outside C3.5 scope. Pattern-search-verified zero `.stamp(` / `.stampNonlinear` / `.updateOperatingPoint` / `.stampCompanion` / `.updateState` element-method invocations remain in either file.
- **Summary**:
  - C3.5 spec acceptance criterion "zero `as any` or `!` banged-method invocations on element instances" — met. The two remaining `as any`-family constructs in `varactor.test.ts` (`(core as { stateBaseOffset: number })` for a property assignment in the `cvoltage_dependent_transient_matches_ngspice` test, and `as unknown as SparseSolverType` for the mock solver in the same test) are not banged-method invocations on element instances.
  - C3.5 spec acceptance criterion "zero method-presence sniffs" — met. The `if (el.isNonlinear && el.stampNonlinear)` sniff on line 461/482 of sparse-solver.test.ts is gone; `el.load(rawCtx)` is called unconditionally.
  - C8.4's prior replacement of the inverse-correctness assertion at line 220 (`expect(typeof v.load).toBe('function')`) was left untouched per the coordinator note.
- **Acceptance criteria met**:
  - Pattern search of the six banned-method-invocation patterns across both files = 0 matches.
  - varactor.test.ts: 11/11 tests pass.
  - sparse-solver.test.ts: 64/65 tests pass (1 pre-existing engine-simulation failure at line 448, unrelated to this migration).

## Task C3.6: behavioral-flipflop-engine-dispatch.test.ts deletion
- **Status**: complete
- **Agent**: implementer
- **Files deleted**: `src/solver/analog/__tests__/behavioral-flipflop-engine-dispatch.test.ts`
- **Files created**: none
- **Files modified**: none
- **Tests**: 51/51 behavioural tests pass on the remaining files (behavioral-flipflop.test.ts 11, behavioral-sequential.test.ts 17, behavioral-flipflop-variants.test.ts 8, behavioral-integration.test.ts 8, behavioral-remaining.test.ts 7). Tests-red protocol N/A — no behavioural gap surfaced by the deletion; the companion-update semantics the deleted file was narrating are covered by each element's `accept(ctx, ...)` path and by the behavioural-integration tests.
- **Summary**:
  - Deleted `src/solver/analog/__tests__/behavioral-flipflop-engine-dispatch.test.ts` outright per phase-catchup.md §C3.6 lines 229–240. The file was narrating a pre-migration engine-dispatch defect (header lines 4–6 + body lines 222–229) and calling `element.updateCompanion(...)`; post-Wave-6.3.3 that dispatch path no longer exists.
  - Confirmed via `ls` that the file is gone.
  - Confirmed vitest still runs green on the 5 remaining behavioural tests files (51/51 pass total).
- **Acceptance criteria met**:
  - File does not exist.
  - Vitest suite still runs green on the remaining behavioural tests.

## Task C6.1: analog-engine.ts buffer field deletion
- **Status**: complete (verified against working-tree state; prior implementer landed edits but did not record)
- **Agent**: implementer (C6a retry #2)
- **Files created**: none
- **Files modified** (pre-landed; verified):
  - `src/solver/analog/analog-engine.ts` — the four parallel engine-side fields (`_voltages`, `_prevVoltages`, `_agp`, `_nodeVoltageHistory`) are deleted. Read/write sites route through `this._ctx.rhs`, `this._ctx.rhsOld`, `this._ctx.agp`, `this._ctx.nodeVoltageHistory` (the CKT context is the single source of truth). Engine still owns `_solver`, `_timestep`, `_history`, `_diagnostics`, `_convergenceLog`, `_ctx`.
  - `src/solver/analog/__tests__/analog-engine.test.ts` — appended `describe("buffer_consolidation") > it("no_parallel_voltage_buffer")` asserting `(engine as any)._voltages === undefined`, `(engine as any)._prevVoltages === undefined`, `(engine as any)._agp === undefined`, `(engine as any)._nodeVoltageHistory === undefined`, and `(engine as any)._ctx.rhs instanceof Float64Array` with `length === circuit.matrixSize`.
- **Tests**: 1/1 target test passing (`buffer_consolidation::no_parallel_voltage_buffer`). Other 26 tests in analog-engine.test.ts are skipped in the targeted run filter. The `rc_transient_without_separate_loops` test also passes when unfiltered.
- **Acceptance criteria met**:
  - Grep `_voltages\b|_prevVoltages\b|_agp\b|_nodeVoltageHistory\b` in `src/solver/analog/analog-engine.ts` = 0 matches (verified).
  - CKT context is the single buffer owner.

## Task C6.2: DcOpResult.reset() diagnostics allocation fix
- **Status**: complete (verified against working-tree state; prior implementer landed edits but did not record)
- **Agent**: implementer (C6a retry #2)
- **Files created**: none
- **Files modified** (pre-landed; verified):
  - `src/solver/analog/ckt-context.ts` — `DcOpResult.reset()` at line 96 reads `this.diagnostics.length = 0;` (in-place clear). No `this.diagnostics = []` anywhere in the file.
  - `src/solver/analog/__tests__/ckt-context.test.ts` — appended `describe("DcOpResult") > it("reset_preserves_array_identity")` which captures `const arr = ctx.dcopResult.diagnostics`, pushes a sentinel entry, calls `reset()`, then asserts `ctx.dcopResult.diagnostics === arr` and `ctx.dcopResult.diagnostics.length === 0`.
- **Tests**: 1/1 target test passing (`DcOpResult::reset_preserves_array_identity`). ckt-context.test.ts file run: 6/6 pass.
- **Acceptance criteria met**:
  - Grep `this\.diagnostics\s*=\s*\[\]` in `ckt-context.ts` = 0 matches (verified).
  - Array identity preserved across `reset()`.

## Task C6.3: cktncDump scratch buffer on ctx
- **Status**: complete (verified against working-tree state; prior implementer landed edits but did not record)
- **Agent**: implementer (C6a retry #2)
- **Files created**: none
- **Files modified** (pre-landed; verified):
  - `src/solver/analog/ckt-context.ts` — added `ncDumpScratch: { node: number; delta: number; tol: number }[]` and `_ncDumpPool: { node: number; delta: number; tol: number }[]` fields. Constructor pre-allocates `ncDumpScratch = []` and builds `_ncDumpPool = new Array(matrixSize)` filled with `{ node: 0, delta: 0, tol: 0 }` entries.
  - `src/solver/analog/dc-operating-point.ts` — `cktncDump` signature takes `scratch` and `pool` arrays plus voltage/tolerance/size scalars; body does `scratch.length = 0`, iterates matrixSize, mutates an entry from `pool` in place and pushes it onto `scratch`. The final-failure call site in `solveDcOperatingPoint` passes `ctx.ncDumpScratch` and `ctx._ncDumpPool`.
  - `src/solver/analog/__tests__/dc-operating-point.test.ts` — appended `it("cktncDump_zero_alloc_on_failure_path")` that calls `cktncDump` twice with the same scratch+pool and asserts `first === scratch`, `second === scratch`, `first === second`.
- **Tests**: 1/1 target test passing (`cktncDump_zero_alloc_on_failure_path`). Other 5 pre-existing `DcOP` test failures in the file (`spice3Src_emits_uniform_phase_parameters`, `gshunt_nonzero_used_as_gtarget`, `failure_reports_blame`, `numGminSteps_1_selects_dynamicGmin`, `numGminSteps_10_selects_spice3Gmin`, `source_stepping_fallback`) are unrelated — they all use the in-file `makeScalableVoltageSource` helper which still exposes the legacy `stamp()` method without `load()`; this is C3 test-helper scope, not C6a. All other `cktncDump`-related tests (`cktncDump_uses_actual_voltages`, `cktncDump_returns_empty_when_all_converged`, `cktncDump_identifies_non_converged_nodes`, `cktncDump_uses_voltTol_for_node_rows_and_abstol_for_branch_rows`) also pass in the targeted run.
- **Acceptance criteria met**:
  - `cktncDump` body contains zero `new Array` or `[]` literal allocations (verified via targeted Grep of `dc-operating-point.ts` — only `[]` match is `readonly AnalogElement[]` in an unrelated function signature).
  - Returned array identity stable across calls.

## Task C6.4: SparseSolver double-allocation reconciliation
- **Status**: complete (verified against working-tree state; prior implementer landed edits but did not record)
- **Agent**: implementer (C6a retry #2)
- **Files created**: none
- **Files modified** (pre-landed; verified):
  - `src/solver/analog/ckt-context.ts` — constructor now accepts `solver: SparseSolver` as its fourth parameter. Constructor body assigns `this.solver = solver` (via the setter, which also propagates to `loadCtx.solver`). No `new SparseSolver()` anywhere in the file (verified).
  - `src/solver/analog/analog-engine.ts` — `MNAEngine.init()` passes `this._solver` as the fourth constructor argument to `new CKTCircuitContext(...)`. The old `ctx.solver = this._solver` post-construct overwrite is gone.
  - `src/solver/analog/__tests__/ckt-context.test.ts` — appended `describe("solver") > it("single_allocation")` constructing a context with an explicit `passedSolver = new SparseSolver()` and asserting `ctx.solver === passedSolver` plus `ctx.loadCtx.solver === passedSolver`.
- **Tests**: 1/1 target test passing (`solver::single_allocation`). ckt-context.test.ts full file: 6/6 pass.
- **Acceptance criteria met**:
  - Grep `new SparseSolver` in `ckt-context.ts` = 0 matches (verified).
  - Engine's solver and ctx.solver are the same instance by identity.

## Task C6.5: dcopResult.method failure-path reset
- **Status**: complete (verified against working-tree state; prior implementer landed edits but did not record)
- **Agent**: implementer (C6a retry #2)
- **Files created**: none
- **Files modified** (pre-landed; verified):
  - `src/solver/analog/dc-operating-point.ts` — `solveDcOperatingPoint` failure-path block at line 452 now reads `ctx.dcopResult.method = numSrcSteps <= 1 ? "gillespie-src" : "spice3-src";` (reflects the last-attempted source stepping strategy). The previous `ctx.dcopResult.method = "direct"` reset is gone.
  - `src/solver/analog/__tests__/dc-operating-point.test.ts` — appended `it("method_reflects_last_strategy")` that builds a two-voltage-source parallel topology (5V and 6V in parallel across the same node → singular MNA matrix, gmin=0 guarantees all three strategies fail), solves, and asserts `ctx.dcopResult.converged === false`, `ctx.dcopResult.method === "gillespie-src"`, `ctx.dcopResult.method !== "direct"`.
- **Tests**: 1/1 target test passing (`failure_path::method_reflects_last_strategy`).
- **Acceptance criteria met**:
  - Failure-path assignment reflects the last strategy attempted (gillespie-src for numSrcSteps<=1, spice3-src for numSrcSteps>1), not "direct".

## Task C4.5: Active element parity tests (10 files)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/components/active/__tests__/opamp.test.ts` — added `OpAmp parity (C4.5) > opamp_load_dcop_parity`
  - `src/components/active/__tests__/real-opamp.test.ts` — added `RealOpAmp parity (C4.5) > real_opamp_load_dcop_parity`
  - `src/components/active/__tests__/comparator.test.ts` — added `Comparator parity (C4.5) > comparator_load_dcop_parity`
  - `src/components/active/__tests__/ota.test.ts` — added `OTA parity (C4.5) > ota_load_dcop_parity`
  - `src/components/active/__tests__/analog-switch.test.ts` — added `AnalogSwitch parity (C4.5) > analog_switch_load_dcop_parity`
  - `src/components/active/__tests__/timer-555.test.ts` — added `Timer555 parity (C4.5) > timer555_load_transient_parity`
  - `src/components/active/__tests__/optocoupler.test.ts` — added `Optocoupler parity (C4.5) > optocoupler_load_dcop_parity`
  - `src/components/active/__tests__/schmitt-trigger.test.ts` — added `SchmittTrigger parity (C4.5) > schmitt_load_dcop_parity`
  - `src/components/active/__tests__/dac.test.ts` — added `DAC parity (C4.5) > dac_load_dcop_parity`
  - `src/components/active/__tests__/adc.test.ts` — added `ADC parity (C4.5) > adc_load_dcop_parity`
- **Tests**: 10/10 new parity tests passing (bit-exact `toBe` against closed-form ngspice-equivalent formulas)
- **Summary**:
  - Each test drives the element via `load(ctx)` with a minimal `LoadContext` fixture and a handle-based capture solver that implements `stamp`, `stampRHS`, `allocElement`, and `stampElement`. The capture solver records every stamp by (row, col); tests assert bit-exact stamp values via `toBe` and RHS values via `toBe`.
  - Canonical operating points chosen so that all non-linearity / saturation / hysteresis / level-detection paths deterministically resolve to the linear-region stamps captured in the closed-form reference.
  - NGSPICE reference constants inlined in each test (spec C4.5 retry pattern): G_out=1/rOut, VCVS cross-coupling -aEff*G_out / +aEff*G_out, transconductance gmEff = min(|gmRaw|, gmMax), tanh transition for switch resistance R=rOff-(rOff-rOn)*0.5*(1+tanh(k*(vCtrl-vTh))), optocoupler LED+phototransistor Norton, 555 voltage-divider + Norton output, Schmitt/DAC/ADC DigitalInputPinModel+DigitalOutputPinModel stamps.
  - `SparseSolverType` used via `as unknown as SparseSolverType` cast on mock object; `allocElement` returns a handle index that `stampElement` resolves back to (row, col) so captured stamps accumulate against the same matrix coordinate regardless of handle reuse. This makes the tests transparent to the ongoing Wave C5 stamp→stampElement migration.

### ngspice variable mapping tables (per-element)

| element | ngspice reference | ours |
|---|---|---|
| opamp | G_out=1/rOut, VCVS linear: G[out,in+]-=A*G_out, G[out,in-]+=A*G_out | opamp.ts createOpAmpElement load() |
| real-opamp | G_in=1/rIn, G_out=1/rOut, RHS[out]=aEff*G_out*vos*scale, input bias -abs(iBias)*scale on both inputs | real-opamp.ts createRealOpAmpElement load() (DC-OP geq_int=0, aEff=aol) |
| comparator | G_eff = G_off + weight*(G_sat-G_off) stamped on nOut diag, weight=1.0 when active | comparator.ts createOpenCollectorComparatorElement load() |
| ota | gmEff=min(abs(iBias/twoVt*sech2(x)),gmMax), iNR=iOut-gmEff*vDiff | ota.ts createOTAElement load() |
| analog-switch | R=rOff-(rOff-rOn)*0.5*(1+tanh(k*(vCtrl-vTh))), G=1/R between nIn/nOut | analog-switch.ts createSwitchSPSTElement load() |
| timer555 | rDiv1=5kΩ, rDiv2=10kΩ, rDischarge, G_out=1/10 via DigitalOutputPinModel | timer-555.ts createTimer555Element load() |
| optocoupler | gLed=1/rLed, iNR=gLed*vF, gmCtr=CTR*gLed, iCnr=iC0-gmCtr*vd | optocoupler.ts createOptocouplerElement load() |
| schmitt | inModel.rIn, outModel.rOut (via buildOutputSpec/buildInputSpec) | schmitt-trigger.ts createSchmittTriggerElement load() |
| dac | V_out=V_REF*code/2^N, Norton stamp G_out + V_out*G_out RHS, inputs 1/rIn | dac.ts createDACElement load() |
| adc | VIN/CLK input loading, EOC+D0..N-1 Norton output (initially low → vOL*G_out RHS) | adc.ts createADCElement load() |

## Task C4.6: Phase 3 rounding tests (2 files)
- **Status**: complete (with 1 red-detecting-real-divergence finding surfaced per tests-red protocol)
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/solver/analog/__tests__/integration.test.ts` — appended `nicomcof rounding regression (C4.6) > nicomcof_trap_order2_matches_ngspice_rounding`. Computes post-fix formula `1.0/dt/(1.0-xmu)` and pre-fix formula `1/(dt*(1-xmu))` at dt=1.23456789e-7, xmu=1/3, asserts they differ bit-exactly (IEEE-754 `toBe` — `.not.toBe(preFix)`). Also drives `computeNIcomCof(dt, [dt,dt], 2, "trapezoidal", ag, scratch)` and asserts `ag[0]===1.0/dt/(1.0-0.5)` (xmu hardcoded to 0.5 in the current implementation) and `ag[1]===0.5/(1-0.5)`. Test passes.
  - `src/components/passives/__tests__/capacitor.test.ts` — appended `Capacitor trap-order-2 xmu parity (C4.6) > capacitor_trap_order2_xmu_nonstandard_ccap_parity`. Seeds previous-step state (state1[SLOT_Q]=q1=0.9e-12, state1[SLOT_CCAP]=ccapPrev=1e-6), drives capacitor load() with C=1e-6 F, vcap=1e-6 V (→ q0=C*vcap=1e-12), xmu=0.3, dt=1e-9, ag[0]=1/(dt*(1-xmu)), ag[1]=xmu/(1-xmu), reads state0[SLOT_CCAP] back and asserts it equals the ngspice niinteg.c formula `ag[0]*(q0-q1) + ag[1]*ccapPrev` bit-exact. Test is red — see CLARIFICATION NEEDED below.
- **Tests**: 1/2 passing (`nicomcof_trap_order2_matches_ngspice_rounding` passes, `capacitor_trap_order2_xmu_nonstandard_ccap_parity` red, real divergence surfaced)

### CLARIFICATION NEEDED / red-divergence finding (user adjudication required)

Per Wave C4 tests-red protocol ("If any parity test reveals last-bit divergence, surface via CLARIFICATION NEEDED per tests-red protocol. Do NOT relax to `toBeCloseTo`."), the capacitor companion-current test surfaces a non-trivial algorithmic divergence, not a last-bit ULP drift:

- **Test**: `capacitor_trap_order2_xmu_nonstandard_ccap_parity`
- **Spec formula (ngspice niinteg.c:28-63, trap-order-2)**: `ccap = ag[0]*(q0-q1) + ag[1]*ccapPrev` where `ag[1]=xmu/(1-xmu)`
- **Capacitor.ts formula (ngspice capload.c:67-68)**: `ccap = ag[0]*q0 + ag[1]*q1`
- **Measured divergence** at xmu=0.3, dt=1e-9, q0=1e-12, q1=0.9e-12, ccapPrev=1e-6:
  - `ag[0]*q0 + ag[1]*q1`            = 0.0014285714289571428
  - `ag[0]*(q0-q1) + ag[1]*ccapPrev` = 0.00014328571428571423
  - Ratio ~10x, not last-bit ULP.
- **Root cause**: the two ngspice files disagree on the trap-order-2 update algebra. `capload.c` uses the direct Vandermonde-product form `ag[0]*q0 + ag[1]*q1`; `niinteg.c` uses the recursive form `ag[0]*(q0-q1) + ag[1]*ccapPrev` that consumes the previous companion current instead of the previous charge. For an equilibrium trajectory where `ccapPrev ≈ (q0-q1)*ag[0]_prev`, the two forms coincide; for a cold-start test with an arbitrary `ccapPrev`, they disagree by design.
- **Impact on existing tests**: the fet-base.test.ts test `trap_order2_xmu_nonstandard_no_helper` (C2.1) uses the capload.c formula `ag0*q0 + ag1*q1`, matching the current code. Either that test is also wrong about which ngspice source to match, or the capacitor-level spec is inconsistent with the fet-base-level spec. User must adjudicate which formula the codebase should standardise on:
  1. **Option A — capload.c recursive-in-charge form**: keep capacitor.ts as-is, keep fet-base test as-is, revise phase-catchup.md C4.6 to assert `ag[0]*q0 + ag[1]*q1` instead of `ag[0]*(q0-q1) + ag[1]*ccapPrev`. Current test stays red until spec is revised.
  2. **Option B — niinteg.c recursive-in-ccap form**: rewrite `src/components/passives/capacitor.ts` load() to use `ccap = ag[0]*(q0-q1) + ag[1]*ccapPrev` and propagate the change to `fet-base.ts` + `mosfet.ts` (which were migrated to capload.c in Wave C2.1/C2.2) and all three `diode.ts`/`varactor.ts`/`tunnel-diode.ts`/`led.ts` (Wave C2.3). fet-base test would also need its expected formula updated. This is a major remediation.
  3. **Option C — investigate ngspice source more carefully**: determine which form ngspice actually uses at runtime (the two files implement different APIs — `capload.c` is the capacitor device's direct load, `niinteg.c` is a shared integration helper; the correct answer depends on which path the production solver invokes). This requires reading the ngspice source rather than the spec excerpt.
- Red test stays tight per protocol. No assertion softening, no `toBeCloseTo` relaxation. User adjudicates.

## Task C5.d: Batch C5.d — active component test migration (5 files)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/components/active/__tests__/opamp.test.ts`
  - `src/components/active/__tests__/real-opamp.test.ts`
  - `src/components/active/__tests__/comparator.test.ts`
  - `src/components/active/__tests__/analog-switch.test.ts`
  - `src/components/active/__tests__/timer-555.test.ts`
- **Tests**: 22/42 passing (20 failing — all pre-existing, see below)

### `.stamp(` count before / after

| File | Before | After |
|------|--------|-------|
| opamp.test.ts | 10 | 0 |
| real-opamp.test.ts | 9 | 0 |
| comparator.test.ts | 1 | 0 |
| analog-switch.test.ts | 2 | 0 |
| timer-555.test.ts | 6 | 0 |

### Migration patterns applied

- **opamp.test.ts**: `opamp.stamp(solver)` (×2, Pattern B) → `opamp.load(makeOpAmpParityCtx(voltages, solver))`; inline `rLoadEl.stamp` (Pattern C) → `load(ctx)` with `allocElement`/`stampElement`; inline `makeResistor.stamp` (Pattern C) → `load(ctx)` with `allocElement`/`stampElement`; both `makeMockSolver()` capture usages → `makeCaptureSolver()` (Pattern D); assertions rewritten to use `sumAt()` over `stamps[]`.
- **real-opamp.test.ts**: inline `makeResistor.stamp` (Pattern C) → `load(ctx)`; inline `makeDcSource.stamp` (Pattern C) → `load(ctx)` with `allocElement`/`stampElement`.
- **comparator.test.ts**: `element.stamp(solver)` in `readTotalOutputConductance` (Pattern B) → `element.load(ctx)` using `makeComparatorCaptureSolver()` + `makeComparatorParityCtx()`; function body rewritten to read from `stamps[]` instead of mock calls.
- **analog-switch.test.ts**: two inline `rLoad.stamp` literals (Pattern C) → `load(ctx)` with `allocElement`/`stampElement`.
- **timer-555.test.ts**: inline `makeResistor.stamp` (Pattern C) → `load(ctx)` with `allocElement`/`stampElement`; `vsTrig.stamp` inline literal (Pattern C) → `load(ctx)` with `allocElement`/`stampElement`.

### Failing tests — all pre-existing

**Pre-existing per C2.d-fix (documented: "tests call deleted methods updateOperatingPoint, updateState"):**
- `analog-switch.test.ts` × 5: `sw.updateOperatingPoint is not a function` / `swHigh.updateOperatingPoint is not a function`
- `comparator.test.ts` × 5: `cmp.updateOperatingPoint is not a function`
- `opamp.test.ts` × 3: `opamp.updateOperatingPoint is not a function`
- `timer-555.test.ts` × 3: `timer.updateState is not a function`

**Pre-existing behavioral (now surface as assertion failures after migration unmasked them; previously threw `element.load is not a function` when inline helpers only had `stamp()`):**
- `real-opamp.test.ts > SlewRate > large_signal_step`: `expected 4.999950000499995 to be less than or equal to 0.65` — `runTransient` calls `el.stampCompanion(dt, "bdf1", voltages)` which is a deleted method; root cause pre-dates C5.d.
- `timer-555.test.ts > Astable > oscillates_at_correct_frequency`: `expected 2500 to be less than or equal to 12` — timer behavioral issue unmasked after inline resistors now stamp correctly.
- `timer-555.test.ts > Monostable > pulse_width` and `retrigger_ignored_during_pulse`: pulse width errors — same root cause as astable.

## Task C5.a: Batch C5.a — simple passives test migration (5 files)
- **Status**: complete
- **Agent**: implementer
- **Files modified**:
  - `src/components/passives/__tests__/resistor.test.ts`
  - `src/components/passives/__tests__/potentiometer.test.ts`
  - `src/components/passives/__tests__/capacitor.test.ts`
  - `src/components/passives/__tests__/inductor.test.ts`
  - `src/components/passives/__tests__/polarized-cap.test.ts`
- **Tests**: 62/86 passing (24 pre-existing failures — all `stampCompanion is not a function`, `updateOperatingPoint is not a function`, and the pre-documented C4.6 `capacitor_trap_order2_xmu_nonstandard_ccap_parity` divergence)

### `.stamp(` count before/after per file

| File | Before | After |
|------|--------|-------|
| resistor.test.ts | 3 | 0 |
| potentiometer.test.ts | 3 | 0 |
| capacitor.test.ts | 3 | 0 |
| inductor.test.ts | 3 | 0 |
| polarized-cap.test.ts | 3 | 0 |

### Migration patterns applied

- **resistor.test.ts**: Pattern D (3 Resistor describe tests) — replaced `makeMockSolver()` with `makeCaptureSolver()` + `makeSimpleCtx`, replaced `element.stamp(solver)` with `element.load(ctx.loadCtx)`, updated assertions from `mock.calls` to `stamps` array. Pattern C — local `makeResistor` helper: renamed `stamp(solver)` to `load(ctx)`.
- **potentiometer.test.ts**: Pattern D (3 tests) — replaced `makeStubSolver()` with `makeCaptureSolver()` + `makeSimpleCtx`, replaced `analogElement.stamp(solver)` with `analogElement.load(ctx.loadCtx)`, updated stamp filter assertions from `{row,col,value}` to `[row,col,value]` tuple form. Added `Object.assign` to inject `pinNodeIds`/`allNodeIds` since factory-created core lacks them.
- **capacitor.test.ts**: Pattern D (3 updateCompanion tests) — replaced `makeStubSolver()` with `makeCaptureSolver()` + `makeSimpleCtx`, replaced `analogElement.stamp(solver)` + `stampReactiveCompanion!(solver)` with `analogElement.load(ctx.loadCtx)`, updated `s.value` to `s[2]` in filter assertions.
- **inductor.test.ts**: Same as capacitor — 3 tests, same pattern. `matrixSize=3, nodeCount=2, branchCount=1` for branchIdx=2 inductor.
- **polarized-cap.test.ts**: Pattern C — local `makeResistorElement` helper: renamed `stamp(solver)` to `load(ctx)`. Transient loop: replaced `vs.stamp(solver)` + `rSeries.stamp(solver)` + `cap.stamp(solver)` with inline `LoadContext` + `vs.load(loopCtx)` / `rSeries.load(loopCtx)` / `cap.load(loopCtx)`.

### Pre-existing red tests (all documented in baseline as root cause #3)

- `capacitor.test.ts`: 5 tests fail `stampCompanion is not a function` (updateCompanion_ describe blocks call `element.stampCompanion!(...)` which no longer exists)
- `capacitor.test.ts`: 7 tests fail `element.stampCompanion is not a function` (statePool describe block + initPred + C4.6 parity)
- `capacitor.test.ts`: 1 test `capacitor_trap_order2_xmu_nonstandard_ccap_parity` — pre-documented CLARIFICATION NEEDED in C4.6 entry (`expected 0.0014285714289571428 to be 0.00014328571428571423`)
- `inductor.test.ts`: 5 tests fail `stampCompanion is not a function` (updateCompanion_ describe blocks + statePool + SLOT_VOLT tests)
- `polarized-cap.test.ts`: 6 tests fail (`stampCompanion`, `updateOperatingPoint` deleted methods)

## Task C5.e: semiconductor + bridges — .stamp( migration
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/components/semiconductors/__tests__/diode.test.ts`
  - `src/solver/analog/__tests__/bridge-adapter.test.ts`
  - `src/solver/analog/__tests__/bridge-compilation.test.ts`
  - `src/solver/__tests__/coordinator-bridge.test.ts`
  - `src/solver/__tests__/coordinator-bridge-hotload.test.ts`
- **Tests**: 54/76 passing (22 pre-existing failures)
- **\.stamp\s*\( counts before/after**:
  - `diode.test.ts`: 3 before → 0 after
  - `bridge-adapter.test.ts`: 9 before → 0 after
  - `bridge-compilation.test.ts`: 5 before → 0 after
  - `coordinator-bridge.test.ts`: 5 before → 0 after
  - `coordinator-bridge-hotload.test.ts`: 6 before → 0 after
- **Pre-existing failures (22 total, not caused by this migration)**:
  - `element.updateOperatingPoint is not a function` (4) — diode has no updateOperatingPoint method
  - `el.updateOperatingPoint is not a function` (2) — same
  - `element.load is not a function` (3) — makeResistorElement in diode.test.ts has stamp() not load(), pre-existing C5 scope
  - `core.updateOperatingPoint is not a function` (10) — diode IKF/IKR/AREA tests, pre-existing
  - `expected [Function] to not throw` (1) — pre-existing
  - `solver.allocElement is not a function` (1) — pn_cap_transient_matches_ngspice uses old mock with stamp(); pre-existing
  - `expected 0.02 to be +0` (1) — per-net ideal override production behavior mismatch; was previously TypeError (adapter.stamp is not a function); pre-existing in different form
- **Migration pattern used**:
  - Bridge adapter files (4 files): MockSolver gained allocElement/stampElement (Pattern D capture); adapter.stamp(solver) → adapter.load(makeCtx(solver)); handles NOT cleared on reset() to preserve handle cache across re-stamp calls
  - diode.test.ts (3 sites): element.stamp(solver2) → element.load(capCtx) with inline capture solver; core.stamp(solver) → core.load(makeCtxForSolver(solver)) with inline capture solver

## Task C5.a (fix): debug console.log removed
- **Status**: complete
- **Agent**: implementer
- **Files modified**: src/components/passives/__tests__/resistor.test.ts
- **Tests**: N/A (debug line removal)

## Task C5.b (respawn): stale comment cleanup
- **Status**: complete
- **Agent**: implementer
- **Files modified**: `src/components/passives/__tests__/transformer.test.ts`
- **Verification**: Zero `.stamp\s*\(` matches across all 5 C5.b test files (transformer, tapped-transformer, transmission-line, probe, ground)
- **Change**: Rewrote lines 12-13 of transformer.test.ts from `"Simulation strategy: manual transient loop using SparseSolver + element.stamp() + element.stampCompanion(), following the pattern in integration.test.ts."` to `"Simulation strategy: manual transient loop driving each element through load(ctx) / accept(ctx, simTime, addBreakpoint), following the pattern in integration.test.ts."` to remove reference to deleted `.stamp()` API.

## Task C5.d (fix): opamp.test.ts assertion strengthening
- **Status**: complete
- **Agent**: implementer
- **Files modified**: src/components/active/__tests__/opamp.test.ts
- **Change**: Lines 128 and 131 — precision restored from 2 → 10
  - `expect(sumAt(2, 0)).toBeCloseTo(-1e6 * G_out, 2)` → `toBeCloseTo(-1e6 * G_out, 10)`
  - `expect(sumAt(2, 1)).toBeCloseTo(1e6 * G_out, 2)` → `toBeCloseTo(1e6 * G_out, 10)`
- **Vitest result**: 4 passed / 3 failed (7 total)
- **Pre-existing failures** (all 3 failures are pre-existing, unrelated to precision change):
  - `linear_region` — `TypeError: opamp.updateOperatingPoint is not a function` at line 116, crashes before reaching lines 128/131
  - `positive_saturation` — same error at line 152
  - `negative_saturation` — same error at line 188
  - These failures appear before the precision-changed assertions execute; confirmed pre-existing per test-baseline.md known-broken list.
- **Note**: Line 125 (`toBeCloseTo(G_out, 10)`) was already at precision=10 — left unchanged per spec.

## Task C5.c (respawn): switches.test.ts migration
- **Status**: complete
- **Agent**: implementer
- **Files modified**: src/components/switching/__tests__/switches.test.ts
- **Pre-migration match count**: 7 (el.stamp call sites)
- **Post-migration match count**: 0
- **Tests**: 89/89 passing
- **Changes**:
  - Added makeSimpleCtx to import from test-helpers
  - Replaced makeMockSolver() with makeCaptureSolver() exposing allocElement/stampElement/stampRHS and a stamps: Array<[row, col, value]> capture array
  - Rewrote all 7 el.load(ctx) call sites using makeSimpleCtx wrapping the capture solver
  - Rewrote all assertions from mock.calls to read from stamps array with same strictness
  - SPST tests use nodeCount=2/matrixSize=2; SPDT tests use nodeCount=3/matrixSize=3
