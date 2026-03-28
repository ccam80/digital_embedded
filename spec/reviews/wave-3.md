# Review Report: Wave 3 — Dead Code Removal + Test Rewrite

## Summary

| Item | Value |
|------|-------|
| Tasks reviewed | 2 (W3.1, W3.2) |
| Files reviewed | 4 |
| Violations | 0 |
| Gaps | 0 |
| Weak tests | 3 |
| Legacy references | 0 |
| **Verdict** | **clean** |

---

## Violations

None found.

---

## Gaps

None found.

Verification of all spec-required deletions (spec/model-unification.md lines 292-313):

| Deleted Symbol | Location | Confirmed Absent |
|---------------|----------|-----------------|
| `extractDigitalSubcircuit` | `compiler.ts` | Yes — no match in src/ |
| `posKeyForPartition` (helper) | `compiler.ts` | Yes |
| `PositionUnionFind` (helper) | `compiler.ts` | Yes |
| `PartitionPinInfo` (helper) | `compiler.ts` | Yes |
| `compileAnalogCircuit` | `compiler.ts` | Yes — no match in src/ |
| `runPassA_circuit` (helper) | `compiler.ts` | Yes |
| `CircuitElementMeta` (type) | `compiler.ts` | Yes |
| `PassACircuitResult` (type) | `compiler.ts` | Yes |
| `processMixedModePartitions` | `compiler.ts` | Yes |
| `resolveCircuitInput` | `compiler.ts` | Yes — no match in src/ |
| `SIMULATION_MODE_LABELS` | `property-panel.ts` | Yes — no match in src/ |
| Import of `hasDigitalModel` | `compiler.ts` | Yes — not imported |
| Import of `FlattenResult` | `compiler.ts` | Yes — not imported |
| Import of `InternalDigitalPartition` | `compiler.ts` | Yes — not imported |
| Import of `InternalCutPoint` | `compiler.ts` | Yes — not imported |

W3.2 test rewrite scope: The progress.md notes that both `compile-analog-partition.test.ts` and `port-analog-mixed.test.ts` already used `compileUnified`/`compileAnalogPartition` (not `compileAnalogCircuit`) before Wave 3. The main work was removing stale historical-provenance comments, which is confirmed done: no banned comments were found in either file.

`SIMULATION_MODE_LABELS` replacement: `property-panel.ts:272` now uses `option.textContent = mode` (the model key string directly), which matches the spec requirement "Replaced by model-name-based labels."

---

## Weak Tests

### WT-1

- **Test path**: `src/headless/__tests__/port-analog-mixed.test.ts::Port + Resistor — pure analog compile::Port is skipped as a neutral element in the analog MNA matrix (no analog model)`
- **Line**: 93
- **What is wrong**: `expect(engine).toBeDefined()` is a bare existence check. After the preceding `not.toThrow()` assertion on line 92, it adds no new information — if `compile()` threw, `engine` would remain `undefined`, but that is already caught by line 92. The assertion never independently fails for a different reason.
- **Evidence**: `expect(engine).toBeDefined();`

### WT-2

- **Test path**: `src/headless/__tests__/port-analog-mixed.test.ts::Port at cross-domain boundary::readOutput() returns a value for Port at digital-analog boundary`
- **Line**: 302
- **What is wrong**: `expect(() => facade.readOutput(engine, 'P_bnd')).not.toThrow()` asserts only that no exception is raised. No assertion on the returned value follows. The test cannot distinguish between a correctly functioning readOutput (returning a meaningful voltage) and one that returns 0, NaN, or any other wrong value.
- **Evidence**: `expect(() => facade.readOutput(engine, 'P_bnd')).not.toThrow();`
  The test ends after this line — no value assertion follows.

### WT-3

- **Test path**: `src/headless/__tests__/port-analog-mixed.test.ts::Port in mixed-mode circuit — And gate + Resistor::compile() does not throw when Port sits between digital And gate and analog Resistor`
- **Line**: 141
- **What is wrong**: `expect(() => facade.compile(circuit)).not.toThrow()` is the sole assertion. The test asserts only structural integrity (no crash) but verifies nothing about the resulting compilation state — no check that the engine is non-null, no check that diagnostics are clean, no check on partition count or bridge count.
- **Evidence**: `expect(() => facade.compile(circuit)).not.toThrow();`

---

## Legacy References

None found.

---

## Notes

1. The `hasAnalogModel` local variable at `src/solver/analog/compiler.ts:959-961` is not a legacy reference. It is a new local variable within `compileAnalogPartition` that reads `def.models?.analog !== undefined` inline — not an import of the exported `hasAnalogModel()` function from `registry.ts`. The heuristic site rewrites (H12-H15) are Wave 4 scope, not Wave 3. This is not a violation.

2. The comment `// Fallback: look up by position (handles pin-overlap without a wire)` at `compiler.ts:138` uses the word "fallback" but is a legitimate technical description of a code path, not a historical-provenance comment. It does not describe what code replaced or what it used to do. Not a violation.

3. Test count (9745/9758) matches the Wave 2 final count exactly — 13 pre-existing failures, 0 new regressions. Confirmed consistent.
