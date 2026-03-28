# Spec Review: Combined Report — timed-simulation.md

## Overall Verdict: needs-revision

## Dimension Summary
| Dimension | Issues | Severity |
|-----------|--------|----------|
| Consistency | 4 | 1 blocking, 3 quality |
| Completeness | 6 | 3 blocking, 3 quality |
| Concreteness | 5 | 2 blocking, 3 quality |
| Implementability | 4 | 2 blocking, 2 quality |

## Cross-Codebase Verification

Independent code verification confirmed or corrected spec claims:

| Claim | Verdict | Notes |
|-------|---------|-------|
| `_stepTimed` is dead code | **Partially correct** | Method exists with switch case (line 364), but `new DigitalEngine("timed")` appears nowhere — no caller activates timed mode |
| TimingWheel: 311 lines, 13+ tests, unused | **Confirmed** | 22 tests total; imported only in test file |
| EventPool: 92 lines, 4 tests, unused | **Confirmed** | Tests embedded in timing-wheel.test.ts |
| Bug 1: executeFn writes immediately | **Confirmed** | Line 1015; snapshots captured (1007-1012) but never restored |
| Bug 2: No shadow buffer | **Confirmed in _stepTimed** | Shadow buffer exists in main engine path but is absent from _stepTimed |
| Bug 3: No sample phase | **Confirmed in _stepTimed** | Sample phase exists at lines 651-658 in _stepLevel, absent from _stepTimed |
| Bug 4: No feedback handling | **Confirmed in _stepTimed** | Feedback iteration exists in _stepLevel, absent from _stepTimed |
| Bug 5: No bus resolution | **Confirmed in _stepTimed** | Bus resolution exists in _stepLevel, absent from _stepTimed |
| Bug 6: Uses TimedEvent[] not TimingWheel | **Confirmed** | _pendingTimedEvents array at line 211 |
| Bug 7: O(n) operations | **Confirmed** | filter at 980, sort at 983, filter at 991, findIndex at 1028 |
| delays Uint32Array "unused" | **Incorrect** | Already read at _stepTimed line 1018: `delays[idx] ?? 10` |
| DEFAULT_GATE_DELAY = 10 at delay.ts:15 | **Confirmed** | Also duplicated in compiler.ts:691 |
| TimedConfig at evaluation-mode.ts:35 | **Confirmed** | Has `kind: "timed"` and `defaultDelay: number` |
| 3-level delay resolution in compiler.ts:688-703 | **Confirmed** | Instance prop -> def.defaultDelay -> DEFAULT_GATE_DELAY |
| TimingWheel: dedup, sorted advance, 1024 slots | **Confirmed** | All features present |

---

## Blocking Issues (must fix before implementation)

### B1. Timed mode has no activation path
**Location**: Completeness gap — no API surface specified
**Problem**: `coordinator.ts:115` and `:151` both hardcode `new DigitalEngine('level')`. The spec describes no API changes to coordinator, facade, or postMessage adapter. The fixed `_stepTimed` will remain unreachable.
**Suggestion**: Add a section specifying: (a) how callers request timed mode (TimedConfig in compile options?), (b) which files change (coordinator.ts, possibly facade.ts), (c) whether mode switching at runtime is supported.

### B2. Phase 4 (bus resolution) is an empty stub
**Location**: Pseudocode Phase 4
**Problem**: Bug 5 is identified but the fix is a one-line comment with zero pseudocode. `_stepLevel` has a non-trivial bus resolution flow: `_resolveAllSwitches()`, `busResolver.checkAllBurns()`, `busResolver.onNetChanged()`. An implementer has nothing to work from.
**Suggestion**: Specify whether timed mode reuses the same bus resolution helpers, at what point in the step they run, and how deferred outputs interact with contention detection.

### B3. Phase 3 does not fix Bug 4 (feedback SCCs)
**Location**: Pseudocode Phase 3
**Problem**: The pseudocode iterates `evaluationOrder` in a single pass per group. No special handling for `isFeedback=true` groups (which require iterative convergence in level mode). The bug is named but the fix is absent.
**Suggestion**: Specify whether feedback groups iterate to stability within a single tick, are scheduled as multi-tick convergence, or use a different strategy.

