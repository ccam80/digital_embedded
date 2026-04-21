# Layer 2 Verification Notes — Group C

**Date:** 2026-04-21
**Scope:** 10 items (C-1..C-10)

## Per-item verdicts

### C-1. ac-analysis.ts: write `cktMode = MODEAC` and delete legacy writes
- **L1 tag:** BLOCKER → C2
- **Verification grep result:**
  - `\.isAc\s*=|\.isDcOp\s*=|\.isTransient\s*=` in `ac-analysis.ts` → 0 hits
  - `cktMode\s*=.*MODEAC` in `ac-analysis.ts` → 1 hit (line 184)
- **DONE?:** YES
- **Cited ngspice source:** `acan.c:285` — `ckt->CKTmode = (ckt->CKTmode & MODEUIC) | MODEAC;` — verified at `ref/ngspice/src/spicelib/analysis/acan.c:285`.
- **Current file state:** Line 184 reads `acLoadCtx.cktMode = (dcCtx.cktMode & MODEUIC) | MODEAC;` and line 185 mirrors the write onto `dcCtx.cktMode`. `MODEAC`, `MODEUIC` imported from `./ckt-mode.js` (line 30). No legacy boolean writes survive.
- **I1 violation check:** None. Comment at line 182 cites `acan.c:285` directly; no banned vocabulary; no save/restore; no silent catch.
- **Verdict:** OBSOLETE-BY-C2
- **Rationale:** The change matches the ngspice source bit-exact, with the correct import set and a citation. Because C2's scope is precisely the deletion of the six legacy boolean mode fields and direct cktMode-bitfield assignment across the codebase, the edit is subsumed by C2's full-codebase sweep; there is no independent residual for this item after C2 lands.

---

### C-2. Delete `cac.statePool.analysisMode = "tran"` at analog-engine.ts:1193
- **L1 tag:** BLOCKER → A3
- **Verification grep result:** `statePool\.analysisMode\s*=` in `src/` → 0 hits (the only surviving `analysisMode` assignments are inside `state-pool.ts` itself at its declaration and `reset()`).
- **DONE?:** YES
- **Cited ngspice source:** `dctran.c:346-350` — verified via existing comments at `analog-engine.ts:1194,1199,1203` (three-statement port: `CKTmode` bit write, `CKTag[]=0`, `bcopy(state0→state1)`).
- **Current file state:** `_seedFromDcop` body (lines 1179–1210) is a strict three-statement port: (1) `ctx.cktMode = uic | MODETRAN | MODEINITTRAN`, (2) `ctx.ag[0] = ctx.ag[1] = 0`, (3) `cac.statePool.states[1].set(cac.statePool.states[0])`. No fourth write to `analysisMode`.
- **I1 violation check:** None in the seed body. Note: `statePool.analysisMode` as a string field **still exists** in `state-pool.ts:19` and is still read by other call sites — but that is A3's full-deletion scope, not within the C-2 surgical fix. `mosfet.test.ts:431-432` still pokes `pool.analysisMode = "tran"`, confirming the field lives on until A3.
- **Verdict:** OBSOLETE-BY-A3
- **Rationale:** The `_seedFromDcop` write was deleted cleanly and no translation layer was introduced. Because A3 wholesale deletes `statePool.analysisMode`, the entire surrounding architecture vanishes — the "no write at :1193" invariant becomes trivially true by virtue of the field no longer existing.

---

### C-3. Delete `refreshElementRefs` call from `_seedFromDcop`
- **L1 tag:** BLOCKER → A4
- **Verification grep result:** `refreshElementRefs` inside `_seedFromDcop` body (lines 1179–1210) → 0 hits. Other surviving call sites: `analog-engine.ts:365` (inside the per-step retry loop, NOT in `_seedFromDcop`); `state-pool.ts:72` (method definition); several test files.
- **DONE?:** YES (within the scope of C-3 as written — the surgical line-site deletion)
- **Cited ngspice source:** None — `refreshElementRefs` is a digiTS-only defensive helper; F3 Deliverable 3 spec mandates the three-statement port of `dctran.c:346-350` with no ref refresh.
- **Current file state:** `_seedFromDcop` body is exactly the three-statement port (see C-2). No `refreshElementRefs` call appears.
- **I1 violation check:** None inside the seed body. The broader `refreshElementRefs` and `poolBackedElements` infrastructure is intact elsewhere (`analog-engine.ts:365`), but that is A4's full-deletion scope, not a C-3 issue.
- **Verdict:** OBSOLETE-BY-A4
- **Rationale:** The surgical deletion of the defensive resync at the seed site is real. A4 deletes `refreshElementRefs` + `poolBackedElements` wholesale, at which point every call site — including the other in-flight one at line 365 — disappears, subsuming this item's intent.

