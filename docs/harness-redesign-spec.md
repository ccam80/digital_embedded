# Harness Redesign Spec

> Successor to `docs/timestep-alignment-spec.md`. Replaces §7 (time-based step alignment), restructures the harness around index-based pairing, introduces structured shape reporting, unifies the master logging switch, and eliminates the DCOP-in-compile boot buffer.
>
> **Status:** Approved design, awaiting implementation.
> **Scope:** `src/solver/analog/__tests__/harness/**`, `src/solver/coordinator.ts`, `src/headless/default-facade.ts`, `src/solver/analog/analog-engine.ts`, `src/solver/analog/dc-operating-point.ts`, `src/solver/analog/convergence-log.ts`, `scripts/mcp/harness-tools.ts`, `scripts/mcp/simulation-tools.ts`, `src/io/postmessage-adapter.ts`, `src/app/convergence-log-panel.ts`, `src/solver/coordinator-types.ts`, `src/solver/null-coordinator.ts`, `src/test-utils/mock-coordinator.ts`.
> **Concurrent fixes (out-of-tree, by other agents):** D1 (`getDivergences` `withinTol` filter), D3 (`traceNode` segment-match split-on-`/`).

---

## §1. Goals

This spec is organized around eight goals labelled A–H. Every later section either implements a goal or supports one. Goals F–H are tracked here for completeness but their fixes are owned by other agents or subsumed by goal A.

| ID | Goal | Owner | Status |
|----|------|-------|--------|
| A | Replace time-based `_alignedNgIndex` map with index-based step pairing (`oursSteps[i]` ↔ `ngSteps[i]`). The `stepStartTimeDelta` becomes a reported datum, not a defect. | this spec | new |
| B | Asymmetric shape reporting via structured `presence: "both" \| "oursOnly" \| "ngspiceOnly"` types. **No prose renderer.** | this spec | new |
| C | Test helpers must build complete steps via `ComparisonSession.createSelfCompare(opts)`. The manual `buildHwrSession()` that calls `engine.dcOperatingPoint()` + `endStep()` directly is forbidden. | this spec | new |
| D | `setCaptureHook` becomes the **master switch** that auto-enables all four engine instrumentations (`postIterationHook`, `stepPhaseHook`, `detailedConvergence`, `limitingCollector`) and `convergenceLog.enabled`. Harness owns the convergence log lifecycle while installed. | this spec | new |
| E | Eliminate the `_dcopBootAttempts` boot buffer by deferring DCOP from `coordinator` constructor into a new `coordinator.initialize()` method. `compile(opts: { deferInitialize?: boolean })` opt-out. | this spec | new |
| F | Bug D2 (matrix NaN in self-compare) is **subsumed** by index alignment — when `oursSteps[i]` and `ngSteps[i]` are paired by index, the same step compares against itself and matrix entries are bit-identical. | this spec (subsumed) | resolved-by-A |
| G | Bug D1 (`getDivergences` `withinTol` filter inverted) | other agent | in-progress |
| H | Bug D3 (`traceNode` segment-match split on `/` mishandles subcircuit-prefixed names) | other agent | in-progress |

### §1.1 Why index pairing (the rejection of §7)

The previous spec built `_alignedNgIndex: Map<number, number>` by exact-equality (`stepStartTime`) lookup with a 1e-15 EPS fallback (`comparison-session.ts:1583-1611`). This had three structural problems:

1. **Tolerance brittleness.** Exact-time equality on Float64 across two engines is doomed; the EPS fallback widens it but is still arbitrary. The harness silently drops mismatched steps as "unaligned" instead of comparing them.
2. **Asymmetric loss of data.** When the maps disagree (different rejection patterns, different LTE proposals, different boot-step grouping) the unaligned steps are *invisible* to all query methods because they have no map entry. A 95% paired session looks like a passing session.
3. **The wrong abstraction for parity work.** Two engines starting from the same circuit with the same dt strategy will produce a sequence of steps. The interesting question is "do these sequences agree on values *and* on shape?", not "which steps line up by time?". Time-based alignment hides shape disagreement under the rug.

**Index pairing** says: `oursSteps[i]` is compared to `ngSteps[i]`. If they have different `stepStartTime`, that delta is **reported**, not absorbed. If one side has more steps than the other, the excess is reported as `presence: "oursOnly"` or `"ngspiceOnly"`. Shape is now a first-class output.

### §1.2 Backwards compatibility

This is a behaviour-breaking redesign of an internal test harness. There are no external consumers of `_alignedNgIndex`, `unaligned`, or the §7 alignment semantics. The MCP `harness_*` tool surface is consumer-facing, and §9 of this spec preserves all tool names with new payload fields.

---

## §2. Data model

### §2.1 New types (added to `src/solver/analog/__tests__/harness/types.ts`)

```ts
// ---------------------------------------------------------------------------
// Asymmetric step presence (Goal B)
// ---------------------------------------------------------------------------

/** Indicates which side(s) actually produced a step at a given index. */
export type SidePresence = "both" | "oursOnly" | "ngspiceOnly";

/** Side selector for time-based queries. Disjoint from SidePresence. */
export type Side = "ours" | "ngspice";

/** Compact summary of one NR attempt — used in shape reports. */
export interface AttemptSummary {
  phase: NRPhase;
  outcome: NRAttemptOutcome;
  dt: number;
  iterationCount: number;
  converged: boolean;
}

/** Counts of attempts grouped by phase / outcome — used for fast diff. */
export interface AttemptCounts {
  byPhase: Partial<Record<NRPhase, number>>;
  byOutcome: Partial<Record<NRAttemptOutcome, number>>;
  total: number;
}

/** Per-step shape descriptor. Always populated for both sides where present. */
export interface StepShape {
  stepIndex: number;
  presence: SidePresence;
  /** stepStartTime as reported by each side; null when that side is absent. */
  stepStartTime: { ours: number | null; ngspice: number | null };
  stepEndTime:   { ours: number | null; ngspice: number | null };
  /** Difference of stepStartTime in seconds (ours - ngspice). null if any side absent. */
  stepStartTimeDelta: number | null;
  /** Per-side attempt counts. Each is null when that side is absent. */
  attemptCounts: { ours: AttemptCounts | null; ngspice: AttemptCounts | null };
  /** Per-side attempt summaries (length-limited; full detail is on the StepSnapshot). */
  attempts: { ours: AttemptSummary[] | null; ngspice: AttemptSummary[] | null };
  /** Final integration method per side; null when absent. */
  integrationMethod: { ours: string | null; ngspice: string | null };
}

/** Whole-session shape descriptor. */
export interface SessionShape {
  analysis: "dcop" | "tran";
  stepCount: { ours: number; ngspice: number; max: number };
  presenceCounts: { both: number; oursOnly: number; ngspiceOnly: number };
  steps: StepShape[];
  /** Indices where stepStartTimeDelta exceeds tolerance (reported, not filtered). */
  largeTimeDeltas: Array<{ stepIndex: number; delta: number }>;
}
```

### §2.2 Modified types

```ts
// types.ts:308-319 — add presence; remove unaligned
export interface StepEndReport {
  stepIndex: number;
  presence: SidePresence;            // NEW — replaces unaligned?
  stepStartTime: ComparedValue;
  stepEndTime: ComparedValue;
  dt: ComparedValue;
  converged: { ours: boolean; ngspice: boolean };
  iterationCount: ComparedValue;
  // unaligned?: boolean;            // REMOVED
  nodes: Record<string, ComparedValue>;
  branches: Record<string, ComparedValue>;
  components: Record<string, StepEndComponentEntry>;
}

// types.ts:523 — add "shape" category
export type DivergenceCategory = "voltage" | "state" | "rhs" | "matrix" | "shape";

// types.ts:525-538 — add presence
export interface DivergenceEntry {
  stepIndex: number;
  iteration: number;                 // -1 for shape divergences
  stepStartTime: number;
  category: DivergenceCategory;
  label: string;
  ours: number;                      // numeric where applicable; for shape, count or delta
  ngspice: number;
  absDelta: number;
  relDelta: number;
  withinTol: boolean;
  componentLabel: string | null;
  slotName: string | null;
  presence: SidePresence;            // NEW — "both" for value diffs, "oursOnly"/"ngspiceOnly" for shape diffs
}

// types.ts:376-391 — add shape facts
export interface SessionSummary {
  analysis: "dcop" | "tran";
  stepCount: ComparedValue;          // already there
  presenceCounts: { both: number; oursOnly: number; ngspiceOnly: number };  // NEW
  worstStepStartTimeDelta: number;   // NEW — max abs delta across paired steps
  // ... rest unchanged
}
```

### §2.3 Deleted types and fields

- `comparison-session.ts:251` — `protected _alignedNgIndex: Map<number, number>` — **deleted**.
- `comparison-session.ts:240` — `protected _dcopBootAttempts: Array<...>` — **deleted** (Goal E).
- `types.ts:315`, `types.ts:738` — `unaligned?: boolean` — **deleted** (replaced by `presence`).
- `compare.ts:45` — `alignment?: Map<number, number>` parameter to `compareSnapshots` — **deleted**.

### §2.4 PhaseAwareCaptureHook bundle

The `setCaptureHook` API today takes a single `MNAEngine["stepPhaseHook"]` (`default-facade.ts:118-120`). Goal D requires all four hooks to be installed atomically. New bundle type added to `src/solver/analog/__tests__/harness/types.ts`:

```ts
/** Bundle of all instrumentation hooks the comparison harness needs. */
export interface PhaseAwareCaptureHook {
  /** Per-NR-iteration hook (fires inside newton-raphson.ts loop). */
  iterationHook: PostIterationHook;
  /** Phase begin/end hook (fires from analog-engine and dc-operating-point). */
  phaseHook: MNAEngine["stepPhaseHook"];
}
```

`setCaptureHook(bundle: PhaseAwareCaptureHook | null)` is the new master-switch signature (Goal D, §7).

---

## §3. Index-based comparison pipeline (Goal A, F)

### §3.1 New `compareSnapshots` loop

Rewrite `src/solver/analog/__tests__/harness/compare.ts:41-194`:

