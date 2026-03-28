# Spec Review: Combined Report — model-unification.md

## Overall Verdict: needs-revision

## Per-Wave Verdicts
| Wave | Verdict | Consistency | Completeness | Concreteness | Implementability |
|------|---------|-------------|--------------|--------------|------------------|
| 0 — Bug fixes | needs-revision | 0 | 1 | 0 | 0 |
| 1 — Core resolution | needs-revision | 1 | 0 | 1 | 0 |
| 2 — Pipeline reorder | ready | 0 | 0 | 0 | 0 |
| 3 — Dead code removal | needs-revision | 1 | 0 | 0 | 1 |
| 4 — Heuristic rewrites | needs-revision | 0 | 1 | 1 | 0 |
| 5 — ComponentModels restructure | needs-revision | 1 | 1 | 0 | 1 |
| 6 — digitalPinLoading | needs-revision | 1 | 1 | 1 | 0 |
| 7 — Model selector UI | ready | 0 | 0 | 0 | 0 |
| 8 — Pin loading UI | needs-revision | 0 | 0 | 1 | 0 |
| 9 — Save/load overrides | needs-revision | 1 | 0 | 0 | 1 |
| 10 — .SUBCKT parser | needs-revision | 0 | 1 | 1 | 1 |
| 11 — SPICE import UI | needs-revision | 1 | 1 | 1 | 0 |
| 12 — SPICE serialization | needs-revision | 0 | 0 | 0 | 1 |

## Cross-Wave Issues

### Shared File Conflicts
- `src/solver/digital/flatten.ts`: Wave 2 (pipeline reorder), Wave 3 (dead code table lists `resolveCircuitDomain`), and Wave 4 (H9 also claims `resolveCircuitDomain` deletion). Wave 3 omits `flatten.ts` from its files column despite claiming the deletion.
- `src/compile/compile.ts`: Waves 1, 2, 3, 4 all modify this file. Wave 4's H1 deletes code that Wave 3 should already have removed.

### Wave Dependency Violations
- **Wave 5 parallelization gate is wrong.** Spec says "Wave 5 can start after Wave 1." Wave 5 converts component declarations from `analog:` to `mnaModels:`. Waves 2-4 rewrite the compiler to read `mnaModels`. Running Wave 5 concurrently with Waves 2-4 breaks all analog compilation. Safe gate is **after Wave 4**, not Wave 1.
- Waves 10-12 gate ("after Wave 5") is correct.

### Duplicate/Overlapping Work
- `resolveCircuitDomain()` deletion appears in both Wave 3 (dead code table) and Wave 4 (H9). Must be assigned to exactly one wave.
- `forceAnalogDomain` removal appears in Wave 3 dead code table AND is implicitly part of Wave 4's H1 rewrite of the same `compile.ts` block.

### Unmapped Spec Sections
- "Subcircuit Propagation Rules" — 5 rules described, no wave implements or tests them.
- "'Analog Wins' Label Precedence" — marked "Preserved unchanged" but no wave verifies it survives the rewrites.
- "Migration / Runtime: Zero-Cost" — the `simulationMode` backward-compat fallback is promised but no wave implements it, and the `getActiveModelKey()` pseudocode contradicts the promise.

### Unaddressed Verification Measures
- No wave tests the subcircuit propagation rules (cross-engine boundary, same-domain inlining, etc.)
- No wave verifies "Analog Wins" label precedence survives the pipeline reorder
- Three-surface test descriptions for Waves 7-9 are grouped into one block despite covering different features

## Per-Wave Details

See `spec/reviews/spec-review-model-unification.md` for full per-wave analysis with code verification.

### Critical Issues Summary

| ID | Wave(s) | Issue |
|----|---------|-------|
| IC-2/IM-7 | 5 vs 2-4 | Wave 5 parallelization gate must be Wave 4, not Wave 1 |
| IC-8/IM-6 | 1 | `getActiveModelKey()` pseudocode omits promised `simulationMode` fallback |
| IM-1 | 5 | 144 files (not 139), unlisted edge cases, no completion criterion — must split |
| IM-2 | 3 | Dead code deletion has no ordered safety protocol; `port-analog-mixed.test.ts` missing from migration list |
| IC-5/IC-6 | 11 | `circuit.metadata.spiceModels` and `DtsDocument.spiceSubcircuits` are dead references — never defined |
| CN-4 | 6-9 | `stableNetId` sorts by `elementIndex` (unstable) instead of `instanceId` (stable) |
| IC-1 | 3 vs 4 | `resolveCircuitDomain` deletion double-assigned |

### Codebase Verification Results

| Claim | Verified | Actual |
|-------|----------|--------|
| 139 component files with `models:` | Wrong | 144 files, 159 occurrences |
| ~40 test sites with `simulationMode` | Wrong | 117 occurrences across 12 files |
| `compileAnalogCircuit` only in `compiler.ts` | Wrong | Also called in `port-analog-mixed.test.ts` and `compile-analog-partition.test.ts` |
| Bug B1 (`netlist.ts:393` reads wrong attr) | Confirmed | Verified in codebase |
| Bug B2 (`simulationMode` vs `simulationModel` split) | Confirmed | 117 occurrences of `simulationMode` in src/ |
