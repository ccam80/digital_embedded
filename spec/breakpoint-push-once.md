# Spec: Push-Once Breakpoint Architecture for Reactive Sources

**Status:** Draft, ready for executor hand-off.
**Scope:** `src/solver/analog/element.ts`, `src/solver/analog/timestep.ts`, `src/solver/analog/compiler.ts`, `src/solver/analog/analog-engine.ts`, `src/components/sources/ac-voltage-source.ts`, `src/components/io/clock.ts`. ~100 lines additive + one deletion across 6 files.
**Out of scope:** coordinator one-shot breakpoints (continue using the existing direct-push API); non-periodic sources; `setParam` handle refresh (separate follow-up).

---

## 1. Context — what exists today

### 1.1 Pull loop (committed ~1 hour before this spec)

At the top of every `MNAEngine.step()`, a loop walks all elements and asks each for its breakpoints inside a `3 * maxTimeStep` lookahead window:

```ts
// analog-engine.ts:256–266
const lookaheadEnd = this._simTime + 3 * params.maxTimeStep;
for (const el of elements) {
  if (el.getBreakpoints) {
    const bps = el.getBreakpoints(this._simTime, lookaheadEnd);
    for (const bp of bps) {
      this._timestep.addBreakpoint(bp);
    }
  }
}
```

This was added to wire up `getBreakpoints` on `ac-voltage-source.ts:512` and `clock.ts:272` (previously orphaned — declared on the element interface but never called from the engine). It enables the timestep controller to clip steps to land exactly on square-wave / clock edges via `getClampedDt` (`timestep.ts:166–175`) and the `computeNewDt` breakpoint clamp (`timestep.ts:149–156`).

### 1.2 Dedup on `addBreakpoint` (committed in the same change)

Because consecutive lookahead windows overlap, the same upcoming edge was being re-inserted on every step. `timestep.addBreakpoint(time)` now silently drops entries within `0.5 * minTimeStep` of an existing breakpoint (`timestep.ts:314–335`). This plugs the leak but does not eliminate the per-step work: every element is still called on every step.

### 1.3 Producers

Only two element files implement `getBreakpoints`:

- **`ac-voltage-source.ts:512–527`** — square waveform returns all edges in `[tStart, tEnd]`; noise waveform returns uniformly spaced sample points at `1 / (20 * frequency)` stride inside the window.
- **`clock.ts:272–278`** — square-wave edges via `squareWaveBreakpoints(frequency, 0, tStart, tEnd)`. Has a vestigial `addBreakpoint?: (t: number) => void` push-callback parameter that no caller ever passes (`makeAnalogClockElement` at `clock.ts:300` constructs the inner element without it), so the push path at `clock.ts:274–276` is dead code.

### 1.4 External one-shot callers

`coordinator.ts:253, 326, 460` poke `analog.addBreakpoint(time)` directly for single future events (`stepTo(targetTime)` and similar). These are finite-cardinality, not periodic, and do not come from elements. They stay on the existing API.

### 1.5 Per-step cost we can eliminate

For a 2-source circuit at 10⁴ accepted steps:

- 20,000 `getBreakpoints` method calls.
- 20,000 allocations of the returned `number[]` (even empty returns walk the `[]` literal path).
- 20,000 `squareWaveBreakpoints` scans computing `floor((tStart - phase) * 2f)` and walking forward.
- 20,000 dedup binary-searches inside `addBreakpoint`.
- Linear in source count. For circuits with many AC sources (mixer benches, multi-phase supplies) the cost is meaningful.

---

## 2. Design — iterator / one-slot-per-source queue

### 2.1 Contract change

Add a new optional method to the element interface:

```ts
// src/solver/analog/element.ts (appended near getBreakpoints declaration)

/**
 * Return the strictly-next breakpoint strictly greater than `afterTime`, or
 * null if the source has no more breakpoints ever.
 *
 * Called by the timestep controller exactly once per accepted step on which
 * this source's current breakpoint was consumed. The controller guarantees
 * at most one outstanding breakpoint per source in its queue at any time,
 * so implementations do not need to track which events have already been
 * emitted — they only need to compute "the first edge after t".
 *
 * For infinite periodic sources (square, clock, noise), this always
 * returns a finite number. For bounded events (one-shots), it returns
 * the event time on first call and null thereafter.
 *
 * This method replaces `getBreakpoints(tStart, tEnd)` on the engine hot
 * path. `getBreakpoints` may still exist for unit tests and external
 * queries, but it must not be called per step.
 */
nextBreakpoint?(afterTime: number): number | null;
```

