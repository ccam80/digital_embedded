# Spec Review: Phase A — ngspice Netlist Generator Architectural Cleanup

**Phase ID**: A (single-spec; not phase-decomposed)
**Spec file**: `spec/ngspice-netlist-generator-architecture.md`
**Reviewed**: 2026-04-26

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 2 | 2 |
| major    | 3 | 5 | 8 |
| minor    | 4 | 2 | 6 |
| info     | 2 | 1 | 3 |

## Plan Coverage

There is no `spec/plan.md`. §7 "Execution Order" is treated as the plan substitute.

| §7 Step | In Spec? | Notes |
|---------|----------|-------|
| Step 1 — Extend type system (`registry.ts`, `model-params.ts`) | yes | §2.1, §2.2, §3.1 steps 1-2 |
| Step 2 — Migrate per-param fields on every component schema | yes | §3.1-3.3, §4 file table |
| Step 3a — Split Diode/TunnelDiode schemas | yes | §3.4 |
| Step 3b — BJT topology as model variants | yes | §3.5 |
| Step 4 — Rewrite the generator | yes | §2.3, §4 |
| Step 5 — Verify ngspice parity | yes | §7 Step 5 |
| Step 6 — Mark predecessor doc resolved | yes | §7 Step 6 |
| Model-swap rebuild path verification (Step 3b, migration step 5) | partial | Spec mandates the check but provides no fallback plan if the path is absent — see D3 |
| NSUB/NSS schema cleanup (§3.7b deferred) | no | Explicitly deferred — see D1 |

---

## Code-Grounded Reference Verification

The following claimed line numbers were verified against the current source:

| Spec Claim | Actual Location | Status |
|---|---|---|
| `netlist-generator.ts:46-152` — `DEVICE_NETLIST_RULES` | Lines 46–152 ✓ | Correct |
| `bjt.ts:175` — SUBS in NPN instance group | Line 175 ✓ (`SUBS: { default: 1, … }`) | Correct |
| `bjt.ts:237` — SUBS in PNP instance group | Line 237 ✓ | Correct |
| `bjt.ts:1046` — `SUBS: props.getModelParam<number>("SUBS")` | Line 1046 ✓ | Correct |
| `bjt.ts:1142` — `const isLateral = params.SUBS === 0` | Line 1142 ✓ | Correct |
| `mosfet.ts:174-176` — ICVDS/ICVGS/ICVBS | Lines 174–176 ✓ | Correct |
| `mosfet.ts:279-281` — PMOS IC params | Lines 279–281 ✓ | Correct |
| `diode.ts:104-140` — `DIODE_PARAM_DEFS` | Lines 104–140 ✓; IBEQ at :130, IBSW at :131, NB at :132 | Correct |
| `diode.ts:411-414` — runtime tunnel reads | Lines 411–415 ✓ (IBEQ :412, IBSW :413, NB :414, TEMP :415) | Off by one: spec says "411-414" but the block spans :411-415 (TEMP is line 415). Minor. |
| `tunnel-diode.ts:77-96` — `TUNNEL_DIODE_PARAM_DEFS` | Lines 77–96 ✓ | Correct |
| `tunnel-diode.ts:524-532` — TunnelDiodeDefinition.modelRegistry | Lines 524–532 ✓ (behavioral entry at :524-530) | Correct |
| `model-params.ts:4-49` — `defineModelParams` | Lines 4–49 ✓ | Correct |
| `registry.ts:33-52` — `ParamDef` | Lines 33–52 ✓ | Correct |
| `registry.ts:58-75` — `ModelEntry` | Lines 58–75 ✓ | Correct |
| BJT L1 factory is a plain function, not already curried | `createSpiceL1BjtElement(polarity, pinNodes, …)` at line 982 — takes `polarity: 1 | -1` as first arg, NOT an `AnalogFactory` directly. Registered via inline arrow: `(pinNodes, internalNodeIds, branchIdx, props, _getTime) => createSpiceL1BjtElement(1, …)` | **Critical discrepancy — see M1** |
| BJT model-registry key is `"spice-l1"` | Actual key is `"spice"` (line 2177); `defaultModel: "spice"` (line 2223). Not `"spice-l1"`. | **Major discrepancy — see M2** |
| `bjt.ts:78` — OFF in BJT instance group | Line 78 ✓ (BJT simple NPN) | Correct |
| `bjt.ts:107` — OFF in BJT simple PNP | Line 107 ✓ | Correct |
| `bjt.ts:172` — OFF in L1 NPN instance | Line 172 ✓ | Correct |
| `bjt.ts:234` — OFF in L1 PNP instance | Line 234 ✓ | Correct |
| `DIODE_PARAM_DEFAULTS` consumers (3: optocoupler, polarized-cap, varactor) | Grep found 4 additional files: `dcop-init-jct.test.ts`, `phase-3-xfact-predictor.test.ts`, `tunnel-diode.ts`, `diode.ts` itself — the test files are consumers too | **Minor discrepancy — see M3** |
| `IBEQ/IBSW/NB` absent from optocoupler, polarized-cap, varactor | Confirmed by Grep — none of those three reference tunnel params | Correct |
| NJFET/PJFET OFF declaration | `njfet.ts` instance group has `OFF` at line 91 (per Grep) | Correct; spec §3.2 step 5 says "jfet.ts" — actual files are `njfet.ts` and `pjfet.ts` (no single `jfet.ts`) | **Minor discrepancy — see M4** |

