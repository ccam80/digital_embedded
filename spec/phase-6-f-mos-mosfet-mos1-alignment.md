# Phase 6: F-MOS — MOSFET MOS1 Alignment

## Overview

Align `src/components/semiconductors/mosfet.ts::createMosfetElement.load()` to ngspice `ref/ngspice/src/spicelib/devices/mos1/mos1load.c::MOS1load` so that every NR iteration through an NMOS or PMOS device mirrors ngspice bit-for-bit at the MOS1 level. Phase 6 closes the post-A1 MOSFET alignment gap before the Phase 10 MOSFET-inverter bit-exact acceptance gate.

Every task operates inside the unified `load()` method (`mosfet.ts` lines ≈1004–1632). The 11 deleted MOSFET cross-method slots (`SLOT_CAP_GEQ_GS/_GD/_DB/_SB/_GB`, `SLOT_IEQ_*`, `SLOT_Q_*`) are locals in `load()`; Meyer charges and cap companions compute and stamp in a single pass. G1 (VBS/VBD sign convention) already landed in Phase 2.5. M-W3-4 (`params.GAMMA` semantics) was closed 2026-04-24 — no edit required.

Preconditions assumed landed by Phase 5:
- `LoadContext.bypass: boolean` and `LoadContext.voltTol: number` fields present.
- Bypass infrastructure exercised by BJT waves, so the MOSFET bypass in Wave 6.2 reuses the same shape.

Non-goals for Phase 6 (deferred):
- BSIM / MOS2 / MOS3 — F-MOS scopes to MOS1 Shichman-Hodges only.
- E2E / MCP surface tests — covered at Phase 10 acceptance.
- MOSFET inverter bit-exact transient (`cgs_cgd_transient` regression / D-8 carry-forward) — Phase 10 acceptance closure only.

---

## Wave 6.1: Infrastructure (verify-landed + TEMP override)

### Task 6.1.1: Verify `SLOT_VON` zero-initialisation

- **Description**: Phase 2.5 landed `SLOT_VON` as `{ kind: "zero" }` and removed the `isNaN` guard in the VON read path. Confirm the current state survives with verify-only evidence.
- **Files to modify**: none (verify only).
- **Tests**:
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET schema::SLOT_VON init kind` — assert `MOSFET_SCHEMA.slots[MOSFET_SCHEMA.getSlotOffset("VON")].init.kind === "zero"`.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET schema::VON read path has no NaN guard` — grep (via fs.readFileSync at test time) `mosfet.ts` content for `isNaN.*VON` / `Number\.isNaN.*VON`, assert zero matches.
- **Acceptance criteria**:
  - `MOSFET_SCHEMA` has `VON` with `init: { kind: "zero" }`.
  - No `isNaN` / `Number.isNaN` check gates reads of `SLOT_VON` in `mosfet.ts`.
  - All tests pass.

### Task 6.1.2: Verify `getLteTimestep` covers bulk charges

- **Description**: Phase 2.5 added `QBS`, `QBD` to the MOSFET `getLteTimestep` LTE loop. Confirm by test.
- **Files to modify**: none (verify only).
- **Tests**:
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET LTE::includes QBS and QBD` — construct a MOSFET with `CBD=1pF, CBS=1pF`, run one transient step so `SLOT_QBS / SLOT_QBD / SLOT_CQBS / SLOT_CQBD` carry non-zero values, call `getLteTimestep` with crafted `deltaOld / order / method / lteParams`, and assert the returned `minDt` is influenced by the QBS and QBD pairs. Implementation: zero out all `QGS/QGD/QGB` slots first; whatever `minDt` is returned must be strictly less than `Infinity` because QBS/QBD are non-zero.
- **Acceptance criteria**:
  - `getLteTimestep` includes both `[SLOT_QBS, SLOT_CQBS]` and `[SLOT_QBD, SLOT_CQBD]` pairs.
  - All tests pass.

### Task 6.1.3: Assert `LoadContext.bypass` and `LoadContext.voltTol` landed

- **Description**: Phase 5 is responsible for adding `bypass: boolean` and `voltTol: number` to `LoadContext`. This task is a compile-time import + runtime assertion at MOSFET construction so Phase 6 work fails loudly if the precondition did not land.
- **Files to modify**:
  - `src/components/semiconductors/mosfet.ts` — inside `createMosfetElement`, before returning the element object, add a one-line assertion that exercises the `LoadContext` type by creating a typed test adapter. Specifically: add a type-only reference `type _PhaseAssert = Pick<LoadContext, "bypass" | "voltTol">;` at module scope. This produces a TypeScript compile error if Phase 5 has not landed its `LoadContext` extension.
- **Tests**:
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET LoadContext precondition::bypass and voltTol exist` — construct a mock `LoadContext` with both fields and pass it into `load()`; assert the call does not throw and the fields are read through the `ctx.bypass` / `ctx.voltTol` code paths (verified by running the bypass branch introduced in Task 6.2.4).
- **Acceptance criteria**:
  - `mosfet.ts` contains `type _PhaseAssert = Pick<LoadContext, "bypass" | "voltTol">;` at module scope.
  - Compilation fails if either field is missing from `LoadContext`.
  - All tests pass.

### Task 6.1.4: Delete `primeJunctions()` + `primedFromJct` + consume-seed branch

