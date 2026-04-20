# ngspice alignment — F3: DCOP/transient transition

_Extracted from ephemeral tool-results cache. Source agent output verbatim below._

---

I have sufficient grounding to produce the diffs. Proceeding to write the full analyst output now.

---

# F3 Architect — ngspice DCop-to-Transient Alignment Diffs

## Summary

Five deliverables spanning `src/solver/analog/dc-operating-point.ts`, `src/solver/analog/analog-engine.ts`, and a new `src/solver/analog/ckt-mode.ts`. Fixes #2/#5/#6/#12 plus B1–B8. The core architectural move is Option A (Deliverable 3): collapse four mode fields into a single `ctx.cktMode` bitfield that mirrors ngspice's `CKTmode` word exactly. Cross-file coupling: F4 owns the device-side readers for `cktMode` / the revised `cktLoad()` signature.

Citations throughout:
- `ref/ngspice/src/spicelib/analysis/dcop.c:127,153` — one `CKTload`, not a solve
- `ref/ngspice/src/spicelib/analysis/dctran.c:346-350` — MODEINITTRAN + ag zero + state copy
- `ref/ngspice/src/spicelib/analysis/dctran.c:230-284` — transient-DCOP path has no smsig load
- `ref/ngspice/src/spicelib/analysis/dctran.c:794` — post-NR `CKTmode |= MODEINITPRED`
- `ref/ngspice/src/spicelib/analysis/dcop.c:81-84` — `.OP` mode assembly

---

## Deliverable 0 — New file `src/solver/analog/ckt-mode.ts` (prereq for D3/D5)

**File:** `C:\local_working_projects\digital_in_browser\src\solver\analog\ckt-mode.ts` (NEW)

**NEW (entire file):**

```ts
/**
 * CKTmode bitfield — single source of truth for simulation mode.
 *
 * Direct port of ngspice `CKTmode` (cktdefs.h:160-209). Replaces the fanned-out
 * representation we previously used (statePool.analysisMode + ctx.isTransient +
 * ctx.isTransientDcop + ctx.loadCtx.isTransientDcop), which drifted out of
 * sync and required manual write-mirroring at every call site.
 *
 * Semantics (ngspice cktdefs.h):
 *   MODE          — high-level analysis selector bits
 *     MODEDCOP    (0x01) .OP standalone  (dcop.c:82)
 *     MODETRAN    (0x02) transient       (dctran.c:346)
 *     MODEAC      (0x04) AC sweep        (acan.c)
 *     MODETRANOP  (MODEDCOP|MODETRAN) transient-boot DCOP (dctran.c:190,231)
 *     MODEUIC     (0x10) use IC          (traninit.c:35)
 *   INITF         — low-level Newton init-mode selector bits (mutually exclusive)
 *     MODEINITFLOAT (0x100)
 *     MODEINITJCT   (0x200)
 *     MODEINITFIX   (0x400)
 *     MODEINITSMSIG (0x800)
 *     MODEINITTRAN  (0x1000)
 *     MODEINITPRED  (0x2000)
 *
 * INITF mask covers the mutually-exclusive init-mode bits; MODE_ANALYSIS_MASK
 * covers the analysis-class bits. The helpers assert mutual exclusion on
 * write.
 */

// Analysis-class bits (ngspice cktdefs.h:163-171).
export const MODEDCOP    = 0x0001;
export const MODETRAN    = 0x0002;
export const MODEAC      = 0x0004;
export const MODETRANOP  = MODEDCOP | MODETRAN;   // dctran.c:190
export const MODEUIC     = 0x0010;                // cktdefs.h:168

// INITF bits (ngspice cktdefs.h:172-209). Exactly one is set at any time.
export const MODEINITFLOAT = 0x0100;
export const MODEINITJCT   = 0x0200;
export const MODEINITFIX   = 0x0400;
export const MODEINITSMSIG = 0x0800;
export const MODEINITTRAN  = 0x1000;
export const MODEINITPRED  = 0x2000;

export const INITF_MASK =
  MODEINITFLOAT | MODEINITJCT | MODEINITFIX |
  MODEINITSMSIG | MODEINITTRAN | MODEINITPRED;

export const MODE_ANALYSIS_MASK = MODEDCOP | MODETRAN | MODEAC;

/** Replace only the INITF bits, preserving analysis and UIC. */
export function setInitf(mode: number, initf: number): number {
  return (mode & ~INITF_MASK) | (initf & INITF_MASK);
}

/** Replace analysis bits, preserving UIC and INITF. */
export function setAnalysis(mode: number, analysis: number): number {
  return (mode & ~MODE_ANALYSIS_MASK) | (analysis & MODE_ANALYSIS_MASK);
}

/** True if this is any kind of DC-OP (standalone .OP or transient-boot). */
export function isDcop(mode: number): boolean {
  return (mode & MODEDCOP) !== 0;
}

/** True if in transient analysis (includes MODETRANOP during boot DCOP). */
export function isTran(mode: number): boolean {
  return (mode & MODETRAN) !== 0;
}

/** True during transient-boot DCOP (MODETRANOP = MODEDCOP|MODETRAN). */
export function isTranOp(mode: number): boolean {
  return (mode & MODETRANOP) === MODETRANOP;
}

/** True during AC sweeps. */
export function isAc(mode: number): boolean {
  return (mode & MODEAC) !== 0;
}

/** True when UIC bit is set. */
export function isUic(mode: number): boolean {
  return (mode & MODEUIC) !== 0;
}

/** Extract the active INITF bit. Returns 0 if none set. */
export function initf(mode: number): number {
  return mode & INITF_MASK;
}
```

**Callers affected:**
- F3-owned: `ctx.cktMode` field + every write in `dc-operating-point.ts`, `analog-engine.ts`.
- F4-owned (out of F3 scope, enumerated as dependency): every device `load()` that currently reads `loadCtx.initMode`, `loadCtx.isDcOp`, `loadCtx.isTransient`, `loadCtx.isTransientDcop`, `loadCtx.isAc` must switch to reading `loadCtx.cktMode` via the helpers above. Files: `capacitor.ts`, `inductor.ts`, `diode.ts`, `bjt.ts`, `fet-base.ts`, `vsrcload.ts`, `isrcload.ts`, `behavioral-*.ts`, `ac-analysis.ts`, `ckt-load.ts`, `newton-raphson.ts`.

---

## Deliverable 1 — Rewrite `dcopFinalize` to one CKTload (#2, B3, B7)

**File:** `C:\local_working_projects\digital_in_browser\src\solver\analog\dc-operating-point.ts`

### 1a. Add cktLoad import

**OLD (lines 25-28):**
```ts
import type { DiagnosticCollector } from "./diagnostics.js";
import { makeDiagnostic } from "./diagnostics.js";
import { newtonRaphson } from "./newton-raphson.js";
import type { CKTCircuitContext } from "./ckt-context.js";
```

**NEW (lines 25-30):**
```ts
import type { DiagnosticCollector } from "./diagnostics.js";
import { makeDiagnostic } from "./diagnostics.js";
import { newtonRaphson } from "./newton-raphson.js";
import { cktLoad } from "./ckt-load.js";
import type { CKTCircuitContext } from "./ckt-context.js";
import { setInitf, MODEINITSMSIG, MODEINITFLOAT } from "./ckt-mode.js";
```

### 1b. Rewrite `dcopFinalize` — one cktLoad, no NR, no save/restore dance

**OLD (lines 208-232):**
```ts
// ---------------------------------------------------------------------------
// dcopFinalize — ngspice cktop.c post-convergence initSmsig pass
// ---------------------------------------------------------------------------

/**
 * Finalize the DC operating point after convergence.
 *
 * Sets initMode to "initSmsig" and performs one final load pass with
 * exactMaxIterations=1. The mode is left as-is after the pass; the caller
 * (dctran.c equivalent) sets MODEINITTRAN before the first transient step.
 *
 * ngspice reference: cktop.c post-convergence — sets MODEINITSMSIG, runs
 * CKTload, does NOT reset mode afterward.
 */
function dcopFinalize(
  ctx: CKTCircuitContext,
  voltages: Float64Array,
): void {
  ctx.initMode = "initSmsig";
  const savedHook = ctx.postIterationHook;
  ctx.postIterationHook = null;
  ctx.rhsOld.set(voltages);
  runNR(ctx, 1, ctx.diagonalGmin, null, true);
  ctx.postIterationHook = savedHook;
}
```

