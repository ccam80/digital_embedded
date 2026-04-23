# Phase 2.5 — Track A Execution Spec

**Date:** 2026-04-21
**Precondition:** Reconciliation complete at commit `67dbca73`
**Input docs:** `spec/architectural-alignment.md`, `spec/reconciliation-notes.md`, `spec/plan-addendum.md`, `spec/i1-suppression-backlog.md`, `spec/fix-list-phase-2-audit.md`
**Target:** A1 + A2 + A3 + A4 + F2 + F4a + F4b + F4c + G1 + I1 landed as a series of incremental commits on `main`
**Commit policy:** incremental commits on `main`. The tree is expected to be broken throughout execution — `main` is not working today and will not be working until the final wave lands.

---

## Session restart instructions (read first when resuming)

1. Read this file top-to-bottom.
2. Check the **Wave status tracker** in §2 below — the first UNCHECKED wave is where execution resumes.
3. Read `spec/architectural-alignment.md` §1 Summary table for the Track A IDs cited in the wave.
4. Read the wave's listed inputs (ngspice source files, existing digiTS files).
5. Spawn the wave's agents per the prompt skeletons in §3+.
6. After each wave completes, commit with a message referencing this spec and the wave ID, then update the Wave status tracker in this file.

**Starting commit on resume:** run `git log --oneline -15` and compare against the Wave status tracker to locate the most recent wave commit. That is the resume point.

**If convergence is broken at a resume point:** expected. Per §1 principle 4, agents do not debug convergence — they implement to spec. User review of convergence happens after Wave 3 (wrap-up).

---

## 1. Execution principles (non-negotiable)

1. **Mechanical rewrite to spec.** Agents port the cited ngspice function or implement the cited digiTS-only stub. They do not improvise. Every judgment call lives in this spec; if the spec is ambiguous, agent escalates to user — does not guess.

2. **Prioritize by file scope, not by "don't leave things broken".** Lanes are partitioned by directory / device ownership. Tests WILL be failing during and after each wave. That is expected. Agents do NOT modify code to make tests pass; they modify code to match the spec.

3. **Aggressive test deletion per A1 §Test handling rule.** Any assertion whose expected value was computed by hand, rather than produced by ngspice, is subject to deletion. Tests that inspect intermediate `_updateOp` / `_stampCompanion` state are deleted wholesale — the methods won't exist after A1. Survivor categories (per `spec/architectural-alignment.md` §A1 "Test handling during A1 execution"): parameter plumbing, F4c self-compares, engine-agnostic interface contracts. Everything else: delete.

4. **No self-correction for convergence.** If an agent's ported device fails to converge against ngspice, the agent surfaces the failure in its report and stops. No harness-compare loops, no formula-tweaking, no tolerance adjustment. End-of-wave review is by user. This is explicit: agents would otherwise drift into watering down full replacements to make tests pass — exactly the pattern the forcing-function plan targets.

5. **Banned vocabulary** (CLAUDE.md): *mapping*, *tolerance*, *close enough*, *equivalent to*, *pre-existing*, *intentional divergence*, *citation divergence*, *partial* — never as closing verdicts. Escalate to user instead.

6. **Incremental commits on `main`.** One commit per wave (or per lane within a wave, if the lane is self-contained). Commit messages cite this spec + the wave ID. No feature branches; `main` is the working edge.

---

## 2. Wave status tracker

| Wave | Title | Status | Commit |
|---|---|---|---|
| W0 | Interface + LoadContext core | ✓ | 39ab73ca |
| W1.1 | Diode family (diode + zener + F2 varactor→diode) | ✓ | f8586dc6 |
| W1.2 | BJT (L0 + L1) | ✓ | 5b3fadf3 |
| W1.3 | MOSFET (L1) + G1 sign convention | ✓ | 2b2b58a9 |
| W1.4 | JFET (N + P + fet-base collapse) | ✓ | b62d6148 |
| W1.5 | Reactive passives (capacitor, polarized-cap, inductor, transformer, tapped-transformer) | ✓ | 781b1943 |
| W1.6 | F4c digiTS-only semiconductors (triac, scr, diac, tunnel-diode, triode, LED) | ✓ | 46e1dae7 |
| W1.7 | F4c digiTS-only passives / sensors (crystal, transmission-line, memristor, analog-fuse, ntc-thermistor, spark-gap) | ✓ | d8643e83 |
| W1.8 | Active devices — 5 F4c confirmed, 3 composition lanes pending (see triage 2026-04-22) | ▶ | b6e52a6a (partial) |
| W1.8a | Optocoupler composition — LED → `diode.ts`, phototransistor → `bjt.ts`, CCCS coupling | ✓ | 130ddd8a |
| W1.8b | Analog-switch direct port — `sw/*` VSWITCH primitive | ✓ | 63efc924 |
| W1.8c | 555 timer composition — two comparators + RS flip-flop + BJT output + R-divider | ✓ | 52a6b576 (reworked, supersedes 8b298ca9) |
| W1.9 | `device-mappings.ts` schema sync — harness slot-correspondence follows W1.1–W1.8 renames | ✓ | 563c8d49 + close-out (harness rename + BJT CDSUB/GDSUB swap + QCS→QSUB) |
| W2.1 | Solver architectural fixes — B1, B2, B3, B4, B5 | ✓ | 28db1913 |
| W2.2 | Control-flow fixes — C1, C2, C3, D1, H1, H2 | ✓ | 7dadd629 |
| W2.3 | `InitMode` string deletion (production + harness) | ✓ | ab8552e4 |
| W2.4 | Aggressive I1 test regeneration | ✓ | d24840ec + 24440b4a |
| W3 | Post-A1 static audit — 24 parallel lanes → `spec/post-a1-parity.md` | ✓ | 42f9b5dd |
| W4.A | A1 gate — stamp-semantics verify + LoadContext field audit | ✓ | d23f3ebd |
| W4.B.1 | Diode — W3 findings D-W3-1..7 (IKF/IKR, MODEINITPRED cascade, SLOT_V verify, BV_given, sidewall, tunnel) | — | — |
| W4.B.2 | Zener — W3 findings Z-W3-1..9 (three-region + tBV pulled forward from 4.3.3) | — | — |
| W4.B.3 | Polarized-cap — W3 findings PC-W3-1..6 (clamp diode + F4b parity test) | — | — |
| W4.B.4 | Inductor — W3 findings I-W3-1/2/3/5 (rhsOld + alias verification + SLOT_VOLT) | — | — |
| W4.B.5 | Transformer — W3 findings T-W3-1..6 (branchCount + NIintegrate + UIC) | — | — |
| W4.B.6 | Tapped-transformer — W3 findings TT-W3-1..6 (branchCount + two-pass flux + SLOT_VOLT) | — | — |
| W4.B.7 | Capacitor — W3 findings C-W3-2, C-W3-3 (m-at-stamp + niIntegrate validation) | — | — |
| W4.B.8 | MOSFET — W3 findings M-W3-1..6 (cktFixLimit + icheckLimited + tGamma + noncon) | — | — |
| W4.B.9 | BJT — W3 findings B-W3-1..5 (AREA + evsub clamp + Phase-5 cross-refs pulled forward) | — | — |
| W4.B.10 | JFET — W3 findings J-W3-1..3 (SMSIG return + noncon gate + RD/RS stamps) | — | — |
| W4.C.1 | F4c ngspice framing strip — NTC + spark-gap (4 files) | — | — |
| W4.C.2 | L3 DLL hard-fail gates — buckbjt smoke + convergence tests | — | — |
| W4.C.3 | L3 silent I/O catches → logged warnings — 29 sites / 9 files | — | — |
| W4.C.4 | L2 stale test deletions — 5 approved line ranges (polarized-cap, capacitor, crystal) | — | — |
| W4.D | C-4 lifecycle verifier — `initVoltages` caller-chain + behavioral-* audit | — | — |
| W4.close | Phase 2.5 closure commit — post-a1-parity.md §§5–6 updated, D-8 canary resolved | — | — |
| W5 | `spec/phase-3-onwards.md` — re-author 77 surviving plan.md Phase 3–9 tasks | — | — |

Legend: `—` = not started, `▶` = in progress, `✓` = complete.

---

## 3. Wave W0 — Interface + LoadContext core

**Scope:** serial, blocks every W1.x and W2.x lane. Must land first.

**Files:**
- `src/solver/analog/element.ts` — `AnalogElement` interface
- `src/solver/analog/load-context.ts` — `LoadContext` shape
- `src/solver/analog/state-pool.ts` — delete `pool.uic`, `pool.analysisMode`, `poolBackedElements`, `refreshElementRefs`
- `src/solver/analog/ckt-load.ts` (or wherever `cktLoad` lives) — rewrite to call `.load(ctx)` per device
- `src/solver/analog/analog-engine.ts` — remove any references to the deleted pool fields

**Spec:**

### W0.1 — Define the new `.load()` method

Add to `AnalogElement` interface (cite: `cktdefs.h::CKTloadPtr`, `bjtdefs.h::BJTloadPtr`, per-device loadPtr type):

```typescript
load(ctx: LoadContext): void;
```

Remove from `AnalogElement` interface:
- `_updateOp(ctx: LoadContext): void`
- `_stampCompanion(ctx: LoadContext): void`
- `refreshElementRefs(pool: StatePool): void`

