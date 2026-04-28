# Setup-Load Cleanup — Pinned Follow-ups (post-triage)

Triage status: every item below has a baked-in decision. The next agent reads
this file once, applies the action steps directly, and runs the cited targeted
tests. No re-discussion, no "Decision needed" sections — those have all been
resolved.

Items already landed during the triage run have been removed. What remains is:

- §A — Production-shape decisions. Most are approved with a named option;
  three (A.11, A.12, A.13) require investigation or design input before an
  agent can act.
- §B — Latent-stamp-gap items, all approved with action steps.
- §C — Deferred audits (next sweep, after this batch lands).

Each action item references the original ngspice source line where applicable
so the agent can verify bit-exactly without re-deriving.

---

## A. Production-shape decisions (approved — apply named option)

### A.3 — `bjt.ts` `elementIndex` declaration shape — APPROVED (a)

**Files:** `src/components/semiconductors/bjt.ts` (factory return literals at
~2073 and ~2313/2382), `src/components/semiconductors/__tests__/bjt.test.ts`
(lines 361, 368, 387, 394).

**Action:**
1. Drop the `elementIndex: undefined as number | undefined` line from every
   factory return literal in `bjt.ts`. Let the field be "missing" on the
   literal rather than explicitly undefined.
2. The reads at the limiting-collector push sites (currently
   `el0.elementIndex ?? -1` etc.) already handle the optional case correctly —
   leave them as-is.
3. The compiler `Object.assign`s `elementIndex` after factory construction; the
   field still appears at runtime when the harness needs it.

**Why (a) over the alternatives:** preserves the `elementIndex?: number`
contract on `AnalogElement` (analog-types.ts:194-199); isolates the workaround
to bjt without widening the type for every element. ngspice has no analog of
`elementIndex` (devices use `here->BJTname` strings) — this is purely a
digiTS-side type-shape question, so type-safety of the contract wins.

**Verify:** `npx tsc --noEmit 2>&1 | grep "elementIndex"` returns zero hits.

---

### A.4 — `njfet.ts:855`, `pjfet.ts:815` `_p` field on factory return literal — APPROVED (a)

**Files:** `src/components/semiconductors/njfet.ts` (around the factory return
literal at line 855), `src/components/semiconductors/pjfet.ts` (line 815).

**Action:** widen the typed return to the intersection form already used by
mosfet.ts:851:

```ts
const el: PoolBackedAnalogElement & { readonly _p: ResolvedJfetParams } = {
  // ...factory body...
  get _p(): JfetParams { return params; },
  // ...
};
```

**Why (a) over the alternatives:** uniform with `mosfet.ts:851`. The `_p`
getter is digiTS's surrogate for ngspice's `here->`-style direct access to
resolved-temp params. Closing it to a closure-local would fork the JFET path
away from the MOSFET one for no ngspice-justified reason.

**Verify:** `npx tsc --noEmit 2>&1 | grep "_p.*does not exist"` returns zero.

---

### A.7 — `tapped-transformer.ts` schema overshoots actual state usage — APPROVED (a)

**File:** `src/components/passives/tapped-transformer.ts`.

**Action:**
1. Slim the schema declaration at line 73 to size=0:
   ```ts
   const TAPPED_TRANSFORMER_SCHEMA: StateSchema = defineStateSchema(
     "AnalogTappedTransformerElement", []
   );
   ```
2. Drop the slot constants at lines 79-81 (`SLOT_PHI1`, `SLOT_PHI2`,
   `SLOT_PHI3`).
3. Drop the `_pool!: StatePoolRef` field at line 233 and the assignment in
   `initState` at line 292.
4. The `applyInitialValues` call at line 293 becomes a no-op — remove it.

**Why (a) over implementing the mirror:** ngspice's `mutsetup.c:28` is
`NG_IGNORE(states)` — MUT allocates zero state slots. The composite owns no
state in the ngspice model; the three IND sub-elements own their 2 slots each
(via `mutual-inductor.ts`). Mirroring slot reads through the composite is
non-ngspice-faithful (ngspice never touches state through the MUT). State is
already accessible to harness consumers via the IND sub-elements directly
(`_l1.statePoolForMut`, etc., at `mutual-inductor.ts:229-237`).

