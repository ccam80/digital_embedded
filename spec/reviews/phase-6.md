# Review Report: Phase 6 Wave 6.1 — LoadContext + AnalogElement Interface

**Scope**: Tasks 6.1.1 and 6.1.2 only. Wave 6.2 and 6.3 are unimplemented and excluded.
**Commit reviewed**: ecdc34a
**Date**: 2026-04-17

---

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 2 (6.1.1, 6.1.2) |
| Violations | 5 |
| Gaps | 1 |
| Weak tests | 1 |
| Legacy references | 4 |
| **Verdict** | **has-violations** |

---

## Violations

### V-01 — Compatibility shim: `mna-assembler.ts` callers to deleted interface methods (major)

**File**: `src/solver/analog/mna-assembler.ts`, lines 69–78, 105–107, 132, 158

**Rule violated**: rules.md — "No fallbacks. No backwards compatibility shims. No safety wrappers." and "All replaced or edited code is removed entirely. Scorched earth." Also CLAUDE.md: "No compatibility shims or type-asserted fallbacks during migrations."

**Evidence**:
```typescript
// line 69
if (iteration > 0 && prevVoltages !== undefined && el.shouldBypass?.(voltages, prevVoltages)) {

// line 72-78
el.stamp(this._solver);
if (el.isNonlinear && el.stampNonlinear) {
  el.stampNonlinear(this._solver);
}
if (el.isReactive && el.stampReactiveCompanion) {
  el.stampReactiveCompanion(this._solver);
}

// line 105-107
if (el.isNonlinear && el.updateOperatingPoint) {
  const limited = el.updateOperatingPoint(voltages, limitingCollector);

// line 132
if (!el.checkConvergence(voltages, prevVoltages, reltol, iabstol)) {

// line 158
if (!el.checkConvergence(voltages, prevVoltages, reltol, iabstol)) {
```

**Explanation**: Task 6.1.2 explicitly removed `stamp`, `stampNonlinear`, `updateOperatingPoint`, `stampCompanion`, `stampReactiveCompanion`, `shouldBypass` from the `AnalogElement` interface. Yet `mna-assembler.ts` — which was **not** listed as a "Files to modify" target in either 6.1.1 or 6.1.2 and was not updated — continues to call all of these deleted interface methods as if they still exist. This is a full suite of callers to deleted interface methods that were left in place.

Additionally, `checkAllConverged` (line 132) and `checkAllConvergedDetailed` (line 158) call the **old 4-argument** `checkConvergence(voltages, prevVoltages, reltol, iabstol)` signature. Task 6.1.2 changed this to `checkConvergence(ctx: LoadContext)`. These callers are incompatible with the new interface definition.

`mna-assembler.ts` is a compatibility shim: it implements the entire old dispatch protocol (stamp/stampNonlinear/stampReactiveCompanion/updateOperatingPoint/shouldBypass/checkConvergence-4-arg) against an interface that no longer declares those methods. The file was not cleaned up when the interface was redefined.

**Severity**: major

---

### V-02 — Runtime arity sniff in `ckt-context.ts` constructor (major)

**File**: `src/solver/analog/ckt-context.ts`, lines 563–565

**Rule violated**: rules.md — "No fallbacks. No backwards compatibility shims." The `typeof ... === "function"` runtime presence sniff on `checkConvergence` is a compatibility guard that exists to tolerate elements still on the old 4-argument interface.

**Evidence**:
```typescript
this.elementsWithConvergence = elements.filter(
  el => typeof (el as { checkConvergence?: unknown }).checkConvergence === "function",
);
```

**Explanation**: This runtime `typeof` sniff is the mechanism by which the engine identifies elements with `checkConvergence` at construction time. The interface (post-6.1.2) declares `checkConvergence?(ctx: LoadContext): boolean` as an optional method. However, all concrete element implementations still carry the old 4-argument form `(voltages, prevVoltages, reltol, iabstol)`. Because `tsc` is broken, no static type guarantee exists that elements in `elementsWithConvergence` actually implement the new single-argument form. The filter is effectively probing for "does the element have *any* function named `checkConvergence`" — which includes the old-form implementations — and then `mna-assembler.ts` calls them with 4 arguments (V-01 above). This runtime sniff is the runtime side of the arity-mismatch compatibility shim chain.

**Severity**: major

---

### V-03 — `state-pool.ts` `(el as any).refreshSubElementRefs` type-asserted runtime method sniff (major)

**File**: `src/solver/analog/state-pool.ts`, lines 95–97

**Rule violated**: rules.md — "No fallbacks. No backwards compatibility shims." memory feedback: "Never create compatibility shims or type-asserted fallbacks during migrations."

**Evidence**:
```typescript
if (typeof (el as any).refreshSubElementRefs === 'function') {
  (el as any).refreshSubElementRefs(s0, s1, s2, s3, s4, s5, s6, s7);
}
```

