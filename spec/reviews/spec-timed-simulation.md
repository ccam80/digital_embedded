# Spec Review: Timed Digital Simulation - Requirements

## Verdict: needs-revision

## Plan Coverage

No plan.md exists for this spec. It is a standalone requirements document. Plan coverage checks are not applicable.

---

## Internal Consistency Issues

### 1. TimedConfig extension conflicts with existing field

**Section: Configuration**

The spec says to extend TimedConfig at evaluation-mode.ts:35 with tickSize?: number (ns per step, default DEFAULT_GATE_DELAY) and timeResolution?: number (ns per wheel slot, default 1). The actual TimedConfig already has a defaultDelay: number field -- not optional, not named tickSize. The spec never explains whether defaultDelay is retired, renamed, or kept alongside tickSize. Both fields serve similar purposes (fallback propagation delay in ns). A fresh implementer cannot determine whether defaultDelay stays and tickSize is something separate (time quantum per step() call vs. per-component fallback delay), whether tickSize replaces defaultDelay, or whether the two coexist. The spec does not describe what happens to the existing defaultDelay field.

### 2. Pseudocode Phase 3 uses undefined variables newVal and newHighZ

**Section: Recommended Approach: Snapshot-Restore**

The pseudocode reads:

    for each changed output:
      _values[netId] = beforeValues  // restore!
      timingWheel.schedule(netId, newVal, newHighZ, targetTime + delay)

newVal and newHighZ are never defined. The correct sequence is: capture post-execute value, restore pre-execute value, schedule the captured value. An implementer must infer that newVal = state[netId] must be saved before the restore line. Getting this wrong produces silently broken behaviour (scheduling the restored value rather than the computed one). This is implementation-critical and must be explicit.

### 3. Phase 3 pseudocode does not fix Bug 4 (feedback group handling)

**Section: Recommended Approach: Snapshot-Restore**

Bug 4 in the spec is "No feedback group handling (single-pass only)." The pseudocode Phase 3 iterates "for each group in evaluationOrder" with a single pass per group. It does not describe how groups with isFeedback=true (SCCs) should be handled -- whether they iterate to stability as in level mode, run once, or use a different approach. The spec identifies the bug but the fix is absent from the proposed pseudocode.

### 4. Phase 4 is listed but empty

**Section: Recommended Approach: Snapshot-Restore**

    // Phase 4: Bus resolution & switch handling

This is a comment stub with no content. Bug 5 (No bus resolution) is identified in the spec, but Phase 4 contains no pseudocode. _stepLevel() has a non-trivial bus resolution flow: _resolveAllSwitches() for switch components, busResolver.checkAllBurns() for contention detection, and busResolver.onNetChanged() per changed output. The spec does not describe whether timed mode calls the same helpers in the same way, or whether the deferred-output model requires a different approach.

---

## Completeness Gaps

### 1. No file modification list

The spec names the rewrite target (digital-engine.ts:969-1048) but never provides a list of files to modify. An implementer does not know whether evaluation-mode.ts must also be edited for the TimedConfig changes, whether digital-engine.ts needs new import statements for TimingWheel and EventPool, or whether the old TimedEvent type and _pendingTimedEvents field must be removed.

### 2. No test specification

The implementation effort table mentions "Unit tests: Medium (1 day)" but specifies no test file path, no individual test cases, and no assertions. The spec contains no reference to the Three-Surface Testing Rule from CLAUDE.md. Since timed simulation mode is a user-facing feature, headless API tests, MCP tests, and E2E Playwright tests are all required by project rules, and none are addressed.

### 3. No acceptance criteria

There is no section defining when the implementation is complete. No observable behaviour is specified as a pass/fail condition. Examples of missing criteria: a two-NOT-gate ring oscillator in timed mode produces alternating 0/1 at output with a 20ns period (2 x DEFAULT_GATE_DELAY); a D flip-flop samples D on the clock edge and holds the value through the high phase; a tristate bus with two simultaneous active drivers sets the burn flag.

### 4. TimingWheel construction parameters never specified

The spec says to use TimingWheel but never states what arguments to pass to its constructor (wheelSize, poolSize). event-pool.ts documents that poolSize should be 2 * netCount. The spec does not state where or when the TimingWheel instance should be created relative to compilation or engine construction.

