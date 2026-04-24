# Phase 7.5: F-RESIDUAL — Remaining Temp-Dependent Devices + primeJunctions Cleanup

**Date:** 2026-04-24
**Status:** W5 deliverable. Authored post-A1, against the unified `load(ctx: LoadContext): void` architecture. Depends on Phase 4 (shared limiting primitives landed). Runs in parallel with Phase 5 (BJT), Phase 6 (MOSFET), Phase 7 (JFET) — disjoint files.
**Inputs:** `spec/plan.md` §Phase 7.5; `spec/architectural-alignment.md` A1/D4/H1/I1/I2; `ref/ngspice/src/spicelib/devices/dio/dioload.c`, `diotemp.c`.

---

## Overview

Propagate two cross-phase findings from Phases 6 and 7 into every other semiconductor that still exposes the legacy patterns:

1. **Per-instance TEMP override.** ngspice reads per-instance `{DEVICE}temp` (default = `CKTtemp`, overridable via `.MODEL TEMP=` or `.TEMP`). digiTS currently hardcodes `REFTEMP` / `circuitTemp = REFTEMP` inside the temp-param computation of every non-MOSFET temp-dependent device. Phase 6 closed this for MOSFET (Task 6.2.9 / M-9); Phase 5 Wave 5.3 closed it for BJT; Phase 7 Wave 7.2 closed it for JFET. Phase 7.5 closes it for diode, zener, LED, tunnel-diode — every remaining temp-dependent semiconductor.
2. **Delete `primeJunctions()` + `primedFromJct` one-shot seed path.** ngspice has no pre-NR priming method — MODEINITJCT priming lives inside `{DEVICE}load.c` as a 3-branch priority at the top of the voltage dispatch. Phase 7 deleted this for NJFET + PJFET; Phase 6 deleted it for MOSFET (Task 6.1.4). Phase 7.5 closes the remaining implementers (zener, SCR) and tears out the call site and interface member.

Every task operates inside the unified `load()` method of the target device. Cross-method transfer slots remain deleted per §A1.

## What "matches ngspice" means in this phase

Applies to every task and every code comment bearing a `// cite:` reference. Identical to Phase 5's rules; reproduced here verbatim for single-read accessibility.

| Acceptable | Not acceptable |
|---|---|
| **Exact numerical equivalence.** Every arithmetic operation, branch condition, and order of operations matches the cited ngspice function bit-for-bit. | **Algorithmic reshaping** — pulling loop invariants, combining sub-expressions, reordering commutatively-equivalent operations. |
| **Variable renames.** `JFETtemp` → `params.TEMP`, `DIOtemp` → `params.TEMP`, `CKTstate0 + DIOvd` → `s0[base + SLOT_VD]`. | **Control-flow restructuring** — `goto load` → early return + flag; MODEINITJCT 3-branch priority collapsed into a ternary chain. |
| **Structural adaptations for digiTS's data model**, each paired with an `architectural-alignment.md` reference. | **"Pragmatic" / "minimal" / "simpler" versions of ngspice code.** |

**If a task cannot be implemented without a deviation in the "not acceptable" column:** STOP and escalate.

---

## Wave 7.5.1: Diode per-instance TEMP

All edits inside `createDiodeElement::load()` and `computeDiodeTempParams` in `src/components/semiconductors/diode.ts`.

### Task 7.5.1.1: Add TEMP to DIODE param defs

- **Description**: Declare `TEMP` as a first-class per-instance param on both resistive and capacitive diode schemas, default 300.15 K. Add to the shared param defs under `secondary` with description `"Per-instance operating temperature"`, unit `"K"`.
- **Files to modify**:
  - `src/components/semiconductors/diode.ts::DIODE_PARAM_DEFS` (or equivalent) — add `TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature" }` under `secondary`.
- **Tests**:
  - `diode.test.ts::Diode TEMP::TEMP_default_300_15` — after `makeDiodeProps()`, `propsObj.getModelParam<number>("TEMP") === 300.15`.
  - `diode.test.ts::Diode TEMP::paramDefs_include_TEMP` — param def list contains `"TEMP"`.
  - `diode.test.ts::Diode TEMP::setParam_TEMP_no_throw` — `element.setParam("TEMP", 400)` doesn't throw.
