# Spec Review: state-pool-schema.md — Declarative State-Pool Contract

## Verdict: needs-revision

## Tally
| Dimension | Issues |
|-----------|--------|
| Plan coverage gaps | 2 |
| Internal consistency issues | 6 |
| Completeness gaps | 4 |
| Concreteness issues | 5 |
| Implementability concerns | 4 |
| Rule compliance violations | 3 |

---

## Plan Coverage

The plan file (`spec/plan.md`) references `spec/analog-state-pool-and-writeback-removal.md` for all phases — not `spec/state-pool-schema.md`. This spec is a standalone amendment / design contract layered on top of the execution plan. That relationship is not stated in the spec itself.

| Plan Task / Coverage Area | In Spec? | Notes |
|--------------------------|----------|-------|
| W1T1 Create StatePool class | no | Spec defers entirely to `state-pool.ts:1-29` as-is; no new StatePool work specified |
| W1T2 Add stateSize/stateBaseOffset/initState interfaces | partial | §1.3 covers `element.ts` amendment but skips `analog-types.ts` stateSize/initState which already exist at lines 168-180 (no diff needed) |
| W1T3 Compiler allocation loop | no | §2 references `compiler.ts:1332` as existing; no change to compiler is prescribed |
| W1T4 StatePool unit tests | no | Not addressed in this spec |
| W2T1–W3T9 Device migrations | partial | §4.2 slot catalogue and §5.1 wave ordering cover the devices, but scope differs — this spec adds schema layer on top; relationship to the migration tasks is unstated |
| W4T1 AbstractFetElement migration | yes | §5.3 covers this |
| W5T1–W5T2 Capacitor/Inductor | yes | §5.1 Wave B covers these |
| W6T1 Engine integration | no | Out of scope per §0 preamble; but Wave A tasks touch `analog-engine.ts` |

**Gap 1:** The spec's relationship to `spec/analog-state-pool-and-writeback-removal.md` is not declared. Is this an amendment that layers on top of that spec, a replacement for some phases, or a standalone contract? An executor reading only this spec cannot know whether to consult the other spec or ignore it. The preamble should state: "This spec amends/replaces [phases X-Y of] `spec/analog-state-pool-and-writeback-removal.md`."

**Gap 2:** The plan's W6T3 (`Make voltages param Readonly<Float64Array>`) is not mentioned anywhere in this spec. It is unclear whether this spec supersedes or ignores that task.

---

## Internal Consistency Issues

### Issue 1: Rollback line-number references are wrong (§1.2, §2, §6.1)

The spec repeatedly references `analog-engine.ts:297-302` and `analog-engine.ts:369-371` as "rollback paths." Verified in source:

- Lines 297-308 are the `newtonRaphson({...})` call — NOT a rollback.
- The actual NR-failure rollback is at lines **286-287**: `statePool.state0.set(this._stateCheckpoint)`.
- Lines 369-371 are `stampCompanion(lteRetryDt, ...)` — NOT a rollback.
- The actual LTE-rejection rollback is at lines **355-356**: `statePool.state0.set(this._stateCheckpoint)`.

The spec also references `analog-engine.ts:248-254` as "step-top checkpoint." Verified: checkpoint is `this._stateCheckpoint.set(statePool.state0)` at line 251 — close enough (within the range), but the description says "checkpoint" while the spec's References section says `_stateCheckpoint.set(statePool.state0)`. Checkpoint write is correct; the rollback line numbers are wrong.

This is a concreteness and consistency issue: executors reading line 297 will not find rollback code and may conclude the rollback mechanism has changed.

### Issue 2: `element.ts:235-248` amendment target is wrong (§1.3)

The spec says "Replace the `stateSize` / `initState` JSDoc at `element.ts:235-248`." Verified: `element.ts:235` is inside the `isReactive` field documentation (line 234 is `readonly isReactive: boolean`). The `stateSize` field is at **line 256-259** and `initState` is at **lines 177-180** (already in `analog-types.ts`) or at `element.ts:266-269`. The spec's target range `235-248` contains `isReactive`, `getPinCurrents`, and `label` — none of which are `stateSize`/`initState`.

Furthermore, the amendment spec proposes adding `stateSchema?: StateSchema` to `AnalogElementCore`. But `AnalogElementCore` is defined in `src/core/analog-types.ts` (confirmed at lines 83-196), NOT in `element.ts`. The executor would add the field to the wrong file.

