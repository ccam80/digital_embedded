# Wave 1 — Foundational Types and Interface Stubs

> Source: `docs/harness-redesign-spec.md` §2, §9.1, §9.8, §9.9, §9.12, §11.1, §12.2.
> Wave dependency: none — this is the first wave.
> Sizing: haiku (purely additive type and interface work).
> Exit gate: `npx tsc --noEmit` — additive edits compile cleanly. Wave 1 is permitted to leave downstream typecheck temporarily broken if Wave 3 will fix it; in particular, replacing `unaligned?` with `presence` in `StepEndReport` and `ToJSONOpts` is a TYPE-BREAKING rename that Wave 3's `comparison-session.ts` rewrite will reconcile. Wave 1 must STILL perform that rename — Wave 2's coordinator code references the new field shapes.

## Tasks in this wave

| ID | Title | Files | Complexity |
|----|-------|-------|------------|
| W1.T1 | Add new harness types and modify existing ones | `src/solver/analog/__tests__/harness/types.ts` | M |
| W1.T2 | Extend coordinator interface with `applyCaptureHook` and `initialize` | `src/solver/coordinator-types.ts` | S |
| W1.T3 | Add no-op stubs to null-coordinator and mock-coordinator | `src/solver/null-coordinator.ts`, `src/test-utils/mock-coordinator.ts` | S |
| W1.T4 | Lock down `iterationDetails` doc comment as a contract | `src/solver/analog/convergence-log.ts` | S |

---

## W1.T1 — `src/solver/analog/__tests__/harness/types.ts`

### New types to add (per §2.1, §2.4)

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

/** Bundle of all instrumentation hooks the comparison harness needs. */
export interface PhaseAwareCaptureHook {
  /** Per-NR-iteration hook (fires inside newton-raphson.ts loop). */
  iterationHook: PostIterationHook;
  /** Phase begin/end hook (fires from analog-engine and dc-operating-point). */
  phaseHook: MNAEngine["stepPhaseHook"];
}
```

If `PostIterationHook` or `MNAEngine` aren't already imported in `types.ts`, add the imports from their canonical sites — do not duplicate-define them. Look at the existing top-of-file imports and follow that style.

### Modifications to existing types

```ts
// types.ts:308-319 — StepEndReport
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

// types.ts:523 — DivergenceCategory
export type DivergenceCategory = "voltage" | "state" | "rhs" | "matrix" | "shape";

// types.ts:525-538 — DivergenceEntry
export interface DivergenceEntry {
  stepIndex: number;
  iteration: number;                 // -1 for shape divergences
  stepStartTime: number;
  category: DivergenceCategory;
  label: string;
  ours: number;
  ngspice: number;
  absDelta: number;
  relDelta: number;
  withinTol: boolean;
  componentLabel: string | null;
  slotName: string | null;
  presence: SidePresence;            // NEW
}

// types.ts:376-391 — SessionSummary additions
export interface SessionSummary {
  analysis: "dcop" | "tran";
  stepCount: ComparedValue;          // already there
  presenceCounts: { both: number; oursOnly: number; ngspiceOnly: number };  // NEW
  worstStepStartTimeDelta: number;   // NEW — max abs delta across paired steps
  // ... rest unchanged — preserve every other field as-is
}
```

### Tolerance addition (per §4.6)

```ts
/** Maximum acceptable |stepStartTime_ours - stepStartTime_ngspice| in seconds. */
timeDeltaTol: number;   // default 1e-12
```

Add `timeDeltaTol` to the `Tolerance` interface AND to `DEFAULT_TOLERANCE` with value `1e-12`.

### `ComparisonResult` extension (per §3.2)

Find the `ComparisonResult` interface (search for `ComparisonResult` — likely earlier in this file) and add:

```ts
export interface ComparisonResult {
  stepIndex: number;
  iterationIndex: number;          // -1 for shape sentinel rows (Wave 3 will populate)
  stepStartTime: number;
  presence: SidePresence;          // NEW
  voltageDiffs: VoltageDiff[];
  rhsDiffs: RhsDiff[];
  matrixDiffs: MatrixDiff[];
  stateDiffs: StateDiff[];
  allWithinTol: boolean;
}
```

### Removing `unaligned?` (TWO sites — per §9.1)

- Site 1: `StepEndReport` at `:315` — already covered in the modification above.
- Site 2: `:738` — find the second `unaligned?` site (likely in `ToJSONOpts` or a sibling type). Replace with `presence: SidePresence`.

Use Grep on `unaligned\?` in `types.ts` to confirm both sites are caught. Both must be replaced; neither remains.

### Acceptance (W1.T1)

- `npx tsc --noEmit src/solver/analog/__tests__/harness/types.ts` — file itself parses cleanly (the file may import other harness files that won't compile until Wave 3, but the types.ts module's own declarations must be valid TypeScript).
- All eight new exports (`SidePresence`, `Side`, `AttemptSummary`, `AttemptCounts`, `StepShape`, `SessionShape`, `PhaseAwareCaptureHook`, plus the modified shapes) are visible from this module.
- Zero remaining `unaligned?` references in `types.ts`.
- `Tolerance.timeDeltaTol` exists; `DEFAULT_TOLERANCE.timeDeltaTol === 1e-12`.

---

## W1.T2 — `src/solver/coordinator-types.ts`

### Add to interface at `:120-145` (per §9.8)

```ts
/** Apply a phase-aware capture hook (master switch). Pass null to clear. */
applyCaptureHook(bundle: PhaseAwareCaptureHook | null): void;

