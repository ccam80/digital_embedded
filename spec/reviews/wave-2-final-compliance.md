# Wave 2 Final Strict Spec Compliance Review

Reviewed by: code-reviewer (opus)
Date: 2026-04-02
Spec source: spec/domain-leak-fix.md (Wave 2 section)
Previous review: spec/reviews/wave-2-compliance.md (1 FAIL: net pin lines)

---

## scripts/mcp/formatters.ts -- Domain-aware formatting

### formatNetlist

| # | Requirement | Verdict | Evidence |
|---|-------------|---------|----------|
| 1 | Component line shows `[modelKey]` tag from `comp.modelKey` | **PASS** | Line 53: `const modelTag = comp.modelKey ? \` [\${comp.modelKey}]\` : "";` |
| 2 | `isAnalogOnly` heuristic DELETED | **PASS** | Grep: zero matches in file |
| 3 | `[mixed]` heuristic DELETED | **PASS** | No mixed heuristic remains |
| 4 | Pin summary: `[terminal]` for analog, `[N-bit, DIRECTION]` for digital | **PASS** | Lines 38-41: branches on `p.domain === 'analog'` |
| 5 | Net header: `[N-bit, M pins]` when `net.bitWidth` exists, `[M pins]` for analog | **PASS** | Lines 63-65: branches on `net.bitWidth !== undefined` |
| 6 | Net pin lines: `label:pin [terminal]` for analog, `label:pin [N-bit, DIRECTION]` for digital | **PASS** | Lines 69-78: analog gets `[terminal]`; digital cross-references `netlist.components[pin.componentIndex].pins` to find `PinDescriptor` with `bitWidth` and `direction`, producing `[N-bit, DIRECTION]`. Falls back to `[digital]` only when PinDescriptor data is missing (defensive). **Previously FAIL, now fixed.** |

### formatDiagnostics

| # | Requirement | Verdict | Evidence |
|---|-------------|---------|----------|
| 7 | Shows `message` + `explanation` + `suggestions` | **PASS** | Lines 16-24: shows `d.message`, `d.explanation`, iterates `d.suggestions` |
| 8 | `-> Pins:` appendage DELETED | **PASS** | Grep: zero matches for `Pins:` pattern in file |

### formatComponentDefinition

| # | Requirement | Verdict | Evidence |
|---|-------------|---------|----------|
| 9 | `defIsAnalogOnly` heuristic DELETED | **PASS** | Grep: zero matches in file |
| 10 | Pin display: always shows `label [N-bit, DIRECTION]` | **PASS** | Line 147: `pin.label [pin.defaultBitWidth-bit, pin.direction]` |
| 11 | `[terminal, INPUT]` special case DELETED | **PASS** | Grep: zero matches in file |

### Overall

| # | Requirement | Verdict | Evidence |
|---|-------------|---------|----------|
| 12 | No `isAnalogOnly`, `defIsAnalogOnly`, or `availableModels` anywhere in file | **PASS** | Grep: zero matches for all three patterns |

---

## scripts/mcp/circuit-tools.ts -- MCP tool fixes

| # | Requirement | Verdict | Evidence |
|---|-------------|---------|----------|
| 13 | `circuit_describe_file` DELETED | **PASS** | Grep: zero matches in file |
| 14 | `scanDigPins` import REMOVED | **PASS** | Grep: zero matches in file |
| 15 | `circuit_list` pins: NO directional arrows | **PASS** | Line 295: `def.pinLayout.map((p) => p.label).join(" ")` -- labels only, no arrows |
| 16 | `circuit_list` category: ANALOG in examples | **PASS** | Line 258: category filter description includes `"ANALOG"` |
| 17 | `circuit_test` description: "test vector format" | **PASS** | Lines 575-576, 585: both say "test vector format", not "Digital test format" |
| 18 | `circuit_test` driver analysis: domain-aware | **PASS** | Lines 664-696: checks `outComp.pins.every(p => p.domain === 'analog')`, analog shows connected components without directional language, digital traces INPUT pin |
| 19 | `circuit_patch`: analog example present | **PASS** | Line 336: `{op:'set', target:'R1', props:{resistance:10000}}` |
| 20 | `circuit_compile`: analog tool suggestions when available | **PASS** | Lines 534-537: checks `supportsDcOp()`/`supportsAcSweep()`, appends "For analog analysis: circuit_dc_op, circuit_ac_sweep." |

