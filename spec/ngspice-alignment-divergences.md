# ngspice alignment divergences

Every difference from ngspice is a project failure. This document inventories every known divergence — code, tests, and process — with citations on both sides. No severity rankings, no prioritization, no "minimum blast radius" notes. All items block ngspice parity.

All file paths under `ref/ngspice/` are the vendored ngspice reference source. All other paths are our code.

---

## 1. tranInit reorder timing

**ngspice** — `ref/ngspice/src/maths/ni/niiter.c:856-859`:
```c
if ((ckt->CKTmode & MODEINITJCT) ||
    ((ckt->CKTmode & MODEINITTRAN) && (iterno==1))) {
    ckt->CKTniState |= NISHOULDREORDER;
}
```
The NISHOULDREORDER flag is set at the top of the NR loop, before factor dispatch. Consumed at `niiter.c:861-880` which calls `SMPreorder → spOrderAndFactor` and clears the flag.

**Ours** — `src/solver/analog/newton-raphson.ts:490-494`:
```ts
} else if (curInitMode === "initTran") {
    ctx.initMode = "initFloat";
    if (iteration <= 0) {
        solver.forceReorder();
    }
}
```
`forceReorder()` is called at the end of iteration 0 (in STEP J, after factor+solve). Factor of iteration 0 dispatches to `factorNumerical → _numericLUReusePivots` using DC-OP's stored pivot order.

**Divergence**: ngspice reorders BEFORE iter 0 solve. Ours reorders AFTER iter 0 solve.

**Behavior**: First transient NR iteration reuses DC-OP pivot order on a matrix with completely different diagonal magnitudes. On `tmp-hang-circuits/rl-step.dts` this produces a 100 kV overshoot. Iter 1 onwards is fine because `forceReorder()` has now set the flag.

---

## 2. dcopFinalize runs a full NR pass instead of one CKTload

**ngspice** — `ref/ngspice/src/spicelib/analysis/dcop.c:127,153`:
```c
ckt->CKTmode = (ckt->CKTmode & MODEUIC) | MODEDCOP | MODEINITSMSIG;
converged = CKTload(ckt);
```
One CKTload call. No factor, no solve, no convergence check. CKTop at `niiter.c:1058-1062` returns OK directly on MODEINITFLOAT convergence and does not run an additional NR pass.

**Ours** — `src/solver/analog/dc-operating-point.ts:222-232`:
```ts
function dcopFinalize(ctx, voltages) {
    ctx.initMode = "initSmsig";
    const savedHook = ctx.postIterationHook;
    ctx.postIterationHook = null;
    ctx.rhsOld.set(voltages);
    runNR(ctx, 1, ctx.diagonalGmin, null, true);
    ctx.postIterationHook = savedHook;
}
```
`runNR` with `exactMaxIterations=true` runs one full NR iteration: cktLoad + preorder + factor + solve.

**Divergence**: We run factor+solve where ngspice runs nothing. The pass mutates `_elVal` (LU values) and calls `postIterationHook`. The save/restore hook dance exists to suppress the spurious hook invocation — itself a band-aid for the structural divergence.

**Behavior**: `_elVal` left in post-factor LU state for the next caller. Extra factor+solve cost per DC-OP completion. The hook-leak band-aid (commit `d4dc1e3c`) papers over the divergence.

---

## 3. `_numericLUReusePivots` has no partial-pivoting guard

**ngspice** — `ref/ngspice/src/maths/sparse/spfactor.c:214-227`:
```c
for (Step = 1; Step <= Size; Step++) {
    pPivot = Matrix->Diag[Step];
    LargestInCol = FindLargestInCol(pPivot->NextInCol);
    if ((LargestInCol * RelThreshold < ELEMENT_MAG(pPivot))) {
        RealRowColElimination(Matrix, pPivot);
    } else {
        ReorderingRequired = YES;
        break;
    }
}
```
Every stored pivot validated against the largest element in its column below the pivot. Failure triggers a full re-reorder.

**Ours** — `src/solver/analog/sparse-solver.ts:1208-1213`:
```ts
const pivotRow = q[k];
const diagVal = x[pivotRow];
if (Math.abs(diagVal) < PIVOT_ABS_THRESHOLD) {
    for (let idx = 0; idx < xNzCount; idx++) x[xNzIdx[idx]] = 0;
    return { success: false };
}
```
Only check is absolute magnitude < 1e-13. No column-relative validation. No fallthrough to re-reorder on failure — returns singular.

