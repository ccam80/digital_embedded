# ngspice alignment — Phase 1 verification report

All 17 divergences from `spec/ngspice-alignment-divergences.md` were reviewed for factual accuracy by 5 independent verification agents. Additional divergences surfaced during review are appended. Every item here is a critical failure to reach 100% ngspice parity. No triage. No prioritization.

---

## Verification verdict on original 17

| # | Title | Verdict | Notes |
|---|---|---|---|
| 1 | tranInit reorder timing | **ACCURATE** | ngspice reorders BEFORE iter 0 factor; ours AFTER. Confirmed at cited line numbers. |
| 2 | dcopFinalize runs full NR | **ACCURATE** | ngspice: one CKTload. Ours: cktLoad + preorder + factor + solve + convergence + damping + hook. |
| 3 | `_numericLUReusePivots` no partial-pivot guard | **ACCURATE (refined)** | ngspice routes `MODEINITTRAN && iterno==1` through `spOrderAndFactor` which has guard (spfactor.c:214-227). Ours routes through `_numericLUReusePivots` which has no guard. ngspice's `spFactor` reuse path also lacks the column-relative guard, but that path is not reached for the failing case. |
| 4 | Pivot threshold magnitude | **ACCURATE (refined)** | We have both `PIVOT_THRESHOLD=1e-3` (used only in `_searchForPivot`) and `PIVOT_ABS_THRESHOLD=1e-13` (sole check in `_numericLUReusePivots`). ngspice defaults `AbsThreshold=0.0`. Two separate problems: absence of column-relative guard in reuse path, and non-zero absolute default. |
| 5 | Transient-DCOP skips MODEINITTRAN | **ACCURATE (structural)** | Structural divergence confirmed: ngspice sets at transition, ours defers via `_firsttime`. Nominal path does reach `initTran` (`_seedFromDcop` sets `_firsttime=true`), so not functionally broken on happy path — but structurally non-parallel and dangerous for any step() path without DCop. |
| 6 | `dcopFinalize` on transient-DCOP | **ACCURATE** | ngspice `dctran.c:230-346` has NO `CKTload` between `CKTop` and MODEINITTRAN. We call `dcopFinalize` unconditionally on all converged DC-OP paths, including transient-boot. |
| 7 | `"initSmsig"` mode gates no device code | **ACCURATE** | 0 device `load()` methods in `src/components/**/*.ts` inspect `initSmsig`. All four ngspice cites confirmed except `b3ld.c:265` — gates are at `b3ld.c:194, 2813`. |
| 8 | cktLoad iteration parameter | **PARTIAL** | Signature divergence real. Spec's example claim ("consumed by diode damping and BJT junction limiting paths that condition on `iteration === 0`") is factually **wrong** for current code — those branches gate on `initMode === "initJct"`. No production device reads `ctx.iteration`. The signature surface is latent divergence. |
| 9 | Preorder sees pre-stamped Gmin | **PARTIAL** | Spec's framing that ngspice "applies gmin inside factor" is wrong: ngspice's `SMPluFac` calls `LoadGmin` then `spFactor` — same pre-factor stamp shape as ours. **Real divergence**: our `solver.factor()` dispatcher (`sparse-solver.ts:405-410`) silently drops the `diagGmin?` parameter accepted by `factorWithReorder`/`factorNumerical`. Gmin management is entirely out-of-band in our NR loop; ngspice's is atomic inside `SMPluFac`/`SMPreorder`. |
| 10 | `_hasPivotOrder` semantic mismatch | **PARTIAL** | We DO have two flags (`_hasPivotOrder` ↔ `Factored`, `_needsReorder` ↔ `NeedsOrdering`). Spec's "one flag conflates meanings" is wrong. Real divergence is in the mutation points — particularly `_needsReorder` is never auto-set by element insertion (see #11). |
| 11 | `invalidateTopology` trigger parity | **ACCURATE (stronger)** | Confirmed worse than described: ZERO production call sites of `invalidateTopology()`. `allocElement` does not flip `_needsReorder` on new insertions. Additional ngspice triggers at `sputils.c:1042, 1112, 1264` not cited. |
| 12 | `_seedFromDcop` structural parallel | **ACCURATE** | 3 flat statements in ngspice vs ~48 lines + multiple abstractions in ours. MODEINITTRAN specifically deferred via `_firsttime`. Extra `el.accept()` sweep and `refreshElementRefs` have no ngspice analogue. |
| 13 | Band-aid commits | **ACCURATE, + more found** | `d4dc1e3c` confirmed. Additional band-aids identified: `44ab1313` (linear-circuit hook bypass), `9351442` items N2/N3 (cktop/cktncDump argument-value fixes), `d9c48666` (performance_50_node PRNG determinism patch). |
| 14 | Untrusted citations | **ACCURATE, + more found** | `b4add694` commit message + current comments at `dc-operating-point.ts:209, 219` misattribute to `cktop.c`. Additional mis-cites: `core/analog-types.ts:82` (`niiter.c:991-997` does not exist); `newton-raphson.ts:344` comment conflates `niiter.c:957` with `cktop.c:170` semantics. |
| 15 | Partial spec implementation | **ACCURATE, + more found** | `phase-4-dcop-alignment.md` Task 4.1.2: `transient` write removed, `runNR → CKTload` replacement NOT delivered. `phase-7-verification.md` Wave 7.2-7.4 parity tests structurally unrunnable until all divergences close. `phase-0-sparse-solver-rewrite.md` `_buildEtree` deletion shipped as post-hoc cleanup in `9351442` rather than at Phase 0 close. `phase-catchup.md` Wave C5 completion state unverifiable from specs alone. |
| 16 | Limiting events not firing | **ACCURATE, root cause found** | `cktLoad` (`ckt-load.ts:41-87`) never syncs `ctx.loadCtx.limitingCollector = ctx.limitingCollector`. All other CKTCircuitContext→LoadContext field syncs are done. Devices read `ctx.loadCtx.limitingCollector` — always `null`. Events from `pnjlim`/`fetlim`/`limvds` calls are pushed to a permanently-null collector. |
| 17 | wasLimited comparison fails | **ACCURATE** | Same root cause as #16. |