Existing `getBreakpoints(tStart, tEnd)` stays declared and implemented so tests (`ac-voltage-source.test.ts:199`, `analog-clock.test.ts:100,120`) continue to pass — re-express it as a thin wrapper that calls `nextBreakpoint` in a loop until the window is exhausted. Engine-side callers of `getBreakpoints` are deleted.

### 2.2 Queue storage change

`TimestepController._breakpoints` changes from `number[]` to a record array carrying a source reference:

```ts
// src/solver/analog/timestep.ts
interface BreakpointEntry {
  /** Absolute simulation time in seconds. */
  time: number;
  /**
   * Element that produced this breakpoint, or null for external one-shots
   * registered via the public addBreakpoint(time) API. On pop, if source
   * is non-null and implements nextBreakpoint, the controller refills the
   * queue with the element's next edge.
   */
  source: AnalogElement | null;
}

private _breakpoints: BreakpointEntry[] = [];
```

### 2.3 API surface on `TimestepController`

Add one new method, keep the existing `addBreakpoint(time)` as-is (external one-shot path, still deduped):

```ts
/**
 * Register the next outstanding breakpoint for an element source. The
 * controller holds at most one entry per source; when this entry is
 * consumed in accept(), the controller calls source.nextBreakpoint to
 * refill.
 *
 * Seeded at compile time for every element with nextBreakpoint, and
 * re-seeded automatically during accept(). Never called from the hot
 * path per step.
 */
insertForSource(time: number, source: AnalogElement): void {
  // Same binary-search insertion as addBreakpoint, but carries source ref
  // and skips the eps-dedup path (iterator contract guarantees monotonic
  // uniqueness).
  let lo = 0;
  let hi = this._breakpoints.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (this._breakpoints[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  this._breakpoints.splice(lo, 0, { time, source });
}

/** Existing one-shot API — boxed for uniform storage, dedup preserved. */
addBreakpoint(time: number): void {
  // binary search + dedup exactly as committed in 8647446, but store as
  // { time, source: null } instead of raw number.
  // ...
}
```

All call sites that read `_breakpoints[0]` (currently `timestep.ts:166-175`, `149-156`, `216-220`, `314-324`) migrate from `_breakpoints[0]` to `_breakpoints[0].time`. Four mechanical touch points, all in one file.

### 2.4 Refill on `accept(simTime)`

```ts
// src/solver/analog/timestep.ts — accept() body
accept(simTime: number): void {
  this._acceptedSteps++;
  this._updateMethodForStartup();

  // Pop reached breakpoints and refill from their source if any.
  while (this._breakpoints.length > 0 && simTime >= this._breakpoints[0].time) {
    const popped = this._breakpoints.shift()!;
    if (popped.source?.nextBreakpoint) {
      const next = popped.source.nextBreakpoint(simTime);
      if (next !== null) {
        this.insertForSource(next, popped.source);
      }
    }
  }
}
```

One conditional method call per *consumed* breakpoint. For a 1 kHz clock in a 10 ms simulation that is 20 calls total, not 20,000.

### 2.5 Compile-time seeding

```ts
// src/solver/analog/compiler.ts — after the existing initState loop
for (const el of analogElements) {
  if (el.nextBreakpoint) {
    const first = el.nextBreakpoint(0);
    if (first !== null) {
      timestepController.insertForSource(first, el);
    }
  }
}
```

Runs once per compile. Zero cost on subsequent steps.

### 2.6 Deletion in `analog-engine.ts`

Delete the per-step pull loop at `analog-engine.ts:256–266` and its `lookaheadEnd` calculation. The `getBreakpoints` import stays only if other callers reference it (grep confirms they do not, outside tests).

### 2.7 Producer migrations

**`ac-voltage-source.ts`** — add `nextBreakpoint(afterTime)` alongside the existing `getBreakpoints`:

```ts
nextBreakpoint(afterTime: number): number | null {
  if (waveform === "square") {
    // Half-period edge index strictly greater than afterTime.
    const halfPeriod = 1 / (2 * frequency);
    const idx = Math.floor((afterTime - phase) / halfPeriod) + 1;
    return phase + idx * halfPeriod;
  }
  if (waveform === "noise") {
    // Uniform sampling at 1/(20*frequency) stride — return next sample.
    const dt = 1 / (20 * frequency);
    return afterTime + dt;
  }
  return null;
},

// getBreakpoints stays as a thin wrapper for test compatibility:
getBreakpoints(tStart: number, tEnd: number): number[] {
  const out: number[] = [];
  let t = tStart;
  while (true) {
    const next = this.nextBreakpoint!(t);
    if (next === null || next >= tEnd) break;
    out.push(next);
    t = next;
  }
  return out;
},
```

