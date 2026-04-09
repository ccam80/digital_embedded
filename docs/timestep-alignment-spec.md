# Timestep Alignment Redesign — Specification

Status: APPROVED (spec-only; no code changes yet; all design questions resolved §11)
Scope: `src/solver/analog/__tests__/harness/*` + `ref/ngspice/src/maths/ni/niiter.c`
Related: `docs/ngspice-harness-howto.md`

## 1. Problem statement

The ngspice comparison harness captures per-NR-iteration state from two engines and aligns them side-by-side. Today the two sides disagree on what a "step" is.

**Our engine** (`src/solver/analog/__tests__/harness/capture.ts:311-402`, `src/solver/analog/__tests__/harness/comparison-session.ts:221-350`). A "step" is one call to `coordinator.step()` or one call to `engine.dcOperatingPoint()`. The DCOP three-level fallback stack (`src/solver/analog/dc-operating-point.ts:165-322`) runs *inside* `compile()`, and its per-iteration data is NOT captured — the hook is only wired up for the DC OP re-run in `runDcOp()` (see `src/solver/analog/__tests__/harness/comparison-session.ts:214-220`). For `runTransient()`, the first call to `coordinator.step()` produces one `StepSnapshot` whose iterations cover only the first transient NR solve at `simTime = dt`. `finalizeStep()` is called with `engine.simTime` AFTER the step — the **end-of-step** time (see `src/solver/analog/analog-engine.ts:335` which does `this._simTime += dt` at the top of the retry loop, then proceeds through acceptance).

**ngspice bridge** (`src/solver/analog/__tests__/harness/ngspice-bridge.ts:530-618`). The C instrumentation in `ref/ngspice/src/maths/ni/niiter.c:740-818` fires `ni_instrument_cb_v2` once per `NIiter` call. During a transient run that means: every `MODEINITJCT` sub-iteration, every gmin-stepping sub-solve, every source-stepping sub-solve, every `MODEINITTRAN` predictor pass, and every regular `MODEINITFLOAT` transient NR solve — each becomes its own "step". The TS bridge groups iterations into steps by detecting either an iteration-counter reset OR a `simTime` change (`ngspice-bridge.ts:538-539`). The result is 100+ ngspice "steps" at `simTime=0` before the first transient step even begins. `simTime` in the callback is `ckt->CKTtime` which ngspice advances *before* the NR solve (ngspice `src/spicelib/analysis/dctran.c:731-732`), so it is the **target (end-of-step)** time of the solve.

