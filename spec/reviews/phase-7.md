# Review Report: Phase 7 — Verification (ngspice Parity Tests)

## Summary

- **Tasks reviewed**: 11 (7.1.1, 7.1.2, 7.2.1, 7.2.2, 7.2.3, 7.2.4, 7.3.1, 7.3.2, 7.3.3, 7.3.4, 7.4.1; plus fix-round tasks 7.2b-retry and 7.3.2-fix)
- **Violations**: 7 (3 critical, 2 major, 2 minor)
- **Gaps**: 2
- **Weak tests**: 3
- **Legacy references**: 2
- **Verdict**: has-violations

---

## Violations

### V-1 — CRITICAL

- **File**: `src/solver/analog/__tests__/ngspice-parity/parity-helpers.ts`
- **Lines**: 117–126 (`initMode` branch), 128–137 (`order` branch), 139–148 (`delta` branch), 95–115 (`diagGmin` and `srcFact` branches)
- **Rule violated**: Tests ALWAYS assert desired behaviour. Never adjust tests to match perceived limitations in test data or package functionality. (rules.md §Testing) / spec Phase 7 tolerance contract: "Comparison tolerance is `absDelta === 0` (exact IEEE-754 bit equality)" on `noncon, diagGmin, srcFact, initMode, order, delta`.
- **Quoted evidence**:
  ```typescript
  // Compare diagGmin if present on both sides
  const ourDiagGmin = (ours as any).diagGmin as number | undefined;
  const ngDiagGmin = (ngspice as any).diagGmin as number | undefined;
  if (ourDiagGmin !== undefined && ngDiagGmin !== undefined) { ... }

  // Compare srcFact if present on both sides
  const ourSrcFact = (ours as any).srcFact as number | undefined;
  const ngSrcFact = (ngspice as any).srcFact as number | undefined;
  if (ourSrcFact !== undefined && ngSrcFact !== undefined) { ... }

  // Compare initMode if present on both sides
  const ourInitMode = (ours as any).initMode as number | undefined;
  const ngInitMode = (ngspice as any).initMode as number | undefined;
  if (ourInitMode !== undefined && ngInitMode !== undefined) { ... }

  // Compare order if present on both sides
  const ourOrder = (ours as any).order as number | undefined;
  const ngOrder = (ngspice as any).order as number | undefined;
  if (ourOrder !== undefined && ngOrder !== undefined) { ... }

  // Compare delta if present on both sides
  const ourDelta = (ours as any).delta as number | undefined;
  const ngDelta = (ngspice as any).delta as number | undefined;
  if (ourDelta !== undefined && ngDelta !== undefined) { ... }
  ```
- **Analysis**: `diagGmin`, `srcFact`, `initMode`, `order`, and `delta` are **never populated** on `IterationSnapshot` objects by either the our-engine capture path (`capture.ts`) or the ngspice bridge path (`ngspice-bridge.ts`). A search across all harness source files confirms no assignment to any of these five fields on an `IterationSnapshot`. The `(ours as any).diagGmin` etc. always resolves to `undefined`. The `if (X !== undefined && Y !== undefined)` guard then silently skips all five comparisons at every call site. Five of the nine per-iteration parity fields specified in the tolerance contract are **never actually compared**. The assertions appear in the code but never execute. This is a trivially-true test pattern (the comparison always passes because it never runs).
- **Severity**: critical

---

### V-2 — CRITICAL

- **File**: `src/solver/analog/__tests__/ngspice-parity/parity-helpers.ts`
- **Lines**: 273–287 (`_extractModeSequence`)
- **Rule violated**: Test assertions must test desired behaviour, not be trivially true. (rules.md §Testing)
- **Quoted evidence**:
  ```typescript
  function _extractModeSequence(session: CaptureSession): ModeEntry[] {
    const entries: ModeEntry[] = [];
    for (let si = 0; si < session.steps.length; si++) {
      const step = session.steps[si]!;
      for (let ai = 0; ai < step.attempts.length; ai++) {
        const attempt = step.attempts[ai]!;
        for (let ii = 0; ii < attempt.iterations.length; ii++) {
          const snap = attempt.iterations[ii]!;
          const initMode = (snap as any).initMode as number | undefined;
          entries.push({ stepIndex: si, iterIndex: ii, initMode: initMode ?? 0 });
        }
      }
    }
    return entries;
  }
  ```
- **Analysis**: `snap.initMode` is never set on `IterationSnapshot` (same dead-field problem as V-1). It always resolves to `undefined`, so `initMode ?? 0` always produces `0` for every entry from both engines. `assertModeTransitionMatch` then compares two sequences of all-zeros and trivially passes. The spec requires verifying the actual `initJct → initFix → initFloat → ...` mode-transition sequence (Phase 7 acceptance criteria: "Mode transition sequences match ngspice for all 8 test circuits — bit-exact initMode equality throughout"). This assertion never fires on the actual mode data.
- **Severity**: critical

---

### V-3 — CRITICAL