**Verify:** `npx tsc --noEmit 2>&1 | grep "tapped-transformer"` returns zero.
Run `src/components/passives/__tests__/tapped-transformer.test.ts` — tests must
still pass (the composite's stateSize derivation will fall through to the
sub-elements naturally).

**Note:** the `tapped-transformer.test.ts` `branch2`/`branch3` TS2339 errors
(lines 535-536) are a separate pre-existing test issue — fix in the same pass
since they sit in the same file.

---

### A.8 — `AnalogTappedTransformerElement.initState(pool)` doesn't propagate to subs — APPROVED (a)

**File:** `src/components/passives/tapped-transformer.ts`.

**Action:** reclassify the class to extend `CompositeElement` (per
`spec/setup-load-cleanup.md` §A.15):

1. Change the declaration from
   `class AnalogTappedTransformerElement implements PoolBackedAnalogElement`
   to `class AnalogTappedTransformerElement extends CompositeElement`.
2. Implement `protected getSubElements(): readonly AnalogElement[]` returning
   `[this._l1, this._l2, this._l3, this._mut12, this._mut13, this._mut23]`.
3. Drop the hand-rolled `setup`, `load`, `initState`, `getLteTimestep`
   overrides — let the base-class forwarders handle them.
4. Keep class-specific implementations of `getPinCurrents`, `setParam`,
   `findBranchFor` (these have transformer-specific logic).
5. Remove the `_pool` field per A.7.

**Why (a) over keeping the override + calling super:** the class is
semantically a composite (six sub-elements, every lifecycle method forwards).
The §A.15 carve-out exempting tapped-transformer was conservative — option (a)
matches ngspice's per-device-walk semantics exactly: each IND/MUT setup is
independent, no parent forwarding step.

**Verify:** `tapped-transformer.test.ts` passes; the runtime crash "Cannot
read properties of undefined (reading 'states')" in `mutual-inductor.ts` is
gone (was caused by missing `initState` propagation to sub-INDs).

---

### A.9 — `PropertyBag.getModelParam` policy — APPROVED (c)

**Files:** every site that uses `getModelParam` or `getOrDefault` for params
that originate from a model card vs an instance overlay. Audit candidates:
`tapped-transformer.ts:344-346`, `potentiometer.ts` (recently migrated by
agent away from `getModelParam`), test fixtures using `replaceModelParams` /
`setModelParam`.

**Action:** preserve the `_mparams`/`_map` partition. Audit each call site:

- If the param comes from `defineModelParams` defaults / model card →
  `props.getModelParam<T>(key)`.
- If it's an instance overlay (label, OFF, AREA, IC) → `props.get<T>(key)` or
  `props.getOrDefault<T>(key, fallback)`.

The runtime error `props.getModelParam is not a function` reported by the
potentiometer agent was a TEST FIXTURE bug (test-built `PropertyBag` without
the `_mparams` partition). Fix is to populate `_mparams` in the fixture via
`replaceModelParams({...})`, NOT to migrate production reads to `getOrDefault`.

**Why (c) over (a) collapse-to-single-read:** ngspice has the model-card-vs-
instance split structurally (`diodefs.h:180-234` separates `model->DIOresist`
from `here->DIOarea`); collapsing to a single `getOrDefault` loses information
that matters when model param resolution semantics diverge from instance
overlay (e.g., temperature-scaling lives on the model card, not the instance).

**Verify:** roll back the potentiometer agent's `getModelParam → getOrDefault`
migration. Targeted test: any test that hot-patches a model param via
`setModelParam` followed by element read — value must propagate.

---

### A.10 — `adc.ts` symbol rename inverts meaning — APPROVED (b)

**Files:** `src/components/active/adc.ts` (and any test imports of `ADCElement`
or `ADCAnalogElement`).

**Action:**
1. Rename the analog simulation class currently named `ADCElement` (the one
   `extends CompositeElement` at line 199) back to `ADCAnalogElement`.
2. Rename the editor circuit class currently named `ADCCircuitElement` back
   to `ADCElement`.
3. Update all internal references and test imports.

