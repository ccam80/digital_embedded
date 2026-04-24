# Phase 5: F-BJT — BJT L0 + L1 Full Alignment

**Date:** 2026-04-24
**Status:** W5 deliverable. Authored post-A1, against the unified `load(ctx: LoadContext): void` architecture. Depends on Phase 4 (fetlim/LED/BJT-substrate limiting primitives landed). Parallel with Phase 6 (MOSFET), Phase 7 (JFET) — disjoint files.
**Inputs:** `spec/plan.md` §Phase 5; `spec/architectural-alignment.md` A1/D3/D4/H1/I1/I2; `ref/ngspice/src/spicelib/devices/bjt/bjtload.c`.

---

## Overview

Align `createBjtElement` (L0, simple Gummel-Poon) and `createSpiceL1BjtElement` (L1, full Gummel-Poon with capacitances, substrate, excess phase) to their ngspice counterpart in `bjtload.c`. Every edit lands inside the unified `load()` method — no `_updateOp` / `_stampCompanion` split. Cross-method transfer slots remain deleted per §A1; values that crossed compute→stamp in the old architecture are locals inside `load()`.

## What "matches ngspice" means in this phase

Applies to every task and every code comment bearing a `// cite:` reference.

| Acceptable | Not acceptable |
|---|---|
| **Exact numerical equivalence.** Every arithmetic operation, branch condition, and order of operations matches the cited ngspice function bit-for-bit. Floating-point results IEEE-754 equal under identical inputs. | **Algorithmic reshaping** — pulling loop invariants, combining sub-expressions, reordering commutatively-equivalent operations. Reordering changes IEEE-754 output; `(a + b) + c ≠ a + (b + c)` under rounding. Forbidden. |
| **Variable renames.** ngspice `vbe` → ours `vbeRaw` or `vbeLimited`, `qb` → `op.qb`, `CKTstate0 + BJTvbe` → `s0[base + SLOT_VBE]`. Type/scope/lifetime preserved, only identifier text differs. | **Control-flow restructuring** — `goto load` → early return + flag; nested `if` chain → `switch`; ngspice's four-level `if` in the bypass gate → a single boolean `&&` chain with short-circuit. Forbidden. Match ngspice's nesting exactly. |
| **Macro expansion.** `MODEINITSMSIG`, `MODEINITTRAN`, `MODETRANOP` etc. are bitmask constants in both codebases; `(CKTmode & MODEINITJCT)` ↔ `(ctx.cktMode & MODEINITJCT)` is identity. | **Guard-insertion for edge cases ngspice doesn't guard.** Examples: `ctx.deltaOld[1] > 0 ? ctx.deltaOld[1] : ctx.delta` (papering — see 5.0.2). `Math.max(sqarg, 1e-30)` where ngspice divides raw. Forbidden except under an explicit `architectural-alignment.md` entry. |
| **Structural adaptations for digiTS's data model**, each paired with an `architectural-alignment.md` reference. Examples: ngspice `NIintegrate(ckt, &geq, &ceq, capbe, here->BJTqbe)` ↔ our `niIntegrate(method, order, capbe, ag, qbe, s1[QBE], [q2,q3,0,0,0], s1[CQBE])` — different signature, same math (per §I2.1). | **"Pragmatic" / "minimal" / "simpler" / "cleaner" versions of ngspice code.** If a simpler version exists and you think it's equivalent: don't write it. Write the ngspice version. Per CLAUDE.md "No Pragmatic Patches". |
| **Comment-level rephrasing** of ngspice source comments in our cite lines. | **Citation decoration.** A `// cite: bjtload.c:NNN` must describe the code *immediately following it*. Decorative citations (Phase 2.5 W1.8c precedent, commit `8b298ca9` — rejected) forbidden. |

**If a task cannot be implemented without a deviation in the "not acceptable" column:** STOP and escalate with:
- The ngspice lines you're trying to port
- The digiTS lines where the deviation manifests
- Which cell of the "not acceptable" column it falls under
- A proposed `architectural-alignment.md` entry in the escalation report (users approve, not agents)

---

## Wave 5.0: LoadContext bypass prerequisites

Prelude before any BJT edits. Adds the `bypass` / `voltTol` fields required by NOBYPASS tasks 5.1.3 and 5.2.3. Verifies the `deltaOld` seeding already present in `ckt-context.ts`.

### Task 5.0.1: Extend LoadContext with bypass + voltTol
- **Description**: Add `bypass: boolean` and `voltTol: number` to `LoadContext`, matching ngspice `CKTbypass` and `CKTvoltTol`. Defaults from `ref/ngspice/src/spicelib/devices/cktinit.c:53-55`: `bypass = false`, `voltTol = 1e-6`.
- **Files to modify**:
  - `src/solver/analog/load-context.ts` — add two fields to the `LoadContext` interface with ngspice citations
  - `src/solver/analog/ckt-context.ts` — add `bypass` / `voltTol` fields on `CKTCircuitContext`; default-initialize to `false` / `1e-6` in the constructor; include in the `loadCtx` object returned around line 566
  - Every `LoadContext` literal in tests — append `bypass: false, voltTol: 1e-6`. Known sites (grep `deltaOld: \[`):
    - `src/components/semiconductors/__tests__/bjt.test.ts` (the `makeDcOpCtx` helper)
    - `src/components/semiconductors/__tests__/diode.test.ts`, `mosfet.test.ts`, `jfet.test.ts`, `scr.test.ts`, `triac.test.ts`, `zener.test.ts`, `tunnel-diode.test.ts`
    - `src/components/active/__tests__/schmitt-trigger.test.ts`, `opamp.test.ts`, `comparator.test.ts`, `ota.test.ts`, `adc.test.ts`, `dac.test.ts`, `real-opamp.test.ts`
    - `src/components/passives/__tests__/capacitor.test.ts`, `inductor.test.ts`, `polarized-cap.test.ts`, `transformer.test.ts`, `tapped-transformer.test.ts`, `transmission-line.test.ts`, `memristor.test.ts`, `analog-fuse.test.ts`, `tx_trace.test.ts`
    - `src/components/sensors/__tests__/ntc-thermistor.test.ts`, `spark-gap.test.ts`
    - `src/components/sources/__tests__/variable-rail.test.ts`, `ac-voltage-source.test.ts`, `dc-voltage-source.test.ts`, `current-source.test.ts`, `ground.test.ts`
    - `src/components/io/__tests__/analog-clock.test.ts`, `led.test.ts`, `probe.test.ts`
    - `src/solver/__tests__/coordinator-bridge.test.ts`, `coordinator-bridge-hotload.test.ts`
    - `src/solver/analog/__tests__/behavioral-combinational.test.ts`, `behavioral-sequential.test.ts`, `behavioral-flipflop.test.ts`, `behavioral-flipflop-variants.test.ts`, `behavioral-integration.test.ts`, `behavioral-gate.test.ts`, `behavioral-remaining.test.ts`, `bridge-adapter.test.ts`, `bridge-compilation.test.ts`, `digital-pin-model.test.ts`, `timestep.test.ts`, `sparse-solver.test.ts`, `dcop-init-jct.test.ts`, `analog-engine.test.ts`, `ckt-context.test.ts`, `integration.test.ts`, `ckt-terr.test.ts`
