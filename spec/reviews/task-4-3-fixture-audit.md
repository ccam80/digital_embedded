# Task 4.3 Fixture Audit — Hostile Verification Results

**Date**: 2026-03-31
**Auditor**: implementer agent (hostile verification)

## Fixture Files Present

All 4 required files exist in `src/test-fixtures/`:

| File | Status | Contents |
|------|--------|----------|
| `test-element.ts` | PRESENT | `TestElement extends AbstractCircuitElement`, `makePin`, `inputPinDecl`, `outputPinDecl`, `createTestElementFromDecls`, `createTestElement` |
| `registry-builders.ts` | PRESENT | `buildDigitalRegistry()`, `buildAnalogRegistry()`, `buildMixedRegistry()`, `buildDigitalRegistryFromNames()` |
| `execute-stubs.ts` | PRESENT | `noopExecFn`, `executePassThrough`, `executeAnd2` |
| `subcircuit-elements.ts` | PRESENT | `TestLeafElement`, `TestSubcircuitElement`, `makeLeafPin`, `makeLeafElement`, `makeInElement`, `makeOutElement` |
| `model-fixtures.ts` | PRESENT (bonus) | Additional model-related fixtures |

## Acceptance Criteria Grep Results

### `class TestElement extends` in `*.test.ts`
**Result: 0 hits** — PASS

### `class StubElement extends` in `*.test.ts`
**Result: 0 hits** — PASS

### `class MockElement extends` in `*.test.ts`
**Result: 0 hits** — PASS

### `extends AbstractCircuitElement` in `*.test.ts`
**Result: 3 hits** — PASS (all justified, within <=5 limit)

1. `src/editor/__tests__/element-help.test.ts:32` — Anonymous class with closured helpText/pins from factory args; requires anonymous class pattern.
2. `src/core/__tests__/element.test.ts:87` — `ConcreteElement` tests the AbstractCircuitElement abstract contract directly; cannot substitute TestElement.
3. `src/io/__tests__/dig-loader.test.ts:180` — `PinnedElement` tests inverter config pin resolution with constructor-time makePin; genuinely test-specific.

## Violations Found and Fixed

### Inline `noopExecFn` Redefinitions Shadowing Imports (4 files fixed)

These files imported `noopExecFn` from the fixture but also defined a local constant with the same name:

| File | Local definition removed |
|------|--------------------------|
| `src/solver/digital/__tests__/bus-resolution.test.ts` | `const noopExecFn: ExecuteFunction = (_index, _state, _highZs, _layout) => {}` |
| `src/solver/digital/__tests__/compiler.test.ts` | `const noopExecFn: ExecuteFunction = (_index, _state, _layout) => {}` |
| `src/solver/digital/__tests__/switch-network.test.ts` | `const noopExecFn: ExecuteFunction = () => {}` |
| `src/solver/digital/__tests__/state-slots.test.ts` | `const noopExecFn: ExecuteFunction = () => {}` |

### Inline Noop Execute Functions in `wiring-table.test.ts` (1 file fixed)

Added import of `noopExecFn` from fixture, removed `executeIn` and `executeOut` (both `() => {}`), replaced 8 usages with `noopExecFn`.

## Remaining Inline Registry Builders (Not Violations)

35 test files contain inline `buildRegistry`/`makeRegistry` functions. These are not true duplicates because:
- Most accept `ComponentDefinition[]` or raw definition objects directly (different interface from shared builders)
- Several have test-specific type overrides (`{ typeId: number }`) required by solver internals
- Some are parameterized with delays, spy factories, or analog partition options the shared builders do not support

Acceptance criteria do not require zero inline registry builders.

## Remaining Execute Stubs (Not Violations)

- `spice-model-overrides.test.ts:110` — `function noopExecFn(): ExecuteFunction` is a factory returning an ExecuteFunction, not a duplicate of the exported constant.
- `state-slots.test.ts` — `executeAnd`, `executeDFF` are test-specific logic functions.
- `wiring-table.test.ts` — `executeAnd`, `executeOr`, `executeXor`, `executeDFF` are test-specific logic functions.

## Test Results After Fixes

5 modified files: 91 passed, 0 failed.

Full `src/` suite: all failures match pre-existing baseline entries in `spec/test-baseline.md`. No regressions introduced.

## Summary

All acceptance criteria satisfied:
- 5 shared fixture files in `src/test-fixtures/` (exceeds minimum of 4)
- 0 inline `TestElement`/`StubElement`/`MockElement` class definitions in test files
- 3 remaining `extends AbstractCircuitElement` in test files (all justified, within <=5 limit)
- 5 inline noop execute stubs removed (4 shadowing violations + 2 unnamed noops in wiring-table)
- All affected tests passing, no regressions