/** Run the deferred initialization (DCOP for analog backends). Idempotent. */
initialize(): void;
```

Import `PhaseAwareCaptureHook` from `src/solver/analog/__tests__/harness/types.ts`. If a circular-import warning surfaces (test code into production code), declare a structural alias inline at the top of `coordinator-types.ts` instead:

```ts
// Structural alias to avoid pulling test types into production module.
export interface PhaseAwareCaptureHookLike {
  iterationHook: unknown;
  phaseHook: unknown;
}
```

…and use the `Like` alias in the interface signature. Wave 2 will tighten the alias to the real type if needed. Choose the import path first; only fall back to the structural alias if the real import causes a circular dep.

### Acceptance (W1.T2)

- `coordinator-types.ts` declares both methods on the coordinator interface.
- `npx tsc --noEmit` — interface declaration compiles.
- Existing implementations of the interface (next task) must compile against the new shape.

---

## W1.T3 — `src/solver/null-coordinator.ts` and `src/test-utils/mock-coordinator.ts`

### Add no-op stubs (per §9.9, §8.7)

In `src/solver/null-coordinator.ts` near `:109-110`:

```ts
applyCaptureHook(_bundle: PhaseAwareCaptureHook | null): void {
  // null coordinator has no engine to apply the hook to
}

initialize(): void {
  // null coordinator has nothing to initialize
}
```

In `src/test-utils/mock-coordinator.ts` near `:91-92`:

```ts
applyCaptureHook(_bundle: PhaseAwareCaptureHook | null): void {
  // mock coordinator does not run real instrumentation
}

initialize(): void {
  // mock coordinator does not run DCOP
}
```

If you used the `PhaseAwareCaptureHookLike` structural alias in W1.T2, use the same alias here. Otherwise import `PhaseAwareCaptureHook` from the harness types.

### Acceptance (W1.T3)

- Both files implement the new interface members and compile.
- `npx tsc --noEmit` — no errors in either file or its consumers.

---

## W1.T4 — `src/solver/analog/convergence-log.ts`

### Lock down doc comment at `:36-46` (per §9.12, §11.1 Q5)

Find the existing comment on `iterationDetails?` field of `NRAttemptRecord` (currently says "may be populated only when the comparison harness postIterationHook is active alongside convergence logging"). Replace with:

```ts
/**
 * Per-iteration detail records for this attempt.
 *
 * CONTRACT: When `engine.convergenceLog.enabled === true`, this field MUST be
 * populated with one entry per NR iteration. Per Q5 resolution (§11.1), the
 * harness `postIterationHook` is NOT a precondition — convergence logging is
 * an independent capability. The drain at `analog-engine.ts:400-408` and
 * `:676-687` fires on the log-enabled gate alone.
 */
iterationDetails?: IterationDetail[];
```

Adjust the comment text to match the file's existing JSDoc style; the substantive change is the contract assertion. Do NOT touch the field's type or any code in this file — only the comment.

### Acceptance (W1.T4)

- The field's documentation now states the contract unambiguously.
- No code changes; file still parses.

---

## Wave 1 exit checklist

- [ ] `npx tsc --noEmit` — additive type changes compile. Downstream test code (`comparison-session.ts`) may break temporarily; that is expected and resolved in Wave 3.
- [ ] All eight new types exported from `types.ts`.
- [ ] `unaligned?` removed from both sites in `types.ts`.
- [ ] `Tolerance.timeDeltaTol` exists with default `1e-12`.
- [ ] `coordinator-types.ts` declares `applyCaptureHook` and `initialize`.
- [ ] `null-coordinator.ts` and `mock-coordinator.ts` implement no-op stubs.
- [ ] `convergence-log.ts:36-46` documents the contract per §11.1 Q5 (log-enabled gate alone, no `&& postIterationHook` requirement).
- [ ] No behavioral changes — all changes are types, interface declarations, no-op stubs, or comment updates.

## Hard rules (project-wide)

- Read `CLAUDE.md` for non-negotiable project rules (engine-agnostic editor, no pragmatic patches, three-surface testing).
- No "pragmatic" or "minimal" reductions of the spec — implement exactly what is written.
- Do not silently narrow scope. If you cannot complete a task, take the Clarification Exit per the implementer instructions.
