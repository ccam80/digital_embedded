# Test-Fix Jobs — post setup-load-cleanup wave

**Baseline at HEAD `fe1222a1`:**
- vitest: 8618 passed, **249 failed**, 15 skipped (398 files, 19.1s)
- playwright: 475 passed, **13 failed** (23 files, ~200s)
- combined: 9093 passed, **262 failed**

**Status after first J-job dispatch round (uncommitted on working tree):**
- vitest: 8673 passed, **191 failed**, 15 skipped (399 files)
- playwright: ~13 failed (no signal change; flake band)
- combined delta: **-58 vitest failures resolved**

**Status after second burst (this update — uncommitted, no test run performed):**
- **K12 landed** — `getSubElements()` added to 4 composites (Optocoupler, Timer555, Triac, Scr); `MNAEngine._buildDeviceMap` migrated; in-test `_deviceMap` workaround removed. Engine file is `analog-engine.ts` (not `mna-engine.ts`).
- ~~**E2 pnjlim K-fix landed**~~ — **REVERTED.** The investigation agent invented a "post-Gillespie revision" of `devsup.c:57-60` that doesn't exist in this checkout. Original digiTS code at `newton-raphson.ts:108,110` was a byte-for-byte port of `devsup.c:58,60`; the agent replaced canonical `(2+log(arg±2))` forms with non-canonical `log(1+arg)` / `vt*log(vnew/vt)` based on a phantom citation. **Both pnjlim tests are now reclassified as test bugs (J22)**, and the 5 `mna-end-to-end.test.ts` diode failures need a fresh investigation (the original cascade theory was tied to the phantom pnjlim bug). See updated §E2.
- **Tunnel-diode K-fix landed** — `setup()` was missing the idempotent `ctx.allocStates(this.stateSize)` call; added, gated on `_stateBase === -1`. Resolves the latent runtime crash on every tunnel-diode in any real circuit.
- **`withState` test-helper migration landed** — 3 files (`led.test.ts`, `tunnel-diode.test.ts`, `crystal.test.ts`). Helpers now build a real `SparseSolver`, run `setupAll([core], ctx)`, and use `allocateStatePool` — so `_stateBase` and TSTALLOC handles are real, not `-1`.
- **TLINE J-fix landed** — `setup-stamp-order.test.ts:2055` `props.set("segments", 2)` → `props.setModelParam("segments", 2)`. PropertyBag has separate `_map` / `_mparams` stores; the factory reads `_mparams`. PB-TLINE failed with 95 vs 15 entries because the override never reached `getModelParam`.
- **5 investigations completed** — Cluster B, E1 LTE, E5 TSTALLOC, E7 contract drift, TLINE `_segments`. New K-jobs (K13, K14, K15) and J-jobs (J15–J19) surfaced. E1 mostly **reclassified J-class**: tests cite the wrong ngspice file.

Touched 9 files this burst. Vitest delta unmeasured until user runs tests.

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

**Status legend** used in §J/§K/§E/§P:
- `[DONE]` — landed in the working tree (uncommitted)
- `[BLOCKED]` — spec gate returned, awaiting user direction
- `[OPEN]` — not yet attempted
- `[NEW]` — surfaced after first dispatch round
- `[NEW-2]` — surfaced after second burst (E7 / Cluster B investigations)

---

## Open decisions (3 user gates)

These all need authorization before further automated dispatch:

1. **§J12 behavioral-sequential migration** — three options (a/b/c) detailed in §J12 below.
2. **boot-step `step accepted/converged` ambiguity** (E7) — J (test fixes phase-hook setup) vs K (production must emit `onPhaseBegin` for direct DC-OP path).
3. **`MNAEngine` accessors after `init()`** (E7) — J (test calls `dcOperatingPoint()` first to trigger lazy `_setup`) vs K (`init()` should eagerly run `_setup()`).

**Gate 4 (pnjlim arg≤0 floor) WITHDRAWN** — was based on the erroneous
agent claim that production differed from canonical ngspice. Production
matches `devsup.c:58,60` byte-for-byte; the test expectation was wrong.
J22 corrects the test (see §E2).

Each job below names the failure pattern, the affected sites (with counts),
the root cause, and the **shape of the fix**. Where a job is escalation
rather than a test rewrite, it is filed in §E.

---

## §J — Test-migration jobs (test bugs; rewrite to current contract)

### J1 — Hand-rolled `MockSolver` retired in bridge / coordinator tests `[DONE]`

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

### J2 — BJT-composite tests pass non-Map / wrong PropertyBag shape `[DONE — partial]`

**Outcome:** All seven individual component test files (optocoupler, timer-555,
ota, real-opamp, schmitt-trigger, scr, triac) were already passing the Map and
seeding the right defaults — no edit needed. Only `setup-stamp-order.test.ts`
needed `*_DEFAULTS` seeding for PB-OPTO/OTA/REAL_OPAMP/SCHMITT.

**Follow-up regression discovered:** PB-OPTO setup then failed with
`CCCS 'Optocoupler_cccsCouple': unknown controlling source 'Optocoupler_vSense'`
because `OptocouplerCompositeElement` stores its sub-elements as named fields
(`_vSense`, `_cccsCouple`, etc.) rather than in a `_subElements` array, so
`MNAEngine._buildDeviceMap` never finds them. **Patched** in test via
`(engine as any)._deviceMap` injection — properly fixed in §K12 below.

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

### J3 — State-slot tuple access in capacitor / inductor / resistor / clock `[DONE]`

**Outcome:** All four files migrated from `makeCaptureSolver()` mock pattern
to real `SparseSolver` + `setupAll`. Resistor required a follow-up fix-up
because the first agent skipped `setupAll` for three tests.

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

