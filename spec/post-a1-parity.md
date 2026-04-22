# Post-A1 Parity List

**Generated:** 2026-04-22
**Source:** Phase 2.5 W3 static audit — 24 parallel lanes (10 sonnet L1a+L1b, 12 haiku L1c, 1 haiku L2, 1 haiku L3 — L3 re-run in flight).
**Method:** static line-by-line comparison vs ngspice; no harness run (see `spec/phase-2.5-execution.md §6.8`).
**Purpose:** authoritative handoff to Phase 3+. Every entry is self-contained — a fresh agent with no prior session context can action each item by reading only this file + the cited ngspice source.

Every finding is **PARITY** (bit-exact divergence from ngspice or from `architectural-alignment.md`). No middle verdicts. No tolerances. Findings cross-referenced to `spec/plan-addendum.md` Phase 3–9 rows are noted; they remain in this list so Phase 3+ authors see the complete surface.

## Reader's orientation

**Files a fresh agent needs before starting work:**

1. This file (`spec/post-a1-parity.md`) — the work list.
2. `spec/architectural-alignment.md` §A1 (test handling rule), §F4a/F4b/F4c (device classifications), §I2 (citation policy).
3. `spec/plan-addendum.md` for cross-referenced Phase 3–9 rows.
4. `CLAUDE.md` — hard rules including **banned closing verdicts** (mapping, tolerance, close enough, equivalent to, pre-existing, intentional divergence, citation divergence, partial). If you would use one, stop and escalate.
5. The ngspice source file cited in each finding (all under `ref/ngspice/src/spicelib/`).

**How to read a finding row:**

- `ngspice ref:line` — authoritative source. Read at least 10 lines of surrounding context.
- `digiTS ref:line` — location of the bug. Line numbers reflect current main; if the file shifts, the cited function/symbol is still the anchor.
- `Divergence` — what's wrong.
- `Severity` — CRITICAL (convergence-breaking / main current path / compile-time bug), HIGH (numerical correctness at bit-exact level), MEDIUM (subtle divergence), LOW (cosmetic).
- `Remedy` — concrete action. If a remedy says "matches plan-addendum X.Y.Z", the Phase 3+ row owns the fix; this entry is here for completeness.
- `Verify grep` — the mechanical check to confirm the fix landed (borrowed from the `spec/fix-list-phase-2-audit.md` protocol).

---

## §1. Device parity findings (L1a small-device + L1b BJT/MOSFET/JFET port-integrity)

### §1.1 diode

**File:** `src/components/semiconductors/diode.ts`
**ngspice reference:** `ref/ngspice/src/spicelib/devices/dio/dioload.c` (DIOload function, lines 21–445)
**Coverage:** full function vs `load()` body at diode.ts:463–664 + helpers (`computeDiodeIV` 336–357, `computeJunctionCapacitance` 142–159, `computeJunctionCharge` 184–224).

| # | ngspice ref:line | digiTS ref:line | Divergence | Severity | Remedy |
|---|---|---|---|---|---|
| D-W3-1 | dioload.c:292–300 (IKF forward, high-injection) | diode.ts:556–564 | `sqrtTerm = sqrt(1 + id/IKF)` has a spurious `+1` under the radical. ngspice uses `sqrt_ikf = sqrt(cd/ikf_area_m)`. Also: IKF correction is applied only to `gd` in digiTS; ngspice applies a consistent Norton pair — both `cd` and `gd` get the high-injection correction before GMIN is added. | **CRITICAL** | Re-derive IKF forward-region block verbatim from `dioload.c:292-300`: `sqrt_ikf = sqrt(cd/ikf_area_m); gd = ((1+sqrt_ikf)*gd - cd*gd/(2*sqrt_ikf*ikf_area_m))/(1+2*sqrt_ikf + cd/ikf_area_m) + CKTgmin; cd = cd/(1+sqrt_ikf) + CKTgmin*vd;`. Apply GMIN *inside* the IKF/IKR/else branch per ngspice, not after. |
| D-W3-2 | dioload.c:304–312 (IKR reverse, high-injection) | diode.ts:560–563 | Same two bugs as D-W3-1, mirrored for the reverse (IKR) branch. | **CRITICAL** | Re-derive reverse block from `dioload.c:304-312`: `sqrt_ikr = sqrt(cd/(-ikr_area_m)); gd = ((1+sqrt_ikr)*gd + cd*gd/(2*sqrt_ikr*ikr_area_m))/(1+2*sqrt_ikr - cd/ikr_area_m) + CKTgmin; cd = cd/(1+sqrt_ikr) + CKTgmin*vd;`. |
| D-W3-3 | dioload.c:141–149 (`#ifndef PREDICTOR` copy then fall through to rhsOld read) | diode.ts:478–509 | MODEINITPRED branch copies state1→state0 then cascades into `if MODEINITSMSIG / else if MODEINITTRAN / else rhsOld`. ngspice copies state, then falls directly through to the rhsOld read without re-testing MODEINITSMSIG/MODEINITTRAN. | MEDIUM → plan-addendum 3.2.1 | Re-author MODEINITPRED as first branch: copy state1→state0, then fall through to the rhsOld read (no cascade). Phase 3 row 3.2.1 owns; re-author against post-A1 `load()`. |
| D-W3-4 | — | diode.ts:632 | `s0[SLOT_V] = vdLimited` written but never read in any load() call-path. Vestigial. | MEDIUM | Grep for `SLOT_V\b` reads outside `load()` in `diode.ts` + harness device-mappings. If zero reads: delete both the slot and the write. If a harness read exists: document as a diagnostic-only slot in architectural-alignment.md §I2. |
| D-W3-5 | dioload.c:183 (`DIObreakdownVoltageGiven` flag) | diode.ts:520 | Breakdown gate uses `tBV < Infinity` instead of an explicit "breakdown-voltage-given" flag. Functionally equivalent (BV default is Infinity). | LOW | Accept as-is or add a `BV_given` boolean mirroring ngspice for clarity. Not a numerical bug. |
| D-W3-6 | dioload.c:209–243 (sidewall current block) | — | Sidewall current terms (`csatsw`, `cdsw`, `gdsw`, `DIOswEmissionCoeff`) are absent. Discrete diodes default `DIOsatSWCurGiven = false` so the merge path produces identical results; the model would diverge for VLSI parity. | LOW | Defer unless VLSI parity is scoped. If scoped, port `dioload.c:209-243` verbatim, adding `SW` params to the diode schema. |
| D-W3-7 | dioload.c:267–285 (tunnel current) | — | Tunnel bottom and sidewall tunnel-current terms (`DIOtunSatSWCur`, `DIOtunSatCur`) absent. Negligible for standard discrete diodes. | LOW | Defer; add `architectural-alignment.md §I2` note if VLSI parity ever scoped. |
| D-W3-8 | — | diode.ts `SLOT_CCAP` | Genuine cross-timestep integration-history slot (written to `s0`, read from `s1` on next step). Maps to ngspice's `CKTstate1 + DIOcapCurrent` which NIintegrate uses internally. Architecturally legitimate, but undocumented. | — | User action: add `architectural-alignment.md §I2` entry documenting SLOT_CCAP as a digiTS-externalised NIintegrate history slot, not a cross-method transfer. No code change. |

**Carry-forward status:**
- **D-1** (`Math.min(vd/nVt, 700)` clamp removal per `dioload.c:244`): CONFIRMED ABSENT — no `Math\.min\([^)]*700\)` in diode.ts. CLOSED.
- **D-W3-3 cross-ref:** plan-addendum 3.2.1 PAUSE-UNTIL-A1. Ownership transfers after Phase 3 re-authoring.

