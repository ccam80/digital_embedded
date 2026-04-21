# Fix List — 2026-04-21 Phase 2 Audit Response

## Overriding rule (non-negotiable)

> Complete match with ngspice, no exceptions. Close-enough is not acceptable. Any spec-divergent code is a critical bug. The only remedy is re-implementation to spec. "Latent divergence", "redundant but harmless", "pre-existing failure", and similar excuse-framing are unacceptable — every divergence is critical.

This rule overrides all agent-level instructions about "smallest viable diff", "minimal change", or "do not broaden scope". Scope is defined by the spec (F1–F6 / F-bjt / F-mos), not by agent preference.

## Execution protocol for this list

- **Each fix cites ngspice source.** The cited file + line is authoritative.
- **Grep-only verification.** Execution agents MUST NOT run tests to verify their work. Tests in this repo are partially stale and partially incorrect (this audit identified 5 "pre-existing" test failures that are in fact spec-correct behavior on failing tests, plus 24+ test files with deleted field references). An agent that uses failing tests as a signal to revert a spec-aligned change corrupts the codebase. **Verification is grep-based only, per the grep commands supplied with each fix.**
- **Do not revert spec-aligned changes because a test fails.** If a test fails after your change, that is expected information — NOT a trigger to undo the change. Forward the test name and failure to the orchestrator.
- **Do not introduce new excuse framing.** No "for now", "temporary", "pre-existing", "redundant but harmless", "latent", "fallback", "legacy", "previously", "workaround", "TODO", "FIXME", "HACK", "deferred". Comments describing divergence from spec are themselves spec violations.

## Fix count summary

| Group | Fixes | Ngspice-aligned? | User input required? |
|-------|-------|------------------|----------------------|
| A. Phase 0 — banned exp clamps & historical comments | 4 | Yes | No |
| B. Phase 1 — sparse solver pre-factor snapshot | 4 | Yes | No |
| C. Phase 2 Infrastructure — cktMode, AC analysis, flipflop | 10 | Yes | **1 (ckt-mode hex constants)** |
| D. Phase 2 Device loads — diode, BJT, MOSFET, cap, inductor | 15 | Yes | **3 (schema slots, default values)** |
| E. Phase 2 Remaining devices — triac, LED | 2 | Yes | No |
| F. Test migration | 27+ files | Yes | No |
| G. Weak-test strengthening | ~25 tests | Yes (reference values from harness) | No |

**Total: 4 items need user design decisions; everything else is spec-aligned re-implementation.**

---

## Group A — Phase 0: Banned exp clamps & historical comments

### A-1. Remove `Math.min(expArg, 80)` clamps from njfet.ts
**Reconciliation:** PARITY (banned exp clamp removal is a direct ngspice-source-cited numerical fix against `jfetload.c`; stands on its own after Track A lands)

- **File**: `src/components/semiconductors/njfet.ts`, lines 284, 302, 320, 381
- **Current**: `const expArg = Math.min(this._vgs_junction / vt_n, 80); ... Math.exp(expArg)`
- **Required**: `Math.exp(this._vgs_junction / vt_n)` — ngspice `jfetload.c` does not clamp. Voltage limiting is upstream (`pnjlim`/`fetlim`), not at `exp`.
- **Ngspice ref**: `ref/ngspice/src/spicelib/devices/jfet/jfetload.c` (grep for `exp(` — no `min` wrapper).
- **Verification grep**: `Math\.min\([^)]*80\)` in `njfet.ts` → 0 hits.

### A-2. Remove `Math.min(expArg, 80)` clamps from pjfet.ts
**Reconciliation:** PARITY (banned exp clamp removal against `jfetload.c`; stands independent of Track A)

- **File**: `src/components/semiconductors/pjfet.ts`, lines 137, 155, 173, 235
- **Current**: identical banned pattern, all four mode branches.
- **Required**: same as A-1.
- **Verification grep**: `Math\.min\([^)]*80\)` in `pjfet.ts` → 0 hits.

### A-3. Remove historical-provenance comment at bjt.ts:55
**Reconciliation:** OBSOLETE (pure comment cleanup of a stale provenance line; subsumed by the general I2 citation-audit policy — no standalone work remains)

- **File**: `src/components/semiconductors/bjt.ts`, line 55
- **Current**: `// BJ1: VT import removed — all code now uses tp.vt (temperature-dependent thermal voltage)`
- **Required**: delete entirely. Current state of code is self-evident from usage.
- **Note**: This is handled by the in-flight relabel agent; if not already done, re-apply here.
- **Verification grep**: `VT import removed` in `bjt.ts` → 0 hits.

### A-4. Remove banned word "fallback" from bjt.ts:1516
**Reconciliation:** OBSOLETE (comment-only rewording to drop a banned word; no numerical or structural change, handled under I2 policy hygiene)

- **File**: `src/components/semiconductors/bjt.ts`, line 1516
- **Current**: `// bjtload.c:258-276: MODEINITJCT with OFF / UIC / fallback.`
- **Required**: Replace with `// bjtload.c:258-276: MODEINITJCT dispatch — OFF branch, UIC branch, and the else (vcrit) branch.`
- **Verification grep**: `fallback` in `bjt.ts` → 0 hits.

---

## Group B — Phase 1: Sparse solver

### B-1. Extract `_takePreFactorSnapshotIfEnabled()` helper and move snapshot AFTER `_applyDiagGmin`
**Reconciliation:** BLOCKER → B3 (snapshot-vs-gmin ordering is the direct symptom of B3 "Gmin stamped outside factor, not passed to factor routine"; resolving B3 eliminates the separate snapshot hazard)

- **File**: `src/solver/analog/sparse-solver.ts`, lines 481–517 + 1603–1624
- **Current**: snapshot block is inline at the top of `factor()`, BEFORE `_applyDiagGmin` runs (in `factorWithReorder`/`factorNumerical`). Result: `getPreFactorMatrixSnapshot()` returns A, but the matrix actually factored is A + gmin·I.
- **Required** (per F1.1 spec, verbatim): delete snapshot block from `factor()`; add private method `_takePreFactorSnapshotIfEnabled()` that performs the existing snapshot logic; call it inside both `factorWithReorder` and `factorNumerical` **immediately after** `_applyDiagGmin`.
- **Ngspice ref**: N/A — ngspice has no snapshot feature; this is a digiTS diagnostic that must correctly reflect the factored matrix.
- **Verification grep**: `_takePreFactorSnapshotIfEnabled` in `sparse-solver.ts` → ≥3 hits (definition + 2 call sites). No snapshot block remains inside `factor()` body (grep `_preFactorMatrix\s*=` inside `factor(` scope → 0 hits).

### B-2. Fix misleading comment at sparse-solver.ts:1490-1495
**Reconciliation:** OBSOLETE (comment-only cleanup; I2 policy covers stale-citation sweeps across the solver when B1/B2 architecture lands)