**NEW (lines 208-243):**
```ts
// ---------------------------------------------------------------------------
// dcopFinalize — ngspice DCop initSmsig final CKTload (dcop.c:127,153)
// ---------------------------------------------------------------------------

/**
 * Finalize the standalone .OP DC operating point after convergence.
 *
 * ngspice `DCop` (dcop.c:127,153) performs exactly:
 *   ckt->CKTmode = (ckt->CKTmode & MODEUIC) | MODEDCOP | MODEINITSMSIG;
 *   converged = CKTload(ckt);
 *
 * That is: one CKTmode reassignment to flip the INITF bits to MODEINITSMSIG,
 * followed by one CKTload call. No factor, no solve, no iteration, no NR.
 * The converged CKTrhsOld from the previous cktop() call is already in the
 * MNA solution vector; CKTload re-evaluates every device's small-signal
 * quantities (e.g. geqcb for capacitors) into state0 using those voltages.
 *
 * After the load, ngspice does NOT reset CKTmode — the next consumer owns
 * it. For our engine, no consumer reads initMode after standalone .OP
 * finalize (the next user call either resets, reconfigures, or transitions
 * to transient via _seedFromDcop which writes its own mode). We still clear
 * the INITF bits to MODEINITFLOAT on return so `ctx.initMode` is never
 * observed leaking `"initSmsig"` (B7 fix) — matches niiter.c's post-converge
 * INITF dispatcher landing mode.
 *
 * Runs ONLY on the standalone .OP path (isTransientDcop === false). The
 * transient-boot DCOP path (dctran.c:230-346) has no smsig load and callers
 * must skip this function — see Deliverable 2.
 *
 * F4 coordination: cktLoad no longer takes an iteration parameter; this
 * diff assumes the signature `cktLoad(ctx)`. If F4 has not yet landed,
 * replace `cktLoad(ctx)` below with `cktLoad(ctx, 0)` and remove the 0
 * once F4 lands.
 */
function dcopFinalize(
  ctx: CKTCircuitContext,
  voltages: Float64Array,
): void {
  // dcop.c:127 — CKTmode = (CKTmode & MODEUIC) | MODEDCOP | MODEINITSMSIG
  // We only flip the INITF bits; analysis bits (MODEDCOP) stay from the
  // caller's ctx.cktMode setup at the top of solveDcOperatingPoint.
  ctx.cktMode = setInitf(ctx.cktMode, MODEINITSMSIG);
  // Elements read voltages via loadCtx.voltages — cktLoad sets that to
  // ctx.rhsOld each call. Make sure the converged solution is seeded.
  ctx.rhsOld.set(voltages);
  // dcop.c:153 — one CKTload call. No factor, no solve, no iteration.
  cktLoad(ctx);
  // B7 fix: clear INITF bit to MODEINITFLOAT so callers never observe the
  // smsig mode leaking across. ngspice leaves CKTmode at MODEINITSMSIG, but
  // ngspice also has no code path that reads CKTmode between the smsig
  // CKTload and the next analysis starting. Our _seedFromDcop overwrites
  // the mode unconditionally, so this is a belt-and-suspenders landing.
  ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);
}
```

**Callers affected:**
- `dc-operating-point.ts:337` (direct path) — gated by D2 below.
- `dc-operating-point.ts:370` (dynamicGmin / spice3Gmin path) — gated by D2 below.
- `dc-operating-point.ts:406` (gillespieSrc / spice3Src path) — gated by D2 below.
- `newton-raphson.ts:239` — `exactMaxIterations` floor bypass can be removed (B3): no code sets `exactMaxIterations=true` anywhere once `dcopFinalize` stops calling `runNR(..., true)`. Grep for other usages — if zero, delete the field; if more, leave the mechanism but note `dcopFinalize` is no longer a consumer.
- `ckt-load.ts:41` — `iteration` param removed (F4 dependency). Until F4 lands, caller passes 0.

---

## Deliverable 2 — Split `dcopFinalize` call on transient-DCOP path (#6)

**File:** `C:\local_working_projects\digital_in_browser\src\solver\analog\dc-operating-point.ts`

### 2a. Direct convergence path

**OLD (lines 335-351):**
```ts
  if (directResult.converged) {
    voltages.set(directResult.voltages);
    dcopFinalize(ctx, voltages);
    diagnostics.emit(
      makeDiagnostic(
        "dc-op-converged",
        "info",
        `DC operating point converged directly in ${directResult.iterations} iteration(s).`,
        { explanation: "Newton-Raphson converged without any convergence aids." },
      ),
    );
    ctx.dcopResult.converged = true;
    ctx.dcopResult.method = "direct";
    ctx.dcopResult.iterations = directResult.iterations;
    ctx.dcopResult.nodeVoltages.set(voltages);
    ctx.dcopResult.diagnostics = diagnostics.getDiagnostics();
    return;
  }
```

**NEW (lines 335-355):**
```ts
  if (directResult.converged) {
    voltages.set(directResult.voltages);
    // D2/#6: ngspice `DCtran` (dctran.c:230-346) performs NO CKTload after
    // the transient-boot CKTop returns. The initSmsig load fires only from
    // `DCop` (dcop.c:127,153) on the standalone .OP path. Gate on
    // isTransientDcop so transient-boot DCOP skips the smsig pass entirely.
    if (!ctx.isTransientDcop) {
      dcopFinalize(ctx, voltages);
    }
    diagnostics.emit(
      makeDiagnostic(
        "dc-op-converged",
        "info",
        `DC operating point converged directly in ${directResult.iterations} iteration(s).`,
        { explanation: "Newton-Raphson converged without any convergence aids." },
      ),
    );
    ctx.dcopResult.converged = true;
    ctx.dcopResult.method = "direct";
    ctx.dcopResult.iterations = directResult.iterations;
    ctx.dcopResult.nodeVoltages.set(voltages);
    ctx.dcopResult.diagnostics = diagnostics.getDiagnostics();
    return;
  }
```

### 2b. Gmin convergence path

**OLD (lines 368-390):**
```ts
  if (gminResult.converged) {
    voltages.set(gminResult.voltages);
    dcopFinalize(ctx, voltages);
    const gminMethod = numGminSteps <= 1 ? "dynamic-gmin" : "spice3-gmin";
    ...
```

**NEW (lines 372-395):**
```ts
  if (gminResult.converged) {
    voltages.set(gminResult.voltages);
    // D2/#6: smsig load is .OP-only — skip on transient-boot DCOP.
    if (!ctx.isTransientDcop) {
      dcopFinalize(ctx, voltages);
    }
    const gminMethod = numGminSteps <= 1 ? "dynamic-gmin" : "spice3-gmin";
    ...
```

### 2c. Source-step convergence path

**OLD (lines 404-426):**
```ts
  if (srcResult.converged) {
    voltages.set(srcResult.voltages);
    dcopFinalize(ctx, voltages);
    const srcMethod = numSrcSteps <= 1 ? "gillespie-src" : "spice3-src";
    ...
```

**NEW (lines 408-431):**
```ts
  if (srcResult.converged) {
    voltages.set(srcResult.voltages);
    // D2/#6: smsig load is .OP-only — skip on transient-boot DCOP.
    if (!ctx.isTransientDcop) {
      dcopFinalize(ctx, voltages);
    }
    const srcMethod = numSrcSteps <= 1 ? "gillespie-src" : "spice3-src";
    ...
```

**Callers affected:** none beyond the three gate points above. The transient-boot path (`_transientDcop` in `analog-engine.ts:859-911`) already sets `ctx.isTransientDcop = true`, so this gating is free at that call site.

---

## Deliverable 3 — Rewrite `_seedFromDcop` + CKTmode bitfield (#5, #12, B1, B2, B4, B5, B6)

### 3a. `ckt-context.ts` — add `cktMode` field; mark deprecated fanouts

**File:** `C:\local_working_projects\digital_in_browser\src\solver\analog\ckt-context.ts`

**OLD (lines 235-256):**
```ts
  // -------------------------------------------------------------------------
  // Mode flags
  // -------------------------------------------------------------------------

  /** Current NR init mode. */
  initMode: InitMode = "transient";
  /** True during DC operating point solves. */
  isDcOp: boolean = false;
  /** True during transient solves. */
  isTransient: boolean = false;
  /**
   * True during transient-boot DCOP (ngspice MODETRANOP, cktdefs.h:172).
   * False during standalone .OP (MODEDCOP, cktdefs.h:171) and during
   * transient NR. See LoadContext.isTransientDcop for full semantics.
   */
  isTransientDcop: boolean = false;
  /** True during AC small-signal sweeps (ngspice MODEAC bit; acan.c:285). */
  isAc: boolean = false;
  /** Source stepping scale factor (ngspice srcFact). */
  srcFact: number = 1;
  /** True when nodesets are present (derived from nodesets.size > 0). */
  hadNodeset: boolean = false;
```