**Why (b) over keeping the rename:** the codebase convention everywhere else
is `Foo` for circuit elements and `AnalogFooElement` (or `FooAnalogElement`)
for runtime simulation elements — see `AnalogCapacitorElement`,
`AnalogOpAmpElement`, `AnalogTappedTransformerElement`. The current rename
inverts that convention; option (b) restores uniformity.

**Verify:** `Grep "ADCElement\b" src/` returns only circuit-element imports;
`Grep "ADCAnalogElement\b" src/` returns only analog-simulation imports.

---

### A.11 — `polarized-cap` `_stateBase` runtime crash (×6) — INVESTIGATION REQUIRED

**File:** `src/components/passives/polarized-cap.ts` and any consumer that
constructs / initialises an `AnalogPolarizedCapElement`.

**Symptom:** six runtime traces report `Cannot read properties of undefined`
when `_stateBase` is accessed on a `polarized-cap` instance. The field IS
declared correctly on the production class (`_stateBase: number = -1`), so
something is bypassing the constructor or invoking `initState` before
`setup`.

**Investigation steps:**
1. Reproduce the crash — run the polarized-cap test suite and capture the
   stack trace for each of the six traces.
2. Identify whether the bypass originates in:
   - (a) a test that constructs the element via `Object.create` / spread
     literal / similar bypass-the-factory pattern, OR
   - (b) a consumer holding a stale element reference from before a recompile
     / hot-reload, OR
   - (c) an ordering bug where `initState(pool)` lands before `setup(ctx)`
     (which writes `_stateBase`).
3. Once the bypass type is identified, choose the fix:
   - For (a) — fix the test fixture to use the production factory.
   - For (b) — invalidate stale references via the recompile path or surface
     a clear error when an element is used post-recompile.
   - For (c) — add a defensive `initState` body that throws if `_stateBase`
     is still -1 (so the ordering bug surfaces immediately rather than
     crashing in the middle of a state-pool write).

**Why decision is deferred:** root cause is unknown until step 1 reproduces
the crash. The (a)/(b)/(c) split exists but a clean choice can't be made
without the trace evidence.

**Verify:** all six traces stop firing after the chosen fix lands; targeted
test `polarized-cap.test.ts` passes.

---

### A.12 — `PolarizedCap` 8-arg helper signature drift — DECISION REQUIRED

**Files:** `src/components/passives/polarized-cap.ts` (the helper, likely
`buildAnalogPolarizedCapElement` or similar — confirm by grep);
`src/components/passives/__tests__/polarized-cap.test.ts` (14 TS2554 errors at
call sites passing 5-6 args where 8 are expected).

**Symptom:** wave-time signature change broadened the helper from 5/6 args to
8 args; the test fixtures were authored against the old shape.

**Decision needed:**
- (a) The 8-arg signature is the intended target (the wave change was
  correct) → migrate the 14 test call sites to pass the additional args.
- (b) The 8-arg signature was over-broadened → revert the helper to 5/6 args
  and absorb whatever extra params the wave needed via a different mechanism.

**Investigation steps before decision:**
1. Identify the helper by name. Run
   `Grep "Argument of type.*expected" src/components/passives/__tests__/polarized-cap.test.ts`
   to extract the exact callee.
2. Read the helper's current signature. List the 2-3 new args that were
   added during the wave.
3. Determine whether each new arg is REQUIRED by the production setup path,
   or whether they have sensible defaults that the test fixtures could rely
   on.
4. If all new args have sensible defaults → option (b) flavour: make them
   optional, restore 5/6 as the minimum-call form, tests pass without churn.
5. If any new arg is structurally required → option (a) flavour: tests
   migrate to the 8-arg form.

**Verify:** `npx tsc --noEmit 2>&1 | grep "polarized-cap"` returns zero TS2554
errors. `polarized-cap.test.ts` passes.

---

### A.13 — `spec/setup-load-cleanup.md` §A.16 stale side-note — DOC CLEANUP

**File:** `spec/setup-load-cleanup.md`, section §A.16 (`SetupContext`
interface).

