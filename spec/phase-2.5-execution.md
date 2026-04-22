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
| W2.3 | `InitMode` string deletion (production + harness) | — | — |
| W2.4 | Aggressive I1 test regeneration | — | — |
| W3 | Wrap-up — convergence harness run + user review | — | — |

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

## 6. Wave W3 — Wrap-up

Not an executor task. User-driven.

**Checklist:**
1. Run full ngspice-comparison harness suite (`npm run test:q -- src/solver/analog/__tests__/harness src/solver/analog/__tests__/ngspice-parity`) strict-by-default.
2. Review the unfiltered red output. This is the post-A1 reality.
3. For each failing test, classify:
   - **Convergence failure** (device doesn't solve to the right fixed point): becomes a post-A1 PARITY item against the new `load()` structure. Example: the D-8 canary measurement happens here.
   - **Suppression residue**: a test that's failing because an I1 suppression was removed and the underlying bug surfaces. Usually means a real bug; becomes PARITY.
   - **Test deletion missed**: a test that should have been deleted per the §Test handling rule but survived. Delete it.
4. **Known pre-flagged watch items** — classify under the scheme in (3) during W3; do not let these silently pass:
   - `mna-end-to-end::rl_dc_steady_state_tight_tolerance` — observed 97.56 vs expected `<0.1` at W2.1 close. Originally framed as §B5 100 kV RL overshoot on `tmp-hang-circuits/rl-step.dts`; current symptom shape differs. Could be pre-existing, could be a fresh regression from a W1.x or W2.x port. Per §1 principle 4 not investigated at the wave that surfaced it; W3 owns the classification.
5. **Verify the unmapped digiTS-only integration slots** flagged at W1.9 close (diode `CCAP`, inductor `CCAP`, and any peer slots the W1.5 port introduces under the same pattern). For each such slot, trace the write/read lifetime:
   - Written once per call-frame and read only within the same call-frame → cross-method transfer slot that escaped A1. Open a post-A1 PARITY item to excise.
   - Written at timestep N and read at timestep N+1 (or later) → genuine per-device state with no ngspice counterpart. Add to `spec/architectural-alignment.md` §I2 as a documented digiTS-only slot category with a one-line note on why no ngspice offset exists.
   Do not add a `slotToNgspice` entry for either case — unmapped is the correct harness stance.
6. Append the remaining PARITY list to a new `spec/post-a1-parity.md` — the new work list for Phase 3 onwards.
7. Commit: "Phase 2.5 complete — Track A landed, post-A1 PARITY list captured."

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
