# Review Report: Wave 2 — Pipeline Reorder

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 2 (W2.1, W2.2) |
| Violations | 4 |
| Gaps | 1 |
| Weak tests | 2 |
| Legacy references | 1 |
| **Verdict** | **has-violations** |

---

## Violations

### V1 — Historical-provenance comment (major)

**File:** `src/solver/analog/compiler.ts:1949`
**Rule:** rules.md — "No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned."
**Evidence:**
```
 * The existing `compileAnalogCircuit()` continues to work unchanged.
```
This sentence, in the JSDoc block for `compileAnalogPartition`, explicitly describes the relationship between old and new code. It is a historical-provenance comment. The comment was added (or retained) to justify that the old function was left intact. The rule bans this regardless of intent.
**Severity:** major

---

### V2 — Trivially-true test assertion (critical)

**File:** `src/__tests__/diag-rc-step.test.ts:54`
**Rule:** rules.md — "Tests ALWAYS assert desired behaviour." / reviewer.md — "Test assertions that are trivially true (e.g. `assert result is not None`, `assert isinstance(x, dict)` without checking contents)"
**Evidence:**
```typescript
expect(true).toBe(true);
```
This test calls `resolveModelAssignments` and `compileUnified`, prints extensive `console.log` output, then asserts nothing. The entire assertion is `expect(true).toBe(true)` — it can never fail. This test was listed in the W2.1 progress entry as a modified file ("removed obsolete third `'analog'` argument from `resolveModelAssignments` call") but the test body asserts only a tautology. It does not verify any desired behaviour of the pipeline reorder.
**Severity:** critical

---

### V3 — `SIMULATION_MODE_LABELS` not removed (major)

**File:** `src/editor/property-panel.ts:23-27`
**Rule:** spec/model-unification.md dead-code removal table — "`SIMULATION_MODE_LABELS` | `property-panel.ts:23-27` | Replaced by model-name-based labels"
**Evidence:**
```typescript
const SIMULATION_MODE_LABELS: Record<string, string> = {
  "logical": "Digital",
  "analog-pins": "Analog (at pins)",
  "analog-internals": "Analog (full)",
};
```
The spec explicitly lists `SIMULATION_MODE_LABELS` as dead code to be removed in the "What Gets Removed" section. The labels map old sub-mode string values (`logical`, `analog-pins`, `analog-internals`) which are themselves dead values under the renamed key system. This is still in production code at line 278 and still referenced at `property-panel.ts:278`. Note: The spec assigns this removal to Wave 7 UI work — however, the spec's "What Gets Removed" table lists it unconditionally. This is noted as a gap between wave scoping and the removal table; see Gaps section.
**Severity:** major

---

### V4 — Sub-mode routing comment uses historical-context framing (minor)

**File:** `src/compile/extract-connectivity.ts:76-81`
**Rule:** rules.md — "No historical-provenance comments."
**Evidence:**
```typescript
// The simulationModel property may hold sub-mode values (e.g. "analog-pins",
// "logical", "analog-internals") that are NOT model registry keys — they are
// read by the analog compiler internally. When a sub-mode value is set and
// the component has an analog model, assign "analog" so the component is
// routed to the analog partition. Only treat the property value as a model
// key when it actually exists in def.models.
```
The phrase "they are read by the analog compiler internally" describes a relationship to pre-existing code behaviour rather than explaining the algorithm to future developers. The mention of "analog-pins", "logical", "analog-internals" by name is historical context — these are old mode values retained for backwards compatibility. Per the spec Migration section (line 960): "Old mode names (logical, analog-pins, analog-internals): deleted. Replaced by named model keys." Retaining them here and documenting them in a code comment signals that backward compatibility was maintained rather than deleted. This is a bannable historical-provenance comment pattern.
**Severity:** minor

---

## Gaps

### G1 — Three-surface testing requirement not met for Wave 2 pipeline reorder

**Spec requirement:** `spec/model-unification.md:931-934` (Waves 2-4 three-surface testing):
> 1. **Headless:** Mixed-circuit compilation with per-instance model overrides. Subcircuit flattening with cross-engine boundaries from resolved models.
> 2. **MCP:** `circuit_compile` for mixed circuits returns both partitions.
> 3. **E2E:** Circuit with dual-model component, change model dropdown, verify correct partition.

