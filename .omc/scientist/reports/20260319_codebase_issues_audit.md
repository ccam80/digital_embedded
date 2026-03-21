# Codebase Issues Audit — Exhaustive Marker Search

**Scope:** `src/`, `e2e/`, `scripts/`, `spec/`
**Date:** 2026-03-19
**Method:** Exhaustive grep for TODO/FIXME/HACK/BUG/STUB/WORKAROUND/LIMITATION/SKIP/NOT IMPLEMENTED/DEFERRED/FUTURE and targeted code pattern analysis across all TypeScript source files.

---

## Summary

| Category | Count | Severity |
|----------|-------|----------|
| BUG — Named regression defects (test-documented) | 7 | HIGH |
| LIMITATION — Runtime feature gaps (silent or partial) | 3 | HIGH |
| WORKAROUND — Tests working around missing internal API | 2 | MEDIUM |
| E2E Known Limitation — Untested scenario | 1 | MEDIUM |
| TEST_SKIP — Conditional no-op skips | 2 | LOW |
| STUB — Intentional test-double patterns (not production) | 2 | INFO |

---

## BUGS — Named regression defects (HIGH)

Documented in `src/headless/__tests__/stress-test-regressions.test.ts`. Each has an explicit BUG-N comment, a catalog entry at the top of the file, and a passing test that **verifies the fix**. The risk is whether the fix actually landed in the production source, not just in the test expectations.

| Bug ID | File | Line | Description | Production file to verify |
|--------|------|------|-------------|---------------------------|
| BUG-1 | `src/headless/__tests__/stress-test-regressions.test.ts` | 333 | Builder silently ignores unknown property names. Using `"Bits"` instead of `"bitWidth"` creates 1-bit components with zero diagnostic. Silent data corruption. | `src/headless/builder.ts` ~L138 |
| BUG-2 | `src/headless/__tests__/stress-test-regressions.test.ts` | 59 | `executeSplitter()` hardcodes width=1 for all output ports. A 16→8,8 split extracts bit 0 and bit 1 instead of the two bytes. | `src/components/wiring/splitter.ts` ~L354 |
| BUG-3 | `src/headless/__tests__/stress-test-regressions.test.ts` | 100 | `RegisterFile` `getPins()` calls `derivePins()` without overriding widths from `bitWidth`/`addrBits`. All pins stay 1-bit regardless of configuration. | `src/components/memory/register-file.ts` |
| BUG-4 | `src/headless/__tests__/stress-test-regressions.test.ts` | 376 | ROM `data` property as string is silently ignored — only an array is accepted. No diagnostic emitted. | `src/components/memory/rom.ts` |
| BUG-5a | `src/headless/__tests__/stress-test-regressions.test.ts` | 137 | D_FF `~Q` output not masked to bit width. For Q=0 on a 1-bit FF, `(~q) >>> 0` produces `0xFFFFFFFF` instead of `1`. Comment at line 161 explicitly notes the wrong value. | `src/components/flipflops/d.ts` ~L166 |
| BUG-5b | `src/headless/__tests__/stress-test-regressions.test.ts` | 203 | `isSequentialComponent()` in `compiler.ts` uses Java naming conventions (`"Flipflop*"`, `"DFF"`) while the TS port uses `"D_FF"`, `"JK_FF"` etc. Result: `sampleFn` is never called for any flip-flop — edge-triggered logic never captures data. | `src/engine/compiler.ts` ~L897 |
| BUG-7 | `src/headless/__tests__/stress-test-regressions.test.ts` | 269 | `executeBarrelShifter()` delegates to `makeExecuteBarrelShifter(8, ...)` hardcoded, ignoring the component's actual `bitWidth` property. A 32-bit barrel shifter silently operates at 8-bit width. | `src/components/arithmetic/barrel-shifter.ts` ~L196 |

**Note:** BUG-6 is absent from the catalog — that number was skipped in the regression test file.

---

## LIMITATIONS — Runtime feature gaps (HIGH)

| ID | File | Line | Description | Impact |
|----|------|------|-------------|--------|
| L-1 | `e2e/fixtures/simulator-harness.ts` | 13–14 | `digital-set-input`, `digital-step`, `digital-read-output`, `digital-read-all-signals` are **defined in `PostMessageAdapter`** but **NOT wired in `app-init.ts`**. These four postMessage command types are silently ignored when sent to the browser simulator. The harness comment reads verbatim: *"are defined in PostMessageAdapter but NOT wired in app-init.ts"*. | HIGH — tutorial host cannot drive input pins or step the simulation via postMessage in GUI mode. The entire interactive tutorial use-case depends on these messages. |
| L-2 | `src/analog/model-library.ts` | 208–228 | SPICE `.MODEL` Level > 2 is unsupported. Levels 3, 4, BSIM, etc. silently fall back to Level 2 equations with a `"warning"` diagnostic. Simulation does not fail — it continues with wrong parameters. | MEDIUM — incorrect analog results for advanced MOSFET models (BSIM3/BSIM4, Level 3 MOSFET). No visual indicator beyond a diagnostic in the diagnostics panel. |
| L-3 | `src/components/active/__tests__/real-opamp.test.ts` | 527 | Op-amp output current limiting is not implemented as an explicit nonlinear saturation clamp in the MNA model. Only passive `R_out` (75 Ω) limits current. Comment states: *"Current limiting is not implemented as an explicit nonlinear clamp in this model."* | MEDIUM — op-amp output current is not clamped at real hardware limits; results diverge from physical device at saturation. Documented in test comment only, not surfaced to user. |