**Divergence**: Pivot validity is not checked against surrounding column magnitudes. Stored pivot from a prior factor that becomes catastrophically small relative to the new matrix values is used without re-reorder.

**Behavior**: Any magnitude shift in matrix values between factor calls silently produces garbage LU. The RL hang at divergence #1 is one instance; applies to any scenario where matrix values change substantially between NR iterations without an explicit `forceReorder()` call.

---

## 4. Pivot threshold constant magnitude mismatch

**ngspice** — `ref/ngspice/src/maths/sparse/spconfig.h:331`:
```c
#define RelThreshold 1.0e-3
```
Column-relative threshold.

**Ours** — `src/solver/analog/sparse-solver.ts:24`:
```ts
const PIVOT_ABS_THRESHOLD = 1e-13;
```
Absolute threshold.

**Divergence**: Ngspice's 1e-3 is column-relative (compared against `LargestInCol`). Ours is 1e-13 absolute. The numeric values are 10 orders of magnitude apart; more importantly they measure different quantities.

**Behavior**: Related to divergence #3. Even after adding the guard shape from #3, the threshold magnitude would need to be `1e-3` and column-relative.

---

## 5. Transient-DCOP path skips MODEINITTRAN regime

**ngspice** — `ref/ngspice/src/spicelib/analysis/dctran.c:346-350`:
```c
ckt->CKTmode = (ckt->CKTmode&MODEUIC) | MODETRAN | MODEINITTRAN;
ckt->CKTag[0] = ckt->CKTag[1] = 0;
bcopy(ckt->CKTstate0, ckt->CKTstate1, (size_t) ckt->CKTnumStates * sizeof(double));
```
Sets MODEINITTRAN immediately after DCop. The next NIiter call loads the first transient step under MODEINITTRAN, which triggers device-level state-seed paths (inductor flux, capacitor charge).

**Ours** — `src/solver/analog/analog-engine.ts:422-429,466-469`:
```ts
if (statePool) {
    statePool.dt = dt;
    computeNIcomCof(...);
    if (this._firsttime) { ctx.initMode = "initTran"; }
}
...
if (statePool && firstNrForThisStep && !this._firsttime) {
    ctx.initMode = "initPred";
}
newtonRaphson(ctx);
```
`_firsttime` flag gates the `"initTran"` assignment. Without `_firsttime=true`, the first transient step runs under `"initPred"`.

**Divergence**: ngspice sets the init mode directly at the DCop → tran transition (`dctran.c:346`). We defer via a `_firsttime` boolean, and the setting happens inside the step function rather than at the transition point.

**Behavior**: The `"initTran"` branch is only reached when `_firsttime=true`. Every code path that does not set `_firsttime` loads the first transient step under `"initPred"` instead of `"initTran"`. Device-level MODEINITTRAN paths (capacitor/inductor state0 seed) do not fire under `"initPred"`.

---

## 6. dcopFinalize called on transient-DCOP success path

**ngspice** — `ref/ngspice/src/spicelib/analysis/dcop.c:81,127,153`:
`dcop.c` runs the smsig CKTload pass. `ref/ngspice/src/spicelib/analysis/dctran.c:230-233,346`: `dctran.c` calls `CKTop` then jumps directly to setting MODEINITTRAN without a smsig pass.

**Ours** — `src/solver/analog/dc-operating-point.ts:337,370,406`:
```ts
dcopFinalize(ctx, voltages);
```
Called on every DC-OP convergence path (direct / dynamicGmin / gillespieSrc) regardless of whether the caller is `.OP` or transient-DCOP. The `ctx.isTransientDcop` flag set at `analog-engine.ts:897` is not consulted.

**Divergence**: `.OP` runs the smsig pass; transient-DCOP does not. We run it unconditionally.

**Behavior**: Every transient simulation executes an extra device-evaluation pass with no ngspice counterpart.

---

## 7. `"initSmsig"` mode gates no device code

**ngspice** gates small-signal-only branches at 50+ sites in device `load` functions. Examples:
- `ref/ngspice/src/spicelib/devices/bsim3/b3ld.c:265`
- `ref/ngspice/src/spicelib/devices/bsim4v7/b4v7ld.c:265`
- `ref/ngspice/src/spicelib/devices/bsimsoi/b4soild.c:508`
- `ref/ngspice/src/spicelib/devices/vbic/vbicload.c:319`

