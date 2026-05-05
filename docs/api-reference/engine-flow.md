# Engine flow — DCOP and transient

> Generated 2026-05-05. Companion: `test-tools.md` (which API call returns X — this doc tells you when X exists).
> Source-of-truth files:
> - `src/solver/coordinator.ts:225-269,411-454,950-991` (coordinator entry points)
> - `src/solver/analog/analog-engine.ts:145-211,213-250,275-729,834-935,949-1006,1340-1490` (engine lifecycle, step, dcOperatingPoint, _transientDcop, _seedFromDcop)
> - `src/solver/analog/newton-raphson.ts:314-784` (NR loop A→K)
> - `src/solver/analog/dc-operating-point.ts:160-820` (DCOP three-level ladder)
> - `src/solver/analog/state-pool.ts:35-148` (state ring rotation, copyState1ToState23)
> - `src/solver/analog/__tests__/fixtures/build-fixture.ts:64-139` (warm-start contract)
> - `src/solver/analog/__tests__/harness/capture.ts:200-238` (captureElementStates layout)
> - `scripts/mcp/harness-tools.ts:280-650` (harness MCP surface)
> - `src/core/analog-engine-interface.ts:200-411` (AnalogEngine contract, DcOpResult)
> - `ref/ngspice/src/spicelib/analysis/dctran.c:117-360,500-1010` (ngspice transient firsttime + retry loop)
> - `ref/ngspice/src/spicelib/analysis/cktop.c:27-86` (CKTop three-level ladder)
> - `ref/ngspice/src/spicelib/analysis/dcop.c:21-180` (standalone .OP driver)

This document answers **"does X exist, when does it exist, what overwrites it?"** For "what API call returns X?", see `test-tools.md`.

## Table of contents