### §1.2 zener

**File:** `src/components/semiconductors/zener.ts`
**ngspice reference:** `ref/ngspice/src/spicelib/devices/dio/dioload.c` (breakdown-aware branches — zener is diode + BV/IBV params).
**Coverage:** `createZenerElement` simplified model.

| # | ngspice ref:line | digiTS ref:line | Divergence | Severity | Remedy |
|---|---|---|---|---|---|
| Z-W3-1 | dioload.c:245–265 (3-region structure) | zener.ts:208 | Forward/breakdown split at `-params.BV` (one-step function). ngspice uses three regions separated at `-3*vte` and `-DIOtBrkdwnV`: forward, reverse-cubic (Shockley approximation), breakdown. | **CRITICAL** | Port three-region structure verbatim from dioload.c:245-265. Forward region: `if (vd >= -3*vte) { evd = exp(vd/vte); cdb = csat*(evd - 1); gdb = csat*evd/vte; }`. Reverse-cubic region: see Z-W3-2. Breakdown: `evrev = exp(-(tBV+vd)/vtebrk); cdb = -csat*evrev; gdb = csat*evrev/vtebrk`. |
| Z-W3-2 | dioload.c:251–258 (reverse-cubic branch) | zener.ts (absent) | Cubic approximation branch (`arg = 3*vte/(vd*CONSTe); arg = arg*arg*arg; cdb = -csat*(1 + arg); gdb = csat*3*arg/vd`) is entirely missing between forward and breakdown. | **CRITICAL** | Add the branch between forward and breakdown in Z-W3-1's three-region structure. |
| Z-W3-3 | dioload.c:297–299 (GMIN as Norton pair) | zener.ts:213, 221 | GMIN folded into `geq` only. ngspice adds a Norton pair: `gd += CKTgmin; cd += CKTgmin*vd`. Current digiTS: `ieq = id - geq*vd` where `geq` is IKF-corrected + GMIN but `id` is pre-GMIN — inconsistent pair. | HIGH | After branch computes intrinsic `geq = IS*exp/nVt`: add `geq += GMIN; id += GMIN * vdLimited;` before computing `ieq = id - geq*vdLimited`. |
| Z-W3-4 | dioload.c:130–138 (4-branch MODEINITJCT dispatch) | zener.ts:172–175 | Single MODEINITJCT branch that unconditionally uses `vdRaw`. ngspice dispatches 4 ways: (a) `MODEINITJCT && MODETRANOP && MODEUIC` → `vd = IC`, (b) `MODEINITJCT && OFF` → `vd = 0`, (c) `MODEINITJCT` else → `vd = tVcrit`, (d) `MODEINITFIX && OFF` → `vd = 0`. | HIGH | Port the 4-branch dispatch from dioload.c:130-138. Model after the now-correct dispatch in `diode.ts` (which already has the pattern post-W1.1). |
| Z-W3-5 | dioload.c:183 + jfettemp.c temperature scaling | zener.ts:520 | `tBV` computation missing — zener uses `params.BV` (room-temperature) throughout. ngspice uses `DIOtBrkdwnV` (temperature-scaled from `diosetup.c`). At non-REFTEMP temperatures the breakdown threshold and pnjlim limiting domain are both wrong. | HIGH → plan-addendum 4.3.3 | Phase 4 row 4.3.3 owns. Compute `tBV` from `BV` via temperature-scaling formula (cite `dio/diosetup.c`) and use `tBV` in place of `params.BV` in every breakdown expression. Also applies to every point Z-W3-4 / Z-W3-1 cite `params.BV`. |
| Z-W3-6 | dioload.c:189–190 (breakdown pnjlim vcrit from `DIOtVcrit`) | zener.ts:180 | Breakdown pnjlim `vcrit` argument computed from forward `nVt`, not breakdown `nbvVt`. When `NBV ≠ N` the breakdown limit is wrong. | MEDIUM | Compute `vcritBrk = nbvVt * log(nbvVt / (params.IS * sqrt(2)))` and use it in the breakdown-branch pnjlim call when `params.NBV !== params.N`. |
| Z-W3-7 | dioload.c:417–419 (state0 writes gmin-adjusted cd/gd) | zener.ts:204, 215, 223 | `SLOT_ID` stores pre-GMIN `id`; `SLOT_GEQ` stores GMIN-augmented `geq`. ngspice stores the full GMIN-adjusted pair. Consistency required for checkConvergence's `cdhat` prediction. | MEDIUM | Store GMIN-adjusted values consistently: after Z-W3-3 remedy, write `s0[SLOT_ID] = id_adjusted` and `s0[SLOT_GEQ] = gd_adjusted` where both include GMIN. Mirror what diode.ts does. |
| Z-W3-8 | dioload.c:126–128 (MODEINITSMSIG) | zener.ts (absent) | No MODEINITSMSIG branch. Zener always runs through pnjlim + full current formula during AC small-signal. ngspice reads `vd = state0_voltage`, skips pnjlim, stores small-signal cap value, early-returns. | MEDIUM | Port dioload.c:126-128: inside `if (mode & MODEINITSMSIG)` branch read `vd = s0[SLOT_VD]`, compute OP values (no pnjlim), skip stamps, `return`. |
| Z-W3-9 | dioload.c:128–129 (MODEINITTRAN state1 read) | zener.ts (absent) | No MODEINITTRAN seeding — state1 is never read to seed the initial `vd` for the first transient step. | MEDIUM | Add `else if (mode & MODEINITTRAN) { vdLimited = s1[base + SLOT_VD]; }` in the mode-dispatch chain. |

### §1.3 capacitor

**File:** `src/components/passives/capacitor.ts`
**ngspice reference:** `ref/ngspice/src/spicelib/devices/cap/capload.c` (full CAPload).

| # | ngspice ref:line | digiTS ref:line | Divergence | Severity | Remedy |
|---|---|---|---|---|---|
| C-W3-1 | — | `src/solver/analog/sparse-solver.ts::stampElement` (caller semantics) | MUST verify `solver.stampElement(handle, val)` performs `matrix[handle] += val`, NOT `matrix[handle] = val`. Applies to every device's stamps, not just capacitor. ngspice stamping is always additive (`*(CAPposPosptr) += m*geq`). | **CRITICAL (architectural verification)** | Read `src/solver/analog/sparse-solver.ts` and inspect the `stampElement` (and `stampRHS`) implementation. If additive: add a comment confirming; close item. If overwriting: immediate fix — the entire analog simulator is silently producing wrong matrix entries on every multi-device circuit. Verify separately that `stampRHS` is additive (same concern). |
| C-W3-2 | capload.c:44 + stamp lines w/ `m` | capacitor.ts:326–333 | `M` is folded into `C` via `_computeEffectiveC()` instead of applied at stamp time. Numerically identical for constant `M`, but `q`-history slots (`s1`/`s2`/`s3` SLOT_Q) become stale on mid-simulation `setParam("M", ...)` because they were written with the old `M`-scaled `C`. | MEDIUM | Option A: Apply `m` at stamp time (`stamp(..., m * geq)` etc.) mirroring ngspice structurally. Option B: Accept the fold but add a documented constraint: `setParam("M", ...)` or `setParam("SCALE", ...)` mid-simulation requires re-seeding q-history via `MODEINITTRAN`. Add a code comment at `_computeEffectiveC()`. |
| C-W3-3 | capload.c:69 (NIintegrate error return) | `src/solver/analog/ni-integrate.ts` (or wherever niIntegrate lives) | `niIntegrate` silently falls through GEAR branch at `order < 1` instead of propagating an error. ngspice returns `E_ORDER` / `E_METHOD`. | LOW | Either (a) add a `throw` in niIntegrate's GEAR branch for `order < 1` / unsupported method; or (b) document that the solver validates order/method before calling `load()`. |

