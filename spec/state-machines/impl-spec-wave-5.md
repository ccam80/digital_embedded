# Wave 5 — Transient Loop Architecture (CRITICAL)

Implementation spec for items 5.1-5.8 from ALIGNMENT-DIFFS.md.

## Current Code Structure

File: `src/solver/analog/analog-engine.ts`, method `MNAEngine.step()`, lines 256-664.

Current transient loop:
```
1. prevVoltages.set(voltages)                          [line 310]
2. dt = timestep.getClampedDt(simTime)                 [line 313]
3. timestep.rotateDeltaOld()                           [line 340]
4. for(;;) retry loop:                                 [line 348]
   a. statePool.state0.set(statePool.state1)           [line 349]  <- DATA COPY
   b. timestep.setDeltaOldCurrent(dt)                  [line 352]
   c. simTime += dt                                    [line 355]
   d. NIpred (if enabled)                              [lines 370-376]
   e. stampCompanion for all reactive                  [lines 410-413]
   f. statePool.initMode = "initTran" (if firsttime)  [lines 406-408]
   g. NR solve                                         [lines 417-443]
   h. statePool.initMode = "initPred"                 [lines 445-447]
   i. firsttime state copy: s0->s1, seedFromState1    [lines 454-457]
   j. LTE / acceptance / rejection                    [lines 491-539]
5. statePool.acceptTimestep()  <- POINTER ROTATION     [lines 573-577]
6. Order promotion trial                               [lines 630-632]
```

## Target Code Structure

```typescript
step(): StepResult {
  prevVoltages.set(voltages);
  dt = timestep.getClampedDt(simTime);

  // Rotate deltaOld BEFORE entering loop (already correct)
  timestep.rotateDeltaOld();

  // NEW: Rotate state vectors BEFORE retry loop (ngspice dctran.c:715-723)
  // Pointer swap — s0 is fresh recycled storage, s1 = previous accepted
  statePool.rotateStateVectors();
  statePool.refreshElementRefs(elements);

  for (;;) {
    // On retry: only restore time. NO state0.set(state1).
    timestep.setDeltaOldCurrent(dt);
    simTime += dt;
    statePool.dt = dt;

    // NEW: Centralized NIcomCof (item 5.3)
    computeNIcomCof(dt, timestep.deltaOld, timestep.currentOrder,
                    timestep.currentMethod, statePool.ag);

    // Predictor
    if (stepCount > 0 && predictor) {
      computeAgp(...);
      predictVoltages(...);
    }

    // Companion stamp
    if (firsttime) statePool.initMode = "initTran";
    for (const el of elements) {
      if (el.isReactive && el.stampCompanion) {
        el.stampCompanion(dt, method, voltages, order, deltaOld);
      }
    }

    // NR solve
    nrResult = newtonRaphson(...);
    statePool.initMode = "initPred";

    // Firsttime state copy — AFTER mode transition (item 5.7)
    if (firsttime) {
      statePool.states[1].set(statePool.states[0]);
      statePool.seedFromState1();
    }

    // NR failure
    if (!nrResult.converged) {
      simTime -= dt;
      voltages.set(prevVoltages);
      dt /= 8;
      order = 1;
      if (firsttime) statePool.initMode = "initTran";
      if (dt < delmin) return ERROR;
      continue;  // retry — NO state restoration needed
    }

    // LTE check — with order promotion INSIDE (item 5.4)
    const lte = timestep.computeNewDt(...);
    // Try order promotion before accept/reject
    if (timestep.currentOrder === 1 && lte.newDt > 0.9 * dt) {
      timestep.tryOrderPromotion(...);
    }
    if (shouldReject(lte)) {
      simTime -= dt;
      voltages.set(prevVoltages);
      dt = lte.newDt;
      continue;  // retry — NO state restoration needed
    }

    break;  // accepted
  }

  // Acceptance — NO rotation here (already done before loop)
  statePool.tranStep++;
  // Push history, advance timestep, schedule breakpoints, etc.
}
```

## Key Changes

### 5.1 State rotation timing

**Remove:** `statePool.acceptTimestep()` call from post-acceptance (line 573-577)
**Remove:** `statePool.state0.set(statePool.state1)` at retry entry (line 349)
**Add:** `statePool.rotateStateVectors()` + `refreshElementRefs()` BEFORE retry loop

