# digiTS analog solver — Phase 3–10 Plan (post-A1)

**Date:** 2026-04-24
**Precondition:** Phase 2.5 complete at commit `438de273` (tracker hygiene) / `653340ac` (W4 closure).
**Status:** W5 deliverable. Authored against the post-A1 codebase landed by Phase 2.5.
**Input doc:** `spec/architectural-alignment.md` (Track A canonical rulings).

**Absorbed and deleted in the 2026-04-24 cleanup (git history preserves):** `plan.md`, `plan-addendum.md` (task classification bridge), `post-a1-parity.md` (Phase 2.5 W3 findings — all closed or carried forward into this plan), `phase-2.5-execution.md` (Phase 2.5 wave-level execution record — all waves ✓), `ngspice-alignment-F*.md` per-phase specs (absorbed into each Phase section below), plus forensic/reconciliation artefacts.

---

## Reader's orientation

This plan re-authors the surviving 77 tasks from `plan.md` Phases 3–9 (22 CARRY + 37 REWRITE-POST-A1 + 18 PAUSE-UNTIL-A1 per `plan-addendum.md`) against the current post-A1 code surface. Every REWRITE task has been re-expressed against:

- The unified `load(ctx: LoadContext): void` method per device (no `_updateOp` / `_stampCompanion` split)
- `ctx.cktMode` bitfield with `MODE*` constants (no `InitMode` string, no `ctx.initMode` / `ctx.isDcOp` / `ctx.isTransient` / `loadCtx.iteration`)
- Deleted state slots (SLOT_CAP_GEQ_*, SLOT_IEQ_*, SLOT_Q_*, L1_SLOT_*) — gone; the values are locals inside `load()`

**Before executing any phase, read:**

1. This file — the phase you're executing plus §"Governing principles"
2. `spec/architectural-alignment.md` — Track A canonical rulings
3. `spec/post-a1-parity.md` — W3 findings (closed in Phase 2.5 W4; here for reference only)
4. The cited ngspice source file(s) at the line ranges listed in each task
5. `CLAUDE.md` — banned closing verdicts (*mapping*, *tolerance*, *close enough*, *equivalent to*, *pre-existing*, *intentional divergence*, *citation divergence*, *partial*)

---

## Governing principles (non-negotiable — inherited from plan.md + Phase 2.5)

1. **Match ngspice, or the job has failed.** Every cited ngspice function is the authority. Implementers port verbatim.
2. **No substitutions.** No "pragmatic," "minimal," "smallest viable," "simpler version" of any diff. Spec says X, implementer writes X.
3. **No silent scope narrowing.** If a diff cannot be applied (surrounding code has drifted post-Phase-2.5, assumption violated), STOP and report. Do not improvise, do not skip.
4. **Banned concepts** (CLAUDE.md): deferral, scope reduction, pragmatic shortcuts, test-chasing fixes, silent scope narrowing.
5. **Regression policy.** If approved work lands and tests regress: do not revert. Report with full output.
6. **Tests-red protocol.** Full-suite test passage is not a phase gate until Phase 9.1.3. Implementers run targeted vitest scoped to their modified files.
7. **Zero allocations in hot paths.** No `new`, no object literals, no closures, no allocating array methods inside NR iterations, per-step code, or per-device `load()`.
8. **ngspice comparison harness is the primary tool for numerical issues.** Do not theorize about per-iteration divergence — run the harness (`docs/ngspice-harness-howto.md`), find the exact iteration where values split.
9. **No self-correction for convergence.** If a ported device fails to converge against ngspice, surface and stop. End-of-phase review is user-driven.
10. **Citation audit.** Every `// cite: xxxload.c:NNN` comment must describe the code that immediately follows. Decorative citations are forbidden (see Phase 2.5 W1.8c precedent — commit `8b298ca9` rejected for this reason).

---

## Goals

- Every `plan-addendum.md` task with verdict CARRY-AS-IS or REWRITE-POST-A1 landed on `main` against the current `load(ctx)` architecture.
- Every PAUSE-UNTIL-A1 task unpaused and executed against the unified `load()`.
- Per-device `load()` bit-aligned to its ngspice counterpart (`dioload.c`, `bjtload.c`, `mos1load.c`, `jfetload.c`) — covering MODEINITJCT / MODEINITPRED / MODEINITFIX / MODEINITTRAN / MODEINITSMSIG state machine, xfact predictor extrapolation, NOBYPASS bypass tests, limiting primitives with Gillespie negative-bias branch.
- `spec/ngspice-citation-audit.md` delivered as the durable citation table.
- D-8 MOSFET `cgs_cgd_transient` regression closed via the Phase 10 acceptance harness.
- 8-circuit ngspice parity acceptance complete (Phase 10): IEEE-754 bit-exact per-NR-iteration `rhsOld[]` for every circuit.

## Non-Goals

- MOS2/3/6/9, BSIM, HSPICE extensions. F-MOS scopes to MOS1 Shichman-Hodges.
- CKTsenInfo sensitivity, noise (mos1noi.c, bjtnoi.c), distortion, BSIM thermal extensions.
- Behavioral-digital element rewrite (E2 APPROVED ACCEPT per `architectural-alignment.md`).
- Harness architecture rewrite beyond `device-mappings.ts` slot sync (already done in Phase 2.5 W1.9).
- F4c device parity against ngspice — F4c APPROVED ACCEPT means self-compare only.
- Sparse-solver algorithm rewrites beyond what Phase 1 (DONE) already landed.

## Verification