```ts
export function compareSnapshots(
  ours: CaptureSession,
  ref:  CaptureSession,
  tolerance: Tolerance = DEFAULT_TOLERANCE,
): ComparisonResult[] {
  const results: ComparisonResult[] = [];
  const stepCount = Math.max(ours.steps.length, ref.steps.length);

  for (let si = 0; si < stepCount; si++) {
    const ourStep = ours.steps[si];   // may be undefined
    const refStep = ref.steps[si];    // may be undefined

    if (!ourStep && !refStep) continue;       // impossible by max(), but defensive

    // Asymmetric: only one side has this step
    if (!ourStep || !refStep) {
      results.push({
        stepIndex: si,
        iterationIndex: -1,
        stepStartTime: (ourStep ?? refStep)!.stepStartTime,
        presence: ourStep ? "oursOnly" : "ngspiceOnly",
        voltageDiffs: [],
        rhsDiffs: [],
        matrixDiffs: [],
        stateDiffs: [],
        allWithinTol: false,
      });
      continue;
    }

    // Symmetric: both sides present — pair iterations by index
    const iterCount = Math.min(ourStep.iterations.length, refStep.iterations.length);
    for (let ii = 0; ii < iterCount; ii++) {
      // ... existing voltage / rhs / matrix / state diff loops UNCHANGED ...
      results.push({
        stepIndex: si,
        iterationIndex: ii,
        stepStartTime: ourStep.stepStartTime,
        presence: "both",                       // NEW
        voltageDiffs, rhsDiffs, matrixDiffs, stateDiffs,
        allWithinTol,
      });
    }
  }

  return results;
}
```

Key changes:
1. Loop bound was `ours.steps.length` (`compare.ts:48`); now `Math.max(ours.steps.length, ref.steps.length)`.
2. The `alignment.get(si) ?? si` lookup at `compare.ts:52` is gone — `refStep` is just `ref.steps[si]`.
3. Asymmetric steps emit a single sentinel `ComparisonResult` with `iterationIndex: -1` and `presence` set, so divergence reports can pick them up.
4. The `allWithinTol` for sentinel rows is **always false** — an unmatched step is a shape divergence.

### §3.2 `ComparisonResult` extension

`types.ts` (search for the `ComparisonResult` interface):

```ts
export interface ComparisonResult {
  stepIndex: number;
  iterationIndex: number;          // -1 for shape sentinel rows
  stepStartTime: number;
  presence: SidePresence;          // NEW
  voltageDiffs: VoltageDiff[];
  rhsDiffs: RhsDiff[];
  matrixDiffs: MatrixDiff[];
  stateDiffs: StateDiff[];
  allWithinTol: boolean;
}
```

### §3.3 Why this resolves bug D2 (Goal F)

The matrix-NaN bug (`query-methods.test.ts:583`) appeared in self-compare runs because `_buildTimeAlignment()` mapped some `oursSteps[i]` to a *different* `ngSteps[j]` whose matrix had a different sparsity pattern (e.g. boot step matrix vs. tranInit matrix). The diff loop at `compare.ts:104-111` then computed `(0 ?? 0) - NaN` for entries that existed on one side and not the other. With `oursSteps[i] ↔ ngSteps[i]` paired by index in a self-compare, every entry exists on both sides with bit-identical values. **D2 is mechanically impossible after Goal A lands.**

### §3.4 Per-step time-delta reporting

The `_buildTimeAlignment()` private method (`comparison-session.ts:1583-1611`) is **deleted entirely**. Its replacement is two pure helpers:

```ts
private _stepStartTimeDelta(stepIndex: number): number | null {
  const ours = this._ourSession?.steps[stepIndex];
  const ng   = this._ngSessionAligned()?.steps[stepIndex];
  if (!ours || !ng) return null;
  return ours.stepStartTime - ng.stepStartTime;
}

private _stepPresence(stepIndex: number): SidePresence {
  const ours = this._ourSession?.steps[stepIndex];
  const ng   = this._ngSessionAligned()?.steps[stepIndex];
  if (ours && ng) return "both";
  if (ours)       return "oursOnly";
  return "ngspiceOnly";
}
```

Both are O(1) array lookups; no map, no caching, no rebuilding on `dispose()`.

---

## §4. Shape reporting API (Goal B)

### §4.1 Two new public methods on `ComparisonSession`

```ts
/** Whole-session shape descriptor. Always available after a run. */
getSessionShape(): SessionShape;

/** Per-step shape descriptor. Throws if both sides are absent at this index. */
getStepShape(stepIndex: number): StepShape;
```

### §4.2 No prose renderer

The user has clarified that the prose narrative shape report mentioned in earlier discussion was an interim conversation device, not a feature. **There is no `formatShape()`, no `getShapeReport(): string`, no Markdown emitter.** All shape data flows out as structured TypeScript objects through the two methods above. MCP clients render their own representation; tests assert on the structured data.

### §4.3 `getSessionShape()` semantics

```ts
getSessionShape(): SessionShape {
  this._ensureRun();
  const oursLen = this._ourSession!.steps.length;
  const ngLen   = this._ngSessionAligned()?.steps.length ?? 0;
  const max     = Math.max(oursLen, ngLen);

  const steps: StepShape[] = [];
  const presenceCounts = { both: 0, oursOnly: 0, ngspiceOnly: 0 };
  const largeTimeDeltas: Array<{ stepIndex: number; delta: number }> = [];

  for (let i = 0; i < max; i++) {
    const shape = this.getStepShape(i);
    steps.push(shape);
    presenceCounts[shape.presence]++;
    if (shape.stepStartTimeDelta !== null
        && Math.abs(shape.stepStartTimeDelta) > this._tol.timeDeltaTol) {
      largeTimeDeltas.push({ stepIndex: i, delta: shape.stepStartTimeDelta });
    }
  }

  return {
    analysis: this._analysis ?? "dcop",
    stepCount: { ours: oursLen, ngspice: ngLen, max },
    presenceCounts,
    steps,
    largeTimeDeltas,
  };
}
```

### §4.4 `getStepShape(i)` semantics

```ts
getStepShape(stepIndex: number): StepShape {
  this._ensureRun();
  const ours = this._ourSession!.steps[stepIndex];
  const ng   = this._ngSessionAligned()?.steps[stepIndex];
  if (!ours && !ng) {
    throw new Error(`getStepShape: step ${stepIndex} out of range on both sides`);
  }
  const presence: SidePresence =
    ours && ng ? "both" : ours ? "oursOnly" : "ngspiceOnly";

  const summarize = (s: StepSnapshot | undefined): AttemptSummary[] | null =>
    s ? s.attempts.map(a => ({
      phase: a.phase,
      outcome: a.outcome,
      dt: a.dt,
      iterationCount: a.iterationCount,
      converged: a.converged,
    })) : null;

  const counts = (s: StepSnapshot | undefined): AttemptCounts | null => {
    if (!s) return null;
    const byPhase: Partial<Record<NRPhase, number>> = {};
    const byOutcome: Partial<Record<NRAttemptOutcome, number>> = {};
    for (const a of s.attempts) {
      byPhase[a.phase] = (byPhase[a.phase] ?? 0) + 1;
      byOutcome[a.outcome] = (byOutcome[a.outcome] ?? 0) + 1;
    }
    return { byPhase, byOutcome, total: s.attempts.length };
  };

  return {
    stepIndex,
    presence,
    stepStartTime: { ours: ours?.stepStartTime ?? null, ngspice: ng?.stepStartTime ?? null },
    stepEndTime:   { ours: ours?.stepEndTime   ?? null, ngspice: ng?.stepEndTime   ?? null },
    stepStartTimeDelta:
      ours && ng ? ours.stepStartTime - ng.stepStartTime : null,
    attemptCounts: { ours: counts(ours), ngspice: counts(ng) },
    attempts: { ours: summarize(ours), ngspice: summarize(ng) },
    integrationMethod: {
      ours: ours?.integrationCoefficients.ours.method ?? null,
      ngspice: ng?.integrationCoefficients.ngspice.method ?? null,
    },
  };
}
```

### §4.5 Shape divergences in `getDivergences`

A shape disagreement (asymmetric presence, or paired steps with different attempt counts / different accepted-attempt phase) emits one synthetic `DivergenceEntry` with `category: "shape"`, `iteration: -1`, and the appropriate `presence`. This makes shape problems show up in any code that already iterates `divergences` (e.g. the MCP `harness_query` divergence drilldown).

A shape divergence is reported when:
- `presence !== "both"`, OR
- `attemptCounts.ours.total !== attemptCounts.ngspice.total`, OR
- the accepted-attempt `phase` differs between sides, OR
- the accepted-attempt `outcome` differs between sides.

`absDelta` for a shape divergence is `|attemptCounts.ours.total - attemptCounts.ngspice.total|` (or 0 for phase/outcome mismatches with equal attempt counts). `withinTol` is always `false` for shape divergences.

### §4.6 Tolerance addition

`Tolerance` (in `types.ts`) gains:

```ts
/** Maximum acceptable |stepStartTime_ours - stepStartTime_ngspice| in seconds. */
timeDeltaTol: number;   // default 1e-12
```

The `largeTimeDeltas` field is filtered against this. The default is loose enough that bit-aligned self-compare always passes, and tight enough that real engine drift is reported.

---

## §5. Time-based query: `getStepAtTime`

Index pairing means there is no longer an "alignment" abstraction the consumer can use to convert wall-clock to step index. We replace it with a direct query.

### §5.1 Signature

```ts
getStepAtTime(t: number, side: Side = "ours"): number | null;
```

Returns the step index whose `stepStartTime` interval contains `t`, on the chosen side. Returns `null` when out of range.

### §5.2 Interval semantics

Half-open: `stepStartTime <= t < stepEndTime`. The boot step has `stepStartTime === stepEndTime === 0` (spec §5 of timestep-alignment-spec, kept). For the boot step we add a special case: `t === 0` returns the boot step index (typically 0). For all other steps, `t === stepEndTime` belongs to the *next* step.

### §5.3 Implementation