**Carry-forward status:**
- **D-15** (capacitor `_IC = 0.0` default + unconditional cond1 use per `capload.c:46-47`): CONFIRMED SATISFIED. `_IC: { default: 0.0 }` in CAPACITOR_DEFAULTS; no `isNaN` guard in cond1 path.
- **Plan-addendum 2.4.5** (gate `MODETRAN|MODEAC|MODETRANOP`, drop MODEDCOP): CONFIRMED SATISFIED.

### §1.4 polarized-cap

**File:** `src/components/passives/polarized-cap.ts`
**F4 classification:** F4b APPROVED FIX per `architectural-alignment.md` §F4b: composition of `cap/*` (forward-bias capacitor body) + `dio/*` (reverse-bias clamp diode).
**ngspice references:** `ref/ngspice/src/spicelib/devices/cap/capload.c` (base cap) + `ref/ngspice/src/spicelib/devices/dio/dioload.c` (reverse-bias clamp).

| # | ngspice ref:line | digiTS ref:line | Divergence | Severity | Remedy |
|---|---|---|---|---|---|
| PC-W3-1 | architectural-alignment.md §F4b (composition = cap/* + dio/*) | polarized-cap.ts (entire `load()`) | **Entire `dio/*` reverse-bias clamp primitive is absent.** Reverse-bias region is implemented as a polarity-warning diagnostic only; no MNA stamp. Half of the F4b composition is missing. | **CRITICAL** | Instantiate a `DIOload`-backed element or inline the diode junction stamp between `nPos/nNeg` (or `nCap/nNeg` — see Ambiguity). Port Shockley forward/reverse from dioload.c:245-265 for the clamp. Match diode.ts's `load()` structure for the clamp portion. |
| PC-W3-2 | capload.c:30 (outer gate `MODETRAN\|MODEAC\|MODETRANOP`) | polarized-cap.ts:345 | `MODEAC` absent from outer participation gate: `if (!(mode & (MODETRAN \| MODETRANOP))) return;`. AC small-signal path skips companion stamp entirely. | HIGH | Change gate to `if (!(mode & (MODETRAN \| MODETRANOP \| MODEAC))) return;`. |
| PC-W3-3 | capload.c:52 (inner fork `MODETRAN\|MODEAC`) | polarized-cap.ts:352 | Inner fork is `if (mode & MODETRAN)` — excludes MODEAC. ngspice's inner fork is `(MODETRAN \| MODEAC)`, meaning AC also calls NIintegrate. | HIGH | Change inner fork to `if (mode & (MODETRAN \| MODEAC))` / `else` for DC-OP. Depends on PC-W3-2 being fixed first. |
| PC-W3-4 | architectural-alignment.md §F4b constraint §1 | `src/components/passives/__tests__/polarized-cap.test.ts` | No parity harness test comparing matrix entries against ngspice CAPload for the cap-body portion. F4b constraint §1 requires per-device parity harness test. | HIGH | Create/extend `polarized-cap.test.ts` to run the CAPload-equivalent through the ngspice comparison harness and compare matrix entries (geq/ceq) at bit-exact, separately for the cap body and the clamp diode. |
| PC-W3-5 | capload.c:46–51 (`cond1` IC override param `CAPinitCond`) | polarized-cap.ts:264–271 | `cond1` branch uses `this._IC` which defaults to 0 — correct behavior, but no `initCond` param is exposed on the device. | MEDIUM | Add `IC` (alias `initCond`) parameter to POLARIZED_CAP_PARAM_DEFS (default 0). Confirm plumbed through the factory like `CAPinitCond` is in ngspice. |
| PC-W3-6 | capload.c:44 (`m = CAPm`, applied at every stamp) | polarized-cap.ts (absent) | No multiplicity factor `m` / `CAPm` param. Every stamp is single-instance. Parallel-element scaling absent. | MEDIUM | Add `M` (multiplicity) param default 1. Multiply all stamp values (ESR conductance, leakage conductance, companion geq/ceq) by `m`. Or fold into `C` like capacitor.ts does — see C-W3-2 remedy decision. |

**Ambiguity for user:** diode clamp node choice. ESR topology splits terminal into `nPos — ESR — nCap — (body) — nNeg`. Clamp diode could stamp (a) between `nPos/nNeg` (full terminal) or (b) between `nCap/nNeg` (internal cap-node only). ngspice has no ESR internal node, so the mapping is not obvious. Decide before executing PC-W3-1.

### §1.5 inductor

**File:** `src/components/passives/inductor.ts`
**ngspice reference:** `ref/ngspice/src/spicelib/devices/ind/indload.c` (non-MUTUAL path).

| # | ngspice ref:line | digiTS ref:line | Divergence | Severity | Remedy |
|---|---|---|---|---|---|
| I-W3-1 | indload.c:43–51 (`*(state0 + INDflux) = INDinduct/m * *(CKTrhsOld + INDbrEq)`) | inductor.ts:285–289 | **Flux seeded from `voltages[b]` (current NR iterate) instead of `ctx.rhsOld[b]` (prior accepted solution).** Rewrites SLOT_PHI every NR sub-iteration, corrupting NIintegrate inputs on every NR step. **Directly explains `mna-end-to-end::rl_dc_steady_state_tight_tolerance: 97.56 vs <0.1` watch item from prior §6.5.** | **CRITICAL** | Replace `voltages[b]` with `ctx.rhsOld[b]` in the non-UIC flux write. Precondition: verify `LoadContext` exposes `rhsOld` (if not, add it — mirrors ngspice `CKTrhsOld` at the load-context layer). |
| I-W3-2 | indload.c:43–44 (one UIC branch inside `!(MODEDC\|MODEINITPRED)` outer gate) | inductor.ts:271–272 | Spurious `(MODEDC & MODEINITJCT)` arm added to cond1. It fires at DC-OP (a mode ngspice never enters this branch under) and forces `iNow = NaN` (since `_IC` default is NaN) into the flux write. | HIGH | Remove the `(mode & MODEDC) && (mode & MODEINITJCT)` arm entirely. Keep only `(mode & MODEUIC) && (mode & MODEINITTRAN) && !isNaN(_IC)`, and move it **inside** the `!(MODEDC\|MODEINITPRED)` outer gate (it's currently before it). |
| I-W3-3 | indload.c:114–117 (`state1[INDvolt] = state0[INDvolt]` on MODEINITTRAN) | inductor.ts (absent) | `SLOT_VOLT` never copied s0→s1 on MODEINITTRAN. Second transient step sees stale zero in `s1[SLOT_VOLT]`. | MEDIUM | After the `s0[SLOT_VOLT] = vNow` write at inductor.ts:328, add: `if (mode & MODEINITTRAN) { s1[base + SLOT_VOLT] = s0[base + SLOT_VOLT]; }`. |
| I-W3-4 | indload.c:112 (`*(CKTrhs + INDbrEq) += veq`) | inductor.ts:340 | `solver.stampRHS(b, veq)` — must verify it's additive. Architectural, same concern as C-W3-1. | MEDIUM (arch) | Subsumed by C-W3-1 verification. |
| I-W3-5 | indload.c:88–123 | inductor.ts:291–292 | MODEINITPRED / MODEINITTRAN state-copy ordering differs from ngspice (structurally — functional equivalence for current case, but any future extension diverges). | LOW | Restructure to mirror ngspice: outer `if(!(MODEDC\|MODEINITPRED))` for flux-from-current write; then `else` leading into `if(MODEDC) { req=veq=0 } else { PREDICTOR check + NIintegrate }`. |
| I-W3-6 | — | inductor.ts SLOT_CCAP (slot 4) | Genuine cross-timestep integration history (maps to ngspice's `CKTstate1 + INDflux` implicit in NIintegrate). Architecturally legitimate digiTS extension. | — | User action: add `architectural-alignment.md §I2` entry. No code change. |

**rl_dc_steady_state classification:** inductor-side primary (I-W3-1); B5 solver contribution not ruled out but the inductor bug would dominate.

### §1.6 transformer

**File:** `src/components/passives/transformer.ts`
**F4 classification:** F4a APPROVED FIX per `architectural-alignment.md` §F4a (coupled inductors via `K` factor).
**ngspice reference:** `ref/ngspice/src/spicelib/devices/ind/indload.c` (includes inline MUTUAL block — there is no separate `mutload.c`).

| # | ngspice ref:line | digiTS ref:line | Divergence | Severity | Remedy |
|---|---|---|---|---|---|
| T-W3-1 | — (compiler-level) | transformer.ts:608 `branchCount: 1` | **`branchCount: 1` but device internally uses 2 MNA branch rows (`branch2 = branch1 + 1`).** Compiler allocates only one row; `branch2` aliases the next element's branch or an unallocated slot. Every `b2` stamp / read / write targets wrong index. Breaks every circuit containing a transformer. | **CRITICAL** | Change `branchCount: 1` → `branchCount: 2` in the modelRegistry entry. |
| T-W3-2 | indload.c:88–109 (integration gate `if(MODEDC){req=veq=0}else{...}`) | transformer.ts:361 | Integration gate is `if (mode & MODETRAN)`, not `if (!(mode & MODEDC))`. At MODEINITTRAN (set before MODETRAN bit is added), all g/hist coefficients are zeroed — companion stamps absent on first transient step. | **CRITICAL** | Replace `if (mode & MODETRAN)` with `if (!(mode & MODEDC))`, matching indload.c:88 and inductor.ts:300. |
| T-W3-3 | indload.c:108 (`NIintegrate(...)`) | transformer.ts:370–384 | **NIintegrate never called — manual `ag[]` expansion is used.** The expansion omits `ccapPrev` (prior-step ccap) and has no SLOT_CCAP tracking. BDF-2 history becomes wrong from the second transient step. `TRANSFORMER_SCHEMA` has no SLOT_CCAP1 / SLOT_CCAP2 slots. | **CRITICAL** | Add `SLOT_CCAP1` and `SLOT_CCAP2` to `TRANSFORMER_SCHEMA`. Replace the manual ag-expansion with two `niIntegrate()` calls, one per winding (treating `L_i` as the "capacitance"-equivalent argument), passing `ccapPrev` from `SLOT_CCAP1/2` and storing result back. For the mutual companion: `g12 = ag[0] * M` per `indload.c:74-75` (the off-diagonal `MUTbr1br2` / `MUTbr2br1` stamp). |
| T-W3-4 | indload.c:44–46 (UIC flux seed `flux = L/m * INDinitCond`) | transformer.ts (absent) | UIC IC path entirely absent — no `IC1` / `IC2` params, no MODEUIC branch. A transformer with non-zero initial winding currents cannot be UIC-initialised. | HIGH | Add `IC1` / `IC2` params. In the flux-update block, gate on `(mode & MODEUIC) && (mode & MODEINITTRAN)` and seed `phi1 = L1 * IC1`; `phi2 = L2 * IC2 + M * IC1` (per mutual convention). Guard with `isFinite(IC*)`. |
| T-W3-5 | indload.c:41, 107 (`m = INDm; newmind = INDinduct/m`) | transformer.ts (absent) | Parallel-multiplicity factor absent — no `M` (multiplicity) param on windings. | MEDIUM | Add `M` param. Divide `lPrimary` / `lSecondary` by `M` in `updateDerivedParams`. |
| T-W3-6 | indload.c:114–116 (MODEINITTRAN INDvolt history copy) | transformer.ts (absent) | No SLOT_VOLT1 / SLOT_VOLT2 slots; volt-state history copy absent. | LOW | Add SLOT_VOLT1 / SLOT_VOLT2 to schema. On MODEINITTRAN: `s1[SLOT_VOLT1] = s0[SLOT_VOLT1]` and same for VOLT2. |

**Extra observation:** `src/components/passives/coupled-inductor.ts` defines an unused `CoupledInductorState` interface with `prevI1 / prevV1 / ...` fields and a `createState()` method never called by transformer.ts (which only uses `.l1 / .l2 / .m` getters from `CoupledInductorPair`). Dead code that may indicate an alternative history-tracking design. Clean up during T-W3-3 fix.

### §1.7 tapped-transformer

**File:** `src/components/passives/tapped-transformer.ts`
**F4 classification:** F4a APPROVED FIX per `architectural-alignment.md` §F4a (coupled inductors with tap).
**ngspice reference:** `ref/ngspice/src/spicelib/devices/ind/indload.c` (inductor + MUTUAL inline block).

| # | ngspice ref:line | digiTS ref:line | Divergence | Severity | Remedy |
|---|---|---|---|---|---|
| TT-W3-1 | — (compiler-level) | tapped-transformer.ts:683 `branchCount: 1` | **Same `branchCount: 1` bug as transformer T-W3-1 — needs 3.** Device uses three windings with `b1`, `b2 = b1+1`, `b3 = b1+2`. Compiler allocates one row; `b2` and `b3` alias unrelated matrix rows. | **CRITICAL** | Change `branchCount: 1` → `branchCount: 3` in the modelRegistry entry at line 683. |
| TT-W3-2 | indload.c structure (copy-back after NIintegrate) | tapped-transformer.ts:391–403 | MODEINITTRAN `s1←s0` flux copy happens *before* the flux write + integration block; ngspice does it *after* NIintegrate writes `state0`. Ordering inverted. | HIGH | Restructure to mirror ngspice exactly: (1) outer gate `if (!(mode & (MODEDC\|MODEINITPRED)))` — flux-from-current write; (2) NIintegrate; (3) then MODEINITTRAN `s1←s0` copy; (4) MODEINITPRED copy is a separate arm inside `else !MODEDC`. |
| TT-W3-3 | indload.c:88 (non-DC gate for integration) | tapped-transformer.ts:407 | Same bug as T-W3-2: gate is `MODETRAN` instead of `!MODEDC`. | MEDIUM | Replace `if (mode & MODETRAN)` with `if (!(mode & MODEDC))`. |
| TT-W3-4 | indload.c:114–116 | tapped-transformer.ts (absent) | No SLOT_VOLT1/2/3 slots; voltage state not copied at MODEINITTRAN. | LOW | Add three voltage-state slots storing winding terminal voltage differences; copy `s1←s0` at MODEINITTRAN. |
| TT-W3-5 | indload.c (two-pass self + mutual) | tapped-transformer.ts:348–349 | Three-winding flux computed in one expression (`phi1 = L1·i1 + M12·i2 + M13·i3`); ngspice uses two-pass (self-loop over inductors, then mutual-loop over MUT instances). Functionally equivalent for a self-contained element, but structural departure from F4a constraint §1 ("mirrors the cited ngspice file"). | LOW | Escalate to user: accept combined formula as valid flattening for single-element case, or split into two-pass. |
| TT-W3-6 | — | tapped-transformer.ts:254 (class-body `setParam` no-op; real `setParam` wired in outer `buildTappedTransformerElement` closure) | Latent `setParam` hot-reload hazard if any future consumer calls constructor directly instead of routing through `buildTappedTransformerElement`. | LOW | Verify all construction paths route through `buildTappedTransformerElement`. Add a comment on class-body `setParam` noting the closure-override pattern to prevent agents from "fixing" it. |

### §1.8 bjt (L0 + L1)

**File:** `src/components/semiconductors/bjt.ts` (L0 = `createBjtElement` + L1 = `createSpiceL1BjtElement`, same file).
**ngspice reference:** `ref/ngspice/src/spicelib/devices/bjt/bjtload.c` (BJTload).
**Scope:** L1b port-integrity audit only — Phase 5 has ~21 REWRITE tasks doing full BJT parity. L1b reports transcription errors not enumerated in plan-addendum.md Phase 5.

| # | ngspice ref:line | digiTS ref:line | Divergence | Severity | Remedy |
|---|---|---|---|---|---|
| B-W3-1 | bjtload.c:583–585 (`czsub = BJTtSubcap * BJTareac`) | bjt.ts:1456 | `const czsub = tp.tSubcap;` — missing `* params.AREA` factor. Substrate depletion cap is off by factor `AREA` for any AREA≠1; silent when AREA=1. | **CRITICAL** | Change to `const czsub = tp.tSubcap * params.AREA;`. (After plan-addendum 5.2.8 lands with separate AREAB/AREAC params, revisit: use `params.AREAC` for vertical BJT, `params.AREAB` for lateral.) |
| B-W3-2 | bjtload.c:488 (`evsub = exp(MIN(MAX_EXP_ARG, vsub/vts))`) | bjt.ts:1368 | `evsub = Math.exp(vsubLimited/vts)` — unclamped. ngspice clamps the exp argument to `MAX_EXP_ARG ≈ 709` to prevent overflow. Overflow path is reachable via MODEINITSMSIG/MODEINITTRAN seeding paths that bypass pnjlim. | HIGH | Add `const MAX_EXP_ARG = 709;` in a shared constants module if not present. Change to `const expArg = Math.min(MAX_EXP_ARG, vsubLimited / vts); const evsub = Math.exp(expArg);`. Note: D-1 banned per-junction clamps; this is the specific ngspice overflow guard, not a banned one — the guard is **at** the ngspice source. |
| B-W3-3 | bjtload.c:525 (excess-phase gate `MODETRAN\|MODEAC && td != 0` only) | bjt.ts:1385 | Extra `ctx.delta > 0` guard on excess-phase block. Under MODEAC, `delta` may be a non-zero DC-OP residual — ngspice does not guard. | MEDIUM → plan-addendum 5.2.10 | Phase 5 owns via 5.2.10 REWRITE-POST-A1. Remove the `ctx.delta > 0` conjunction when re-authoring. |
| B-W3-4 | bjtload.c:749 (noncon gate `!(MODEINITFIX) \|\| !(BJToff)`) | bjt.ts:871 (L0), 1321 (L1) | `ctx.noncon.value++` unconditional on `icheckLimited`. ngspice skips the bump when `MODEINITFIX && BJToff`. | MEDIUM → plan-addendum 5.1.4, 5.2.4 | Phase 5 owns via 5.1.4 / 5.2.4 REWRITE-POST-A1. Wrap `noncon++` in `if (params.OFF === 0 || !(mode & MODEINITFIX))`. |
| B-W3-5 | bjtload.c:780 (`*(CKTstate0 + BJTgx) = gx`) | bjt.ts L0 schema | `BJT_SIMPLE_SCHEMA` has no GX slot; L0's `load()` never writes one. Currently harmless because L0's `gx=0` and no bypass reads it, but any future bypass-path read of `state0[GX]` would be undefined. | LOW | Add `GX` slot to BJT_SIMPLE_SCHEMA initialised to `{kind:"zero"}`. Write `s0[base + SLOT_GX] = 0` in L0 load(). |

**Cross-ref absorbed into Phase 5 rows (not duplicated here):** bypass block + `cghat`/`cdhat` checks, MODEINITPRED xfact, vbxRaw seeding, L1 MODEINITSMSIG return correctness (verified implemented), AREAB/AREAC params.

### §1.9 mosfet

**File:** `src/components/semiconductors/mosfet.ts`
**ngspice reference:** `ref/ngspice/src/spicelib/devices/mos1/mos1load.c` (MOS1load).
**Scope:** L1b port-integrity — Phase 6 owns full MOS1 parity; this lane reports unenumerated transcription errors.

| # | ngspice ref:line | digiTS ref:line | Divergence | Severity | Remedy |
|---|---|---|---|---|---|
| M-W3-1 | mos1load.c:385 (`if(!(ckt->CKTfixLimit)) { ... limvds(-vds, ...) }`) | mosfet.ts:1132 | Reverse-mode `limvds` called unconditionally; missing `!ctx.cktFixLimit` guard. In fix-limit mode, reverse vds is incorrectly limited. | HIGH | Wrap the reverse-mode `limvds` call in `if (!ctx.cktFixLimit) { vds = -limvds(-vds, -vdsOldStored); }`. Precondition: `LoadContext.cktFixLimit` field (per plan-addendum 4.1.3 CARRY). If the field isn't present yet, add it in the same commit. |
| M-W3-2 | mos1load.c:108 (`Check = 1` at instance loop top) | mosfet.ts:976 (closure-level `let icheckLimited = false`) | `icheckLimited` never reset per-`load()`-call. Stale value persists across invocations; MODEINITJCT path (line 1213) explicitly sets `icheckLimited = false` which ngspice's MODEINITJCT path does not exempt from the noncon gate. | HIGH | Declare `icheckLimited` as a local variable inside `load()`, initialised to `true` per call (matching `Check = 1`). Set to `false` only in the non-simple path (MODEINITJCT / MODEINITFIX+OFF) and let `pnjlim`'s `limited` flag drive it to true when limiting occurs. |
| M-W3-3 | mos1load.c:354–406 (no MODEINITSMSIG exemption from limiting) | mosfet.ts:1092 | digiTS skips fetlim+limvds under MODEINITSMSIG: `if ((mode & (MODEINITPRED \| MODEINITSMSIG \| MODEINITTRAN)) === 0)`. ngspice does apply limiting under MODEINITSMSIG. | HIGH | Change guard to `if ((mode & (MODEINITPRED \| MODEINITTRAN)) === 0)`. Remove MODEINITSMSIG from the skip set. |
| M-W3-4 | mos1load.c:507 (`von = MOS1tVbi * type + MOS1gamma * sarg`) | mosfet.ts:1255 | `von = tp.tVbi * polarity + params.GAMMA * sarg` uses `params.GAMMA` (raw input). ngspice uses `model->MOS1gamma` which is temperature-corrected (`mos1temp.c:167`). At `TNOM ≠ REFTEMP`, `von` is numerically wrong. | MEDIUM | Read `src/components/semiconductors/mosfet.ts::computeTempParams` (~lines 402–500). If `tp.tGamma` exists, change `params.GAMMA` → `tp.tGamma`. If not, add `tGamma` computation per mos1temp.c:167 and use it. |
| M-W3-5 | mos1load.c:875–877 (zero-outs inside MODETRAN `else` branch) | mosfet.ts:1463–1466 | CQGS/CQGD/CQGB zero-outs placed in `initOrNoTran` branch instead of MODETRAN `else`. Harmless when cap=0 but stale slot on nonzero cap + MODEINITTRAN. | MEDIUM | Move the three `if (capXX === 0) s0[...] = 0;` lines into the `else` branch (the MODETRAN path), before the NIintegrate calls. |
| M-W3-6 | mos1load.c:739–743 (noncon gate) | mosfet.ts:1624 | `ctx.noncon.value++` ungated. ngspice gates: `if ((MOS1off == 0) || !(MODEINITFIX\|MODEINITSMSIG))`. | MEDIUM | Gate the bump: `if (icheckLimited && (params.OFF === 0 || !(mode & (MODEINITFIX \| MODEINITSMSIG)))) ctx.noncon.value++;`. Apply after M-W3-2 (otherwise `icheckLimited` stale state interacts). |

**D-8 canary status:** INCONCLUSIVE from static analysis. Slot `SLOT_CAP_IEQ_DB` that held the failing `-3.5e-12` was excised by A1. Quantity now lives in `niIntegrate` output at mosfet.ts:1340–1388. Post-Phase-6 harness comparison required to resolve.

**G1 sign convention:** CLEAN. All `vbs`/`vbd` references consistent with ngspice convention `vbs = polarity*(vB - vS)`, `vbd = vbs - vds`. `SLOT_VBS` / `SLOT_VBD` reads/writes consistent in `load()`, `checkConvergence`, `primeJunctions`.

**Cross-ref absorbed into Phase 6 rows (not duplicated here):** M-1 predictor xfact, M-2 MODEINITSMSIG body, M-3 IC params + primeJunctions, M-4 bypass, M-5 `cktFixLimit` threading, M-6 icheck noncon broader scope, M-7 qgs/qgd/qgb xfact, M-9 per-instance vt in bulk-diode paths, M-12 MODEINITFIX+OFF, companion zero-fix #32.

### §1.10 jfet (NJFET + PJFET)

**Files:** `src/components/semiconductors/njfet.ts`, `src/components/semiconductors/pjfet.ts`.
**ngspice reference:** `ref/ngspice/src/spicelib/devices/jfet/jfetload.c` (JFETload).
**Scope:** L1b port-integrity. Phase 7 owns full JFET parity.

**fet-base.ts:** CONFIRMED DELETED — zero functional references in `src/`. Only comment-level mentions remain (documenting prior excisions).

| # | ngspice ref:line | digiTS ref:line | Divergence | Severity | Remedy |
|---|---|---|---|---|---|
| J-W3-1 | jfetload.c:463–466 (`continue` skips stamps under MODEINITSMSIG) | njfet.ts:677–680; pjfet.ts:636–639 | After storing `capgs` / `capgd` into `SLOT_QGS` / `SLOT_QGD` under MODEINITSMSIG, digiTS falls through to the state-write block and executes all stamps. ngspice's `continue` skips all stamps for that instance in small-signal mode. | **CRITICAL** | After `s0[SLOT_QGS] = capgs; s0[SLOT_QGD] = capgd;` in the MODEINITSMSIG branch, add `return;` immediately. The state-write and stamp blocks that follow MUST be skipped. Apply to both njfet.ts and pjfet.ts. |
| J-W3-2 | jfetload.c:498–508 (noncon gate `if(!(MODEINITFIX) \| !(MODEUIC))`) | njfet.ts:742–743; pjfet.ts:698–699 | Outer convergence-bump gate missing entirely. ngspice's gate is `!(MODEINITFIX) \| !(MODEUIC)` (bitwise-OR — intentional ngspice quirk that makes it always-true in practice since both bits are rarely set together, but must be replicated exactly). digiTS unconditionally calls `ctx.noncon.value++` on `icheckLimited`. | HIGH | Wrap the existing `if (icheckLimited) ctx.noncon.value++;` in: `if (!(mode & MODEINITFIX) \| !(mode & MODEUIC)) { if (icheckLimited) ctx.noncon.value++; }`. Note: bitwise-OR (`\|`) not logical-OR (`\|\|`) — replicate the ngspice quirk exactly. Apply to both njfet.ts and pjfet.ts. |
| J-W3-3 | jfetload.c:536–539 (external drain/source stamps `JFETdrainDrainPtr += gdpr` etc.) | njfet.ts:768–776; pjfet.ts:721–730 | `gdpr` / `gspr` (series-resistance conductances) are computed but never stamped. When `RD > 0` or `RS > 0`, the drain/source ohmic resistances are silently dropped from the Y-matrix. | HIGH | After computing `gdpr` / `gspr`, stamp them. Since digiTS collapses prime↔external nodes (no internal drain-prime / source-prime), the 6-stamp ngspice pattern reduces to 2 self-stamps: `if (gdpr > 0) stampG(nodeD, nodeD, +gdpr); if (gspr > 0) stampG(nodeS, nodeS, +gspr);`. Apply to both njfet.ts and pjfet.ts. |

**Carry-forward status:**
- **A-1** / **A-2** (`Math.min(expArg, 80)` absence per `jfetload.c`): CONFIRMED ABSENT — zero hits for `Math\.min\([^)]*80\)` in njfet.ts / pjfet.ts. CLOSED.

**Cross-ref absorbed into Phase 7 rows (not duplicated here):** bypass block + `cghat` / `cdhat` convergence, MODEINITPRED state-copy of CG/CD/CGD/GM/GDS/GGS/GGD, JFET-specific `checkConvergence`, schema rename SLOT_GD_JUNCTION→SLOT_GGS_JUNCTION.

---

## §2. F4c papering residue (L1c)

**CLEAN (10 devices):** triac (E-1 papering successfully removed in W1.6), scr, diac, tunnel-diode, triode, memristor, analog-fuse, crystal (F4b APPROVED FIX — not F4c), LED (F4b via optocoupler composition — not F4c), transmission-line (F4a APPROVED FIX — not F4c).

**RESIDUE (2 devices):**

| # | file:line | Residue | Remedy |
|---|---|---|---|
| F4c-W3-1 | `src/components/sensors/ntc-thermistor.ts:20` | Comment `"Unified load() pipeline (matches ngspice DEVload)"` frames F4c device as ngspice port. | Delete `(matches ngspice DEVload)` from the comment. NTC is digiTS-only; its load pipeline is not a port of anything. |
| F4c-W3-2 | `src/components/sensors/__tests__/ntc-thermistor.test.ts:328, 362, 364` | Comments `"NGSPICE reference: ngspice resload.c stamps G=1/R"` + `"NGSPICE ref: G = 1/r0 when T == T₀"` + variable `const NGSPICE_G_REF = 1 / NTC_DEFAULTS.r0;`. F4c tests are self-compare, not ngspice-parity. | Strip the NGSPICE comments. Rename `NGSPICE_G_REF` → `EXPECTED_G`. Keep the numerical assertions; just un-frame them as ngspice-reference. |
| F4c-W3-3 | `src/components/sensors/spark-gap.ts:29` | Comment `"Unified load() pipeline (matches ngspice DEVload)"` — identical pattern to F4c-W3-1. | Same remedy: delete `(matches ngspice DEVload)`. |
| F4c-W3-4 | `src/components/sensors/__tests__/spark-gap.test.ts:375, 407, 418, 422, 426, 429, 432` | `"NGSPICE reference: ngspice resload.c..."` comment + variable `NGSPICE_G_REF` + assertions against it. | Same remedy: strip comments, rename variable to `EXPECTED_G`. |

All four items land in a single commit: `Phase 2.5 W3 — strip F4c ngspice framing from ntc-thermistor + spark-gap`.

---

## §3. Suppression residue (L3)

**Status:** follow-up agent reported 2026-04-22. W2.4 execution was highly effective — 28 of 44 enumerated sites removed (~64%), and `toBeCloseTo` occurrences dropped from 852 → 5 (**99.4% elimination**).

### §3.1 `toBeCloseTo` residue — 5 sites total

| # | file:line | Assessment | Remedy |
|---|---|---|---|
| L3-tB-1 | `src/components/active/__tests__/comparator.test.ts:175, 178, 181` | 3 sites in F4c APPROVED ACCEPT digiTS-only device. Hand-computed constants (`G_off = 1/1e9`, `G_sat = 1/rSat`). Under F4c ACCEPT rules these are permitted as self-compare snapshots. | **ACCEPTABLE.** Per `architectural-alignment.md §F4c`, self-compare values are the allowed test pattern. Add a `// self-compare (F4c ACCEPT — comparator is digiTS-only)` comment above each assertion for clarity. |
| L3-tB-2 | `src/components/active/__tests__/real-opamp.test.ts:526, 527` | 2 sites. Parameter-plumbing asserts (`expect(params.gainBW).toBeCloseTo(1e6)` etc.) verifying preset loading. | **ACCEPTABLE.** Parameter plumbing is an A1 §Test handling survivor category. No change. |

### §3.2 Concrete suppression residue — 16 RESIDUE entries (29 physical sites)

**Simulation-path sites (priority):**

| # | file:line | Pattern | Remedy |
|---|---|---|---|
| L3-s-1 | `src/solver/analog/__tests__/buckbjt-smoke.test.ts:19` | `catch { console.warn(...) }` hiding DLL-availability failure in harness test | Convert to explicit `throw new Error('ngspice DLL required for buckbjt smoke test')` — I1 requires no silent suppression |
| L3-s-2 | `src/solver/analog/__tests__/buckbjt-convergence.test.ts:53` | `describe.skip` when DLL missing (silent skip) | Replace with `throw new Error('ngspice DLL required for buckbjt convergence test')`; test becomes a hard failure in environments without the DLL |

**Memory / I/O / fixture robustness fallbacks (lower priority — not numerical):**

| # | file:line | Pattern | Remedy |
|---|---|---|---|
| L3-s-3 | `src/components/memory/rom.ts:118` | `catch { /* ignore */ }` on JSON parse | Replace with `catch (err) { console.warn('ROM serialized data corrupt', err); return null; }` |
| L3-s-4 | `src/components/memory/ram.ts:215` | same pattern, RAM | Same remedy as L3-s-3 |
| L3-s-5 | `src/components/memory/eeprom.ts:103` | same pattern, EEPROM | Same remedy as L3-s-3 |
| L3-s-6 | `src/fixtures/__tests__/shape-audit.test.ts:175` | `catch { /* ignore */ }` on bag property get | Add explicit error path with element-type + property-key context |
| L3-s-7 | `src/io/file-resolver.ts:230, 242, 267, 273` (4 sites) | `catch {}`, `catch { continue; }`, `catch { return []; }` filesystem probe fallbacks | Each: add `console.warn` with file path + error message |
| L3-s-8 | `src/io/ctz-parser.ts:68` | `catch {}` deflate-raw → deflate fallback | Add warning log citing which format was tried / succeeded |
| L3-s-9 | `src/io/dig-serializer.ts:65, 74, 86, 110` (4 sites) | `catch {}` JSON parse / stringify fallbacks | Add warning logs — surface format issues without blocking |
| L3-s-10 | `src/fixtures/__tests__/shape-render-audit.test.ts:217, 241, 301, 392, 416, 457, 878` (7 sites) | Factory/draw construction swallows in audit harness | Consolidate into single factory-error reporter; log element type + error message into the audit result |
| L3-s-11 | `src/fixtures/__tests__/analog-shape-render-audit.test.ts:248, 262, 293, 387, 395, 415, 786` (7 sites) | Same pattern as L3-s-10 | Same remedy; share the reporter with L3-s-10 |

### §3.3 Verdict

**W2.4 did not leak suppression residue into numerical assertions.** All simulation-path suppressions (`simulation-controller.ts`, `ngspice-bridge.ts`, `digital-pin-model.test.ts`, etc. — 28 sites) are removed. Residue is concentrated in:

- DLL-availability test gates (L3-s-1, L3-s-2) — 2 sites, convert to hard-fail.
- I/O robustness fallbacks (memory devices, file-resolver, serializers, parsers) — 12 sites, convert silent catches to logged warnings.
- Audit-harness factory swallows — 14 sites (2 files × 7 each), consolidate into a shared reporter.

None are in the analog simulator load / stamp / state paths. None block Phase 3+ progress. Fix as a single dedicated commit: `Phase 2.5 W3 L3 — convert silent I/O catches to logged warnings + hard DLL gates`.

---

## §4. Deleted-test manifest (L2 proposal)

**PROPOSAL ONLY.** No deletions executed. User reviews, then a separate commit lands.

**DEFINITE-DELETE files:** 0 (all test files have survivors).

**Already A1-compliant (file headers document W2.4 deletions — no W3 action):**
- `src/components/semiconductors/__tests__/bjt.test.ts`
- `src/components/semiconductors/__tests__/jfet.test.ts`
- `src/components/active/__tests__/timer-555.test.ts`

**PARTIAL block deletions proposed:**

| File | Lines | Reason | Remedy |
|---|---|---|---|
| `src/components/passives/__tests__/polarized-cap.test.ts` | 492–494 | `pool.state0[0/1/2]` reads with hand-computed expected `// GEQ`, `// IEQ`, `// V_PREV` — A1-deleted cross-method slots | Delete the three assertions. |
| same file | 661–662 | `SLOT_GEQ_PC` / `SLOT_IEQ_PC` direct `toBe()` expectations | Delete the two assertions. |
| `src/components/passives/__tests__/capacitor.test.ts` | 569 | `expect(q0_actual).toBe(1e-12)` — hand-computed, no ngspice provenance | Delete the single assertion. If the surrounding test becomes empty, delete the test block. |
| `src/components/passives/__tests__/crystal.test.ts` | 2 × pool state0 assertions (exact lines TBD during execution) | Hand-computed SLOT reads without provenance | Delete the assertions; if block empties, delete block. |