Each branches on `(ckt->CKTmode & MODEINITSMSIG)` to compute small-signal linearization values distinct from the steady-state DC load.

**Ours** — grep of `src/components/**/*.ts` for `initSmsig`: zero occurrences. The `InitMode` type declares `"initSmsig"` at `src/solver/analog/load-context.ts:24` and `src/solver/analog/newton-raphson.ts:497-499` processes the mode in the dispatcher, but no device `load()` method inspects it.

**Divergence**: ngspice's MODEINITSMSIG linearization regime has no counterpart in any of our device models.

**Behavior**: The smsig load pass runs the same device code that `"initFloat"` runs. AC analysis preparation is missing from every device.

---

## 8. cktLoad takes an iteration argument; ngspice CKTload does not

**ngspice** — `ref/ngspice/src/spicelib/analysis/cktload.c` declares `CKTload(CKTcircuit *ckt)`. No iteration parameter. Device `load()` callbacks receive only the circuit pointer. Iteration-sensitive device behavior is driven by `CKTmode` flags and `CKTstate0`/`CKTstate1` comparisons.

**Ours** — `src/solver/analog/ckt-load.ts`:
```ts
export function cktLoad(ctx: CKTCircuitContext, iteration: number): void
```
Iteration plumbed through `ctx.loadCtx.iteration` to device `load()` methods. Consumed by diode damping and BJT junction limiting paths that condition on `iteration === 0`.

**Divergence**: Our `load()` callback interface differs from ngspice's. Iteration-conditional branches in our device code have no ngspice counterpart.

**Behavior**: Any device `load()` method that inspects `iteration` diverges from ngspice's equivalent by construction. The dcopFinalize fix at divergence #2 passes `iteration=0` to cktLoad, which triggers first-iteration device behavior that does not fire in ngspice's equivalent `dcop.c:153` CKTload.

---

## 9. Preorder sees pre-stamped Gmin; ngspice passes Gmin through

**ngspice** — `ref/ngspice/src/maths/ni/niiter.c:863-864`:
```c
error = SMPreorder(ckt->CKTmatrix, ckt->CKTpivotAbsTol,
                   ckt->CKTpivotRelTol, ckt->CKTdiagGmin);
```
`CKTdiagGmin` passed as parameter to `SMPreorder` (= `spOrderAndFactor`). Applied inside the factor routine during pivot search.

**Ours** — `src/solver/analog/newton-raphson.ts:296-303`:
```ts
if (ctx.diagonalGmin) {
    solver.addDiagonalGmin(ctx.diagonalGmin);
}
...
const factorResult = solver.factor();
```
Gmin stamped onto `_elVal` diagonal via separate `addDiagonalGmin` call. `solver.factor()` at line 303 ignores any gmin parameter. `factorWithReorder(diagGmin?)` accepts the parameter at `sparse-solver.ts:1320` but the public `factor()` dispatch at line 405 does not pass it.

**Divergence**: ngspice applies gmin inside the factor routine. We apply it outside, beforehand.

**Behavior**: For single-factor calls the numerical result matches. Under gmin-stepping DC-OP where gmin is reset between attempts, the out-of-band stamping means our NR loop is responsible for un-applying prior gmin before re-applying new gmin, a responsibility ngspice's routine handles internally.

---

## 10. `_hasPivotOrder` semantic mismatch with `Matrix->Factored`

**ngspice** — `ref/ngspice/src/maths/sparse/spdefs.h:69`:
```c
#define IS_FACTORED(matrix) ((matrix)->Factored && !(matrix)->NeedsOrdering)
```
`Matrix->Factored` indicates "LU values are fresh for current matrix state". The `IS_FACTORED` macro combines this with `!NeedsOrdering` to mean "LU reuse is safe".

**Ours** — `src/solver/analog/sparse-solver.ts:198,701,1328`:
```ts
private _hasPivotOrder: boolean = false;
```
Set at `_numericLUMarkowitz` success. Tracks "pivot permutation has been established". Does not track LU-values-fresh state separately.

**Divergence**: ngspice has two orthogonal flags (`Factored`, `NeedsOrdering`) whose combined state controls reuse. We have one flag, which conflates the meanings.