---

## src/io/postmessage-adapter.ts -- Wire protocol rename

| # | Requirement | Verdict | Evidence |
|---|-------------|---------|----------|
| 21 | `sim-set-input` / `sim-read-output` DO NOT EXIST | **PASS** | Grep: zero matches for either pattern. Replaced by `sim-set-signal` (line 239) and `sim-read-signal` (line 245) |
| 22 | Non-convergence: no "cross-coupled latch" mention | **PASS** | Grep: zero matches for `cross-coupled` or `cross.coupled`. Line 511: generic "Circuit did not converge within iteration limit." |
| 23 | Test signal detection: uses `labelSignalMap` domain, not hardcoded whitelist | **PASS** | Lines 460-477: iterates elements, checks `addr.domain === 'analog'` from `coordinator.compiled.labelSignalMap`, analog sources added to `circuitInputLabels` |

---

## src/app/render-pipeline.ts + simulation-controller.ts

| # | Requirement | Verdict | Evidence |
|---|-------------|---------|----------|
| 24 | `populateDiagnosticOverlays` accepts `Diagnostic[]` | **PASS** | Line 348-349: `diags: Diagnostic[]` parameter type |
| 25 | Import from `compile/types.js` | **PASS** | Line 16: `import type { Diagnostic } from '../compile/types.js';` |
| 26 | Handles both `involvedNodes` and `involvedPositions` | **PASS** | Lines 363-377: two separate `if` blocks for each field |
| 27 | No `as unknown as SolverDiagnostic[]` cast | **PASS** | Grep: zero matches in `simulation-controller.ts`. Line 308: `Diagnostic[]` passed directly |

---

## Rename-only files

### src/testing/comparison.ts

| # | Requirement | Verdict | Evidence |
|---|-------------|---------|----------|
| 28 | Uses `setSignal` / `readSignal` / `settle` | **PASS** | Lines 32-34: interface declares `setSignal`, `readSignal`, `settle`. Grep: zero matches for old names `setInput`/`readOutput`/`runToStable` |

### src/testing/run-all.ts

| # | Requirement | Verdict | Evidence |
|---|-------------|---------|----------|
| 29 | All three renames applied | **PASS** | Grep: zero matches for old names. Line 83 comment references `setSignal/readSignal/settle` |

### src/analysis/model-analyser.ts

| # | Requirement | Verdict | Evidence |
|---|-------------|---------|----------|
| 30 | Uses `setSignal` / `readSignal` / `settle` | **PASS** | Lines 103, 107, 111: `facade.setSignal`, `await facade.settle`, `facade.readSignal`. Grep: zero matches for old names |

### scripts/verify-fixes.ts

| # | Requirement | Verdict | Evidence |
|---|-------------|---------|----------|
| 31 | Uses `setSignal` / `readSignal` / `settle` | **PASS** | Lines 28, 42, 66-139: `runner.setSignal`, `runner.readSignal`, `await runner.settle`. Grep: zero matches for old names |

---

## Deleted items (verify NONE remain)

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| 32 | `circuit_describe_file` gone from circuit-tools.ts | **PASS** | Grep: zero matches |
| 33 | `defIsAnalogOnly` / `isAnalogOnly` gone from formatters.ts | **PASS** | Grep: zero matches |
| 34 | `availableModels` gone from formatters.ts | **PASS** | Grep: zero matches |
| 35 | `sim-set-input` / `sim-read-output` gone from postmessage-adapter.ts | **PASS** | Grep: zero matches |
| 36 | `as unknown as SolverDiagnostic[]` gone from simulation-controller.ts | **PASS** | Grep: zero matches |

---

## Summary

| Verdict | Count |
|---------|-------|
| **PASS** | 36 |
| **FAIL** | 0 |

**All 36 checklist items PASS.** The previously-failed net pin line formatting (item #6) has been corrected: digital pins in net listings now show `[N-bit, DIRECTION]` by cross-referencing the `PinDescriptor` from `netlist.components[pin.componentIndex].pins`, matching the spec requirement exactly.

---

## Recommendation

**APPROVE** -- 100% spec compliance across all Wave 2 items. No deviations, no regressions.
