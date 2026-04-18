# Review Report: Phase 1 — Zero-Alloc Infrastructure

## Summary

- **Tasks reviewed**: 1.1.1, 1.1.2, 1.1.3, 1.2.1, 1.2.2, 1.2.3, part-a-cascade caller migration, 1.1-fix verifier remediation.
- **Violations found**: 8 (0 critical, 4 major, 4 minor)
- **Gaps found**: 2
- **Verdict**: has-violations

## Violations

### V-01: Historical-provenance comment: "migrated from mna-assembler.test.ts"
- **File**: `src/solver/analog/__tests__/ckt-load.test.ts`:24 (and header docstring line 5)
- **Rule**: rules.md historical-provenance comment ban.
- **Evidence**: `// Stamping tests — migrated from mna-assembler.test.ts`
- **Severity**: major

### V-02: Historical-provenance comment block "previously called solveDcOperatingPoint / newtonRaphson"
- **File**: `src/solver/analog/__tests__/test-helpers.ts`:743-748
- **Rule**: rules.md historical-provenance comment ban
- **Evidence**:
  ```
  // makeSimpleCtx / runDcOp / runNR — migration helpers for component tests
  //
  // Component tests that previously called solveDcOperatingPoint({solver, ...})
  // with the old DcOpOptions API should call runDcOp() instead.
  // Tests that previously called newtonRaphson({...}) should call runNR() instead.
  ```
- **Severity**: major

### V-03: Task 1.1.1 spec requirement not met — `_voltages`, `_prevVoltages`, `_agp`, `_nodeVoltageHistory` retained alongside `_ctx`
- **File**: `src/solver/analog/analog-engine.ts`:92-100, 153-154, 159-160, plus 20+ reference sites.
- **Rule**: Phase 1 spec Task 1.1.1 "Files to modify — analog-engine.ts — Replace all per-field buffer declarations with a single `_ctx: CKTCircuitContext` field"
- **Evidence** (lines 92-100):
  ```
  private _voltages: Float64Array = new Float64Array(0);
  private _prevVoltages: Float64Array = new Float64Array(0);
  private _agp: Float64Array = new Float64Array(7);
  private _nodeVoltageHistory: NodeVoltageHistory = new NodeVoltageHistory();
  ```
  `_ctx` was added but the old fields were not removed. Engine maintains two parallel voltage tracking systems kept in sync via `.set()` calls.
- **Severity**: major

### V-04: Dead code — `rawMaxIter` computed via tautological ternary
- **File**: `src/solver/analog/newton-raphson.ts`:276-279
- **Rule**: rules.md — scorched earth
- **Evidence**:
  ```
  const rawMaxIter = ctx.exactMaxIterations ? (ctx.maxIterations) : ctx.maxIterations;
  ```
- **Severity**: minor

### V-05: CKTCircuitContext constructor allocates a SparseSolver that engine discards
- **File**: `src/solver/analog/ckt-context.ts`:452; `src/solver/analog/analog-engine.ts`:83, 206-208
- **Rule**: Phase 1 governing principle #2 zero-alloc
- **Severity**: minor

### V-06: `DcOpResult.reset()` allocates a new diagnostics array per DC-OP call
- **File**: `src/solver/analog/ckt-context.ts`:93
- **Rule**: Phase 1 Task 1.1.3 acceptance + governing principle #2
- **Evidence**: `this.diagnostics = [];` — should use `.length = 0`
- **Severity**: major

### V-07: `cktncDump` allocates array and per-node object literals per call
- **File**: `src/solver/analog/dc-operating-point.ts`:238-250
- **Severity**: minor

### V-08: Failure-path sets `ctx.dcopResult.method = "direct"` incorrectly
- **File**: `src/solver/analog/dc-operating-point.ts`:439
- **Severity**: minor

## Gaps

### G-01: Task 1.1.1 file-modification requirement only partially implemented (analog-engine.ts)
- **Spec**: Replace per-field buffers with `_ctx` in analog-engine.ts
- **Actual**: `_ctx` added, old fields retained; 12+ `.set()` sync sites maintain dual-buffer regime
- **File**: `src/solver/analog/analog-engine.ts`

### G-02: Double SparseSolver allocation (Task 1.1.2)
- **Spec**: All buffers allocated once in constructor, never re-created
- **Actual**: CKTCircuitContext constructor creates a solver, engine replaces it with a different instance
- **File**: `src/solver/analog/ckt-context.ts`; `src/solver/analog/analog-engine.ts`

## Weak Tests

### T-01: `allocates_all_buffers_at_init` uses `toBeGreaterThan(0)` for element list assertions
- **Test**: `ckt-context.test.ts::CKTCircuitContext::allocates_all_buffers_at_init`
- **Issue**: Passes even with wrong elements in the lists
- **Evidence**:
  ```
  expect(ctx.nonlinearElements.length).toBeGreaterThan(0);
  expect(ctx.reactiveElements.length).toBeGreaterThan(0);
  expect(ctx.poolBackedElements.length).toBeGreaterThan(0);
  ```

### T-02: `zero_allocations_on_reuse` does not exercise a real NR path
- **Test**: `ckt-context.test.ts::CKTCircuitContext::zero_allocations_on_reuse`
- **Issue**: Only calls `.fill()` and `.reset()` — does not invoke `newtonRaphson(ctx)`, `cktLoad`, `solver.factor()`, etc.

## Legacy References

### L-01: `ckt-load.test.ts`:5, 24 — `migrated from mna-assembler.test.ts`
### L-02: `test-helpers.ts`:746 — `previously called solveDcOperatingPoint({solver, ...})`
### L-03: `test-helpers.ts`:748 — `Tests that previously called newtonRaphson({...})`
### L-04: `newton-raphson.test.ts`:297 — `// Change 6 ensures assembler.noncon` (references deleted MNAAssembler)
### L-05: `analog-engine.ts`:1038 — `// DcOpOptions, so boot-step DCOP sub-solves` (references deleted DcOpOptions)