- **Phase 0 done:** Full plan-addendum 9.1.1 expanded identifier grep returns zero hits outside `ref/ngspice/` and `spec/`. Coupled-inductor dead code (`CoupledInductorState`, `createState`) removed if still present.
- **Phase 3 done:** F2 targeted tests run against `newton-raphson`, `analog-engine`, `diode`, `bjt`; xfact predictor formula present in diode + BJT (L0 and L1) `load()`; forceReorder() gated at NR loop top per `niiter.c:856-859`.
- **Phase 4 done:** F5 residual fixes landed — `fetlim` `vtstlo` coefficient matches `devsup.c:102`; LED initJct skip + collector push present; BJT L1 substrate pnjlim call verified.
- **Phase 5 done:** F-BJT targeted tests run; BJT L0 and L1 `load()` mirror `bjtload.c` sections including NOBYPASS bypass, MODEINITJCT 3-branch priming, MODEINITSMSIG return, MODEINITTRAN state seeding, excess-phase `cex` uses raw `opIf`.
- **Phase 6 done:** F-MOS targeted tests run; MOSFET `load()` mirrors `mos1load.c` including M-1 xfact predictor, Meyer averaging, IC params, NOBYPASS bypass, `CKTfixLimit` gate on reverse `limvds`, per-instance `vt` in bulk-diode paths, MODEINITFIX+OFF branch.
- **Phase 7 done:** F5ext targeted tests run; NJFET `load()` mirrors `jfetload.c` with full state schema (VGS/VGD/CG/CD/GGS/GGD/QGS/QGD, no cross-method CAP transfer slots), Shockley gate-drain diode, Sydney drain current, 16 Y-matrix + 3 RHS stamps; PJFET delegates to polarity-aware base.
- **Phase 8 done:** `spec/ngspice-citation-audit.md` exists; priority-list citations in `dc-operating-point.ts`, `newton-raphson.ts`, `analog-types.ts` verified against ngspice source.
- **Phase 9 done:** Repo-wide grep for every removed identifier returns zero hits outside `ref/ngspice/` and `spec/`; full suite `npm test` runs.
- **Phase 10 done:** Each of the 8 acceptance circuits produces IEEE-754 bit-identical per-NR-iteration `rhsOld[]` vs ngspice. D-8 MOSFET `cgs_cgd_transient` closed (via MOSFET inverter circuit's acceptance evidence).

## Dependency Graph

```
Phase 0 (Residual Dead Code Audit)              ─── runs first, alone
  │
Phase 3 (F2 — NR reorder + xfact: diode + BJT)  ─── after 0
  │
Phase 4 (F5 — Residual limiting fixes)          ─── after 3
  │
  ├──→ Phase 5 (F-BJT L0 + L1)      ─── parallel after 4 ──┐
  ├──→ Phase 6 (F-MOS MOS1)         ─── parallel after 4    │
  └──→ Phase 7 (F5ext-JFET)         ─── parallel after 4 ───┘
  │
Phase 8 (F6 — docs & citation audit)            ─── after 5 + 6 + 7
  │
Phase 9 (Legacy reference review + full suite)  ─── after 8
  │
Phase 10 (8-Circuit bit-exact ngspice parity)   ─── after 9
```

**Serialization rationale:**

- **0 first** — clean tree before any phase agent reads context. Phase 2.5 already scrubbed most of the identifier list; Phase 0 is the belt-and-braces verification.
- **3 before 4** — Phase 3 lands xfact in diode + BJT `load()`; Phase 4's BJT substrate audit reads those xfact branches.
- **4 before 5/6/7** — Phase 4 delivers the last shared limiting primitive fixes (`fetlim` coefficient) that BJT / MOSFET / JFET all call.
- **5/6/7 parallel** — disjoint device files (`bjt.ts` | `mosfet.ts` | `njfet.ts` + `pjfet.ts`). All post-A1 `load()` edits; no cross-device shared state.
- **8 after 5/6/7** — citation text must reflect final state of the code. Running earlier risks stale line-number citations.
- **9 after 8** — full-suite run is meaningful only after all phases' code changes land.
- **10 after 9** — acceptance harness runs against a stable, full-suite-passing tree. Bit-exact comparison against ngspice requires every upstream fix in place; the user has flagged that running acceptance while engine bugs remain produces misleading failures. Phase 10 is gated behind a clean Phase 9.

---

## Phase 0: Residual Dead Code Audit
**Depends on:** (none — runs first)

Verify Phase 2.5's dead-code removal is complete. Delete any residue. This will not break the build (Phase 2.5 already removed the bulk); Phase 0 is the audit pass.

### Wave 0.1: Expanded identifier grep

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 0.1.1 | Grep repo-wide for every identifier in `plan-addendum.md` §9.1.1 expanded list. Delete any production hit. Expected zero hits — report per-identifier status. Identifiers: `PIVOT_THRESHOLD`, `PIVOT_ABS_THRESHOLD`, `_firsttime`, `firstNrForThisStep`, `"transient"` initMode sentinel, `statePool.analysisMode`, `loadCtx.iteration`, `InitMode` type, `ctx.initMode`, `ctx.isDcOp` (field), `ctx.isTransient` (field), `ctx.isTransientDcop`, `ctx.isAc` (field), `pool.uic`, `poolBackedElements`, `refreshElementRefs`, `_updateOp`, `_stampCompanion`, `SLOT_GD_JUNCTION`, `SLOT_ID_JUNCTION`, `SLOT_CAP_GEQ`, `SLOT_CAP_IEQ`, `L1_SLOT_CAP_GEQ_BE`, `L1_SLOT_CAP_GEQ_BC_INT`, `L1_SLOT_CAP_GEQ_BC_EXT`, `L1_SLOT_CAP_GEQ_CS`, `L1_SLOT_IEQ_BE`, `L1_SLOT_IEQ_BC_INT`, `L1_SLOT_IEQ_BC_EXT`, `SLOT_CAP_GEQ_GS`, `SLOT_CAP_GEQ_GD`, `SLOT_CAP_GEQ_DB`, `SLOT_CAP_GEQ_SB`, `SLOT_CAP_GEQ_GB`, `SLOT_IEQ_GS`, `SLOT_IEQ_GD`, `SLOT_IEQ_DB`, `SLOT_IEQ_SB`, `SLOT_IEQ_GB`, `SLOT_Q_GS`, `SLOT_Q_GD`, `SLOT_Q_GB`, `SLOT_Q_DB`, `SLOT_Q_SB`, JFET `SLOT_CAP_GEQ_GS`/`_GD`/`SLOT_IEQ_GS`/`_GD`, `TUNNEL_DIODE_MAPPING`, `VARACTOR_MAPPING`, `derivedNgspiceSlots`, `VSB` (MOSFET old sign convention), `VBD` (MOSFET old sign convention — distinguish from `VBD` that survives in post-A1 code), `Math.exp(700)`, `Math.min(..., 700)`, banned Vds clamp `(vds < -10)` or `(vds > 50)`, `junctionCap` helper, `MNAAssembler`, `_ctxInitMode`, `_prev<X>Voltage` without corresponding `initVoltages()` wiring | M | repo-wide |
| 0.1.2 | Remove dead code flagged in `post-a1-parity.md §1.6` extra observation: `src/components/passives/coupled-inductor.ts::CoupledInductorState` + `createState()` if still present (may have landed under W4.B.5 — verify) | S | `src/components/passives/coupled-inductor.ts` |

**Commit:** `Phase 0 — residual identifier audit + coupled-inductor dead code sweep`

---

## Phase 3: F2 — NR Reorder Gate + Per-Device xfact Predictor (diode + BJT)
**Depends on:** Phase 0

Targeted tests: `newton-raphson`, `analog-engine`, `diode`, `bjt` unit/integration suites under `src/solver/analog/__tests__/` and `src/components/semiconductors/__tests__/`; ngspice comparison harness for per-NR parity on diode / BJT transients.

**Scope narrowing post-A1:** xfact predictor lives inside each device's unified `load()`. References to line numbers against the old `_updateOp` split are replaced with references to the device's post-A1 `load()` body. MOSFET and JFET xfact are in Phases 6 / 7 respectively (device-specific).

### Wave 3.1: NR reorder timing

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.1.1 | Pre-factor `NISHOULDREORDER` gate: insert `solver.forceReorder()` at the top of the NR loop before factor dispatch, gated on `isInitJct(ctx.cktMode) \|\| (isInitTran(ctx.cktMode) && iteration === 0)`. Cite `niiter.c:856-859`. | S | `src/solver/analog/newton-raphson.ts` |
| 3.1.2 | Citation hygiene: add ngspice cross-reference comments to existing `forceReorder()` calls citing `niiter.c:474-499`. Behavior unchanged. | S | `src/solver/analog/newton-raphson.ts` |

### Wave 3.2: Device xfact predictor — diode + BJT

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.2.1 | **Diode xfact.** Inside `diode.ts::load()`, add a MODEINITPRED branch: `if (ctx.cktMode & MODEINITPRED) { vdRaw = (1 + ctx.xfact) * s1[base + SLOT_VD] - ctx.xfact * s2[base + SLOT_VD]; }`. Route `vdRaw` into the pnjlim skip path (predicted voltages bypass pnjlim). Cite `dioload.c:141-149` verbatim for the copy-then-fall-through structure. | M | `src/components/semiconductors/diode.ts` |
| 3.2.2 | **BJT L0 xfact.** Same pattern in `bjt.ts::load()` (the `createBjtElement` `load()` body) for `vbeRaw` / `vbcRaw`. Route predicted voltages through the pnjlim-skip path. | M | `src/components/semiconductors/bjt.ts` |
| 3.2.3 | **BJT L1 xfact.** Same pattern in `createSpiceL1BjtElement::load()` for `vbeRaw` / `vbcRaw` / `vsubRaw` per `bjtload.c:302-305`. | M | `src/components/semiconductors/bjt.ts` |
| 3.2.4 | **BJT L1 state-copy slots.** Inside the same MODEINITPRED branch, ensure `s0[base + SLOT_RB_EFF] = s1[base + SLOT_RB_EFF]` and `s0[base + SLOT_VSUB] = s1[base + SLOT_VSUB]` are copied. | S | `src/components/semiconductors/bjt.ts` |
| 3.2.5 | **xfact scope audit.** `Grep "\.xfact"` across `src/components/` and `src/solver/analog/`. Confirm every read is gated by `(ctx.cktMode & MODEINITPRED) !== 0`. No reads outside that guard. | S | `src/components/**/*.ts`, `src/solver/analog/load-context.ts` |

**Commit:** `Phase 3 — F2 NR reorder gate + diode/BJT xfact predictor`

---

## Phase 4: F5 — Residual Limiting Primitives
**Depends on:** Phase 3

Most of F5 was absorbed by Phase 2.5 (D4 pnjlim Gillespie branch, H1 limitingCollector sync, LoadContext `cktFixLimit` field, Zener `tBV` pulled forward into W4.B.2). What remains are three small fixes. Targeted tests: `npx vitest run src/solver/analog/__tests__/harness/stream-verification.test.ts`.

### Wave 4.1: Primitive fix

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.1.1 | `fetlim` `vtstlo` coefficient fix: change to `Math.abs(vold - vto) + 1` matching `devsup.c:102`. | S | `src/solver/analog/newton-raphson.ts` (fetlim implementation) |
| 4.1.2 | `limvds` parity audit: confirm bit-identical to `devsup.c:20-40`. No diff expected; comment-only citation refresh if so. | S | `src/solver/analog/newton-raphson.ts` |
| 4.1.3 | Doc-comment citation refresh: update `pnjlim` comment citation from `devsup.c:50-58` to `devsup.c:49-84` (post-D4 Gillespie inclusion). | S | `src/solver/analog/newton-raphson.ts` |

### Wave 4.2: Call-site fixes

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.2.1 | **LED initJct skip + collector push.** In `led.ts::load()`, add the MODEINITJCT skip branch and push limiting events into `ctx.limitingCollector` when limiting fires. Cite `dioload.c:130-138` for the skip structure; H1 provides the collector. | S | `src/components/io/led.ts` |
| 4.2.2 | **BJT L1 substrate pnjlim audit.** In `bjt.ts::createSpiceL1BjtElement::load()`, verify the `pnjlim(vsubRaw, ..., tp.tSubVcrit)` call is present and argument-correct. Document the simple-model (L0) divergence (no substrate pnjlim) in a comment block citing `architectural-alignment.md §D3`. | S | `src/components/semiconductors/bjt.ts` |

**Commit:** `Phase 4 — F5 residual limiting primitives (fetlim + LED + BJT substrate)`

---

## Phase 5: F-BJT — BJT L0 + L1 Full Alignment
**Depends on:** Phase 4
**Parallel with:** Phase 6, Phase 7

Targeted tests: BJT suites under `src/components/semiconductors/__tests__/`; ngspice harness for BJT common-emitter + diode bridge.

**Post-A1 re-expression:** every task operates inside the unified `load()` methods of `createBjtElement` (L0) and `createSpiceL1BjtElement` (L1). No references to deleted `L1_SLOT_CAP_GEQ_*` / `_IEQ_*` slots — those values are locals in `load()`.

### Wave 5.1: L0 (simple model) alignment

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.1.1 | **A1: MODEINITPRED xfact extension.** Wave 3.2.2 landed the xfact extrapolation; 5.1.1 extends it with the full state1→state0 copy list from `bjtload.c` (all charge / conductance history slots: `QBE`, `QBC`, `CBE`, `CBC`, `GBE`, `GMU`, `IC`, `IB`). Route predicted values into the pnjlim skip path. | M | `src/components/semiconductors/bjt.ts` (createBjtElement load) |
| 5.1.2 | **A3: MODEINITJCT priming.** Inside `load()`, implement the 3-branch ngspice priority: (a) `MODEINITJCT && MODETRANOP && MODEUIC` → UIC IC values; (b) `MODEINITJCT && !OFF` → `tVcrit` priming; (c) `MODEINITJCT && OFF` → zero. Cite `bjtload.c:170-220`. | S | `src/components/semiconductors/bjt.ts` |
| 5.1.3 | **A4: NOBYPASS bypass test.** Add 4-tolerance bypass (`delvbe`, `delvbc`, `cchat`, `cbhat` each vs. `ctx.voltTol`). If all under tolerance: reload state0, skip compute + stamps, return. Add `bypass: boolean` + `voltTol: number` to LoadContext if not present (both SATISFIED in Phase 2.5 Wave 4.1.2 — verify and extend if needed). | L | `src/components/semiconductors/bjt.ts`, `src/solver/analog/load-context.ts` |
| 5.1.4 | **A5: noncon gate INITFIX/off exception.** Wrap `ctx.noncon.value++` in `if (!(ctx.cktMode & MODEINITFIX) \|\| params.OFF === 0) { ... }`. Cite `bjtload.c:749`. Note: B-W3-4 landed a partial version in Phase 2.5; 5.1.4 verifies and completes. | S | `src/components/semiconductors/bjt.ts` |
| 5.1.5 | **A8: Parameterize NE / NC.** Add `NE`, `NC` to `BJT_PARAM_DEFS`. Plumb through factory + `makeTp`. Parameter plumbing; orthogonal to A1 (CARRY-AS-IS). | S | `src/components/semiconductors/bjt.ts` |
| 5.1.6 | **A2 / A9: MODEINITSMSIG + MODEINITTRAN stubs.** Inside `load()`, add MODEINITSMSIG early-return after OP evaluation (no stamps under small-signal pre-pass) and MODEINITTRAN state1 seeding of `vbe` / `vbc`. Cite `bjtload.c:126-149`. | S | `src/components/semiconductors/bjt.ts` |

### Wave 5.2: L1 (Gummel-Poon) alignment

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.2.1 | **B1 / B2: MODEINITPRED xfact + state copies.** Wave 3.2.3 and 3.2.4 landed the core xfact + `RB_EFF`/`VSUB` copies; 5.2.1 completes with the full ngspice state-copy list inside the MODEINITPRED branch. Route predicted voltages to skip pnjlim. | M | `src/components/semiconductors/bjt.ts` (createSpiceL1BjtElement load) |
| 5.2.2 | **B3: MODEINITSMSIG return block.** Inside L1 `load()`, under `(ctx.cktMode & MODEINITSMSIG)`, evaluate OP only, write `cexbc = geqcb` into state, `return` before stamps. Cite `bjtload.c:126-128`. | M | `src/components/semiconductors/bjt.ts` |
| 5.2.3 | **B4: NOBYPASS bypass test.** 4-tolerance gate. If satisfied: reload state0, skip compute + stamps. Same structure as 5.1.3 but wrapping the L1 `load()` body. | L | `src/components/semiconductors/bjt.ts` |
| 5.2.4 | **B5: noncon gate.** Same as 5.1.4 for L1. | S | `src/components/semiconductors/bjt.ts` |
| 5.2.5 | **B8: CdBE uses `op.gbe` (not `op.gm`) in diffusion cap.** Inside `load()` where the diffusion cap companion is computed, the `CAP_GEQ_BE` computation is now a local; fix the formula to use `op.gbe` per `bjtload.c:617`. | S | `src/components/semiconductors/bjt.ts` |
| 5.2.6 | **B9: External BC cap node destination.** At the four cap-companion stamp sites for the external BC path, stamp to `nodeC_int` not `nodeC_ext`. Cite `bjtload.c:725-734`. | S | `src/components/semiconductors/bjt.ts` |
| 5.2.7 | **B10: `BJTsubs` (SUBS) model param.** Add to `BJT_MODEL_PARAM_DEFS`, plumb through factory + subs derivation. Parameter plumbing; orthogonal (CARRY-AS-IS). | M | `src/components/semiconductors/bjt.ts` |
| 5.2.8 | **B11: AREAB / AREAC params.** Add to `BJT_PARAM_DEFS`. Apply area scaling for `c4` (AREAB), `czsub` (AREAC), `czbc` (AREAC) at their compute sites inside `load()`. Cite `bjtload.c:583-585`. Aligns with B-W3-1 post-A1 location. Parameter plumbing portion is CARRY-AS-IS; scaling-site edits are REWRITE-POST-A1. | M | `src/components/semiconductors/bjt.ts` |
| 5.2.9 | **B12: MODEINITTRAN charge state copy.** Inside `load()` under MODEINITTRAN, copy `cqbe`, `cqbc`, `cqbx`, `cqsub` from state0 → state1. Cite `bjtload.c:144-149`. | S | `src/components/semiconductors/bjt.ts` |
| 5.2.10 | **B15: `cexbc` INITTRAN seed + excess-phase shift-history gate split on `prevDt > 0`.** Two-part edit inside `load()`. | M | `src/components/semiconductors/bjt.ts` |
| 5.2.11 | **B22: Excess-phase `cex` uses raw `opIf` not `cbe_mod`.** Inside the excess-phase block, source `cex` from the unmodified forward current. Cite `bjtload.c:520-535`. | S | `src/components/semiconductors/bjt.ts` |
| 5.2.12 | **F-BJT-ADD-21: XTF = 0 gbe adjustment.** Run `gbe`/`cbe` modification regardless of XTF when `TF > 0 && vbe > 0`. Cite `bjtload.c:468-495`. | M | `src/components/semiconductors/bjt.ts` |
| 5.2.13 | **F-BJT-ADD-23: `geqsub = gcsub + gdsub` Norton aggregation.** Single Norton stamp at the substrate node. Previously operated on A1-deleted `_IEQ_BC_EXT` / `_CS` transfer slots; now these are locals. Cite `bjtload.c:625-640`. | S | `src/components/semiconductors/bjt.ts` |
| 5.2.14 | **F-BJT-ADD-25: cap gating for MODEINITSMSIG / UIC-DC-OP.** Gate the cap-companion computation inside `load()` on the correct mode bits. | S | `src/components/semiconductors/bjt.ts` |
| 5.2.15 | **F-BJT-ADD-34: VSUB limiting collector entry.** When `pnjlim` limits `vsub`, push a `LimitingEvent` into `ctx.limitingCollector`. H1 provides the collector side. | S | `src/components/semiconductors/bjt.ts` |

**Commit:** one per wave: `Phase 5.1 — BJT L0 full alignment`, `Phase 5.2 — BJT L1 full alignment`.

---

## Phase 6: F-MOS — MOSFET MOS1 Alignment
**Depends on:** Phase 4
**Parallel with:** Phase 5, Phase 7

Targeted tests: MOSFET vitest suites; ngspice harness for MOSFET inverter.

**Post-A1 re-expression:** every task operates inside the unified `load()` method of `mosfet.ts`. The 11 deleted MOSFET cross-method slots (`SLOT_CAP_GEQ_GS/_GD/_DB/_SB/_GB`, `SLOT_IEQ_*`, `SLOT_Q_*`) are locals in `load()`; Meyer charges and cap companions compute and stamp in a single pass. G1 (MOSFET VBS / VBD sign convention) was landed in Phase 2.5. M-W3-4 was closed as a spec citation error (2026-04-24); `params.GAMMA` already matches `model->MOS1gamma` semantics and requires no edit.

### Wave 6.1: Infrastructure

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.1.1 | **B-5: SLOT_VON zero-init.** Change from `NaN` to `{ kind: "zero" }` in the schema; drop the `isNaN` guard in the VON read path. | S | `src/components/semiconductors/mosfet.ts` |
| 6.1.2 | **B-4: LTE extended to bulk charges.** Add `qbs`, `qbd` to MOSFET's `getLteTimestep` loop. Real state slots; orthogonal to A1 (CARRY-AS-IS). | S | `src/components/semiconductors/mosfet.ts` |

### Wave 6.2: MOSFET correctness

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.2.1 | **M-1: MODEINITPRED xfact predictor.** Replace the current broken state-copy stub (if still present) with the full `mos1load.c:205-227` xfact port. Inside `load()`, under `(ctx.cktMode & MODEINITPRED)`, extrapolate `vbs`, `vbd`, `vgs`, `vgd` from state1 / state2. Route predicted values through the I-V and junction-diode evaluation. Gate so MODEINITTRAN also hits the predictor path per ngspice. | L | `src/components/semiconductors/mosfet.ts` |
| 6.2.2 | **M-2: MODEINITSMSIG path + Meyer averaging fix.** Add the MODEINITSMSIG branch inside `load()` (OP-only, no stamps, return). Fix the Meyer averaging gate in the companion-cap computation. Cite `mos1load.c:354-406`. | M | `src/components/semiconductors/mosfet.ts` |
| 6.2.3 | **M-3: MODEINITJCT IC_VDS / VGS / VBS.** Add `ICVDS`, `ICVGS`, `ICVBS` params to `MOS_PARAM_DEFS`. Inside `load()`, under `(MODEINITJCT && MODETRANOP && MODEUIC)`, initialize junction voltages from the IC params. Parameter-plumbing portion is CARRY; `primeJunctions` rewrite is REWRITE-POST-A1 (now a branch inside `load()`). | M | `src/components/semiconductors/mosfet.ts` |
| 6.2.4 | **M-4: NOBYPASS bypass test.** After node-voltage read inside `load()`, gate the compute block on `!bypassed`. Restore cached state when tolerances satisfied. Same pattern as BJT 5.1.3 / 5.2.3. | L | `src/components/semiconductors/mosfet.ts` |
| 6.2.5 | **M-5: `CKTfixLimit` gate on reverse `limvds`.** Thread `ctx.cktFixLimit` through the `limitVoltages()` helper. Cite `mos1load.c:385`. Note: M-W3-1 landed a version in Phase 2.5 W4.B.8; 6.2.5 verifies the edit survived the full `load()` re-port and fixes any residue. | S | `src/components/semiconductors/mosfet.ts` |
| 6.2.6 | **M-6: icheck noncon gate.** Suppress `ctx.noncon.value++` when `params.OFF !== 0 && (ctx.cktMode & (MODEINITFIX \| MODEINITSMSIG))`. Cite `mos1load.c:739-743`. M-W3-6 landed a version in Phase 2.5 W4.B.8; 6.2.6 verifies after `icheckLimited` local is in place (M-W3-2 dependency). | S | `src/components/semiconductors/mosfet.ts` |
| 6.2.7 | **M-7: qgs / qgd / qgb xfact extrapolation.** Under MODEINITPRED inside `load()`, extrapolate Meyer charges alongside voltages. Previously targeted deleted `SLOT_Q_*` slots; now charges are locals computed once per `load()` — the xfact edit applies to the local at the top of the cap block. | M | `src/components/semiconductors/mosfet.ts` |
| 6.2.8 | **M-8: `von` formula comment.** Add a justification comment above the `von = type * tVbi + gamma * sarg` line documenting the polarity convention. No code change. | S | `src/components/semiconductors/mosfet.ts` |
| 6.2.9 | **M-9: Per-instance `vt`.** Replace hardcoded `VT` with `REFTEMP * KoverQ` or the per-instance scaled `vt` in every `exp(vbs/vt)` / `exp(vbd/vt)` path in the bulk-diode computation. Cite `mos1load.c` bulk-diode section. | S | `src/components/semiconductors/mosfet.ts` |
| 6.2.10 | **M-12: MODEINITFIX + OFF path.** Inside `load()`, add a branch `if ((ctx.cktMode & MODEINITFIX) && params.OFF) { vbs = vgs = vds = 0; }`. | M | `src/components/semiconductors/mosfet.ts` |
| 6.2.11 | **Companion junction zero fix (#32).** Stop zeroing bulk-cap `SLOT_CCAP_DB` / `SLOT_CCAP_SB` on MODEINITTRAN; only zero the Meyer gate-cap companions. Post-A1 this operates on the surviving NIintegrate history slots, not the deleted cross-method slots. | S | `src/components/semiconductors/mosfet.ts` |

### Wave 6.3: Verification

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.3.1 | **PMOS `tVbi` sign audit (#25).** Verify PMOS-with-gamma-nonzero against ngspice via the comparison harness. Determine if `\|VTO\|` vs signed-VTO causes `tVbi` divergence. G1 (sign convention, landed Phase 2.5) likely clarifies; if still divergent, file a finding and escalate. | M | `src/components/semiconductors/mosfet.ts` |

**D-8 note:** the MOSFET `cgs_cgd_transient` regression canary from Phase 2.5 is NOT resolved by Phase 6 code changes — Phase 6 delivers the MOSFET alignment work; the bit-exact acceptance comparison happens in Phase 10 (MOSFET inverter circuit). Do not attempt to close D-8 here.

**Commit:** one per wave: `Phase 6.1 — MOSFET infrastructure`, `Phase 6.2 — MOSFET correctness`, `Phase 6.3 — PMOS tVbi verification`.

---

## Phase 7: F5ext — JFET Full Convergence Port
**Depends on:** Phase 4
**Parallel with:** Phase 5, Phase 6

Subsumes F5-D (Vds-clamp removal, done pre-Phase-2.5) + F5-E (pnjlim on vgd). Targeted tests: `src/components/semiconductors/__tests__/jfet.test.ts`; ngspice harness for JFET circuits.

**Post-A1 re-expression:** every task operates inside the unified `load()` method of `njfet.ts` (and `pjfet.ts` delegates to a polarity-aware version). The deleted cross-method `SLOT_CAP_GEQ_GS` / `_GD` / `SLOT_IEQ_GS` / `_GD` slots are locals in `load()`. `fet-base.ts` was removed in Phase 2.5 — NJFET and PJFET are self-contained.

### Wave 7.1: NJFET core

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.1.1 | **State schema rewrite.** Rename `SLOT_GD_JUNCTION` → `SLOT_GGS_JUNCTION` (if not already done in Phase 2.5); add `SLOT_VGD`, `SLOT_GGD`, `SLOT_CGD`, `SLOT_CD`, `SLOT_QGS`, `SLOT_QGD` to `NJFET_SCHEMA`. Do NOT add `SLOT_CQGS` / `SLOT_CQGD` — those were the cross-method CAP transfer slots A1 deleted; under post-A1 `load()` they are locals. | M | `src/components/semiconductors/njfet.ts` |
| 7.1.2 | **Schema accessor getters/setters for 6 new slots + the GGS_JUNCTION rename.** Keep existing schema-lookup rule (`stateSchema.getSlotOffset("NAME")` rather than `SLOT_*` constant imports in tests). | S | `src/components/semiconductors/njfet.ts` |
| 7.1.3 | **`limitVgd` helper.** Add `DEVpnjlim` on vgs via `limitVoltages`; add gate-drain pair limiting via `limitVgd`. Import `fetlim`. Inside `load()`, limiting applies before IV computation. | M | `src/components/semiconductors/njfet.ts` |
| 7.1.4 | **`primeJunctions` rewrite.** Inside `load()`'s MODEINITJCT branch: 3-branch priority (`UIC` / `!OFF` / `OFF`) per `jfetload.c:109-122`. Seed `_vgs_junction`, `_vgd_junction`, GMIN conductances. `primeJunctions` becomes a local sequence inside `load()`, not a separate method. | M | `src/components/semiconductors/njfet.ts` |
| 7.1.5 | **MODEINITPRED + full NJFET `load()` body port.** Inside the MODEINITPRED branch: state1→state0 copies for 9 slots (VGS, VGD, CG, CD, CGD, GM, GDS, GGS, GGD), xfact extrapolation of vgs / vgd, delvgs / delvgd / cghat / cdhat predictor for convergence checks. Gate-drain Shockley diode computation; Sydney drain current formula per `jfetload.c:280-420`. | L | `src/components/semiconductors/njfet.ts` |
| 7.1.6 | **JFET-specific `checkConvergence`.** Replace inherited MOS1convTest with JFET convergence: `icheck \|\| \|cghat - cg\| >= tol \|\| \|cdhat - cd\| > tol`. Preserve `>=` / `>` asymmetry per ngspice. | M | `src/components/semiconductors/njfet.ts` |
| 7.1.7 | **`_stampNonlinear` rewrite → merged into `load()`.** The 16 Y-matrix + 3 RHS stamps per `jfetload.c:521-550`. Gate-drain diode Norton, RHS-first ordering with polarity sign. Previously `_stampNonlinear` was a separate method; under A1 it's the stamp phase of `load()`. Also includes J-W3-3 follow-through: stamp `gdpr`/`gspr` (RD/RS ohmic conductances — 2 self-stamps for collapsed prime↔external nodes). | L | `src/components/semiconductors/njfet.ts` |

### Wave 7.2: PJFET collapse

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.2.1 | **Delete PJFET `load()` override.** Delegate to a polarity-aware `njfet.ts` base implementation (or a shared `jfet-core` module). No code duplication between NJFET and PJFET beyond polarity. | S | `src/components/semiconductors/pjfet.ts` |
| 7.2.2 | **Delete PJFET `primeJunctions` override.** Delegate to the polarity-aware base (which after 7.1.4 is inline inside `load()`). | S | `src/components/semiconductors/pjfet.ts` |
| 7.2.3 | **Delete PJFET `checkConvergence` override** if present; delegate to the base. | S | `src/components/semiconductors/pjfet.ts` |

### Wave 7.3: Test alignment

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.3.1 | **Update test imports.** Replace `SLOT_GD_JUNCTION` / `SLOT_ID_JUNCTION` with `stateSchema.getSlotOffset("GGS_JUNCTION")` / `("CG_JUNCTION")` per schema-lookup rule. Delete any test whose expected value was hand-computed on a deleted `CAP_GEQ_GS` / `_GD` / `IEQ_GS` / `_GD` slot. | S | `src/components/semiconductors/__tests__/jfet.test.ts` |

**Commit:** one per wave: `Phase 7.1 — NJFET full port`, `Phase 7.2 — PJFET base delegation`, `Phase 7.3 — JFET tests schema-lookup`.

---

## Phase 8: F6 — Documentation & Citation Audit
**Depends on:** Phase 5, Phase 6, Phase 7

Pure documentation / comment-only edits. No runtime behavior change.

### Wave 8.1: Spec artifact

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 8.1.1 | **Create `spec/ngspice-citation-audit.md`** verbatim from F6 Deliverable 8: 58-row table of every ngspice citation in `src/`, with status defs, priority corrections, and maintenance protocol. | M | `spec/ngspice-citation-audit.md` (new) |

### Wave 8.2: Citation corrections in source

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 8.2.1 | **`dc-operating-point.ts` citation corrections.** 6 corrections per the F6 priority list. Line numbers have shifted post-C1 (dcopFinalize rewrite — done in Phase 2.5); re-target against current code. | M | `src/solver/analog/dc-operating-point.ts` |
| 8.2.2 | **`newton-raphson.ts` citation corrections.** pnjlim citation (resolved by Phase 2.5 D4 landing), plus `cktntask.c:97` and `niiter.c:1012-1046` updates. | S | `src/solver/analog/newton-raphson.ts` |
| 8.2.3 | **`analog-types.ts` citation correction.** Replace `niiter.c:991-997` with `niiter.c:1050-1085` on line 82. | S | `src/core/analog-types.ts` |

**Commit:** `Phase 8 — F6 citation audit + corrections`.

---

## Phase 9: Legacy Reference Review + Full Suite Run
**Depends on:** Phase 8

Audit the repo for any remaining stale references introduced or missed since Phase 0's upfront sweep. Run the full test suite once.

### Wave 9.1: Full audit

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 9.1.1 | **Repo-wide grep** for every identifier in Phase 0's list + any new Track A-deleted symbols surfaced during Phases 3–8. Expected: zero hits outside `ref/ngspice/` and `spec/`. Report any residue. | M | repo-wide |
| 9.1.2 | **Citation audit.** Random sample 10 ngspice citations from `src/`; verify line numbers against `ref/ngspice/`. I2 policy enforcement. | S | `src/**/*.ts` |
| 9.1.3 | **Full suite run.** `npm test`. Capture failures as the Phase-10 acceptance input — do not chase them mid-Phase-9; Phase 10 triages. | S | (project-wide) |

**Commit:** `Phase 9 — legacy reference review + full suite baseline`.

---

## Phase 10: 8-Circuit Bit-Exact ngspice Parity Acceptance
**Depends on:** Phase 9

Final acceptance gate. Plan.md Appendix A's 8 circuits must produce IEEE-754 bit-identical per-NR-iteration `rhsOld[]` compared to ngspice.

**Why Phase 10 (not Phase 9.X):** the user has flagged that expecting bit-exact harness results while the underlying engine has known bugs has burned this project before. Phase 10 runs only after Phases 3–9 land; every known fix is in place; engine-level bugs are closed to the best of static + targeted-test knowledge. Phase 10's failures are therefore genuine bit-level divergences, not confounded by upstream known-broken code.

**Per-circuit pass criteria:**
- **DC-OP:** every NR iteration's `rhsOld[]` matches exactly (`absDelta === 0`); mode transitions match; iteration count matches.
- **Transient:** every accepted timestep's `dt`, `order`, `method` match; per-step NR iteration count matches; node voltages match exactly.
- **Convergence flow:** `noncon`, `diagGmin`, `srcFact` match at every iteration/step.
- **Device state:** `state0[]` (per `device-mappings.ts` slots) matches exactly at every NR iteration.

**Execution model:** one wave per circuit. Each circuit gets its own test file under `src/solver/analog/__tests__/acceptance/` (or equivalent). Failures surface as PARITY tickets. Agents DO NOT self-correct convergence divergences — they report and stop. User reviews and decides fix-or-escalate.

### Wave 10.1: DC-OP acceptance circuits

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 10.1.1 | **Resistive divider** — linear stamp, 1 NR iteration expected. Sanity baseline. | M | acceptance test file |
| 10.1.2 | **Diode + resistor** — pnjlim + mode transitions; exercises D4 Gillespie branch. | M | acceptance test file |
| 10.1.3 | **BJT common-emitter** — multi-junction limiting, gmin stepping; exercises Phase 5 work. | L | acceptance test file |
| 10.1.4 | **Op-amp inverting amplifier** — source stepping path. | M | acceptance test file |

### Wave 10.2: Transient acceptance circuits

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 10.2.1 | **RC series with pulse** — capacitor integration, LTE, order promotion. | M | acceptance test file |
| 10.2.2 | **RLC oscillator** — inductor integration, ringing without method switch. Exercises I-W3-1 closure (post-Phase 2.5 W4.B.4). | L | acceptance test file |
| 10.2.3 | **Diode bridge rectifier** — multiple junctions, breakpoints. | L | acceptance test file |
| 10.2.4 | **MOSFET inverter** — fetlim, FET equations, DC-OP + transient. **Closes D-8 carry-forward** (MOSFET `cgs_cgd_transient` regression): if the inverter's transient timesteps produce bit-identical `rhsOld[]` and `state0[SLOT_CCAP_*]` vs ngspice, D-8 closes. If not, file a PARITY ticket on the exact NR iteration where values split. | L | acceptance test file |

**Commit:** one per wave: `Phase 10.1 — DC-OP acceptance`, `Phase 10.2 — transient acceptance + D-8 closure`.

**Post-Phase-10:** all remaining divergences surfaced as PARITY tickets go through user review. Track A-style escalation applies — no agent self-correction on convergence.

---

## Appendix A: Operational rules for implementers

- **Run targeted vitest only** per-phase, per-wave. Full suite runs at Phase 9.1.3 and per-circuit at Phase 10.
- **STOP and escalate** if a diff cannot be applied cleanly (code has drifted since Phase 2.5 closure at commit `653340ac`, assumed structure absent). No improvisation.
- **Do not revert on regression.** Report full output. Reverting destroys diagnostic signal.
- **ngspice comparison harness is the primary tool for numerical issues** — do not theorize about per-iteration divergence. Run the harness.
- **Zero allocations in hot paths.** No `new`, `{}`, `[]`, closures inside `load()`, NR iterations, per-step code.
- **Schema lookups over slot exports** — tests resolve pool slots by name via `stateSchema.getSlotOffset("NAME")`, not by importing `SLOT_*` constants.
- **Citation audit per commit** — every `// cite: xxxload.c:NNN` claim must describe the code immediately following. Decorative citations (precedent: Phase 2.5 W1.8c commit `8b298ca9`, rejected) are forbidden.
- **Banned closing verdicts** — *mapping*, *tolerance*, *close enough*, *equivalent to*, *pre-existing*, *intentional divergence*, *citation divergence*, *partial*. If you would use one, escalate.

## Appendix B: Resolved design decisions (inherited from plan.md)

| Decision | Resolution | Rationale |
|---|---|---|
| AMD ordering | Dropped — pure Markowitz on original column order | ngspice doesn't use AMD; required for per-iteration parity |
| NISHOULDREORDER | Explicit `forceReorder()` only, no auto-detection | Match ngspice |
| E_SINGULAR | Continue to CKTload (re-stamp + re-factor) | Match `niiter.c:888-891` |
| NR signature | `newtonRaphson(ctx): void`, writes `ctx.nrResult` | Match ngspice NIiter void signature |
| `hadNodeset` gate | Derived from `ctx.nodesets.size > 0` | Match `niiter.c:1051-1052` |
| Method switching | Remove entirely | ngspice sets method once, never changes |
| Initial method | Trapezoidal | ngspice default is TRAPEZOIDAL |
| Element migration | Atomic — all elements at once, no shims | No legacy shims policy |

## Appendix C: Dropped tasks (SATISFIED-BY Track A — landed in Phase 2.5)

For traceability — tasks from the original plan.md Phases 3–9 that were absorbed by Track A (Phase 2.5) and are NOT in this plan. (plan.md and plan-addendum.md deleted 2026-04-24; per-task classifications are preserved in git history.)

- **Wave 2.1.1–2.1.4** (ckt-mode.ts + LoadContext migration + CKTCircuitContext bitfield + noncon dual-storage) — SATISFIED-BY A2/A3/A4 + C2/C3.
- **Wave 2.2.1** (cktLoad rewrite) — SATISFIED-BY C3.
- **Wave 2.3.1–2.3.8** (dcopFinalize single CKTload, `_firsttime` deletion, caller-side cktMode writes, UIC early-exit fix) — SATISFIED-BY C1/C2 + A2/A3.
- **Wave 2.5.1** (LoadContext literal test migration) — SATISFIED-BY A3/C3 + A1 §Test handling rule.
- **Wave 3.3.1** (unconditional initTran set on first step) — SATISFIED-BY C2.
- **Wave 3.3.2** (NIDIDPREORDER lifecycle audit) — SATISFIED-BY B4.
- **Wave 4.1.1, 4.1.4, 4.2.1, 4.3.1** (limitingCollector field + sync, pnjlim Gillespie rewrite) — SATISFIED-BY H1 + D4.
- **Wave 4.3.3** (Zener tBV) — pulled forward into Phase 2.5 W4.B.2.
- All **Phase 5/6/7 surgical line-number edits against the `_updateOp` / `_stampCompanion` split** — obsolete; re-expressed against `load()` in this plan.

---

## Appendix D: §I2 architectural notes (spec update — user action)

The following genuine cross-timestep integration-history slots were surfaced by Phase 2.5 W3 as undocumented-but-legitimate (not cross-method transfer slots excised by A1). They are now recorded in `architectural-alignment.md §I2.1` as digiTS-externalised NIintegrate history (landed 2026-04-24). No further action required from this plan — listed here as context for why the slots survive post-A1 grep sweeps:

- `diode.ts` — `SLOT_CCAP` (maps to ngspice `CKTstate1 + DIOcapCurrent` implicit in NIintegrate).
- `inductor.ts` — `SLOT_CCAP` (maps to ngspice `CKTstate1 + INDflux` implicit in NIintegrate).

Phase 2.5 also surfaced `src/components/passives/coupled-inductor.ts::CoupledInductorState` + `createState()` as dead code that may have been cleaned up in W4.B.5's bundle. Phase 0 Wave 0.1.2 verifies.
