# Group G- Weak Test Enumeration

Source: spec/reviews/phase-2-*.md (all 7 files read and cross-referenced against actual file line numbers via grep).

---

## Category 1: `toBeGreaterThan(0)` / `toBeLessThan` without paired exact `toBeCloseTo` (~17 instances)

| # | File | Line | Test name (describe::it) | Pattern | Required fix |
|---|------|------|--------------------------|---------|--------------|
| G-01 | `src/components/semiconductors/__tests__/jfet.test.ts` | 218 | `NJFET::saturation_current` | `expect(hasSignificantCurrent).toBe(true)`- any nonzero RHS passes | Assert exact Norton Ids stamp at drain/source nodes using toBeCloseTo |
| G-02 | `src/components/semiconductors/__tests__/jfet.test.ts` | 251 | `NJFET::linear_region` | `expect(hasLinearCurrent).toBe(true)`- any nonzero RHS passes | Assert exact Norton current from linear-region formula |
| G-03 | `src/components/semiconductors/__tests__/jfet.test.ts` | 323 | `NJFET::gate_forward_current` | `expect(maxRhs).toBeGreaterThan(1e-9)` | Assert specific Shockley current at gate node |
| G-04 | `src/components/semiconductors/__tests__/jfet.test.ts` | 385 | `PJFET::polarity_inverted` | `expect(nonzeroStamps.length).toBeGreaterThan(0)` + `expect(maxRhs).toBeGreaterThan(1e-10)` | Assert exact P-channel Norton current and conductance stamps |
| G-05 | `src/components/semiconductors/__tests__/jfet.test.ts` | 516 | `JFET state-pool extension schema::junction_slots_are_written_by_load` | `expect(gdJunction).toBeGreaterThan(1e-12)` + `expect(Math.abs(idJunction)).toBeGreaterThan(0)` | Assert exact Shockley values at known bias via toBeCloseTo |
| G-06 | `src/components/semiconductors/__tests__/bjt.test.ts` | 992–995 | `StatePool- BJT simple write-back elimination::load_stores_limited_vbe_vbc_in_pool` (L0) | `expect(vbeInPool).toBeGreaterThan(0.5)` + `toBeLessThanOrEqual(0.7)` | Pin exact pnjlim-converged value with toBeCloseTo |
| G-07 | `src/components/semiconductors/__tests__/bjt.test.ts` | 1070–1071 | `StatePool- BJT SPICE L1 write-back elimination::load_stores_limited_vbe_vbc_in_pool` (L1) | `expect(vbeInPool).toBeGreaterThan(0.5)` + `toBeLessThanOrEqual(0.7)` | Pin exact pnjlim-converged value with toBeCloseTo |
| G-08 | `src/components/semiconductors/__tests__/bjt.test.ts` | 352–353 | `NPN::voltage_limiting_both_junctions` | `expect(vbeLimited).toBeLessThan(5.0)` + `expect(vbeLimited - 0.3).toBeLessThan(4.5)` | Compute exact pnjlim(5.0, 0.3, tVcrit) and assert with toBe |
| G-09 | `src/components/semiconductors/__tests__/bjt.test.ts` | 752–753 | `Integration::npn_cutoff_with_zero_base_drive` | `expect(vCollector).toBeGreaterThan(4.9)` + `toBeLessThan(5.0)` | Use toBeCloseTo with ngspice reference value |
| G-10 | `src/components/passives/__tests__/capacitor.test.ts` | 337 | `Capacitor statePool::getLteTimestep returns finite value after two stampCompanion steps` | `expect(result).toBeGreaterThan(0)` only | Add toBeCloseTo against analytically computed LTE timestep |
| G-11 | `src/components/passives/__tests__/capacitor.test.ts` | 360–361 | `Capacitor statePool::getLteTimestep uses stored ccap from stampCompanion` | `expect(result).toBeGreaterThan(0)` + `expect(isFinite(result)).toBe(true)` | Add toBeCloseTo against formula |
| G-12 | `src/components/passives/__tests__/capacitor.test.ts` | 384 | `Capacitor statePool::getLteTimestep returns finite value after two stampCompanion steps with non-zero...` | `expect(result).toBeGreaterThan(0)` only | Add toBeCloseTo against formula |
| G-13 | `src/components/passives/__tests__/inductor.test.ts` | 364–365 | `Inductor statePool::getLteTimestep returns finite value after two stampCompanion steps with non-zero branch current` | `expect(result).toBeGreaterThan(0)` + `expect(isFinite(result)).toBe(true)` | Add toBeCloseTo against analytically computed LTE timestep |
| G-14 | `src/components/semiconductors/__tests__/diode.test.ts` | 1318 | `diode MODEINITSMSIG seeding::cap gate fires under MODEAC` | `expect(pool.state0[4]).toBeGreaterThan(0)` | Assert exact `ag[0] * Ctotal` value with toBeCloseTo |
| G-15 | `src/components/semiconductors/__tests__/diode.test.ts` | 1358 | `diode MODEINITSMSIG seeding::cap gate fires under MODETRANOP | MODEUIC` | `expect(pool.state0[4]).toBeGreaterThan(0)` | Assert exact `ag[0] * Ctotal` value with toBeCloseTo |
| G-16 | `src/components/passives/__tests__/transmission-line.test.ts` | 294 | `TLine::lossy_line_has_resistance_stamps` | `expect(matchingGeq.length).toBeGreaterThan(0)` | Assert exact conductance value, not just count |
| G-17 | `src/components/passives/__tests__/transmission-line.test.ts` | 833 | `TLine::stamps_during_modeinittran` | `expect(stamps.length).toBeGreaterThan(0)` | Assert exact stamp count and specific values |

