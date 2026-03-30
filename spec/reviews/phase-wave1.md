# Review Report: Wave 1 -- Bridge Architecture Rewrite (Tasks 1.1-1.8)

## Summary

| Field | Value |
|-------|-------|
| Tasks reviewed | 8 (Tasks 1.1-1.8) |
| Tasks implemented | 6 fully (1.1, 1.2, 1.3, 1.4, 1.5, 1.6), 1 partially (1.7), 1 partially (1.8) |
| Violations | 6 |
| Gaps | 4 |
| Weak tests | 8 |
| Legacy references | 2 |
| Verdict | **has-violations** |

---

## Violations

### V1 -- CRITICAL: stampOutput() is a Norton equivalent backdoor for behavioral elements

- **File**: src/solver/analog/digital-pin-model.ts, lines 154-166
- **Rule violated**: Spec Task 1.1 acceptance criteria
- **Severity**: critical

The spec requires DigitalOutputPinModel use an ideal voltage source branch equation. The implementation added a stampOutput() method (originally named stampNorton() per progress.md) that implements exactly the old Norton equivalent behavior: conductance + current source stamp (gOut on diagonal, V_target * gOut on RHS).

All behavioral elements (gates, flipflops, sequential, combinational, remaining, ADC, Schmitt trigger, timer-555) call stampOutput() instead of stamp(). The old Norton behavior is preserved for the majority of analog-modeled digital components. Only bridge adapters use the new ideal voltage source stamp().

Callers of stampOutput (not exhaustive):
- behavioral-gate.ts:152
- behavioral-flipflop.ts:145-146
- behavioral-flipflop/t.ts:73-74, jk.ts:75-76, jk-async.ts:82-83, rs.ts:84-85, rs-async.ts:77-78, d-async.ts:79-80
- behavioral-combinational.ts:132,274,396
- behavioral-sequential.ts:116,120,301,556,569
- behavioral-remaining.ts:147,252,373,823,828
- adc.ts:339,341,347,349
- schmitt-trigger.ts:164,170
- timer-555.ts:337

Progress.md confirms intentional rule-breaking: Added stampNorton() method to preserve Norton equivalent behavior for behavioral elements.

### V2 -- MAJOR: DigitalInputPinModel constructor defaults loaded to true

- **File**: src/solver/analog/digital-pin-model.ts, line 278
- **Rule violated**: Spec Task 1.2 constructor signature
- **Severity**: major

Evidence: constructor(spec: ResolvedPinElectrical, loaded = true)

The spec says constructor takes loaded: boolean. The default=true is a backwards-compatibility default confirmed by progress.md.

### V3 -- MAJOR: Coordinator tests do not exercise _stepMixed() path

- **File**: src/solver/__tests__/coordinator-bridge.test.ts, lines 198-212
- **Rule violated**: Spec Task 1.7 acceptance criteria
- **Severity**: major

Test file comment states: test the bridge adapter logic directly rather than through the full _stepMixed path. No test calls coordinator.step() to verify integration.

### V4 -- MINOR: Historical-provenance comment in digital-pin-model.ts

- **File**: src/solver/analog/digital-pin-model.ts, line 116
- **Rule violated**: rules.md no historical-provenance comments
- **Severity**: minor

Evidence: Behavioral elements that need a conductance+current-source stamp use stampOutput().

### V5 -- MINOR: Historical-provenance comment in extract-connectivity.ts

- **File**: src/compile/extract-connectivity.ts, line 86
- **Rule violated**: rules.md no historical-provenance comments
- **Severity**: minor

Evidence: // Legacy: some definitions attach mnaModels directly on def.models (test-only pattern).

### V6 -- MINOR: Backward-compatibility re-export comment in element.ts

- **File**: src/solver/analog/element.ts, line 11
- **Rule violated**: rules.md no historical-provenance comments
- **Severity**: minor

Evidence: // circular dependency. Re-exported here for backward compatibility.
Pre-existing. Reported for completeness.

---

## Gaps

### G1: Task 1.8 -- mid-simulation hot-load test missing

- **Spec requirement**: At least one test must verify hot-loading during a running simulation
- **What was found**: No test performs compile -> step -> setParam -> step -> verify voltage change
- **File**: none

### G2: Task 1.8 -- E2E surface tests missing

- **Spec requirement**: E2E tests in e2e/gui/ verifying digitalPinLoading mode differences
- **What was found**: No E2E tests exist. Blocked by E2E infrastructure.
- **File**: none

### G3: Task 1.7 -- coordinator integration tests missing

- **Spec requirement**: 4 integration tests exercising coordinator step path with bridge adapters
- **What was found**: Tests test adapter API directly, not through coordinator.step()
- **File**: src/solver/__tests__/coordinator-bridge.test.ts

### G4: Task 1.8 -- test rewrite completeness unverified

- **Spec requirement**: Rewrite digital-pin-loading.test.ts, pin-loading-menu.test.ts, digital-bridge-path.test.ts
- **What was found**: digital-pin-loading.test.ts rewritten. Task 1.8 not tracked in progress.md. No digital-bridge-path.test.ts exists.
- **Files**: src/solver/analog/__tests__/digital-pin-loading.test.ts

---

## Weak Tests

### WT1-WT3: coordinator-bridge.test.ts -- does-not-throw assertions
Three tests assert only that method calls do not throw, with no behavioral verification:
- outputAdapter.setLogicLevel(true) does not throw
- setHighZ(true) does not throw
- setHighZ(true) then setLogicLevel(false) does not throw

### WT4-WT5: coordinator-bridge.test.ts -- typeof checks
Two tests assert typeof x === function, which is trivially true:
- setHighZ is available on outputAdapter
- setParam is available on both output and input adapters

### WT6-WT7: coordinator-bridge.test.ts -- toBeDefined on find result
Two tests use toBeDefined() which is weak; should verify same instance:
- outputAdapter found in bridgeAdaptersByGroupId
- inputAdapter found in bridgeAdaptersByGroupId

### WT8: digital-pin-loading.test.ts -- toBeGreaterThan(0) without upper bound
Multiple assertions at lines 337, 364, 376, 433 use toBeGreaterThan(0) instead of exact counts.

---

## Legacy References

### LR1: Legacy comment in extract-connectivity.ts
- **File**: src/compile/extract-connectivity.ts, line 86
- **Reference**: // Legacy: some definitions attach mnaModels directly on def.models (test-only pattern).
- mnaModels path is active in 47+ files, so test-only label is also inaccurate.

### LR2: backward compatibility re-export in element.ts
- **File**: src/solver/analog/element.ts, line 11
- **Reference**: // circular dependency. Re-exported here for backward compatibility.
- Pre-existing, not introduced by Wave 1.

---

## Verified Correct

- BridgeOutputAdapter.isNonlinear === false
- BridgeOutputAdapter.branchIndex >= 0
- BridgeInputAdapter.branchIndex === -1
- stampNonlinear removed from bridge adapter and pin model
- _thresholdVoltage removed from coordinator
- applyLoadingDecisions exists between steps 3 and 4 in compile.ts
- bridgeAdaptersByGroupId populated on ConcreteCompiledAnalogCircuit
- partition.ts does NOT use old routing functions
- Analog partition guard uses groups.length > 0 check
- Bridge-only partitions suppress no-ground diagnostic