**Symptom:** §A.16 contains a side-note describing tests that call
`solver.beginAssembly(...)` / `solver.endAssembly()` outside the SetupContext
lifecycle. That description is now wrong — the production engine's
`SparseSolver` exposes only `_initStructure()`, and the assembly path goes
through `CKTCircuitContext` constructor.

**Action:**
1. Locate the side-note in §A.16 (search for "beginAssembly" or "endAssembly"
   in `spec/setup-load-cleanup.md`).
2. Delete the side-note paragraph.
3. If any prose around it referenced the old API (`beginAssembly` /
   `endAssembly`), rewrite to point at the current API
   (`_initStructure` / `makeSimpleCtx` / `makeTestSetupContext`).

**Why this is in §A despite being a doc edit:** the wave's convergence pass
explicitly does NOT touch spec files (per `spec/setup-load-cleanup.md`
§A.20 out-of-scope list). This needs a separate edit and someone needs to do
it; the action is mechanical but has to be a deliberate pass.

**Verify:** `Grep "beginAssembly\|endAssembly" spec/setup-load-cleanup.md`
returns zero hits.

---

## B. Latent-stamp-gap items (approved — apply action steps)

### B.1 — `fgnfet.ts` and `fgpfet.ts` DEVqmeyer cap path missing — WITHDRAWN (no defect)

**Files:** `src/components/switching/fgnfet.ts`, `src/components/switching/fgpfet.ts`
(note: actual location is `switching/`, not `semiconductors/` — original spec
path was wrong).

**Investigation outcome:** the items cited as "allocs at lines 91, 93, 542" are
**state-slot index constants** (`MOS_SLOT_QBD = 13`, `MOS_SLOT_CQBD = 14`),
not orphan TSTALLOC matrix handles. Every TSTALLOC handle allocated in setup
(lines 492-513 NFET / 497-518 PFET) IS consumed by stamps in load (lines
913-934 NFET / 857-878 PFET). There is no orphan handle.

The "latent stamp gap" is documented in code comments at `fgnfet.ts:106-111`,
:548-552, :786-803 as **deliberate** — these state slots are reserved for a
future 4-terminal MOS1 expansion. With the digital model parameters this
component uses (`TOX→∞`, `CJ=CBD=CBS=0`, `CGSO=CGDO=CGBO=0`), ngspice's own
`mos1load.c` produces zero contribution from these paths (`capbd=capbs=0`,
overlap caps zero). Porting the stamps now would compute `0 × x` — bit-exact
equal to skipping them.

**Test surface:** no `fgnfet.test.ts` / `fgpfet.test.ts` exists. There is no
failing test, engine crash, or measurable divergence to fix.

**Resolution:** classification withdrawn. The existing `// latent-stamp-gap:`
comments in the code are sufficient documentation for the future 4-terminal
expansion. No action required this batch.

---

### B.2 — `real-opamp.ts:410 stampCond` helper anti-pattern — APPROVED (iii cleanup)

**File:** `src/components/active/real-opamp.ts`.

**Symptom (severity iii):** TSTALLOC migration leftover — the `stampCond`
helper at line 410 allocates fresh handles per invocation. Per
`spec/setup-load-cleanup.md` §A.5/A.9, TSTALLOC handles must be allocated
once in `setup()` and reused inside `load()`.

**Action:** lift the handle allocations from inside `stampCond` up into the
factory's `setup()` body, store as closure-local `let _h... = -1`. Inside
`stampCond` (or its callers), call `solver.stampElement(handle, value)`
directly with the cached handle. This is the standard `§A.13` pattern.

**Verify:** `Grep "allocElement" src/components/active/real-opamp.ts` shows
all calls inside `setup()`, none inside `load()` or downstream helpers.
Existing `real-opamp.test.ts` tests must still pass.

---

### B.3 — `bjt.ts:587` unused `model` local after polarity swap — APPROVED (iii cleanup)

**File:** `src/components/semiconductors/bjt.ts` line 587 (or thereabouts —
search for `const model = ` near the L0/L1 polarity swap block).

**Action:** delete the unused `const model = ...` declaration. Trivial
cleanup — confirm with `Grep "\bmodel\b" bjt.ts` near the line that no
subsequent use exists in the same scope.

---

