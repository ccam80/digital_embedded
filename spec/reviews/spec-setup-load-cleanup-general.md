# Spec Review: setup-load-cleanup.md — General Wide-Net Review

## Verdict: needs-revision

The spec is unusually thorough for a single document and the contract section (A) is well-structured. However the wide-net review surfaced several real ambiguities and one structural gap (the closure criteria for the wave) that an implementer-fleet of ~50 parallel agents will hit. There are also a handful of inconsistencies between A and B that could cause partial-state landings.

This review was scoped to general consistency, completeness, concreteness, implementability and CLAUDE.md alignment. The two parallel agents (ngspice contract verification and F-code appropriateness per file) covered the lanes I left untouched.

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 1 | 1 |
| major    | 1 | 7 | 8 |
| minor    | 2 | 4 | 6 |
| info     | 1 | 2 | 3 |
| **Total**| **4** | **14** | **18** |

## Plan Coverage

There is no `spec/plan.md` for this work; the spec is its own contract. As called out in the assignment, "plan coverage" maps to: does the spec articulate a verifiable success metric? Result: **partial** — Section D defines a three-phase execution model (Foundation → Wave → Convergence) but the **acceptance gate** is implicit. The C.1 grep returning zero hits is the only mechanical closure check, and Section D explicitly defers tsc / tests to the convergence pass with no pass/fail criteria there. See D2 below.

| Implicit gate | Defined? | Notes |
|---|---|---|
| Section C.1 forbidden greps return zero hits repo-wide | yes (D.3) | sole hard gate |
| `tsc --noEmit` clean | partial | "assess landing impact" — no zero-error mandate |
| Test suite green | partial | "triage residual breakage" — no pass-rate requirement |
| Convergence (numerical parity) | no | explicit out-of-band lane |
| C.2 required patterns appear where applicable | no | C.4 says agent reports per-file but the convergence pass does not aggregate |

## Findings

### Mechanical Fixes
| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | minor | §A.16 line ~604 | `SetupContext.solver` is typed `SparseSolver`, but the canonical inline factory in §A.13 stores TSTALLOC handles via `ctx.solver.allocElement(...)` — implying a sparse-solver shape that supports preliminary `allocElement` (the same call used post-`beginAssembly`). The two are consistent, but the test usage in §A.19 line ~759 calls `solver.beginAssembly(matrixSize)` which is also a SparseSolver method that the SetupContext interface does not expose. This is an info-level concreteness gap — the spec should either add `beginAssembly` (and `endAssembly`) to the SetupContext sketch, or note explicitly that those methods are NOT exposed on `ctx.solver` and must be called against the raw solver instance. | Add a one-line footnote to §A.16 immediately after the `solver: SparseSolver` field: "Tests construct the solver and call `solver.beginAssembly(...)` / `solver.endAssembly()` outside the SetupContext lifecycle; element setup() calls only `ctx.solver.allocElement(...)`." |
| M2 | minor | §A.21 line ~810, contradicting §A.15 line ~480-487 | A.21 says "the compiler does not pre-sum [`stateSize`]". A.15's `CompositeElement.stateSize` getter computes the sum dynamically from `getSubElements()`. Both statements agree (the compiler does not pre-sum because the getter dynamically sums) — but the spec wording in A.21 reads as a prohibition rather than an explanation. | Edit A.21 line ~810 from "The composite's `stateSize` derives from the base-class getter; the compiler does not pre-sum it." to "The composite's `stateSize` is provided by the `CompositeElement` base-class getter (A.15), which dynamically sums sub-element `stateSize`. The compiler does not write a `stateSize` field to the composite directly." |
| M3 | major | §C.1 row C13 line ~1226 | The pattern `\bel\.isReactive\b` \| `\bel\.isNonlinear\b` uses `el\.` as a literal anchor — this misses occurrences using any other variable name (`element.isReactive`, `c.isReactive`, `child.isReactive`). The spec elsewhere (§A.12) explicitly mentions `element.isReactive` in the compiler discriminator. C1 (`\bisReactive\b`) catches everything but is the looser net; C13's stated purpose is "Predicates replaced by method-presence checks" — predicates can use any identifier. | Replace C13's pattern with `\b\w+\.(isReactive\|isNonlinear)\b` or (simpler) drop C13 entirely since C1+C2 already catch all surface forms. |
| M4 | minor | §A.5 line ~145 vs §A.16 line ~628 | A.5 says state-pool allocation is via `ctx.allocStates(N)` — singular `allocStates`. A.16 declares the field as `allocStates(slotCount: number): number`. Consistent. But §A.16's JSDoc says "stored to `el._stateBase`", which is a documentation note that belongs in A.5, not in the type declaration. The convention elsewhere in the spec is "type interfaces are pure contract; storage decisions live in the prose". | Move the "Stored to `el._stateBase`" sentence out of the `allocStates` JSDoc and into A.5 prose. Same for the "Stored to `el.branchIndex`" line on `makeCur`. (Style consistency only.) |

