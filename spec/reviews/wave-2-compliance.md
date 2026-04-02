# Wave 2 Strict Spec Compliance Review

Reviewed by: code-reviewer (opus)
Date: 2026-04-02
Spec source: spec/domain-leak-fix.md (Wave 2 section)

---

## scripts/mcp/formatters.ts -- Domain-aware formatting

### formatNetlist

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 1 | Component line shows [modelKey] tag from comp.modelKey | **PASS** | Line 53: modelTag derived from comp.modelKey |
| 2 | isAnalogOnly heuristic DELETED | **PASS** | Grep confirms zero matches in file |
| 3 | [mixed] heuristic DELETED | **PASS** | No mixed heuristic remains |
| 4 | Pin summary: branches on pin.domain -- [terminal] for analog, [N-bit, DIRECTION] for digital | **PASS** | Lines 38-41: analog to [terminal], digital to [bitWidth-bit, direction] |
| 5 | Net header: [N-bit, M pins] when net.bitWidth exists, [M pins] for analog nets | **PASS** | Lines 63-65: branches on net.bitWidth !== undefined |
| 6 | Net pin lines: label:pin [terminal] for analog, label:pin [N-bit, DIRECTION] for digital | **FAIL** | See FAIL detail section below |

### formatDiagnostics

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 7 | Shows message + explanation (if present) + suggestions text (if present) | **PASS** | Lines 16-24: shows d.message, d.explanation, iterates d.suggestions |
| 8 | -> Pins: appendage DELETED | **PASS** | Grep confirms no Pins: string in the file |

### formatComponentDefinition

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 9 | defIsAnalogOnly heuristic DELETED | **PASS** | Grep confirms zero matches |
| 10 | Pin display: always shows label [N-bit, DIRECTION] | **PASS** | Line 136: pin.label [pin.defaultBitWidth-bit, pin.direction] |
| 11 | [terminal, INPUT] special case DELETED | **PASS** | Grep confirms zero matches |

### Overall

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 12 | No isAnalogOnly, defIsAnalogOnly, or availableModels checks remain | **PASS** | Grep confirms zero matches for all three patterns |

---

## scripts/mcp/circuit-tools.ts -- MCP tool fixes

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 13 | circuit_describe_file tool registration DELETED entirely | **PASS** | Grep confirms zero matches |
| 14 | scanDigPins import REMOVED | **PASS** | No import present |
| 15 | circuit_list pin display: NO directional arrows | **PASS** | Line 295: labels only, no arrows |
| 16 | circuit_list category filter description: ANALOG added to examples | **PASS** | Line 258: includes ANALOG |
| 17 | circuit_test description: test vector format not Digital test format | **PASS** | Lines 576, 585: both say test vector format |
| 18 | circuit_test driver analysis: domain-aware | **PASS** | Lines 665-696: checks pins domain, analog shows connected components, digital traces INPUT pin |
| 19 | circuit_patch description: includes analog example | **PASS** | Line 336: resistance:10000 example present |
| 20 | circuit_compile output: when analog available, appends analog analysis guidance | **PASS** | Lines 534-537: checks supportsDcOp/supportsAcSweep, appends guidance |

---

## src/io/dig-pin-scanner.ts

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 21 | Spec says DELETE this file | **FAIL -- justified deviation** | See justified deviation section below |

---

## src/io/postmessage-adapter.ts -- Wire protocol rename

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 22 | sim-set-input to sim-set-signal (hard cut, old name gone) | **PASS** | Grep confirms zero matches for sim-set-input |
| 23 | sim-read-output to sim-read-signal (hard cut, old name gone) | **PASS** | Grep confirms zero matches for sim-read-output |
| 24 | Non-convergence error: cross-coupled latch advice REMOVED | **PASS** | Grep confirms zero matches. Generic message used |
| 25 | Test signal detection: uses labelSignalMap domain, NOT hardcoded whitelist | **PASS** | Lines 460-477: uses labelSignalMap, branches on addr.domain |
| 26 | Analog voltage sources with labels recognized as test inputs | **PASS** | Line 470-471: analog domain adds to circuitInputLabels |

---

## src/app/render-pipeline.ts -- Unified diagnostic overlays

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 27 | populateDiagnosticOverlays accepts Diagnostic[] not SolverDiagnostic[] | **PASS** | Line 348-349: parameter type is Diagnostic[] |
| 28 | Import from ../compile/types.js not ../core/analog-engine-interface.js | **PASS** | Line 16: correct import |
| 29 | Reads BOTH involvedNodes and involvedPositions | **PASS** | Lines 363-377: handles both paths |