### Issue 3: `analog-types.ts:196` AnalogElementCore closing brace (§1.3)

The spec says to add `ReactiveAnalogElement` "immediately after the closing `}` of `AnalogElementCore` (which ends at `analog-types.ts:196`)." Verified: `AnalogElementCore` closes at line **196** in `analog-types.ts` — this is accurate. However, the spec instructs modification of `analog-types.ts` for `ReactiveAnalogElement` but §1.3's heading says "Amendment to `AnalogElement` in `src/solver/analog/element.ts`". The two files are conflated in a single section with no clear delineation of which edit goes to which file.

### Issue 4: Wave B vs. Wave E duplication for capacitor/inductor (§5.1)

Wave B (steps 5-6) says: "`capacitor.ts` — adopt schema (section 1.4)" and "`inductor.ts`, `coupled-inductor.ts` — adopt schema."

Wave E (steps 15-16) says: "`capacitor.ts` — 6 slots, all `{ kind: 'zero' }`: `GEQ`, `IEQ`, `V_PREV`, `I_PREV`, `I_PREV_PREV`, `V_PREV_PREV`" and "`inductor.ts` — 4 slots."

This is ambiguous: does Wave B fully adopt the schema including slot declarations, or does Wave B do a partial adoption that Wave E completes? The spec says Wave E "retrofits `stateSchema` declarations onto all pool-compliant reactive elements" including capacitor/inductor, which Wave B was supposed to already have done. An executor cannot determine whether Wave E steps 15-16 are redundant, corrective, or additive.

### Issue 5: Diode stateSize stated as both 7 and 8 (§4.2 vs. §5.1)

In §4.2 (slot catalogue): "current stateSize `hasCapacitance ? 7 : 4` at `diode.ts:161`. ... New stateSize: 4 (resistive) or **8** (capacitive)."

Verified at `diode.ts:161`: `stateSize: hasCapacitance ? 7 : 4` — current is 7 capacitive. The spec correctly proposes changing to 8.

But in §5.1 Wave E step 20: "`diode.ts` — 4 or 8 slots per Amendment E2 (see §4.2)." This is consistent with §4.2. However, the diode's `initState` at `diode.ts:167` currently seeds `s0[base + SLOT_GEQ] = GMIN` — the spec does not address what happens to this existing seed when the schema takes over. The `SLOT_GEQ` seed (`GMIN`, not zero) is a `fromParams`-like constant init that §4.2's slot list does not capture. This is a completeness gap (addressed below), but also an internal consistency issue: the slot catalogue for diode declares `SLOT_GEQ` with no explicit init kind, while the existing `initState` sets it to `GMIN`.

### Issue 6: JFET base+extension composition — spec says 25+3=28 but slot numbering is unclear (§4.2, §5.3)

§4.2 says "Total JFET instance slots: 28 (base 25 + extension 3). MOSFET instances stay at 25 slots."

§5.3 (MOSFET follow-up paragraph): "In Wave C step 13, `AnalogJfetElement` declares a separate 3-slot extension schema (`VGS_JUNCTION`, `GD_JUNCTION`, `ID_JUNCTION`) and its total stateSize is 28 (base 25 + extension 3) composed via `[...BASE_SLOTS, ...JFET_EXTENSION_SLOTS]`."

The composition method is `defineStateSchema(owner, [...BASE_SLOTS, ...JFET_EXTENSION_SLOTS])`. This means the JFET declares a **single flat 28-slot schema** at the JFET class level. The spec says "AbstractFetElement keeps its 25-slot base schema unchanged" — but if JFET has its own 28-slot schema, there is no shared `FET_BASE_SCHEMA` between MOSFET and JFET. The spec does not resolve: does `FET_BASE_SCHEMA` exist as a shared constant that JFET extends by spreading, or does each class declare its own full schema? If MOSFET declares `FET_BASE_SCHEMA` with 25 slots and JFET spreads it into a 28-slot schema, the two schemas are independent objects with duplicate slot descriptors — which is fine at runtime but wastes definitions. If `FET_BASE_SCHEMA` is not exported, JFET cannot spread it. The spec is silent on the export status of `FET_BASE_SCHEMA`.

---

## Completeness Gaps

### Gap 1: Wave A task 4 (`_elements` promotion) — no before/after code (§5.1)