```ts
getStepAtTime(t: number, side: Side = "ours"): number | null {
  this._ensureRun();
  const steps = (side === "ours"
    ? this._ourSession!.steps
    : this._ngSessionAligned()?.steps) ?? [];
  if (steps.length === 0) return null;

  // Boot-step exact-zero special case
  if (t === 0) {
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].stepStartTime === 0 && steps[i].stepEndTime === 0) return i;
    }
    // Fall through to interval search
  }

  // Interval search (linear; sessions are O(steps), not enough to merit binary)
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.stepStartTime <= t && t < s.stepEndTime) return i;
  }
  // Last step: include the closing endpoint
  const last = steps[steps.length - 1];
  if (t === last.stepEndTime) return steps.length - 1;
  return null;
}
```

### §5.4 Why `Side` is disjoint from `presence`

Note carefully that `Side = "ours" | "ngspice"` (selector for `getStepAtTime`) is **separate** from `SidePresence = "both" | "oursOnly" | "ngspiceOnly"`. Earlier drafts collided these by reusing `Side` for both axes; this spec uses two distinct types so neither axis loses information when the other is mentioned.

---

## §6. Test helper redesign (Goal C)

### §6.1 The forbidden pattern

`src/solver/analog/__tests__/harness/query-methods.test.ts:114-146` (`buildHwrSession`) constructs an `MNAEngine` directly, runs `engine.dcOperatingPoint()`, manually wires `stepPhaseHook` and `postIterationHook` to a `createStepCaptureHook` instance, calls `endStep()` by hand, then injects the resulting `CaptureSession` into a `TestableComparisonSession` subclass via the back-door `setTestSession()` method (`query-methods.test.ts:91-108`).

Three things wrong with this:

1. **Test-only path bypasses the production capture pipeline.** Anything that breaks in `init()` / `runDcOp()` is invisible to these tests.
2. **`TestableComparisonSession` is a permanent subclass that monkey-patches `_alignedNgIndex` and `_comparisons`** (lines 106-107) — this is fragile to internal-rename refactors and a red flag for the architecture.
3. **The manual `endStep` call commits semantics that production code does not** — the test could pass while production fails because of an off-by-one in the step closer.

### §6.2 The replacement: `ComparisonSession.createSelfCompare(opts)`

New static factory in `src/solver/analog/__tests__/harness/comparison-session.ts`:

```ts
static async createSelfCompare(opts: {
  /** Either dtsPath or an inline circuit factory. */
  dtsPath?: string;
  buildCircuit?: (registry: ComponentRegistry) => Circuit;
  analysis: "dcop" | "tran";
  tStop?: number;       // required if analysis === "tran"
  maxStep?: number;     // optional
  tolerance?: Partial<Tolerance>;
}): Promise<ComparisonSession> {
  const session = new ComparisonSession({
    dtsPath: opts.dtsPath ?? "<inline>",
    tolerance: opts.tolerance,
    selfCompare: true,        // NEW flag — disables ngspice bridge entirely
  });
  await session.initSelfCompare(opts.buildCircuit);

  if (opts.analysis === "dcop") {
    await session.runDcOp();
  } else {
    if (opts.tStop === undefined) {
      throw new Error("createSelfCompare: tStop required for transient analysis");
    }
    await session.runTransient(0, opts.tStop, opts.maxStep);
  }
  return session;
}
```

The `selfCompare: true` flag changes two things in `init()` / the run methods:

- The ngspice bridge is **never** instantiated. The `runDcOp()` / `runTransient()` ngspice block becomes `if (!this._opts.selfCompare && this._cirClean) { ... }`.
- After our side runs, `this._ngSession` is **deep-cloned from `this._ourSession`**, with `topology.source` rewritten to `"ngspice"`. This produces a bit-identical reference session that pairs perfectly by index (Goal F mechanical proof).
- `this._nodeMap` is built as the identity mapping (`{ ourIndex: i, ngspiceIndex: i }` for each node).

### §6.3 Deletions

- **Delete entire class:** `query-methods.test.ts:91-109` (`TestableComparisonSession`).
- **Delete entire function:** `query-methods.test.ts:114-146` (`buildHwrSession`).
- **Replace all callers** (`query-methods.test.ts` tests 19-43 plus any tran-path cousins) with:
  ```ts
  const session = await ComparisonSession.createSelfCompare({
    buildCircuit: () => makeHWR().circuit,
    analysis: "dcop",
  });
  ```

### §6.4 Why this is sufficient

The redesigned helper exercises the **exact same** `init()` → `runDcOp()` / `runTransient()` codepath that production tests use. The only difference is that the ngspice side is a clone rather than a separate solver. Every assertion on shape, divergences, traces, and component slots passes through the same `_getComparisons()` / `getStepShape()` / `compareSnapshots()` machinery as a real ngspice run. This is the closest we can get to "test the production path" without paying the ngspice startup cost.

### §6.5 Inline circuit option

Some tests need ad-hoc topology that no `.dts` fixture covers (e.g. the `makeRC()` and `makeHWR()` factories at `query-methods.test.ts:58-86`). The `buildCircuit` callback provides a hook for those: it runs after the registry is created but before `compileUnified()`. The session never reads a `.dts` file when `buildCircuit` is supplied.

---

## §7. Master logging switch and convergence-log unification (Goal D)

### §7.1 The four instrumentation channels today

1. `engine.postIterationHook` — fires inside `newton-raphson.ts` per NR iteration. Captures matrix, RHS, voltages, state. Public field at `analog-engine.ts:912-914` area.
2. `engine.stepPhaseHook` — fires from `analog-engine.step()` retry loop (`analog-engine.ts:343-478`) and from `dc-operating-point.ts` phase transitions (`dc-operating-point.ts:215-706`). Public field on engine.
3. `engine.detailedConvergence: boolean` — flips on the per-element convergence collection in `newton-raphson.ts:518-557`.
4. `engine.limitingCollector: LimitingEvent[] | null` — appended to from PN-junction limiting code paths.

Plus the convergence ring buffer:
5. `engine.convergenceLog.enabled: boolean` — gates the per-step `StepRecord` writes in `analog-engine.step()`.

### §7.2 Today's harness wires these one at a time

`comparison-session.ts:325` (`setCaptureHook(bufferingHook)` — phase hook only), then `comparison-session.ts:332-334`:
```ts
this._engine.detailedConvergence = true;
this._engine.limitingCollector = [];
```
And `runTransient()` rewires `postIterationHook` and `stepPhaseHook` again at lines 466-474. The convergence log is **not** touched by the harness.

This is fragile: a future field is added to `MNAEngine` and the harness silently misses it.

### §7.3 New contract: `setCaptureHook` is the master switch

`DefaultSimulatorFacade.setCaptureHook(bundle)` (`default-facade.ts:118-120`) becomes:

```ts
setCaptureHook(bundle: PhaseAwareCaptureHook | null): void {
  this._captureHook = bundle;
  // Forward to active coordinator if one already exists. The coordinator
  // owns the master-switch responsibility once installed.
  if (this._coordinator instanceof DefaultSimulationCoordinator) {
    this._coordinator.applyCaptureHook(bundle);
  }
}
```

A new coordinator method:

```ts
// coordinator.ts
applyCaptureHook(bundle: PhaseAwareCaptureHook | null): void {
  if (!this._analog) return;
  const e = this._analog as MNAEngine;
  if (bundle === null) {
    e.postIterationHook = null;
    e.stepPhaseHook = null;
    e.detailedConvergence = false;
    e.limitingCollector = null;
    e.convergenceLog.enabled = false;
    return;
  }
  e.postIterationHook = bundle.iterationHook;
  e.stepPhaseHook = bundle.phaseHook;
  e.detailedConvergence = true;
  e.limitingCollector = [];
  e.convergenceLog.enabled = true;
}
```

The bundle-or-null shape gives consumers a single atomic on/off and removes the four-line unwiring dance.

### §7.4 Convergence-log integration: `iterationDetails` becomes a contract

`convergence-log.ts:36-46` already documents an `iterationDetails?` field on `NRAttemptRecord` and notes that it is "populated only when the comparison harness postIterationHook is active alongside convergence logging". This is currently an unrealized intent — there is no code that actually populates it.

This spec **locks down the contract**:

> When `engine.convergenceLog.enabled === true` AND `engine.postIterationHook !== null`, every `NRAttemptRecord.iterationDetails` MUST be populated with one entry per NR iteration. The harness can therefore read the convergence log via `coordinator.getConvergenceLog()` and recover per-iteration data without re-running the engine.

Implementation site: `analog-engine.ts:400-408` (the `stepRec.attempts.push` branch in `step()`) and `analog-engine.ts:676-687` (the corresponding branch in `dcOperatingPoint()`). When the conditions hold, the harness's `postIterationHook` builds a tap that pushes `{ iteration, maxDelta, maxDeltaNode, noncon, converged }` into a per-attempt scratch buffer; on `endAttempt`, the buffer is moved into the corresponding `NRAttemptRecord.iterationDetails`.

The exact wiring lives in `createIterationCaptureHook` (the inner helper of `createStepCaptureHook` at `capture.ts:294-429`), which already has access to the per-iteration snapshot. We extend it to expose a `drainForLog(): IterationDetail[]` method that the engine can call right before pushing the attempt record.

### §7.5 The conflict: who owns convergence-log enabled state?

This is the subtle bit. Three sources currently flip `convergenceLog.enabled`:

| Source | File:line |
|--------|-----------|
| UI panel auto-enable on open | `convergence-log-panel.ts:249, 292, 363, 416-433` |
| MCP `circuit_convergence_log enable` | `simulation-tools.ts:415-465` |
| postMessage `setConvergenceLogEnabled(true/false)` | `postmessage-adapter.ts:434-447` |

Plus a new fourth source: the harness master switch.

**Design decision:** The harness master switch wins while installed. Specifically:

- Calling `setCaptureHook(bundle)` immediately sets `convergenceLog.enabled = true`.
- While the bundle is installed, calling `setConvergenceLogEnabled(false)` from any other surface **throws** with the message: `"Cannot disable convergence log while a comparison harness capture hook is installed. Call setCaptureHook(null) first."`
- Calling `setConvergenceLogEnabled(true)` from another surface while the bundle is installed is a **no-op** (already true).
- Calling `setCaptureHook(null)` does NOT auto-disable the convergence log if it was enabled by another source before the harness was installed. The coordinator tracks `_convergenceLogPreHookState: boolean` and restores it. (This is the tracked-restore variant; the alternative is documented in Q1 below.)

