# Spec Review: Phase W0-W2 — Engine Contract (00-engine.md)

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 2 | 2 |
| major    | 1 | 4 | 5 |
| minor    | 2 | 1 | 3 |
| info     | 1 | 0 | 1 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| A0 — delete wrong-comment block at sparse-solver.ts:394-398 | yes | Spec §A0 correctly identifies path and intent |
| A1 — port expandable-matrix mechanism (EXPANDABLE/Translate/EnlargeMatrix/ExpandTranslationArrays) | yes | §A1.1–A1.9 cover all sub-tasks; field-renaming table, method bodies, tests all present |
| A2 — new SetupContext interface in setup-context.ts | yes | §A2 gives full interface with ngspice cross-refs |
| A3 — AnalogElementCore.setup declared; branchIndex mutable | yes | §A3 covers both; MnaModel field changes in §A3.1 |
| A4 — MNAEngine._setup() driver gate | yes | §A4.1–A4.3 specify init() strip, _setup() body, and driver entry sites |
| A5 — ckt-context.ts defer-buffer-alloc; matrixSize field deleted | yes | §A5.1–A5.4 cover constructor change, two new methods, field deletion, test migration |
| A6 — factory signature change; compiler strip-down | yes | §A6.1–A6.6 cover all sub-tasks |
| A7 — allocElement removal from load() — convention only | yes | §A7 specifies convention + verification grep |
| A8 — nodeset/icHandles setup-time allocation | yes | §A8 gives full code and field additions |
| A9 — setup-stamp-order.test.ts skeleton | yes | §A9 specifies path, structure, and gate |
| Plan exit criterion 11 — W2 stub setup() on every component | partial | §A3 states setup() must be added; the "stub throws" contract is stated only in plan.md, not in 00-engine.md. The spec file that implementers are told to read (00-engine.md) is silent on the stub body requirement. |

---

## Findings

### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | major | §A1.2, first paragraph | "Caller: `src/solver/analog/ckt-context.ts:537` (single site — confirm via `Grep` returning only this match before proceeding)." A grep of `_initStructure` across `src/` without path-scoping returns ~100 matches in test files (plus `complex-sparse-solver.ts` which has its own private method of the same name). An implementer running the grep as written will not get a single match and will be confused or may conclude the claim is wrong. `complex-sparse-solver.ts:278` calls its own private `_initStructure` — distinct from `SparseSolver._initStructure`. The grep command the spec implies is ambiguous. | Replace the paragraph with: "**Production caller:** `src/solver/analog/ckt-context.ts:537` (single site in production code — confirm via `Grep` scoped to `src/solver/analog/*.ts` excluding test files returning only this match before proceeding). Test callers that call `_initStructure(n)` with an explicit `n` are addressed in A1.9." |
| M2 | minor | §A4.3, parenthetical | "(The earlier spec listed `monteCarloRun` and `parameterSweep`. Those methods do not exist on `MNAEngine`…)" — This is historical-provenance prose ("the earlier spec") that `rules.md` explicitly forbids in a current-state contract. | Delete the parenthetical entirely. The sentence "Those methods do not exist on `MNAEngine`" is already captured in plan.md §Resolved decisions. |
| M3 | minor | §A7, first sentence | "ngspice has no runtime guard." This is present-tense explanation of a design decision, fine. However the paragraph ends with "The previous revision proposed a TypeScript-typed solver split. Dropped — it's invented machinery ngspice does not have." This is decision-history prose violating the current-state contract rule. | Delete the sentence "The previous revision proposed a TypeScript-typed solver split. Dropped — it's invented machinery ngspice does not have." |

### Decision-Required Items

#### D1 — `_translate` double-pushes `_insertionOrder` for a single `allocElement` call (critical)