Wave A task 4 says: "Promote `elements` from a local destructured `const` (at `analog-engine.ts:173`) to an instance field `this._elements`." Verified: `analog-engine.ts:173` has `const cac = compiled as CompiledWithBridges` — NOT an `elements` destructure. The elements destructure is at `analog-engine.ts:243`: `const { elements, matrixSize, nodeCount } = this._compiled`. This is inside the `step()` method, not `init()`. The spec's line reference is wrong AND the mechanical change (promoting a `step()`-local variable to an instance field that persists across calls) is significantly more complex than the spec describes — the executor needs to know which method the promotion happens in, what type the field is, and whether it stays in sync across recompile events.

### Gap 2: No test for `ReactiveAnalogElement` discriminant narrowing (§1.3)

The spec mandates `readonly isReactive: true` as a discriminant for `ReactiveAnalogElement`. There is no test asserting that the TypeScript type narrowing actually works. Since this is a TypeScript interface (not enforced at runtime), the spec should include at minimum a compile-time test (e.g., a `.test-d.ts` file using `expectType`) or an explicit note that no test is needed because it is purely type-level. Per the Three-Surface Testing Rule, new interfaces must be tested.

### Gap 3: Diode `SLOT_GEQ` init value is unspecified in schema (§4.2)

The existing `diode.ts:167` seeds `s0[base + SLOT_GEQ] = GMIN`. The §4.2 slot catalogue for diode lists slots 0-3 as `SLOT_VD, SLOT_GEQ, SLOT_IEQ, SLOT_ID` but provides no `init` kind for any of them. The slot catalogue table only lists names, not init values. `SLOT_GEQ` must be `{ kind: "constant", value: GMIN }` to preserve existing behavior — but the spec does not say this. An executor following §4.2 verbatim would use `{ kind: "zero" }` for `SLOT_GEQ`, changing behavior (GMIN → 0.0 initial conductance).

### Gap 4: `coupled-inductor.ts` migration — deferred decision inside Wave B (§4.2, §5.1)

Wave B step 6 lists "`inductor.ts`, `coupled-inductor.ts` — adopt schema." But §4.2 says: "Executor: before migrating transformer, read `coupled-inductor.ts` to determine whether `CoupledInductorState` is a Float64Array view into a pool (good) or plain numeric fields (also a violation that must be migrated together)." This deferral applies to Wave C (transformer), but `coupled-inductor.ts` is already scheduled in Wave B. If `CoupledInductorState` contains mutable numeric fields (likely, given §4.2 describes it as holding "4 current + 4 voltage history"), Wave B must either migrate it or skip it. The spec does not resolve this conflict: it is impossible to migrate transformer correctly in Wave C if `coupled-inductor.ts` was only partially migrated in Wave B.

---

## Concreteness Issues

### Issue 1: `SlotIndex<'GEQ'>` brand referenced but never defined (§1.1, spec intro)

§1.1 says: "A **typed index brand** (`SlotIndex<'GEQ'>`) that prevents cross-element slot mixups at compile time." However, `SlotIndex` appears nowhere in the `state-schema.ts` code in §1.2, nowhere in the codebase (verified via grep), and nowhere else in the spec. The `defineStateSchema` signature uses `S[number]["name"]` for `Names extends string`, but the actual slot access constants (`const SLOT_GEQ = 0`) remain plain `number`. There is no branded index type in the spec's code. The claim in §1.1 is made as a design feature but is not implemented in the §1.2 code. An executor reading §1.1 would expect to find `SlotIndex<'GEQ'>` in the new file and would be confused when it is absent.

### Issue 2: Dev probe invocation location is internally contradictory (§3, §5.1 Wave A)

§3 says the probe runs at "the first `MNAEngine.step()` call, controlled by a one-shot `_devProbeRan` boolean flag on the engine." But §3 also says: "Emit a compiler diagnostic with code `reactive-state-outside-pool`, severity `error`." Compiler diagnostics come from the compile phase, not the step phase. The spec does not say how a violation emitted during `step()` surfaces as a compile diagnostic. The `_diagnostics` object on MNAEngine is a `DiagnosticsAccumulator` — not the compiler's diagnostic list. The executor would not know whether to emit via `this._diagnostics.push(...)` or to throw an Error or to log to console.

### Issue 3: `assertPoolIsSoleMutableState` Float64Array comment is incomplete (§1.2)