- **File**: `src/solver/analog/__tests__/harness/comparison-session.ts`
- **Lines**: 653–660 (lteDt capture for our engine)
- **Rule violated**: No pragmatic patches / No fallbacks. (CLAUDE.md "No Pragmatic Patches"; rules.md §Code Hygiene)
- **Quoted evidence**:
  ```typescript
  const lteDtValue = (this._engine as any)._timestep?.currentDt as number | undefined;
  sc.endStep({
    ...
    lteDt: typeof lteDtValue === "number" && isFinite(lteDtValue) && lteDtValue > 0
      ? lteDtValue : undefined,
  });
  ```
- **Analysis**: The spec (Task 7.1.2) states lteDt must be populated from "our `TimestepController`'s proposed dt **after the LTE check**" — i.e., the LTE-proposed **next** dt, not `currentDt`. `TimestepController.currentDt` is the **current** accepted step size, not the LTE-proposed next timestep. Reading it via `(this._engine as any)._timestep?.currentDt` is also an `as any` bypass of the typed interface — the accessor is not part of any public API. The spec says populate from `TimestepController`'s proposed dt after the LTE check; using `currentDt` is the wrong field. This is a spec deviation producing a silently incorrect parity field.
- **Severity**: critical

---

### V-4 — MAJOR

- **File**: `src/solver/analog/__tests__/ngspice-parity/diode-bridge.test.ts`
- **Lines**: 46–63
- **Rule violated**: Tests ALWAYS assert desired behaviour. (rules.md §Testing) / spec Task 7.3.3 requires assertIterationMatch at every step/iter across both sessions.
- **Quoted evidence**:
  ```typescript
  const maxSteps = Math.max(ours.steps.length, ngspice.steps.length);
  for (let si = 0; si < maxSteps; si++) {
    const ourStep = ours.steps[si];
    const ngStep = ngspice.steps[si];
    if (!ourStep || !ngStep) continue;
    ...
  ```
  Also:
  ```typescript
  const ngspice = session.ngspiceSession!;  // NOT ngspiceSessionAligned
  ```
- **Analysis**: Two problems. First, `Math.max` is used as the loop bound with `continue` on missing steps. When the two engines produce a different number of steps, all steps where one engine is absent are silently skipped instead of failing. The spec requires bit-exact match at every step; a step-count divergence should fail the test, not be silently ignored. Second, `session.ngspiceSession!` is used (raw, unaligned) instead of `session.ngspiceSessionAligned` — other tests (resistive-divider, diode-resistor, rc-transient, rlc-oscillator) all use the aligned session, which is the correct partner for per-iteration comparison. Using the raw session may cause spurious step-index misalignment.
- **Severity**: major

---

### V-5 — MAJOR

- **File**: `src/solver/analog/__tests__/ngspice-parity/mosfet-inverter.test.ts`
- **Lines**: 47–64 (`dc_op_match`), 89–106 (`transient_match`)
- **Rule violated**: Tests ALWAYS assert desired behaviour. (rules.md §Testing)
- **Quoted evidence**:
  ```typescript
  const maxSteps = Math.max(ours.steps.length, ngspice.steps.length);
  for (let si = 0; si < maxSteps; si++) {
    const ourStep = ours.steps[si];
    const ngStep = ngspice.steps[si];
    if (!ourStep || !ngStep) continue;
    ...
  ```
  Also:
  ```typescript
  const ngspice = session.ngspiceSession!;  // NOT ngspiceSessionAligned
  ```
- **Analysis**: Same two problems as V-4: `Math.max` with silent `continue` hides step-count mismatches; raw `ngspiceSession!` used instead of aligned session. Both `dc_op_match` and `transient_match` share this pattern.
- **Severity**: major

---

### V-6 — MINOR

- **File**: `src/solver/analog/__tests__/ngspice-parity/diode-bridge.test.ts`
- **Line**: 13
- **Rule violated**: No dead code. (rules.md §Code Hygiene)
- **Quoted evidence**:
  ```typescript
  import { describe, it, expect } from "vitest";
  ```
- **Analysis**: `describe` is imported from vitest but never used in this file. The file uses `describeIfDll` from parity-helpers for all test grouping. The unused import is dead code.
- **Severity**: minor

---

### V-7 — MINOR

- **File**: `src/solver/analog/__tests__/ngspice-parity/mosfet-inverter.test.ts`
- **Line**: 14
- **Rule violated**: No dead code. (rules.md §Code Hygiene)
- **Quoted evidence**:
  ```typescript
  import { describe, it, expect } from "vitest";
  ```
- **Analysis**: Same as V-6: `describe` is imported but never used. `describeIfDll` is used for grouping.
- **Severity**: minor

---

## Gaps

### G-1

- **Spec requirement**: Task 7.1.2 — "Add `lteDt?: number` to `NRAttempt` or `StepSnapshot`" (spec files to modify: `src/harness/types.ts`). Also: "Extend `NRAttempt`... with `lteDt: number` and populate it from our `TimestepController`'s proposed dt **after the LTE check**."
- **What was found**: `lteDt` was added to `IterationSnapshot` (not `NRAttempt` or `StepSnapshot`). This is a different location than what the spec names. Additionally, the "proposed dt after LTE check" is not the same as `currentDt` (see V-3). The `NRAttempt` type has no `lteDt` field.
- **File**: `src/solver/analog/__tests__/harness/types.ts` (line 186), `src/solver/analog/__tests__/harness/comparison-session.ts` (line 653)

