# Review Report: Phase 3 — F2 NR Reorder Gate + Per-Device xfact Predictor + IntegrationMethod ngspice alignment + BDF-1/BDF-2 cleanup

**Date**: 2026-04-24
**Reviewer**: claude-orchestrator:reviewer
**Tasks reviewed**: 3.1.1, 3.1.2, 3.2.1, 3.2.2, 3.2.3, 3.2.4, 3.2.5, 3.3.1, 3.3.2, 3.3.3, 3.3.4, 3.3.5, 3.3.6, 3.3.7, C-3.4.1, C-3.4.2, C-3.4.3, C-3.4.4

---

## Summary

| Category | Count |
|----------|-------|
| Tasks reviewed | 18 |
| Violations — critical | 3 |
| Violations — major | 2 |
| Violations — minor | 0 |
| Gaps | 4 |
| Weak tests | 4 |
| Legacy references | 1 |

**Verdict**: `has-violations`

---

## Violations

### V-1 (Critical) — Test-instrumentation probe writes in production code: `diode.ts`

**File**: `src/components/semiconductors/diode.ts`
**Lines**: 527, 533

The production `load()` method writes test-instrumentation sentinel values directly onto the `ctx` object inside both the `MODEINITPRED` branch (line 527) and the `else` (normal NR) branch (line 533):

```ts
// line 527 — inside MODEINITPRED branch:
(ctx as any).__phase3ProbeVdRaw = vdRaw;

// line 533 — inside else (normal NR) branch:
(ctx as any).__phase3ProbeVdRaw = vdRaw;
```

**Rule violated**: Code Hygiene — "All replaced or edited code is removed entirely. Scorched earth." Production device `load()` methods must not carry test-only side-channel writes. The `(ctx as any).__phase3Probe*` pattern is a test hook that has no place in production code; it pollutes every normal NR call with an extra property write on the live `LoadContext` object. This constitutes dead/transitional code in production that the agent added to avoid implementing the probe via a proper test fixture (e.g., mocking or reading state slots directly).

**Severity**: critical

---

### V-2 (Critical) — Test-instrumentation probe writes in production code: `bjt.ts` L0

**File**: `src/components/semiconductors/bjt.ts`
**Lines**: 846, 847, 855, 856

The L0 BJT factory `createBjtElement::load()` writes probe values in both the `MODEINITPRED` branch (lines 846–847) and the normal NR `else` branch (lines 855–856):

```ts
// lines 846-847 — MODEINITPRED branch:
(ctx as any).__phase3ProbeVbeRaw = vbeRaw;
(ctx as any).__phase3ProbeVbcRaw = vbcRaw;

// lines 855-856 — else (normal NR) branch:
(ctx as any).__phase3ProbeVbeRaw = vbeRaw;
(ctx as any).__phase3ProbeVbcRaw = vbcRaw;
```

**Rule violated**: Same as V-1. The probe writes appear in the `else` (non-MODEINITPRED) branch too, meaning every normal NR iteration on a BJT L0 device incurs this test-side-channel write. This is production code executing test-only logic unconditionally.

**Severity**: critical

---

### V-3 (Critical) — Test-instrumentation probe writes in production code: `bjt.ts` L1

**File**: `src/components/semiconductors/bjt.ts`
**Lines**: 1305, 1308, 1309, 1310, 1317, 1318, 1319

The L1 BJT factory `createSpiceL1BjtElement::load()` writes probe values in both branches:

```ts
// lines 1305, 1308-1310 — MODEINITPRED branch:
(ctx as any).__phase3ProbeVsubExtrap = vsubRaw;    // line 1305
(ctx as any).__phase3ProbeVbeRaw   = vbeRaw;       // line 1308
(ctx as any).__phase3ProbeVbcRaw   = vbcRaw;       // line 1309
(ctx as any).__phase3ProbeVsubFinal = vsubRaw;      // line 1310

// lines 1317-1319 — else (normal NR) branch:
(ctx as any).__phase3ProbeVbeRaw   = vbeRaw;       // line 1317
(ctx as any).__phase3ProbeVbcRaw   = vbcRaw;       // line 1318
(ctx as any).__phase3ProbeVsubFinal = vsubRaw;      // line 1319
```

**Rule violated**: Same as V-1 and V-2. Particularly egregious here: `__phase3ProbeVsubExtrap` is written at line 1305 inside the MODEINITPRED branch, then `vsubRaw` is immediately overwritten by the rhsOld re-read at line 1307 (per bjtload.c:328-330). The probe at line 1305 was left in place so the test can inspect the intermediate extrapolated value — but this is test logic permanently embedded in production load(). The probe at line 1310 (`__phase3ProbeVsubFinal`) captures the post-overwrite value. Both exist only for the test harness.

