# Spec Review: Master Plan — setup-load-split

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 0 | 2 | 2 |
| minor    | 3 | 2 | 5 |
| info     | 1 | 1 | 2 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| W0 — A0 wrong-comment delete | yes | §A0 in 00-engine.md; exit criterion 1 matches. |
| W1 — A1 SparseSolver expandable matrix | yes | §A1.1–A1.9 in 00-engine.md; exit criterion 2 matches. |
| W2 — A2–A9 engine restructure | yes | §A2–A9 in 00-engine.md; exit criteria 3–11 match. |
| W3 — 74 per-component PB-*.md tasks | yes | 74 files confirmed. W3 gate defined; PB-TLINE blocker documented. |
| W4 — parity sweep | yes | Gate defined; 8 fixtures named. |
| PB-TLINE open blocker | yes | Three options presented with trade-offs; user decision required. |
| PB-BEHAV-SEVENSEGHEX implementer note | yes | Marked NOT blocking; verified at W3. |

## Findings

### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | minor | plan.md §Resolved-decisions table, row "findBranch mechanism" | Cites `vsrc/vsrcfbr.c:26-39`. Actual file is 37 lines; lines 38–39 do not exist. The guard block is lines 27–31; closing `return(0)` is line 36; file ends at line 37. | Change `vsrc/vsrcfbr.c:26-39` → `vsrc/vsrcfbr.c:23-37`. |
| M2 | minor | plan.md §Wave plan W4 gate | Exit criterion reads "first-iteration matrix-entry assertion at `comparison-session.ts:2688` passes for every fixture." A hard-coded line number is a brittle reference — any edit that adds/removes lines before that point silently invalidates the criterion without touching the plan. | Replace "`comparison-session.ts:2688`" with a stable anchor: name the assertion by its surrounding function or describe the assertion's observable behaviour (e.g., "the per-element matrix-entry comparison assertion in `comparison-session.ts::assertFirstIterationMatrixEntries` passes"). |
| M3 | minor | plan.md §Engine-wave exit criteria, item 8 | "grep `allocElement` in `src/components/` returns only setup() sites." `grep` is a manual shell command, not an automated gate. The exit criterion cannot be verified by a CI run. | Replace with a reference to the test that enforces this: "After W2, running `npm run test:q` produces no failures in `sparse-expandable.test.ts`; additionally, the `A7-convention` check in `setup-stamp-order.test.ts` asserts no component calls `allocElement` from `load()`." (Or, if no such test exists, file a Decision-Required item about how to automate this gate — see D2.) |

### Decision-Required Items

#### D1 — W3 gate does not cover MCP or E2E surfaces (major)

- **Location**: plan.md §Wave plan, W3 gate column
- **Problem**: The W3 gate reads: "Per-component gates: `setup-stamp-order.test.ts` row green for that component; component's own test file green." This specifies only unit/integration test coverage. CLAUDE.md "Three-Surface Testing Rule" requires every user-facing feature to be tested across headless API, MCP tool, and E2E/UI surfaces. The plan's W3 gate is silent on MCP and E2E verification.
- **Why decision-required**: Whether MCP and E2E re-runs are required per-component (74 × 3 surfaces = 222 checks), or only for a representative subset, or only at W4 as a batch gate, is a sequencing and resourcing decision. There is also a question of whether the setup/load split is observable at the MCP or E2E surface at all (if all changes are internal, the three-surface rule may be satisfied by existing E2E tests remaining green rather than new per-component E2E assertions).
- **Options**:
  - **Option A — Explicit three-surface gate per component**: Amend the W3 gate to add: "MCP tool test for the component passes (circuit_compile + circuit_dc_op round-trip); component appears correctly in E2E harness smoke test." Each W3 agent must verify all three surfaces before marking the row green.
    - Pros: Fully satisfies CLAUDE.md three-surface rule; catches serialization regressions per component immediately.
    - Cons: Significantly increases W3 agent scope; 74 components × 3 surfaces is a large surface area; some components may not have standalone MCP or E2E tests today.
  - **Option B — Batch three-surface gate at W4**: W3 gate remains as-is (unit/integration only). W4 adds an explicit three-surface gate: all parity fixtures green on headless + MCP round-trip + E2E smoke pass before W4 is declared complete.
    - Pros: Keeps per-component W3 agents lean and parallelisable; three-surface verification happens once all stubs are replaced.
    - Cons: A per-component MCP regression is not caught until W4, which may require re-opening W3 agents.
  - **Option C — Acknowledge existing E2E as sufficient, document rationale**: Add a note to the plan explaining that the setup/load split is an internal refactor (no new API surface) and that the existing E2E suite, if green at W4, constitutes three-surface verification. Reference the specific E2E fixtures that exercise each component category.
    - Pros: Least additional work; honest about the internal nature of the change.
    - Cons: Requires confirming that current E2E fixtures actually exercise every component category; if any component category has no E2E coverage, the argument fails.

---

#### D2 — A7 "no allocElement from load()" convention is unverifiable by any automated test (major)