### W0.2 — `LoadContext` finalization

Ensure `LoadContext` provides (mirroring ngspice `CKTcircuit` load-time fields):

- `cktMode: number` (bitfield — `MODEDC | MODETRAN | MODEINITJCT | MODEINITFIX | MODEINITFLOAT | MODEINITTRAN | MODEUIC` etc.)
- `time: number`
- `delta: number` (current timestep)
- `method: 0 | 1` (0 = Trapezoidal, 1 = Gear, cite `cktdefs.h`)
- `order: number` (integration order)
- `agVector: Float64Array` (integration coefficients — ag[0] = `1/delta` for trap, etc.)
- `rhs: Float64Array`, `rhsOld: Float64Array`
- `matrix: SparseMatrix`
- ~~`nodes: NodeMap`~~ — **STRICKEN 2026-04-22.** No such type exists; ngspice `load()` functions don't take a node lookup (devices hold their own resolved pin indices and index `CKTrhs`/`CKTmatrix` directly). LoadContext's `matrix` + `rhs` are sufficient.
- `limitingCollector: LimitingEventList` (for H1 — must be synced on every load call)
- `convergenceCollector: ConvergenceEventList` (for checkConvergence — see H2)
- `xfact: number` (initPred extrapolation factor — cite `cktdefs.h`)
- `temp: number`, `vt: number` (thermal voltage, = kT/q at ckt temperature)

If any field is missing today, add it during W0 (not during per-device waves).

### W0.3 — Delete from `state-pool.ts`

Delete these fields outright:
- `pool.uic: boolean` → every reader becomes `(ctx.cktMode & MODEUIC) !== 0`
- `pool.analysisMode: "dcOp" | "tran"` → every reader becomes bitfield check against `ctx.cktMode`
- `pool.poolBackedElements: AnalogElement[]`
- `pool.refreshElementRefs(): void`

### W0.4 — Rewrite `cktLoad`

New shape (cite `ngspice/src/spicelib/analysis/cktload.c`):

```typescript
function cktLoad(ctx: LoadContext, elements: AnalogElement[]): void {
  // Per ngspice cktload.c:
  // 1. Clear RHS (if INITF mode requires) and matrix
  // 2. For each element: element.load(ctx)
  // 3. Limiting events already collected via ctx.limitingCollector
  // 4. No iteration argument; no post-load "finalize" pass
  for (const el of elements) {
    el.load(ctx);
  }
}
```

Note: no `iteration` parameter (removes C3). No `_seedFromDcop` inside `cktLoad` (moves to dcopFinalize → C1). No `refreshElementRefs` call (A4 deletion).

### W0.5 — Provide a stub `.load()` for every existing device

To land W0 without a broken build, each device gets a stub:

```typescript
load(ctx: LoadContext): void {
  // TEMPORARY W0 STUB — per-device port in W1.x
  this._updateOp(ctx);
  this._stampCompanion(ctx);
}
```

**This is the ONLY place in Phase 2.5 where a non-final pattern is permitted, and it lives for the duration of W0's commit only.** Each W1.x lane replaces its devices' stubs with the real port and deletes `_updateOp` / `_stampCompanion`.

Rationale for the stub: W0 is the interface-migration commit; without the stub, W0 would require also landing every device port, which is what W1.1-W1.8 do separately. The stub lets W0 land as a contained "interface rewired" commit and gives W1 lanes clean per-device work.

### W0.6 — Tests

- Delete any test that asserts directly on `_updateOp` or `_stampCompanion` being called (count-of-calls, argument inspection).
- Keep tests that assert on post-load state (matrix contents, RHS contents, node voltages) — those survive.
- Delete any test that reads `pool.uic`, `pool.analysisMode`, or `pool.poolBackedElements`.

### W0 agent prompt skeleton

One agent, serial:

> You are executing Phase 2.5 Wave 0 per `spec/phase-2.5-execution.md` §3. This is the interface rewiring commit. Read §1 principles and §3 fully.
> Deliverables: W0.1 through W0.6 landed in a single commit on `main`.
> Mechanical rewrite, no self-correction, no convergence debugging. Tests will be failing — that is expected and on-spec.
> Ngspice sources: `ref/ngspice/src/spicelib/analysis/cktload.c` and `ref/ngspice/src/include/ngspice/cktdefs.h`. Read at cited line ranges only, do not read entire files.
> Escalate to user if: the `LoadContext` fields required are ambiguous; `cktLoad` has non-device callers that need cascading changes; any device's stub cannot compile cleanly.

---

## 4. Wave W1.x — Per-device load() ports (parallelizable lanes)

Each W1.x lane is self-contained in its own device files. Lanes can run in parallel once W0 lands. Commit per lane (incremental).

### Common pattern for every W1.x lane

For each device in the lane:

1. **Read the ngspice source.** For F4a devices, the cited load function (e.g., `dioload.c::DIOload`). For F4b composites, the primitive load functions being composed. For F4c stubs, no ngspice reading — identify the digiTS-only behavior from current code.

2. **Write `load(ctx: LoadContext): void`.** Structure mirrors ngspice's load function line-by-line where possible. Cite specific ngspice line ranges in comments.

3. **Delete `_updateOp()` and `_stampCompanion()`.** The whole methods, not just their bodies.

4. **Delete invented cross-method state slots.** From the device's `stateSchema`. Slots that had direct ngspice correspondences in `device-mappings.ts` survive (those are the ones kept after papering removal). Any slot that only existed to transit values between `_updateOp` and `_stampCompanion` is deleted. **Additionally, delete cached `Float64Array` references to `pool.states[N]` held as device member variables.** Every state access in the new `load()` goes through `pool.states[0]` (or the compiled access path) at call time. Ngspice does not cache `CKTstate0` pointers on devices, and neither does the ported code. This is the fix for the stale-ref issue surfaced after A4's deletion of `refreshElementRefs`.

5. **Apply test handling rule** (`spec/architectural-alignment.md` §A1):
   - Delete tests asserting on hand-computed expected values of intermediate state.
   - Delete tests that call `_updateOp` / `_stampCompanion` directly.
   - Keep tests asserting on post-load observable state (matrix stamps, RHS contents, node voltages).
   - Keep parameter-plumbing tests (setParam propagation, default values).
   - Keep engine-agnostic interface contracts.

6. **Commit** with message: `Phase 2.5 W1.x — <device family> load() port`.

### W1.1 — Diode family