---

## Additional divergences surfaced during verification

### Sparse solver / NR loop

- **S1.** `SparseSolver.factor()` (`sparse-solver.ts:405-410`) drops the `diagGmin?` parameter that `factorWithReorder`/`factorNumerical` accept (lines 1320, 1338). Gmin cannot be plumbed through the public factor API; callers must use `addDiagonalGmin` out-of-band.
- **S2.** `CKTpivotAbsTol` / `CKTpivotRelTol` not plumbed. ngspice passes them as per-call parameters to `SMPreorder`/`SMPluFac` (niiter.c:863, 884). Ours hard-codes module-level constants (`sparse-solver.ts:23-24`); not sourced from `ctx`.
- **S3.** `didPreorder` scope mismatch. ngspice `NIDIDPREORDER` is CKT-lifetime persistent (cleared only in `NIreinit`). Our `didPreorder` local in `newtonRaphson` (`newton-raphson.ts:252`) is per-NR-call; the solver-internal `_didPreorder` is solver-lifetime. Invariant shape diverges from ngspice's CKT-lifetime flag.
- **S4.** `_needsReorder` not flipped by `addDiagonalGmin`. If a caller calls `addDiagonalGmin` twice before `beginAssembly`, gmin stacks. ngspice has the same risk structurally, but always calls `LoadGmin` exactly once per factor internally — our NR loop owns the invariant instead of the solver.
- **S5.** `invalidateTopology()` does not set `_needsReorder = true`. Clears `_hasPivotOrder` only. Next factor dispatches to `factorWithReorder` via `!_hasPivotOrder`, so functional behavior is OK, but the flag lifecycle shape differs.
- **S6.** `_searchForPivot` phase 3 column search walks `_colHead[k]` only (`sparse-solver.ts:1421-1440`). ngspice's phase 3 walks Markowitz products across ALL columns. Potential pivot-selection correctness divergence outside the initial scope.
- **S7.** `allocElement` does not flag reorder on new insertions. ngspice `spcCreateElement` sets `NeedsOrdering = YES` at `spbuild.c:788`. See #11.