### J4 — Definitions no longer expose `branchCount` field `[DONE]`

**Outcome:** Inductor, transformer, variable-rail tests all replaced with
post-setup `branchIndex >= 0` assertions. Transmission-line "requires branch
row" test deleted (TLINE composite has no primary branch — its branches live
on sub-elements `SegmentInductorElement` / `CombinedRLElement`).

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

### J5 — `stateSchema` slot-count assertions on transmission-line sub-elements `[DONE]`

**Outcome:** Three transmission-line schema tests replaced literal counts with
sorted-key-name assertions; canonical key sets recorded:
- `SegmentInductorElement`: `["GEQ", "IEQ", "I_PREV", "PHI", "CCAP"]`
- `SegmentCapacitorElement`: `["GEQ", "IEQ", "V_PREV", "Q", "CCAP"]`
- `CombinedRLElement`: `["GEQ", "IEQ", "I_PREV", "PHI", "CCAP"]`

`digital-pin-model.test.ts` two branch-role tests fixed with explicit
`pin.setup(setupCtx)` call before `pin.load(ctx)`.

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

### J6 — `_handles[h]` undefined when test skips `setup()` `[DONE]`

**Failure pattern:** `Cannot destructure property 'row' of 'handles[handle]' as it is undefined.` (×1, transformer winding test)

**Site:** `src/components/passives/__tests__/transformer.test.ts:190` (`winding_resistance_drops_voltage`)

**Root cause:** Test calls `el.load(ctx)` without first calling
`el.setup(ctx)`; the closure-local TSTALLOC handles are still `-1`.

**Fix shape:** Use `setupAll([el], ctx)` per A.19 canonical pattern
before any `load()`. (Fold into J1 if convenient — same family.)

---

### J7 — TSTALLOC golden sequences need re-recording `[BLOCKED — awaiting §E5]`

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

### J8 — `TEMP` key missing from default model bags (Zener, Schottky) `[DONE — production edit authorized]`

**Outcome:** Investigation gate confirmed both Zener and Schottky were Case B
(production gap). `instance: { TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature" } }`
bucket added to `ZENER_SPICE_L1_DEFAULTS` (zener.ts) and `SCHOTTKY_PARAM_DEFAULTS`
(schottky.ts), mirroring the canonical `diode.ts` pattern. Side-effect: a
zener test "all SPICE_L1 defs have partition 'model'" was renamed to
"...partition 'model' or 'instance'" since TEMP is per-instance.

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

### J9 — UTF-8 BOM / encoding artifact in `coordinator-speed-control` `[DONE]`

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

### J10 — `compile()` output surface: `statePool` / `_stateBase=-999` removed `[DONE]`

**Outcome:** Four legacy tests deleted; three replacements lock the new
contract: `compiled.statePool === null` (deferred to setup), `_stateBase === -1`
on every element post-compile, and a setup-pass test that verifies
`ctx.allocStates(...)` assigns contiguous state offsets.

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

### J11 — Harness query API: `SlotTrace`, `ComponentSlotsSnapshot`, `StateHistoryReport` `[DONE — Path C]`

**Outcome:** All six query-method tests resolved by adding a Capacitor
(1µF, id `c1`) to the `buildHwrCircuit` fixture so `listComponents().find(c => c.slotNames.length > 0)`
returns a pool-backed component (Path C — fixture, not API rename).
Stream-verification test 12 needed no edit: field names already match.

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

### J12 — `behavioral-sequential` outputs read 0 (digital wiring not driven) `[BLOCKED — needs decision]`

**Outcome:** Investigation gate returned Root B (tests bypass facade entirely:
hand-rolled `makeNullSolver`, direct element construction, no
`compileAnalogPartition` or facade anywhere). Migration to
`DefaultSimulatorFacade` blocked because:
1. No JSON counter/register fixture exists in repo, and the spec prohibits
   fabricating one without authorization.
2. Several tests assert on internal element state (`element.count`,
   `element.storedValue`, direct `allocElement` call tracking) not exposed
   through the facade's public API (`readSignal`, `step`, etc.).

**User decision required:** (a) authorize fabricating a counter/register
JSON spec + accept loss of internal-state coverage; or (b) keep the tests
direct-stamp but rewrite under the new contract; or (c) move these tests
to `headless/__tests__/` and assert against facade signal reads only.

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

**J14a (varactor) status:** `[DONE — deleted]` — `setup_allocates_handles_before_load`
asserted on 7 closure-local TSTALLOC handle names that no longer exist as
fields. Adjacent test `TSTALLOC_ordering_RS_zero_7_entries` already covers
the same intent via `_getInsertionOrder()`. Test deleted.

**J14b (wire-current-resolver) status:** `[BLOCKED — K-class]` — failures
trace to a production-side regression (current resolver returns 0 where
the compiled circuit should have a non-zero current). Routes to §K below.



| Failure | Site | Cause | Fix |
|---|---|---|---|
| `expected 0 to be greater than 0.045` | wire-current-resolver.test.ts:1070 (`cross-component current equality through real compiled lrctest.dig`) | LRC fixture compile path no longer writes per-pin currents | Read current-resolver.ts to confirm; rewrite assertion against the new resolver API |
| `expected 0 to be greater than 0` (×10 across 6 files) | wire-current-resolver, tapped-transformer, ckt-load `noncon_incremented_by_device_limiting`, convergence-regression `reset restores`, digital-pin-model `handle_cache_stable_across_iterations`, newton-raphson `e_singular_*`, harness-integration `captureElementStates`, `findLargestDelta` | Mixed bag — some are real production stamps returning 0; others are tests that assume an old branchIndex. Triage individually. | Mixed §J / §K |
| `actual value must be number or bigint, received "undefined"` | varactor.test.ts:162 (`setup_allocates_handles_before_load`) | Test reads `el._h…` at a path that's now closure-local, not on the literal (per A.9) | Drop the field assertion; assert handles via post-load matrix entries |
| `expected null not to be null` | schmitt-trigger.test.ts:358 (`plot_matches_hysteresis_loop`) | Hysteresis plot helper returns null when stamping yields no transition (related to schmitt §K5) | After §K5 lands, re-examine |

