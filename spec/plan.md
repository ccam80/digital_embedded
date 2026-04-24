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
3. The cited ngspice source file(s) at the line ranges listed in each task
4. `CLAUDE.md` — banned closing verdicts (*mapping*, *tolerance*, *close enough*, *equivalent to*, *pre-existing*, *intentional divergence*, *citation divergence*, *partial*)

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

- **Phase 0 done:** `spec/phase-0-residual-dead-code-audit.md` all three waves complete. `derivedNgspiceSlots` + readers deleted; historical doc-comment residue stripped; tunnel-diode and LED cross-method slots collapsed to `load()` locals; `DigitalPinModel` refactored to use `AnalogCapacitorElement` as a child for `cOut`/`cIn` companion. `phase-0-identifier-audit.test.ts` passes green with the allowlist exactly matching `spec/phase-0-audit-report.md`.
- **Phase 3 done:** F2 targeted tests run against `newton-raphson`, `analog-engine`, `diode`, `bjt`; xfact predictor formula present in diode + BJT (L0 and L1) `load()`; forceReorder() gated at NR loop top per `niiter.c:856-859`; `IntegrationMethod` collapsed to ngspice's `"trapezoidal" | "gear"` (cktdefs.h:107-108) with `"bdf1"` / `"bdf2"` / `"auto"` deleted from live code, tests, and the public `SimulationParams` surface; behavioral relay coil inductor rewritten as a composite-child `AnalogInductorElement`; Phase 0 identifier audit extended with three banned-literal rules.
- **Phase 4 done:** F5 residual fixes landed — `fetlim` `vtstlo` coefficient matches `devsup.c:102`; LED initJct skip + collector push present; BJT L1 substrate pnjlim call verified.
- **Phase 5 done:** F-BJT targeted tests run; BJT L0 and L1 `load()` mirror `bjtload.c` sections including NOBYPASS bypass, MODEINITJCT 3-branch priming, MODEINITSMSIG return, MODEINITTRAN state seeding, excess-phase `cex` uses raw `opIf`; `LoadContext.bypass` and `LoadContext.voltTol` present with ngspice defaults; `ctx.deltaOld[1] > 0 ? :` guard deleted from `bjt.ts`; `isLateral` branching at the three SUBS-dependent area-scaling sites; first-class `TEMP` param on both NPN and PNP BJT param defs (default 300.15 K) threaded through `computeBjtTempParams` with `tp.vt` replacing every thermal-voltage site; grep of `bjt.ts` for `ctx.vt` returns zero hits.
- **Phase 6 done:** F-MOS targeted tests run; MOSFET `load()` mirrors `mos1load.c` including M-1 predictor limiting routing, MODEINITSMSIG general-iteration path, IC params (ICVDS/ICVGS/ICVBS), NOBYPASS bypass (precondition: `ctx.bypass` + `ctx.voltTol` landed by Phase 5 Wave 5.0.1), `CKTfixLimit` gate on reverse `limvds`, first-class `TEMP` param threaded through `computeTempParams` with `tp.vt` replacing `ctx.vt` in `load()`, q-predictor xfact extrapolation, MODEINITFIX+OFF zero-branch, `primeJunctions()` + `primedFromJct` closure var + consume-seed branch deleted (MODEINITJCT in-`load()` 3-branch priority is sole priming path). Full phase spec: `spec/phase-6-f-mos-mosfet-mos1-alignment.md`.
- **Phase 7 done:** smoke tests run; NJFET and PJFET `load()` mirror `jfetload.c` NR convergence machinery — 9-slot MODEINITPRED state1→state0 copy, `delvgs/delvgd/cghat/cdhat` extrapolation feeding the noncon gate with verbatim `>=`/`>` asymmetry, NOBYPASS 4-tolerance bypass block with four-level nested `if` preserved, `primeJunctions()` deleted (MODEINITJCT in-`load()` priority is sole priming path), inline fetlim replaced by the Phase 4 shared helper, noncon-gate comment corrected; first-class `TEMP` param on both NJFET and PJFET param defs (default 300.15 K) threaded through `computeJfetTempParams` (replaces pinned `const temp = REFTEMP`); grep of `njfet.ts` + `pjfet.ts` for `ctx.vt` and `const temp = REFTEMP` each return zero hits. PJFET remains self-contained per D-10 — every edit hand-mirrored with `-1` polarity literal.
- **Phase 7.5 done:** targeted tests run per-device; diode, zener, LED, SCR, tunnel-diode each expose first-class `TEMP` as a secondary param (default 300.15 K) with `computeTempParams` / factory plumbing threading `params.TEMP` end-to-end; zener's and SCR's `primeJunctions()` methods deleted with MODEINITJCT in-`load()` taking over priming; `dc-operating-point.ts:322-325` primeJunctions loop deleted; `primeJunctions?(): void;` member removed from `analog-types.ts` + `element.ts`; `src/` grep for `primeJunctions` returns zero hits outside `spec/` + `ref/ngspice/`; `src/components/` grep for `const temp = REFTEMP` and `const circuitTemp = REFTEMP` each return zero hits. Full phase spec: `spec/phase-7.5-f-residual-temp-primejunctions.md`.
- **Phase 8 done:** `spec/ngspice-citation-audit.md` exists; priority-list citations in `dc-operating-point.ts`, `newton-raphson.ts`, `analog-types.ts` verified against ngspice source.
- **Phase 9 done:** Repo-wide grep for every removed identifier returns zero hits outside `ref/ngspice/` and `spec/`; full suite `npm test` runs.
- **Phase 10 done:** Each of the 8 acceptance circuits produces IEEE-754 bit-identical per-NR-iteration `rhsOld[]` vs ngspice. D-8 MOSFET `cgs_cgd_transient` closed (via MOSFET inverter circuit's acceptance evidence).

## Dependency Graph

```
Phase 0 (Residual Dead Code Audit)                   ─── runs first, alone
  │
Phase 3 (F2 — NR reorder + xfact: diode + BJT)       ─── after 0
  │
Phase 4 (F5 — Residual limiting fixes)               ─── after 3
  │
  ├──→ Phase 5 (F-BJT L0 + L1)           ─── parallel after 4 ──┐
  ├──→ Phase 6 (F-MOS MOS1)              ─── parallel after 4    │
  ├──→ Phase 7 (F5ext-JFET)              ─── parallel after 4    │
  └──→ Phase 7.5 (F-RESIDUAL: dio/zen/   ─── parallel after 4 ───┤
        led/scr/tunnel-diode TEMP +      (Wave 7.5.6 serialised  │
        primeJunctions cleanup)           after Phases 6, 7,     │
                                          7.5.2, 7.5.4 land)     │
  │                                                              │
Phase 8 (F6 — docs & citation audit)                 ─── after 5+6+7+7.5
  │
Phase 9 (Legacy reference review + full suite)       ─── after 8
  │
Phase 10 (8-Circuit bit-exact ngspice parity)        ─── after 9
```

**Serialization rationale:**

- **0 first** — clean tree before any phase agent reads context. Phase 2.5 already scrubbed most of the identifier list; Phase 0 is the belt-and-braces verification.
- **3 before 4** — Phase 3 lands xfact in diode + BJT `load()`; Phase 4's BJT substrate audit reads those xfact branches.
- **4 before 5/6/7/7.5** — Phase 4 delivers the last shared limiting primitive fixes (`fetlim` coefficient) that BJT / MOSFET / JFET (and transitively diode, zener, LED via `pnjlim`) all call.
- **5/6/7/7.5 parallel** — disjoint device files. Phase 5 owns `bjt.ts`, Phase 6 owns `mosfet.ts`, Phase 7 owns `njfet.ts` + `pjfet.ts`, Phase 7.5 owns `diode.ts` + `zener.ts` + `led.ts` + `scr.ts` + `tunnel-diode.ts`. All post-A1 `load()` edits; no cross-device shared state.
- **Phase 7.5 Wave 7.5.6 serialised** — the `dc-operating-point.ts:322-325` primeJunctions call-site deletion + interface-member deletion must wait until every implementer is gone: MOSFET (Phase 6 Task 6.1.4), NJFET + PJFET (Phase 7 Task 7.1.4), zener (Phase 7.5 Wave 7.5.2), SCR (Phase 7.5 Wave 7.5.4). Waves 7.5.1 through 7.5.5 can commit in any order once Phase 4 lands.
- **8 after 5/6/7/7.5** — citation text must reflect final state of the code. Running earlier risks stale line-number citations.
- **9 after 8** — full-suite run is meaningful only after all phases' code changes land.
- **10 after 9** — acceptance harness runs against a stable, full-suite-passing tree. Bit-exact comparison against ngspice requires every upstream fix in place; the user has flagged that running acceptance while engine bugs remain produces misleading failures. Phase 10 is gated behind a clean Phase 9.

---

## Phase 0: Residual Dead Code Audit
**Depends on:** (none — runs first)
**Detailed spec:** `spec/phase-0-residual-dead-code-audit.md`.

Close out three classes of residue left after Phase 2.5: dead harness infrastructure (`derivedNgspiceSlots`), historical doc-comment residue referencing A1-deleted identifiers, and A1-rule leakage in non-ngspice devices (`tunnel-diode.ts`, `led.ts`, `DigitalPinModel`). Also ship the identifier-audit vitest that Phase 9.1.1 reuses as its final sweep.

Coupled-inductor dead code (`CoupledInductorState`, `createState`) was already removed during Phase 2.5 W4.B.5; verified zero hits under `src/solver/analog/coupled-inductor.ts` at plan-authoring time. The historical-note comment inside that file is stripped in Wave 0.1.2.

### Wave 0.1: Dead-code deletion

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 0.1.1 | Delete `DerivedNgspiceSlot` interface + `DeviceMapping.derivedNgspiceSlots` field + 3 reader branches; tighten `device-mappings.ts` module header. Zero populators exist; the escape hatch contradicts the module's own "no formulas" docstring. | S | `src/solver/analog/__tests__/harness/types.ts`, `device-mappings.ts`, `ngspice-bridge.ts`, `compare.ts`, `src/solver/analog/__tests__/ngspice-parity/parity-helpers.ts`, `harness-integration.test.ts` |
| 0.1.2 | Strip historical doc-comment residue referencing A1-deleted identifiers (`_updateOp`, `_stampCompanion`, `InitMode` type, deleted `SLOT_*` lists, `CoupledInductorState`/`createState`, pre-Phase-2.5 `VARACTOR_STATE_SCHEMA` layout, `Math.min(vd/nVt, 700)` deletion notes) from ~15 production + test files. Comment-only edits, no logic changes. | S | BJT/MOSFET/NJFET/PJFET/varactor/coupled-inductor `.ts`; multiple `__tests__/*.test.ts`; `harness/device-mappings.ts` comment |

### Wave 0.2: A1 leakage fixes

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 0.2.1 | Collapse tunnel-diode cross-method slots. Delete `SLOT_CAP_GEQ`, `SLOT_CAP_IEQ`, `SLOT_V` (redundant with `SLOT_VD`); compute `capGeq`/`capIeq` as `load()` locals. Cap-variant schema 9 → 6 slots. `SLOT_Q`, `SLOT_CCAP` retained as legitimate NIintegrate history. | S | `src/components/semiconductors/tunnel-diode.ts`, `__tests__/tunnel-diode.test.ts` |
| 0.2.2 | Same collapse applied to LED (identical slot layout, identical cross-method write pattern). | S | `src/components/io/led.ts`, `__tests__/led.test.ts` |
| 0.2.3 | Refactor `DigitalPinModel` — delete `_prevVoltage`, `_prevCurrent`, the `accept()` methods, and the inline `cOut`/`cIn` companion blocks. Each pin model exposes `getChildElements()` returning `[AnalogCapacitorElement]` when loaded and the capacitance is positive. 15+ owning elements (dac, adc, comparator, schmitt-trigger, timer-555, bridge-adapter, behavioral-gate/combinational/sequential/flipflop + 6 variants, behavioral-remaining) aggregate child elements into their own state-pool layout and `load()` dispatch per the `TransmissionLineElement` composite pattern. Eliminates per-object integration state and the `q0 = q1 = C * _prevVoltage` companion bug. | L | `src/solver/analog/digital-pin-model.ts`, `bridge-adapter.ts`, `behavioral-*.ts`, `behavioral-flipflop/*.ts`, `src/components/active/{dac,adc,comparator,schmitt-trigger,timer-555}.ts`, `digital-pin-model.test.ts`, `behavioral-integration.test.ts` |

### Wave 0.3: Identifier-audit test + report

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 0.3.1 | Author `phase-0-identifier-audit.test.ts` — manifest-driven vitest walking `src/`, `scripts/`, `e2e/` (excluding `node_modules`, `dist`, `ref/ngspice`, `spec`, `.git`), asserts zero unexpected hits across the full banned-identifier manifest. Allowlist entries carry per-hit reason strings; a stale-allowlist check catches drift. Reused by Phase 9.1.1. | M | `src/solver/analog/__tests__/phase-0-identifier-audit.test.ts` (new) |
| 0.3.2 | Author `spec/phase-0-audit-report.md` — per-identifier resolution table (absent / deleted-in-Phase-0 / allowlisted with reason), narrative companion to the audit test's manifest. | S | `spec/phase-0-audit-report.md` (new) |

**Commits (one per wave):** `Phase 0.1 — delete derivedNgspiceSlots + strip historical doc residue`, `Phase 0.2 — collapse tunnel-diode/LED cross-method slots + DigitalPinModel AnalogCapacitorElement child`, `Phase 0.3 — identifier-audit vitest + phase-0 audit report`.

---

## Phase 3: F2 — NR Reorder Gate + Per-Device xfact Predictor (diode + BJT)
**Depends on:** Phase 0
**Detailed spec:** `spec/phase-3-f2-nr-reorder-xfact.md`

Targeted tests: `newton-raphson`, `analog-engine`, `diode`, `bjt` unit/integration suites under `src/solver/analog/__tests__/` and `src/components/semiconductors/__tests__/`; ngspice comparison harness for per-NR parity on diode / BJT transients.

**Scope narrowing post-A1:** xfact predictor lives inside each device's unified `load()`. References to line numbers against the old `_updateOp` split are replaced with references to the device's post-A1 `load()` body. MOSFET and JFET xfact are in Phases 6 / 7 respectively (device-specific).

**Corrections applied 2026-04-24** during phase-3 spec authoring:
- Task 3.1.1 re-expressed as verify-only. Phase 2.5 Wave 2.1 (B5) already landed the pre-factor `NISHOULDREORDER` gate at `newton-raphson.ts:337-357` with the exact `MODEINITJCT || (MODEINITTRAN && iteration === 0)` condition and `niiter.c:856-859` citation. The original Task 3.1.1 wording "insert `solver.forceReorder()`" is struck; Task 3.1.1 now asserts the landed gate by test.
- Task 3.1.2 citation target corrected. The original `niiter.c:474-499` reference is struck as a plan authoring error — that ngspice range is unrelated (tail of `ni_check_convergence` + start of `ni_send_topology`). The correct citations are `niiter.c:888-891` for the existing E_SINGULAR retry `forceReorder()` at `newton-raphson.ts:396` (already cited in place) and `cktop.c:<lines>` for the MODEINITJCT→MODEINITFIX transition `forceReorder()` at `dc-operating-point.ts:567` (currently uncited, added by Task 3.1.2).
- Task 3.2.4 narrowed to `SLOT_VSUB` state-copy only. The original `SLOT_RB_EFF` reference is struck as a plan authoring error — no such slot exists in `BJT_L1_SCHEMA`; the effective base resistance is a `load()`-local (`rbpr` / `rbpi`) post-A1.
- Plan's "route predicted voltages through the pnjlim-skip path" direction for Tasks 3.2.1 / 3.2.2 / 3.2.3 is struck. Independent ngspice re-verification against `dioload.c:139-205` and `bjtload.c:276-416` confirmed pnjlim runs on the MODEINITPRED-extrapolated voltage in both devices — the only `!(MODEINITPRED)` guards in those regions wrap the `#ifndef NOBYPASS` bypass test, not the `DEVpnjlim` call. Phase 3 aligns with ngspice: pnjlim runs on the extrapolated `vdRaw` / `vbeRaw` / `vbcRaw` / `vsubRaw`. Diode's current pnjlim skip mask is already correct (MODEINITPRED not present); BJT L0 (`bjt.ts:862`) and L1 (`bjt.ts:1310`) both require removal of `MODEINITPRED` from their skip masks as part of Tasks 3.2.2 and 3.2.3 respectively.
- Wave 3.3 added (IntegrationMethod ngspice alignment) — surfaced by Phase 0 review as item "L-1: IntegrationMethod type invents non-ngspice methods". Upstream review error corrected: ngspice `cktdefs.h:107-108` defines `TRAPEZOIDAL = 1` and `GEAR = 2` (not `0` / `1` as the review stated). Wave 3.3 collapses the `IntegrationMethod` type to `"trapezoidal" | "gear"`; deletes the dedicated `"bdf2"` branch in `integration.ts` (order 2 routes through `solveGearVandermonde` under `method === "gear"`); deletes `"auto"` from the public API (never resolved anywhere — a silent invention); rewrites the behavioral relay coil inductors (`behavioral-remaining.ts:624-651, 734-753`) to delegate integration to child `AnalogInductorElement` instances via the composite-child pattern landed in Phase 0 Wave 0.2.3; extends `phase-0-identifier-audit.test.ts` with three banned-literal rules (`"bdf1"`, `"bdf2"`, `integrationMethod: "auto"`). Sequenced after Wave 3.2 and before Phase 4 so downstream device phases (5 / 6 / 7 / 7.5) port device `load()` bodies against the ngspice-correct method set on first contact.

### Wave 3.1: NR reorder timing

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.1.1 | **Verify-only — NR loop-top `forceReorder()` gate.** Phase 2.5 Wave 2.1 (B5) landed the pre-factor `NISHOULDREORDER` gate at `newton-raphson.ts:337-357` with exact `MODEINITJCT || (MODEINITTRAN && iteration === 0)` condition and `niiter.c:856-859` citation. Task 3.1.1 asserts by test: gate fires on the two relevant mode combinations, does not fire on MODEINITFLOAT / MODEINITFIX, and `forceReorder()` precedes `factor()` in call order. Zero production-code changes. | S | (test-only) `src/solver/analog/__tests__/phase-3-nr-reorder.test.ts` |
| 3.1.2 | **Citation hygiene for non-top-of-loop `forceReorder()` sites.** Verify the existing `niiter.c:888-891` citation at `newton-raphson.ts:391-398` (E_SINGULAR retry). Add a `cktop.c:<lines>` citation comment above the `forceReorder()` at `dc-operating-point.ts:567` (MODEINITJCT→MODEINITFIX transition). Localize the exact `cktop.c` line range against `ref/ngspice/src/spicelib/analysis/cktop.c` — if no matching block is found, STOP and escalate per governing principle §9 (do not invent a citation, do not redirect to `niiter.c`). | S | `src/solver/analog/dc-operating-point.ts`, `src/solver/analog/newton-raphson.ts` (audit), `src/solver/analog/__tests__/phase-3-nr-reorder.test.ts` |

### Wave 3.2: Device xfact predictor — diode + BJT

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.2.1 | **Diode xfact.** Replace the current MODEINITPRED state-copy-only block in `diode.ts::load()` with an explicit `if (mode & MODEINITPRED) { s1→s0 copies for SLOT_VD/SLOT_ID/SLOT_GEQ; vdRaw = (1 + ctx.xfact) * s1[SLOT_VD] - ctx.xfact * s2[SLOT_VD]; } else { rhsOld read }` two-way split. The existing pnjlim skip mask at `diode.ts:540` is already correct (MODEINITPRED absent) — pnjlim runs on the extrapolated `vdRaw` per `dioload.c:183-204`. Cite `dioload.c:141-152` for the copy + DEVpred + rhsOld-fallthrough structure. | M | `src/components/semiconductors/diode.ts` |
| 3.2.2 | **BJT L0 xfact + pnjlim skip-mask fix.** Replace the MODEINITPRED block in `createBjtElement::load()` at `bjt.ts:839-846` with state-copy + `(1+xfact)*s1 - xfact*s2` extrapolation for `vbeRaw` / `vbcRaw`. **Remove `MODEINITPRED` from the pnjlim skip mask at `bjt.ts:862`** so pnjlim runs on the extrapolated values per `bjtload.c:386-414` (ngspice has no MODEINITPRED skip on DEVpnjlim; the `!(MODEINITPRED)` guard at `bjtload.c:347` wraps bypass only). Cite `bjtload.c:278-287`. | M | `src/components/semiconductors/bjt.ts` |
| 3.2.3 | **BJT L1 xfact + pnjlim skip-mask fix.** Replace the MODEINITPRED block in `createSpiceL1BjtElement::load()` at `bjt.ts:1287-1294` with state-copy + xfact extrapolation for `vbeRaw` / `vbcRaw` / `vsubRaw`, then unconditionally re-read `vbxRaw` and `vsubRaw` from rhsOld at the end of the MODEINITPRED branch (matches `bjtload.c:325-330`'s unconditional recompute that overwrites the :304-305 vsub extrapolation — verbatim port, not optimized). **Remove `MODEINITPRED` from the pnjlim skip mask at `bjt.ts:1310`** so pnjlim runs on all three extrapolated voltages (BE, BC, VSUB) per `bjtload.c:386-414`. Cite `bjtload.c:278-330`. | M | `src/components/semiconductors/bjt.ts` |
| 3.2.4 | **BJT L1 VSUB state-copy verification.** Task 3.2.3 already adds the `s0[base + SLOT_VSUB] = s1[base + SLOT_VSUB]` copy inside the MODEINITPRED branch. Task 3.2.4 is a standalone regression guard asserting that state-copy exists after Task 3.2.3 lands. The original `SLOT_RB_EFF` reference is struck — no such slot in `BJT_L1_SCHEMA`. | S | (test-only) `src/components/semiconductors/__tests__/phase-3-xfact-predictor.test.ts` |
| 3.2.5 | **xfact scope audit.** Manifest-driven vitest asserting every `.xfact` / `ctx.xfact` read in `src/components/` and `src/solver/analog/` is gated by `(ctx.cktMode & MODEINITPRED) !== 0`. Allowlist contains exactly one entry (`analog-engine.ts:430` — the engine-side `ctx.loadCtx.xfact = deltaOld[0] / deltaOld[1]` WRITE). Expected production reads after Phase 3: 1 (diode) + 2 (BJT L0) + 3 (BJT L1). Any new unguarded read fails the audit. | S | `src/solver/analog/__tests__/phase-3-xfact-scope-audit.test.ts` (new), `src/components/**/*.ts`, `src/solver/analog/*.ts` |

### Wave 3.3: IntegrationMethod ngspice alignment

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.3.1 | **Collapse `IntegrationMethod` to `"trapezoidal" \| "gear"` and delete bdf1 / bdf2 in core + solver primitives.** Narrow the type at `analog-types.ts:23` (cite `cktdefs.h:107-108` with correct values `TRAPEZOIDAL=1`, `GEAR=2`); delete the `integration.ts:314-328` bdf2 branch and the trailing BDF-1 fallback at lines 331-335 (order 1 regardless of method uses trap-1 per `nicomcof.c:40-41`; order 2..6 under `"gear"` routes through `solveGearVandermonde`); collapse `ni-integrate.ts:38` dispatch to `else if (method === "gear")`; strip "bdf1/bdf2 alias" comments in `ni-pred.ts`; update `ckt-terr.ts:88` doc-comment; replace `"bdf1"` → `"trapezoidal"` literals in DCOP synthetic records at `analog-engine.ts:815, 816, 823`; delete `convergence-log-panel.ts:115-116` bdf1/bdf2 label cases; delete misleading "backwards compatibility" comment at `load-context.ts:87-91`. Remap `"bdf1"` → `"trapezoidal"` / `"bdf2"` → `"gear"` across targeted test files. Does NOT touch `behavioral-remaining.ts` (owned by Task 3.3.3). | L | `src/core/analog-types.ts`, `src/solver/analog/load-context.ts`, `integration.ts`, `ni-integrate.ts`, `ni-pred.ts`, `ckt-terr.ts`, `analog-engine.ts`, `src/app/convergence-log-panel.ts`, 8+ targeted test files |
| 3.3.2 | **`SimulationParams.integrationMethod` public API — delete `"auto"`, match internal type exactly.** Replace inline union at `analog-engine-interface.ts:63` with imported `IntegrationMethod`; default from `"auto"` → `"trapezoidal"` at line 153 (matches `cktntask.c:99`); tighten harness `string \| null` → `IntegrationMethod \| null` at `harness/types.ts:53, 497, 994`; update consumer tests in `analog-engine-interface.test.ts`. Clean break — no runtime coercion shims. | M | `src/core/analog-engine-interface.ts`, `src/core/__tests__/analog-engine-interface.test.ts`, `src/solver/analog/__tests__/timestep.test.ts`, `src/solver/analog/__tests__/harness/types.ts` |
| 3.3.3 | **Behavioral relay — delegate coil inductor to standard `AnalogInductorElement` via composite-child pattern.** Rewrite `createRelayAnalogElement` (SPDT, `behavioral-remaining.ts:624-651`) and `createRelayDTAnalogElement` (DPDT, `behavioral-remaining.ts:734-753`). Each relay factory constructs a child `AnalogInductorElement` for the coil via the standard inductor factory, exposes it through `getChildElements()` (matching Phase 0 Wave 0.2.3 DigitalPinModel → AnalogCapacitorElement precedent). Relay `load()` stamps only contact conductances; child inductor handles coil MNA stamping via `ctx.ag[]`. Relay `accept()` reads the child's accepted coil current to drive `energised` / `contactClosed`. Delete hand-rolled `iL` / `geqL` / `ieqL` closure vars and all method-dispatch. | L | `src/solver/analog/behavioral-remaining.ts`, `src/solver/analog/__tests__/phase-3-relay-composite.test.ts` (new) |
| 3.3.4 | **`getLteTimestep` signature narrowing audit.** Grep-driven regression guard: no device `getLteTimestep` or `load()` body contains a live `method === "bdf1" \| "bdf2"` branch. Coverage via Task 3.3.6's banned-literal audit. | S | (audit-only) `src/components/**/*.ts` |
| 3.3.5 | **Compile-time assertion — public `SimulationParams.integrationMethod` equals internal `IntegrationMethod`.** Add module-scope conditional-type assertion at `analog-engine-interface.ts`; `tsc --noEmit` fails if the two types drift apart. | S | `src/core/analog-engine-interface.ts` |
| 3.3.6 | **Identifier-audit manifest extension.** Extend `phase-0-identifier-audit.test.ts` with three new banned-literal rules: `"bdf1"`, `"bdf2"`, and `integrationMethod: "auto"`. Allowlists empty. Append three rows to `spec/phase-0-audit-report.md`. | S | `src/solver/analog/__tests__/phase-0-identifier-audit.test.ts`, `spec/phase-0-audit-report.md` |
| 3.3.7 | **Public-surface consumer audit — postMessage / MCP / UI / E2E.** Grep-audit + targeted edit of non-solver consumers of `integrationMethod` in `scripts/`, `src/io/`, `src/app/`, `e2e/`. Delete every `"auto"` / `"bdf1"` / `"bdf2"` literal; remove any runtime coercion shim. STOP and escalate if a consumer relies on `"auto"` at runtime. | M | (grep-driven) `scripts/circuit-mcp-server.ts`, `src/io/postmessage-adapter.ts`, `src/app/app-init.ts`, `e2e/fixtures/*.ts` |

**Commits (one per wave):**
- `Phase 3.1 — NR reorder verify-only + forceReorder citation hygiene`
- `Phase 3.2 — F2 diode + BJT MODEINITPRED xfact extrapolation (ngspice-aligned: pnjlim runs on predicted voltages)`
- `Phase 3.3 — IntegrationMethod ngspice alignment (collapse to "trapezoidal" | "gear"; delete bdf1 / bdf2 / auto; relay via composite-child inductor)`

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

### Wave 5.0: LoadContext bypass prerequisites

Prelude before BJT work; adds the `bypass` / `voltTol` fields required by 5.1.3 / 5.2.3 and removes the `deltaOld[1] > 0 ? :` papering guard in `bjt.ts`.

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.0.1 | **LoadContext `bypass` + `voltTol`.** Add two fields to `LoadContext`; default-initialize in `CKTCircuitContext` to `false` and `1e-6` per `cktinit.c:53-55`. Append to every `LoadContext` literal in tests. | M | `src/solver/analog/load-context.ts`, `src/solver/analog/ckt-context.ts`, all `src/**/__tests__/*.test.ts` files constructing `LoadContext` literals |
| 5.0.2 | **Delete deltaOld guard.** `ckt-context.ts:539` already seeds `deltaOld[i] = params.maxTimeStep` matching `dctran.c:317` — verify and delete the `ctx.deltaOld[1] > 0 ? ctx.deltaOld[1] : ctx.delta` fallback at `bjt.ts:1399`. Divide directly like `bjtload.c:536-539`. | S | `src/components/semiconductors/bjt.ts` |

**Commit:** `Phase 5.0 — LoadContext bypass prerequisites`

### Wave 5.1: L0 (simple model) alignment

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.1.1 | **A1: MODEINITPRED xfact extension.** Wave 3.2.2 landed xfact extrapolation of VBE/VBC plus their state1→state0 copies; 5.1.1 extends with copies for the remaining 7 L0 slots (`CC, CB, GPI, GMU, GM, GO, GX`) so the full state1→state0 list matches `bjtload.c:288-303` minus VSUB (L0 has no substrate slot). Route predicted values into the pnjlim skip path. | M | `src/components/semiconductors/bjt.ts` (createBjtElement load) |
| 5.1.2 | **A3: MODEINITJCT priming.** Inside `load()`, implement the 3-branch ngspice priority: (a) `MODEINITJCT && MODETRANOP && MODEUIC` → UIC IC values; (b) `MODEINITJCT && !OFF` → `tVcrit` priming; (c) `MODEINITJCT && OFF` → zero. Cite `bjtload.c:170-220`. | S | `src/components/semiconductors/bjt.ts` |
| 5.1.3 | **A4: NOBYPASS bypass test.** Add 4-tolerance bypass (`delvbe`, `delvbc`, `cchat`, `cbhat` each vs. `ctx.voltTol`). On bypass: restore 9-slot op state from state0, skip pnjlim + compute + noncon, proceed to stamp block (mirror of ngspice `goto load`). LoadContext `bypass: boolean` + `voltTol: number` fields are NOT present in post-2.5 code — added by Wave 5.0.1 prelude (defaults `bypass=false, voltTol=1e-6` per `cktinit.c:53-55`). Cite `bjtload.c:338-381`. | L | `src/components/semiconductors/bjt.ts`, `src/solver/analog/load-context.ts` |
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
| 5.2.8 | **B11: AREAB / AREAC params with SUBS-dependent scaling.** Add `AREAB`, `AREAC` to `BJT_SPICE_L1_PARAM_DEFS` (default 1 each). Apply ngspice's `BJTsubs`-branched area scaling: `c4` and `ctot` (czbc base) scale with AREAB when SUBS=1 (VERTICAL) and with AREAC when SUBS=0 (LATERAL); `czsub` scales with AREAC when VERTICAL and AREAB when LATERAL — opposite direction. Cite `bjtload.c:184-187, 573-576, 582-585`. Depends on 5.2.7 (SUBS param). | M | `src/components/semiconductors/bjt.ts` |
| 5.2.9 | **B12: MODEINITTRAN charge state copy.** Inside `load()` under MODEINITTRAN, copy `cqbe`, `cqbc`, `cqbx`, `cqsub` from state0 → state1. Cite `bjtload.c:144-149`. | S | `src/components/semiconductors/bjt.ts` |
| 5.2.10 | **B15: `cexbc` INITTRAN seed + excess-phase shift-history gate split on `prevDt > 0`.** Two-part edit inside `load()`. | M | `src/components/semiconductors/bjt.ts` |
| 5.2.11 | **B22: Excess-phase `cex` uses raw `opIf` not `cbe_mod`.** Inside the excess-phase block, source `cex` from the unmodified forward current. Cite `bjtload.c:520-535`. | S | `src/components/semiconductors/bjt.ts` |
| 5.2.12 | **F-BJT-ADD-21: XTF = 0 gbe adjustment.** Run `gbe`/`cbe` modification regardless of XTF when `TF > 0 && vbe > 0`. Cite `bjtload.c:468-495`. | M | `src/components/semiconductors/bjt.ts` |
| 5.2.13 | **F-BJT-ADD-23: `geqsub = gcsub + gdsub` Norton aggregation.** Single Norton stamp at the substrate node. Previously operated on A1-deleted `_IEQ_BC_EXT` / `_CS` transfer slots; now these are locals. Cite `bjtload.c:625-640`. | S | `src/components/semiconductors/bjt.ts` |
| 5.2.14 | **F-BJT-ADD-25: cap gating for MODEINITSMSIG / UIC-DC-OP.** Gate the cap-companion computation inside `load()` on the correct mode bits. | S | `src/components/semiconductors/bjt.ts` |
| 5.2.15 | **F-BJT-ADD-34: VSUB limiting collector entry.** When `pnjlim` limits `vsub`, push a `LimitingEvent` into `ctx.limitingCollector`. H1 provides the collector side. | S | `src/components/semiconductors/bjt.ts` |

**Commit:** one per wave: `Phase 5.0 — LoadContext bypass prerequisites`, `Phase 5.1 — BJT L0 full alignment`, `Phase 5.2 — BJT L1 full alignment`.

---

## Phase 6: F-MOS — MOSFET MOS1 Alignment
**Depends on:** Phase 4
**Parallel with:** Phase 5, Phase 7

Targeted tests: MOSFET vitest suites; ngspice harness for MOSFET inverter.

**Post-A1 re-expression:** every task operates inside the unified `load()` method of `mosfet.ts`. The 11 deleted MOSFET cross-method slots (`SLOT_CAP_GEQ_GS/_GD/_DB/_SB/_GB`, `SLOT_IEQ_*`, `SLOT_Q_*`) are locals in `load()`; Meyer charges and cap companions compute and stamp in a single pass. G1 (MOSFET VBS / VBD sign convention) was landed in Phase 2.5. M-W3-4 was closed as a spec citation error (2026-04-24); `params.GAMMA` already matches `model->MOS1gamma` semantics and requires no edit.

### Wave 6.1: Infrastructure

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.1.1 | **B-5: SLOT_VON zero-init.** *Verify-only* — Phase 2.5 landed `{ kind: "zero" }` and removed the `isNaN` guard; Task 6.1.1 asserts both via test-time schema and file-content checks. | S | `src/components/semiconductors/__tests__/mosfet.test.ts` |
| 6.1.2 | **B-4: LTE extended to bulk charges.** *Verify-only* — Phase 2.5 added `QBS`/`QBD` to MOSFET `getLteTimestep`; Task 6.1.2 asserts by runtime test that both pairs influence `minDt`. | S | `src/components/semiconductors/__tests__/mosfet.test.ts` |
| 6.1.3 | **LoadContext `bypass`/`voltTol` compile-time assertion.** Add `type _PhaseAssert = Pick<LoadContext, "bypass" \| "voltTol">;` at `mosfet.ts` module scope. Compilation fails if Phase 5 Wave 5.0.1 did not land the LoadContext extension. Phase 6 Wave 6.2.4 depends on this precondition. | S | `src/components/semiconductors/mosfet.ts` |

### Wave 6.2: MOSFET correctness

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.2.1 | **M-1: Predictor limiting routing.** The MODEINITPRED/MODEINITTRAN voltage extrapolation already lives at `mosfet.ts::load()`; M-1's remaining divergence is that digiTS skips the `fetlim`→`limvds`→`pnjlim` block under MODEINITPRED\|MODEINITTRAN. `mos1load.c:356-406` runs limiting unconditionally inside the simple/general dispatch — the bypass guard excludes predictor/tran/smsig but limiting does not. Delete the `if ((mode & (MODEINITPRED \| MODEINITTRAN)) === 0)` wrapper; state-sequencing already correct because the predictor branch writes `s0[SLOT_V*] = s1[SLOT_V*]` before new voltages compute, so limiting reads state1 as "old" per `mos1load.c:211-225, 370`. | L | `src/components/semiconductors/mosfet.ts` |
| 6.2.2 | **M-2: MODEINITSMSIG general-iteration path.** `mos1load.c` has NO MOSFET SMSIG early-return (contrast BJT `bjtload.c:126-128`); SMSIG falls through line 202's gate into the `else` branch at `mos1load.c:226-240`, reads `vbs/vgs/vds` from CKTrhsOld, then runs common crunching + limiting + OP eval + cap block + Meyer block + stamps exactly like general iteration. Delete the `else if (mode & MODEINITSMSIG)` seed-from-state0 branch in digiTS; SMSIG reads rhsOld like other "simple" modes. Meyer `useDouble` averaging (`mode & (MODETRANOP \| MODEINITSMSIG)`), bulk-junction NIintegrate exclusion (`MODETRAN \|\| (MODEINITTRAN && !MODEUIC)` — SMSIG correctly excluded), gate-cap NIintegrate zero-companions path (`MODEINITTRAN \|\| !MODETRAN` — SMSIG fires zero branch), and noncon gate (`OFF==0 \|\| !(MODEINITFIX\|MODEINITSMSIG)`) all already match ngspice. Cite `mos1load.c:202-204, 226-240, 565, 789, 862`. | M | `src/components/semiconductors/mosfet.ts` |
| 6.2.3 | **M-3: MODEINITJCT IC_VDS / VGS / VBS.** Add `ICVDS`, `ICVGS`, `ICVBS` params (default 0 V) to both NMOS and PMOS param defs. Inside `load()`'s `MODEINITJCT && !OFF` branch, read IC values polarity-applied; if all three are zero AND `((mode & (MODETRAN\|MODEDCOP\|MODEDCTRANCURVE)) \|\| !(mode & MODEUIC))`, fall back to `(vbs=-1, vgs=polarity*tp.tVto, vds=0)`. Cite `mos1load.c:419-430` verbatim. Ensure `MODEDCTRANCURVE` is exported from `ckt-mode.ts` as a precondition. | M | `src/components/semiconductors/mosfet.ts` |
| 6.2.4 | **M-4: NOBYPASS bypass test.** Port `mos1load.c:258-348` verbatim. Compute `cdhat`/`cbhat` from state0 conductances inside `load()` (reads `s0[SLOT_CD/GM/GDS/GMBS/GBD/GBS/CBS/CBD]`). 5-tolerance bypass gate (`cbhat`, `delvbs`, `delvbd`, `delvgs`, `delvds`, `cdhat`) negative-gated on `MODEINITPRED\|MODEINITTRAN\|MODEINITSMSIG` and `ctx.bypass`. On bypass: reload `vbs/vbd/vgs/vds` from state0, rebuild `capgs/capgd/capgb` from `state0+state1` half-caps (MODETRAN/MODETRANOP only), skip OP eval + junction charge update + bulk-junction NIintegrate + Meyer block + gate-cap NIintegrate; stamps still run using state0 conductances — `mos1load.c:858-956` explicitly stamps *after* the `bypass:` label. Noncon gate runs unchanged. **Precondition:** `ctx.bypass: boolean` + `ctx.voltTol: number` on LoadContext — landed by Phase 5 Wave 5.0.1; compile-time asserted by Task 6.1.3. | L | `src/components/semiconductors/mosfet.ts` |
| 6.2.5 | **M-5: `CKTfixLimit` gate on reverse `limvds`.** *Verify-only* — Phase 2.5 landed the gate (`mosfet.ts:1133: if (!ctx.cktFixLimit) { vds = -limvds(-vds, -vdsOldStored); }`). Task 6.2.5 asserts by test that the gate survived the Task 6.2.1 limiting re-port and that forward-mode limvds still runs unconditionally. Cite `mos1load.c:385`. | S | `src/components/semiconductors/__tests__/mosfet.test.ts` |
| 6.2.6 | **M-6: `icheckLimited` init semantics.** Align to ngspice's `Check` semantics: `mos1load.c:108` inits `Check=1`; `DEVpnjlim` mutates `&Check` to 0 on no-limit (`devsup.c:50-58`); `Check` stays 1 iff pnjlim limited. digiTS currently inits `icheckLimited = true` and only sets true on `pnjlim.limited===true`, never clearing on no-limit. Invert: init `icheckLimited = false`, set `true` iff pnjlim reports `limited===true`. Keep `icheckLimited = false;` at the MODEINITJCT/default-zero branch (those modes skip pnjlim). Noncon gate at line 1629 unchanged — already matches `mos1load.c:737-743`. | S | `src/components/semiconductors/mosfet.ts` |
| 6.2.7 | **M-7: qgs / qgd / qgb xfact extrapolation.** `mos1load.c:828-836` extrapolates Meyer charges as `(1+xfact)*state1 - xfact*state2` with `xfact = CKTdelta/CKTdeltaOld[1]` (same formula as voltage predictor at `mos1load.c:210`). Current digiTS writes `s0 = s1` (implicit xfact=0) — a bug. Replace with the full formula; compute `xfact` locally (guarded by `ctx.deltaOld[1] > 0`) at the charge-predictor site to match the voltage-predictor pattern. Do NOT use `ctx.xfact` — keep local to match `mos1load.c` verbatim. | M | `src/components/semiconductors/mosfet.ts` |
| 6.2.8 | **M-8: `von` formula comment.** Add a justification comment above the `von = polarity * tp.tVbi + params.GAMMA * sarg` line documenting that `tVbi` is stored polarity-unsigned in `mos1temp.c` so multiplying by polarity at the evaluation site applies the type sign. Cite `mos1load.c:507`. No code change. | S | `src/components/semiconductors/mosfet.ts` |
| 6.2.9 | **M-9: Per-instance TEMP param.** Close the architectural gap: `mos1load.c:107` uses `vt = CONSTKoverQ * MOS1temp` where `MOS1temp` is per-instance; digiTS hard-codes REFTEMP inside `computeTempParams` and reads `ctx.vt` in `load()`. Add first-class `TEMP` param to both NMOS and PMOS param defs (default 300.15 K). Thread `params.TEMP` through `computeTempParams`, replacing every REFTEMP usage for instance-level calculations (`vt`, `ratio`, `fact2`, `kt`, `egfet`, `arg`, `pbfact`, capfact recomputes); `TNOM` stays model-level. Store `tp.vt = params.TEMP * KoverQ` on `MosfetTempParams`; replace `const vt = ctx.vt;` in `load()` with `const vt = tp.vt;`. `setParam('TEMP', …)` triggers `computeTempParams` recompute via the existing generic branch at `mosfet.ts:1718`. | M | `src/components/semiconductors/mosfet.ts` |
| 6.2.10 | **M-12: MODEINITFIX + OFF path.** *Verify-only* — `simpleGate` excludes `(MODEINITFIX && OFF===1)`; control falls into the `else` branch which already zeros `vbs/vgs/vds`. Task 6.2.10 asserts by test that both OFF=0 (simple/general path) and OFF=1 (default-zero path) produce the expected state0 writes, and adds a citation comment to the default-zero branch citing `mos1load.c:204, 431-433`. | S | `src/components/semiconductors/mosfet.ts`, `src/components/semiconductors/__tests__/mosfet.test.ts` |
| 6.2.11 | **Companion junction zero fix (#32).** *Verify-only* — post-A1 there are no `SLOT_CCAP_DB` / `SLOT_CCAP_SB` slots to zero (A1 deleted them). Meyer gate-cap zeroing at `mosfet.ts:1460-1465` fires on `MODEINITTRAN \|\| !MODETRAN`, matching `mos1load.c:862-866`. Task 6.2.11 asserts by test that (a) MODEINITTRAN zeros Meyer gate-cap companions, (b) MODETRAN-only integrates them, (c) bulk-junction integrator slots are overwritten by NIintegrate output (not blanket-zeroed). | S | `src/components/semiconductors/__tests__/mosfet.test.ts` |

### Wave 6.3: Verification

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.3.1 | **PMOS `tVbi` sign audit (#25).** Verify PMOS-with-gamma-nonzero against ngspice via the comparison harness. Determine if `\|VTO\|` vs signed-VTO causes `tVbi` divergence. G1 (sign convention, landed Phase 2.5) likely clarifies; if still divergent, file a finding and escalate. | M | `src/components/semiconductors/mosfet.ts` |

**D-8 note:** the MOSFET `cgs_cgd_transient` regression canary from Phase 2.5 is NOT resolved by Phase 6 code changes — Phase 6 delivers the MOSFET alignment work; the bit-exact acceptance comparison happens in Phase 10 (MOSFET inverter circuit). Do not attempt to close D-8 here.

**Commit:** one per wave: `Phase 6.1 — MOSFET infrastructure`, `Phase 6.2 — MOSFET correctness`, `Phase 6.3 — PMOS tVbi verification`.

---

## Phase 7: F5ext — JFET Full Convergence Port
**Depends on:** Phase 4 (`fetlim` helper), Phase 5 Wave 5.0.1 (`LoadContext.bypass` + `voltTol`)
**Parallel with:** Phase 5, Phase 6
**Detailed spec:** `spec/phase-7-f5ext-jfet-full-convergence-port.md`

Subsumes F5-D (Vds-clamp removal, done pre-Phase-2.5) + F5-E (pnjlim on vgd). Targeted tests: `src/components/semiconductors/__tests__/jfet.test.ts`; ngspice harness for JFET circuits (deferred per Wave 7.3 collapse below).

**Post-A1 re-expression:** every task operates inside the unified `load()` methods of `njfet.ts` and `pjfet.ts`. Per D-10 (self-contained factories landed in Phase 2.5), PJFET does NOT delegate to NJFET; each edit is hand-mirrored into `pjfet.ts` with its `-1` polarity literal. The deleted cross-method `SLOT_CAP_GEQ_GS` / `_GD` / `SLOT_IEQ_GS` / `_GD` slots are locals in `load()`. `fet-base.ts` was removed in Phase 2.5.

**Corrections applied 2026-04-24** during phase-7 spec authoring:
- The original Wave 7.1.1 text ("Do NOT add `SLOT_CQGS` / `SLOT_CQGD` — those were the cross-method CAP transfer slots A1 deleted") was factually wrong. `JFETcqgs` (`JFETstate+10`) and `JFETcqgd` (`JFETstate+12`) are real ngspice state slots per `jfetdefs.h:164-166`, read and written directly by `jfetload.c:477-492`. Current code correctly has them. The claim has been struck; these slots are legitimate ngspice mirrors.
- Original Wave 7.2 (PJFET delegation to NJFET base) directly contradicted the D-10 ruling. Wave 7.2 has been struck; PJFET remains self-contained with its own polarity-literal `load()`.
- Original Wave 7.3 (detailed test alignment) has been collapsed to smoke-only. The engine is not expected to be fully working until Phase 10 acceptance closes; detailed per-task tests before then produce confounded failures. Deferred tests are recorded in `spec/phase-10-follow-ups.md` §JFET (items J-D-1 through J-D-7).

Much of the original Wave 7.1 is already landed on `main`: the 13-slot state schema matches `jfetdefs.h:154-166` exactly; the unified `load()` carries the 6-branch voltage dispatch, pnjlim + inline fetlim, Sydney-University drain current, transient NIintegrate, and 15 Y-matrix + 3 RHS stamps (including the J-W3-3 self-stamps for collapsed prime↔external nodes); the MODEINITJCT 3-branch priority is in place. What remains is NR convergence machinery and plumbing hygiene.

### Wave 7.1: JFET NR convergence machinery

Applied identically to `njfet.ts` and `pjfet.ts`. Single commit: `Phase 7 — F5ext JFET full convergence port (6 tasks)`.

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.1.1 | **Complete MODEINITPRED 9-slot state1→state0 copy.** Current code copies only VGS/VGD; `jfetload.c:135-148` copies VGS, VGD, CG, CD, CGD, GM, GDS, GGS, GGD. Without this, Task 7.1.2's cghat/cdhat reads stale state0 instead of accepted state1. | S | `njfet.ts`, `pjfet.ts` |
| 7.1.2 | **Port cghat/cdhat extrapolation + noncon convergence gate.** Add `delvgs`/`delvgd`/`delvds`/`cghat`/`cdhat` compute per `jfetload.c:165-174`; feed into the noncon gate per `jfetload.c:500-504` preserving the `>=` (cghat) / `>` (cdhat) asymmetry verbatim. Outer gate `(!(mode & MODEINITFIX)) \| (!(mode & MODEUIC))` unchanged — suppresses bump only when both MODEINITFIX and MODEUIC are set (UIC-forced IC at init step). | M | `njfet.ts`, `pjfet.ts` |
| 7.1.3 | **Port NOBYPASS bypass block.** `jfetload.c:178-208` verbatim: four-level nested `if` chain on `ctx.bypass && !MODEINITPRED` with 4-tolerance gate. On bypass: reload 9 op-state values from state0, skip compute, preserve stamps + noncon + state-writeback. Do NOT collapse the four-level `if` into an `&&` chain — match ngspice's "expression too big" nesting exactly. Requires `ctx.bypass`/`ctx.voltTol` from Phase 5 Wave 5.0.1. | L | `njfet.ts`, `pjfet.ts` |
| 7.1.4 | **Delete `primeJunctions()` + `primedFromJct` + consume-seed branch.** MODEINITJCT in-`load()` 3-branch priority becomes the sole priming path, matching ngspice exactly. `dc-operating-point.ts:323-324`'s optional-method guard handles JFET's new shape (no method defined) correctly. | S | `njfet.ts`, `pjfet.ts` |
| 7.1.5 | **Replace inline fetlim with shared helper.** Import `fetlim` from `newton-raphson.ts` (landed by Phase 4.1.1); delete ~70 lines of inline fetlim duplication across the two files. `fetlim` becomes the single source of truth shared with MOSFET, mirroring ngspice's `DEVfetlim` in `devsup.c`. | S | `njfet.ts`, `pjfet.ts` |
| 7.1.6 | **Noncon-gate comment fix + bitwise-semantics verification.** The current "intentional ngspice quirk / always-true when only one bit is set" comment is wrong — bitwise `\|` on `!`-produced 0/1 operands is identical to logical `\|\|`. Replace with the actual semantics comment. No behaviour change; bitwise `\|` form preserved for verbatim line correspondence with `jfetload.c:498-499`. | S | `njfet.ts`, `pjfet.ts` |

### Wave 7.3: Smoke tests only (detailed tests deferred)

Existing `src/components/semiconductors/__tests__/jfet.test.ts` untouched in Phase 7. Detailed per-task tests (state-copy, convergence, bypass, harness parity) are deferred to `spec/phase-10-follow-ups.md` §JFET and triggered once Phase 10 acceptance closes.

**Commit:** single `Phase 7 — F5ext JFET full convergence port (6 tasks)`. Tasks are tightly coupled; splitting would produce unstable intermediate states.

Wave 7.2 (per-instance TEMP) ships as a separate commit `Phase 7.2 — JFET per-instance TEMP parameter` after Wave 7.1 lands.

---

## Phase 7.5: F-RESIDUAL — Remaining Temp-Dependent Devices + primeJunctions Cleanup
**Depends on:** Phase 4
**Parallel with:** Phase 5, Phase 6, Phase 7
**Detailed spec:** `spec/phase-7.5-f-residual-temp-primejunctions.md`

Propagates two cross-phase findings into every non-MOSFET / non-BJT / non-JFET semiconductor:

- **Per-instance `TEMP` override** (first introduced in Phase 6 Task 6.2.9 / M-9 for MOSFET, Phase 5 Wave 5.3 for BJT, Phase 7 Wave 7.2 for JFET). Remaining devices: diode, zener, LED, SCR, tunnel-diode. `varactor`, `schottky`, `diac`, `triac`, `triode` carry no temperature dependence in the ngspice-equivalent sense and are out of scope.
- **`primeJunctions()` / `primedFromJct` deletion** (first introduced in Phase 7 Task 7.1.4 for JFET, Phase 6 Task 6.1.4 for MOSFET). Remaining implementers: zener, SCR. Once every implementer is gone, the `dc-operating-point.ts:322-325` call site + `primeJunctions?` interface member in `analog-types.ts` + `element.ts` are deleted.

### Wave 7.5.1: Diode per-instance TEMP

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.5.1.1 | Add `TEMP: { default: 300.15, unit: "K" }` to diode param defs under `secondary`. | S | `src/components/semiconductors/diode.ts` |
| 7.5.1.2 | Replace the `T: number = REFTEMP` default in `computeDiodeTempParams` with required positional; pass `params.TEMP` at every call site. `p.TNOM` unchanged. | M | `src/components/semiconductors/diode.ts` |
| 7.5.1.3 | Wire `setParam('TEMP', …)` → `computeDiodeTempParams` recompute. Verify by test. | S | `src/components/semiconductors/diode.ts` |

### Wave 7.5.2: Zener per-instance TEMP + primeJunctions deletion

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.5.2.1 | Add `TEMP` param (default 300.15 K); replace `const circuitTemp = REFTEMP` at zener.ts:177 with `const circuitTemp = params.TEMP`; wire setParam recompute. | M | `src/components/semiconductors/zener.ts` |
| 7.5.2.2 | Delete `primeJunctions()` method at `zener.ts:426-429`. Move the `pool.states[0][base + SLOT_VD] = tVcrit` priming into the MODEINITJCT branch of `load()` per `dioload.c:130-138`. Add `OFF===1 → SLOT_VD=0` fork. | S | `src/components/semiconductors/zener.ts` |

### Wave 7.5.3: LED per-instance TEMP

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.5.3.1 | Add `TEMP` param; replace hardcoded `VT as LED_VT` import with per-instance `params.TEMP`-derived `vt`; drop unused `VT` import; wire setParam recompute. | M | `src/components/io/led.ts` |

### Wave 7.5.4: SCR per-instance TEMP + primeJunctions deletion

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.5.4.1 | Add `TEMP` param; route `tp.vt` (derived from `params.TEMP`) into every pnjlim / exponential site; drop `ctx.vt` reads; wire setParam recompute. | M | `src/components/semiconductors/scr.ts` |
| 7.5.4.2 | Delete `primeJunctions()` method, `primedVak` / `primedVgk` closure vars, and the consume-seed branch at top of `load()`. Add MODEINITJCT branch in `load()` seeding `SLOT_VAK = tp.tVcrit` (OFF=0) or `0` (OFF=1) and `SLOT_VGK = 0`, per `dioload.c:130-138` pattern applied to the anode-cathode junction. | M | `src/components/semiconductors/scr.ts` |

### Wave 7.5.5: Tunnel-diode per-instance TEMP

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.5.5.1 | Add `TEMP` param; replace hardcoded `VT` import with per-instance `params.TEMP`-derived `vt`; drop unused `VT` import; wire setParam recompute. | M | `src/components/semiconductors/tunnel-diode.ts` |

### Wave 7.5.6: Delete `primeJunctions` call site + interface member

**Precondition:** Phase 6 Task 6.1.4, Phase 7 Task 7.1.4, Phase 7.5 Wave 7.5.2, and Phase 7.5 Wave 7.5.4 have all landed. At this point `src/` has zero `primeJunctions` implementers outside `spec/` + `ref/ngspice/`.

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.5.6.1 | Delete the dead `for (const el of elements) { if (el.isNonlinear && el.primeJunctions) el.primeJunctions(); }` loop at `dc-operating-point.ts:322-325`. | S | `src/solver/analog/dc-operating-point.ts`, `src/solver/analog/__tests__/dcop-init-jct.test.ts` |
| 7.5.6.2 | Delete the `primeJunctions?(): void;` optional interface member from `src/core/analog-types.ts:219` and `src/solver/analog/element.ts:120`. Compile check passes. | S | `src/core/analog-types.ts`, `src/solver/analog/element.ts` |

**Commits (one per wave):** `Phase 7.5.1 — Diode per-instance TEMP`, `Phase 7.5.2 — Zener TEMP + primeJunctions deletion`, `Phase 7.5.3 — LED per-instance TEMP`, `Phase 7.5.4 — SCR TEMP + primeJunctions deletion`, `Phase 7.5.5 — Tunnel-diode per-instance TEMP`, `Phase 7.5.6 — Delete primeJunctions call site + interface`.

Waves 7.5.1 through 7.5.5 may commit in any order once Phase 4 lands. Wave 7.5.6 serialised last, with a hard precondition that Phases 6, 7, and Waves 7.5.2 + 7.5.4 have landed.

---

## Phase 8: F6 — Documentation & Citation Audit
**Depends on:** Phase 5, Phase 6, Phase 7, Phase 7.5

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
| 9.1.1 | **Re-run `phase-0-identifier-audit.test.ts`.** Extend its `BANNED_IDENTIFIERS` manifest with any new Track A-deleted symbol surfaced during Phases 3–8. Expected: green test run with no unexpected hits. Report any residue. | S | `src/solver/analog/__tests__/phase-0-identifier-audit.test.ts`, `spec/phase-0-audit-report.md` |
| 9.1.2 | **Citation audit.** Random sample 10 ngspice citations from `src/`; verify line numbers against `ref/ngspice/`. I2 policy enforcement. | S | `src/**/*.ts` |
| 9.1.3 | **Full suite run.** `npm test`. Capture failures as the Phase-10 acceptance input — do not chase them mid-Phase-9; Phase 10 triages. | S | (project-wide) |

**Commit:** `Phase 9 — legacy reference review + full suite baseline`.

---

## Phase 10: 8-Circuit Bit-Exact ngspice Parity Acceptance
**Depends on:** Phase 9
**Spec:** `spec/phase-10-bit-exact-ngspice-parity.md`
**Ticket sink:** `spec/phase-10-parity-tickets.md`

Final acceptance gate. 8 circuits must produce IEEE-754 bit-identical per-NR-iteration `rhsOld[]` compared to ngspice.

**Nature:** run-and-triage. The eight acceptance tests already exist at `src/solver/analog/__tests__/ngspice-parity/*.test.ts` (with fixtures, helpers, and `absDelta === 0` assertions on every compared field). Phase 10 runs each test against the post-Phase-9 tree, surfaces every divergence as a PARITY ticket in `spec/phase-10-parity-tickets.md`, and closes when every ticket has user disposition.

**Why Phase 10 (not Phase 9.X):** the user has flagged that expecting bit-exact harness results while the underlying engine has known bugs has burned this project before. Phase 10 runs only after Phases 3–9 land; every known fix is in place; engine-level bugs are closed to the best of static + targeted-test knowledge. Phase 10's failures are therefore genuine bit-level divergences, not confounded by upstream known-broken code.

**Per-circuit pass criteria** (asserted by `parity-helpers.ts::assertIterationMatch` / `assertModeTransitionMatch` / `assertConvergenceFlowMatch`):
- **DC-OP:** every NR iteration's `rhsOld[]` matches exactly (`absDelta === 0`); mode transitions match; iteration count matches.
- **Transient:** every accepted timestep's `dt`, `order`, `method` match; per-step NR iteration count matches; node voltages match exactly.
- **Convergence flow:** `noncon`, `diagGmin`, `srcFact` match at every iteration/step.
- **Device state:** `state0[]` (per `device-mappings.ts` slots) matches exactly at every NR iteration.

**Execution model:** one wave per circuit, complexity-ordered (simpler circuits first so divergences surface in the minimum-reproducing circuit). Waves may run in parallel — ticket accumulation does not block later waves. Agents surface tickets per wave and STOP; the user reviews tickets and decides fix (PARITY remediation PR) or escalate (user-only write to `architectural-alignment.md`). Agents never write to `architectural-alignment.md` and never fix engine code during Phase 10.

### Waves 10.1..10.8: one circuit per wave (complexity-ordered)

| Task | Circuit | Test file | Phase-dependency exercised | Complexity |
|------|---------|-----------|----------------------------|------------|
| 10.1.1 | Resistive divider | `ngspice-parity/resistive-divider.test.ts` | NR outer loop, linear stamp, 1 iteration sanity | M |
| 10.2.1 | Diode + resistor | `ngspice-parity/diode-resistor.test.ts` | Phase 4 D4 Gillespie pnjlim; mode transitions | M |
| 10.3.1 | RC transient | `ngspice-parity/rc-transient.test.ts` | Capacitor NIintegrate, LTE, order promotion, I2.1 `SLOT_CCAP` | M |
| 10.4.1 | BJT common-emitter | `ngspice-parity/bjt-common-emitter.test.ts` | Phase 5 BJT L0/L1; multi-junction limiting; gmin stepping | L |
| 10.5.1 | RLC oscillator | `ngspice-parity/rlc-oscillator.test.ts` | Inductor NIintegrate; held trapezoidal; I2.1 inductor `SLOT_CCAP` | L |
| 10.6.1 | Op-amp inverting | `ngspice-parity/opamp-inverting.test.ts` | Source stepping (`dcopSrcSweep`, `srcFact` sequence) | M |
| 10.7.1 | Diode bridge | `ngspice-parity/diode-bridge.test.ts` | Multi-junction transient; breakpoint consumption parity | L |
| 10.8.1 / 10.8.2 | MOSFET inverter | `ngspice-parity/mosfet-inverter.test.ts` | Phase 6 MOSFET MOS1 `load()`; fetlim; **D-8 closure (10.8.2 `transient_match`)** | L |

**D-8 closure:** implicit in Task 10.8.2 (`transient_match`) passing with `absDelta === 0`. The test pass IS the closure — no separate gesture. Any CCAP_GS / CCAP_GD divergence surfaces as a P10-8.N ticket.

**Commit per wave:** on PASS, `Phase 10.<N> — <circuit> parity acceptance (PASS)`. On FAIL, `Phase 10 — tickets from W10.<N> run` (the ticket file is the only modified artifact; no engine code changes). See `spec/phase-10-bit-exact-ngspice-parity.md` for the commit-body evidence protocol.

**Closure commit:** `Phase 10 — bit-exact ngspice parity gate closed (<N> passes, <M> tickets dispositioned, D-8 <closed|escalated>)`. Requires every ticket in `spec/phase-10-parity-tickets.md` to have User disposition + Resolution commit filled in.

**Post-Phase-10:** remaining divergences are reflected in `spec/phase-10-parity-tickets.md` with user-assigned dispositions. Track A-style escalation is user-only — agents never add to `architectural-alignment.md`.

---

## Appendix A: Operational rules for implementers

### Orchestration

- **Batch sizing — up to 8 parallel implementers per batch.** Overrides the orchestrator skill's default of 6 (`min(tasks, 6)`). Disjoint-file cross-phase parallelism (plan.md Phases 5/6/7/7.5 fan-out) justifies the higher cap. The orchestrator may pack up to 8 disjoint-file task_groups into one batch.
- **STOP and escalate** if a diff cannot be applied cleanly (code has drifted since Phase 2.5 closure at commit `653340ac`, assumed structure absent). No improvisation.

### Test discipline

- **Tests are expected red.** The engine is not expected to be ngspice-exact until Phase 10 closes. Many tests across the suite will fail for reasons unrelated to the current task. Implementers MUST NOT chase failures in code they did not touch. They implement the spec verbatim and report failures, not fix them.
- **No test-chasing, no assertion-softening.** Never modify an assertion to "make a test pass." Never add `skip` / `xfail` / `toBeApproximately` / widened tolerances. If a test fails because the spec you are implementing requires it to fail until a later task, that is a *feature* — note it in the completion report and move on.
- **Targeted vitest only, never full suite.** Run `npx vitest run <path>` scoped to the specific test files listed in the task spec. Running `npm test` or untargeted `vitest` is forbidden until Phase 9 Task 9.1.3 lands. Phase 9 owns the full-suite instrument; no other phase is permitted to invoke it.
- **120-second per-test timeout.** Every vitest invocation MUST pass `--testTimeout=120000`. Any test that times out or hangs is a surface-and-stop signal, not a "re-run" signal. Do NOT retry with longer timeouts. Do NOT re-run selectively to chase flakes. Report the timeout verbatim (test name + full command line + tail of output) in the completion report and move on.
- **Failures and timeouts are surfaced, never hidden.** Completion reports include: every failed test name, every timeout, the first 20 lines of stack for each, the full command invoked, the vitest exit code. Agents that omit this information from their report are considered to have returned dishonestly.
- **No test baseline.** `spec/test-baseline.md` is not produced this run — the baseline-capture agent hangs indefinitely on this project. Implementers cannot cite "pre-existing failure" as a closure verdict. Every failure is reported as-observed; the user distinguishes pre-existing vs. regression at review time.

### Implementation

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
