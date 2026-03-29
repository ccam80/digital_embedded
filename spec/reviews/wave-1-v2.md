# Review Report: Wave 1 — Registry Rename + Code Health (v2)

## Summary

- **Tasks reviewed**: 2 (W1.1 Rename TransistorModelRegistry → SubcircuitModelRegistry, W1.2 Code health — delete shims and dead code)
- **Violations**: 5 (0 critical, 2 major, 3 minor)
- **Gaps**: 0
- **Weak tests**: 0
- **Legacy references**: 2
- **Verdict**: has-violations

---

## Violations

### V1 — Historical-provenance comment (major)

**File**: `src/components/wiring/splitter.ts:207`
**Rule**: "No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned." (rules.md)
**Evidence**:
```typescript
  // Legacy accessors used by engine consumers
  get parts(): number[] { return this.outputPorts.map((p) => p.bits); }
  get totalBits(): number { return totalBitsFromPattern(this.parts); }
```
The comment `// Legacy accessors used by engine consumers` is a historical-provenance comment. It describes that these accessors exist for backwards-compatibility reasons ("legacy"). This is exactly the pattern the rule bans. The comment also signals that these accessors may be shims themselves that should have been deleted or cleaned up in W1.2. The spec explicitly lists splitter.ts in the W1.2 scope. Whether these accessors are actually dead code or genuinely needed is a separate question — the comment is a violation regardless.
**Severity**: major

---

### V2 — Banned sub-mode string "analog-pins" in production code (major)

**File**: `src/editor/property-panel.ts:273`
**Rule**: Extra review instructions: "analog-pins should be GONE." The v2 spec states the old sub-mode strings (`"logical"`, `"analog-pins"`, `"analog-internals"`) are replaced by the `resolveComponentRoute()` discriminated union — they should not appear as string literals in production logic.
**Evidence**:
```typescript
    const defaultMode = def.defaultModel ?? modes[0] ?? "analog-pins";
```
This uses `"analog-pins"` as a hard-coded fallback default model key. If `def.defaultModel` is absent and `modes` is empty (length 0 after the `<= 1` guard has already passed — which cannot actually happen, but the triple-fallback is defensive), the fallback is a stale sub-mode string that the v2 compiler does not recognise as a valid model key. Even if the dead branch is unreachable in practice, the banned string `"analog-pins"` must not exist in production logic.
**Severity**: major

---

### V3 — Stale "analog-pins" in JSDoc comment (minor)

**File**: `src/editor/property-panel.ts:259`
**Rule**: "No historical-provenance comments." The JSDoc comment still describes behavior using the removed sub-mode name.
**Evidence**:
```typescript
   * Default is "analog-pins" (read at call time, never persisted on the element
   * until the user changes it).
```
The comment describes `"analog-pins"` as the default. This is now wrong and references a removed sub-mode string. Comments must not describe historical behavior.
**Severity**: minor

---

### V4 — "workaround" banned word in comment (minor)

**File**: `src/solver/digital/__tests__/two-phase.test.ts:346`
**Rule**: "Any comment containing words like 'workaround' … is banned." (reviewer.md posture section)
**Evidence**:
```typescript
    //    _values array is not directly accessible, but we can use a workaround:
    //    set A's Q output net to 1, set state slot for A to 1 manually.
```
The word "workaround" appears in a test comment. This is a banned word per posture rules, indicating the test uses an indirect approach rather than a clean test path.
**Severity**: minor

---

### V5 — "for now" banned phrase in production comment (minor)

**File**: `src/io/dig-serializer.ts:156`
**Rule**: "Any comment containing words like … 'for now' … is banned." (reviewer.md posture section)
**Evidence**:
```typescript
      // Custom shapes are complex; preserve as empty for now
```
The phrase "for now" signals deferred work. Per rules.md: "Never mark work as deferred, TODO, or 'not implemented.'"
**Severity**: minor

---

## Gaps

None found.

---

## Weak Tests

None found.

The previously-skipped tests in `src/fixtures/__tests__/shape-audit.test.ts` and `src/fixtures/__tests__/fixture-audit.test.ts` were verified: no `it.skip`, `test.skip`, or `describe.skip` present in either file. The skip removal from W1.2 was completed.

---

## Legacy References

### L1 — Stale sub-mode string "analog-pins" as runtime default

**File**: `src/editor/property-panel.ts:273`
**Evidence**:
```typescript
const defaultMode = def.defaultModel ?? modes[0] ?? "analog-pins";
```
`"analog-pins"` is a removed sub-mode string. It should not appear in any runtime path.

---

### L2 — Stale sub-mode reference "analog-pins" in test comments (analog-compiler.test.ts)

**File**: `src/solver/analog/__tests__/analog-compiler.test.ts:379,385,396`
**Evidence**:
```typescript
    // Set mode to 'analog-pins' explicitly and
    // verify the factory IS called — proving that without the explicit
    // property the compiler would NOT have taken the analog-pins path.
    ...
    expect(spy1).toHaveBeenCalledOnce(); // explicit analog-pins → factory called
    ...
    // simulationModel explicitly set to 'analog-pins' → compiles normally
```
The actual test code sets `simulationModel` to `"behavioral"` — the comments still reference the removed `"analog-pins"` sub-mode string. These are stale references in test comments describing old behavior that no longer applies. The description misrepresents what the test actually does.

---

## Positive Findings (informational)

The following W1.1 and W1.2 deliverables were verified clean:

- `src/solver/analog/transistor-model-registry.ts` — deleted (confirmed absent)
- `TransistorModelRegistry` — zero references in `src/` (confirmed)
- `registerAllCmosGateModels` — zero references in `src/` (confirmed)
- `registerBuiltinSubcircuitModels` — present in `cmos-gates.ts` and called from `default-models.ts` (correct)
- `src/solver/analog/subcircuit-model-registry.ts` — created, contains `SubcircuitModelRegistry` class (correct)
- `src/editor/wire-merge.ts` — deleted (confirmed absent)
- `src/editor/pin-voltage-access.ts` — deleted (confirmed absent); all remaining `pin-voltage-access` imports correctly target `../../core/pin-voltage-access.js`
- `AnalogScopePanel` alias — absent from `src/runtime/analog-scope-panel.ts` (confirmed)
- `parseSplittingPattern` — absent from `src/components/wiring/splitter.ts` (confirmed)
- `show()` overload — absent from `src/editor/context-menu.ts`; only `showItems()` exists (confirmed)
- `DeviceType` re-export — absent from `src/solver/analog/model-parser.ts`; file imports `DeviceType` from `../../core/analog-types.js` and does not re-export it (confirmed)
- `it.skip` in shape-audit.test.ts and fixture-audit.test.ts — both files have no skipped tests (confirmed)
- `subcircuitModel` field — zero references in `src/` as a model field (confirmed; only `_subcircuitModels` variable name in `default-models.ts`, which is a local `SubcircuitModelRegistry` instance)
- `requiresBranchRow` — zero references in `src/` (confirmed)