### Decision-Required Items

#### D1 — Wave closure criteria are too loose for ~150-file blast radius (critical)
- **Location**: §D.3 lines ~1295-1298 and §D.4 line ~1305-1307
- **Problem**: The spec explicitly accepts that "[t]he wave will not be tsc-clean or test-clean while in flight" and defers tsc/test remediation to a "single post-wave pass". The convergence pass is described as: "runs Section C.1 greps repo-wide to confirm no forbidden pattern survives, then runs `tsc --noEmit` and the test suite to **assess landing impact and triage residual breakage**". There is no defined exit condition — the wave can land with arbitrary tsc errors and arbitrary test failures and still claim done.
- **Why decision-required**: The user has chosen a parallel-execution model that explicitly trades short-term breakage for throughput. A stricter exit condition (e.g. zero tsc errors) might force the convergence pass to balloon into another wave, defeating the purpose. But "no exit condition" means an agent (or the user) finishing the convergence pass has no objective signal that the wave is complete. The CLAUDE.md "No Pragmatic Patches" / "Completion Definition" rules require an explicit done-state.
- **Options**:
  - **Option A — Hard gate**: Convergence pass must end with zero `tsc --noEmit` errors AND no NEW test failures relative to the pre-wave baseline (referenced in `spec/test-baseline.md`). Section C.4 per-file reports are aggregated; any unresolved C.2 missing-row blocks closure.
    - Pros: Maximally aligned with CLAUDE.md "Completion Definition". A reviewer can mechanically verify done.
    - Cons: Forces the convergence pass to fix every issue, including downstream regressions caused by parallel agents stepping on each other's reads. May effectively become a second wave.
  - **Option B — Numerical parity gate only**: Convergence pass ends when (a) C.1 greps return zero, (b) tsc errors are within a documented allow-list referenced from a frozen file, and (c) `npm run test:q` shows no NEW numerical regressions vs `spec/test-baseline.md`. Type-only errors and trivial test breakages (snapshot updates) are accepted.
    - Pros: Aligns with the "out-of-band TS6133" and "out-of-band convergence" lanes already in the spec. Realistic given parallel execution.
    - Cons: "Type-only errors" is not a sharp distinction; CLAUDE.md "No Pragmatic Patches" reads against allow-listing tsc errors. Risk of allowing real bugs.
  - **Option C — Two-stage convergence**: Convergence-1 (C.1 greps clean + tsc clean), Convergence-2 (test triage spawning per-failure follow-up tasks). Each stage has its own pass/fail.
    - Pros: Separates "did the rename land" (mechanical) from "did the rename break anything" (numerical). Each stage has a clear gate.
    - Cons: Adds a phase. Test triage in stage 2 can spawn arbitrary follow-up work that is itself unscoped here.

#### D2 — `_pinNodes.size + p` internal-node ID derivation is fragile (major)
- **Location**: §A.7 lines ~189-191, §A.23 lines ~847-855
- **Problem**: A.7 specifies that harness consumers derive matching internal-node IDs by reading `_pinNodes.size` and counting up from there in allocation order. A.23 repeats this. But the assignment correctly identifies the failure mode: "an element that calls `ctx.makeVolt` interleaved with `ctx.makeCur` could break this assumption" — `makeCur` returns a branch-row index that is in a separate ID space from internal nodes (rows vs node-ids), so it does not break the offset arithmetic in this respect. The real risk is composites where `setup()` calls `super.setup(ctx)` (forwarding to children that each call `makeVolt`), then the parent calls its own `makeVolt` afterward. The base class's getter would expose only the parent's internal labels, not the children's, but the offset arithmetic against `_pinNodes.size` would skip past nodes the children allocated — putting the parent's first internal node at the wrong offset. A.7 says nothing about how composite vs leaf elements expose internal nodes.
- **Why decision-required**: The fix is either (1) require every element to record its internal-node IDs explicitly (not just labels), and have `getInternalNodeIds()` return them; or (2) document the harness-side allocation-order contract so composites' children's internal nodes are named with the parent's prefix; or (3) prohibit composites from owning internal nodes directly. Each has trade-offs in cost-of-implementation.
- **Options**:
  - **Option A — Add `getInternalNodeIds?(): readonly number[]`**: Mirror `getInternalNodeLabels` so both labels and IDs are returned by the element. The harness zips them.
    - Pros: Element is self-describing. No offset arithmetic. Robust to any allocation order, including composites.
    - Cons: Every factory that allocates internal nodes records IDs (one extra `internalIds.push(nodeId)` per `makeVolt` call) and exposes the method. Roughly 19 production sites + composites.
  - **Option B — Composites do not allocate internal nodes; only leaf children do**: Document this as a contract clause. The base class's `setup()` only forwards. The parent's own `setup()` body (if it has one beyond the forward) must not call `makeVolt`.
    - Pros: Smaller surface — only leaf factories record labels. The offset-from-`_pinNodes.size` works correctly.
    - Cons: Requires an audit of all 16 composite classes to confirm none directly call `makeVolt`. The spec doesn't currently audit this.
  - **Option C — Document the contract explicitly and accept the risk**: Add a clause to A.7 saying "elements that use `CompositeElement` must not allocate internal nodes via parent-side `setup()`; all `makeVolt` calls must occur in child `setup()`s." Add a Section C grep that detects parent-side `ctx.makeVolt` in any `extends CompositeElement` class.
    - Pros: Lightest spec change. Catches the class of bugs the assumption hides.
    - Cons: Still relies on offset arithmetic; doesn't help non-composite classes that interleave `makeVolt` and `makeCur` if a future engine change reuses ID spaces.