- **Tests**:
  - `src/solver/analog/__tests__/ckt-context.test.ts::LoadContext defaults::bypass_defaults_to_false` — assert `new CKTCircuitContext({...}).loadCtx.bypass === false`
  - `src/solver/analog/__tests__/ckt-context.test.ts::LoadContext defaults::voltTol_defaults_to_1e_minus_6` — assert `...loadCtx.voltTol === 1e-6`
- **Acceptance criteria**:
  - `LoadContext` interface has `bypass: boolean` and `voltTol: number` with citation `// cite: cktinit.c:53-55`
  - Every test compiles with the new fields
  - Defaults match ngspice exactly

### Task 5.0.2: Verify deltaOld seeding + remove bjt.ts guard
- **Description**: Confirm `src/solver/analog/ckt-context.ts:539` (`this.deltaOld = new Array<number>(7).fill(params.maxTimeStep)`) matches ngspice `dctran.c:317` (`ckt->CKTdeltaOld[i] = ckt->CKTmaxStep`). With the engine-side seeding verified, delete the `ctx.deltaOld[1] > 0 ? ctx.deltaOld[1] : ctx.delta` papering guard at `src/components/semiconductors/bjt.ts:1399`. Divide by `ctx.deltaOld[1]` directly, matching `bjtload.c:536-539`.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts` line 1399 — replace `const deltaOld1 = ctx.deltaOld[1] > 0 ? ctx.deltaOld[1] : ctx.delta;` with `const deltaOld1 = ctx.deltaOld[1];  // cite: dctran.c:317 — pre-seeded to CKTmaxStep, never zero`
- **Tests**:
  - `src/solver/analog/__tests__/ckt-context.test.ts::deltaOld init::seeded_to_maxTimeStep` — after `new CKTCircuitContext({ maxTimeStep: 1e-6, ... })`, assert `ctx.loadCtx.deltaOld[i] === 1e-6` for every `i` in `0..6`
- **Acceptance criteria**:
  - `ctx.deltaOld[0..6]` equals `params.maxTimeStep` post-construction
  - `bjt.ts` excess-phase block divides by `deltaOld[1]` directly; no conditional substitution
  - `ckt-context.test.ts` new test passes

---

## Wave 5.1: BJT L0 full alignment

All edits inside `createBjtElement::load()` at `src/components/semiconductors/bjt.ts:807`. L0 is the reduced resistive Gummel-Poon subset — no capacitances, no transit time, no substrate.

### Task 5.1.1: MODEINITPRED full state-copy list (A1)
- **Description**: Phase 3 wave 3.2.2 landed xfact extrapolation of vbe/vbc inside the MODEINITPRED branch plus the VBE/VBC state copies. Extend with copies for the remaining 7 slots in the L0 schema (CC, CB, GPI, GMU, GM, GO, GX), mirroring `bjtload.c:288-303` minus VSUB (L0 has no substrate slot). Predicted voltages continue to route through the pnjlim-skip path per Phase 3's existing guard.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts::createBjtElement::load()` — inside the Phase-3 MODEINITPRED branch, append `s0[base + SLOT_CC] = s1[base + SLOT_CC]`, and likewise for `SLOT_CB, SLOT_GPI, SLOT_GMU, SLOT_GM, SLOT_GO, SLOT_GX`. Cite `bjtload.c:288-303`.
- **Tests**:
  - `src/components/semiconductors/__tests__/bjt.test.ts::BJT L0 MODEINITPRED::copies_9_slots_state1_to_state0` — seed every L0 state1 slot with a sentinel (e.g., `s1[VBE]=0.1, s1[VBC]=0.2, s1[CC]=0.3, s1[CB]=0.4, s1[GPI]=0.5, s1[GMU]=0.6, s1[GM]=0.7, s1[GO]=0.8, s1[GX]=0.9`). Call `load()` with `cktMode = MODETRAN | MODEINITPRED`. Assert every `s0[SLOT_X]` equals the corresponding sentinel.
- **Acceptance criteria**:
  - 7 new state-copy assignments present (VBE/VBC already landed by Phase 3)
  - Each copy carries a `// cite: bjtload.c:NNN` pointing at the specific ngspice line
  - Test passes with sentinels preserved through `load()` on the MODEINITPRED path

### Task 5.1.2: MODEINITJCT 3-branch priming verification (A3)
- **Description**: Verify the 3-branch MODEINITJCT priority at `bjt.ts:825-839` matches `bjtload.c:258-275`: (a) `MODEINITJCT & MODETRANOP & MODEUIC` → UIC IC values; (b) `MODEINITJCT & !OFF` → `vbe = tVcrit, vbc = 0`; (c) `MODEINITJCT` or `(MODEINITFIX & OFF)` → `vbe = vbc = 0`. Refresh citation comments to match exact ngspice line ranges.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts:825-839` — citation refresh with exact ngspice line ranges (`:258-264`, `:265-269`, `:270-275`)
- **Tests**:
  - `bjt.test.ts::BJT L0 MODEINITJCT::uic_path_seeds_from_icvbe_icvce` — with `ICVBE=0.5`, `ICVCE=1.0`, `cktMode = MODEINITJCT | MODETRANOP | MODEUIC`, call `load()`. Assert `s0[SLOT_VBE]` equals the value written by the UIC branch (pnjlim is skipped on init paths, so state0 receives the raw IC-derived voltages).
  - `bjt.test.ts::BJT L0 MODEINITJCT::on_path_seeds_tVcrit` — `OFF=0`, `cktMode = MODEINITJCT` (no TRANOP). Assert `s0[SLOT_VBE] > 0` (magnitude near thermal voltage) and `s0[SLOT_VBC] === 0` modulo the compute step.
  - `bjt.test.ts::BJT L0 MODEINITJCT::off_path_zero_seeds` — `OFF=1`, `cktMode = MODEINITJCT`. Assert the `vbeRaw`/`vbcRaw` seed was 0 by probing downstream op output that monotonically depends on vbe (e.g., `s0[SLOT_CC]` post-load is near 0 for zero bias).
- **Acceptance criteria**:
  - 3 tests pass
  - Citation comments refreshed to exact bjtload.c ranges
  - No regression in the existing LimitingEvent tests in `bjt.test.ts`

### Task 5.1.3: NOBYPASS bypass test (A4)
- **Description**: Insert a 4-tolerance bypass gate inside `load()` between the post-init vbeRaw/vbcRaw read and pnjlim. Matches `bjtload.c:338-381`. Gate: `ctx.bypass && !(mode & MODEINITPRED) && |delvbe| < reltol*max(|vbe|,|vbeOld|)+voltTol && |delvbc| < ... && |cchat-cc| < reltol*max(|cchat|,|cc|)+iabstol && |cbhat-cb| < ...`. On bypass: restore `vbe, vbc, op.cc, op.cb, op.gpi, op.gmu, op.gm, op.go, gx` from state0, skip pnjlim + computeBjtOp + noncon, proceed directly to the RHS / Y-matrix stamp block (mirrors ngspice `goto load`).
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts::createBjtElement::load()` — compute `delvbe`, `delvbc`, `cchat`, `cbhat` per `bjtload.c:323-337` (formulas already present in the `checkConvergence` method at lines 976-986; port inline). Insert the 4-test AND gate. On bypass, populate a local `op`-shaped record from state0 slots, set `vbeLimited = s0[VBE]`, `vbcLimited = s0[VBC]`, `icheckLimited = false`, and jump to the stamp block. Do NOT restructure into early-return or separate function — match ngspice's `goto load` by arranging the gate as a wrapping `if`/`else` around the pnjlim + compute phases. Cite `bjtload.c:338-381`.
- **Tests**:
  - `bjt.test.ts::BJT L0 NOBYPASS::bypass_disabled_when_ctx_bypass_false` — `ctx.bypass = false`, run two back-to-back `load()` calls with identical `rhsOld`. Assert both calls emit non-zero stamp counts (detected via a `SparseSolver` stamp-count probe wrapping `stampG`/`stampRHS`).
  - `bjt.test.ts::BJT L0 NOBYPASS::bypass_triggers_when_tolerances_met` — `ctx.bypass = true`. Prime state0 by running one `load()`, then run a second `load()` with `rhsOld` unchanged. Assert: (a) `ctx.noncon.value` unchanged on second call, (b) stamps still emitted on second call (bypass preserves stamps), (c) a probe on `computeBjtOp` call-count shows it was invoked once (first call) not twice.
  - `bjt.test.ts::BJT L0 NOBYPASS::bypass_disabled_by_MODEINITPRED` — `ctx.bypass = true`, `cktMode |= MODEINITPRED`, tolerances nominally satisfied. Assert `computeBjtOp` was still called (path-selection probe — e.g., overwrite a sentinel slot pre-load and check it was rewritten by compute, not preserved by bypass).
