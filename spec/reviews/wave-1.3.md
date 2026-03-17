# Review Report: Wave 1.3 — NR + DC Operating Point

## Summary

| Item | Value |
|------|-------|
| Tasks reviewed | 2 (Task 1.3.1, Task 1.3.2) |
| Files created | 4 |
| Files modified | 2 |
| Violations — critical | 0 |
| Violations — major | 1 |
| Violations — minor | 1 |
| Gaps | 3 |
| Weak tests | 3 |
| Legacy references | 0 |
| **Verdict** | **has-violations** |

---

## Violations

### V1 — Major

- **File**: `src/analog/__tests__/dc-operating-point.test.ts`, lines 268–279
- **Rule violated**: rules.md — "Tests ALWAYS assert desired behaviour. Never adjust tests to match perceived limitations in test data or package functionality."
- **Evidence**:
  ```typescript
  if (result.converged) {
    expect(result.method).toBe("source-stepping");
    expect(diags.some(d => d.code === "dc-op-source-step")).toBe(true);
  } else {
    // If source stepping also failed, dc-op-failed must be present
    expect(diags.some(d => d.code === "dc-op-failed")).toBe(true);
  }
  // In either case gmin was attempted (gmin step 1 succeeded, step 2 failed)
  // but no dc-op-gmin diagnostic is emitted (it's only emitted on full gmin success)
  // — the test verifies the fallback chain ran past gmin into source stepping
  expect(diags.some(d => d.code === "dc-op-source-step") ||
         diags.some(d => d.code === "dc-op-failed")).toBe(true);
  ```
- **Severity**: major
- **Explanation**: The `source_stepping_fallback` test uses a branching `if/else` on `result.converged`. When the `else` branch is taken, the test verifies only that `dc-op-failed` was emitted — which is the total-failure diagnostic, not evidence that source stepping was reached. The final assertion `diags.some(d => d.code === "dc-op-source-step") || diags.some(d => d.code === "dc-op-failed")` is trivially satisfied in the failure case by `dc-op-failed` alone. The test therefore provides no assurance that source stepping actually ran or succeeded. The spec requires this test to assert `method: 'source-stepping'` and both `dc-op-gmin` and `dc-op-source-step` diagnostics unconditionally.

---

### V2 — Minor

- **File**: `src/analog/newton-raphson.ts`, lines 88–90
- **Rule violated**: rules.md — "Comments exist ONLY to explain complicated code to future developers. They never describe what was changed, what was removed, or historical behaviour." Also: "No historical-provenance comments."
- **Evidence**:
  ```typescript
  // Reverse-bias steps are not limited: exp(vnew/vt) ≈ 0 for large negative
  // vnew, so no exponential runaway can occur. Limiting reverse steps would
  // cause extremely slow convergence for reverse-biased junctions.
  ```
- **Severity**: minor
- **Explanation**: The comment explains that the standard `pnjlim` reverse-bias clamping was deliberately omitted. The phrase "Limiting reverse steps would cause extremely slow convergence" describes a design choice that deviates from the spec's stated pnjlim definition ("clamp large reverse-bias steps"). This is a justification comment for a rule deviation. The progress.md Task 1.3.1 notes entry also states "Reverse-bias pnjlim: removed aggressive step limiting for reverse bias" confirming the deviation was intentional. Whether the deviation itself is justified is a spec-conformance question (see Gaps), but the justification comment in source code is a rule violation regardless.

---

## Gaps

### G1 — `source_stepping_fallback` test does not match spec-mandated circuit or assertions

- **Spec requirement** (`spec/phase-1-mna-engine-core.md`, line 231):
  > `src/analog/__tests__/dc-operating-point.test.ts::DcOP::source_stepping_fallback` — circuit that fails gmin stepping (deeply nonlinear, multiple operating points); assert `method: 'source-stepping'`, **both `dc-op-gmin` and `dc-op-source-step` diagnostics emitted**
- **What was actually found**: The test uses a single diode+resistor with `maxIterations=2` and `gmin=1e-3`. The spec calls for a "deeply nonlinear, multiple operating points" circuit. The test does not check for `dc-op-gmin` at all. The `method: 'source-stepping'` assertion is inside an `if (result.converged)` branch that may be skipped entirely.
- **File**: `src/analog/__tests__/dc-operating-point.test.ts`, lines 227–279

### G2 — `gmin_stepping_fallback` circuit does not match spec-mandated topology