**NEW (lines 235-285):**
```ts
  // -------------------------------------------------------------------------
  // Mode flags — single CKTmode bitfield (ngspice cktdefs.h:163-209)
  // -------------------------------------------------------------------------

  /**
   * ngspice CKTmode — single bitfield holding analysis bits (MODEDCOP,
   * MODETRAN, MODEAC, MODEUIC) and INITF bits (MODEINITJCT, MODEINITFIX,
   * MODEINITFLOAT, MODEINITTRAN, MODEINITPRED, MODEINITSMSIG). See
   * ./ckt-mode.ts for constants and helpers.
   *
   * This replaces the prior fanout of statePool.analysisMode +
   * ctx.isTransient + ctx.isTransientDcop + ctx.loadCtx.isTransientDcop,
   * which drifted out of sync because there were four writers and no
   * invariant. `cktMode` is the single source of truth; LoadContext exposes
   * it to devices via `loadCtx.cktMode`.
   *
   * Defaults to MODEDCOP | MODEINITFLOAT — ngspice's post-reset analysis-
   * idle state.
   */
  cktMode: number;

  /**
   * @deprecated Use `initf(cktMode)` / `setInitf(cktMode, MODEINITx)`. Kept
   * for the transition window; `ckt-load.ts` still mirrors this into
   * `loadCtx.initMode`. Will be removed once F4 lands device-side
   * `loadCtx.cktMode` readers.
   */
  initMode: InitMode = "transient";
  /**
   * @deprecated Use `isDcop(cktMode)`. Mirrored from `cktMode` for the
   * transition window.
   */
  isDcOp: boolean = false;
  /**
   * @deprecated Use `isTran(cktMode) && !isTranOp(cktMode)` for "real"
   * transient, or `isTran(cktMode)` for "any transient including boot".
   * Mirrored from `cktMode` for the transition window.
   */
  isTransient: boolean = false;
  /**
   * @deprecated Use `isTranOp(cktMode)`. Mirrored from `cktMode` for the
   * transition window.
   */
  isTransientDcop: boolean = false;
  /**
   * @deprecated Use `isAc(cktMode)`. Mirrored from `cktMode` for the
   * transition window.
   */
  isAc: boolean = false;
  /** Source stepping scale factor (ngspice srcFact). */
  srcFact: number = 1;
  /** True when nodesets are present (derived from nodesets.size > 0). */
  hadNodeset: boolean = false;
```

**OLD (constructor, line 517 area — add `cktMode` initialization near the existing mode-default lines):**
Current constructor has no explicit `cktMode` assignment. Add immediately after line 480 (`this.statePool = circuit.statePool ?? null;`):

**NEW (insertion after line 480):**
```ts
    // ngspice cktdefs.h: post-reset CKTmode = MODEDCOP | MODEINITFLOAT (no
    // job running). Every analysis entry point overwrites this before its
    // first NR call.
    this.cktMode = MODEDCOP | MODEINITFLOAT;
```

Add import at top of `ckt-context.ts`:

**NEW (after line 21, new import line):**
```ts
import { MODEDCOP, MODEINITFLOAT } from "./ckt-mode.js";
```

### 3b. `load-context.ts` — add `cktMode` to LoadContext

**File:** `C:\local_working_projects\digital_in_browser\src\solver\analog\load-context.ts`

**OLD (lines 31-85):**
```ts
export interface LoadContext {
  /** Sparse solver — element stamps conductance and RHS directly into this. */
  solver: SparseSolver;
  ...
```

**NEW (insert `cktMode` as the first field, keep legacy mirrors during transition):**
```ts
export interface LoadContext {
  /**
   * ngspice CKTmode bitfield — see ./ckt-mode.ts. Single source of truth
   * for analysis mode (MODEDCOP/MODETRAN/MODEAC/MODEUIC) and INITF init
   * mode (MODEINITJCT/…/MODEINITPRED). Devices read via helpers:
   *   import { isDcop, isTran, isUic, initf, MODEINITTRAN } from "./ckt-mode.js";
   *   if (initf(ctx.cktMode) === MODEINITTRAN) { … }
   *
   * The legacy fields `initMode`, `isDcOp`, `isTransient`, `isTransientDcop`,
   * `isAc`, `uic` are mirrored from cktMode by cktLoad() for the
   * transition window (F4 device migration). New code reads cktMode.
   */
  cktMode: number;
  /** Sparse solver — element stamps conductance and RHS directly into this. */
  solver: SparseSolver;
  …
```

Constructor loadCtx initializer in `ckt-context.ts:530-552` — add `cktMode: this.cktMode,` as the first entry.

### 3c. `ckt-load.ts` — mirror cktMode into loadCtx; drop `iteration` param

**File:** `C:\local_working_projects\digital_in_browser\src\solver\analog\ckt-load.ts`

**OLD (lines 41-62):**
```ts
export function cktLoad(ctx: CKTCircuitContext, iteration: number): void {
  // Step 1: clear matrix and RHS (ngspice cktload.c:34-47)
  ctx.solver.beginAssembly(ctx.matrixSize);

  // Step 2: update per-iteration load context fields
  ctx.loadCtx.iteration = iteration;
  ctx.loadCtx.voltages = ctx.rhsOld;
  ctx.loadCtx.initMode = ctx.initMode;
  ctx.loadCtx.srcFact = ctx.srcFact;
  ctx.loadCtx.gmin = ctx.diagonalGmin;
  ctx.loadCtx.isDcOp = ctx.isDcOp;
  ctx.loadCtx.isTransient = ctx.isTransient;
  ctx.loadCtx.isTransientDcop = ctx.isTransientDcop;
  ctx.loadCtx.isAc = ctx.isAc;
  ctx.loadCtx.noncon.value = 0;

  // Step 3: single device loop (ngspice cktload.c:71-95, calls DEVload)
  for (const element of ctx.elements) {
    element.load(ctx.loadCtx);
  }
  ctx.noncon = ctx.loadCtx.noncon.value;
  …
```

**NEW:**
```ts
export function cktLoad(ctx: CKTCircuitContext): void {
  // Step 1: clear matrix and RHS (ngspice cktload.c:34-47)
  ctx.solver.beginAssembly(ctx.matrixSize);

  // Step 2: update per-iteration load context fields.
  // cktMode is the single source of truth; the remaining fields are
  // mirrored from it for the F4 device-migration transition window.
  ctx.loadCtx.cktMode = ctx.cktMode;
  ctx.loadCtx.voltages = ctx.rhsOld;
  ctx.loadCtx.srcFact = ctx.srcFact;
  ctx.loadCtx.gmin = ctx.diagonalGmin;
  ctx.loadCtx.noncon.value = 0;

  // Legacy mirrors (F4 removes these once device readers switch to cktMode).
  ctx.loadCtx.initMode = ctx.initMode;
  ctx.loadCtx.isDcOp = ctx.isDcOp;
  ctx.loadCtx.isTransient = ctx.isTransient;
  ctx.loadCtx.isTransientDcop = ctx.isTransientDcop;
  ctx.loadCtx.isAc = ctx.isAc;

  // Step 3: single device loop (ngspice cktload.c:71-95, calls DEVload)
  for (const element of ctx.elements) {
    element.load(ctx.loadCtx);
  }
  ctx.noncon = ctx.loadCtx.noncon.value;
  …
```

Also remove the `iteration` field from `LoadContext` interface in `load-context.ts:37`. NR callers must stop writing `ctx.loadCtx.iteration`.

### 3d. `analog-engine.ts` — rewrite `_seedFromDcop`

**File:** `C:\local_working_projects\digital_in_browser\src\solver\analog\analog-engine.ts`