- **Acceptance criteria**:
  - Gate syntactically matches ngspice's 4-test AND chain
  - Restore list covers 9 L0 op-state slots (VBE, VBC, CC, CB, GPI, GMU, GM, GO, GX)
  - Bypass never triggers under MODEINITPRED
  - 3 tests pass

### Task 5.1.4: noncon INITFIX/off gate verification (A5)
- **Description**: Verify `bjt.ts:874` (`if (icheckLimited && (params.OFF === 0 || !(mode & MODEINITFIX))) ctx.noncon.value++`) matches `bjtload.c:749-754`. Refresh citation.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts:874` — comment refresh to `// cite: bjtload.c:749-754 — icheck++ unless MODEINITFIX && OFF`
- **Tests**:
  - `bjt.test.ts::BJT L0 noncon::no_bump_when_initfix_and_off` — `OFF=1`, `cktMode = MODEINITFIX`, seed `rhsOld` large enough for pnjlim to nominally fire. Assert `ctx.noncon.value === 0` after `load()`.
  - `bjt.test.ts::BJT L0 noncon::bumps_when_initfix_and_not_off` — `OFF=0`, `cktMode = MODEINITFIX`, same `rhsOld`. Assert `ctx.noncon.value >= 1` (pnjlim fires, OFF=0 permits the bump).
  - `bjt.test.ts::BJT L0 noncon::bumps_when_not_initfix_and_off` — `OFF=1`, `cktMode = MODEDCOP` (no INITFIX), same `rhsOld`. Assert `ctx.noncon.value >= 1`.
- **Acceptance criteria**:
  - 3 tests pass
  - Citation verbatim against `bjtload.c:749-754`

### Task 5.1.5: Parameterize NE / NC (A8)
- **Description**: Add `NE` (default 1.5) and `NC` (default 2) to `BJT_PARAM_DEFS` under `secondary`. Plumb through `params` factory object, through `makeTp()` (currently hard-coded `NE: 1.5, NC: 2.0` at `bjt.ts:752`), and into the `computeBjtOp` call site at `bjt.ts:904` (currently `1.5, 2.0`).
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts::BJT_PARAM_DEFS`, `BJT_NPN_DEFAULTS`, `BJT_PNP_DEFAULTS` — add `NE: { default: 1.5, description: "B-E leakage emission coefficient" }` and `NC: { default: 2, description: "B-C leakage emission coefficient" }`
  - `createBjtElement` `params` factory — add `NE: props.getModelParam<number>("NE"), NC: props.getModelParam<number>("NC")`
  - `makeTp()` — pass `NE: params.NE, NC: params.NC` into `computeBjtTempParams`
  - `load()` `computeBjtOp` call at line 904 — pass `params.NE, params.NC` instead of `1.5, 2.0`
- **Tests**:
  - `bjt.test.ts::ModelParams::NE_default_1_5` — after `makeBjtProps()`, `propsObj.getModelParam<number>("NE") === 1.5`
  - `bjt.test.ts::ModelParams::NC_default_2` — `propsObj.getModelParam<number>("NC") === 2`
  - `bjt.test.ts::ModelParams::paramDefs_include_NE_NC` — `BJT_PARAM_DEFS.map(pd => pd.key)` contains both `"NE"` and `"NC"`
  - `bjt.test.ts::ModelParams::setParam_NE_NC_no_throw` — `element.setParam("NE", 1.2)` and `element.setParam("NC", 2.5)` don't throw
- **Acceptance criteria**:
  - Params declared with correct rank (`secondary`) and descriptions
  - 4 tests pass
  - No `1.5` / `2.0` literal remains in L0 `load()` or `makeTp()` for NE/NC

### Task 5.1.6: MODEINITSMSIG early-return + MODEINITTRAN state1 seed (A2/A9)
- **Description**: L0 currently reads `s0` voltages under MODEINITSMSIG but runs the full compute+stamp pipeline, which ngspice does NOT do for L0 (ngspice has no cap block in L0 so the smsig early exit at `bjtload.c:703` never fires; however the OP-only-no-stamps semantic of MODEINITSMSIG applies regardless). After the state0 write-back of op values but before the RHS/Y-matrix stamp block, insert `if (mode & MODEINITSMSIG) return;`. Additionally, inside the existing MODEINITTRAN branch at `bjt.ts:822-824`, after reading vbe/vbc from state1, write `s1[base + SLOT_VBE] = vbeRaw; s1[base + SLOT_VBC] = vbcRaw;` so subsequent NIintegrate history has a valid `t = 0` prior value. Cite `bjtload.c:126-149` (conceptual) and `:236-257`.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts::createBjtElement::load()` — between the state0 op-slot write-back (currently line 908-916) and the RHS stamp block (line 921+), add `if (mode & MODEINITSMSIG) return;  // cite: bjtload.c:676,703 — MODEINITSMSIG stores op state, skips stamps`
  - Same `load()`, inside the MODEINITTRAN branch (lines 822-824), add `s1[base + SLOT_VBE] = vbeRaw; s1[base + SLOT_VBC] = vbeRaw;` — actually the seed mirrors the voltages that were just read FROM state1, so this is idempotent on the first tran step. But it is required to ensure state1 is populated with the DC-OP voltages (the predecessor iteration wrote state0; on MODEINITTRAN entry we need state1 aligned)
