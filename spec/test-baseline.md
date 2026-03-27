# Test Baseline

- **Timestamp**: 2026-03-27T13:02:53Z
- **Phase**: Subcircuit Extraction (Phase 5)
- **Command**: `npm test`
- **Result**: Unit/Integration: 7644/7644 tests, 7640 passing, 4 failing | E2E: 502 tests, 315 passing, 187 failing

## Summary

### Unit/Integration Tests (Vitest)
- **Test Files**: 334 passed, 2 failed (336 total)
- **Tests**: 7640 passed, 4 failed (7644 total)
- **Duration**: 25.90s (transform 17.37s, collect 63.75s, tests 33.93s, environment 5.25s, prepare 44.33s)

### E2E Tests (Playwright)
- **Tests**: 315 passed, 187 failed (502 total)
- **Duration**: 3.6 minutes

## Failing Tests (Pre-existing Unit Tests)

| Test | File | Status | Summary |
|------|------|--------|---------|
| DigParser > parsesRotation | src/io/__tests__/dig-parser.test.ts | FAIL | ENOENT: missing `ref/Digital/src/main/dig/combinatorial/mux.dig` — git submodule not initialized |
| DigParser > resolvesXStreamReference | src/io/__tests__/dig-parser.test.ts | FAIL | ENOENT: missing `ref/Digital/src/main/dig/combinatorial/mux.dig` — git submodule not initialized |
| DigParser > parsesInputCount | src/io/__tests__/dig-parser.test.ts | FAIL | ENOENT: missing `ref/Digital/src/main/dig/combinatorial/mux.dig` — git submodule not initialized |
| Generic > genAndExample | src/io/__tests__/resolve-generics.test.ts | FAIL | ENOENT: missing `ref/Digital/src/main/dig/generic/modify/genAnd.dig` — git submodule not initialized |

## E2E Test Failures (187 total)

### Failure Categories

1. **Analog Circuit Assembly (15 failures)**
   - RC lowpass, voltage divider, RL circuit, RLC series/parallel, diode rectifier, zener regulator, BJT common-emitter, differential pair, Darlington pair, push-pull, MOSFET, CMOS inverter/NAND, JFET, cascode, Wilson current mirror
   - Root cause: Analog solver convergence or circuit assembly workflow issue

2. **74XX Component Placement (10 failures)**
   - 7400, 7402, 7404, 7408, 7432, 7486, 74138, 74161, 74245, others
   - Root cause: 74XX subcircuit loading or palette availability

3. **Component Bit-Width Sweep (7 failures)**
   - Multiplexer, Demux, BitExtender, Splitter, Tunnel at various widths
   - Root cause: Property setting or compilation with non-default widths

4. **Per-Component Engine Mode Sweep (13 failures)**
   - Logic gates (And, Or, NAnd, NOr, XOr, XNOr) in analog mode; flip-flops (D_FF, JK_FF, T_FF, RS_FF) in analog mode; DAC, ADC, VoltageComparator in mixed mode
   - Root cause: Dual-domain component registration or engine bridging

5. **Digital Circuit Assembly (13 failures)**
   - Decoder, 4:1 Mux, ROM, RAM, Register file, Priority encoder, Bus splitter, T flip-flop counter
   - Root cause: Memory/sequential component simulation or test vector matching

6. **Mixed-Mode Circuit Assembly (10 failures)**
   - DAC+filter, digital gate driving analog load, Schmitt trigger, comparator, ADC, PWM, servo loop, transistor level-shift, relay, switching transient, 555 timer
   - Root cause: Engine bridge (SimulationCoordinator) signal routing or mode transition

7. **Speed Control Tests (2 failures)**
   - Speed button interaction, manual speed entry
   - Root cause: Speed control widget or simulation rate binding

## Notes

1. **Git Submodule Status**: The 4 unit test failures are pre-existing and due to missing `ref/Digital/` reference files. These can be resolved by initializing submodules:
   ```bash
   git submodule update --init
   ```

2. **E2E Test Regression**: 187 E2E test failures indicate a significant regression since the previous baseline (which had only 4 unit test failures and no mention of E2E failures). The failures span all major functional areas:
   - Analog circuit simulation
   - Component palette loading (especially 74XX series)
   - Component property configuration
   - Mixed-mode engine bridging
   - Digital sequential logic
   - User interaction (speed controls)

3. **Capture Point**: This baseline was captured at the START of Phase 5 (Subcircuit Extraction) work to establish a reproducible pre-work state for regression testing during implementation.
