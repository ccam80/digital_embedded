# Baseline Reality — Post-Papering-Removal Strict Run

**Date:** 2026-04-21
**Commit:** (this commit — see git log for hash after merge)
**Plan:** `spec/parity-forcing-function-plan.md`
**Purpose:** This file is the unfiltered red output from running the ngspice
comparison harness after the papering infrastructure was deleted. It is the
actual starting point for Phase 2 — not what `fix-list-phase-2-audit.md` or
`ngspice-alignment-divergences.md` claim. **Do not reconcile against this
file in this commit; reconciliation is a later step.**

---

## 1. What the papering-removal commit actually changed

| Surface | Before | After |
|---|---|---|
| `harness/types.ts::Tolerance` interface + `DEFAULT_TOLERANCE` const | vAbsTol=1e-6, iAbsTol=1e-12, relTol=1e-3, qAbsTol=1e-14, timeDeltaTol=1e-12 | Deleted entirely |
| `harness/compare.ts::withinTol` helper, `tolerance` param on `compareSnapshots`, `timeMismatched` check, per-slot-type tolerance selection | absTol + relTol * refMag formulas at every diff site | `ours === theirs` at every diff site; `timeMismatched = stepEndTime !== stepEndTime` |
| `harness/compare.ts::findFirstDivergence` threshold default | `1e-3` | `0` |
| `harness/comparison-session.ts::_tol` field, `_slotTol()` helper, `tolerance` getter, `tolerance?` option (ctor + `createSelfCompare`), `makeComparedValue(o,n,absTol,relTol)` 18 call sites, `simpleCompared()` wrapper, `timeDeltaTol` check at line 1225, matrix + RHS `withinTol` tolerance inequalities | The abstraction is gone. `makeComparedValue(ours, ngspice)` returns `withinTol = ours === ngspice`. `simpleCompared` removed; all callers renamed to `makeComparedValue`. Matrix/RHS compare strict equality. |
| `harness/device-mappings.ts` — file shape | 643 lines | 241 lines |
| `slotToNgspice` entries with `null` value | Present across every mapping (diode, BJT, MOSFET, JFET, tunnel-diode, varactor, capacitor, inductor) | Deleted entirely — if a slot has no ngspice correspondence it is simply absent from the map, not silently null |
| `derivedNgspiceSlots` blocks (invented equivalence formulas) | Present: diode `IEQ = ID − GEQ·VD`, tunnel-diode/varactor same formula, BJT `RB_EFF = 1/gx`, BJT `IC_NORTON`/`IB_NORTON`/`IE_NORTON` synthesized from state, MOSFET `VSB = −MOS1vbs` sign-flip, MOSFET `VBD = MOS1vbd`, JFET `VDS = VGS − VGD` | Deleted from every mapping |
| `TUNNEL_DIODE_MAPPING` export | Present, with derived IEQ formula | **Deleted** — ngspice has no tunnel-diode model, comparison was nonsense |
| `VARACTOR_MAPPING` export | Present, with derived IEQ formula | **Deleted** — ngspice's varactor is the diode model, the separate mapping was digiTS-only |
| `DEVICE_MAPPINGS` registry | 8 entries | 6 entries (capacitor, inductor, diode, bjt, mosfet, jfet) |

## 2. What the harness now reports (strict-by-default)

Run: `npm run test:q -- src/solver/analog/__tests__/harness src/solver/analog/__tests__/ngspice-parity`

```
vitest: 247 passed, 9 failed, 11 skipped (5.4s, 28 files)
playwright: skipped
```

`.vitest-failures.json` and `test-results/test-failures.json` hold the raw
details.

### 2.1 The 9 failures — triaged