**`clock.ts`** — same shape, plus delete the dead `addBreakpoint?: (t: number) => void` parameter and the push path at lines 274–276:

```ts
nextBreakpoint(afterTime: number): number | null {
  const halfPeriod = 1 / (2 * frequency);
  const idx = Math.floor(afterTime / halfPeriod) + 1;
  return idx * halfPeriod;
},
```

---

## 3. Invariants gained

| Invariant | Before | After |
|---|---|---|
| Queue size | Grows with every step (pre-dedup) or stays bounded but churns (post-dedup) | Bounded by `\|breakpoint sources\|` — typically 1–3 entries |
| Per-step breakpoint cost | O(sources × maxTimeStep lookahead) | O(1) — read index 0 for clamping, nothing else |
| Duplicate emissions | Prevented by eps-dedup safety net | Structurally impossible for element sources (iterator contract). Dedup retained for external callers. |
| Rollback safety | Unaffected (breakpoints live in controller, not state pool) | Unaffected — NR/LTE retries don't advance simTime, `accept` never fires during retry |
| Memory leak risk | Plugged by dedup | Eliminated at the source |

---

## 4. Risks and edge cases

### 4.1 `setParam` frequency hot-load

If a source's frequency changes via `setParam` while an already-inserted next edge sits in the queue, that edge is stale. Error bound: ≤ one old-period. Three options in increasing effort:

1. **Accept the staleness** (not recommended — square-wave circuits depend on edge accuracy).
2. **Queue handle refresh**: give each element a `BreakpointHandle` at seed time with a `refresh()` method that calls `source.nextBreakpoint(simTime)` and replaces the queue entry. `setParam` invokes it on frequency/phase change. ~20 lines, isolated to frequency-sensitive elements.
3. **Compile-time rebind**: on any hot-param change, trigger `hotRecompile` (already used for structural changes). Heavy-handed but uses existing machinery.

**Recommendation:** ship option 1 initially (documented known limitation), implement option 2 as a follow-up when it bites. Hot-loading clock frequency on a running sim is not a common case.

### 4.2 Tests that call `getBreakpoints(tStart, tEnd)` directly

Existing tests at `ac-voltage-source.test.ts:199`, `analog-clock.test.ts:100, 120` call the window-based API directly. Keep `getBreakpoints` implemented as a `nextBreakpoint`-backed wrapper (shown in section 2.7) so these tests continue to pass without modification.

### 4.3 Noise waveform density

Current `getBreakpoints` for `noise` returns ~20 samples per window call. New iterator returns one sample per call. Same total sampling rate across the simulation, same LTE clamping behaviour, lower per-call overhead. No behavior change.

### 4.4 Mixed coordinator one-shots and element sources

`coordinator.ts:253,326,460` use the existing `addBreakpoint(time)` API. These now box into `{time, source: null}`. On pop, `source?.nextBreakpoint` is null and no refill happens — correct one-shot semantics. Dedup in `addBreakpoint` is preserved as the safety net.

### 4.5 First call with `afterTime === 0`

At compile-time seeding, the first element breakpoint may land at exactly t=0 (e.g. phase-aligned clock). The contract says "strictly greater than `afterTime`", so `nextBreakpoint(0)` returns the *first positive* edge, not t=0 itself. Sources that want to fire at t=0 must do so via `stampCompanion` / DC-op, not via the breakpoint queue. Document this explicitly in the element interface JSDoc.

### 4.6 Infinite loop guard in the `getBreakpoints` wrapper

The wrapper in section 2.7 calls `nextBreakpoint` in a loop until `next >= tEnd` or `null`. If a buggy implementation returns a value `<= afterTime`, the loop spins forever. Add an assertion in dev builds:

```ts
if (next !== null && next <= t) {
  throw new Error(`nextBreakpoint returned non-monotonic value: ${next} <= ${t}`);
}
```

---

## 5. Migration steps