## C. Deferred audits (next sweep)

The three families below were added during triage but explicitly **deferred
this run**. Each is a (ii)-class numerical concern that may surface
divergences from ngspice once the items above are landed. They feed a future
audit lane — do not investigate as part of this batch.

### C.1 — MOS/JFET `gmin` and `gmin-stepping` paths

**Concern:** ngspice's `cktload.c` adds `CKTgmin` to junction conductances
during MODEDCOP convergence-aid passes. If digiTS's MOS/JFET load() bodies
don't add `ctx.diagonalGmin` to the equivalent diagonals, source-stepping
convergence will diverge from ngspice.

**Audit scope:** grep `diagonalGmin` reads across all junction-bearing devices
(BJT, DIO, JFET, MOSFET, FGNFET, FGPFET, zener, schottky, varactor, triac,
SCR, tunnel, optocoupler). Compare against `cktload.c` gmin stamps.

### C.2 — BJT L1 substrate junction stamps

**Concern:** ngspice's `bjtload.c` has substrate-junction terms (`qcsub`,
`ccsub`) gated on `model.subs`. If `bjt.ts` L1 `load()` doesn't fully stamp
substrate-substrate, the `(sc, substNode)` handles allocated at
`bjt.ts:635-636` may not be fully consumed.

**Audit scope:** trace every TSTALLOC handle allocated in L1 `setup()`
through L1 `load()` and confirm a stamp exists for each. Cross-check against
`bjtload.c:qcsub/ccsub` block.

### C.3 — BJT L1 excess-phase modulation stamps

**Concern:** ngspice gates excess-phase stamps on `model.tFreq > 0`. If L1
allocates the excess-phase state slots but skips the stamps, that's a
(ii)-class bug for high-frequency BJT models.

**Audit scope:** same approach as C.2 — trace L1 excess-phase state slot
writes and reads, confirm each is consumed.

### C.4 — `polarized-cap` clamp-diode `_stateBase` re-partition — RESOLVED

**Surfaced by:** A.11 batch (defensive guard surfaced the underlying ordering issue).

**Resolution:** applied resolution candidate (i):

1. `src/components/semiconductors/diode.ts:556-568` — added idempotency guard
   on `_stateBase` allocation matching the pattern at
   `mutual-inductor.ts:94-95`. When a composite (e.g. polarized-cap)
   pre-partitions `_stateBase` before forwarding `setup()`, the diode now
   skips its own `ctx.allocStates()` call.
2. `src/components/passives/polarized-cap.ts:354-360` — moved the partition
   `this._clampDiode._stateBase = this._stateBase + POLARIZED_CAP_SCHEMA.size`
   into `setup()` (before forwarding to the diode), so the partition is
   established at allocation time rather than at `initState()` time.
3. `polarized-cap.ts:initState()` — removed the now-redundant partition write.
4. `polarized-cap.test.ts:402-429` — removed the now-stale per-step manual
   `_stateBase` patching that compensated for the wasted-slot allocation.

**Result:** 5 of 6 previously failing polarized-cap tests now pass (62 of 63
across polarized-cap and diode). One residual failure remains
(`charges_with_rc_time_constant` — NaN at line 485) which is independent of
state-base partitioning — the per-step transient-loop fixture has a separate
issue (probably state-rotation or rhs-aliasing). Defer to a transient-fixture
audit, not a state-partition concern.

### C.5 — `tapped-transformer` 3 simulation tests fail post-CompositeElement reclassification

**Surfaced by:** A.7+A.8 batch (the runtime crash
`Cannot read properties of undefined (reading 'states')` in
`mutual-inductor.ts` is gone; 14/17 tests now pass).

**Failing:**
- `center_tap_voltage_is_half` — voltage explodes to 1.5e+300
- `symmetric_halves` — secondary half voltages = 0
- `full_wave_rectifier` — diagnostic emits ERROR

These tests were CRASHING before A.7+A.8 (couldn't reach the assertion).
Now they reach the assertion and fail. The defensive baseline is unclear:
the simulation behavior may have been wrong for a long time, masked by the
crash. Investigation is deferred per user instruction (review batch
explicitly carved out numerical-blowup investigation).