**Kept (with ngspice-harness provenance):** 21 test files carry `// from ngspice harness run <cite>` or `NGSPICE_*` constants. Survive per A1 §Test handling rule.

**`toBeCloseTo` / `toBe(<number>)` total occurrences:** 85 files. Most are parameter plumbing (`expect(params.RS).toBe(100)`), F4c self-compare with labels, or have provenance. No bulk sweep needed beyond the partial deletions above.

**Execute only after user review.** Commit message: `Phase 2.5 W3 L2 — stale test deletion per user-approved list`.

---

## §5. Carry-forwards from reconciliation-notes.md §5

The original 7 post-A1 deferrals:

| Item | Source (fix-list-phase-2-audit.md) | W3 verification result | Status |
|---|---|---|---|
| A-1 | njfet.ts banned `Math.min(expArg, 80)` clamp removal | Grep `Math\.min\([^)]*80\)` in `njfet.ts` → 0 hits | **CLOSED** |
| A-2 | pjfet.ts same banned clamp | Grep same in `pjfet.ts` → 0 hits | **CLOSED** |
| C-4 | `behavioral-flipflop.ts` `_prevClockVoltage` seeded by a new `initState()` method | Method named `initVoltages(rhs: Float64Array)` at line 119 primes `_prevClockVoltage` from `readMnaVoltage(clockPin.nodeId, rhs)`. Method exists; lifecycle wiring (is it called between DC-OP convergence and first transient step?) NOT VERIFIED in W3. | **PARTIAL — open for Phase 3+.** Verification task: `Grep "initVoltages" src/solver/analog/` to find the caller chain. Confirm `initVoltages` is invoked after DC-OP convergence, before first transient `load()`. If not called: wire it in analog-engine.ts / coordinator. If called: item closes. Audit similar fields across `behavioral-*.ts` via `Grep "_prev[A-Z]" src/solver/analog/behavioral-*.ts`. |
| C-5 | `ckt-mode.ts::isDcop()` helper uses `MODEDC` mask (0x70), not `MODEDCOP` (standalone) | `ckt-mode.ts:106-108`: `export function isDcop(mode: number): boolean { return (mode & MODEDC) !== 0; }` — CORRECT | **CLOSED** |
| D-1 | diode.ts banned `Math.min(vd/nVt, 700)` clamp removal | Grep `Math\.min\([^)]*700\)` in `diode.ts` → 0 hits | **CLOSED** |
| D-8 | MOSFET `cgs_cgd_transient_matches_ngspice_mos1` regression (-3.5e-12 delta) | Slot `SLOT_CAP_IEQ_DB` that held the value excised by A1; quantity now embedded in `niIntegrate` output at `mosfet.ts:1340–1388`. Static analysis cannot resolve. | **INCONCLUSIVE — open for Phase 6+.** Measurement task: post-Phase-6 harness comparison of MOSFET `cgs_cgd_transient` test. If bit-exact against ngspice: item closes. If non-zero delta: PARITY ticket against the new MOSFET `load()`. |
| D-15 | Capacitor default `_IC = 0.0` + unconditional cond1 use | `CAPACITOR_DEFAULTS._IC = 0.0` confirmed; cond1 branch uses `this._IC` unconditionally (no `isNaN` guard) | **CLOSED** |