- **Description**: ngspice has no pre-NR priming method — MODEINITJCT priming runs inside `mos1load.c` per the in-`load()` 3-branch priority Task 6.2.3 establishes (`ICVDS/ICVGS/ICVBS` + fallback + OFF-path zero). The digiTS `primeJunctions()` method + `primedFromJct` one-shot flag + consume-seed branch at the top of the voltage dispatch are digiTS-only scaffolding that duplicates and races with the MODEINITJCT in-`load()` branch. Once Task 6.2.3 lands, the digiTS priming method is dead weight; delete it.
- **Dependency**: Task 6.2.3 (MODEINITJCT IC_VDS / IC_VGS / IC_VBS fallback) must land first — that is the sole priming path post-deletion. Task 6.1.4 may commit in Wave 6.1 with a runtime assertion that the MODEINITJCT branch is reachable; the full test coverage in Task 6.2.3 gates Phase 6 closure.
- **Files to modify**:
  - `src/components/semiconductors/mosfet.ts`:
    - Delete the closure-scope variable `let primedFromJct = false;` (currently line 976).
    - Delete the header comment block describing it (currently line 975).
    - Delete the "Consume one-shot seed" branch at the top of `load()`'s voltage dispatch (currently lines 1038-1049 — the `if (primedFromJct) { ... primedFromJct = false; ... }` block that reads `s0[SLOT_VGS/VDS/VBS]` into locals and clears the flag). Control falls directly into the subsequent dispatch branches (`simpleGate`, `MODEINITJCT`, default-zero).
    - Delete the `primeJunctions(): void { ... }` method on the returned element object (currently lines 1684-1703).
  - `src/solver/analog/dc-operating-point.ts:323-324` — untouched in Phase 6. The `if (el.isNonlinear && el.primeJunctions)` guard handles MOSFET's new shape (no method defined) correctly. Call-site deletion is Phase 7.5 scope, after all implementers are gone.
  - `src/core/analog-types.ts:219` + `src/solver/analog/element.ts:120` — `primeJunctions?(): void;` optional interface member untouched in Phase 6; still used by zener + scr until Phase 7.5 lands.
