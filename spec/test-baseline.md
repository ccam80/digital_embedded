# Test Baseline

- **Timestamp**: 2026-03-18T07:50:37Z
- **Phase**: Phase 2 + Phase 3 + Phase 4a (Analog Engine + Components)
- **Command**: `npm test` (vitest run)
- **Result**: 5914/5920 passing, 6 failing, 0 errors
- **Test Files**: 234 passed / 236 total
- **Duration**: 26.58s (total including setup and collection)

## Summary

| Metric | Value |
|--------|-------|
| Total Tests | 5920 |
| Passed | 5914 (99.9%) |
| Failed | 6 (0.1%) |
| Test Files | 234 passed, 2 failed |
| Duration | 26.58s |

## Failing Tests (pre-existing)

| Test | Status | Summary |
|------|--------|---------|
| src/analog/__tests__/sparse-solver.test.ts > SparseSolver > performance_50_node | FAIL | Performance: factorization took 2.96ms, threshold 2.5ms (0.5ms × 5 CI relaxation) |
| src/fixtures/__tests__/fixture-audit.test.ts > 'Sim/all-components.dig' > tunnel pins connected | FAIL | 1 disconnected tunnel at (0, 64) — fixture wiring issue |
| src/fixtures/__tests__/fixture-audit.test.ts > 'Sim/Processor/cpu_final.dig' > wire endpoints meet pins or junctions | FAIL | 3 orphan wire endpoints at (-38, 48), (-38, 36), (-38, 44) — fixture geometry |
| src/fixtures/__tests__/fixture-audit.test.ts > 'Sim/TC.dig' > wire endpoints meet pins or junctions | FAIL | 1 orphan wire endpoint at (135, 18) — fixture geometry |
| src/fixtures/__tests__/fixture-audit.test.ts > 'Sim/TC_testing.dig' > wire endpoints meet pins or junctions | FAIL | 1 orphan wire endpoint at (135, 18) — fixture geometry |
| src/fixtures/__tests__/fixture-audit.test.ts > 'mod3/Sim/cpu_layout_final.dig' > tunnel pins connected | FAIL | 25 disconnected tunnels in range (-40 to -31, y: 34-49) — fixture wiring |

## Classification

- **Performance failure** (1): SparseSolver performance threshold slightly exceeded
- **Fixture geometry issues** (4): Orphan wire endpoints in various .dig files
- **Fixture wiring issues** (2): Disconnected tunnel components in complex circuits

All failures are pre-existing issues in test fixtures or performance thresholds, not regressions in Phase 2/3/4a implementation.

## Test Coverage (All Passing)

- Core engine (clock, digital engine, compiler, micro-step, timing wheel, state slots, switch network)
- Analog engine (MNA solver, Newton-Raphson, sparse matrix factorization, DC operating point)
- All component types (gates, arithmetic, memory, flipflops, I/O, switching, semiconductors, etc.)
- Circuit builder and headless facade
- Test execution and validation
- UI components (editor, palette, rendering, wire drawing, auto-power)
- Tutorial system and markdown rendering
- File I/O and serialization
- Analysis tools (Karnaugh maps, truth tables, synthesis, expression parser, JK synthesis)
- HGS scripting and parity checking
- Graphics components (VGA, graphics card)
- Terminal emulation