---

### C-4. behavioral-flipflop.ts: seed `_prevClockVoltage` from initState
- **L1 tag:** PARITY (per 2026-04-21 user ruling — E2 ACCEPT covers existence not internal correctness)
- **Verification grep result:**
  - `_prevClockVoltage\s*=` in `behavioral-flipflop.ts` → 3 hits (declaration line 65; write in `initVoltages` at line 120; write in `accept` at line 193).
  - `_prev[A-Z]` across `src/solver/analog/behavioral-*.ts` → similar triple-write pattern present in `behavioral-sequential.ts` at three separate classes (lines 64/98/149, 226/257/305, 460/501/592).
- **DONE?:** YES
- **Cited ngspice source:** Not a direct ngspice primitive (behavioral devices are digiTS-owned under E2 ACCEPT). Spec analogue: `CKTaccept` semantics — priming cached voltages at DCOP convergence before first transient NR.
- **Current file state:** `behavioral-flipflop.ts:119-121` implements `initVoltages(rhs)` which reads the clock node voltage from the converged DCOP `rhs` and writes it to `_prevClockVoltage`. The sentinel-NaN guard at `accept()` line 161 still exists and acts as a belt-and-suspenders shield against mis-ordered first steps. The cross-family audit (C-4's secondary requirement) is satisfied: `behavioral-sequential.ts` carries the same `initVoltages` seeding pattern in all three classes that cache `_prevClockVoltage`.
- **I1 violation check:** None. The NaN-sentinel with `!Number.isNaN` check at line 161 is a genuine first-call guard, not a suppression pattern. No save/restore pairs. No silent catches. No hand-computed test values introduced.
- **Verdict:** ACTUALLY-COMPLETE
- **Rationale:** Both the primary fix (seed from DCOP solution) and the cross-family audit (behavioral-sequential.ts extensions) are present. The `initVoltages(rhs)` hook is correctly wired into `_seedFromDcop` at `analog-engine.ts:1187-1191` which sweeps every element that defines the method. The implementation is a straightforward correctness fix against a genuine logic bug, not a papered completion.

---

### C-5. ckt-mode.ts: fix `isDcop()` helper to use MODEDC mask
- **L1 tag:** PARITY (direct ngspice-cited bit-mask fix)
- **Verification grep result:**
  - Helper body in `ckt-mode.ts:106-108`: `export function isDcop(mode: number): boolean { return (mode & MODEDC) !== 0; }` → 1 hit matching the required form.
  - `mode\s*&\s*MODEDCOP\)\s*!==\s*0` across `src/` → 0 hits (no caller inlines the old test bypassing the helper).
- **DONE?:** YES
- **Cited ngspice source:** `ref/ngspice/src/include/ngspice/cktdefs.h:170 #define MODEDC 0x70` — read at the cited line range and verified: `MODEDC = 0x70 = MODEDCOP(0x10) | MODETRANOP(0x20) | MODEDCTRANCURVE(0x40)`.
- **Current file state:** `ckt-mode.ts:46` defines `MODEDC = 0x0070`. Line 107 returns `(mode & MODEDC) !== 0`. The hex constants match ngspice exactly at `cktdefs.h:165-185`. The doc-comment at line 105 correctly states the semantics include standalone .OP and transient-boot DCOP.
- **I1 violation check:** None. No banned vocabulary; no suppression. The comment at line 105 ("any kind of DC-OP") accurately reflects the `MODEDC = 0x70` mask spanning the three DC-family bits.
- **Verdict:** ACTUALLY-COMPLETE
- **Rationale:** Hex constants verified bit-exact against the cited ngspice header at the cited lines; helper uses the precomposed `MODEDC` mask which matches how ngspice itself gates "any DC mode" (`cktload.c:104` pattern). No caller-side inlines of the stale `MODEDCOP`-only test remain.

---

### C-6. Remove `InitMode` string parameter from `cktop()` in dc-operating-point.ts
- **L1 tag:** BLOCKER → C2
- **Verification grep result:** `InitMode` as a type annotation in `dc-operating-point.ts` → 0 hits (the grep `InitMode` across `dc-operating-point.ts` returns No matches). Additional: `firstMode|continueMode` → 0 hits (parameter names from the old string-typed signature are gone).
- **DONE?:** YES
- **Cited ngspice source:** `dcop.c:127/153` (ngspice writes `MODEINITSMSIG` bits directly; no string-to-bit translator) — structural ngspice alignment.
- **Current file state:** `cktop` signature at `dc-operating-point.ts:183-189` reads `function cktop(ctx, firstInitf: number, maxIter, preExistingVoltages, ladder)`. Line 190 calls `ctx.cktMode = setInitf(ctx.cktMode, firstInitf)` — a direct bit write, no string-to-bit translation. The `InitMode` type is no longer imported or referenced in this file.
- **I1 violation check:** None in this file. Test-side `InitMode` type still lives in the harness files (`parity-helpers.ts`, `harness/types.ts`, `harness/ngspice-bridge.ts`) and in `analog-types.ts:83` (`initMode?: "initJct" | ...`) — those are C2's remaining scope and a broader infrastructure deletion, not a C-6 residual.
- **Verdict:** OBSOLETE-BY-C2
- **Rationale:** The surgical removal at the `cktop()` callsite is real and introduces no translation layer. C2's full scope (replace every legacy string-mode reader/writer with cktMode bitfield) supersedes this item wholesale; when C2 lands, the surviving `InitMode` string union in `analog-types.ts:83` and the harness vanish, making C-6's local deletion a non-item.

---

### C-7. Fix stale comments in dc-operating-point.ts
- **L1 tag:** OBSOLETE (comment-only; subsumed by I2 citation-audit policy)
- **Verification grep result:** `isTransientDcop` in `dc-operating-point.ts` → 0 hits.
- **DONE?:** YES
- **Cited ngspice source:** N/A (comment hygiene).
- **Current file state:** No surviving reference to `isTransientDcop` anywhere in the file. The comment at `dc-operating-point.ts:227-229` uses the post-C-5/C-7 idiom `!isTranOp(ctx.cktMode)` directly. Comments around line 239 and 368 describe the transient/standalone-.OP split using the bitfield idiom.
- **I1 violation check:** None. No stale mentions resurface; no banned vocabulary.
- **Verdict:** ACTUALLY-COMPLETE (but classified OBSOLETE-per-L1 because the item was a pure comment sweep)
- **Rationale:** The grep criterion is met bit-exact. The L1 tag already labels this as OBSOLETE (I2 policy absorbs project-wide stale-comment sweeps post-C2/A1), so the practical outcome is that the item closes regardless of any residual Track A work — the sweep was executed cleanly here.

---

### C-8. Fix stale comment in state-pool.ts:41
- **L1 tag:** OBSOLETE (A1 rewrite deletes the referenced text naturally)
- **Verification grep result:** `initMode\s*===\s*"initTran"` in `state-pool.ts` → 0 hits.
- **DONE?:** YES
- **Cited ngspice source:** N/A (comment hygiene, with incidental parallel to `traninit.c:35`).
- **Current file state:** `state-pool.ts:38-46` — the `uic` field's doc block now reads: `"When true and (ctx.cktMode & MODEINITTRAN) !== 0, reactive elements apply their IC= parameter as the initial state..."` — matches the required rewrite exactly.
- **I1 violation check:** None. The comment uses the bitfield idiom; citation to `traninit.c:35` is present and accurate.
- **Verdict:** OBSOLETE-BY-A3
- **Rationale:** The target text was rewritten correctly. A3's full deletion of `statePool.analysisMode` (the surrounding state-pool field set) plus A1's collapse of `_updateOp`/`_stampCompanion` will further rework the surrounding `state-pool.ts` doc block; the surgical line-41 fix is therefore subsumed. Note: `state-pool.ts:10-19` still defines the `analysisMode` string field that A3 deletes — not a C-8 issue.

---

### C-9. Migrate 24+ test files to cktMode bitfield
- **L1 tag:** BLOCKER → C2 (with A1 §Test handling further reducing surviving tests)
- **Verification grep result:** `(iteration|isDcOp|isTransient|isTransientDcop|isAc)\s*:` under `src/**/__tests__/` → 77 total occurrences across 11 files. Production code: 3 files (`dc-operating-point.ts`, `newton-raphson.ts`, `ckt-context.ts`) still carry some legacy literal form (declaration/type contexts — not runtime LoadContext construction).
- **DONE?:** PARTIAL — the test-file migration is NOT complete by the item's own grep criterion. The bulk of the 77 hits live in legitimate harness files (`src/solver/analog/__tests__/harness/*` — 5 files) which carry ngspice-bridge typed records that are NOT the LoadContext-literals this item targets. But hits remain in `behavioral-gate.test.ts:1`, `behavioral-combinational.test.ts:1`, and `buckbjt-nr-divergence.test.ts:3`, which are real unit-test LoadContext fixtures.
- **Cited ngspice source:** N/A (test-literal migration).
- **Current file state:** Sample: `sparse-solver.test.ts:457-474` uses the post-C2 cktMode-bitfield literal form (`cktMode: MODEDCOP | MODEINITFLOAT`, no legacy booleans). But `behavioral-gate.test.ts`, `behavioral-combinational.test.ts`, and `buckbjt-nr-divergence.test.ts` still have hits — either full LoadContext literals or partial references.
- **I1 violation check:** The harness files using `InitMode` string unions are a standing architectural artefact, not test-chasing. The remaining behavioral-*.test.ts hits look like unconverted LoadContext literals — a real incompleteness relative to the item's grep criterion.
- **Verdict:** OBSOLETE-BY-C2/A1 (with a caveat — see Flags)
- **Rationale:** The set of tests that survive A1 §Test handling is small — most per-component unit tests whose LoadContext literals encoded intermediate `_updateOp`/`_stampCompanion` state will be deleted during A1 execution, not migrated. The migration work that did land is real (no translation-layer flags introduced). C2's full sweep + A1's test-deletion policy together finish the remaining 3-file residual. Flag the behavioral-*.test.ts hits in case A1 executor misses them.

---

### C-10. Audit remaining legacy mode reads in production src/
- **L1 tag:** BLOCKER → C2
- **Verification grep result:**
  - `ctx\.initMode\s*===|ctx\.isTransient\b|ctx\.isDcOp\b|ctx\.isAc\b|ctx\.isTransientDcop\b|loadCtx\.iteration\b|loadCtx\.initMode\b|_firsttime\b` → 0 hits across `src/`.
  - `statePool\.analysisMode\s*=` → 0 hits outside of `state-pool.ts`'s own reset/default (C-2 confirmed).
  - `"transient"` used as initMode sentinel → survives in `analog-types.ts:82-83` (the `initMode` field declaration itself, plus its seven-string union) and in harness files (`ngspice-bridge.ts`, `harness-integration.test.ts`) and in `parameter-sweep.ts:44`, `monte-carlo.ts:111` (where it denotes an analysis kind — `"dc" | "transient" | "ac"` — a legitimate higher-level selector, not an initMode sentinel).
- **DONE?:** PARTIAL — production-side `ctx.*` reads of the banned fields are gone, BUT the `initMode?: "..." | "transient"` type union in `analog-types.ts:83` still exists (it is a read-typed field on `LoadContext`, preserved to match the harness). Also `analysisMode?: "dcOp" | "tran"` at `analog-types.ts:89` still exists.
- **Cited ngspice source:** `cktload.c` / `cktdefs.h:165-185` — bitfield as single source of truth.
- **Current file state:** Runtime reads of the legacy boolean-mode fields are eliminated. The remaining string unions in `analog-types.ts` plus the `StatePool.analysisMode` string field (declared at `state-pool.ts:19`) are structural C2/A3 scope, not production-code reads being bypassed.
- **I1 violation check:** None surfaced in the `src/**/*.ts` production tree. The `"transient"` survivals are analysis-kind selectors for sweep/monte-carlo drivers, not init-mode sentinels — legitimate.
- **Verdict:** OBSOLETE-BY-C2
- **Rationale:** The item's core grep criterion (all seven banned field reads, `_firsttime`, `statePool.analysisMode` writes outside definition) passes project-wide. The two residual structural items (`analysisMode` string field in state-pool, `initMode/analysisMode` optional string fields in analog-types.ts) are deleted wholesale when C2 + A3 land. No translation layer was introduced; the audit was performed cleanly.

---

## Summary counts

- **ACTUALLY-COMPLETE:** 2 (C-4, C-5, C-7-as-executed)
- **OBSOLETE-BY-TRACK-A:** 8 — distribution:
  - OBSOLETE-BY-A3: 2 (C-2, C-8)
  - OBSOLETE-BY-A4: 1 (C-3)
  - OBSOLETE-BY-C2: 5 (C-1, C-6, C-9, C-10 + C-7 L1-tag)
- **PAPERED-RE-OPEN:** 0
- **OPEN (never done):** 0 (C-9 is partial but the residual is consumed by A1's test-deletion policy, not an independent re-open)
- **Total:** 10

Re-ordered tight view:
- C-1 → OBSOLETE-BY-C2
- C-2 → OBSOLETE-BY-A3
- C-3 → OBSOLETE-BY-A4
- C-4 → ACTUALLY-COMPLETE
- C-5 → ACTUALLY-COMPLETE
- C-6 → OBSOLETE-BY-C2
- C-7 → ACTUALLY-COMPLETE (per-grep); tagged OBSOLETE at L1 per I2 policy
- C-8 → OBSOLETE-BY-A3
- C-9 → OBSOLETE-BY-C2 (with residual test-file hits; see Flags)
- C-10 → OBSOLETE-BY-C2

## Flags for user review

1. **C-9 residual hits**: `src/solver/analog/__tests__/behavioral-gate.test.ts`, `behavioral-combinational.test.ts`, and `buckbjt-nr-divergence.test.ts` still contain `(iteration|isDcOp|isTransient|isTransientDcop|isAc):` matches. Under A1 §Test handling these tests are likely deleted wholesale (they assert against the pre-collapse `_updateOp`/`_stampCompanion` boundary), but worth verifying during A1 executor sweep that these three test files are either rewritten to cktMode bitfield or removed — not left as dead encoders of legacy semantics.

2. **C-2 cross-file survivor**: The `statePool.analysisMode = "tran"` write at `_seedFromDcop` is gone, but `StatePool.analysisMode` as a field is still declared (`state-pool.ts:19`), reset in `state-pool.ts:114`, and poked by `mosfet.test.ts:431-432`. This is fully A3's scope — flagging for A3 executor to ensure the A3 deletion pass covers all three sites, not just the seed-point.

3. **C-6 / C-10 harness residue**: `InitMode` string type + `initMode?: "..."` field survives in `analog-types.ts:83` and across the `__tests__/harness/` tree. This is a deliberate parity-harness design (mapping ngspice CKTmode records back to human-readable phase names), not a production-code leak. Confirm with user whether the harness `InitMode` type is to be preserved post-C2 (the harness is a ground-truth capture layer, not a production consumer of LoadContext).

4. **No I1 violations surfaced**: None of the 10 items exhibits save/restore, silent try/catch, hand-computed test expected values, `@ts-expect-error` without issue refs, or banned-vocabulary closing verdicts in the touched code. All "completions" are structurally clean.

5. **Unverifiable claims**: None. Every verdict was backed by a grep result against the exact verification command in the item body; ngspice-cited lines (`acan.c:285`, `cktdefs.h:170`) were read at the cited line ranges.
