# Review Report: Phase 2 Task 2.4.7 — Remaining Charge/Reactive Devices (F4 bitfield rewrite)

## Summary

- Tasks reviewed: 1 (Task 2.4.7)
- Component files reviewed: 11 production files + 9 test files
- Violations: 5 (1 critical, 2 major, 2 minor)
- Gaps: 1
- Weak tests: 3
- Legacy references: 3
- Verdict: **has-violations**

---

## Violations

### V1 — CRITICAL: triac.ts — No MODEINITJCT gate; pnjlim applied unconditionally

**File:** `src/components/semiconductors/triac.ts`
**Lines:** 298–304 (load() body)
**Rule violated:** F4 spec diode-family pattern (dioload.c:130–136): during MODEINITJCT, vd must be seeded directly without calling pnjlim. Code Hygiene rule: no backwards compatibility shims or omitted migrations.

**Evidence:**
```typescript
// No import of any ckt-mode constants in triac.ts at all
// (grep for `import.*ckt-mode` returns zero results)

const vmtResult = pnjlim(vmtRaw, s0[base + SLOT_VAK], nVt, vcritMain);
const vmtLimited = vmtResult.value;
const vg1Result = pnjlim(vg1Raw, s0[base + SLOT_VGK], nVt, vcritGate);
const vg1Limited = vg1Result.value;
pnjlimLimited = vmtResult.limited || vg1Result.limited;
if (pnjlimLimited) ctx.noncon.value++;
```

The TRIAC applies `pnjlim` to both junction voltages (MT2-MT1 and G-MT1) on every NR iteration including MODEINITJCT cold-start. The diode-family pattern (zener.ts, scr.ts, bjt.ts) gates on `ctx.cktMode & MODEINITJCT` and seeds the junction voltage directly from vcrit without limiting. The triac has zero ckt-mode imports and zero MODEINITJCT gate. This is an incomplete F4 migration — the triac was never migrated to the bitfield pattern.

**Severity: critical**

---

### V2 — MAJOR: led.ts — Missing MODEINITJCT gate; pnjlim applied unconditionally

**File:** `src/components/io/led.ts`
**Lines:** load() body (pnjlim call site)
**Rule violated:** F4 spec diode-family pattern: during MODEINITJCT, vd must be seeded directly without pnjlim.

**Evidence:**
The LED imports `MODETRAN, MODEAC` from ckt-mode.ts (correct for the cap gate) but does not import `MODEINITJCT`. The `load()` function calls `pnjlim(vdRaw, vdOld, nVt, vcrit)` unconditionally on every iteration with no MODEINITJCT gate. SCR, zener, BJT, and MOSFET all have the gating pattern:
```typescript
if (ctx.cktMode & MODEINITJCT) {
  // seed vd directly from vcrit, no pnjlim
} else {
  const res = pnjlim(...);
  ...
}
```
The LED is missing this gate entirely. This is a partial F4 migration: the cap gate was migrated correctly but the junction-seed path was not.

**Severity: major**

---

### V3 — MAJOR: real-opamp.test.ts — Historical-provenance comment referencing removed API

**File:** `src/components/active/__tests__/real-opamp.test.ts`
**Line:** 599
**Rule violated:** rules.md "Historical-provenance comments are dead-code markers." Code Hygiene rule: "No `# previously this was...` comments." Comments must not describe historical behaviour.

**Evidence:**
```
// limiting is only active in transient (ctx.isTransient), so the DC-OP
```
This comment references `ctx.isTransient`, which is the old pre-F4 LoadContext API that has been removed. The comment describes a historical API in the context of the new bitfield system. This is a provenance comment that must be removed. The code it decorates must be inspected to ensure it correctly uses `cktMode` bitfields rather than the removed field.

**Severity: major**

---

### V4 — MINOR: diode.test.ts — Historical-provenance comment (line 1282)

**File:** `src/components/semiconductors/__tests__/diode.test.ts`
**Line:** 1282
**Rule violated:** rules.md historical-provenance comment ban.