- **Location**: §A1.5 `_translate` code listing, lines in the `intRow === -1` branch and the `intCol === -1` branch
- **Problem**: The spec's `_translate` implementation pushes `{ extRow, extCol }` to `_insertionOrder` in BOTH the row-new branch AND the col-new branch. When `allocElement(r, c)` is called with both r and c being first-seen external indices, two entries are pushed: `{ extRow: r, extCol: c }` (row branch) and again `{ extRow: r, extCol: c }` (col branch). Both entries carry the same `extRow`/`extCol` from the call site — not the index being assigned internally. This is structurally incorrect: when `c` is assigned its internal index in the col branch, the `extRow` stored is still `r` (the row from the call), not `c` (the external index actually being registered). The inserted pair `{ extRow: r, extCol: c }` in the col branch is therefore misleading — `c` has just been assigned an internal index as a row/col mapping, not as the `extCol` of a matrix element. The A9 test asserts that `_getInsertionOrder()` returns the TSTALLOC sequence position-for-position against ngspice — so the semantics of what one "entry" means must be unambiguous before implementing.
- **Why decision-required**: There are at least three semantically distinct choices for what `_insertionOrder` should track, each requiring a different A9 assertion strategy:
  - **Option A — One entry per `allocElement` call**: Push exactly one `{ extRow, extCol }` per `allocElement(r, c)` call, regardless of whether r and/or c are new. The push happens unconditionally at the top of `_translate`, before the row/col branches. This matches "TSTALLOC call order" — one TSTALLOC in ngspice `*setup.c` = one `allocElement` call = one entry. The A9 test checks that the sequence of `(r, c)` pairs equals the ngspice TSTALLOC sequence line-for-line.
    - Pros: Clean 1:1 mapping with TSTALLOC lines; A9 test is straightforward.
    - Cons: Does not capture which internal index was assigned to which external node; requires separate mechanism if internal-index order is also needed.
  - **Option B — One entry per new external-index encounter** (current spec intent, but with corrected `extRow`/`extCol` semantics): In the row-new branch push `{ extRow: extRow, extCol: extRow }` (the index being registered), and in the col-new branch push `{ extRow: extCol, extCol: extCol }`. This records the external index each time a new internal mapping is created. Two assignments per `allocElement(r, c)` when both are new.
    - Pros: Captures the full index-assignment trace.
    - Cons: The A9 test comparing against ngspice TSTALLOC becomes non-trivial: one TSTALLOC can produce 0, 1, or 2 entries depending on whether nodes are already assigned.
  - **Option C — Current spec as written (push `{ extRow, extCol }` in both branches)**: Preserves the call-site coordinates in both branches, producing potentially two identical entries per `allocElement` call when both indices are new.
    - Pros: No code change needed.
    - Cons: The push in the col branch always records `extRow` (the row from the *call*), not `extCol` (the index being assigned). This is a semantic mismatch: the col-branch push says "at this point I was processing (extRow, extCol)" but the assignment just made is for the external col index. When r ≠ c and both are new, the two entries are byte-identical `{ extRow: r, extCol: c }` — the second entry's data is not distinguishable from the first. If r == c, one branch short-circuits and only one push occurs, but the push in the surviving branch again records `{ r, r }`.

---

#### D2 — `_resetForAssembly` not specified to reset `_insertionOrder` (critical)