**Explanation**: `refreshSubElementRefs` is declared as an optional method on `PoolBackedAnalogElementCore` in `element.ts` (line 238). The correct call pattern would be `(el as PoolBackedAnalogElementCore).refreshSubElementRefs?.(...)` after a type-narrowed `isPoolBacked(el)` check. Instead, the code casts to `any` and performs a runtime `typeof` presence sniff. The `as any` cast suppresses TypeScript's ability to check the call, and the `typeof` check is a runtime compatibility guard that exists to tolerate implementations that may or may not carry the method. This is a type-asserted fallback shim, not a clean typed optional-method call.

**Severity**: major

---

### V-04 — Broken TypeScript compilation admitted without spec carve-out (critical)

**File**: `spec/progress.md`, lines 302 and 310 (self-reported); root violation in `src/solver/analog/element.ts` (the new interface) combined with all ~65 unmodified element implementations.

**Rule violated**: Phase spec line 9: "Wave 6.3 cannot begin until every Wave 6.2 task has landed AND a full-codebase `tsc --noEmit` passes — this is the atomic-migration gate. No shims, no coexistence period." The spec states "No shims, no coexistence period" as the phase invariant. It does NOT grant a carve-out permitting a tsc-broken codebase after Wave 6.1 lands. The `tsc --noEmit` gate is described as the Wave 6.3 entry condition, not as something that is acceptable to be broken between 6.1 and 6.2.

The spec states (line 5, Phase 6 overview): "All ~65 analog element implementations rewritten atomically. No compatibility shims, no coexistence period."

The progress.md notes (line 302 and 365) state "Codebase-wide tsc breakage is INTENTIONAL" — but this is an implementer's self-justification. The implementer's note does **not** override the spec. The phase spec does not contain any phrase like "tsc may be broken between Wave 6.1 and Wave 6.2" or any equivalent carve-out. The only tsc-clean gate mentioned is Wave 6.3 entry; no explicit permission is given for a broken state between 6.1 and 6.2.

**Evidence** (progress.md lines 302, 310, 365):
```
Codebase-wide tsc breakage after this wave is INTENTIONAL — Wave 6.2 migrates all ~65 element implementations.
...
Codebase-wide tsc breakage is INTENTIONAL — pending Wave 6.2 atomic migration of all element implementations.
...
Codebase-wide tsc remains intentionally broken from Task 6.1.2 interface change.
```

**Severity**: critical

---

### V-05 — Historical-provenance comment in `ckt-context.ts` (minor)

**File**: `src/solver/analog/ckt-context.ts`, line 148

**Rule violated**: rules.md — "No commented-out code. No `# previously this was...` comments." and "Comments exist ONLY to explain complicated code to future developers. They never describe what was changed, what was removed, or historical behaviour."

**Evidence**:
```typescript
/**
 * MNA matrix assembler (hoisted to ctx in Phase 1, deleted in Phase 2 Wave 2.2
 * when cktLoad replaces stampAll).
 */
assembler: MNAAssembler = null!;
```

**Explanation**: The JSDoc for `assembler` describes historical migration history ("hoisted to ctx in Phase 1") and a future planned deletion ("deleted in Phase 2 Wave 2.2"). Both are historical-provenance annotations. The comment describes what was done in Phase 1 and what will happen in Phase 2 — neither of which explains the code to a future developer. This pattern is explicitly banned. The comment also implies `assembler` is transitional code scheduled for deletion, which makes it a dead-code marker per the rules.

**Severity**: minor

---

## Gaps

### G-01 — Task 6.1.2 acceptance criterion: spec-required test not implemented

**Spec requirement** (phase-6-model-rewrites.md, Task 6.1.2 Tests section):
> "Compilation must succeed with all ~65 elements implementing the new interface (this is enforced by TypeScript after Task 6.2.*)."

This is listed under Task 6.1.2 Tests as the enforcement mechanism. However, the spec's **Acceptance criteria** state:
> "`AnalogElement` interface has `load()` as the primary hot-path method."
> "No `stamp()`, `stampNonlinear()`, `updateOperatingPoint()`, `stampCompanion()`, `stampReactiveCompanion()` in the interface."

The interface itself satisfies these two criteria. However, the spec also states (Wave 6.1 description, line 115):
> "The NR-loop caller in `newton-raphson.ts` must be updated to pass `ctx.loadCtx` instead of the four-argument tuple."

This caller update is noted as part of Task 6.1.2's scope ("This caller update is handled as part of Phase 2 Task 2.2.2's 'Files to modify' for `newton-raphson.ts`"). However, `mna-assembler.ts:checkAllConverged` and `checkAllConvergedDetailed` call `el.checkConvergence(voltages, prevVoltages, reltol, iabstol)` with the old 4-argument form — and `mna-assembler.ts` was **not** listed as a Wave 6.2 file to modify. This means there is no planned wave to fix these callers.