- **Tests**:
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET primeJunctions::method absent from element` — after `createMosfetElement(...)`, assert `element.primeJunctions === undefined`.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET primeJunctions::MODEINITJCT branch primes directly` — construct NMOS with `OFF=0`, `ICVDS=0, ICVGS=0, ICVBS=0`; invoke `load()` under `mode = MODEDCOP | MODEINITJCT`; assert `s0[SLOT_VBS] === -1, s0[SLOT_VGS] === polarity * tp.tVto, s0[SLOT_VDS] === 0` (Task 6.2.3's fallback path — no separate primeJunctions call required).
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET primeJunctions::dc-operating-point skips MOSFET` — construct a MOSFET element, call the dc-operating-point `primeJunctions()` loop manually (or observe via integration), assert no throw and no state changes from the loop (because `el.primeJunctions` is absent, the optional-chain guard skips).
- **Acceptance criteria**:
  - `mosfet.ts` grep for `primeJunctions`, `primedFromJct` returns zero hits.
  - The returned MOSFET element object has no `primeJunctions` property.
  - All tests pass.
  - `dc-operating-point.ts:323-324` call site unchanged.

---

## Wave 6.2: MOSFET correctness

### Task 6.2.1: M-1 — MODEINITPRED limiting routing

- **Description**: Route predictor-computed voltages through the limiting block. `mos1load.c:356-406` runs `fetlim`/`limvds`/`pnjlim` unconditionally inside the simple/general dispatch block — the bypass guard excludes `MODEINITPRED|MODEINITTRAN|MODEINITSMSIG` but limiting does not.
- **Files to modify**:
  - `src/components/semiconductors/mosfet.ts::createMosfetElement::load()`:
    - Delete the `if ((mode & (MODEINITPRED | MODEINITTRAN)) === 0) { ... }` wrapper at line 1092.
    - Delete the `else { icheckLimited = false; }` at lines 1194-1196.
    - Move the limiting block (`fetlim` → `limvds` → `pnjlim`, including `ctx.limitingCollector` pushes) to run unconditionally inside the `simpleGate` branch.
    - Preserve the state-sequencing: the predictor branch at lines 1058 / 1060 / 1062 writes `s0[SLOT_VBS] = s1[SLOT_VBS]` etc. BEFORE the new predicted scalars compute; limiting then reads `s0[SLOT_V*]` which carries state1 as "old". Cite `mos1load.c:211-225, 370, 376, 382, 387, 395, 401`.
    - Preserve the `mode & MODEINITJCT` + default-zero branch's `icheckLimited = false;` at line 1216 — that path legitimately bypasses limiting because voltages are IC-seeded, not NR-driven.
- **Tests**:
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-1::predictor voltages pass through fetlim` — seed `s1[SLOT_VGS]=3.0, s2[SLOT_VGS]=2.0` (so predictor yields `vgs ≈ 4.0 * (1+xfact) - 3.0 * xfact` for some `xfact`), set `mode = MODEINITPRED | MODETRAN`, call `load()`, assert `ctx.limitingCollector` contains a `junction: "GS", limitType: "fetlim"` event.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-1::predictor voltages pass through pnjlim` — seed `s1[SLOT_VBS]=0.0, s2[SLOT_VBS]=-0.2` such that predictor yields `vbs > sourceVcrit + 2*vt`, call `load()` under `MODEINITPRED | MODETRAN`, assert `ctx.limitingCollector` contains a `junction: "BS", limitType: "pnjlim"` event and the limited `vbs` obeys the Gillespie bound.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-1::INITJCT path still skips limiting` — set `mode = MODEDCOP | MODEINITJCT`, OFF=0, run `load()`, assert `ctx.limitingCollector` is empty for that call.
- **Acceptance criteria**:
  - Limiting block runs for `MODEINITPRED`, `MODEINITTRAN`, `MODEINITFLOAT`, `MODEINITFIX && !OFF`, and `MODEINITSMSIG` (once 6.2.2 lands).
  - Limiting block does NOT run for `MODEINITJCT` or the default-zero path (IC-seeded modes).
  - `icheckLimited` behaviour follows Task 6.2.6 (not `= false;` blanket reset for predictor).
  - All tests pass.

### Task 6.2.2: M-2 — MODEINITSMSIG general-iteration path

- **Description**: Make SMSIG follow `mos1load.c`'s general-iteration path verbatim. `mos1load.c:202-204` gates SMSIG into the simple/general block; line 226 `else` branch reads `vbs/vgs/vds` from `CKTrhsOld`. There is no early return and no special "seed from state0" step. Post-fix, SMSIG also runs the limiting block (as a no-op at convergence), the cap + Meyer blocks, `useDouble` averaging, and the charge update `q = c*v` branch.
- **Files to modify**:
  - `src/components/semiconductors/mosfet.ts::createMosfetElement::load()`:
    - Delete the `else if (mode & MODEINITSMSIG) { vbs=s0[...]; vgs=s0[...]; vds=s0[...]; }` branch at lines 1065-1069.
    - Let SMSIG fall through the `if (mode & (MODEINITPRED | MODEINITTRAN))` guard's `else` at line 1070 and read `vbs/vgs/vds` from `ctx.rhsOld` with polarity scaling, same as `MODEINITFLOAT` / `MODEINITFIX&!OFF`.
    - Verify — no code change required — that `capGate` at line 1294 (= `MODETRAN|MODETRANOP|MODEINITSMSIG`) still fires for SMSIG.
    - Verify that `useDouble` at line 1425 (= `MODETRANOP|MODEINITSMSIG`) still fires for SMSIG.
    - Verify that the bulk-junction NIintegrate gate `runBulkNIintegrate` at line 1338 (= `MODETRAN || (MODEINITTRAN && !MODEUIC)`) excludes SMSIG — correct per `mos1load.c:701`.
    - Verify the charge-update branch at line 1445 (`mode & (MODEINITPRED|MODEINITTRAN)`) does NOT fire for SMSIG; SMSIG falls to the `else if (mode & MODETRAN)` / `else` branch; SMSIG is neither MODETRAN nor MODEINITPRED/MODEINITTRAN, so hits the TRANOP/SMSIG `q = c*v` branch at lines 1451-1454 — matches `mos1load.c:849-851`.
    - Verify the gate-cap NIintegrate gate `initOrNoTran = MODEINITTRAN || !MODETRAN` at line 1460 fires for SMSIG (SMSIG ∉ MODETRAN) → zero companions — matches `mos1load.c:862-866`.
    - Add a citation-comment block at the simpleGate dispatch citing `mos1load.c:202-204, 226-240, 565, 789, 862`, documenting that SMSIG takes the general-iteration path with no early return, mirroring ngspice.
- **Tests**:
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-2::SMSIG reads voltages from rhsOld` — construct a MOSFET whose pin nodes are mapped; set `ctx.rhsOld` so that `vbs/vgs/vds` from rhs differ from state0; call `load()` under `mode = MODEDCOP | MODEINITSMSIG`; assert the stamped currents reflect the rhsOld-derived voltages, not state0-derived.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-2::SMSIG uses useDouble cap averaging` — seed `s0[SLOT_CAPGS] = C`, `s1[SLOT_CAPGS] = Cprev`, call `load()` under `mode = MODEDCOP | MODEINITSMSIG` with a non-zero `CGSO`, assert the Y(G,G) stamp's `gcgs` contribution equals `ag[0] * (2 * C + GateSourceOverlapCap)` (i.e. `useDouble` path).
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-2::SMSIG skips bulk NIintegrate` — seed `s0[SLOT_QBS], s1[SLOT_QBS]` such that a normal MODETRAN NIintegrate would fire a non-zero `SLOT_CQBS` write; run under `mode = MODEDCOP | MODEINITSMSIG`; assert `s0[SLOT_CQBS]` is UNCHANGED from its pre-call value.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-2::SMSIG qgs = c*v` — with non-zero overlap+junction caps and a step voltage, assert `s0[SLOT_QGS] === vgs * capgs` after the call under `mode = MODEDCOP | MODEINITSMSIG`.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-2::SMSIG stamps run` — assert the solver's G matrix and RHS are non-zero in the expected entries after a SMSIG load (i.e. no early return).
- **Acceptance criteria**:
  - No branch at `mosfet.ts` reads from `s0[SLOT_VBS/VGS/VDS]` conditional on `mode & MODEINITSMSIG`.
  - SMSIG load() path produces the same `{vbs, vgs, vds}` triple as `MODEINITFLOAT` given identical `ctx.rhsOld`.
  - SMSIG path produces stamps (Y + RHS) identical to ngspice's post-bypass stamp execution.
  - All tests pass.

### Task 6.2.3: M-3 — MODEINITJCT IC_VDS / IC_VGS / IC_VBS

- **Description**: Add per-instance initial-condition params `ICVDS`, `ICVGS`, `ICVBS`. Inside `load()`'s `MODEINITJCT && !OFF` branch, read the IC values first; if all three are zero AND `(mode & (MODETRAN|MODEDCOP|MODEDCTRANCURVE)) || !(mode & MODEUIC)`, fall back to `(vbs=-1, vgs=polarity*tVto, vds=0)`. Cite `mos1load.c:419-430`.
- **Files to modify**:
  - `src/components/semiconductors/mosfet.ts`:
    - Add `ICVDS`, `ICVGS`, `ICVBS` to `MosfetParams` and `ResolvedMosfetParams` interfaces (default 0).
    - Add them to both `MOSFET_NMOS_PARAM_DEFS` and `MOSFET_PMOS_PARAM_DEFS` under `secondary`, with `default: 0, unit: "V"`, description: "Initial condition for Vds/Vgs/Vbs (MODEUIC)".
    - Thread the three params through `resolveParams`.
    - Inside the `createMosfetElement` factory's `load()` method, replace the current MODEINITJCT branch at lines 1200-1209 with:
      ```ts
      if ((mode & MODEINITJCT) && params.OFF === 0) {
        vds = polarity * params.ICVDS;
        vgs = polarity * params.ICVGS;
        vbs = polarity * params.ICVBS;
        const allZero = vds === 0 && vgs === 0 && vbs === 0;
        const fallback = allZero && (
          (mode & (MODETRAN | MODEDCOP | MODEDCTRANCURVE)) !== 0
          || (mode & MODEUIC) === 0
        );
        if (fallback) {
          vbs = -1;
          vgs = polarity * tp.tVto;
          vds = 0;
        }
      } else { vbs = 0; vgs = 0; vds = 0; }
      ```
    - Import `MODEDCOP` and `MODEDCTRANCURVE` if not already imported. `MODEDCOP` is already imported; verify `MODEDCTRANCURVE` presence in `ckt-mode.ts` — if missing, add it as a precondition (cite `cktdefs.h`).
- **Tests**:
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-3::IC fallback on all-zero ICs` — construct NMOS with `ICVDS=0, ICVGS=0, ICVBS=0, OFF=0`, run under `mode = MODEDCOP | MODEINITJCT`, assert `s0[SLOT_VBS] === -1`, `s0[SLOT_VGS] === tp.tVto`, `s0[SLOT_VDS] === 0` after the call.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-3::IC values used when non-zero` — construct NMOS with `ICVDS=2.5, ICVGS=1.5, ICVBS=0`, run under `mode = MODEINITJCT | MODEUIC`, assert `s0[SLOT_VDS] === 2.5`, `s0[SLOT_VGS] === 1.5`, `s0[SLOT_VBS] === 0` after the call (note: non-zero ICVDS disables the fallback even with `MODEUIC`).
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-3::PMOS polarity applied to ICs` — construct PMOS with `ICVDS=2.5, ICVGS=1.5`, run under `mode = MODEINITJCT | MODEUIC`, assert `s0[SLOT_VDS] === -2.5`, `s0[SLOT_VGS] === -1.5`.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-3::MODEDCOP + MODEUIC with zero ICs triggers fallback` — construct NMOS with `ICVDS=0, ICVGS=0, ICVBS=0`, run under `mode = MODEDCOP | MODEINITJCT | MODEUIC`. Per `mos1load.c:424-425` the fallback gate is `(CKTmode & (MODETRAN|MODEDCOP|MODEDCTRANCURVE)) || !(CKTmode & MODEUIC)` — `MODEDCOP` is in the enabling set so the fallback fires even with `MODEUIC` set. Assert `s0[SLOT_VBS] === -1, s0[SLOT_VGS] === polarity * tp.tVto, s0[SLOT_VDS] === 0`.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-3::pure MODEUIC with zero ICs skips fallback` — construct NMOS with `ICVDS=0, ICVGS=0, ICVBS=0`, run under `mode = MODEINITJCT | MODEUIC` (NO MODETRAN/MODEDCOP/MODEDCTRANCURVE bits). Per the same gate, the enabling set is empty and `!MODEUIC` is false — fallback does NOT fire. Assert `s0[SLOT_VBS] === 0, s0[SLOT_VGS] === 0, s0[SLOT_VDS] === 0` (ICs stay zero, no fallback overwrite).
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-3::OFF=1 forces zero` — construct NMOS with `OFF=1`, `ICVDS=2.5`, run under `mode = MODEINITJCT`, assert `s0[SLOT_VBS] === 0`, `s0[SLOT_VGS] === 0`, `s0[SLOT_VDS] === 0` (ICs ignored, default-zero branch).
- **Acceptance criteria**:
  - `ICVDS`, `ICVGS`, `ICVBS` present in both NMOS and PMOS param defs with default 0 V.
  - Load() MODEINITJCT branch matches `mos1load.c:419-430` fallback logic verbatim.
  - All tests pass.

### Task 6.2.4: M-4 — NOBYPASS bypass test

- **Description**: Port `mos1load.c:258-348` verbatim — compute `cdhat`/`cbhat` from previous-iteration conductances in `load()`, then run a 5-tolerance bypass gate (`cbhat vs cbs+cbd`, `delvbs`, `delvbd`, `delvgs`, `delvds`, `cdhat vs cd`). On bypass, reload vbs/vbd/vgs/vds from state0, rebuild `capgs/capgd/capgb` from `state0 + state1` half-caps (MODETRAN / MODETRANOP only), skip OP evaluation + junction charge update + bulk-junction NIintegrate + Meyer block + gate-cap NIintegrate, and jump to the stamp section. Stamps still run using cached conductances from state0 (`SLOT_GM/GDS/GMBS/GBD/GBS`).
- **Files to modify**:
  - `src/components/semiconductors/mosfet.ts::createMosfetElement::load()`:
    - After line 1090 (post-common-crunching `vbd=vbs-vds; vgd=vgs-vds`), add the cdhat / cbhat computation per `mos1load.c:258-277`. Reads `s0[SLOT_CD/GM/GDS/GMBS/GBD/GBS/CBS/CBD]` for "previous iteration" quantities; `delvbs/delvbd/delvgs/delvds` against `s0[SLOT_VBS/VBD/VGS/VDS]` (before the state0 overwrite at line 1395).
    - Implement the bypass gate per `mos1load.c:282-348`:
      ```
      if (!(mode & (MODEINITPRED | MODEINITTRAN | MODEINITSMSIG))
          && ctx.bypass
          && 5-tolerance checks all pass) {
        // bypass branch — mos1load.c:322-347
        vbs = s0[SLOT_VBS]; vbd = s0[SLOT_VBD]; vgs = s0[SLOT_VGS]; vds = s0[SLOT_VDS];
        vgd = vgs - vds; vgb = vgs - vbs;
        cdrain = mode_stored * (cd + cbd);  // MOS1mode * (cd + cbd)
        if (mode & (MODETRAN | MODETRANOP)) {
          capgs = s0[SLOT_CAPGS] + s1[SLOT_CAPGS] + GateSourceOverlapCap;
          capgd = s0[SLOT_CAPGD] + s1[SLOT_CAPGD] + GateDrainOverlapCap;
          capgb = s0[SLOT_CAPGB] + s1[SLOT_CAPGB] + GateBulkOverlapCap;
        }
        // fall through to bypass stamp target
        bypassed = true;
      }
      ```
    - Flag `bypassed: boolean` used to skip the OP evaluation block (lines 1224-1290), the cap+charge block (lines 1294-1392), and the Meyer+gate-cap block (lines 1400-1542). On `bypassed===true`, read `gm`, `gds`, `gmbs`, `gbd`, `gbs`, `cbd`, `cbs` from `s0[SLOT_*]` directly and use them in the stamp section.
    - Stamps at lines 1566-1626 run unchanged whether bypassed or not — they use `gmNR/gdsNR/gmbsNR/gbd/gbs/cbd/cbs` which are filled either by fresh OP eval or by state0 reload.
    - `ceqbs/ceqbd/cdreq` at lines 1544-1553 recompute using the reloaded voltages (bypass) or fresh voltages (no bypass) — identical code path.
    - 5-tolerance gate exact formulation (verbatim from `mos1load.c:288-315`):
      ```
      tempv = Math.max(Math.abs(cbhat), Math.abs(cbs + cbd)) + ctx.iabstol;
      Math.abs(cbhat - (cbs + cbd)) < ctx.reltol * tempv
      && Math.abs(delvbs) < ctx.reltol * Math.max(Math.abs(vbs), Math.abs(s0[SLOT_VBS])) + ctx.voltTol
      && Math.abs(delvbd) < ctx.reltol * Math.max(Math.abs(vbd), Math.abs(s0[SLOT_VBD])) + ctx.voltTol
      && Math.abs(delvgs) < ctx.reltol * Math.max(Math.abs(vgs), Math.abs(s0[SLOT_VGS])) + ctx.voltTol
      && Math.abs(delvds) < ctx.reltol * Math.max(Math.abs(vds), Math.abs(s0[SLOT_VDS])) + ctx.voltTol
      && Math.abs(cdhat - cd) < ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(cd)) + ctx.iabstol
      ```
    - noncon gating at line 1629 still runs (bypass does not skip the noncon decision — cite `mos1load.c:738` which runs after the `bypass:` label).
  - `src/solver/analog/ckt-load.ts` and any upstream populating `LoadContext` — ensure `ctx.bypass` and `ctx.voltTol` are populated per iteration. (This is Phase 5 precondition; Task 6.1.3 compile-time-asserts.)
- **Tests**:
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-4::bypass fires when within tolerances` — seed state0 at a converged DC-OP, set `ctx.rhsOld` so that `vbs/vgs/vds` match state0 to within `ctx.reltol`, set `ctx.bypass=true, ctx.voltTol=1e-6`; call `load()`. Assert: (a) stamps happen (non-zero Y and RHS), (b) `s0[SLOT_CD]` is UNCHANGED (no OP re-eval), (c) `s0[SLOT_CQGS/CQGD/CQGB]` UNCHANGED (no NIintegrate).
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-4::bypass disabled during predictor` — same setup but `mode = MODEINITPRED | MODETRAN`. Assert `s0[SLOT_CD]` IS updated (bypass guard excludes MODEINITPRED).
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-4::bypass disabled during SMSIG` — mode `= MODEDCOP | MODEINITSMSIG`. Assert `s0[SLOT_CD]` IS updated.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-4::bypass does not fire when delvbs exceeds voltTol` — seed state0, set `ctx.rhsOld` so that `delvbs = 10*ctx.voltTol`, call `load()`. Assert `s0[SLOT_CD]` is updated (no bypass).
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-4::bypass with MODETRAN rebuilds capgs/d/b from halves` — seed `s0[SLOT_CAPGS]=1e-12, s1[SLOT_CAPGS]=1.1e-12`, CGSO = 3e-12, W=1e-6, bypass fires under MODETRAN, assert the Y(G,G) stamp's gcgs contribution equals `ag[0] * (1e-12 + 1.1e-12 + 3e-18)`.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-4::noncon increments even on bypass` — seed state0 with `icheckLimited=true` semantics (e.g. pre-populate the previous `Check=1` via s0). After bypass, assert `ctx.noncon.value` increments exactly as it would without bypass (bypass does not gate noncon per `mos1load.c:738`).
- **Acceptance criteria**:
  - Bypass gate negative guards on `MODEINITPRED | MODEINITTRAN | MODEINITSMSIG` and requires `ctx.bypass === true`.
  - Bypass gate's 5-tolerance formula is bit-for-bit identical to `mos1load.c:288-315`.
  - Bypass reloads voltages from state0, rebuilds cap totals from cached halves, skips OP eval + charge + integrate blocks, still runs stamps using state0 conductances.
  - `ctx.noncon.value` and `ctx.limitingCollector` unaffected by bypass (no limiting events posted when bypassed; noncon gate still runs from post-limiting `icheckLimited`).
  - All tests pass.

