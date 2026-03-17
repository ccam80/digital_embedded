# Test Baseline

- **Timestamp**: 2026-03-17T00:25:59Z
- **Phase**: Phase 0 - Interface Abstraction (Dead Code Removal Complete)
- **Command**: `npx vitest run`
- **Result**: 5524/5529 passing, 5 failing, 0 errors
- **Test Files**: 207 passed / 208 total
- **Duration**: 19.92s (total including setup and collection: 154.28s)

## Failing Tests (pre-existing)

| Test | Status | Summary |
|------|--------|---------|
| `src/fixtures/__tests__/fixture-audit.test.ts > fixture audit > 'Sim/all-components.dig' > tunnel pins connected` | FAIL | 1 disconnected tunnel at (0, 64) in all-components.dig |
| `src/fixtures/__tests__/fixture-audit.test.ts > fixture audit > 'Sim/Processor/cpu_final.dig' > wire endpoints meet pins or junctions` | FAIL | 3 orphan wire endpoints at (-38, 48), (-38, 36), (-38, 44) in cpu_final.dig |
| `src/fixtures/__tests__/fixture-audit.test.ts > fixture audit > 'Sim/TC.dig' > wire endpoints meet pins or junctions` | FAIL | 1 orphan wire endpoint (not shown in output) in TC.dig |
| `src/fixtures/__tests__/fixture-audit.test.ts > fixture audit > 'Sim/TC_testing.dig' > wire endpoints meet pins or junctions` | FAIL | 1 orphan wire endpoint at (135, 18) in TC_testing.dig |
| `src/fixtures/__tests__/fixture-audit.test.ts > fixture audit > 'mod3/Sim/cpu_layout_final.dig' > tunnel pins connected` | FAIL | 25 disconnected tunnels in cpu_layout_final.dig at various coordinates |

## Test Coverage

All test failures are in the fixture audit suite (`src/fixtures/__tests__/fixture-audit.test.ts`), which validates the integrity of reference circuit files (.dig files). These are pre-existing failures related to geometric validation (orphan wire endpoints and disconnected tunnels) in complex test fixtures, not regressions in the simulator engine itself.

Main test categories passing:
- Core engine (clock, digital engine, compiler, micro-step, etc.)
- All component types (gates, arithmetic, memory, flipflops, I/O, etc.)
- Circuit builder and headless facade
- Test execution and validation
- UI components (editor, palette, rendering)
- Tutorial system
- File I/O and serialization
- Analysis tools (Karnaugh maps, truth tables, synthesis)