New `rotateStateVectors()` in `state-pool.ts`:
```typescript
rotateStateVectors(): void {
  const recycled = this.states[this.states.length - 1];
  for (let i = this.states.length - 1; i > 0; i--) {
    this.states[i] = this.states[i - 1];
  }
  this.states[0] = recycled;
  // NO s0.set(s1) — s0 is fresh, filled by CKTload during NR
}
```

### 5.3 Centralized NIcomCof

New function in `integration.ts`:
```typescript
export function computeNIcomCof(
  dt: number,
  deltaOld: readonly number[],
  order: number,
  method: IntegrationMethod,
  ag: Float64Array,
): void {
  if (dt <= 0) { ag.fill(0); return; }

  if (method === "trapezoidal") {
    if (order === 1) {
      ag[0] = 1 / dt;
      ag[1] = -1 / dt;
    } else {
      const xmu = 0.5;
      ag[0] = 1 / (dt * (1 - xmu));
      ag[1] = xmu / (1 - xmu);
    }
  } else if (method === "bdf2") {
    const h1 = deltaOld[1] > 0 ? deltaOld[1] : dt;
    const r1 = 1;
    const r2 = (dt + h1) / dt;
    const u22 = r2 * (r2 - r1);
    if (Math.abs(u22) < 1e-30) {
      ag[0] = 1 / dt;
      ag[1] = -1 / dt;
    } else {
      const rhs2 = r1 / dt;
      const ag2 = rhs2 / u22;
      ag[1] = (-1 / dt - r2 * ag2) / r1;
      ag[0] = -(ag[1] + ag2);
      ag[2] = ag2;
    }
  } else {
    // BDF-1
    ag[0] = 1 / dt;
    ag[1] = -1 / dt;
  }
}
```

Add `ag: Float64Array` field to `StatePool` (size 8 for future GEAR support).
Elements read `statePool.ag[0]` instead of computing `1/dt` locally.

### 5.4 LTE order promotion timing

**Move** `tryOrderPromotion()` from post-acceptance (line 630) to INSIDE the LTE check, before accept/reject.

### 5.7 State copy ordering

**Current:** seedHistory (state0->state1) happens before `analysisMode = "tran"` (line 817-823)
**Fix:** Reorder to: (1) set analysisMode, (2) zero ag[], (3) state0->state1 copy

### 5.8 ag[] zeroing at transition

At DCOP-to-transient transition:
```typescript
statePool.analysisMode = "tran";
statePool.ag[0] = 0;
statePool.ag[1] = 0;
statePool.states[1].set(statePool.states[0]);
```

## File-by-File Change List

### `src/solver/analog/analog-engine.ts`
- `step()`: restructure as above. Remove `acceptTimestep()` from acceptance. Move order promotion.
- Add `_ag: Float64Array` or use `statePool.ag`.
- Call `computeNIcomCof()` before companion stamping.
- DCOP result handling: reorder to ag-zero before state copy.

### `src/solver/analog/state-pool.ts`
- Rename/replace `acceptTimestep()` with `rotateStateVectors()` — pointer ring rotation WITHOUT s1->s0 copy.
- Add `ag: Float64Array` field (size 8).

### `src/solver/analog/integration.ts`
- Add `computeNIcomCof()` function.

### `src/solver/analog/timestep.ts`
- `tryOrderPromotion()` — no signature change, called from different location.

## ngspice Source Mapping

| ngspice | Ours |
|---|---|
| State rotation (dctran.c:715-723) | `statePool.rotateStateVectors()` before retry |
| NIcomCof (nicomcof.c) | `computeNIcomCof()` in integration.ts |
| CKTag[0]=CKTag[1]=0 (dctran.c:348) | `statePool.ag[0]=0; statePool.ag[1]=0` |
| state0->state1 (dctran.c:349-350) | `states[1].set(states[0])` AFTER ag zeroing |
| CKTtrunc order promotion | `tryOrderPromotion()` inside LTE check |

## Dependency Notes

- Depends on: Wave 1 (NR loop structure)
- Coordinate with Wave 2 (factorization)

## Test Impact

- `analog-engine.test.ts` — transient step behavior
- `state-pool.test.ts` — `rotateStateVectors` replaces `acceptTimestep`
- `integration.test.ts` — new `computeNIcomCof`
- `timestep.test.ts` — order promotion timing
- All harness comparison tests
