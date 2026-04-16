# Phase 4: DC Operating Point Alignment

## Overview

Fix all numerical bugs in the DC operating point solver to match ngspice cktop.c exactly. Five sub-algorithms: CKTop direct NR, dynamicGmin, spice3Gmin, gillespieSrc, spice3Src.

**Testing surfaces:** Phase 4 is an engine-internal refactor. Per the master plan Testing Surface Policy, Phase 4 is satisfied by unit tests defined below (headless API surface) plus Phase 7 parity tests as the E2E surface. No per-phase MCP or Playwright tests are required.

**Prerequisite:** Phase 1 has landed. By the time Phase 4 begins, `solveDcOperatingPoint` already takes `ctx: CKTCircuitContext` (delivered by Phase 1 Task 1.1.3); `ctx.noncon`, `ctx.diagonalGmin`, `ctx.srcFact`, and `ctx.dcopVoltages`/`dcopSavedVoltages`/`dcopSavedState0`/`dcopOldState0` scratch buffers are available. All Phase 4 tasks are defined against the ctx-based signature.

## Wave 4.1: CKTop / DCop Flow Fixes

### Task 4.1.1: Add CKTnoncon=1 before NIiter calls

- **Description**: ngspice cktop.c:170 sets `CKTnoncon = 1` before each NIiter call in gmin/src stepping loops. Our code does not. This ensures the first NR iteration always re-evaluates convergence from scratch.

  ngspice reference: cktop.c:170 — `ckt->CKTnoncon = 1` before `NIiter(ckt, ...)`.

  Under the ctx-based NR signature delivered by Phase 1, this is a one-line `ctx.noncon = 1` assignment before each `newtonRaphson(ctx)` invocation.

- **Files to modify**:
  - `src/solver/analog/dc-operating-point.ts` — Add `ctx.noncon = 1` before each `newtonRaphson(ctx)` call in `dynamicGmin`, `spice3Gmin`, `gillespieSrc`, `spice3Src`, and the direct NR in `solveDcOperatingPoint`.

- **Tests**:
  - `src/solver/analog/__tests__/dc-operating-point.test.ts::noncon_set_before_each_nr_call` — Instrument `ctx.noncon` reads inside NR. Assert it is 1 at the start of every NR call during gmin stepping.

- **Acceptance criteria**:
  - `ctx.noncon = 1` precedes every `newtonRaphson(ctx)` call in the DC-OP solver.

### Task 4.1.2: Remove dcopFinalize initMode="transient" assignment

- **Description**: dc-operating-point.ts:330 sets `pool.initMode = "transient"` after the initSmsig NR pass. This has no ngspice counterpart — ngspice does not set a specific mode after the smsig pass. The mode is set by the caller (dctran.c sets MODEINITTRAN before the first transient step). Remove this line.

  ngspice reference: cktop.c post-convergence — only sets MODEINITSMSIG, runs CKTload, does NOT reset mode afterward.

- **Files to modify**:
  - `src/solver/analog/dc-operating-point.ts` — Delete line 330 (`pool.initMode = "transient"`).

- **Files to delete**:
  - In `src/solver/analog/__tests__/dc-operating-point.test.ts`: **Delete** the existing test `dcopFinalize_sets_initMode_to_transient_after_convergence` (currently at line 548 — asserts `pool.initMode === "transient"`). That test directly contradicts the ngspice-compliant behaviour; it cannot coexist with the new test.

- **Tests**:
  - `src/solver/analog/__tests__/dc-operating-point.test.ts::dcopFinalize_leaves_initMode_as_smsig` — After `solveDcOperatingPoint` converges, assert `statePool.initMode === "initSmsig"` (or whatever mode the NR loop leaves after the `initSmsig` → `initFloat` transition), not `"transient"`.

- **Acceptance criteria**:
  - `dcopFinalize` does not write `"transient"` to `initMode`.
  - The contradicting pre-existing test is removed.

## Wave 4.2: dynamicGmin Fixes

### Task 4.2.1: Verify initial diagGmin value matches ngspice (verification-only)