1. [Two flows, independent](#1-two-flows-independent)
2. [Flow A — DCOP (`coordinator.dcOperatingPoint()`)](#2-flow-a-dcop)
3. [Flow B — transient (`coordinator.step()`)](#3-flow-b-transient)
4. [NR iteration substructure (A→K)](#4-nr-iteration-substructure)
5. [Step-boundary observability](#5-step-boundary-observability)
6. [Between-phase invisibility (harness-only)](#6-between-phase-invisibility)
7. [Why DCOP is NOT a transient warm-up](#7-why-dcop-is-not-a-transient-warm-up)
8. [Question → answer-location cheat sheet](#8-cheat-sheet)

**Skim path** if you only need to know what's observable when: §5 + §6.
**Skim path** if you're debugging a "DCOP didn't seed transient" issue: §7.
**Skim path** for ngspice mirror citations: §2 (Flow A) + §3 (Flow B).

---

## 1. Two flows, independent

Two flows. **Independent**. They share data structures (`StatePool`, `MNAEngine.compiled`, the matrix/RHS, device internal states inside `CKTCircuitContext`) but they are not chained. A `coordinator.dcOperatingPoint()` call does not advance simulated time, does not run any `_transientDcop`, does not write `MODEINITTRAN`, does not touch the timestep controller's `currentDt`, and does not seed `state1` from `state0`. A `coordinator.step()` call does its own warm-start once on first invocation; that warm-start internally runs a DCOP-like solve via `_transientDcop()`, but it is NOT the same call path — they enter `solveDcOperatingPoint` with different `cktMode` analysis bits and different post-convergence finalisation.

| Path | cktMode at entry | Post-converge finalisation | Touches timestep | Seeds `state1`? |
|---|---|---|---|---|
| `dcOperatingPoint()` (Flow A) | `MODEDCOP \| MODEINITJCT` (`analog-engine.ts:867`) | `dcopFinalize(ctx)` runs `MODEINITSMSIG` cktLoad (`dc-operating-point.ts:250-254,355-357`) | No (`analog-engine.ts:868-876`) | No |
| `_transientDcop()` (Flow B warm-start) | `MODETRANOP \| MODEINITJCT` (`analog-engine.ts:980`) | `_seedFromDcop`: `MODETRAN \| MODEINITTRAN`, `ag[0]=ag[1]=0`, `state1.set(state0)` (`analog-engine.ts:1443-1490`) | Yes — writes `firstStep` to `_timestep.currentDt` (`analog-engine.ts:1002`) | Yes |

`solveDcOperatingPoint(ctx)` itself gates on `isTranOp(ctx.cktMode)` to decide whether to run `dcopFinalize` (`dc-operating-point.ts:355-357,390-392,428-430`). The standalone `.OP` path runs the smsig load; the transient-boot path skips it.

**Test-author rule**: never call `coordinator.dcOperatingPoint()` to "warm up" a transient. If your test wants a transient, call `coordinator.step()` (or use `buildFixture` which calls it for you). Calling `dcOperatingPoint()` first leaves the engine in a state that is either redundant or actively wrong for transient — see §7.

---

## 2. Flow A — DCOP

### A1. Coordinator entry → engine.dcOperatingPoint()

**Caller**: `coordinator.dcOperatingPoint()` at `coordinator.ts:450-454`.

**Runs in order**:
1. Return `null` if `_analog === null`.
2. Set `_analysisPhase = "dcop"`.
3. Delegate to `(this._analog as MNAEngine).dcOperatingPoint()`.

**Written**: `_analysisPhase` only.
**NOT written**: `_stepCount`, `_topLevelBridgeStates`, the digital engine, simTime, voltage tracking. Bridges are not stepped. `setSimTime` is NOT called.

### A2. Engine pre-solve setup

**Caller**: `MNAEngine.dcOperatingPoint()` at `analog-engine.ts:834-880`.

**Runs in order**:
1. Diagnostics cleared (`analog-engine.ts:846`).
2. Hooks (`postIterationHook`, `preFactorHook`, `detailedConvergence`, `limitingCollector`) copied from MNAEngine fields onto `ctx` (`analog-engine.ts:852-855`).
3. `ctx.nodesets` and `ctx.ics` populated from compiled circuit (`analog-engine.ts:856-857`).
4. `ctx.srcFact = 1` (`analog-engine.ts:865`).
5. `ctx.cktMode = (oldUicBit) | MODEDCOP | MODEINITJCT` — preserves only the UIC bit; replaces analysis and INITF bits entirely (`analog-engine.ts:866-867`). Mirrors `dcop.c:82` `(CKTmode & MODEUIC) | MODEDCOP | MODEINITJCT`.
6. `ctx.loadCtx.dt = 0` — mirrors ngspice `cktdojob.c:117` zeroing CKTdelta (`analog-engine.ts:876`). The timestep controller's `currentDt` is NOT touched.
7. `_setup()` runs once per circuit lifetime (`analog-engine.ts:877`, body at `analog-engine.ts:1340-1367`): allocates `StatePool`, walks elements in `NGSPICE_LOAD_ORDER` calling each `el.setup(setupCtx)`, freezes row buffers to `solver.matrixSize`, runs post-setup topology detectors.
8. Phase hooks `_onPhaseBegin` / `_onPhaseEnd` wired (`analog-engine.ts:878-879`).

**Written**: `ctx.cktMode`, `ctx.srcFact`, `ctx.loadCtx.dt`, `ctx.nodesets`, `ctx.ics`, `ctx.diagnostics`. First-call setup-phase fields (`_isSetup`, `_maxEqNum`, `_numStates`, `_nodeTable`, `_deviceMap`).
**NOT written**: `_simTime`, `_lastDt`, `_firstStep`, `_timestep.currentDt`, `_timestep.deltaOld`, `_timestep.currentOrder`, `_timestep.currentMethod`, `ctx.ag[0]/ag[1]`, `pool.state1`, `pool.state2..state7`, `ctx.rhs`, `ctx.rhsOld`. Anything that could imply a transient warm-up has been deliberately avoided.

### A3. NR loop — `solveDcOperatingPoint(ctx)` → ladder

**Caller**: `dc-operating-point.ts:308-491`.

**Three-level ladder**:

1. **Level 0** — direct NR via `cktop(ctx, MODEINITJCT, params.maxIterations, ladder)` (`dc-operating-point.ts:339-347`). On convergence: copy `ctx.rhs` into `ctx.dcopVoltages`, run `dcopFinalize(ctx)` because `!isTranOp(ctx.cktMode)`. Return.
2. **Level 1** — gmin stepping. `numGminSteps <= 1 → dynamicGmin` (`dc-operating-point.ts:509-587`); `> 1 → spice3Gmin` (`dc-operating-point.ts:602-647`). Both call `runNR` repeatedly with varying `diagonalGmin`. `dynamicGmin` does `zeroRhsOldAndState` once at entry and snapshots `dcopSavedVoltages`/`dcopSavedState0` for backtracking. On convergence: `dcopFinalize` (gated on `!isTranOp`).
3. **Level 2** — source stepping. `numSrcSteps <= 1 → gillespieSrc` (`dc-operating-point.ts:705-819`); `> 1 → spice3Src` (`dc-operating-point.ts:660-688`). Adaptive `srcFact` ramp 0 → 1 with snapshot/restore.

**All-level failure**: `cktncDump` writes per-node non-convergence diagnostics into `ctx.ncDumpScratch`, emits `dc-op-failed` diagnostic, sets `ctx.dcopResult.converged = false` and zeroes `ctx.dcopResult.nodeVoltages` (`dc-operating-point.ts:458-490`).

The same NR engine drives every DCOP sub-solve and every transient NR call. See §4 for the per-iteration A→K body.

### A4. Post-converge finalisation (standalone .OP only)

**Caller**: `dcopFinalize(ctx)` at `dc-operating-point.ts:250-254`, called from `solveDcOperatingPoint` at `dc-operating-point.ts:355,391,429`.
**Gate**: `!isTranOp(ctx.cktMode)` — only fires on standalone `.OP`.

**Runs in order**:
1. `ctx.cktMode = setInitf(ctx.cktMode, MODEINITSMSIG)`.
2. `cktLoad(ctx)` — single non-iterating load at the converged bias point. Re-evaluates each device's small-signal quantities (e.g. capacitor `geqcb`) into `state0`. Mirrors `dcop.c:127,153`.
3. `ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT)`.

**Written**: `ctx.cktMode` flips through INITSMSIG and back to INITFLOAT. `state0` device-specific small-signal slots may be updated.
**NOT written**: `state1`, `state2..state7`, `ag[0]`, `ag[1]`, `_timestep.currentDt`, `_simTime`. **Critically: nothing seeds the transient flow.**

### A5. Post-engine-call cleanup

**Caller**: `MNAEngine.dcOperatingPoint()` after `solveDcOperatingPoint` returns (`analog-engine.ts:881-934`).

**Runs in order** (only on `result.converged`):
1. `ctx.rhs.set(result.nodeVoltages)` — write converged voltages back into the live `rhs` buffer (`analog-engine.ts:923`).
2. For each element, call optional `el.initVoltages(rhs)` (`analog-engine.ts:924-929`).
3. `ctx.cktMode = (uic) | MODEDCOP | MODEINITSMSIG` (`analog-engine.ts:930-931`). Mirrors `dcop.c:127`.

**Committed**: `ctx.rhs`, `ctx.rhsOld` (via the NR pointer-swap exit invariant — see `newton-raphson.ts:336-342`); device caches refreshed by the smsig cktLoad. `result.nodeVoltages` is a stable Float64Array of length `matrixSize`.
**NOT committed**: `_simTime` unchanged. `_lastDt` unchanged. `_firstStep` unchanged. `_timestep.currentDt` unchanged. `pool.state1` unchanged (typically zero on a fresh engine). `pool.state2..state7` unchanged.

---

## 3. Flow B — transient

### B1. Coordinator entry

**Caller**: `coordinator.step()` at `coordinator.ts:225-269`.

**Runs in order**:
1. Capture `analogTimeBefore = this._analog?.simTime ?? 0`.
2. If analog backend present and phase was `"dcop"`, transition to `"tranInit"`.
3. Dispatch to one of `_stepMixed()` (digital + analog), `_digital.step()`, or `_analog.step()`.
4. Stagnation guard: if `_analog.simTime === analogTimeBefore`, throw.
5. Phase transition: if phase is `"tranInit"` and `_stepCount >= 1`, advance to `"tranFloat"`.
6. Increment `_stepCount`; notify observers.

**Written by coordinator itself**: `_analysisPhase`, `_stepCount`. (Bridge state mutations and analog `simTime` updates happen inside `_stepMixed()` / `_analog.step()`.)

### B2. Warm-start (only on first `step()`)

**Trigger**: first invocation of `coordinator.step()` after `compile()` (or `engine.reset()`/`init()`). Gated by `this._firstStep === false` at `analog-engine.ts:288-291`.

**Runs in order**:
1. `this._setup()` runs (`analog-engine.ts:277`) if not already done. Same body as A2.
2. `this._transientDcop()` at `analog-engine.ts:949-1006`:
   - Diagnostics cleared.
   - Hooks copied onto `ctx`.
   - `ctx.nodesets`, `ctx.ics` populated.
   - `ctx.srcFact = 1`.
   - `ctx.cktMode = (uicBit) | MODETRANOP | MODEINITJCT` (`analog-engine.ts:979-980`). Mirrors `dctran.c:190,231`. **`MODETRAN` is set, so `isTranOp(ctx.cktMode)` is true.**
   - `this._timestep.currentDt = 0` (`analog-engine.ts:986`). Mirrors `cktdojob.c:117`.
   - `ctx.loadCtx.dt = 0`.
   - Phase hooks wired.
   - `solveDcOperatingPoint(ctx)` — same three-level ladder as A3, BUT `dcopFinalize` is **skipped** at `dc-operating-point.ts:355,390,428` because `isTranOp(ctx.cktMode)` is true. The smsig cktLoad does NOT happen.
3. On convergence: `_seedFromDcop(result, elements, cac)` at `analog-engine.ts:994` (body `analog-engine.ts:1443-1490`). **Direct port of `dctran.c:346-350`**. Sequence:
   - `ctx.rhs.set(result.nodeVoltages)`.
   - `ctx.rhsOld.set(result.nodeVoltages)` — explicit mirror of ngspice's NR-pointer-swap implicit invariant. Without this, every internal node allocated by `ctx.makeVolt` reads zero from `rhsOld` at iter ≥ 1 of the first transient step.
   - For each element, call `el.initVoltages(rhs)` if defined.
   - `ctx.cktMode = uic | MODETRAN | MODEINITTRAN` (`analog-engine.ts:1476-1477`). Direct port of `dctran.c:346`.
   - `ctx.ag[0] = 0; ctx.ag[1] = 0`. Direct port of `dctran.c:348`.
   - `cac.statePool.states[1].set(cac.statePool.states[0])` (`analog-engine.ts:1488`). Direct port of `dctran.c:349-350` (`bcopy(CKTstate0, CKTstate1, numStates*sizeof(double))`).
   - `this._timestep.currentDt = this._params.firstStep` (`analog-engine.ts:1002`). Mirrors `dctran.c:319`.
4. `this._firstStep = true`. Subsequent `step()` calls skip the warm-start.

**Written**: `ctx.cktMode` (final value `MODETRAN | MODEINITTRAN`); `ctx.ag[0]`, `ctx.ag[1]`; `ctx.rhs`; `ctx.rhsOld`; `pool.state0` (whatever DCOP wrote); `pool.state1` (= `state0` after `_seedFromDcop`); `_timestep.currentDt = firstStep`; `_firstStep = true`.
**NOT written**: `_simTime` (still 0). `pool.state2..state7` are NOT seeded here — they're seeded inside the per-step retry loop on the firsttime block at `analog-engine.ts:548-550` (see B3). `_lastDt` still 0. `_timestep.deltaOld` still at construction-init values.

### B3. Per-step transient cycle

This runs on the first `step()` call AFTER `_transientDcop()` returns, and on every subsequent `step()` call.

**Caller**: `MNAEngine.step()` continuation at `analog-engine.ts:293-729`.

**Runs in order**:
1. **Top-of-step `acceptStep` dispatch** (`analog-engine.ts:357-363`): for each element with an `acceptStep` method, call `el.acceptStep(simTime, addBPTop, breakFlagTop)`. Mirrors ngspice `CKTaccept` at the head of `dctran.c:410 nextTime:`. PULSE/AC sources register their first breakpoint here.
2. `dt = this._timestep.getClampedDt(this._simTime)` (`analog-engine.ts:365`). Applies near-breakpoint clamps and method-specific bounds.
3. If `convergenceLog.enabled`: allocate `stepRec`.
4. `this._timestep.rotateDeltaOld()` (`analog-engine.ts:392`). Mirrors `dctran.c:704-706,715-717`.
5. **State vector rotation** (`analog-engine.ts:400-402`): `statePool.rotateStateVectors()`. Pointer swap mirroring `dctran.c:719-723`. After: `states[0]` is fresh recycled storage, `states[1]` holds the previously-accepted state. **NB**: this happens BEFORE the retry loop, so on the first transient step after `_seedFromDcop`, the rotation moves the seeded-from-DCOP `state0` into `state1` — producing exactly the `dctran.c:349-350` invariant.
6. **Retry loop** (`for (;;)` at `analog-engine.ts:404-677`). Each iteration is one NR attempt at the current `dt`:
   - `deltaOld[0] = dt` (`analog-engine.ts:406`). Mirrors `dctran.c:735`.
   - `_simTime += dt` (`analog-engine.ts:409`). Mirrors `dctran.c:731`. Publishes to `compiled.timeRef`.
   - **Predictor** (`analog-engine.ts:425-431`): gated on `_stepCount > 0 && params.predictor` — does NOT fire on step 0. `computeAgp` then `predictVoltages` writes `ctx.rhs` to the extrapolated NR initial guess. Mirrors `dctran.c:734,750`.
   - **Phase hook attempt-begin**: label is `tranInit` if `MODEINITTRAN`, `tranPredictor` if `MODEINITPRED`, else `tranNR`.
   - **NIcomCof** (`analog-engine.ts:455-462`): `statePool.dt = dt`; `computeNIcomCof(dt, deltaOld, order, method, ctx.ag, ctx.gearMatScratch)`. Writes `ctx.ag[]` integration coefficients. Mirrors `dctran.c:736`.
   - **NR setup**: `loadCtx.xfact = deltaOld[0]/deltaOld[1]`; `loadCtx.dt = dt`; `loadCtx.order = currentOrder`; `loadCtx.method = currentMethod`; `ctx.maxIterations = params.transientMaxIterations`.
   - **`newtonRaphson(ctx)`**. Same A→K body as DCOP (see §4). Mirrors `dctran.c:783`.
   - **MODEINITPRED write** (`analog-engine.ts:541`): `ctx.cktMode = (uic) | MODETRAN | MODEINITPRED` — fires unconditionally inside the retry loop, AFTER NIiter, BEFORE the converged/non-converged branch. Mirrors `dctran.c:794`.
   - **state2/state3 seed on step 0** (`analog-engine.ts:548-550`): if `_stepCount === 0 && statePool`, call `statePool.copyState1ToState23()`. Direct port of `dctran.c:795-799`. Width is `state2` and `state3` only — `state4..state7` are not touched.
   - **NR-failed branch**: rewind `_simTime -= dt`; `dt = dt/8`; `currentOrder = 1`; on `_stepCount === 0`, restore `cktMode |= MODEINITTRAN`. Mirrors `dctran.c:806-822`.
   - **NR-converged → LTE branch**:
     - On step 0 (firsttime), skip LTE and accept (`analog-engine.ts:604-609`). Mirrors `dctran.c:849-866`.
     - Otherwise compute LTE via `_timestep.computeNewDt(...)`.
     - Trial order promotion (`analog-engine.ts:625-627`). Mirrors `dctran.c:880-890`.
     - If `!_timestep.shouldReject(worstRatio)`: accept, `break`.
     - LTE rejected: `_simTime -= dt`; `dt = newDt`; continue.
   - **delmin two-strike check**: if `dt <= minTimeStep` and `olddelta <= minTimeStep`, emit `convergence-failed` diagnostic, transition to `EngineState.ERROR`, return. Mirrors `dctran.c:957-972`.
7. **Acceptance block** (`analog-engine.ts:680-728`):
   - `statePool.tranStep++`.
   - `ctx.nodeVoltageHistory.rotateNodeVoltages(ctx.rhs)` — push the accepted solution into the predictor history.
   - Record convergence log.
   - `compiled.timeRef.value = _simTime`.
   - `_lastDt = dt`.
   - `_timestep.currentDt = newDt`; `_timestep.markAccepted(_simTime)`. Promotes order if eligible.
   - `_stepCount++`; observers notified.

### B4. Per-attempt invisibility

After `coordinator.step()` returns, the following are gone unless the harness was capturing:

- `ctx.rhsOld` between iterations — `swapRhsBuffers()` rotates this every NR iteration. Only the final-iter input survives.
- The post-load, pre-LU matrix at iteration k — `solver.factor()` overwrites `_elVal[]` with LU at `newton-raphson.ts:465`.
- The pre-solve RHS at iteration k — `solver.solve()` overwrites `ctx.rhs` in place.
- `ctx.noncon`, `globalConverged`, `elemConverged`, `convergenceFailedElements`, `limitingEvents` per iteration.
- The retry loop's intermediate `dt` values across rejected attempts — recorded into `stepRec.attempts[].dt` when convergence-log is enabled, but the matrix/RHS state inside those rejected attempts is harness-only.
- `ag[]` integration coefficients written by `NIcomCof` for the current attempt's `dt`.
- The predictor's `agp[]` and the predicted initial-guess `rhs` written into `ctx.rhs` before the NR call.
- The state of `pool.state0` between NR iterations — elements may write into `state0` during their `load()` calls. Only the converged-iter values survive.

See §6 for which of these the harness can capture.

---

## 4. NR iteration substructure

The same NR engine drives every DCOP sub-solve and every transient NR call. Inside `newtonRaphson(ctx)` at `newton-raphson.ts:314-779`, each iteration runs steps A–K:

| Step | Line | What happens |
|---|---|---|
| A | `383-387` | `ctx.noncon = 0`; reset `ctx.limitingCollector` if non-null. |
| B | `393` | `cktLoad(ctx)` — reads `ctx.rhsOld` (iter k's input voltages), evaluates every element's `load()`, stamps the matrix and RHS into the solver. |
| B+ | `403` | `ctx.preFactorHook?.(ctx)` — the unique window where the assembled MNA holds post-load, pre-LU values. Mirrors ngspice `niiter.c:704-842 ni_instrument_cb`. |
| D | `409` | `solver.preorder()` — idempotent via `solver._didPreorder`. |
| B5/Reorder gate | `427-431` | If INITF is `MODEINITJCT` OR (`MODEINITTRAN` && `iteration === 0`), call `solver.forceReorder()`. |
| E | `463-465` | `solver.setPivotTolerances(...)`; `solver.factor(ctx.pivotAbsTol, ctx.diagonalGmin)`. On `spSINGULAR` from the reuse arm, force reorder and continue (mirrors `niiter.c:888-891`). |
| state0 snapshot | `498-504` | `oldState0.set(statePool.state0)` for damping. |
| F | `512` | `solver.solve(ctx.rhs, ctx.rhs)` — writes solve output into `ctx.rhs` in-place. |
| G | `517-524` | Iteration-limit check. |
| H | `526-614` | Convergence check. Computes `globalConverged` (per-row `delta = abs(rhs[i] - rhsOld[i])` against `reltol*max(...)+absTol`) and `elemConverged` (calls each element's `checkConvergence`). Mirrors `niiter.c:957-961`. |
| I | `617-641` | DCOP-only node damping: if `maxDelta > 10`, scale rhs and `state0` toward `rhsOld`/`oldState0` by `dampFactor = max(10/maxDelta, 0.1)`. |
| Blame tracking | `644-661` | |
| post-iter hook | `664-665` | `ctx.postIterationHook?.(...)` fires here with iteration index, voltages, noncon flag, convergence flags, limiting events. |
| J | `667-767` | INITF dispatcher: sequences `MODEINITJCT → MODEINITFIX → MODEINITFLOAT`. On `MODEINITFLOAT` converged exit, sets `nrResult.converged = true`, writes `nrResult.voltages = ctx.rhs`, returns. |
| onIter0Complete | `770-772` | Hook. |
| K | `778` | `ctx.swapRhsBuffers()` — pointer swap of `ctx.rhs`/`ctx.rhsOld` so iter k's solve output becomes iter k+1's input. Mirrors `niiter.c:1087-1090`. |

---

## 5. Step-boundary observability

A test can only observe values that exist at a step boundary, OR values explicitly exposed via the harness for per-NR-iteration data. If a test wants to observe X *between* two phases that are not exposed, the test must be redesigned (use a different observable at a step boundary) or deleted.

### Boundary 1 — after `coordinator.dcOperatingPoint()` returns

| Observable | Where to read |
|---|---|
| Did DCOP converge? | `result.converged` from `coordinator.dcOperatingPoint()`. |
| Which method converged? | `result.method` (`"direct"` / `"dynamic-gmin"` / `"spice3-gmin"` / `"gillespie-src"` / `"spice3-src"`). |
| Total NR iterations | `result.iterations`. |
| Final converged node voltage | `engine.getNodeVoltage(nodeId)` after the call returns. Equivalent: indexing into `result.nodeVoltages` directly. |
| Final branch current | `engine.getBranchCurrent(branchId)`. |
| Final element pin currents | `engine.getElementPinCurrents(elementIndex)` or `coordinator.readElementCurrent(elementIndex)`. |
| Final analysis phase | `coordinator.analysisPhase === "dcop"`. |
| Diagnostics emitted | `result.diagnostics` (in-band) or `coordinator.getRuntimeDiagnostics()`. |
| Convergence-log step record | After `setConvergenceLogEnabled(true)`, `coordinator.getConvergenceLog()`. DCOP records have `stepNumber: -1`. |
| Voltage limiting events | `coordinator.setLimitingCapture(true)` before the call; `coordinator.getLimitingEvents()` after. |
| `state0` slot values | `pool.state0[base + slotIndex]`. |
| `state1` slot values | All zero on a fresh engine. **DCOP does NOT write `state1`** — see §7. If a test asserts on `state1` after `dcOperatingPoint()`, the assertion is wrong. |
| Did `dcOperatingPoint()` advance simTime? | No. `coordinator.simTime` unchanged. `engine.simTime` unchanged. |

### Boundary 2 — after `coordinator.step()` returns

| Observable | Where to read |
|---|---|
| Did the step accept? | `coordinator.step()` does not throw and `coordinator.simTime` advanced. |
| Current sim time | `coordinator.simTime` or `engine.simTime`. |
| Last accepted dt | `engine.lastDt`. |
| LTE-proposed next dt | `engine.getLteNextDt()` (= `_timestep.currentDt`). |
| Current integration order/method | `engine.integrationOrder`, `engine.integrationMethod`. |
| Node voltage at the new time | `engine.getNodeVoltage(nodeId)` or `coordinator.readSignal({domain:"analog", nodeId})`. |
| Element current / power at the new time | `engine.getElementCurrent(idx)`, `coordinator.readElementCurrent(idx)`, `engine.getElementPower(idx)`. |
| Element state slots at the new time | `pool.state0[base + slotIndex]`. |
| Previous-step state (trapezoidal companion) | `pool.state1[base + slotIndex]`. **Not the DCOP-seeded zero** — the previous accepted transient step's state. On the first accepted step it IS the DCOP-seeded state. |
| `pool.state2`, `pool.state3` | Populated after first accepted step (firsttime `copyState1ToState23`); rotated thereafter up to `maxOrder+1`. |
| `analysisPhase` after step k | `"tranInit"` for `k=0`, `"tranFloat"` for `k>=1`. |
| Per-step `attempts[]` | `coordinator.getConvergenceLog()` after `setConvergenceLogEnabled(true)`. |
| Limiting events during the step | `setLimitingCapture(true)` before; `getLimitingEvents()` after. |
| Was a step rejected for LTE? | `coordinator.getConvergenceLog()` step record has `lteRejected: true` and `attempts[]` will include both the rejected and the retry attempt. |
| Did `_seedFromDcop` run? | Only on the first `coordinator.step()` after `compile()`/`reset()`. Indirectly observable: `engine.simTime > 0` after `step()` returns, and `pool.state1` equals what `state0` was at DCOP completion. |

---

## 6. Between-phase invisibility

Properties that exist only between phases — not at any step boundary. The only sanctioned route is the comparison harness via `ComparisonSession` or MCP `harness_*` tools (see `test-tools.md` §5).

| Property | Why no boundary | Only window |
|---|---|---|
| Matrix at NR iteration k (post-load, pre-LU) | `solver.factor()` overwrites `_elVal[]` with LU. | `harness_get_attempt(...).iterations[k].matrix`. |
| Pre-solve RHS at NR iteration k | `solver.solve()` overwrites `ctx.rhs` in place. | `harness_get_attempt(...).iterations[k].rhs` (paired with `prevRhs` for iter K-1 input). |
| `ctx.rhsOld` between iterations | `swapRhsBuffers()` rotates each iter; only final-iter input survives. | Harness iteration capture. |
| Predictor's `agp[]` for `tranPredictor` attempts | Overwritten by next iteration. | `harness_get_attempt`. |
| Intermediate `pool.state0` writes during element `load()` mid-iter | Re-written every iteration. | Harness iteration capture. |
| Per-iteration limiting events | Cleared at top of each iteration (`newton-raphson.ts:385-387`). | Harness `postIterationHook` (which captures into `iterations[k].limitingEvents`) OR `setLimitingCapture(true)` accumulating across the whole step. |
| `MODEINITPRED` cktMode bit | Written at `analog-engine.ts:541` after every NR call inside the retry loop, cleared by next NR call's STEP-J INITF dispatcher. | Harness-attached `nrModeLadder` callback. |
| `ag[]` coefficients per attempt | Read via `ctx.loadCtx.ag` during element `load()`; not exposed on `engine.*` after the step. | `harness_get_attempt(...).iterations[k].ag`. |

The harness pairs digiTS's MNA engine against an instrumented ngspice DLL on the same circuit and records every NR iteration on both sides. Tests that need any property in this section MUST use T2 (self-compare) or T3 (paired); see `test-tools.md` §4 / §5.

---

## 7. Why DCOP is NOT a transient warm-up

If you call `coordinator.dcOperatingPoint()` and then `coordinator.step()`, here is what happens at each layer:

1. **`dcOperatingPoint()`** sets `ctx.cktMode = MODEDCOP | MODEINITJCT` (`analog-engine.ts:867`), runs the three-level NR ladder, and on convergence runs `dcopFinalize` (smsig cktLoad at `dc-operating-point.ts:250-254`). It writes `ctx.rhs`, `ctx.rhsOld`, leaves `ctx.cktMode` at `MODEDCOP | MODEINITSMSIG` (`analog-engine.ts:930-931`). It does NOT write `pool.state1`. It does NOT touch `_timestep.currentDt`. It does NOT write `ctx.ag[0]`/`ag[1]`. It does NOT set `_firstStep`.

2. **`step()`** — because `_firstStep` is still `false`, the warm-start branch fires (`analog-engine.ts:288`). `_transientDcop()` runs another full DCOP — this time entering with `ctx.cktMode = MODETRANOP | MODEINITJCT` (`analog-engine.ts:980`). Differences from the just-completed `dcOperatingPoint()`:
   - `MODETRAN` is set, so `vsrcload.c:410-411` mirror code may scale source values by `srcFact`.
   - `srcFact` enters at 1; the gillespie ladder sub-solve may mutate it internally.
   - The smsig finalise is **skipped** — `dcopFinalize` is gated on `!isTranOp(ctx.cktMode)`. Any device cache that the smsig load updated during the prior `dcOperatingPoint()` call is now stale relative to a fresh transient-boot.
   - `_seedFromDcop` runs after convergence — writes `state1.set(state0)`, `ag[0]=ag[1]=0`, `cktMode |= MODEINITTRAN`, `_timestep.currentDt = firstStep`.

3. **Net effect**: the prior `dcOperatingPoint()` work is discarded — the transient flow re-runs its own DCOP from scratch with different `cktMode` bits and different post-convergence semantics. The cost is duplicated NR iterations; the harm is that the lingering smsig-load device state from the prior `.OP` may contaminate the start of `_transientDcop`'s first NR iteration in subtle ways (any element whose `load()` reads cached small-signal quantities). The two flows are **independent** and the only safe way to "warm up" a transient is to call `coordinator.step()` directly — its first call internally does the right warm-start.

The mirror to ngspice: `dcop.c:21-180` is the standalone `.OP` driver; `dctran.c:117-360` is the transient driver. Each calls `CKTop(ckt, MODE..., MODE..., maxIter)` at `cktop.c:27-86` with different mode arguments. ngspice users invoking `.op` followed by `.tran` get a fresh `dctran.c` `firsttime` block — there is no shared cached bias point. digiTS preserves that exact two-flow structure.

**Citation summary**:
- digiTS gate: `dc-operating-point.ts:355,390,428` (`if (!isTranOp(ctx.cktMode)) dcopFinalize(ctx);`).
- digiTS warm-start gate: `analog-engine.ts:288-291` (`if (!this._firstStep) { this._transientDcop(); this._firstStep = true; }`).
- digiTS state seed: `analog-engine.ts:1443-1490` (`_seedFromDcop` ports `dctran.c:346-350`).
- ngspice standalone .OP: `ref/ngspice/src/spicelib/analysis/dcop.c:81-85` calls `CKTop(ckt, (CKTmode & MODEUIC) | MODEDCOP | MODEINITJCT, (CKTmode & MODEUIC) | MODEDCOP | MODEINITFLOAT, CKTdcMaxIter)`; `dcop.c:127` writes `MODEDCOP | MODEINITSMSIG`; `dcop.c:153` runs the smsig CKTload.
- ngspice transient firsttime: `ref/ngspice/src/spicelib/analysis/dctran.c:230-233` calls `CKTop(ckt, (CKTmode & MODEUIC) | MODETRANOP | MODEINITJCT, (CKTmode & MODEUIC) | MODETRANOP | MODEINITFLOAT, CKTdcMaxIter)`; `dctran.c:346-350` then writes `MODETRAN | MODEINITTRAN`, `CKTag[0]=CKTag[1]=0`, `bcopy(CKTstate0, CKTstate1, ...)`. **There is no smsig finalise in the transient path.**

---

## 8. Cheat sheet

| Question | Answer location |
|---|---|
| Did DCOP converge? | A5 — `result.converged`. |
| What method converged DCOP? | A3 — `result.method`. |
| Final converged node voltage after DCOP | §5 Boundary 1 — `engine.getNodeVoltage`. |
| Did DCOP advance simTime? | §5 Boundary 1 — no. |
| Did the transient step accept? | §5 Boundary 2 — `coordinator.simTime` advanced and no throw. |
| Last accepted dt | §5 Boundary 2 — `engine.lastDt`. |
| LTE-proposed next dt | §5 Boundary 2 — `engine.getLteNextDt()`. |
| state0 / state1 / state2 at step end | §5 Boundary 2 — `pool.state0/1/2[base + slotIndex]`. |
| Per-step attempts (dt, iterations, blame, lteRejected) | §5 Boundary 2 — `coordinator.getConvergenceLog()`. |
| Matrix entry M[i,j] between NR iterations | §6 — `harness_get_attempt(...).iterations[k].matrix`. |
| Pre-solve RHS at iter k | §6 — `harness_get_attempt(...).iterations[k].rhs`. |
| state1[X] vs state0[X] mid-iteration | §6 — `harness_get_attempt(...)` for `tranPredictor` attempt. |
| Per-iteration limiting events | §6 — harness post-iteration hook. |
| Why my "DCOP then step" pattern is broken | §7. |

For **API method signatures and code templates**, see `test-tools.md`.
