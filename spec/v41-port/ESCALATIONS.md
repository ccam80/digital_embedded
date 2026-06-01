# v41 Port — Escalation Log

Escalations raised during the v41 port loop. An entry here means a ledger item
is `ESCALATED` — **blocked, not done**. The job is not complete while this log
has unresolved entries.

There is **no "accepted divergence" outcome** in this job. Every escalation
resolves one of two ways:
- the user converts it back to `PENDING` with a directive (nearly always
  "make it match ngspice — here is the approach"); or
- the user splits it into new ledger items (e.g. a "restore v26 baseline"
  item, or a sequenced cross-group architecture change).

An escalation is never closed by deciding our code may differ from v41.

Valid triggers (see `TASK.md` §8): (1) pre-image failure, (2) cross-group
architecture change needing sequencing approval, (3) genuine C→TS ambiguity.
The verifier (`VERIFICATION.md` §6a) bounces bogus escalations before they
reach this log.

---

## Pre-launch deferrals (scout) — NOT loop escalations

These are units the scout holds back before the run because they are not portable
as-is (no `ESCALATED` ledger state, not applier/verifier-raised). Recorded so the
gap is durable. Each needs a spec-author action, not a loop retry.

### DEFER-mos3 — missing `tsFunction` mapping (in-scope planning gap)

- **Surfaced:** 2026-05-30, pre-launch grouping audit.
- **Evidence:** 43 of mos3's PENDING hunks have `tsFunction: null` in `ledger.json`
  (no `src/*.ts` target), so its functionGroups can't be emitted as workable groups.
- **Scope:** mos3 (MOSFET level 3) is IN scope per `device-class-scope.md`. The gap is
  that the per-hunk mapping (mos3 ngspice symbols → `src/components/semiconductors/mosfet.ts`)
  was never authored during planning.
- **Decision needed from user:** author the mos3 → mosfet.ts per-hunk mappings into
  `spec/ngspice-v41-model-diffs/mos3.md` (or the planning overlay) + rebuild the ledger,
  or decide mos3 needs a dedicated model file. Until then mos3 stays deferred.
- **Resolution:** _pending_

### DEFER-parser — frozen engine-phase re-plan (#8 / #61)

- **Surfaced:** 2026-05-30, confirmed against ledger; matches frozen Phase-0 decision.
- **Evidence:** 36 unmapped hunks; the `INP2x` functionGroups are ngspice SPICE-deck card
  readers (`inp2b.c`=B-source card, `inp2c.c`=cap card, …). digiTS has no SPICE-deck parser
  (it builds devices from its structured format; the harness netlist-generator runs the
  opposite direction).
