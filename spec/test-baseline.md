# Test Baseline

- **Timestamp**: 2026-03-05T17:55:31Z
- **Phase**: Phase 5.5 (cross-cutting modifications about to start)
- **Command**: `npm test` (vitest run)
- **Result**: 3419/3420 passing, 1 failing, 0 errors

## Test Summary

- **Total Test Files**: 115 passed
- **Total Tests**: 3420 tests run (1 skipped)
- **Pass Rate**: 99.97% (3419/3420)
- **Duration**: 7.79s total (test execution 2.52s)

## Failing Tests (pre-existing)

| Test | Status | Summary |
|------|--------|---------|
| src/engine/__tests__/run-to-break.test.ts > RunToBreak > reportsBreakComponent — verify breakComponent index matches the Break element | FAIL | Expected stop reason 'break' but received 'maxSteps'; break point detection logic returns incorrect stop reason when Break component is encountered |

## Test File Breakdown (Selected Key Files)

Test files passing across all major subsystems:
- **Core/Engine**: pin.test.ts, signal.test.ts, engine-interface.test.ts, compiler.test.ts, bus-resolution.test.ts, net-resolver.test.ts, noise-mode.test.ts, delay.test.ts, oscillation.test.ts, worker-detection.test.ts, quick-run.test.ts
- **Components**: 50+ test files covering gates, arithmetic, memory, I/O, graphics, flipflops, switches, wiring, PLD, terminal, MIDI, segment displays, rotary encoders, VGA, LED matrix
- **Editor**: element-renderer.test.ts, viewport.test.ts, wire-drawing.test.ts, palette.test.ts, canvas-renderer.test.ts, insert-subcircuit.test.ts, edit-operations.test.ts, selection.test.ts, placement.test.ts, label-tools.test.ts, wire-renderer.test.ts, grid.test.ts, undo-redo.test.ts, coordinates.test.ts, locked-mode.test.ts, shortcuts.test.ts, search.test.ts, settings.test.ts, context-menu.test.ts, file-history.test.ts
- **I/O & Headless**: dig-schema.test.ts, save.test.ts, integration.test.ts, runner.test.ts, loader.test.ts, trace.test.ts, facade-types.test.ts, fence.test.ts

## Pre-existing Issue Details

The single failing test is a pre-existing condition in the break-point detection feature. The engine's `run()` function returns `maxSteps` as the stop reason when it should return `break` when a Break component is encountered during execution. This issue is independent of Phase 5.5 modifications and should be tracked separately for future resolution.