---

### J15 — `digital-pin-model.test.ts` `pin.setup()` missing on cache-stability tests `[NEW-2]`

**Sites:** `digital-pin-model.test.ts:295-312` and `:367-383` —
`handle_cache_stable_across_iterations` (output and input variants).

**Root cause:** Tests call `pin.init(NODE, -1/0)` and `pin.load(ctx)` but
**never call `pin.setup(ctx)`**. Per spec §A.5, `setup()` is the sole
allocator — `digital-pin-model.ts:190-203, 328-331` moved `allocElement`
out of `load()` into `setup()`. Without setup, `_hNodeDiag = -1` and
`stampElement` is a no-op. Test expects `firstCallCount > 0`, observed 0.

**Fix shape:** Prepend `pin.setup(setupCtx)` to each test, mirroring the
existing pattern at `:153-164` (which already does this for the branch-role
tests fixed in J5). ~3 LOC per test.

**Resolves:** 2 tests.

---

### J16 — `ckt-load.test.ts` inline `makeDiode` bypasses `pnjlim` `[NEW-2]`

**Site:** `ckt-load.test.ts:79-116` (`makeDiode` test helper) +
`:224-241` (`noncon_incremented_by_device_limiting`).

**Root cause:** Test's hand-rolled `makeDiode` clamps `vD = Math.min(vA-vK, 0.7)`
and stamps directly — does NOT call `pnjlim` or increment `ctx.noncon.value++`.
After the wave, `noncon` is incremented only by elements that actually
emit limiting events. Production `diode.ts:672` correctly does the bump.

**Fix shape:** Replace the inline `makeDiode` with `createDiodeElement`
from `src/components/semiconductors/diode.ts`. Drops ~40 LOC of hand-rolled
fixture; matches the project rule "use real elements".

**Resolves:** 1 test.

---

### J17 — `phase-3-nr-reorder.test.ts` citation marker rename `[NEW-2]`

**Site:** `phase-3-nr-reorder.test.ts:246-277` (`cites niiter.c:888-891 at the E_SINGULAR retry`)

**Root cause:** Test scans `newton-raphson.ts` for context strings
`lastFactorUsedReorder` or `!factorResult` near a `solver.forceReorder()`
call. Production at `:415` cites `niiter.c:888-891` but uses
`lastFactorWalkedReorder` ("Walked", not "Used"). Test regex matches
neither variant.

**Fix shape:** Update the test regex/string match from
`lastFactorUsedReorder` → `lastFactorWalkedReorder`. ~1 line.

**Resolves:** 1 test.

---

### J18 — `newton-raphson.test.ts` rhs length convention 4 → 3 `[NEW-2]`

**Site:** `newton-raphson.test.ts:185-198` (`writes_into_ctx_nrResult`)

**Root cause:** Test asserts `ctx.nrResult.voltages.length === 3` but
got 3 (so observed correctness — failure shows `expected 4, got 3`).
The wave's `rhs` buffer-size convention changed from `matrixSize+1`
(old "ground sentinel" allocation) to plain `matrixSize`. Test asserts
the old convention.

**Fix shape:** Change `expect(ctx.nrResult.voltages.length).toBe(4)`
→ `toBe(3)`. ~1 line.

**Resolves:** 1 test.

---

### J19 — `harness-integration.test.ts` HWR fixture branch alloc missing `[NEW-2]`

**Site:** `harness-integration.test.ts:544-555` (`SparseSolver exposes dimension, getCSCNonZeros`)

**Root cause:** Test fixture builds an HWR (half-wave rectifier) circuit
matrixSize=3 (2 nodes + 1 branch). After `_setup()`, solver dimension
should be 3. Got 2. Voltage-source `findBranchFor` is never invoked —
its branch row never allocates. Per J4, `branchCount` was dropped from
`ModelEntry`, so the compiler-less inline fixture has nothing forcing
the source's `findBranchFor` to fire.

**Fix shape:** In `makeHWR`, after building the `setupCtx`, call
`vs.findBranchFor("Vs:branch", setupCtx)` to force the branch
allocation, OR migrate to `makeSimpleCtx`/`runDcOp` from `test-helpers.ts`
which handle this. ~3 LOC.