### §7.6 Tradeoff matrix for Goal D

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **A. setCaptureHook is master (selected)** | One bundle install, all five flags atomically toggled, mutual exclusion enforced via throw | Atomic, race-free, impossible to forget a flag, surfaces conflicts loudly | UI/MCP toggles must be aware they may throw; one extra `_convergenceLogPreHookState` field |
| B. Independent toggles | Keep five separate flags; harness flips them one at a time | No surface coordination needed | Already shown to be fragile (`comparison-session.ts:332-334` race today); future fields will be missed |
| C. Enum mode `setLoggingMode("off" \| "convergence" \| "harness")` | One mode field, mode-aware behavior throughout | Single source of truth | Forces ungrouped flags to rendezvous on enum changes; refactor cost is large; mode != hook is confusing |

### §7.7 Q&A

**Q.** Does the harness need `iterationDetails` if it already has `postIterationHook` snapshots?
**A.** Not strictly — the snapshots are richer. The contract exists so that code OUTSIDE the harness (e.g., a future "post-mortem analyzer" UI) can replay an iteration trace from the convergence log without re-running the engine. The harness gets it for free as a side effect of the master switch, and pays nothing extra.

**Q.** What if the user opens the UI convergence log panel during a harness run?
**A.** The panel's auto-enable code at `convergence-log-panel.ts:249` already calls `coord.setConvergenceLogEnabled(true)`. Per §7.5 that's a no-op (already true). The panel reads via `getConvergenceLog(lastN)` which is unchanged. The user sees harness-quality data including `iterationDetails`. Win.

**Q.** What if the user toggles the panel off during a harness run?
**A.** The panel's disable code calls `setConvergenceLogEnabled(false)`. Per §7.5 that throws. The panel must catch the throw and surface a notification: "Cannot disable convergence log: comparison harness is active." Q1 (open question) asks whether this should be a silent no-op instead.

---

## §8. DCOP-in-compile findings (Goal E)

### §8.1 Today's flow

`DefaultSimulationCoordinator` constructor (`coordinator.ts:87-146`):
1. Build engine (`coordinator.ts:114-115`).
2. Install capture hook on `engine.stepPhaseHook` (`coordinator.ts:118-120`).
3. **Run DCOP** (`coordinator.ts:121`): `this._cachedDcOpResult = engine.dcOperatingPoint();`
4. Cache the result; coordinator is "done".

The harness worked around step 3 by installing a buffering hook BEFORE calling `compile()`, capturing the in-compile DCOP attempts into `_dcopBootAttempts`, and replaying them into step 0 of `_stepCapture` when `runDcOp()` or `runTransient()` is later called (`comparison-session.ts:296-356`, `:391-407`, `:478-482`).

### §8.2 Why DCOP runs in the constructor

There are essentially three reasons in the codebase:

1. **`getDcOpResult()` returns `_cachedDcOpResult`** without running anything (`default-facade.ts:389-391`). Consumers expect a fresh compile to have a DCOP available.
2. **Coordinator-driven `step()` assumes DCOP has run**, because the first transient step needs a converged starting point.
3. **Postmessage adapter and UI**: many surfaces call `getDcOpResult()` shortly after `compile()` and expect it to be non-null.

None of these requires DCOP to fire INSIDE the constructor. They only require DCOP to fire SOMEWHERE before the consumer reads the result.

### §8.3 Selected option: E1 — defer DCOP via `coordinator.initialize()`

```ts
// coordinator.ts — new method
initialize(): void {
  if (this._initialized) return;
  if (!this._analog) { this._initialized = true; return; }
  this._cachedDcOpResult = (this._analog as MNAEngine).dcOperatingPoint();
  this._initialized = true;
}

// constructor: REMOVE the dcOperatingPoint() call at line 121.
// Replace with: (nothing — the constructor stops at engine creation)
```

`DefaultSimulatorFacade.compile(circuit, opts?)` becomes:

```ts
compile(circuit: Circuit, opts?: { deferInitialize?: boolean }): SimulationCoordinator {
  this._disposeCurrentEngine();
  this._circuit = null;
  this._coordinator = new NullSimulationCoordinator();

  const unified = compileUnified(circuit, this._registry);
  const coordinator = new DefaultSimulationCoordinator(unified, this._registry);
  this._coordinator = coordinator;
  this._circuit = circuit;

  // Apply capture hook BEFORE initialize so the in-init DCOP is captured.
  if (this._captureHook) coordinator.applyCaptureHook(this._captureHook);

  if (!opts?.deferInitialize) {
    coordinator.initialize();
  }
  return coordinator;
}
```

Default behavior: `compile()` always calls `initialize()` immediately, so existing call sites are unchanged. The harness opts into deferral via `compile(circuit, { deferInitialize: true })`, then calls `coordinator.initialize()` later inside `runDcOp()` / `runTransient()` AFTER its real `_stepCapture` is wired up. **No buffer is needed.**

### §8.4 Rejected options

| Option | Why rejected |
|--------|--------------|
| E2: Rename `_dcopBootAttempts` to `_bootStepAttempts` and tidy comments | Cosmetic; preserves the buffer-and-replay anti-pattern; still requires a buffering hook before compile |
| E3: Construct an "uninitialized null coordinator" first, attach hook, then re-compile | Two-compile pattern doubles the cost and trips lifecycle assumptions in `_disposeCurrentEngine` |

### §8.5 Migration of `init()` after Goal E

```ts
async init(): Promise<void> {
  const registry = createDefaultRegistry();
  this._facade = new DefaultSimulatorFacade(registry);

  const dtsJson = readFileSync(resolvePath(this._opts.dtsPath), "utf-8");
  const circuit = this._facade.deserialize(dtsJson);

  // Compile WITHOUT running DCOP.
  this._coordinator = this._facade.compile(
    circuit, { deferInitialize: true }
  ) as DefaultSimulationCoordinator;
  this._engine = this._coordinator.getAnalogEngine() as MNAEngine;

  if (!this._engine) {
    this._elementLabels = new Map();
    this._ourTopology = emptyTopology();
    return;
  }

  // Build labels + topology BEFORE creating the capture hook (capture
  // needs labels, labels need a built engine).
  const compiled = this._engine.compiled! as ConcreteCompiledAnalogCircuit;
  this._elementLabels = buildElementLabelMap(compiled);
  this._ourTopology = captureTopology(compiled, this._elementLabels);

  // Build the real step capture hook.
  this._stepCapture = createStepCaptureHook(
    this._engine.solver!,
    this._engine.elements,
    this._engine.statePool,
    this._elementLabels,
  );

  // Build the PhaseAwareCaptureHook bundle that wraps the step capture.
  const sc = this._stepCapture;
  const bundle: PhaseAwareCaptureHook = {
    iterationHook: sc.iterationHook,    // renamed from sc.hook in §9
    phaseHook: {
      onAttemptBegin(phase: string, dt: number, phaseParameter?: number): void {
        sc.beginAttempt(phase as NRPhase, dt, phaseParameter);
      },
      onAttemptEnd(outcome: string, converged: boolean): void {
        sc.endAttempt(outcome as NRAttemptOutcome, converged);
      },
    },
  };

  // Install the master switch — atomically enables all five channels.
  this._facade.setCaptureHook(bundle);

  // Build the boot step. Set start time then trigger DCOP — phase hooks
  // fire directly into _stepCapture, no buffering, no replay.
  sc.setStepStartTime(0);
  this._coordinator.initialize();
  sc.endStep({
    stepEndTime: 0,
    integrationCoefficients: _zeroDcopCoefficients(),
    analysisPhase: "dcop",
    acceptedAttemptIndex: -1,
  });

  // The boot step is now sitting in _stepCapture as steps[0].
  // runDcOp() will pick it up; runTransient() will pick it up and continue.

  if (this._opts.cirPath) {
    const cirRaw = readFileSync(resolvePath(this._opts.cirPath), "utf-8");
    this._cirClean = stripControlBlock(cirRaw);
  } else if (this._engine) {
    this._cirClean = generateSpiceNetlist(compiled, this._elementLabels);
  }
}
```

**Net effect:** `_dcopBootAttempts` is gone. The buffering hook is gone. `runDcOp()` no longer rebuilds the boot step from a replay buffer; it just snapshots `_stepCapture.getSteps()` and runs the ngspice side. `runTransient()` no longer replays DCOP attempts at lines 478-482; the boot step is already in `_stepCapture` from `init()`.

### §8.6 Cost analysis

The cost of Goal E is one new boolean field (`_initialized`), one new method (`initialize()`), one new optional parameter to `compile()`, and one no-op-if-initialized guard. Eliminated: `_dcopBootAttempts` field, the type `AttemptCall`/`EndCall` shapes used only for buffering, the `bufferingHook` closure (`comparison-session.ts:308-322`), the replay loops at `comparison-session.ts:403-406` and `:479-482`, and an entire category of "did the buffer get drained?" bugs. **Net: −40 LOC, +1 method, +0 conceptual overhead.**

### §8.7 Coordinator-types interface update

`coordinator-types.ts:120` block needs:

```ts
/** Apply a phase-aware capture hook (master switch). Pass null to clear. */
applyCaptureHook(bundle: PhaseAwareCaptureHook | null): void;

/** Run the deferred initialization (DCOP for analog backends). Idempotent. */
initialize(): void;
```

Both must be implemented as no-ops on `null-coordinator.ts:109-110` and `mock-coordinator.ts:91-92`.

---

## §9. Migration checklist

This is a per-file edit list. Every entry cites the current line number from the as-of-this-spec source.

### §9.1 `src/solver/analog/__tests__/harness/types.ts`