### Task 6.2.5: M-5 — Verify `CKTfixLimit` gate on reverse limvds

- **Description**: Phase 2.5 landed the `ctx.cktFixLimit` gate on reverse `limvds` (line 1133: `if (!ctx.cktFixLimit) { vds = -limvds(-vds, -vdsOldStored); }`). Verify it survived the Task 6.2.1 limiting re-port.
- **Files to modify**: none (verify only).
- **Tests**:
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-5::cktFixLimit=true skips reverse limvds` — set `s0[SLOT_VDS] = -1.0` (reverse mode), `ctx.rhsOld` drives a reverse-mode step, `ctx.cktFixLimit = true`; call `load()`. Assert `ctx.limitingCollector` contains zero `junction: "DS", limitType: "limvds"` events.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-5::cktFixLimit=false runs reverse limvds` — same setup with `ctx.cktFixLimit = false`; assert a `limvds` event fires on the DS junction.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-5::forward limvds always runs` — `s0[SLOT_VDS] = 1.0` (forward mode), `ctx.cktFixLimit = true`; assert a `limvds` event fires (forward path is not guarded).
- **Acceptance criteria**:
  - Reverse-mode `limvds` is gated on `!ctx.cktFixLimit`.
  - Forward-mode `limvds` always runs.
  - All tests pass.

### Task 6.2.6: M-6 — `icheckLimited` init semantics

- **Description**: Align the `icheckLimited` local to ngspice's `Check` semantics: `Check` starts at 1 (`mos1load.c:108`); `DEVpnjlim` mutates `&Check` to 0 when the bias is well-conditioned (no limiting); `Check` stays 1 iff a pnjlim call actually limited. In digiTS, the current `let icheckLimited = true;` plus conditional `if (limited) icheckLimited = true;` never clears the flag when pnjlim returns `limited===false`. Invert the invariant: init to `false`, set `true` iff any limiting call reports `limited===true`. The outer noncon gate at line 1629 then fires iff some limiting occurred AND the mode gate permits.
- **Files to modify**:
  - `src/components/semiconductors/mosfet.ts::createMosfetElement::load()`:
    - Change `let icheckLimited = true;` (line 1006) to `let icheckLimited = false;`.
    - For each `pnjlim` call site (BS at line 1161, BD at line 1179), replace `if (vbsResult.limited) icheckLimited = true;` with `icheckLimited = icheckLimited || vbsResult.limited;` (equivalent in effect but more explicit about the invariant).
    - For `fetlim`/`limvds` calls: ngspice's `DEVfetlim` / `DEVlimvds` do not mutate `Check` — only `DEVpnjlim` does (cite `devsup.c:50-58` for pnjlim; `devsup.c:20-40` for limvds; `devsup.c:88-118` for fetlim). Keep `fetlim`/`limvds` not contributing to `icheckLimited`.
    - Remove the `else { icheckLimited = false; }` at lines 1194-1196 (already removed by Task 6.2.1).
    - Keep `icheckLimited = false;` at line 1216 (MODEINITJCT / default-zero path) — these modes do not call pnjlim, so `icheckLimited` stays false.
    - Noncon gate at line 1629 unchanged — matches `mos1load.c:737-743`.
- **Tests**:
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-6::no pnjlim limit → icheckLimited stays false` — construct NMOS at moderate bias where no pnjlim call limits, run `load()`, assert `ctx.noncon.value === 0`.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-6::pnjlim limit → noncon increments` — construct NMOS at a bias where the pnjlim Gillespie branch fires (e.g. vbs jumps from 0 → +1.5 in one NR step, triggering limiting), run `load()`, assert `ctx.noncon.value === 1`.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-6::OFF=1 + MODEINITFIX suppresses noncon even on limit` — construct NMOS with OFF=1, mode = MODEINITFIX, force pnjlim to limit, assert `ctx.noncon.value === 0` (mos1load.c:737-743 gate).
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-6::MODEINITJCT path does not touch noncon` — mode = MODEINITJCT, assert `ctx.noncon.value === 0` regardless of state0 content.
- **Acceptance criteria**:
  - `icheckLimited` initialised `false`; set `true` only by pnjlim.limited==true.
  - `ctx.noncon.value` increments exactly when `(icheckLimited === true) && (params.OFF === 0 || !(mode & (MODEINITFIX | MODEINITSMSIG)))` — matches `mos1load.c:737-743`.
  - All tests pass.

### Task 6.2.7: M-7 — qgs/qgd/qgb xfact extrapolation

- **Description**: `mos1load.c:828-836` extrapolates the Meyer charges `qgs/qgd/qgb` using `(1+xfact)*state1 - xfact*state2` where `xfact = CKTdelta/CKTdeltaOld[1]` is computed once in the predictor branch at `mos1load.c:210`. Current digiTS code at lines 1439-1444 writes `s0 = s1` (implicit xfact=0). Replace with the full ngspice formula.
- **Files to modify**:
  - `src/components/semiconductors/mosfet.ts::createMosfetElement::load()`:
    - In the voltage-predictor branch at lines 1051-1064, the existing local `xfact = ctx.deltaOld[1] > 0 ? ctx.delta / ctx.deltaOld[1] : 0` is computed inside that block scope. Hoist it to a higher scope (or recompute) so it is visible to the charge-predictor branch at line 1439.
    - Replace the current charge predictor at lines 1439-1444 with:
      ```ts
      if (mode & (MODEINITPRED | MODEINITTRAN)) {
        const xfactQ = ctx.deltaOld[1] > 0 ? ctx.delta / ctx.deltaOld[1] : 0;
        s0[base + SLOT_QGS] = (1 + xfactQ) * s1[base + SLOT_QGS] - xfactQ * s2[base + SLOT_QGS];
        s0[base + SLOT_QGD] = (1 + xfactQ) * s1[base + SLOT_QGD] - xfactQ * s2[base + SLOT_QGD];
        s0[base + SLOT_QGB] = (1 + xfactQ) * s1[base + SLOT_QGB] - xfactQ * s2[base + SLOT_QGB];
      }
      ```
      Do NOT use `ctx.xfact` — compute locally to match `mos1load.c` verbatim and avoid coupling to upstream `xfact` bookkeeping.
    - Update the outdated comment "PREDICTOR #undef default uses xfact=0 → q0 = q1" to cite `mos1load.c:828-836`.
- **Tests**:
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-7::qgs extrapolation uses xfact` — seed `s1[SLOT_QGS] = 3e-12, s2[SLOT_QGS] = 2e-12`, `ctx.delta = 1e-9`, `ctx.deltaOld = [0, 2e-9, 0, 0, 0, 0, 0]` (so xfact = 0.5). Run `load()` under `mode = MODEINITPRED | MODETRAN` with non-zero Meyer caps. Assert `s0[SLOT_QGS] === (1 + 0.5) * 3e-12 - 0.5 * 2e-12 === 3.5e-12` (bit-exact).
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-7::qgd extrapolation` — same shape for QGD.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-7::qgb extrapolation` — same shape for QGB.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-7::xfact=0 when deltaOld[1]=0` — `ctx.deltaOld = [0,0,0,0,0,0,0]`, assert `s0[SLOT_QGS] === s1[SLOT_QGS]` (fallback to q0=q1).
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-7::voltage predictor shares xfact formula` — assert that at the same `ctx.delta / ctx.deltaOld[1]` ratio, the voltage predictor (line 1059) and charge predictor (line 1441) produce values derived from the same `xfact` scalar.
- **Acceptance criteria**:
  - Charge predictor uses `(1+xfact)*state1 - xfact*state2` with `xfact = ctx.delta / ctx.deltaOld[1]` (guarded), matching `mos1load.c:828-836`.
  - Voltage predictor and charge predictor use the same `xfact` formula (computed locally at each site or hoisted).
  - `ctx.xfact` is NOT read in MOSFET `load()` — all xfact usage is local `ctx.delta / ctx.deltaOld[1]`.
  - All tests pass.