- **Tests**:
  - `bjt.test.ts::BJT L0 MODEINITSMSIG::no_stamps_emitted` — `cktMode = MODEDCOP | MODEINITSMSIG`, wrap `SparseSolver` with a stamp-count probe. Call `load()`. Assert zero stampG / stampRHS increments from this element.
  - `bjt.test.ts::BJT L0 MODEINITSMSIG::state0_op_slots_populated` — same ctx, after `load()` assert `s0[VBE], s0[VBC], s0[CC], s0[CB], s0[GPI], s0[GMU], s0[GM], s0[GO], s0[GX]` are all finite (not NaN).
  - `bjt.test.ts::BJT L0 MODEINITTRAN::state1_VBE_VBC_seeded` — `cktMode = MODETRAN | MODEINITTRAN`. Seed `rhsOld` such that initial vbeRaw=0.5, vbcRaw=-0.3. Call `load()`. Assert `s1[VBE] === 0.5` and `s1[VBC] === -0.3` (or polarity-signed equivalents for PNP).
- **Acceptance criteria**:
  - Early-return present before stamp block under MODEINITSMSIG
  - MODEINITTRAN seeds state1 from the initial voltage read
  - 3 tests pass

---

## Wave 5.2: BJT L1 (Gummel-Poon) full alignment

All edits inside `createSpiceL1BjtElement::load()` at `src/components/semiconductors/bjt.ts:1211`. Many tasks are verification-and-citation-refresh because Phase 2.5 landed the mechanics; each still writes at least one path-selection test that catches regressions from Phase 3/4 drift.

### Task 5.2.1: MODEINITPRED full state-copy list (B1/B2)
- **Description**: Phase 3 wave 3.2.3 + 3.2.4 landed xfact extrapolation of vbe/vbc/vsub plus VBE/VBC/VSUB state copies. Extend with the remaining 7 slots from `bjtload.c:288-303`: CC, CB, GPI, GMU, GM, GO, GX. Predicted voltages route through the pnjlim-skip path per Phase 3's existing guard. Note: the plan mentions `SLOT_RB_EFF` in task 3.2.4, but `BJT_L1_SCHEMA` does not declare an RB_EFF slot — Phase 3 is expected to surface this as a plan error. This task copies only the 7 slots that exist in `BJT_L1_SCHEMA`.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts::createSpiceL1BjtElement::load()` — inside the Phase-3 MODEINITPRED branch (around line 1288-1295), append `s0[base + SLOT_CC] = s1[base + SLOT_CC]` and likewise for SLOT_CB, SLOT_GPI, SLOT_GMU, SLOT_GM, SLOT_GO, SLOT_GX. Cite `bjtload.c:288-303`.
- **Tests**:
  - `bjt.test.ts::BJT L1 MODEINITPRED::copies_10_slots_state1_to_state0` — seed state1 with sentinels for all 10 (VBE, VBC, CC, CB, GPI, GMU, GM, GO, GX, VSUB). Call `load()` with `cktMode = MODETRAN | MODEINITPRED`. Assert every `s0[SLOT_X]` equals the state1 sentinel.
- **Acceptance criteria**:
  - 7 new state-copy assignments present (3 already landed by Phase 3)
  - Test passes with all 10 sentinels preserved

### Task 5.2.2: MODEINITSMSIG return block verification (B3)
- **Description**: L1 currently has the MODEINITSMSIG return block at `bjt.ts:1562-1588`. Verify it matches `bjtload.c:674-703`: writes CQBE=capbe, CQBC=capbc, CQSUB=capsub, CQBX=capbx, CEXBC=geqcb into state0, writes the full op state (VBE, VBC, CC, CB, GPI, GMU, GM, GO, GX, GEQCB, GCSUB=0, GEQBX=0, VSUB, GDSUB, CDSUB), then `return` before NIintegrate + stamps. Refresh citation.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts:1562` — citation refresh to `// cite: bjtload.c:674-703 — MODEINITSMSIG stores caps+op, skips NIintegrate and stamps via 'continue'`
- **Tests**:
  - `bjt.test.ts::BJT L1 MODEINITSMSIG::no_stamps_emitted` — `cktMode = MODEDCOP | MODEINITSMSIG`, `CJE=1e-12`, `CJC=1e-12` so cap block fires. Assert zero stamps from the stamp-count probe.
  - `bjt.test.ts::BJT L1 MODEINITSMSIG::cap_values_stored` — same ctx, after `load()` assert `s0[CQBE], s0[CQBC], s0[CQSUB], s0[CQBX]` are all finite (populated by smsig branch).
  - `bjt.test.ts::BJT L1 MODEINITSMSIG::cexbc_equals_geqcb` — with `TF=1e-9`, forward VBE so geqcb computes non-zero. Assert `s0[CEXBC] === s0[GEQCB]`.
- **Acceptance criteria**:
  - Citation refreshed
  - 3 tests pass

### Task 5.2.3: NOBYPASS bypass test (B4)
- **Description**: Same 4-tolerance gate structure as 5.1.3, scaled to L1's state set. Restore list per `bjtload.c:365-379`: `vbe, vbc, cc, cb, gpi, gmu, gm, go, gx, geqcb, gcsub, geqbx, vsub, gdsub, cdsub` from state0. On bypass: skip pnjlim, skip `computeSpiceL1BjtOp`, skip substrate diode compute, skip cap block + NIintegrate, proceed to stamp block.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts::createSpiceL1BjtElement::load()` — after the init-voltage dispatch but before pnjlim (around line 1302), insert the 4-test gate. Gate formula identical to L0 but with L1's vbe/vbc state slots. Restore 15 op-state values from state0. Arrange as a wrapping `if/else` so the stamp block executes on bypass with restored values. Cite `bjtload.c:338-381`.
- **Tests**:
  - `bjt.test.ts::BJT L1 NOBYPASS::bypass_disabled_when_ctx_bypass_false` — same shape as 5.1.3 test 1
  - `bjt.test.ts::BJT L1 NOBYPASS::bypass_restores_and_stamps` — bypass=true, tolerances met. Assert noncon unchanged, stamps still emitted.
  - `bjt.test.ts::BJT L1 NOBYPASS::bypass_disabled_by_MODEINITPRED` — bypass=true, mode|=MODEINITPRED. Assert compute path taken.
- **Acceptance criteria**:
  - 15-slot restore list present
  - Gate matches ngspice verbatim
  - 3 tests pass

