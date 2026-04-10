# Wave 3 — comparison-session bulk rewrite + compare.ts + capture.ts

> Source: `docs/harness-redesign-spec.md` §3, §4, §5, §6, §8.5, §9.2, §9.3, §9.4, §12.4.
> Wave dependency: Wave 1 (types), Wave 2 (coordinator master switch + deferred initialize).
> Sizing: sonnet (largest single block of work in the redesign).
> Goals implemented: A (index pairing), B (shape reporting), C (test helper redesign), F (D2 subsumed by Goal A).
> Exit gate: see bottom of file.

## Tasks in this wave

| ID | Title | Files | Complexity |
|----|-------|-------|------------|
| W3.T1 | `compare.ts`: drop alignment, switch to index pairing, add asymmetric branch | `src/solver/analog/__tests__/harness/compare.ts` | M |
| W3.T2 | `capture.ts`: rename `hook` → `iterationHook`, add `drainForLog()` | `src/solver/analog/__tests__/harness/capture.ts` | S |
| W3.T3 | `comparison-session.ts`: bulk rewrite — delete buffers, rewrite `init`/`runDcOp`/`runTransient`/`getStepEnd`, replace 18 `_alignedNgIndex.get` sites, add shape APIs, add self-compare | `src/solver/analog/__tests__/harness/comparison-session.ts` | XL |

These three tasks are tightly interleaved: comparison-session.ts depends on the new `compareSnapshots` signature (T1) and the renamed `iterationHook` (T2). Implement T1 and T2 first, then T3. Although they are listed as separate IDs, a single implementer should complete all three sequentially because their changes touch a shared compile graph.

---

## W3.T1 — `src/solver/analog/__tests__/harness/compare.ts`

### Drop the `alignment?` parameter from `compareSnapshots` at `:41-46`

Old signature:
```ts
export function compareSnapshots(
  ours: CaptureSession,
  ref:  CaptureSession,
  tolerance: Tolerance = DEFAULT_TOLERANCE,
  alignment?: Map<number, number>,
): ComparisonResult[]
```

New signature:
```ts
export function compareSnapshots(
  ours: CaptureSession,
  ref:  CaptureSession,
  tolerance: Tolerance = DEFAULT_TOLERANCE,
): ComparisonResult[]
```