#### D3 — `ReadonlyMap` vs `Map` parameter typing inconsistency (major)
- **Location**: §A.2 line ~62 (`_pinNodes: Map<string, number>`), §A.3 line ~115 (`pinNodes: ReadonlyMap<string, number>`), §A.13 line ~291 (`_pinNodes: new Map(pinNodes)`), §A.14 line ~408 (constructor `pinNodes: ReadonlyMap<string, number>`)
- **Problem**: The factory signature requires `ReadonlyMap` (immutable input), but the element's own `_pinNodes` field is mutable `Map`. The factory copies via `new Map(pinNodes)`. This pattern is intentional (defensive copy on construction). But it leaves the **mutable** `_pinNodes` field exposed on the element interface — meaning any consumer can write to `el._pinNodes.set(...)` post-setup. There's no spec clause saying "_pinNodes is conceptually frozen after construction".
- **Why decision-required**: A reasonable engineer could pick `ReadonlyMap` for the element field too (treat construction as the only write site), or keep `Map` to allow setParam-style mutations (none of which are specified, but a future user might assume they are allowed). Both choices have downstream implications for what the rendering / harness layers can do.
- **Options**:
  - **Option A — Tighten to `ReadonlyMap` on the element field**: A.2 changes to `_pinNodes: ReadonlyMap<string, number>`. Factories use `new Map(pinNodes) as ReadonlyMap<string, number>` if needed for typing.
    - Pros: Field becomes immutable post-construction. Catches accidental mutation at the type level.
    - Cons: Disallows future use-cases (e.g. a "rewire" operation). Class-implementing elements that build `_pinNodes` incrementally in the constructor become awkward.
  - **Option B — Keep `Map` and document immutability in prose**: Add a line to A.4: "_pinNodes is initialized in the factory/constructor and never mutated thereafter. The mutable type is for ergonomic construction only."
    - Pros: Matches current spec. No interface churn.
    - Cons: Type system doesn't enforce. A wave agent could write `el._pinNodes.set(...)` and pass review.
  - **Option C — Use a frozen Map (Map but call `Object.freeze`)**: Factory does `Object.freeze(map)` before returning the element.
    - Pros: Runtime safety.
    - Cons: TypeScript still types it as `Map`; doesn't catch at compile time. `Object.freeze` on Map doesn't actually prevent `set()` calls (Map's internal slots aren't frozen).