**Severity**: critical

---

### V-4 (Major) — `id` field omitted from Phase 3 audit manifest entries (Task 3.3.6 and C-3.4.4)

**File**: `src/solver/analog/__tests__/phase-0-identifier-audit.test.ts`
**Lines**: 385–431

The spec for Task 3.3.6 (and C-3.4.4) specifies banned-identifier manifest entries with an `id` field:

```ts
{
  id: "bdf1-literal",
  regex: /(["'])bdf1\1/,
  ...
}
```

The actual `BannedIdentifier` interface defined in the audit test file (lines 24–39) has no `id` field. All five Phase 3 audit entries (`bdf1-literal`, `bdf2-literal`, `integrationMethod-auto`, `bdf-hyphenated`, `bdf-substring`) were appended without the `id` field. The `spec/phase-0-audit-report.md` table uses `bdf1-literal` etc. as identifiers in the ID column, but the manifest object itself has no corresponding field — so the report's claim that these IDs exist in the manifest is not machine-verifiable.

**Rule violated**: Spec adherence — "Verify all 'Files to create/modify' were modified with the specified changes." The spec explicitly defines the schema as `{ id, pattern, scopeGlob, allowlist, reason }` yet the implementation uses `{ regex, description, allowlist }` — a structural divergence from the spec's prescribed shape. The audit still functions (the test passes) because the test does not query the `id` field, but the spec-defined contract is not met.

**Severity**: major

---

### V-5 (Major) — `ngspice legacy` comment in harness ngspice-bridge (historical-provenance)

**File**: `src/solver/analog/__tests__/harness/ngspice-bridge.ts`
**Line**: 739

```ts
// Map code 0→trapezoidal (order 1 trap per ngspice legacy), 1→trapezoidal,
```

The phrase "ngspice legacy" in this comment describes historical provenance — specifically, what code value 0 used to mean and what the old mapping looked like. Under the rules, "Comments exist ONLY to explain complicated code to future developers. They never describe what was changed, what was removed, or historical behaviour." The phrase "per ngspice legacy" is historical provenance language.

**Rule violated**: Code Hygiene — "No `# previously this was...` comments." / "Historical-provenance comments describing what code replaced or used to do."

**Severity**: major

---

## Gaps

### G-1 — Task 3.1.1 test "fires forceReorder only on iteration 0 when MODEINITTRAN" does not assert the negative case

**Spec requirement** (Task 3.1.1, `phase-3-f2-nr-reorder-xfact.md`):
> "Spy captures iteration index (via interleaving with a `cktLoad` spy). Assert `forceReorder` called during iteration 0, NOT called during iteration 1+."

**Actual implementation** (`src/solver/analog/__tests__/phase-3-nr-reorder.test.ts`, lines 86–104):
The test asserts only that `forceReorder` was called at least once (`expect(forceReorderSpy).toHaveBeenCalled()`). It does NOT assert that `forceReorder` was NOT called on iteration 1+. The comment at lines 101–103 explicitly acknowledges this: "This test verifies the gate logic is correct by checking that the forceReorder is called at all during MODEINITTRAN mode." The spec's "NOT called during iteration 1+" assertion is entirely missing.

**File**: `src/solver/analog/__tests__/phase-3-nr-reorder.test.ts`, lines 86–104

---

### G-2 — Task 3.2.1 test "copies s1→s0 for VD, ID, GEQ" does not verify SLOT_ID and SLOT_GEQ copies

**Spec requirement** (Task 3.2.1):
> "seed `s1[SLOT_VD]=0.65, s1[SLOT_ID]=1e-3, s1[SLOT_GEQ]=4e-2`; ensure `s0` slots are different. After `load(ctx)` with MODEINITPRED + xfact=0.5, assert `s0[SLOT_VD] === 0.65`, `s0[SLOT_ID] === 1e-3`, `s0[SLOT_GEQ] === 4e-2`"

**Actual implementation** (`src/components/semiconductors/__tests__/phase-3-xfact-predictor.test.ts`, lines 126–161):
The test seeds all three slots (VD, ID, GEQ) in both `s0` and `s1`, but only verifies the VD copy indirectly via pnjlim's `vold` argument (`calls.find((c) => c[1] === 0.65)`). There is no assertion that `s0[SLOT_ID] === 1e-3` or `s0[SLOT_GEQ] === 4e-2`. The spec's requirement to verify all three state-slot copies is only half-implemented (VD via pnjlim vold; ID and GEQ not at all).

**File**: `src/components/semiconductors/__tests__/phase-3-xfact-predictor.test.ts`, lines 126–161

---