### DC-OP / transient transition

- **B1.** `CKTmode` fanned out across 4 fields: `statePool.analysisMode`, `ctx.isTransient`, `ctx.isTransientDcop`, `ctx.loadCtx.isTransientDcop`. ngspice has one `CKTmode` word. Four mirrors = four ways to drift out of sync.
- **B2.** `_seedFromDcop` sweeps `el.accept()` with `dt=0, simTime=0` for every element (`analog-engine.ts:1205-1212`). ngspice `dctran.c:230-351` has no DEVaccept sweep at this transition. Comment claims "Matches ngspice DEVaccept post-CKTop call" — **unsupported**; no such call exists in `dctran.c` between `CKTop` return and MODEINITTRAN stamp.
- **B3.** `exactMaxIterations` escape hatch (`newton-raphson.ts:239`) bypasses the `maxIter < 100` floor. ngspice's `niiter.c:622` floor is unconditional. The bypass exists to support `dcopFinalize`'s one-iteration pass — a workaround downstream of divergence #2.
- **B4.** `_seedFromDcop` calls `refreshElementRefs` (`analog-engine.ts:1197`). No ngspice equivalent. Architectural artifact of our pool-backed element design; if the callback mutates observable state beyond ref-rebinding, becomes functional.
- **B5.** `isTransient = false` during transient-boot DCOP sub-solves (`dc-operating-point.ts:157`). ngspice `CKTmode` during transient-boot DCOP is `MODETRANOP` (= `MODETRAN | MODEDCOP`) — MODETRAN bit IS set. Our flag is the opposite of ngspice's bit.
- **B6.** `step()` writes `ctx.initMode = "transient"` (`analog-engine.ts:472-475`) after `newtonRaphson` returns. Two writers for the same field (NR STEP J also writes initMode). The `"transient"` sentinel has no ngspice counterpart — ngspice cycles `MODEINITTRAN → MODEINITFLOAT → MODEINITPRED`.
- **B7.** `dcopFinalize` return state: `ctx.initMode` left as `"initSmsig"` (STEP J dispatcher skipped due to `exactMaxIterations`). Leaks between `dcopFinalize` return and next `step()`. Next `step()` overwrites, but any reader in between sees stale value.
- **B8.** `solveDcOperatingPoint` writes `ctx.initMode = "initFloat"` at 6+ points (`dc-operating-point.ts:507, 599, 652, 710, 722, 743`). Layered on top of NR-internal writes. ngspice's `CKTmode` is written only by `NIiter` after CKTop/DCtran setup.

### cktLoad / LoadContext

- **C1.** `ckt-load.ts:47-54` flattens `CKTmode` bitfield into 5 booleans (`isDcOp`, `isTransient`, `isTransientDcop`, `isAc`, plus `initMode` string). Type system permits impossible states (e.g., `isDcOp && isTransient`) that ngspice's bitmask forbids.
- **C2.** `ckt-load.ts:55` resets `noncon.value = 0` inside `cktLoad`. ngspice `cktload.c:57-58` only snapshots under `STEPDEBUG`; reset is caller's responsibility. Semantic difference in noncon ownership.
- **C3.** `ctx.noncon = ctx.loadCtx.noncon.value` (`ckt-load.ts:61`) — two-hop path where ngspice has one `CKTnoncon` location.
- **C4.** `ckt-load.ts:74` gate `ctx.isDcOp && (initMode === "initJct" || "initFix")` may be narrower than ngspice's `MODEDC` bitmask at `cktload.c:104`. If DC sweep (non-DCOP MODEDC) should fire nodesets, ours skips.
- **C5.** Nodesets and ICs applied together under single gate. ngspice `cktload.c:106-129` (nodesets, `MODEINITJCT | MODEINITFIX`) and `:130-157` (ICs, `MODETRANOP && !MODEUIC`) are distinct. Our code applies both under `isDcOp && (initJct || initFix)`. ICs should only apply under MODETRANOP (transient-DCOP) without UIC.
- **C6.** No `DEVload`-null guard in our loop (`ckt-load.ts:58`). ngspice `cktload.c:62` has full `if (DEVices[i] && DEVices[i]->DEVload && ckt->CKThead[i])`.
- **C7.** `CKTtroubleNode` not tracked. ngspice `cktload.c:64-65` clears trouble-node every time `CKTnoncon` rises. Our per-iteration trouble-tracking absent.