**What was found**: `mna-assembler.ts` is not listed in any Wave 6.2 task's "Files to modify" list. Its old-signature callers for `checkConvergence`, `stamp`, `stampNonlinear`, `updateOperatingPoint`, `stampReactiveCompanion`, and `shouldBypass` will remain broken after Wave 6.2 lands unless `mna-assembler.ts` is added to the migration scope.

**File**: `src/solver/analog/mna-assembler.ts`

---

## Weak Tests

### WT-01 — `ckt-context.test.ts::loadCtx_fields_populated` — weak type assertions instead of value assertions

**Test path**: `src/solver/analog/__tests__/ckt-context.test.ts::CKTCircuitContext::loadCtx_fields_populated`

**Problem**: The spec requires: "Assert all LoadContext fields are defined and have correct types/defaults." For several fields, the test asserts only that the value has the correct JavaScript type (`typeof lc.isDcOp === "boolean"`, `typeof lc.isTransient === "boolean"`, `typeof lc.uic === "boolean"`, `typeof lc.xfact === "number"`) without asserting the actual default value. These fields have known correct defaults: `isDcOp` must be `false`, `isTransient` must be `false`, `uic` must be `false`, `xfact` must be `0`.

**Evidence**:
```typescript
// line 318-320
expect(typeof lc.isDcOp).toBe("boolean");
expect(typeof lc.isTransient).toBe("boolean");
// ...
// line 322-323
expect(typeof lc.xfact).toBe("number");
// ...
// line 329-330
expect(typeof lc.uic).toBe("boolean");
```

None of these assert the actual default values. A LoadContext that initializes `isDcOp = true` or `xfact = 999` would pass these assertions. The spec acceptance criterion is "correct types/defaults" — the defaults are not verified.

---

## Legacy References

### LR-01 — `mna-assembler.ts:69` — call to deleted interface method `shouldBypass`

**File**: `src/solver/analog/mna-assembler.ts`, line 69

```typescript
if (iteration > 0 && prevVoltages !== undefined && el.shouldBypass?.(voltages, prevVoltages)) {
```

`shouldBypass` was deleted from `AnalogElement` by Task 6.1.2 (spec line 110: "removed (ngspice bypass is device-internal, not interface-level)"). This call references a method that no longer exists on the interface.

---

### LR-02 — `mna-assembler.ts:72,73,74,76,77` — calls to deleted interface methods `stamp`, `stampNonlinear`, `stampReactiveCompanion`

**File**: `src/solver/analog/mna-assembler.ts`, lines 72–78

```typescript
el.stamp(this._solver);
if (el.isNonlinear && el.stampNonlinear) {
  el.stampNonlinear(this._solver);
}
if (el.isReactive && el.stampReactiveCompanion) {
  el.stampReactiveCompanion(this._solver);
}
```

All three methods (`stamp`, `stampNonlinear`, `stampReactiveCompanion`) were deleted from `AnalogElement` by Task 6.1.2 (spec lines 102–106). These calls reference methods that no longer exist on the interface.

---

### LR-03 — `mna-assembler.ts:105,106` — call to deleted interface method `updateOperatingPoint`

**File**: `src/solver/analog/mna-assembler.ts`, lines 105–106

```typescript
if (el.isNonlinear && el.updateOperatingPoint) {
  const limited = el.updateOperatingPoint(voltages, limitingCollector);
```

`updateOperatingPoint` was deleted from `AnalogElement` by Task 6.1.2 (spec line 104: "absorbed into `load()`"). This call references a method that no longer exists on the interface.

---

### LR-04 — `mna-assembler.ts:132,158` — calls to `checkConvergence` with old 4-argument signature

**File**: `src/solver/analog/mna-assembler.ts`, lines 132, 158

```typescript
// line 132
if (!el.checkConvergence(voltages, prevVoltages, reltol, iabstol)) {
// line 158
if (!el.checkConvergence(voltages, prevVoltages, reltol, iabstol)) {
```

Task 6.1.2 changed `checkConvergence` from `(voltages, prevVoltages, reltol, iabstol)` to `(ctx: LoadContext)` (spec line 114). These callers still use the deleted 4-argument form. `reltol` and `iabstol` are now fields on `LoadContext` per Task 6.1.1. These are stale references to the removed API signature.

---

## Notes on Scope Boundary

Wave 6.2 (element rewrites) and Wave 6.3 (test infra / dead-code deletion) are excluded per the review scope boundary. The violations and legacy references above are the direct consequence of Task 6.1.2 landing without cleaning up callers in `mna-assembler.ts`. The spec does not list `mna-assembler.ts` as a file to modify in any Wave 6.2 task, creating a coverage gap (G-01).

The `preIterationHook` field on `CKTCircuitContext` (line 355) is noted as future dead code per the spec (it "was kept alive through Phase 5 intentionally; Wave 6.2 load() absorbs its responsibility, making it dead code after Wave 6.2 completes. Its removal is part of Wave 6.3"). This is correctly scoped to Wave 6.3 and is NOT a Wave 6.1 violation — no finding raised.