**Net remaining carry-forwards:** 2 items (C-4 partial, D-8 inconclusive). 5 items closed.

---

## §6. Summary and handoff

### CRITICAL (12)

| ID | Device | Bug summary |
|---|---|---|
| D-W3-1, D-W3-2 | diode | IKF/IKR `sqrt(1 + id/IKF)` spurious `+1`; current-not-corrected Norton pair (both regions) |
| Z-W3-1, Z-W3-2 | zener | Forward/breakdown split at wrong voltage + entire reverse-cubic branch missing |
| C-W3-1 | architectural | `solver.stampElement` and `solver.stampRHS` accumulation semantics — verify both are `+=` not `=`. If overwriting: silent wrong matrix on every multi-device circuit |
| PC-W3-1 | polarized-cap | Entire `dio/*` reverse-bias clamp primitive missing (half of F4b composition absent) |
| I-W3-1 | inductor | Flux seeded from `voltages[b]` (current NR iterate) not `ctx.rhsOld[b]` — directly explains rl_dc_steady_state failure |
| T-W3-1 | transformer | `branchCount: 1` but device needs 2 — every multi-element circuit with a transformer gets wrong matrix |
| T-W3-2 | transformer | Integration gate `MODETRAN` not `!MODEDC` — zeros companions at MODEINITTRAN |
| T-W3-3 | transformer | NIintegrate never called; manual ag-expansion skips ccapPrev. BDF-2 history wrong from step 2 |
| TT-W3-1 | tapped-transformer | Same `branchCount: 1` — needs 3 |
| B-W3-1 | bjt | `czsub` missing `* AREA` factor |
| J-W3-1 | jfet | MODEINITSMSIG missing `return` — stamps always execute in small-signal mode |