---

## src/app/simulation-controller.ts

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 30 | NO forced as-unknown-as SolverDiagnostic[] cast | **PASS** | Grep confirms zero matches |
| 31 | Diagnostic[] passed directly | **PASS** | Line 308: native Diagnostic[] passed |

---

## Rename-only files

### src/testing/comparison.ts

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 32 | setInput to setSignal | **PASS** | Line 32: setSignal on ComparatorFacade |
| 33 | readOutput to readSignal | **PASS** | Line 33: readSignal on ComparatorFacade |
| 34 | runToStable to settle | **PASS** | Line 34: settle on ComparatorFacade |

### src/testing/run-all.ts

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 35 | All three renames applied | **PASS** | Grep confirms zero old names |

### src/analysis/model-analyser.ts

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 36 | setInput to setSignal | **PASS** | Line 103: facade.setSignal |
| 37 | readOutput to readSignal | **PASS** | Line 111: facade.readSignal |
| 38 | runToStable to settle | **PASS** | Line 107: await facade.settle |

### scripts/verify-fixes.ts

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 39 | setInput to setSignal | **PASS** | Uses runner.setSignal |
| 40 | readOutput to readSignal | **PASS** | Uses runner.readSignal |
| 41 | runToStable to settle | **PASS** | Uses await runner.settle |

---

## Deleted items (verify NONE remain)

| # | Item | Verdict | Notes |
|---|------|---------|-------|
| 42 | circuit_describe_file tool registration | **PASS** | Gone from circuit-tools.ts |
| 43 | defIsAnalogOnly / isAnalogOnly heuristics | **PASS** | Gone from formatters.ts |
| 44 | availableModels checks | **PASS** | Gone from formatters.ts |
| 45 | sim-set-input / sim-read-output message types | **PASS** | Gone from postmessage-adapter.ts |
| 46 | as-unknown-as SolverDiagnostic[] cast | **PASS** | Gone from simulation-controller.ts |

---

## Summary

| Verdict | Count |
|---------|-------|
| **PASS** | 44 |
| **FAIL** | 1 |
| **FAIL (justified deviation)** | 1 |
| **MISSING** | 0 |

---

## FAIL #6 -- Net pin lines in formatNetlist show [digital] instead of [N-bit, DIRECTION]

**Spec requirement:** Net pin lines for digital pins should display label:pin [N-bit, DIRECTION] (e.g., gate1:A [1-bit, INPUT]).

**Actual code** (formatters.ts line 68):

    const pinDetail = pin.domain === 'analog' ? '[terminal]' : '[digital]';

Shows gate1:A [digital] -- a flat domain tag with no width or direction information.

**Root cause:** The NetPin type (defined in netlist-types.ts lines 55-66) does not carry bitWidth or direction fields. It only has domain: string. The formatter cannot produce the spec-required format because the upstream type does not provide the data. This is a Wave 1 type gap that propagates into Wave 2 formatting.

**Severity:** MEDIUM -- The analog side is correct ([terminal]). The digital side provides less information than specified but is not incorrect. The data simply is not available on the NetPin type.

**Fix:** Either (a) add bitWidth and direction to NetPin in netlist-types.ts and populate them in buildNetlistView, then update the formatter to show [N-bit, DIRECTION]; or (b) cross-reference via netlist.components[pin.componentIndex].pins to find the matching PinDescriptor which does carry bitWidth and direction, and format from there. Option (b) requires no type changes and can be done entirely in formatters.ts.

---

## Justified Deviation -- src/io/dig-pin-scanner.ts not deleted

The spec says to delete this file, claiming the only consumer is circuit_describe_file at circuit-tools.ts line 16. This claim is incorrect -- scan74xxPinMap from this file is actively imported in scripts/circuit-mcp-server.ts line 16 and referenced in documentation comments in src/components/register-all.ts and src/components/library-74xx.ts. Deleting the file would break the MCP server and 74xx library registration. Keeping it is correct; only the circuit_describe_file tool registration was removed as required.

---

## Recommendation

**COMMENT** -- One MEDIUM issue found (net pin line format). No CRITICAL or HIGH issues. All deletions, renames, and structural changes match the spec. The single formatting gap is caused by an upstream type limitation in Wave 1, not a Wave 2 implementation error.