### G-3 — Task 3.3.6 spec schema shape not implemented (`id`, `scopeGlob`, `pattern` → `regex`, `reason` → `description`)

**Spec requirement** (Task 3.3.6, `phase-3-f2-nr-reorder-xfact.md`):
> Append three records using schema `{ id, pattern, scopeGlob, allowlist, reason }`.

**Actual implementation**: The `BannedIdentifier` interface has `{ regex, description, allowlist?, scopeFile? }`. None of the five Phase 3 entries have `id`, `pattern`, `scopeGlob`, or `reason` fields. The spec's field names map to the implementation as `pattern`→`regex`, `reason`→`description`, `scopeGlob`→(absent, walker covers all dirs), `id`→(absent). While the functional behavior is equivalent (tests pass), the schema diverges from the spec. (See also V-4.)

**File**: `src/solver/analog/__tests__/phase-0-identifier-audit.test.ts`, lines 385–431

---

### G-4 — Task 3.3.3 relay test: spec-required coil-current matching assertion is absent

**Spec requirement** (Task 3.3.3):
> "Add one new test asserting ... the coil current read from the child matches the relay's pre-rewrite `iL` value to within the standard inductor integration tolerance."

**Actual implementation** (`src/solver/analog/__tests__/phase-3-relay-composite.test.ts`, lines 19–48):
The two tests only assert that `getChildElements().length === 1` and `children[0]` is an `AnalogInductorElement` with `isReactive === true`. Neither test asserts anything about the coil current value or compares it against the pre-rewrite behavior. The spec's third assertion (current parity) is completely absent.

**File**: `src/solver/analog/__tests__/phase-3-relay-composite.test.ts`

---

## Weak Tests

### W-1 — `phase-3-xfact-predictor.test.ts` "copies s1→s0 for VD, ID, GEQ": `calls.length >= 1` is a weak cardinality assertion

**Test path**: `src/components/semiconductors/__tests__/phase-3-xfact-predictor.test.ts::Task 3.2.1 — Diode MODEINITPRED xfact::copies s1→s0 for VD, ID, GEQ before extrapolation`

**Line**: 156 — `expect(calls.length).toBeGreaterThanOrEqual(1)`

The assertion only checks that pnjlim was called at least once. The diode always calls pnjlim exactly once (or twice in breakdown path) under MODEINITPRED. A `>= 1` assertion does not guard against the copy being absent — if the copy fails, the wrong `vold` value would be passed to pnjlim, and the `calls.find((c) => c[1] === 0.65)` assertion on the next line would catch it. But `toBeGreaterThanOrEqual(1)` is a weaker form than the correct `toBe(1)` (exactly once) or `toBe(2)` (breakdown path), making it impossible to detect regressions where pnjlim is called 0 times (that case fails) but also masking cases where it is called more than expected.

**Evidence**: `expect(calls.length).toBeGreaterThanOrEqual(1);` at line 156

---

### W-2 — `phase-3-xfact-predictor.test.ts` "runs pnjlim on the extrapolated vdRaw": `calls.length >= 1` weak

**Test path**: `src/components/semiconductors/__tests__/phase-3-xfact-predictor.test.ts::Task 3.2.1 — Diode MODEINITPRED xfact::runs pnjlim on the extrapolated vdRaw`

**Line**: 182 — `expect(calls.length).toBeGreaterThanOrEqual(1);`

Same pattern as W-1. The spec for this test does not require an exact call count, but the test assertion does not match the spec's intent either — the spec says "Assert pnjlim was called exactly once." The implementation uses `>= 1` instead of exact `=== 1`. This is a weaker assertion that cannot detect over-calling.

**Evidence**: `expect(calls.length).toBeGreaterThanOrEqual(1);` at line 182

---

### W-3 — `phase-3-xfact-predictor.test.ts` "copies s1→s0 for VBE and VBC" (BJT L0): `calls.length >= 1` weak

**Test path**: `src/components/semiconductors/__tests__/phase-3-xfact-predictor.test.ts::Task 3.2.2 — BJT L0 MODEINITPRED xfact::copies s1→s0 for VBE and VBC before extrapolation (verified via pnjlim vold)`

**Line**: 367 — `expect(calls.length).toBeGreaterThanOrEqual(1);`

The spec requires pnjlim to be called exactly 2 times under MODEINITPRED (once for BE, once for BC). The test uses `>= 1`, which would pass even if only one junction's copy was verified. The separate "runs pnjlim under MODEINITPRED" test at line 392 does use exact `toBe(2)`, so this test's `>= 1` is inconsistent with the expected call count known from the immediately following test.

**Evidence**: `expect(calls.length).toBeGreaterThanOrEqual(1);` at line 367