**Behavior**: Set/clear points for our `_hasPivotOrder` may not match the combined lifecycle of ngspice's `Matrix->Factored` + `Matrix->NeedsOrdering`. Unverified where our lifecycle diverges.

---

## 11. `invalidateTopology` trigger parity unverified

**ngspice** sets `Matrix->NeedsOrdering = YES` at:
- `ref/ngspice/src/maths/sparse/spalloc.c:170` — initial matrix allocation
- `ref/ngspice/src/maths/sparse/spbuild.c:788` — element insertion into existing assembly

**Ours** — `src/solver/analog/sparse-solver.ts:465-469`:
```ts
invalidateTopology(): void {
    this._structureEmpty = true;
    this._hasPivotOrder = false;
    this._didPreorder = false;
}
```
Single method. Call sites in production code not enumerated; call sites in tests (4) do not cover the ngspice triggers.

**Divergence**: ngspice reorders on element insertion during assembly. Our parity on that trigger is unverified.

**Behavior**: Unknown until call sites are traced. If we do not invalidate on element insertion mid-assembly, stored pivot order persists through topology changes.

---

## 12. `_seedFromDcop` structural parallel deferred

**ngspice** — `ref/ngspice/src/spicelib/analysis/dctran.c:346-350`:
```c
ckt->CKTmode = (ckt->CKTmode&MODEUIC) | MODETRAN | MODEINITTRAN;
ckt->CKTag[0] = ckt->CKTag[1] = 0;
bcopy(ckt->CKTstate0, ckt->CKTstate1, ...);
```
Three-line flat block at the DCop → tran transition. CKTmode is set directly.

**Ours** — `src/solver/analog/analog-engine.ts:1166-1213`:
```ts
_seedFromDcop(result, elements, cac) {
    ctx.rhs.set(result.nodeVoltages);
    ...
    cac.statePool.analysisMode = "tran";
    ctx.isTransient = true;
    ctx.isTransientDcop = false;
    ...
    ctx.ag[0] = 0;
    ctx.ag[1] = 0;
    cac.statePool.seedHistory();
    ...
    this._firsttime = true;
}
```
Multi-line function with internal abstractions (`seedHistory`, `analysisMode` assignment, `_firsttime` flag). Mode is not set here; instead `_firsttime` is set so that the next `step()` call sets `initMode = "initTran"`.

**Divergence**: ngspice's direct mode assignment at transition vs our deferred-via-flag pattern.

**Behavior**: Structurally non-parallel to ngspice. Divergence between "here we transition to transient" and "here we start the first transient step" creates intermediate states that ngspice does not have.

---

## 13. Pattern: band-aid commits mask structural divergences

**Instance** — commit `d4dc1e3c` "Fix dcopFinalize hook leak":
```ts
const savedHook = ctx.postIterationHook;
ctx.postIterationHook = null;
...
ctx.postIterationHook = savedHook;
```
Added to suppress a spurious hook invocation caused by the structural divergence at #2 (dcopFinalize running a full NR pass when ngspice runs one CKTload).

**Divergence**: The band-aid is needed only because the structural divergence exists. The fix at #2 removes the NR pass, which removes the hook invocation, which removes the need for the band-aid.

**Behavior**: Git history contains at least one commit that papers over a structural divergence rather than fixing it. Other similar commits have not been audited.

---

## 14. ngspice citations in our code comments are untrusted

**Instance** — commit `b4add694` introducing `dcopFinalize`:
```
"Matches ngspice post-cktop sequence: CKTmode |= MODEINITSMSIG → CKTload() → CKTmode reset"
```
Attributed the source to `cktop.c`. Actual source is `ref/ngspice/src/spicelib/analysis/dcop.c:127,153` — not `cktop.c`.

**Divergence**: The code citation in the introducing commit is wrong. Our `dc-operating-point.ts:209` comment currently says "ngspice cktop.c post-convergence initSmsig pass" — also wrong.

**Behavior**: Every `ngspice:` citation in our codebase is untrusted until re-verified. Future alignment audits using comments as the reference will propagate the misattribution.

---

## 15. Pattern: alignment specs partially implemented

**Instance** — `spec/phase-4-dcop-alignment.md:30-46`:
> dcopFinalize must not write "transient"; it leaves initMode as whatever NR leaves it (→ "initFloat" after the dispatcher hits initSmsig).