---

## WORKAROUNDS — Tests working around missing internal API (MEDIUM)

Both workarounds share the same root cause: the engine's internal `_values` signal array is not accessible through any public API, forcing tests to use `setSignalValue()` with raw state-slot indices as surrogate net IDs.

| ID | File | Line | Description |
|----|------|------|-------------|
| W-1 | `src/engine/__tests__/snapshot.test.ts` | 158–159 | Comment: *"BitVector-free workaround: use a circuit that writes specific values per step iteration"*. Test cannot directly seed signal state so builds a counter circuit instead. |
| W-2 | `src/engine/__tests__/two-phase.test.ts` | 343–348 | Comment: *"engine's internal `_values` array is not directly accessible, but we can use a workaround"*. Test writes state slot indices as if they were net IDs via `setSignalValue()`. |

**Production impact:** None directly. But the missing public API (`engine.setStateSlot(componentIdx, slotIdx, value)` or similar) means any future test of stateful components must use the same fragile trick.

---

## E2E KNOWN LIMITATION (MEDIUM)

| File | Line | Description |
|------|------|-------------|
| `e2e/gui/workflow-tests.spec.ts` | 518 | Slider panel population during analog simulation is not tested. Comment: *"sliders populate on selection change which requires canvas clicks that are currently blocked during analog sim (known limitation)"*. The test asserts the panel container exists but does not verify that sliders populate when components are selected during a live run. |

---

## TEST_SKIP — Conditional no-op skips (LOW)

These fire only when the fixture directory is empty, as a guard against Vitest's "no tests found" error. They are not hiding real test cases.

| File | Line | Condition |
|------|------|-----------|
| `src/fixtures/__tests__/shape-audit.test.ts` | 150 | `it.skip("no fixtures found", () => {})` — placeholder when fixture dir is empty |
| `src/fixtures/__tests__/fixture-audit.test.ts` | 200 | Same pattern |

---

## STUBS — Intentional test-double patterns (INFO — not production bugs)

These are correctly scoped partial mocks. They throw `'not implemented'` only on methods the test does not need. They would fail loudly if a wrong code path called them.

| File | Lines | Description |
|------|-------|-------------|
| `src/analysis/__tests__/model-analyser.test.ts` | 189–212 | 12 facade methods stubbed out; only `analyseCircuit()` / `compile()` / `step()` / `runToStable()` / `readAllSignals()` are implemented in the mock. |
| `src/analysis/__tests__/dependency.test.ts` | 139–162 | Same partial facade mock pattern. |

---

## ACTION PRIORITY TABLE

| Priority | ID | Item | Recommended Action |
|----------|----|------|--------------------|
| P0 | L-1 | `digital-set-input` / `digital-step` / `digital-read-output` / `digital-read-all-signals` not wired in `app-init.ts` | Wire these four postMessage types in `app-init.ts`; add E2E parity tests using `SimulatorHarness` |
| P1 | BUG-5b | `isSequentialComponent()` Java naming mismatch — `sampleFn` never called | Fix type name list in `src/engine/compiler.ts`; run two-phase tests to confirm flip-flops capture |
| P1 | BUG-5a | D_FF `~Q` not bit-masked | Apply `(~q & ((1 << bitWidth) - 1)) >>> 0` in `src/components/flipflops/d.ts` |
| P1 | BUG-2 | Splitter hardcoded width=1 | Verify `executeSplitter` uses `parsePorts()` for per-port widths in `splitter.ts` |
| P2 | BUG-7 | BarrelShifter hardcoded `bitWidth=8` | Read `getProperty('bitWidth')` in `executeBarrelShifter` |
| P2 | BUG-1 | Builder silent unknown properties | Emit `unknown-property` diagnostic when key not in `propertyDefs` |
| P2 | BUG-3 | RegisterFile pin scaling | Pass `bitWidth`/`addrBits` through `derivePins()` |
| P2 | BUG-4 | ROM string data silently ignored | Accept string → parse as hex/decimal array, or emit `invalid-property` diagnostic |
| P3 | L-3 | Op-amp no current clamp | Document model limitation in `RealOpAmp` component help text; optionally add VCCS clamp |
| P3 | L-2 | SPICE Level >2 silent fallback | Add user-visible warning in the analog diagnostics panel; document supported levels |
| P3 | E2E | Slider panel not tested during analog run | Add canvas-click test for component selection → slider population during analog simulation |
| P4 | W-1/W-2 | Engine internal state not accessible | Add `engine.setStateRaw(offset, value)` or similar low-level test API to avoid index-as-net-id tricks |