### HIGH (14)

Z-W3-3 (zener gmin Norton), Z-W3-4 (zener MODEINITJCT 4-branch), Z-W3-5 (zener `tBV` → plan-addendum 4.3.3), PC-W3-2, PC-W3-3, PC-W3-4 (polarized-cap MODEAC + inner fork + missing parity test), I-W3-2 (inductor spurious MODEDC arm), T-W3-4 (transformer UIC path absent), B-W3-2 (BJT `evsub` unclamped), M-W3-1, M-W3-2, M-W3-3 (MOSFET cktFixLimit + icheckLimited init + MODEINITSMSIG limiting), J-W3-2, J-W3-3 (JFET noncon gate + RD/RS stamps dropped).

### MEDIUM / LOW (~25)

Tabulated per-device above. Remedies are concrete. Low-priority items (sidewall / tunnel currents, vestigial SLOT_V, combined flux formula) can be deferred indefinitely; medium items should be addressed during Phase 3+ or as opportunities.

### Phase routing

- **Immediate W3 follow-up commits** (before Phase 3 begins):
  - F4c-W3-1 through F4c-W3-4 (strip ngspice framing from ntc-thermistor + spark-gap) — single commit.
  - L3 residue sweep (after follow-up lane reports).
  - L2 partial deletions (after user approves the deletion list).
  - C-W3-1 architectural verification of `stampElement` / `stampRHS` semantics — gating for every numerical item.