Current state: the `pool.initMode = "transient"` write was removed. The intended ngspice-aligned behaviour was NOT delivered — dcopFinalize still runs the full NR pass (divergence #2).

**Divergence**: Half the spec was implemented. The other half is outstanding.

**Behavior**: The spec document reads as complete. Readers trust it as delivered. Other phase specs (phases 1-3, 5+) have not been audited for the same pattern.

---

## 16. Voltage limiting events not firing (test #10)

**Test** — `src/solver/analog/__tests__/harness/stream-verification.test.ts:215-231`:
```ts
if (iter.limitingEvents.length > 0) {
    foundLimiting = true;
    for (const ev of iter.limitingEvents) {
        ...
        if (ev.wasLimited) foundWasLimited = true;
    }
}
...
expect(foundLimiting).toBe(true);
expect(foundWasLimited).toBe(true);
```
Asserts that at least one junction-limiting event with `wasLimited === true` fires during the test run.

**Current state**: `foundWasLimited` is `false`. Test fails. Limiting logic at `src/solver/analog/newton-raphson.ts:89-205` implements `pnjlim` / `fetlim` / `limvds` ported from `ref/ngspice/src/spicelib/devices/devsup.c:50-58`. Whether the port is correct and whether `limitingCollector` is wired to capture the events has not been investigated.

**Divergence**: Limiting events fire in ngspice for equivalent circuits; they do not fire in our engine on the tested circuit.

**Behavior**: Test persistently fails. Voltage limiting may be implemented incorrectly or not collected correctly.

---

## 17. Voltage limiting comparison fails (test #14)

**Test** — `src/solver/analog/__tests__/harness/stream-verification.test.ts:310-331`:
Depends on finding a limiting event with `wasLimited === true` to drive a comparison against ngspice's limiting output. Same root cause as divergence #16.

**Divergence**: No `wasLimited === true` event found anywhere in the session.

**Behavior**: Test persistently fails for the same reason as #16. Limiting-parity between our engine and ngspice cannot be verified because our side produces zero limiting events.

---

## Source document references

- `ref/ngspice/src/maths/ni/niiter.c:844-905` — NR loop factor dispatch
- `ref/ngspice/src/maths/ni/niiter.c:856-859` — top-of-loop NISHOULDREORDER set
- `ref/ngspice/src/maths/ni/niiter.c:1050-1085` — INITF dispatcher
- `ref/ngspice/src/maths/ni/niiter.c:1058-1062` — CKTop return on INITFLOAT convergence
- `ref/ngspice/src/spicelib/analysis/dcop.c:81,127,153` — post-CKTop smsig CKTload
- `ref/ngspice/src/spicelib/analysis/dctran.c:230-233,346-350` — DCop call, MODEINITTRAN stamp
- `ref/ngspice/src/spicelib/analysis/cktload.c` — CKTload signature
- `ref/ngspice/src/maths/sparse/spfactor.c:214-227,333-336` — pivot validation in reuse path
- `ref/ngspice/src/maths/sparse/spconfig.h:331` — RelThreshold = 1e-3
- `ref/ngspice/src/maths/sparse/spdefs.h:69` — IS_FACTORED macro
- `ref/ngspice/src/maths/sparse/spalloc.c:170` — initial NeedsOrdering
- `ref/ngspice/src/maths/sparse/spbuild.c:788` — element-insertion NeedsOrdering
- `ref/ngspice/src/include/ngspice/cktdefs.h:137` — NISHOULDREORDER bit
- `src/solver/analog/newton-raphson.ts:89-205,278-510` — voltage limiting, NR loop
- `src/solver/analog/sparse-solver.ts:24,196-206,405-411,465-477,701-702,1208-1213,1320-1332` — solver flags, dispatch, reuse path
- `src/solver/analog/dc-operating-point.ts:222-232,337,370,406` — dcopFinalize and call sites
- `src/solver/analog/analog-engine.ts:422-429,466-469,897,1166-1213` — transient setup, seedFromDcop
- `src/solver/analog/ckt-load.ts` — cktLoad signature
- `src/solver/analog/load-context.ts:24` — InitMode type
- `src/solver/analog/__tests__/harness/stream-verification.test.ts:215-231,310-331` — limiting tests
- `spec/phase-4-dcop-alignment.md:30-46` — partially-implemented spec