**Evidence:**
```
// cap gate was `ctx.isTransient` — MODEAC was excluded.
```
This comment describes what the old gate used to be, referencing the removed `ctx.isTransient` field. It is a before/after migration note — exactly what the rules ban.

**Severity: minor**

---

### V5 — MINOR: diode.test.ts — Historical-provenance comment (line 1363)

**File:** `src/components/semiconductors/__tests__/diode.test.ts`
**Line:** 1363
**Rule violated:** rules.md historical-provenance comment ban.

**Evidence:**
```
// The old gate was `ctx.isTransient`. Under pure MODEDCOP (DC-OP), caps are
```
Same category as V4 — references the removed `ctx.isTransient` field to explain historical behaviour.

**Severity: minor**

---

## Gaps

### G1 — No Task 2.4.7 entry in spec/progress.md

**Spec requirement:** All completed tasks must have a corresponding entry in `spec/progress.md` documenting status, files created/modified, and acceptance criteria met. The spec defines `spec/progress.md` as the source of truth for implementation status.

**What was found:** `spec/progress.md` ends at line 426 with the `fix-bjt-mosfet-ctx` entry. There is no entry for Task 2.4.7 ("Remaining charge/reactive devices mechanical bitfield rewrite"). All 11 component files listed in the task were modified (confirmed by git status), but the implementation was never formally recorded.

**Impact:** The orchestrator cannot verify wave completion, the next agent cannot determine what was done, and the reviewer cannot determine the agent's self-reported acceptance criteria. The absence also indicates the agent may have stopped before completing the task (consistent with the triac and LED violations above).

**File:** `spec/progress.md`

---

## Weak Tests

### WT1 — transmission-line.test.ts: lossless_case test has trivially weak assertion

**Test path:** `src/components/passives/__tests__/transmission-line.test.ts::TLine::lossless_case::lossless line: R_seg and G_seg stamps are zero when loss=0`

**Problem:** The test asserts `2 * (N - 1) === 4` (a pure arithmetic identity, always true regardless of the implementation) and `isFinite(s.value)` for all stamps. The "finite" check cannot catch incorrect resistance stamps — a stamp of `1e12` is finite. The test does not assert that the resistive conductance stamps are actually zero (or near zero) for a lossless line.

**Evidence:**
```typescript
expect(2 * (N - 1)).toBe(4);  // arithmetic identity, not a behaviour assertion
for (const s of stamps) {
  expect(isFinite(s.value)).toBe(true);  // trivially true — NaN/Infinity are edge cases
}
```

---

### WT2 — transmission-line.test.ts: more_segments_more_accurate has ambiguous direction assertion

**Test path:** `src/components/passives/__tests__/transmission-line.test.ts::TLine::more_segments_more_accurate::N=50 delay more accurate than N=5`

**Problem:** The test asserts only `Math.abs(v50 - v5) > 0.001` (the two values differ by more than 1mV). This does not assert which direction is more accurate — the test passes whether N=50 is higher or lower than N=5. The spec says N=50 should produce a sharper delay response (closer to ideal step delay), but the test does not verify this direction.

**Evidence:**
```typescript
// The exact comparison direction depends on dispersion effects, so we
// only verify that both are positive and the higher-fidelity model
// produces a meaningfully different result from the low-fidelity one.
expect(Math.abs(v50 - v5)).toBeGreaterThan(0.001);
```
The comment explicitly acknowledges the direction is not asserted.

---

### WT3 — led.test.ts: junction_cap_transient_matches_ngspice has tautological sub-assertions

**Test path:** `src/components/io/__tests__/led.test.ts::integration::junction_cap_transient_matches_ngspice`

**Problem:** Two of the intermediate assertions are tautologies — they assert that a formula equals itself, not that the implementation matches the formula.

**Evidence:**
```typescript
// Verify the formulas are bit-exact (these are the NIintegrate spec)
expect(capGeq_expected).toBe(ag[0] * Ctotal);       // tautology: same computation
expect(capIeq_expected).toBe(ccap_expected - capGeq_expected * vd);  // tautology
```
These assertions verify the test's own local variables are self-consistent, not that the production code produces the correct values. The only meaningful assertion is the final `expect(total00).toBe(gd_junction + capGeq_expected)` which checks the stamped value.

