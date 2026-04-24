# Phase 7: F5ext — JFET Full Convergence Port

## Overview

Phase 7 closes the remaining gaps between `njfet.ts` / `pjfet.ts` and `ref/ngspice/src/spicelib/devices/jfet/jfetload.c::JFETload`. The unified `load()` pattern, state schema, pnjlim+fetlim limiting, Sydney-University drain current, transient NIintegrate, and 15 Y-matrix + 3 RHS stamps are already landed from Phase 2.5 W1.4 (A1 collapse). What remains is the NR-level convergence machinery: predictor state-copy completeness, `cghat`/`cdhat` extrapolation and noncon gating, the NOBYPASS bypass block, and plumbing hygiene (delete the redundant `primeJunctions()` path, drop the inline fetlim duplication, correct a misleading comment on the noncon gate).

Every task applies identically to `njfet.ts` and `pjfet.ts`. Per the D-10 self-contained-factories rule landed in Phase 2.5, PJFET does not delegate to NJFET — each edit is hand-mirrored with the `-1` polarity literal.

## Governing rules (inherited from `spec/plan.md` §Governing principles)

- **Match ngspice, or the job has failed.** Every task in this phase cites a specific line range in `jfetload.c`. Implementers port verbatim: variable-name renames are OK, control-flow restructuring is not.
- **No substitutions.** No "pragmatic," "minimal," or "simpler" versions of the bypass block or convergence gate. The spec says what ngspice does.
- **Zero allocations in hot paths.** No `new`, `{}`, `[]`, closures inside `load()`. The cghat/cdhat locals and the bypass-branch reloads are plain `let`s.
- **Targeted tests only.** Per `spec/plan.md` Appendix A, run targeted vitest (`npx vitest run src/components/semiconductors/__tests__/jfet.test.ts`). Full-suite passage is not a Phase 7 gate.
- **No self-correction for convergence.** If a ported change regresses a parity test, report and stop. End-of-phase review is user-driven.
- **Variable renames OK** (ngspice `delvgs` → our `delvgs`, `*(ckt->CKTstate0 + here->JFETvgs)` → `s0[base + SLOT_VGS]`); **control-flow restructuring forbidden** (no collapsing the four-level `if` of the bypass gate into a single `&&` chain; match ngspice's nesting exactly so a diff reads the same shape).

## Preconditions

- Phase 0 (residual dead-code audit) complete.
- Phase 3 (NR reorder + diode/BJT xfact) complete — shares the MODEINITPRED predictor semantics JFET also uses.
- Phase 4 (F5 residual limiting primitives) complete. Phase 4.1.1 lands the shared `fetlim(vold, vnew, vto): number` helper in `src/solver/analog/newton-raphson.ts` with `vtstlo = Math.abs(vold - vto) + 1` matching `devsup.c:102`. **Task 7.1.5 depends on this landing.**
- Phase 5 Wave 5.0.1 complete — `LoadContext.bypass: boolean` and `LoadContext.voltTol: number` fields present, defaulted to `false` / `1e-6` per `cktinit.c:53-55`. **Task 7.1.3 depends on this landing.**

## Parallel work

Phase 7 runs in parallel with Phase 5 (BJT) and Phase 6 (MOSFET) after Phase 4 lands. Disjoint files — no cross-device shared state. The only shared edit is the import of the Phase 4 `fetlim` helper, which lands before Phase 7 starts.

## Plan corrections applied during this spec

- **`spec/plan.md` Wave 7.1 task 7.1.1** — the sentence "Do NOT add `SLOT_CQGS` / `SLOT_CQGD` — those were the cross-method CAP transfer slots A1 deleted; under post-A1 `load()` they are locals" is factually wrong. `JFETcqgs` (`JFETstate+10`) and `JFETcqgd` (`JFETstate+12`) are real ngspice state slots per `jfetdefs.h:164-166`, written and read directly by ngspice in `jfetload.c:477-492`. The current code correctly has them. The sentence is struck.
- **`spec/plan.md` Wave 7.2** (PJFET delegation) — directly contradicts the D-10 ruling (self-contained factories with polarity literals) landed in Phase 2.5. Wave 7.2 is struck; PJFET remains self-contained.
- **`spec/plan.md` Wave 7.3** (test alignment) — collapsed to smoke-only since the engine is not expected to be fully working until Phase 10 acceptance. Detailed per-task tests (state-copy completeness, cghat/cdhat convergence, bypass branch behaviour, ngspice harness parity) are moved to `spec/phase-10-follow-ups.md` and scheduled post-Phase-10 closure.

## Files in scope

- `src/components/semiconductors/njfet.ts` — all edits
- `src/components/semiconductors/pjfet.ts` — all edits mirrored
- `src/components/semiconductors/__tests__/jfet.test.ts` — untouched in Phase 7

## Wave 7.1: JFET NR convergence machinery

All six tasks land in a single commit `Phase 7 — JFET NR convergence machinery` unless otherwise noted. Each edit is applied verbatim to both `njfet.ts` (polarity `+1`) and `pjfet.ts` (polarity `-1`).

### Task 7.1.1: Complete MODEINITPRED state-copy list

- **Description**: Extend the MODEINITPRED branch in `load()` to copy the full 9-slot state1→state0 list per `jfetload.c:135-148`. The current code copies only `SLOT_VGS` and `SLOT_VGD`; the rest (CG, CD, CGD, GM, GDS, GGS, GGD) are missing. Without these, the cghat/cdhat extrapolation added in Task 7.1.2 reads stale state0 from the previous NR iteration instead of the accepted state1 from the last timestep, breaking bit-exact parity with ngspice.
- **Files to modify**:
  - `src/components/semiconductors/njfet.ts` — inside the MODEINITPRED branch of `load()` (currently at lines 395-407), immediately after the `vgs`/`vgd` extrapolation, add:
    ```
    s0[base + SLOT_CG]  = s1[base + SLOT_CG];
    s0[base + SLOT_CD]  = s1[base + SLOT_CD];
    s0[base + SLOT_CGD] = s1[base + SLOT_CGD];
    s0[base + SLOT_GM]  = s1[base + SLOT_GM];
    s0[base + SLOT_GDS] = s1[base + SLOT_GDS];
    s0[base + SLOT_GGS] = s1[base + SLOT_GGS];
    s0[base + SLOT_GGD] = s1[base + SLOT_GGD];
    // cite: jfetload.c:135-148
    ```
  - `src/components/semiconductors/pjfet.ts` — identical insertion inside its MODEINITPRED branch (currently at lines 364-375).
- **Tests**: smoke-only (see §Testing strategy below). Detailed test deferred to `spec/phase-10-follow-ups.md` §JFET.
- **Acceptance criteria**:
  - Under `(ctx.cktMode & MODEINITPRED)`, both NJFET and PJFET `load()` execute 9 state1→state0 assignments covering VGS, VGD, CG, CD, CGD, GM, GDS, GGS, GGD in that order.
  - The citation comment `// cite: jfetload.c:135-148` sits immediately above the first CG copy (NJFET) / is present in PJFET with identical wording.
  - Existing smoke tests continue to pass.

### Task 7.1.2: Port cghat/cdhat extrapolation + noncon convergence gate

- **Description**: Port `jfetload.c:165-174` (cghat/cdhat compute) and `jfetload.c:500-504` (additional noncon triggers). The extrapolation runs unconditionally after voltage limiting (not under MODEINITPRED); its output feeds both the Task 7.1.3 bypass gate and the noncon counter. Preserve ngspice's `>=` / `>` asymmetry between the cghat and cdhat tests — this is a real ngspice semantic (a cghat hit at the boundary of reltol fires, a cdhat hit at the boundary does not). Do not symmetrise the comparisons.
- **Files to modify**:
  - `src/components/semiconductors/njfet.ts` — inside the general-iteration branch of `load()` (currently the `else` clause beginning at line 408), immediately after the pnjlim + inline-fetlim block ends (before the `icheckLimited = icheck === 1;` line at 535), insert:
    ```
    // cite: jfetload.c:165-174 — extrapolated currents for bypass + noncon gates
    const delvgs = vgs - s0[base + SLOT_VGS];
    const delvgd = vgd - s0[base + SLOT_VGD];
    const delvds = delvgs - delvgd;
    const cghat = s0[base + SLOT_CG]
      + s0[base + SLOT_GGD] * delvgd
      + s0[base + SLOT_GGS] * delvgs;
    const cdhat = s0[base + SLOT_CD]
      + s0[base + SLOT_GM]  * delvgs
      + s0[base + SLOT_GDS] * delvds
      - s0[base + SLOT_GGD] * delvgd;
    ```
    These five locals are visible to both the bypass block (Task 7.1.3) and the noncon gate (this task). The bypass block is inserted between this compute and the existing Sydney drain-current block.
  - Replace the existing noncon gate (NJFET currently `if ((!(mode & MODEINITFIX) | !(mode & MODEUIC)) && icheckLimited) ctx.noncon.value++;` at line 748) with the three-trigger form per `jfetload.c:500-504`:
    ```
    // cite: jfetload.c:498-507 — suppress noncon bump under UIC-forced IC at init step
    if ((!(mode & MODEINITFIX)) | (!(mode & MODEUIC))) {
      const absTol = ctx.iabstol;
      const cgNoncon = Math.abs(cghat - cg)
        >= ctx.reltol * Math.max(Math.abs(cghat), Math.abs(cg)) + absTol;
      const cdNoncon = Math.abs(cdhat - cd)
        >  ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(cd)) + absTol;
      if (icheckLimited || cgNoncon || cdNoncon) ctx.noncon.value++;
    }
    ```
    Note `>=` on cghat, `>` on cdhat — ngspice asymmetry per jfetload.c:501-504.
  - `src/components/semiconductors/pjfet.ts` — identical insertion + noncon-gate replacement at the equivalent line positions.
- **Files affected (read only, no edits)**: `src/solver/analog/load-context.ts` — `ctx.reltol` and `ctx.iabstol` already present.
- **Tests**: smoke-only. Detailed convergence test deferred to `spec/phase-10-follow-ups.md` §JFET.
- **Acceptance criteria**:
  - `delvgs`, `delvgd`, `delvds`, `cghat`, `cdhat` locals computed in the order ngspice computes them (jfetload.c:165-174).
  - The noncon gate fires when `icheckLimited` is true, OR when `|cghat - cg| >= reltol*max(|cghat|,|cg|) + iabstol`, OR when `|cdhat - cd| > reltol*max(|cdhat|,|cd|) + iabstol`. The `>=` / `>` asymmetry is preserved verbatim.
  - The outer gate `(!(mode & MODEINITFIX)) | (!(mode & MODEUIC))` suppresses the bump only when both MODEINITFIX and MODEUIC are set — i.e., UIC-forced IC at init (see Task 7.1.6 for the accompanying comment rewrite).
  - The citation comment `// cite: jfetload.c:165-174` precedes the extrapolation block; `// cite: jfetload.c:498-507` precedes the noncon gate.

### Task 7.1.3: Port NOBYPASS bypass block

- **Precondition**: Phase 5 Wave 5.0.1 has landed `ctx.bypass: boolean` and `ctx.voltTol: number` on `LoadContext`. If either field is missing at the time Phase 7 begins, the implementer STOPs and escalates — do not add the fields here (Phase 5 owns them).
- **Description**: Port `jfetload.c:178-208` verbatim. The bypass block is an inner four-level `if` chain gated on `ctx.bypass && !MODEINITPRED`. When all four tolerance tests pass, the compute block (Sydney drain current, transient caps, NIintegrate) is skipped; instead, accepted-state values are reloaded from state0 and the code jumps directly to the stamp phase. Ngspice uses `goto load;` for this jump. digiTS replicates the structure with a `bypassed: boolean` flag and an `if (!bypassed) { ... compute ... }` wrapper around the compute block.
- **Files to modify**:
  - `src/components/semiconductors/njfet.ts` — inside the general-iteration branch of `load()`, immediately AFTER the Task 7.1.2 cghat/cdhat compute, insert the bypass block per `jfetload.c:178-208`:
    ```
    // cite: jfetload.c:178-208 — NOBYPASS bypass test
    let bypassed = false;
    if (ctx.bypass && !(mode & MODEINITPRED)) {
      const vgsOld = s0[base + SLOT_VGS];
      const vgdOld = s0[base + SLOT_VGD];
      const cgOld  = s0[base + SLOT_CG];
      const cdOld  = s0[base + SLOT_CD];
      if (Math.abs(delvgs) < ctx.reltol * Math.max(Math.abs(vgs), Math.abs(vgsOld)) + ctx.voltTol)
      if (Math.abs(delvgd) < ctx.reltol * Math.max(Math.abs(vgd), Math.abs(vgdOld)) + ctx.voltTol)
      if (Math.abs(cghat - cgOld) < ctx.reltol * Math.max(Math.abs(cghat), Math.abs(cgOld)) + ctx.iabstol)
      if (Math.abs(cdhat - cdOld) < ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(cdOld)) + ctx.iabstol) {
        // bypass taken — reload state0 values and skip compute
        vgs = vgsOld;
        vgd = vgdOld;
        cg  = cgOld;
        cd  = cdOld;
        cgd = s0[base + SLOT_CGD];
        gm  = s0[base + SLOT_GM];
        gds = s0[base + SLOT_GDS];
        ggs = s0[base + SLOT_GGS];
        ggd = s0[base + SLOT_GGD];
        bypassed = true;
      }
    }
    ```
    **Structural constraint**: the four nested `if`s without braces mirror ngspice's "hack - expression too big" structure (jfetload.c:190). Do NOT collapse them into a single `&&` chain. The nested form is the ngspice structure; diff readability during parity audits depends on matching the shape.
  - Wrap the existing Sydney drain-current block + transient cap block in `if (!bypassed) { ... }`. Note: `vgs`, `vgd`, `cg`, `cd`, `cgd`, `gm`, `gds`, `ggs`, `ggd` must be declared as `let`s at function scope (above the bypass block) so they are visible both to the bypass-reload branch and to the subsequent stamp block. The current code declares them inside sub-blocks; promote the declarations.
  - `vds` is derived `vgs - vgd` and must be recomputed after the bypass block (since `vgs`/`vgd` may have been overwritten). The current `const vds = vgs - vgd;` at line 538 stays where it is; move it to after the bypass block closes.
  - The noncon gate from Task 7.1.2 runs whether bypassed or not — `jfetload.c:498-508` executes after the `load:` label (post-bypass-jump), matching that behaviour. Do not gate the noncon block on `!bypassed`.
  - The state-writeback block (njfet.ts:750-759, the `s0[base + SLOT_VGS] = vgs;` lines) also runs whether bypassed or not — ngspice re-executes the state writes at lines 509-517 after the `load:` jump. (When bypassed, the writes are idempotent: vgs reloaded = vgs written.) Preserve this unconditional write to match bit-exactly.
  - `src/components/semiconductors/pjfet.ts` — identical insertion at the equivalent line positions, with polarity literal unchanged.
- **Tests**: smoke-only. Detailed bypass branch tests deferred to `spec/phase-10-follow-ups.md` §JFET.
- **Acceptance criteria**:
  - `ctx.bypass` and `ctx.voltTol` are read through `ctx.*` (no destructuring into top-of-function locals — field access is ~3 ns and avoids the allocation of a literal object if TypeScript ever lowers destructuring).
  - When `ctx.bypass === false`, the bypass block is structurally present but never sets `bypassed = true` (the outer `if` short-circuits).
  - When `(ctx.cktMode & MODEINITPRED) !== 0`, the bypass block is skipped regardless of `ctx.bypass` — ngspice excludes MODEINITPRED via `jfetload.c:179`.
  - On bypass: `vgs`, `vgd`, `cg`, `cd`, `cgd`, `gm`, `gds`, `ggs`, `ggd` are reloaded from state0; the Sydney drain-current block is not executed; the transient NIintegrate block is not executed; the noncon gate runs (but with `icheckLimited = false` because limiting was skipped too); the state-writeback + stamp phase runs unchanged.
  - Four-level `if` structure preserved (no `&&` collapse); citation `// cite: jfetload.c:178-208` precedes the block.

### Task 7.1.4: Delete `primeJunctions()` and the `primedFromJct` one-shot seed path

- **Description**: `primeJunctions()` is a digiTS-only pre-NR priming method invoked by `src/solver/analog/dc-operating-point.ts:323-324`. For JFET, the in-`load()` MODEINITJCT 3-branch priority (per `jfetload.c:109-122`) already covers the same cases (UIC + TRANOP, INITJCT + !OFF, INITJCT || INITFIX+OFF). The separate `primeJunctions()` method + `primedFromJct` one-shot flag + the "consume seed" branch at the top of `load()` are duplicate work that complicate the dispatch ordering. Delete all three; MODEINITJCT in `load()` becomes the sole priming path. `dc-operating-point.ts:323-324` tests `if (el.primeJunctions)` — JFET instances simply won't define the method and will be skipped. No caller-side edit needed.
- **Files to modify**:
  - `src/components/semiconductors/njfet.ts`:
    - Delete the closure-scope variable `let primedFromJct = false;` (currently line 316).
    - Delete the header comment block that describes it (currently lines 314-316).
    - Delete the "Consume one-shot seed from primeJunctions()" branch at the top of the voltage dispatch (currently lines 360-366 — the `if (primedFromJct) { ... primedFromJct = false; icheck = 0; }` block). The next branch (`else if (mode & MODEINITSMSIG)` at line 367) becomes the leading `if`.
    - Delete the `primeJunctions(): void { ... }` method on the returned element object (currently lines 789-800).
  - `src/components/semiconductors/pjfet.ts` — identical deletions at equivalent line positions (closure var ~line 285, consume branch ~line 329-335, method ~lines 744-755).
- **Files left untouched**:
  - `src/solver/analog/dc-operating-point.ts:323-324` — the `if (el.isNonlinear && el.primeJunctions)` guard handles JFET's new shape (no method) correctly.
  - `src/core/analog-types.ts:219` + `src/solver/analog/element.ts:120` — `primeJunctions?(): void;` remains an optional interface method used by diode, zener, BJT, MOSFET, SCR. Untouched.
- **Tests**: smoke-only. Existing `jfet.test.ts` does not reference `primeJunctions`; deletion is behaviour-preserving for JFET tests.
- **Acceptance criteria**:
  - `njfet.ts` grep for `primeJunctions`, `primedFromJct` returns zero hits.
  - `pjfet.ts` grep for `primeJunctions`, `primedFromJct` returns zero hits.
  - `src/solver/analog/dc-operating-point.ts` grep for `primeJunctions` — unchanged (still 2 hits at 323-324).
  - Existing smoke tests in `jfet.test.ts` continue to pass.
  - NJFET and PJFET element objects no longer expose `primeJunctions` — the MODEINITJCT dispatch inside `load()` is the only code path that seeds junction voltages.

### Task 7.1.5: Replace inline `fetlim` with the Phase 4 shared helper

- **Precondition**: Phase 4 Wave 4.1.1 has landed `export function fetlim(vnew: number, vold: number, vto: number): number` in `src/solver/analog/newton-raphson.ts`, with `vtstlo = Math.abs(vold - vto) + 1` per `devsup.c:102`. If the export is absent or the signature differs, the implementer STOPs and escalates.
- **Description**: Remove the ~35-line inline fetlim implementations (njfet.ts:461-496 for vgs, 497-532 for vgd; and the two equivalent blocks in pjfet.ts) and replace each with a single call to the imported helper. This collapses ~70 lines of duplicated code across the two files and gives fetlim one source of truth shared with MOSFET (aligning with ngspice's `DEVfetlim` in `devsup.c`).
- **Files to modify**:
  - `src/components/semiconductors/njfet.ts`:
    - Add `fetlim` to the existing import from `newton-raphson.js` (line 33 currently imports only `pnjlim`). Result: `import { pnjlim, fetlim } from "../../solver/analog/newton-raphson.js";`.
    - Delete the two inline fetlim blocks (lines 461-496 and 497-532), each replaced with:
      ```
      vgs = fetlim(vgs, vgsOld, vto); // cite: devsup.c::DEVfetlim via newton-raphson.fetlim
      ```
      and
      ```
      vgd = fetlim(vgd, vgdOld, vto);
      ```
      respectively.
  - `src/components/semiconductors/pjfet.ts` — identical import addition + two inline-block replacements at equivalent line positions.
- **Tests**: smoke-only. The Phase 4 helper carries its own targeted tests per `spec/plan.md` Phase 4 verification.
- **Acceptance criteria**:
  - `njfet.ts` contains no `vtsthi` / `vtstlo` / `vtox` / `delv` locals inside `load()` (those belonged to the deleted inline fetlim).
  - `pjfet.ts` same.
  - Both files import `fetlim` from `newton-raphson.js`.
  - Behaviour change vs. pre-Phase-4 inline fetlim: the `vtstlo` coefficient is now `|vold - vto| + 1` (per Phase 4.1.1) instead of the prior `vtsthi/2 + 2`. This is a deliberate correctness fix, not a regression.
  - Existing smoke tests continue to pass.

### Task 7.1.6: Correct the noncon-gate comment and verify bitwise semantics


- **Description**: The current njfet.ts:744-748 and pjfet.ts:700-704 comment claims the `!(mode & MODEINITFIX) | !(mode & MODEUIC)` gate is a "bitwise-OR (|), NOT logical-OR (||) ... intentional ngspice quirk that makes the condition always-true when only one bit is set; replicated exactly per J-W3-2." This framing is wrong and will mislead future auditors. Verify the actual ngspice semantics and replace the comment.
- **Verification** (already performed during spec authoring, recorded here for the implementer):
  - `jfetload.c:498-499` reads `if( (!(ckt->CKTmode & MODEINITFIX)) | (!(ckt->CKTmode & MODEUIC)))`. In C, `!` yields 0 or 1; bitwise `|` on 0/1 operands is equivalent to logical `||` — both return `!A && !B ? 0 : 1`. There is no "quirk." The gate fires when NOT (MODEINITFIX set AND MODEUIC set) — i.e., it suppresses the noncon bump only under UIC-forced IC at the init step.
  - TypeScript `!` yields `true`/`false`; bitwise `|` coerces them to `1`/`0` and returns `0` or `1`. Identical semantics to C for 0/1 operands. No bit-exact divergence.
- **Files to modify**:
  - `src/components/semiconductors/njfet.ts` — the Task 7.1.2 noncon gate replaces this whole block. Ensure the comment above the replacement noncon gate reads:
    ```
    // cite: jfetload.c:498-507 — suppress noncon bump only when both
    // MODEINITFIX and MODEUIC are set (UIC-forced IC at init step).
    // Bitwise `|` on operands that are already 0/1 from `!` is equivalent
    // to logical `||` — no "quirk," just C convention ported verbatim.
    ```
  - `src/components/semiconductors/pjfet.ts` — identical comment block above the equivalent noncon gate.
- **Tests**: no behaviour change; smoke tests continue to pass.
- **Acceptance criteria**:
  - No occurrence of the substring `"quirk"` in njfet.ts or pjfet.ts.
  - The noncon gate preserves the bitwise-`|` form (`(!(mode & MODEINITFIX)) | (!(mode & MODEUIC))`) for verbatim line correspondence with ngspice. Do not "fix" to `||` — the point is that they are equivalent, not that one is preferred.
  - Comment above the gate names the actual semantics ("suppresses ... under UIC-forced IC at init step") rather than "quirk" / "always-true when only one bit is set."

## Wave 7.2: JFET per-instance TEMP parameter

Runs after Wave 7.1 with its own commit `Phase 7.2 — JFET per-instance TEMP parameter`. Orthogonal to the NR-convergence machinery in Wave 7.1 — different regions of `njfet.ts` / `pjfet.ts` (param defs, factory, `computeJfetTempParams` body, `TEMP` recompute wiring), so splitting the commit gives a cleaner revert boundary if TEMP work regresses any parity test.

ngspice reality: `jfettemp.c:83-104` reads per-instance `JFETtemp` (default = `CKTtemp`, overridable via `.MODEL ... TEMP=` or `.TEMP`). digiTS currently pins `const temp = REFTEMP;` at `njfet.ts:229` (and the mirror in `pjfet.ts`) with the comment "no CKTtemp/CKTnomTemp exposed through digiTS — we assume REFTEMP for both." The assumption is wrong: ngspice distinguishes `TNOM` (model-nominal, where parameters were measured) from `TEMP` (per-instance, where the device operates). digiTS pins both to `REFTEMP`, which silently breaks any circuit that uses `.TEMP` or per-instance temp overrides.

Per the D-10 self-contained-factories rule landed in Phase 2.5, PJFET does NOT delegate to NJFET; every edit is hand-mirrored into `pjfet.ts` at the corresponding line position. Polarity literal stays `-1`.

### Task 7.2.1: Add TEMP to NJFET and PJFET param defs

- **Description**: Declare `TEMP` as a first-class per-instance param on both NJFET and PJFET param defs, default 300.15 K. Add under `secondary` with description `"Per-instance operating temperature"`, unit `"K"`.
- **Files to modify**:
  - `src/components/semiconductors/njfet.ts` — add `TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature" }` to the NJFET param defs object, under `secondary`.
  - `src/components/semiconductors/pjfet.ts` — identical addition at the equivalent line.
- **Tests**:
  - `jfet.test.ts::NJFET TEMP::TEMP_default_300_15` — after `makeNjfetProps()`, `propsObj.getModelParam<number>("TEMP") === 300.15`.
  - `jfet.test.ts::PJFET TEMP::TEMP_default_300_15` — same shape for PJFET.
  - `jfet.test.ts::NJFET TEMP::paramDefs_include_TEMP` — `NJFET_PARAM_DEFS.map(pd => pd.key)` contains `"TEMP"`.
  - `jfet.test.ts::PJFET TEMP::paramDefs_include_TEMP` — same for PJFET.
- **Acceptance criteria**:
  - `TEMP` declared with rank `secondary`, default `300.15`, unit `"K"` on both NJFET and PJFET defs.
  - 4 tests pass.

### Task 7.2.2: Thread `TEMP` through `computeJfetTempParams` (NJFET + PJFET)

- **Description**: Replace the pinned `const temp = REFTEMP;` at `njfet.ts:229` and its mirror in `pjfet.ts` with `const temp = p.TEMP;`. Strip the "no CKTtemp/CKTnomTemp exposed through digiTS — we assume REFTEMP for both" comment and replace with citation `// cite: jfettemp.c:83 — instance temp from params.TEMP (maps to ngspice JFETtemp)`. Inside the function, `temp` already drives `vt = temp * KoverQ`, `fact2 = temp / REFTEMP`, `egfet = 1.16 - (7.02e-4*temp*temp)/(temp+1108)`, `cjfact1 = 1 + 0.5 * (4e-4 * (temp - REFTEMP) - gmanew)` — no internal algorithm change beyond the one-line source swap. `p.TNOM` continues to drive model-nominal `fact1`, `kt1`, `egfet1`, `cjfact` (untouched). The `1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP))` constant stays pegged to `REFTEMP` per `jfettemp.c` (model-level egnom reference at 300.15 K, not the instance temperature).
- **Files to modify**:
  - `src/components/semiconductors/njfet.ts::computeJfetTempParams` — change the `p` parameter's declared shape to include `TEMP: number`. Replace line 229 body. Update the function docstring at lines 202-203 to reflect that `temp` is now instance-configurable.
  - `src/components/semiconductors/pjfet.ts::computeJfetTempParams` — identical edit at equivalent lines.
  - `createNjfetElement` `params` factory — add `TEMP: props.getModelParam<number>("TEMP")` to the resolved params object.
  - `createPjfetElement` `params` factory — same addition.
  - Every `computeJfetTempParams(params)` call site — pass the updated `params` object that now carries `TEMP` (no signature change at call site; only the input shape grows).
- **Tests**:
  - `jfet.test.ts::NJFET TEMP::tp_vt_reflects_TEMP` — construct NJFET with `TEMP=400`, assert `tp.vt` approximately equals `400 * KoverQ`.
  - `jfet.test.ts::PJFET TEMP::tp_vt_reflects_TEMP` — same for PJFET.
  - `jfet.test.ts::NJFET TEMP::tSatCur_scales_with_TEMP` — construct NJFET with `IS=1e-14, TNOM=300.15`. Build at `TEMP=300.15` and `TEMP=400`. Assert `tp.tSatCur(400) > tp.tSatCur(300.15)`.
  - `jfet.test.ts::PJFET TEMP::tSatCur_scales_with_TEMP` — same for PJFET.
  - `jfet.test.ts::NJFET TEMP::TNOM_stays_nominal` — with `TEMP=400, TNOM=300.15`, assert `tp.tBetaF` / model-level params reflect `T/TNOM` ratio and not `T/REFTEMP`.
- **Acceptance criteria**:
  - `njfet.ts` + `pjfet.ts` grep for `const temp = REFTEMP;` returns zero hits.
  - Each file contains exactly one `const temp = p.TEMP;` line inside `computeJfetTempParams`.
  - 5 tests pass.

### Task 7.2.3: `load()` reads `tp.vt` at every thermal-voltage site (audit)

- **Description**: NJFET `load()` at line 351 already reads `const vt_temp = tp.vt;`, and PJFET at line 448 reads `vt = tp.vt`. This task is a belt-and-braces audit: grep both files for any `ctx.vt` read inside `load()` or the pnjlim / exponential call sites — should be zero. If drift introduces `ctx.vt` into JFET, the audit test fails.
- **Files to modify**: none (audit-only) unless drift found.
- **Tests**:
  - `jfet.test.ts::NJFET TEMP::no_ctx_vt_read_in_njfet_ts` — test-time `fs.readFileSync` on `njfet.ts`; assert the string `"ctx.vt"` appears zero times.
  - `jfet.test.ts::PJFET TEMP::no_ctx_vt_read_in_pjfet_ts` — same for `pjfet.ts`.
- **Acceptance criteria**:
  - `njfet.ts` grep for `ctx.vt` returns zero hits.
  - `pjfet.ts` grep for `ctx.vt` returns zero hits.
  - 2 tests pass.

### Task 7.2.4: `setParam('TEMP', …)` recomputes `tp` (NJFET + PJFET)

- **Description**: Verify that `setParam('TEMP', newT)` triggers a `computeJfetTempParams` recompute for both NJFET and PJFET, so that the next `load()` reflects the new temperature.
- **Files to modify**:
  - `src/components/semiconductors/njfet.ts::setParam` — ensure `TEMP` routes through the tp-recompute pathway after the param update.
  - `src/components/semiconductors/pjfet.ts::setParam` — same.
- **Tests**:
  - `jfet.test.ts::NJFET TEMP::setParam_TEMP_recomputes_tp` — construct NJFET at default `TEMP=300.15`, call `element.setParam("TEMP", 400)`, invoke one `load()` iteration. Probe: set a cold state, drive a forward step that triggers pnjlim, read `s0[SLOT_VGS]` post-limit — it matches the 400K pnjlim output, not the 300.15K output.
  - `jfet.test.ts::PJFET TEMP::setParam_TEMP_recomputes_tp` — same for PJFET.
- **Acceptance criteria**:
  - `setParam('TEMP', newT)` causes the next `load()` to read `tp.vt` at the new temperature for both NJFET and PJFET.
  - 2 tests pass.

**Commit:** `Phase 7.2 — JFET per-instance TEMP parameter`

---

## Testing strategy

Per the user decision on 2026-04-24, Phase 7 tests stay at smoke-only because the engine is not expected to be fully working until Phase 10 acceptance. The existing `src/components/semiconductors/__tests__/jfet.test.ts` is untouched: registration tests, pin-layout tests, the PJFET stamp-emission smoke test, and the NJFET NR convergence smoke test all continue to run.

**Tests deferred to `spec/phase-10-follow-ups.md` §JFET:**

- MODEINITPRED 9-slot state1→state0 copy completeness.
- cghat/cdhat extrapolation numerical output at a seeded operating point (comparing local outputs against hand-rolled ngspice reference via the comparison harness — not hand-computed expected values).
- Noncon gate triggers: `icheckLimited=false, cg diverged > reltol ⇒ noncon++` and similar axis tests.
- NOBYPASS bypass block: bypass-fired, bypass-not-fired, bypass-suppressed-under-MODEINITPRED, bypass-suppressed-under-!ctx.bypass.
- JFET common-source ngspice harness parity — per-NR-iteration `rhsOld[]` bit-exact.
- JFET transient with CGS/CGD non-zero — NIintegrate state transfer bit-exact vs. ngspice.

These tests land after Phase 10 closes the acceptance cycle, when the engine is stable enough that failures are signal rather than noise.

## Phase commit

Two commits, one per wave:

- `Phase 7 — F5ext JFET full convergence port (6 tasks)` — Wave 7.1. All six tasks land together. Rationale: the tasks are tightly coupled (Task 7.1.2's cghat/cdhat feeds Task 7.1.3's bypass; Task 7.1.4's primeJunctions deletion interacts with the MODEINITJCT branch that Task 7.1.1 reads state from; Task 7.1.5's fetlim import removes code Task 7.1.3's bypass never touches but that lives in the same dispatch block). Splitting Wave 7.1 would require re-building intermediate state that is never a stable point in the dispatch flow.
- `Phase 7.2 — JFET per-instance TEMP parameter` — Wave 7.2. Orthogonal to the convergence work in Wave 7.1; separate commit gives a clean revert boundary if TEMP work regresses parity.

## Verification

After Phase 7 lands:

- `npx vitest run src/components/semiconductors/__tests__/jfet.test.ts` — all smoke tests pass.
- Grep njfet.ts + pjfet.ts for `primeJunctions`, `primedFromJct`, `vtsthi`, `vtstlo`, `quirk`, `ctx.vt` — zero hits.
- Grep njfet.ts + pjfet.ts for `const temp = REFTEMP` — zero hits (replaced by `const temp = p.TEMP`).
- Grep njfet.ts + pjfet.ts for `// cite: jfetload.c:135-148`, `// cite: jfetload.c:165-174`, `// cite: jfetload.c:178-208`, `// cite: jfetload.c:498-507`, `// cite: jfettemp.c:83` — each present at least once in each file.
- Grep njfet.ts + pjfet.ts for `fetlim(` — each file contains exactly two calls (vgs and vgd limiting).
- Both NJFET_PARAM_DEFS and PJFET_PARAM_DEFS include `TEMP` with default 300.15 K.
- Compile: `npm run build` succeeds with no new TypeScript errors.

## Out of scope for Phase 7

- Phase 5 Wave 5.0.1's `LoadContext.bypass` + `LoadContext.voltTol` — a precondition, not this phase's work.
- Phase 4 Wave 4.1.1's `fetlim` helper landing — a precondition.
- Rewriting `dc-operating-point.ts:323-324` to stop calling `primeJunctions()` on non-JFET devices — other devices still use it; that's Phase 5/6 scope at most.
- Fixing I2.1's misframing of SLOT_CCAP in diode/inductor as "NIintegrate externalisations" — user action post-Phase-7. Tracked in `spec/phase-10-follow-ups.md` §I2.1 cleanup.
- Updating `src/solver/analog/__tests__/harness/device-mappings.ts` to map diode `SLOT_CCAP` → `DIOcapCurrent` and inductor `SLOT_CCAP` → `INDflux` — same follow-up file, same section.
- JFET behavioural / noise / distortion / AC analysis — not in F5ext scope.