### Rewrite the loop body per §3.1

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
      // Preserve every existing per-iteration diff loop body — only the
      // outer pairing logic changes. The diff body is data-shape agnostic.
      results.push({
        stepIndex: si,
        iterationIndex: ii,
        stepStartTime: ourStep.stepStartTime,
        presence: "both",
        voltageDiffs, rhsDiffs, matrixDiffs, stateDiffs,
        allWithinTol,
      });
    }
  }

  return results;
}
```

Key changes from current `compare.ts:41-194`:
1. Loop bound was `ours.steps.length` (`compare.ts:48`); now `Math.max(ours.steps.length, ref.steps.length)`.
2. The `alignment.get(si) ?? si` lookup at `compare.ts:52` is gone — `refStep` is just `ref.steps[si]`.
3. Asymmetric steps emit a single sentinel `ComparisonResult` with `iterationIndex: -1` and `presence` set, so divergence reports can pick them up.
4. The `allWithinTol` for sentinel rows is **always false** — an unmatched step is a shape divergence.
5. **The inner per-iteration diff loops at `:104-111` (matrix), `:118-130` (rhs), `:136-153` (voltage), `:160-180` (state) are NOT modified — only the outer step-pairing changes.** Preserve every existing comparison detail.

### Acceptance (W3.T1)

- `compareSnapshots` no longer takes `alignment` parameter.
- Loop bound is `max` of two step counts.
- Asymmetric branch emits one sentinel `ComparisonResult` per missing step with `iterationIndex: -1` and `presence: "oursOnly" | "ngspiceOnly"`.
- Symmetric branch pushes results with `presence: "both"`.
- All existing per-iteration diff loop bodies are preserved verbatim; only the outer pairing changes.
- `npx tsc --noEmit` — file compiles. Consumer (`comparison-session.ts`) will be fixed in T3.

---

## W3.T2 — `src/solver/analog/__tests__/harness/capture.ts`

### Rename `hook` → `iterationHook` at `:299-313`

The `createStepCaptureHook` factory currently returns an object whose `hook` field is the per-iteration hook. Rename that field to `iterationHook` to match `PhaseAwareCaptureHook.iterationHook`.

```ts
return {
  iterationHook,            // renamed from `hook`
  beginAttempt,
  endAttempt,
  endStep,
  setStepStartTime,
  getSteps,
  // ... whatever else is currently returned, unchanged
};
```

Update all call sites. Within Wave 3 the call sites are in `comparison-session.ts` (T3); outside Wave 3, the call sites are in `query-methods.test.ts` which Wave 4 will rewrite. Use Grep on `\.hook\b` and `createStepCaptureHook` within the harness directory to find every site, then update those that come from a `createStepCaptureHook` return value to `.iterationHook`.

### Add `drainForLog()` method per §7.4

Inside `createStepCaptureHook`, the inner per-iteration capture object needs a new method:

```ts
drainForLog(): IterationDetail[] {
  const drained = this._iterationDetailBuffer.slice();
  this._iterationDetailBuffer.length = 0;
  return drained;
}
```

The implementation depends on how the capture currently buffers per-iteration data. Find the existing `_iterationBuffer` / `currentAttemptIterations` array (search for `iterations` / `iteration` field on the capture state) and write `drainForLog` to:
1. Snapshot the buffer in the shape `IterationDetail` requires.
2. Empty the buffer (so the next attempt starts clean).
3. Return the snapshot.

`IterationDetail` is defined in `convergence-log.ts` — import it. The shape per the spec (§7.4):
```ts
{ iteration, maxDelta, maxDeltaNode, noncon, converged }
```

If those fields are not currently captured, you'll need to extend the per-iteration capture to record them. Look at what `postIterationHook` already receives — it likely has `iteration`, `maxDelta`, `maxDeltaNode`, `noncon`, `converged` in its callback signature. Pull those from the hook and stash into the buffer.

### Wire `drainForLog` so the engine can find it

Per §7.4 / Wave 2 W2.T3, the engine drain code calls `drainForLog()` on the `postIterationHook` (treating the hook as having an attached `drainForLog`). The cleanest way:

- Make `drainForLog` a method on the same object that's installed as `engine.postIterationHook`. The function-style hook can be wrapped in a method-bearing object: `Object.assign(hookFn, { drainForLog })`.
- OR expose `drainForLog` on the capture state and have the engine call it via a side channel — but that requires more wiring.

Recommended pattern:

```ts
const iterationHookFn: PostIterationHook = (...args) => { /* existing body */ };
const iterationHook = Object.assign(iterationHookFn, {
  drainForLog,
});
```

Then `engine.postIterationHook.drainForLog?.()` works at the Wave 2 call site.

### Acceptance (W3.T2)

- The `createStepCaptureHook` return shape exposes `iterationHook` (not `hook`).
- `iterationHook.drainForLog()` returns a snapshot of the current attempt's per-iteration buffer and resets the buffer.
- `IterationDetail` is the correct return type, imported from `convergence-log.ts`.
- All in-harness call sites of `.hook` from this factory are updated to `.iterationHook`.
- `npx tsc --noEmit` — file compiles.

---

## W3.T3 — `src/solver/analog/__tests__/harness/comparison-session.ts`

This is the bulk of the wave. The file is currently ~1700 lines; the rewrite touches roughly 25 distinct sites. Work in this order:

### 1. Delete dead state

- `:240` delete `protected _dcopBootAttempts: Array<...>` field. Find any other references in the same class and remove them.
- `:251` delete `protected _alignedNgIndex: Map<number, number>` field.
- `:1583-1611` delete `_buildTimeAlignment()` method ENTIRELY.
- `:1540-1547` `dispose()`: remove `_alignedNgIndex.clear()` line and `_dcopBootAttempts.length = 0` line if present.

### 2. Add new private helpers per §3.4

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

`_ngSessionAligned()` already exists at `:1614-1616`; keep using it.

### 3. Add public shape API per §4.3, §4.4

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

The exact field names on `StepSnapshot` (`attempts`, `integrationCoefficients`, etc.) must match what the codebase already uses — read the actual `StepSnapshot` shape from `capture.ts` or `types.ts` and adjust accordingly. Do not invent fields.

### 4. Add `getStepAtTime` per §5

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

### 5. Rewrite `init()` per §8.5

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

  // Build labels + topology BEFORE creating the capture hook.
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

  // Build the PhaseAwareCaptureHook bundle.
  const sc = this._stepCapture;
  const bundle: PhaseAwareCaptureHook = {
    iterationHook: sc.iterationHook,
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
  if (this._opts.cirPath) {
    const cirRaw = readFileSync(resolvePath(this._opts.cirPath), "utf-8");
    this._cirClean = stripControlBlock(cirRaw);
  } else if (this._engine) {
    this._cirClean = generateSpiceNetlist(compiled, this._elementLabels);
  }
}
```

