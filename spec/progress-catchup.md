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