- **Description**: Per ngspice cktop.c:155-157, `OldGmin = 1e-2` and `CKTdiagGmin = OldGmin`. The first sub-solve uses `OldGmin = 1e-2` directly; the `/ factor` division only happens **after** convergence (line 190-196). Our current code at the equivalent site sets `diagGmin = oldGmin` directly, which already matches ngspice.

  **No code change is required.** This task is verification-only: add a regression test that locks in the ngspice-matching behaviour so future edits cannot silently break it.

- **Files to modify**: None.

- **Tests**:
  - `src/solver/analog/__tests__/dc-operating-point.test.ts::dynamicGmin_initial_diagGmin_matches_ngspice` — Run `dynamicGmin` on a circuit that enters the gmin-stepping path. Capture the `diagonalGmin` value passed to the first `newtonRaphson(ctx)` call (via `ctx.diagonalGmin` read at iteration 0 in a test hook or spy). Assert it equals `1e-2` exactly.

- **Acceptance criteria**:
  - Initial `diagGmin` value confirmed matching ngspice cktop.c:155-161. Regression test in place.

### Task 4.2.2: Fix factor adaptation cap

- **Description**: dc-operating-point.ts:716 — factor adaptation caps at literal 10. Must use `params.gminFactor` (which defaults to 10 but is configurable).

  Current: `Math.min(factor * Math.sqrt(factor), 10)`
  Correct: `Math.min(factor * Math.sqrt(factor), params.gminFactor ?? 10)`

  ngspice reference: cktop.c:198-199.

- **Files to modify**:
  - `src/solver/analog/dc-operating-point.ts` — Fix line 716.

- **Tests**:
  - `src/solver/analog/__tests__/dc-operating-point.test.ts::dynamicGmin_factor_cap_uses_param` — Set `params.gminFactor = 20`. Assert factor adaptation caps at 20, not 10.

- **Acceptance criteria**:
  - Factor cap reads from `params.gminFactor`, not hardcoded 10.

### Task 4.2.3: Fix clean solve iteration limit

- **Description**: dc-operating-point.ts:753-759 — clean solve after gmin stepping uses `params.dcTrcvMaxIter` (50). ngspice cktop.c:253 uses `iterlim` which is `dcMaxIter` (100).

  Current: `maxIterations: params.dcTrcvMaxIter`
  Correct: `maxIterations: params.maxIterations`

  An existing code comment at the same line reads "ngspice uses dcTrcvMaxIter here" — that comment is **wrong** (it contradicts ngspice cktop.c:253). The comment must be corrected as part of this task.

  ngspice reference: cktop.c:253 — `error = CKTop(ckt, MODEDCOP | MODEINITFLOAT, MODEDCOP | MODEINITFLOAT, iterlim);` where `iterlim` is `ckt->CKTdcMaxIter`.

- **Files to modify**:
  - `src/solver/analog/dc-operating-point.ts` — Change `maxIterations: params.dcTrcvMaxIter` to `maxIterations: params.maxIterations` at the `dynamicGmin` clean-solve site. Update the adjacent code comment: replace "ngspice uses dcTrcvMaxIter here" with a correct comment citing cktop.c:253 and `CKTdcMaxIter`.

- **Tests**:
  - `src/solver/analog/__tests__/dc-operating-point.test.ts::dynamicGmin_clean_solve_uses_dcMaxIter` — Assert the final clean solve in dynamicGmin uses `params.maxIterations` (100), not `params.dcTrcvMaxIter` (50).

- **Acceptance criteria**:
  - Clean solve iteration limit matches ngspice cktop.c:253.
  - Misleading code comment corrected.

## Wave 4.3: spice3Gmin Fixes

### Task 4.3.1: Fix initial diagGmin gshunt handling

- **Description**: dc-operating-point.ts:811 — initial diagGmin ignores gshunt. ngspice cktop.c:295-298 uses gshunt when it's nonzero.

  Current: `let diagGmin = params.gmin`
  Correct:
  ```
  const gs = params.gshunt ?? 0;
  let diagGmin = gs === 0 ? params.gmin : gs;
  ```

  ngspice reference: cktop.c:295-298.

- **Files to modify**:
  - `src/solver/analog/dc-operating-point.ts` — Fix line 811.

- **Tests**:
  - `src/solver/analog/__tests__/dc-operating-point.test.ts::spice3Gmin_uses_gshunt_when_nonzero` — Set `params.gshunt = 1e-10`. Assert initial diagGmin is `1e-10`, not `params.gmin`.
  - `src/solver/analog/__tests__/dc-operating-point.test.ts::spice3Gmin_uses_gmin_when_gshunt_zero` — Set `params.gshunt = 0`. Assert initial diagGmin is `params.gmin`.

