# Timed Digital Simulation — Requirements

## Status

`_stepTimed` at `digital-engine.ts:969-1048` is broken dead code. Never instantiated anywhere. Has 7 fundamental bugs. The TimingWheel (311 lines) and EventPool (92 lines) are fully implemented, tested (13+4 tests), and completely unused.

## Bugs in Current Implementation

1. **executeFn writes immediately to state** (line 1015), defeating delay scheduling
2. **No shadow buffer** — ExecuteFunction writes directly to shared state array
3. **No sample phase** for sequential components (flip-flops won't work)
4. **No feedback group handling** (single-pass only)
5. **No bus resolution** (no switch checks, no burn detection)
6. **Unused TimingWheel** — engine uses naive `TimedEvent[]` instead
7. **O(n) event queue** — Array.filter/sort per step vs TimingWheel's O(1)

## Recommended Approach: Snapshot-Restore

No ExecuteFunction contract change needed:

```
stepTimed():
  // Phase 0: Advance to target time
  targetTime = _currentTime + tickSize

  // Phase 1: Apply due events from TimingWheel
  for each event in timingWheel.advance(targetTime):
    _values[event.netId] = event.value
    _highZs[event.netId] = event.highZ

  // Phase 2: Sample sequential components
  for each idx in sequentialComponents:
    sampleFn(idx, _values, _highZs, layout)

  // Phase 3: Evaluate + snapshot-restore
  for each group in evaluationOrder:
    for each component idx:
      // Snapshot outputs before execution
      beforeValues = capture output nets
      // Execute (writes to _values immediately)
      executeFn(idx, _values, _highZs, layout)
      // Capture new, RESTORE originals, schedule via wheel
      for each changed output:
        _values[netId] = beforeValues  // restore!
        timingWheel.schedule(netId, newVal, newHighZ, targetTime + delay)

  // Phase 4: Bus resolution & switch handling
  // Phase 5: _currentTime = targetTime
```

## Implementation Effort

| Item | Effort |
|------|--------|
| Fix `_stepTimed` with snapshot-restore | Medium (1-2 days) |
| TimingWheel integration | Small (2-4 hours) |
| Sequential sampling phase | Small (1-2 hours) |
| Bus resolution in timed mode | Small (2-4 hours) |
| Unit tests | Medium (1 day) |
| Timing diagram viewer | Large (3-5 days) |
| Mixed-signal synchronization | Large (1-2 weeks) |

## TimingWheel Sufficiency

Sufficient as-is: per-net deduplication (latest-wins), sorted advance(), 1024-slot wheel covers 102 levels of gate delay at DEFAULT_GATE_DELAY=10. One minor gap: no source component tracking for educational trace display.

## Configuration

Extend `TimedConfig` at `evaluation-mode.ts:35`:
- `tickSize?: number` — ns per step(), default = DEFAULT_GATE_DELAY
- `timeResolution?: number` — ns per wheel slot, default = 1

Per-component delays already working via 3-level resolution in `compiler.ts:688-703`.

## Key Files

- `digital-engine.ts:969-1048` — broken _stepTimed (rewrite target)
- `timing-wheel.ts` — 311 lines, 13 tests, production-ready, unused
- `event-pool.ts` — 92 lines, 4 tests, production-ready, unused
- `delay.ts:15` — DEFAULT_GATE_DELAY = 10 (10ns)
- `compiled-circuit.ts:137` — delays Uint32Array (populated, unused)
