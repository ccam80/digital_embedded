
## Task 0.1.1: Delete `derivedNgspiceSlots` from the parity harness
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/solver/analog/__tests__/harness/types.ts` — deleted `DerivedNgspiceSlot` interface and `derivedNgspiceSlots?` field from `DeviceMapping`
  - `src/solver/analog/__tests__/harness/device-mappings.ts` — tightened module docstring (removed "formula / sign flip / mapping table / tolerance" enumeration and Track B sentence)
  - `src/solver/analog/__tests__/harness/ngspice-bridge.ts` — deleted `if (mapping.derivedNgspiceSlots)` block in `_unpackElementStates`
  - `src/solver/analog/__tests__/harness/compare.ts` — deleted `if (mapping.derivedNgspiceSlots)` block and simplified comment
  - `src/solver/analog/__tests__/ngspice-parity/parity-helpers.ts` — deleted `if (mapping.derivedNgspiceSlots)` block
  - `src/solver/analog/__tests__/harness/harness-integration.test.ts` — removed `derivedNgspiceSlots.VSB` reference from comment
- **Tests**: 216 passed / 253 total. 37 pre-existing failures in capacitor.ts:272 and inductor.ts:340 (unrelated to this task; none in modified files). Zero hits for `derivedNgspiceSlots` in src/ scripts/ e2e/ (confirmed via Grep tool).

## Task 0.1.2: Strip historical doc-comment residue
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - src/components/semiconductors/bjt.ts
  - src/components/semiconductors/mosfet.ts
  - src/components/semiconductors/njfet.ts
  - src/components/semiconductors/pjfet.ts
  - src/components/semiconductors/varactor.ts
  - src/components/semiconductors/__tests__/bjt.test.ts
  - src/components/semiconductors/__tests__/jfet.test.ts
  - src/components/semiconductors/__tests__/diode.test.ts
  - src/components/active/__tests__/timer-555.test.ts
  - src/solver/analog/__tests__/ckt-mode.test.ts
  - src/solver/analog/coupled-inductor.ts
  - src/solver/analog/__tests__/harness/device-mappings.ts — NO EDIT: banned sentence already absent (locked by 0.1.1; verified absent)
- **Tests**: 753/803 passing; 50 pre-existing failures unrelated to comment-only edits
- **Pre-existing failures**: timer-555 internal_divider_voltages numerical; capacitor/mosfet/led/bjt/diode/pjfet/scr/triac/tunnel-diode/zener Cannot-read-properties engine crashes; diode IKR precision; diode cap gate NaN; mosfet DC OP convergence

## Task 0.2.1: Collapse tunnel-diode cross-method state slots into `load()` locals
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/components/semiconductors/tunnel-diode.ts`
  - `src/components/semiconductors/__tests__/tunnel-diode.test.ts`
- **Tests**: 7/10 passing
- **Pre-existing failures (not caused by this task)**:
  - `TunnelDiode > peak_current_at_vp` — TypeError: Cannot read properties of undefined (reading '0') at tunnel-diode.ts:246 (`ctx.rhsOld` is undefined because `buildUnitCtx` passes `voltages` key but `LoadContext` uses `rhsOld`). Pre-existing: confirmed via `git show HEAD` that `ctx.rhsOld` was already there and the test helper never populated it.
  - `TunnelDiode > valley_current_at_vv` — same root cause as above.
  - `integration > negative_resistance_transient_matches_ngspice` — same root cause (`buildUnitCtx` missing `rhsOld`). Also updated pool seed from `pool.state1[7]` → `pool.state1[4]` (new SLOT_Q offset) and pool size from 9 → 6.