---

## Legacy References

### LR1 — real-opamp.test.ts line 599: reference to removed `ctx.isTransient`

**File:** `src/components/active/__tests__/real-opamp.test.ts`
**Line:** 599
**Quoted evidence:**
```
// limiting is only active in transient (ctx.isTransient), so the DC-OP
```
References the pre-F4 field `ctx.isTransient` which has been removed from `LoadContext`.

---

### LR2 — diode.test.ts line 1282: reference to removed `ctx.isTransient`

**File:** `src/components/semiconductors/__tests__/diode.test.ts`
**Line:** 1282
**Quoted evidence:**
```
// cap gate was `ctx.isTransient` — MODEAC was excluded.
```
References the removed pre-F4 field `ctx.isTransient`.

---

### LR3 — diode.test.ts line 1363: reference to removed `ctx.isTransient`

**File:** `src/components/semiconductors/__tests__/diode.test.ts`
**Line:** 1363
**Quoted evidence:**
```
// The old gate was `ctx.isTransient`. Under pure MODEDCOP (DC-OP), caps are
```
References the removed pre-F4 field `ctx.isTransient`.

---

## Clean Findings (for record)

The following files from the 11-component scope were found to be compliant with the F4 bitfield migration pattern:

- **zener.ts**: Correct MODEINITJCT gate; cap not applicable (diode-only). No legacy fields.
- **varactor.ts**: Correct MODEINITJCT gate; cap gate `MODETRAN | MODEAC` correct. No legacy fields.
- **scr.ts**: Correct MODEINITJCT gate (dioload.c:130-136 comments present). No legacy fields.
- **tunnel-diode.ts**: No pnjlim (NDR device uses voltage clamping — intentional); cap gate `MODETRAN | MODEAC` correct. No legacy fields.
- **polarized-cap.ts**: Outer gate `!(MODETRAN | MODETRANOP)`, inner `MODETRAN`, pred `MODEINITPRED`, initTran `MODEINITTRAN` — correct capacitor pattern. No legacy fields.
- **transformer.ts**: Flux gate `!(MODEDC | MODEINITPRED)`, initTran `MODEINITTRAN`, companion `MODETRAN` — correct inductor pattern. No legacy fields.
- **tapped-transformer.ts**: Same inductor pattern as transformer.ts. No legacy fields.
- **transmission-line.ts**: SegmentInductorElement and CombinedRLElement use inductor pattern; SegmentCapacitorElement uses capacitor pattern. No legacy fields.
- **crystal.ts**: Outer gate `!(MODETRAN | MOTETRANOP)`, inner `MOTETRAN`, pred/initTran gates correct. No legacy fields.
- **real-opamp.ts**: Only uses `MODETRAN` for geq_int computation — correct for an op-amp (no junction caps). No legacy fields.

Test files (excluding noted violations):
- **polarized-cap.test.ts**: Uses `cktMode: MODEDCOP | MODEINITFLOAT`, `MODETRAN | MODEINITTRAN`, `MODETRAN | MODEINITFLOAT`. No legacy fields.
- **transformer.test.ts**: Uses `cktMode: MODETRAN | MODEINITTRAN`, `MODETRAN | MODEINITFLOAT`. No legacy fields.
- **tapped-transformer.test.ts**: Uses `cktMode: MODETRAN | MODEINITFLOAT`, `MODETRAN | MODEINITTRAN`. No legacy fields.
- **transmission-line.test.ts**: Uses `cktMode: MODETRAN | MODEINITTRAN`, `MODETRAN | MODEINITFLOAT`. No legacy fields.
- **crystal.test.ts**: Uses `cktMode: MODETRAN | MODEINITFLOAT`, `MODETRAN | MODEINITTRAN`. No legacy fields.
- **led.test.ts (analog section)**: Uses `cktMode: MODETRAN | MODEINITFLOAT`. No legacy fields in LoadContext literals.
- **varactor.test.ts**: Clean (read in prior session). No legacy fields.
- **tunnel-diode.test.ts**: Clean (read in prior session). No legacy fields.