**OLD (lines 1157-1213):**
```ts
  /**
   * Post-convergence seeding sequence shared by dcOperatingPoint() and
   * _transientDcop().
   *
   * Copies converged voltages into engine state, seeds state pool history.
   *
   * Matches ngspice dctran.c:346-350 post-CKTop sequence:
   *   CKTmode set to MODETRAN -> CKTag[] zeroed -> bcopy seeds state1 from state0.
   */
  private _seedFromDcop(
    result: DcOpResult,
    elements: readonly AnalogElement[],
    cac: CompiledWithBridges,
  ): void {
    const ctx = this._ctx!;
    ctx.rhs.set(result.nodeVoltages);

    if (cac.statePool) {
      // ngspice dctran.c:346-350: set analysis mode, zero CKTag[], then copy state.
      // Order matters: analysisMode must be "tran" and ag[] zeroed BEFORE state0->state1
      // so that elements reading ag[0] during the first transient NR see ag0=0 (DC form)
      // for the initial companion stamp, not a stale value.
      cac.statePool.analysisMode = "tran";
      // ngspice dctran.c:346 — `CKTmode = (CKTmode & MODEUIC) | MODETRAN | MODEINITTRAN`.
      // Set isTransient true and clear isTransientDcop: leaving MODETRANOP,
      // entering MODETRAN. Reactive elements gate companion stamps on
      // `isTransient || isDcOp`; without isTransient=true the reactive ladder
      // is invisible to every transient NR call.
      ctx.isTransient = true;
      ctx.isTransientDcop = false;
      ctx.loadCtx.isTransientDcop = false;
      // ctx.ag is CKTag[7] (cktdefs.h:97) read by elements via loadCtx.ag (D1).
      ctx.ag[0] = 0;
      ctx.ag[1] = 0;
      // ngspice dctran.c:316-318 — CKTdeltaOld[i] = CKTmaxStep for all 7 slots
      // at transient init. ctx.deltaOld is seeded in the CKTCircuitContext
      // constructor, and the TimestepController references the same backing
      // array (D2 unification). No copy loop needed — `ctx.deltaOld ===
      // timestep.deltaOld` by identity.
      cac.statePool.seedHistory();
      cac.statePool.refreshElementRefs(ctx.poolBackedElements as unknown as PoolBackedAnalogElement[]);
      this._firsttime = true;
    }

    // Seed reactive element history (e.g. _prevClockVoltage) from the DC-OP
    // solution so the first transient step can correctly detect signal edges.
    // Matches ngspice DEVaccept post-CKTop call: elements are notified of the
    // accepted DC operating point before any transient NR iteration begins.
    const addBP = ctx.addBreakpointBound;
    ctx.loadCtx.voltages = ctx.rhs;
    ctx.loadCtx.dt = 0;
    for (const el of elements) {
      if (el.accept) {
        el.accept(ctx.loadCtx, 0, addBP);
      }
    }
  }
```

**NEW:**
```ts
  /**
   * Transition from converged DCOP to the first transient timestep.
   *
   * Direct port of ngspice dctran.c:346-350:
   *
   *     ckt->CKTmode = (ckt->CKTmode & MODEUIC) | MODETRAN | MODEINITTRAN;
   *     ckt->CKTag[0] = ckt->CKTag[1] = 0;
   *     bcopy(ckt->CKTstate0, ckt->CKTstate1,
   *           (size_t) ckt->CKTnumStates * sizeof(double));
   *
   * Three statements. No cktLoad, no NR, no device.accept sweep, no
   * per-element ref refresh. Those things are artifacts of our prior
   * design and are removed here.
   */
  private _seedFromDcop(
    result: DcOpResult,
    _elements: readonly AnalogElement[],
    cac: CompiledWithBridges,
  ): void {
    const ctx = this._ctx!;
    ctx.rhs.set(result.nodeVoltages);

    if (cac.statePool) {
      // dctran.c:346 — CKTmode = (CKTmode & MODEUIC) | MODETRAN | MODEINITTRAN
      // Preserve MODEUIC only; replace the analysis and INITF bits entirely.
      const uic = ctx.cktMode & MODEUIC;
      ctx.cktMode = uic | MODETRAN | MODEINITTRAN;

      // Sync deprecated mirrors so any device still reading the legacy flags
      // during the F4 transition sees consistent values. Remove this block
      // once F4 device migration completes.
      ctx.initMode = "initTran";
      ctx.isDcOp = false;
      ctx.isTransient = true;
      ctx.isTransientDcop = false;
      ctx.isAc = false;
      cac.statePool.analysisMode = "tran";

      // dctran.c:348 — CKTag[0] = CKTag[1] = 0
      ctx.ag[0] = 0;
      ctx.ag[1] = 0;

      // dctran.c:349-350 — bcopy(CKTstate0, CKTstate1, numStates*sizeof(double))
      // Direct ngspice analogue: copy current state into the "last accepted"
      // slot. No seeding of state2..state7 yet — ngspice does state2 = state1
      // and state3 = state1 inside the first-step acceptance block
      // (dctran.c:795-799), not here.
      cac.statePool.states[1].set(cac.statePool.states[0]);

      // B4 audit — refreshElementRefs is pure reference-rebinding. It only
      // rewrites the s0..s7 pointer fields on each PoolBackedAnalogElement
      // so they point at the pool's current states[0..7] arrays (see
      // state-pool.ts:72-94). No scalar or state value is mutated. It is a
      // pool-architecture artifact with no ngspice counterpart; ngspice
      // stores `CKTstate0..CKTstate7` as pointers into one `CKTstates[]`
      // array and never needs per-device ref fixups. Keep the call because
      // the `.set()` above modified `states[1]`'s backing memory via the
      // current array reference, but any subsequent pool-level rotation
      // (rotateStateVectors) needs devices to see the rotated slots.
      // Note: states[1].set(states[0]) does NOT rotate — this call is only
      // strictly necessary if a prior sub-solve rotated inside a failure
      // path and left element refs dangling. We keep it as a defensive
      // resync; it is pure rebinding and cannot drift from ngspice.
      cac.statePool.refreshElementRefs(
        ctx.poolBackedElements as unknown as PoolBackedAnalogElement[],
      );
    }

    // B2 fix: el.accept() sweep REMOVED. ngspice dctran.c:230-351 does not
    // run DEVaccept between CKTop and the first MODEINITTRAN NIiter call;
    // DEVaccept fires only inside CKTaccept (cktaccept.c) after an accepted
    // transient step, not at DCOP→transient transition. Our previous sweep
    // was a divergence with no ngspice counterpart.
    //
    // B6/#5 fix: this._firsttime flag REMOVED. The direct `ctx.cktMode`
    // assignment above means the next step() call sees MODEINITTRAN in
    // cktMode without needing a deferred boolean gate. See Deliverable 4.
  }
```

**Callers affected:**
- `analog-engine.ts:840` (`dcOperatingPoint() → _seedFromDcop`) — unchanged signature; call site keeps working.
- `analog-engine.ts:907` (`_transientDcop() → _seedFromDcop`) — unchanged signature.
- `analog-engine.ts:118,183,234,426,466,504,513,594,1198` (every `_firsttime` read/write) — see Deliverable 4.
- `analog-engine.ts:1205-1212` (the removed accept sweep) — gone.

---

## Deliverable 4 — Eliminate `_firsttime`, remove `"transient"` sentinel (#5, B6, B7)

**File:** `C:\local_working_projects\digital_in_browser\src\solver\analog\analog-engine.ts`

### 4a. Remove the field declaration

**OLD (line 118):**
```ts
  private _firsttime: boolean = false;
```

**NEW:**
```ts
  // _firsttime removed (F3 Deliverable 4). MODEINITTRAN is now set directly
  // on ctx.cktMode by _seedFromDcop; no deferred gate is needed. "First
  // transient step" is identified by MODEINITTRAN being live in cktMode,
  // which niiter's INITF dispatcher clears to MODEINITFLOAT after the
  // first NR pass.
```

### 4b. Remove the `init()` reset of `_firsttime`

**OLD (line 183):**
```ts
    this._firsttime = false;
```

**NEW:** *(delete line)*

### 4c. Remove `reset()` write

**OLD (line 234):**
```ts
    this._lastDt = 0;
    this._firsttime = false;
```

**NEW:**
```ts
    this._lastDt = 0;
```

### 4d. Remove the deferred `initMode = "initTran"` block inside `step()`

**OLD (lines 419-429):**
```ts
      // --- NIcomCof (ngspice dctran.c:736) ---
      // Recompute ag[] integration coefficients before each NR solve.
      // Elements read ag[] via ctx.loadCtx.ag inside their load() calls.
      if (statePool) {
        statePool.dt = dt;
        computeNIcomCof(dt, this._timestep.deltaOld, this._timestep.currentOrder,
          this._timestep.currentMethod, this._ctx!.ag, this._ctx!.gearMatScratch);
        if (this._firsttime) {
          ctx.initMode = "initTran";
        }
      }
```

**NEW:**
```ts
      // --- NIcomCof (ngspice dctran.c:736) ---
      // Recompute ag[] integration coefficients before each NR solve.
      // Elements read ag[] via ctx.loadCtx.ag inside their load() calls.
      if (statePool) {
        statePool.dt = dt;
        computeNIcomCof(dt, this._timestep.deltaOld, this._timestep.currentOrder,
          this._timestep.currentMethod, this._ctx!.ag, this._ctx!.gearMatScratch);
        // MODEINITTRAN is already live in ctx.cktMode from _seedFromDcop
        // (Deliverable 3). niiter's INITF dispatcher will land it on
        // MODEINITFLOAT after the first cktLoad. No deferred write needed.
      }