---

## Findings

### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | major | §3.5 "The current BJT L1 factory…" paragraph; §4 file table row for `bjt.ts` | Spec says "The factory is **not** currently curried — it is a plain function reference passed directly into `modelRegistry["spice-l1"].factory`." In reality the factory IS already partially applied: it is registered via an inline arrow `(pinNodes, internalNodeIds, branchIdx, props, _getTime) => createSpiceL1BjtElement(1, pinNodes, internalNodeIds, branchIdx, props)` where polarity is closed over in the arrow. The factory-of-factory migration still makes sense, but the description of the starting state is wrong — there is already partial application (via arrow closure) at the modelRegistry callsite. | Replace the quoted paragraph with: "The factory is currently registered via an inline arrow at the `modelRegistry` callsite that closes over the `polarity` constant. The migration converts `createSpiceL1BjtElement` from a function taking `(polarity, pinNodes, …)` to a factory-of-factory `createBjtL1Element(isLateral: boolean): AnalogFactory` that closes over `isLateral` instead of polarity. The polarity is already a closure constant; `isLateral` joins it." |
| M2 | major | §3.5 migration steps (steps 1-7), §4 file table (`bjt.ts` row), §7 Step 3b, §1 "DEVICE_NETLIST_RULES" table row #6, §3.5 "Proposed declarative form" code sketch | Spec repeatedly refers to the existing BJT L1 model-registry key as `"spice-l1"` (e.g. "for each existing `spice-l1` entry", "change `factory: createBjtL1Element` … to `factory: createBjtL1Element(false)`", "add a parallel `spice-l1-lateral` entry"). The actual key in `bjt.ts:2177` and `bjt.ts:2247` is `"spice"`, not `"spice-l1"`. `defaultModel` is `"spice"` (line 2223). The new lateral entry would therefore be `"spice-lateral"` (or whatever name is chosen), not `"spice-l1-lateral"`. Every test assertion and code sketch citing `"spice-l1"` will be wrong. | Replace every occurrence of `"spice-l1"` (when referring to the existing key) with `"spice"`. Replace every occurrence of `"spice-l1-lateral"` with `"spice-lateral"` (or whichever lateral key is chosen — that choice is D5). Replace the defaultModel assertions: "confirm `defaultModel` stays `"spice-l1"`" → "confirm `defaultModel` stays `"spice"`". |
| M3 | minor | §3.4 step 6, blast-radius audit paragraph: "Grep already confirms three: `optocoupler.ts:134`, `polarized-cap.ts:250`, `varactor.ts:56-72`" | The actual grep for `DIODE_PARAM_DEFAULTS` finds 9 files, not 3. The test files `dcop-init-jct.test.ts` and `phase-3-xfact-predictor.test.ts` also import it, as do `tunnel-diode.ts` and `diode.ts` itself. The claim "Grep already confirms three" is incomplete. The spec's conclusion (none reference IBEQ/IBSW/NB) still holds for production code, but the audit language misleads the implementer into thinking only 3 files need checking. | Replace "Grep already confirms three: `optocoupler.ts:134`, `polarized-cap.ts:250`, `varactor.ts:56-72`" with "Grep finds production consumers: `optocoupler.ts`, `polarized-cap.ts`, `varactor.ts`. Test files (`dcop-init-jct.test.ts`, `phase-3-xfact-predictor.test.ts`) also import `DIODE_PARAM_DEFAULTS`; confirm these test files do not reference `IBEQ`/`IBSW`/`NB` before merging step 3a." |
| M4 | minor | §3.2 step 5 and §4 file table: "`src/components/semiconductors/jfet.ts` (or wherever NJFET/PJFET live)" | The repo has `njfet.ts` and `pjfet.ts` — there is no `jfet.ts`. The spec's parenthetical "or wherever NJFET/PJFET live" hedges correctly, but the primary file path `jfet.ts` is wrong and will confuse any file-search step. | In §3.2 step 5 and §4 file table, replace `src/components/semiconductors/jfet.ts` with `src/components/semiconductors/njfet.ts` and `src/components/semiconductors/pjfet.ts` (two separate files). |

