# Review Report: Phase 4 — F5 Residual Limiting Primitives

## Summary

- **Tasks reviewed**: 5 (4.1.1, 4.1.2, 4.1.3, 4.2.1, 4.2.2)
- **Violations**: 0 critical, 1 major, 1 minor
- **Gaps**: 0
- **Weak tests**: 2
- **Legacy references**: 0
- **Verdict**: has-violations

---

## Violations

### V-1 — Major

**File**: `src/solver/analog/newton-raphson.ts`
**Lines**: 18-22 (import block), 194 (call site in `fetlim`)
**Rule violated**: Code Hygiene — test-specific infrastructure embedded in production code.

**Evidence**:
```typescript
// Self-namespace import: lets intra-module calls (e.g. `fetlim` → `_computeVtstlo`)
// route through the exports object rather than the lexical binding, so that
// `vi.spyOn(NewtonRaphsonModule, "_computeVtstlo")` can intercept the call
// from test code and guard against future inline re-expansion of the helper.
import * as self from "./newton-raphson.js";
```

And at line 194 inside `fetlim`:
```typescript
const vtstlo = self._computeVtstlo(vold, vto);
```

**Analysis**: The production module `newton-raphson.ts` performs a self-referential circular import (`import * as self from "./newton-raphson.js"`) whose only stated purpose — documented in the comment — is enabling `vi.spyOn` interception from test code. The comment explicitly names `vi.spyOn` as the motivation. This is test-framework infrastructure embedded in production code: it changes the calling convention of a production function (`fetlim` calls `self._computeVtstlo` instead of calling `_computeVtstlo` directly) purely so that a Vitest spy can intercept the call. Every invocation of `fetlim` incurs an extra property lookup through the module namespace object at runtime due to this design.

The spec (Task 4.1.1) says to "spy/mock `_computeVtstlo` via vitest `vi.spyOn` on the module namespace", but does not specify that production code must call through `self`. The spy-interception requirement could be met differently (e.g., Vitest module-level mock, or restructuring the test to verify the observable output of `fetlim` rather than the internal call routing). As implemented, production code is structurally altered to satisfy a test framework constraint.

**Severity**: Major.

---

### V-2 — Minor

**File**: `src/components/semiconductors/__tests__/bjt-l0-scope-comment.test.ts`
**Line**: 32
**Rule violated**: Testing — "Test the specific."

**Evidence**:
```typescript
const l0AnchorMatch = l0AnchorRegex.exec(source);
expect(l0AnchorMatch, "L0 icheckLimited anchor line must exist").not.toBeNull();
```

**Analysis**: `expect(...).not.toBeNull()` verifies only that the regex matched somewhere in the file, not any specific content or location. This is an intermediate guard before the real assertion at lines 43-47. The primary assertion (`expect(region.includes("architectural-alignment.md §E1"), ...).toBe(true)`) is specific. The intermediate `.not.toBeNull()` is a weak precondition guard rather than a behavioural assertion, and its failure message ("anchor line must exist") would obscure the actual structural invariant being tested.

**Severity**: Minor.

---

## Gaps

None found. All five tasks have been implemented as specified:

- **4.1.1**: `_computeVtstlo` exported, `fetlim` routes via `self._computeVtstlo`, `// cite: devsup.c:101-102` present adjacent to both coefficient lines, four tests present in `newton-raphson-limiting.test.ts`.
- **4.1.2**: `limvds` implementation unchanged (diff limited to docstring), docstring updated to `devsup.c:17-40`, six tests present.
- **4.1.3**: Both `pnjlim` JSDoc citations normalized to `devsup.c:49-84` (two hits confirmed), old forms `devsup.c:50-58` and `devsup.c:50-84` absent (zero hits confirmed).
- **4.2.1**: `ctx.limitingCollector`-gated push block present in `led.ts` immediately after `s0[base + SLOT_VD] = vdLimited`, with `junction: "AK"`, `limitType: "pnjlim"`, `vBefore: vdRaw`, `vAfter: vdLimited`, `wasLimited: pnjlimLimited`. Four new tests in `led.test.ts`.
- **4.2.2**: L1 substrate pnjlim call at `bjt.ts:1449` audited — all five spec conditions pass. L0 scope comment present at lines 924-927 citing `architectural-alignment.md §E1`. Comment-presence test in `bjt-l0-scope-comment.test.ts` present and structurally correct.

---

## Weak Tests

### WT-1

**Test path**: `src/components/io/__tests__/led.test.ts::describe("LED limitingCollector")::it("pushes AK pnjlim event on non-init NR iteration")`
**Line**: 1066
**Issue**: `vBefore`/`vAfter` inequality check only; no exact numerical assertion on the pnjlim output.

**Evidence**:
```typescript
expect(collector[0].vBefore).not.toBe(collector[0].vAfter);
```