- **Acceptance criteria**:
  - `TEMP` declared with rank `secondary`, default `300.15`, unit `"K"`.
  - 3 tests pass.

### Task 7.5.1.2: Thread `TEMP` through `computeDiodeTempParams`

- **Description**: Replace the `T: number = REFTEMP` default at `diode.ts:276` with `T: number` required positional, and pass `params.TEMP` at every call site (currently `diode.ts:442` and any other). Internal algorithm unchanged: `T` already drives `vt`, `fact2`, `egfet`, `arg`, `capfact` numerator. `p.TNOM` continues to drive the model-nominal `vtnom`, `fact1`, `egfet1`, `arg1`, `capfact` denominator — untouched. `1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP))` stays pegged to `REFTEMP` per `diotemp.c:66-67` (model-level egnom at 300.15 K).
- **Files to modify**:
  - `src/components/semiconductors/diode.ts::computeDiodeTempParams` — drop `T: number = REFTEMP` default, make positional. Add `TEMP: number` to the input-shape type on the `p` parameter.
  - `createDiodeElement` `params` factory — add `TEMP: props.getModelParam<number>("TEMP")` to the resolved params object.
  - Every call site of `computeDiodeTempParams` (diode.ts:442 and any other) — pass `params.TEMP` as the `T` arg.
- **Tests**:
  - `diode.test.ts::Diode TEMP::tp_vt_reflects_TEMP` — construct diode with `TEMP=400`, assert `tp.vt` approximately equals `400 * KoverQ`.
  - `diode.test.ts::Diode TEMP::tSatCur_scales_with_TEMP` — construct diode with `IS=1e-14, XTI=3, TNOM=300.15`, build at `TEMP=300.15` and `TEMP=400`, assert `tp.tSatCur(400) > tp.tSatCur(300.15)`.
  - `diode.test.ts::Diode TEMP::TNOM_stays_nominal_refs` — with `TEMP=400, TNOM=300.15`, assert `tp.vtnom` uses `TNOM`, not `TEMP`.
- **Acceptance criteria**:
  - `computeDiodeTempParams` no longer has a defaulted `T` arg.
  - Every caller passes `params.TEMP`.
  - 3 tests pass.

### Task 7.5.1.3: `setParam('TEMP', …)` recomputes `tp`

- **Description**: Verify `setParam('TEMP', newT)` triggers `computeDiodeTempParams` recompute so the next `load()` reflects the new temperature. If not wired via the existing generic setParam branch, wire explicitly.
- **Files to modify**:
  - `src/components/semiconductors/diode.ts::createDiodeElement::setParam` — ensure TEMP routes through the tp-recompute pathway.
- **Tests**:
  - `diode.test.ts::Diode TEMP::setParam_TEMP_recomputes_tp` — capture `tp.vt` at default, call `setParam("TEMP", 400)`, invoke one `load()` iteration at a forward-biased step that triggers pnjlim, assert `s0[SLOT_VD]` post-limit matches 400K pnjlim output.
- **Acceptance criteria**:
  - `setParam('TEMP', newT)` causes next `load()` to use `vt` derived from `newT`.
  - 1 test passes.

---

## Wave 7.5.2: Zener per-instance TEMP + primeJunctions deletion

All edits in `src/components/semiconductors/zener.ts`.

### Task 7.5.2.1: Add TEMP param + thread into `computeTempParams`

- **Description**: Add `TEMP` param (default 300.15 K), replace the hardcoded `circuitTemp = REFTEMP` at line 177 with `circuitTemp = params.TEMP`. `dt = circuitTemp - params.TNOM` at line 178 is already correct once the substitution is made. `vt = (CONSTboltz * circuitTemp) / CHARGE` at line 179 automatically scales.
- **Files to modify**:
  - `src/components/semiconductors/zener.ts::ZENER_PARAM_DEFS` — add `TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature" }` under `secondary`.
  - `createZenerElement` `params` factory — add `TEMP: props.getModelParam<number>("TEMP")`.
  - `zener.ts:177` — replace `const circuitTemp = REFTEMP;` with `const circuitTemp = params.TEMP;` and add citation `// cite: dioload.c / diotemp.c — per-instance TEMP (maps to ngspice DIOtemp)`.
  - Wire `setParam('TEMP', …)` to recompute `tp`.