- **Location**: §A1.7, last sentence: "Reset by `_initStructure()` (per A1.2 above) and `_resetForAssembly()`."
- **Problem**: The spec states `_insertionOrder` is reset by both `_initStructure()` and `_resetForAssembly()`. §A1.2's `_initStructure()` listing includes `this._insertionOrder = [];` — correct. But `_resetForAssembly()` is never given a new body in this spec; the existing implementation at `sparse-solver.ts:1086-1102` has no mention of `_insertionOrder`. The spec must tell the implementer to add `this._insertionOrder = [];` to `_resetForAssembly()`, but it does not. A component-level test in A9 that calls `_setup()` more than once (e.g. via multiple driver calls) will see stale insertion-order data from previous calls if `_resetForAssembly()` does not reset the array.
- **Why decision-required**: Two options for how to specify this:
  - **Option A — Add explicit `_resetForAssembly` body change to §A1.6 (Loop-bound rewrite)**: Add a new §A1.6b or extend §A1.7 with: "Also add `this._insertionOrder = [];` to `_resetForAssembly()` at the top of that method, before the element-zero loop." This makes the implementer's task unambiguous.
    - Pros: Complete spec; implementer cannot miss it.
    - Cons: Adds a sentence to the spec.
  - **Option B — Note that `_insertionOrder` is only meaningful between `_initStructure` and the first `_resetForAssembly` call**: Clarify that the A9 test reads insertion order immediately after `_setup()` completes, before any `_resetForAssembly` has run (setup does not call `_resetForAssembly`). Under this interpretation, not resetting in `_resetForAssembly` is acceptable because the test never calls an NR iteration after setup. The §A1.7 "Reset by ... `_resetForAssembly()`" claim would be removed as incorrect.
    - Pros: Avoids changing `_resetForAssembly`.
    - Cons: The spec currently says it IS reset there — removing that claim changes the contract. Also leaves `_insertionOrder` growing unbounded across NR iterations in production (it's never actually reset after first use).

---

#### D3 — `_registeredMnaModels` field: source not specified (major)

- **Location**: §A4.2, "Engine state additions", last bullet: "`_registeredMnaModels: MnaModel[];` — set of all MnaModels in use; constructed in `init()` from `compiled` for `_findBranch` dispatch."
- **Problem**: `ConcreteCompiledAnalogCircuit` (defined in `src/solver/analog/compiled-analog-circuit.ts`) does not expose a `MnaModel[]` field. The compiled circuit has `elements: AnalogElement[]` and `models: Map<string, DeviceModel>`. `MnaModel` (in `src/compile/types.ts`) is a compiler-internal interface with a `factory` function; compiled `AnalogElement` instances are the factory's output, not the factory itself. There is no field or method on `ConcreteCompiledAnalogCircuit` from which an implementer can recover the list of `MnaModel` instances. The spec does not say where to get this list.
- **Why decision-required**: Multiple valid approaches exist:
  - **Option A — Pass MnaModel[] through `ConcreteCompiledAnalogCircuit`**: Add a new field `mnaModels: MnaModel[]` to `ConcreteCompiledAnalogCircuit`, populated by the compiler's stamp loop. Each element's model is already available there. This is the cleanest approach but requires a compiler change that is not mentioned in A6.
    - Pros: Single source of truth; type-safe.
    - Cons: Expands the compiled circuit's surface area; requires A6 spec amendment.
  - **Option B — Derive `_registeredMnaModels` from element types at `init()` time**: Walk `compiled.elements`, extract the `MnaModel` for each element via some element-to-model mapping stored at compile time. Requires specifying where elements store their model reference.
    - Pros: No change to `ConcreteCompiledAnalogCircuit`.
    - Cons: `AnalogElement` has no `model` field today; adding one widens the element interface.
  - **Option C — Inline `_findBranch` without `_registeredMnaModels`**: Instead of walking registered models, walk `compiled.elements` directly and check `element.findBranchFor?.(label, ctx)` if `AnalogElement` gains a `findBranchFor` method. Eliminates the need for `_registeredMnaModels` entirely.
    - Pros: Simpler; no new compiled-circuit field needed.
    - Cons: Couples `findBranch` dispatch to the element interface rather than the model interface; diverges from the `CKTfndBranch` pattern which walks model types, not instances.

---

#### D4 — `allocateStateBuffers` references `this._poolBackedElements` which does not exist (major)

- **Location**: §A5.1, `allocateStateBuffers` method body, line: `for (const el of this._poolBackedElements) {`
- **Problem**: `_poolBackedElements` does not exist as a field on `CKTCircuitContext` anywhere in the codebase. A grep of the entire `src/` tree for `_poolBackedElements` returns zero results. The existing code in `analog-engine.ts` achieves the same goal by calling `isPoolBacked(el)` inline on `this._elements` at multiple points. The spec's `allocateStateBuffers` method is a method on `CKTCircuitContext`, not on `MNAEngine`, so it cannot access `this._elements` from the engine. The spec gives no instruction for how `CKTCircuitContext` should learn which elements are pool-backed.
- **Why decision-required**: Multiple valid approaches:
  - **Option A — Add `_poolBackedElements: readonly AnalogElement[]` field to `CKTCircuitContext`**: Populated at construction time by filtering `circuit.elements` with `isPoolBacked`. The constructor already has `elements` available. The `allocateStateBuffers` body then works as written.
    - Pros: Matches the spec's code exactly; self-contained in ckt-context.ts.
    - Cons: Adds a new field to `CKTCircuitContext`; requires the A5.1 constructor section to specify this field's initialization.
  - **Option B — Move `initState` calls to `MNAEngine._setup()` after calling `allocateStateBuffers`**: `allocateStateBuffers(numStates)` only constructs the `StatePool`; `MNAEngine._setup()` then iterates `this._elements`, checks `isPoolBacked`, and calls `el.initState(statePool)`. Removes the dependency on `_poolBackedElements` from `CKTCircuitContext`.
    - Pros: `MNAEngine` already uses `isPoolBacked` and has `_elements`; no new field on `CKTCircuitContext`.
    - Cons: The spec's `allocateStateBuffers` body must be revised; the `initState` loop moves out of `CKTCircuitContext`.

---

#### D5 — A9 test calls `_setup()` which is declared `private` (major)

- **Location**: §A9, "run only `MNAEngine.init()` + `_setup()` (no NR call)"
- **Problem**: §A4.2 declares `_setup()` as `private`. TypeScript enforces private method access at compile time — a test file cannot call `engine._setup()` directly. The spec gives no guidance for how the test invokes this method. The test must either (a) trigger `_setup()` indirectly via a driver method (e.g. `dcOperatingPoint()`), (b) cast `engine` to `any`, or (c) have `_setup()` declared with a less-restrictive modifier (e.g. `_setup()` with a leading underscore as a "protected by convention" rather than `private`). The choice has consequences: if `dcOperatingPoint()` is used, the test must not reach NR iteration (it must stub or the circuit must solve in 0 iterations), making the "no NR call" requirement harder to guarantee.
- **Why decision-required**: Multiple valid approaches:
  - **Option A — Use `(engine as any)._setup()` in the test**: The test casts to `any` to bypass TypeScript privacy. Common pattern for testing private methods.
    - Pros: No change to production code; test is explicit about what it's doing.
    - Cons: Loses type safety in the test; if `_setup` is renamed, the test silently becomes a no-op.
  - **Option B — Trigger `_setup()` via `dcOperatingPoint()` with a trivially-converging circuit**: The test calls `engine.dcOperatingPoint()` which invokes `_setup()` as its first act. The minimal circuit (one resistor + voltage source + ground) will converge, but the insertion order is captured after setup, before any NR iteration modifies it.
    - Pros: Uses the public API; no casting.
    - Cons: The insertion order is captured from `_getInsertionOrder()` after `_setup()` has run but the same `_getInsertionOrder()` must be read before `_resetForAssembly()` runs (the first NR iteration would reset it per D2 above). This requires D2 to be resolved first.
  - **Option C — Change `private _setup()` to `/** @internal */ _setup()`**: Removes TypeScript private enforcement while keeping the underscore convention. Tests can call it directly.
    - Pros: No casting; test is safe.
    - Cons: Exposes `_setup()` on the public type signature.

---

#### D6 — W2 stub `setup()` body requirement is absent from 00-engine.md (major)

- **Location**: §A3, the `setup()` declaration; Plan exit criterion 11
- **Problem**: Plan exit criterion 11 states: "W2 stub for every component: every component file has a `setup()` method whose body is `throw new Error(\`PB-\${name} not yet migrated\`)`." This is a concrete, testable requirement for the W2 deliverable. The plan's reading guide says "W2: read `00-engine.md` §A2–A9 line-for-line." But §A3 only declares `setup()` as a required method on `AnalogElementCore` — it gives the JSDoc comment and the signature, but does not specify that every existing component must immediately get a stub body when A3 is implemented. An implementer reading only 00-engine.md will add `setup()` to the interface, will not know that every component file also needs a stub throwing `"PB-${name} not yet migrated"`.
- **Why decision-required**: Two options:
  - **Option A — Add a new §A3.2 "Component stubs"** to 00-engine.md specifying: "For every file in `src/components/` that exports an `AnalogElementCore`, add a `setup(ctx)` method whose body is `throw new Error(\`PB-\${name} not yet migrated\`)` where `name` is the component's class or label string. This stub is the W2 gate: it makes the component loud-fail on any `_setup()` call until W3 replaces the body."
    - Pros: Self-contained; implementer reading only 00-engine.md knows the full W2 requirement.
    - Cons: Adds content to the spec; may duplicate plan.md §Exit criteria.
  - **Option B — Add a cross-reference at §A3** to plan.md §Exit criterion 11: "After adding `setup()` to `AnalogElementCore`, add placeholder stubs to every component per `plan.md` §Exit criterion 11."
    - Pros: Minimal spec change; defers to plan.md for the exact stub text.
    - Cons: Implementers must cross-reference plan.md even though the reading guide says W2 implementers read 00-engine.md line-for-line.

---

### Additional Notes (Info)

#### I1 — ngspice citations verified (info)

Three spot-checked citations are correct:
- `spconfig.h:207` → `#define EXPANDABLE YES` — verified at line 207 (offset 200, line 7 in the file).
- `spconfig.h:336-337` → `MINIMUM_ALLOCATED_SIZE 6` / `EXPANSION_FACTOR 1.5` — verified at lines 336-337.
- `spbuild.c:436-504` → `Translate` function — verified: function starts at line 436, ends at line 504.
- `spbuild.c:957-1019` → `EnlargeMatrix` — verified: starts 957, ends 1019.
- `spbuild.c:1047-1081` → `ExpandTranslationArrays` — verified: starts 1047, ends 1081.
- `spsmp.c:249-257` → `SMPnewMatrix → spCreate(0, 1, &Error)` — verified: `spCreate(0, 1, &Error)` at line 255.
- `cktsetup.c:52-53` → `if (ckt->CKTisSetup) return E_NOCHANGE;` — verified at lines 52-53.
- `vsrcfbr.c:26-39` → `if(here->VSRCbranch == 0) { CKTmkCur(...) }` — verified. File is 37 lines; guard at lines 27-30. The spec cites `:26-39` but the file ends at line 37. The cite is off by 2 lines at the end; the guard itself is real and correct. This is a minor inaccuracy in the end-line number only.
- `cktfbran.c:20-33` → `CKTfndBranch` loop — verified: function body at lines 20-33. Correct.

No banned closing verdicts found in the spec text.

---

## Summary of Blocking Issues Before Implementation

The two critical items (D1, D2) must be resolved before the A1.5 and A1.7 implementations begin, as they define the core semantics of `_insertionOrder` that the A9 test will assert against. The three major decision-required items (D3, D4, D5) block A4.2, A5.1, and A9 respectively and need decisions before those sections are implemented. D6 (major) blocks W2 completion because an implementer reading only this spec will not add the required stubs to component files.

The three mechanical fixes (M1, M2, M3) can be applied without decisions and should be applied before any W1/W2 implementation agent reads the spec.