**Analysis**: The test drives `vdRaw = 5.0 V` with `vcrit ≈ 1.82 V` for a red LED, which triggers the pnjlim forward-bias limiting branch. The pnjlim output is computable from the formula (`vold + vt*(2+log(arg-2))`), but the assertion only checks that `vBefore !== vAfter`. The spec says: `ctx.limitingCollector[0].vBefore !== ctx.limitingCollector[0].vAfter` — so this assertion exactly matches the spec's wording. However, it leaves a gap where a corrupted `vAfter` (e.g., swapped assignment, sign error) would still pass as long as it differs from `vBefore`. An exact-value assertion on `vAfter` would have higher diagnostic power. This is spec-compliant but suboptimal.

### WT-2

**Test path**: `src/components/semiconductors/__tests__/bjt-l0-scope-comment.test.ts::describe("BJT L0 scope documentation")::it("documents L0 substrate divergence after pnjlim block")`
**Line**: 32
**Issue**: `.not.toBeNull()` intermediate guard — same as V-2.

**Evidence**:
```typescript
expect(l0AnchorMatch, "L0 icheckLimited anchor line must exist").not.toBeNull();
```

Same analysis as V-2. The primary assertion at lines 43-47 is specific; this guard is weak.

---

## Legacy References

None found.

Scanned all Phase 4 modified/created files (`newton-raphson.ts`, `led.ts`, `bjt.ts`, `newton-raphson-limiting.test.ts`, `led.test.ts`, `bjt-l0-scope-comment.test.ts`) for: "legacy", "fallback", "workaround", "temporary", "previously", "backwards compatible", "shim", "migrated from", "replaced".

One occurrence noted and dismissed: `bjt.ts:499` contains `"bjtload.c:427-430: reverse-bias cubic fallback."` — this is an ngspice algorithm citation describing a mathematical approximation branch in the live Gummel-Poon implementation. The word "fallback" here names the ngspice algorithm (cubic fallback for deep reverse bias), not a dead code path or compatibility shim. The decorated code is the live else-branch of the `vbe >= -3 * vtn_f` gate, which is the standard SPICE3/ngspice cubic approximation. Not a dead-code marker.

---

## Acceptance Criteria Verification

### Task 4.1.1
- `grep -n "vtstlo = vtsthi" src/solver/analog/newton-raphson.ts` → **zero hits**. PASS.
- `grep -n "Math.abs(vold - vto) + 1" src/solver/analog/newton-raphson.ts` → **one hit** (line 166, inside `_computeVtstlo`). PASS.
- `// cite: devsup.c:101-102` present adjacent to both coefficient lines (line 192). PASS. (Note: spec says `// cite:` comment at `vtstlo` line reads `devsup.c:102`; the single comment covers both `:101` and `:102`, satisfying the acceptance criterion for the `vtstlo` line.)
- Four new tests in `newton-raphson-limiting.test.ts` pass. PASS (per progress.md: 10/10 tests passing in that file for tasks 4.1.1 + 4.1.2).

### Task 4.1.2
- `limvds` implementation verified unchanged (only docstring modified at line 243). PASS.
- Docstring citation updated to `devsup.c:17-40` (line 243). PASS.
- Six `limvds` tests present and named per spec. PASS.

### Task 4.1.3
- `grep -n "devsup.c:50-58" newton-raphson.ts` → **zero hits**. PASS.
- `grep -n "devsup.c:50-84" newton-raphson.ts` → **zero hits**. PASS.
- `grep -n "devsup.c:49-84" newton-raphson.ts` → **two hits** (lines 72, 89). PASS.

### Task 4.2.1
- `grep -n "limitingCollector" src/components/io/led.ts` → **two hits** (lines 279, 280). PASS.
- Four new LED limitingCollector tests present and structured per spec. PASS.
- Existing LED tests: 88/89 passing per progress.md; one pre-existing failure (`junction_cap_transient_matches_ngspice`) is independent of this task. PASS.

### Task 4.2.2
- L1 substrate pnjlim call at `bjt.ts:1449`:
  - Arg 1 = `vsubRaw`. PASS.
  - Arg 2 = `s0[base + SLOT_VSUB]`. PASS.
  - Arg 3 = `vt` (local variable). PASS.
  - Arg 4 = `tp.tSubVcrit`. PASS.
  - Enclosing gate = `(mode & (MODEINITJCT | MODEINITSMSIG | MODEINITTRAN)) === 0` (MODEINITPRED absent per Phase 3 W3.2 ngspice alignment and spec clarification). PASS.
- L0 `load()` scope comment at lines 924-927 citing `architectural-alignment.md §E1 APPROVED ACCEPT`. PASS.
- Comment-presence test (`bjt-l0-scope-comment.test.ts`): 1/1 passing per progress.md. PASS.
- Existing BJT L0/L1 tests: 35/38 passing; three pre-existing failures (`voltages[nodeB - 1]` crash in LimitingEvent tests, pre-dating Phase 4). PASS.