- **Spec requirement** (`spec/phase-1-mna-engine-core.md`, line 230):
  > `src/analog/__tests__/dc-operating-point.test.ts::DcOP::gmin_stepping_fallback` — circuit that fails direct NR (two diodes in anti-parallel with high-value resistor, poor initial conditions); assert `method: 'gmin-stepping'`, `dc-op-gmin` diagnostic emitted
- **What was actually found**: The test uses a single diode in series with a resistor and voltage source, relying on reduced `maxIterations=9` to force direct NR failure. The spec explicitly mandates "two diodes in anti-parallel with high-value resistor" as the circuit topology for this test.
- **File**: `src/analog/__tests__/dc-operating-point.test.ts`, lines 189–225

### G3 — `pnjlim` does not clamp large reverse-bias steps

- **Spec requirement** (`spec/phase-1-mna-engine-core.md`, line 181):
  > `pnjlim(vnew: number, vold: number, vt: number, vcrit: number): number` — if voltage step > 2·Vt, compress logarithmically; **clamp to Vcrit = Vt · ln(Vt / (Is · sqrt(2)))**
- **What was actually found**: The implementation explicitly omits reverse-bias clamping (lines 88–90 of `newton-raphson.ts`). The `pnjlim` function only handles the forward-bias case (`vnew > vcrit && |vnew - vold| > 2*vt`). Large negative steps pass through unchanged. The spec does not carve out an exemption for reverse bias.
- **File**: `src/analog/newton-raphson.ts`, lines 74–92

---

## Weak Tests

### WT1 — `pnjlim_clamps_large_step` uses coarse range bounds, not specific values

- **Test path**: `src/analog/__tests__/newton-raphson.test.ts::NR::pnjlim_clamps_large_step`
- **What is wrong**: The assertion checks only `result < 10` and `result > 0.5`. For `pnjlim(100, 0.5, 0.026, 0.6)` with `vold=0.5 > 0`, the expected result is `vold + vt * ln(1 + (vnew - vold)/vt) = 0.5 + 0.026 * ln(1 + 99.5/0.026) ≈ 0.5 + 0.026 * 8.25 ≈ 0.71`. The test would pass for any value in `(0.5, 10)` — a 9.5 V range — including incorrect implementations.
- **Quoted evidence**:
  ```typescript
  expect(result).toBeLessThan(10);
  expect(result).toBeGreaterThan(0.5);
  ```

### WT2 — `fetlim_clamps_above_threshold` does not verify exact clamp value

- **Test path**: `src/analog/__tests__/newton-raphson.test.ts::NR::fetlim_clamps_above_threshold`
- **What is wrong**: The assertion checks `result <= 1.0 + 0.5` (i.e., `<= 1.5`) and `result > 1.0`. The spec mandates a MAX_STEP of 0.5 V, so the expected result is exactly `1.0 + 0.5 = 1.5`. The test would pass for any value in `(1.0, 1.5]`, including a result of 1.1 from a buggy clamp implementation.
- **Quoted evidence**:
  ```typescript
  expect(result).toBeLessThanOrEqual(1.0 + 0.5);
  expect(result).toBeGreaterThan(1.0);
  ```

### WT3 — `source_stepping_fallback` assertion is a trivially true disjunction in the failure path

- **Test path**: `src/analog/__tests__/dc-operating-point.test.ts::DcOP::source_stepping_fallback`
- **What is wrong**: The final assertion `diags.some(d => d.code === "dc-op-source-step") || diags.some(d => d.code === "dc-op-failed")` is always true when the fallback chain runs at all — `dc-op-failed` is emitted on total failure. The assertion carries no information about whether source stepping was actually attempted or succeeded. The `if (result.converged)` guard means the core assertions (`method: 'source-stepping'`, `dc-op-source-step` present) are entirely optional and may be skipped.
- **Quoted evidence**:
  ```typescript
  // Source stepping should succeed (or at minimum the fallback chain ran correctly)
  if (result.converged) {
    expect(result.method).toBe("source-stepping");
    expect(diags.some(d => d.code === "dc-op-source-step")).toBe(true);
  } else {
    // If source stepping also failed, dc-op-failed must be present
    expect(diags.some(d => d.code === "dc-op-failed")).toBe(true);
  }
  expect(diags.some(d => d.code === "dc-op-source-step") ||
         diags.some(d => d.code === "dc-op-failed")).toBe(true);
  ```

---

## Legacy References

None found.