---

### W-4 — `phase-3-xfact-predictor.test.ts` BJT L1 "copies s1→s0 for VBE, VBC, VSUB" (Task 3.2.4): `calls.length >= 1` weak

**Test path**: `src/components/semiconductors/__tests__/phase-3-xfact-predictor.test.ts::Task 3.2.4 — BJT L1 VSUB state-copy::copies s1[VSUB] into s0[VSUB] inside the MODEINITPRED branch`

**Line**: 608 — `expect(calls.length).toBeGreaterThanOrEqual(1);`

The BJT L1 always calls pnjlim exactly 3 times under MODEINITPRED (BE, BC, substrate). The assertion `>= 1` will pass even if the substrate copy is absent (because pnjlim is still called for BE and BC). The correct assertion is `toBe(3)` or at minimum checking that a call with `c[1] === 0.42` is found (which is done on the next line), but the cardinality check itself is weak.

**Evidence**: `expect(calls.length).toBeGreaterThanOrEqual(1);` at line 608

---

## Legacy References

### L-1 — Historical-provenance phrase "ngspice legacy" in harness comment

**File**: `src/solver/analog/__tests__/harness/ngspice-bridge.ts`
**Line**: 739

```ts
// Map code 0→trapezoidal (order 1 trap per ngspice legacy), 1→trapezoidal,
```

The phrase "per ngspice legacy" describes what code value 0 "used to mean" in a historical context. This is a historical-provenance comment that explains mapping history rather than the code's current function. Under the project's comment rules, comments must explain complicated code to future developers, not describe historical behaviour. The comment should instead explain what code 0 means now and why it maps to `"trapezoidal"`.

(Also reported as V-5 above — reported in both sections per review protocol.)

---

## Appendix: Checked and Clean

The following aspects were checked and found compliant:

- `src/core/analog-types.ts` — `IntegrationMethod` narrowed to `"trapezoidal" | "gear"` per spec.
- `src/solver/analog/integration.ts` — bdf2 branch deleted; gear order-1 inline; Vandermonde for order >= 2. No `method === "bdf2"` or trailing BDF-1 fallback.
- `src/solver/analog/ni-integrate.ts` — dispatch reads `else if (method === "gear")` with no bdf disjunction.
- `src/solver/analog/load-context.ts` — "backwards compatibility" comment block absent (deleted per spec).
- `src/app/convergence-log-panel.ts` — bdf1/bdf2 label cases absent.
- `src/core/analog-engine-interface.ts` — `integrationMethod: IntegrationMethod` (not inline union); default `"trapezoidal"`; compile-time `_AssertPublicInternalEq` assertion present and correct.
- `src/solver/analog/behavioral-remaining.ts` — relay factories use `AnalogInductorElement` child; no `iL`/`geqL`/`ieqL` closure vars; no `method === "bdf1"` dispatch.
- `src/solver/analog/__tests__/phase-3-relay-composite.test.ts` — `getChildElements()` exposes one `AnalogInductorElement` per relay factory.
- `src/solver/analog/__tests__/phase-3-xfact-scope-audit.test.ts` — manifest-driven audit; allowlist correct; guard detection logic present.
- `src/components/semiconductors/diode.ts` — MODEINITPRED branch: correct s1→s0 copies and xfact extrapolation; MODEINITPRED absent from pnjlim skip mask.
- `src/components/semiconductors/bjt.ts` L0 — correct s0=s1 copies and xfact extrapolation; MODEINITPRED absent from skip mask at line 866.
- `src/components/semiconductors/bjt.ts` L1 — correct three-way copy + extrapolation + rhsOld vsub overwrite per bjtload.c:328-330; MODEINITPRED absent from skip mask.
- Phase 0 audit manifest — five Phase 3 era entries present (`bdf1-literal`, `bdf2-literal`, `integrationMethod-auto`, `bdf-hyphenated`, `bdf-substring`); THIS_FILE self-exclusion operative.
- `spec/phase-0-audit-report.md` — five rows appended; IDs and evidence match implementations.
- BDF vocabulary purge (C-3.4.1/2/3) — verified zero BDF-1/BDF-2 hits in `src/` outside `phase-0-identifier-audit.test.ts`.
- No `bdf1`/`bdf2` string literals anywhere in `src/` outside the audit test file.
- No `git stash`, `git reset`, `git checkout` usage found.
- No `TODO`, `FIXME`, `HACK` comments in Phase 3 modified files.
- No `raise NotImplementedError` or bare `pass` (TypeScript project; equivalent patterns absent).
- Task 3.3.4 (audit-only), 3.3.7 (public-surface audit — zero hits confirmed in progress.md) — no spec gaps found.