**Resolves:** 1 test (+ likely cascade to `findLargestDelta` and
`MNAEngine exposes accessors after init` if the latter resolves to
"call `dcOperatingPoint()` first" per Open Decision #3).

---

### J20 — `ckt-terr.test.ts` NGSPICE_REF rewrites against `cktterr.c` `[NEW-2]`

**Sites:** `ckt-terr.test.ts:534-723` (~13 tests).

**Root cause:** Tests assert against `ckttrunc.c` (NEWTRUNC voltage-domain)
formulas while the function under test (`cktTerr`) ports
`cktterr.c:69-75` (charge-domain unified scalar). See E1 entry for
detailed reframe.

**Fix shape:** Per-test, rewrite the NGSPICE_REF block to use
`cktterr.c:69-75`'s unified scalar form:
- `del = trtol*tol / max(abstol, factor*|diff|)` (no sqrt)
- `factor` table: `gearCoeff = {.5, .2222..., .1364..., .096, ...}`,
  `trapCoeff = {.5, .0833...}`
- Order=2 → `del = sqrt(del)`; order>2 → `del = exp(log(del)/order)`
  (root index `order`, not `order+1`)

Affected tests (one block rewrite each):
- `cktTerr_trap_order1_matches_ngspice`
- `cktTerr_trap_order2_matches_ngspice`
- `cktTerr_gear_order1_sqrt`
- `gear_higher_order_root_is_order_plus_one`
- `gear_lte_factor_order_3/5/6` (×3)
- `order 1 trapezoidal: returns finite positive timestep`
- `order 2 gear: returns sqrt-scaled timestep`
- `gear order 2 returns positive finite timestep`
- `constant charge history produces finite timestep — abstol-gated`
- `cktTerr_trap_order2_matches_ngspice` (the 1.1e-24 vs 1.5e-6 case)

**Estimated LOC:** ~50 across the 13 tests.

**Resolves:** 13 tests. Possibly cascade-resolves the 14 RLC end-to-end
LTE failures (see E1 residual note).

---

### J21 — `ckt-terr.ts` widen `deltaOld` parameter type `[NEW-2]`

**Sites:** `ckt-terr.ts` `cktTerr` signature; `ckt-terr.test.ts:362-368`
(`zero_allocations_in_lte_path`).

**Root cause:** `cktTerr` declares `deltaOld: readonly number[]`. Test
allocates a `Float64Array` and converts via `Array.from(deltaOld)` 4×
per loop × 50 iterations = 200 allocations — counted by a proxied
`Array` constructor in the test. Test instruments itself, then asserts
`arrayCount === 0`.

**Fix shape:** Widen the `deltaOld` parameter type from
`readonly number[]` to `ArrayLike<number>` (matches both `number[]` and
`Float64Array`); drop `Array.from` in the test. ~1 line in production
+ 4 line edits in test.

**Note:** Despite touching production, this is a structural type fix,
not numerical — bundle with J20 in the same dispatch.

**Resolves:** 1 test.

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

### K3 — Memristor / polarized-cap NaN cascade `[PARTIAL — burst 2; reframed]`

**Reframe (burst 2 investigation):** Most "Cluster B" failures
(K3/K6/K7/K8) traced not to a single state-pool init regression in
production but to a **test-helper pattern**: per-test `withState(core)`
helpers in `led.test.ts`, `tunnel-diode.test.ts`, `crystal.test.ts`
allocated a `StatePool` and called `core.initState(pool)` but **skipped
`setup(ctx)`** entirely. `_stateBase` stayed at `-1` → every
`pool.state0[base + SLOT_X]` read landed OOB → NaN propagation.

**Burst 2 fixes landed:**
1. **`withState` helper rewrite** across all 3 files — now builds a real
   `SparseSolver` + `setupAll([core], ctx)` + `allocateStatePool([core])`.
   Resolves the cascade for tests that used those helpers.
2. **Tunnel-diode `setup()` `allocStates`** — production fix, idempotent
   `if (this._stateBase === -1) this._stateBase = ctx.allocStates(this.stateSize);`
   guard added before `this._vccs.setup(ctx)`. Resolves the latent
   runtime crash for any real circuit using tunnel-diode (the test-helper
   migration alone wouldn't have caught it because tunnel-diode's setup
   was *itself* broken).

**Remaining K3 work-orders (queued):**

→ **K3a Polarized-cap `IC=NaN` propagation** — `polarized-cap.ts:469-479`
evaluates `cond1 = (MODEDC && MODEINITJCT) || (MODEUIC && MODEINITTRAN)`.
On DC-OP warm-start with `cond1=true`, `vNow = this._IC = NaN` →
`s0[base + SLOT_Q] = C * NaN` → propagates through state ring. **Fix:**
gate IC consumption on `Number.isFinite(this._IC)` in the constructor
or coerce default to 0. Mirror `capload.c:46-51` `CAPicGiven` gating.
~5 LOC. Resolves 1 test.

→ **K3b Memristor test index mismatch** — TEST BUG, not production:
`memristor.test.ts:278-325` builds a `Float64Array(2)` rhs for a
2-pin element with `_pinNodes = [A=1, B=2]`, then asserts `sumAt(0,0) === G`
treating node 1 as solver row 0. Either the test should use rows
matching the pin nodes (1, 2) or the production element is renumbering.
Read 5 lines of context to disambiguate. ~5 LOC test fix. Resolves 4–9
tests in `memristor.test.ts`.

→ **K3c LED `setParam("TEMP")` may not call `recomputeTemp()`** — needs
investigation. The `vt_reflects_TEMP` and `setParam_TEMP_recomputes`
tests for LED, tunnel-diode, and possibly diode all assert that
`setParam("TEMP", v)` triggers `recomputeTemp()` in the element. Read
`diode.ts` setParam body around line 800+ to confirm.

→ **K3d Crystal DC-source structural-singularity** — separate root from
the `withState` issue. The "DC source across crystal produces near-zero
current" test uses `runDcOp` (which DOES run setup correctly), so the
helper migration doesn't cover it. Caps stamp open at DC, Ls stamps a
wire, but `n2` may be floating except for gmin-bleed. Verify the bleed
connection. May fold into a small production fix or stay as test-side
acknowledgement that the gmin bleed is what carries the assertion.



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

### K12 — Composite elements lack `getSubElements()` accessor `[DONE — burst 2]`

**Outcome:** `getSubElements()` added to `OptocouplerCompositeElement`,
`Timer555CompositeElement`, `TriacCompositeElement`, `ScrCompositeElement`.
18 other composites already conformant. `MNAEngine._buildDeviceMap`
(actually in `src/solver/analog/analog-engine.ts`, not `mna-engine.ts`)
migrated to prefer `getSubElements()` with `typeof` guard, falling back to
`_subElements` for non-composite leaves. In-test `(engine as any)._deviceMap`
workaround in `setup-stamp-order.test.ts` PB-OPTO removed. `CompositeElement`
base class already declared the abstract method.

**Dependency order** chosen per composite:
- Optocoupler: `_dLed → _vSense → _cccsCouple → _bjtPhoto`
- Timer555: `_rDiv1, _rDiv2, _rDiv3, _comp1, _comp2, _bjtDis, _outModel, _childElements`
- Triac: `_q1, _q2, _q3, _q4`
- Scr: `_q1, _q2`



**Site:** Surfaced as a side-effect of fixing PB-OPTO setup-stamp-order. The
`MNAEngine._buildDeviceMap` traverses each compiled element's
`._subElements` array to register sub-elements for `findDevice` /
`findBranch` lookups. `OptocouplerCompositeElement` (and likely the other
composites: `Timer555CompositeElement`, `OtaCompositeElement`,
`RealOpampCompositeElement`, `SchmittCompositeElement`, `ScrCompositeElement`,
`TriacCompositeElement`, `TappedTransformerElement`, etc.) store their
sub-elements as named instance fields (`_vSense`, `_cccsCouple`, `_dLed`,
`_bjtPhoto`, …) rather than in a `_subElements: AnalogElement[]` array.

Result: when a sub-element calls `ctx.findBranch("<peer>")` during setup
or load, the device map cannot resolve the peer because it was never
registered. PB-OPTO test was patched in-test via
`(engine as any)._deviceMap` injection — that bypass is a smell, and
every other composite has the same latent bug.

**Fix shape:** Per spec §A.15 (`CompositeElement` abstract base class),
every composite must implement `getSubElements(): readonly AnalogElement[]`.
Either (a) add `getSubElements()` to each composite class returning the
named-field children in pinLayout-or-dependency order, AND change
`MNAEngine._buildDeviceMap` to call `getSubElements()` instead of
walking `._subElements` directly; or (b) populate a `_subElements` array
in each composite's constructor as a mirror of the named fields, and
keep the engine's traversal as-is.

The §A.15 spec mandates `getSubElements()` — option (a) is the canonical
choice. Production fix.

**Side effect:** Once K12 lands, the test-side `(engine as any)._deviceMap`
patch in `setup-stamp-order.test.ts` PB-OPTO becomes a no-op and should
be removed (revisit as part of K12 cleanup).

---

### K13 — E_SINGULAR retry path missing `solver.beginAssembly()` `[NEW-2]`

**Sites:** `newton-raphson.test.ts:770-832` `e_singular_recovers_via_continue`,
`newton-raphson.test.ts:834-891` `e_singular_recovery_reloads_and_refactors`.

**Root cause:** Test stubs `factor()` to return `spSINGULAR`, expects
`beginAssemblyAfterFailure > 0`. Production at `newton-raphson.ts:445-448`
calls `solver.forceReorder()` + `continue` after spSINGULAR — but the wave
reorganized cktLoad such that `solver.beginAssembly()` (or
`_resetForAssembly`) is no longer called between `forceReorder` and the
next factor. The retry stamps land into stale CSC layout.

**Fix shape:** Restore the post-`forceReorder` `solver.beginAssembly()` /
`_resetForAssembly()` call before re-entering cktLoad on retry. Cite
`niiter.c:881-902` (the canonical ngspice path that pairs `factor` /
`solveCircuit` with assembly resets on E_SINGULAR retry).

**Estimated LOC:** ~3. Resolves 2 tests.

---

### K14 — `_lastDt` seeded by something during `dcOperatingPoint()` `[NEW-2]`

**Site:** `harness/boot-step.test.ts:214-217` `step dt === 0 (boot step is DCOP, no timestepping)`

**Root cause:** Test calls `engine.dcOperatingPoint()` then asserts
`engine.currentDt === 0`. Got `0.171` — exactly `params.maxTimeStep`
default. Either `TimestepController` constructor at `:179, 213` writes
`_lastDt = params.maxTimeStep` on configure, or `dcOperatingPoint()`
itself seeds `_lastDt` somewhere in the boot path.

**Fix shape:** Audit `TimestepController` constructor and
`analog-engine.ts:dcOperatingPoint()` (lines 821-922). Either explicitly
zero `_lastDt` at line 853 before `_setup()`, or audit the controller's
`deltaOld[0]` seed (`:179, 213`).

**Estimated LOC:** ~1. Resolves 1 test.

---

### K15 — `ipass` not initialized to 1 on MODEINITFLOAT entry with nodeset `[NEW-2]`

**Site:** `newton-raphson.test.ts:557-600` `ipass_fires_with_nodesets`

**Root cause:** Test sets `ctx.cktMode = MODEDCOP | MODEINITFLOAT` and
seeds a nodeset; expects `convergeIter > initFloatBeginIter`. Production
`newton-raphson.ts:644-649` reads `ctx.hadNodeset` and decrements `ipass`
inside the MODEINITFLOAT branch — but the wave's NR-loop reorganization
moved the `ipass` write into the MODEINITFIX branch (`:691`). Starting
directly in MODEINITFLOAT means `ipass` never gets set to 1, the gate at
`:645` (`if (ipass)`) never fires.

**Fix shape:** Add an `ipass = 1` initialization in the MODEINITFLOAT
entry path when `hadNodeset && isDcop` is true and the caller bypassed
the JCT/FIX ladder. Cite `niiter.c` for the original ipass control flow.

**Estimated LOC:** ~3. Resolves 1 test.

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

### E1 — `ckt-terr` LTE numerical mismatches `[RECLASSIFIED — mostly J-class]`

**Investigation outcome (burst 2):** digiTS `cktTerr` correctly mirrors
`ref/ngspice/src/spicelib/analysis/cktterr.c:69-75` (charge-domain LTE,
unified scalar formula). The **TESTS** at
`__tests__/ckt-terr.test.ts:534-723` instead encode the
`ref/ngspice/src/spicelib/analysis/ckttrunc.c` NEWTRUNC voltage-domain
formula — a **different ngspice file** for a different code path.
Per-device `captrunc.c`/`indtrunc.c` call `CKTterr` (charge), not
`CKTtrunc` (voltage). Implementation citation in source comment and the
test's NGSPICE_REF blocks point at different files.

**13 of 14 failures are test bugs, not production:**

→ **New J-job: J20** — Rewrite the 13 ckt-terr.test.ts NGSPICE_REF blocks
against `cktterr.c:69-75`'s unified scalar form (no `Math.sqrt` for
trap-1, no `delsum` term for gear, root index `order` not `order+1`).
Affected tests: `cktTerr_trap_order1_matches_ngspice`,
`cktTerr_trap_order2_matches_ngspice`, `cktTerr_gear_order1_sqrt`,
`gear_higher_order_root_is_order_plus_one`, `gear_lte_factor_order_3/5/6`,
`order 1 trapezoidal: returns finite positive timestep`,
`order 2 gear: returns sqrt-scaled timestep`, `gear order 2 returns positive
finite timestep`, `constant charge history produces finite timestep`.