The probe implementation in §1.2 has this comment:
```
// Float64Array instance identity is fine; contents changing inside s0 is legal
// because s0 IS the pool. We only flag *other* Float64Arrays mutating.
```
But the `snapshotOwnFields` function only snapshots `typeof v === "number"` scalars — it explicitly does NOT snapshot Float64Arrays at all. So the comment about "other Float64Arrays mutating" is misleading: the probe will NOT detect a rogue `Float64Array` field that mutates. If an element has `private _scratch: Float64Array` outside the pool that it mutates in `stampCompanion`, the probe will miss it entirely. The spec claims the probe "enforces that all mutable numeric state lives inside the pool" but it can only enforce scalar numeric fields, not array fields.

### Issue 4: `transmission-line.ts` sub-element line numbers are approximate (§4.2)

The spec uses "~lines 294-296", "~lines 357-359", "~lines 413-415", "~lines 221-223" with a tilde prefix explicitly marking them as approximate. For a spec that claims to be "ready for executor hand-off," approximate line numbers in a 200-line migration task are insufficient. An executor must read the file first anyway — the spec should either give exact line numbers or omit them and describe what to search for instead.

### Issue 5: `transformer.ts` migration has an open prerequisite inside the spec (§4.2)

The spec says: "Executor: before migrating transformer, read `coupled-inductor.ts` to determine whether `CoupledInductorState` is a Float64Array view into a pool (good) or plain numeric fields." This is an explicit "you might find something that changes the slot count" caveat embedded in a spec that claims to be final. The 13-slot count for `transformer.ts` depends on the answer to this question. If `CoupledInductorState` already uses Float64Array pool views, the slot count changes. A final spec must resolve this, not delegate the discovery to the executor.

---

## Implementability Concerns

### Concern 1: Wave A task 4 `elements` promotion will break recompile handling

The spec says to promote `elements` from a local `const` to `this._elements`. In the actual source, `elements` is destructured from `this._compiled` in the `step()` method (`analog-engine.ts:243`). Making it an instance field requires:
1. Removing the destructure from `step()`.
2. Adding `this._elements: readonly AnalogElementCore[]` field declaration.
3. Populating it in `init()` (not just in `step()`).
4. Handling recompile: when `init()` is called again with a new circuit, `_elements` must be updated.
5. Handling `dispose()`: field must be cleared.

The spec says only "promote to an instance field" — it does not address steps 3-5. This is a non-trivial refactor that could introduce a stale-elements bug on recompile.

### Concern 2: `fromParams` BJT warm-start uses closure variable, not params record (§5.1 Wave E)

§5.1 Wave E BJT entry says: "The `fromParams` compute function must reference the closure `polarity` variable directly: `{ kind: 'fromParams', compute: (_params) => polarity === 1 ? 0.6 : -0.6 }`."

But `SlotInit.fromParams` is declared in §1.2 as `compute: (params: Readonly<Record<string, number>>) => number`. The `fromParams` kind is designed for cases where the init depends on the element's `params` record — but here the spec says to ignore `_params` and close over an external variable instead. This is a misuse of the `fromParams` kind. It will work, but it means `applyInitialValues` (which passes the params record to `compute`) becomes irrelevant for this slot. An executor might reasonably ask: "should I add `polarity` to the params record instead?" The spec should clarify or use `{ kind: 'constant', value: polarity === 1 ? 0.6 : -0.6 }` evaluated at schema declaration time (which is also closure-captured but cleaner).

### Concern 3: Three-Surface Testing Rule is violated (§5.2)

`CLAUDE.md` mandates: "Every user-facing feature MUST be tested across all three surfaces: headless API test, MCP tool test, E2E/UI test."

§5.2 specifies only unit tests (`<element>.rollback.test.ts`). The state-pool rollback mechanism is part of simulation correctness — a user running a transient simulation with reactive elements is the user-facing surface. The spec has no MCP-level test and no E2E/Playwright test for rollback behavior. The spec's justification ("all those test files are modified") refers to pre-existing tests, not new surface coverage for the rollback feature.

### Concern 4: No-shims rule may be violated by static alias retention (§5.3, rules.md)

§5.3 says: "the static class constants remain in place as backward-compatible aliases."

`rules.md` states: "No fallbacks. No backwards compatibility shims. No safety wrappers." and "All replaced or edited code is removed entirely. Scorched earth."