The exact helper names (`buildElementLabelMap`, `captureTopology`, `_zeroDcopCoefficients`, `stripControlBlock`, `generateSpiceNetlist`) must match what already exists in the file or its imports. Read the current `init()` body and reuse what's there.

**`_zeroDcopCoefficients` may not exist** — the boot step needs an integration coefficients object that represents "no integration yet" (DCOP). Look at how the current `_dcopBootAttempts` replay logic builds the boot step's coefficients, and reuse that construction. If it inlined the object literal, do the same.

### 6. Rewrite `runDcOp()` per §9.3, §12.4

The current `runDcOp()` at `:386-443`:
- Has a `_dcopBootAttempts.length === 0` guard at `:391-396` — DELETE.
- Has a replay block at `:402-414` that pumps `_dcopBootAttempts` into `_stepCapture` — DELETE. The boot step is already in `_stepCapture` from `init()`.
- Has a `_buildTimeAlignment()` call at `:442` — DELETE.
- Keeps the ngspice block — KEEP, but gate it on `!this._opts.selfCompare`.

Rewritten body:
```ts
async runDcOp(): Promise<void> {
  this._ensureInited();
  if (this._hasRun) return;

  // Boot step is already in _stepCapture from init().
  // Snapshot it as our session.
  this._ourSession = {
    topology: { ...this._ourTopology, source: "ours" },
    steps: this._stepCapture.getSteps(),
  };

  // Run ngspice side (skip in self-compare mode).
  if (!this._opts.selfCompare && this._cirClean) {
    // ... existing ngspice bridge invocation, unchanged ...
    this._ngSession = /* result */;
    this._ngSessionReindexed = await reindexNgsessionToOurs(/* ... */);
  } else if (this._opts.selfCompare) {
    // Self-compare: deep clone, identity node map.
    this._ngSession = deepCloneSession(this._ourSession, "ngspice");
    this._ngSessionReindexed = this._ngSession;
    this._nodeMap = buildIdentityNodeMap(this._ourSession);
  }

  this._hasRun = true;
  this._analysis = "dcop";
}
```

`deepCloneSession` and `buildIdentityNodeMap` are new helpers — see "Self-compare helpers" below. The exact names of `_ourTopology`, `_stepCapture.getSteps()`, the ngspice bridge call, and `reindexNgsessionToOurs` must match the current source.

### 7. Rewrite `runTransient()` per §9.3, §12.4

Current `runTransient()` at `:452-547`:
- Has hook rewiring at `:466-474` — DELETE. The bundle is already installed in `init()`.
- Has a DCOP-replay-into-step-0 block at `:478-482` — DELETE. Boot step is in `_stepCapture`.
- Has a `_buildTimeAlignment()` call at `:546` — DELETE.
- Has the per-step `coordinator.step()` loop — KEEP.
- Add at the END: `this._facade.setCaptureHook(null);` — releases the master switch.
- Gate the ngspice block on `!this._opts.selfCompare`; in self-compare mode, deep-clone after the our-side run.

```ts
async runTransient(t0: number, tStop: number, maxStep?: number): Promise<void> {
  this._ensureInited();
  if (this._hasRun) return;

  // Per-step loop on our side.
  while (currentT < tStop) {
    this._coordinator.step(/* ... */);
    // _stepCapture is already wired via the master-switch bundle.
  }

  this._ourSession = {
    topology: { ...this._ourTopology, source: "ours" },
    steps: this._stepCapture.getSteps(),
  };

  // Ngspice side (skip in self-compare).
  if (!this._opts.selfCompare && this._cirClean) {
    // ... existing ngspice transient run ...
  } else if (this._opts.selfCompare) {
    this._ngSession = deepCloneSession(this._ourSession, "ngspice");
    this._ngSessionReindexed = this._ngSession;
    this._nodeMap = buildIdentityNodeMap(this._ourSession);
  }

  // Release the master switch.
  this._facade.setCaptureHook(null);

  this._hasRun = true;
  this._analysis = "tran";
}
```

### 8. Rewrite `getStepEnd` at `:557-630`