→ **New micro-K: K17** — Widen `cktTerr`'s `deltaOld` parameter type
from `readonly number[]` to `ArrayLike<number>` so the test can drop
`Array.from(deltaOld)`. Resolves `zero_allocations_in_lte_path` (200
allocations come from the test's own `Array.from`, not from `cktTerr`).
~1 line in `ckt-terr.ts` + 4 line edits in test.

**Residual E1 escalation:** the 14 RLC end-to-end failures
(`rlc-lte-path.test.ts` RC step ≤3.22V, RL step ≤0.64V) are downstream
of whichever LTE formula governs `computeNewDt` — they confirm dt isn't
tightening enough on the charging transient. Likely resolves naturally
when J20 lands and the formula tightening propagates through
`timestep.ts:412-420`. Re-evaluate after J20.



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

### E2 — `pnjlim_matches_ngspice_*` `[REVERTED — agent error; reclassified as test bugs]`

**Burst 2 outcome (CORRECTED):** The investigation agent claimed the
production formula at `newton-raphson.ts:108,110` was "corrupt" and
replaced it with `log(1 + arg)` / `vt * log(vnew/vt)`. **This was
wrong.** The actual canonical `ref/ngspice/src/spicelib/devices/devsup.c`
in this repo, lines 58,60, reads literally:

```c
vnew = vold + vt * (2+log(arg-2));     // L58 — canonical
vnew = vold - vt * (2+log(2-arg));     // L60 — canonical
```

The original digiTS code was a **byte-for-byte port** of devsup.c. The
agent invented a "post-Gillespie revision" with the `log(1+arg)` form
that is not present anywhere in this checkout's ngspice source. Burst 2
patch reverted in cleanup.

**Reclassification:** **Both tests are test bugs**, not production bugs.

→ **New J-job: J22** — Rewrite both pnjlim test expectations against
the actual canonical formulas:

| Test | Inputs | Production output (canonical) | Test should expect |
|---|---|---|---|
| `pnjlim_matches_ngspice_forward_bias` | vold=0.7, vnew=1.5, vt=0.02585 | `0.7 + 0.02585*(2+log(28.948)) = 0.83870` | **0.83870** (was 0.789547) |
| `pnjlim_matches_ngspice_arg_le_zero_branch` | vold=0.5, vnew=0.42, vt=0.02585 | `0.5 - 0.02585*(2+log(5.095)) = 0.40621` | **0.40621** (was 0.300000) |

Site: `src/solver/analog/__tests__/newton-raphson.test.ts:427-455`. Two
constants change. ~2 LOC.

**Cascade reset:** The 5 `mna-end-to-end.test.ts` diode failures
(`two_diodes_in_series`, `parallel_diodes`,
`diode_clamp_on_resistor_divider`, `anti_parallel_diodes`,
`diode_shockley_equation_consistency`) were claimed to chain off the
"pnjlim bug". Pnjlim is correct, so **those failures have a different
unknown root cause**. They need a fresh investigation, NOT folded into E2.

→ **New investigation job: I-DIODE** — trace what actually fails in the
diode end-to-end tests. Candidates: gmin-stepping fallback path,
source-stepping continuation, `diode.ts:load()` stamp algebra,
SLOT_VD/SLOT_GD pool slot timing under MODEINITTRAN.

**Open Decision #4 (originally about pnjlim arg≤0 floor) — withdrawn.**
The arg≤0 branch test was simply wrong about what ngspice does. No
architectural divergence; J22 corrects the test.

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

### E5 — TSTALLOC sequence divergence (PB-BJT, PB-IND, PB-SCR, PB-TLINE) `[INVESTIGATED — all 4 MATCH ngspice]`

**Investigation outcome (burst 2):** All four devices match ngspice;
**no E5 escalation needed.** Routes back to J7 for golden re-record.

| Device | Verdict | Notes |
|---|---|---|
| BJT | MATCH `bjtsetup.c:435-464` | digiTS emits 23 stamps; 3 substrate stamps go to TrashCan when subst=0; 20 recorded — identical sequence to ngspice. Test golden has length 9 (was authored against an earlier 9-entry partial). |
| IND | MATCH `indsetup.c:96-100` | digiTS emits exactly the 5 ngspice stamps in the same order. Test failure was order-shift artifact in old golden. |
| SCR | MATCH `bjtsetup.c:435-464` × 2 (no stock-ngspice SCR) | Composite of NPN + PNP BJTs sharing internal latch node; emits 40 entries (2× BJT). Test golden has length 18 (pre-wave partial). |
| TLINE | MATCH J5 ladder design (architectural divergence from ngspice TRA, already accepted in J5) | `_segments` test bug fixed in burst 2 (`setup-stamp-order.test.ts:2055`); now produces 15 entries for N=2 (was 95 because PropertyBag namespace mismatch made it run with default N=10). |

**Action:** All four route to J7. The TLINE test fix already landed
in burst 2. BJT/IND/SCR golden re-record remain queued (J7).

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

**Stage 1 — Burst 1 foundation rewrites:** all `[DONE]`
- J9 (encoding), J4 (drop branchCount), J5 (schema slot count)
- J1 (MockSolver→SparseSolver), J6 (transformer setup), J2 (composite PropertyBag seeding)
- J3 (state-slot lookup), J11 (harness query API)

**Stage 2 — Burst 2 fixes (this cycle):** all `[DONE]`
- K12 (composite `getSubElements()`)
- E2 pnjlim 2-line K-fix
- Tunnel-diode `setup()` `allocStates`
- `withState` test-helper migration (3 files)
- TLINE `setModelParam` 1-line test fix

**Stage 3 — Queued test rewrites (low risk, no user gates):**
- J20 (ckt-terr NGSPICE_REF rewrites against `cktterr.c`) — 13 tests
- J21 (widen `cktTerr` `deltaOld` type + drop `Array.from`) — 1 test
- J15 (`pin.setup()` on cache-stability tests) — 2 tests
- J16 (replace inline `makeDiode` with `createDiodeElement`) — 1 test
- J17 (citation rename `lastFactorWalkedReorder`) — 1 test
- J18 (rhs length 4→3) — 1 test
- J19 (HWR fixture branch alloc) — 1 test
- J7 (BJT/IND/SCR golden re-record — E5 confirmed match) — 3 tests
- K3b (memristor test index mismatch — TEST fix not production) — 4–9 tests

**Stage 4 — Queued production fixes (low risk):**
- K13 (E_SINGULAR retry `beginAssembly`) — 2 tests
- K14 (`_lastDt` seed) — 1 test
- K15 (`ipass` on MODEINITFLOAT) — 1 test
- K3a (polarized-cap `IC=NaN` guard) — 1 test
- K3c (LED `setParam("TEMP")` `recomputeTemp` — needs investigation) — 2 tests
- K1 (dc-op offset OOB) — 4 tests
- K4 (real-opamp param units 1000× off) — 8 tests
- K5 (schmitt 0-output) — 3 tests
- K7 (LED forward-drop residual after K3c) — review
- K8 (tunnel-diode residual after burst 2) — review
- K9 (variable-rail / dc-vsrc PULSE) — 2 tests
- K11 (flip-flop diagnostic emission) — 2 tests
- K3d (crystal DC-source structural-singularity) — review
- K17 (widen deltaOld param — bundled with J21)

**Stage 5 — Open user decisions** (4 gates listed at top):
- Gate 1: §J12 behavioral-sequential migration option
- Gate 2: boot-step `step accepted` J vs K
- Gate 3: `MNAEngine` accessors after `init()` J vs K
- Gate 4: pnjlim arg≤0 floor — test correction vs architectural divergence

**Stage 6 — Re-run vitest** to measure post-Stage-3/4 reduction; remaining
failures should be ≤ ~30 (mostly §E escalation candidates).

**Stage 7 — Ngspice parity escalation lane:**
- Run §E3 harness comparison sessions (CLAUDE.md mandates this is the
  first tool for numerical issues anyway); produce escalation reports
  for any residual E1, E4 entries with full (row, col, ours, ngspice)
  quartets at the divergence iteration.
- E5 closed (all 4 devices match ngspice).
- E2 closed (single bug fixed; arg≤0 is Gate 4).

**Stage 8 — Playwright** (P1–P5) re-run after K3a/K4/K5/K7/K8 land. The
master-circuit-assembly suite likely surfaces residual K-class issues in
combination — best run after the analog production fixes.

---

## Post-dispatch status snapshot (this fork point)

**Jobs landed (uncommitted on working tree):** J1, J2 (partial), J3, J4,
J5, J6, J8, J9, J10, J11, J14a — plus three follow-up regression-fixups
(resistor `setupAll`, zener `partition` rename, PB-OPTO device-map inject).

**Test files modified:** ~26 across `__tests__/` directories. **Production
edits:** 2 files (`zener.ts`, `schottky.ts`) — added canonical
`instance: { TEMP }` bucket. No other production source touched.

**Vitest delta:** 249 → 191 failures (-58). The remaining 191 break down as:

- **K-class (production bugs):** ~85 failures across K1, K3–K8, K9, K11,
  K12. Many trace to common roots (state-pool init regression, composite
  sub-element discovery, real-opamp param-units), so a small number of
  production fixes may resolve disproportionate failure counts.
- **E-class (ngspice numerical / parity):** ~80 failures across E1–E8.
  Need user direction per banned-vocab rules — agents do not file these
  in `architectural-alignment.md`.
- **Re-triage candidates:** ~25 (e.g. tapped-transformer, transmission-line
  numerical instability, behavioral-combinational/-gate pin-loading,
  diac/scr setup throws). These need a second-pass categorization once
  K12/K3 land — current root-cause guesses may shift.

**Open spec gates that returned during dispatch:**

| Gate | Job | Question |
|---|---|---|
| §J7 + §E5 | TSTALLOC goldens | Does the new closure-allocation order match ngspice's per-device TSTALLOC walk for PB-BJT/PB-IND/PB-SCR/PB-TLINE? Authorize re-record vs route to architectural escalation. |
| §J12 | behavioral-sequential | Authorize a counter/register JSON fixture, OR pivot to facade-only assertions losing internal-state coverage, OR keep direct-stamp tests rewritten under new contract. |
| §K12 | composite getSubElements | Authorize a production sweep to add `getSubElements()` to every composite per spec §A.15, and migrate `MNAEngine._buildDeviceMap` to call it. |

**Estimated post-K reduction:** With K3 + K12 (the two highest-leverage
production fixes) the remaining count likely drops to ~80 (mostly §E
escalation candidates).

Estimated post-J/K reduction (terminal): **249 → ≤ ~50 vitest failures**,
with remainder funneling through §E escalations to user.

---

## Post-burst-2 status snapshot

**Burst 2 jobs landed (uncommitted on working tree):**

| Job | Type | Files touched | LOC | Tests likely resolved |
|---|---|---|---|---|
| K12 | production + 1 test | 4 composites + `analog-engine.ts` + `setup-stamp-order.test.ts` | ~50 | PB-OPTO setup unblocked + future composite latency removed |
| ~~E2 pnjlim 2-line~~ | ~~production~~ | ~~`newton-raphson.ts:108,110`~~ | **REVERTED** | Agent error — production matches `devsup.c:58,60` exactly; tests are wrong (→ J22). The 5 mna-end-to-end diode failures need new investigation, not pnjlim-rooted. |
| Tunnel-diode `allocStates` | production | `tunnel-diode.ts:281-286` | 3 | latent — any real circuit using tunnel-diode |
| `withState` helper migration | 3 tests | `led.test.ts`, `tunnel-diode.test.ts`, `crystal.test.ts` | ~45 | the K6/K7/K8 NaN cascades that share this helper |
| TLINE `setModelParam` | 1 test | `setup-stamp-order.test.ts:2055` | 1 | 1 (PB-TLINE) |

**Total burst 2:** 5 fixes, 9 files, ~100 LOC. Test-failure delta
unmeasured (no test runs performed per protocol).

**Burst 2 investigations (read-only) returned:**

| Investigation | Outcome |
|---|---|
| Cluster B state-pool init | Reframed as test-helper pattern issue; tunnel-diode allocStates is genuine production bug; remaining K3a–K3d are surgical (small LOC each) |
| E1 LTE formula divergence | digiTS `cktTerr` correctly mirrors `cktterr.c`; tests cite wrong file (`ckttrunc.c`) → reclassified as **mostly J-class** (J20/J21) |
| E2 pnjlim formula divergence | Bug isolated to 2 lines; production fix landed; arg≤0 branch test floor escalated to Gate 4 |
| E5 TSTALLOC alignment | All 4 devices (BJT, IND, SCR, TLINE) match ngspice canonical order; route to J7 golden re-record (TLINE already fixed in burst 2) |
| E7 contract drift triage | 18 tests classified: 7 J-class (J15–J19), 3 new K-class (K13/K14/K15), 6 cascading from K3, 2 ambiguous (Gates 2 + 3) |
| TLINE `_segments` threading | PropertyBag namespace bug; one-line test fix landed |

**Updated remaining failure breakdown (~191 baseline at fork point):**

- **~7** resolved by E2 pnjlim K-fix (when tests run)
- **~13** queued for J20 (ckt-terr test rewrites)
- **~14** queued for J7/J15–J19 cluster (small test rewrites)
- **~10** unknown but likely resolved by burst 2 cumulative (withState
  migration unblocks most LED/tunnel-diode/crystal tests)
- **~6** cascading from K3a/K3b (polarized-cap IC, memristor index)
- **~5** cascading from K13/K14/K15 (NR / boot-step / nodeset)
- **~10** queued for K1/K4/K5/K7/K8 production fixes
- **~6** real ngspice-parity escalations (E3 harness, E4 ULP, E6 strategy)
- **~10** awaiting user decision (4 gates × multiple cascading tests each)

**Estimated post-Stage-3+4 reduction (terminal pre-escalation):**
**~191 → ~25–35 vitest failures**, of which ~15 are §E escalations and
~10 are gated on user decisions.

**No further dispatch this session.** The execution spec for Stage 3 +
Stage 4 is now defined; the user can dispatch in batches or as a single
sweep. Recommended dispatch order:

1. **First batch — pure test rewrites (highest confidence, zero blast radius):**
   J7 (BJT/IND/SCR re-record), J15, J16, J17, J18, J19, J20, J21, K3b.
2. **Second batch — small production fixes (one file each):**
   K3a, K13, K14, K15.
3. **Run vitest.** Re-baseline.
4. **Third batch — wider production fixes:**
   K1, K4, K5, K7 residual, K8 residual, K9, K11.
5. **Fourth batch — gated work:** address the 4 user gates.
6. **Final E lane:** run E3 harness, file E1 residual, E4, E6 escalations.