- **Tests**:
  - `zener.test.ts::Zener TEMP::TEMP_default_300_15` — after construction, `propsObj.getModelParam<number>("TEMP") === 300.15`.
  - `zener.test.ts::Zener TEMP::vt_reflects_TEMP` — construct zener with `TEMP=400`, assert the computed `vt` approximately equals `400 * KoverQ`.
  - `zener.test.ts::Zener TEMP::setParam_TEMP_recomputes` — setParam('TEMP', 400), run `load()` at a reverse breakdown step, assert the breakdown current reflects 400K thermal voltage in the `vtebrk = params.NBV * vt` expression at line 535.
- **Acceptance criteria**:
  - `TEMP` declared; `circuitTemp` derived from `params.TEMP`.
  - 3 tests pass.

### Task 7.5.2.2: Delete `primeJunctions()` + move priming into `load()`

- **Description**: Zener's current `primeJunctions()` at line 426 writes `pool.states[0][base + SLOT_VD] = tVcrit;` — a single line executing before the first NR iteration. ngspice equivalent in `dioload.c:135-136` runs this priming inside `load()` under the MODEINITJCT branch. Move the priming into the existing MODEINITJCT branch in zener `load()` (if one exists) or add one following the dioload.c pattern. Then delete `primeJunctions()`.
- **Files to modify**:
  - `src/components/semiconductors/zener.ts::createZenerElement::load()` — ensure MODEINITJCT branch is present and writes `s0[base + SLOT_VD] = tVcrit;` when `params.OFF === 0`, or `s0[base + SLOT_VD] = 0;` when `params.OFF === 1`. Cite `dioload.c:130-138`.
  - Delete the `primeJunctions(): void { ... }` method at `zener.ts:426-429`.
- **Tests**:
  - `zener.test.ts::Zener primeJunctions::method_absent` — after construction, `element.primeJunctions === undefined`.
  - `zener.test.ts::Zener primeJunctions::MODEINITJCT_seeds_tVcrit` — invoke `load()` under `mode = MODEDCOP | MODEINITJCT` with `OFF=0`, assert `s0[SLOT_VD] === tVcrit` after the call.
  - `zener.test.ts::Zener primeJunctions::MODEINITJCT_OFF_zeros_vd` — same with `OFF=1`, assert `s0[SLOT_VD] === 0`.
- **Acceptance criteria**:
  - `zener.ts` grep for `primeJunctions` returns zero hits.
  - MODEINITJCT branch in `load()` seeds `SLOT_VD` per dioload.c:130-138.
  - 3 tests pass.

---

## Wave 7.5.3: LED per-instance TEMP

All edits in `src/components/io/led.ts`.

### Task 7.5.3.1: Add TEMP param + replace hardcoded LED_VT

- **Description**: LED currently imports a hardcoded `VT as LED_VT` from `src/core/constants.ts` (line 37). The `LED_VT` constant pins the thermal voltage at `kT/q` for `T = REFTEMP`. Replace with a per-instance TEMP-derived `vt` computed inside the factory and made available to `load()` through the element's private state (closure local or `tp.vt`).
- **Files to modify**:
  - `src/components/io/led.ts` — add `TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature" }` to LED param defs under `secondary`.
  - Add `TEMP: props.getModelParam<number>("TEMP")` to the resolved params object.
  - Compute `const vt = params.TEMP * CONSTboltz / CHARGE;` in the factory or inside a `computeLedTempParams` helper; store on a closure-local `ledTp` object accessible to `load()`.
  - Replace all `LED_VT` reads inside `load()` with the new `ledTp.vt` (or closure local).
  - Remove the `VT as LED_VT` import at line 37 if no other reads remain.
  - Wire `setParam('TEMP', …)` to recompute the closure-local `vt`.