**What was actually found:**
- Surface 1 (Headless): `src/solver/digital/__tests__/flatten-pipeline-reorder.test.ts` — present and covers the required scenarios.
- Surface 2 (MCP): No MCP test file was created or modified for Wave 2. No test exercises `circuit_compile` for mixed circuits with cross-engine boundaries via MCP tool handlers.
- Surface 3 (E2E): No E2E test file was created or modified for Wave 2. The E2E search for `flattenCircuit`, `resolveModelAssignments`, `per-instance`, `cross-engine`, and `analog-wins` across `e2e/` returned zero results.

**CLAUDE.md (Hard Rules):** "Every user-facing feature MUST be tested across all three surfaces... A feature can work headless but break in MCP serialization, or work in MCP but fail in the browser. All three surfaces are non-negotiable."

The pipeline reorder changes the compilation contract (models resolve before flattening; cross-engine boundary detection now uses pre-resolved model assignments). MCP and E2E surfaces are untested for these changes.
**File:** `spec/progress.md` — W2.2 task lists only `src/solver/digital/__tests__/flatten-pipeline-reorder.test.ts` as the test file; no MCP or E2E test files listed.

---

## Weak Tests

### WT1 — `diag-rc-step.test.ts` — tautological assertion

**Test path:** `src/__tests__/diag-rc-step.test.ts::RC XML partition diagnostics::check model assignments and partition`
**What's wrong:** The test runs the entire pipeline (`resolveModelAssignments`, `compileUnified`) and then asserts `expect(true).toBe(true)`. This is always-passing by definition regardless of what the pipeline does. The test name implies partition diagnostic verification but verifies nothing. All observable behaviour is only logged to `console.log`.
**Evidence:**
```typescript
    expect(true).toBe(true);
```

---

### WT2 — `flatten-pipeline-reorder.test.ts::per_instance_override` — no assertion on `internalEngineType`

**Test path:** `src/solver/digital/__tests__/flatten-pipeline-reorder.test.ts::FlattenPipelineReorder::per_instance_override`
**What's wrong:** The test asserts `crossEngineBoundaries[0]!.outerEngineType` is `"analog"` but does NOT assert `internalEngineType`. The internal circuit contains a `DualGate` (dual-model component). When `simulationModel="digital"` is set as a per-instance override, the internalDomain computed by `domainFromAssignments` for the internal circuit will be "auto" (no leaf elements with a resolved model key since `DualGate` isn't registered in the internal circuit's registry call — `resolveModelAssignments` treats unregistered components as neutral). The test should verify `internalEngineType` to confirm the boundary record is fully correct.
**Evidence:**
```typescript
    expect(crossEngineBoundaries).toHaveLength(1);
    expect(crossEngineBoundaries[0]!.subcircuitElement).toBe(subEl);
    expect(crossEngineBoundaries[0]!.outerEngineType).toBe("analog");
    // internalEngineType not asserted
```

---

## Legacy References

### LR1 — Old sub-mode values retained as named constants in production code comment

**File:** `src/compile/extract-connectivity.ts:77`
**Evidence:**
```typescript
// The simulationModel property may hold sub-mode values (e.g. "analog-pins",
// "logical", "analog-internals") that are NOT model registry keys
```
Per spec Migration section (model-unification.md:960): "Old mode names (logical, analog-pins, analog-internals): deleted. Replaced by named model keys (digital, behavioral, cmos). No mapping layer." These names appear here documented as still-supported values that receive special routing treatment. The sub-mode routing logic in `extract-connectivity.ts:92-98` is a backwards-compatibility shim that keeps old mode values functional by silently routing them to "analog". This is exactly the kind of "fallback" and "backwards compatible" pattern that rules.md bans: "No fallbacks. No backwards compatibility shims. No safety wrappers."

The shim itself (lines 91-98) constitutes a legacy reference — it handles stale property values that should have been migrated away in Wave 0 when all 117 `simulationMode` occurrences were renamed.

---

## Notes on Wave Scoping

The following items are NOT flagged as violations because they are explicitly scheduled for future waves:

- `extractDigitalSubcircuit()` (lines 322-453 of `compiler.ts`) — scheduled for Wave 3 deletion
- `resolveCircuitInput()` (lines 654-699 of `compiler.ts`) — scheduled for Wave 3 deletion
- `compileAnalogCircuit()` (lines 1182+ of `compiler.ts`) — scheduled for Wave 3 deletion
- H2-H15 heuristic sites (`hasAnalogModel`/`hasDigitalModel` usage) — scheduled for Wave 4

These are in scope for future review.