- **Trivial CRITICAL fixes (one-line each, no Phase dependency):** T-W3-1, TT-W3-1 (branchCount), I-W3-1 (rhsOld), B-W3-1 (`* params.AREA`), J-W3-1 (`return`), T-W3-2 (gate operator), PC-W3-2/3 (gate). Candidate for a single "W3 CRITICAL patch" commit.
- **Non-trivial CRITICAL requiring larger surgery:** D-W3-1/2 (IKF/IKR re-port), Z-W3-1/2 (three-region structure), PC-W3-1 (clamp primitive), T-W3-3 (SLOT_CCAP1/2 + NIintegrate calls). User decides fix-now-standalone vs. bundle-into-Phase-3+.
- **HIGH and MEDIUM**: either bundled into a W3 patch commit or deferred to their cross-referenced Phase 3–9 rows.
- **Architectural (§I2 notes)**: SLOT_CCAP lifetime for diode, inductor — user action per forcing function. Adds I2 entries, no code change.

### Handoff

Next document: **`spec/phase-3-onwards.md`**. Re-authors surviving plan.md Phases 3–9 tasks against the post-A1 `load()` file layout + the W3 findings above. Inputs:
- This file (`spec/post-a1-parity.md`)
- `spec/plan-addendum.md` (87 surviving post-A1 tasks across Phases 3–9)
- `spec/architectural-alignment.md` (30 approved items)

### Phase 2.5 completion gate

Four items before Phase 2.5 can be declared complete and Phase 3+ can open:

1. User review of CRITICAL items (decide fix-now-standalone vs bundle-into-Phase-3+, per-item).
2. L3 follow-up lane commits its residue table, §3 of this file updates.
3. L2 partial-deletion commit lands after user approval.
4. `spec/phase-3-onwards.md` drafted and committed.

Once all four land: `Phase 2.5 complete — Track A landed, post-A1 PARITY list captured` commit. Phase 3+ opens.
