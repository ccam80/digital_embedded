# Spec Review: Combined Report

## Overall Verdict: needs-revision

## Per-Phase Verdicts
| Phase | Verdict | Coverage Gaps | Consistency | Completeness | Concreteness | Implementability |
|-------|---------|---------------|-------------|--------------|--------------|------------------|
| 1 — Domain Leak Fix | needs-revision | 4 | 6 | 11 | 7 | 8 |

## Cross-Phase Issues

N/A — single spec, no cross-phase analysis needed.

### Shared File Conflicts
None found (single spec).

### Phase Dependency Violations
None found (single spec).

### Duplicate Tasks
None found (single spec).

### Unaddressed Verification Measures
N/A — no plan.md with verification measures.

## Per-Phase Details

### Critical Issues (from review agent + coordinator cross-checks)

**1. 11 solver diagnostic codes missing from unified `DiagnosticCode` union**
- **Location:** `src/compile/types.ts` — Diagnostic type code block
- **Problem:** The spec's proposed `DiagnosticCode` union omits 11 codes from `SolverDiagnosticCode`: `model-param-ignored`, `model-level-unsupported`, `bridge-inner-compile-error`, `bridge-unconnected-pin`, `bridge-missing-inner-pin`, `bridge-indeterminate-input`, `bridge-oscillating-input`, `bridge-impedance-mismatch`, `transmission-line-low-segments`, `reverse-biased-cap`, `fuse-blown`. Deleting `SolverDiagnostic` without migrating all codes silently drops diagnostics the solver currently emits.
- **Verified:** `SolverDiagnosticCode` at `src/core/analog-types.ts:161-202` contains all listed codes.

**2. `AcResult.diagnostics: SolverDiagnostic[]` not updated**
- **Location:** `src/core/analog-types.ts:299`
- **Problem:** The spec deletes `SolverDiagnostic` but `AcResult` (same file) uses it. Will break compilation. Spec does not mention `AcResult`.
- **Verified:** `AcResult` confirmed at line 287-300 with `diagnostics: SolverDiagnostic[]`.

**3. `involvedPositions` field missing from unified `Diagnostic` type definition**
- **Location:** `src/compile/types.ts` Diagnostic code block vs. `src/compile/extract-connectivity.ts` section and `src/app/render-pipeline.ts` section
- **Problem:** `extract-connectivity.ts` section says diagnostics carry `involvedPositions: Point[]`. `render-pipeline.ts` section reads `involvedPositions`. But the `Diagnostic` type definition code block does not include this field. Two spec sections require a field the type definition omits.
- **Verified:** Current `Diagnostic` at `src/compile/types.ts:49-66` has no `involvedPositions`.

**4. No wave ordering for deeply interdependent changes**
- **Location:** Entire spec — "single parallel burst"
- **Problem:** Dependencies require ordering: `Diagnostic` type unification → `compile.ts` pass-through; `netlist-types.ts` reshape → `netlist.ts` rebuild; `compile/types.ts` `labelToCircuitElement` addition → `default-facade.ts` `setSignal` routing; `facade.ts` renames → `executor.ts`/`equivalence.ts` updates.
- **Suggestion:** Split into 3-4 waves: (W1) type foundations — Diagnostic merge, netlist-types reshape, compile/types additions; (W2) algorithm rebuilds — netlist.ts, extract-connectivity.ts, compile.ts pass-through; (W3) API surface — facade renames, settle, setSignal, executor/parser; (W4) consumers — formatters, MCP tools, postmessage, render-pipeline, rename-only files.

**5. `settle()` opts parameter completely unspecified**
- **Location:** `src/headless/facade.ts` + `default-facade.ts` section
- **Problem:** No type definition for `opts`, no field name, no default value (inventory mentions 10ms but spec does not repeat it). Implementer cannot write method signature.

**6. Three-surface testing rule violated (CLAUDE.md hard rule)**
- **Location:** Multiple sections
- **Problem:** No E2E tests specified for: postMessage protocol rename, `settle()`, analog test vectors, `circuit_compile` analog suggestions, `circuit_list` pin display, render-pipeline overlay changes, equivalence vacuous fix. No MCP integration tests for tool output changes.
- **Verified:** CLAUDE.md explicitly states "All three surfaces are non-negotiable."

**7. `builder.ts` listed in both logic-change section and rename-only section**
- **Location:** `src/headless/builder.ts` section vs. "Files with rename-only changes"
- **Problem:** The dedicated section deletes `validatePinConnection` and bit-width checks (logic changes). The rename-only section re-lists builder.ts. Contradiction.

**8. `setSourceByLabel` vs `setSignal` routing — two conflicting designs**
- **Location:** `src/solver/coordinator.ts` section vs. `src/headless/facade.ts` section
- **Problem:** Coordinator section defines `setSourceByLabel(label, paramKey, value)`. Facade section says `setSignal` calls `coordinator.setComponentProperty` directly. Spec doesn't clarify whether `setSignal` calls `setSourceByLabel` or `setComponentProperty` directly.

**9. `render-pipeline.ts` import path not specified**
- **Location:** `src/app/render-pipeline.ts` section
- **Problem:** Currently imports `SolverDiagnostic` from `../core/analog-engine-interface.js` (confirmed at line 16). That file is not in the spec's modification list. After deleting `SolverDiagnostic`, both `analog-engine-interface.ts` and `render-pipeline.ts` need import path changes — spec only addresses `render-pipeline.ts` type change.

**10. Line number inaccuracies**
- **Location:** Multiple sections
- **Problem:** `labelTypesPartition` referenced at line 925 but actually at line 938. Spec references `compiler.ts:924-931` but actual range is `938-944`. `builder.ts:280` width check actually starts at line 280 (correct). Minor issue but causes implementer friction.

### Inventory Coverage (4 gaps)

| Gap | Status |
|-----|--------|
| Finding #10 — `PinDescriptor.direction`/`bitWidth` kept unconditionally | Spec adds `domain` but retains digital-only fields without explicit justification |
| Finding #24 — `formatComponentDefinition` scaling-pin detection | Dismissed with "no changes needed" — should justify |
| Findings #18/#19 — `circuit_describe_file` description vs. deletion | Spec deletes tool (valid but diverges from inventory recommendation without explanation) |
| Finding #29 — `validatePinConnection` heuristic | Deleted (valid but no justification for deletion over fix) |