- **Tests**:
  - `led.test.ts::LED TEMP::TEMP_default_300_15` — after construction, `propsObj.getModelParam<number>("TEMP") === 300.15`.
  - `led.test.ts::LED TEMP::vt_reflects_TEMP` — construct LED with `TEMP=400`, assert the thermal-voltage read by `load()` equals `400 * KoverQ`. Probe: run a forward-biased step, observe that the exponential current scale matches `exp(vd / (N * vt(400K)))`.
  - `led.test.ts::LED TEMP::setParam_TEMP_recomputes` — setParam('TEMP', 400), run `load()`, assert `vt` is recomputed.
- **Acceptance criteria**:
  - `led.ts` grep for `LED_VT` returns zero hits.
  - Thermal voltage derived from `params.TEMP`.
  - 3 tests pass.

---

## Wave 7.5.4: SCR per-instance TEMP + primeJunctions deletion

All edits in `src/components/semiconductors/scr.ts`.

### Task 7.5.4.1: Add TEMP param + thread into thermal-voltage sites

- **Description**: SCR uses pnjlim internally on its gate-cathode and anode-cathode junctions. Currently no `TEMP` param; thermal voltage sourced from internal constants or `ctx.vt`. Add a TEMP param and ensure every pnjlim / exponential site inside SCR `load()` reads `tp.vt` derived from `params.TEMP`.
- **Files to modify**:
  - `src/components/semiconductors/scr.ts` — add `TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature" }` to SCR param defs under `secondary`.
  - Thread `TEMP` into any internal temp-param structure (if SCR has a `computeScrTempParams` equivalent, add it; if not, add one that produces `{ vt, vcrit, ... }` from `params.TEMP`).
  - Replace every `ctx.vt` read inside SCR `load()` with the local-scope `tp.vt` or equivalent.
  - Wire `setParam('TEMP', …)` to recompute.
- **Tests**:
  - `scr.test.ts::SCR TEMP::TEMP_default_300_15` — after construction, `propsObj.getModelParam<number>("TEMP") === 300.15`.
  - `scr.test.ts::SCR TEMP::vt_reflects_TEMP` — construct SCR with `TEMP=400`, invoke `load()` at a forward-biased gate step that triggers pnjlim, assert pnjlim's vt argument equals `400 * KoverQ`.
  - `scr.test.ts::SCR TEMP::setParam_TEMP_recomputes` — setParam('TEMP', 400), run `load()`, assert new vt used.
  - `scr.test.ts::SCR TEMP::no_ctx_vt_read` — test-time `fs.readFileSync` on `scr.ts`; assert `"ctx.vt"` appears zero times.
- **Acceptance criteria**:
  - `TEMP` declared; every pnjlim / exponential in SCR load() reads `tp.vt` derived from `params.TEMP`.
  - 4 tests pass.

### Task 7.5.4.2: Delete `primeJunctions()` + `primedVak` / `primedVgk` + consume-seed branch

- **Description**: SCR's `primeJunctions()` at line 378 seeds closure-local variables `primedVak` and `primedVgk` (a different pattern from MOSFET/JFET's slot-state seeding). The load()-start branch that consumes these primed values must be located and deleted, and the priming logic moved into an MODEINITJCT branch inside `load()` itself.
- **Files to modify**:
  - `src/components/semiconductors/scr.ts`:
    - Locate the closure vars `let primedVak: number | null = null;` and `let primedVgk: number | null = null;` (around lines 147-148) and delete.
    - Delete the consume branch at the top of `load()` that reads `primedVak` / `primedVgk` into voltage locals and resets them to `null`.
    - Delete the `primeJunctions(): void { ... }` method at line 378.
    - Inside `load()`, add a MODEINITJCT branch that seeds the anode-cathode voltage to `tp.tVcrit` (anode-cathode) and gate voltage to `0`, mirroring ngspice's dioload.c:130-138 pattern for the anode-cathode junction; gate seeds to 0. Cite `dioload.c:130-138` for the anode-cathode branch.
  - The SCR state pool layout determines the slot names; verify and write to the correct slots (likely `SLOT_VAK` / `SLOT_VGK` or equivalent).