### Task 5.2.4: noncon INITFIX/off gate verification (B5)
- **Description**: Mirror of 5.1.4 for L1. Verify `bjt.ts:1325` matches `bjtload.c:749-754`. Refresh citation.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts:1325` — citation refresh
- **Tests**:
  - `bjt.test.ts::BJT L1 noncon::no_bump_when_initfix_and_off` — `OFF=1`, `cktMode = MODEINITFIX`, rhsOld triggers pnjlim. Assert `noncon.value === 0`.
  - `bjt.test.ts::BJT L1 noncon::bumps_when_initfix_and_not_off` — `OFF=0`, `cktMode = MODEINITFIX`. Assert `noncon.value >= 1`.
  - `bjt.test.ts::BJT L1 noncon::bumps_when_not_initfix_and_off` — `OFF=1`, `cktMode = MODEDCOP`. Assert `noncon.value >= 1`.
- **Acceptance criteria**:
  - 3 tests pass
  - Citation verbatim

### Task 5.2.5: CdBE uses op.gbe verification (B8)
- **Description**: Verify `bjt.ts:1502` (`capbe = tf * gbeMod + czbe * sarg`) and `:1510` (`capbe = tf * gbeMod + czbef2 * (f3 + xme * vbeLimited / pe)`) derive `gbeMod` from `op.gbe`, not from a transconductance. Matches `bjtload.c:617, 625`. Refresh citations.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts:1502` and `:1510` — citation refresh to `// cite: bjtload.c:617` and `:625`
- **Tests**:
  - `bjt.test.ts::BJT L1 CdBE::scales_with_gbe_not_gm` — construct L1 with `TF=1e-9`, `CJE=1e-12`, VBE forward. Run `load()` twice with `IS` scaled ×10 between runs (gbe ~ IS*exp(vbe/vt)/vt; gm ~ cbe*dqbdve/qb — different IS dependence). Assert `s0[QBE]` responds monotonically to gbe (probe via observed QBE ratio; not bit-exact).
- **Acceptance criteria**:
  - Citations refreshed
  - Probe test passes (QBE monotonically tracks gbe)

### Task 5.2.6: External BC cap stamp destination verification (B9)
- **Description**: Verify `bjt.ts:1761-1762` (geqbx stamps) target `(nodeB_ext, nodeC_int)` and `(nodeC_int, nodeB_ext)`, NOT `nodeC_ext`. Matches `bjtload.c:841-842` — `BJTbaseColPrimePtr` and `BJTcolPrimeBasePtr` target colPrime (internal). Refresh citation.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts:1761-1762` — citation refresh against `bjtload.c:841-842`
- **Tests**:
  - `bjt.test.ts::BJT L1 BC_cap_stamps::target_colPrime` — construct L1 with `RC=1` (forces `nodeC_int !== nodeC_ext`), `CJC=1e-11`, tran mode, VBC reverse. Wrap `stampG` with an address-capturing probe. Call `load()`. Assert no stamp touches `(nodeB_ext, nodeC_ext)` or `(nodeC_ext, nodeB_ext)`; stamps to `(nodeB_ext, nodeC_int)` and `(nodeC_int, nodeB_ext)` present.
- **Acceptance criteria**:
  - Citation refreshed
  - Addressing test passes

### Task 5.2.7: BJTsubs (SUBS) model param (B10)
- **Description**: Add `SUBS` to `BJT_SPICE_L1_PARAM_DEFS` (numeric 0/1, default 1). Matches ngspice int enum `VERTICAL=1`, `LATERAL=0`. Must NOT be confused with the existing `subs` local at `bjt.ts:1153` which is a **polarity sign** (±1 for substrate Norton direction). Plumb SUBS into `params` factory; add a `isLateral = params.SUBS === 0` local near the top of `load()` for use by 5.2.8.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts::BJT_SPICE_L1_PARAM_DEFS` (NPN + PNP variants) — add `SUBS: { default: 1, description: "Substrate topology: 1=VERTICAL, 0=LATERAL" }` under `secondary`
  - `createSpiceL1BjtElement` `params` factory — add `SUBS: props.getModelParam<number>("SUBS")`
  - `load()` — hoist `const isLateral = params.SUBS === 0;` near the top of the function body (before any area-scaled compute). Do not rename the existing `const subs = polarity > 0 ? 1 : -1;` at line 1153.
- **Tests**:
  - `bjt.test.ts::SpiceL1 ModelParams::SUBS_default_1` — `propsObj.getModelParam<number>("SUBS") === 1` after `makeSpiceL1Props()`
  - `bjt.test.ts::SpiceL1 ModelParams::SUBS_in_paramDefs` — `BJT_SPICE_L1_PARAM_DEFS.map(pd => pd.key)` contains `"SUBS"`
  - `bjt.test.ts::SpiceL1 ModelParams::setParam_SUBS_no_throw` — `setParam("SUBS", 0)` doesn't throw
- **Acceptance criteria**:
  - Param plumbing complete
  - `subs` polarity sign untouched
  - `isLateral` local available in `load()` scope
  - 3 tests pass