- [ ] Add `SidePresence`, `Side`, `AttemptSummary`, `AttemptCounts`, `StepShape`, `SessionShape`, `PhaseAwareCaptureHook` (per §2.1, §2.4).
- [ ] `:308-319` `StepEndReport`: replace `unaligned?: boolean` with `presence: SidePresence`.
- [ ] `:523` `DivergenceCategory`: add `"shape"`.
- [ ] `:525-538` `DivergenceEntry`: add `presence: SidePresence`.
- [ ] `:376-391` `SessionSummary`: add `presenceCounts`, `worstStepStartTimeDelta`.
- [ ] `:738` find-and-fix the second `unaligned?` site (likely in `ToJSONOpts` or a sibling type).
- [ ] Add `timeDeltaTol: number` to `Tolerance`; default `1e-12` in `DEFAULT_TOLERANCE`.
- [ ] Update `ComparisonResult` shape (per §3.2): add `presence: SidePresence`.

### §9.2 `src/solver/analog/__tests__/harness/compare.ts`

- [ ] `:41-46` `compareSnapshots` signature: drop the `alignment?` parameter.
- [ ] `:48` change loop bound to `Math.max(ours.steps.length, ref.steps.length)`.
- [ ] `:52-54` delete the `alignment.get(si) ?? si` redirection.
- [ ] `:50-194` add the asymmetric branch (per §3.1).
- [ ] `:181-190` add `presence: "both"` to the result push (and `"oursOnly"`/`"ngspiceOnly"` in the asymmetric branch).

### §9.3 `src/solver/analog/__tests__/harness/comparison-session.ts`

- [ ] `:240` delete `_dcopBootAttempts` field.
- [ ] `:251` delete `_alignedNgIndex` field.
- [ ] `:295-371` rewrite `init()` per §8.5.
- [ ] `:386-443` rewrite `runDcOp()`: drop the `_dcopBootAttempts.length === 0` guard at `:391-396`; drop the replay block at `:402-414`; the boot step is already in `_stepCapture` from `init()`. Keep the ngspice block. Drop the `_buildTimeAlignment()` call at `:442`.
- [ ] `:452-547` rewrite `runTransient()`: drop the rewiring at `:466-474` (the master-switch bundle is already installed in `init()`); drop the replay block at `:478-482`; drop the `_buildTimeAlignment()` call at `:546`. Keep the per-step `coordinator.step()` loop. At the end, call `setCaptureHook(null)` to release the master switch.
- [ ] `:557` rewrite `getStepEnd`: replace `_alignedNgIndex.get(stepIndex)` lookup with `this._ngSessionAligned()?.steps[stepIndex]` direct index. Compute `presence` via `_stepPresence(i)`. The method now returns asymmetric data when `presence !== "both"`.
- [ ] `:564, :642, :937, :981, :1024, :1062, :1108, :1172, :1303, :1355, :1382, :1410, :1474` — every `_alignedNgIndex.get(...)` site (18 in total per Grep at §9.0): replace with direct `[stepIndex]` access on `_ngSessionAligned()?.steps`. None of these need fallback logic — `undefined` is the asymmetric signal.
- [ ] `:1505-1534` rewrite `toJSON`: replace `unaligned: !this._alignedNgIndex.has(i)` with `presence: this._stepPresence(i)`. Step list is now per-`getSessionShape().steps` instead of the inline build.
- [ ] `:1540-1547` rewrite `dispose()`: drop `_alignedNgIndex.clear()`.
- [ ] `:1583-1611` **delete** `_buildTimeAlignment()` entirely.
- [ ] `:1618-1626` rewrite `_getComparisons()`: drop the alignment argument from `compareSnapshots(...)` call.
- [ ] Add `_stepPresence(i)` and `_stepStartTimeDelta(i)` private helpers (§3.4).
- [ ] Add public `getSessionShape()` and `getStepShape(i)` (§4).
- [ ] Add public `getStepAtTime(t, side)` (§5).
- [ ] Add static `createSelfCompare(opts)` (§6.2).
- [ ] Add `initSelfCompare(buildCircuit?)` private method that mirrors `init()` but skips `cirPath` parsing and clones `_ourSession → _ngSession` after the run.
- [ ] Add `selfCompare?: boolean` to `ComparisonSessionOptions`.
- [ ] In `runDcOp()` / `runTransient()`, gate the ngspice bridge block on `!this._opts.selfCompare`.
- [ ] In `runDcOp()` / `runTransient()`, after our side completes, when `selfCompare` is true: deep-clone `_ourSession` into `_ngSession` and set `_ngSessionReindexed = _ngSession`; build identity `_nodeMap`.

### §9.4 `src/solver/analog/__tests__/harness/capture.ts`

- [ ] `:299-313` rename `hook` field of the `createStepCaptureHook` return shape to `iterationHook` (matches the new `PhaseAwareCaptureHook.iterationHook`). All call sites in `comparison-session.ts` and `query-methods.test.ts` follow.
- [ ] Add `drainForLog(): IterationDetail[]` method on the inner iteration capture (§7.4) for convergence-log integration.

### §9.5 `src/solver/analog/__tests__/harness/query-methods.test.ts`

- [ ] `:91-109` **delete** `TestableComparisonSession` class.
- [ ] `:114-146` **delete** `buildHwrSession()`.
- [ ] All callers of `buildHwrSession()` (tests numbered 19-43; locate via the Grep tool on `buildHwrSession`) — replace with `await ComparisonSession.createSelfCompare({...})`.
- [ ] Tests that monkey-patch `_comparisons` directly (test 30 is the main culprit) must be rewritten to use a fixture circuit that produces the desired divergences naturally, OR moved to a new `compare.test.ts` that unit-tests `compareSnapshots` directly with hand-built `CaptureSession` literals.

### §9.6 `src/headless/default-facade.ts`

- [ ] `:118-120` change `setCaptureHook` signature to take `PhaseAwareCaptureHook | null`. Forward to `coordinator.applyCaptureHook(bundle)` if a coordinator already exists.
- [ ] `:122-134` change `compile(circuit)` to `compile(circuit, opts?: { deferInitialize?: boolean })`. After constructing the coordinator, apply the stored capture hook (if any), then call `initialize()` unless deferred.
- [ ] `:393-396` `setConvergenceLogEnabled`: when `_captureHook !== null` and `enabled === false`, throw the §7.5 error message.
- [ ] Update the imported `CaptureHook` type alias to point at `PhaseAwareCaptureHook`.

### §9.7 `src/solver/coordinator.ts`

- [ ] `:87-146` constructor: drop `captureHook?: MNAEngine["stepPhaseHook"]` parameter; drop the hook install at `:116-120`; drop `engine.dcOperatingPoint()` at `:121`; engine is constructed but DCOP is not run.
- [ ] Add private field `_initialized: boolean = false`.
- [ ] Add private field `_convergenceLogPreHookState: boolean = false`.
- [ ] Add public method `initialize()` (per §8.3).
- [ ] Add public method `applyCaptureHook(bundle: PhaseAwareCaptureHook | null)` (per §7.3) — this method also flips `convergenceLog.enabled` and stores the pre-hook state.
- [ ] `:382-384` `setConvergenceLogEnabled`: when `_captureHookInstalled` and `enabled === false`, throw per §7.5.

### §9.8 `src/solver/coordinator-types.ts`

- [ ] `:120` block: add `applyCaptureHook(bundle: PhaseAwareCaptureHook | null): void`.
- [ ] Same block: add `initialize(): void`.

### §9.9 `src/solver/null-coordinator.ts` and `src/test-utils/mock-coordinator.ts`

- [ ] Both: add no-op `applyCaptureHook` and no-op `initialize` (per §8.7).

### §9.10 `src/solver/analog/analog-engine.ts`

- [ ] `:400-408` `step()` `stepRec.attempts.push` branch: when `convergenceLog.enabled && postIterationHook !== null`, drain `iterationDetails` from the capture and attach.
- [ ] `:676-687` `dcOperatingPoint()` similar branch: same drain.
- [ ] No public-API changes.

### §9.11 `src/solver/analog/dc-operating-point.ts`

- [ ] No structural changes — the existing `onPhaseBegin`/`onPhaseEnd` callbacks (`:90-97`, fired throughout `:215-706`) already produce exactly what `phaseHook.onAttemptBegin`/`onAttemptEnd` consumes.

### §9.12 `src/solver/analog/convergence-log.ts`

- [ ] `:36-46` lock down the `iterationDetails` doc comment from "may be populated" to "MUST be populated when both gates are true".

### §9.13 `src/solver/analog/__tests__/harness/ngspice-bridge.ts`

- [ ] No changes. The grouping state machine at `:530-700` produces a `CaptureSession` whose `steps` array is consumed by the new index-based pipeline without adaptation.

### §9.14 `scripts/mcp/harness-tools.ts`

- [ ] `:401` `harness_query`: add a new mode `"shape"` that calls `getSessionShape()`.
- [ ] `:727, :854, :900` `getStepEnd` call sites: update to consume `presence` field; surface `oursOnly`/`ngspiceOnly` in the tool response.
- [ ] `:753, :934` `getDivergences` call sites: shape divergences flow through the existing structure (with `category: "shape"`); no shape changes needed beyond the type update.
- [ ] Add `harness_get_step_at_time` tool (or fold into `harness_query`) for §5.

### §9.15 `scripts/mcp/simulation-tools.ts`

- [ ] `:415-465` `circuit_convergence_log` enable/disable: catch the new throw from the facade's `setConvergenceLogEnabled` and surface a clear error to the MCP caller.

### §9.16 `src/io/postmessage-adapter.ts`

- [ ] `:434, :438` `setConvergenceLogEnabled` handlers: catch the new throw, send a `sim-error` reply with the harness-conflict message.
- [ ] `:447` `getConvergenceLog`: unchanged.

### §9.17 `src/app/convergence-log-panel.ts`

- [ ] `:249, :292, :363, :416-433` panel auto-enable/disable: wrap the `setConvergenceLogEnabled(false)` calls in try/catch, surface a UI notification when the harness is active.

---

## §10. Test strategy

### §10.1 Tests that survive as-is

