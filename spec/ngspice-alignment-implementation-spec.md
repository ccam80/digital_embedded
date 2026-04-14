# ngspice Alignment — Implementation Specification

**Status:** READY FOR IMPLEMENTATION
**Date:** 2026-04-14
**Scope:** 42 changes grouped into 12 implementation waves
**Target files:** `analog-engine.ts`, `newton-raphson.ts`, `state-pool.ts`, `timestep.ts`, `dc-operating-point.ts`, `sparse-solver.ts`, `bjt.ts`, `mosfet.ts`, `diode.ts`, `capacitor.ts`, `inductor.ts`, `varactor.ts`, `zener.ts`, `fet-base.ts`

This document is **self-contained**. An implementer reading ONLY this spec can make every change correctly. No other document is needed.

---

## Table of Contents

1. [Dependency Graph](#dependency-graph)
2. [Wave 1 — Firsttime Lifecycle (Changes 1, 3, 4, 5, 7)](#wave-1--firsttime-lifecycle)
3. [Wave 2 — Transient Mode Automaton (Changes 2, 6, 9)](#wave-2--transient-mode-automaton)
4. [Wave 3 — DeltaOld Ring Expansion (Change 8)](#wave-3--deltaold-ring-expansion)
5. [Wave 4 — DCOP Fallback Chain (Changes 10, 11, 12, 13)](#wave-4--dcop-fallback-chain)
6. [Wave 5 — Sparse Solver (Changes 14, 15)](#wave-5--sparse-solver)
7. [Wave 6 — MOSFET Correctness (Changes 16, 17, 18, 26, 27, 28)](#wave-6--mosfet-correctness)
8. [Wave 7 — Device INITF Modes (Changes 19, 20, 21, 22, 23)](#wave-7--device-initf-modes)
9. [Wave 8 — NR/Acceptance Mechanics (Changes 24, 25, 29)](#wave-8--nracceptance-mechanics)
10. [Wave 9 — Device Parameters (Changes 30, 38, 39, 40)](#wave-9--device-parameters)
11. [Wave 10 — Diode Correctness (Changes 31, 32, 33, 34)](#wave-10--diode-correctness)
12. [Wave 11 — Varactor Correctness (Changes 35, 36, 37)](#wave-11--varactor-correctness)
13. [Wave 12 — Zener Simplified Model (Change 42)](#wave-12--zener-simplified-model)

---

## Dependency Graph

```
Wave 1 (firsttime lifecycle)
  |
  v
Wave 2 (mode automaton)  --> Wave 7 (device INITF) --> Wave 8 (predictor gating)
  |
  +--> Wave 3 (deltaOld) [independent]
  +--> Wave 4 (DCOP fallback) [independent]
  +--> Wave 5 (sparse solver) [independent]
  +--> Wave 6 (MOSFET correctness) [independent]
  +--> Wave 9 (device params) [independent]
  +--> Wave 10 (diode correctness) [independent]
  +--> Wave 11 (varactor correctness) [independent]
  +--> Wave 12 (zener simplified) [independent]
```

Hard dependencies:
- Wave 2 requires Wave 1 (`_firsttime` flag must exist before mode automaton uses it)
- Wave 7 requires Wave 2 (`initTran`/`initPred` modes must exist before devices branch on them)
- Wave 8 requires Wave 2 (predictor gating interacts with `initPred` mode)
- All other waves are independent of each other

Recommended serial order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10 -> 11 -> 12

---

## Wave 1 — Firsttime Lifecycle

**Changes:** 1, 3, 4, 5, 7
**Files:** `src/solver/analog/analog-engine.ts`
**Dependencies:** None
**Risk:** Medium -- changes the transient step acceptance logic; could cause LTE rejection storms if first-step skip is wrong

### Change 1: Add `_firsttime` flag

**What:** Add a boolean field `_firsttime` to `MNAEngine` that tracks whether the engine is on its very first transient step after DC-OP.

**File:** `src/solver/analog/analog-engine.ts`

**Implementation:**

1. Add field declaration near line 128 (alongside `_simTime`, `_lastDt`):
```typescript
private _firsttime: boolean = false;
```

2. In `reset()` (line ~202), set:
```typescript
this._firsttime = false;
```

3. In `dcOperatingPoint()`, after line 791 (`cac.statePool.analysisMode = "tran"`), set:
```typescript
this._firsttime = true;
```

4. In `init()`, initialize:
```typescript
this._firsttime = false;
```

**ngspice ref:** `dctran.c:304` sets `firsttime = 1`; `dctran.c:864` clears it.

### Change 3: First step skips LTE

**What:** After NR converges on the first transient step, skip the LTE computation entirely and proceed directly to acceptance. This matches ngspice `dctran.c:849-866` where `firsttime && converged -> goto nextTime` (bypasses CKTtrunc).

**File:** `src/solver/analog/analog-engine.ts`

**Implementation:** In the NR-converged branch (after line ~463 `} else {`), BEFORE the `computeNewDt` call (line ~485), insert:

```typescript
// ngspice dctran.c:849-866: firsttime && converged -> skip LTE, accept immediately
if (this._firsttime) {
  this._firsttime = false;  // ngspice dctran.c:864: firsttime = 0
  this.stepPhaseHook?.onAttemptEnd("accepted", true);
  // Set newDt/worstRatio so the post-loop acceptance code works correctly
  newDt = dt;
  worstRatio = 0;
  break;  // exit for(;;) -> proceed to acceptance block
}
```

**Remove** the existing `_stepCount === 0` LTE-skip logic at line ~481-483 (the `if (this._stepCount === 0 && statePool)` block that copies s0->s1). This is superseded by the `_firsttime` check. The s0->s1 copy for MODEINITTRAN moves to Change 7.

### Change 4: NR failure re-arms MODEINITTRAN when firsttime

**What:** When NR fails during `_firsttime`, set `statePool.initMode = "initTran"` so the retry enters NR with the correct mode for charge initialization.

**File:** `src/solver/analog/analog-engine.ts`

**Implementation:** In the NR failure block (line ~454, `if (!nrResult.converged)`), after `this._timestep.currentOrder = 1` (line ~461), add:

```typescript
// ngspice dctran.c:820-821: NR failure during firsttime -> re-arm initTran
if (this._firsttime && statePool) {
  statePool.initMode = "initTran";
}
```

**ngspice ref:** `dctran.c:820-821` -- `ckt->CKTmode = (ckt->CKTmode & MODETRANOP) | MODEINITTRAN`

### Change 5: Post-NIiter unconditional MODEINITPRED set

**What:** Immediately after the NR call returns (before checking `converged`), unconditionally set `statePool.initMode = "initPred"`. This gets overwritten by Change 4 on NR failure during firsttime.

**File:** `src/solver/analog/analog-engine.ts`

**Implementation:** After the `newtonRaphson(...)` call (line ~433), BEFORE the logging block, add:

```typescript
// ngspice dctran.c:794: unconditional MODEINITPRED after NIiter returns
if (statePool) {
  statePool.initMode = "initPred";
}
```

Note: This requires `"initPred"` to be in the `initMode` union type. For Wave 1 standalone testing, temporarily add `"initPred"` to the union in `state-pool.ts` line 13.

**ngspice ref:** `dctran.c:794` -- `ckt->CKTmode = (ckt->CKTmode & MODETRAN) | MODEINITPRED`

### Change 7: State2/state3 seed after NIiter return (not at acceptance)

**What:** Move `seedFromState1()` from the acceptance block to immediately after the post-NIiter `initMode = "initPred"` set. Gate on `_firsttime`. This fires on every NIiter return while firsttime=true, including retries.

**File:** `src/solver/analog/analog-engine.ts`

**Current code at line ~547-549:**
```typescript
if (this._stepCount === 0) {
  statePool.seedFromState1();
}
```

**Implementation:**

1. **Remove** the `seedFromState1()` call from the acceptance block (line ~547-549).

2. After the post-NIiter `initMode = "initPred"` set (Change 5), add the MODEINITTRAN s0->s1 copy AND the seed:

```typescript
// ngspice dctran.c:795-799 + capload.c:60-62:
// On first transient step (firsttime), copy s0->s1 for q0==q1,
// then seed s2/s3 from s1. Fires every NIiter return while firsttime
// (including retries), matching ngspice which runs these copies
// unconditionally after NIiter when firsttime is set.
if (this._firsttime && statePool) {
  statePool.states[1].set(statePool.states[0]);
  statePool.seedFromState1();
}
```

3. Add a `wasFirsttime` local before the for(;;) loop for use at the acceptance block:
```typescript
// Before the for(;;) loop:
const wasFirsttime = this._firsttime;
```
This is needed because `_firsttime` is cleared in Change 3's break before reaching the acceptance block. The `wasFirsttime` flag lets the acceptance block know whether to skip operations that were already done.

**ngspice ref:** `dctran.c:795-799` -- state history seeding after NIiter; `dctran.c:782-786` -- bcopy(state0, state2/state3)

### Testing Strategy -- Wave 1

1. **Harness comparison test:** Run the NPNTransistor harness test circuit. Verify that step 0 is accepted without LTE computation. Compare iteration counts and node voltages against ngspice for steps 0-5.

2. **Unit test:** Create a test that runs `dcOperatingPoint()` then `step()` and verifies:
   - `_firsttime` is true after DCOP, false after first step
   - First step does not trigger LTE rejection
   - `seedFromState1()` fires on step 0 NIiter return

3. **Regression:** Run full `npm run test:q` -- no existing test should break.

### Risk Assessment -- Wave 1

- **LTE skip on step 0:** If the first step produces wildly wrong charge values, they propagate into all history slots via `seedFromState1`. This is correct behavior (matching ngspice) but could surface latent charge computation bugs.
- **`_firsttime` flag lifetime:** If DCOP fails and the engine proceeds anyway, `_firsttime` would be false (never set), which is correct -- no transient steps should run after DCOP failure.

---

## Wave 2 — Transient Mode Automaton

**Changes:** 2, 6, 9
**Files:** `src/solver/analog/newton-raphson.ts`, `src/solver/analog/state-pool.ts`, `src/solver/analog/analog-engine.ts`, `src/components/semiconductors/bjt.ts`, `src/components/semiconductors/mosfet.ts`, `src/components/passives/capacitor.ts`, `src/components/passives/inductor.ts`
**Dependencies:** Wave 1 (`_firsttime` flag)
**Risk:** High -- changes NR convergence gating; incorrect implementation causes NR to never converge or always converge too early

### Change 2: Extend initMode union and implement unified mode ladder

**What:** Extend `StatePool.initMode` to include `"initTran"` and `"initPred"`. Implement transient mode transitions in the NR loop.

**File:** `src/solver/analog/state-pool.ts`, line 13

```typescript
// BEFORE:
initMode: "initJct" | "initFix" | "initFloat" | "transient" = "transient";

// AFTER:
initMode: "initJct" | "initFix" | "initFloat" | "initTran" | "initPred" | "transient" = "transient";
```

**File:** `src/solver/analog/newton-raphson.ts`

In the NR loop, after the `assembler.updateOperatingPoints(elements, voltages, ...)` call (line ~545), and after the forced noncon=1 (Change 6 below), add the transient mode transition block:

```typescript
// Transient mode automaton (niiter.c:1065-1073):
// initTran: after iter 0, unconditional -> initFloat
// initPred: unconditional -> initFloat (before iter 0 stamps)
if (!ladder && opts.statePool) {
  const pool = opts.statePool as { initMode: string };
  if (pool.initMode === "initTran" && iteration === 0) {
    pool.initMode = "initFloat";
  } else if (pool.initMode === "initPred") {
    pool.initMode = "initFloat";
  }
}
```

Also update the convergence gate (line ~694-696):

```typescript
// BEFORE:
const canConverge = !ladder || ladder.pool.initMode === "initFloat";

// AFTER:
let canConverge: boolean;
if (ladder) {
  canConverge = ladder.pool.initMode === "initFloat";
} else if (opts.statePool) {
  const pool = opts.statePool as { initMode: string };
  canConverge = pool.initMode === "initFloat" || pool.initMode === "transient";
} else {
  canConverge = true;
}
```

**ngspice ref:** `niiter.c:1065` (MODEINITPRED -> MODEINITFLOAT), `niiter.c:1073` (MODEINITTRAN iterno==1 -> MODEINITFLOAT)

**File:** `src/solver/analog/analog-engine.ts`

In the `step()` method, before the NR call (before line ~408), set the mode:

```typescript
// ngspice: first transient step uses MODEINITTRAN, subsequent use MODEINITPRED
if (statePool) {
  if (this._firsttime) {
    statePool.initMode = "initTran";
  }
  // Note: initPred is set by Change 5 (post-NIiter) -- already correct for step 1+
}
```

### Change 6: iterno==1 forced noncon=1

**What:** After `updateOperatingPoints` in the NR loop, if `iteration === 0`, force `assembler.noncon = 1`. This guarantees at least 2 NR iterations.

**File:** `src/solver/analog/newton-raphson.ts`

After the `assembler.updateOperatingPoints(elements, voltages, ...)` call (line ~545), BEFORE the transient mode automaton block (Change 2), add:

```typescript
// ngspice niiter.c:957-961: iterno==1 forces noncon=1
// Guarantees at least 2 NR iterations (no convergence on iteration 0)
if (iteration === 0) {
  assembler.noncon = 1;
}
```

**Ordering within the NR loop body after the solve:**
1. updateOperatingPoints (line ~545)
2. forced noncon=1 (Change 6) -- NEW
3. transient mode transitions (Change 2) -- NEW
4. node damping (existing, line ~551)
5. convergence checks (existing, line ~579)

**ngspice ref:** `niiter.c:957-961` -- `if(ckt->CKTiterno == 1) ckt->CKTnoncon = 1;`

### Change 9: Device initMode migration (tranStep -> initMode)

**What:** Replace `pool.tranStep === 0` checks in device code with `pool.initMode === "initTran"`.

**File: `src/components/semiconductors/bjt.ts`**

Search for all occurrences of `pool.tranStep === 0` or equivalent and replace:
```typescript
// BEFORE:
const isFirstCall = pool.tranStep === 0;
// (or similar patterns)

// AFTER:
const isFirstCall = pool.initMode === "initTran";
```

**File: `src/components/semiconductors/mosfet.ts`**

Same transformation for all `pool.tranStep === 0` checks.

**File: `src/components/passives/capacitor.ts`, `src/components/passives/inductor.ts`**

Same transformation if any `tranStep === 0` checks exist. The engine-level bulk copy (`statePool.states[1].set(statePool.states[0])` at step 0) serves as the safety net.

**Verification:** After migration, `tranStep` is only used for increment counting in the acceptance block. Consider removing it from StatePool if no other consumer exists.

### Testing Strategy -- Wave 2

1. **Minimum 2-iteration test:** Verify NR always runs at least 2 iterations for any nonlinear circuit (single diode + resistor). Linear circuits still short-circuit in 1 iteration (the `!hasNonlinear` return at newton-raphson.ts:519).

2. **Harness comparison:** Run a diode+resistor circuit. Compare per-iteration convergence behavior (noncon values, mode labels) against ngspice.

3. **Regression:** Run full test suite. The forced 2-iteration minimum may increase iteration counts slightly.

### Risk Assessment -- Wave 2

- **Performance:** Forced 2-iteration minimum adds one extra NR iteration per step for previously-1-iteration circuits. Negligible cost.
- **Convergence gating:** The `canConverge` logic must correctly handle all combinations: DCOP ladder present, transient mode, no pool, etc. Test all paths explicitly.

---

## Wave 3 — DeltaOld Ring Expansion

**Change:** 8
**Files:** `src/solver/analog/timestep.ts`
**Dependencies:** None
**Risk:** Low -- structural expansion; higher indices consumed when higher-order BDF methods are active

### Implementation

**File:** `src/solver/analog/timestep.ts`

1. Expand `_deltaOld` from 4 to 7 slots. Change line ~90:
```typescript
// BEFORE:
private _deltaOld: number[] = [0, 0, 0, 0];

// AFTER:
private _deltaOld: number[] = [0, 0, 0, 0, 0, 0, 0];
```

2. Update `rotateDeltaOld()` (line ~102-107):
```typescript
// BEFORE:
rotateDeltaOld(): void {
  this._deltaOld[3] = this._deltaOld[2];
  this._deltaOld[2] = this._deltaOld[1];
  this._deltaOld[1] = this._deltaOld[0];
  this._deltaOld[0] = this.currentDt;
}

// AFTER:
rotateDeltaOld(): void {
  // ngspice dctran.c:715-717: shift all 7 slots
  for (let i = 5; i >= 0; i--) {
    this._deltaOld[i + 1] = this._deltaOld[i];
  }
  this._deltaOld[0] = this.currentDt;
}
```

3. Update constructor initialization (line ~154-157):
```typescript
// BEFORE:
this._deltaOld[0] = params.maxTimeStep;
this._deltaOld[1] = params.maxTimeStep;
this._deltaOld[2] = params.maxTimeStep;
this._deltaOld[3] = params.maxTimeStep;

// AFTER:
// ngspice dctran.c:316-317: CKTdeltaOld[i] = CKTmaxStep for all 7 slots
for (let i = 0; i < 7; i++) {
  this._deltaOld[i] = params.maxTimeStep;
}
```

**ngspice ref:** `cktdefs.h:93` -- `double CKTdeltaOld[7]`; `dctran.c:316-317` -- init; `dctran.c:715-717` -- rotation

### Testing Strategy -- Wave 3

1. Unit test: Verify `_deltaOld` has 7 slots after construction, all initialized to maxTimeStep.
2. Unit test: Verify `rotateDeltaOld()` shifts all 7 correctly.
3. Regression: Full test suite.

### Risk Assessment -- Wave 3

Minimal risk. The extra slots are unused until higher-order BDF methods are implemented. Existing code only reads `deltaOld[0..3]`; `deltaOld[4..6]` are inert.

---

## Wave 4 — DCOP Fallback Chain

**Changes:** 10, 11, 12, 13
**Files:** `src/solver/analog/dc-operating-point.ts`, `src/core/analog-engine-interface.ts`
**Dependencies:** None (benefits from Wave 2 but not required)
**Risk:** Medium -- changes DCOP convergence; could make previously-converging circuits fail or vice versa

### Change 10: Reset initMode at each fallback level

**What:** At the entry of each fallback function, set `statePool.initMode = "initJct"`. After each successful sub-solve, transition to `"initFloat"`.

**File:** `src/solver/analog/dc-operating-point.ts`

In `dynamicGmin()` (line ~466), after `zeroState` (line ~468):
```typescript
// ngspice cktop.c:136: reset to MODEINITJCT at each fallback level entry
if (statePool && 'initMode' in statePool) {
  (statePool as any).initMode = "initJct";
}
```

After each successful sub-solve (where `result.converged` is true):
```typescript
// ngspice cktop.c:171: MODEINITFLOAT after successful sub-step
if (statePool && 'initMode' in statePool) {
  (statePool as any).initMode = "initFloat";
}
```

Apply the same pattern to `spice3Gmin()` (line ~597) and `gillespieSrc()` (line ~672).

**ngspice ref:** `cktop.c:136, 283, 373, 583` -- `ckt->CKTmode = firstmode` (MODEDCOP | MODEINITJCT)

### Change 11: DCOP fallback chain topology -- mutually exclusive gmin methods

**What:** Restructure the fallback chain to match ngspice's selector logic. ngspice selects ONE gmin method (dynamic or spice3) based on `CKTnumGminSteps`, and ONE source-stepping method (gillespie or spice3) based on `CKTnumSrcSteps`.

**File:** `src/core/analog-engine-interface.ts`

Add to `SimulationParams` (or the `DEFAULT_SIMULATION_PARAMS` object):
```typescript
/** Number of gmin stepping levels. 1 = dynamic (default), >1 = spice3. ngspice: CKTnumGminSteps */
numGminSteps?: number;
/** Number of source stepping levels. 0 or 1 = gillespie (default), >1 = spice3_src. ngspice: CKTnumSrcSteps */
numSrcSteps?: number;
```

**File:** `src/solver/analog/dc-operating-point.ts`

In `solveDcOperatingPoint()`, replace the sequential gmin calls (lines ~312-365) with a selector:

```typescript
// ngspice cktop.c:57-60: select ONE gmin method (mutually exclusive)
const numGminSteps = params.numGminSteps ?? 1;
let gminResult: StepResult;
if (numGminSteps <= 1) {
  gminResult = dynamicGmin(nrBase, elements, params, diagnostics, statePool, matrixSize, onPhaseBegin, onPhaseEnd);
} else {
  gminResult = spice3Gmin(nrBase, elements, params, diagnostics, statePool, matrixSize, onPhaseBegin, onPhaseEnd);
}
totalIterations += gminResult.iterations;

if (gminResult.converged) {
  // ... emit diagnostic, return result (same as existing) ...
}
```

Remove the second gmin call that currently runs spice3Gmin after dynamicGmin.

Add `spice3Src` function for uniform linear source stepping:

```typescript
/**
 * spice3 source stepping (cktop.c:583-628).
 * Uniform linear source ramp with no backtracking.
 */
function spice3Src(
  nrBase: NrBase,
  elements: readonly AnalogElement[],
  params: SimulationParams,
  _diagnostics: DiagnosticCollector,
  statePool: { state0: Float64Array; reset(): void } | null | undefined,
  matrixSize: number,
  onPhaseBegin?: PhaseBeginFn,
  onPhaseEnd?: PhaseEndFn,
): StepResult {
  const voltages = new Float64Array(matrixSize);
  zeroState(voltages, statePool);
  let totalIter = 0;
  const numSrcSteps = params.numSrcSteps ?? 1;

  // ngspice cktop.c:590-620: uniform ramp i=0..numSrcSteps
  for (let i = 0; i <= numSrcSteps; i++) {
    const srcFact = i / numSrcSteps;
    scaleAllSources(elements, srcFact);
    onPhaseBegin?.("dcopSrcSweep", srcFact);
    const result = newtonRaphson({
      ...nrBase,
      maxIterations: params.dcTrcvMaxIter,
      elements,
      initialGuess: voltages,
    });
    totalIter += result.iterations;
    if (!result.converged) {
      onPhaseEnd?.("nrFailedRetry", false);
      scaleAllSources(elements, 1);
      return { converged: false, iterations: totalIter, voltages: new Float64Array(matrixSize) };
    }
    onPhaseEnd?.("dcopSubSolveConverged", true);
    voltages.set(result.voltages);
  }

  scaleAllSources(elements, 1);

  // Final clean solve
  onPhaseBegin?.("dcopSrcSweep", 1);
  const cleanResult = newtonRaphson({
    ...nrBase,
    maxIterations: params.maxIterations,
    elements,
    initialGuess: voltages,
  });
  totalIter += cleanResult.iterations;
  onPhaseEnd?.(cleanResult.converged ? "accepted" : "finalFailure", cleanResult.converged);

  return cleanResult.converged
    ? { converged: true, iterations: totalIter, voltages: cleanResult.voltages }
    : { converged: false, iterations: totalIter, voltages: new Float64Array(matrixSize) };
}
```

Select source-stepping method:
```typescript
// ngspice cktop.c:66-75: select ONE source-stepping method
const numSrcSteps = params.numSrcSteps ?? 1;
let srcResult: StepResult;
if (numSrcSteps <= 1) {
  srcResult = gillespieSrc(nrBase, elements, params, diagnostics, statePool, matrixSize, onPhaseBegin, onPhaseEnd);
} else {
  srcResult = spice3Src(nrBase, elements, params, diagnostics, statePool, matrixSize, onPhaseBegin, onPhaseEnd);
}
```

### Change 12: gillespieSrc gmin bootstrap off-by-one

**What:** Change the gmin bootstrap loop from 10 to 11 iterations.

**File:** `src/solver/analog/dc-operating-point.ts`, line ~699

```typescript
// BEFORE:
for (let decade = 0; decade < 10; decade++) {

// AFTER:
// ngspice cktop.c:416: for (i = 0; i <= 10; i++) = 11 iterations
for (let decade = 0; decade <= 10; decade++) {
```

### Change 13: Missing gshunt in dynamicGmin target

**What:** Use `Math.max(gmin, gshunt)` as the target in dynamicGmin.

**File:** `src/core/analog-engine-interface.ts`

Add to `SimulationParams`:
```typescript
/** Shunt conductance applied to all nodes (S). ngspice: CKTgshunt. Default 0. */
gshunt?: number;
```

**File:** `src/solver/analog/dc-operating-point.ts`, line ~479

```typescript
// BEFORE:
const gtarget = params.gmin;

// AFTER:
// ngspice cktop.c:148-157: gtarget = MAX(CKTgmin, CKTgshunt)
const gtarget = Math.max(params.gmin, params.gshunt ?? 0);
```

### Testing Strategy -- Wave 4

1. Test the mutually exclusive selector: verify `numGminSteps=1` runs only dynamicGmin, `numGminSteps=10` runs only spice3Gmin.
2. Test the off-by-one fix: a circuit that needed 11 bootstrap decades should now converge.
3. Test `spice3Src` with a circuit that needs source stepping.
4. Regression: Run DCOP convergence tests.

### Risk Assessment -- Wave 4

- **Mutual exclusion:** If a circuit relied on the sequential gmin+spice3 behavior, it may fail with the new selector. This is a correctness fix -- the old behavior was never valid ngspice behavior.
- **gshunt:** Default 0 matches ngspice's default (`CKTgshunt = 0`).

---

## Wave 5 — Sparse Solver

**Changes:** 14, 15
**Files:** `src/solver/analog/sparse-solver.ts`, `src/solver/analog/newton-raphson.ts`
**Dependencies:** None
**Risk:** High -- changes pivot selection; can cause singular-matrix failures in previously-working circuits

### Change 14: Mode-driven matrix reorder

**What:** Add `forceReorder()` method to `SparseSolver` and call it at mode transitions.

**File:** `src/solver/analog/sparse-solver.ts`

1. Add flag and method:
```typescript
private _needsReorder: boolean = false;

/**
 * Force full symbolic reorder on next factor() call.
 * ngspice: NISHOULDREORDER trigger (niiter.c:858, 861-880).
 */
forceReorder(): void {
  this._needsReorder = true;
}
```

2. In `factor()`, check the flag early and force full refactorization:
```typescript
// At the top of factor():
if (this._needsReorder) {
  this._needsReorder = false;
  // Invalidate cached symbolic analysis so it reruns
  this._amdPerm = null;  // or equivalent invalidation
}
```

**File:** `src/solver/analog/newton-raphson.ts`

Call `forceReorder()` at mode transitions:

In the DCOP ladder mode transitions (line ~649-688):
```typescript
// initJct -> initFix: force reorder (niiter.c:1065)
if (curMode === "initJct" && nextMode === "initFix") {
  opts.solver.forceReorder();
}
```

In the transient mode transitions (after Change 2's block):
```typescript
// initTran iter 0 (DCOP->transient boundary): force reorder (niiter.c:1073)
if (!ladder && opts.statePool) {
  const pool = opts.statePool as { initMode: string };
  if (pool.initMode === "initTran" && iteration === 0) {
    opts.solver.forceReorder();
    pool.initMode = "initFloat";
  }
}
```

### Change 15: Pivot threshold and AbsThreshold

**What:** Fix the structurally dead pivot threshold check, correct the threshold value, and add AbsThreshold.

**File:** `src/solver/analog/sparse-solver.ts`

1. Change constants (line ~29):
```typescript
// BEFORE:
const PIVOT_THRESHOLD = 0.01;

// AFTER:
// ngspice spconfig.h:331: DEFAULT_THRESHOLD = 1e-3
const PIVOT_THRESHOLD = 1e-3;
// ngspice cktinit.c:66-67: CKTpivotAbsTol = 1e-13
const PIVOT_ABS_THRESHOLD = 1e-13;
```

2. Fix the structurally dead threshold check (line ~945-968). The fix applies threshold DURING the search, filtering candidates before selecting the best:

```typescript
// Step 3: PARTIAL PIVOT -- find best |x[i]| among unpivoted rows
// Apply RelThreshold and AbsThreshold DURING search (ngspice spfactor.c:219)

// First pass: find absolute maximum among unpivoted rows (for relative threshold)
let absMax = 0;
for (let idx = 0; idx < xNzCount; idx++) {
  const i = xNzIdx[idx];
  if (pinv[i] >= 0) continue;  // already pivoted
  const v = Math.abs(x[i]);
  if (v > absMax) absMax = v;
}

if (absMax === 0) {
  // All unpivoted entries are zero -- singular
  for (let idx = 0; idx < xNzCount; idx++) x[xNzIdx[idx]] = 0;
  return { success: false, singularRow: k };
}

const relThreshold = PIVOT_THRESHOLD * absMax;

// Second pass: among candidates meeting BOTH thresholds, pick largest
let maxVal = 0;
let pivotRow = -1;
for (let idx = 0; idx < xNzCount; idx++) {
  const i = xNzIdx[idx];
  if (pinv[i] >= 0) continue;
  if (x[i] === 0) continue;
  const v = Math.abs(x[i]);
  if (v < relThreshold || v < PIVOT_ABS_THRESHOLD) continue;
  if (v > maxVal) { maxVal = v; pivotRow = i; }
}

// Fallback: if no candidate met threshold, accept largest anyway
// (ngspice spSMALL_PIVOT warning path)
if (pivotRow < 0) {
  maxVal = 0;
  for (let idx = 0; idx < xNzCount; idx++) {
    const i = xNzIdx[idx];
    if (pinv[i] >= 0) continue;
    const v = Math.abs(x[i]);
    if (v > maxVal) { maxVal = v; pivotRow = i; }
  }
}
```

### Testing Strategy -- Wave 5

1. Test with known near-singular circuits (two voltage sources with 1uV difference).
2. Verify pivot selection rejects weak candidates and falls back correctly.
3. Harness comparison: matrices from same circuit should produce compatible pivots.
4. Regression: full test suite -- watch for any new singular-matrix errors.

### Risk Assessment -- Wave 5

- **High risk:** Pivot changes affect every circuit. The AbsThreshold (1e-13) could reject pivots that were previously accepted. The fallback path handles this.
- **Reorder triggers:** Extra symbolic reorders add O(nnz log nnz) cost. Fires once at DCOP and once at transient start -- negligible.

---

## Wave 6 — MOSFET Correctness

**Changes:** 16, 17, 18, 26, 27, 28
**Files:** `src/components/semiconductors/mosfet.ts`, `src/solver/analog/fet-base.ts`
**Dependencies:** None
**Risk:** Medium -- changes I-V and convergence behavior; PMOS circuits will produce different results

### Change 16: PMOS temperature scaling -- missing type multiplier on tVbi/tVto

**File:** `src/components/semiconductors/mosfet.ts`, lines ~999-1002

```typescript
// BEFORE:
this._tVbi = p.VTO - (p.GAMMA * Math.sqrt(p.PHI))
  + 0.5 * (egfet1 - egfet)
  + 0.5 * (this._tPhi - p.PHI);
this._tVto = this._tVbi + p.GAMMA * Math.sqrt(this._tPhi);

// AFTER:
// ngspice mos1temp.c:170-176: type multiplier on gamma and delta-phi terms
const type = this.polaritySign;  // +1 for NMOS, -1 for PMOS
this._tVbi = p.VTO - type * (p.GAMMA * Math.sqrt(p.PHI))
  + 0.5 * (egfet1 - egfet)
  + type * 0.5 * (this._tPhi - p.PHI);
this._tVto = this._tVbi + type * p.GAMMA * Math.sqrt(this._tPhi);
```

### Change 17: MOSFET convergence check -- remove cqbd from cd

**File:** `src/solver/analog/fet-base.ts`, lines ~481-484

```typescript
// BEFORE:
const cd = mode * ids - cbdI;
const cqbd = s0[base + SLOT_CAP_IEQ_DB];
const cdFinal = cd - cqbd;

// AFTER:
// ngspice mos1conv.c:36: cd = mode * cdrain - cbd (no cap companion current)
const cdFinal = mode * ids - cbdI;
```

### Change 18: MOSFET gm/gds return 0 in cutoff (not GMIN)

**File:** `src/components/semiconductors/mosfet.ts`

In `computeGm()` (line ~583-584):
```typescript
// BEFORE:
if (vgst <= 0) return GMIN;

// AFTER:
// ngspice mos1load.c:520-521: gm=0 in cutoff
if (vgst <= 0) return 0;
```

In `computeGds()` (line ~630-631):
```typescript
// BEFORE:
if (vgst <= 0) return GMIN;

// AFTER:
// ngspice mos1load.c:520: gds=0 in cutoff
if (vgst <= 0) return 0;
```

### Change 26: MOSFET MAX_EXP_ARG cap at 709.78 instead of 80

**File:** `src/components/semiconductors/mosfet.ts`, lines ~1319, 1330

```typescript
// BEFORE:
const evbs = Math.exp(Math.min(vbs / VT, 80));

// AFTER:
// ngspice: MAX_EXP_ARG = ln(DBL_MAX) ~ 709.78
const MAX_EXP_ARG = 709.78;
const evbs = Math.exp(Math.min(vbs / VT, MAX_EXP_ARG));
```

Apply same change to `evbd`.

### Change 27: Missing MOSFET multiplicity parameter `m`

Add `M` parameter (default 1). Apply scaling:
- `DrainSatCur *= m`, `SourceSatCur *= m`
- `Beta *= m`
- Overlap caps `CGDO, CGSO, CGBO` scaled by `m`

### Change 28: Permittivity constant epsilon_0

**File:** `src/components/semiconductors/mosfet.ts`

```typescript
// BEFORE:
const EPS0 = 8.854187817e-12;

// AFTER:
// ngspice const.h: 8.854214871e-12 (for bit-exact match)
const EPS0 = 8.854214871e-12;
```

### Testing Strategy -- Wave 6

1. PMOS temperature test at T != TNOM. Compare Vth against ngspice.
2. Cutoff gm/gds test: MOSFET in cutoff has gm=0, gds=0.
3. Convergence test without cqbd.
4. Harness comparison on MOSFET inverter circuit.

---

## Wave 7 — Device INITF Modes

**Changes:** 19, 20, 21, 22, 23
**Files:** `src/components/semiconductors/bjt.ts`, `src/components/semiconductors/mosfet.ts`, `src/components/semiconductors/diode.ts`, `src/components/passives/capacitor.ts`, `src/components/passives/inductor.ts`
**Dependencies:** Wave 2 (initTran/initPred modes must exist)
**Risk:** Medium -- changes device behavior during mode transitions

### Change 19: MODEINITPRED -- device-level scalar copies

During `initPred` mode, devices copy operating-point scalars from state1 -> state0 before recomputation.

**BJT:** In `updateOperatingPoint`, at the very top:
```typescript
if (pool.initMode === "initPred") {
  s0[base + SLOT_VBE]  = s1[base + SLOT_VBE];
  s0[base + SLOT_VBC]  = s1[base + SLOT_VBC];
  s0[base + SLOT_IC]   = s1[base + SLOT_IC];
  s0[base + SLOT_IB]   = s1[base + SLOT_IB];
  s0[base + SLOT_GPI]  = s1[base + SLOT_GPI];
  s0[base + SLOT_GMU]  = s1[base + SLOT_GMU];
  s0[base + SLOT_GM]   = s1[base + SLOT_GM];
  s0[base + SLOT_GO]   = s1[base + SLOT_GO];
}
```

**MOSFET:** Similar pattern with MOSFET-specific slots (VBS, VBD, VON, IDS, GM, GDS, GMBS, GBD, GBS, etc.)

**Diode:** Copy SLOT_VD, SLOT_ID, SLOT_GEQ.

### Change 20: Cap/Inductor MODEINITPRED -- charge/flux from last accepted

**Capacitor** in `stampCompanion`:
```typescript
const isInitPred = this._pool && this._pool.initMode === "initPred";
const q0 = isInitPred ? this.s1[this.base + SLOT_Q] : this.C * vNow;
```

**Inductor** in `stampCompanion`:
```typescript
const isInitPred = this._pool && this._pool.initMode === "initPred";
const phi0 = isInitPred ? this.s1[this.base + SLOT_PHI] : this.L * iNow;
```

### Change 21: MOSFET MODEINITJCT -- non-zero startup voltages

Add `primeJunctions` to MOSFET: `vbs = -1`, `vgs = tVto`, `vds = 0`.

### Change 22: Missing device `off` parameter

Add `OFF` boolean to BJT, Diode, MOSFET. When set:
- `primeJunctions`: all junctions at 0V
- `checkConvergence` during initFix: always return true (suppress noncon)

### Change 23: Missing UIC initial conditions

Add IC parameters (ICVBE/ICVCE for BJT, IC for Diode). Apply in `primeJunctions` when `pool.uic === true`.

### Testing Strategy -- Wave 7

1. MOSFET primeJunctions test: verify DCOP starts with correct voltages.
2. initPred charge test: run capacitor circuit, verify q0 source on step 2.
3. OFF device test: BJT with OFF=true converges at 0V junctions.

---

## Wave 8 — NR/Acceptance Mechanics

**Changes:** 24, 25, 29
**Files:** `src/solver/analog/analog-engine.ts`, `src/solver/analog/newton-raphson.ts`, source components
**Dependencies:** Wave 2

### Change 24: _prevVoltages verification only

Verify that device `checkConvergence` uses the NR-loop-provided `prevVoltages` parameter (per-iterate), not a stale reference. The NR loop already does `prevVoltages.set(voltages)` at the top of every iteration. **No code change expected.**

### Change 25: Source breakpoint scheduling after acceptance

Add `acceptStep?(simTime, addBreakpoint)` to `AnalogElement` interface. Call from acceptance block. Implement for PULSE and PWL sources — schedule next waveform edge via `this._timestep.addBreakpoint(t)`.

### Change 29: Predictor default OFF

Gate `computeAgp()` + `predictVoltages()` behind `params.predictor ?? false`:

```typescript
if (this._stepCount > 0 && (this._params.predictor ?? false)) {
  computeAgp(...);
  predictVoltages(...);
}
```

### Testing Strategy -- Wave 8

1. Predictor OFF: verify NR uses last converged solution.
2. PULSE breakpoint: verify edges are hit precisely.
3. Regression with predictor OFF default.

---

## Wave 9 — Device Parameters

**Changes:** 30, 38, 39, 40, 41
**Files:** `src/components/passives/inductor.ts`, `src/components/passives/capacitor.ts`
**Dependencies:** None

### Change 30: Inductor SLOT_VOLT

Add `VOLT` state slot. Store terminal voltage in `stampCompanion`. Engine bulk copy handles s0->s1.

### Change 38: Cap/Ind IC initial conditions

Add `IC` parameter (NaN default). Under initTran + UIC, set `q0 = C * IC` (cap) or `phi0 = L * IC` (ind).

### Change 39: Cap/Ind temperature coefficients

Add TC1, TC2, TNOM, SCALE parameters. Apply `factor = 1 + TC1*dT + TC2*dT^2; effective = nominal * factor * SCALE`.

### Change 40: Cap/Ind multiplicity `m`

Add `M` parameter (default 1). Cap: `C_eff = C * M`. Ind: `L_eff = L / M`.

### ~~Change 41~~ — REMOVED (verified correct)

Our `CoupledInductorPair` (`src/solver/analog/coupled-inductor.ts`) and `Transformer` (`src/components/passives/transformer.ts`) match ngspice's K element exactly. Verified: M computation, self/mutual coefficients, off-diagonal stamp pattern, TRAP/BDF-2 history, INITF mode handling. No changes needed.

---

## Wave 10 — Diode Correctness

**Changes:** 31, 32, 33, 34
**Files:** `src/components/semiconductors/diode.ts`
**Dependencies:** None

### Change 31: Temperature scaling

Implement `dioTemp()` function scaling IS (via EG/XTI), VJ (via pbfact), CJO (via capfact), and make VT = kT/q temperature-dependent. Replace all `params.IS`/`params.VJ`/`params.CJO` with temperature-adjusted values.

### Change 32: IBV knee iteration

Newton-iterate (25 steps) to find effective BV: `xbv = BV - vt*log(1 + cbv/IS)`.

### Change 33: IKF/IKR

Add parameters. After computing gd, apply high-injection correction: `gd /= sqrt(1 + id/ikf) * (1 + sqrt(1 + id/ikf))`.

### Change 34: Area scaling

Add `AREA` parameter (default 1). Scale: `IS *= AREA`, `RS /= AREA`, `CJO *= AREA`.

---

## Wave 11 — Varactor Correctness

**Changes:** 35, 36, 37
**Files:** `src/components/semiconductors/varactor.ts`
**Dependencies:** None

### Change 35: Use `computeJunctionCharge` instead of `Cj * vNow`.

### Change 36: Use `computeJunctionCapacitance` (with FC linearization) instead of custom formula.

### Change 37: Add TT parameter; `Ctotal = Cj + TT * gd`.

---

## Wave 12 — Zener Simplified Model

**Change:** 42
**Files:** `src/components/semiconductors/zener.ts`
**Dependencies:** None

Fix breakdown amplitude (IS not IBV), add breakdown pnjlim, add NBV parameter.

---

## Appendix A: Variable Mapping Tables

### StatePool.initMode <-> ngspice CKTmode bits

| Our initMode | ngspice CKTmode bits | When |
|---|---|---|
| `"initJct"` | MODEINITJCT | DCOP iteration 0 |
| `"initFix"` | MODEINITFIX | DCOP after iter 0 |
| `"initFloat"` | MODEINITFLOAT | DCOP after noncon=0 in initFix; transient after mode transition |
| `"initTran"` | MODEINITTRAN | First transient step (step 0) |
| `"initPred"` | MODEINITPRED | Subsequent transient steps (step 1+) |
| `"transient"` | MODETRAN (no INITF) | After initFloat converges in transient |

### TimestepController._deltaOld <-> ngspice CKTdeltaOld

| Our index | ngspice index | Meaning |
|---|---|---|
| `_deltaOld[0]` | `CKTdeltaOld[0]` | Current trial dt |
| `_deltaOld[1]` | `CKTdeltaOld[1]` | h_{n-1} (previous accepted) |
| `_deltaOld[2]` | `CKTdeltaOld[2]` | h_{n-2} |
| `_deltaOld[3]` | `CKTdeltaOld[3]` | h_{n-3} |
| `_deltaOld[4]` | `CKTdeltaOld[4]` | h_{n-4} |
| `_deltaOld[5]` | `CKTdeltaOld[5]` | h_{n-5} |
| `_deltaOld[6]` | `CKTdeltaOld[6]` | h_{n-6} |

### MOSFET Temperature Variables

| ngspice (mos1temp.c) | Our variable | File:line |
|---|---|---|
| `here->MOS1tTransconductance` | `this._tTransconductance` | mosfet.ts:992 |
| `here->MOS1tPhi` | `this._tPhi` | mosfet.ts:996 |
| `here->MOS1tVbi` | `this._tVbi` | mosfet.ts:999 |
| `here->MOS1tVto` | `this._tVto` | mosfet.ts:1002 |
| `here->MOS1type` | `this.polaritySign` | mosfet.ts (class field) |
| `here->MOS1tSatCur` | `this._tSatCur` | mosfet.ts:1006 |
| `here->MOS1drainSatCur` | `this._drainSatCur` | mosfet.ts:1030 |
| `here->MOS1sourceSatCur` | `this._sourceSatCur` | mosfet.ts:1031 |

### Diode Temperature Variables

| ngspice (diotemp.c) | Our variable | Description |
|---|---|---|
| `here->DIOtSatCur` | `tIS` | Temperature-scaled saturation current |
| `here->DIOtJctPot` | `tVJ` | Temperature-scaled junction potential |
| `here->DIOtJctCap` | `tCJO` | Temperature-scaled zero-bias cap |
| `here->DIOtVcrit` | `tVcrit` | Critical voltage for pnjlim |
| `here->DIOtBrkdwnV` | `tBV` | Effective breakdown voltage (after knee iteration) |

---

## Appendix B: SimulationParams Additions

All additions to `SimulationParams` (file: `src/core/analog-engine-interface.ts`):

```typescript
interface SimulationParams {
  // ... existing params ...

  /** Shunt conductance (S). ngspice: CKTgshunt. Default 0. */
  gshunt?: number;

  /** Number of gmin stepping levels. 1 = dynamic (default), >1 = spice3. */
  numGminSteps?: number;

  /** Number of source stepping levels. 0 or 1 = gillespie (default), >1 = spice3. */
  numSrcSteps?: number;

  /** Enable voltage predictor. ngspice: #ifdef PREDICTOR. Default false. */
  predictor?: boolean;

  /** Use Initial Conditions mode. ngspice: MODEUIC. Default false. */
  uic?: boolean;
}
```

These parameters are required for ngspice-correct behavior. Default values match ngspice's defaults (not chosen for backward compatibility with our old behavior).

---

## Appendix C: Summary Change Index

| # | Wave | File(s) | One-line description |
|---|---|---|---|
| 1 | 1 | analog-engine.ts | Add `_firsttime` flag |
| 2 | 2 | newton-raphson.ts, state-pool.ts | Transient mode automaton (initTran/initPred) |
| 3 | 1 | analog-engine.ts | First step skips LTE |
| 4 | 1 | analog-engine.ts | NR failure re-arms initTran when firsttime |
| 5 | 1 | analog-engine.ts | Post-NIiter unconditional initPred set |
| 6 | 2 | newton-raphson.ts | iterno==1 forced noncon=1 |
| 7 | 1 | analog-engine.ts | State2/3 seed after NIiter (not at acceptance) |
| 8 | 3 | timestep.ts | deltaOld ring 4 to 7 slots |
| 9 | 2 | bjt.ts, mosfet.ts, capacitor.ts, inductor.ts | tranStep to initMode migration |
| 10 | 4 | dc-operating-point.ts | DCOP fallback initMode reset per level |
| 11 | 4 | dc-operating-point.ts | Mutually exclusive gmin methods + spice3Src |
| 12 | 4 | dc-operating-point.ts | gillespieSrc bootstrap off-by-one fix |
| 13 | 4 | dc-operating-point.ts | gshunt in dynamicGmin target |
| 14 | 5 | sparse-solver.ts, newton-raphson.ts | Mode-driven matrix reorder |
| 15 | 5 | sparse-solver.ts | Pivot threshold fix + AbsThreshold |
| 16 | 6 | mosfet.ts | PMOS type multiplier on tVbi/tVto |
| 17 | 6 | fet-base.ts | Remove cqbd from convergence cd |
| 18 | 6 | mosfet.ts | gm/gds = 0 in cutoff (not GMIN) |
| 19 | 7 | bjt.ts, mosfet.ts, diode.ts | initPred scalar copies state1 to state0 |
| 20 | 7 | capacitor.ts, inductor.ts | initPred charge/flux from state1 |
| 21 | 7 | mosfet.ts | MOSFET primeJunctions |
| 22 | 7 | bjt.ts, diode.ts, mosfet.ts | Device `off` parameter |
| 23 | 7 | bjt.ts, diode.ts | UIC initial conditions |
| 24 | 8 | (verify only) | Per-iterate prevVoltages (already correct) |
| 25 | 8 | analog-engine.ts, source components | Source breakpoint scheduling |
| 26 | 6 | mosfet.ts | MAX_EXP_ARG 80 to 709.78 |
| 27 | 6 | mosfet.ts | MOSFET multiplicity m |
| 28 | 6 | mosfet.ts | Permittivity epsilon_0 constant |
| 29 | 8 | analog-engine.ts | Predictor default OFF |
| 30 | 9 | inductor.ts | INDvolt state slot |
| 31 | 10 | diode.ts | Temperature scaling (IS, VJ, CJO, VT) |
| 32 | 10 | diode.ts | IBV knee self-consistent iteration |
| 33 | 10 | diode.ts | IKF/IKR high-injection knee correction |
| 34 | 10 | diode.ts | Area/perimeter scaling |
| 35 | 11 | varactor.ts | Proper charge integration (use computeJunctionCharge) |
| 36 | 11 | varactor.ts | FC forward-bias linearization (use computeJunctionCapacitance) |
| 37 | 11 | varactor.ts | TT diffusion charge term |
| 38 | 9 | capacitor.ts, inductor.ts | IC initial conditions |
| 39 | 9 | capacitor.ts, inductor.ts | Temperature coefficients (TC1/TC2) |
| 40 | 9 | capacitor.ts, inductor.ts | Multiplicity m |
| 41 | — | — | ~~REMOVED~~ — verified correct, no changes needed |
| 42 | 12 | zener.ts | Simplified model: IS amplitude, breakdown pnjlim, NBV |