---

### G-2

- **Spec requirement**: Task 7.3.3 — "compare the sequence of breakpoint consumption times between sessions: every consumed breakpoint's time must match bit-exact (`absDelta === 0`)."
- **What was found**: `diode-bridge.test.ts` compares `stepEndTime` of all accepted steps as a proxy for breakpoint times. The spec explicitly calls for comparing "breakpoint consumption times" as a distinct sequence — breakpoints are circuit-defined events (diode switching transients), not merely all accepted step end-times. Using every accepted step's `stepEndTime` conflates regular timestep advancement with breakpoint events, potentially masking true breakpoint-time divergences.
- **File**: `src/solver/analog/__tests__/ngspice-parity/diode-bridge.test.ts` (lines 72–92)

---

## Weak Tests

### WT-1

- **Test path**: `src/solver/analog/__tests__/harness/capture.test.ts::lteDt capture — our engine::lteDt_captured_from_ours`
- **Problem**: The `lteDt` positivity check uses a boolean expression as the assertion subject rather than the value itself.
- **Quoted evidence**:
  ```typescript
  expect(
    Number.isFinite(lastIter.lteDt!),
    `step at t=${step.stepStartTime}: lteDt=${lastIter.lteDt} should be finite`,
  ).toBe(true);
  expect(
    lastIter.lteDt! > 0,
    `step at t=${step.stepStartTime}: lteDt=${lastIter.lteDt} should be positive`,
  ).toBe(true);
  ```
  Using `expect(boolean).toBe(true)` produces opaque failures. Standard form is `expect(lastIter.lteDt!).toBeGreaterThan(0)` and `expect(Number.isFinite(lastIter.lteDt!)).toBe(true)` — however the positivity check `expect(lastIter.lteDt! > 0).toBe(true)` is a weakened assertion; when it fails the output only says "expected false to be true" with no value information beyond the message string.

---

### WT-2

- **Test path**: `src/solver/analog/__tests__/ngspice-parity/rlc-oscillator.test.ts::RLC oscillator transient parity — Task 7.3.2::transient_oscillation_match`
- **Problem**: The oscillation peak check scans `prevVoltages` (all nodes) rather than the specific capacitor node.
- **Quoted evidence**:
  ```typescript
  // Collect capacitor node voltage for oscillation check (steps 0..200).
  if (si <= 200) {
    const snap = ourAttempt.iterations[ii]!;
    for (const v of snap.prevVoltages) {
      const absV = Math.abs(v);
      if (absV > capVoltagePeak) capVoltagePeak = absV;
    }
  }
  ```
  This scans all node voltages including the supply rail, which in a circuit with a 1V AC source would always have voltages reaching 1V regardless of oscillation. The check `peak > 0.5V` could pass even if the capacitor itself shows no oscillation, as long as any node reaches 0.5V.

---

### WT-3

- **Test path**: `src/solver/analog/__tests__/ngspice-parity/diode-bridge.test.ts::Diode bridge rectifier — ngspice transient parity::transient_rectification_match`
- **Problem**: Trivially-true sanity assertions at end of test.
- **Quoted evidence**:
  ```typescript
  // Sanity: simulation must have produced steps
  expect(ours.steps.length).toBeGreaterThan(0);
  expect(ngspice.steps.length).toBeGreaterThan(0);
  ```
  These assertions verify only that any simulation output was produced. `length > 0` without content checks is the exact trivially-true weak assertion pattern flagged in rules.md. If the simulation ran but all steps mismatched, these pass.

---

## Legacy References

### LR-1

- **File**: `src/solver/analog/__tests__/harness/netlist-generator.ts`
- **Line**: 154
- **Quoted evidence**:
  ```
  // Fallback for any other MOSFET variant
  ```
  This is a "fallback" comment. Per rules.md §Code Hygiene: "Any comment containing... 'fallback'... is almost never just a comment problem. The comment exists because an agent left dead or transitional code in place." The code decorated by this comment must be examined for dead/transitional behaviour.

---

### LR-2

- **File**: `src/solver/analog/__tests__/harness/slice.ts`
- **Line**: 169
- **Quoted evidence**:
  ```
  // fallback: nodeLabels is keyed by 1-based nodeId
  ```
  Same pattern — "fallback" comment decorating code that may represent a dead or transitional path that should have been removed or unified.

---

## Notes on Skipped Tests

All 8 parity test files use `describeIfDll(...)` to gate execution on DLL presence. This is correct per the spec ("tests are structured to run bit-exact when the DLL is supplied via `describeIfDll`"). The assignment instructs evaluation of test structure only, not live execution. The structural issues above (V-1 through V-3) mean that even when the DLL is present, the critical parity assertions for `diagGmin`, `srcFact`, `initMode`, `order`, `delta`, and mode transitions will silently pass without performing any comparison.