**Alignment** (`comparison-session.ts:1641-1676`). `_buildTimeAlignment()` binary-searches ngspice steps by `simTime` within a tolerance of `0.5 * min(dt_ours, dt_ng)`. For our-steps with no match, query code falls back to a raw `stepIndex` lookup (`getStepEnd` at line 379: `this._alignedNgIndex.get(stepIndex) ?? stepIndex`). Consequence: on `buckbjt` we see 2 our-steps vs ~120 ngspice-steps, and step 0 gets paired with the wrong ngspice iteration (our first transient solve ↔ ngspice's first DCOP sub-solve).

**Root cause.** The two sides disagree on the discriminator for a step.

## 2. Target model

### 2.1 Definitions

- **Iteration.** One stamp/assemble/factor/solve inside NR.
- **NR attempt.** One full call to `newtonRaphson()` (or ngspice `NIiter()`) until it converges or hits `maxIterations`.
- **NR phase (mode).** Algorithmic context: `dcopDirect`, `dcopGminDynamic`, `dcopGminSpice3`, `dcopSrcSweep`, `tranInit` (`MODEINITTRAN`), `tranPredictor` (`MODEINITPRED`), `tranNR` (`MODEINITFLOAT`), `tranNrRetry` (NR failed, dt cut, same `simTime`), `tranLteRetry` (LTE failed, dt cut, `simTime` rolled back).
- **Step.** The aggregate of every iteration and every attempt that occurs while `simTime` is unchanged.

### 2.2 Discriminator: simTime advancing

> A new step begins exactly when, and only when, `simTime` advances.

Corollaries:
- All DCOP sub-iterations live at `simTime = 0`; they form a single step.
- Transient init (`MODEINITTRAN`) iterations at `t = 0` join the same step as DCOP, provided `simTime` has not advanced (§5).
- NR-failure retries (`analog-engine.ts:390-397`) and LTE roll-backs (`analog-engine.ts:436-443`, `dctran.c:920`) both keep `simTime` at `t_n`, so their attempts join the same step.

### 2.3 Step time: start time, not end time

> `step.stepStartTime` = the `simTime` that was current BEFORE any NR attempt in this step began.

For the step that targets moving from `t = 0` to `t = 1ns`, `stepStartTime = 0` (not `1e-9`). Once accepted, `simTime` becomes `1e-9` and the next step opens with `stepStartTime = 1e-9`.

Rationale:
1. Unambiguous on the ngspice side: `CKTtime` has already been advanced to the target when the callback fires; the bridge rewinds by `dt` (see §8.1) — or the C side populates a new `simTimeStart` field.
2. Collapses DCOP + first transient solve into the same boot step (matches the requirement "all iters at this timepoint, across all modes, flattened into a single grouped record").
3. Gives queries a stable key: `getStepAtTime(0)` returns the boot step.

`stepEndTime` is also recorded for reporting convenience; the **canonical identifier** is `stepStartTime`.

### 2.4 Sub-grouping within a step

Iterations within a step are grouped into `NRAttempt` records, each carrying `phase`, `dt`, `iterations[]`, `converged`, and `outcome` ∈ {`accepted`, `nrFailedRetry`, `lteRejectedRetry`, `dcopSubSolveConverged`, `finalFailure`}. The **accepted attempt** is the last one with `outcome === "accepted"`. Steps whose terminal attempt has a different outcome are marked `step.accepted = false` (engine gave up at `dt < delmin`).

## 3. Data model changes (`types.ts`)

### 3.1 New enums

```ts
export type NRPhase =
  | "dcopDirect"
  | "dcopGminDynamic"
  | "dcopGminSpice3"
  | "dcopSrcSweep"
  | "tranInit"          // MODEINITTRAN / first transient pass
  | "tranPredictor"     // MODEINITPRED
  | "tranNR"            // MODEINITFLOAT
  | "tranNrRetry"       // NR failed, dt cut, simTime unchanged
  | "tranLteRetry";     // LTE rejected, dt cut, simTime rolled back

export type NRAttemptOutcome =
  | "accepted"
  | "nrFailedRetry"
  | "lteRejectedRetry"
  | "dcopSubSolveConverged"
  | "finalFailure";
```

### 3.2 `NRAttempt` — extended (breaking)

```ts
export interface NRAttempt {
  phase: NRPhase;
  dt: number;                // DCOP sub-solves: 0.
  iterations: IterationSnapshot[];
  converged: boolean;
  iterationCount: number;
  outcome: NRAttemptOutcome;
  /** Gmin value (dcopGmin*) or source factor (dcopSrcSweep). */
  phaseParameter?: number;
}
```

Migration: existing call-sites in `capture.ts:346-354` and `363-394` must pass `phase` and `outcome`.

### 3.3 `StepSnapshot` — breaking rewrite

```ts
export interface StepSnapshot {
  // Identity
  stepStartTime: number;      // canonical identifier
  stepEndTime: number;

  dt: number;                 // accepted attempt's dt; 0 for DCOP-only boot

  // Attempts
  attempts: NRAttempt[];                 // REQUIRED
  acceptedAttemptIndex: number;          // -1 if finalFailure
  accepted: boolean;

  // Shortcut fields (derived from accepted attempt)
  iterations: IterationSnapshot[];
  converged: boolean;
  iterationCount: number;

  // Existing
  integrationCoefficients: IntegrationCoefficients;  // accepted-attempt only (§9.5)
  analysisPhase: "dcop" | "tranInit" | "tranFloat";
  cktMode?: number;
}
```

Notes:
- **Hard cut: no `simTime` legacy alias.** All call-sites migrate to `stepStartTime` / `stepEndTime`. Old tests that reference `step.simTime` are deleted, not ported.
- `attempts` is required. Single-attempt steps have `attempts.length === 1` with `outcome === "accepted"`.
- A boot step on our side typically carries `[dcopDirect, dcopGminDynamic×N, dcopGminSpice3×N, dcopSrcSweep×N, tranInit]`. DCOP gmin-stepping and source-stepping sub-solves are **one attempt per sub-solve** (see §11, answer 5).

### 3.4 `CaptureSession` — no shape change.

### 3.5 `RawNgspiceIterationEx` — new field

```ts
export interface RawNgspiceIterationEx {
  // ... existing ...
  /** CKTtime BEFORE the NR solve began (start-time). Populated by C side. */
  simTimeStart: number;
  // simTime retained as CKTtime AFTER advance (end-time).
}
```

## 4. Our-engine capture changes

### 4.1 Hook points

| Phase | Source location | Hook status |
|---|---|---|
| `dcopDirect` | `dc-operating-point.ts:187-191` | hook passed via `nrBase` (line 179) |
| `dcopGminDynamic` loop | `dc-operating-point.ts:382-443` | hook flows through |
| `dcopGminDynamic` clean solve | `dc-operating-point.ts:446-457` | same |
| `dcopGminSpice3` ramp | `dc-operating-point.ts:504-522` | same |
| `dcopGminSpice3` clean | `dc-operating-point.ts:525-536` | same |
| `dcopSrcSweep` | `dc-operating-point.ts:568-668` | same |
| `tranInit` / `tranNR` | `analog-engine.ts:350-375` | at line 364 |
| NR retry | `analog-engine.ts:390-397` | continues in `for(;;)` |
| LTE retry | `analog-engine.ts:436-443` | same |

All iteration hook points exist today. What is missing is **phase annotation** — telling the capture layer which NR phase an incoming iteration belongs to.

### 4.2 Phase-aware capture API

Extend `createStepCaptureHook` (`capture.ts:311`):

```ts
interface StepCapture {
  hook: PostIterationHook;
  beginAttempt(phase: NRPhase, dt: number, phaseParameter?: number): void;
  endAttempt(outcome: NRAttemptOutcome, converged: boolean): void;
  endStep(params: {
    stepEndTime: number;
    integrationCoefficients: IntegrationCoefficients;
    analysisPhase: "dcop" | "tranInit" | "tranFloat";
    acceptedAttemptIndex: number;
  }): void;
  peekIterations(): readonly IterationSnapshot[];
  getSteps(): StepSnapshot[];
  clear(): void;
}
```

Internal cursor: `currentStep: { stepStartTime, pendingAttempts[] } | null`. `beginAttempt` captures `simTime` as `stepStartTime` iff `currentStep` is null. `endAttempt` pushes iterations into `pendingAttempts`. `endStep` emits the final `StepSnapshot`.

### 4.3 Wiring `dc-operating-point.ts`

Add to `DcOpOptions` (`dc-operating-point.ts:40-70`):
```ts
onPhaseBegin?: (phase: NRPhase, phaseParameter?: number) => void;
onPhaseEnd?: (outcome: NRAttemptOutcome, converged: boolean) => void;
```
Call sites:
- Before `newtonRaphson` at line 187: `onPhaseBegin("dcopDirect")` / after: `onPhaseEnd(...)`.
- `dynamicGmin` sub-solves (lines 384, 446) — phase `dcopGminDynamic`, `phaseParameter = diagGmin`.
- `spice3Gmin` sub-solves (lines 504, 525) — phase `dcopGminSpice3`.
- `gillespieSrc` sub-solves (lines 568, 583, 619) — phase `dcopSrcSweep`, `phaseParameter = srcFact`.

**Critical fix — hook-before-compile, not defer-DCOP.** Today DCOP runs inside `compile()` (`src/solver/coordinator.ts:113-117`) with no hook attached, then runs again in `runDcOp()` with the hook. For `runTransient()`, the DCOP that actually establishes the operating point is the one in `compile()`, and its iterations are invisible.

**Fix:** attach the capture hook *before* `compile()` runs, so the in-compile DCOP emits iterations into the same capture session as the transient loop. This preserves the `compile() → ready circuit` invariant — no backdoor, no deferred work.

Concretely, extend `DefaultSimulatorFacade`:
```ts
class DefaultSimulatorFacade {
  constructor(opts?: { captureHook?: PhaseAwareCaptureHook });
  // OR mutator form:
  setCaptureHook(hook: PhaseAwareCaptureHook): void;   // must be called before compile()
}
```
The facade threads the hook into `DefaultSimulationCoordinator`, which installs it on `MNAEngine` and passes it through to `dcOperatingPoint()` as part of `DcOpOptions.onPhaseBegin`/`onPhaseEnd`. `ComparisonSession.init()` constructs the facade with the hook, then calls `compile()`; the in-compile DCOP now fires the hook exactly like the transient NR loop.

Consequence: `runDcOp()` no longer needs to re-run DCOP — it just returns the boot step captured during `compile()` (see §11, answer 6). The re-run path is deleted.

### 4.4 Wiring `analog-engine.ts step()`

Add `stepPhaseHook?: { onAttemptBegin(phase, dt); onAttemptEnd(outcome, converged) }` on `MNAEngine`. Call sites inside retry loop at `analog-engine.ts:328-473`:
- After `setDeltaOldCurrent(dt)` at line 332: `onAttemptBegin(phase, dt)` where phase is `tranInit` (if coordinator's `analysisPhase === "tranInit"`) else `tranNR`, overridden to `tranNrRetry`/`tranLteRetry` on subsequent iterations of the same step (cursor maintained inside the hook).
- At NR failure exit (line 390): `onAttemptEnd("nrFailedRetry", false)`.
- At LTE reject exit (line 436): `onAttemptEnd("lteRejectedRetry", true)`.
- At accepted break (line 433): `onAttemptEnd("accepted", true)`.

### 4.5 simTime-advanced detection

Harness tracks `prevSimTime`. After any potentially-advancing call:
```ts
if (engine.simTime > prevSimTime) {
  stepCapture.endStep({ stepEndTime: engine.simTime, ... });
  prevSimTime = engine.simTime;
}
```
For the first transient step after DCOP, this closes the boot step when `simTime` flips from 0 to the first accepted timepoint.

## 5. The "at t=0" reconciliation

Question: the first transient NR solve targets `t = dt` (ngspice advances `CKTtime` before the solve at `dctran.c:731`). Does it belong to the boot step (with DCOP) or its own step?

**Rule.** Because `stepStartTime` = "`simTime` BEFORE the attempt began" (§2.3), the first transient solve starts at `simTime = 0` and advances to `dt`. Its `stepStartTime = 0`. DCOP attempts are also at `stepStartTime = 0`. **They all belong to the same step.**

```
step[0] = {
  stepStartTime: 0,
  stepEndTime:   dt_accepted,
  attempts: [
    { phase: "dcopDirect",        outcome: "dcopSubSolveConverged"|"accepted" },
    ...optional dcopGmin*/dcopSrcSweep sub-solves...
    { phase: "tranInit",          outcome: "accepted" },
  ],
  acceptedAttemptIndex: <index of tranInit attempt>,
}
step[1] = {
  stepStartTime: dt_accepted_of_step0,
  stepEndTime:   dt_accepted_of_step0 + dt_1,
  attempts: [{ phase: "tranNR", outcome: "accepted" }],
  ...
}
```

Justification:
- Matches the user request.
- Both engines produce a boot step at `stepStartTime=0`; alignment becomes trivial (exact `stepStartTime` equality).
- Step `dt`/`integrationCoefficients` reflect the accepted (tranInit) attempt.
- `getStepEnd(0)` reports state at the end of the first transient solve, mirroring ngspice's step 0.

Caveat: DCOP iterations and first transient iterations have different physical meaning (no companion stamps vs. companion stamps). Query code must distinguish them via `NRAttempt.phase`, not treat them as a continuous NR history. Monotonic-noncon assertions must scope to iterations within a single `NRAttempt`.

## 6. ngspice bridge changes (`ngspice-bridge.ts`)

### 6.1 Grouping algorithm (replaces lines 530-618)

Keyed on `simTimeStart`:

```
Inputs: this._iterations[] (RawNgspiceIterationEx in arrival order).
State:
  currentStep: { stepStartTime, attempts[], currentAttempt } | null
  prevCktMode, prevIterationCounter

For each raw:
  1. attemptPhase = cktModeToPhase(raw.cktMode, raw.phaseFlags).
  2. stepStartTimeOfRaw = raw.simTimeStart.
  3. If currentStep == null → open step with stepStartTime = stepStartTimeOfRaw.
  4. Else if stepStartTimeOfRaw !== currentStep.stepStartTime:
       - Close currentStep (acceptedAttemptIndex = last attempt whose
         final iteration has converged === true). Push to steps[].
       - Open new step with stepStartTime = stepStartTimeOfRaw.
  5. New attempt if:
       - currentAttempt == null, OR
       - raw.iteration === 0 or raw.iteration < prevIterationCounter (NR reset), OR
       - attemptPhase !== currentAttempt.phase (mode transition)
     On new attempt: close currentAttempt with its outcome, open new one.
  6. Push iteration snapshot into currentAttempt.iterations.
  7. prevCktMode = raw.cktMode; prevIterationCounter = raw.iteration.

After loop: close currentAttempt (default outcome="accepted"), close currentStep.
```

### 6.2 CKTmode → NRPhase

```ts
const MODEDCOP=0x0001, MODETRANOP=0x0002, MODETRAN=0x0004;
const MODEINITFLOAT=0x0010, MODEINITJCT=0x0040, MODEINITFIX=0x0080;
const MODEINITPRED=0x0100, MODEINITTRAN=0x0200;

function cktModeToPhase(mode: number, phaseFlags: number): NRPhase {
  const IN_GMIN_DYN = (phaseFlags & 0x1) !== 0;
  const IN_SRC_STEP = (phaseFlags & 0x2) !== 0;
  const IN_GMIN_SP3 = (phaseFlags & 0x4) !== 0;
  if (mode & MODEDCOP) {
    if (IN_SRC_STEP) return "dcopSrcSweep";
    if (IN_GMIN_SP3) return "dcopGminSpice3";
    if (IN_GMIN_DYN) return "dcopGminDynamic";
    return "dcopDirect";
  }
  if (mode & MODETRANOP)   return "tranInit";
  if (mode & MODEINITPRED) return "tranPredictor";
  if (mode & MODEINITTRAN) return "tranInit";
  if (mode & MODETRAN)     return "tranNR";
  return "tranNR";
}
```
Without C phase flags, distinguishing gmin-dynamic vs gmin-spice3 vs src-sweep requires heuristics. Recommended: add the C flags (§8.2).

### 6.3 Retry vs distinct attempt

Within a step (same `stepStartTime`):
- `!converged` followed by `converged` → first attempt's `outcome="nrFailedRetry"`, second's `"accepted"`.
- LTE rejection is detected from an **explicit outer callback** emitted by `dctran.c` (see §8.3), not inferred. When the outer callback fires with `lteRejected=true`, the current attempt's outcome is set to `"lteRejectedRetry"` and the step remains open at the same `stepStartTime` for the re-attempt.

### 6.4 First iteration

Open the first step/attempt using the first callback's `simTimeStart` and phase. No synthetic zero needed.

## 7. Alignment algorithm rewrite

Replace `comparison-session.ts:1641-1676`:

```ts
private _buildTimeAlignment(): void {
  this._alignedNgIndex.clear();
  const ourSteps = this._ourSession?.steps ?? [];
  const ngSteps  = this._ngSessionAligned()?.steps ?? [];
  if (ourSteps.length === 0 || ngSteps.length === 0) return;

  const ngIdxByTime = new Map<number, number>();
  for (let j = 0; j < ngSteps.length; j++) {
    ngIdxByTime.set(ngSteps[j].stepStartTime, j);
  }

  const EPS = 1e-15;  // 1 fs floating-point slack
  for (let i = 0; i < ourSteps.length; i++) {
    const t = ourSteps[i].stepStartTime;
    const j = ngIdxByTime.get(t);
    if (j !== undefined) { this._alignedNgIndex.set(i, j); continue; }

    let bestJ = -1, bestDelta = Infinity;
    for (let k = 0; k < ngSteps.length; k++) {
      const d = Math.abs(ngSteps[k].stepStartTime - t);
      if (d < bestDelta) { bestDelta = d; bestJ = k; }
    }
    if (bestDelta <= EPS) this._alignedNgIndex.set(i, bestJ);
    // else: leave unaligned — no raw-index fallback.
  }
}
```

Every query site currently doing `this._alignedNgIndex.get(stepIndex) ?? stepIndex` (lines 379, 435, 1506, ...) must become:
```ts
const ngIdx = this._alignedNgIndex.get(stepIndex);
if (ngIdx === undefined) return /* unaligned sentinel */;
```
Unaligned behavior:
- `getStepEnd(i)` → `ComparedValue.ngspice = NaN` and `unaligned: true` on the report.
- `getIterations(i)` → our side only.
- `SessionSummary` counts unaligned steps.

Unaligned states are a bug signal. For well-formed transient runs we expect **zero** unaligned steps.

### 7.1 Gap handling

- Our path ran `dcopGminSpice3`; ngspice converged directly → both boot steps at `stepStartTime=0`, aligned; differing sub-attempts reported via a new `getAttemptComparison(stepIndex)` helper.
- Different NR retry counts at same step → still aligned; attempt counts differ.
- Our engine advanced past a point where ngspice stalled → our step has no match; unaligned and reported.

## 8. ngspice C-side changes (`ref/ngspice/src/maths/ni/niiter.c`)

Current struct (`niiter.c:73-104`) has `cktMode`, `simTime`, `dt`. Missing:

### 8.1 `simTimeStart` field — required

Add:
```c
double simTimeStart;   // CKTtime BEFORE the current NR solve began
```
Populate at the call site `niiter.c:778-818`. Simplest: set `ni_data.simTimeStart = ckt->CKTtime - ckt->CKTdelta;` for transient iterations. Correct because:
- `dctran.c` advances `CKTtime += CKTdelta` before calling `NIiter` (line 731).
- On NR-failure rollback (`dctran.c:796`), `CKTtime -= CKTdelta` so the next callback sees the same pre-advance → same `simTimeStart`. Retries at the same step share `simTimeStart`.
- For DCOP (`CKTtime == 0`, `CKTdelta == 0`), `simTimeStart = 0` naturally.
- Source-stepping loops inside `NIiter` (`niiter.c:560-612`) fire with `MODEDCOP` and `CKTtime=0` — all bucket to the boot step.

Alternative (cleaner): `dctran.c` stores a pre-advance value on `ckt` and clears it at step accept. Pick whichever is safest given ngspice's existing retry paths.

### 8.2 Phase-parameter fields — strongly recommended

```c
double phaseGmin;     // current diagGmin during gmin stepping, else 0
double phaseSrcFact;  // current source factor during src stepping, else 1
int    phaseFlags;    // bit0=inGminDynamic, bit1=inSrcSweep, bit2=inGminSpice3
```
Set in `src/spicelib/analysis/cktop.c` before each gmin/src ladder branch; clear on exit. Without them, TS-side phase distinction relies on heuristics.

### 8.3 New outer callback — `ni_outer_cb`

Add a second instrumentation callback fired from `dctran.c` after each outer timestep-loop iteration (accept or reject):

```c
typedef struct {
    double  simTimeStart;      // CKTtime before the just-finished solve
    double  dt;                 // CKTdelta used
    int     lteRejected;        // 1 if LTE test failed and dt was cut
    int     nrFailed;           // 1 if NR did not converge
    int     accepted;           // 1 if the step was accepted and simTime advanced
    double  newDt;              // next CKTdelta (after any trunc-error cut)
} ni_outer_data_t;

void ni_outer_cb(const ni_outer_data_t* data);
```
Fired at the end of each `dctran.c` outer iteration, after `CKTterr()` and before the next `NIiter()` call. TS bridge uses it to:
- set the current attempt's `outcome` to `lteRejectedRetry` on `lteRejected=1`,
- close the current step and open a new one on `accepted=1`,
- set `outcome=finalFailure` and close the step on `nrFailed=1` at `dt < delmin`.

This replaces inference from same-`stepStartTime` converged attempts and gives deterministic attempt outcomes without heuristics.

### 8.4 No "new step" flag needed

`simTimeStart` change detection on `ni_instrument_cb_v2` (combined with the explicit `accepted` signal on `ni_outer_cb`) replaces any per-iteration "new step" flag.

## 9. Query API impact

### 9.1 `getStepEnd(stepIndex)`

Returns state at the **end of the accepted attempt**:
`step.attempts[step.acceptedAttemptIndex].iterations.at(-1)` on both sides. Report shape:
```ts
interface StepEndReport {
  stepIndex: number;
  stepStartTime: ComparedValue;
  stepEndTime: ComparedValue;
  // NO legacy simTime field — hard cut.
  // ... existing ...
  attemptCount: { ours: number; ngspice: number };
  unaligned?: boolean;
}
```

### 9.2 `getStepIteration` / new attempt helpers

`step.iterations[]` continues to mirror the accepted attempt. New helpers:
```ts
getAttempt(stepIndex, attemptIndex): AttemptReport;
getAttemptIteration(stepIndex, attemptIndex, iterIndex): IterationReport;
```

### 9.3 "Final iteration" semantics

`step.iterations.at(-1)` = last iteration of the **accepted attempt** — the one that committed state to `_voltages` / `CKTrhsOld`. NOT "the last NR iteration run at this simTime" — retries, LTE roll-backs, and DCOP sub-solves live in `attempts[non-accepted]`.

- "Iteration that committed state" → `step.iterations.at(-1)`.
- "Every iteration ever run at this step" → `attempts.flatMap(a => a.iterations)`.

### 9.4 DCOP boot step

`runDcOp()` → one step, `stepStartTime = stepEndTime = 0`, `dt = 0`, attempts reflecting the DCOP ladder actually taken. `acceptedAttemptIndex` points at the attempt that committed voltages (final clean solve in gmin/src ladder, or the direct solve).

**Capture source:** because the hook is attached before `compile()` (§4.3), the boot step produced during `compile()` IS what `runDcOp()` returns. There is no re-run. `runDcOp()` just validates that `compile()` has already populated the session's first step and hands it back.

`runTransient()` step 0 → merged boot step per §5. Accepted attempt is the first `tranInit`. DCOP attempts present but not accepted. `getStepEnd(0)` returns post-first-transient-solve state, matching ngspice's step 0.

### 9.5 `integrationCoefficients` semantics

`StepSnapshot.integrationCoefficients` reflects the **accepted attempt only**. For a boot step whose accepted attempt is `tranInit`, this is backward-Euler on both engines (ngspice hard-codes BE for the first transient step; ours does the same). Retried attempts (`nrFailedRetry`, `lteRejectedRetry`) may have used different coefficients — those are NOT stored in `integrationCoefficients`; if needed, read them from the individual attempt's iteration snapshots.

This is a doc'd semantic: "coefficients reflect the accepted attempt". Callers who need the retry's coefficients walk `step.attempts[i].iterations[j]` directly.

## 10. Migration and test plan

### 10.1 Code call-sites to migrate

Harness (`src/solver/analog/__tests__/harness/`):
- `capture.ts:311-402` — rewrite `createStepCaptureHook` per §4.2.
- `ngspice-bridge.ts:530-618` — rewrite `getCaptureSession` per §6.1.
- `comparison-session.ts:221-262` (`runDcOp`) — use new API.
- `comparison-session.ts:270-350` (`runTransient`) — track `prevSimTime`; call `endStep` on advance.
- `comparison-session.ts:376-427` (`getStepEnd`) — emit `stepStartTime`/`stepEndTime`; read accepted-attempt iterations.
- `comparison-session.ts:432-500+` (`getIterations`) — default to accepted attempt; add attempt-walk overload.
- `comparison-session.ts:~1500` (summary loops) — drop raw-stepIndex fallback.
- `comparison-session.ts:1641-1676` (`_buildTimeAlignment`) — rewrite per §7.

Solver (`src/solver/analog/`):
- `dc-operating-point.ts:40-70` — add `onPhaseBegin`/`onPhaseEnd`, thread through calls at 187, 384, 446, 504, 525, 568, 583, 619.
- `analog-engine.ts` — add `stepPhaseHook`, call at 332, 390, 436, 433.
- `src/solver/coordinator.ts:113-117` — accept `captureHook` in constructor; install on `MNAEngine` before `compile()` calls `dcOperatingPoint()`.
- `DefaultSimulatorFacade` (`src/headless/default-facade.ts`) — accept `captureHook` in constructor / `setCaptureHook()` before `compile()`.

ngspice C (`ref/ngspice/src/`):
- `maths/ni/niiter.c:73-104` — add `simTimeStart`, `phaseGmin`, `phaseSrcFact`, `phaseFlags`.
- `maths/ni/niiter.c:778-818` — populate at call site.
- `maths/ni/niiter.c` — add `ni_outer_cb` (§8.3) declaration and wiring.
- `spicelib/analysis/cktop.c` — set `phaseFlags`/`phaseGmin` around each ladder branch.
- `spicelib/analysis/dctran.c` — fire `ni_outer_cb` at end of each outer loop iteration with `lteRejected`/`nrFailed`/`accepted` flags; store pre-advance `simTimeStart` on `ckt`, or rely on `CKTtime - CKTdelta`.

### 10.2 Tests

**Hard cut — delete, don't migrate.** Tests that reference the old per-`coordinator.step()` grouping or the legacy `step.simTime` field are deleted outright. No compatibility porting.

Delete:
- Any assertion that depends on "1 our-step per `coordinator.step()` call".
- Any assertion that reads `step.simTime`.

Rewrite from scratch (new tests replace them):
- `buckbjt-smoke.test.ts` — assert matching step counts (boot + N tran, not N+120) and exact `stepStartTime` alignment.
- `query-methods.test.ts` — use `stepStartTime`/`stepEndTime` exclusively.
- `harness-integration.test.ts` — updated step-count expectations.
- `stream-verification.test.ts` — updated.

New:
1. `step-alignment.test.ts` — trivial RC transient; assert `ourSession.steps.length === ngSession.steps.length` and every step aligns by exact `stepStartTime`.
2. `boot-step.test.ts` — `runDcOp()` produces exactly 1 step with `stepStartTime===0`, `dt===0`, attempts reflect DCOP path.
3. `boot-step-merge.test.ts` — `runTransient()` step 0 contains DCOP + tranInit attempts, `acceptedAttemptIndex` points at tranInit.
4. `nr-retry-grouping.test.ts` — circuit forcing an NR retry; failed attempt captured at same `stepStartTime`.
5. `lte-retry-grouping.test.ts` — LTE rejection roll-back case.
6. `ngspice-bridge-grouping.test.ts` — synthetic `RawNgspiceIterationEx[]` stream unit-testing the §6.1 state machine (no FFI).

### 10.3 End-to-end validation (buckbjt)

Expected after rewrite:
- `ourSession.steps.length === ngSession.steps.length` (true equality). Today: 2 vs ~120; after fix: matching counts.
- `_alignedNgIndex.size === ourSession.steps.length`.
- `step[0].attempts` shows DCOP phases on **both** sides; attempts compare within tolerance at matching indices.
- Divergence reports highlight genuine model discrepancies, not timestep mismatch.

### 10.4 Staged rollout

No legacy-compatibility phase — everything lands as a coordinated breaking change.

1. Land C-side `simTimeStart` + phase fields + `ni_outer_cb`, rebuild DLL, verify existing ngspice DLL callers still link.
2. Land `types.ts` rewrite (new `NRPhase`/`NRAttemptOutcome` enums, `StepSnapshot` with no legacy `simTime`, extended `NRAttempt`, `RawNgspiceIterationEx.simTimeStart`).
3. Land `capture.ts` + `analog-engine.ts` + `dc-operating-point.ts` phase-aware hook additions.
4. Land `DefaultSimulatorFacade` / `coordinator.ts` `captureHook` constructor wiring; `ComparisonSession.init()` attaches the hook before `compile()`.
5. Land `ngspice-bridge.ts` grouping rewrite (§6) and `ni_outer_cb` handling.
6. Land `comparison-session.ts` alignment rewrite (§7); delete re-run-DCOP path from `runDcOp()`.
7. Delete old tests wholesale; land new tests per §10.2.

Expect a single large PR — the data model is breaking and there is no transitional alias, so partial rollout is not viable.

## 11. Resolved decisions

All previously-open questions are answered. No outstanding blockers for implementation.

- **D1 — Hook attachment: constructor-arg, not defer-DCOP.** `DefaultSimulatorFacade` gains an optional `captureHook` constructor arg (or `setCaptureHook()` mutator that must be called before `compile()`). The hook survives compile-time and fires during the in-compile DCOP. This preserves the `compile() → ready circuit` invariant with no backdoor state and no deferred work. See §4.3.

- **D2 — LTE rejection: explicit outer callback.** `dctran.c` fires a new `ni_outer_cb` after each outer timestep-loop iteration carrying `lteRejected` / `nrFailed` / `accepted` flags. TS bridge consumes this for deterministic attempt outcomes — no inference from same-`stepStartTime` converged pairs. See §6.3, §8.3.

- **D3 — `integrationCoefficients` scope.** Reflects the accepted attempt only. Documented as such (§9.5). Callers who need retry coefficients walk `step.attempts[i].iterations[j]` directly.

- **D4 — Legacy `simTime` alias: hard cut.** No deprecation window, no transitional field. `StepSnapshot.simTime` is deleted; `StepEndReport.simTime` is deleted. Old tests that depend on per-`coordinator.step()` grouping or `step.simTime` are deleted outright, not ported. See §3.3, §10.2.

- **D5 — `gillespieSrc` sub-solves: one `NRAttempt` per sub-solve.** Each source-stepping sub-solve becomes its own attempt with `phase="dcopSrcSweep"` and `phaseParameter = srcFact`. This gives clean per-sweep-point comparisons and keeps attempt boundaries consistent with gmin-stepping sub-solves. See §2.4, §3.2.

- **D6 — Drop the re-run-DCOP path.** With D1 in place, the DCOP inside `compile()` IS captured. `runDcOp()` simply returns the first step of the capture session; the second DCOP invocation inside `runDcOp()` is deleted. Single capture path, no duplicate DCOP solves. See §9.4, §10.1.
