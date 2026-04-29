# Test-Fix Jobs — post setup-load-cleanup wave

**Baseline at HEAD `fe1222a1`:**
- vitest: 8618 passed, **249 failed**, 15 skipped (398 files, 19.1s)
- playwright: 475 passed, **13 failed** (23 files, ~200s)
- combined: 9093 passed, **262 failed**

**Goal:** every test accurately exercises the post-wave architecture (3-arg
factories, `_pinNodes: Map`, `setup()`-allocated handles, ngspice-exact
numerical matching). No shims. No reverts. No hand-rolled fixtures where
real elements / `makeTestSetupContext` / `setupAll` would do.

**Banned remedies** (do not propose these on any job):
- adding compatibility shims, aliases, or type-asserted fallbacks to keep
  old test fixtures running
- reverting away from the new contract (`_pinNodes: Map`, 3-arg factories,
  pool-backed state, ngspice-exact algorithms)
- declaring numerical divergence as "tolerance" / "equivalent under" /
  "intentional" — those route to the escalation lane in §E

Each job below names the failure pattern, the affected sites (with counts),
the root cause, and the **shape of the fix**. Where a job is escalation
rather than a test rewrite, it is filed in §E.

---

## §J — Test-migration jobs (test bugs; rewrite to current contract)

### J1 — Hand-rolled `MockSolver` retired in bridge / coordinator tests

**Failure pattern:** `Cannot destructure property 'row' of 'this._handles[handle]' as it is undefined.` (×17)

**Sites:**
- `src/solver/__tests__/coordinator-bridge.test.ts` (5 tests)
- `src/solver/analog/__tests__/bridge-adapter.test.ts` (7 tests)
- `src/solver/analog/__tests__/bridge-compilation.test.ts` (4 tests)
- `src/components/passives/__tests__/transformer.test.ts` (1 test, `winding_resistance_drops_voltage`)

**Root cause:** Tests use a bespoke `MockSolver` whose `_handles[]` is
populated only by `allocElement()`. Production paths now resolve handles
that the bridge/coordinator code allocated against the *real* solver during
`setup()`, so the mock's slot table is empty when `stampElement(handle, …)`
fires.

**Fix shape:** Replace `MockSolver` with `new SparseSolver()` +
`solver._initStructure()` and run real `setup()` via `makeTestSetupContext`
and `setupAll`. Per CLAUDE.md "use real elements; consolidate to existing
machinery" — the MockSolver in `bridge-adapter.test.ts` is exactly the
hand-rolled fixture we are deleting.

---

### J2 — BJT-composite tests pass non-Map / wrong PropertyBag shape

**Failure patterns:**
- `pinNodes.get is not a function` (×18) — stack frame in `bjt.ts:494`
- `PropertyBag: model param "NF" not found` (×13) — frame in `properties.ts:137`
- `PropertyBag: model param "ctr" not found` (×1, optocoupler PB-OPTO)
- `PropertyBag: model param "gmMax" not found` (×1, OTA)
- `PropertyBag: model param "aol" not found` (×1, real-opamp)
- `PropertyBag: model param "vTH" not found` (×1, schmitt)
- `PropertyBag: model param "voltage" not found` (×1, dc-vsrc pulse)

**Sites:** Composites that embed BJTs/sub-elements: `optocoupler.test.ts`,
`timer-555.test.ts`, `scr.test.ts`, `triac.test.ts`, `setup-stamp-order.test.ts`
(`PB-OPTO`/`PB-OTA`/`PB-REAL_OPAMP`/`PB-SCHMITT`/`PB-TRIAC`/`PB-TIMER555`).

**Root cause:** Two distinct issues bundled here:
1. Some test setups still construct sub-element pinNodes as plain objects
   `{B: 1, C: 2, E: 3}` instead of `new Map(...)`. Wave A.4 mandates Map.
2. Composite tests pre-stage props with `replaceModelParams({ ... })` whose
   keys do not match the sub-element's `*_PARAM_DEFS` (e.g. `NF` is
   present in `BJT_PARAM_DEFS` but the test passes a defaults bag missing
   it; or the composite's PropertyBag was never seeded with the BJT
   defaults at all).