- **File**: `src/solver/analog/sparse-solver.ts`, lines 1490–1495
- **Current**: Comment says "Do NOT demand reorder here" but return is `{ success: false, needsReorder: true }`.
- **Required**: Correct comment to reflect actual return. Per F1.1 Item #3 Part C, both paths (relative-threshold guard + absolute-threshold guard) return `needsReorder: true`.
- **Verification grep**: `Do NOT demand reorder` in `sparse-solver.ts` → 0 hits.

### B-3. Migrate sparse-solver.test.ts `rawCtx` literal (line 456-478)
**Reconciliation:** BLOCKER → C2 (legacy `iteration`/`isDcOp`/`isTransient` LoadContext fields are deleted by C2 direct MODEINITTRAN assignment + cktMode bitfield adoption; this test-literal migration rides that wave)

- **File**: `src/solver/analog/__tests__/sparse-solver.test.ts`, lines 456–478
- **Current**: `rawCtx` constructs `LoadContext` with removed fields (`iteration`, `initMode`, `isDcOp`, `isTransient`, `isTransientDcop`, `isAc`) and omits `cktMode`.
- **Required**: Remove all 6 legacy fields. Add `cktMode: MODEDCOP | MODEINITFLOAT` (import from `ckt-mode.js`).
- **Verification grep**: `iteration\s*:\s*0` in `sparse-solver.test.ts` → 0 hits; `cktMode\s*:` in `sparse-solver.test.ts` → ≥1 hit per LoadContext literal.

### B-4. Strengthen sparse-solver weak tests (WT-001, WT-002, WT-003)
**Reconciliation:** BLOCKER → B1 + B2 (pivot-threshold and reorder-state assertions are defined by B1 absolute-vs-column-relative threshold and B2 `_hasPivotOrder` conflation fixes; the concrete expected values follow from those)

- **Files**: `src/solver/analog/__tests__/sparse-solver.test.ts`
- **Required**:
  - `returns failure when pivot becomes near-zero` — add `expect(result.needsReorder).toBe(true)` after `expect(result.success).toBe(false)`.
  - `detects singular matrix` — add `expect(result.singularRow).toBe(<exact row index>)` (compute from the 2×2 singular matrix).
  - `factor() sets lastFactorUsedReorder=false on second call` — correct the false comment "_needsReorder starts false" (after Task 1.1.2 it starts `true`).
- **Verification grep**: `needsReorder.*toBe(true)` appears in the relevant test bodies.

---

## Group C — Phase 2 Infrastructure

### C-1. ac-analysis.ts: write `cktMode = MODEAC` and delete legacy writes
**Reconciliation:** BLOCKER → C2 (removal of the six legacy boolean mode fields and adoption of direct cktMode bit assignment is the direct scope of C2 "_firsttime flag vs direct MODEINITTRAN assignment" architectural sweep; also touches A3 analysisMode deletion)

- **File**: `src/solver/analog/ac-analysis.ts`, lines 183–191
- **Current**: writes deleted LoadContext fields (`isAc`, `isDcOp`, `isTransient`). Never sets `cktMode = MODEAC`. Devices reading `cktMode & MODEAC` see 0 during the entire AC sweep.
- **Required** (per ngspice `acan.c:285`): `acLoadCtx.cktMode = (dcCtx.cktMode & MODEUIC) | MODEAC;` + delete all 6 legacy boolean writes + delete the comment at lines 183–184 referencing them. Import `MODEAC`, `MODEUIC` from `ckt-mode.js`.
- **Verification grep**: `\.isAc\s*=` / `\.isDcOp\s*=` / `\.isTransient\s*=` in `ac-analysis.ts` → 0 hits. `cktMode\s*=.*MODEAC` in `ac-analysis.ts` → ≥1 hit.

### C-2. Delete `cac.statePool.analysisMode = "tran"` at analog-engine.ts:1193
**Reconciliation:** BLOCKER → A3 (statePool.analysisMode is the exact duplicate-of-CKTmode string field A3 deletes wholesale; no line-specific surgical fix survives after A3)

- **File**: `src/solver/analog/analog-engine.ts`, line 1193
- **Current**: `cac.statePool.analysisMode = "tran";`
- **Required**: Delete line. The F3 `_seedFromDcop` spec is a strict three-statement port of dctran.c:346-350; no fourth write.
- **Ngspice ref**: `ref/ngspice/src/spicelib/analysis/dctran.c:346-350`.
- **Verification grep**: `statePool\.analysisMode\s*=` in `src/` → 0 hits outside of the pool's own definition.

### C-3. Delete `refreshElementRefs` call from `_seedFromDcop`
**Reconciliation:** BLOCKER → A4 (refreshElementRefs is the defensive-resync helper A4 deletes wholesale along with poolBackedElements; removing this call-site is one symptom of the umbrella deletion)

- **File**: `src/solver/analog/analog-engine.ts`, `_seedFromDcop` function body
- **Current**: The function retains a `cac.statePool.refreshElementRefs(...)` call with a comment "Kept as a defensive resync".
- **Required** (per F3 Deliverable 3): strict three-statement port — cktMode write, ag[] zeros, `states[1].set(states[0])`. No ref refresh.
- **Verification grep**: `refreshElementRefs` inside `_seedFromDcop` body → 0 hits.

### C-4. behavioral-flipflop.ts: seed `_prevClockVoltage` from initState
**Reconciliation:** PARITY (2026-04-21 user ruling: E2's APPROVED ACCEPT covers behavioral-*.ts's *existence*, not its internal correctness; the never-primed `_prevClockVoltage` cache is a genuine logic bug in digiTS-owned code and stands as PARITY work against the post-A1 codebase)

- **File**: `src/solver/analog/behavioral-flipflop.ts`, line 65 + `initState()` method (add if missing)
- **Current**: `_prevClockVoltage = NaN`, only written by `accept()`. After F3 removed the `el.accept()` sweep from `_seedFromDcop`, this field is never primed before the first transient step.
- **Required**: Add an `initState(ctx)` method that reads the DC-OP clock voltage from the solution vector (or from state0 via the pool) and writes it to `_prevClockVoltage`. Verify the same fix applies to any other behavioral element that caches voltages across step boundaries.
- **Ngspice ref**: not a direct ngspice concept (behavioral-only), but analogous to `ACCEPT` callback runs that ngspice does fire at DC-OP convergence via `CKTaccept`; our alternative path is `initState`.
- **Verification grep**: `_prevClockVoltage\s*=` in `behavioral-flipflop.ts` → ≥2 hits (`initState` write + `accept` write). Audit similar fields across `behavioral-*.ts`: run `rg -l '_prev[A-Z]' src/solver/analog/behavioral-*.ts` and add `initState` handling for any field found.

### C-5. ckt-mode.ts: fix `isDcop()` helper to use MODEDC mask
**Reconciliation:** PARITY (helper bit-mask bug is a direct ngspice-cited numerical fix against `cktdefs.h:170 #define MODEDC 0x70`; stands independent of Track A)