---

### Decision-Required Items

#### D1 — Dead-code guard `if (false && ...)` in §3.4 step 2 contradicts "No Pragmatic Patches" (critical)

- **Location**: §3.4 migration step 2, paragraph beginning "Edit `src/components/semiconductors/diode.ts:411-414`…"
- **Problem**: The spec says: "Cleanest: hoist the tunnel block into a separate function and only call it from TunnelDiode's load path. **Phase 1 of execution can leave this as a `if (false)` guard and Phase 2 can extract.**"
  The spec literally proposes committing `if (false && params.IBSW > 0)` as an interim state, then cleaning it up in "Phase 2." This is dead code protected by a compiler-visible constant-false guard. CLAUDE.md `rules.md` states: "No commented-out code. No `# previously this was...` comments." and treats such patterns as dead-code markers requiring immediate deletion. An `if (false)` guard is semantically identical to commented-out code. CLAUDE.md "No Pragmatic Patches" bars "deferred" solutions. The spec itself acknowledges the pattern is not clean ("but that is dead code").
- **Why decision-required**: The spec author raised two sub-options (the `if (false)` guard vs. hoisting to a separate function), said the hoist is cleanest, then proposed doing the dead-code guard first "in Phase 1". Whether the intermediate dead-code state is acceptable depends on whether the user accepts this as a deliberate multi-step execution plan or views it as a CLAUDE.md violation.
- **Options**:
  - **Option A — Delete the `if (false)` option entirely**: Remove the intermediate-state allowance from step 2. Mandate that Step 3a lands the full hoist (tunnel block moved to a `diodeLoadTunnel()` helper called only from TunnelDiode's load path) with no dead-code interim. Step 3a becomes slightly larger but is clean on merge.
    - Pros: Consistent with CLAUDE.md rules. No dead code at any commit boundary. A reviewer can verify the spec on each step independently.
    - Cons: Step 3a becomes the only place this hoist lands, which is more work than the spec currently assigns to it. May force the implementer to trace TunnelDiode's load path (which re-uses `createDiodeElement`) more carefully.
  - **Option B — Keep the two-phase structure but ban the `if (false)` guard**: Step 3a removes the three tunnel reads from `createDiodeElement`'s params object (lines 411–415) and guards the tunnel block with a schema-level check (`if (props.hasModelParam("IBEQ"))`) that evaluates to false for plain Diode after the schema split. Step 3b (or a renumbered Step 3c) extracts the tunnel block. No `if (false)` is ever committed.
    - Pros: Preserves the two-step structure. No literal dead code.
    - Cons: `if (props.hasModelParam("IBEQ"))` is a runtime check, not schema-enforcement — an implementer could still set the param on a plain Diode object, just not via `defineModelParams`. Slightly more complexity in the interim state.
  - **Option C — Declare step 3a lands the full separation in one commit**: Move the tunnel block extraction into step 3a as a required sub-task (not deferred). The tunnel block in `diode.ts:load()` is extracted to a function; `createDiodeElement` calls it only when `props.hasModelParam("IBEQ")` returns true (which only TunnelDiode's schema permits after the split). This is one atomic change — no intermediate state.
    - Pros: No dead code, no deferred task, no two-phase commit.
    - Cons: Step 3a is now the largest single step. Must trace the full diode load path.

---

#### D2 — LEVEL=3 on `behavioral` TunnelDiode model is architecturally questionable (major)

- **Location**: §3.4 step 4, §3.7a proposed form; §2.2 "Augment `ModelEntry`"
- **Problem**: The spec proposes attaching `spice: { modelCardPrefix: ["LEVEL=3"] }` to the `"behavioral"` ModelEntry of `TunnelDiodeDefinition`. The spec's own justification: "the netlist generator's job is to make ngspice produce comparable output, and ngspice's tunnel diode is exactly LEVEL=3." But the `"behavioral"` model name implies the device is simulating internally using a behavioral I(V) curve (Esaki-formula fitting), NOT the ngspice LEVEL=3 Shockley-with-tunnel-extension model. Attaching `LEVEL=3` to an entry named `"behavioral"` means the emitted netlist claims a LEVEL=3 physics model while the digiTS solver is running a completely different I(V) curve. For parity testing this might be the right thing (it is what ngspice understands for tunnel diodes), but it creates a `ModelEntry` where the `factory` and the `spice` field describe two completely different physics models — which violates the principle that a `ModelEntry` is a single self-consistent model.
- **Why decision-required**: Whether to accept this semantic mismatch, rename the entry, or add a second model entry is a design call.
- **Options**:
  - **Option A — Accept as-is**: The `"behavioral"` name refers to the digiTS internal simulation method; the `spice` field describes the ngspice emission. Document this clearly in a comment on the ModelEntry.
    - Pros: No structural change. Minimal blast radius.
    - Cons: `ModelEntry.spice` and `ModelEntry.factory` describe different physics. Future authors of other devices will reasonably expect `spice` to describe the same model the `factory` implements. Sets a confusing precedent.
  - **Option B — Rename `"behavioral"` to `"esaki"` or `"tunnel-behavioral"`**: The new name describes what the factory does without implying it is equivalent to ngspice's LEVEL=3 model.
    - Pros: `factory` and `spice` both annotate the same entry; it is now clear the digiTS solver uses an Esaki fit while the SPICE export uses LEVEL=3 for ngspice compat.
    - Cons: Changes the model key; any existing serialized circuit with `model: "behavioral"` must be handled via a registry alias or migration path. Broader blast radius.
  - **Option C — Add a dedicated `"spice-l3"` ModelEntry to TunnelDiode**: Keep `"behavioral"` with no `spice` field. Add `"spice-l3"` with the LEVEL=3 prefix and an appropriate factory. The netlist generator uses the current model key to select the emission.
    - Pros: Each ModelEntry is self-consistent. Parity testing can explicitly select `"spice-l3"`.
    - Cons: Requires a second factory or re-uses the behavioral factory for SPICE emission (which is the same as Option A under a different name). May complicate how the harness selects model keys.

---

#### D3 — Model-swap rebuild path: spec mandates verification but provides no contingency (critical)

- **Location**: §3.5 migration step 5; §7 Step 3b "Verify the model-swap path before merging this step"
- **Problem**: The spec says: "If the existing path does not rebuild on `model` change, that is a pre-existing gap that this stage MUST land a fix for; the lateral variant is unusable without it. Do not assume CLAUDE.md's 'model is the source of truth post-placement' guarantee implies a working hot-swap — read the code path and confirm." This review traced the compile path (`compiler.ts:resolveModelEntry`) and found it reads `props.get("model")` at compile time to select a `ModelEntry`. The question is whether changing the `model` property on a live placed component triggers a recompile automatically. The spec correctly flags this as "must verify" but provides ZERO contingency if the path is absent — it only says "that is a pre-existing gap that this stage MUST land a fix for." A fresh executor agent has no guidance on what "a fix" means: re-subscribe to property changes? Force recompile in the coordinator? Emit a diagnostic? The spec leaves the implementer to design a non-trivial engine feature from scratch with no spec for it.
- **Why decision-required**: Whether the model-swap recompile path exists is a code question (partially answered: the compiler reads `model` from `props` at compile time, but whether property changes trigger recompile is a separate mechanism). More importantly, the spec does not specify the repair path, making Step 3b un-implementable if the path is missing.
- **Options**:
  - **Option A — Extend the spec with a stub fix**: Add a sub-step 5a to §3.5 describing the required repair if the model-swap path is absent: "If `SimulationController.hotRecompile()` (or equivalent) is not triggered by a `model` property change, add a property-change listener in the relevant coordinator/controller that calls `hotRecompile()` when `props.get("model")` changes on an analog component. File path: `src/app/simulation-controller.ts` or `src/solver/coordinator.ts`. Acceptance criterion: the model-swap test (§3.5 last bullet) passes."
    - Pros: Implementer has a concrete path regardless of what the verification finds.
    - Cons: May specify unnecessary work if the path already exists.
  - **Option B — Make verification a pre-condition gate**: Separate Step 3b into two steps: "Step 3b-i: Verify model-swap path (read-only). If it exists, proceed to 3b-ii. If absent, file a separate spec (not this one) for the engine-side fix, and block 3b-ii on that spec landing." The lateral variant is explicitly declared "not implementable under this spec" until the prerequisite is confirmed.
    - Pros: Does not conflate the cleanup spec with an engine feature spec. Keeps each spec's scope clean.
    - Cons: May indefinitely block the lateral variant. Requires a second spec document.
  - **Option C — Remove the lateral variant from this spec entirely**: The lateral variant's sole value is eliminating `instanceDropAlways`. If model-swap is not guaranteed, a lateral BJT element placed in a circuit can never be safely changed to vertical at runtime. Defer the lateral entry to a follow-up spec once the model-swap path is confirmed or implemented.
    - Pros: This spec stays focused on the netlist generator cleanup. `instanceDropAlways` can still be deleted (SUBS simply is not a param; lateral is not yet a ModelEntry).
    - Cons: Leaves a deliberate architecture gap — vertical-vs-lateral distinction was the whole point of the SUBS refactor.

---

#### D4 — `prefix` and `modelType` placeholder fields in `ModelEmissionSpec` (minor)

- **Location**: §2.2 `ModelEmissionSpec` interface; the comment "Out of scope for this cleanup, but the field is part of the same contract" and "for symmetry, not used in this cleanup"
- **Problem**: The spec adds `prefix?: string` and `modelType?: string` to `ModelEmissionSpec` and explicitly says they are "out of scope" and "not used in this cleanup." Under CLAUDE.md `rules.md`: "Never mark work as deferred, TODO, or 'not implemented.'" and "No `# TODO`, `# FIXME`, `# HACK` comments." An interface field with a JSDoc comment that says "Out of scope for this cleanup" is the interface equivalent of a TODO. The field will never be used until someone adds usage — meaning the type system will contain dead optional fields from the moment this spec is implemented.
- **Why decision-required**: Whether unused-but-documented interface fields violate CLAUDE.md's deferred-work ban, or whether they constitute forward-looking architecture (acceptable per "do not paint into a corner"), is a policy call.
- **Options**:
  - **Option A — Delete `prefix` and `modelType` from `ModelEmissionSpec`**: Ship only `modelCardPrefix`. The other two fields are added by a future spec when a use case arrives.
    - Pros: No dead optional fields. No code that exists solely to avoid a future extension.
    - Cons: A future model that needs `prefix` must add the field to the interface at that time, which is a tiny but real cost.
  - **Option B — Keep `prefix` and `modelType` but remove the "out of scope / for symmetry" JSDoc**: The fields are valid forward-looking architecture. Replace the JSDoc with a neutral description of what the field does when set, no mention of scope. The field being optional means unused instances are zero-cost.
    - Pros: Consistent with "do not paint into a corner." Interface is stable.
    - Cons: Technically ships dead optional fields whose presence cannot be validated by any test.
  - **Option C — Keep the fields and add a registry-load validator**: A validator on `ModelEntry` at registry time asserts that if `spice.prefix` is set it must be a single uppercase letter, and similarly for `modelType`. This gives the fields meaning even before any component uses them.
    - Pros: Fields are not dead — they have runtime enforcement.
    - Cons: More work than warranted for a cleanup spec.

---

#### D5 — New lateral model-registry key name collision with existing naming convention (minor)

- **Location**: §3.5 "Proposed declarative form" code sketch, migration step 4, Optional follow-up paragraph
- **Problem**: The spec proposes `"spice-l1-lateral"` as the new lateral key. As established in finding M2, the existing key is `"spice"` (not `"spice-l1"`). The lateral key would therefore naturally be `"spice-lateral"`. However, the spec's "Optional follow-up" paragraph separately suggests renaming `"spice-l1"` → `"spice-l1-vertical"` as a future task. If both this cleanup and that follow-up land, the progression would be: today `"spice"` → this PR `"spice"` + `"spice-lateral"` → follow-up `"spice-l1-vertical"` + `"spice-l1-lateral"`. That follow-up would break any saved circuit with `model: "spice"` unless aliases are provided. The spec does not address this migration burden.
- **Why decision-required**: The choice of lateral key name determines whether the follow-up rename requires aliases and how many migration steps exist.
- **Options**:
  - **Option A — Use `"spice-lateral"` (consistent with current `"spice"` key)**: Minimal change. A future rename of `"spice"` → `"spice-l1-vertical"` is a separate spec with its own migration plan.
    - Pros: This cleanup does not introduce any key names that will be renamed again immediately.
    - Cons: The key `"spice-lateral"` does not signal the SPICE level (L1).
  - **Option B — Land the full rename in this spec**: Rename `"spice"` → `"spice-l1-vertical"` and add `"spice-l1-lateral"` in the same PR. Register `"spice"` as an alias for `"spice-l1-vertical"` so saved circuits load correctly.
    - Pros: Final naming is in place after a single PR. No follow-up rename needed.
    - Cons: Blast radius is larger. Every test asserting `model === "spice"` must be updated. Scope creep for a "cleanup" spec.

---

#### D6 — `getTime` parameter in `AnalogFactory` signature not addressed by the factory-of-factory sketch (major)

- **Location**: §3.5 "Proposed declarative form" factory-of-factory sketch
- **Problem**: The actual `AnalogFactory` signature in `registry.ts:21-27` is:
  ```ts
  export type AnalogFactory = (
    pinNodes: ReadonlyMap<string, number>,
    internalNodeIds: readonly number[],
    branchIdx: number,
    props: PropertyBag,
    getTime: () => number,      // ← fifth parameter
  ) => AnalogElementCore;
  ```
  The spec's code sketch for `createBjtL1Element` omits `getTime`:
  ```ts
  return (pinNodes, internalNodeIds, branchIdx, props) => {
  ```
  This is a type error — the returned function does not match `AnalogFactory`. The existing inline arrow in `NpnBjtDefinition.modelRegistry["spice"]` correctly names but ignores it as `_getTime`. The spec's sketch would not compile as written.
- **Why decision-required**: Whether to explicitly name `_getTime` (ignored) or include it with a forward-looking placeholder depends on whether `isLateral` elements will ever need simulation time.
- **Options**:
  - **Option A — Add `_getTime` to the inner function signature**: The sketch becomes `return (pinNodes, internalNodeIds, branchIdx, props, _getTime) => {`. This is a purely mechanical fix if the user agrees it is unambiguous.
    - Pros: Compiles. Matches the existing pattern in the modelRegistry arrows.
    - Cons: None.
  - **Option B — Document explicitly**: Add a note to §3.5 that the inner function must accept (and ignore) `_getTime` to satisfy the `AnalogFactory` type. Leave the exact fix to the implementer.
    - Pros: Less prescriptive.
    - Cons: Risks being missed — a fresh implementer reading only the sketch will write non-compiling code.

---

#### D7 — Single-file vitest gate risk not mitigated (major)

- **Location**: §7 "Test-suite status note" and each Step's "Sanity check" description
- **Problem**: The spec acknowledges the whole-suite vitest hang and substitutes `(a) tsc compiles cleanly` + `(b) the targeted hand-run sanity check named in the step`. For Steps 3a, 3b, and 4 the spec says "run the netlist-generator unit tests in isolation (single-file vitest invocation)" as the gate. But Step 4 edits `netlist-generator.ts`, which is imported by multiple harness tests and potentially by parity tests. A single-file vitest run of `netlist-generator.test.ts` would not catch:
  - Regressions in `harness-integration.test.ts` (which calls `generateSpiceNetlist` through the full harness stack)
  - Regressions in any `ngspice-parity/` tests that import the harness directly
  The spec says "do not introduce new commands… into commit hooks or CI" but does not specify whether the multi-file parity suite must also pass. Step 5 covers parity at the harness level, but only after Step 4 lands. A regression introduced in Step 4 may not surface until Step 5 — by which time other changes have also landed.
- **Why decision-required**: Whether to require a broader (multi-file) vitest gate at Step 4 before the hang is fixed, or accept the single-file gate with an explicit "Step 5 is the regression catch", is a risk-tolerance decision.
- **Options**:
  - **Option A — Keep single-file gate at Step 4, explicitly state Step 5 is the full regression gate**: Add to §7 Step 4: "Note: `netlist-generator.test.ts` single-file is the primary gate for Step 4. Step 5 is the full regression gate covering `harness-integration.test.ts` and all parity fixtures. Do not merge Step 4 until Step 5 is verified."
    - Pros: Minimal change. Risk is accepted and documented.
    - Cons: Steps 4 and 5 become implicitly coupled and should not be merged independently.
  - **Option B — Mandate a multi-file gate at Step 4 using targeted file list**: Specify `vitest run src/solver/analog/__tests__/harness/netlist-generator.test.ts src/solver/analog/__tests__/harness/harness-integration.test.ts` as the Step 4 gate. This covers the harness path without triggering the whole-suite hang.
    - Pros: Catches harness-integration regressions before Step 5. Still avoids the whole-suite hang.
    - Cons: The hang's cause is unknown — it could affect these files too. Requires the implementer to verify the targeted run does not hang.

---

#### D8 — NSUB/NSS deferred schema cleanup conflicts with "No Pragmatic Patches" (major)

- **Location**: §3.7b last paragraph: "Schema cleanup of NSUB/NSS for MOS L1 is a separate follow-up the user can prioritize independently."
- **Problem**: The spec correctly deletes `modelCardDropIfZero` and lets NSUB/NSS emit. It then says: "If the user later wants to remove NSUB/NSS from the MOS Level-1 schema entirely, that is its own architectural call… Keep this cleanup focused; flag it for follow-up." CLAUDE.md "No Pragmatic Patches" bans "deferred" solutions. The predecessor doc §D explicitly says the cleaner answer is "not declare NSUB/NSS in paramDefs at all unless the model genuinely uses them." If they are not used, declaring them and emitting them (`NSUB=0 NSS=0`) on every MOSFET model card is dead schema. The spec itself acknowledges this is a half-measure ("flag it for follow-up") but argues scope focus justifies the deferral.
- **Why decision-required**: Whether omitting an unused-schema cleanup from a cleanup spec is a CLAUDE.md "scope reduction" ban violation, or a legitimate scoping decision, requires user judgment.
- **Options**:
  - **Option A — Accept the deferral as legitimate scope management**: The spec argues it is not pragmatic — it is a deliberate architectural decision deferred to a separate spec. Add a note referencing `spec/architectural-alignment.md` or a future spec file for the NSUB/NSS MOS level-split.
    - Pros: Keeps this spec's blast radius from growing. NSUB/NSS emission is harmless (ngspice ignores them at LEVEL=1).
    - Cons: Leaves dead schema declared and emitted. Future implementers hitting the follow-up will need to re-trace all the same consumers.
  - **Option B — Include NSUB/NSS schema cleanup in this spec**: Add a step 3c that removes NSUB and NSS from `MOSFET_NMOS_PARAM_DEFS` and `MOSFET_PMOS_PARAM_DEFS`. Update all MOS preset constants to remove those keys. Update tests to no longer assert or set NSUB/NSS.
    - Pros: Consistent with "No Pragmatic Patches." Schema is clean after this spec.
    - Cons: Substantial blast radius increase (many preset constants reference NSUB/NSS). Scope creep.

---

## Additional Findings

### Info Items

#### I1 — `partition` field in §2.1 notes is correct but under-explained for the reader (info)

- **Location**: §3.1 step 1, Note: "there is no `partition` field on `ParamSpec`"
- **Observation**: The claim is correct — `ParamSpec` in `model-params.ts:4-10` has no `partition` field; partition is entirely bucket-derived (`primary`/`secondary` → `"model"`, `instance` → `"instance"`). However, the note does not explain what a reader should do if they encounter a param that legitimately needs `partition: "model"` but lives in the `instance` bucket due to a historical error (e.g., params that were incorrectly placed in `instance` but should be `model`). The note's brevity may confuse an implementer who encounters edge cases.
- **Classification**: Info — the statement is true and the limitation is intentional.

---

#### I2 — `instanceDropAlways` lines 125/130 vs spec's cited lines 125/130 (info)

- **Location**: §3.5 migration step 6: "delete the two `instanceDropAlways: ["SUBS"]` entries at lines 125 and 130"
- **Observation**: Verified in `netlist-generator.ts`: `NpnBJT` entry with `instanceDropAlways: ["SUBS"]` is at line 125, `PnpBJT` at line 130. Both correct. Recording for completeness.
- **Classification**: Info — confirmed accurate.

---

#### I3 — §7 Step 6 marks predecessor doc resolved, but predecessor has open worker-crash question (info, decision-required)

- **Location**: §7 Step 6: "Update `spec/ngspice-netlist-generator-cleanup.md` 'Cleanup needed' sections A, B, C, D to reference this proposal as their resolution…"
- **Problem**: The predecessor doc has an "Open question" section (the worker-crash / test-hang). Step 6 says to mark sections A, B, C, D as resolved but leaves the "Open question" open. This is explicitly called out in the spec. However, the spec does not specify what "updating" section A/B/C/D means — does it add a "resolved by commit X" line? Does it delete the section? Does it leave them as-is with a pointer to the architecture doc? The spec says "reference this proposal as their resolution and the relevant commit IDs" — which implies adding a cross-reference, not deleting the sections. This is an implementable instruction, but vague enough that two implementers might produce very different results.
- **Classification**: Info / minor — the instruction is workable but imprecise.
- **Options**:
  - **Option A — Add a "Resolved by:" line to each section A/B/C/D**: Each section gets a single appended line: `**Resolved by:** spec/ngspice-netlist-generator-architecture.md, implemented in commit <id>.`
    - Pros: Minimal change, auditable.
    - Cons: Leaves the predecessor doc as a hybrid of resolved and open items.
  - **Option B — Delete sections A/B/C/D from the predecessor doc**: Only the open worker-crash question remains. The resolved sections are replaced by a pointer: "Cleanup items A/B/C/D resolved — see `spec/ngspice-netlist-generator-architecture.md`."
    - Pros: Predecessor doc is clean. "specs are current-state contracts" applies.
    - Cons: Loses the per-section reasoning (which is useful for understanding why the architectural decisions were made).