Replace `_alignedNgIndex.get(stepIndex)` lookup with `this._ngSessionAligned()?.steps[stepIndex]`. Compute `presence` via `_stepPresence(stepIndex)`. The method now sets `presence` on the returned `StepEndReport` instead of `unaligned?: true`.

When `presence === "oursOnly"` or `"ngspiceOnly"`, the method still returns a report — but the side that's missing has `null` or sentinel values (matching the old `unaligned` behavior). Read the current body to see how it currently fills the report when alignment was missing, and translate that pattern to the new presence enum.

### 9. Replace 18 `_alignedNgIndex.get(...)` sites

Per §9.3 the sites are at:
`:564, :642, :937, :981, :1024, :1062, :1108, :1172, :1303, :1355, :1382, :1410, :1474`

Use Grep on `_alignedNgIndex` in `comparison-session.ts` to enumerate all current uses. For each site, replace:

```ts
const ngIdx = this._alignedNgIndex.get(stepIndex);
const ngStep = ngIdx !== undefined ? this._ngSessionAligned()!.steps[ngIdx] : undefined;
```

with:

```ts
const ngStep = this._ngSessionAligned()?.steps[stepIndex];
```

`undefined` is now the asymmetric signal — no fallback, no remapping. Where the old code branched on `ngIdx === undefined`, branch on `ngStep === undefined` instead. Where it computed presence via the map's `has()`, call `this._stepPresence(stepIndex)` instead.

### 10. Rewrite `toJSON` at `:1505-1534`

Replace `unaligned: !this._alignedNgIndex.has(i)` with `presence: this._stepPresence(i)`. The step list portion of the JSON should pull from `getSessionShape().steps` instead of being inline-built — that keeps the JSON shape consistent with the public API.

### 11. Rewrite `_getComparisons()` at `:1618-1626`

Drop the alignment argument from the `compareSnapshots(...)` call. New body:

```ts
private _getComparisons(): ComparisonResult[] {
  if (!this._ourSession || !this._ngSessionReindexed) return [];
  return compareSnapshots(this._ourSession, this._ngSessionReindexed, this._tol);
}
```

### 12. Add shape divergences to `getDivergences` per §4.5

The existing `getDivergences` builds a `DivergenceEntry[]` from `_getComparisons()`. After producing the value-diff entries, walk `getSessionShape().steps` and emit a synthetic `DivergenceEntry` with `category: "shape"`, `iteration: -1`, and the appropriate `presence` for any step where:
- `presence !== "both"`, OR
- `attemptCounts.ours.total !== attemptCounts.ngspice.total`, OR
- the accepted-attempt `phase` differs between sides, OR
- the accepted-attempt `outcome` differs between sides.

`absDelta` for shape divergences = `|attemptCounts.ours.total - attemptCounts.ngspice.total|` (or 0 for phase/outcome mismatches with equal counts). `withinTol` is always `false` for shape divergences. `relDelta` can be 0 — these are categorical, not numeric.

The shape entries should appear AFTER the value entries in the returned array (so existing tests that index value diffs first still work) — OR document the position change in `progress.md` for the wave-verifier.

### 13. Add `selfCompare` option

In `ComparisonSessionOptions`:
```ts
export interface ComparisonSessionOptions {
  dtsPath?: string;          // now optional — see §6.2
  cirPath?: string;
  tolerance?: Partial<Tolerance>;
  selfCompare?: boolean;     // NEW
  // ... existing fields
}
```

`dtsPath` becomes optional (per §6.2 / Q8). When `selfCompare === true` and `buildCircuit` is supplied via the static factory (next), the constructor doesn't read any `.dts` file.

### 14. Add `createSelfCompare` static factory per §6.2