1. **`src/solver/analog/element.ts`** — add optional `nextBreakpoint?(afterTime: number): number | null;` to `AnalogElementCore`. Document the monotonic-strict contract.
2. **`src/solver/analog/timestep.ts`** — change `_breakpoints` storage to `BreakpointEntry[]`, migrate the 4 call sites to use `.time`, add `insertForSource(time, source)`, add refill loop in `accept(simTime)`. Preserve `addBreakpoint(time)` with dedup as `{time, source: null}` inserts.
3. **`src/solver/analog/compiler.ts`** — after the existing `initState` loop, add a second loop that seeds `insertForSource` for every element implementing `nextBreakpoint`.
4. **`src/solver/analog/analog-engine.ts`** — delete lines 256–266 (the pull loop and its `lookaheadEnd` calculation). Run typecheck.
5. **`src/components/sources/ac-voltage-source.ts`** — implement `nextBreakpoint(afterTime)` for square and noise; rewrite `getBreakpoints(tStart, tEnd)` as a wrapper over `nextBreakpoint`. DC waveform returns null unchanged.
6. **`src/components/io/clock.ts`** — implement `nextBreakpoint(afterTime)`; rewrite `getBreakpoints(tStart, tEnd)` as a wrapper; delete the `addBreakpoint?: (t: number) => void` parameter and the dead push path at lines 274–276.
7. **Run test suites**:
   - `npx vitest run src/components/sources/__tests__/ac-voltage-source.test.ts` — verifies getBreakpoints wrapper.
   - `npx vitest run src/components/io/__tests__/analog-clock.test.ts` — verifies clock wrapper.
   - `npx vitest run src/solver/analog/__tests__/timestep.test.ts` — verifies queue storage migration.
   - `npx vitest run src/solver/analog/__tests__/analog-engine.test.ts` — verifies engine init and step paths.
   - `npx vitest run src/solver/analog/__tests__/buckbjt-convergence.test.ts` — end-to-end regression on the circuit that drove this work.

## 6. Rollout plan

- **Wave 1 (single commit, no behaviour change):** steps 1–3. Add the new API, add the queue storage + seeding. The pull loop still runs, still produces results, but now gets deduped by the queue contract (both paths co-exist).
- **Wave 2 (single commit):** step 4 deletion of the pull loop. At this point only the iterator path is live. Run the full test surface.
- **Wave 3 (single commit):** steps 5–6 producer migrations. Ship with the wrappers keeping the old `getBreakpoints` API behaviourally intact for tests.

Three commits, each individually revertable. Wave 1 and Wave 2 can be combined if reviewers prefer a single "replace pull with iterator" change.

---

## 7. Performance delta (expected)

For the buckbjt convergence test (~10⁴ accepted steps, 1 clock source + 1 AC source):

- **Saved function calls**: ~20,000 `getBreakpoints` invocations → ~40 `nextBreakpoint` invocations (one per consumed edge × 2 sources).
- **Saved allocations**: ~20,000 `number[]` returns → zero (or the 40 refill calls).
- **Saved binary-searches**: ~20,000 dedup probes → zero for element sources.
- **Wall-clock**: dominated by NR iterations; breakpoint overhead is <1% of step time today. Still worth doing for cleanliness and scaling.

---

## 8. Explicit non-goals

- **Coordinator one-shot API.** `coordinator.ts:253,326,460` continues to use `addBreakpoint(time)` unchanged. One-shots have no iterator; they box into `{time, source: null}` and never refill.
- **`setParam` handle refresh.** Option 2 in section 4.1 is a follow-up; initial landing accepts one-period staleness on frequency hot-loads.
- **Breakpoint merging across sources.** Two sources that happen to fire at the same instant produce two queue entries. No merging — the cost of two reaches of the same moment is negligible and merging would require an extra comparison on every insert.
- **Removing the dedup in `addBreakpoint`.** It stays as a safety net for external callers and for any future element that pushes eagerly.

---

## 9. References

- `src/solver/analog/analog-engine.ts:256–266` — pull loop to delete.
- `src/solver/analog/timestep.ts:149–156` — computeNewDt breakpoint clamp (migrates to `.time`).
- `src/solver/analog/timestep.ts:166–175` — getClampedDt (migrates to `.time`).
- `src/solver/analog/timestep.ts:216–220` — accept() pop loop (add refill).
- `src/solver/analog/timestep.ts:314–335` — addBreakpoint dedup (preserve, box into record).
- `src/components/sources/ac-voltage-source.ts:512–527` — source 1.
- `src/components/io/clock.ts:272–278` — source 2, plus dead push path at 245/274–276.
- `src/components/sources/__tests__/ac-voltage-source.test.ts:199` — direct `getBreakpoints` caller; kept alive via wrapper.
- `src/components/io/__tests__/analog-clock.test.ts:100, 120` — direct `getBreakpoints` callers; kept alive via wrapper.
- `src/solver/coordinator.ts:253, 326, 460` — external one-shot callers; unchanged.
- `src/solver/analog/compiler.ts` — seed loop insertion point (after existing `initState` loop).