**Files:**
- `src/components/semiconductors/diode.ts` + `__tests__/diode.test.ts`
- `src/components/semiconductors/zener.ts` + `__tests__/zener.test.ts`
- `src/components/semiconductors/varactor.ts` — **delete the invented varactor simulation code** per F2; **retain** the `VaractorElement` visual class + `VaractorDefinition` palette entry; factory routes placements to `createDiodeElement` with varactor-specific params (same pattern as `schottky.ts`). No shim layer, no type assertions, no re-exports of diode symbols under varactor names — if any are present, the port has introduced a shim and must be redone. **Amended 2026-04-22** (original text read "delete the file per F2"; ambiguous against F2's architectural intent — F2 targets the invented simulation code, not user-facing palette symbols)
- `src/components/semiconductors/__tests__/diode-state-pool.test.ts` — delete (inspects intermediate pool state)

**Ngspice source:** `ref/ngspice/src/spicelib/devices/dio/dioload.c` — read `DIOload` entire function. Key sections:
- Junction voltage selection per cktMode (INITJCT / INITFIX / INITTRAN / UIC / SmallSig branches) — `dioload.c:120-200`
- `pnjlim` with Gillespie branch (D4) — read `ref/ngspice/src/spicelib/devices/devsup.c::pnjlim` including the vd<0 Gillespie branch
- Junction current + conductance — `dioload.c:220-260`
- Capacitance + charge (Q, CCAP) — `dioload.c:300-370`
- Matrix/RHS stamps — `dioload.c:380-end`

**Track A items landed in this lane:** D2 (MODEINITSMSIG body), D4 (pnjlim Gillespie branch), F2 (varactor → diode), partial of A1 (diode's slot excision).

**PARITY items carried forward:** D-1 (`Math.min(vd/nVt, 700)` removal — must be absent in the ported code).

### W1.2 — BJT (L0 + L1)

**Files:**
- `src/components/semiconductors/bjt.ts` + `__tests__/bjt.test.ts`

**Ngspice source:** `ref/ngspice/src/spicelib/devices/bjt/bjtload.c` — read `BJTload` entire function. Key sections:
- Initial guess + limiting per cktMode — `bjtload.c:170-280`
- Gummel-Poon equations — `bjtload.c:300-500`
- Capacitance (cbe / cbc / csub) + charge — `bjtload.c:550-680`
- Cap-companion geq/ieq lumped into Gpi/Gmu/Ic/Ib slots — `bjtload.c:725-734` (NOTE: no invented `CAP_GEQ_*` cross-method slots — the lumping is inline)
- Matrix/RHS stamps — `bjtload.c:735-end`

**Track A items landed:** D3 (BJT L1 `dt > 0` gate), partial of A1 (BJT's 7 invented cap slots excised).

**PARITY items carried forward:** none pre-specced; D-8-analog regression check applies post-port.

### W1.3 — MOSFET (L1) + G1 sign convention

**Files:**
- `src/components/semiconductors/mosfet.ts` + `__tests__/mosfet.test.ts`

**Ngspice source:** `ref/ngspice/src/spicelib/devices/mos1/mos1load.c` — read `MOS1load` entire function. Key sections:
- Junction voltage & vbs/vbd sign (G1 — digiTS has used VSB/VBD inversion; port to ngspice VBS/VBD convention) — `mos1load.c:150-250`
- Mosfet current/conductance (mos1 equations) — `mos1load.c:300-500`
- Meyer capacitance model + bulk junction caps — `mos1load.c:550-750`
- Matrix/RHS stamps — `mos1load.c:800-end`

**Track A items landed:** A1 (MOSFET 11 invented cap+Q slots excised), G1 (sign convention), C-AUD-8 resolution (cgs_cgd regression — verify bit-exact post-port; if not, D-8 becomes post-A1 PARITY ticket per 2026-04-21 canary ruling).

### W1.4 — JFET family

**Files:**
- `src/components/semiconductors/njfet.ts` + `pjfet.ts` + `fet-base.ts`
- `__tests__/jfet.test.ts`, `fet-base.test.ts`

**Ngspice source:** `ref/ngspice/src/spicelib/devices/jfet/jfetload.c` — read `JFETload` entire function. Key sections:
- Junction voltages + limiting — `jfetload.c:120-200`
- JFET current model (Shichman-Hodges) — `jfetload.c:250-400`
- Gate capacitances — `jfetload.c:420-550`
- Matrix/RHS stamps — `jfetload.c:580-end`

**Note:** `fet-base.ts` class abstraction is obsolete under A1 (per D-10). Collapse NJFET and PJFET each into its own `load()` with sign-polarity inline. Delete `fet-base.ts` entirely.

**PARITY items carried forward:** A-1, A-2 (`Math.min(expArg, 80)` absent in the ports).

### W1.5 — Reactive passives

**Files:**
- `src/components/passives/capacitor.ts` + `polarized-cap.ts` + `inductor.ts` + `transformer.ts` + `tapped-transformer.ts`
- Respective test files

**Ngspice source:** `ref/ngspice/src/spicelib/devices/cap/capload.c`, `ind/indload.c`. Transformer / polarized-cap / tapped-transformer are digiTS extensions on top of these — port the ngspice primitives exactly, layer the extensions.

**Track A items landed:** A1 slot excision (capacitor Q/CCAP are direct ngspice correspondences, survive).

**PARITY items carried forward:** D-15 (capacitor default `_IC = 0.0` + unconditional cond1 use).

### W1.6 — F4c digiTS-only semiconductors

**Files:** `triac.ts`, `scr.ts`, `diac.ts`, `tunnel-diode.ts`, `triode.ts`, `led.ts` + tests

**No ngspice source.** These are APPROVED ACCEPT digiTS-only devices. Each gets a `load()` method that wraps the existing digiTS-only logic — the port is mechanical (fold `_updateOp` body + `_stampCompanion` body into a single `load()`), not semantic.

**Specific items:** E-1 (PAPERED-RE-OPEN per reconciliation) — strip `dioload.c:130-136` citation from triac.ts:303. Triac is digiTS-only; the gate must not be framed as an ngspice port. If the gate's only justification was port-framing, delete the gate.

**Tests:** self-compare snapshots against committed reference data (per F4c constraint §1). No ngspice harness comparison.

### W1.7 — F4c digiTS-only passives / sensors

**Files:** `crystal.ts`, `transmission-line.ts`, `memristor.ts`, `analog-fuse.ts`, `ntc-thermistor.ts`, `spark-gap.ts` + tests

Same pattern as W1.6 — no ngspice source, mechanical fold of `_updateOp` + `_stampCompanion` into `load()`.

### W1.8 — Active devices (AMENDED 2026-04-22)

**Original scope error:** W1.8 as originally authored lumped 8 active devices as "F4b composites". Cross-check against `spec/architectural-alignment.md` F-series (§F4) revealed only 1 of the 8 was actually F4b in the source doc; the rest were already F4c (or F4a). The W1.8 executor's reclassification was partially correct — for the five genuinely behavioral devices it was the right call — but silently declaring the wave done was the papering pattern, not a valid closing verdict.

**Triage ruling (2026-04-22):**

| Device | Pre-W1.8 classification in `architectural-alignment.md` | Ruling | Landed code at `b6e52a6a` |
|---|---|---|---|
| `real-opamp.ts` | F4c | **F4c confirmed** — behavioral BDF-1 companion + slew clamp; no ngspice primitive | **Keep as-is** (F4c self-compare) |
| `comparator.ts` | F4c | **F4c confirmed** — hysteresis state machine; no ngspice primitive | **Keep as-is** |
| `ota.ts` | F4c | **F4c confirmed** — VCCS + tanh; tanh saturation is digiTS-owned | **Keep as-is** |
| `schmitt-trigger.ts` | F4c | **F4c confirmed** — hysteresis state machine by definition | **Keep as-is** |
| `opamp.ts` (ideal) | F4c | **F4c confirmed** — ngspice has no ideal-opamp primitive | **Keep as-is** |
| `optocoupler.ts` | F4b | **F4b — composition pending (W1.8a)** — LED really is a diode; phototransistor really is a BJT | Shortcut PWL — incomplete |
| `analog-switch.ts` | F4a | **F4a — direct port pending (W1.8b)** — `sw/*` VSWITCH primitive exists | Behavioral `R_on`/`R_off` — incomplete |
| `timer-555.ts` | F4c → **F4b** | **F4b promotion — composition pending (W1.8c)** — genuine composite of comparators + RS flip-flop + BJT + R-divider; all primitives exist in W1.x | Behavioral — incomplete |

The five F4c-confirmed devices need no further W1.x work — they are landed under F4c self-compare rules (see F4 constraint §3 in `architectural-alignment.md`: tests cite "self-compare snapshot"; no "equivalent to ngspice X" claims in comments). Any remaining tests that claim ngspice equivalence for these devices are deleted per A1 §Test handling rule in the normal course of W2.4.

The three composition lanes (W1.8a, W1.8b, W1.8c) complete the wave. None block W1.9; all can run in parallel.

### W1.8a — Optocoupler composition (F4b)

**Files:** `src/components/active/optocoupler.ts` + `__tests__/optocoupler.test.ts`

**Ngspice reference:** no single primitive; compose from `ref/ngspice/src/spicelib/devices/dio/dioload.c` (LED junction) and `ref/ngspice/src/spicelib/devices/bjt/bjtload.c` (phototransistor). Coupling is a CCCS whose source current is the LED's forward current scaled by the optocoupler's CTR (current-transfer ratio) parameter; coupling primitive is ngspice `cccs/*` (F source).

**Process:**
1. Replace the inline PWL LED with an instantiated `DiodeElement` configured with LED-forward-voltage params (`Vf`, `Is`, `n`) exposed on the optocoupler's public param surface.
2. Replace the inline phototransistor current-driven behavior with an instantiated `BJTElement` whose base current is supplied by a CCCS driven by the LED forward current scaled by `CTR`. The BJT's other terminals wire to the package collector/emitter.
3. Delete any remaining inline junction/conductance computation — all of it is now handled by the instantiated diode and BJT `load()` methods.
4. Optocoupler's own `load()` composes: diode `load()` on the input side, CCCS stamp for the coupling, BJT `load()` on the output side. No new `_updateOp`/`_stampCompanion` invention.
5. Apply A1 §Test handling rule to tests — delete hand-computed expected values; keep parameter-plumbing (`Vf`, `CTR`, etc.) and post-load observable-state tests.

**Commit:** `Phase 2.5 W1.8a — optocoupler composition (LED + phototransistor + CCCS)`

### W1.8b — Analog-switch direct port (F4a)

**Files:** `src/components/active/analog-switch.ts` + `__tests__/analog-switch.test.ts`

**Ngspice reference:** `ref/ngspice/src/spicelib/devices/sw/swload.c` — read `SWload` entire function. Key sections: voltage-controlled threshold logic, `Ron`/`Roff` transition, hysteresis handling if present in our schema.

**Process:**
1. Rewrite `load()` to mirror `SWload` directly. Ngspice's `S` element has a control voltage, on-threshold, off-threshold, `Ron`, `Roff`, and a transition function — map each digiTS param to the corresponding ngspice `SWmodel` field.
2. Remove any behavioral `R_on`/`R_off` logic that doesn't correspond to `swload.c`.
3. If the digiTS analog-switch has features beyond the ngspice `S` primitive (e.g., rise-time limited switching), those features are F4c-behavioral extensions and are labelled as such in a comment block — the parity-comparable portion matches `SWload` bit-exact.
4. Apply A1 §Test handling rule.

**Commit:** `Phase 2.5 W1.8b — analog-switch port to sw/* VSWITCH primitive`

### W1.8c — 555 timer composition (F4b, promoted from F4c)

**Files:** `src/components/active/timer-555.ts` + `__tests__/timer-555.test.ts`

**Ngspice reference:** no single primitive. The 555's textbook internal schematic composes:
- Two comparators (use the `comparator.ts` F4c-behavioral device as internal building blocks OR, if the BJT-diff-pair composite version lands first, use that — for W1.8c's scope, `comparator.ts` F4c is fine since the 555 itself is F4b via composition, not F4b via purely-F4a primitives).
- An RS flip-flop (digital primitive; digiTS has one in the digital layer or it composes from two cross-coupled gates).
- A BJT discharge transistor (instantiate `BJTElement`).
- An internal R-divider (instantiate three `ResistorElement` instances, or a parameterized `res/*` chain).

**Process:**
1. Rewrite `timer-555.ts` to instantiate the sub-components above and wire them per the 555's internal schematic. The device's `load()` composes by calling each sub-component's `load()` (or by emitting them into the netlist at compile time, if the codebase's composite pattern works that way — match whatever W1.8a optocoupler establishes).
2. Delete inline behavioral threshold logic, inline flip-flop state, inline discharge transistor modeling.
3. Preserve the public param surface (`Vcc`, threshold levels, output polarity) by mapping to the internal R-divider values and comparator thresholds.
4. Apply A1 §Test handling rule.
5. **Note on F4b-via-F4c:** Using `comparator.ts` (F4c-behavioral) inside a F4b composite is acceptable because the *555's composition shape* matches ngspice's textbook schematic; parity harness comparison happens at the 555's external terminals, not at the comparator's internal node voltages. The internal comparators are implementation detail.

**Commit:** `Phase 2.5 W1.8c — 555 timer composition (2 comparators + RS FF + BJT + R-divider)`

### W1.9 — `device-mappings.ts` schema sync

**Scope:** harness-infrastructure sync lane. Single-file, serial, cheap. Not a per-device port — picks up the slot-correspondence drift that each W1.x lane created when renaming schema slots to match ngspice.

**Rationale:** per §1 principle 2 (file-scope partitioning) each W1.x lane is bounded to its device files and does not touch the harness. Slot renames therefore accumulate in `device-mappings.ts` as stale key references until swept here. Making each W1.x lane edit `device-mappings.ts` inline would turn it into a merge-conflict hot spot across parallelizable lanes, which W1.9 avoids.

**Files:**
- `src/solver/analog/__tests__/harness/device-mappings.ts`

**Process:**
1. For every `DeviceMapping` in the file, cross-check current `slotToNgspice` / `ngspiceToSlot` keys against the post-port `stateSchema` in the corresponding device's `.ts` file.
2. Update renamed keys to match the device-side names. Known drift at the time this lane opens:
   - W1.2 BJT: `IC→CC`, `IB→CB`, `Q_BE→QBE`, `CCAP_BE→CQBE`, `CEXBC_NOW→CEXBC` (plus the analogous `_BC` / `_CS` renames).
   - W1.1 diode: walk schema at `diode.ts` and reconcile any slot-name changes against the mapping's current keys.
   - W1.3–W1.8: whatever renames those lanes introduce; sweep at the time W1.9 runs.
3. Preserve ngspice offset integers — they come from ngspice header files (`diodefs.h`, `bjtdefs.h`, `mos1defs.h`, `jfetdefs.h`, `capdefs.h`, `inddefs.h`) and do not change. Only slot-name keys shift.
4. Add mappings for any new slot that corresponds to an existing ngspice offset and didn't exist pre-W1.x. Omit any mapping whose slot was excised by A1 (cross-method transfer slots are deleted, not re-mapped under a new name).
5. Run `npm run test:q -- src/solver/analog/__tests__/harness src/solver/analog/__tests__/ngspice-parity` and confirm no "slot not found" / undefined-key errors from lookup drift. Convergence failures are not W1.9's concern — they go to W3.
6. Commit: `Phase 2.5 W1.9 — device-mappings.ts schema sync`.

**What this lane does NOT do:**
- No harness architecture changes (the broader harness rewrite to actually compare raw values per-NR-iteration is a post-A1 follow-up — see `spec/baseline-reality.md` §4).
- No new comparison sites, no tolerance re-introduction, no translation tables, no `derivedNgspiceSlots` blocks. The papering-removal stance from commit `dcf56e23` is permanent.
- No per-device `.ts` edits. W1.1–W1.8 are landed and stand.

**Dependency:** every W1.x lane from W1.1 through W1.8 must be committed before W1.9 opens. W1.9 is the terminal lane of the W1 block; W2.x lanes can already run in parallel with W1.x and do not depend on W1.9.

---

## 5. Wave W2.x — Solver / control-flow / infrastructure

Parallelizable with W1.x once W0 lands (different files).

### W2.1 — Solver architectural fixes

**Files:** `src/solver/analog/sparse-solver.ts`, `newton-raphson.ts`, `ckt-terr.ts`

**Items:**
- B1: `_numericLUReusePivots` absolute threshold → column-relative per `ngspice/src/sparse/spfactor.c`
- B2: `_hasPivotOrder` conflation → separate `Factored` and `NeedsOrdering` states per ngspice `MATRIX` state
- B3: Gmin stamped inside factor routine, not outside (cite `spfactor.c`)
- B4: `invalidateTopology` trigger parity per ngspice `spalloc.c:170` + `spbuild.c:788` (authoritative sources per `spec/architectural-alignment.md §B4`). Prior text cited `SMPgetError` + `NIcomCof` — neither touches the `NeedsOrdering` state; `SMPgetError` wraps `spWhereSingular` at `spsmp.c:302-308` and `NIcomCof` computes integration coefficients.
- B5: tranInit reorder before iter-0 solve per `ngspice/src/spicelib/analysis/dctran.c::CKTdoJob`

### W2.2 — Control-flow fixes

**Files:** `src/solver/analog/dc-operating-point.ts`, `newton-raphson.ts`, `ckt-mode.ts`, `load-context.ts`

**Items:**
- C1: `dcopFinalize` → single `CKTload` call per `dcop.c`
- C2: delete `_firsttime` flag; write `cktMode = MODEINITTRAN` directly
- C3: remove `iteration` parameter from `cktLoad` (already done in W0)
- D1: `"initSmsig"` mode → `MODEINITSMSIG` bit routes to device code (AC analysis path)
- H1: `ctx.loadCtx.limitingCollector` synced on every `cktLoad` call per `dctran.c::CKTconvTest`
- H2: `addDiagonalGmin` ownership → NR owns, cite `ngspice/src/spicelib/analysis/niiter.c::NIiter`

### W2.3 — `InitMode` string deletion (user ruling 4.3)

**Files:**
- `src/solver/analog/analog-types.ts` — delete `InitMode` string type entirely
- `src/solver/analog/__tests__/harness/**` — replace `InitMode` references with `bitsToName(cktMode)` helper
- All production sites still referring to `initMode` string — already largely done by C2, this wave sweeps residue

**New helper:** add `bitsToName(mode: number): string` to `ckt-mode.ts`, returning human-readable names like `"MODEINITJCT"` / `"MODEINITFIX"` / `"MODETRAN"` for harness diagnostics.

### W2.4 — Aggressive I1 test regeneration

**Scope:** the 852 `toBeCloseTo` sites + the ~44 concrete suppression sites from `spec/i1-suppression-backlog.md`.

**Rule per A1 §Test handling:**
- Delete any test assertion whose expected value was computed by hand.
- Keep any test assertion whose expected value came from the ngspice harness (see `docs/ngspice-harness-howto.md` — or recreate if missing).
- Keep parameter-plumbing tests.
- Keep engine-agnostic interface contracts.

**Process (per test file):**
1. Open the file. Identify every assertion.
2. For each assertion: does the expected value have a provenance comment pointing to ngspice harness output? If yes, keep. If no (hand-computed or untraceable), delete the assertion.
3. If the file ends with zero remaining assertions, delete the file.

**Suppression sweep (44 concrete sites from `spec/i1-suppression-backlog.md`):**
- Silent catches: convert to explicit rethrow or delete the try/catch if the call is safe.
- `@ts-expect-error` without linked issue: remove the directive, fix the underlying type if needed, or escalate.
- Unreferenced `.skip` / `.todo`: either link to a Track A ID or delete.

---

## 6. Wave W3 — Post-A1 static audit (revised 2026-04-22)

**Superseded design:** original W3 was "run strict harness, classify red output." Premise broken — strict-by-default plus non-convergent BJT/MOSFET/JFET produces 15+ minute timeouts and no signal. Full convergence verification is deferred to Phase 9 acceptance (plan.md Appendix A 8-circuit harness) after Phase 3+ re-authoring lands. See §6.8.

**Revised W3:** five parallel static-audit lane types, producing `spec/post-a1-parity.md` as handoff to Phase 3+. Agents find divergences; user consolidates findings into the parity list. No harness run.

Collapsed classification: every finding is **PARITY** (divergence from ngspice / architectural-alignment.md, fix bit-exact in Phase 3+) or **PAPERING-RESIDUE** (violates F4c constraint or I1 policy, fix before Phase 3+). The original convergence / suppression / test-deletion triad was a distinction without difference at the work-item level — every divergence cashes out as "align to ngspice or to spec, bit-exact."

### 6.1 L1a — Small-device parity audit (7 sonnet lanes, parallel)

Devices: diode, zener, capacitor, polarized-cap, inductor, transformer, tapped-transformer. These finished in W1.1 + W1.5 and have no downstream plan.md phase to revisit them. Last-chance parity audit: line-by-line semantic comparison of our ported `load()` against the cited ngspice load function. Output per lane: structured findings table. Severity: CRITICAL / HIGH / MEDIUM / LOW.

**Folds in watch item from prior §6.5:** unmapped digiTS-only integration slots (diode `CCAP`, inductor `CCAP`, peer W1.5 slots). L1a lanes trace the write/read lifetime for each such slot. Within-frame write-then-read → cross-method transfer slot that escaped A1 → PARITY item to excise. Cross-timestep write/read → genuine per-device state → flag for `architectural-alignment.md` §I2 note (no `slotToNgspice` entry added — unmapped is the correct harness stance).

### 6.2 L1b — BJT / MOSFET / JFET port-integrity audit (3 sonnet lanes, parallel)

Devices: BJT (W1.2), MOSFET (W1.3), JFET (W1.4). Narrower scope than L1a — Phase 5/6/7 do full parity via REWRITE tasks. L1b looks only for **transcription errors** introduced during the W1.2/W1.3/W1.4 ports (sign flips, wrong constants, missing branches, copy-paste regressions). Cross-reference filter: if a finding matches a row in `spec/plan-addendum.md` Phase 5/6/7 REWRITE list, skip — it's enumerated. Only unenumerated findings become W3 signal.

### 6.3 L1c — F4c constraint audit (~12 haiku lanes, parallel)

Devices: triac, scr, diac, tunnel-diode, triode, LED, crystal, transmission-line, memristor, analog-fuse, ntc-thermistor, spark-gap. F4c APPROVED ACCEPT devices may not cite ngspice (per `architectural-alignment.md` §F4c §3). E-1 triac was the prototype papering case.

Per-device checklist:
1. Grep device file for ngspice citations (`dioload.c`, `bjtload.c`, `mos1load.c`, `jfetload.c`, `capload.c`, `indload.c`). Any finding = papering residue.
2. Check `load()` mechanically folds pre-A1 `_updateOp` + `_stampCompanion` body without semantic ngspice-ported claims in comments.
3. Verify self-compare snapshot file (if present) has date ≥ W1.6 / W1.7 commit.

### 6.4 L2 — Test sweep (1 haiku lane, PROPOSAL ONLY)

Walks every test file under `src/**/__tests__/`. Per test, flag for deletion if any of:

- References `_updateOp`, `_stampCompanion`, `refreshElementRefs`, `InitMode`, `pool.uic`, `pool.analysisMode`, `poolBackedElements`
- References deleted slots: `SLOT_CAP_GEQ*`, `SLOT_IEQ*`, `L1_SLOT_CAP_GEQ_*`, `L1_SLOT_IEQ_*`, `SLOT_CAP_GEQ_GS/_GD/_DB/_SB/_GB`, `SLOT_IEQ_GS/_GD/_DB/_SB/_GB`, `SLOT_Q_GS/_GD/_GB/_DB/_SB`, `SLOT_GD_JUNCTION`, `SLOT_ID_JUNCTION`
- `toBeCloseTo` / `toBe` with hand-computed numeric and no `// from ngspice harness run <cite>` provenance
- Asserts method call counts of `_updateOp` / `_stampCompanion`
- References `TUNNEL_DIODE_MAPPING`, `VARACTOR_MAPPING`, `derivedNgspiceSlots`, `VSB`/`VBD` old MOSFET names

Survivors (per `architectural-alignment.md` §A1 Test handling): parameter plumbing, F4c self-compares with fresh reference, engine-agnostic interface contracts.

Output: proposed deletion list (file → reason). **No deletions executed.** User reviews before a separate L2-execute commit.

**Watch item fold:** `mna-end-to-end::rl_dc_steady_state_tight_tolerance` (observed 97.56 vs expected `<0.1` at W2.1 close). L2 flags test for review. If assertion is hand-computed: delete. If traceable to ngspice harness: keep and classify underlying divergence as PARITY item under L1a inductor / W2.1 B5 RL-step handling.

### 6.5 L3 — Suppression residue sweep (1 haiku lane)

Walks `spec/i1-suppression-backlog.md`. For each concrete site + the `toBeCloseTo` sweep category, verifies current-main status — `DONE` if removed, `RESIDUE` with file:line + removal approach if still present.

### 6.6 `post-a1-parity.md` structure

```
# Post-A1 Parity List
Generated: <date> | Input: W3 L1a + L1b + L1c + L2 + L3 audit outputs

## §1. Device parity findings (L1a + L1b)
## §2. F4c papering residue (L1c)
## §3. Suppression residue (L3)
## §4. Deleted-test manifest (L2, after execution)
## §5. Carry-forwards from reconciliation-notes.md §5
## §6. Handoff pointer to spec/phase-3-onwards.md
```

### 6.7 Commits

- `Phase 2.5 W3 — static audit consolidated, post-a1-parity.md landed`
- `Phase 2.5 W3 L2 — stale test deletion per user-approved list` (separate, after review)
- `Phase 2.5 complete — Track A landed, post-A1 PARITY list captured`

### 6.8 Why not run the harness

Convergence verification is a Phase 9 acceptance concern. Running the harness now produces timeouts, not signal — BJT/MOSFET/JFET cannot converge until Phases 5/6/7 re-author their surviving REWRITE tasks against post-A1 `load()`. The 8-circuit bit-exact harness (plan.md Appendix A) is the right and only place for convergence proof, after Phase 3+ lands. The original W3 design conflated that acceptance gate with the post-Phase-2.5 handoff.

### 6.9 W4 — post-a1-parity.md closure (15 parallel lanes)

**Precondition:** W3 static audit complete (commit `42f9b5dd` — `spec/post-a1-parity.md` landed). A1 gate commit `d23f3ebd` verified:
- `stampElement` / `stampRHS` semantics are **ADDITIVE** (matches ngspice `*ptr += val`). Documented at `src/solver/analog/sparse-solver.ts:62`.
- `LoadContext.rhsOld` already present; `LoadContext.cktFixLimit` added at every construction site. Engine site at `ckt-context.ts:556-582` threads real Float64Arrays. 35 test-fixture sites default-filled `cktFixLimit: false`.
- Verdict: **GO** for all W4.B / W4.C / W4.D lanes.

**User rulings (2026-04-22):** every ambiguity in `spec/post-a1-parity.md` resolves to **match ngspice**. No items deferred. Specifically:

1. PC-W3-1 clamp-diode node choice: **nPos / nNeg** (ngspice has no ESR internal node).
2. TT-W3-5 flux expression: **two-pass self + mutual** (ngspice structure).
3. C-W3-2 multiplicity `m`: **apply at stamp time** (ngspice structure; removes hot-reload footgun).
4. D-W3-4 vestigial SLOT_V: **grep-verify reads outside `load()` + harness; delete if unused** (no ngspice analog).
5. D-W3-5 BV_given flag: **add** (ngspice uses `DIObreakdownVoltageGiven`).
6. D-W3-6 / D-W3-7 sidewall + tunnel current: **port verbatim from `dioload.c:209-285`**.
7. Z-W3-5 tBV temperature scaling: **pulled forward into W4.B.2** (was plan-addendum 4.3.3).
8. B-W3-3 / B-W3-4 / B-W3-5 BJT Phase-5 cross-refs: **pulled forward into W4.B.9**.
9. C-4 lifecycle verifier (D1): **spawn now (W4.D)**.

**Spawning protocol:** A1 gate (W4.A) is landed. All W4.B.x + W4.C.x + W4.D lanes may spawn in parallel. Each lane owns its file surface — no merge contention. One commit per lane, per §1 principle 6. Expected fleet: 10 sonnet device lanes + 3 haiku support lanes + 1 haiku L2-deletion lane + 1 sonnet verifier = 15 parallel agents.

**Per-lane common rules (in addition to §1 and §8):**
- Banned closing verdicts: *mapping*, *tolerance*, *close enough*, *equivalent to*, *pre-existing*, *intentional divergence*, *citation divergence*, *partial*. Escalate to user instead.
- No self-correction for convergence. If a port does not converge, surface and stop.
- Cite ngspice by file:line in every numerical change.
- Use `Grep` / `Glob` / `Read` / `Edit` — never bash `grep` / `find` / `rg`.
- A1 gate verdict is binding: stamps are additive. Do not re-verify.
- Tests may fail during and after the wave. Delete per A1 §Test handling rule; do not modify code to chase a test.
- Each lane reads `spec/post-a1-parity.md §<device-section>` for the authoritative finding list + remedies + verify-greps. This spec references them by ID; `post-a1-parity.md` is the full row detail.

---

#### W4.A — A1 gate (landed)

**Commit:** `d23f3ebd` (2026-04-22). Stamp semantics ADDITIVE; LoadContext fields wired. GO for downstream.

---

#### W4.B device re-port lanes (sonnet, fully parallel)

Each lane owns one device file surface. Bundles every `post-a1-parity.md §1.<device>` finding — CRITICAL through LOW — into one commit.

##### W4.B.1 — Diode

**Files:** `src/components/semiconductors/diode.ts`, `src/components/semiconductors/__tests__/diode.test.ts`
**Findings (`post-a1-parity.md §1.1`):** D-W3-1, D-W3-2, D-W3-3, D-W3-4, D-W3-5, D-W3-6, D-W3-7
**Source:** `ref/ngspice/src/spicelib/devices/dio/dioload.c` (full `DIOload`, lines 21–445)
**Scope:**
- IKF/IKR Norton-pair re-derivation per `dioload.c:292-312` (D-W3-1, D-W3-2)
- MODEINITPRED cascade cleanup per `dioload.c:141-149` (D-W3-3)
- Grep-verify SLOT_V reads outside `load()` + harness mappings; delete slot + write if zero hits (D-W3-4)
- Add `BV_given` flag mirroring ngspice `DIObreakdownVoltageGiven` (D-W3-5)
- Port sidewall current block verbatim from `dioload.c:209-243` — `csatsw`, `cdsw`, `gdsw`, `DIOswEmissionCoeff` + schema additions (D-W3-6)
- Port tunnel current block verbatim from `dioload.c:267-285` — `DIOtunSatSWCur`, `DIOtunSatCur` + schema additions (D-W3-7)

**Commit:** `Phase 2.5 W4.B.1 — diode W3 findings + sidewall/tunnel port`

##### W4.B.2 — Zener

**Files:** `src/components/semiconductors/zener.ts`, `src/components/semiconductors/__tests__/zener.test.ts`
**Findings (`post-a1-parity.md §1.2`):** Z-W3-1 through Z-W3-9 (all)
**Source:** `dioload.c:126-312`, `dio/diosetup.c` (temperature scaling)
**Scope:**
- Three-region structure (forward / reverse-cubic / breakdown) per `dioload.c:245-265` (Z-W3-1, Z-W3-2)
- GMIN Norton pair per `dioload.c:297-299` (Z-W3-3)
- 4-branch MODEINITJCT dispatch per `dioload.c:130-138` mirroring post-W1.1 diode (Z-W3-4)
- **Pulled forward from plan-addendum 4.3.3:** tBV temperature scaling from `dio/diosetup.c` — replace every `params.BV` with `tBV` in breakdown paths (Z-W3-5)
- Breakdown pnjlim `vcrit` using `nbvVt` per `dioload.c:189-190` (Z-W3-6)
- state0 GMIN-adjusted writes per `dioload.c:417-419` (Z-W3-7)
- MODEINITSMSIG branch per `dioload.c:126-128` (Z-W3-8)
- MODEINITTRAN state1 seed per `dioload.c:128-129` (Z-W3-9)

**Commit:** `Phase 2.5 W4.B.2 — zener three-region + tBV + SMSIG/INITTRAN branches`

##### W4.B.3 — Polarized-cap

**Files:** `src/components/passives/polarized-cap.ts`, `src/components/passives/__tests__/polarized-cap.test.ts`
**Findings (`post-a1-parity.md §1.4`):** PC-W3-1 through PC-W3-6 (PC-W3-2 / PC-W3-3 already scoped with gate fixes; do them in this lane)
**Source:** `cap/capload.c`, `dio/dioload.c:245-265`
**User ruling:** clamp-diode nodes = **nPos / nNeg** (full terminal).
**Scope:**
- Inline reverse-bias clamp diode between nPos / nNeg, Shockley forward/reverse per `dioload.c:245-265` (PC-W3-1)
- Outer gate add `MODEAC` per `capload.c:30` (PC-W3-2)
- Inner fork add `MODEAC` per `capload.c:52` (PC-W3-3)
- F4b parity harness test — compare matrix entries for cap-body + clamp diode against ngspice bit-exact (PC-W3-4)
- `IC` (alias `initCond`) param, default 0 (PC-W3-5)
- `M` multiplicity param — apply at stamp time per user ruling 3 (PC-W3-6)

**Commit:** `Phase 2.5 W4.B.3 — polarized-cap clamp diode + F4b completion`

##### W4.B.4 — Inductor

**Files:** `src/components/passives/inductor.ts`, `src/components/passives/__tests__/inductor.test.ts`
**Findings (`post-a1-parity.md §1.5`):** I-W3-1, I-W3-2, I-W3-3, I-W3-5
**Source:** `ind/indload.c:41-123`

**CRITICAL ALIAS CHECK — read before patching I-W3-1:** `src/solver/analog/load-context.ts:80-88` documents `voltages` and `rhsOld` as **aliases for the same Float64Array** ("both point at the same Float64Array on the ckt"). If runtime confirms this aliasing, the I-W3-1 remedy (`voltages[b]` → `ctx.rhsOld[b]`) is a cosmetic rename and the real bug is elsewhere — re-diagnose by reading the NR swap logic in `src/solver/analog/newton-raphson.ts` and `src/solver/analog/ckt-context.ts`. Candidates: reading `ctx.rhs[b]` (current iterate) when `ctx.rhsOld[b]` (prior accepted) is intended; or swap ordering where the prior-accepted solution is overwritten before the flux write reads it. **Escalate if the real fix does not land at `inductor.ts:285-289`** — do not close the item with a cosmetic rename.

**Scope:**
- I-W3-1: verify aliasing, then apply real fix (aligned with `indload.c:43-51`)
- Remove spurious `MODEDC & MODEINITJCT` arm per `indload.c:43-44` (I-W3-2)
- Add SLOT_VOLT s0→s1 copy on MODEINITTRAN per `indload.c:114-117` (I-W3-3)
- Restructure state-copy ordering to mirror ngspice per `indload.c:88-123` (I-W3-5)

**Commit:** `Phase 2.5 W4.B.4 — inductor rhsOld fix + state-copy ordering`

##### W4.B.5 — Transformer

**Files:** `src/components/passives/transformer.ts`, `src/components/passives/coupled-inductor.ts` (dead-code cleanup), `src/components/passives/__tests__/transformer.test.ts`
**Findings (`post-a1-parity.md §1.6`):** T-W3-1, T-W3-2, T-W3-3, T-W3-4, T-W3-5, T-W3-6
**Source:** `ind/indload.c:41-123` (inline MUTUAL block)
**Scope:**
- `branchCount: 1 → 2` at modelRegistry entry (T-W3-1)
- Integration gate `!(MODEDC)` per `indload.c:88` (T-W3-2)
- Replace manual ag-expansion with SLOT_CCAP1 / SLOT_CCAP2 + two `niIntegrate()` calls; mutual companion `g12 = ag[0] * M` per `indload.c:74-75, 108` (T-W3-3)
- `IC1` / `IC2` params + MODEUIC flux seed per `indload.c:44-46` (T-W3-4)
- `M` multiplicity param — apply at stamp time per user ruling 3 (T-W3-5)
- SLOT_VOLT1 / SLOT_VOLT2 + MODEINITTRAN copy per `indload.c:114-116` (T-W3-6)
- Delete `coupled-inductor.ts::CoupledInductorState` + `createState()` (dead code flagged in `post-a1-parity.md §1.6` extra observation)

**Commit:** `Phase 2.5 W4.B.5 — transformer NIintegrate + UIC + branchCount`

##### W4.B.6 — Tapped-transformer

**Files:** `src/components/passives/tapped-transformer.ts`, `src/components/passives/__tests__/tapped-transformer.test.ts`
**Findings (`post-a1-parity.md §1.7`):** TT-W3-1, TT-W3-2, TT-W3-3, TT-W3-4, TT-W3-5, TT-W3-6
**Source:** `ind/indload.c:41-123`
**User ruling:** TT-W3-5 flux = **two-pass** (self-loop + mutual-loop per ngspice).
**Scope:**
- `branchCount: 1 → 3` (TT-W3-1)
- MODEINITTRAN flux-copy ordering restructure (copy happens after NIintegrate) per `indload.c` (TT-W3-2)
- Integration gate `!(MODEDC)` (TT-W3-3)
- SLOT_VOLT1/2/3 slots + MODEINITTRAN copy per `indload.c:114-116` (TT-W3-4)
- Split combined flux into two-pass (TT-W3-5)
- `setParam` closure-override warning comment (TT-W3-6)

**Commit:** `Phase 2.5 W4.B.6 — tapped-transformer two-pass flux + branchCount + SLOT_VOLT`

##### W4.B.7 — Capacitor

**Files:** `src/components/passives/capacitor.ts`, `src/components/passives/__tests__/capacitor.test.ts`, `src/solver/analog/ni-integrate.ts`
**Findings (`post-a1-parity.md §1.3`):** C-W3-2, C-W3-3 (C-W3-1 closed by W4.A gate — stamps are additive)
**Source:** `cap/capload.c:30-77`
**User ruling:** C-W3-2 = **Option A** (apply `m` at stamp time).
**Scope:**
- Apply `m` at stamp sites per `capload.c:44` — pass `m * geq`, `m * ceq` to `solver.stampElement` / `stampRHS`. Remove `_computeEffectiveC()` fold; `C` is param-raw throughout (C-W3-2)
- Add `throw` in `ni-integrate.ts` GEAR branch for unsupported order / method per `capload.c:69` error path (C-W3-3)

**Commit:** `Phase 2.5 W4.B.7 — capacitor m-at-stamp + niIntegrate order validation`

##### W4.B.8 — MOSFET

**Files:** `src/components/semiconductors/mosfet.ts`, `src/components/semiconductors/__tests__/mosfet.test.ts`
**Findings (`post-a1-parity.md §1.9`):** M-W3-1, M-W3-2, M-W3-3, M-W3-4, M-W3-5, M-W3-6
**Source:** `mos1/mos1load.c` full `MOS1load`, `mos1/mos1temp.c:167`

**Sequencing within lane:** M-W3-2 (declare `icheckLimited` as local, reset per call) MUST land before M-W3-6 (gate bump on it). Otherwise M-W3-6 gates on stale closure state.

**Scope:**
- `cktFixLimit` guard on reverse `limvds` per `mos1load.c:385` (M-W3-1; LoadContext field already wired by W4.A)
- `icheckLimited` local reset per `load()` call per `mos1load.c:108` (M-W3-2)
- MODEINITSMSIG **included** in limiting per `mos1load.c:354-406` — remove MODEINITSMSIG from skip-set guard (M-W3-3)
- `von` gamma temperature-correction — read `computeTempParams`; add `tGamma` per `mos1temp.c:167` if absent; use it in `von` formula per `mos1load.c:507` (M-W3-4)
- CQGS/CQGD/CQGB zero-outs into MODETRAN `else` branch per `mos1load.c:875-877` (M-W3-5)
- noncon gate per `mos1load.c:739-743` — `if (params.OFF === 0 || !(mode & (MODEINITFIX | MODEINITSMSIG)))` (M-W3-6; must follow M-W3-2)

**Commit:** `Phase 2.5 W4.B.8 — MOSFET icheckLimited + tGamma + noncon gate`

##### W4.B.9 — BJT

**Files:** `src/components/semiconductors/bjt.ts`, `src/components/semiconductors/__tests__/bjt.test.ts`
**Findings (`post-a1-parity.md §1.8`):** B-W3-1, B-W3-2, B-W3-3, B-W3-4, B-W3-5 (B-W3-3..5 pulled forward from Phase 5 per user ruling 8)
**Source:** `bjt/bjtload.c:488, 525, 583-585, 749, 780`
**Scope:**
- `czsub = tp.tSubcap * params.AREA` per `bjtload.c:583-585` (B-W3-1)
- `evsub` exp-arg clamp to `MAX_EXP_ARG=709` per `bjtload.c:488` (B-W3-2; ngspice-source clamp — NOT a banned per-junction clamp à la D-1, the guard is literally in ngspice)
- Remove `ctx.delta > 0` conjunction from excess-phase gate per `bjtload.c:525` (B-W3-3; from plan-addendum 5.2.10)
- `noncon++` gate on `!(MODEINITFIX && BJToff)` per `bjtload.c:749` (B-W3-4; from plan-addendum 5.1.4 / 5.2.4)
- Add `GX` slot to BJT_SIMPLE_SCHEMA, write `s0[SLOT_GX]=0` in L0 `load()` per `bjtload.c:780` (B-W3-5)

**Commit:** `Phase 2.5 W4.B.9 — BJT AREA + evsub clamp + Phase-5 cross-refs pulled forward`

##### W4.B.10 — JFET

**Files:** `src/components/semiconductors/njfet.ts`, `src/components/semiconductors/pjfet.ts`, `src/components/semiconductors/__tests__/jfet.test.ts`
**Findings (`post-a1-parity.md §1.10`):** J-W3-1, J-W3-2, J-W3-3 (both N and P variants)
**Source:** `jfet/jfetload.c:463-466, 498-508, 536-539`
**Scope:**
- Add `return` after `s0[SLOT_QGS/QGD]` writes under MODEINITSMSIG per `jfetload.c:463-466` — skip stamps. Both files. (J-W3-1)
- noncon gate `if (!(mode & MODEINITFIX) | !(mode & MODEUIC))` per `jfetload.c:498-508` — **bitwise-OR (`|`), not logical-OR (`||`)** — replicate the ngspice quirk exactly. Both files. (J-W3-2)
- Stamp `gdpr` / `gspr` — for collapsed prime↔external nodes, 2 self-stamps: `if (gdpr > 0) stampG(nodeD, nodeD, +gdpr); if (gspr > 0) stampG(nodeS, nodeS, +gspr)`. Per `jfetload.c:536-539`. Both files. (J-W3-3)

**Commit:** `Phase 2.5 W4.B.10 — JFET SMSIG return + noncon gate + RD/RS stamps`

---

#### W4.C support commits

##### W4.C.1 — F4c ngspice framing strip (haiku)

**Files:**
- `src/components/sensors/ntc-thermistor.ts:20` — strip `(matches ngspice DEVload)` from comment
- `src/components/sensors/__tests__/ntc-thermistor.test.ts:328, 362, 364` — strip NGSPICE-reference comments; rename `NGSPICE_G_REF` → `EXPECTED_G`
- `src/components/sensors/spark-gap.ts:29` — same comment strip as NTC
- `src/components/sensors/__tests__/spark-gap.test.ts:375, 407, 418, 422, 426, 429, 432` — strip NGSPICE-reference comments; rename `NGSPICE_G_REF` → `EXPECTED_G`

**Rationale:** NTC + spark-gap are F4c APPROVED ACCEPT devices; citing ngspice's `resload.c` or `DEVload` frames them as ngspice ports, which violates `architectural-alignment.md §F4c §3`.

**Commit:** `Phase 2.5 W4.C.1 — strip F4c ngspice framing from NTC + spark-gap`

##### W4.C.2 — L3 DLL hard-fail gates (haiku)

**Files:**
- `src/solver/analog/__tests__/buckbjt-smoke.test.ts:19` — replace `catch { console.warn(...) }` with `throw new Error('ngspice DLL required for buckbjt smoke test')`
- `src/solver/analog/__tests__/buckbjt-convergence.test.ts:53` — replace `describe.skip` with `throw new Error('ngspice DLL required for buckbjt convergence test')`

**Rationale:** I1 policy — no silent suppression. Missing DLL in a harness test is a hard error, not a silent skip.

**Commit:** `Phase 2.5 W4.C.2 — L3 DLL hard-fail gates`

##### W4.C.3 — L3 silent I/O catches → logged warnings (haiku)

**Files (29 sites across 9 files):**
- `src/components/memory/rom.ts:118` — `catch (err) { console.warn('ROM serialized data corrupt', err); return null; }`
- `src/components/memory/ram.ts:215` — same pattern
- `src/components/memory/eeprom.ts:103` — same pattern
- `src/fixtures/__tests__/shape-audit.test.ts:175` — add element-type + property-key context to the warn
- `src/io/file-resolver.ts:230, 242, 267, 273` (4 sites) — `console.warn` with path + error
- `src/io/ctz-parser.ts:68` — warn citing which deflate format was tried/succeeded
- `src/io/dig-serializer.ts:65, 74, 86, 110` (4 sites) — warn on JSON parse/stringify fallback
- `src/fixtures/__tests__/shape-render-audit.test.ts:217, 241, 301, 392, 416, 457, 878` (7 sites) — consolidate into single factory-error reporter logging element type + error
- `src/fixtures/__tests__/analog-shape-render-audit.test.ts:248, 262, 293, 387, 395, 415, 786` (7 sites) — share reporter with shape-render-audit

**Rationale:** I1 policy — no silent suppression. Each catch becomes a context-rich `console.warn` or an explicit throw. Per `post-a1-parity.md §3.3`.

**Commit:** `Phase 2.5 W4.C.3 — L3 silent I/O catches converted to logged warnings`

##### W4.C.4 — L2 stale test deletions (haiku — APPROVED 2026-04-23)

**User-approved sites** (exact locations per `post-a1-parity.md §4`):

- `src/components/passives/__tests__/polarized-cap.test.ts:492-494` — 3 assertions reading `pool.state0[0/1/2]` with hand-computed `GEQ/IEQ/V_PREV` expected values (A1-deleted slots)
- `src/components/passives/__tests__/polarized-cap.test.ts:661-662` — 2 assertions on `SLOT_GEQ_PC` / `SLOT_IEQ_PC` direct `toBe()` (A1-deleted slots)
- `src/components/passives/__tests__/capacitor.test.ts:569` — 1 assertion `expect(q0_actual).toBe(1e-12)` (hand-computed, no ngspice provenance)
- `src/components/passives/__tests__/crystal.test.ts` — 2 pool state0 assertions (locate exact lines by `Grep "pool.state0\[" src/components/passives/__tests__/crystal.test.ts` at execution time)

**Post-deletion check per file:** if the enclosing `it(...)` / `describe(...)` block becomes empty of assertions, delete the block. If the file becomes empty, delete the file.

**Commit:** `Phase 2.5 W4.C.4 — L2 stale test deletions`

---

#### W4.D — C-4 lifecycle verifier (sonnet)

**Task:** verify that `initVoltages(rhs)` on `behavioral-flipflop.ts:119` is called between DC-OP convergence and the first transient `load()` call. If not wired: patch.

**Steps:**
1. `Grep "initVoltages" src/solver/analog/` to enumerate callers.
2. Read each caller; trace the call path back to the analog engine / coordinator.
3. Confirm sequence: DC-OP runs → DC-OP converges → `initVoltages(rhs)` called on every behavioral element → first transient NR step begins.
4. If sequence broken: patch `analog-engine.ts` / coordinator to wire the call at the correct position.
5. Audit similar `_prev<X>Voltage` / `_prev<X>` fields across `behavioral-*.ts` — each needs an `initVoltages` / `initState` analog wired in the same position. `Grep "_prev[A-Z]" src/solver/analog/behavioral-*.ts`.

**Closes:** `post-a1-parity.md §5 C-4` (currently PARTIAL).

**Commit:** `Phase 2.5 W4.D — C-4 lifecycle verifier + behavioral-* initVoltages audit`

---

### 6.10 Phase 2.5 closure commit (W4.close)

After all W4.B.x + W4.C.x + W4.D lanes land (13 parallel commits):

1. Verify `spec/post-a1-parity.md §§1–4` all resolved: every CRITICAL / HIGH / MEDIUM / LOW finding has a closing commit referenced in the row.
2. Update `post-a1-parity.md §5` with final carry-forward status — close C-4 if W4.D wired the call; close D-8 canary only if W4.B.8 landed bit-exact, else convert to Phase 6 PARITY ticket against new MOSFET `load()`.
3. Update `post-a1-parity.md §6 CRITICAL / HIGH / MEDIUM tables` with per-row commit hashes.
4. Commit: `Phase 2.5 complete — Track A landed, post-A1 PARITY list closed`.

This single closure commit marks Phase 2.5 complete and opens Phase 3+ authoring (W5).

---

### 6.11 Agent prompt template for W4 lanes

```
You are executing Phase 2.5 W4.<lane-id> per spec/phase-2.5-execution.md §6.9.

Before you start, read:
  1. spec/phase-2.5-execution.md §1 (principles), §6.9 (W4 rules + your lane's sub-section), §8 (hard rules)
  2. spec/post-a1-parity.md §<section for your device / support area> — authoritative finding list + remedies + verify-greps
  3. spec/architectural-alignment.md §A1, §F4a/§F4b/§F4c, §I1, §I2 — policy context
  4. CLAUDE.md — banned closing verdicts and Bash-hook prohibitions
  5. The ngspice source file(s) cited in your lane's Scope block, at the specific line ranges listed.

Deliverables:
  - All findings for your device / lane landed in one commit on main
  - Commit message per §6.9's commit template for your lane

Hard rules (non-negotiable):
  - A1 verdict is binding: stamps are additive. Do not re-verify.
  - Mechanical port to ngspice source. No improvisation.
  - Tests WILL fail. Do not modify code to make tests pass. Delete per A1 §Test handling rule.
  - No self-correction for convergence. If a port does not converge, note in report and stop.
  - Banned vocabulary: mapping, tolerance, close enough, equivalent to, pre-existing, partial, intentional divergence, citation divergence.
  - Escalate ambiguity to user. Do not guess.
  - Use built-in Grep/Glob/Read/Edit — never bash grep/find/rg.

Report to me under 300 words:
  - What landed (file-by-file, finding ID-by-finding ID)
  - What tests were deleted and why (per A1 §Test handling rule)
  - Any convergence failures observed (listed, not fixed)
  - Any ambiguity that required a judgment call (listed for my review)
  - Commit hash
```

---

## 7. What happens after Phase 2.5 lands

Per `spec/reconciliation-task.md §Post-reconciliation flow` and `spec/plan-addendum.md`:

```
Phase 2.5 lands ✓
  │
Phase 3 (F2 NR reorder + predictor) — REWRITE tasks re-authored against post-A1 load()
  │
Phase 4 (F5 limiting primitives) — most tasks already in W2.2; surviving REWRITE tasks re-authored
  │
Phase 5 (F-BJT L0 + L1 full alignment) — fully rewritten against post-A1 BJT load()
  │
Phase 6 (F-MOS alignment) — fully rewritten against post-A1 MOSFET load()
  │
Phase 7 (F5ext — JFET full convergence port) — fully rewritten against post-A1 JFET load()
  │
Phase 8 (F6 documentation & citations) — CARRY AS-IS (Wave 8.1.2 OBSOLETE per plan-addendum)
  │
Phase 9 (Legacy reference review) — CARRY AS-IS with expanded identifier list
  │
Acceptance: 8-circuit bit-exact ngspice parity harness per spec/plan.md Appendix A
```

**Next document to write after W3:** `spec/phase-3-onwards.md` — re-authors surviving plan.md tasks against the post-A1 codebase. Inputs: `spec/plan-addendum.md`, `spec/post-a1-parity.md` (produced in W3), the post-A1 `load()` file layout.

---

## 8. Hard rules agents must honor (summarized here for prompt skeletons)

1. **No self-correction for convergence.** Failing tests get surfaced, not fixed by adjusting code.
2. **Delete aggressively per A1 §Test handling rule.** Hand-computed expected values and intermediate-state inspections are deleted.
3. **No pragmatic patches, no tolerances, no mappings, no "close enough".** See CLAUDE.md banned vocabulary.
4. **One commit per wave (or lane within a wave).** Incremental commits on `main`.
5. **Escalate, don't guess.** Ambiguity in this spec → user. No silent assumptions.
6. **Cite ngspice by file + line range.** Every numerical behavior has a citable authority.
7. **Citation audit.** Every `// cite: xxxload.c:NNN` comment must describe the code that immediately follows it. If the comment claims "port of X" or "simplified X," the code must be a mechanical derivation of X — not a behavioral substitute that happens to solve the same external problem. Decorative citations are the "citation divergence" pattern banned by CLAUDE.md; the audit step exists because W1.8c surfaced this failure mode at commit `8b298ca9` (inline switched-resistor stamped as "Cite: bjtload.c::BJTload CE saturation path" with zero `bjtload.c` quantities present).
8. **Main is broken during execution.** This is expected. Do not add workarounds to unbreak intermediate states.

---

## 9. Agent prompt template (used for each wave / lane)

```
You are executing Phase 2.5 Wave <ID> per spec/phase-2.5-execution.md §<section>.

Before you start, read:
  1. spec/phase-2.5-execution.md §1 (principles), §<this wave's section>, §8 (hard rules)
  2. spec/architectural-alignment.md §<relevant Track A items> for the behaviors being landed
  3. <specific ngspice source files at cited line ranges>
  4. <specific digiTS files being modified>

Deliverables:
  - <wave-specific list from §<section>>
  - Commit with message: "Phase 2.5 W<ID> — <short description>"

Hard rules (non-negotiable):
  - Mechanical port to ngspice source or spec. No improvisation.
  - Tests WILL fail. Do not modify code to make tests pass. Delete per A1 §Test handling rule.
  - No self-correction for convergence. If a device doesn't converge, note in report and stop.
  - Banned vocabulary: mapping, tolerance, close enough, equivalent to, pre-existing, partial.
  - Escalate ambiguity to user. Do not guess.

Do NOT (build-green discipline — empirically needed per post-W1.3 review):
  - Do NOT run `tsc`, `npm run build`, `npm test`, `npm run test:q`, or any test/build command.
    The spec guarantees the tree is broken throughout Phase 2.5 execution. Seeing red output
    is not new information and will not change your port decisions.
  - Do NOT try to make the build green. If the compiler reports errors in files outside your
    scope, that is expected and on-spec. Leave them alone.
  - Do NOT debug TypeScript errors by hypothesizing about filesystem caching, Cygwin/Windows
    path translation, or editor state. If your scope files compile when read at face value,
    they are correct; any surviving tsc error in them is your bug, any tsc error outside them
    is out of scope.
  - Do NOT add temporary fixes, stubs, or shims to unbreak unrelated code. Your deliverable is
    the mechanical port of your scope files; the rest is W3's problem.
  - If you find yourself about to run a verification command for the Nth time, STOP, commit
    what you have, write the report, and exit. The user verifies convergence, not you.

Citation audit (self-check before commit — empirically needed per W1.8c review 2026-04-22):
  - For every `// cite: xxxload.c:NNN` comment in your load(), verify the cited ngspice line
    range actually describes the code immediately following. The comment is a claim; the code
    must honor it.
  - If the code under the citation is a linear stamp of one conductance but the citation
    points at a nonlinear Gummel-Poon/exponential-diode/etc. section, the citation is
    decorative and the port is a behavioral substitute. Rewrite the code to port what was
    cited, OR change the citation to describe what the code actually is (which then means
    it's not an ngspice port — F4b/F4a scope violated; escalate).
  - The test: read the cited ngspice lines and list the quantities computed (voltages,
    exponentials, conductances). Then read your code and list the quantities computed. The
    two lists must correspond. If yours is "one linear conductance toggled by a boolean"
    and theirs is "three exponentials, four signal conductances, Norton-current RHS
    injection," the citation is false.
  - W1.8c precedent: commit `8b298ca9` stamped a switched linear resistor between two pins
    and cited `bjtload.c::BJTload`. Zero `bjtload.c` quantities were present in the code.
    The wave was rejected; rework commit supersedes. Do not repeat this pattern.
  - If a primitive's load() can't be embedded as a sub-element (e.g., composite not pool-backed
    but primitive is), ESCALATE. Do not inline-stamp with a decorative citation as an
    architectural workaround.

Report to me under 300 words:
  - What landed (file-by-file)
  - What tests were deleted and why
  - Any convergence failures observed (listed, not fixed)
  - Any ambiguity that required a judgment call (listed for my review)
  - Commit hash
```