- **Tests**:
  - `scr.test.ts::SCR primeJunctions::method_absent` — after construction, `element.primeJunctions === undefined`.
  - `scr.test.ts::SCR primeJunctions::MODEINITJCT_seeds_vak_vcrit` — invoke `load()` under `mode = MODEDCOP | MODEINITJCT` with `OFF=0`, assert `s0[SLOT_VAK] === tp.tVcrit` and `s0[SLOT_VGK] === 0`.
  - `scr.test.ts::SCR primeJunctions::MODEINITJCT_OFF_zeros_both` — same with `OFF=1`, assert both are 0.
- **Acceptance criteria**:
  - `scr.ts` grep for `primeJunctions`, `primedVak`, `primedVgk` returns zero hits.
  - MODEINITJCT branch seeds anode-cathode and gate voltages per the dioload.c pattern.
  - 3 tests pass.

---

## Wave 7.5.5: Tunnel-diode per-instance TEMP

All edits in `src/components/semiconductors/tunnel-diode.ts`.

### Task 7.5.5.1: Add TEMP param + replace hardcoded VT

- **Description**: Tunnel-diode imports a hardcoded `VT` from `src/core/constants.ts` (line 57 of tunnel-diode.ts references it in the header comment). Replace with per-instance `TEMP`-derived `vt` in the factory. Same pattern as LED (Wave 7.5.3).
- **Files to modify**:
  - `src/components/semiconductors/tunnel-diode.ts` — add `TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature" }` to tunnel-diode param defs under `secondary`.
  - Add `TEMP: props.getModelParam<number>("TEMP")` to the resolved params object.
  - Compute `const vt = params.TEMP * CONSTboltz / CHARGE;` in the factory; store on a closure-local or `tp.vt`.
  - Replace all `VT` reads inside `load()` with the local-scope `vt`.
  - Remove the `VT` import if no other reads remain.
  - Wire `setParam('TEMP', …)` to recompute.
- **Tests**:
  - `tunnel-diode.test.ts::TunnelDiode TEMP::TEMP_default_300_15` — after construction, `propsObj.getModelParam<number>("TEMP") === 300.15`.
  - `tunnel-diode.test.ts::TunnelDiode TEMP::vt_reflects_TEMP` — construct with `TEMP=400`, invoke `load()` at a forward-biased step, assert the thermal-current scale matches `exp(v / (N * 400K_vt))`.
  - `tunnel-diode.test.ts::TunnelDiode TEMP::setParam_TEMP_recomputes` — setParam('TEMP', 400), run `load()`, assert `vt` is recomputed.
- **Acceptance criteria**:
  - `tunnel-diode.ts` grep for direct imports of hardcoded `VT` returns zero hits.
  - Thermal voltage derived from `params.TEMP`.
  - 3 tests pass.

---

## Wave 7.5.6: Delete `primeJunctions` call site + interface member

**Precondition:** Phase 6 Task 6.1.4 (MOSFET primeJunctions deletion), Phase 7 Wave 7.1 Task 7.1.4 (JFET primeJunctions deletion), and Phase 7.5 Waves 7.5.2 (zener) and 7.5.4 (SCR) have all landed. At this point no device exposes `primeJunctions()`, so the call site and interface member are dead weight.

### Task 7.5.6.1: Delete the dc-operating-point call site

- **Description**: Delete the optional-chain invocation at `src/solver/analog/dc-operating-point.ts:322-325`:
  ```ts
  for (const el of elements) {
    if (el.isNonlinear && el.primeJunctions) {
      el.primeJunctions();
    }
  }
  ```
  The loop is dead code — no element exposes `primeJunctions` after Waves 7.5.2 and 7.5.4 land. ngspice's equivalent primitive is in-`load()` MODEINITJCT priming, which every remaining device now implements.
- **Files to modify**:
  - `src/solver/analog/dc-operating-point.ts` — delete lines 322-325 (the for-loop and the optional-chain guard). Any enclosing block that becomes empty after deletion is also removed.
- **Tests**:
  - `dcop-init-jct.test.ts` — existing tests in this file that assert priming behavior should continue to pass because every device now primes inside its own `load()` under MODEINITJCT. If any test explicitly references a `primeJunctions` call, rewrite the test to observe the in-`load()` state write.