```

### 4e. Rewrite step()'s MODEINITPRED block (B6 — remove `"transient"` sentinel)

**OLD (lines 462-475):**
```ts
      // ngspice dctran.c: MODEINITPRED is set ONLY at step > 0 (dctran.c:794),
      // never at firsttime (dctran.c:346 uses MODEINITTRAN instead). initTran
      // was already written at line 427 for firsttime and must not be clobbered.
      if (statePool && firstNrForThisStep && !this._firsttime) {
        ctx.initMode = "initPred";
      }
      newtonRaphson(ctx);
      const nrResult = ctx.nrResult;
      // After the first load() pass, revert initMode to "transient".
      if (statePool && firstNrForThisStep) {
        ctx.initMode = "transient";
        firstNrForThisStep = false;
      }
```

**NEW:**
```ts
      // ngspice dctran.c:794 — AFTER NIiter returns, CKTmode is set to
      // `(CKTmode & MODEUIC) | MODETRAN | MODEINITPRED` for the next step's
      // first NIiter call. On the first transient step the mode is
      // MODEINITTRAN (set by _seedFromDcop); niiter's INITF dispatcher
      // clears that to MODEINITFLOAT after the first cktLoad. For all
      // subsequent steps, dctran.c:794's post-NIiter write puts
      // MODEINITPRED back on cktMode, which niiter again clears to
      // MODEINITFLOAT in its dispatcher.
      //
      // No per-step write is needed here — dctran.c does its MODEINITPRED
      // write AFTER NIiter returns (line 794), not before. We do the same
      // in the acceptance block below.
      //
      // The prior `ctx.initMode = "transient"` sentinel is removed; it was
      // our invention and had no ngspice analogue.
      newtonRaphson(ctx);
      const nrResult = ctx.nrResult;
      firstNrForThisStep = false;
```

Also strike the unused `firstNrForThisStep` declaration if it becomes unused. Grep confirms it is still read in the guard above the removed block; keep it only if it is now read anywhere else. Looking at the block: `firstNrForThisStep = false` is the sole remaining use. Remove the variable entirely:

**OLD (line 373-374):**
```ts
    // ngspice dctran.c MODEINITPRED: set once before the first NR of a step,
    // cleared to "transient" after the first load() pass completes.
    let firstNrForThisStep = true;
```

**NEW:** *(delete those two lines and the `firstNrForThisStep = false` on the reassignment line)*

### 4f. Rewrite the NR-failure firsttime branch

**OLD (lines 503-506):**
```ts
        this._timestep.currentOrder = 1;                // ngspice dctran.c:810 — order, NOT method
        if (this._firsttime && statePool) {
          ctx.initMode = "initTran";
        }
```

**NEW:**
```ts
        this._timestep.currentOrder = 1;                // ngspice dctran.c:810 — order, NOT method
        // dctran.c:820-822 — on NR failure while firsttime, restore
        // MODEINITTRAN on CKTmode. "firsttime" in ngspice is the local C
        // auto variable in DCtran that is 1 between lines 189 and 864 (the
        // first successful step's acceptance). We detect it as: MODETRAN
        // is set AND MODEINITTRAN was the INITF that niiter last cleared
        // — the cleanest proxy is "_stepCount === 0".
        if (this._stepCount === 0 && statePool) {
          ctx.cktMode = (ctx.cktMode & MODEUIC) | MODETRAN | MODEINITTRAN;
          ctx.initMode = "initTran";  // legacy mirror
        }
```

### 4g. Rewrite the LTE-skip firsttime branch

**OLD (lines 511-519):**
```ts
        // ngspice dctran.c:849-866: firsttime && converged -> skip LTE, accept immediately
        if (this._firsttime) {
          this._firsttime = false;  // ngspice dctran.c:864: firsttime = 0
          this.stepPhaseHook?.onAttemptEnd("accepted", true);
          newDt = dt;
          worstRatio = 0;
          break;  // exit for(;;) -> proceed to acceptance block
        }
```

**NEW:**
```ts
        // ngspice dctran.c:849-866: firsttime && converged -> skip LTE,
        // accept immediately. Our firsttime proxy is _stepCount === 0:
        // before the first-step increment it is 0, and dctran.c:864 sets
        // firsttime = 0 just before jumping to nextTime where STATaccepted
        // increments. Our equivalent increment is at `_stepCount++` at
        // the end of step(), giving the same one-shot semantics.
        if (this._stepCount === 0) {
          this.stepPhaseHook?.onAttemptEnd("accepted", true);
          newDt = dt;
          worstRatio = 0;
          break;  // exit for(;;) -> proceed to acceptance block
        }
```

### 4h. Rewrite the post-acceptance state-seeding branch

**OLD (lines 588-598):**
```ts
    // Accept the timestep — rotation already happened before the retry loop.
    if (statePool) {
      statePool.tranStep++;
      // ngspice dctran.c:795-799 + capload.c:60-62:
      // On first transient step (firsttime), copy s0->s1 for q0==q1,
      // then seed s2/s3 from s1. Runs once per accepted step, not per NR retry,
      // so prior-step history is never overwritten by a failed attempt.
      if (this._firsttime) {
        statePool.states[1].set(statePool.states[0]);
        statePool.seedFromState1();
      }
    }
```

**NEW:**
```ts
    // Accept the timestep — rotation already happened before the retry loop.
    if (statePool) {
      statePool.tranStep++;
      // ngspice dctran.c:795-799: on firsttime acceptance, state2 = state1
      // and state3 = state1 (no state0→state1 copy here — that happens at
      // dctran.c:349-350 inside _seedFromDcop). Runs once per first-step
      // acceptance, not per NR retry.
      if (this._stepCount === 0) {
        // states[1] already holds the DCOP state from _seedFromDcop.
        // seedFromState1 copies s1 into s2..s7, matching dctran.c:795-799
        // (ngspice seeds only s2 and s3; we seed s2..s7 because our order
        // cap permits higher-order history reads).
        statePool.seedFromState1();
      }
    }
```

### 4i. Add post-NIiter MODEINITPRED write (dctran.c:794)

Insert BEFORE `this._stepCount++` (the current line 652), after the `el.acceptStep` loop. This is the correct ngspice landing point for the post-NIiter MODE reset:

**OLD (lines 645-656):**
```ts
    // Schedule next waveform breakpoints after acceptance
    for (const el of elements) {
      if (el.acceptStep) {
        el.acceptStep(this._simTime, addBP);
      }
    }

    // Notify measurement observers
    this._stepCount++;
    for (const obs of this._measurementObservers) {
      obs.onStep(this._stepCount);
    }
  }
```

**NEW:**
```ts
    // Schedule next waveform breakpoints after acceptance
    for (const el of elements) {
      if (el.acceptStep) {
        el.acceptStep(this._simTime, addBP);
      }
    }

    // ngspice dctran.c:794 — `ckt->CKTmode = (ckt->CKTmode & MODEUIC) |
    // MODETRAN | MODEINITPRED;` The MODEINITPRED bit is set AFTER NIiter
    // returns, landing mode for the NEXT step's first cktLoad. Under
    // `#ifndef PREDICTOR` (ngspice default) device loads do `loadCtx.voltages
    // = rhsOld` anyway, so MODEINITPRED is effectively equivalent to
    // MODEINITFLOAT; the distinction matters only if PREDICTOR is enabled
    // at ngspice build time (it is not, by default).
    const uicBit = ctx.cktMode & MODEUIC;
    ctx.cktMode = uicBit | MODETRAN | MODEINITPRED;
    ctx.initMode = "initPred";  // legacy mirror

    // Notify measurement observers
    this._stepCount++;
    for (const obs of this._measurementObservers) {
      obs.onStep(this._stepCount);
    }
  }