- Every test in `query-methods.test.ts` that calls a public `ComparisonSession` query method on a session created via `createSelfCompare` (i.e. tests 1-7, 8-14, 15-18 in glob/format/serialize sections, after the helper migration).
- Every test in `compare.test.ts` (if it exists) that builds `CaptureSession` literals and calls `compareSnapshots(ours, ref, tol)` — these need only the parameter-order update to drop `alignment`.
- Every test in `capture.test.ts` covering `createStepCaptureHook` mechanics — only the `hook → iterationHook` rename is needed.

### §10.2 Tests that need mechanical edits

- `query-methods.test.ts` tests 19-43 (all `buildHwrSession()` callers): replace constructor with `createSelfCompare()`. The test bodies that read `session.getStepEnd(0)` etc. work unchanged because the API surface is preserved.
- Any test asserting on `unaligned: true` — replace with `presence: "oursOnly"` or `"ngspiceOnly"`.
- Any test passing `alignment` to `compareSnapshots` directly — drop the argument.

### §10.3 Tests to delete

- Test 30 in `query-methods.test.ts` (the `_comparisons` monkey-patch test) — the technique it uses (back-door inject) is no longer supported. Replace with a fixture-based test that produces the desired divergences naturally.
- Any test that asserted on `_alignedNgIndex` internals.

### §10.4 New tests to write

| Surface | Test | Validates |
|---------|------|-----------|
| Headless | `getSessionShape()` on a 5-step self-compare returns `presenceCounts: { both: 5, oursOnly: 0, ngspiceOnly: 0 }` | §4.3 happy path |
| Headless | `getStepShape(0).stepStartTimeDelta === 0` for self-compare | Goal F mechanical proof |
| Headless | A divergent self-compare with truncated `ourSession.steps` reports `presence: "ngspiceOnly"` for the missing tail | §3.1 asymmetric branch |
| Headless | `getStepAtTime(0)` on a session with boot step (0,0) returns 0 | §5.2 special case |
| Headless | `getStepAtTime(t)` for `t > simTime` returns `null` | §5.2 |
| Headless | `setCaptureHook(bundle)` flips all five engine flags atomically | §7.3 |
| Headless | `setConvergenceLogEnabled(false)` while bundle installed throws with the §7.5 message | §7.5 |
| Headless | `compile(c, { deferInitialize: true })` returns a coordinator whose `dcOperatingPoint()` returns `null` | §8.3 |
| Headless | After `coordinator.initialize()`, `dcOperatingPoint()` returns the cached result | §8.3 idempotency |
| MCP | `harness_query { mode: "shape" }` returns the structured `SessionShape` | §9.14 |
| MCP | `harness_query { mode: "stepEnd", stepIndex: ... }` returns `presence` field | §9.14 |
| MCP | `circuit_convergence_log { action: "disable" }` while harness installed surfaces a clear error | §9.15 |
| E2E | UI panel toggle while harness active shows the conflict notification | §9.17 |
| E2E | UI panel auto-open shows `iterationDetails` for harness-enabled sessions | §7.4 contract |

### §10.5 Three-surface coverage

Per CLAUDE.md, every user-facing feature is tested headless + MCP + E2E. The user-facing features added by this spec are:

