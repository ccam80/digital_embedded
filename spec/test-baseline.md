# Test Baseline

- **Timestamp**: 2026-03-29T00:00:00Z
- **Phase**: Plan v2 — Model System Unification v2
- **Command**: npm run test:q
- **Result**: 10065/10088 passing, 23 failing, 0 skipped (30.6s, 341 files)

## Test Summary

- **Vitest + Playwright combined**: 10065/10088 passing (23 failing) — 30.6 seconds
- **Total test files**: 341

## Failing Tests (pre-existing)

| Test | File | Status | Summary |
|------|------|--------|---------|
| digitalPinLoading="none": And gate in logical mode gets rIn=Infinity on input adapters | src/headless/__tests__/digital-pin-loading-mcp.test.ts:167 | FAIL | Weak assertion: `expected 0 to be greater than 0` |
| digitalPinLoading="none": And gate in logical mode gets rOut=0 on output adapters | src/headless/__tests__/digital-pin-loading-mcp.test.ts:189 | FAIL | Weak assertion: `expected 0 to be greater than 0` |
| digitalPinLoading="cross-domain": And in logical mode gets finite rIn (not ideal) | src/headless/__tests__/digital-pin-loading-mcp.test.ts:211 | FAIL | Weak assertion: `expected 0 to be greater than 0` |
| patch with _spiceModelOverrides changes DC operating point vs default | src/headless/__tests__/spice-model-overrides-mcp.test.ts:165 | FAIL | Weak assertion: `expected false to be true` |
| peak_current_at_vp | src/components/semiconductors/tunnel-diode.ts:125 | ERROR | Cannot read properties of undefined (reading 'IP') |
| valley_current_at_vv | src/components/semiconductors/tunnel-diode.ts:125 | ERROR | Cannot read properties of undefined (reading 'IP') |
| nr_converges_in_ndr_region | src/components/semiconductors/tunnel-diode.ts:125 | ERROR | Cannot read properties of undefined (reading 'IP') |
| digital_only_component_emits_diagnostic | src/solver/analog/__tests__/analog-compiler.test.ts:312 | FAIL | Expected diagnostic array length 1, got 0 |
| rejects_digital_only_component | src/solver/analog/__tests__/compiler.test.ts:425 | FAIL | Expected diagnostic array length 1, got 0 |
| analog_internals_without_transistorModel_falls_through_to_analogFactory | src/solver/analog/__tests__/analog-compiler.test.ts:553 | FAIL | Spy not called as expected (expected 1 call, got 0) |

## Failure Analysis

**Total failures**: 23 tests (10 unique failure categories)

### Failure Categories

1. **Weak test assertions** (4 tests) — Plan v2 Wave 7.1 known issues
   - 3x digital-pin-loading tests: checking for `> 0` against values that should be inspected
   - 1x spice-model-overrides: checking for boolean value that needs actual comparison

2. **Tunnel diode undefined reference** (3 tests) — Initialization or model data issue
   - All at same location: `src/components/semiconductors/tunnel-diode.ts:125`
   - Error: Cannot read property 'IP' from undefined object

3. **Missing diagnostic emission** (2 tests) — Model system changes may affect diagnostic generation
   - Digital-only component in analog context not generating expected diagnostic
   - Related to Wave 4 compiler rewrite refactoring

4. **Spy assertion failure** (1 test) — Mock expectation not met
   - `analog_internals_without_transistorModel_falls_through_to_analogFactory`
   - Expected factory function call not occurring

## Notes

- **Headless/MCP tests dominant**: Failures are primarily in unit/integration tests (not E2E)
- **Wave 7.1 overlap**: 4 failures are known weak assertion issues documented in plan-v2.md
- **Model system impact**: Diagnostic and factory call failures suggest model system unification refactoring side effects
- **Tunnel diode isolated issue**: 3-test failure at one location suggests a single root cause (missing model data or initialization)

## Baseline Established

This baseline captures the state after recent model system unification work and serves as reference for ongoing Wave 4 compiler rewrite, Wave 6 SPICE apply, and Wave 7 test fixes.