```ts
static async createSelfCompare(opts: {
  dtsPath?: string;
  buildCircuit?: (registry: ComponentRegistry) => Circuit;
  analysis: "dcop" | "tran";
  tStop?: number;
  maxStep?: number;
  tolerance?: Partial<Tolerance>;
}): Promise<ComparisonSession> {
  const session = new ComparisonSession({
    dtsPath: opts.dtsPath ?? "<inline>",
    tolerance: opts.tolerance,
    selfCompare: true,
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

### 15. Add `initSelfCompare` private method

A variant of `init()` that:
- Skips `cirPath` parsing (no ngspice side).
- Optionally calls `opts.buildCircuit(registry)` instead of reading the `.dts` file.
- Otherwise mirrors `init()` exactly: master-switch install, boot step, etc.

Implementation: factor out the shared body of `init()` into a private helper, then `init` and `initSelfCompare` both call it with different "load circuit" steps.

```ts
private async initSelfCompare(buildCircuit?: (registry: ComponentRegistry) => Circuit): Promise<void> {
  const registry = createDefaultRegistry();
  this._facade = new DefaultSimulatorFacade(registry);

  const circuit = buildCircuit
    ? buildCircuit(registry)
    : this._facade.deserialize(readFileSync(resolvePath(this._opts.dtsPath!), "utf-8"));

  // ... rest mirrors init() body — extract to a shared helper if cleanest ...
}
```

### 16. Self-compare helpers

```ts
function deepCloneSession(src: CaptureSession, newSource: "ours" | "ngspice"): CaptureSession {
  // structuredClone if available, else JSON round-trip for plain-data fields.
  const cloned = structuredClone(src);
  cloned.topology = { ...cloned.topology, source: newSource };
  return cloned;
}

function buildIdentityNodeMap(session: CaptureSession): NodeMap {
  // Identity: { ourIndex: i, ngspiceIndex: i } for each node in the topology.
  // Look at the existing _nodeMap shape to match it exactly.
}
```

### 17. Update `dispose()` at `:1540-1547`

Drop the `_alignedNgIndex.clear()` call. If `_dcopBootAttempts.length = 0` is also there, drop that too.

### Acceptance (W3.T3)

- `_alignedNgIndex` field is gone; zero references in the file.
- `_dcopBootAttempts` field is gone; zero references in the file.
- `_buildTimeAlignment()` method is gone.
- All 18 `_alignedNgIndex.get(...)` sites are migrated to direct `[stepIndex]` access on `_ngSessionAligned()?.steps`.
- New methods: `getSessionShape()`, `getStepShape(i)`, `getStepAtTime(t, side)`, `_stepPresence(i)`, `_stepStartTimeDelta(i)`, `initSelfCompare(buildCircuit?)`, `createSelfCompare(opts)` (static).
- `init()` rewritten per §8.5 — boot step is built directly into `_stepCapture`, no buffer.
- `runDcOp()` and `runTransient()` rewritten — no replay blocks, no second hook install, master switch released at end of `runTransient`.
- `getStepEnd` uses direct index + `presence`.
- `getDivergences` emits shape divergences.
- `toJSON` uses `_stepPresence`.
- `dispose()` drops `_alignedNgIndex.clear()`.
- `compareSnapshots` is called WITHOUT the alignment argument.

---

## Wave 3 exit checklist

- [ ] `npx tsc --noEmit` — entire codebase compiles. Zero errors in harness module. Zero stale `_alignedNgIndex` or `_dcopBootAttempts` references. Zero `unaligned?` references in harness production code (Wave 4 cleans up tests; Wave 5 cleans up UI).
- [ ] `npm run test:q -- comparison-session` — at least the smoke path works. Tests that monkey-patched internals (query-methods.test.ts test 30) will still fail; those are Wave 4's problem.
- [ ] `npm run test:q -- harness` — query-methods.test.ts tests 41 and 54 (matrix NaN, traceNode 6 iters) should now pass via Goal F (subsumed by Goal A index alignment + self-compare clone).
- [ ] Spot check: `_getComparisons()` call to `compareSnapshots` no longer passes `_alignedNgIndex`.
- [ ] Spot check: `compare.ts` loop bound is `Math.max`, asymmetric branch emits sentinel rows with `iterationIndex: -1`.
- [ ] `setCaptureHook(null)` is called at the end of `runTransient()` (and `runDcOp()`, if appropriate — verify by reading the spec and choosing consistent semantics).
- [ ] The boot step appears as `_stepCapture.getSteps()[0]` after `init()` completes — proven by an inline assertion or a focused test.

## Hard rules

- Read `CLAUDE.md` for non-negotiable rules.
- Read `spec/test-baseline.md` BEFORE investigating any test failure — the listed failures are pre-existing and out of scope.
- Do not touch any file outside the three listed in this wave's task table. Wave 4 owns test files. Wave 5 owns MCP/UI surfaces.
- The 18 `_alignedNgIndex.get` sites are not optional — every single one must be migrated. Use Grep to confirm zero remain.
- Self-compare is a new mode, not a "test-only" backdoor. Do not implement it as a flag that subclasses or monkey-patches the main session — it must flow through the same `init()` / `runDcOp()` / `runTransient()` codepath as a real ngspice run, gated only by `!this._opts.selfCompare` on the ngspice block.