### Task 6.2.8: M-8 — `von` polarity-convention comment

- **Description**: Document the `von = tVbi*polarity + GAMMA*sarg` sign convention inline. No behaviour change.
- **Files to modify**:
  - `src/components/semiconductors/mosfet.ts` — above the `const von = tp.tVbi * polarity + params.GAMMA * sarg;` line (line 1258 current), add a comment block:
    ```
    // mos1load.c:507: von = tVbi * MOS1type + gamma * sarg.
    // tVbi is stored polarity-unsigned in mos1temp.c (vtbi = VTO - polarity * gamma*sqrt(PHI) + ...),
    // so multiplying by polarity here applies the type sign at the evaluation site.
    // For NMOS (polarity=+1): von > 0, threshold above source. For PMOS (polarity=-1): von < 0.
    // Downstream `vgst = (mode==1 ? vgs : vgd) - von` then carries the correct sign.
    ```
- **Tests**: none (comment-only change).
- **Acceptance criteria**:
  - Comment block present above the `von = ...` line citing `mos1load.c:507`.
  - No code change.

### Task 6.2.9: M-9 — Per-instance TEMP parameter

- **Description**: Close the architectural gap in MOSFET temperature handling. `mos1load.c:107` uses `vt = CONSTKoverQ * MOS1temp` where `MOS1temp` is the per-instance temperature (defaults to `CKTtemp`, overridable per instance via `.MODEL ... TEMP=` or `.TEMP` statement). Current digiTS hard-codes `REFTEMP` in `computeTempParams` and reads `ctx.vt` in `load()` — neither is per-instance-configurable. Add a first-class `TEMP` param.
- **Files to modify**:
  - `src/components/semiconductors/mosfet.ts`:
    - Add `TEMP: number` to `MosfetParams` and `ResolvedMosfetParams` (default `REFTEMP` = 300.15 K).
    - Add `TEMP: { default: REFTEMP, unit: "K", description: "Per-instance operating temperature" }` to both `MOSFET_NMOS_PARAM_DEFS` and `MOSFET_PMOS_PARAM_DEFS` under `secondary`.
    - Thread `TEMP` through `resolveParams` (preserve default when unset).
    - Rewrite `computeTempParams` signature to accept `TEMP` as the per-instance operating temperature. Inside, replace every `REFTEMP` used for instance-level calculations with `p.TEMP`:
      - `vt = p.TEMP * KoverQ` (was `REFTEMP * KoverQ`)
      - `ratio = p.TEMP / p.TNOM` (was `REFTEMP / p.TNOM`)
      - `fact2 = p.TEMP / p.TNOM` (was `1`; now reflects `p.TEMP / p.TNOM`)
      - `kt = p.TEMP * CONSTboltz` (was `REFTEMP * CONSTboltz`)
      - `egfet = 1.16 - (7.02e-4 * p.TEMP * p.TEMP) / (p.TEMP + 1108)` (was `REFTEMP` form)
      - `arg = -egfet / (kt + kt) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP))` — leave the `1.1150877 / (CONSTboltz * 2*REFTEMP)` constant alone per `mos1temp.c:45-51` (model-level egnom at REFTEMP).
      - `pbfact = -2 * vt * (1.5 * Math.log(fact2) + Q * arg)` — now correctly uses non-unit `fact2`.
      - All `capfact` recomputes referencing `REFTEMP - REFTEMP` now become `p.TEMP - REFTEMP` where appropriate per `mos1temp.c:190-200`.
    - Add a `vt: number` field to `MosfetTempParams` = `p.TEMP * KoverQ`.
    - In `load()`, replace `const vt = ctx.vt;` (line 1016) with `const vt = tp.vt;`.
    - `setParam('TEMP', ...)` already triggers `computeTempParams` recompute via generic branch at line 1718 — no additional wiring needed; verify via test.
  - `src/core/model-params.ts` — no change expected, but verify `defineModelParams` supports adding `TEMP` as a runtime-mutable param (sanity check on plumbing).