### Task 5.2.8: AREAB / AREAC params with SUBS-dependent area scaling (B11)
- **Description**: Add `AREAB` and `AREAC` to `BJT_SPICE_L1_PARAM_DEFS` (default 1 each). Apply ngspice's BJTsubs-dependent area branching at three compute sites:
  - `c4` (currently `bjt.ts:1225`): `c4 = tp.tBCleakCur * (isLateral ? params.AREAC : params.AREAB)`. Cite `bjtload.c:184-187`.
  - `ctot` (inside cap block, currently line 1458-1460): `ctot = tp.tBCcap * (isLateral ? params.AREAC : params.AREAB)`. Cite `bjtload.c:573-576`.
  - `czsub` (line 1464): `czsub = tp.tSubcap * (isLateral ? params.AREAB : params.AREAC)`. Cite `bjtload.c:582-585`. **Note the swap** — czsub scales with AREAC under VERTICAL and AREAB under LATERAL; this is the opposite of c4/ctot.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts::BJT_SPICE_L1_PARAM_DEFS` (NPN + PNP) — add `AREAB: { default: 1, description: "Base-area factor" }` and `AREAC: { default: 1, description: "Collector-area factor" }` under `secondary`
  - `createSpiceL1BjtElement` `params` factory — plumb both
  - `load()` line 1225 (c4), line 1458 (ctot), line 1464 (czsub) — replace `params.AREA`-based scaling with the SUBS-branched forms above. Other `params.AREA`-scaled quantities (csat, csubsat, c2, oik, oikr, rbpr, rbpi, gcpr, gepr, xjrb, czbe, xjtf) keep `params.AREA` unchanged — these are all intrinsic-area scalings, not area-subset scalings.
- **Tests**:
  - `bjt.test.ts::SpiceL1 ModelParams::AREAB_default_1` — default is 1
  - `bjt.test.ts::SpiceL1 ModelParams::AREAC_default_1` — default is 1
  - `bjt.test.ts::SpiceL1 ModelParams::paramDefs_include_AREAB_AREAC` — both keys present
  - `bjt.test.ts::BJT L1 AREAB_AREAC::c4_scales_with_AREAB_under_VERTICAL` — `SUBS=1, AREAB=2, AREAC=4, ISC=1e-12`. Drive VBC forward so cbcn fires. Run `load()` twice with AREAB=2 vs AREAB=4 (AREAC fixed). Assert the probe (`s0[CB]` or a stamp-coefficient probe on gmu) scales linearly with AREAB.
  - `bjt.test.ts::BJT L1 AREAB_AREAC::c4_scales_with_AREAC_under_LATERAL` — `SUBS=0`, same probe structure, scales with AREAC.
  - `bjt.test.ts::BJT L1 AREAB_AREAC::czsub_scales_with_AREAC_under_VERTICAL` — `SUBS=1, CJS=1e-12`, tran mode. Probe `s0[CQSUB]` scaling against AREAC (AREAB fixed).
  - `bjt.test.ts::BJT L1 AREAB_AREAC::czsub_scales_with_AREAB_under_LATERAL` — `SUBS=0`, probe scales with AREAB.
- **Acceptance criteria**:
  - Both params added to paramDefs
  - Three compute sites branch on `isLateral`
  - Citations verbatim against bjtload.c lines
  - 7 tests pass

### Task 5.2.9: MODEINITTRAN charge state copy verification (B12)
- **Description**: Verify the MODEINITTRAN state copies at `bjt.ts:1591-1596` (qbe, qbc, qbx, qsub), `:1642-1643` (cqbe, cqbc), and `:1673-1676` (cqbx, cqsub) match `bjtload.c:715-724, 735-740, 764-769`. Refresh citations.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts:1591-1596`, `:1642-1643`, `:1673-1676` — citation refresh at each site
- **Tests**:
  - `bjt.test.ts::BJT L1 MODEINITTRAN::copies_qbe_qbc_qbx_qsub_to_state1` — `cktMode = MODETRAN | MODEINITTRAN`, `CJE=1e-12, CJC=1e-12, CJS=1e-12`. After `load()`, assert `s1[QBE] === s0[QBE]`, likewise for QBC, QBX, QSUB.
  - `bjt.test.ts::BJT L1 MODEINITTRAN::copies_cqbe_cqbc_to_state1` — same ctx, assert `s1[CQBE] === s0[CQBE]`, `s1[CQBC] === s0[CQBC]`.
  - `bjt.test.ts::BJT L1 MODEINITTRAN::copies_cqbx_cqsub_to_state1` — same ctx, assert `s1[CQBX] === s0[CQBX]`, `s1[CQSUB] === s0[CQSUB]`.
- **Acceptance criteria**:
  - Citations refreshed at all three sites
  - 3 tests pass

### Task 5.2.10: cexbc INITTRAN seed + dt guard removal (B15)
- **Description**: Verify the MODEINITTRAN cexbc seed at `bjt.ts:1401-1404` (`s1[CEXBC] = cbe/qb; s2[CEXBC] = s1[CEXBC];`) matches `bjtload.c:531-535`. Wave 5.0.2 removed the `> 0 ? :` papering guard at `bjt.ts:1399` — confirm the direct `ctx.deltaOld[1]` divide is in place. Refresh citations.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts:1401-1404` — citation refresh to `// cite: bjtload.c:531-535 — INITTRAN seeds state1+state2 cexbc to cbe/qb`
  - `src/components/semiconductors/bjt.ts:1406-1411` — citation refresh to `// cite: bjtload.c:536-539 — IIR denom uses deltaOld[1] directly (dctran.c:317 seeds)`
- **Tests**:
  - `bjt.test.ts::BJT L1 excess_phase::initTran_seeds_cexbc_state1_state2` — `cktMode = MODETRAN | MODEINITTRAN`, `PTF=15`, `TF=1e-9`, VBE forward. After `load()` assert `s1[CEXBC] === s2[CEXBC]` and both are non-zero.
  - `bjt.test.ts::BJT L1 excess_phase::uses_deltaOld1_directly` — `cktMode = MODETRAN` (not INITTRAN), `PTF=15`, `TF=1e-9`. Construct two `CKTCircuitContext` instances with `maxTimeStep` of `1e-6` vs `1e-5`. Run `load()` on each (state1 and state2 pre-seeded with identical cexbc values). Assert `s0[CEXBC]` differs between the two runs (proving the IIR denominator actually consumes `deltaOld[1]`).
- **Acceptance criteria**:
  - Citations refreshed
  - Wave 5.0.2's guard deletion verified in place
  - 2 tests pass

### Task 5.2.11: cex uses raw op.cbe verification (B22)
- **Description**: Verify `bjt.ts:1389` (`let cex = cbe; let gex = gbe;`) uses the unmodified `op.cbe` / `op.gbe` — the values returned by `computeSpiceL1BjtOp`, BEFORE the XTF cbeMod modification at lines 1471-1494. The excess-phase block at 1384-1411 executes before the cap block at 1451-1679, so ordering is correct. Matches `bjtload.c:522-524`. Refresh citation.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts:1389` — citation refresh to `// cite: bjtload.c:522-524 — cex/gex use raw cbe/gbe from Gummel-Poon, before XTF modification`
- **Tests**:
  - `bjt.test.ts::BJT L1 excess_phase::cex_is_raw_cbe_not_cbeMod` — construct two L1 elements differing ONLY in XTF (`XTF=0` vs `XTF=10`). Both with `TF=1e-9`, `PTF=15`, VBE forward, tran mode, MODEINITTRAN to seed cexbc from cbe/qb. Assert `s1[CEXBC]` from the XTF=0 run equals `s1[CEXBC]` from the XTF=10 run to IEEE-754 precision — the seed is `cbe/qb` (raw), so XTF cannot affect it. Divergence indicates cex is being populated from the XTF-modified cbeMod.
- **Acceptance criteria**:
  - Citation refreshed
  - Bit-exact CEXBC equality between XTF=0 and XTF=10 seeds

### Task 5.2.12: XTF=0 gbe adjustment verification (F-BJT-ADD-21)
- **Description**: Verify `bjt.ts:1474-1494` runs `cbeMod = cbe*(1+argtf)/qb` and `gbeMod = (gbe*(1+arg2) - cbeMod*dqbdve)/qb` whenever `tf !== 0 && vbeLimited > 0`, with `argtf = arg2 = arg3 = 0` when XTF=0. Matches `bjtload.c:591-610`. Refresh citation.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts:1474` — citation refresh to `// cite: bjtload.c:591-610 — cbeMod/gbeMod compute unconditionally when tf>0 && vbe>0; XTF=0 collapses argtf=arg2=0`
- **Tests**:
  - `bjt.test.ts::BJT L1 XTF_zero::cbeMod_computed_when_tf_nonzero_xtf_zero` — `TF=1e-9`, `XTF=0`, VBE forward, tran mode. Probe: `s0[QBE]` after `load()` is `TF * (cbe/qb) + czbe * sarg`-shaped (non-zero; differs from the `TF=0` baseline). Not a bit-exact assertion — a monotonic positive-check.
  - `bjt.test.ts::BJT L1 XTF_zero::cbeMod_skipped_when_tf_zero` — `TF=0`, `XTF=0`. Assert `s0[QBE]` after `load()` equals the DC-component-only value (`capbe = czbe * sarg` in the `if (vbe < fcpe)` branch, QBE=pe*czbe*(1-arg*sarg)/(1-xme)) — i.e., no transit-time contribution.
