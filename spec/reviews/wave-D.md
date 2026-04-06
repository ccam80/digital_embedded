# Review Report: Wave D — MOSFET Finalisation

## Summary

| Field | Value |
|-------|-------|
| Tasks reviewed | 2 (WD1, WD2) |
| Files reviewed | 3 (fet-base.ts, mosfet.ts, fet-base.test.ts) |
| Violations | 1 minor |
| Gaps | 0 |
| Weak tests | 4 (all pre-existing, not introduced by Wave D) |
| Legacy references | 0 |
| Verdict | has-violations |

---

## Violations

### V1 — Minor

**File**: `src/solver/analog/fet-base.ts`, lines 78–104
**Rule violated**: Spec §5.3 executor follow-up paragraph — "Immediately above that block, insert a `defineStateSchema` call"
**Evidence**:

```
// Lines 50–76: SLOT constants block
export const SLOT_VGS       = 0;
// ... (25 constants)
export const SLOT_GMBS                  = 24;

// Lines 78–104: FET_BASE_SCHEMA — defined AFTER the slot constants, not above them
export const FET_BASE_SCHEMA: StateSchema = defineStateSchema("AbstractFetElement", [
```

**Detail**: The spec states `FET_BASE_SCHEMA` should be inserted "Immediately above that block" (the SLOT constants block). The implementation places `FET_BASE_SCHEMA` after the slot constants. Functionally equivalent because the schema uses string slot names rather than the numeric constants — no runtime impact — but the placement does not match the spec instruction.

---

## Gaps

None found.

All spec requirements for Wave D are satisfied:

- All 25 `const SLOT_*` declarations in `fet-base.ts` have been made `export`. Confirmed: no unexported SLOT_ constants remain.
- `FET_BASE_SCHEMA` declared with all 25 slots, correct `init` values: `GM`/`GDS` = `{ kind: "constant", value: 1e-12 }`, `VGS_PREV`/`VGD_PREV` = `{ kind: "constant", value: NaN }`, `CAP_JUNCTION_FIRST_CALL`/`CAP_GB_FIRST_CALL` = `{ kind: "constant", value: 1.0 }`, all others `{ kind: "zero" }`. Verified at lines 78–104.
- `AbstractFetElement` class declares `readonly stateSchema = FET_BASE_SCHEMA` and `readonly stateSize = FET_BASE_SCHEMA.size`, replacing hardcoded `stateSize: number = 25`. Verified at lines 143–144.
- `initState` body replaced with single `applyInitialValues(FET_BASE_SCHEMA, pool, this.stateBaseOffset, {})` call. Verified at line 149.
- All 25 `static readonly SLOT_*` class mirrors on `AbstractFetElement` deleted. Confirmed: git diff shows 25 removals, 0 re-additions.
- All `AbstractFetElement.SLOT_*` references in `mosfet.ts` rewritten to use the 13 imported module-scope constants. Confirmed: no `AbstractFetElement.SLOT_` references remain anywhere in `src/`.
- Named imports of the 13 required constants added at the top of `mosfet.ts`. Verified in diff.
- `mosfet.ts` `_vsb`/`_gmbs` getter/setter pairs updated to use `SLOT_VSB`/`SLOT_GMBS`. Verified.
- All capacitor companion block references in `mosfet.ts` `updateCompanion` updated. Verified.

---

## Weak Tests

The following weak assertions are present in `fet-base.test.ts` but were NOT introduced by Wave D — all pre-existing (confirmed: none appear in the `+` side of the Wave D diff). Reported for completeness.

### WT1

**Test path**: `src/solver/analog/__tests__/fet-base.test.ts::Refactor::nmos_transient_unchanged`
**Problem**: Trivially weak — only checks the method is not undefined, asserts nothing about behavioural output.
**Evidence**: `expect(element.stampCompanion).toBeDefined();`

### WT2

**Test path**: `src/solver/analog/__tests__/fet-base.test.ts::Refactor::nmos_transient_unchanged`
**Problem**: Tests only that no exception is thrown. Asserts nothing about what the companion model computed.
**Evidence**: `expect(() => element.stampCompanion!(dt, "bdf1", voltages)).not.toThrow();`

### WT3

**Test path**: `src/solver/analog/__tests__/fet-base.test.ts::Refactor::nmos_transient_unchanged`
**Problem**: Tests only absence of exception. No assertion on stamp values.
**Evidence**: `expect(() => element.stamp(solver)).not.toThrow();`

### WT4

**Test path**: `src/solver/analog/__tests__/fet-base.test.ts::AbstractFetElement::createMosfetElement_returns_AbstractFetElement_instance`
**Problem**: Structural type check only. No behavioural content verified.
**Evidence**: `expect(element).toBeInstanceOf(AbstractFetElement);`

---

## Legacy References

None found.

No `AbstractFetElement.SLOT_*` references remain in the `src/` tree. No shims, no re-exports, no deprecated wrappers, no feature flags.

---

## Notes

**Pre-existing "backward compat" comment in `mosfet.ts`** (line 1018):

```
/** Read a model param, returning `fallback` if the key is absent (backward compat). */
function mp(key: string, fallback: number): number {
  return props.hasModelParam(key) ? props.getModelParam<number>(key) : fallback;
}
```

This comment and function pre-date Wave D (present at commit `e2f290b`). Out of scope for this review, but flagged for follow-up: the `mp()` function is a backwards-compatibility shim that silently returns a fallback when a model param is absent. Both the comment (contains "backward compat") and the function (is a fallback shim) violate the "no fallbacks, no backwards compatibility shims" rule. Not attributed to Wave D.