| # | Test | File | Cause | Classification |
|---|---|---|---|---|
| 1–4 | `transient: CCAP in capacitor and BJT junctions over first steps/retries` / `transient: inductor current divergence over iterations in step 1` / `transient: PNP BJT internal node agreement in step 1` / `8. per-element convergence: our engine reports failures` | runtime failure at `src/solver/analog/fet-base.ts:567` — `MODEINITTRAN is not defined` | In-flight Phase 2 F4 rewrite — a `MODEINITTRAN` reference in `fet-base.ts` is not imported from `ckt-mode.ts`. Pre-existing runtime bug, orthogonal to this commit. | Phase-2 in-flight bug (not mine, not baseline signal) |
| 5 | `DEVICE_MAPPINGS has populated MOSFET mapping` | `harness-integration.test.ts:314` | Asserts `slotToNgspice["GEQ"] === null`. I deleted `null` entries. | **Expected baseline signal — item 3 of checklist** |
| 6 | `DEVICE_MAPPINGS has JFET mapping with correct ngspice offsets` | `harness-integration.test.ts:331` | Asserts `slotToNgspice["CAP_GEQ"] === null`. Same. | **Expected baseline signal — item 3** |
| 7 | `DEVICE_MAPPINGS has tunnel-diode and varactor mappings` | `harness-integration.test.ts:341` | Asserts both mappings are defined. I deleted them. | **Expected baseline signal — item 5** |
| 8 | `10. limiting events: our engine captures events (Item 9)` | `stream-verification.test.ts:230` | `foundWasLimited === false` — devices never push limiting events | Pre-existing (divergence #16 in `ngspice-alignment-divergences.md`; root cause L4 in verification: `cktLoad` never syncs `ctx.loadCtx.limitingCollector`) |
| 9 | `14. limiting comparison: sign is postLimit - preLimit` | `stream-verification.test.ts:331` | Depends on same limiting infrastructure | Pre-existing (divergence #17) |

**Only 3 of the 9 (tests 5–7) are new red signal from this commit.** The
other 6 were already failing before — 4 from the in-flight F4 rewrite's
`MODEINITTRAN` import bug, 2 from long-known limiting-collector wiring.

### 2.2 Tests that exist to verify the papering and are now removed/skipped

`src/solver/analog/__tests__/harness/netlist-generator.test.ts` was edited
to delete three `describe` blocks totalling ~156 lines:

- `BJT_MAPPING.derivedNgspiceSlots` — RB_EFF, IC_NORTON, IB_NORTON, IE_NORTON
- `DIODE_MAPPING.derivedNgspiceSlots` — IEQ, + cross-check against tunnel-diode/varactor
- `JFET_MAPPING.derivedNgspiceSlots` — VDS

These tests exercised the invented equivalence formulas. A `describe.skip`
placeholder remains at the site pointing here.

**Consistency note — read this before any further cleanup:** `netlist-
generator.test.ts` imports of `TUNNEL_DIODE_MAPPING` and `VARACTOR_MAPPING`
were compile-blocking, so touching the file was unavoidable. But the three
describe blocks themselves would have compiled (the mapping objects still
exist) and failed at runtime, exactly like the 3 `harness-integration.test
.ts` failures. I deleted them rather than let them fail at runtime. That
choice under-reports the papering test coverage by ~7 test cases in the 9-
failure count above. If a future commit wants a more complete baseline, it
can restore these blocks and expect them to fail at runtime. The failures
would carry no new information — the 3 `harness-integration` failures
already demonstrate the papering is gone — so restoration is optional.

### 2.3 Pre-existing `tsc --noEmit` errors (unrelated to this commit)

307 TypeScript errors exist in the working tree from the in-flight Phase 2
refactor. Representative categories:

- `Property 'load' is missing in type …` — `AnalogElement` interface drift
- `MODEDCOP` / `MODEINITFLOAT` / `MODEAC` / `MODETRANOP` / `MODEDC` /
  `MODEINITJCT` — missing imports in tests, mid-F4 migration
- `CKTCircuitContext` not assignable to `LoadContext` — type drift between
  the two context surfaces, mid-F3 migration
- `refreshElementRefs` / `initState` / `pinNodeIds` on `AnalogElementCore`
  — interface rename mid-flight
- `_ctxCktMode` declared but never read — cleanup debt
- `_koffi` / `outerEv` / `isLastInStep` unused-declaration warnings

**Verification of this commit's contribution:** `tsc --noEmit` reported 307
errors before any of my edits and 307 errors after. Zero new type errors
from the papering removal. The in-flight Phase 2 errors are not addressed
here.

## 3. What the baseline actually proves

- **Papering removal is type-clean.** The tolerance abstraction, the
  `derivedNgspiceSlots` formulas, and the tunnel-diode/varactor mappings
  could all be deleted without introducing TypeScript regressions in
  anything outside the tests that explicitly asserted the papering.
- **Strict-by-default is runnable.** 247 of 256 harness/parity tests pass
  when every comparison reduces to `ours === ngspice`. The passes include
  self-compare topology tests, netlist-generator structural tests, and
  direct-offset slot correspondence tests (BJT CCAP slots, etc.).
- **The claimed "parity" surface was never very large.** The 3 new failures
  (tests 5–7) and the 7 deleted netlist-generator tests are not numerical
  regressions — they are tests of the papering itself. Removing the
  papering removed the tests that validated the papering. The underlying
  numerical reality (which tests actually compared raw values bit-exactly)
  is largely unchanged because **most existing harness tests never compared
  raw values bit-exactly in the first place.** They compared against
  tolerances that made the comparison trivially pass.

This last point is the most important. Strict-by-default did not turn the
harness into a sea of red because the harness, as written, was mostly
structural and topological. Genuine numerical comparison was confined to a
small number of sites that already had large known divergences
(`stream-verification` limiting tests; mosfet.test.ts `cgs_cgd` regression
outside the harness scope). Rewriting the harness to actually compare raw
values under strict equality is its own separate effort — not part of this
commit.

## 4. Handoff — what the next commits should address

In the order implied by `parity-forcing-function-plan.md` §5:

### Immediate (reconciliation pass)

1. Reconcile `fix-list-phase-2-audit.md` and `audit-papered-divergences.md`
   against this file. Every item in those lists should be re-classified as
   PARITY (bit-exact with ngspice after fix), BLOCKER (architectural, route
   to Track A or B), or OBSOLETE (item was itself papering).
2. The 3 new harness-integration failures are BLOCKERs routed to Track A —
   the underlying items (MOSFET `GEQ`, JFET `CAP_GEQ`, tunnel-diode /
   varactor existence) are architectural, not numerical.
3. The 4 `MODEINITTRAN` failures are a separate in-flight Phase 2 F4
   migration bug — fix in that track, not here.
4. The 2 stream-verification limiting failures are L4 in
   `ngspice-alignment-verification.md` — `cktLoad` never syncs
   `ctx.loadCtx.limitingCollector`. Real numerical + wiring fix.

### Track A — `architectural-alignment.md`

Inventory every structural shape difference between digiTS and ngspice
(state pool vs `CKTstate0`, `_updateOp`/`_stampCompanion` split, class
hierarchy vs procedural load, pivot selection logic, etc.). Each item:
restructure-to-match or explicit user-approved divergence with documented
numerical cost. Close the three new BLOCKERs here.

### Track B — `_updateOp` / `_stampCompanion` collapse

Separate planning track. Generator of the invented-slot problem. Not
bundled into Phase 2.

### Later — expand the harness to truly compare

The "most tests never compared raw values" observation in §3 is its own
follow-up. After Track A decisions land, the harness needs additional
per-NR-iteration raw-value comparison sites (matrix entries, per-slot
state values, limiting events, Norton currents) that will surface actual
numerical divergences. That expansion is independent of this commit.

## 5. Vocabulary ban (still to be committed — plan §3.3)

Not part of this commit. A subsequent commit must add to CLAUDE.md /
executor prompts: the words *mapping*, *tolerance*, *close enough*,
*equivalent to*, *pre-existing* are banned as closing verdicts on ngspice-
comparison work. The rule of thumb (mapping/tolerance ⇒ architectural,
not numerical) gets promoted from retrospective tool to forward-looking
ban. Without this, the forcing function is incomplete and agents will
drift back to the same categories.