### Limiting

- **L1.** `pnjlim` positive-vold branch implements a DIFFERENT formula than ngspice `devsup.c:57-61`. ngspice: `arg = (vnew - vold) / vt`, `vnew = vold + vt * (2 + log(arg - 2))` for `arg > 0`, `vnew = vold - vt * (2 + log(2 - arg))` otherwise. Ours (`newton-raphson.ts:93-96`): `arg = 1 + (vnew - vold) / vt`, `vnew = vold + vt * log(arg)` for `arg > 0`, else `vnew = vcrit`. **Numerically different results for any large positive forward swing.** This is the Gillespie large-signal limiter — ours is not it.
- **L2.** `pnjlim` negative-vnew limiting branch entirely absent. ngspice `devsup.c:67-82` limits large negative swings and sets `*icheck = 1` when `vnew < arg`. Our `else` branch (`newton-raphson.ts:103-105`) unconditionally sets `limited = false`. ngspice may declare non-convergence here; we cannot.
- **L3.** `fetlim` vtstlo formula wrong. ngspice `devsup.c:102`: `vtstlo = fabs(vold - vto) + 1`. Ours (`newton-raphson.ts:135`): `vtstlo = vtsthi / 2 + 2`. Doc comment describes ngspice formula; code implements a different one.
- **L4.** `cktLoad` never syncs `ctx.loadCtx.limitingCollector = ctx.limitingCollector`. `LoadContext.limitingCollector` is permanently `null`. Every device pnjlim/fetlim/limvds call pushes to `null` — events never surface. (Smoking gun for tests #10 and #14.)

### Process / documentation

- **P1.** Additional band-aids: `44ab1313`, `9351442` items N2/N3, `d9c48666`.
- **P2.** Additional mis-cites: `core/analog-types.ts:82` (`niiter.c:991-997` nonexistent), `newton-raphson.ts:344` (conflates niiter.c:957 with cktop.c:170).
- **P3.** `phase-7-verification.md` Wave 7.2-7.4 tests structurally blocked until all divergences close.
- **P4.** `phase-0-sparse-solver-rewrite.md` shipped with `_buildEtree` still present; deleted post-hoc in `9351442`.

---

## Verification complete. Phase 2 gate.

Every item above is a ngspice-parity failure. The only permitted "intentional" divergence is pure diagnostics/logging — none of the above qualifies.

Proposed Phase 2 grouping by shared mechanism/file for concrete ngspice-exact fix proposals:

- **Group F1 — `sparse-solver.ts` reuse/factor/reorder core**: #3, #4, #9, #10, #11, S1, S2, S3, S4, S5, S6, S7.
- **Group F2 — NR loop & reorder timing**: #1.
- **Group F3 — DC-OP finalize & transient transition**: #2, #5, #6, #12, B1, B2, B3, B4, B5, B6, B7, B8.
- **Group F4 — cktLoad / LoadContext / init-mode gating**: #7, #8, C1, C2, C3, C4, C5, C6, C7.
- **Group F5 — Voltage limiting (devsup port + wiring)**: #16, #17, L1, L2, L3, L4.
- **Group F6 — Documentation / citations / process debt**: #13, #14, #15, P1, P2, P3, P4.