### 5. No teardown and reset specification

_pendingTimedEvents is currently cleared on loadCircuit (line 303), reset (line 316), and dispose (line 332) in digital-engine.ts. The spec does not state that a new TimingWheel instance must also be cleared or replaced at those same call sites.

### 6. Timed mode is never activated from outside the engine

coordinator.ts:115 and coordinator.ts:151 both instantiate new DigitalEngine with mode "level". The spec does not describe any API surface changes to DefaultSimulatorFacade, the coordinator, or the postMessage adapter that would allow callers to request timed mode. Without this, the fixed _stepTimed will remain dead code as before.

---

## Concreteness Issues

### 1. Phase 4 is a one-line stub with no content

Bus resolution and switch handling has no pseudocode. Level mode requires: per-output busResolver.onNetChanged(), busResolver.checkAllBurns(), and _resolveAllSwitches() with switch state tracking. Whether timed mode calls the same helpers, at which point in the step, or whether the deferred-output model requires a different approach is entirely unspecified.

### 2. Sequential sampling interaction with deferred values is unspecified

Phase 2 calls sampleFn(idx, _values, _highZs, layout) after Phase 1 has applied due events. The spec does not clarify: whether sampleFn output should also be deferred through the wheel or applied immediately; how clock-edge detection inside sampleFn interacts with per-net deduplication in the wheel; or whether _values at this point correctly reflects the circuit state that should be sampled.

### 3. Source component tracking gap has no disposition

Section "TimingWheel Sufficiency" states "One minor gap: no source component tracking for educational trace display." Per spec/.context/rules.md, work must not be marked deferred or left as an implicit TODO. The spec must either explicitly state this is out of scope for this task (with justification) or specify what needs to be implemented.

### 4. delays array described as unused but it is already referenced

Section "Key Files" says compiled-circuit.ts:137 -- delays Uint32Array (populated, unused). The current _stepTimed at line 1018 already reads delays[idx]: const delay = BigInt(delays[idx] ?? 10). Calling it unused is factually incorrect and may mislead an implementer into thinking they need to wire up the delays array when it is already referenced in the rewrite target.

### 5. tickSize vs internal bigint representation not specified

The spec proposes tickSize?: number in nanoseconds, but the current code uses bigint internally (const tick = 10n). The spec does not state whether tickSize is converted to bigint at use, stored as bigint, or whether the internal representation changes. This affects every arithmetic expression in _stepTimed.

---

## Implementability Concerns

### 1. advance() frees events before the caller reads them -- pseudocode ignores this hazard

timing-wheel.ts:155-157 frees all returned events back to the pool immediately inside advance() before returning the array. In the proposed pseudocode, Phase 3 calls timingWheel.schedule() inside a nested loop, which triggers pool allocation from the same pool. If Phase 1 events were already freed by advance() and the pool recycles them during Phase 3 schedule() calls, the netId/value/highZ fields on Phase 1 event objects can be silently overwritten mid-iteration. The spec does not acknowledge this lifetime hazard or specify that Phase 1 events must be fully consumed before Phase 3 begins.

### 2. TimingWheel instance lifecycle is unspecified

TimingWheel must be sized with poolSize = 2 * netCount, which is only known post-compilation. The spec does not state where the instance lives: engine constructor-time field, lazy creation on first timed step, or created inside loadCircuit. This is not a stylistic choice -- pool sizing and reset semantics differ significantly across these options.

### 3. Old _pendingTimedEvents field and TimedEvent type removal is not specified

The current engine has _pendingTimedEvents: TimedEvent[] (line 211) and a TimedEvent interface. The spec implicitly replaces these with TimingWheel but never explicitly states they must be removed. Per spec/.context/rules.md, "All replaced or edited code is removed entirely. Scorched earth." This must be explicitly stated in the spec.

### 4. No three-surface test specification (CLAUDE.md violation)

CLAUDE.md mandates: "Every user-facing feature MUST be tested across all three surfaces: headless API test, MCP tool test, E2E/UI test." Timed simulation mode is a user-facing simulation feature. The spec specifies no test file paths, no test cases, and no assertions at any surface. An implementer following project rules would have no guidance on what to test or where.