Retaining `static readonly SLOT_VGS = SLOT_VGS` etc. (lines 107-131 of `fet-base.ts`) as "backward-compatible aliases" after the module-scope `const SLOT_*` constants and schema are the new source of truth is a compatibility shim. If `mosfet.ts` uses `AbstractFetElement.SLOT_CAP_GEQ_DB`, the spec should instead update those call sites to use the module-scope constant or the schema's `indexOf` map — not keep the statics as aliases. The spec explicitly calls them "backward-compatible aliases," which matches the pattern rules.md bans.

---

## Verified Claims

The following spec claims were confirmed accurate against the source:

1. **`fet-base.ts:166`** — `protected get _vgs(): number { return this._s0[this.stateBaseOffset + SLOT_VGS]; }` — VERIFIED.
2. **`bjt.ts:713-774`** — Slot layout starts at 713 (`L1_SLOT_VBE = 0`), `L1_SLOT_RB_EFF = 10` at line 724, `L1_SLOT_CAP_FIRST_CALL = 23` at line 738, `initState` runs through line 774 — VERIFIED.
3. **`capacitor.ts:155`** — `readonly stateSize: number = 6` — VERIFIED.
4. **`compiler.ts:1332`** — `if (element.initState) element.initState(statePool)` — VERIFIED.
5. **`analog-engine.ts:186`** — `el.initState?.(cac.statePool)` — VERIFIED.
6. **`polarized-cap.ts:208`** — class exists at line 208, has no `stateSize`/`stateBaseOffset`/`initState` — VERIFIED.
7. **`polarized-cap.ts:221-223`** — `private geq: number = 0`, `private ieq: number = 0`, `private vPrev: number = 0` — VERIFIED.
8. **`diode.ts:155`** — `let capFirstCall = true` — VERIFIED.
9. **`diode.ts:161`** — `stateSize: hasCapacitance ? 7 : 4` — VERIFIED.
10. **`njfet.ts:118-120`** — `_vgs_junction`, `_gd_junction`, `_id_junction` instance fields — VERIFIED.
11. **`analog-types.ts:196`** — `AnalogElementCore` closes at line 196 — VERIFIED.
12. **`analog-engine.ts:203`** — `cac.statePool.reset()` in `reset()` — VERIFIED (no re-init after reset, gap is real).
13. **`analog-engine.ts:251`** — checkpoint write `this._stateCheckpoint.set(statePool.state0)` — VERIFIED.
14. **`analog-engine.ts:287`** — actual NR-failure rollback site — VERIFIED (spec cites wrong lines 297-302).
15. **`capacitor.ts:134`** — spec says "Replace `capacitor.ts:134-264`"; line 134 begins a comment block, class begins at 150 — range is approximately correct.

---

## Unverified Claims

1. **`analog-engine.ts:175-188`** as "init-time `initState` binding loop" — The actual init loop is at lines 174-188. Close but the reference in §6 References says "175-187" while source shows the loop body is 174-189. Minor.
2. **`bjt.ts:770`** as "`L1_SLOT_RB_EFF = params.RB`** — verified at line 770: `s0[base + L1_SLOT_RB_EFF] = params.RB` — ACCURATE.
3. **`fet-base.ts:148-149`** as `GM/GDS = 1e-12` — verified at lines 148-149: `GM = 1e-12` and `GDS = 1e-12` — ACCURATE.
4. **`bjt.ts:773`** as `CAP_FIRST_CALL = 1.0` — verified at line 773: `s0[base + L1_SLOT_CAP_FIRST_CALL] = 1.0` — ACCURATE.
5. **`mosfet.ts:758`** as `updateOperatingPoint` — verified: method starts at line 758 — ACCURATE.
6. **`mosfet.ts:775`** as "first use of `_vgs`" — verified at line 775: `const limited = limitVoltages(this._vgs, ...)` — ACCURATE.
7. **`crystal.ts:210-224`** as "9 mutable fields" — not verified (file not read); spec claim is unconfirmed.
8. **`transformer.ts:200-211`** as "5 companion fields" — not verified; unconfirmed.
9. **`tapped-transformer.ts:215-235`** slot count — not verified; unconfirmed.
10. **`transmission-line.ts:285-464`** sub-element classes — not verified; unconfirmed.
11. **`bjt.ts:376-377`** as polarity parameter location — not verified.

---

## Critical Issues (Blocking)

### B1: Wrong rollback line numbers throughout (§2, §1.2, §6.1 references)

The spec cites `analog-engine.ts:297-302` and `369-371` as "rollback paths." These are wrong. Actual rollbacks are at lines 286-287 and 355-356. Every mention of these line numbers must be corrected before executor hand-off or executors will waste time on wrong lines.