### B4. Pseudocode uses undefined variables
**Location**: Pseudocode Phase 3 — `newVal`, `newHighZ`
**Problem**: The capture-restore sequence is: snapshot -> execute -> ??? -> restore -> schedule. `newVal` and `newHighZ` are never assigned. Getting this wrong silently schedules restored (pre-execute) values instead of computed values.
**Suggestion**: Make explicit: `newVal = state[netId]` and `newHighZ = highZs[netId]` captured *after* executeFn, *before* restore.

### B5. No acceptance criteria or test specification
**Location**: Completeness gaps — no tests, no criteria
**Problem**: The spec says "Unit tests: Medium (1 day)" but names no test file, no test cases, no assertions. Violates the Three-Surface Testing Rule from CLAUDE.md (headless + MCP + E2E).
**Suggestion**: Add acceptance criteria section with concrete scenarios: ring oscillator period = 2x gate delay, D flip-flop samples on edge, tristate bus burn detection. Specify test file paths for all three surfaces.

---

## Quality Issues (should fix for better implementation)

### Q1. TimedConfig field conflict unresolved
**Location**: Configuration section
**Problem**: Existing `defaultDelay: number` vs proposed `tickSize?: number` — overlapping semantics, no disposition specified.
**Suggestion**: Clarify: does `tickSize` replace `defaultDelay`? Are they orthogonal (tick quantum vs fallback component delay)?

### Q2. delays array incorrectly described as "unused"
**Location**: Key Files section
**Problem**: Line 1018 already reads `delays[idx] ?? 10`. Calling it "unused" may mislead implementers.
**Suggestion**: Change to "populated and partially used" or remove the claim.

### Q3. TimingWheel construction parameters unspecified
**Location**: Completeness gap
**Problem**: Constructor needs `wheelSize` and `poolSize`. EventPool docs say `poolSize = 2 * netCount`, only known post-compilation. Where and when is the instance created?
**Suggestion**: Specify lifecycle: created in `loadCircuit()` after compilation, sized to `2 * compiled.netCount`, cleared on reset/dispose.

### Q4. advance() frees events before caller reads them
**Location**: Implementability concern
**Problem**: `timing-wheel.ts:155-157` frees returned events back to pool inside `advance()`. If Phase 3's `schedule()` calls trigger pool reuse, Phase 1 event objects can be silently overwritten mid-iteration.
**Suggestion**: Note that Phase 1 events must be fully consumed (values copied to state) before any Phase 3 `schedule()` calls. Or note that advance() returns copies, not pooled objects.

### Q5. Sequential sampling interaction with deferred values unspecified
**Location**: Concreteness gap
**Problem**: Phase 2 calls `sampleFn` after applying due events. Should sample outputs also be deferred through the wheel? How does clock-edge detection interact with per-net deduplication?
**Suggestion**: Specify that sample outputs are applied immediately (they represent latched state, not propagation).

### Q6. No file modification list
**Location**: Completeness gap
**Problem**: Only names the rewrite target. Missing: evaluation-mode.ts (TimedConfig), digital-engine.ts imports (TimingWheel, EventPool), removal of TimedEvent/_pendingTimedEvents.
**Suggestion**: Add explicit file list with what changes in each.

### Q7. Old code removal not specified
**Location**: Implementability concern
**Problem**: `_pendingTimedEvents: TimedEvent[]` (line 211) and the `TimedEvent` interface must be removed when replaced by TimingWheel. Not stated.
**Suggestion**: Explicitly list removals per "scorched earth" rule.

### Q8. tickSize vs bigint representation gap
**Location**: Concreteness gap
**Problem**: Proposed `tickSize?: number` but internal code uses `bigint` (`10n`). Conversion strategy unspecified.
**Suggestion**: State whether internal representation stays bigint with `BigInt(tickSize)` conversion, or switches to number.

### Q9. Source component tracking gap has no disposition
**Location**: TimingWheel Sufficiency section
**Problem**: "One minor gap: no source component tracking" left as implicit TODO.
**Suggestion**: Explicitly mark as out-of-scope or specify what's needed.

### Q10. TimingWheel teardown not specified
**Location**: Completeness gap
**Problem**: `_pendingTimedEvents` is cleared on loadCircuit/reset/dispose. TimingWheel needs equivalent lifecycle management.
**Suggestion**: Specify clear/recreate at each call site.