```

Add imports at top of `analog-engine.ts`:

**NEW (import block near line 40):**
```ts
import {
  MODEUIC, MODEDCOP, MODETRAN, MODETRANOP, MODEAC,
  MODEINITTRAN, MODEINITPRED, MODEINITFLOAT, MODEINITJCT,
} from "./ckt-mode.js";
```

**Callers affected:**
- All 9 original `_firsttime` read/write sites (now 0).
- `step()`'s for-loop top no longer needs `firstNrForThisStep`.
- Tests that check `_firsttime` directly — grep: none in production; any harness test reading it must switch to `(ctx.cktMode & MODEINITTRAN) !== 0`.

---

## Deliverable 5 — Remove B5, B8

### 5a. B5 — `dc-operating-point.ts:runNR` sets `ctx.isTransient = false`

**File:** `C:\local_working_projects\digital_in_browser\src\solver\analog\dc-operating-point.ts`

**OLD (lines 150-169):**
```ts
function runNR(
  ctx: CKTCircuitContext,
  maxIterations: number,
  diagonalGmin: number,
  ladder: CKTCircuitContext["dcopModeLadder"],
  exactMaxIterations?: boolean,
): StepResult {
  ctx.isDcOp = true;
  // Mutually exclusive with isTransient — matches ngspice's MODEDCOP/MODETRAN
  // bitfield where dctran.c:346 overwrites MODEDCOP with MODETRAN. Without this
  // pair, a reset() → step() → dcOp() sequence would carry isTransient=true
  // into the DCOP solve and elements gating on `isTransient || isDcOp` would
  // see both flags simultaneously.
  ctx.isTransient = false;
  // D3: isTransientDcop is set by the CALLER (analog-engine.ts) for the
  // _transientDcop path and left false for standalone .OP. Do NOT modify it
  // here — all DCOP sub-solves (gmin stepping, source stepping, initSmsig
  // finalize) inherit the caller's MODETRANOP vs MODEDCOP distinction.
  // isAc stays false — there is no AC sub-solve inside the DCOP ladder.
  ctx.isAc = false;
  ctx.maxIterations = maxIterations;
  …
```

**NEW:**
```ts
function runNR(
  ctx: CKTCircuitContext,
  maxIterations: number,
  diagonalGmin: number,
  ladder: CKTCircuitContext["dcopModeLadder"],
  exactMaxIterations?: boolean,
): StepResult {
  // B5 fix: the caller (dcOperatingPoint / _transientDcop in analog-engine.ts)
  // owns the cktMode write — standalone .OP sets
  //   MODEDCOP | MODEINITJCT                    (dcop.c:82)
  // transient-boot DCOP sets
  //   MODETRANOP | MODEINITJCT                  (dctran.c:231)
  // Sub-solves (gmin/src stepping ladders) inherit those bits and only
  // flip the INITF sub-field via ladder.onModeBegin. No `isTransient =
  // false` write here — the cktMode bitfield already encodes the correct
  // analysis mode and sub-solves must not clobber it (MODETRANOP has
  // MODETRAN set, and zeroing it here would break vsrcload.c:410-411's
  // MODETRANOP-gated srcFact scaling inside the transient-boot ladder).

  // Legacy mirror maintenance during F4 transition:
  ctx.isDcOp = true;
  ctx.isAc = false;
  // isTransient is derived from cktMode's MODETRAN bit; update the mirror.
  ctx.isTransient = (ctx.cktMode & MODETRAN) !== 0;

  ctx.maxIterations = maxIterations;
  …
```

Add import at top of `dc-operating-point.ts`:

**NEW:**
```ts
import { MODETRAN } from "./ckt-mode.js";
```

### 5b. B5 — Caller wires MODETRANOP at the DCOP sub-solve entry

**File:** `C:\local_working_projects\digital_in_browser\src\solver\analog\analog-engine.ts`

**OLD (`_transientDcop`, lines 895-903):**
```ts
    ctx.srcFact = this._params.srcFact ?? 1;
    // D3: transient-boot DCOP runs under MODETRANOP per dctran.c:190,219-220,231-232.
    // Reset to false after DCOP converges in _seedFromDcop, before the first
    // real transient step.
    ctx.isTransientDcop = true;
    ctx.isAc = false;
    ctx._onPhaseBegin = phaseHook ? (phase: string, param?: number) => phaseHook.onAttemptBegin(phase as DcOpNRPhase, param ?? 0) : null;
    ctx._onPhaseEnd = phaseHook ? (outcome: string, converged: boolean) => phaseHook.onAttemptEnd(outcome as DcOpNRAttemptOutcome, converged) : null;
    solveDcOperatingPoint(ctx);
```

**NEW:**
```ts
    ctx.srcFact = this._params.srcFact ?? 1;
    // dctran.c:190,231 — save_mode = (CKTmode & MODEUIC) | MODETRANOP | MODEINITJCT
    // Preserve UIC; replace analysis and INITF bits entirely. Reset to
    // the first-transient-step mode inside _seedFromDcop after DCOP converges.
    const uicBitOp = ctx.cktMode & MODEUIC;
    ctx.cktMode = uicBitOp | MODETRANOP | MODEINITJCT;
    // Legacy mirrors (removed once F4 devices read cktMode):
    ctx.isDcOp = true;
    ctx.isTransient = true;   // MODETRAN bit is set inside MODETRANOP
    ctx.isTransientDcop = true;
    ctx.isAc = false;
    ctx._onPhaseBegin = phaseHook ? (phase: string, param?: number) => phaseHook.onAttemptBegin(phase as DcOpNRPhase, param ?? 0) : null;
    ctx._onPhaseEnd = phaseHook ? (outcome: string, converged: boolean) => phaseHook.onAttemptEnd(outcome as DcOpNRAttemptOutcome, converged) : null;
    solveDcOperatingPoint(ctx);
```

**OLD (`dcOperatingPoint`, lines 795-806):**
```ts
    // D3: standalone .OP is MODEDCOP only (not MODETRANOP). vsrcload.c:410-411
    // scales source value by CKTsrcFact ONLY under MODETRANOP, so for
    // standalone .OP the source-load srcFact path is gated off by the flag
    // below. CKTsrcFact itself must enter the ladder at 1 — the source-
    // stepping sub-solve (gillespieSrc / spice3Src) mutates ctx.srcFact
    // internally during the ramp, but the ladder entry value must be 1 so
    // source-scaling only kicks in when the sub-solve asks for it.
    ctx.srcFact = 1;
    ctx.isTransientDcop = false;
    ctx.isAc = false;
```

**NEW:**
```ts
    // dcop.c:82 — firstmode = (CKTmode & MODEUIC) | MODEDCOP | MODEINITJCT
    ctx.srcFact = 1;
    const uicBitOp = ctx.cktMode & MODEUIC;
    ctx.cktMode = uicBitOp | MODEDCOP | MODEINITJCT;
    // Legacy mirrors:
    ctx.isDcOp = true;
    ctx.isTransient = false;
    ctx.isTransientDcop = false;
    ctx.isAc = false;
```

### 5c. B8 — Audit every `ctx.initMode = "initFloat"` write

Grep hits (from ngspice-counterpart analysis of the file read):

| Line | Context | ngspice counterpart | Verdict |
|------|---------|----------------------|---------|
| 486 `dynamicGmin` (`ctx.initMode = "initJct"` before loop) | cktop.c:35 `firstmode` = MODEINITJCT on entry | **Keep** — ngspice-correct entry mode. |
| 507 inside dynamicGmin success branch | cktop.c:179 `CKTmode = continuemode = MODEINITFLOAT` after sub-solve converges | **Keep** — ngspice-correct. Reword the write to use `setInitf`. |
| 575 `spice3Gmin` entry `= "initJct"` | cktop.c:291 `firstmode = MODEINITJCT` | **Keep** — ngspice-correct. |
| 599 spice3Gmin per-decade success | cktop.c:319 `continuemode = MODEINITFLOAT` | **Keep** — ngspice-correct. |
| 635 `spice3Src` entry `= "initJct"` | cktop.c:591 `firstmode = MODEINITJCT` | **Keep** — ngspice-correct. |
| 652 spice3Src per-decade success | cktop.c:603 `continuemode = MODEINITFLOAT` | **Keep** — ngspice-correct. |
| 679 `gillespieSrc` entry `= "initJct"` | cktop.c:381 `firstmode = MODEINITJCT` | **Keep** — ngspice-correct. |
| 710 gillespieSrc gmin-bootstrap decade success | cktop.c:453 `continuemode = MODEINITFLOAT` | **Keep** — ngspice-correct. |
| 722 gillespieSrc zero-source success | cktop.c:453-497 `continuemode = MODEINITFLOAT` | **Keep** — ngspice-correct. |
| 743 gillespieSrc main-loop success | cktop.c:497 `continuemode = MODEINITFLOAT` | **Keep** — ngspice-correct. |

All of these are ngspice-counterparts of cktop.c's `firstmode`/`continuemode` bitfield writes. The file's claim in the original scope ("B8: writes `ctx.initMode = "initFloat"` at 6+ points … custom") is incorrect on audit — every one of them has a matching cktop.c line. They are NOT niiter INITF dispatcher writes (that dispatcher runs inside `newtonRaphson`); they are the CKTop-level `ckt->CKTmode = continuemode` writes that ngspice does between sub-solves.

**Action for B8:** No functional change, but convert each write to the new bitfield API for consistency. Example diffs:

**OLD (line 486):**
```ts
  ctx.initMode = "initJct";
```

**NEW:**
```ts
  ctx.cktMode = setInitf(ctx.cktMode, MODEINITJCT);
  ctx.initMode = "initJct";  // legacy mirror
```

**OLD (line 507):**
```ts
      ctx.initMode = "initFloat";
```

**NEW:**
```ts
      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);
      ctx.initMode = "initFloat";  // legacy mirror
```

Apply the identical rewrite to lines 575, 599, 635, 652, 679, 710, 722, 743. Add import:

**NEW (top of dc-operating-point.ts):**
```ts
import {
  setInitf,
  MODEINITJCT, MODEINITFLOAT, MODEINITSMSIG,
} from "./ckt-mode.js";
```

Similarly rewrite `cktop` (line 196 `ctx.initMode = firstMode`) to mirror its write onto `ctx.cktMode`:

**OLD (line 196):**
```ts
  ctx.initMode = firstMode;
```

**NEW:**
```ts
  // Translate the string-typed firstMode parameter into its INITF bit and
  // write both cktMode (source of truth) and initMode (legacy mirror).
  const firstInitf =
    firstMode === "initJct" ? MODEINITJCT :
    firstMode === "initFix" ? MODEINITFIX :
    firstMode === "initFloat" ? MODEINITFLOAT :
    firstMode === "initTran" ? MODEINITTRAN :
    firstMode === "initPred" ? MODEINITPRED :
    firstMode === "initSmsig" ? MODEINITSMSIG :
    MODEINITFLOAT;
  ctx.cktMode = setInitf(ctx.cktMode, firstInitf);
  ctx.initMode = firstMode;
```

Add `MODEINITFIX`, `MODEINITTRAN`, `MODEINITPRED` to the import.

**Callers affected:** every `solveDcOperatingPoint` test that asserts on `ctx.initMode` — they continue to pass because the legacy mirror is maintained. Tests asserting `ctx.isTransient === false` during DCOP sub-solves: now derived from cktMode; mirror is maintained in `runNR`. Harness capture in `__tests__/harness/capture.ts` — must be re-verified (see "Additional divergences surfaced" below).

---

## Additional divergences surfaced (F3)

### AD1 — `newtonRaphson` UIC early-exit reads wrong flag (`newton-raphson.ts:268`)

```ts
if (ctx.isDcOp && ctx.loadCtx.uic) {
```
ngspice's UIC early-exit path is gated on `MODETRANOP && MODEUIC` (traninit.c path), not on "any DCOP with UIC." Standalone `.OP` with UIC=true should NOT take the single-load exit — it should still run the full CKTop ladder. The current gate fires whenever isDcOp is true, which includes standalone `.OP`. File:line: `src/solver/analog/newton-raphson.ts:268`; ngspice: `ref/ngspice/src/spicelib/analysis/dctran.c:117-189` (UIC branch exists only in DCtran, not DCop). Fix: gate on `isTranOp(ctx.cktMode) && isUic(ctx.cktMode)`.

### AD2 — `step()` writes `statePool.analysisMode = "tran"` indirectly via `_seedFromDcop` — but nothing else in the transient path writes it

`state-pool.ts:19` documents `analysisMode` but after the F3 cktMode migration, NOTHING outside `_seedFromDcop` writes it. `reset()` at `state-pool.ts:114` sets it back to `"dcOp"`. The field is dead weight after F3. File:line: `src/solver/analog/state-pool.ts:14-20`. Action: delete the field once F4 lands; all reads must route through `cktMode`.

### AD3 — `computeNIcomCof(dt, …)` called with `dt = 0` during `_seedFromDcop` previously never, but if it were, would divide by zero

The removed `_seedFromDcop` block used to set `ctx.loadCtx.dt = 0` and call `el.accept()`. Now gone, but verify no other code path hits `computeNIcomCof` with `dt = 0`. File:line: `src/solver/analog/integration.ts:computeNIcomCof`. Action: audit — grep for all callers shows only `analog-engine.ts:424` inside the step loop, where dt comes from `getClampedDt`. Safe post-F3.

### AD4 — `rotateStateVectors` in `step()` runs BEFORE `_seedFromDcop`'s state[1].set(state[0]) on step 0

`analog-engine.ts:363-366` rotates state vectors on every step. On step 0, `_seedFromDcop` has already placed DCOP state in `states[0]` and copied it to `states[1]` (new F3 code). Then `rotateStateVectors` rotates: new `states[0]` = recycled previous last slot (zeros), new `states[1]` = previous `states[0]` = DCOP state (correct), new `states[2]` = previous `states[1]` = DCOP state (also correct coincidentally). This produces correct behavior but ONLY by coincidence — the rotation's "new states[0] = zeros" is what ngspice `dctran.c:719-723` does (temp = states[maxOrder+1]; states[0] = temp). But our ngspice-matching `bcopy(state0, state1)` at `_seedFromDcop` becomes useless: rotate immediately overwrites it with the shifted slot. Verify by tracing — states[1] after rotate holds the pre-rotate states[0] which was set by `ctx.rhs.set(result.nodeVoltages)` indirectly. File:line: `src/solver/analog/analog-engine.ts:363-366` vs `dctran.c:349-350,719-723`. LOUDLY flagging: **the rotation-then-bcopy ordering in ngspice is reversed in our code because we rotate at the top of each step(), but ngspice does the bcopy in DCtran init and the rotation in the resume/NR loop top — so the bcopy happens BEFORE the rotation in ngspice too.** This is subtle: ngspice rotation lines 719-723 happen INSIDE the outer for-loop that starts at line 726, i.e. AFTER DCtran init's `bcopy` at 349-350. Our rotation is at 363-366 inside step(), and `_seedFromDcop` runs BEFORE the first `step()` call. So our ordering is bcopy → rotate-inside-step, matching ngspice. **No divergence — annotating for the record.**

### AD5 — `poolBackedElements` type cast `as unknown as PoolBackedAnalogElement[]`

`analog-engine.ts:1197`: `ctx.poolBackedElements as unknown as PoolBackedAnalogElement[]`. The double cast hides that `ctx.poolBackedElements` is typed as `readonly AnalogElement[]`. The `ctx-context.ts:280` declaration stores pool-backed elements in a `readonly AnalogElement[]` rather than the narrower `PoolBackedAnalogElement[]`. This is a type-safety divergence; `StatePool.refreshElementRefs` signature is `(elements: readonly { poolBacked?: boolean }[])`. File:line: `ckt-context.ts:487,280` vs `state-pool.ts:72`. Action: narrow the stored type to `readonly PoolBackedAnalogElement[]` and drop the cast.

### AD6 — `ac-analysis.ts` sets its own mode but does not write to `cktMode`

After F3, `ac-analysis.ts` must write `ctx.cktMode = (cktMode & MODEUIC) | MODEAC | MODEINITFLOAT` at the top of its run, matching `acan.c:285`. Currently it presumably sets `ctx.isAc = true`. File: `src/solver/analog/ac-analysis.ts`. Must be updated in F3 or F4. Flagging as a required follow-up, not producing a diff here because AC is out of the original scope.

### AD7 — Harness capture reads deprecated fields

`src/solver/analog/__tests__/harness/capture.ts` is modified in the working tree and likely reads `initMode`, `isTransient`, `isTransientDcop`, `isAc` to build AttemptRecord fields. After F3 these are still populated via legacy mirrors, so capture continues to work — but the source of truth has moved. Flagging: when F4 lands, the harness must read via `cktMode` helpers, not the mirrors. File:line: `src/solver/analog/__tests__/harness/capture.ts`.

### AD8 — `ctx.loadCtx.iteration` is read by some device convergence checks

After removing `iteration` from `LoadContext` (Deliverable 3c), grep every `.iteration` access across `src/solver/analog/**`. File: unconfirmed; if any device reads `loadCtx.iteration` for limiting gating (e.g. diode's "first iteration only" guesses), it must switch to a different signal (likely the INITF bit — limiting is suppressed on `MODEINITFLOAT` and enabled when the prior iteration was MODEINITJCT/FIX). Flagging as a blocker for removing the field; if F4 has not landed the device-side change, KEEP the `iteration` field until F4 is merged. Safer: keep `iteration`, defer its removal.

### AD9 — `_seedFromDcop` no longer invokes `el.accept()` — behavioral elements relying on it

Elements under `src/solver/analog/behavioral-*.ts` that wrote `_prevClockVoltage` in `accept()` relied on the removed accept sweep. After F3, the first transient step starts without `_prevClockVoltage` seeded. ngspice does not have a "prev clock" concept — this is a digital-bridge detail. The fix: behavioral elements must seed such fields from their `initState` / first-load path, not from `accept()` at dt=0. LOUDLY flagging: `src/solver/analog/behavioral-flipflop.ts` and similar must be audited for reads of `_prevClockVoltage` before the first `accept()` call — if any, they produce garbage on the first transient NR. File:line: `src/solver/analog/behavioral-flipflop.ts` (any accept sweep users). Action: audit and add seeding inside `initState`.

### AD10 — `ctx.srcFact = this._params.srcFact ?? 1` in `_transientDcop` differs from `dcOperatingPoint`'s `ctx.srcFact = 1`

`analog-engine.ts:895` vs `analog-engine.ts:802`. ngspice `dctran.c` does NOT read `srcFact` at transient-boot DCOP entry — it always enters at 1 (cktop.c:385 sets `CKTsrcFact = 0` inside the gillespie sub-solve). Reading `params.srcFact` from the config is a local divergence: user-settable srcFact has no ngspice counterpart. File:line: `analog-engine.ts:895`. Action: change to `ctx.srcFact = 1;` identical to standalone `.OP`.

### AD11 — After F3, deprecated `statePool.analysisMode` and `ctx.isDcOp/isTransient/isTransientDcop/isAc` will drift

These legacy mirrors exist for F4 transition. The invariant "cktMode is the source of truth, mirrors derive from it" is now only enforced at `_seedFromDcop`, `dcOperatingPoint` entry, `_transientDcop` entry, and `runNR`. Any OTHER code path that writes one of the mirrors without updating cktMode is a latent bug. Grep-audit required across the codebase before deleting the mirrors in F4. Flagging.

### AD12 — `step()`'s NR-failure branch at line 505 used to write `ctx.initMode = "initTran"` under `this._firsttime && statePool`. After F3, `_stepCount === 0` replaces `_firsttime`, but `_stepCount` is incremented AFTER `_seedFromDcop` returns and BEFORE a step() call begins — they are both `0` at step 0 entry, so the proxy holds for the first step()

However, on the retry loop inside step()'s first invocation after NR fails, `_stepCount` is still 0, so the branch fires — correct. After the first-step acceptance `_stepCount++` runs, so subsequent step invocations skip the branch — correct. Triple-check: what if DCOP is run twice back-to-back (pattern: call `dcOperatingPoint()` twice before any `step()`)? The second call's `_seedFromDcop` writes MODEINITTRAN again. `_stepCount` was never incremented. The next `step()`'s retry-on-NR-failure writes MODEINITTRAN again. Correct. No drift. Flagging as audit-complete.

### AD13 — `acceptStep` is still called in step() with `dt=0` equivalent on first step

`analog-engine.ts:645-649` calls `el.acceptStep(simTime, addBP)` after first-step acceptance. For a newly-placed source whose `nextBreakpoint(0)` was already seeded into the queue, this risks double-seeding. File:line: `analog-engine.ts:645`. Not F3 scope. Flagging.

### AD14 — `dcopFinalize` caller gating uses `ctx.isTransientDcop` not `isTranOp(ctx.cktMode)`

In Deliverable 2's three gates, I wrote `!ctx.isTransientDcop`. Since this is the legacy mirror, it is still correct during the F4 transition — but the robust form is `!isTranOp(ctx.cktMode)`. Substitute at all three sites before F4 removes the mirror. Flagging.

---

## Root Cause

The DCop-to-transient transition divergences collapse to two root causes:

1. **Fanned-out mode state.** ngspice's `CKTmode` is one integer read by every device. We exploded it into `statePool.analysisMode`, `ctx.isTransient`, `ctx.isTransientDcop`, `ctx.loadCtx.isTransientDcop`, `ctx.isAc`, `ctx.initMode`, `ctx.loadCtx.initMode`, and `this._firsttime` — eight writers, no invariant, frequent drift. The `_firsttime` boolean, the `"transient"` sentinel string, the `exactMaxIterations` bypass, and the `el.accept()` sweep at dt=0 are all compensatory patches for this drift.
2. **NR-loop conflation at the DCop finalize.** ngspice's finalize is one `CKTload` (device small-signal pass). Ours runs a full NR pass (`runNR(..., true)`), requiring the maxIterations floor bypass and the hook save/restore dance.

F3 collapses (1) into a single `ctx.cktMode` bitfield and (2) into a direct `cktLoad(ctx)` call. The four-writer drift vanishes; the one-iteration NR pass vanishes; the `_firsttime` flag vanishes; the `"transient"` sentinel vanishes; the `el.accept()` sweep vanishes.

---

## Recommendations — already given as diffs above

Priorities:

1. **Deliverable 0 (ckt-mode.ts + cktMode field)** — high effort, critical impact. Blocks D3, D5; unblocks F4.
2. **Deliverable 3 (_seedFromDcop rewrite)** — medium effort, critical impact. Removes B2 accept sweep, B4 audit closure, B6 sentinel.
3. **Deliverable 4 (_firsttime elimination)** — medium effort, critical impact. Eliminates #5, simplifies step().
4. **Deliverable 1 (dcopFinalize one-CKTload)** — low effort, critical impact. Needs Deliverable 0.
5. **Deliverable 2 (transient-DCOP skip)** — trivial effort, critical impact. Independent.
6. **Deliverable 5 (B5, B8 alignment)** — low effort, low-to-medium impact. Tightens invariants.

---

## Trade-offs

| Option | Pros | Cons |
|--------|------|------|
| A (taken): single `ctx.cktMode` bitfield | 1:1 ngspice match; one writer invariant; devices read via helpers | Requires F4 device migration; legacy mirrors must coexist during transition |
| B: keep fanned fields, add invariant-asserter | Minimal blast radius | Doesn't solve root cause — drift-prevention is runtime-only, not compile-time; perpetuates 8-writer pattern |
| C: delete legacy mirrors immediately | Cleanest endpoint | Breaks every device during the commit; forces F3 and F4 to merge as one massive diff |

Picked A with legacy-mirror coexistence because it fits inside F3 scope without forcing F4 to be atomic.

---

## References

- `src/solver/analog/dc-operating-point.ts:222-232` — old dcopFinalize with runNR call
- `src/solver/analog/dc-operating-point.ts:337,370,406` — unconditional dcopFinalize calls to split
- `src/solver/analog/dc-operating-point.ts:157` — B5 `ctx.isTransient = false`
- `src/solver/analog/dc-operating-point.ts:486,507,575,599,635,652,679,710,722,743` — B8 initMode writes (all ngspice-correct, action is API consistency only)
- `src/solver/analog/analog-engine.ts:118,183,234,426,466,504,513,594,1198` — all `_firsttime` sites
- `src/solver/analog/analog-engine.ts:1166-1213` — old `_seedFromDcop`
- `src/solver/analog/analog-engine.ts:1205-1212` — B2 `el.accept()` sweep (delete)
- `src/solver/analog/analog-engine.ts:1197` — B4 `refreshElementRefs` (keep as pure rebinding)
- `src/solver/analog/analog-engine.ts:422-429,462-475` — `_firsttime`-gated initMode writes in step()
- `src/solver/analog/newton-raphson.ts:239` — B3 exactMaxIterations bypass
- `src/solver/analog/newton-raphson.ts:268` — AD1 UIC early-exit gate
- `src/solver/analog/ckt-load.ts:41` — cktLoad signature (drop iteration param)
- `src/solver/analog/load-context.ts:31-85` — add cktMode field
- `src/solver/analog/ckt-context.ts:235-256` — mode-field declarations
- `src/solver/analog/state-pool.ts:19` — AD2 deprecated analysisMode
- `ref/ngspice/src/spicelib/analysis/dcop.c:127,153` — one CKTload finalize
- `ref/ngspice/src/spicelib/analysis/dcop.c:82-84` — standalone .OP mode setup
- `ref/ngspice/src/spicelib/analysis/dctran.c:190,231` — MODETRANOP transient-boot setup
- `ref/ngspice/src/spicelib/analysis/dctran.c:230-284` — no smsig load on transient path
- `ref/ngspice/src/spicelib/analysis/dctran.c:346-350` — three-statement transition
- `ref/ngspice/src/spicelib/analysis/dctran.c:794` — post-NR MODEINITPRED
- `ref/ngspice/src/spicelib/analysis/dctran.c:820-822` — NR-failure firsttime restore
- `ref/ngspice/src/spicelib/analysis/dctran.c:849-866` — firsttime LTE skip
- `ref/ngspice/src/spicelib/analysis/cktop.c:35,144,179,291,319,381,453,497,591,603` — every cktop.c firstmode/continuemode write (B8 audit)

agentId: a5324150c1d77736e (use SendMessage with to: 'a5324150c1d77736e' to continue this agent)
<usage>total_tokens: 151586
tool_uses: 15
duration_ms: 410551</usage>