### B2: `element.ts:235-248` amendment targets the wrong lines / wrong file (§1.3)

The spec tells executors to replace `element.ts:235-248` for `stateSize`/`initState`. That range contains `isReactive`, `getPinCurrents`, and `label` — not `stateSize`/`initState`. Additionally, `AnalogElementCore` lives in `analog-types.ts`, not `element.ts`. The executor would modify the wrong file.

### B3: `SlotIndex<'GEQ'>` brand is promised in §1.1 but absent from §1.2 code (§1.1)

The design summary in §1.1 calls `SlotIndex<'GEQ'>` a core feature. The `state-schema.ts` code in §1.2 contains no such type. An executor producing the file verbatim from §1.2 will not have this feature. Either §1.1 must remove the claim or §1.2 must add the type.

### B4: `coupled-inductor.ts` migration is open-ended inside Wave B (§4.2, §5.1)

Wave B commits `coupled-inductor.ts` to schema adoption. §4.2 tells the executor to read the file first to determine the migration approach for transformer (Wave C). If `CoupledInductorState` contains mutable fields, Wave B is incomplete as written. The spec must resolve `CoupledInductorState`'s structure before marking this as ready for execution.

### B5: No-shims rule violation — static slot aliases as "backward-compatible aliases" (§5.3, rules.md)

The spec explicitly instructs keeping `static readonly SLOT_*` constants as "backward-compatible aliases" after the schema migration. `rules.md` bans this pattern ("No backwards compatibility shims. Scorched earth."). The spec must instead specify updating all `mosfet.ts` call sites that use `AbstractFetElement.SLOT_*` constants to use the module-scope constants directly.

### B6: Three-Surface Testing Rule violated — no MCP or E2E tests for rollback (§5.2, CLAUDE.md)

`CLAUDE.md` mandates testing across all three surfaces. §5.2 specifies only unit tests. The rollback behavior is a user-facing simulation correctness feature. MCP-level and E2E-level tests must be specified.

---

## Quality Issues (Non-Blocking)

### Q1: `assertPoolIsSoleMutableState` cannot detect rogue Float64Array fields (§1.2, §3)

The probe's `snapshotOwnFields` only captures scalar `number` fields. It cannot detect `private _scratch: Float64Array` mutating outside the pool. The spec claims it "enforces that all mutable numeric state lives inside the pool" — this overstatement should be corrected to "enforces that all mutable scalar numeric fields live inside the pool."

### Q2: `fromParams` misuse for BJT warm-start (§5.1 Wave E)

Using `{ kind: "fromParams", compute: (_params) => polarity === 1 ? 0.6 : -0.6 }` ignores the `params` argument and closes over an external variable. This is semantically incorrect usage of the `fromParams` kind. Use `{ kind: "constant", value: polarity === 1 ? 0.6 : -0.6 }` evaluated at schema-construction time instead.

### Q3: Wave B vs. Wave E duplication for capacitor/inductor is not explained (§5.1)

Wave B says "adopt schema" for capacitor/inductor. Wave E also lists them with full slot declarations. The spec should either clarify that Wave E's entries are redundant checks, or that Wave B does structural adoption only and Wave E adds the explicit `init` kinds.

### Q4: Dev probe diagnostic emission mechanism is unspecified (§3)

The spec says "emit a compiler diagnostic with code `reactive-state-outside-pool`" but the probe runs during `step()`, where only `MNAEngine._diagnostics` is available — not the compiler's diagnostic list. The spec must specify the emission mechanism (e.g., `this._diagnostics.push({ code: 'reactive-state-outside-pool', ... })`).

### Q5: `_elements` promotion Wave A task scope is understated (§5.1)

"Promote `elements` from a local destructured `const`" does not convey that this requires changing the field's lifecycle across `init()`, `step()`, and recompile. The spec should describe the full change: add field declaration, populate in `init()`, clear in `dispose()`.

### Q6: `digital-pin-model.ts` and behavioral flipflop action items use banned comment pattern (§6.1)

The spec says: "add a comment block at the field declaration sites (lines 62-63 and 274-275) explaining the exemption." `rules.md` bans comments that "describe what was changed, what was removed, or historical behaviour." An exemption comment explaining "this field is carved out because..." is a historical/provenance comment. The spec should not mandate adding it, or should frame it as a pure-logic explanation that stands without historical context.