- `getSessionShape` / `getStepShape` (headless API + `harness_query` mode + MCP test, no E2E because shape data isn't user-rendered today).
- `getStepAtTime` (headless + MCP, no E2E).
- The harness/convergence-log mutual exclusion (headless + MCP + E2E because it's user-visible in the UI panel).

### §10.6 Regression sweep

After migration, run:
- `npm run test:q` — full Vitest sweep, expect zero new failures.
- `npm test -- harness` — focused on harness modules, expect a clean run.
- `npm run test:e2e -- convergence-log-panel` — UI conflict notification test.
- The MCP harness end-to-end test (locate via `harness-tools.test.ts`) — expect all modes including the new `"shape"` mode to pass.

---

## §11. Resolved questions

| ID | Question | Resolution | Decider |
|----|----------|------------|---------|
| **Q1** | Should `setConvergenceLogEnabled(false)` while harness is installed **throw** or **silently no-op**? | **THROW** (user confirmed) — no UI path runs harness today, silent no-ops hide bugs | User |
| Q2 | Should `createSelfCompare` support `analysis: "tran"`? | Yes — supports it; cost is one branch in the helper | Author (default) |
| Q3 | Default value of `Tolerance.timeDeltaTol`? | `1e-12` and let the harness override per test | Author (default) |
| **Q4** | Confirm Option E1 (defer DCOP via `coordinator.initialize()`) over E2/E3? | **E1 CONFIRMED** (user) — eliminates `_dcopBootAttempts` buffer | User |
| **Q5** | Should `iterationDetails` (§7.4) be populated *only* when the harness hook is installed, or whenever `convergenceLog.enabled === true` regardless of hook? | **Whenever `convergenceLog.enabled === true` regardless of hook** (user override). Convergence log is independent: when enabled (via UI, API, or harness install), it captures full our-engine iteration data. Harness adds comparison + state + tools on top. `iterationDetails` is part of the convergence-log contract, not the harness contract. | User |
| Q6 | Naming: `presence: "both" \| "oursOnly" \| "ngspiceOnly"` vs `presence: "both" \| "ours" \| "ngspice"` (collides with `Side`) | Keep `oursOnly`/`ngspiceOnly` — disjoint from `Side` | Author (resolved) |
| Q7 | Should `compareSnapshots` accept a per-call tolerance override for `timeDeltaTol`, or read it from the passed `Tolerance` only? | Read from `Tolerance` only — keeps the signature stable | Author (resolved) |
| Q8 | Should `dtsPath` become optional in `ComparisonSessionOptions` for self-compare mode? | Yes, optional with `selfCompare: true` mode — no path read | Author (default) |

**All questions resolved. No blockers for implementation.**

### §11.1 Q5 consequence: iterationDetails drain gate

The original §7.4 contract and §9.10 migration task gated the `iterationDetails` drain on `convergenceLog.enabled && postIterationHook !== null`. Per Q5 resolution, the `postIterationHook` requirement is DROPPED. The drain fires whenever `convergenceLog.enabled === true`, regardless of harness installation.

Implementer rule: at `analog-engine.ts:400-408` and `:676-687`, the drain condition is:

```ts
if (this._convergenceLog.enabled) {
  // populate stepRec.attempts[i].iterationDetails from the capture
}
```

The capture mechanism itself (capture.ts `drainForLog()`) is still populated via the capture hook machinery, but the drain into convergence-log records fires on the log-enabled gate alone.

When the harness is active AND the log is enabled, the drain still works normally — the harness install auto-enables the log as part of the master switch, and nothing in the drain path cares that the hook is installed. When the log is enabled by a UI user with no harness, the drain still fires — the capture infrastructure is present because the convergence log's own enable path must bring it up (implementer: verify the convergence log has its own capture-lite path or extend it to use `createStepCaptureHook` directly).

---

## §12. Implementation wave plan

Six sequential waves with an explicit dependency chain. Each wave lists the agent sizing, affected §9 subsections, spec sections consumed, and the exit gate that proves the wave is done before the next starts.

### §12.1 Wave dependency graph

```
Wave 1 (types + interfaces)
   ↓
Wave 2 (coordinator + facade + engine drain)
   ↓
Wave 3 (comparison-session rewrite + compare.ts + capture.ts)
   ↓
Wave 4 (test migrations)    Wave 5 (MCP + UI surfaces)    Wave 6 (new tests §10.4)
        ↓                          ↓                              ↓
              (all three merge into the regression sweep)
```

Waves 4, 5, 6 are independent after Wave 3 lands and can run in parallel.

### §12.2 Wave 1 — Foundational types (haiku, mechanical)

Purely additive type and interface work. No behavior changes yet. Consumers of the new types land in Wave 2.

| §9 | File | Scope |
|----|------|-------|
| §9.1 | `src/solver/analog/__tests__/harness/types.ts` | Add `SidePresence`, `Side`, `AttemptSummary`, `AttemptCounts`, `StepShape`, `SessionShape`, `PhaseAwareCaptureHook`. Modify `StepEndReport`, `DivergenceCategory`, `DivergenceEntry`, `SessionSummary`, `ComparisonResult`, `Tolerance` (add `timeDeltaTol`). Two `unaligned?` sites flagged in §9.1 get replaced by `presence`. |
| §9.8 | `src/solver/coordinator-types.ts` | Add `applyCaptureHook(bundle: PhaseAwareCaptureHook \| null): void` and `initialize(): void` to the coordinator interface. |
| §9.9 | `src/solver/null-coordinator.ts`, `src/test-utils/mock-coordinator.ts` | No-op stubs for the two new methods. |
| §9.12 | `src/solver/analog/convergence-log.ts` | Lock down `:36-46` `iterationDetails` doc comment from "may be populated" to "MUST be populated when `convergenceLog.enabled === true`" (per §7.4 and §11.1 Q5 resolution — drop the `postIterationHook !== null` gate). |

**Exit gate:** `npx tsc --noEmit` — all additive type edits compile, no new errors. `ComparisonResult.presence`, `StepEndReport.presence`, `DivergenceCategory` including `"shape"`, and `Tolerance.timeDeltaTol` are visible to consumers.

**Breaking concern:** `StepEndReport.unaligned?` → `StepEndReport.presence` is a type-breaking rename. Wave 3 will fix call sites. Wave 1 is allowed to produce temporarily-broken downstream typecheck until Wave 2 lands — the rename must still happen at this wave because Wave 2's coordinator code references `presence`.

### §12.3 Wave 2 — Coordinator E1 wiring + facade + engine drain (sonnet)

Implements Goals D (master switch) and E (DCOP deferral). Every subsequent wave depends on `applyCaptureHook` + `initialize()` existing on the coordinator.

| §9 | File | Scope |
|----|------|-------|
| §9.7 | `src/solver/coordinator.ts` | Constructor drops DCOP call (line :121) and `captureHook` parameter. Add `_initialized`, `_convergenceLogPreHookState` private fields. Add public `initialize()` per §8.3. Add public `applyCaptureHook(bundle)` per §7.3. Add throw in `setConvergenceLogEnabled` when `_captureHookInstalled && enabled === false` per §7.5. |
| §9.6 | `src/headless/default-facade.ts` | Change `setCaptureHook` signature to take `PhaseAwareCaptureHook \| null` (§7.3). Change `compile(circuit)` → `compile(circuit, opts?: { deferInitialize?: boolean })` per §8.3. After constructing coordinator, apply stored capture hook if any, then call `initialize()` unless deferred. `setConvergenceLogEnabled` throws on conflict per §7.5. |
| §9.10 | `src/solver/analog/analog-engine.ts` | `:400-408` `step()` and `:676-687` `dcOperatingPoint()`: when `convergenceLog.enabled === true`, drain `iterationDetails` from capture and attach to `stepRec.attempts[i]`. **Gate is log-enabled ONLY, not `&& postIterationHook !== null`** (§11.1 Q5 resolution). |

**Exit gate:** 
- `npx tsc --noEmit` — all existing code still compiles. The `compile(circuit)` callers that don't pass opts are unaffected (opts is optional).
- Run existing tests: anything that doesn't touch the harness should still pass. Expect the comparison-session.ts tests to fail because comparison-session still references `_dcopBootAttempts` and `_alignedNgIndex` — that's Wave 3. **Do not attempt to make comparison-session tests pass at this wave.**
- Add a minimal smoke test: `compile(c, { deferInitialize: true })` returns a coordinator where `dcOperatingPoint()` has NOT been called. Then `coordinator.initialize()` runs it. (§10.4 "compile deferInitialize" test.)

### §12.4 Wave 3 — Comparison-session rewrite + compare.ts + capture.ts (sonnet, bulk)

The largest wave. Deletes `_alignedNgIndex`, `_dcopBootAttempts`, `_buildTimeAlignment`, the buffering-hook anti-pattern. Adds `createSelfCompare`, `getSessionShape`, `getStepShape`, `getStepAtTime`. Fixes 18 `_alignedNgIndex.get` sites.

| §9 | File | Scope |
|----|------|-------|
| §9.2 | `src/solver/analog/__tests__/harness/compare.ts` | Drop `alignment?` param from `compareSnapshots`. Loop bound `Math.max`. Add asymmetric branch per §3.1. Push `presence: "both"` / `"oursOnly"` / `"ngspiceOnly"`. |
| §9.4 | `src/solver/analog/__tests__/harness/capture.ts` | Rename `hook` → `iterationHook` in return shape. Add `drainForLog(): IterationDetail[]` per §7.4. |
| §9.3 | `src/solver/analog/__tests__/harness/comparison-session.ts` | Delete `_dcopBootAttempts`, `_alignedNgIndex`, `_buildTimeAlignment`. Rewrite `init()` per §8.5 (master switch install, no buffer, boot step via sc.endStep). Rewrite `runDcOp()`/`runTransient()` to drop replay block and `_buildTimeAlignment` call. Rewrite `getStepEnd` to use direct index + `_stepPresence`. Replace all 18 `_alignedNgIndex.get(...)` sites with `this._ngSessionAligned()?.steps[stepIndex]` direct access. Rewrite `toJSON` to use `_stepPresence`. Add `_stepPresence(i)` / `_stepStartTimeDelta(i)` private helpers. Add public `getSessionShape`, `getStepShape`, `getStepAtTime`. Add `createSelfCompare` static factory + `initSelfCompare` + `selfCompare` option per §6.2. Gate ngspice bridge on `!selfCompare`. On selfCompare, deep-clone `_ourSession` → `_ngSession` + identity `_nodeMap`. Call `setCaptureHook(null)` at end of `runTransient` to release master switch. |

**Exit gate:**
- `npx tsc --noEmit` — zero errors in harness module. All 18 sites migrated, no stale `_alignedNgIndex` references, no `unaligned?` references outside of §9.17 UI code (Wave 5).
- `npm run test:q -- comparison-session` OR hand-run a single test that calls `createSelfCompare` + `getSessionShape` and verify shape is populated correctly for a known circuit.
- Spot-check: `_getComparisons()` no longer takes alignment, `compare.ts` loop bound is `max`, asymmetric branch emits sentinel rows with `iterationIndex: -1`.

### §12.5 Wave 4 — Test migrations (sonnet)

Mechanical test rewrites to align with the new API. No production code changes.

| §9 / §10 | File | Scope |
|----------|------|-------|
| §9.5, §10.2 | `src/solver/analog/__tests__/harness/query-methods.test.ts` | Delete `TestableComparisonSession` (`:91-109`) and `buildHwrSession` (`:114-146`). Replace all callers in tests 19-43 with `await ComparisonSession.createSelfCompare({ buildCircuit: () => makeHWR().circuit, analysis: "dcop" })`. Drop any references to `_alignedNgIndex` internals. |
| §10.3 | `src/solver/analog/__tests__/harness/query-methods.test.ts` | Delete test 30 (the `_comparisons` monkey-patch). Replace with a fixture-based test that produces divergences naturally (if the coverage matters) OR move pagination test to `compare.test.ts` if one exists. |
| §10.2 | Any `harness/*.test.ts` | Replace `unaligned: true` assertions with `presence: "oursOnly"` / `"ngspiceOnly"`. Drop `alignment` arg in `compareSnapshots` calls. |

**Exit gate:** `npm run test:q -- harness` — all harness tests pass except known-BJT failures. Tests 4, 5, 41, 54 from the current failure list should now pass because the index alignment and self-compare machinery handles their cases correctly.

### §12.6 Wave 5 — MCP + UI surfaces (sonnet harness-tools, haiku UI)

Surface-level wiring for the new data flows. Runs in parallel with Wave 4.

| §9 | File | Scope |
|----|------|-------|
| §9.14 | `scripts/mcp/harness-tools.ts` | Add new `"shape"` mode to `harness_query` that calls `getSessionShape()`. Update `getStepEnd` call sites (`:727, :854, :900`) to consume `presence` field. Surface `oursOnly`/`ngspiceOnly` in the tool response. Divergences with `category: "shape"` flow through existing pagination unchanged. Add `harness_get_step_at_time` tool OR fold into `harness_query` for §5. |
| §9.15 | `scripts/mcp/simulation-tools.ts` | `:415-465` `circuit_convergence_log` enable/disable: catch the new throw from facade's `setConvergenceLogEnabled`, surface a clear error to the MCP caller. |
| §9.16 | `src/io/postmessage-adapter.ts` | `:434, :438, :447` `setConvergenceLogEnabled` handlers: catch the throw, send `sim-error` reply with harness-conflict message. |
| §9.17 | `src/app/convergence-log-panel.ts` | `:249, :292, :363, :416-433` panel auto-enable/disable: wrap `setConvergenceLogEnabled(false)` in try/catch, surface UI notification when harness is active. |

**Exit gate:** `npm run test:q -- harness-tools` — MCP tests pass. Manual spot check: `harness_query { mode: "shape" }` returns a `SessionShape` object with `presenceCounts`, `steps`, `largeTimeDeltas`.

### §12.7 Wave 6 — New tests §10.4 (sonnet)

Write the coverage tests listed in §10.4. Runs in parallel with Waves 4-5. 

| Surface | Tests to add |
|---------|--------------|
| Headless | `getSessionShape` on 5-step self-compare, `getStepShape(0).stepStartTimeDelta === 0`, asymmetric-tail `presence: "ngspiceOnly"`, `getStepAtTime(0)`, `getStepAtTime(t > simTime) === null`, `setCaptureHook` flips all five flags atomically, `setConvergenceLogEnabled(false)` throws when bundle installed, `compile(c, { deferInitialize: true })` semantics, `coordinator.initialize()` idempotency |
| MCP | `harness_query { mode: "shape" }`, `harness_query { mode: "stepEnd", stepIndex }` returns `presence`, `circuit_convergence_log { action: "disable" }` while harness installed surfaces error |
| E2E | UI panel toggle-while-active conflict notification, UI panel `iterationDetails` for harness-enabled sessions (§7.4 contract) |

**Exit gate:** all §10.4 tests pass. Regression sweep per §10.6.

### §12.8 Regression sweep

After all waves complete:

1. `npm run test:q` — full vitest sweep. Target: 8219 → 8219 + N passing, 12 → 4 failures (only the known-BJT-convergence failures carry over).
2. `npm test -- harness` — focused harness module.
3. `npm run test:e2e -- convergence-log-panel` — UI conflict notification.
4. MCP end-to-end — all harness_* modes including new `"shape"` mode.

### §12.9 Carry-over from Round 3 (already landed)

These fixes from pre-implementation rounds are in the working tree and should not be re-done:

- **D1** `getDivergences` `withinTol` filter — filter `if (diff.withinTol) continue;` added at push sites in `comparison-session.ts:789-892`.
- **D3** `traceNode` composite label segment-match — new `_findNodeIdByLabel` helper at `:1629-1649`, NaN-safe `makeComparedValue` at `:81-93`, `traceNode` uses the helper at `:1153-1156`.
- **Cat A** `simTime` → `stepStartTime` rename in `compare.ts` and `query.ts`.
- **Cat B/C** `runDcOp` re-run path deleted, test 4/5 + MCP-4 filter tightened to `analysisPhase === "tranFloat"`.
- **Cat E minimal** `detailedConvergence = true` + `limitingCollector = []` in `comparison-session.ts:331-334` — this will be superseded by Wave 3's full master-switch wiring; leave the minimal wire in place until Wave 3 lands and delete it as part of `init()` rewrite.
- **Cat F** MCP handler serialization (`simTime` → `stepStartTime` rename at `harness-tools.ts:758, 869-870, 946`, `label.toUpperCase` fix at `:904-906`).
- **Round 3** MCP-7 NaN absDelta filter at `:753-754, :937`, MCP-12 `stepIndex/iteration` from args at `:524-525`, MCP-15 `delta` computed from `ours - ngspice` at `:1032`.
- **Stream-verif 9 and 17 deleted** (wrong premises, user-approved deletion).
- **MCP-5** `getConvergenceDetail()` fully populated at `comparison-session.ts:1482-1502`, test assertion updated at `harness-mcp-verification.test.ts:279`.

### §12.10 Vitest baseline entering Wave 1

12 failures (captured 2026-04-10 after Round 3 + cleanup):

| # | Test | Resolution wave |
|---|------|-----------------|
| 1-4 | BJT convergence (coordinator stagnation + buckbjt + buckbjt-mcp-surface) | Out of scope — known model divergence |
| 5 | query-methods 41 "matrix NaN self-compare" | Wave 3 (Goal F via index alignment + self-compare clone) |
| 6 | query-methods 54 "traceNode self-compare 6 iters" | Wave 3 (same mechanism) |
| 7 | stream-verif 4 "ag0 on tranFloat" | Wave 3 (if `analysisPhase` classification is correct after boot-step rewrite) or flag as investigation |
| 8 | stream-verif 5 "trapezoidal on tranFloat" | Wave 3 same |
| 9 | MCP-4 "integration coefficients on tranFloat" | Wave 3 same |
| 10 | MCP-5 "convergence detail per-element" | Already fixed in Round 3 cleanup — verify it passes at Wave 3 exit |

Items 7-9 may share a root cause: if the capture hook isn't classifying post-boot steps as `"tranFloat"`, the Cat B+C test filter catches nothing. Wave 3's `init()` rewrite should surface this during implementation. If it persists after Wave 3, it's a capture-hook classification bug that needs a follow-up.

---

## Appendix A. File:line citation index

Every claim in this spec maps to at least one of these citations.

### Harness module
- `src/solver/analog/__tests__/harness/comparison-session.ts:11` — "Unaligned steps report unaligned:true; no raw-index fallback" — the §7 comment being repealed.
- `:240` — `_dcopBootAttempts` field (deleted by Goal E).
- `:247-248` — `_ngSession`/`_ngSessionReindexed` (kept).
- `:251` — `_alignedNgIndex` field (deleted by Goal A).
- `:295-371` — `init()` body (rewritten per §8.5).
- `:308-322` — buffering hook closure (deleted).
- `:325` — `setCaptureHook(bufferingHook)` early install (rewritten as bundle install AFTER topology build).
- `:328` — `compile(circuit)` call (gains `{ deferInitialize: true }`).
- `:332-334` — manual `detailedConvergence`/`limitingCollector` flags (deleted; subsumed by master switch).
- `:347-356` — `_dcopBootAttempts` populate loop (deleted).
- `:386-443` — `runDcOp()` body (rewritten).
- `:391-396` — boot-attempts guard (deleted).
- `:402-414` — boot replay block (deleted).
- `:442` — `_buildTimeAlignment()` call (deleted).
- `:452-547` — `runTransient()` body (rewritten).
- `:466-474` — second-time hook rewiring (deleted; bundle persists).
- `:478-482` — DCOP replay-into-step-0 (deleted).
- `:546` — `_buildTimeAlignment()` call (deleted).
- `:557-630` — `getStepEnd` body (rewritten to use direct index + `presence`).
- `:564, :642, :937, :981, :1024, :1062, :1108, :1172, :1303, :1355, :1382, :1410, :1474` — 18 `_alignedNgIndex.get(...)` sites (rewritten to direct index).
- `:1505-1534` — `toJSON` (rewritten to use `_stepPresence`).
- `:1522` — `unaligned: !this._alignedNgIndex.has(i)` (rewritten as `presence: this._stepPresence(i)`).
- `:1540-1547` — `dispose()` (drop `_alignedNgIndex.clear()`).
- `:1583-1611` — `_buildTimeAlignment()` (deleted entirely).
- `:1614-1616` — `_ngSessionAligned()` helper (kept).
- `:1618-1626` — `_getComparisons()` (drop alignment arg).
- `:1640-1644` — `_findNodeIdByLabel` segment-match (D3 fix is owned by other agent, no edit here).

### compare.ts
- `src/solver/analog/__tests__/harness/compare.ts:41-46` — `compareSnapshots` signature (drop alignment param).
- `:48` — loop bound (max instead of ours.length).
- `:50` — outer loop start.
- `:52-54` — alignment redirection (deleted).
- `:104-111` — matrix diff loop (kept; the asymmetric-side matrix entries no longer trigger NaN because both sides come from the same session in self-compare and from an index-paired ngspice in real runs).
- `:181-190` — result push (add `presence`).

### capture.ts
- `src/solver/analog/__tests__/harness/capture.ts:294-429` — `createStepCaptureHook`.
- `:299-313` — return shape (`hook` → `iterationHook` rename).
- `:319-323` — `currentStepStartTime` cursor (kept).
- `:325-345` — `beginAttempt` body (kept).
- `:347-367` — `endAttempt` body (kept; gains `iterationDetails` drain at the new contract site in analog-engine).
- `:372-414` — `endStep` body (kept).

### types.ts
- `src/solver/analog/__tests__/harness/types.ts:295-301` — `QueryFilters` (kept).
- `:308-319` — `StepEndReport` (replace `unaligned?` with `presence`).
- `:315` — first `unaligned?` site.
- `:376-391` — `SessionSummary` (add `presenceCounts`, `worstStepStartTimeDelta`).
- `:523` — `DivergenceCategory` (add `"shape"`).
- `:525-538` — `DivergenceEntry` (add `presence`).
- `:738` — second `unaligned?` site.

### query-methods.test.ts
- `src/solver/analog/__tests__/harness/query-methods.test.ts:58-71` — `makeHWR()` (kept; reused via `buildCircuit` callback).
- `:91-109` — `TestableComparisonSession` (deleted).
- `:114-146` — `buildHwrSession()` (deleted).
- `:142` — `dtsPath: "fixtures/buckbjt.dts"` lie (eliminated when `dtsPath` becomes optional).
- `:583` — D2 NaN site (Goal F: subsumed by Goal A index alignment).

### default-facade.ts
- `src/headless/default-facade.ts:118-120` — `setCaptureHook` (signature change).
- `:122-134` — `compile()` (gains `opts.deferInitialize`).
- `:129` — coordinator construction (drops captureHook parameter).
- `:393-405` — convergence-log methods (gain throw-when-installed contract).

### coordinator.ts
- `src/solver/coordinator.ts:78` — `_cachedDcOpResult` field.
- `:85` — `_analysisPhase` field.
- `:87-146` — constructor (DCOP call removed; capture hook param removed).
- `:113-122` — analog engine setup block (DCOP moved out).
- `:121` — `engine.dcOperatingPoint()` (moved into `initialize()`).
- `:382-384` — `setConvergenceLogEnabled` (gains throw).

### convergence-log.ts
- `src/solver/analog/convergence-log.ts:20-47` — `NRAttemptRecord` shape (the `iterationDetails` doc lock-down site).
- `:36-46` — the comment turned into a contract.
- `:96` — `enabled: boolean` (touched by master switch).

### MCP & UI surfaces
- `scripts/mcp/harness-tools.ts:401, :727, :753, :854, :900, :934` — `harness_query` and the four downstream calls.
- `scripts/mcp/simulation-tools.ts:415-465` — `circuit_convergence_log` (gains harness-conflict error path).
- `src/io/postmessage-adapter.ts:434, :438, :447` — convergence-log handlers (gain harness-conflict error path).
- `src/app/convergence-log-panel.ts:249, :292, :363, :416-433` — UI auto-enable / disable (gains conflict notification).

### Engine (master-switch consumers)
- `src/solver/analog/analog-engine.ts:343-478` — `step()` retry loop with phase hook calls.
- `:385-387` — NR call site that consumes `postIterationHook`/`detailedConvergence`/`limitingCollector`.
- `:400-408` — `stepRec.attempts.push` branch (gains `iterationDetails` drain).
- `:676-687` — `dcOperatingPoint()` mirror.
- `:912-938` — public hook fields.
- `src/solver/analog/dc-operating-point.ts:90-97` — `DcOpOptions` (already wired).
- `:215, :221, :419, :431, :470, :484, :492, :547, :559, :563, :570, :578, :617, :628, :634, :645, :648, :659, :675, :685, :706` — phase callback fire sites (no edits).
- `src/solver/analog/newton-raphson.ts:518-557` — `convergenceFailedElements` collection (gated on `detailedConvergence`).

### Coordinator interface
- `src/solver/coordinator-types.ts:120-145` — interface (gains `applyCaptureHook`, `initialize`).
- `src/solver/null-coordinator.ts:109-110` — no-op stubs.
- `src/test-utils/mock-coordinator.ts:91-92` — no-op stubs.

---

## Appendix B. Glossary

- **Step.** A single advance of the simulation by `dt` seconds. Begins with one or more NR attempts; ends when an attempt is accepted.
- **Attempt.** One Newton-Raphson solve at a chosen `dt`. Has a `phase` (e.g. `tranNR`, `dcopGminDynamic`), an `outcome` (`accepted`, `nrFailedRetry`, etc.), and a list of iterations.
- **Iteration.** One linearized solve of the MNA system inside an NR attempt.
- **Phase.** The role of an attempt within the engine's step strategy. Distinguishes initial NR from retries from DCOP sub-solves.
- **Boot step.** The synthetic `stepStartTime === stepEndTime === 0` step that groups DCOP attempts (and, in transient mode, the first `tranInit`) into the harness's step 0.
- **Capture hook.** The bundle (`PhaseAwareCaptureHook`) that the harness installs on the engine to intercept iteration data, attempt boundaries, per-element convergence, and limiting events. Master switch.
- **Self-compare.** A `ComparisonSession` mode where the ngspice side is a deep clone of our side. Used for fast unit testing of the harness's query/shape APIs without invoking ngspice. Bit-identical pairing makes Goal F mechanically true.
- **Presence.** The `SidePresence` axis for a step or divergence: `"both"` (paired), `"oursOnly"` (we ran a step ngspice did not), `"ngspiceOnly"` (ngspice ran a step we did not). Disjoint from `Side` (the `getStepAtTime` selector).
- **Index pairing.** The Goal A rule that `oursSteps[i]` is compared to `ngSteps[i]`, with no time-based remapping. The replacement for the `_alignedNgIndex` map.
- **Time delta.** `oursSteps[i].stepStartTime - ngSteps[i].stepStartTime`. A reported datum, not a defect; large deltas appear in `SessionShape.largeTimeDeltas`.

---

*End of spec.*