- **Decision**: verified against `ref/ngspice/src/include/ngspice/cktdefs.h:165-185`. All hex constants in `ckt-mode.ts` match ngspice exactly (MODETRANOP = 0x20 is a standalone bit, MODEDC = 0x70 is a pre-defined mask equal to `MODEDCOP | MODETRANOP | MODEDCTRANCURVE`). The bug is in the helper logic only.
- **File**: `src/solver/analog/ckt-mode.ts`, lines 106–108
- **Current**: `isDcop(mode): return (mode & MODEDCOP) !== 0` — only catches standalone `.OP`, misses MODETRANOP (transient-boot DCOP) and MODEDCTRANCURVE (DC sweep).
- **Required**: `isDcop(mode): return (mode & MODEDC) !== 0`. `MODEDC` (0x0070) is already defined in `ckt-mode.ts`; just wire it into the helper.
- **Ngspice ref**: cktdefs.h:170 `#define MODEDC 0x70`. This is the mask ngspice itself uses wherever "any DC mode" is the gating question.
- **Caller audit**: check `src/solver/analog/newton-raphson.ts:431` (node damping) and `:482` (nodeset ipass) — both currently call `isDcop(ctx.cktMode)` and must now apply during transient-boot DCOP per ngspice. No caller-side change needed if they use the helper; verify no caller inlines `(mode & MODEDCOP) !== 0` bypassing the helper.
- **Verification grep**: 
  - `isDcop\(mode\)\s*\{\s*[\s\S]*?mode\s*&\s*MODEDC\b` in `ckt-mode.ts` → 1 hit.
  - `mode\s*&\s*MODEDCOP\)\s*!==\s*0` across `src/**/*.ts` → 0 hits (or only inside callers that genuinely want the standalone-.OP distinction, which must be cited with ngspice source).

### C-6. Remove `InitMode` string parameter from `cktop()` in dc-operating-point.ts
**Reconciliation:** BLOCKER → C2 (InitMode string-to-bit translation is precisely the legacy string-mode infrastructure C2 replaces with direct MODEINIT* bit writes)

- **File**: `src/solver/analog/dc-operating-point.ts`, lines 187–201
- **Current**: `cktop(ctx, firstMode: InitMode, _continueMode: InitMode, ...)` takes string params and translates to INITF bits internally.
- **Required**: Replace parameter type with `firstInitf: number`; delete the internal string→bit translation; update all 3 callers to pass INITF bits directly.
- **Verification grep**: `InitMode` appearing as a type annotation in `dc-operating-point.ts` → 0 hits.

### C-7. Fix stale comments in dc-operating-point.ts
**Reconciliation:** OBSOLETE (stale-comment sweep for deleted `isTransientDcop` references; I2 policy covers citation/comment hygiene after C2 lands)

- **File**: `src/solver/analog/dc-operating-point.ts`, lines 239, 368
- **Current**: comments reference `isTransientDcop === false` (deleted field).
- **Required**: rewrite each comment to reference `!isTranOp(ctx.cktMode)`.
- **Verification grep**: `isTransientDcop` in `dc-operating-point.ts` → 0 hits.

### C-8. Fix stale comment in state-pool.ts:41
**Reconciliation:** OBSOLETE (stale-comment-only; A1 rewrites state-pool.ts extensively and A3 removes analysisMode — the referenced `initMode === "initTran"` text vanishes naturally under the rewrite)

- **File**: `src/solver/analog/state-pool.ts`, line 41
- **Current**: `When true and initMode === "initTran", reactive elements apply their ...`
- **Required**: rewrite to reference `(ctx.cktMode & MODEINITTRAN) !== 0`.
- **Verification grep**: `initMode\s*===\s*"initTran"` in `state-pool.ts` → 0 hits.