**Fix shape:** Update each affected fixture to (a) pass `_pinNodes` as a
`Map`, (b) seed `PropertyBag` with the same `*_DEFAULTS` constant the
production composite uses (e.g. `BJT_PARAM_DEFS` for any sub-BJT). Lift
the per-composite "make props" helper into the composite test directly
or into `test-fixtures/model-fixtures.ts`; do NOT introduce a missing-key
fallback in `properties.ts`.

---

### J3 — State-slot tuple access in capacitor / inductor / resistor / clock

**Failure pattern:** `Cannot read properties of undefined (reading '2')` (×25)

**Sites:**
- `src/components/passives/__tests__/capacitor.test.ts` (10 tests)
- `src/components/passives/__tests__/inductor.test.ts` (8 tests)
- `src/components/passives/__tests__/resistor.test.ts` (3 tests)
- `src/components/io/__tests__/analog-clock.test.ts` (4 tests)

**Root cause:** Tests read `el.stateSchema[2]` (or similar positional
index) where `stateSchema` is now an object/record keyed by slot name
(per A.2 `StateSchema` and the wave's pool-slot rename). Positional
indexing returns `undefined`.

**Fix shape:** Resolve slots by name via `stateSchema` (per project memory:
"Schema lookups over slot exports — Tests should resolve pool slots by name
via stateSchema, not import raw SLOT_* constants"). Each test reads e.g.
`stateSchema.GEQ.offset` or uses the production helper if one exists.

---

### J4 — Definitions no longer expose `branchCount` field

**Failure pattern:** `expected undefined to be 1 // Object.is equality` and similar (×4)

**Sites:**
- `src/components/passives/__tests__/inductor.test.ts` — `InductorDefinition branchCount is 1`
- `src/components/passives/__tests__/transformer.test.ts` — `branchCount is 2`
- `src/components/passives/__tests__/transmission-line.test.ts` — `requires branch row` (`expected 'undefined' to be 'function'`)
- `src/components/sources/__tests__/variable-rail.test.ts` — `definition_has_requires_branch_row`

**Root cause:** Per A.21 spec ("compiler drops the eager `branchCount`
pre-summation; sub-elements allocate their own branches in `setup()`")
the `branchCount` field — and the corresponding `requires` predicate —
have been removed from `ModelEntry`/definitions.

**Fix shape:** Drop these assertions; replace with an integration check
that `setupAll([el], ctx)` followed by inspecting `el.branchIndex !== -1`
(or `el.findBranchFor("…", ctx)` returning a positive row). The "the
definition declares branches" property is no longer a property of the
definition — it is a property of the post-setup element.

---

### J5 — `stateSchema` slot-count assertions on transmission-line sub-elements

**Failure pattern:** `expected +0 to be 2 // Object.is equality` (×2), `expected +0 to be 1` (×3)

**Sites:**
- `src/components/passives/__tests__/transmission-line.test.ts` — SegmentInductorElement / SegmentCapacitorElement / CombinedRLElement schema-slot tests
- `src/solver/analog/__tests__/digital-pin-model.test.ts` — `output_load_branch_role_drive_loaded`, `output_load_branch_role_hiz_ideal`

**Root cause:** Schema sizes were re-tuned during the wave (A.7 follow-up
mentions tapped-transformer schema overshoots actual state usage). Test
expectations are stale.

**Fix shape:** Re-derive the expected slot count from each element's
`stateSchema` definition; if the production schema is genuinely wrong,
escalate to §K, not patched here.

---

### J6 — `_handles[h]` undefined when test skips `setup()`

**Failure pattern:** `Cannot destructure property 'row' of 'handles[handle]' as it is undefined.` (×1, transformer winding test)

**Site:** `src/components/passives/__tests__/transformer.test.ts:190` (`winding_resistance_drops_voltage`)

**Root cause:** Test calls `el.load(ctx)` without first calling
`el.setup(ctx)`; the closure-local TSTALLOC handles are still `-1`.

**Fix shape:** Use `setupAll([el], ctx)` per A.19 canonical pattern
before any `load()`. (Fold into J1 if convenient — same family.)

---

### J7 — TSTALLOC golden sequences need re-recording

**Failure pattern:** `expected [...] to deeply equal [...]` on TSTALLOC handle order (×4)

**Sites:** `src/solver/analog/__tests__/setup-stamp-order.test.ts` —
`PB-BJT`, `PB-IND`, `PB-SCR`, `PB-TLINE` TSTALLOC sequence tests.

**Root cause:** TSTALLOC allocation order during `setup()` was rearranged
when handles moved into closures (A.9). The golden sequences in the test
are stale.

**Fix shape:** TWO-STEP. First confirm the new order **matches ngspice
TSTALLOC order** (cross-reference `bjtsetup.c`, `indset.c`, `scrset.c`,
`tralump.c`). If yes, re-record the golden in the test. If the new
allocation order does NOT match ngspice, this is an **architectural
escalation**, not a test fix — file under §E.5.

---

### J8 — `TEMP` key missing from default model bags (Zener, Schottky)

**Failure pattern:** `expected { … } to have property "TEMP"` (×2)

**Site:** `src/components/semiconductors/__tests__/spice-model-overrides-prop.test.ts`
— `ZenerDiode: default model entry has params record with TEMP key`,
`SchottkyDiode: default model entry has params record with TEMP key`.

**Root cause:** ZENER_DEFAULTS / SCHOTTKY_DEFAULTS objects do not include
`TEMP: 300.15`; other diode variants do.

**Fix shape:** Decide if this is a production gap (TEMP truly should be
in the defaults bag — fold in per A.4 hot-loadable params requirement) or
a stale test (TEMP belongs only to params that ngspice tracks per-instance).
First read `diode.ts` `ZENER_DEFAULTS`/`SCHOTTKY_DEFAULTS` and the matching
ngspice device-set; if TEMP routes through the same path as for the
standard diode, this is a one-line production add. Otherwise drop the
assertion.

---

### J9 — UTF-8 BOM / encoding artifact in `coordinator-speed-control`

**Failure pattern:** `expected 'µs/s' to be 'Âµs/s' // Object.is equality` (×1)

**Site:** `src/solver/__tests__/coordinator-speed-control.test.ts:271`
(`formatSpeed returns micros/s for rate in 1e-6 to 1e-3 range`)

**Root cause:** Test source file was saved with a windows-1252 round-trip
through UTF-8 — the literal in the assertion contains the mojibake
`Âµ` while production correctly emits `µ`.

**Fix shape:** Re-save the test file as UTF-8 (no BOM) with the assertion
literal `µs/s`. Confirm with `git diff` that only the µ byte sequence
changes.

---

### J10 — `compile()` output surface: `statePool` / `_stateBase=-999` removed

**Failure patterns:**
- `expected null to be an instance of StatePool` (×1)
- `Cannot read properties of null (reading 'totalSlots')` (×1)
- `expected null not to be null // Object.is equality` (×1)
- `expected -999 to be +0 // Object.is equality` (×1)

**Site:** `src/solver/analog/__tests__/compile-analog-partition.test.ts`
(4 tests around statePool / `_stateBase` assignment).

**Root cause:** Per A.21 spec, the compiler no longer attaches a
`statePool` field to the compiled output, and the `_stateBase = -1`
sentinel replaces the old `-999`. Tests inspect the old surface.

**Fix shape:** Re-read `compiler.ts`'s actual return shape and rewrite
the assertions to match. If the compiled artifact does still carry pool
metadata under a different name, point at that. If not, drop the assertions
and replace with an integration check (compile + boot DC-OP, observe pool
slots populated through the engine).

---

### J11 — Harness query API: `SlotTrace`, `ComponentSlotsSnapshot`, `StateHistoryReport`

**Failure pattern:** `expected undefined to be defined` (×6 in harness tests; 1 in resistor)

**Sites:**
- `src/solver/analog/__tests__/harness/query-methods.test.ts` — tests 34, 35, 37, 38, 57, 58
- `src/solver/analog/__tests__/harness/stream-verification.test.ts` — `state1Slots and state2Slots populated`
- `src/components/passives/__tests__/resistor.test.ts:362` — `load(ctx) stamps G=1/R bit-exact for R=1kΩ`

**Root cause:** Harness query method names / return shapes drifted during
the wave (A.23 mentions snapshot-blob field removals; query method names
likely consolidated). Tests reference accessors that no longer exist.

**Fix shape:** Re-baseline against the current `harness/capture.ts` and
`harness/query.ts` exports. Where the harness genuinely no longer
captures a slot, that is the new contract — drop the assertion; do not
reinstate the field.

---

### J12 — `behavioral-sequential` outputs read 0 (digital wiring not driven)

**Failure pattern:** `expected +0 to be 5/3/85/165` (×6)

**Site:** `src/solver/analog/__tests__/behavioral-sequential.test.ts` —
`counts_on_clock_edges`, `clear_resets_to_zero`, `output_voltages_match_logic`,
`latches_all_bits`, `holds_value_across_timesteps`, `sequential_pin_loading_propagates`

**Root cause:** Tests read flip-flop / counter outputs after stepping but
the digital-side bridge adapter no longer drives the analog rail by
default (rOut may now stamp only when explicitly loaded). Tests need to
either drive the input clock through the production clock element rather
than a hand-wired step, or assert against the digital state ring rather
than analog node voltage.

**Fix shape:** Read `behavioral-sequential.ts` and `digital-pin-model.ts`
to confirm the actual signal path under the new bridge model. Migrate
each test to use `DefaultSimulatorFacade.compile()` + `step()` + read
through `readSignal` (the three-surface rule: headless API, not direct
solver poking).

---

### J13 — `dc-operating-point.ts:129 offset out of bounds`

**Failure pattern:** `offset is out of bounds` (×4)

**Sites:** `output_impedance`, `inverting_amplifier`,
`method_reflects_last_strategy`, `gillespieSrc_source_stepping_uses_gshunt`
(all rooted at `dc-operating-point.ts:129`, frames in tests).

**Root cause:** Production code in `dc-operating-point.ts:129` writes
past the rhs/state buffer in a path the wave touched. Almost certainly a
**production bug**, not a test bug — the symptom is `RangeError` from
TypedArray bounds. Routes to §K, not §J.

**Fix shape:** See §K1.

---

### J14 — Misc small-blast-radius fixture rewrites

| Failure | Site | Cause | Fix |
|---|---|---|---|
| `expected 0 to be greater than 0.045` | wire-current-resolver.test.ts:1070 (`cross-component current equality through real compiled lrctest.dig`) | LRC fixture compile path no longer writes per-pin currents | Read current-resolver.ts to confirm; rewrite assertion against the new resolver API |
| `expected 0 to be greater than 0` (×10 across 6 files) | wire-current-resolver, tapped-transformer, ckt-load `noncon_incremented_by_device_limiting`, convergence-regression `reset restores`, digital-pin-model `handle_cache_stable_across_iterations`, newton-raphson `e_singular_*`, harness-integration `captureElementStates`, `findLargestDelta` | Mixed bag — some are real production stamps returning 0; others are tests that assume an old branchIndex. Triage individually. | Mixed §J / §K |
| `actual value must be number or bigint, received "undefined"` | varactor.test.ts:162 (`setup_allocates_handles_before_load`) | Test reads `el._h…` at a path that's now closure-local, not on the literal (per A.9) | Drop the field assertion; assert handles via post-load matrix entries |
| `expected null not to be null` | schmitt-trigger.test.ts:358 (`plot_matches_hysteresis_loop`) | Hysteresis plot helper returns null when stamping yields no transition (related to schmitt §K5) | After §K5 lands, re-examine |

---

## §K — Production / architecture jobs (code bugs surfaced by tests)

These are **not** test bugs. The test correctly encodes the contract;
production code must move.

### K1 — `dc-operating-point.ts:129 offset out of bounds`

4 tests crash with `RangeError`. The wave touched `dc-operating-point.ts`
to drop `rhsOld` foreign writes (commit `221d369b`). Investigate whether
buffer sizing during the gmin-stepping path or NIiter retry path now
overshoots. Production fix; tests are correct.

---

### K2 — `xfact` unguarded reads + stale allowlist

**Sites:** `phase-3-xfact-scope-audit.test.ts` —
`has zero unguarded xfact reads in src/components/`,
`allowlist is exhaustive — no stale entries`

**Root cause:** A.12 / phase-3 NR reorder requires every `xfact` read in
component code to be guarded (e.g. `if (xfact !== 1.0)` or DCOP-mode
check). Audit found new unguarded reads; allowlist contains entries no
longer in the codebase.

**Fix shape:** Either (a) add the missing guards in components, (b)
prune the allowlist, or both. Architectural escalation only if the
guard contract itself needs revisiting.

---

### K3 — Memristor / polarized-cap NaN cascade

**Failure pattern:** `expected NaN to be ...` (×9)

**Sites:** `memristor.test.ts` (8 tests including `positive voltage
causes w to increase`, `negative voltage causes resistance to increase`,
…, plus `memristor_load_transient_parity`, `stamps conductance between
nodes A and B`); `polarized-cap.test.ts` (`capacitor voltage reaches
63%…`).

**Root cause:** Per project memory follow-up A.11 (`polarized-cap
_stateBase runtime crash`), state-pool init regressed during the wave —
the diode child no longer initializes its slots, so divisions by 0
produce NaN in `load()`. Memristor likely has the same pattern (its
state-w / Roff-Ron tracking depends on pool slots written during
`initState`).

**Fix shape:** Production fix: ensure each `PoolBackedAnalogElement.initState`
is invoked exactly once for every pool-backed sub-element under
composites. Cross-reference `compile-analog-partition.test.ts` once §J10
lands.

---

### K4 — Real-opamp output way off (×5)

**Sites:** `real-opamp.test.ts` —
`inverting_amplifier_gain` (11394 vs 0.1),
`output_saturates_at_rails` (1138 vs 13.6),
`large_signal_step` (1138 vs 0.65),
`small_signal_not_slew_limited` (1138 vs 0.015),
`output_offset_with_gain`,
`output_current_clamped` (133.94 vs 13.6),
plus `unity_gain_frequency`, `load_741_model`, `element_has_correct_flags` (3× false-true)

**Root cause:** All five magnitudes overshoot by ~1000×. Smells like
`gain` parameter ingested as raw aol (1e6) instead of
20·log10(aol) → dB, OR rOut stamped with reciprocal. Production model
bug — likely a single-line param-units regression in `real-opamp.ts`
caused by the param-bag rewrite during the wave.

**Fix shape:** Read `real-opamp.ts` `setParam("aol")` / load() body;
cross-reference ngspice opamp model reference. Fix at the source.

---

### K5 — Schmitt-trigger output stuck at 0

**Sites:** `schmitt-trigger.test.ts` —
`noisy_sine_clean_square` (0 vs 10),
`plot_matches_hysteresis_loop` (null),
`schmitt_load_dcop_parity` (0 vs 1e-7)

**Root cause:** Output node never charges. Either `vOH`/`vOL` stamps
were lost during the wave or the threshold-crossing path doesn't fire
on init.

**Fix shape:** Production fix in `schmitt-trigger.ts`. Confirm by
single-step DC-OP with a 5V input and inspecting `rhs[outputNode]`.

---

### K6 — Crystal blocks DC test fails

**Site:** `crystal.test.ts` — `DC source across crystal produces
near-zero current (capacitors block DC)`

**Root cause:** Crystal stamps are not blocking DC current the way the
ideal AC-coupled equivalent should (could be the same `_stateBase`
init regression as K3).

**Fix shape:** Trace through crystal.ts setup() and DCOP-path stamp
to confirm. Production fix.

---

### K7 — LED forward-drop returns 0

**Sites:** `led.test.ts` —
`red_led_forward_drop` (0 vs >1.65),
`blue_led_forward_drop` (0 vs >3.05),
`junction_cap_transient_matches_ngspice` (0 vs 0.486),
`vt_reflects_TEMP` / `setParam_TEMP_recomputes` (vt off)

**Root cause:** LED `load()` not stamping — likely sub-element factory
not registering its diode children correctly during `setup()` after the
wave, OR the param-bag for the LED is missing ngspice keys.

**Fix shape:** Production fix in `led.ts` — confirm child-diode setup
runs and stamps Shockley correctly.

---

### K8 — Tunnel-diode peak/valley current 0/NaN

**Sites:** `tunnel-diode.test.ts` —
`peak_current_at_vp` (NaN vs >0.00475),
`valley_current_at_vv` (NaN vs >0.00045),
`vt_reflects_TEMP` and `setParam_TEMP_recomputes` (numerical drift),
`negative_resistance_transient_matches_ngspice` (0 vs -0.00949),
`nr_converges_in_ndr_region` (false-true)

**Root cause:** State-pool / param-bag regression similar to K3, K7.

**Fix shape:** Production fix. Possibly fold into K3 (single root cause).

---

### K9 — Variable-rail / dc-vsrc PULSE breakpoint not scheduled

**Sites:**
- `variable-rail.test.ts` — `definition_has_requires_branch_row`
- DC vsrc — `pulse_breakpoint_scheduled` (PropertyBag: model param "voltage" not found)

**Root cause:** Source param bags reorganized during wave; `voltage` is
no longer the bag-key (likely `dc` per ngspice convention); `requires`
predicate removed (J4).

**Fix shape:** Update tests to use the production param key; if the
production element really should accept `voltage` as an alias, that's a
separate alias decision (not a shim).

---

### K10 — Setup-stamp-order: PB-OPTO/OTA/REAL_OPAMP/SCHMITT TSTALLOC

These are NOT bare TSTALLOC-sequence assertions — they fail with
`PropertyBag: model param "X" not found`, meaning the test cannot even
run setup before recording the sequence. Once §J2 lands the fixture,
revisit and treat the residual ordering deltas as J7-style golden
re-records.

---

### K11 — Behavioral driver / flip-flop diagnostic emission

**Sites:**
- `behavioral-flipflop-variants.test.ts` — `both_set_emits_diagnostic`
- `competing-voltage-constraints.test.ts` — `two voltage sources on same net emits competing-voltage-constraints error`

**Root cause:** `expected 0 to be greater than or equal to 1` —
diagnostic collector is empty when it should contain at least one entry.
Likely the diagnostic key was renamed during the wave or the emission
path was deleted.

**Fix shape:** Confirm where the diagnostic was emitted pre-wave; if
intentionally removed, drop the test; if accidentally removed, re-add.

---

## §E — Numerical / parity escalations (NOT test fixes)

Per CLAUDE.md ngspice-parity vocabulary rules, every item below is a
candidate for `spec/architectural-alignment.md` (architectural divergence)
or `spec/fix-list-phase-2-audit.md` (numerical bug). **Agents do not
edit `architectural-alignment.md`** — escalate to user with the cited
ngspice file, the digiTS file, and the divergent quantities.

### E1 — `ckt-terr` LTE numerical mismatches

**Failure pattern:** Multiple `expected X to be Y // Object.is equality`
on LTE timestep proposals. Examples:
- `order 1 trapezoidal: returns finite positive timestep` (Infinity vs 2.65)
- `order 2 gear: returns sqrt-scaled timestep` (9.2e-10 vs 9.5e-7)
- `gear order 2 returns positive finite timestep for cubic charge data` (1.50 vs 1.13)
- `cktTerr_trap_order1_matches_ngspice` (2.8e-7 vs 5.3e-10)
- `cktTerr_gear_order1_sqrt`, `gear_higher_order_root_is_order_plus_one`
- `cktTerr_trap_order2_matches_ngspice` (1.5e-6 vs 1.1e-24)
- `gear_lte_factor_order_3/5/6` (×3)
- `zero_allocations_in_lte_path` (200 vs 0)
- `constant charge history produces finite timestep — abstol-gated`

**Root cause:** `cktTerr` implementation doesn't match the corresponding
ngspice `CKTtrunc` / `CKTtrap`/`CKTgear` formulas. The 1.1e-24 expected
value vs 1.5e-6 observed value indicates a **scaling bug** (probably the
allocation-count step factor or the order-N+1 root). The
`zero_allocations_in_lte_path` failure (200 allocations vs 0) means we
allocate per-call where ngspice does not.

**Action:** Escalate. Provide user with the cited ngspice function
(likely `CKTtrunc` in `src/maths/cktnumc.c` or per-device `*Terr`
hooks), the digiTS file (`solver/analog/timestep.ts` / `ckt-terr`
helper), and the specific quantity mismatches per test.

---

### E2 — `pnjlim_matches_ngspice_*`

- `pnjlim_matches_ngspice_forward_bias` — 0.838698 vs 0.789547
- `pnjlim_matches_ngspice_arg_le_zero_branch` — 0.406210 vs 0.300000

**Root cause:** PN-junction limiting does not match ngspice's `DEVpnjlim`
(devsup.c). Either the `arg = …` formula is off or the icrit selection
diverges.

**Action:** Escalate with citation of `devsup.c:DEVpnjlim`.

---

### E3 — `harness/comparison-session.ts` matrix-entry divergences (×10)

All ten tests fail with `Matrix-entry value divergence at step=0
attempt=0 iter=0`. These are the canonical ngspice-parity comparison
tests (buckbjt_load_dcop, transient: CCAP/PNP/inductor, DC-OP match,
transient_rectification_match, dc_op_pnjlim_match, dump+compare structure).

**Action:** This is the **first tool** per CLAUDE.md's "ngspice
comparison harness" rule. Run the harness, identify the iteration where
values first diverge, and report the exact (row, col, ours, ngspice)
quartet. Escalate with that quartet.

---

### E4 — Bit-exact misses with absDelta ~10^-21

- `parity-helpers.ts` — `transient_match` (absDelta=4.4e-21)
- `parity-helpers.ts` — `transient_oscillation_match` (absDelta=1.6e-24)

**Root cause:** Floating-point operation ordering between digiTS and
ngspice differs at the ULP level. Per CLAUDE.md banned-vocab rules, this
is an **architectural escalation** ("intentional divergence" is banned;
items go in `architectural-alignment.md`).

**Action:** Escalate. The user decides whether to accept FP-ordering
divergence or chase the per-summation-order match.

---

### E5 — TSTALLOC sequence divergence (PB-BJT, PB-IND, PB-SCR, PB-TLINE)

If the new closure-based TSTALLOC allocation order in §A.9 deviates from
ngspice's per-device TSTALLOC walk, this is architectural; if it matches
ngspice, J7 covers it as a golden re-record. Determine which by reading
ngspice's `bjtsetup.c`, `indset.c`, `scrset.c`, `tralump.c`.

---

### E6 — diode_circuit_direct strategy mismatch

`dc-operating-point.test.ts` — `diode_circuit_direct`
(`expected 'dynamic-gmin' to be 'direct'`)

**Root cause:** Production now falls back to dynamic-gmin where ngspice
takes the direct path on the same diode circuit. Architectural —
escalate after E1/E2 land (they likely affect the strategy decision).

---

### E7 — `noncon`-tracked failures

- `ckt-load.test.ts` — `noncon_incremented_by_device_limiting` (0 vs >0)
- `digital-pin-model.test.ts` — `handle_cache_stable_across_iterations`
- `newton-raphson.test.ts` — `e_singular_recovers_via_continue`,
  `e_singular_recovery_reloads_and_refactors`,
  `ipass_fires_with_nodesets`,
  `writes_into_ctx_nrResult` (4 vs 3)
- `phase-3-nr-reorder.test.ts` — `cites niiter.c:888-891 at the E_SINGULAR retry`
- `harness-integration.test.ts` — `MNAEngine exposes accessors after init`
  (0 vs 3), `SparseSolver exposes dimension, getCSCNonZeros` (2 vs 3),
  `findLargestDelta`
- `boot-step.test.ts` — `step accepted === true and converged === true`,
  `step dt === 0 (boot step is DCOP, no timestepping)` (0.171 vs 0)
- `convergence-regression.test.ts` — `half-wave rectifier converges`,
  `statePool state0 has non-zero values after DC operating point`,
  `statePool state1 is updated after accepted transient step`,
  `reset restores initial values in statePool`,
  `diode circuit runs 100 transient steps without error` (returns
  'ERROR' not !'ERROR')

These are NR-loop / boot-step / state-ring contract changes during the
wave. Triage as a group: re-read `newton-raphson.ts`, `boot-step.ts`,
`ckt-context.ts` and confirm what the new contract emits, then split
into J-jobs (test rewrites against the new contract) vs §K (production
regressions).

---

### E8 — Misc numerical / convergence / stamp-shape

| Test | Failure | Likely lane |
|---|---|---|
| `rlc-lte-path.test.ts` — RC step / RL step exponential matches | 5 vs ≤3.22, 1 vs ≤0.64 | E1 (LTE rooted) |
| `mna-end-to-end.test.ts` — diodes-in-series, parallel/anti-parallel diodes, diode_clamp, diode_shockley_consistency | false-true (5×) | E2 (pnjlim rooted) |
| `behavioral-combinational/-gate.test.ts` — pin_loading | false-true (3×) | likely §J12 family |
| `tapped-transformer.test.ts` — `center_tap_voltage_is_half`, `full_wave_rectifier`, `symmetric_halves` | 1.5e+300 / ERROR / 0 | numerical instability — E |
| `transformer.test.ts` — `voltage_ratio`, `power_conservation`, `analogFactory creates element with correct branch indices` | 5.7e+20 / 4.8e+193 / -1 vs 5 | numerical instability + branchIndex==-1 contract change (J6 fold) |
| `transmission-line.test.ts` — `step input arrives at port 2`, `matched load no reflection`, `lossy line < lossless`, `unterminated line voltage rises`, `N=50 delay more accurate than N=5` | false-true / ERROR / 0 | numerical (E) |
| `jfet.test.ts` — `emits_stamps_when_conducting` (5e-11 vs >1e-5) | numerical, jfet model | E |
| `crystal.test.ts` — `DC source across crystal` | false-true (1) | K6 |
| `polarized-cap.test.ts` — `capacitor voltage reaches 63% at t=RC` | NaN | K3 |
| `analog-fuse.test.ts` (recently modified, may have new test cases) | — | check after baseline |
| `potentiometer.test.ts` — `wiper=0.5 G_top=G_bottom=1/5000 bit-exact` (0.0002 vs 0.0004) | 2× factor; production stamp pair-counting | K (production) |
| `capacitor.test.ts` — `capacitor_load_transient_parity` (1 vs -0.0080) | numerical / K3 family |
| `inductor.test.ts` — `inductor_load_transient_parity` (NaN vs 9.98e-7) | K3 family |
| `ac-voltage-source.test.ts` — `rc_lowpass` | numerical (E1) |

---

## §P — Playwright (browser) failures

### P1 — CMOS-mode gate timeouts (×6)

Tests: `And/Or/NAnd/NOr/XOr/XNOr works in cmos mode` in
`gui/component-sweep.spec.ts:766` — all hit the 30s test timeout.

**Likely cause:** CMOS mode compilation triggers a new convergence path
(BJT-rooted, see §K3/K7) that hangs or runs orders of magnitude slower
than the digital fallback. NOT a test fix — production fix once the
underlying analog regressions land.

---

### P2 — `master-circuit-assembly.spec.ts` (×3)

- `Master 1: digital logic` — timeout at line 46
- `Master 2: analog — switched divider, RC, opamp, BJT` — status bar error
- `Master 3: mixed-signal — DAC, RC, comparator, counter` — `toBeLessThan` fail

These are the highest-leverage E2E tests. Likely surface §K3/K4/K7 in
combination. Run after the analog production fixes land.

---

### P3 — `hotload-params-e2e.spec.ts` BF param drift

Test: `changing BF on BJT via primary param row changes output voltage`
— observed 0.09577 vs expected 0.09577 with 1e-7 precision; off by 2.8e-6.

**Likely cause:** Numerical drift, related to E1/E2 family. Escalate.

---

### P4 — `analog-bjt-convergence.spec.ts` (×2)

- `compile and step — no convergence error, supply rail is 10V` — 0 vs 0.0208
- `step to 5ms — output voltage evolves and trace captures transient` — `not.toBeCloseTo` failure

**Likely cause:** Same BJT-rooted regression as the unit failures.

---

### P5 — `component-sweep.spec.ts` ADC bits=4 (×1)

`ADC at bits=4: set property and compile` — status bar shows error.
Possibly K-family ADC compile path.

---

## Suggested execution order

1. **Foundation rewrites** (touch many tests, no production code):
   J9 (encoding), J4 (drop branchCount), J5 (schema slot count), J7 (TSTALLOC golden re-record IF E5 confirms ngspice match).
2. **Hand-rolled fixture deletions:**
   J1 (MockSolver→SparseSolver), J6 (transformer setup), J2 (composite PropertyBag seeding).
3. **State-slot test rewrites:**
   J3 (capacitor/inductor/resistor/clock by-name lookup), J11 (harness query API).
4. **Production regressions (block several test families):**
   K3 (state-pool init NaN cascade — unblocks memristor, polarized-cap, crystal, possibly LED/tunnel-diode), K1 (dc-op offset OOB), K4 (real-opamp units), K5 (schmitt), K7 (LED), K8 (tunnel-diode).
5. **Then re-run vitest; remaining failures should fall into §E.**
6. **Ngspice parity escalation lane:**
   Run §E3 harness comparison sessions; produce escalation reports
   for E1, E2, E4, E6 with citations.
7. **Playwright** (P1–P5) re-run after K-jobs land.

Estimated post-J/K reduction: **249 → ≤ ~50 vitest failures**, with
remainder funneling through §E escalations to user.