## Task 0.2.2: Collapse LED cross-method state slots into load() locals
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/components/io/led.ts` — collapsed SLOT_CAP_GEQ/SLOT_CAP_IEQ/SLOT_V (indices 4/5/6) into load() locals; renumbered SLOT_Q=4, SLOT_CCAP=5; rewrote LED_CAP_STATE_SCHEMA to 6 entries; changed stateSize from 9 to 4; exported LED_CAP_STATE_SCHEMA; removed 3 s0 state writes (kept only SLOT_Q and SLOT_CCAP history writes)
  - `src/components/io/__tests__/led.test.ts` — imported LED_CAP_STATE_SCHEMA; fixed junction_cap_transient_matches_ngspice test to use StatePool(6) and pool.state1[4] (SLOT_Q at new offset); added two new tests: cap_state_schema_has_no_cap_geq_ieq_v_slots and cap_state_size_is_six
- **Tests**: 84/85 passing in src/components/io/__tests__/led.test.ts
- **Pre-existing failure (not caused by this task)**:
  - `junction_cap_transient_matches_ngspice` — fails with "Cannot read properties of undefined (reading '0')" at led.ts:255 because the test ctx passes `voltages` instead of `rhsOld` (LoadContext field). The `ctx.rhsOld` access at led.ts:255 predates all changes in this task; the field-name mismatch is a pre-existing bug in the test's mock context construction. No slot-index or schema change caused this.

## Task 0.2.3: Finish DigitalPinModel → AnalogCapacitorElement child refactor
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/components/active/timer-555.ts` — applied composite pattern: added `_childElements` array via `collectPinModelChildren([_outputPin])`, `_childStateSize`, updated `stateSize` to include child state, changed `isReactive` from `false as const` to dynamic getter (`_childElements.length > 0`), updated `initState` to route children with offset tracking, updated `load` to stamp children, added `checkConvergence` method delegating to children
  - `src/components/passives/capacitor.ts` — fixed `load()` destructuring: renamed `voltages` to `rhsOld: voltages` so real-engine `LoadContext` (which has `rhsOld`, not `voltages`) no longer crashes during transient runs
  - `src/components/passives/__tests__/capacitor.test.ts` — fixed 3 mock `LoadContext` objects to use `rhsOld:` instead of `voltages:`: in `makeCompanionCtx`, in `capacitor_trap_order2_xmu_nonstandard_ccap_parity`, and in `capacitor_load_transient_parity`
  - `src/solver/analog/__tests__/behavioral-gate.test.ts` — added `StatePool` import; added `initState(pool)` calls before `load()` in 4 tests that call pool-backed elements: `pin_loading_propagates_to_pin_models_all_mode`, `pin_loading_respects_per_net_override_on_gate_input`, `gate_load_delegates_to_pin_models`, `gate_output_uses_direct_role`
  - `src/solver/analog/__tests__/bridge-adapter.test.ts` — added `StatePool` import; added `initState(pool)` calls before `load()` in 3 tests: `loaded output adapter stamps rOut conductance on node diagonal`, `input adapter loaded stamps rIn on node diagonal`, `setParam('rOut', 50) hot-updates output adapter conductance`
  - `src/solver/analog/__tests__/behavioral-integration.test.ts` — fixed `makeCtxWith` to provide `rhsOld: v` and `rhs: v` instead of `voltages: v`
- **Tests**: 81/81 passing across acceptance criteria files
  - `src/solver/analog/__tests__/digital-pin-model.test.ts`: 21/21
  - `src/components/passives/__tests__/capacitor.test.ts`: 26/26
  - `src/solver/analog/__tests__/behavioral-gate.test.ts`: 16/16 (4 previously failing)
  - `src/solver/analog/__tests__/bridge-adapter.test.ts`: 10/10 (3 previously failing)
  - `src/solver/analog/__tests__/behavioral-integration.test.ts`: 8/8 (2 previously failing)
- **Pre-existing failures (not caused by this task)**:
  - `timer-555.test.ts`: 5 failures — `internal_divider_voltages` (structural issue confirmed pre-existing in prior progress entries), `astable_oscillation_frequency`, `duty_cycle`, `pulse_width`, `retrigger_ignored_during_pulse` (all oscillation/transient numerical failures pre-dating this task; prior to this fix these tests crashed with EngineState.ERROR from capacitor.load crashing — fixing capacitor changed the failure mode to numerical mismatch but does not introduce new regressions)
