# E2E Fix Plan — Continuation Session

## Current State (end of session 2025-04-01)

**476/482 tests passed before this session. After changes: ~478 pass, 4 remain.**

### Changes already committed (in working tree, not git-committed):

#### Production code changes:
1. **`src/app/simulation-controller.ts`** — Render loop: removed unconditional `facade.step()` before the `simTimeGoal` check. Now only steps inside the while loop when `simTime < simTimeGoal`. `else` branch handles digital-only (simTimeGoal=null).
2. **`src/solver/coordinator.ts`** — Added `_simTimeTarget` field that accumulates `speed * wallDt` independently of simTime. `computeFrameSteps` returns this as `simTimeGoal` for analog circuits, `null` for digital-only. Removed sync in `start()`.

#### Test changes:
3. **`e2e/fixtures/ui-circuit-builder.ts`** — Rewrote `stepToTimeViaUI` to use custom time input with absolute semantics. Simplified `stepAndReadAnalog` to only accept SI strings. Added `formatSecondsAsSI` helper.
4. **Various test files** — Converted `stepAndReadAnalog(number)` calls to SI strings. Updated time targets for DC settling. Updated speed assertions from `*5` to `*100`.
5. **`e2e/gui/master-circuit-assembly.spec.ts`** — Added GA_Y Out component + wiring. Fixed trace target (R1.A→R3.A). Fixed comparator polarity. Updated absolute time targets.

### 4 Remaining Failures:

| # | Test | Symptom | Root Cause |
|---|------|---------|------------|
| 1 | Master 2 Phase D | `measureAnalogPeaks` returns peaks=0 | Scope panel `onStep` observer doesn't fire during `coordinator.stepToTime()` because simulation is paused before step-by |
| 2 | Master 2 Phase E | `setSpiceParameter` popup not visible | Scope panel opening shifts canvas coordinates; stale element positions |
| 3 | Master 3 Phase A | GA_Y always 0 | Analog→digital bridge not propagating comparator output during step-by (same root cause as #1) |
| 4 | Hotload BJT | Vc=12V (BJT off), diff=0 | Circuit reads Vc=12V in both states — BJT never conducts. Either CurrentSource polarity wrong or wiring issue. Separate from stepping. |

## Plan for Next Session

### Step 1: `stepClipped` on the analog engine

**Files:** `src/core/analog-engine-interface.ts`, `src/solver/analog/analog-engine.ts`

Add `stepClipped(maxTime: number): void` to `AnalogEngine` interface and implement it. The implementation is identical to `step()` except:

```
let dt = this._timestep.currentDt;
const remaining = maxTime - this._simTime;
if (remaining <= 0) return;
dt = Math.min(dt, remaining);
// ... rest of step() using this clipped dt
```

This takes a shorter step rather than overriding `currentDt`, preserving timestep controller history. The LTE computation, NR solve, history push all use the actual `dt` taken.

### Step 2: Wire `stepClipped` through coordinator

**File:** `src/solver/coordinator.ts`

Update `stepToTime()` to call `this._analog.stepClipped(targetSimTime)` instead of `this.step()`. This ensures `stepToTime` lands exactly at the target without overshoot.

Also update coordinator's own `step()` to optionally accept a maxTime and pass through to `_analog.stepClipped()` for the render loop's use (so the render loop can also land exactly on `_simTimeTarget`).

### Step 3: Delete the pause in `_executeStepBy`

**File:** `src/app/simulation-controller.ts`

Remove the line:
```js
if (coordinator.getState() === EngineState.RUNNING) pauseSimulation();
```

This means the render loop (and its scope panel observer notifications) keep running during step-by. The `stepToTime` yields via `setTimeout(0)` allow RAF ticks to fire, which:
- Update the scope panel (fixing failure #1)
- Render the canvas
- Advance `_simTimeTarget` naturally

After `stepToTime` completes, sync target:
```js
this._simTimeTarget = Math.max(this._simTimeTarget, coordinator.simTime ?? 0);
```

This prevents the render loop from stalling after a step-by that jumped ahead of the accumulated target. Expose a setter or method on the coordinator for this.


| File | Role |
|------|------|
| `src/solver/analog/analog-engine.ts:175` | `step()` — MNA transient step |
| `src/solver/coordinator.ts:180` | `step()` — dispatches to digital/analog/mixed |
| `src/solver/coordinator.ts:318` | `stepToTime()` — loop calling step() |
| `src/solver/coordinator.ts:412` | `computeFrameSteps()` — returns simTimeGoal |
| `src/app/simulation-controller.ts:634` | `_executeStepBy()` — step-by dropdown handler |
| `src/app/simulation-controller.ts:361` | `_startRenderLoop()` — RAF tick |
| `src/core/analog-engine-interface.ts:114` | `AnalogEngine` interface |
| `src/core/engine-interface.ts:226` | `Engine.step()` base interface |
| `e2e/fixtures/ui-circuit-builder.ts:727` | `stepToTimeViaUI()` — rewritten |
| `e2e/gui/master-circuit-assembly.spec.ts` | Master 2 & 3 tests |
| `e2e/gui/hotload-params-e2e.spec.ts:124` | BJT hotload test |