### C-9. Migrate 24+ test files to cktMode bitfield
**Reconciliation:** BLOCKER → C2 (A1 §Test handling rule says per-component unit tests using the legacy boolean-mode LoadContext are largely deleted during A1 execution, not migrated; what survives is re-authored under C2's cktMode bitfield regime — this migration task is subsumed either way)

- **Files** (non-exhaustive — execute `rg -l 'iteration\s*:\s*0|isDcOp\s*:|isTransient\s*:|isTransientDcop\s*:|isAc\s*:' src/**/__tests__/` to enumerate):
  - `src/components/sensors/__tests__/spark-gap.test.ts`
  - `src/components/sensors/__tests__/ntc-thermistor.test.ts`
  - `src/components/passives/__tests__/memristor.test.ts`
  - `src/components/passives/__tests__/analog-fuse.test.ts`
  - `src/solver/__tests__/coordinator-bridge.test.ts`
  - `src/solver/__tests__/coordinator-bridge-hotload.test.ts`
  - `src/components/semiconductors/__tests__/zener.test.ts`
  - `src/components/semiconductors/__tests__/triac.test.ts`
  - `src/components/semiconductors/__tests__/scr.test.ts`
  - `src/components/sources/__tests__/variable-rail.test.ts`
  - `src/components/sources/__tests__/ground.test.ts`
  - `src/components/sources/__tests__/dc-voltage-source.test.ts`
  - `src/components/sources/__tests__/current-source.test.ts`
  - `src/components/sources/__tests__/ac-voltage-source.test.ts`
  - `src/solver/analog/__tests__/behavioral-combinational.test.ts`
  - `src/solver/analog/__tests__/behavioral-flipflop-variants.test.ts`
  - `src/solver/analog/__tests__/behavioral-gate.test.ts`
  - `src/solver/analog/__tests__/behavioral-flipflop.test.ts`
  - `src/solver/analog/__tests__/behavioral-integration.test.ts`
  - `src/solver/analog/__tests__/behavioral-remaining.test.ts`
  - `src/solver/analog/__tests__/behavioral-sequential.test.ts`
  - `src/solver/analog/__tests__/bridge-adapter.test.ts`
  - `src/solver/analog/__tests__/bridge-compilation.test.ts`
  - `src/solver/analog/__tests__/digital-pin-model.test.ts`
  - `src/solver/analog/__tests__/fet-base.test.ts`
  - `src/components/active/__tests__/adc.test.ts`
- **Per file**:
  - Remove fields: `iteration`, `initMode`, `isDcOp`, `isTransient`, `isTransientDcop`, `isAc`.
  - Add `cktMode: <bitfield>` based on the original semantics:
    - Was `isDcOp:true, initMode:"initFloat"` → `MODEDCOP | MODEINITFLOAT`
    - Was `isDcOp:true, initMode:"initJct"` → `MODEDCOP | MODEINITJCT`
    - Was `isDcOp:true, initMode:"initFix"` → `MODEDCOP | MODEINITFIX`
    - Was `isTransient:true, initMode:"initFloat"` → `MODETRAN | MODEINITFLOAT`
    - Was `isTransient:true, initMode:"initTran"` → `MODETRAN | MODEINITTRAN`
    - Was `isTransient:true, initMode:"initPred"` → `MODETRAN | MODEINITPRED`
    - Was `isTransientDcop:true, initMode:"initJct"` → `MODETRANOP | MODEINITJCT`
    - Was `isAc:true` → `MODEAC | MODEINITFLOAT`
  - Import required constants from `ckt-mode.js`.
- **Verification grep**: `rg '(iteration|isDcOp|isTransient|isTransientDcop|isAc)\s*:' src/**/__tests__/` → 0 hits.

### C-10. Audit remaining legacy mode reads in production src/
**Reconciliation:** BLOCKER → C2 (enumerating and replacing every `ctx.initMode`/`ctx.isTransient`/`_firsttime` production-side reader with cktMode bitfield reads is the core scope of C2; this audit is that task)

- **File**: all `src/**/*.ts` production files (not `ref/`, not `__tests__/`)
- **Verification grep (zero-hits required)**:
  - `ctx\.initMode\s*===`
  - `ctx\.isTransient\b` (unless on right-hand side of `=` setting an alias)
  - `ctx\.isDcOp\b`
  - `ctx\.isAc\b` (as field read)
  - `ctx\.isTransientDcop\b`
  - `loadCtx\.iteration\b`
  - `loadCtx\.initMode\b`
  - `_firsttime\b` (field deleted per 2.3.4)
  - `"transient"` used as initMode sentinel
  - `statePool\.analysisMode` (after C-2)
- **Remedy for each hit**: replace with bitfield read against `ctx.cktMode` using appropriate MODE* constant.

---

## Group D — Phase 2 Device Load Bodies

### D-1. Remove `Math.min(vd/nVt, 700)` clamp from diode.ts:344
**Reconciliation:** PARITY (banned exp clamp removal cited to `dioload.c:244`; a genuine numerical algorithm fix that stands on its own)

- **File**: `src/components/semiconductors/diode.ts`, line 344 (`computeDiodeIV`)
- **Required**: `const evd = Math.exp(vd / nVt);` — no clamp. Matches `dioload.c:244`.
- **Verification grep**: `Math\.min\([^)]*700\)` in `diode.ts` → 0 hits.

### D-2a. Diode — re-align state schema to ngspice and implement MODEINITSMSIG body
**Reconciliation:** BLOCKER → A1 (also D2) (diode SLOT_CAP_GEQ/IEQ deletion and cross-method slot excision is the canonical A1 generator; the MODEINITSMSIG body is separately D2's own verdicted fix but rides inside the A1 `load()` collapse)

- **File**: `src/components/semiconductors/diode.ts`
- **Background**: ngspice's diode state schema has only two cap slots (`diodefs.h:157-158`):
  - `DIOcapCharge` → charge `qd` (C). Matches our existing `SLOT_Q`.
  - `DIOcapCurrent` → **dual-semantic**: `iqcap` (integrated displacement current, A) under MODETRAN; `capd` (raw cap, F) under MODEINITSMSIG. Read by `dioload.c:398` (transient current accumulation), `dioacld.c:33` (AC admittance), `diopzld.c:34` (pole-zero).
  - Our current `SLOT_CAP_GEQ` (ag[0]*Ctotal, S) and `SLOT_CAP_IEQ` (Norton RHS, A) are **digiTS inventions** with no ngspice counterpart. Grep confirms they are write-only in `diode.ts` (stamps use local vars, not state reads). They are vestigial.
- **Required**:
  1. **Delete** `SLOT_CAP_GEQ` and `SLOT_CAP_IEQ` from the diode schema. Remove the two writes at lines 639–640. Schema size shrinks by 2 slots. Renumber slots 6+ accordingly.
  2. **Add** `SLOT_CAP_CURRENT` with dual semantics mirroring ngspice `DIOcapCurrent`:
     - MODETRAN normal path: write `iqcap` (Amps) = the integrated displacement current. Source value is the output of `niIntegrate`'s current-component, not its conductance.
     - MODEINITSMSIG path: write `capd` (Farads) = raw total capacitance from `computeJunctionCapacitance()` + `TT*gd`.
  3. **Implement MODEINITSMSIG block body** per `dioload.c:362-374` verbatim: write `capd` to `SLOT_CAP_CURRENT`, then `continue` (skip NIintegrate AND cap-companion stamp).
  4. Keep `SLOT_Q` (maps to ngspice `DIOcapCharge`).
- **Ngspice ref**: `diodefs.h:157-158` (slot schema); `dioload.c:362-374` (MODEINITSMSIG body); `dioload.c:395-401` (transient NIintegrate + DIOcapCurrent write + accumulation).
- **Verification greps**:
  - `SLOT_CAP_GEQ\b` in `diode.ts` (and its test file) → 0 hits (renamed/replaced).
  - `SLOT_CAP_IEQ\b` in `diode.ts` → 0 hits.
  - `SLOT_CAP_CURRENT\b` in `diode.ts` → ≥2 hits (MODETRAN write + MODEINITSMSIG write).
  - `"LATENT divergence"` / the IMPLEMENTATION FAILURE marker at 654–660 → 0 hits (body implemented, marker removed).

### D-2b. Cross-device audit for vestigial cap-Norton slots — PHASE 2.5 FOLLOW-UP, NOT BLOCKING
**Reconciliation:** OBSOLETE (vestigial cap-Norton slots on every device are deleted wholesale by A1's collapse of `_updateOp`+`_stampCompanion` into a single `load()`; no separate cross-device audit survives)

- **Scope**: BJT (`L1_SLOT_CAP_GEQ_BE/BC_INT/BC_EXT/CS` + `_IEQ_*`), MOSFET (`SLOT_CAP_GEQ_GB/DB/SB` + `_IEQ_*`), varactor (`SLOT_CAP_GEQ`/`_IEQ`), tunnel-diode (same names).
- **Audit question**: for each device, are the `SLOT_CAP_GEQ_*`/`SLOT_CAP_IEQ_*` reads genuine cross-method decoupling (compute in `_updateOp`, stamp in `_stampCompanion`) or vestigial write-only like diode?
- **Grep check per device**: `s0\[base\s*\+\s*L?_?SLOT_CAP_GEQ` in a READ context (right-hand side of assignment) → count.
- **If reads are genuine**: decide whether cross-method decoupling is an ngspice divergence worth fixing, or acceptable as a digiTS performance/clarity optimization. **This is an architectural decision for Phase 2.5 or Phase 9 — not part of this audit's fix list.**
- **If reads are vestigial**: excise the slots as part of the relevant device's re-implementation.
- **Do NOT perform this audit during D-2a execution**. D-2a is strictly scoped to diode to unblock Phase 2.

### D-3. Rewrite diode MODEINITJCT dispatch to match dioload.c:129-136
**Reconciliation:** BLOCKER → A2 (primary fix: remove `pool.uic` reads in favor of `(mode & MODETRANOP) && (mode & MODEUIC)` bit checks is exactly A2's scope; the missing MODEINITFIX+OFF branch is a genuine numerical bug that is authored inside A1's diode `load()` rewrite)

- **File**: `src/components/semiconductors/diode.ts`, lines 492–514
- **Required** (ngspice order, verbatim): 
  1. `(MODEINITJCT && MODETRANOP && MODEUIC)` → `vd = params.IC` (or `DIOinitCond`)
  2. `(MODEINITJCT && params.OFF)` → `vd = 0`
  3. `(MODEINITJCT)` else → `vd = tVcrit`
  4. **ADD**: `(MODEINITFIX && params.OFF)` → `vd = 0`  ← currently missing
- **Current bug**: Uses `pool.uic` instead of bitfield check `(mode & MODETRANOP) && (mode & MODEUIC)`. Tests OFF before UIC (wrong order). Missing MODEINITFIX+OFF branch entirely.
- **Ngspice ref**: `dioload.c:129-136`.
- **Verification grep**: `pool\.uic` in `diode.ts` → 0 hits; `mode\s*&\s*MODEINITFIX` present in diode.ts.

### D-4. Fix BJT L1 store-back values (write capbe/capbc/capsub, not CTOT)
**Reconciliation:** BLOCKER → A1 (the CAP_GEQ_* slots being written are the 7 invented BJT cross-method slots A1 deletes; once A1 collapses BJT `load()`, there is no store-back site and the correct `capbe`/`capbc`/`capsub` values become local doubles per `bjtload.c:676-680`)

- **File**: `src/components/semiconductors/bjt.ts`, lines 1875–1881
- **Current**: writes `CTOT_BE/BC/CS` (total depletion+diffusion) into CAP_GEQ slots.
- **Required** (per `bjtload.c:676-680`): write the diffusion-capacitance factors (`capbe = tf * gbe_modified`, `capbc = tr * gbc`, `capsub` similarly) — i.e. the `CdBE`/`CdBC`/`CdCS` values computed immediately before this block, **not** the `CTOT_*` totals.
- **Ngspice ref**: `ref/ngspice/src/spicelib/devices/bjt/bjtload.c:676-680`.
- **Verification grep**: `L1_SLOT_CAP_GEQ_BE\]\s*=\s*s0\[base\s*\+\s*L1_SLOT_CTOT_BE\]` in `bjt.ts` → 0 hits (i.e. the wrong store-back is deleted).

### D-5. Remove `dt > 0` from BJT L1 capGate (MODEINITSMSIG unreachable during AC)
**Reconciliation:** BLOCKER → D3 (D3 "BJT L1 `dt > 0` gate hides MODEINITSMSIG entirely" is an APPROVED FIX that directly targets this gate; this item is D3's concrete code change)

- **File**: `src/components/semiconductors/bjt.ts`, line 1789 (`if (capGate && dt > 0) {`)
- **Current**: `dt > 0` gate prevents MODEINITSMSIG (dt=0 during AC) from ever entering the NIintegrate block → store-back unreachable.
- **Required** (per `bjtload.c:561-563`): drop `dt > 0` from the guard. The ngspice reference does not guard on timestep for MODEINITSMSIG; AC uses `CKTdelta` which can still hold a non-zero value.
- **Verification grep**: `capGate\s*&&\s*dt\s*>\s*0` in `bjt.ts` → 0 hits.

### D-6. Use `=== MODETRANOP` form for UIC branch in BJT L1
**Reconciliation:** BLOCKER → A2 (removing `pool.uic` truthy-coercion in favor of explicit bit-equality / `!== 0` form is part of A2 pool.uic deletion and rewiring to cktMode bitfield checks; done inside A1 BJT `load()` rewrite)

- **File**: `src/components/semiconductors/bjt.ts`, lines 1875–1876
- **Current**: `!((mode & MODETRANOP) && (mode & MODEUIC))` — truthy coercion.
- **Required** (matches C-5 result; use whatever form matches the ngspice-verified constants): `!(((mode & MODETRANOP) === MODETRANOP) && (mode & MODEUIC) !== 0)` — explicit bit-equality check.
- **Ngspice ref**: same conditional form appears in `bjtload.c:579-587`.
- **Verification grep**: `\(mode\s*&\s*MODETRANOP\)\s*&&` in `bjt.ts` → 0 hits (either replaced with `=== MODETRANOP` form or with `!== 0` form).

### D-7. Add vbx rhsOld seeding in BJT L1 MODEINITSMSIG block
**Reconciliation:** BLOCKER → A1 (new rhsOld seeding lines for vbx/vsub are authored inside the post-A1 BJT single `load()` mirroring `bjtload.c:240-244`; the surgical line-specific spec is replaced by A1's full-function port)

- **File**: `src/components/semiconductors/bjt.ts`, lines 1507–1510
- **Current**: seeds only `vbeRaw`/`vbcRaw` from state0.
- **Required** (per `bjtload.c:240-244`): also seed `vbx = type * (rhsOld[nodeB_ext] - rhsOld[nodeC_prime])` and, if `BJTsubs`, `vsub = type * subs * (rhsOld[nodeSubst] - rhsOld[nodeSubstCon])`.
- **Ngspice ref**: `bjtload.c:240-244`.
- **Verification grep**: `vbx\s*=\s*[^;]*rhsOld` in `bjt.ts` L1 path → ≥1 hit.

### D-8. Fix MOSFET `cgs_cgd_transient_matches_ngspice_mos1` regression
**Reconciliation:** PARITY (2026-04-21 user ruling: treat the -3.5e-12 `cgs_cgd` delta as a genuine numerical regression carried forward as a regression canary; re-measured against ngspice after A1 lands. If the delta persists in the post-A1 `load()` it remains a PARITY item; if it resolves by construction, the item closes.)

- **File**: `src/components/semiconductors/mosfet.ts` (root cause in wave 2.4.3 `useDoubleCap` change)
- **Current**: test `cgs_cgd_transient_matches_ngspice_mos1` fails `expected +0 to be -3.549928774784246e-12`. The DB junction cap companion current (`ceq`) is being stored as `+0` instead of the ngspice value.
- **Required**: Use the ngspice harness (`docs/ngspice-harness-howto.md`) to do a per-NR-iteration comparison for the failing test input and identify the exact iteration where the stored `SLOT_CAP_IEQ_DB` diverges from ngspice. Fix the doubling-guard / MODEINITTRAN zero-companion logic responsible.
- **Ngspice ref**: `mos1load.c:789-795` (doubling guard); `mos1load.c` state-1 seeding.
- **Verification grep**: `expected \+0 to be -3\.549928774784246e-12` in test output → gone (agent must NOT run tests to check; this fix's completion criterion is: the responsible code block in `mosfet.ts` has been re-derived verbatim from `mos1load.c`, with a comment citing the exact ngspice line).

### D-9. Delete redundant duplicate `_ctxCktMode` write in mosfet.ts:1196
**Reconciliation:** BLOCKER → A1 (the `_ctxCktMode` field is a cross-method cktMode cache that exists only to bridge `_updateOp` and `_stampCompanion`; A1's single `load()` makes the cache unnecessary — the field disappears entirely)

- **File**: `src/components/semiconductors/mosfet.ts`, line 1196
- **Current**: `this._ctxCktMode = ctx.cktMode;` (duplicate of base-class write at `fet-base.ts:260`)
- **Required**: delete line.
- **Note**: handled by in-flight relabel agent — verify.
- **Verification grep**: inside `mosfet.ts::_updateOp` body — `_ctxCktMode\s*=` → 0 hits.

### D-10. Split fet-base capGate — abstract `_capGate(ctx)` override per device
**Reconciliation:** BLOCKER → A1 (per-device capGate divergence is authored inside each device's post-A1 `load()` directly — mirroring `jfetload.c:425-426` vs `mos1load.c:762` as local if-guards, not as an abstract class method. The class-hierarchy split itself becomes obsolete under A1's procedural-load structure)

- **Decision**: approach (a) — abstract `_capGate(ctx)` method on `AbstractFetElement`, override per device. Same pattern as existing `_updateOp` / `_stampCompanion` overrides.
- **File**: `src/solver/analog/fet-base.ts`, lines 268–271 + new `_capGate` method on `AbstractFetElement`
- **Required**:
  1. Add `protected abstract _capGate(ctx: LoadContext): boolean;` to `AbstractFetElement` (or provide a default that throws to force override, if TS abstract is awkward).
  2. Replace the inline capGate expression in `fet-base.ts:268-271` with `const capGate = this._capGate(ctx);`.
  3. Implement `_capGate` in `njfet.ts` and `pjfet.ts` with the JFET form (jfetload.c:425-426, verbatim): `(cktMode & (MODETRAN | MODEAC | MODEINITSMSIG)) !== 0 || ((cktMode & MODETRANOP) !== 0 && (cktMode & MODEUIC) !== 0)`.
  4. Implement `_capGate` in `mosfet.ts` with the MOS1 form (mos1load.c:762, verbatim): `(cktMode & (MODETRAN | MODETRANOP | MODEINITSMSIG)) !== 0`. No MODEAC, MODETRANOP unconditional.
  5. Each implementation has a doc-comment citing its exact ngspice source file and line.
- **Ngspice refs**: `jfetload.c:425-426` (JFET form); `mos1load.c:762` (MOSFET form).
- **Verification greps**:
  - `_capGate\s*\(` in `njfet.ts` + `pjfet.ts` + `mosfet.ts` → ≥1 hit each (definitions).
  - In `mosfet.ts::_capGate` body: `MODEAC` → 0 hits; `MODETRANOP` → present without `&& ... MODEUIC` conjunction (unconditional).
  - In `njfet.ts::_capGate` + `pjfet.ts::_capGate` bodies: `MODEAC` → present; `MODETRANOP` and `MODEUIC` both present in the same conjunction.
  - The inlined expression in `fet-base.ts::load` → replaced with a single `this._capGate(ctx)` call.

### D-11. Rewrite fet-base.ts:194-196 comment
**Reconciliation:** OBSOLETE (comment-only rewrite describing `_ctxCktMode` cache semantics; the cache itself is deleted by A1 — no comment to maintain)

- **File**: `src/solver/analog/fet-base.ts`, lines 194–196
- **Current**: comment justifies the field's existence by describing why there is a cache.
- **Required**: reduce to a single-line statement of semantics, e.g. `// Most-recent ctx.cktMode captured in load() for use in _stampCompanion.` Omit any "used by" justification if the caller is obvious from the field name.
- **Verification grep**: the exact current comment text → 0 hits.

### D-12. Capacitor test `stampCompanion preserves V_PREV` (fix test, not implementation)
**Reconciliation:** BLOCKER → A1 (per A1 §Test handling rule, capacitor unit tests that inspect intermediate pool state between `_updateOp` and `_stampCompanion` are deleted during A1 execution; the double-solver-mock / handle-caching pattern stops making sense once `stampCompanion` no longer exists as a separate call)

- **File**: `src/components/passives/__tests__/capacitor.test.ts`, lines 301–323
- **Issue**: Test uses two different `makeCaptureSolver()` mocks across two `load()` calls; element caches handles from the first solver's pool → crashes on second `load()`.
- **Required**: Use a single solver mock for both `load()` calls, OR reset element handles (`_handlesInit = false`) between calls if the test's intent is to simulate a fresh solver.
- **Verification grep**: `makeCaptureSolver\(\)` count inside this test body → 1 (or an explicit handle-reset comment if 2).

### D-13. Capacitor test `stampCompanion_uses_s1_charge_when_initPred` (fix expected value)
**Reconciliation:** BLOCKER → A1 (the test inspects intermediate `SLOT_Q` pool state and hand-computes the expected `ceq`; per A1 §Test handling rule any hand-computed expected value is subject to deletion during A1 execution — migrate to harness or drop)

- **File**: `src/components/passives/__tests__/capacitor.test.ts`, lines 399–438
- **Issue**: Test expects `ceq = -7` but correct ngspice-aligned value is `ceq = -3`. The implementation returns -3 (spec-correct); the test is wrong.
- **Required**: Replace `expect(ceq).toBeCloseTo(-7, 3)` with `expect(ceq).toBeCloseTo(-3, 6)`. Rewrite the comment at lines 427–437 to describe the correct formula:
  - `q0 = s1[SLOT_Q] = 3e-6, q1 = 3e-6`
  - `ccap = ag[0]*q0 + ag[1]*q1 = (1/dt)*3e-6 + (-1/dt)*3e-6 = 0`
  - `ceq = ccap - ag[0]*q0 = 0 - (1/dt)*3e-6 = -3` (at dt=1e-6)
- **Verification grep**: `toBeCloseTo\(-7` → 0 hits; `toBeCloseTo\(-3` → 1 hit in this test.

### D-14. Inductor test `stamps branch incidence and conductance entries` (fix expected count)
**Reconciliation:** BLOCKER → A1 (inductor stamp-count assertion is a hand-computed structural expectation on `_stampCompanion`; the method itself is collapsed by A1, so the test is re-authored or deleted per A1 §Test handling rule)

- **File**: `src/components/passives/__tests__/inductor.test.ts`, lines 153–191
- **Issue**: Expects 4 `allocElement` calls; ngspice-aligned implementation stamps 5 (unconditional `-req` on branch diagonal per `indload.c:119-123`).
- **Required**: change `expect(stamps.length).toBe(4)` → `expect(stamps.length).toBe(5)`. Rewrite the comment at line 179 to describe the unconditional stamp correctly.
- **Verification grep**: `toBe\(4\)` in this specific test body → 0 hits; `toBe\(5\)` → 1 hit.

### D-15. Capacitor default `_IC` = 0.0 (match ngspice `CAPinitCond`)
**Reconciliation:** PARITY (default-value and unconditional-use change cited to `cap.c` + `capload.c:46-47`; a genuine numerical fix to the cond1 branch that stands independently)

- **Decision**: match ngspice exactly.
- **File**: `src/components/passives/capacitor.ts` (CAPACITOR_DEFAULTS) + the cond1 gate
- **Required**:
  - `CAPACITOR_DEFAULTS._IC = 0.0` (was `NaN`).
  - `cond1` branch uses `this._IC` unconditionally — no `!isNaN` guard. Matches capload.c:46-47.
- **Ngspice ref**: `ref/ngspice/src/spicelib/devices/cap/cap.c` (CAPinitCond default); `capload.c:46-47` (unconditional use).
- **Verification grep**: `_IC:\s*NaN` in `capacitor.ts` → 0 hits. `isNaN\(this\._IC\)` in `capacitor.ts` → 0 hits.

---

## Group E — Phase 2 Remaining Devices

### E-1. triac.ts: add MODEINITJCT gate around pnjlim calls
**Reconciliation:** BLOCKER → F4c (triac is APPROVED ACCEPT under F4c as a digiTS-only device with no ngspice counterpart; the "dioload.c pattern" framing is papering architectural independence as an ngspice port. The MODEINITJCT import and gating happens inside the F4c self-compare snapshot design, not as a dioload port)

- **File**: `src/components/semiconductors/triac.ts`, lines 298–304
- **Current**: zero ckt-mode imports; pnjlim called unconditionally on both junctions.
- **Required**: add `import { MODEINITJCT } from "../../solver/analog/ckt-mode.js";` Wrap pnjlim in:
  ```
  if (ctx.cktMode & MODEINITJCT) {
    // Seed vmt and vg1 directly without pnjlim — ngspice dioload.c:130-136 pattern.
    vmtLimited = vcritMain;
    vg1Limited = vcritGate;
  } else {
    const vmtResult = pnjlim(vmtRaw, s0[base + SLOT_VAK], nVt, vcritMain);
    ...
  }
  ```
- **Ngspice ref**: `dioload.c:129-136` — diode-family junction-voltage initialization pattern.
- **Verification grep**: `MODEINITJCT` imported in `triac.ts` → 1 hit; `if\s*\(\s*ctx\.cktMode\s*&\s*MODEINITJCT` in `triac.ts` → ≥1 hit.

### E-2. led.ts: add MODEINITJCT gate around pnjlim call
**Reconciliation:** BLOCKER → A1 (LED's diode-equivalent schema is one of the devices A1 collapses into a single `load()`; the MODEINITJCT dispatch mirrors `dioload.c:129-136` inline in that rewritten function — no separate gate-wrapping task survives)

- **File**: `src/components/io/led.ts`, `load()` body
- **Current**: imports MODETRAN, MODEAC but not MODEINITJCT. pnjlim called unconditionally.
- **Required**: add MODEINITJCT import; gate pnjlim on `!(ctx.cktMode & MODEINITJCT)`; seed `vdRaw = tVcrit` when MODEINITJCT (or 0 if OFF).
- **Ngspice ref**: `dioload.c:129-136`.
- **Verification grep**: `MODEINITJCT` in `led.ts` → ≥1 hit.

---

## Group F — Test Migration & Historical-Provenance Comments

### F-1. Delete historical-provenance comments (handled by in-flight relabel agent)
**Reconciliation:** OBSOLETE (comment-only sweep for deleted-field references; I2 citation-audit policy handles the project-wide sweep after A1/C2 land)

Verify the relabel agent covered:
- `src/components/active/__tests__/real-opamp.test.ts:599`
- `src/components/semiconductors/__tests__/diode.test.ts:1282`
- `src/components/semiconductors/__tests__/diode.test.ts:1363`
- `src/components/semiconductors/bjt.ts:55` (Group A-3)
- `src/components/semiconductors/diode.ts:650-669` (combined with D-2)

Plus any hits the relabel agent flagged for review.

- **Verification grep**: `ctx\.isTransient` appearing in any comment (not code) → 0 hits. `cap gate was` / `old gate was` / `was removed` → 0 hits in `src/`.

### F-2. Add IMPLEMENTATION FAILURE entries to spec/progress.md (handled by relabel agent)
**Reconciliation:** OBSOLETE (progress.md bookkeeping for tasks whose work is now subsumed by A1/C2/D2/D3/D4; after A1 execution the affected waves are re-authored per the plan-addendum — individual IMPLEMENTATION FAILURE annotations stop being useful)

Verify the relabel agent added entries for:
- Task 2.4.7 (no entry at all — must be added as IMPLEMENTATION FAILURE per reviewer finding)
- Task 2.4.1 (diode — "empty body per spec — latent divergence noted")
- Task 2.4.2 (BJT — store-back CTOT wrong value; dt>0 dead-code; no MODEINITSMSIG tests)
- Task 2.4.3 + fix-2.4.mosfet-duplicate-const-mode (MOSFET regression + "redundant but harmless")
- Task 2.4.4 (JFET — vacuous slot-value test)
- Task 2.4.5 + 2.4.6 (capacitor/inductor — 3 tests mislabeled "pre-existing")
- Task 2.5.1 (24+ test files with iteration:)
- Task 2.5.2 (behavioral-flipflop seeding)
- Top-of-file banner

---

## Group G — Weak Test Strengthening
**Reconciliation:** BLOCKER → A1 (weak-test strengthening across the component test suite intersects A1 §Test handling rule: tests whose expected values come from the harness survive; tests whose expected values are hand-computed from intermediate `_updateOp`/`_stampCompanion` slot reads are deleted during A1 execution. Per-weak-test triage happens inside A1, not as a standalone task)

For each weak test identified in the review reports (per phase file in `spec/reviews/`), replace the loose assertion with an exact ngspice-reference value obtained from the comparison harness (see `docs/ngspice-harness-howto.md`).

Patterns to eliminate:
- `toBeGreaterThan(0)` / `toBeLessThan(X)` without paired exact `toBeCloseTo` — 17 occurrences
- `expect(typeof result).toBe("boolean")` alone — 1 occurrence (bjt.test.ts)
- `hasSignificantCurrent` / `maxRhs > 1e-X` pattern — 5 occurrences (jfet.test.ts)
- `expect(N).toBe(N)` tautologies — 3 occurrences (led.test.ts, jfet.test.ts, transmission-line.test.ts)
- `expect(2 * (N-1)).toBe(4)` arithmetic identity — 1 occurrence (transmission-line.test.ts)
- `Number.isFinite(x)` as sole assertion on a numeric result — 4 occurrences

Each replacement requires running the ngspice comparison harness on the same inputs as the test and pinning the exact `ngspice` output value. Do NOT weaken further; do NOT leave placeholders.

**Verification grep** (project-wide):
- `toBeGreaterThan\(0\)\s*;?\s*$` in `src/**/__tests__/` → every remaining hit is either on an explicitly counter-type field (e.g. iteration counters, noncon counters) or reported back as unresolved.
- `toBe\("boolean"\)` → 0 hits.

---

## Summary of items requiring user design decisions — ALL RESOLVED

- **C-5** → hex verified identical to ngspice; fix the helper only, use `MODEDC` mask (already defined). See C-5.
- **D-2** → split into D-2a (diode — delete vestigial SLOT_CAP_GEQ/IEQ, add SLOT_CAP_CURRENT with ngspice's dual semantics, implement MODEINITSMSIG body) and D-2b (cross-device audit for BJT/MOSFET/varactor/tunnel-diode SLOT_CAP_GEQ_* reads — DEFERRED to Phase 2.5 or 9 as architectural follow-up). See D-2a, D-2b.
- **D-10** → approach (a): abstract `_capGate(ctx)` override per device. See D-10.
- **D-15** → match ngspice `CAPinitCond`; default `_IC = 0.0`, no guard. See D-15.

All fixes in this list are now mechanical ngspice-aligned re-implementation per the overriding rule.

---

## Orchestration notes for executor team

1. **Parallelizable groups**: A, E, F-1 have no cross-dependencies and can run in parallel.
2. **Sequential groups**: B (Phase 1 sparse solver) → C (Phase 2 infra) → D (device loads) → F-2 + G (test strengthening last).
3. **Blocked on user**: C-5, D-2, D-10, D-15 must be answered before those specific fixes begin. Everything else can start immediately.
4. **Do NOT run tests at any point**. Verification is grep-only per each fix's grep command. If an executor believes a fix requires a test run to verify, they must stop and report to the orchestrator.
5. **Do NOT revert a spec-aligned change because a test fails.** Report the failing test to the orchestrator and continue. The orchestrator will handle test-weakening detection separately.
6. **Commit protocol**: one fix per commit if possible, with the fix ID in the commit message subject (e.g. `Group C fix C-1: ac-analysis.ts cktMode = MODEAC`). Each commit message must cite the ngspice file:line reference used.

---

## Reconciliation summary (added 2026-04-21)

**Classification against `spec/architectural-alignment.md` Track A verdicts.**

### OBSOLETE items (delete, no replacement)

- **A-3** — historical-provenance comment deletion; covered by I2 citation/comment hygiene policy.
- **A-4** — banned-word comment rewording; no numerical or structural change.
- **B-2** — solver-comment-only correction; I2 sweep absorbs it after B1/B2 land.
- **C-7** — stale-comment sweep for deleted `isTransientDcop` references; I2 policy.
- **C-8** — stale-comment rewording in state-pool.ts; A1/A3 rewrite deletes the referenced text.
- **D-2b** — cross-device vestigial cap-Norton slot audit; A1 deletes every such slot wholesale.
- **D-11** — comment-only rewrite for `_ctxCktMode` cache; the cache itself is deleted by A1.
- **F-1** — historical-provenance comment sweep; I2 policy + A1/C2 landing absorbs it.
- **F-2** — IMPLEMENTATION FAILURE progress.md annotations; superseded by the plan-addendum rewrite of affected waves post-A1.

### BLOCKER items (route to Track A)

| Item | Route to | Why |
|---|---|---|
| B-1 | B3 | Pre-factor snapshot ordering is symptom of Gmin-stamped-outside-factor; B3 resolves the ordering hazard. |
| B-3 | C2 | LoadContext legacy-boolean-field migration in test literal rides C2's cktMode bitfield adoption. |
| B-4 | B1 (+B2) | Pivot-threshold and reorder-state expected values are defined by B1/B2 rewrites. |
| C-1 | C2 | Deleting six legacy boolean mode writes and writing `cktMode = MODEAC` is C2's direct scope. |
| C-2 | A3 | `statePool.analysisMode` is the exact string-duplicate field A3 deletes. |
| C-3 | A4 | `refreshElementRefs` is the defensive-resync helper A4 deletes wholesale. |
| C-6 | C2 | `InitMode` string→bit translation is legacy-string infrastructure C2 replaces. |
| C-9 | C2 | 24+ test-file LoadContext migration is subsumed by C2; A1 §Test handling further narrows which tests survive. |
| C-10 | C2 | Project-wide audit of legacy mode reads is C2's core scope. |
| D-2a | A1 (+D2) | SLOT_CAP_GEQ/IEQ excision is the canonical A1 generator; MODEINITSMSIG body is D2 authored inside A1's `load()`. |
| D-3 | A2 | `pool.uic` removal is A2's scope; MODEINITJCT dispatch rewrite happens inside A1 diode `load()`. |
| D-4 | A1 | BJT `CAP_GEQ_*` slot store-back sites are deleted by A1; correct `capbe`/`capbc`/`capsub` become locals. |
| D-5 | D3 | `dt > 0` capGate removal is D3's APPROVED FIX verbatim. |
| D-6 | A2 | Explicit bit-equality UIC check replaces `pool.uic` truthy coercion per A2 deletion. |
| D-7 | A1 | rhsOld seeding for vbx/vsub is authored inside post-A1 BJT single `load()`. |
| D-9 | A1 | `_ctxCktMode` cross-method cache field disappears under A1's single `load()`. |
| D-10 | A1 | Per-device capGate lives inline in each post-A1 `load()` mirroring ngspice; the class-hierarchy abstract-method approach is obsolete. |
| D-12 | A1 | Capacitor test inspects `stampCompanion` intermediate state; deleted per A1 §Test handling rule. |
| D-13 | A1 | Hand-computed `ceq` expected value on intermediate SLOT_Q read; deleted per A1 §Test handling rule. |
| D-14 | A1 | Hand-computed `_stampCompanion` call-count assertion; deleted per A1 §Test handling rule. |
| E-1 | F4c | triac is APPROVED ACCEPT under F4c as a digiTS-only device; framing its init as a `dioload.c` port is papering. |
| E-2 | A1 | LED's diode-equivalent schema is collapsed by A1; MODEINITJCT dispatch authored inline in new `load()`. |
| G | A1 | Weak-test triage across component suite is interleaved with A1 §Test handling rule (delete hand-computed / migrate to harness / keep as labeled survivor). |

### PARITY items (stay as open numerical work)

- **A-1** — `Math.min(expArg, 80)` clamp removal in `njfet.ts` cited to `jfetload.c`.
- **A-2** — `Math.min(expArg, 80)` clamp removal in `pjfet.ts` cited to `jfetload.c`.
- **C-4** — `_prevClockVoltage` init-seeding logic bug in `behavioral-flipflop.ts` (2026-04-21 user ruling: E2's ACCEPT covers existence not correctness).
- **C-5** — `isDcop()` helper uses `MODEDC` (0x70) mask; direct ngspice-cited bit-mask bug fix in `ckt-mode.ts`.
- **D-1** — `Math.min(vd/nVt, 700)` clamp removal in `diode.ts` cited to `dioload.c:244`.
- **D-8** — MOSFET `cgs_cgd` -3.5e-12 regression (2026-04-21 user ruling: kept as PARITY canary, re-measured post-A1).
- **D-15** — Capacitor default `_IC = 0.0` + unconditional cond1 use cited to `cap.c` / `capload.c:46-47`.

### Counts

- PARITY: 7 items
- BLOCKER: 23 items
- OBSOLETE: 9 items
- Total classified: 39