#### D4 — `getInternalNodeLabels` placement on AnalogElement vs PoolBackedAnalogElement (major)
- **Location**: §A.2 lines ~89-94
- **Problem**: `getInternalNodeLabels?(): readonly string[]` is declared on the base `AnalogElement` interface as optional. The spec rationale (line ~91) says "Optional — elements that allocate no internal nodes do not implement it." But internal-node allocation typically goes hand-in-hand with state-pool allocation (capacitors, BJTs, transmission lines all allocate both). The spec also says (A.21) "the compiler-time internal-node allocation goes away" implying internal nodes belong only to elements with non-trivial setup — typically pool-backed. Putting the method on the base interface is more permissive than the actual usage.
- **Why decision-required**: A.2 places it on base; A.7's prose says "Each element that calls `ctx.makeVolt(label, suffix)`" — implying it's per-element-that-does-X. Some non-pool-backed elements (sources, simple resistors) never call makeVolt, so the field is decorative for them. A reasonable engineer could move it to PoolBackedAnalogElement (tighter) or keep it on base (more permissive). The decision affects how `bridge-adapter.ts` (PoolBackedAnalogElement composite) and any non-pool-backed composite elements are typed.
- **Options**:
  - **Option A — Keep on base AnalogElement (current)**: Optional, ignored by elements that don't allocate internal nodes.
    - Pros: Future-proof if a non-pool-backed element ever needs internal nodes. No type churn.
    - Cons: Adds a method to the base contract that ~70% of elements will never implement. Slightly weaker type discipline.
  - **Option B — Move to PoolBackedAnalogElement only**: Optional on the pool-backed extension.
    - Pros: Tighter typing — internal nodes are only meaningful where state-pool is. Prevents a non-pool-backed factory from accidentally implementing it.
    - Cons: Forces any future non-pool-backed element with internal nodes to migrate. Subtler change for harness consumers (they'd need to narrow the type).
  - **Option C — Keep on base, but require it on every element that calls `ctx.makeVolt`**: Add a Section C grep that detects `ctx.makeVolt` in any factory that does NOT define `getInternalNodeLabels`.
    - Pros: Type stays permissive, but contract-compliance is enforced mechanically.
    - Cons: Adds Section C complexity; requires multi-line regex (which the spec currently avoids).

#### D5 — F4 on test files is ambiguous (major)
- **Location**: §B.6 line ~1153 (`diac.test.ts` "F4 (no flag occurrences in the file)"), §B.13 line ~1096 (`setup-stamp-order.test.ts` "F1, F4, F16"), §B.13 multiple test rows with `F4`
- **Problem**: F4 is defined in §B (line ~877) as "Factory signature → 3-arg `(pinNodes, props, getTime)` (A.3)". This is inherently a production-side change. On a test file, F4 makes sense only if the test imports a factory and calls it with a non-3-arg signature; the test then must update its call site. But the spec doesn't say "F4 on a test file means update the test's invocation of the factory" — and the diac.test.ts row's parenthetical "(no flag occurrences in the file)" implies F4 is being used to mean "no F1 needed, but factory invocation needs updating". Without a clear gloss, an agent may interpret F4 on a test as "rewrite the factory definition" (impossible — there is no factory definition in a test) and either no-op or rewrite the wrong file.
- **Why decision-required**: The reasonable readings differ in scope. The current F4 definition is production-coded; using the same code on a test creates a gloss the spec never spells out.
- **Options**:
  - **Option A — Add an F4-test gloss to the F-codes table**: Edit B (line ~877) to read: "F4 | Factory signature → 3-arg `(pinNodes, props, getTime)` (A.3). On a test file: update factory call sites to pass the 3-arg shape; if a test constructs a factory wrapper or test-only factory, ensure that wrapper produces the 3-arg shape."
    - Pros: Disambiguates without splitting F-codes. Single edit.
    - Cons: Slightly muddy — F4 now means two things depending on file kind.
  - **Option B — Split into F4-prod and F4-test**: Add F4a (production factory definition rewrite) and F4b (test invocation rewrite). Update every B.* row that uses F4 on a test file to F4b.
    - Pros: Sharp, no gloss.
    - Cons: Touches every B-row that uses F4 on a test (~30 rows). High edit cost.
  - **Option C — Drop F4 from test rows, rely on F16/F17 instead**: F16 already covers test-fixture rewrites via `withNodeIds` removal; expand its scope to mean "rewrite all factory invocations in test files to match A.3/A.13/A.14".
    - Pros: F16 was always going to require this anyway. Removes redundancy.
    - Cons: Hides the "factory signature change" intent in a more general code. May require renaming F16 to make it less specific.

#### D6 — `variable-rail.ts` `?? ""` workaround vs PropertyBag scope (major)
- **Location**: §B.4 line ~955 (variable-rail.ts row) cross-referenced with §A.18 lines ~684-688
- **Problem**: A.18 says PropertyBag method renames are "out of scope for this wave. The agent records the occurrence in their per-file out-of-band report and moves on." But B.4's variable-rail row says "The legacy `props.getString(...)` site has a `string | undefined` return type — provide an explicit fallback (`?? ""`) at the call site; do not refactor PropertyBag itself". This is an in-scope edit (modify the call site to add `?? ""`) on a method that A.18 says is out-of-scope. The two statements contradict.
- **Why decision-required**: Either (1) variable-rail's call site is exempt from the A.18 prohibition because the spec wants the wave to ship without a tsc error here, or (2) variable-rail should also defer to the out-of-band report. The current text leaves the agent to guess.
- **Options**:
  - **Option A — Add an exemption clause to A.18**: Edit A.18 to read: "Older `getString` / `getNumber` / `getBoolean` calls that surface during the wave are not edited by wave agents (these are PropertyBag API renames; out of scope for this wave) — **except** for non-functional fallbacks (`?? ""`, `?? 0`, `?? false`) at the call site that suppress tsc errors. Behavioural changes to PropertyBag's API surface are out of scope; defensive call-site fallbacks are in scope."
    - Pros: Resolves the contradiction in favor of the more pragmatic stance B.4 already takes.
    - Cons: Opens a gray-area: what counts as "non-functional fallback"? An agent could justify any `?? <default>` as "just fixing tsc".
  - **Option B — Remove the `?? ""` instruction from B.4**: The variable-rail row drops "provide an explicit fallback (`?? ""`)" and instead says "record the `getString` occurrence in the out-of-band report; do not modify the call site". The wave lands with a tsc error here that the convergence pass picks up.
    - Pros: Internally consistent with A.18.
    - Cons: Adds a known tsc error to the wave-end state, which is the kind of thing the convergence pass is meant to triage but the closure criteria (D1) don't pin down.
  - **Option C — Move `getString` to in-scope wave-wide**: Edit A.18 to remove the prohibition entirely. Every `getString`/`getNumber`/`getBoolean` site gets a defensive fallback at the call site. PropertyBag itself is still untouched.
    - Pros: Uniform rule across all files.
    - Cons: Expands wave scope by an unknown number of sites. Risk of touching files not currently in the per-file list.

#### D7 — `makeTestSetupContext.startBranch=-1` default is over-strict (minor)
- **Location**: §A.19 lines ~706-710, ~717-723
- **Problem**: `makeTestSetupContext` defaults `startBranch=-1` and throws "startBranch unset" if any element calls `makeCur`. But §A.6 says `findBranchFor` lazy-allocates via `ctx.makeCur` — meaning a controlled-source test that incidentally triggers `findBranchFor` on a peer will throw at test time even if the test author never explicitly called `setup` on that peer. The spec says "this is intended" via "There is no opt-out path" (line ~768) but doesn't actually clarify that the throw is intentional.
- **Why decision-required**: A reasonable engineer could read the throw as a guard against unintended branch allocation (force tests to be explicit) or as a design accident. The behavioural difference matters: tests that are "minimal" (only set up the elements they need) will throw if a controlled-source dependency reaches across.
- **Options**:
  - **Option A — Document as intentional**: Add a sentence to A.19 immediately before the example block: "The throw on unset `startBranch` is intentional: tests that exercise lazy branch allocation must declare their starting row explicitly. There is no implicit `0` default."
    - Pros: Removes ambiguity.
    - Cons: Doesn't change behaviour. Tests still throw — author must remember to set startBranch.
  - **Option B — Default startBranch to 0**: Change A.19 line ~707 to `startBranch?: number; // default 0`. Drop the `if (nextBranch < 0) throw` guard.
    - Pros: Tests don't need to think about branch allocation unless they care. Reduces friction.
    - Cons: Tests that intend to start at a specific row but forget to set startBranch silently get row 0 — collisions with element[0]'s assumed row become subtle bugs.
  - **Option C — Lazy-default**: Change A.19 to `startBranch?: number; // defaults to 0 if any element exposes findBranchFor`. Detect `findBranchFor` presence on any element in `opts.elements` and set the default accordingly.
    - Pros: Test author opt-in by including a controlled source in `elements`. Explicit by accident.
    - Cons: Magic. Hard to debug when wrong.

#### D8 — `dac.ts` F4 without F18 (minor, info-adjacent)
- **Location**: §B.8 line ~1020 (`src/components/active/dac.ts | F1 (getter form), F4`)
- **Problem**: dac.ts is listed at A.15 as one of the composites that should refactor to `extends CompositeElement`, but the B.8 row only specifies F1, F4 — not F18. If dac.ts is currently a composite class, F4 (factory signature change) without F18 (composite class refactor) would leave the file in a half-state where the factory is 3-arg but the class still hand-rolls the forwarding loops. CLAUDE.md "No Pragmatic Patches" prohibits half-states.
- **Why decision-required**: Either dac.ts is genuinely not a composite (and A.15's mention of "ADC/DAC" in line ~440 is loose phrasing) or it is a composite and F18 was omitted from B.8. The reviewer cannot tell from the spec alone.
- **Options**:
  - **Option A — Add F18 to dac.ts (and audit adc.ts)**: B.8 row for `dac.ts` becomes "F1 (getter form), F4, F18". Same audit for `adc.ts`.
    - Pros: Aligns with A.15's composite mandate.
    - Cons: dac.ts may not actually be a composite (the reviewer didn't verify); adding F18 to a non-composite is wrong.
  - **Option B — Clarify A.15 to exclude DAC/ADC**: Edit A.15's introductory paragraph (line ~440) to remove "ADC/DAC" if these are not in the 16-class subclass mandate table at lines ~575-588. The table does NOT list adc.ts or dac.ts, so this is the more likely intent.
    - Pros: Matches the explicit table. No production behaviour change.
    - Cons: Loses the "ADC/DAC follow the composite pattern" prose hint, which may have been intentional documentation.
  - **Option C — Add an explicit non-composite note for adc.ts/dac.ts**: B.8 rows get a parenthetical "(NOT a CompositeElement subclass — F4 only adjusts the factory; class shape unchanged)".
    - Pros: Eliminates ambiguity at the row level.
    - Cons: Minor noise in B.8.

#### D9 — Three-Surface Testing Rule: spec doesn't address E2E/MCP impact (minor)
- **Location**: spec-wide; CLAUDE.md "Three-Surface Testing Rule"
- **Problem**: CLAUDE.md mandates that every user-facing feature be tested across headless API, MCP, and E2E surfaces. Factory signature changes (F4) and composite refactors (F18) ripple from production into all three surfaces. The spec covers the headless surface (B.13/B.14 unit-test files) and the harness (B.11), but does NOT address:
  - MCP server's circuit_compile path (`scripts/circuit-mcp-server.ts`) — does it materialize element instances such that the factory signature change affects it?
  - E2E tests (`e2e/parity/`, `e2e/gui/`) — do any tests import factories directly or rely on a `pinNodeIds`-shaped element snapshot in postMessage payloads?
  - postMessage adapter (`src/io/postmessage-adapter.ts`) — does any sim-* message carry element internals?
- **Why decision-required**: If the answer is "no MCP/E2E surfaces touch element internals", the spec is fine. If the answer is "they do", the spec has a coverage gap — wave agents may produce tsc-clean production code that breaks at the MCP or postMessage boundary.
- **Options**:
  - **Option A — Add a B.15 row for MCP/E2E surfaces**: Audit `scripts/circuit-mcp-server.ts`, `src/io/postmessage-adapter.ts`, and `e2e/**/*.spec.ts` for any element-internal references; add per-file rows under a new B.15 if any surface needs adjustment.
    - Pros: Closes the surface-coverage gap explicitly.
    - Cons: Requires audit work that the spec author may have already done implicitly.
  - **Option B — Add a one-line out-of-scope clause to A.20**: "MCP server, postMessage adapter, and E2E tests are not in scope for this wave; if any factory-signature change leaks across these boundaries, it is captured by the convergence pass."
    - Pros: Explicit scope boundary.
    - Cons: CLAUDE.md "Three-Surface Testing Rule" reads against this — surfaces are non-negotiable for user-facing features. The wave touches user-facing features only indirectly (it's an internal refactor), but the rule is absolute.
  - **Option C — Do nothing; rely on the convergence pass**: The current spec's tsc/test pass after the wave will catch MCP and E2E breakage.
    - Pros: No spec changes.
    - Cons: D1 already flags that the convergence pass has no exit criteria, so "rely on it" is weak.

#### D10 — `ckt-context.ts` filter for elementsWithLte/elementsWithAcceptStep deletion (minor)
- **Location**: §A.12 line ~268, §A.1 line ~36, §B.1 line ~914
- **Problem**: A.12 says "Also delete the `elementsWithLte` and `elementsWithAcceptStep` filter assignments and field declarations (zero production consumers; only test asserts the filter ran)." But B.13 line ~1082 says `ckt-context.test.ts` is edited with "F1; delete the entire 'precomputed lists' `describe` block". Removing both the field AND the test that asserts it runs is correct, but the spec doesn't explicitly state that *any other* consumer of `elementsWithLte` (e.g. timestep.ts, harness queries) is verified to be a non-consumer. A.12 says "zero production consumers" but doesn't specify how the spec author verified this.
- **Why decision-required**: A.12's "verified zero callers" claim is asserted, not demonstrated. If a wave agent removes `elementsWithLte` and a non-cited consumer breaks, the wave fails. The spec could either commit to the deletion or hedge by adding a Section C grep.
- **Options**:
  - **Option A — Add a C.1 row for `elementsWithLte` / `elementsWithAcceptStep` consumer detection**: New row C19 grepping for `elementsWithLte\|elementsWithAcceptStep` in `src/**` and asserting zero hits outside `ckt-context.ts`.
    - Pros: Mechanical verification of A.12's claim.
    - Cons: Requires the foundation agent to confirm zero hits before deletion.
  - **Option B — Move the deletion to the convergence pass**: B.1's ckt-context.ts row deletes the cached-list assignments (filter side) but keeps the field declarations. After tsc surfaces the unused-field warnings, the convergence pass deletes them.
    - Pros: Defers the verification to a phase that has full repo context.
    - Cons: Inconsistent with the wave's "everything goes" approach. Half-state in the meantime.
  - **Option C — Trust the assertion**: Keep the spec as-is.
    - Pros: No spec change.
    - Cons: Risk if A.12's claim is wrong.

#### D11 — Bridge adapter's `_pinNodes` initialization is under-specified (info)
- **Location**: §A.22 lines ~826-839
- **Problem**: A.22 says "in the constructor, initializes `_pinNodes` from the wrapped digital pin model's label and node id (the previous `pinNodeIds = [...]` / `allNodeIds = [...]` assignments are deleted)". But the adapter's "wrapped digital pin model" is a single pin (one label, one node id), not a Map. The constructor must build a Map from a non-Map source, which the canonical inline pattern (A.13) and class pattern (A.14) don't cover. The agent must invent the construction.
- **Why decision-required**: Multiple reasonable constructions exist. The choice affects how downstream consumers iterate `_pinNodes.values()`.
- **Options**:
  - **Option A — Single-entry Map**: `this._pinNodes = new Map([[pinModel.label, pinModel.nodeId]])`. Pin label is whatever the digital pin model uses internally.
    - Pros: Trivially correct. Matches the iteration pattern.
    - Cons: Not specified explicitly — agent has to invent.
  - **Option B — Add a canonical bridge-adapter snippet to A.22**: Show the constructor body explicitly.
    - Pros: Removes guesswork.
    - Cons: Spec gets longer.
  - **Option C — Defer to a follow-up agent**: A.22 says "see `BridgeOutputAdapter` source for the Map shape post-refactor". Agent infers from running tests.
    - Pros: No spec change.
    - Cons: Wave agents are not supposed to run tests (D.2 line ~1294).

#### D12 — `transmission-line.ts` segment sub-classes are excluded from F18 but file gets F1/F2/F3/F4/F7/F10/F15 (info)
- **Location**: §A.15 line ~595 ("Explicitly NOT in the refactor: ... `transmission-line.ts` segment sub-classes"), §B.5 line ~968
- **Problem**: A.15 excludes transmission-line segments from F18. But B.5 row applies F4 (factory signature) to the file. If the file contains both a top-level factory and segment sub-classes, F4 may be ambiguous about which gets the new signature. The spec doesn't specify.
- **Why decision-required**: The reasonable readings are: (1) F4 applies to the top-level factory only; the segment sub-classes are constructor-based and untouched; (2) F4 applies to every factory-like construction in the file, including segment sub-classes' constructors.
- **Options**:
  - **Option A — Clarify in B.5**: Edit the transmission-line.ts row to read: "F1, F2, F3, F4 (top-level factory only — segment sub-classes are excluded per A.15), F7 (2 makeVolt sites in a loop), F10, F15 (3 in-file `el.isReactive` predicates)".
    - Pros: Removes ambiguity.
    - Cons: Adds prose to a table cell.
  - **Option B — Add a clarification to F4's definition**: Edit F4 in §B's edit-codes table: "F4 | Factory signature → 3-arg `(pinNodes, props, getTime)` (A.3). Applies to top-level exported factories only. Sub-element classes inside the same file follow A.14 (class constructor takes `(pinNodes, props)`)."
    - Pros: Universal clarification.
    - Cons: Affects every B-row that uses F4.
  - **Option C — Do nothing**: Trust the agent to read A.15 and infer.
    - Pros: No spec change.
    - Cons: At ~3 files per agent and 50 parallel agents, "trust them to infer" produces inconsistent landings.

#### D13 — Class implementing pattern `private` vs `#` field (info)
- **Location**: §A.9 line ~218, §A.14 lines ~401-404, §A.8 line ~211
- **Problem**: A.14's class example uses `private _hPP = -1` (TypeScript-style `private` modifier, not JavaScript `#` private). A.9 says "Class-implementing elements use `private` class fields." A.8 just says "TSTALLOC handles are `private` class fields" without specifying syntax. Both `private _hPP` and `#hPP` qualify in casual reading. The spec should pick one to avoid wave-time inconsistency.
- **Why decision-required**: Both are valid TypeScript; the choice is a project convention. The reviewer can't determine the prevailing project convention without grepping the repo.
- **Options**:
  - **Option A — Lock to TypeScript `private`**: Add a one-liner to A.9: "Use the TypeScript `private` modifier, not JavaScript `#`-prefix syntax. (`private _h...` not `#h...`.)"
    - Pros: Matches A.14's example exactly.
    - Cons: TypeScript `private` is compile-time only — a `# `-prefix is harder-private at runtime.
  - **Option B — Lock to JavaScript `#`**: Edit A.14's example to use `#hPP`. Update A.9 prose accordingly.
    - Pros: Stronger encapsulation.
    - Cons: Changes A.14's working example. Wave agents who haven't read A.14 closely may use `private`.
  - **Option C — Accept either**: Add a clause to A.9 saying "either `private` modifier or `#` prefix is acceptable; do not mix within a single file."
    - Pros: Maximally permissive.
    - Cons: Allows inconsistency across the codebase.

#### D14 — `out-of-band` lane risk: realistic agent discipline (info)
- **Location**: §A.20 lines ~775-789, §A.18 lines ~684-688, §B.4 line ~955
- **Problem**: A.20 lists out-of-scope items and instructs agents to "leave them alone and surface them in the per-file report". A.18 reinforces this for PropertyBag. But B.4's variable-rail row shows the spec author already had to override the rule for one specific call site (D6 above). This suggests the boundary is porous in practice. A wave agent encountering an out-of-band issue that blocks tsc may face pressure to fix it — and the spec doesn't explicitly forbid in-line fixes that violate the out-of-band rule.
- **Why decision-required**: The CLAUDE.md "No Pragmatic Patches" rule says agents must implement "the cleanest final architecture" and not defer the real fix. The wave's parallel-execution model intrinsically requires deferral (out-of-band lanes). These are in tension.
- **Options**:
  - **Option A — Add a hard boundary clause to A.20**: "Wave agents MUST NOT touch out-of-band items even if doing so would resolve a tsc error or test failure in their assigned files. Out-of-band issues are documented in the per-file report; the convergence pass owns resolution."
    - Pros: Hard rule, removes pressure.
    - Cons: Conflicts with B.4 variable-rail (D6).
  - **Option B — Add a triage clause**: "If an out-of-band item blocks the agent from completing an assigned F-code, the agent stops, documents the block in the per-file report with status 'blocked', and moves on. The convergence pass triages."
    - Pros: Gives the agent an exit valve.
    - Cons: Could create an avalanche of 'blocked' reports.
  - **Option C — Accept the porousness**: Spec stays as-is. Wave agents use judgment.
    - Pros: No churn.
    - Cons: 50 parallel agents using judgment will reach 50 different conclusions.

#### D15 — F-code coverage of forbidden names: `withNodeIds` and `makeVoltageSource` (4-arg) (minor)
- **Location**: §A.1 (forbidden names), §B (F-code table)
- **Problem**: A.1 lists `withNodeIds` (test helper) and 4-arg `makeVoltageSource` as forbidden. F16 covers `withNodeIds`. F17 covers 4-arg `makeVoltageSource`. But §B.13 has many test rows with F1, F4, F16 — and the wave agent must apply BOTH F16 and F17 if the test file uses BOTH helpers. The spec doesn't say "F16 implies F17 in tests that use both". The current convention seems to be that F17 is only listed where the spec author already knew the file uses 4-arg `makeVoltageSource`. But a parallel agent doing F16 alone may overlook a 4-arg `makeVoltageSource` in the same file.
- **Why decision-required**: Coverage gap risk vs convention reading.
- **Options**:
  - **Option A — Audit B.13/B.14 and explicitly add F17 wherever applicable**: The spec author re-reads each test file and tags F17 where 4-arg `makeVoltageSource` appears.
    - Pros: Mechanical, complete.
    - Cons: Audit work for the spec author.
  - **Option B — Define F16 to subsume F17**: Edit F16 in §B's edit-codes table to read: "F16 | Rewrite test call sites: drop `withNodeIds` AND drop 4-arg `makeVoltageSource(...)`; construct via production factory + `setupAll` (A.19)." Delete F17.
    - Pros: One code, one rule. Wave agents apply both.
    - Cons: Conflates two distinct deletions.
  - **Option C — Add a Section C grep for `\bmakeVoltageSource\b` (already C15) but mandate that any file matching it must also have F17 listed**: Adds verification.
    - Pros: Catches drift.
    - Cons: Doesn't help the wave-time agent.

## Coverage Audit Summary

### Forbidden names in A.1 → Section C grep mapping

| A.1 forbidden name | C.1 grep | Status |
|---|---|---|
| `isReactive` | C1 | ✓ |
| `isNonlinear` | C2 | ✓ |
| `mayCreateInternalNodes` | C3 | ✓ |
| `getInternalNodeCount` | C4 | ✓ |
| `ReactiveAnalogElement` / `ReactiveAnalogElementCore` | C5 | ✓ |
| `internalNodeLabels` (field, JSDoc) | C12, C17 | ✓ |
| `allNodeIds` (field decl, type, ctor assignment) | C6, C9, C11 | ✓ |
| `pinNodeIds` (field decl, type, ctor assignment, `this.pinNodeIds[i]`) | C7, C8, C10 | ✓ |
| `stateBaseOffset` | C16 | ✓ |
| `withNodeIds` (test helper) | C14 | ✓ |
| 4-arg `makeVoltageSource` | C15 | ✓ |
| `nonlinearElements`, `reactiveElements`, `elementsWithLte`, `elementsWithAcceptStep` | C18 | ✓ |

**No coverage gaps in C.1 vs A.1.**

### C.2 required patterns → Section A contract source

| C.2 required pattern | A clause | Status |
|---|---|---|
| R1 `_pinNodes: new Map(pinNodes)` | A.4, A.13, A.14 | ✓ |
| R2 `label: ""` | A.11, A.13, A.14 | ✓ |
| R3 3-arg factory signature | A.3, A.13 | ✓ |
| R4 `getInternalNodeLabels()` returning recorded array | A.7, A.13 | ✓ |
| R5 `findBranchFor` on element factory | A.6 | ✓ |
| R6 `extends CompositeElement` | A.15 | ✓ |

**No coverage gaps in C.2 vs A.**

### CLAUDE.md "ngspice Parity Vocabulary" banned-word grep

Searched the spec for: `tolerance`, `equivalent`, `intentional divergence`, `close enough`, `pre-existing`, `partial`, `mapping table`. Hits:
- `partial` appears once (line 1267) as a literal status value in the per-file output format (§C.4: "Status: complete | partial | blocked"). This is a process status, not a closing verdict on a parity item — outside the rule's scope. Acceptable.
- No other banned words appear.

**Spec is clean of banned closing verdicts.**

---

Full report written to: spec/reviews/spec-setup-load-cleanup-general.md