- **Disposition:** the only in-scope sliver is `ifeval.c` / `PTeval` (behavioral expression
  evaluator) → `src/solver/analog/expression-evaluate.ts`, owned by the **asrc / B-source (#19)**
  work and harness-verified there. The card readers are NO-COUNTERPART pending the deck-reader
  re-plan; not yet reclassified in the ledger, which is why they show PENDING.
- **Resolution:** _pending re-plan_

---

## Contract violations found (remediation required)

### CV-sw-recons — three sw reconstructions applied WITHOUT a spec

- **Surfaced:** 2026-05-30, pilot run `wia5uvbdv`; confirmed by independent verifier.
- **What happened:** the port loop committed `sw#recon/icParam`, `sw#recon/trunc`,
  `sw#recon/acLoad` as APPLIED (commits on `v41-port`), but NO spec file exists on disk
  for any of them (`spec/v41-port/reconstruction/sw-{icParam,trunc,acLoad}.md` absent;
  ledger `specExists:false` is accurate). The recon path reconstructed them from
  inference/planning docs — forbidden by the reconstruction-from-spec contract.
- **Evidence:** `Glob spec/v41-port/reconstruction/sw-*.md` → none; only
  `planning/sw-review.md` + `planning/sw-decisions.json` exist. The dir holds 9 other
  (legitimate) recon specs, so this is a genuine gap, not a wrong path.
- **Driver fix applied:** the scout now defers any unit with a `specExists:false` recon;
  the recon builder + verifier carry a spec-presence HARD GATE (escalate "missing-spec",
  never infer). Prevents recurrence.
- **Remediation of existing commits (USER DECISION):** the three sw recon commits + the
  sw group commits stacked on them are untrustworthy (built on an un-spec'd baseline).
  Recommended: author the sw specs (3 of the 17 missing), ratify, then REBUILD sw from
  spec — do not trust the current sw commits. sw was not marked "device complete".
- **Resolution:** _pending — sw specs to be authored, then sw rebuilt_

### FIND-composite-path — composite with an active sub-element runs on NEITHER surface (blocks nodeAllocOrder criterion 10)

- **Surfaced:** 2026-05-31, authoring the `engine#recon/nodeAllocOrder` criterion-10 gate fixture.
- **What happened:** the fixture `composite-mosfet-stage.dts` (a `cs_stage` subckt with an NMOS
  whose drain touches an internal net `DRN`, instantiated once) is authored + validates clean, but
  cannot run as a parity gate. Two pre-existing composite-path bugs (all 31 existing fixtures are
  flat, so this path was never exercised end-to-end):
  1. **`src/solver/analog/compiler.ts` composite flatten** (`expandCompositeInstance`): a Port net
     whose only internal endpoint is a no-DC-conductance pin (MOSFET gate) collapses to ground —
     severs the gate drive, gate reads 0 V instead of 3 V, raises a spurious `voltage-source-loop`.
  2. ~~harness generator empty-deck~~ **MISDIAGNOSIS (2026-05-31, independent investigation).** There is
     NO generator bug. The generator emits a COMPLETE 6-element deck; it faithfully transcribes the
     compiler's collapsed nodes (`VGS 0 0 DC 3`, `M1 1 0 0 0`), and ngspice rejects that degenerate deck
     at parse → 0 elements / 0 steps. The "empty run" is entirely downstream of bug 1. Generator verified
     healthy (flat controls bit-exact: mosfet-inverter 122/122, resistive-divider 107/107). User-`subcircuitDefinitions`
     are structurally flattened by `compile.ts:74-80` (`flattenCircuit`) BEFORE the analog compiler, so the
     generator only ever sees flat primitives; the `kind:"netlist"` recursion path is for in-registry
     composite components (transformer/optocoupler), irrelevant here.
- **Control (isolates it):** an electrically-identical FLAT MOSFET version runs ngspice 107 / digiTS
  107, divergence ~2.3e-13. So flat MOSFET parity is fine; the failure is confined to the composite/
  subcircuit flatten + emit path on both surfaces.
- **Impact:** nodeAllocOrder criterion 10 (the composite node-ordering gate) cannot run until bug 1
  lands. Does NOT block the immediate re-pilot (vsrc→cap/ind/mut are flat).
- **Resolution:** RESOLVED 2026-05-31 — it is a SINGLE bug (the compiler.ts node-collapse), folded into
  `engine#recon/nodeAllocOrder` as Part E + acceptance criterion 11 (locus confirmed at the compiler
  node-allocation walk: compiler.ts:274 Port-skip → :888-932 outerPortNodes → :437 gnd→0 → :527 gate-leaf;
  independent citation-review GOOD; spec re-ratified). No generator work needed (bug 2 misdiagnosed, see
  above). The loop's recon-builder fixes the collapse when it builds nodeAllocOrder; the composite fixture
  (`composite-mosfet-stage.dts`, authored + ready) then gates — the deck stops being degenerate once the
  gate node survives, so ngspice accepts it.

---

## Template — copy per escalation

### ESC-NNN — `<ledger item id>` — <one-line summary>

- **Raised by:** applier | verifier
- **Trigger:** pre-image failure | cross-group architecture change | C→TS ambiguity
- **ngspice:** `<file>` lines `<a-b>` (v41 tree `ref/ngspice/...`)
- **digiTS:** `<file>` — `<function/method>`
- **What is blocked:** <the specific quantities / structures / control flow>
- **Architecture change required:** <exact change; every file it touches>
- **Why it exceeds one functionGroup / why it is ambiguous:** <evidence>
- **Decision needed from user:** <the precise question>
- **Resolution:** _pending_

---

### ESC-001 — `analysis#recon/tf` — reconstruction spec missing; cannot build the `.tf` driver

- **Raised by:** applier (reconstruction builder, unit "analysis")
- **Trigger:** reconstruction spec absent (a pre-image-class blocker — the spec the recon must be built from does not exist)
- **ngspice:** `src/spicelib/analysis/tfanal.c` lines `18-165` (TFanal, v41 tree `ref/ngspice/src/spicelib/analysis/tfanal.c`)
- **digiTS:** `src/solver/analog/dc-operating-point.ts` — a new `.tf` driver (DC transfer ratio + input/output resistance over the factored DC Jacobian), plus a facade method and a `circuit_tf` MCP surface
- **What is blocked:** the entire `.tf` analysis driver, and the two v41 hunks gated on it (`analysis/tfanal.c#h001` docLineRange 8352-8362, `#h002` 8363-8373 — both `GENnode(ptr)[0]/[1]` accessor renames inside `TFanal` that are only case-(a) applicable once the driver exists). `ledger.json` records this reconstruction item with `specExists: false`; the spec file `spec/v41-port/reconstruction/analysis-tf.md` does not exist on disk (the `reconstruction/` directory holds cap-/mut-/ind-/vdmos-/vccs-/res-/jfet- specs but no `analysis-tf.md`). No `.tf` driver exists in the target TS today (Grep for `TFanal|transferFunction|TFinSrc|circuit_tf|computeTransfer` in `dc-operating-point.ts` returns zero matches); no `rename-maps/*tf*` stub exists.
- **Architecture change required:** build from scratch a faithful v26-baseline `TFanal` port in `src/solver/analog/dc-operating-point.ts` (+ facade + MCP): (1) `CKTop` to the operating point; (2) resolve the input source (Vsource branch / Isource node pair) and the output (Vsource branch / node pair); (3) zero `CKTrhs`, inject +/-1 at the input source's branch or node pair, `SMPsolve` against the already-factored DC Jacobian, read the transfer ratio and input resistance (`-1/rhs[insrc]` with the `1e-20` guard, or the node difference for an Isource input); (4) for output resistance, re-zero rhs, inject at the output, re-solve, read `1/MAX(1e-20,rhs[outsrc])` or the node difference, with the `TFoutIsI && TFoutSrc==TFinSrc` short-circuit. Touches: `src/solver/analog/dc-operating-point.ts`, the AnalogEngine re-solve-against-factored-Jacobian surface, `src/headless/default-facade.ts` / `src/headless/facade.ts`, and the MCP server (new `circuit_tf` tool).
- **Why it exceeds one functionGroup / why it is ambiguous:** the reconstruction item's own `tsFunction` field names a multi-surface scope ("a new .tf driver over the factored DC Jacobian (transfer ratio + Zin/Zout) on the AnalogEngine, plus the facade/MCP surface (circuit_tf)"). The design decisions the missing spec was to fix — how digiTS exposes a re-solve against the retained factored Jacobian (the `SMPsolve` analog), how it addresses a source branch vs a node pair for RHS injection, the output-vector/plot shape, the facade method signature, and the `circuit_tf` MCP contract + serialization — are genuinely ambiguous without the spec. Authoring them by inference would be inventing the spec, which the reconstruction-from-spec contract and the project "no pragmatic shortcuts / match ngspice exactly" rule forbid.
- **Decision needed from user:** author `spec/v41-port/reconstruction/analysis-tf.md` defining the `.tf` driver architecture (re-solve-against-factored-Jacobian surface on AnalogEngine, source-branch vs node-pair RHS injection, transfer-ratio/Zin/Zout output shape, facade method signature, `circuit_tf` MCP contract), then rebuild the ledger so `specExists` flips true and this item returns to `PENDING` for the builder.
- **Resolution:** _pending_

---

### ESC-002 — `maths-ni/niaciter.c#h001b`, `#h002` — AC path has no CKTrhs/CKTrhsOld six-buffer ping-pong + SWAP

- **Raised by:** applier (unit "maths-ni")
- **Trigger:** pre-image failure (case c, absent)
- **ngspice:** `src/maths/ni/niaciter.c` lines `107-115` (NIacIter locals: `double *temp;` removed) and `144-179` (post-solve: six `*ckt->CKTrhs = 0;`→`ckt->CKTrhs[0] = 0;` clears + two manual three-line rhs/irhs swaps → `SWAP(double *, …)`), v41 tree `ref/ngspice/src/maths/ni/niaciter.c`
- **digiTS:** `src/solver/analog/ac-analysis.ts` — `AcAnalysis.run` frequency-sweep loop (`~:354-456`; post-solve `~:416-419`)
- **What is blocked:** the post-solve ground-sentinel clear of the six AC buffers and the rhs↔rhsOld / irhs↔irhsOld pointer SWAP. Our AC architecture has none of `CKTrhs`/`CKTrhsSpare`/`CKTrhsOld`/`CKTirhs`/`CKTirhsSpare`/`CKTirhsOld`: it stamps into `rhsRe`/`rhsIm` input arrays and solves into dedicated `solRe`/`solIm` output arrays via `solver.solve(rhsRe, solRe, rhsIm, solIm)` (`ac-analysis.ts:324-327, 419`). There is no swap-temp local (`#h001b`), no six-buffer clear, and no post-solve swap (`#h002`). Every `-` line is case (c).
- **Architecture change required:** re-architect the AC sweep to ngspice's six-buffer complex ping-pong (`CKTrhs`/`CKTrhsSpare`/`CKTrhsOld`/`CKTirhs`/`CKTirhsSpare`/`CKTirhsOld`) with a post-solve rhs↔rhsOld + irhs↔irhsOld SWAP so the solution lands in `rhsOld`/`irhsOld`, replacing the dedicated `solRe`/`solIm` arrays. Touches `src/solver/analog/ac-analysis.ts` and the AC RHS/solution buffer model shared with the harness `acSnapshotSink` (cross-group, beyond this functionGroup).
- **Why it exceeds one functionGroup / why it is ambiguous:** the change is not a per-statement edit; it replaces the AC solve's entire RHS/solution data model, which the harness capture path also consumes.
- **Decision needed from user:** convert back to `PENDING` with a directive to adopt the ngspice six-buffer AC ping-pong (and update the harness AC capture timing accordingly), or split into a sequenced AC-engine reconstruction item.
- **Resolution:** _pending_

---

### ESC-003 — `maths-ni/nicomcof.c#h001`, `#h002`, `#h003` — xmu already runtime (pre-applied); ag-zeroing is a partial loop

- **Raised by:** applier (unit "maths-ni")
- **Trigger:** pre-image failure (case b, present-but-differs)
- **ngspice:** `src/maths/ni/nicomcof.c` lines `6-13` (`#define xmu 0.5` + comment removed; `#include "ngspice/cpextern.h"` added), `42-45` (TRAP case 2: `xmu` macro → `ckt->CKTxmu` runtime field), `65` (`bzero(ckt->CKTag,7*sizeof(double))` → `memset(ckt->CKTag,0,7*sizeof(double))`), v41 tree `ref/ngspice/src/maths/ni/nicomcof.c`
- **digiTS:** `src/solver/analog/integration.ts` — `computeNIcomCof` (`xmu: number` param `:235`; TRAP order-2 `:250-251`) and `solveGearVandermonde` (ag-zeroing `:168-169`)
- **What is blocked:** (`#h001`/`#h002`) our port already pre-applied v41's xmu-as-runtime change — `xmu` is a runtime function parameter (`:235`, comment cites `ckt->CKTxmu` at `:246-247`), so there is no `#define xmu 0.5` macro to remove and our `1.0 - xmu` already corresponds to the v41 `+` line, not the v26 `-` line. Both v26 macro and v41 field collapse to the same TS text, so the change is invisible and a zero-line delta would silently drop a real change (macro constant → struct field). (`#h003`) our ag-zeroing is a partial loop `for (let i = 0; i <= order; i++) ag[i] = 0;` (`:169`) that zeros only `0..order`, not all 7 slots, and uses neither `bzero` nor `memset` — clearly the counterpart but not the `-` line modulo rename.
- **Architecture change required:** for `#h001`/`#h002`, a user decision whether the pre-applied xmu-runtime (landed ahead of this loop per the CLAUDE.md hot-loadable-params requirement) is recorded `APPLIED` or backed by a v26-baseline reconstruction so the `-` macro pre-image exists. For `#h003`, change `solveGearVandermonde`'s ag-zeroing to clear all 7 slots (matching `bzero`/`memset` of `7*sizeof(double)`). Touches `src/solver/analog/integration.ts`.
- **Why it exceeds one functionGroup / why it is ambiguous:** not ambiguous in mechanism, but the pre-image is case (b) on all three hunks (our port already diverged from v26), which the contract forbids editing on top of.
- **Decision needed from user:** convert back to `PENDING` with a directive (record pre-applied as APPLIED / supply v26 baseline for `#h001`/`#h002`; for `#h003`, "make ag-zeroing clear all 7 slots to match ngspice memset").
- **Resolution:** _pending_

---

### ESC-004 — `maths-ni/niconv.c#h001`, `#h002`, `#h003` — NIconvTest is inlined (no standalone fn / ft_ngdebug / CKTtroubleElt / STEPDEBUG)

- **Raised by:** applier (unit "maths-ni")
- **Trigger:** pre-image failure (case c) + target absent + isomorphic-delta failure
- **ngspice:** `src/maths/ni/niconv.c` lines `17` (`extern bool ft_ngdebug;`), `33-60` (NIconvTest: new `if (isnan(new)) { … return 1; }` + voltage-tol branch with `CKTtroubleNode`/`CKTtroubleElt` + STEPDEBUG reindent), `63-72` (non-voltage branch, same reindent), v41 tree `ref/ngspice/src/maths/ni/niconv.c`
- **digiTS:** `src/solver/analog/newton-raphson.ts` — NIconvTest is inlined into `newtonRaphson` STEP H (`~:653-748`; NaN check `:694-696`)
- **What is blocked:** (`#h001`) `ft_ngdebug` is a C global debug-printf gate consumed only by the `#h002` stderr NaN warning; no digiTS construct to extend. (`#h002`) the substantive `+` addition is the standalone-function NaN check `if (isnan(new)) { … return 1; }`; our port HAS a NaN check but with different structure — it sets `globalConverged = false` (continue scanning) inside the inlined STEP-H loop, not `return 1` from a standalone `NIconvTest`. The `-` lines are STEPDEBUG-printf and `CKTtroubleNode=i; CKTtroubleElt=NULL;` reindents — STEPDEBUG and `CKTtroubleElt` have no TS counterpart (case c). (`#h003`) all `-`/`+` are STEPDEBUG/`CKTtroubleElt` reindents in the non-voltage branch — case c absent. Grep confirms `ft_ngdebug`/`NIconvTest`/`troubleElt`/`STEPDEBUG` are all absent from `newton-raphson.ts`.
- **Architecture change required:** extract a standalone `NIconvTest` from the inlined STEP-H scan with the v41 `return 1` control flow on NaN and on tol-exceed, plus a `CKTtroubleElt` blame field. Touches `src/solver/analog/newton-raphson.ts` and `src/solver/analog/ckt-context.ts` (troubleElt field, cross-group).
- **Why it exceeds one functionGroup / why it is ambiguous:** ngspice keeps `NIconvTest` separate with early `return 1`; our port inlined it with a `globalConverged` flag. A line-isomorphic image requires a convergence-subsystem rewrite, not a per-hunk edit.
- **Decision needed from user:** convert back to `PENDING` with a directive to extract a standalone `NIconvTest` matching v41 (early-return control flow + troubleNode/troubleElt), or accept the inlined structure as an architectural divergence via a sequenced reconstruction item.
- **Resolution:** _pending_

---

### ESC-005 — `maths-ni/niinit.c#h001` — `SMPnewMatrix` gains a `size` arg whose target is the settled, out-of-scope sparse solver

- **Raised by:** applier (unit "maths-ni")
- **Trigger:** cross-group architecture change (target in an out-of-scope file)
- **ngspice:** `src/maths/ni/niinit.c` line `28` (`return(SMPnewMatrix(&(ckt->CKTmatrix)));` → `return SMPnewMatrix(&(ckt->CKTmatrix), 0);`), with `SMPnewMatrix(SMPmatrix **pMatrix, int size) { *pMatrix = spCreate(size, 1, &Error); }` at `ref/ngspice/src/maths/sparse/spsmp.c:252`. The new `0` arg reproduces v26's implicit size-0 (dynamically-sized) matrix exactly.
- **digiTS:** `src/solver/analog/ckt-context.ts:685` — `solver._initStructure()`
- **What is blocked:** making the call site `solver._initStructure(0)` (line-isomorphic to the `+` line) requires adding a `size` parameter to `SparseSolver._initStructure`, which is defined in `src/solver/analog/sparse-solver.ts` — OUTSIDE my file scope AND governed by the CLAUDE.md "Sparse Solver is Settled — Do Not Re-Investigate" hard rule.
- **Architecture change required:** add an optional `size` parameter (default 0 = dynamic) to `SparseSolver._initStructure` mirroring `spCreate`'s size arg, then pass `0` from `ckt-context.ts`. Touches `src/solver/analog/ckt-context.ts` and `src/solver/analog/sparse-solver.ts`.
- **Why it exceeds one functionGroup / why it is ambiguous:** the only behaviorally-faithful landing for the `+` arg is a signature change to the settled sparse solver, which is both out of file scope and under a do-not-touch hard rule — a user decision, not an in-functionGroup change.
- **Decision needed from user:** authorize the `_initStructure(size = 0)` signature change in `sparse-solver.ts` (with the call site updated to `_initStructure(0)`), or rule the `, 0` arg a behavior-identical no-op at this call site and direct how to record it.
- **Resolution:** _pending_

---

### ESC-006 — `maths-ni/niiter.c#h001`–`#h006` — newtonRaphson is a restructured inline port; v41 NIiter additions (msgcount/NIresetwarnmsg/DOING_TRAN errMsg) absent

- **Raised by:** applier (unit "maths-ni")
- **Trigger:** pre-image failure (mix of case b and case c) + isomorphic-delta failure + C→TS ambiguity
- **ngspice:** `src/maths/ni/niiter.c` lines `843-1343` (the NIiter v26→v41 rewrite), v41 tree `ref/ngspice/src/maths/ni/niiter.c`. Per-hunk diff slices: `#h001` :370-439, `#h002` :440-491, `#h003` :492-532, `#h004` :533-557, `#h005` :558-739, `#h006` :740-758.
- **digiTS:** `src/solver/analog/newton-raphson.ts` — `newtonRaphson` (`:406-918`)
- **What is blocked:** our NR loop is a heavily restructured INLINE port (cktLoad / factor / solve / STEP-H / INITF dispatcher) that already embodies several v41 forms (node-damping uses `Math.abs` = v41 `fabs`, not the v26 signed diff → case b) while LACKING the v41 additions entirely: no file-static `msgcount` + 6-message singular-matrix limiter, no `eq(NODENAME(i),NODENAME(j))` single-vs-double-node branch (`#h003`), no `NIresetwarnmsg()` function (`#h006`), no `DOING_TRAN`-gated `errMsg = copy(...)` iterlim string (`#h005`), and no `OldCKTstate0` memcpy (we use `oldState0.set()`, `#h005`). Grep confirms `msgcount`/`NIresetwarnmsg`/`DOING_TRAN`/`copy(`/`errMsg`/`currentAnalysis` are all absent from `newton-raphson.ts`.
- **Architecture change required:** either (a) supply a v26-baseline reconstruction of NIiter so the `-` pre-images are case (a) and the delta applies against a faithful v26 line-structure, or (b) re-port `newtonRaphson` to a line-structured mirror of v41 NIiter including the file-static `msgcount` limiter, the `eq(NODENAME)` single/double-node branch, `NIresetwarnmsg()`, the `DOING_TRAN`-gated `errMsg copy()`, and the `OldCKTstate0` memcpy. Touches `src/solver/analog/newton-raphson.ts` and `src/solver/analog/diagnostics.ts` + `ckt-context.ts` (msgcount/NIresetwarnmsg/troubleElt plumbing, cross-group).
- **Why it exceeds one functionGroup / why it is ambiguous:** the pre-image is case (b)/(c) across all six hunks; the inlined NR loop is not line-isomorphic to C `NIiter`; and mapping the new singular-matrix-message and reset constructs into the restructured loop is genuinely ambiguous. This is a full NIiter rewrite spanning the NR/diagnostic subsystem.
- **Decision needed from user:** convert back to `PENDING` with a directive to either author a v26-baseline NIiter reconstruction or re-port `newtonRaphson` as a line-structured v41 mirror (including the message-limiter / reset / errMsg additions).
- **Resolution:** _pending_

---

### ESC-007 — `include-ngspice/*` (22 hunks, unit "include-ngspice") — engine C-header declaration hunks have no line-isomorphic image in our `.c`-behavior port

- **Raised by:** applier (unit "include-ngspice")
- **Trigger:** pre-image failure (case b/c) and/or target absent / cross-group — applies to every hunk in the unit
- **Summary:** All 22 PENDING hunks assigned to this unit live in ngspice C **header** files under `ref/ngspice/src/include/ngspice/` (`acdefs.h`, `cktdefs.h`, `const.h`, `defines.h`, `devdefs.h`, `inpptree.h`, `optdefs.h`, `smpdefs.h`, `trandefs.h`, `tskdefs.h`). Each hunk is one of: (i) a `#define`→`enum` conversion of card-parser parameter-index constants (`AC_*`, `PARM_*`, `OPT_*`, `TRAN_*`, the `DECADE/OCTAVE/LINEAR` sweep types); (ii) a `struct`-member declaration/comment-reword/reorder inside `CKTcircuit` or `TSKtask`; or (iii) a C forward-prototype declaration. digiTS ports the ngspice **`.c` behavioral source**, not the `.h` declarations — it has no `cktdefs.h`/`optdefs.h`/`tskdefs.h` analogue, no `CKTcircuit`/`TSKtask`/`SPICEdev` struct, no integer parameter-index tables, and no deck-card parser to consume those indices. So for every hunk the v26 `-` lines are case (b) (a TS counterpart exists but is not that line modulo rename/syntax) or case (c) (absent), and/or the v41 `+` lines have no in-scope construct to land a line-isomorphic delta in. Per TASK.md §6 a case-(b)/(c) pre-image is an escalation; the applier may never reclassify a PENDING hunk as NO-COUNTERPART (frozen Phase-0 only). Per-hunk detail and `hunkHash` are recorded in `progress.json`; the recurring sub-cases:
  - **Card-parser parameter-index `#define`→`enum`** — `acdefs.h#h001` (AC_DEC..AC_STEPS + DECADE/OCTAVE/LINEAR), `cktdefs.h#h003` (PARM_NS/PARM_IC/PARM_NODETYPE), `optdefs.h#h001a` (OPT_GMIN..OPT_CSHUNT), `trandefs.h#h001` (TRAN_TSTART..TRAN_UIC). digiTS carries these as **named typed config** (`AcParams.type` string union; `SimulationParams.reltol/gmin/xmu/indVerbosity/...`; coordinator transient config) and as `Map<nodeId,voltage>` ics/nodesets — never as integer indices, and there is no `.ac`/`.options`/`.tran`/`.nodeset` deck-card parser that would consume them. Pre-image case (c).
  - **`CKTcircuit` / `TSKtask` struct-member decl/comment/reorder** — `cktdefs.h#h004` (CKTstates[8] paren-drop), `#h005` (CKTtime/CKTdelta/... comment reword), `#h006` (CKTxmu/CKTindverbosity additions — behavior already present as `xmu`/`cktIndVerbosity`), `#h007` (prev_CKTlastNode → compiler.ts, out of file scope), `#h010` (gmin/gshunt block reword + CKTcshunt/CKTepsmin/RFSPICE/noise_input additions), `#h012a` (CKTepsmin); `tskdefs.h#h001` (TSKxmu/TSKindverbosity), `#h003` (DOING_SP RFSPICE), `#h004` (TSKminBreak comment + TSKcshunt), `#h005` (TSKnoopac reorder + TSKepsmin). digiTS has no `CKTcircuit`/`TSKtask` struct; these fields are scattered TS class/interface fields (often pre-applied) or absent (CKTcshunt/CKTepsmin shunt-cap & log-floor, RFSPICE S-param, noise_input — the latter outside the frozen v41 device-class scope). No line-isomorphic struct-decl delta exists; several are case (b), some all-`+` with no struct to mutate (condition 2).
  - **C forward prototypes / settled-solver / expression-table** — `devdefs.h#h001` (DEVlimitlog/DevCapVDMOS prototypes; functions already defined in newton-raphson.ts, no separate TS prototype line), `#h002` (SPICEdev vtable whitespace; element.ts out of file scope); `smpdefs.h#h001` (SMPnewMatrix gains `size` arg — twin of the already-escalated ESC-005, touches the settled sparse solver), `#h002` (SMPconstMult/SMPmultiply — no consumer, settled solver); `inpptree.h#h001` (PTF_DDT — digiTS uses a string-keyed BUILTIN_FUNCTIONS map, no integer PTF_* code table, no ddt), `#h002` (EXPARGMAX/EXPMAX exp-overflow clamp — no clamped-exp path; `exp`→`Math.exp`); `const.h#h001` (CHARGE/CONSTboltz/REFTEMP — our constants.ts already holds the v41 **values**, case b, plus many new constants absent), `defines.h#h001` (M_*/float-limit/DIR_/TEMP/SYSTEM_ CLI-plumbing macros + MAX_EXP_ARG; mostly no-counterpart, MAX_EXP_ARG absent).
- **What is blocked:** the literal application of any of these header hunks as a line-isomorphic `git diff` of our TS. The **behaviors** several of them declare are already present (xmu, indVerbosity, limitlog, devCapVdmos, and the v41 constant values), landed by earlier device/engine passes per the CLAUDE.md hot-loadable-params requirement — but a header declaration has no separable TS counterpart line, so recording them APPLIED with a zero-line delta would mis-claim a port that the four §5 APPLY conditions do not support.
- **Architecture change required:** disposition is per sub-case and is a user/Phase-0 action, not an in-functionGroup edit: (1) for the card-parser index `#define`→`enum` hunks (AC_*/PARM_*/OPT_*/TRAN_*) and the RFSPICE/noise/S-param struct members and the SPICEdev/prototype headers — these are the classic "ngspice declaration with no behavioral counterpart in our port" shape that only frozen Phase-0 may mark NO-COUNTERPART; (2) for the pre-applied behavioral fields (CKTxmu/CKTindverbosity → `xmu`/`cktIndVerbosity`; DEVlimitlog/DevCapVDMOS → `limitlog`/`devCapVdmos`; const.h v41 values) — a user decision whether to record APPLIED against the already-present TS construct despite the absent v26 pre-image (mirrors the ESC-003 pre-applied-xmu precedent); (3) for the genuinely-unported behavioral fields (CKTcshunt/TSKcshunt shunt capacitor, CKTepsmin/TSKepsmin log floor, MAX_EXP_ARG/EXPARGMAX/EXPMAX/PTF_DDT exp-clamp+ddt) — new SimulationParams/constants fields plus load-path/expression-evaluator wiring spanning files outside this functionGroup; (4) `cktdefs.h#h007` (prev_CKTlastNode → compiler.ts), `devdefs.h#h002` (→ element.ts), and `smpdefs.h#h001/#h002` (→ the settled sparse-solver) are out of this unit's FILE SCOPE / under the settled-solver hard rule.
- **Why it exceeds one functionGroup / why it is ambiguous:** every hunk is a header **declaration**; digiTS has no header layer mirroring these C structs/macros, so there is no per-statement TS edit that renders as a line-isomorphic image of a struct-member or `#define`→`enum` or prototype reformat. The behaviorally-new fields require subsystem wiring (options/node-constraint/expression-table/shunt-cap/log-floor) and several targets are out of file scope or under the settled-solver rule.
- **Decision needed from user:** per the sub-cases above — (1) frozen-Phase-0 NO-COUNTERPART for the card-parser parameter-index tables (AC_*/PARM_*/OPT_*/TRAN_*), the RFSPICE/S-param/noise struct members, and the C forward-prototype/vtable headers; (2) a recording directive for the pre-applied behavioral fields/values (APPLIED-against-present-construct vs v26-baseline reconstruction, as for ESC-003); (3) sequenced reconstruction items (with target files named) for the unported behavioral additions (cshunt, epsmin log floor, PTF_DDT/ddt + EXP clamp); (4) authorization for the out-of-scope/settled-solver targets (compiler.ts prev_CKTlastNode, element.ts SPICEdev signature, sparse-solver SMPnewMatrix size-arg + SMPconstMult/SMPmultiply — the last shared with ESC-005). No rename-map rows were added: zero hunks were applied, and `rename-maps/include-ngspice.md` does not exist on disk (the contract forbids the applier creating it).
- **Resolution:** _pending_

---

### ESC-008 — `isrc#recon/coeffWaveforms` — reconstruction spec missing; cannot rebuild the ngspice coeff-array waveform engine

- **Raised by:** applier (reconstruction builder, unit "isrc")
- **Trigger:** reconstruction spec absent (a pre-image-class blocker — the spec the recon must be built from does not exist), compounded by three unresolved Phase-0 user decisions that gate authoring it
- **ngspice:** v26-baseline of `src/spicelib/devices/isrc/isrcload.c` (`ISRCload` waveform `switch`), `isrcacct.c` (`ISRCaccept` breakpoint scheduling), `isrcpar.c` (coeff-vector + `trnoise`/`trrandom` state init), `isrctemp.c` (transient time-0 value derivation), `isrcdefs.h` (`ISRCcoeffs[]`/`ISRCfunctionType`/`ISRCfunctionOrder` fields + source-type ids), v41 tree `ref/ngspice/src/spicelib/devices/isrc/`
- **digiTS:** `src/components/sources/ac-current-source.ts` — `AcCurrentSourceAnalogImpl.load` / `acceptStep` / `nextBreakpoint` / constructor
- **What is blocked:** the entire `isrc#recon/coeffWaveforms` reconstruction item, and the 19 v41 hunks gated on it (`isrc/isrcacct.c#h002`, `#h003`, `#h004`, `#h005`; `isrc/isrcload.c#h003`–`#h014`; `isrc/isrcpar.c#h003`, `#h004`; `isrc/isrctemp.c#h002`). The reconstruction must replace digiTS's own waveform set with the ngspice `ISRCcoeffs[]`-driven engine (`PULSE/SINE/EXP/SFFM/AM/PWL/TRNOISE/TRRANDOM` via `ISRCfunctionType`/`ISRCfunctionOrder`). The spec file `spec/v41-port/reconstruction/isrc-coeffWaveforms.md` **does not exist on disk** (the `reconstruction/` dir holds cap-/ind-/jfet-/mut-/res-/vccs-/vdmos- specs but no `isrc-*.md`). Current target confirmed against the planning gap: `ac-current-source.ts` ships the digiTS-native set (`waveform` enum sine/square/triangle/sawtooth/expression/sweep/am/fm/noise, evaluated by `computeWaveformValue` imported from `ac-voltage-source.ts`), with no `ISRCcoeffs`/`ISRCfunctionType`/`ISRCfunctionOrder` — so the 19 hunks have an absent (case-c) pre-image and nothing to apply onto.
- **Architecture change required:** rebuild the ngspice coeff-array independent-source waveform engine as the **v26 baseline** of `ISRCload`/`ISRCaccept` inside `AcCurrentSourceAnalogImpl` — the `ISRCcoeffs[]` parameterisation, the `ISRCfunctionType`/`ISRCfunctionOrder` dispatch, and the per-function evaluation/breakpoint logic — **replacing** (per `device-class-scope.md`'s "complete v41 device, no we-do-something-simpler" rule) the digiTS-native `computeWaveformValue` set. Touches `src/components/sources/ac-current-source.ts` (and the editor-facing `waveform` property/UX it re-expresses).
- **Why it exceeds one functionGroup / why it is ambiguous:** this is a from-scratch reconstruction whose end state is genuinely undetermined without the spec, and the planning review (`isrc-review.md` §6) states explicitly that "the planner does **not** author the reconstruction specs in this pass — the spec files are a separate deliverable, **authored after the user approves this review**." Three Phase-0 user decisions (`isrc-review.md` §7) gate the spec and remain unresolved: **Q-ISRC-DECOMP** (does `dc-current-source.ts` stay a pure DC-value source with only `m`, leaving the full waveform engine in `ac-current-source.ts`, or collapse the two elements into one ngspice-faithful element?); **Q-ISRC-WAVEFORM-FIDELITY** (flagged as "the largest-blast-radius decision in the isrc port" — confirm the reconstruction **replaces** rather than supplements the digiTS-native waveform set, re-expressing the editor-facing `waveform` enum as ngspice function types); and the `ISRCcoeffs[]` parameterisation/UX mapping that follows from it. Authoring the spec by inference would be inventing it — forbidden by the reconstruction-from-spec contract and the project "no pragmatic shortcuts / match ngspice exactly" rule.
- **Decision needed from user:** resolve the three §7 Phase-0 questions (Q-ISRC-DECOMP, Q-ISRC-ACLD-SPLIT, Q-ISRC-WAVEFORM-FIDELITY), then author `spec/v41-port/reconstruction/isrc-coeffWaveforms.md` defining the coeff-array waveform engine end state (function-type dispatch, `ISRCcoeffs[]`/order parameterisation, the `waveform`-enum → ngspice-function-type re-expression, breakpoint scheduling), and rebuild the ledger so this item returns to `PENDING` for the builder.
- **Resolution:** _pending_

---

### ESC-009 — `isrc#recon/parallelMultiplier` — reconstruction spec missing; cannot rebuild the `m` parallel-multiplier parameter

- **Raised by:** applier (reconstruction builder, unit "isrc")
- **Trigger:** reconstruction spec absent (a pre-image-class blocker — the spec the recon must be built from does not exist)
- **ngspice:** v26-baseline of `src/spicelib/devices/isrc/isrcload.c` (`m = here->ISRCmValue`; `here->ISRCcurrent = m*value`), `isrcacld.c` (the `m·acReal`/`m·acImag` AC stamps), `isrctemp.c` (`ISRCmValue` default = 1.0 when `!ISRCmGiven`), `isrcdefs.h` (`ISRCmValue` field, `ISRCmGiven` flag), `isrc.c` (`ISRC_M` IFparm row), v41 tree `ref/ngspice/src/spicelib/devices/isrc/`
- **digiTS:** `src/components/sources/ac-current-source.ts` — `AcCurrentSourceAnalogImpl` (`load` RHS stamp, `stampAc` AC stamp, `getPinCurrents`); also `src/components/sources/dc-current-source.ts` (`DcCurrentSourceAnalogImpl`, same three sites) per the planning target — **outside this recon's stated `tsFiles` scope**, see below
- **What is blocked:** the entire `isrc#recon/parallelMultiplier` reconstruction item, and the 2 v41 hunks gated on it (`isrc/isrcacld.c#h001` — once split, `#h001a`/`#h001c`; and `isrc/isrcload.c#h015` — `ISRCcurrent = m*value`). The reconstruction must add the `m` parameter (`ISRCmValue`/`ISRCmGiven`, default 1.0) and apply it at every RHS stamp, the AC-load stamp, and the recorded `ISRCcurrent`. Confirmed against current code: `AcCurrentSourceAnalogImpl` treats `m ≡ 1` (the comment at ac-current-source.ts:410-411 reads "digiTS does not expose `m` for sources, so m ≡ 1 — the stamp collapses to a single ± at each node"); there is no `_M`/`ISRCmValue` field, no `m` factor in `load()`/`stampAc()`/`getPinCurrents()`. The spec file `spec/v41-port/reconstruction/isrc-parallelMultiplier.md` **does not exist on disk**.
- **Architecture change required:** rebuild the `m` parallel-multiplier instance parameter as the **v26 baseline**: add the `m` model param + `_M` field to `AcCurrentSourceAnalogImpl` (default 1.0 when not given), and multiply it into the `load()` RHS stamp, the `stampAc()` AC stamp (`m·acReal`/`m·acImag`), and `getPinCurrents()`. The planning target (`isrc-review.md` §6b) additionally names `src/components/sources/dc-current-source.ts` (`DcCurrentSourceAnalogImpl`, same three sites) as part of this recon's blast radius — but my FILE SCOPE for this recon is `[src/components/sources/ac-current-source.ts]` only; `dc-current-source.ts` is not in my contracted `tsFiles`.
- **Why it exceeds one functionGroup / why it is ambiguous:** two blockers. (1) The spec is absent and, per `isrc-review.md` §6, reconstruction specs are "a separate deliverable, authored after the user approves this review" — not authored by the loop. (2) The planning doc's stated target for this recon spans **two** element files (`ac-current-source.ts` **and** `dc-current-source.ts`), but my contracted FILE SCOPE is `ac-current-source.ts` alone; building only the AC half would leave the DC source's `m` baseline unbuilt and the recon's stated scope half-met — a file-scope conflict the contract directs me to escalate rather than narrow silently. Coupled with Q-ISRC-DECOMP (§7, unresolved), which determines whether `dc-current-source.ts` participates at all, the correct target file set is genuinely undetermined.
- **Decision needed from user:** author `spec/v41-port/reconstruction/isrc-parallelMultiplier.md` defining the `m`/`ISRCmValue`/`ISRCmGiven` parameter and its application points, **and** reconcile the file scope: either expand this builder's `tsFiles` to include `src/components/sources/dc-current-source.ts` (resolving Q-ISRC-DECOMP) or declare a separate recon item for the DC source. Then rebuild the ledger so this item returns to `PENDING`.
- **Resolution:** _pending_

---

### ESC-010 — `dio#recon/diotempUpdate` — reconstruction spec missing; cannot rebuild the full v26 `DIOtemp` body + `DIOtempUpdate(Temp)` helper

- **Raised by:** applier (reconstruction builder, unit "dio")
- **Trigger:** reconstruction spec absent (a pre-image-class blocker — the spec the recon must be built from does not exist)
- **ngspice:** v26-baseline of `src/spicelib/devices/dio/diotemp.c` (`DIOtemp`, refactored in v41 into `DIOtempUpdate(Temp)` + a thin `DIOtemp` driver) and `src/spicelib/devices/dio/diosetup.c` (the IS/IKF/IKR/satCur `CKTepsmin` floors + `DIOnomTemp`/`DIOconductance` defaulting), v41 tree `ref/ngspice/src/spicelib/devices/dio/`
- **digiTS:** `src/components/semiconductors/diode.ts` — `dioTemp()` (extend to the full v26 body + the `_dT` derivative outputs in `DioTempParams`), `DiodeAnalogElement.computeTemperature` (call with explicit `Temp`), `createDiodeElement`/`DiodeAnalogElement.setup` (the satCur/knee epsmin floors + nomTemp/conductance defaults)
- **What is blocked:** the entire `dio#recon/diotempUpdate` reconstruction item, and the 12 v41 hunks it gates (`dio/diodefs.h#h004`; `dio/dioload.c#h001`, `#h004`, `#h010`, `#h011`, `#h013`, `#h014`, `#h015`; `dio/diosetup.c#h002`, `#h003`; `dio/diotemp.c#h001`, `#h002`). The reconstruction must rebuild the v26 `DIOtemp` body digiTS skipped: the `tlev`/`tlevc` temperature-level branch selection; the TM1/TM2 junction-grading and TTT1/TTT2 transit-time temperature coefficients; the TRS/TRS2 series-resistance temperature adjust (area-scaled `DIOtConductance`); the tunneling saturation currents `DIOtTunSatCur`/`DIOtTunSatSWCur`; the `brkdEmissionCoeff` breakdown-current matching iteration; the full sidewall depletion-cap path (`tF2SW`/`tF3SW`/`tDepSWCap`); plus the `_dT` temperature-derivative outputs and the `DIOtempUpdate(Temp)` refactor (explicit-temperature helper so self-heating can re-evaluate at `Temp+delTemp`). `ledger.json` records this reconstruction item with `"specExists": false`; the spec file `spec/v41-port/reconstruction/dio-diotempupdate.md` **does not exist on disk** (the `reconstruction/` dir holds cap-/ind-/jfet-/mut-/res-/vccs-/vdmos- specs but no `dio-*.md`). The planning review (`planning/dio-review.md` §6) states explicitly: "The planner does **not** author the reconstruction specs in this pass — the four spec files are a separate deliverable, authored after the user approves this review."
- **Architecture change required:** rebuild the complete v26 `diotemp.c` temperature-scaling body inside `diode.ts` `dioTemp()` (the tlev/tlevc branch, TM1/TM2/TTT1/TTT2/TRS/TRS2 coefficients, tunneling sat currents, brkdEmissionCoeff iteration, sidewall depletion-cap path), refactor it into a `DIOtempUpdate(Temp)` form taking an explicit temperature, extend `DioTempParams` with the `_dT` derivative fields, route `computeTemperature` through the explicit-`Temp` call, and add the satCur/IKF/IKR epsmin floors + `DIOnomTemp`/`DIOconductance` defaults in `createDiodeElement`/`setup`. Touches `src/components/semiconductors/diode.ts` only (within contracted file scope) — but the **end state is genuinely undetermined without the spec**.
- **Why it exceeds one functionGroup / why it is ambiguous:** this is a from-scratch reconstruction of a large temperature-model body whose exact shape (which tlev/tlevc levels digiTS hosts, the `DioTempParams` `_dT` field set, how the explicit-`Temp` `DIOtempUpdate` signature interacts with the existing `computeTemperature`/`setParam` hot-load path, the epsmin-floor placement) is exactly what the missing spec was to fix. Authoring it by inference would be inventing the spec — forbidden by the reconstruction-from-spec contract (TASK.md: recon items "are built from their own spec in a pre-phase") and the project "no pragmatic shortcuts / match ngspice exactly" rule.
- **Decision needed from user:** author `spec/v41-port/reconstruction/dio-diotempupdate.md` defining the full v26 `DIOtemp` body + `DIOtempUpdate(Temp)` refactor (tlev/tlevc, TM1/TM2/TTT1/TTT2/TRS/TRS2, tunneling, brkdEmissionCoeff, sidewall cap, `_dT` outputs, epsmin floors/defaults) against verified `ref/ngspice/src/spicelib/devices/dio/diotemp.c` + `diosetup.c` citations, then rebuild the ledger so `specExists` flips true and this item returns to `PENDING` for the builder.
- **Resolution:** _pending_

---

### ESC-011 — `dio#recon/v41NewFeatures` — reconstruction spec missing; cannot build self-heating + recombination + level-3 geometry-cap subsystems

- **Raised by:** applier (reconstruction builder, unit "dio")
- **Trigger:** reconstruction spec absent (a pre-image-class blocker — the spec the recon must be built from does not exist), compounded by a file-scope conflict (the recon's ledger `tsFunction` names a second file outside the contracted `tsFiles`)
- **ngspice:** v41-new state of `src/spicelib/devices/dio/dioload.c`, `diosetup.c`, `dioacld.c`, `dioconv.c`, `diodefs.h`, `diotemp.c`, `dioparam.c` (the three v41-new diode subsystems), v41 tree `ref/ngspice/src/spicelib/devices/dio/`
- **digiTS:** `src/components/semiconductors/diode.ts` — `DIODE_SCHEMA` (4 new thermal slots), `buildDiodePinDeclarations` (always-present `Tj` pin), `DIODE_PARAM_DEFS` (rth0/cth0/thermal + isr/nr + lm/lp/wm/wp/xom/xoi/xm/xp + level), `dioTemp()` (tRecSatCur scaling), `DiodeAnalogElement.setup`/`load`/`checkConvergence`/`stampAc`; **and** `src/core/constants.ts` (`CONSTepsSiO2`) — the latter **outside this recon's contracted `tsFiles` scope** (contract names only `[src/components/semiconductors/diode.ts]`)
- **What is blocked:** the entire `dio#recon/v41NewFeatures` reconstruction item, and the 31 v41 hunks it gates (`dio/dioload.c#h002`, `#h012`; `dio/dio.c#h001`; `dio/diodefs.h#h003`; `dio/dioparam.c#h002`, `#h003`; `dio/dioload.c#h017`; `dio/diosetup.c#h001`, `#h004`; `dio/dio.c#h006`; `dio/dioacld.c#h002`; `dio/dioask.c#h001`; `dio/dioconv.c#h002`; `dio/diodefs.h#h002`, `#h005`, `#h007`, `#h008`, `#h009`; `dio/diompar.c#h001`; `dio/dioload.c#h003`, `#h005`, `#h006`, `#h007`, `#h008`, `#h009`, `#h018`, `#h019`, `#h020`; `dio/diosetup.c#h005`, `#h006`, `#h007`). The reconstruction must build three v41-new subsystems together: (1) **electro-thermal self-heating** — an always-present third `Tj` thermal terminal (3-terminal diode), `DIOthermal` flag + `rth0`/`cth0` model params, thermal-cap `NIintegrate` (`DIOqth`/`DIOcqth`) + `DIOdeltemp`/`DIOdIdio_dT` state slots (`DIOnumStates` 5→9), the `DEVlimitlog` thermal-step limit, `DIOtempUpdate` re-eval at `Temp+delTemp`, dissipated power `Ith=vd·cd+vrs²·gspr` and its Jacobian (`dIth_dVrs`/`dIth_dVdio`/`dIth_dT`/`dIrs_dT`/`gcTt`), the seven thermal-node `TSTALLOC` stamps + RHS in `load()`, and the AC (`dioacld`) + convergence (`dioconv`) thermal branches; (2) **recombination current** — `isr` (`DIOrecSatCur`)/`nr` (`DIOrecEmissionCoeff`) params, `DIOtRecSatCur`/`_dT` temp scaling, `cdb_rec` with the `gen_fac=((1−vd/tJctPot)²+0.005)^(tGradingCoeff/2)` generation factor and its V/T derivatives, gated on `DIOrecSatCurGiven`; (3) **level=3 parasitic geometry caps** — `lm`/`lp`/`wm`/`wp`/`xom`/`xoi`/`xm`/`xp` params, `CONSTepsSiO2`, area/perimeter-from-w/l-and-scale derivation, `DIOcmetal`/`DIOcpoly` folded into `capd`, plus the `cp_getvar('scale')` fold and `DIO_W`/`DIO_L` de-scaling. `ledger.json` records this reconstruction item with `"specExists": false`; the spec file `spec/v41-port/reconstruction/dio-v41newfeatures.md` **does not exist on disk**.
- **Architecture change required:** build all three subsystems from scratch in `diode.ts` (schema expansion to 9 state slots, the `Tj` pin in `buildDiodePinDeclarations`, the new param rows, the thermal/recombination/level-3 blocks in `setup`/`load`/`checkConvergence` and the AC path) **plus** add `CONSTepsSiO2` to `src/core/constants.ts`. The constants.ts edit is **outside the contracted `tsFiles` `[src/components/semiconductors/diode.ts]`** — a file-scope conflict the contract directs me to escalate rather than silently broaden.
- **Why it exceeds one functionGroup / why it is ambiguous:** two compounding blockers. (1) The spec is absent and, per `planning/dio-review.md` §6, reconstruction specs are "a separate deliverable, authored after the user approves this review" — not authored by the loop; the end state of three woven v41-new subsystems (state-slot layout, `Tj`-terminal topology and its three-surface test impact, the Ith Jacobian cache fields, the recombination generation-factor derivatives, the level-3 geometry derivation, the engine-side `TempContext` re-eval at perturbed `Temp`) is genuinely undetermined without it. (2) The recon's own ledger `tsFunction` names `src/core/constants.ts` as a required edit target, which is outside my contracted file scope. Authoring the spec by inference would be inventing it — forbidden by the reconstruction-from-spec contract and the "no pragmatic shortcuts / match ngspice exactly" rule. (Related historical planning open questions Q-DIO-ONE-RECON, Q-DIO-TJ-TERMINAL appear resolved in the ledger — the four planning reconstructions were merged to the hybrid `diotempUpdate` + `v41NewFeatures` pair and `Tj` is always-present per the ledger title's "#38" / "#20" notes — but the spec document realising those decisions was never written.)
- **Decision needed from user:** author `spec/v41-port/reconstruction/dio-v41newfeatures.md` defining the three v41-new diode subsystems (self-heating thermal node + state expansion + Ith Jacobian + thermal stamps + AC/conv branches; recombination current + temp scaling + derivatives; level-3 geometry parasitic caps + scale fold), **and** reconcile the file scope by expanding this builder's `tsFiles` to include `src/core/constants.ts` (for `CONSTepsSiO2`). Then rebuild the ledger so `specExists` flips true and this item returns to `PENDING`.
- **Resolution:** _pending_

---

### ESC-012 — `sw/swload.c#h002` — `SWload` MODEINITFLOAT bad-previous-state branch: our port substituted `current_state = HYST_OFF` for ngspice's `internalerror(...)`

- **Raised by:** applier (unit "sw")
- **Trigger:** pre-image failure (case b, present-but-differs)
- **ngspice:** `src/spicelib/devices/sw/swload.c` line `90` (MODEINITFLOAT negative-hysteresis, in-hysteresis sub-block: `else  internalerror("bad value for previous state in swload");`), v41 tree `ref/ngspice/src/spicelib/devices/sw/swload.c`. In the v41 diff hunk `sw/swload.c#h002` (sw.md docLineRange 801-960) this is the `-`/`+` pair at diff lines 828-829 (v26) / 854-855 (v41) — the line *changed* (whitespace only) v26→v41, so it is a `-` line of the hunk, not unchanged context.
- **digiTS:** `src/components/active/analog-switch.ts` — `swLoadHandles` (the SWload body), MODEINITFLOAT branch, line `200`: the final `else { current_state = HYST_OFF; }` of the negative-hysteresis in-hysteresis previous-state chain (analog-switch.ts:193-201).
- **What is blocked:** the whole `sw/swload.c::SWload` functionGroup (`#h001` file-header comment + `#h002` body). Every other `-` line of `#h002` is case (a) (paren/whitespace removal, `CKTstates[0]+SWstate`→`CKTstate0[SWswitchstate]`, ptr→Ptr, `return(OK)`→`return OK` — all allowed differences, so the v26→v41 delta on those is a zero-line TS delta). The single blocking line is the bad-previous-state default: ngspice (both v26 and v41) calls `internalerror("bad value for previous state in swload")` — its fatal internal-error reporter — for the theoretically-unreachable case; digiTS's pre-existing `swLoadHandles` port instead silently assigns `current_state = HYST_OFF`. The `-` line `internalerror(...)` has a clear TS counterpart (the same `else`) but is **not that line modulo identifier-rename / C↔TS syntax** → case (b). Per TASK.md §6 ("APPLY only if every `-` line is case (a); if any `-` line is (b) or (c) → ESCALATE; do not edit on top of a (b)"), the group escalates. This divergence pre-dates the v26 baseline (it is in the pre-existing `SWload` port, not in any of the three sw reconstructions acLoad/trunc/icParam, all APPLIED).
- **Architecture change required:** replace `current_state = HYST_OFF;` (analog-switch.ts:200) with a digiTS equivalent of ngspice `internalerror(...)` — i.e. surface a fatal/internal-error for the unreachable bad-previous-state case (throw, or route through the engine's internal-error/diagnostic channel) rather than silently defaulting to `HYST_OFF`. Touches only `src/components/active/analog-switch.ts` (within file scope) — but it is a **behavioral change not described by this hunk's delta** (the hunk's delta on that line is whitespace-only v26→v41), so it is not a change I may make under the disposition rule; it is a pre-image (b) the user must direct.
- **Why it exceeds one functionGroup / why it is ambiguous:** not ambiguous in mechanism — the issue is the forbidden edit-on-top-of-(b). The faithful v26-pre-image of this line is `internalerror(...)`; our port already diverged to `HYST_OFF`. Applying the (cosmetic) hunk on top of a diverged line, or "fixing" the line to `internalerror` as part of this hunk, both violate the contract (the latter applies a change the diff does not contain). The right disposition is a user decision: a v26-baseline correction of the `SWload` bad-previous-state branch, sequenced as its own item.
- **Decision needed from user:** convert back to `PENDING` with a directive — either (a) "make the MODEINITFLOAT bad-previous-state default match ngspice `internalerror(...)`" (and name the digiTS internal-error channel to route it through), restoring the case-(a) pre-image so `#h002` applies as a clean zero-line cosmetic delta; or (b) split a dedicated "restore v26 `SWload` bad-previous-state branch" baseline item that lands ahead of `sw/swload.c#h002`. No "accepted divergence" outcome (TASK.md §8): ngspice errors here, digiTS must too.
- **Resolution:** _pending_

---

### ESC-013 — `vdmos#recon/wholeClass` — gate/source conductance temp-adjust ports as rebuild-from-base, not ngspice's in-place divide (`VDMOStempUpdate` invocation schedule differs)

- **Raised by:** applier (reconstruction builder, unit "vdmos")
- **Trigger:** isomorphic-delta failure + cross-group architecture (the faithful in-place port regresses a passing default-param self-heating convergence test)
- **ngspice:** `src/spicelib/devices/vdmos/vdmostemp.c` lines `59-61` (`VDMOStempUpdate`):
  `here->VDMOSgateConductance = here->VDMOSgateConductance / (1.0 + (model->VDMOStrg1 * dt) + (model->VDMOStrg2 * dt * dt));`
  and the matching `VDMOSsourceConductance` line `61`. The field is **seeded once** in `VDMOSsetup` (`vdmosset.c:283-290`, `= m/rg` / `= m/rs`) and then **divided in place**. v41 tree `ref/ngspice/src/spicelib/devices/vdmos/vdmostemp.c`.
- **digiTS:** `src/components/semiconductors/vdmos.ts` — `VdmosAnalogElement._tempUpdate` (the `vdmostemp.c:59-61` site). Current port rebuilds from base each call:
  `const baseGateCond = p.RG > 0 ? this._m / p.RG : 0.0; this._gateConductance = baseGateCond / (1.0 + (p.TRG1*dt) + (p.TRG2*dt*dt));` (and `_sourceConductance` likewise). This is a structural divergence from v41: ngspice reads the *previously-divided* field; under self-heating `VDMOStempUpdate` is re-invoked per NR iteration (`vdmosload.c:281`), so ngspice **compounds** the division across iterations (`g = g_setup / f(dt_1) / f(dt_2) / …`) while the rebuild-from-base does not.
- **What is blocked:** bit-exact match of `VDMOSgateConductance` / `VDMOSsourceConductance` under self-heating with **nonzero** `trg1`/`trg2`/`trs1`/`trs2`. For the IRF-class defaults (`trg*`/`trs*` = 0) the two forms are numerically identical (divisor = 1.0), so the harness `vdmos-power-switch.dts` gate is unaffected at defaults; the divergence is latent until temp-coefficient params are set.
- **Evidence the faithful port cannot be applied within file scope:** I applied the in-place form (`this._gateConductance = this._gateConductance / (1.0 + …)`). It **deterministically regressed** the previously-passing test `vdmos-mcp.test.ts:115` ("thermal flag forwards to the engine without breaking convergence", `THERMAL=1, RTHJC=1`, all other params default → `RG=RS=0`, `trg*=trs*=0`) from converged→non-converged, twice in a row. Reverting only the in-place edit (keeping everything else) restores the pass. With `RG=RS=0` the in-place divide is arithmetically `0/1.0 = 0` — identical to the rebuild — so the regression is **not** explained by the per-call arithmetic alone; it is produced by the interaction of the in-place mutation with digiTS's `_tempUpdate` invocation schedule (`computeTemperature` runs after `setup()` and on every `setCircuitTemp`, and `setParam` re-invokes `computeTemperature`; under self-heat `load()` re-invokes `_tempUpdate` per NR iteration), which does not line up with ngspice's "seed in `VDMOSsetup`, divide once in `VDMOStemp`, re-divide per-iteration only inside `VDMOSload`" schedule. The rebuild-from-base form is the prior reconstruction author's resolution of that mismatch; it is regression-free and matches ngspice exactly at the default temp coefficients.
- **Architecture change required:** make digiTS's temperature-recompute schedule match ngspice's so the in-place divide can be ported literally. Either (a) re-seed `_gateConductance`/`_sourceConductance` from `m/rg` / `m/rs` at the top of each `_tempUpdate` only when it is the ambient (`VDMOStemp`) call, and let the self-heat per-iteration call divide the already-seeded value (so ngspice's per-iteration compounding is reproduced without compounding across `computeTemperature`/`setParam` re-entries); or (b) change the engine temp-pass contract so `computeTemperature` (and the `setParam` recompute) re-run `setup()`'s conductance seeding first. (a) is contained in `vdmos.ts` but changes the method's control flow based on call provenance (ambient vs self-heat), which `_tempUpdate` cannot currently distinguish; (b) touches `src/solver/analog/analog-engine.ts` / `src/solver/analog/loaders/default-loaders.ts` / the `TempContext` contract — cross-group, beyond this reconstruction's `vdmos.ts` file scope.
- **Why it exceeds one functionGroup / why it is ambiguous:** porting `vdmostemp.c:59-61` literally requires `_tempUpdate` to know whether it is the once-after-setup ambient call (divide the setup-seeded value) or the per-iteration self-heat call (divide the running value) — a distinction ngspice gets for free from its call sites but digiTS does not expose to `_tempUpdate`. Resolving it correctly is an invocation-schedule change to the engine temp pass (case b above) or a provenance flag threaded into `_tempUpdate` (case a), neither of which is a per-statement edit and (b) of which leaves this file's scope.
- **Decision needed from user:** convert back to `PENDING` with a directive — either (a) "thread an `isAmbient`/`reseed` provenance into `_tempUpdate` and divide the setup-seeded base on the ambient call so the in-place divide ports literally and compounds only per-iteration under self-heat (matching `vdmostemp.c:59-61` + `vdmosload.c:281`)", or (b) "change the engine temp pass so `computeTemperature` re-seeds the conductances from `m/rg`,`m/rs` before `_tempUpdate`", restoring the case-(a) image of the in-place divide. No "accepted divergence" outcome (TASK.md §8): the rebuild-from-base currently shipped diverges from v41 whenever `trg*`/`trs*` ≠ 0.
- **Resolution:** _pending_

---

### ESC-014 — `maths-misc/randnumb.c#h005`, `#h006`, `#h008` — RNG reconstruction delivered the v41 post-image directly; the v26→v41 hunk pre-images are absent

- **Raised by:** applier (unit "maths-misc")
- **Trigger:** pre-image failure (case c, absent) — the blocking reconstruction `maths-misc#recon/randnumb` (APPLIED) built `SeededRng` to v41, not the v26 baseline, so the diff-of-diffs hunks have no v26 `-` lines to act on.
- **ngspice:** `src/maths/misc/randnumb.c`, v41 tree `ref/ngspice/src/maths/misc/randnumb.c`:
  - `#h005` lines `199-206` (`gauss0`): v26 `v1 = drand();  v2 = drand();` (one line) → v41 two lines `v1 = 2.0 * CombLCGTaus() - 1.0;` / `v2 = 2.0 * CombLCGTaus() - 1.0;`.
  - `#h006` lines `214-231` (all-`+`): adds the whole new `gauss1()` function (one-value-per-pass reproducible polar Box-Muller).
  - `#h008` lines `278-337` (`exprand` + tail): removes `checkseed();` from `exprand`, and adds the frontend `com_sseed(wordlist*)` / `setseedinfo(void)` commands.
- **digiTS:** `src/solver/analog/monte-carlo.ts` — `SeededRng.gauss0` (`#h005`, lines 356-372), `SeededRng.gauss1` (`#h006`, lines 376-385), `SeededRng.exprand` (`#h008`, lines 430-432). (`ac-voltage-source.ts::boxMuller` is the `#h008` secondary mapping target; it is an independent `Math.random`-based cosine Box-Muller still in place — unrelated to the `exprand`/`com_sseed` delta.)
- **What is blocked:** the v26 `-` pre-image lines are absent because the reconstruction built straight to the v41 shape:
  - `#h005`: `gauss0` already reads `v1 = 2.0 * this.combLCGTaus() - 1.0; v2 = 2.0 * this.combLCGTaus() - 1.0;` (the v41 `+` form). There is no `v1 = drand(); v2 = drand();` (v26 `-`) line to remove → case (c). A zero-line delta would silently drop a real statement-shape change.
  - `#h006`: `SeededRng.gauss1` already exists and is line-for-line the v41 `gauss1`. The hunk is all-`+` (a whole new function); the target is present in its post-image form, so a zero-line delta drops a real new-function addition (§5 condition 3).
  - `#h008`: `SeededRng.exprand` already has no `checkseed();` call (the v26 `-` line is absent → case c); the `+` block `com_sseed`/`setseedinfo` is ngspice frontend command-layer (`wordlist`, `cp_getvar`, `srand`, `getpid`, `cp_vset`) with no behavioral counterpart, consistent with the frozen NO-COUNTERPART rationale on h001-h003.
- **Architecture change required:** none inside this functionGroup — the v41 behavior is already realized in `monte-carlo.ts`. The conflict is a phase-ordering decision: the reconstruction sub-phase delivered the function at its v41 post-image rather than rebuilding the v26 baseline and letting this loop apply the v26→v41 delta. To restore a case-(a) pre-image, either (a) record h005/h006/h008 `APPLIED` against the recon-delivered v41 code (the v41 post-image is present and bit-identical: split `2.0*CombLCGTaus()-1.0` form, `gauss1`, no `checkseed`), or (b) split a "restore v26 baseline of `randnumb.c`" item so the `-` lines exist for the loop to remove. This is identical in shape to ESC-003 (`nicomcof.c` xmu-already-runtime / pre-applied).
- **Why it exceeds one functionGroup / why it is ambiguous:** not a per-statement edit problem — every `+` line is already present and no `-` line exists to remove, so no line-isomorphic git diff can be produced; the kind-1 (record-APPLIED) vs kind-2 (reconstruct-v26-baseline) classification is a user/planning action the applier may not self-assign (it would be reclassifying a PENDING hunk's pre-image, which §6 forbids).
- **Note on companion hunks in the same unit (NOT escalated):** `#h004` (the `/*** gauss ***/` comment block above `gauss0`) and `#h007` (the C whitespace/tab→space/brace reindent of `rgauss`) are allowed-difference-only (comment wording / C↔TS syntax) and apply as a valid zero-line TS delta (§5); they are left `PENDING` for the verifier, untouched.
- **Decision needed from user:** convert h005/h006/h008 back to `PENDING` with a directive — either "record APPLIED against the recon-delivered v41 `SeededRng` (post-image present, bit-identical)" or "split a restore-v26-baseline item for `randnumb.c` so the `-` pre-images exist".
- **Resolution:** _pending_

---

### ESC-JFET-UNSETUP — `jfet/jfetset.c#h006` — `JFETunsetup` internal-prime-node teardown reorder has no digiTS counterpart (target absent)

- **Raised by:** applier (unit "jfet")
- **Trigger:** target absent (TASK.md §5 cond 2) — the v41 `+` lines modify `JFETunsetup`, a function with no digiTS counterpart.
- **ngspice:** `src/spicelib/devices/jfet/jfetset.c` lines `198-221` (`JFETunsetup`); v41 diff `jfet.md` docLineRange 1010-1043, hunk `@@ -190,23 +202,20 @@ JFETunsetup`. The changed lines are the internal-prime-node teardown: v26 deletes `JFETsourcePrimeNode` first then `JFETdrainPrimeNode` (each guarded `node && node != externalNode`, with `node = 0` set inside the `if` braces); v41 reverses to drain-prime first then source-prime, changes each guard to `node > 0 && node != externalNode`, drops the braces, and sets `node = 0` unconditionally after the (now braceless) `CKTdltNNum(ckt, node)` call.
- **digiTS:** `src/components/semiconductors/njfet.ts` — `NJFETElement` has `setup()` (allocates source-prime BEFORE drain-prime via `ctx.makeVolt`, njfet.ts:412-456) but **no** `unsetup`/`teardown` method. `PoolBackedAnalogElement` / `AnalogElement` expose no `unsetup`/`teardown`/`dispose` hook, and the engine exposes no per-element `CKTdltNNum` equivalent (verified: zero matches for `unsetup`/`teardown`/`dltNNum` across `src/solver/analog/element.ts` and `src/components/semiconductors/`). digiTS rebuilds a **fresh engine per `compile()`** (CLAUDE.md Headless Architecture) and is GC-managed.
- **What is blocked:** the `jfet/jfetset.c::JFETunsetup` functionGroup (`#h006` only — the JFETsetup hunks `#h001`/`#h003`/`#h004`/`#h005` are in their own group and apply cleanly). `JFETunsetup` is the C matrix-node-lifecycle teardown: it frees the internal drain-prime/source-prime nodes from the SMP matrix when a device is torn down, mirroring the order in which `JFETsetup` allocated them. digiTS has no teardown surface — the same architectural reason the planner marked `jfetdel.c`/`jfetdest.c`/`jfetmdel.c` (the deleted C-heap destructor functions) `NO-COUNTERPART`. This hunk (`#h006`) was instead left `PENDING` with `tsFunction` pointing at `NJFETElement.setup` ("internal-node allocation order: source-prime before drain-prime").
- **Why the planner's mapping does not fit:** v41 changes only the **unsetup** teardown order/guards, not the **setup** allocation order. The setup-side allocation order is unchanged across v26→v41 (the v41 setup hunk `jfet/jfetset.c#h001` is a model-walk accessor rename only; it reorders nothing), and digiTS already allocates source-prime before drain-prime (njfet.ts:412-456), matching both v26 and v41 setup. There is no `JFETunsetup` body in digiTS for the `+`/`-` teardown lines to land in: the construct the v41 `+` lines modify is **absent** (§5 cond 2 fails). The four `+` teardown lines are not identifier rename / C↔TS syntax / comment (the closed allowed-difference list), so a zero-line TS delta would **drop** a real change — not a clean apply.
- **Architecture change required (out of this functionGroup / file scope):** either (a) **reclassify** `jfet/jfetset.c#h006` as `NO-COUNTERPART` alongside the JFET C-heap/lifecycle teardown family (`jfetdel.c`/`jfetdest.c`/`jfetmdel.c`, all already `NO-COUNTERPART`) — a Phase-0 planning action, which the applier may **never** take (§3); or (b) stand up a digiTS device-teardown surface (an `unsetup`/teardown hook on `AnalogElement` + an engine-side internal-node release path) so the teardown reorder has a body to land in — a cross-file architecture change that touches `src/solver/analog/element.ts` and the engine, **beyond** this `functionGroup` and **outside** the jfet applier file scope (`njfet.ts` only).
- **Decision needed from user:** convert back to `PENDING` with a directive — either (a) reclassify `#h006` `NO-COUNTERPART` with the JFET teardown/destructor family (planning action), or (b) author the digiTS element-unsetup / internal-node-release surface (cross-file, beyond this functionGroup) for the teardown reorder to land in. No "accepted divergence" outcome (TASK.md §8).
- **Resolution:** _pending_

---

## ESC-vsrc-waveformModel — reconstruction blocked: cross-file architecture + unlanded dependency

- **Item:** `vsrc#recon/waveformModel` (reconstruction; hunkHash `1028722f1de3245b`)
- **Surfaced:** 2026-05-31, recon-builder.
- **Trigger:** TASK.md §8 case 2 — target absent / cross-group architecture change beyond this functionGroup, and beyond the recon's single named tsFile `src/components/sources/ac-voltage-source.ts`.
- **Disposition:** ESCALATED — blocked, not done. No code written, nothing committed (per the recon-builder contract: the verifier records APPLIED + commits).

The spec (`spec/v41-port/reconstruction/vsrc-waveformModel.md`, RATIFIED 2026-05-30) is present and faithfully describes the ngspice waveform model. It cannot be built faithfully **within the single permitted tsFile**. Three concrete blockers:

### B1 — `LoadContext` is missing `cktStep` and `cktFinalTime`

Every order-guard default in the rebuilt `VSRCload` switch reads `ckt->CKTstep` / `ckt->CKTfinalTime`:
- PULSE `TR`/`TF` default `CKTstep`; `PW`/`PER` default `CKTfinalTime` (`ref/ngspice/src/spicelib/devices/vsrc/vsrcload.c:108-119`).
- SINE `FREQ` defaults `1/CKTfinalTime` (`vsrcload.c:181-183`).
- EXP `TD1`/`TAU1`/`TAU2` default `CKTstep`, `TD2` defaults `TD1+CKTstep` (`vsrcload.c:204-215`).
- SFFM `FC`/`FS` default `1/CKTfinalTime` (`vsrcload.c:246-253`); AM `MF` defaults `1/CKTfinalTime` (`vsrcload.c:280-282`).

Spec Part A mapping (`vsrc-waveformModel.md:132-133`) asserts `ckt->CKTstep -> ctx.cktStep` and `ckt->CKTfinalTime -> ctx.cktFinalTime` are **"already on `LoadContext`"**. They are NOT. `src/solver/analog/load-context.ts` carries `dt`/`time`/`minBreak`/`srcFact`/`cktMode` but neither `cktStep` nor `cktFinalTime`. `CKTstep`/`CKTfinalTime` live in `src/solver/analog/timestep.ts` (`_finalTime`, private) and `analog-engine.ts`; they are never propagated to the per-element `LoadContext`. `ac-voltage-source.ts` `load(ctx)` and the element ctor `(pinNodes, props, getTime)` expose no path to them (the file references only `ctx.cktMode` / `ctx.srcFact` today, `ac-voltage-source.ts:699-701`).

**Architecture change required (outside the tsFile):** add `cktStep:number` + `cktFinalTime:number` to `LoadContext` (`src/solver/analog/load-context.ts`) and propagate each `load()` in `src/solver/analog/ckt-load.ts` (mirroring the `cktMode`/`srcFact` propagation at `ckt-load.ts:92-93`) from the engine's `CKTstep` and `TimestepController._finalTime`. Touches `load-context.ts`, `ckt-load.ts`, `analog-engine.ts`/`timestep.ts`.

### B2 — `maths-misc#recon/randnumb` (deterministic RNG) has not landed

The TRNOISE (`vsrcload.c:356-398`) and TRRANDOM (`vsrcload.c:400-407`) value arms, the TRNOISE/TRRANDOM coefficient application (`vsrcpar.c:221-286`, `trnoise_state_init` / `trrandom_state_init`), and the `acceptStep` refreshes (`vsrcacct.c:228-237, 294-304`) all consume the deterministic seeded RNG (`trnoise_state`, `trrandom_state`, `CombLCGTaus`, the `f_alpha` 1/f synthesizer). The spec (Part A cross-dep `vsrc-waveformModel.md:155-167`, criterion 4) says these arms consume `maths-misc#recon/randnumb` and "if it has not landed, the noise arms are blocked on it." Grep confirms **zero** matches for `trnoise_state` / `trrandom_state` / `CombLCGTaus` / `f_alpha` / `trnoiseStateGet` under `src/`. That recon has not been built; the current `boxMuller` (`ac-voltage-source.ts:52-56`) is live `Math.random()` and non-reproducible.

### B3 — Parts F and G require files outside the recon's tsFiles

- **Part F / criterion 8:** `AcCurrentSourceAnalogImpl.acceptStep` (`ac-current-source.ts:482-605`) must mirror the `_breakTime` re-root and consume the changed `computeWaveformValue` signature. `ac-current-source.ts` imports `computeWaveformValue`/`Waveform`/`ExtendedWaveformParams` from `ac-voltage-source.ts` (`ac-current-source.ts:41-45`) and calls it at `:389`, `:432`; changing the signature from named scalars to `coeffs[]+functionType+order+step-context` breaks those call sites — the current-source file would not compile without being edited.
- **Part G / criterion 11:** `buildAcSourceSpec` (`src/solver/analog/__tests__/harness/netlist-generator.ts:1083`) must emit `PULSE`/`SINE`/`EXP`/`SFFM`/`AM`/`PWL` from `_functionType` + `_coeffs[]` verbatim.

The recon's contract tsFiles list is exactly `[src/components/sources/ac-voltage-source.ts]`. Both `ac-current-source.ts` and the harness `netlist-generator.ts` are outside it.

### Why nothing lands in isolation

The structural shell (the `FunctionType` enum, the `_coeffs`/`_functionType`/`_functionOrder`/`_breakTime`/… fields, `applyCoeffs`, the `_breakTime=-1.0` setup seed) IS authorable in `ac-voltage-source.ts` alone — but the per-type value switch it exists to host (PULSE/SINE/EXP/SFFM/AM) is **dead without B1**'s `cktStep`/`cktFinalTime`, and the noise arms are **dead without B2**. Authoring only the shell plus a switch that cannot read `CKTstep`/`CKTfinalTime` would either drop the order-guard defaults (forbidden zero-line/partial application, TASK.md §5) or invent substitute values (forbidden pragmatic shortcut, CLAUDE.md "No Pragmatic Patches"). Per CLAUDE.md NON-NEGOTIABLE EXECUTION STANDARDS, no partial implementation.

### Decision needed from user (resolve in order)

1. **(B1)** Add `cktStep` + `cktFinalTime` to `LoadContext` and propagate them in `ckt-load.ts` — confirm this expanded blast radius, or supply the intended accessor if one already exists that I missed.
2. **(B2)** Confirm whether `maths-misc#recon/randnumb` lands before this recon. The spec says the structural shell lands "now regardless," but the value paths cannot — sequencing matters.
3. **(B3)** Expand the recon's tsFiles to include `src/components/sources/ac-current-source.ts` and `src/solver/analog/__tests__/harness/netlist-generator.ts`, or split Parts F/G into sequenced follow-on items.

With (1)–(3) resolved, all parts of the recon become buildable as specified. No "accepted divergence" outcome (TASK.md §8).
- **Resolution:** _pending_

---

## parser#recon/nodeAllocOrder — Part B totality gate forbidden by a pre-existing out-of-scope audit

**State:** ESCALATED  •  **hunkHash:** `ddd28193a655604e`  •  **Trigger:** TASK.md §8 case 2 (mandatory acceptance gate needs an edit outside the recon's named tsFiles).

**tsFiles allowed:** `src/solver/analog/compiler.ts`, `src/solver/analog/ngspice-load-order.ts`, `src/core/registry.ts`, `src/solver/analog/__tests__/harness/netlist-generator.ts`.

### What was built (within the four named tsFiles, typechecks clean)

- **Part A** — single `deckOrder()` producer in `ngspice-load-order.ts` (`inppas2.c:76`), consumed by BOTH `buildAnalogNodeMapFromPartition` (`compiler.ts`, replacing the inline sort) and the harness deck emitter (`netlist-generator.ts`, replacing the store-reverse/emit-reverse dance). Dependency direction is strictly harness → production.
- **Part C** — `walkCompositeForNodeAllocation` now visits each sub-element's pins in `TYPE_ID_TO_DECK_PIN_LABEL_ORDER[sub.typeId]` deck-token order (D-G-S for a MOSFET sub-element), not pinLayout order; `subPinLayout` hoisted above the internal-net loop.
- **Part D** — straggler-loop citation comment (`inpsymt.c:43-72`) added; logic unchanged.
- **Part E (fold-in)** — composite Port-net identity: a `mintPort` callback threads a flattened-deck first-encounter mint (`inpsymt.c:59-63` → `cktnewn.c:37`) so a port whose only internal endpoint is a high-impedance gate keeps a distinct MNA node; `gnd`/`GND`→0 retained only for explicit ground. Recursion mints nested unresolved ports too.
- `auditDeckPinOrderCoverage` + `registry.analogTypeIds()` added and wired into `compileAnalogPartition`.

### B1 — the blocker: pre-existing `auditNgspiceLoadOrderTables` forbids the four Part B rows

Part B (spec `engine-node-alloc-order.md:183-210,306-368`, criterion 2) mandates `TYPE_ID_TO_DECK_PIN_LABEL_ORDER` be TOTAL, explicitly adding four rows: `MutualInductor: []`, `Transformer`/`TappedTransformer: [pos,neg]`, `CurrentControlledSwitch: [out+,out-]`.

The pre-existing structural audit `auditNgspiceLoadOrderTables` (`src/solver/analog/ngspice-load-order-audit.ts:34-83`) throws on exactly those rows:
- lines 59-63 reject any deck-pins row whose `DeviceFamily` is not in `DECK_EMITTING_FAMILIES` (`ngspice-load-order-audit.ts:9-27`) — `MutualInductor` is family `MUT` and `CurrentControlledSwitch` is family `CSW`, neither in that set;
- lines 64-68 reject any deck-pins row listed in `MULTI_LINE_COMPOSITES` (`ngspice-load-order-audit.ts:29-32`) — `Transformer` and `TappedTransformer` are both there.

**Verified:** adding the four rows makes `auditNgspiceLoadOrderTables` throw "ngspice-load-order audit failed". The load-order-parity / resistive-divider / mosfet-inverter parity suites now fail 5/5 at `ngspice-load-order-audit.ts:78` (every parity helper calls this audit at session init). The audit's rule set is the exact inverse of Part B.

**Architecture change required (outside the four tsFiles):** reconcile `auditNgspiceLoadOrderTables` with Part B — add `"MUT"` and `"CSW"` to `DECK_EMITTING_FAMILIES`, and either remove `Transformer`/`TappedTransformer` from `MULTI_LINE_COMPOSITES` (they now carry a per-winding `[pos,neg]` row) or teach the audit that an empty-token (`[]`) row and a sense-by-name (`[out+,out-]`) row are legal totality entries. Single out-of-scope file: `src/solver/analog/ngspice-load-order-audit.ts`.

### B2 — Part E harness gate not re-verified live this session

The collapse Part E targets WAS reproduced on `composite-mosfet-stage.dts` before the fix-build: DC-OP returned `VGS:pos = 0V`, `M1:G = 0V` (gate should read the 3V VGS drive), and a spurious `voltage-source-loop` error. The `mintPort` fix is authored against the ratified spec locus, but the circuit-simulator MCP server disconnected mid-investigation, so the STRICT bit-exact harness gate (criteria 8/10/11: `harness_first_divergence` null matrix/shape → `harness_topology_diff` IDENTICAL → `harness_matrix_diff` match, plus headless "gate reads driven 3V, no voltage-source-loop") could not be re-run. The verifier must run this gate to confirm.

### Decision needed from user

Expand the recon's tsFiles to include `src/solver/analog/ngspice-load-order-audit.ts` so the pre-existing audit can be reconciled with Part B's totality requirement. Until then Part B / criterion 2 cannot be satisfied within scope, and the four mandated deck-pin rows make the existing parity suites fail at audit init. No "accepted divergence" outcome (TASK.md §8).

- **Resolution:** _pending_

---

## vsrc (2026-06-01)

- **source:** `vsrc#recon/waveformModel`  •  **verdict:** MISMATCH (EMPTY-DIFF CATCH — builder edit did not land in the worktree; recon left PENDING)
  - **note (verbatim):** EMPTY-DIFF CATCH fired. Spec present at spec/v41-port/reconstruction/vsrc-waveformModel.md (RATIFIED 2026-05-30, REVISED 2026-05-31). But `git -C C:/local_working_projects/digital_in_browser/.wt/vsrc diff --name-only` is EMPTY and `git status --short` shows a fully clean worktree (no uncommitted changes, no recent commit touching vsrc). The builder's edit did NOT land in the worktree — the target file C:/local_working_projects/digital_in_browser/.wt/vsrc/src/components/sources/ac-voltage-source.ts is byte-identical to the pre-rebuild 'Current digiTS state' the spec documents (lines 48-91). Evidence: Grep for the rebuilt symbols (_functionType|_coeffs|FunctionType|applyCoeffs|VSRCcoeffs) returns 0 matches in the file; the OLD named-param model is still fully present — line 47 `export type Waveform = "sine"|"square"|...` string enum, line 52 `function boxMuller()`, line 101 `computeWaveformValue(` with the named-scalar signature (call site line 711 passes _amplitude/_frequency/_phase/_dcOffset), instance fields `_amplitude` (570)/`_waveform` (581), the live-Math.random() `noise` arm (line 251 `dcOffset + amplitude * boxMuller()`), and the named-param acceptStep (841+). None of Part A (instance state: FunctionType enum PULSE=1..TRRANDOM=9, _coeffs Float64Array, _functionOrder, _breakTime/-1.0 seed, _rGiven/_rBreakpt/_rdelay, _trnoiseState/_trrandomState), Part B (per-type value switch from _coeffs[]), Part C (applyCoeffs/copy_coeffs), Part D (acceptStep re-root on _breakTime+_coeffs), Part E (boxMuller removal — acceptance #4), Part F (ac-current-source consumption), or Part G (netlist-generator emitter) landed. GATE (server_restart + harness on vsrc-ac-square-rload.dts / vsrc-ac-sine-rload.dts) NOT run: there is no built rebuild to gate and no source isomorphism to the vsrcload.c/vsrcpar.c/vsrcacct.c/vsrcset.c/vsrcdefs.h baseline. Recon left PENDING. Re-apply rooted at C:/local_working_projects/digital_in_browser/.wt/vsrc/src/components/sources/ac-voltage-source.ts (the builder likely edited a different checkout or the edit was lost).

- **source:** `vsrc#recon/waveformModel`  •  **verdict:** MISMATCH (teardown-side durable record; builder ESCALATED rather than building — recon left PENDING/ESCALATED)
  - **note (verbatim):** EMPTY-DIFF CATCH fired. `git -C C:/local_working_projects/digital_in_browser/.wt/vsrc diff --name-only` is EMPTY (also empty for --cached); worktree `git status --porcelain` is clean; latest commit is 8b7c6a02 'v41-port(vsrc): record 1 escalation(s)' (not an APPLIED recon). None of the recon's tsFiles [src/components/sources/ac-voltage-source.ts, src/solver/analog/load-context.ts, src/solver/analog/analog-engine.ts, src/components/sources/ac-current-source.ts, src/solver/analog/__tests__/harness/netlist-generator.ts] carry any edit in the worktree. The MAIN checkout (C:/local_working_projects/digital_in_browser) `git status --porcelain` for those same files is also clean, so the edit did NOT land in the wrong tree by mistake — it was never applied at all. The builder ESCALATED instead of building: progress.json has "vsrc#recon/waveformModel": state=ESCALATED, attempts=0, with three recorded blockers — B1: spec Part A claims ckt->CKTstep/CKTfinalTime are 'already on LoadContext' but LoadContext has neither (only ctx.dt=CKTdelta), so cktStep/cktFinalTime must be ADDED to load-context.ts + populated in the engine builder (the non-noise PULSE/EXP/SINE default guards depend on these); B2: maths-misc#recon/randnumb deterministic RNG (trnoise_state/trrandom_state/CombLCGTaus/f_alpha) is required for the TRNOISE/TRRANDOM arms and the noise arms are blocked until it lands; B3: ac-current-source.ts + netlist-generator.ts were outside the originally-recorded single-tsFile scope. SPEC-PRESENCE gate PASSES — the spec exists at spec/v41-port/reconstruction/vsrc-waveformModel.md (RATIFIED 2026-05-30; REVISED 2026-05-31 'precondition fix, pending re-review' which expands tsFiles to the full five-file set, superseding B3's scope concern, and corrects Part A to ADD cktStep/cktFinalTime rather than claim they pre-exist, confirming B1's substance). I did NOT run the harness GATE (no source change exists to gate) and did NOT flip progress.json to APPLIED. Recon left PENDING/ESCALATED. Builder must re-apply, rooted at C:/local_working_projects/digital_in_browser/.wt/vsrc, against the REVISED spec (which already resolves B1's precondition framing and B3's tsFiles scope); the TRNOISE/TRRANDOM value+coeff+accept arms remain genuinely blocked on maths-misc#recon/randnumb per the spec's own cross-recon dependency (note: a prior commit e98ab61/ae98ad61 shows maths-misc#recon/randnumb APPLIED on this branch, so B2 may now be unblockable — builder should re-check before re-escalating).

## analysis (2026-06-02)

- **source:** `analysis/analysis/acan.c::Modified 2001: AlansFixes`  •  **verdict:** ESCALATE
  - **note (verbatim):** acan.c#h001 (analysis.md:103-113; ref/ngspice/.../acan.c) adds XSPICE event includes (+#include evt.h/enh.h inside #ifdef XSPICE) plus a comment reindent. digiTS has no XSPICE/event subsystem and no C include layer; ACan is reimplemented as AcAnalysis.run, not transcribed. Pre-image case (c) absent. Legitimate Trigger-1 escalation; confirmed. Not APPLIED, nothing committed.

- **source:** `analysis/analysis/acan.c::do { \`  •  **verdict:** ESCALATE
  - **note (verbatim):** acan.c#h002 (analysis.md:114-125) is pure C pointer-style cosmetics (ACan(CKTcircuit *ckt) -> CKTcircuit* ckt; ACAN *job=(ACAN *) -> ACAN* job=(ACAN*)) on a function digiTS reimplements as AcAnalysis.run rather than transcribing. No transcription counterpart for the *-spacing delta. Legitimate reimplemented-driver-layer escalation; confirmed. Not APPLIED.

- **source:** `analysis/analysis/acan.c::CKTacLoad(CKTcircuit *ckt)`  •  **verdict:** ESCALATE
  - **note (verbatim):** acan.c#h011 (analysis.md:678-686), CKTacLoad. digiTS reimplements AC load via per-element stampAc, not a transcribed CKTacLoad. No case-(a) pre-image (case b/c). Target file ac-analysis.ts shows no change for this hunk. Legitimate reimplemented-driver-layer escalation; confirmed. Not APPLIED.

- **source:** `analysis/analysis/cktdojob.c::CKTdoJob(CKTcircuit *ckt, int reset, TSKtask *task)`  •  **verdict:** ESCALATE
  - **note (verbatim):** cktdojob.c#h003/#h004/#h005 -> ckt-context.ts::CKTCircuitContext. digiTS has no CKTdoJob method and no TSKtask struct; the task-config (CKTindverbosity/CKTepsmin) is reimplemented as fields on CKTCircuitContext read from ResolvedSimulationParams. Target file ckt-context.ts shows no change. Pre-image case (b)/(c) -- either already-v41 (ledger-sync, kind 1) or no-counterpart (kind 2). Legitimate; user decision per the unit-wide note. Confirmed; not APPLIED.

- **source:** `analysis/analysis/cktic.c::CKTic(CKTcircuit *ckt)`  •  **verdict:** ESCALATE
  - **note (verbatim):** cktic.c#h001/#h002 (analysis.md:1596-1612; ref/ngspice/cktic.c:28-36) change CKTrhs[n]=v to CKTrhsOld[n]=CKTrhs[n]=v (six-buffer dual-write). digiTS cktLoad seeds nodeset/IC via a large-conductance stamp, not a CKTrhs/CKTrhsOld ping-pong -- the same buffer-model architecture gap already open as ESC-002. Case-(b)/(c) pre-image; the dual-write target structure is absent. ckt-load.ts shows no change. Legitimate Trigger-1/cross-group escalation; confirmed. Not APPLIED.

- **source:** `analysis/analysis/cktncdump.c::CKTncDump(`  •  **verdict:** ESCALATE
  - **note (verbatim):** cktncdump.c#h001 (analysis.md:1669-1677; ref/ngspice/cktncdump.c:24) swaps the node-name filter !strstr(name,"#") -> !strchr(name,'#') on an fprintf-based DC-OP non-convergence debug dump. C-string-API swap on a front-end debug print (the no-counterpart family). dc-operating-point.ts::cktncDump shows no change. Legitimate; confirmed. Not APPLIED.

- **source:** `analysis/analysis/cktntask.c::CKTnewTask(CKTcircuit *ckt, TSKtask **taskPtr, IFuid taskName, TSKtask **defPtr)`  •  **verdict:** ESCALATE
  - **note (verbatim):** cktntask.c#h001-#h006 -> ckt-context.ts::CKTCircuitContext. digiTS has no CKTnewTask/TSKtask; task allocation+defaults are reimplemented in the CKTCircuitContext constructor reading ResolvedSimulationParams. The new TSKxmu/TSKindverbosity/TSKepsmin/TSKcshunt fields are either pre-applied as TS fields (kind 1) or absent (kind 2). ckt-context.ts shows no change. Legitimate; user decision. Confirmed; not APPLIED.

- **source:** `analysis/analysis/cktop.c::Modified: 2005 Paolo Nenzi - Restructured`  •  **verdict:** ESCALATE
  - **note (verbatim):** cktop.c#h001 -> dc-operating-point.ts::solveDcOperatingPoint. Includes OPtran integration in CKTop, which digiTS has no counterpart for. CKTop is reimplemented as solveDcOperatingPoint; no case-(a) pre-image. dc-operating-point.ts shows no change. Legitimate; confirmed. Not APPLIED.

- **source:** `analysis/analysis/cktop.c::CKTop (CKTcircuit * ckt, long int firstmode, long int continuemode,`  •  **verdict:** ESCALATE
  - **note (verbatim):** cktop.c#h002 -> solveDcOperatingPoint. Reimplemented driver; the substantive gmin/src control-flow content is already-v41 in dc-operating-point.ts (escalation note kind 1: ledger-sync) so re-applying would double-apply. Case-(b) pre-image. No change in dc-operating-point.ts. Legitimate; confirmed. Not APPLIED.

- **source:** `analysis/analysis/cktop.c::CKTconvTest (CKTcircuit * ckt)`  •  **verdict:** ESCALATE
  - **note (verbatim):** cktop.c#h003 -> solveDcOperatingPoint. CKTconvTest reimplemented inline in the digiTS NR/DC-OP path; no standalone transcribed function, no case-(a) pre-image. No change in dc-operating-point.ts. Legitimate; confirmed. Not APPLIED.

- **source:** `analysis/analysis/cktop.c::dynamic_gmin (CKTcircuit * ckt, long int firstmode,`  •  **verdict:** ESCALATE
  - **note (verbatim):** cktop.c#h004/#h005/#h006 -> solveDcOperatingPoint. dynamic_gmin reimplemented as dynamicGmin; substantive content (MAX(sqrt(factor),1.00005) etc.) already-v41 (kind 1 ledger-sync). Case-(b) pre-image; re-applying double-applies. No change in dc-operating-point.ts. Legitimate; confirmed. Not APPLIED.

- **source:** `analysis/analysis/cktop.c::spice3_gmin (CKTcircuit * ckt, long int firstmode,`  •  **verdict:** ESCALATE
  - **note (verbatim):** cktop.c#h007 -> solveDcOperatingPoint. spice3_gmin reimplemented; no case-(a) pre-image (kind 1/2). No change in dc-operating-point.ts. Legitimate; confirmed. Not APPLIED.

- **source:** `analysis/analysis/cktop.c::gillespie_src (CKTcircuit * ckt, long int firstmode,`  •  **verdict:** ESCALATE
  - **note (verbatim):** cktop.c#h008/#h009/#h010 -> solveDcOperatingPoint. gillespie_src reimplemented; gminstart capture/restore already-v41 (kind 1 ledger-sync). Case-(b) pre-image. No change in dc-operating-point.ts. Legitimate; confirmed. Not APPLIED.

- **source:** `analysis/analysis/cktsetbk.c::CKTsetBreak(CKTcircuit *ckt, double time)`  •  **verdict:** ESCALATE
  - **note (verbatim):** cktsetbk.c#h001/#h002 -> timestep.ts::TimestepController. CKTsetBreak reimplemented as TimestepController.addBreakpoint; the AlmostEqualUlps(time,CKTtime,3) guard is already-v41 in timestep.ts (kind 1 ledger-sync). Case-(b) pre-image; re-applying double-applies. timestep.ts shows no change. Legitimate; confirmed. Not APPLIED.

- **source:** `analysis/analysis/cktsetup.c::CKTsetup(CKTcircuit *ckt)`  •  **verdict:** ESCALATE
  - **note (verbatim):** cktsetup.c#h002/#h003/#h004 -> compiler.ts::expandCompositeInstance. CKTsetup reimplemented as MNAEngine._setup/expandCompositeInstance; the prev_CKTlastNode/!CKThead/!DEVices guards and CKTsizeIncr have no digiTS counterpart (case c). compiler.ts shows no change. Legitimate; confirmed. Not APPLIED.

- **source:** `analysis/analysis/cktsetup.c::CKTunsetup(CKTcircuit *ckt)`  •  **verdict:** ESCALATE
  - **note (verbatim):** cktsetup.c#h005/#h006 -> compiler.ts. CKTunsetup is matrix-node teardown; digiTS rebuilds a fresh engine per compile() and has no unsetup/teardown surface (same architectural reason JFETunsetup escalated, ESC-JFET-UNSETUP). Target absent (case c). compiler.ts shows no change. Legitimate; confirmed. Not APPLIED.

- **source:** `analysis/analysis/cktsopt.c::CKTsetOpt(CKTcircuit *ckt, JOB *anal, int opt, IFvalue *val)`  •  **verdict:** ESCALATE
  - **note (verbatim):** cktsopt.c#h002/#h003 -> ckt-context.ts::CKTCircuitContext. digiTS has no CKTsetOpt method nor an integer-indexed option setter; options are typed fields read from ResolvedSimulationParams. No case-(a) pre-image. ckt-context.ts shows no change. Legitimate; confirmed. Not APPLIED.

- **source:** `analysis/analysis/cktsopt.c::static IFparm OPTtbl[] = {`  •  **verdict:** ESCALATE
  - **note (verbatim):** cktsopt.c#h004-#h008 -> ckt-context.ts. OPTtbl[] is the C option-index IFparm table (OPT_GMIN..OPT_CSHUNT); digiTS has no option-index table (it uses named typed config). The added cshunt/epsmin rows are either pre-applied fields (kind 1) or absent (kind 2). ckt-context.ts shows no change. Legitimate; confirmed. Not APPLIED.

- **source:** `analysis/analysis/ckttrunc.c::CKTtrunc(CKTcircuit *ckt, double *timeStep)`  •  **verdict:** ESCALATE
  - **note (verbatim):** ckttrunc.c#h001 -> ckt-terr.ts. CKTtrunc reimplemented as cktTerr/cktTerrVoltage; no transcribed CKTtrunc loop, no case-(a) pre-image. ckt-terr.ts shows no change. Legitimate; confirmed. Not APPLIED.

- **source:** `analysis/analysis/dcop.c::DCop(CKTcircuit *ckt, int notused)`  •  **verdict:** ESCALATE
  - **note (verbatim):** dcop.c#h001 -> dc-operating-point.ts::solveDcOperatingPoint. DCop reimplemented; firstmode=(CKTmode&MODEUIC)|MODEDCOP|MODEINITJCT logic present but not a transcribed DCop function (case b). dc-operating-point.ts shows no change. Legitimate; confirmed. Not APPLIED.

- **source:** `analysis/analysis/dctran.c::extern struct dbcomm *dbs;`  •  **verdict:** ESCALATE
  - **note (verbatim):** dctran.c#h001/#h002 -> analog-engine.ts::MNAEngine.stepToTime. File-level C externs/debugger globals (dbcomm *dbs) with no digiTS counterpart (case c). analog-engine.ts shows no change. Legitimate; confirmed. Not APPLIED.

- **source:** `analysis/analysis/dctran.c::DCtran(CKTcircuit *ckt,`  •  **verdict:** ESCALATE
  - **note (verbatim):** dctran.c#h003-#h010 -> analog-engine.ts::MNAEngine.stepToTime. DCtran reimplemented as MNAEngine.stepToTime; the breakpoint-pop while-loop + autostop predicate are already-v41 in timestep.ts:556-578 (kind 1 ledger-sync), the CKTmaxStep/(finalTime-initTime)/50 + nostepsizelimit derivation has no counterpart (digiTS takes params.maxTimeStep, kind 2). Case-(b)/(c). analog-engine.ts shows no change. Legitimate; confirmed. Not APPLIED.

- **source:** `analysis/analysis/dctran.c::resume:`  •  **verdict:** ESCALATE
  - **note (verbatim):** dctran.c#h011-#h014 -> analog-engine.ts::MNAEngine.stepToTime. The C 'resume:' goto-label transient-resume block is reimplemented as MNAEngine.stepToTime control flow; no goto/label counterpart (case c). analog-engine.ts shows no change. Legitimate; confirmed. Not APPLIED.

- **source:** `analysis/analysis/tfanal.c::TFanal(CKTcircuit *ckt, int restart)`  •  **verdict:** ESCALATE
  - **note (verbatim):** tfanal.c#h001/#h002 -> dc-operating-point.ts .tf driver. Sequencing-blocked on reconstruction item analysis#recon/tf (PENDING, specExists:false) per ESC-001: no .tf driver exists in digiTS, and the 2 GENnode accessor-rename hunks are only applicable once the driver exists. Legitimate blocked/sequencing escalation; confirmed. Not APPLIED, left untouched.

- **source:** `analysis/analysis/traninit.c::Modified: 2000 AlansFixes`  •  **verdict:** ESCALATE
  - **note (verbatim):** traninit.c#h001 -> analog-engine.ts::MNAEngine.init. File-header/include-region hunk on TRANinit, which digiTS reimplements as MNAEngine.init; no transcribed counterpart, no case-(a) pre-image. analog-engine.ts shows no change. Legitimate; confirmed. Not APPLIED.

- **source:** `analysis/analysis/traninit.c::int TRANinit(CKTcircuit	*ckt, JOB *anal)`  •  **verdict:** ESCALATE
  - **note (verbatim):** traninit.c#h002 -> analog-engine.ts::MNAEngine.init. TRANinit reimplemented as MNAEngine.init reading typed params (not a JOB/TSKtask); no case-(a) pre-image. analog-engine.ts shows no change. Legitimate; confirmed. Not APPLIED.

- **source:** `analysis/analysis/transetp.c::TRANsetParm(CKTcircuit *ckt, JOB *anal, int which, IFvalue *value)`  •  **verdict:** ESCALATE
  - **note (verbatim):** transetp.c#h001 -> analog-engine.ts::MNAEngine.init. digiTS has no TRANsetParm method; transient params are typed and validated at the facade (escalation kind 2). NOTE: this is the TRAN twin of acsetp.c (group 5) -- but unlike group 5, the applier did NOT write a counterpart edit into analog-engine.ts (analog-engine.ts shows no change), so the no-counterpart claim holds here. Legitimate; confirmed. Not APPLIED.

- **source:** `analysis/analysis/acan.c::ACan(CKTcircuit *ckt, int restart)`  •  **verdict:** ESCALATE
  - **note (verbatim):** tsFile src/solver/analog/ac-analysis.ts carries NO edit in the worktree (git diff --name-only = {spec/v41-port/ESCALATIONS.md, progress.json} only; not staged either). The applier deliberately ESCALATED (progress.json: all of h003-h010 state=ESCALATED, attempts=0, reason=pre-image-absent) rather than misrouting an edit — internally consistent, not the EMPTY-DIFF-CATCH misapply case. The earlier stray uncommitted fStart/fStop<0.0 throws (which a prior verifier review bounced groups 3/5 over) have been WITHDRAWN: run() (ac-analysis.ts:245-348) has no such throw and buildFrequencyArray (567-612) has no startfreq guard. Independent pre-image check vs ref/ngspice/src/spicelib/analysis/acan.c:44-395: ACan is the AC driver (INIT/UPDATE_STATS, XSPICE evt.h/enh.h/IPC, CKTop/CKTncDump/OUTpBeginPlot/fprintf/runDesc, freqDelta switch 84-112, sweep loop), reimplemented as AcAnalysis.run + buildFrequencyArray. Only behavioral counterpart is the DEC freqDelta, and buildFrequencyArray:589-590 already carries the v41 form numSteps=floor(|log10(stop/start)|*n); freqDelta=exp(log(stop/start)/numSteps) (= acan.c:89-90), NOT the v26 exp(log(10.0)/numberSteps) — so the v26 - line is absent (case c / already-v41). startfreq<=0 E_PARMVAL guards (acan.c:85-88,94-97) + fprintf(stderr,'ERROR: AC startfreq <= 0') have no TS image. h003,h005-h010 are XSPICE/IPC/OUTpBeginPlot/fprintf/runDesc + C star-spacing/brace/comment cosmetics over absent constructs. No case-(a) pre-image in any of h003-h010. Escalation reason sound; surfaced kind1-ledger-sync vs kind2-NO-COUNTERPART/sequenced-port decision is a user/planning action the applier cannot self-assign. Left PENDING/ESCALATED; nothing committed. Appended scoped verifier confirmation to spec/v41-port/ESCALATIONS.md.

- **source:** `analysis/analysis/acsetp.c::ACsetParm(CKTcircuit *ckt, JOB *anal, int which, IFvalue *value)`  •  **verdict:** ESCALATE
  - **note (verbatim):** tsFile src/solver/analog/ac-analysis.ts carries NO edit in the worktree; applier ESCALATED both hunks (progress.json: acsetp.c#h001 hash b0ef899ebf4d7700, #h002 hash 510d9e50acfb748a, both state=ESCALATED attempts=0 reason=pre-image-absent) — consistent escalation, not a misrouted edit. Independent pre-image check vs ref/ngspice/src/spicelib/analysis/acsetp.c:16-82: ACsetParm is a switch(which) IFparm setter on the ACAN job struct (AC_START/AC_STOP validate value->rValue<0.0, set errMsg=copy(...), return E_PARMVAL). digiTS AcAnalysis.run takes a typed AcParams object: there is no ACsetParm method, no ACAN struct, no switch(which) dispatch, no errMsg/E_PARMVAL — the param validation lives at the facade/netlist layer. The v26 - lines (if value->rValue <= 0.0 { errMsg=copy('Frequency of 0 is invalid for AC start/stop') }) have no case-(a) pre-image in this file -> case (c). The earlier stray fStart/fStop<0.0 throws a prior verifier flagged here have been withdrawn (run() lines 245-348 contain none). Escalation substantively correct: digiTS reimplements the ACsetParm driver rather than transcribing it; the kind1/kind2 classification decision is a user/planning action. Left PENDING/ESCALATED; nothing committed. Scoped verifier confirmation appended to spec/v41-port/ESCALATIONS.md.

## maths-misc (2026-06-02)

- **source:** `maths-misc/maths-misc/randnumb.c::unsigned int CombLCGTausInt2(void)`  •  **verdict:** ESCALATE
  - **note (verbatim):** hunk h004, tsFile src/solver/analog/monte-carlo.ts::SeededRng. The landed reconstruction (commit ae98ad61, recon maths-misc#recon/randnumb=APPLIED) ports the REAL generator CombLCGTausInt (ref/ngspice/src/maths/misc/randnumb.c:154-162) as SeededRng.combLCGTausInt (monte-carlo.ts:334-340), bijectively. The functionGroup names CombLCGTausInt2 (randnumb.c:179-190), the INLINED TEST-DUPLICATE of CombLCGTausInt (arithmetically identical). The applier deliberately did NOT port the test-duplicate, and hunk h004 is ABSENT from progress.json entirely. Marking h004 APPLIED is impossible: the named fn has no separate counterpart by design (same arithmetic as combLCGTausInt), and declaring it NO-COUNTERPART is a kind2 planning classification an agent cannot self-assign. The real generator is bijectively present and test-gated, so this is a contract/recon hunk-assignment conflict, not a numerical defect. Appended to ESCALATIONS.md. committed=null.

- **source:** `maths-misc/maths-misc/randnumb.c::double gauss0(void)`  •  **verdict:** ESCALATE
  - **note (verbatim):** hunks h005 (hash cb2f7535be54a450), h006 (hash 579d53a6c1f1d862), h007; tsFile src/solver/analog/monte-carlo.ts::SeededRng.gaussian. Tier-2 independent re-derivation vs ref/ngspice/src/maths/misc/randnumb.c: SeededRng.gauss0 (monte-carlo.ts:356-372) is BIJECTIVE with gauss0 (randnumb.c:195-215) - polar Marsaglia loop, fac=sqrt(-2*log(r)/r), glgset=v1*fac, gliset=false, return v2*fac, else returns cached glgset; gauss1 (376-385)=rn:220-231 and rgauss (389-398)=rn:240-254 also bijective. The CODE matches. BUT the per-hunk ledger contradicts the contract's APPLIED action: h005/h006 are state=ESCALATED under the applier's open ESC-014 (pre-image-absent: recon delivered v41 post-image directly), and h007 is ABSENT from progress.json. Flipping them APPLIED would silently override the open ESC-014 and the superseding recon maths-misc#recon/randnumb (already APPLIED). The recon-supersedes-hunk reconciliation (kind1 ledger-sync vs kind2) is a user/planning action. Cannot self-mark APPLIED. Appended to ESCALATIONS.md. committed=null.

- **source:** `maths-misc/maths-misc/randnumb.c::int poisson(double lambda)`  •  **verdict:** 3-ROUNDS-EXHAUSTED
  - **note (verbatim):** hunk maths-misc/randnumb.c#h008 (hash 6780580bcd30da31), CONTRACT tsFile src/components/sources/ac-voltage-source.ts (mapping: ::boxMuller / exprand+com_sseed). EMPTY-DIFF CATCH fires: `git -C ...maths-misc diff --name-only` = {.vitest-failures.json, spec/v41-port/ESCALATIONS.md, spec/v41-port/progress.json} only — ac-voltage-source.ts carries NO edit in the worktree (git status --porcelain on that path is empty). The contract's named tsFile is untouched. ac-voltage-source.ts contains ONLY boxMuller() (Math.random()-based cosine-form Gaussian, lines 52-56); no poisson / exprand / com_sseed counterpart exists there (mapping note itself: 'no current behavioral counterpart - see Q2'). The applier instead landed poisson on src/solver/analog/monte-carlo.ts::SeededRng.poisson (monte-carlo.ts:413-427), which I independently confirm is bijective with poisson (ref/ngspice/src/maths/misc/randnumb.c:260-274): max_k=1000, p=CombLCGTaus(), P=exp(-lambda), sum=P, if sum>=p return 0, for k=1..max_k P*=lambda/k, sum+=P, if sum>=p break, return k. So the function is numerically correct, but it landed under the separate maths-misc#recon/randnumb reconstruction item (APPLIED) on a DIFFERENT file than the contract's named tsFile — the contract's functionGroup is NOT applied at its mapping target. h008 is also state=ESCALATED under ESC-014 in progress.json (applier trigger: 'pre-image failure case c, absent — reconstruction delivered v41 post-image directly; exprand checkseed() removal already done by recon; com_sseed/setseedinfo are frontend NO-COUNTERPART'). Per the EMPTY-DIFF CATCH this is a MISMATCH for the named tsFile: the ac-voltage-source.ts mapping (boxMuller/exprand+com_sseed) did not land; re-apply rooted at the contract's tsFile or correct the contract mapping. Left PENDING/ESCALATED; nothing committed. No file-scope violation: the only worktree changes are progress.json, ESCALATIONS.md, and the test-runner artifact .vitest-failures.json. A prior verifier recorded the identical MISMATCH verdict at ESCALATIONS.md:518-519; this independent re-derivation confirms it.