- **Acceptance criteria**:
  - spice3Gmin initial diagGmin matches ngspice cktop.c:295-298.

## Wave 4.4: spice3Src Fixes

### Task 4.4.1: Remove extra final clean solve

- **Description**: dc-operating-point.ts:914-927 — spice3Src has an extra final clean solve that does not exist in ngspice. ngspice spice3_src (cktop.c:582-628) returns directly after the stepping loop completes. Remove the extra clean solve entirely.

  ngspice reference: cktop.c:582-628 — no final clean solve after loop.

- **Files to modify**:
  - `src/solver/analog/dc-operating-point.ts` — Delete lines 914-927 (the final clean solve in spice3Src).

- **Tests**:
  - `src/solver/analog/__tests__/dc-operating-point.test.ts::spice3Src_no_extra_clean_solve` — Set up a circuit that reliably reaches the `spice3Src` code path by forcing the two prior fallback levels to fail:
    - Circuit: high-voltage diode + series resistor (e.g., Vs=200V, R=1Ω, standard diode `Is=1e-14`, `N=1`) — direct NR fails on this.
    - Set `params.numSrcSteps = 4` (forces `spice3Src` selection over `gillespieSrc`).
    - Set `params.dcTrcvMaxIter = 1` (makes `spice3Gmin` sub-solves fail almost immediately, forcing fallback to `spice3Src`).
    Count total NR calls during `solveDcOperatingPoint` via a spy on `newtonRaphson`. After subtracting the failed prior-path calls (direct + gmin), assert the count attributable to `spice3Src` equals `numSrcSteps + 1 = 5` (the ramp steps), not `numSrcSteps + 2 = 6` (old code with extra clean solve).

- **Acceptance criteria**:
  - spice3Src has no final clean solve.
  - Matches ngspice cktop.c:582-628 exactly.

## Wave 4.5: gillespieSrc Fixes

### Task 4.5.1: Pass gshunt into source-stepping loop NR calls

- **Description**: ngspice cktop.c:457 resets `CKTdiagGmin = gshunt` after the gmin bootstrap loop exits, and subsequent device loads read this global. In our architecture, `diagonalGmin` is passed per `newtonRaphson` call — we have no equivalent global. The correct equivalent of ngspice's reset is to **pass `diagonalGmin: params.gshunt ?? 0` into every `newtonRaphson` call inside the subsequent source-stepping loop**.

  The previous naive fix ("add `diagGmin = params.gshunt ?? 0` after line ~1003") would have been a dead assignment: the `diagGmin` local in the bootstrap block is never read again after the loop exits; the source-stepping loop (roughly lines 1025–1083) never reads it.

  ngspice reference: cktop.c:457 and subsequent calls through NIiter → DEVload which read `CKTdiagGmin`.

- **Files to modify**:
  - `src/solver/analog/dc-operating-point.ts` — In `gillespieSrc`, inside the main source-stepping loop (roughly lines 1025–1083 in current code), pass `diagonalGmin: params.gshunt ?? 0` to every `newtonRaphson(ctx)` call (or set `ctx.diagonalGmin = params.gshunt ?? 0` before each call when using the ctx-based NR signature). Remove any dead `diagGmin = ...` assignment after bootstrap that isn't read.

- **Tests**:
  - `src/solver/analog/__tests__/dc-operating-point.test.ts::gillespieSrc_source_stepping_uses_gshunt` — Force `gillespieSrc` into the bootstrap path with `params.gshunt = 1e-9`. Capture `ctx.diagonalGmin` at each NR call in the source-stepping loop. Assert every NR call in the post-bootstrap stepping loop sees `ctx.diagonalGmin === 1e-9`, not the last bootstrap gmin value.

- **Acceptance criteria**:
  - Every `newtonRaphson(ctx)` call inside `gillespieSrc`'s source-stepping loop sees `ctx.diagonalGmin === params.gshunt ?? 0`, correctly replicating ngspice's CKTdiagGmin-reset behaviour.
  - No dead post-bootstrap `diagGmin` assignments remain.