- **Acceptance criteria**:
  - `dc-operating-point.ts` grep for `primeJunctions` returns zero hits.
  - `dcop-init-jct.test.ts` passes.

### Task 7.5.6.2: Delete the `primeJunctions?` interface member

- **Description**: Delete the `primeJunctions?(): void;` optional interface member from `src/core/analog-types.ts:219` and `src/solver/analog/element.ts:120` (or wherever the interface is declared).
- **Files to modify**:
  - `src/core/analog-types.ts:219` — delete the `primeJunctions?(): void;` line and any comment block describing it.
  - `src/solver/analog/element.ts:120` — same.
- **Tests**:
  - Compile check: `npm run build` succeeds with zero TypeScript errors. No device implementation references the interface member; no caller references the interface member.
- **Acceptance criteria**:
  - `src/core/analog-types.ts` grep for `primeJunctions` returns zero hits.
  - `src/solver/analog/element.ts` grep for `primeJunctions` returns zero hits.
  - `src/` grep for `primeJunctions` returns zero hits outside `spec/` and `ref/ngspice/`.
  - Build passes.

---

## Commit structure

One commit per wave:

- `Phase 7.5.1 — Diode per-instance TEMP`
- `Phase 7.5.2 — Zener TEMP + primeJunctions deletion`
- `Phase 7.5.3 — LED per-instance TEMP`
- `Phase 7.5.4 — SCR TEMP + primeJunctions deletion`
- `Phase 7.5.5 — Tunnel-diode per-instance TEMP`
- `Phase 7.5.6 — Delete primeJunctions call site + interface`

Waves 7.5.1 through 7.5.5 may proceed in parallel (disjoint device files). Wave 7.5.6 is serialised last, with a hard precondition that Phases 6, 7, and Waves 7.5.2 + 7.5.4 have landed.

## Out of scope for Phase 7.5

- **Varactor, schottky, diac, triac, triode** — grep for thermal-voltage references (`vt`, `kt`, `CONSTboltz`, `thermal`, `REFTEMP`, `pnjlim`) returned no matches. These devices are either cap-only (varactor), breakover-based without Shockley equation (diac, triac), or vacuum-tube (triode). They do not carry temperature dependence in the ngspice-equivalent sense, so no TEMP param is needed.
- **Sensor devices (ntc-thermistor, etc.)** — thermistors carry their own temperature physics, not a `.MODEL TEMP=` override pattern. Out of scope for ngspice-alignment work.
- **Behavioural elements** — no ngspice counterpart.
- **Full-suite acceptance** — Phase 9.1.3 runs the full suite after Phase 8 closes.

## Acceptance gate for Phase 7.5

Phase 7.5 is complete when:

1. All tests listed above pass under targeted vitest per-device.
2. `src/` grep for `primeJunctions` returns zero hits outside `spec/` and `ref/ngspice/`.
3. `src/components/` grep for `const temp = REFTEMP` and `const circuitTemp = REFTEMP` each return zero hits — every device's instance temperature is driven by `params.TEMP`.
4. Every semiconductor device (diode, zener, LED, SCR, tunnel-diode) exposes `TEMP` as a secondary param with default 300.15 K.
5. `src/core/analog-types.ts` + `src/solver/analog/element.ts` grep for `primeJunctions` returns zero hits.
6. Build passes with zero TypeScript errors.

Bit-exact per-NR-iteration parity against ngspice for these devices is Phase 10's gate (diode-resistor, diode-bridge, LED in whichever circuits use them). Phase 7.5 establishes structural alignment; Phase 10 measures numerical parity.

## Targeted test command

```
npx vitest run src/components/semiconductors/__tests__/diode.test.ts
npx vitest run src/components/semiconductors/__tests__/zener.test.ts
npx vitest run src/components/io/__tests__/led.test.ts
npx vitest run src/components/semiconductors/__tests__/scr.test.ts
npx vitest run src/components/semiconductors/__tests__/tunnel-diode.test.ts
npx vitest run src/solver/analog/__tests__/dcop-init-jct.test.ts
```

No full-suite run until Phase 9.1.3.