- **Tests**:
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-9::TEMP default is 300.15 K` — construct NMOS without TEMP override, assert `createMosfetElement(...)._p.TEMP === 300.15`.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-9::tp.vt reflects TEMP` — construct NMOS with TEMP=400, assert `tp.vt` approximately equals `400 * KoverQ` (= `400 * 1.3806226e-23 / 1.6021918e-19` ≈ 0.03447 V).
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-9::load uses tp.vt not ctx.vt` — construct NMOS with `TEMP=400`, set `ctx.vt = 300 * KoverQ` (mismatching); run at a bias where the bulk-junction current depends on vt (e.g. `vbs = 0.5`, forward-biased); assert the resulting `s0[SLOT_CBS]` uses `vt(400 K)` not `vt(300 K)`.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-9::setParam('TEMP') recomputes tp` — construct NMOS, capture `tp.vt`, call `element.setParam('TEMP', 400)`, assert the new `_p.TEMP === 400` and the next `load()` call uses `vt(400)`.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-9::tTransconductance scales with TEMP` — construct NMOS with `KP=1e-4, TNOM=300.15`, then at `TEMP=300.15`, `tp.tTransconductance === KP`; at `TEMP=600.3`, `tp.tTransconductance === KP / (2 * sqrt(2))` (ratio4 = 2*sqrt(2)).
- **Acceptance criteria**:
  - `TEMP` param is a first-class primary/secondary model param on both NMOS and PMOS defs, default 300.15 K.
  - `mosfet.ts::load()` does not read `ctx.vt`.
  - `computeTempParams` uses `p.TEMP` everywhere the old code used `REFTEMP` for instance-level calculations. Model-level nominal-temp calcs (pbfact1, fact1, egfet1, vtnom) stay pegged to `p.TNOM`.
  - `setParam('TEMP', newT)` causes the next `load()` to use `newT`-derived `vt`, `tTransconductance`, `tPhi`, `tVbi`, `tVto`, `tBulkPot`, `tDepCap`, `tSatCur`, `tSatCurDens`, `drainVcrit`, `sourceVcrit`, and the f2/f3/f4 cap coefficients.
  - All tests pass.

### Task 6.2.10: M-12 — Verify MODEINITFIX+OFF → zero voltages

- **Description**: Phase 2.5 structure already routes `MODEINITFIX && OFF===1` through the `else` branch at line 1210 which zeros `vbs/vgs/vds`. Verify by test and add a citation comment.
- **Files to modify**:
  - `src/components/semiconductors/mosfet.ts` — add a citation comment above line 1210 (the default-zero branch):
    ```
    // mos1load.c:431-433 — default-zero path: (MODEINITFIX && OFF) OR the
    // "not one of the simple cases" fallthrough. simpleGate at line 1036
    // excludes (MODEINITFIX && OFF) from the simple/general block, so control
    // lands here. Matches mos1load.c:204 which gates on `!MOS1off` for INITFIX.
    ```
- **Tests**:
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-12::INITFIX + OFF=1 zeros voltages` — construct NMOS with OFF=1, mode = MODEINITFIX, call `load()`, assert `s0[SLOT_VBS] === 0, s0[SLOT_VGS] === 0, s0[SLOT_VDS] === 0, s0[SLOT_VBD] === 0` after the call.
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-12::INITFIX + OFF=0 routes through simpleGate` — construct NMOS with OFF=0, mode = MODEINITFIX, set `ctx.rhsOld` so nodes carry non-zero voltages; call `load()`; assert `s0[SLOT_VBS]` reflects `ctx.rhsOld`-derived value (i.e. general iteration ran).
- **Acceptance criteria**:
  - Comment block present citing `mos1load.c:204, 431-433`.
  - Both test cases pass.

### Task 6.2.11: Verify bulk-cap companion zero fix (#32)

- **Description**: Post-A1 there are no `SLOT_CCAP_DB` / `SLOT_CCAP_SB` slots to zero — those were deleted by A1. Confirm: (a) the bulk-junction NIintegrate at lines 1338-1391 has no stray zeroing, (b) Meyer gate-cap zeroing at lines 1460-1465 fires only on `MODEINITTRAN || !MODETRAN`, matching `mos1load.c:862-866`.
- **Files to modify**: none (verify only).
- **Tests**:
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET companion-zero::MODEINITTRAN zeros gate-cap companions` — seed `s0[SLOT_CQGS]=1.0, s0[SLOT_CQGD]=2.0, s0[SLOT_CQGB]=3.0` pre-call; run under `mode = MODETRAN | MODEINITTRAN`; assert the `gcgs/gcgd/gcgb` stamped to the Y matrix are ZERO (initOrNoTran branch: line 1461-1465 zeroes them).
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET companion-zero::MODETRAN (no INITTRAN) integrates gate-caps` — same seed, mode = MODETRAN only; assert `gcgs = ag[0] * capgs` stamped (integrate branch fired).
  - `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET companion-zero::MODEINITTRAN does NOT zero bulk-junction integrator slots` — seed `s0[SLOT_CQBD]=5.0, s0[SLOT_CQBS]=7.0` pre-call, run under `mode = MODETRAN | MODEINITTRAN` with `MODEUIC=0`, assert `s0[SLOT_CQBD]` and `s0[SLOT_CQBS]` reflect the NIintegrate output (overwritten with fresh values, not forced to 0 by a blanket zero step).
- **Acceptance criteria**:
  - Meyer gate-cap companions zero iff `(mode & MODEINITTRAN) !== 0 || (mode & MODETRAN) === 0`.
  - Bulk-junction integrator slots not blanket-zeroed; they are overwritten by the NIintegrate output when the gate fires.
  - All tests pass.

---

## Wave 6.3: Verification

### Task 6.3.1: PMOS `tVbi` sign audit (#25)

- **Description**: Verify PMOS-with-GAMMA-nonzero `tVbi` output against ngspice via the instrumented comparison harness. The suspicion from legacy fix #25 is that digiTS's `|VTO|` vs ngspice's signed `VTO` in the `tVbi` formula causes divergence; G1 (Phase 2.5 sign-convention flip) may have closed it, but needs evidence.
- **Files to modify**: the harness driver / fixture files under `src/solver/analog/__tests__/harness/` to add a PMOS-GAMMA test circuit if not already present.
- **Tests**:
  - `src/solver/analog/__tests__/harness/tVbi-pmos.test.ts` (new) — construct a PMOS instance with `VTO=-1.0, GAMMA=0.5, PHI=0.6, TEMP=300.15, TNOM=300.15`. Run `computeTempParams` on digiTS and run the ngspice counterpart via the harness. Compare `tVbi` scalar bit-exact.
  - If divergent: the test fails with full output showing ngspice `tVbi` vs digiTS `tVbi` and the signed VTO trace.
- **Acceptance criteria**:
  - Test file exists and runs.
  - If PMOS `tVbi` is bit-identical to ngspice: test passes; file an "audit clean" line in the phase commit message.
  - If divergent: test fails loudly. Do NOT self-correct; escalate with a report containing (a) ngspice `bjtload.c`- or `mos1temp.c`- equivalent formula, (b) digiTS `computeTempParams::tVbi` line, (c) the exact scalar difference, (d) the proposed fix for user review. Per `spec/architectural-alignment.md §0`, agents do not add items; escalation is a user-action prompt.

---

## Commit structure

One commit per wave:
- `Phase 6.1 — MOSFET infrastructure + primeJunctions deletion`
- `Phase 6.2 — MOSFET correctness (M-1..M-12) + per-instance TEMP`
- `Phase 6.3 — PMOS tVbi verification`

## Targeted test command

Per the plan's Appendix A operational rules, Phase 6 agents run only:

```
npx vitest run src/components/semiconductors/__tests__/mosfet.test.ts
npx vitest run src/solver/analog/__tests__/harness/tVbi-pmos.test.ts
```

No full-suite run until Phase 9.1.3.