- **Location**: plan.md §Engine-wave exit criteria item 8; 00-engine.md §A7
- **Problem**: Exit criterion 8 states: "grep `allocElement` in `src/components/` returns only setup() sites." 00-engine.md §A7 repeats: "Verification: after wave-2 lands, Grep `allocElement` src/components/ returns only matches inside `setup()` method bodies." Both rely on a manual `grep` invocation. This is not a test — it cannot be run in CI, cannot produce a red row in `setup-stamp-order.test.ts`, and cannot be verified by the verifier agent without a human running a shell command.
- **Why decision-required**: Enforcing the "no allocElement from load()" convention could be done several ways (static lint rule, a dedicated test, a TypeScript-level split of the solver API). Each has different implementation cost and fits differently into the W2 scope vs. a separate follow-on task.
- **Options**:
  - **Option A — Add a dedicated convention-enforcement test in `setup-stamp-order.test.ts`**: The test imports each component file, instantiates the element (with stubs for missing deps), calls `load()`, and asserts `solver.allocElement` was not called (mock the solver). This runs in CI automatically.
    - Pros: Fully automated; catches regressions immediately; fits within W3/W4 gate naturally.
    - Cons: Requires mocking the solver in each component's test setup; adds test infrastructure.
  - **Option B — TypeScript solver split (the approach the spec explicitly dropped)**: Provide a `SetupSolver` type (with `allocElement`) used only during `setup()`, and a `LoadSolver` type (without `allocElement`) used during `load()`. TypeScript compile errors enforce the convention.
    - Pros: Zero runtime cost; enforcement is compile-time; matches how ngspice enforces the split by file separation.
    - Cons: 00-engine.md §A7 explicitly says this approach was "dropped — it's invented machinery ngspice does not have." Reintroducing it contradicts the documented decision.
  - **Option C — Keep the manual grep as a human-run pre-merge check, document it explicitly as such**: Amend exit criterion 8 to say "Pre-merge reviewer runs `Grep 'allocElement' src/components/ output_mode=content` and confirms all matches are inside `setup()` bodies. This is a human-reviewed gate, not an automated test."
    - Pros: No new test infrastructure; honest about the manual nature; consistent with 00-engine.md §A7's documented rationale.
    - Cons: Cannot be enforced in CI; relies on reviewer discipline; a component that slips through would not be caught until parity tests fail in W4.

---

#### D3 — `_registeredMnaModels` population mechanism is unspecified (minor)

- **Location**: plan.md §Engine-wave exit criteria (implicitly, via A6); 00-engine.md §A4.2 engine state additions
- **Problem**: 00-engine.md §A4.2 introduces `_registeredMnaModels: MnaModel[]` with the note "set of all MnaModels in use; constructed in `init()` from `compiled`." It does not specify how MnaModels are extracted from the compiled circuit. The `_findBranch` dispatch walks `this._registeredMnaModels` to find `findBranchFor` callbacks. An implementer must know: (a) where MnaModel instances live in the compiled circuit structure, (b) whether to deduplicate (same model type, multiple instances), and (c) whether to include behavioral models whose `findBranchFor` is undefined.
- **Why decision-required**: Multiple plausible implementations exist — derive from `compiled.elements` map (one MnaModel per element), derive from a static model registry (one MnaModel per type), or derive from both. Each produces a different `_registeredMnaModels` set and different `_findBranch` behaviour on duplicate labels.
- **Options**:
  - **Option A — One MnaModel per element instance**: `_registeredMnaModels = compiled.elements.map(el => el.model)`. Each element carries its model; duplicates allowed. `_findBranch` may call multiple `findBranchFor` on the same model type.
    - Pros: Simple to derive; no separate registry needed.
    - Cons: Duplicate `findBranchFor` calls for multi-instance circuits; first-non-zero-wins semantics still correct but slightly wasteful.
  - **Option B — One MnaModel per distinct type**: Deduplicate by model identity (`new Set(compiled.elements.map(el => el.model))`). `_findBranch` dispatches to each model type once.
    - Pros: Mirrors ngspice's `CKTfndBranch` which walks model *types* (`GENmodel` linked list), not instances.
    - Cons: Requires deduplication logic; implementer must know MnaModel equality semantics.

---

### Info Items

#### I1 — `_doCmplxDirect` not listed in `_enlargeMatrix` zeroing (info)

- **Location**: 00-engine.md §A1.3 `_enlargeMatrix` implementation
- **Observation**: ngspice `EnlargeMatrix` (spbuild.c:1000-1006) frees both `DoRealDirect` and `DoCmplxDirect`. The spec's `_enlargeMatrix` body zeros `_doRealDirect` but does not mention `_doCmplxDirect`. If digiTS has or adds a `_doCmplxDirect` field (for AC analysis complex matrix support), it would be silently missed by the ported `_enlargeMatrix`. The plan makes no mention of this field.
- **Note**: This may be intentional if digiTS does not implement complex-matrix direct solve. If so, a one-line comment in the spec would clarify the omission is deliberate.

#### I2 — Element pool architecture not flagged as divergence (info)

- **Location**: 00-engine.md §A1.2 `_initStructure`, comment "Element pool sized 6 * AllocatedSize per spalloc.c:263-264"
- **Observation**: ngspice's `spCreate` uses `InitializeElementBlocks` (a linked-block allocator) for its element pool; the spec ports this to flat `Int32Array` fields (`_elRow`, `_elCol`, `_elVal`, etc.). This is a structural architectural divergence from the ngspice element pool design. The plan's resolved-decisions table documents other architectural choices (e.g., element pool was already flat before this spec), but this divergence is not listed. Per CLAUDE.md, accepted divergences belong in `spec/architectural-alignment.md` or the resolved-decisions table with rationale. The absence of documentation could confuse a future reviewer comparing the code against spalloc.c.
- **Note**: If the flat-array pool pre-dates this spec and is already accepted, adding a one-line entry to the resolved-decisions table ("Element pool implementation: flat Int32Array vs. ngspice linked-block allocator — pre-existing architectural choice, not addressed by this spec") would close the documentation gap.