- **Acceptance criteria**:
  - Citation refreshed
  - 2 tests pass

### Task 5.2.13: geqsub Norton aggregation verification (F-BJT-ADD-23)
- **Description**: Verify `bjt.ts:1700` (`const geqsub = gcsub + gdsub;`) and all substrate Norton stamps (`:1709, :1712, :1734, :1756-1759`) use `geqsub` as a single aggregate. Matches `bjtload.c:798-800, 810, 814, 823, 838-840`. Refresh citations.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts:1700`, `:1709`, `:1712`, `:1734`, `:1756-1759` — citation refresh
- **Tests**:
  - `bjt.test.ts::BJT L1 substrate::geqsub_aggregates_gcsub_gdsub` — `CJS=1e-12`, `ISS=1e-14`, tran mode, vsub forward. Wrap stampG with coefficient-capturing probe. Call `load()`. Assert the stamp coefficient at `(substConNode, substConNode)` equals `m * (gcsub + gdsub)` where gcsub and gdsub are read from `s0[GCSUB]` and `s0[GDSUB]` after `load()`. Single aggregated stamp, not two sequential stamps.
- **Acceptance criteria**:
  - Citations refreshed
  - Test passes

### Task 5.2.14: Cap block gating verification (F-BJT-ADD-25)
- **Description**: Verify `bjt.ts:1447-1449` gate (`(MODETRAN | MODEAC) || (MODETRANOP && MODEUIC) || MODEINITSMSIG`) matches `bjtload.c:561-563`. Refresh citation.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts:1447` — citation refresh to `// cite: bjtload.c:561-563 — cap block gate`
- **Tests**:
  - `bjt.test.ts::BJT L1 cap_block::skipped_under_pure_dcop` — `cktMode = MODEDCOP`, `CJE=1e-12, CJC=1e-12`, VBE forward. Assert `s0[QBE] === 0` after `load()` (cap block didn't fire).
  - `bjt.test.ts::BJT L1 cap_block::entered_under_MODETRAN` — `cktMode = MODEDCOP | MODETRAN`, `CJE=1e-12`. Assert `s0[QBE] > 0`.
  - `bjt.test.ts::BJT L1 cap_block::entered_under_MODETRANOP_MODEUIC` — `cktMode = MODETRANOP | MODEUIC`, `CJE=1e-12`. Assert `s0[QBE] > 0`.
  - `bjt.test.ts::BJT L1 cap_block::entered_under_MODEINITSMSIG` — `cktMode = MODEINITSMSIG`, `CJE=1e-12`. Assert `s0[CQBE] > 0` (smsig stores cap values).
- **Acceptance criteria**:
  - Citation refreshed
  - 4 tests pass

### Task 5.2.15: VSUB limiting collector entry (F-BJT-ADD-34)
- **Description**: Extend the existing BE + BC LimitingEvent pushes at `bjt.ts:1327-1346` with a third push for the substrate junction (`vsubRaw → vsubLimited` with `wasLimited: vsubLimFlag`). Conditional on `ctx.limitingCollector != null`, matching the existing pattern. H1 (Phase 2.5) wires cktLoad → ctx.limitingCollector sync.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts::createSpiceL1BjtElement::load()` — after the BC push (around line 1346), add a third `ctx.limitingCollector.push({ elementIndex, label, junction: "SUB", limitType: "pnjlim", vBefore: vsubRaw, vAfter: vsubLimited, wasLimited: vsubLimFlag })`
- **Tests**:
  - `bjt.test.ts::BJT L1 LimitingEvent::pushes_SUB_event_when_collector_present` — `collector: LimitingEvent[] = []`, `ISS=1e-14`, vsub forward strong enough to trigger pnjlim. Call `load()`. Assert `collector.some(e => e.junction === "SUB" && e.limitType === "pnjlim")`. Assert the event carries `elementIndex`, `label`, finite `vBefore` and `vAfter`, boolean `wasLimited`.
  - `bjt.test.ts::BJT L1 LimitingEvent::no_SUB_event_when_collector_null` — `collector: null`, same conditions. Assert `load()` does not throw.
- **Acceptance criteria**:
  - SUB event pushed when collector present
  - No throw when collector null
  - 2 tests pass

---

---

## Wave 5.3: BJT per-instance TEMP parameter

Runs in parallel with Waves 5.1 and 5.2 after Wave 5.0. Touches `bjt.ts` in different regions (param defs, factory, `computeBjtTempParams` signature, `TEMP` recompute wiring) from the `load()`-body edits of 5.1/5.2, so merges cleanly. Mirrors Phase 6 Task 6.2.9 (MOSFET M-9) for the BJT L0 + L1 model pair.

ngspice reality: `bjttemp.c` reads per-instance `BJTtemp` (default = `CKTtemp`, overridable via `.MODEL ... TEMP=` or `.TEMP`). digiTS currently hardcodes `REFTEMP` at the top of `computeBjtTempParams` and defaults the function's `T: number = 300.15` parameter at every call site — the instance-level temperature is not configurable.

### Task 5.3.1: Add TEMP to BJT_PARAM_DEFS (NPN + PNP)

- **Description**: Declare `TEMP` as a first-class per-instance param on both NPN and PNP BJT variants, default 300.15 K. Add to `BJT_PARAM_DEFS` under `secondary` with description `"Per-instance operating temperature"`, unit `"K"`.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts::BJT_PARAM_DEFS` — add `TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature" }` under the `secondary` group. Applies to both `createBjtElement` (L0) and `createSpiceL1BjtElement` (L1) — shared defs.
  - `BJT_NPN_DEFAULTS` / `BJT_PNP_DEFAULTS` — add `TEMP: 300.15` (if per-polarity defaults are declared separately).
- **Tests**:
  - `bjt.test.ts::BJT TEMP::TEMP_default_300_15` — after `makeBjtProps()`, `propsObj.getModelParam<number>("TEMP") === 300.15`.
  - `bjt.test.ts::BJT TEMP::paramDefs_include_TEMP` — `BJT_PARAM_DEFS.map(pd => pd.key)` contains `"TEMP"`.
  - `bjt.test.ts::BJT TEMP::setParam_TEMP_no_throw` — `element.setParam("TEMP", 400)` doesn't throw.
- **Acceptance criteria**:
  - `TEMP` declared with rank `secondary`, default `300.15`, unit `"K"` on both NPN and PNP defs.
  - 3 tests pass.

### Task 5.3.2: Thread `TEMP` through `computeBjtTempParams`

- **Description**: Replace the `T: number = 300.15` default parameter at `bjt.ts:335` with required positional param sourced from `params.TEMP`. Inside the function, the `T` variable already drives `vt = T * KoverQ`, `fact2 = T / REFTEMP`, `egfet = 1.16 - (7.02e-4*T*T)/(T+1108)`, and every `(T - REFTEMP)` / `(T/p.TNOM)` expression — no internal algorithm change, just signature hygiene. `p.TNOM` continues to drive the model-nominal reference (untouched). The `1.1150877 / (k * (REFTEMP + REFTEMP))` constant stays pegged to `REFTEMP` per `bjttemp.c:64-65` (that is the model-level egnom reference at 300.15 K, not the instance temperature).
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts` — `computeBjtTempParams` signature: drop `T: number = 300.15` default, keep positional `T: number`. Add `TEMP: number` to the input-shape type on the `p` parameter.
  - `createBjtElement` `params` factory — add `TEMP: props.getModelParam<number>("TEMP")` to the resolved params object.
  - `createSpiceL1BjtElement` `params` factory — same addition.
  - Every `makeTp()` / `computeBjtTempParams(params, T)` call site inside L0 and L1 factories — replace the literal `REFTEMP` / `300.15` arg with `params.TEMP`.
- **Tests**:
  - `bjt.test.ts::BJT TEMP::tp_vt_reflects_TEMP` — construct L0 NPN with `TEMP=400`, assert `tp.vt` approximately equals `400 * KoverQ` (≈ 0.03447 V).
  - `bjt.test.ts::BJT TEMP::tSatCur_scales_with_TEMP` — construct L1 NPN with `IS=1e-16, XTI=3, EG=1.11, TNOM=300.15`. Build at `TEMP=300.15` and `TEMP=400`. Assert `tp.tSatCur(400) > tp.tSatCur(300.15)` by the `exp(factlog)` ratio, not bit-exact.
  - `bjt.test.ts::BJT TEMP::TNOM_stays_nominal` — construct BJT with `TEMP=400, TNOM=300.15`; assert `tp.tBetaF` reflects the `T/TNOM` ratio in `bfactor = exp(ratlog * XTB)` (`ratlog = log(400/300.15)`).
- **Acceptance criteria**:
  - `computeBjtTempParams` no longer has a defaulted `T` arg.
  - Every caller passes `params.TEMP` explicitly.
  - 3 tests pass.

### Task 5.3.3: Drop `ctx.vt` audit (L0 + L1 `load()`)

- **Description**: L0 and L1 `load()` already read `tp.vt` at every pnjlim and transcendental-function site (verified at `bjt.ts:864, 867, 1221`). This task is a belt-and-braces audit: grep `bjt.ts` for any lingering `ctx.vt` reads inside `createBjtElement::load()` or `createSpiceL1BjtElement::load()` — there should be zero. If a future drift introduces `ctx.vt` into BJT, the audit test below fails loudly.
- **Files to modify**: none (audit-only) unless drift found.
- **Tests**:
  - `bjt.test.ts::BJT TEMP::no_ctx_vt_read_in_bjt_ts` — test-time `fs.readFileSync` on `bjt.ts`; assert the string `"ctx.vt"` appears zero times in the file (the file's imports do not reference `ctx.vt`).
- **Acceptance criteria**:
  - No `ctx.vt` occurrence in `bjt.ts`.
  - All L0 and L1 pnjlim + exponential sites use `tp.vt`.
  - 1 test passes.

### Task 5.3.4: `setParam('TEMP', …)` recomputes `tp`

- **Description**: Verify that `setParam('TEMP', newT)` triggers a `computeBjtTempParams` recompute for both L0 and L1 elements, so that the next `load()` reflects the new temperature. The existing generic `setParam` branch in `bjt.ts` dispatches to the resolved param object and recomputes derived values when the param is marked as `rebuildTpOnSet: true` (or equivalent plumbing). If `TEMP` does not trigger recompute with existing plumbing, mark it explicitly.
- **Files to modify**:
  - `src/components/semiconductors/bjt.ts::createBjtElement::setParam` — ensure `TEMP` routes through `makeTp()` after the param update.
  - `createSpiceL1BjtElement::setParam` — same.
- **Tests**:
  - `bjt.test.ts::BJT TEMP::setParam_TEMP_recomputes_tp_L0` — construct L0 NPN at default `TEMP=300.15`, capture `tp.vt`, call `element.setParam("TEMP", 400)`, invoke one `load()` iteration, assert the pnjlim call now uses `vt(400)`. Probe: set a cold state, drive a step that triggers pnjlim, read `s0[SLOT_VBE]` post-limit — it should match the 400K pnjlim output, not the 300.15K output.
  - `bjt.test.ts::BJT TEMP::setParam_TEMP_recomputes_tp_L1` — same structure for L1.
- **Acceptance criteria**:
  - `setParam('TEMP', newT)` causes the next `load()` to read `tp.vt` at the new temperature for both L0 and L1.
  - 2 tests pass.

**Commit:** `Phase 5.3 — BJT per-instance TEMP parameter`

---

## Acceptance gate for Phase 5

Per `spec/plan.md` §Verification:

> Phase 5 done: F-BJT targeted tests run; BJT L0 and L1 `load()` mirror `bjtload.c` sections including NOBYPASS bypass, MODEINITJCT 3-branch priming, MODEINITSMSIG return, MODEINITTRAN state seeding, excess-phase `cex` uses raw `opIf`.

Phase 5 is complete when:

1. All tests listed above pass under `npx vitest run src/components/semiconductors/__tests__/bjt.test.ts` and `npx vitest run src/solver/analog/__tests__/ckt-context.test.ts`.
2. Every `// cite: bjtload.c:NNN` comment in `bjt.ts` introduced or refreshed by Phase 5 describes the ngspice code immediately following the comment — verified by sampling (any agent can run this audit).
3. `ctx.deltaOld[1] > 0 ? :` guard is deleted from `bjt.ts`.
4. `isLateral` branching is present at the three area-scaling sites.
5. `ctx.bypass` and `ctx.voltTol` are used by both L0 and L1 `load()` bypass gates.
6. No `1.5` or `2.0` literal for NE/NC remains in L0 `load()` / `makeTp()` / `computeBjtOp` call sites.
7. `TEMP` is a first-class per-instance param on both NPN and PNP BJT param defs with default 300.15 K. `computeBjtTempParams` accepts `T` from `params.TEMP` at every call site; `setParam('TEMP', …)` recomputes `tp` for both L0 and L1; grep of `bjt.ts` for `ctx.vt` returns zero hits.

Bit-exact per-NR-iteration parity against ngspice for BJT circuits is Phase 10's gate (wave 10.1.3 common-emitter), not Phase 5's. Phase 5 establishes the structural alignment; Phase 10 measures numerical parity against ngspice on the 8 acceptance circuits.