---

## Category 2: `expect(typeof result).toBe("boolean")` alone (1 instance)

| # | File | Line | Test name | Pattern | Required fix |
|---|------|------|-----------|---------|--------------|
| G-18 | `src/components/semiconductors/__tests__/bjt.test.ts` | 1277 | `BJT OFF parameter::checkConvergence_does_not_always_return_true_when_OFF_in_transient_mode` | `expect(typeof result).toBe("boolean")`- doesn't verify true vs false | With all-zero voltages and no pnjlim activity, assert `expect(result).toBe(true)` |

---

## Category 3: `hasSignificantCurrent` / `maxRhs > 1e-X` pattern (5 instances- already listed in Cat 1 as G-01 to G-05)

See G-01, G-02, G-03, G-04, G-05 above. All 5 are from `jfet.test.ts`.

---

## Category 4: `expect(N).toBe(N)` tautologies (3 instances)

| # | File | Line | Test name | Pattern | Required fix |
|---|------|------|-----------|---------|--------------|
| G-19 | `src/components/io/__tests__/led.test.ts` | 957 | `integration::junction_cap_transient_matches_ngspice::capGeq_expected formula` | `expect(capGeq_expected).toBe(ag[0] * Ctotal)`- asserts test variable against its own definition | Delete tautology assertion; verify only `total00` matches formula |
| G-20 | `src/components/io/__tests__/led.test.ts` | 958 | `integration::junction_cap_transient_matches_ngspice::capIeq_expected formula` | `expect(capIeq_expected).toBe(ccap_expected - capGeq_expected * vd)`- same pattern | Delete tautology assertion |
| G-21 | `src/components/semiconductors/__tests__/jfet.test.ts` | 277 | `NJFET::pinch_off_progression` | `expect(ids10).toBeGreaterThan(0)` at zero-approaching bias- effectively tautological at that bias point | Verify exact Ids value at each Vgs point with toBeCloseTo |

---

## Category 5: `expect(2*(N-1)).toBe(4)` arithmetic identity (1 instance)

| # | File | Line | Test name | Pattern | Required fix |
|---|------|------|-----------|---------|--------------|
| G-22 | `src/components/passives/__tests__/transmission-line.test.ts` | 227 | `TLine::lossless_case::lossless line: R_seg and G_seg stamps are zero when loss=0` | `expect(2 * (N - 1)).toBe(4)`- pure arithmetic, not a behaviour assertion | Replace with `expect(internalNodeCount).toBe(4)` where `internalNodeCount` is read from the element; assert resistive stamps are zero or below threshold |

---

## Category 6: `Number.isFinite(x)` as sole / primary assertion (4 instances)

| # | File | Line | Test name | Pattern | Required fix |
|---|------|------|-----------|---------|--------------|
| G-23 | `src/components/passives/__tests__/transmission-line.test.ts` | 235 | `TLine::lossless_case` (inner stamp loop) | `expect(isFinite(s.value)).toBe(true)` for every stamp- only checks non-NaN/Inf | Assert specific expected zero-values for lossless R_seg/G_seg stamps |
| G-24 | `src/components/semiconductors/__tests__/bjt.test.ts` | 1208–1209 | `limitingCollector capture events` | `expect(Number.isFinite(ev.vBefore)).toBe(true)` + `Number.isFinite(ev.vAfter)` | Assert exact vBefore/vAfter values matching pnjlim inputs/outputs |
| G-25 | `src/components/semiconductors/__tests__/bjt.test.ts` | 1335–1336 | `L1 limitingCollector capture` | `expect(Number.isFinite(beEv!.vBefore)).toBe(true)` + `Number.isFinite(beEv!.vAfter)` | Assert exact vBefore/vAfter values |

---

## Summary by file

| File | Instances | IDs |
|------|-----------|-----|
| `jfet.test.ts` | 6 | G-01, G-02, G-03, G-04, G-05, G-21 |
| `bjt.test.ts` | 7 | G-06, G-07, G-08, G-09, G-18, G-24, G-25 |
| `diode.test.ts` | 2 | G-14, G-15 |
| `led.test.ts` | 2 | G-19, G-20 |
| `capacitor.test.ts` | 3 | G-10, G-11, G-12 |
| `inductor.test.ts` | 1 | G-13 |
| `transmission-line.test.ts` | 4 | G-16, G-17, G-22, G-23 |

**Total: 25 instances across 7 files.**

---

## Notes on blocked items

- G-14 and G-15 (diode.test.ts `pool.state0[4]`)- after D-2a completes, `SLOT_CAP_CURRENT` (index 4) will hold the correct `capd` value. The exact expected value formula is `Ctotal = computeJunctionCapacitance(vd, ...) + TT * gd`. Strengthening these tests should be done AFTER D-2a lands.
- G-21 (`jfet.test.ts` pinch_off_progression)- once A-1 (njfet clamp removal) is in place, the exact Ids values can be pinned against the unclipped exponential formula.
