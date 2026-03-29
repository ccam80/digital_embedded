# Review Report: Post-Fix Recheck — Foundations (Waves 0, 1, 2)

## Summary

| Field | Value |
|-------|-------|
| Scope | Recheck of all Wave 0, 1, 2 violation fixes across foundations |
| Violations | 7 |
| Gaps | 1 |
| Weak tests | 1 |
| Legacy references | 0 |
| Verdict | has-violations |

---

## Violations

### V1 — Banned word "workaround" in test comment

**File**: `src/solver/digital/__tests__/snapshot.test.ts:159`
**Rule**: rules.md bans "workaround" in comments.
**Evidence**: `// workaround: use a circuit that writes specific values per step iteration).`
**Severity**: minor

---

### V2 — Banned word "workaround" in test comment

**File**: `src/solver/digital/__tests__/two-phase.test.ts:346`
**Rule**: rules.md bans "workaround" in comments.
**Evidence**: `//    _values array is not directly accessible, but we can use a workaround:`
**Severity**: minor

---

### V3 — Historical-provenance comment: "previously this was"

**File**: `src/solver/analog/__tests__/spice-model-overrides.test.ts:293`
**Rule**: rules.md bans historical-provenance comments describing what code used to do.
**Evidence**:
```
// Override IS to exactly DIODE_DEFAULTS.IS (1e-14) — previously this was
// indistinguishable from "no override" in the lossy-diff approach.
```
**Severity**: minor

---

### V4 — Power pin visibility hardcoded to "cmos" key instead of generic subcircuitRefs check

**Files**: `src/components/gates/and.ts:57`, `src/components/gates/or.ts:57`,
`src/components/gates/nand.ts:55`, `src/components/gates/nor.ts:57`,
`src/components/gates/not.ts:77`, `src/components/gates/xor.ts:57`,
`src/components/gates/xnor.ts:57`, `src/components/flipflops/d.ts:143`

**Rule**: Spec compliance. model-unification-v2.md "Model-dependent pin visibility" specifies the check must be generic:
```typescript
if (activeModel && def.subcircuitRefs?.[activeModel]) {
```
Any model key present in subcircuitRefs should trigger power pin display.

**Evidence** (identical in all 8 files):
```typescript
const activeModel = this._properties.getOrDefault<string>("simulationModel", "");
if (activeModel === "cmos") {
```

The hardcoded string "cmos" means power pins only appear for the built-in CMOS key. If a user assigns a subcircuit definition under a different key via subcircuitBindings (e.g. "74HC"), that instance will have no power pins in getPins() and cannot be wired. The spec extensibility guarantee is violated.

**Severity**: major

---

### V5 — "logical" used as simulationModel value on real And component in MCP test

**File**: `src/headless/__tests__/digital-pin-loading-mcp.test.ts:157`, `:173`, `:189`

**Rule**: Spec compliance. "logical" was a removed sub-mode string, not a valid model key. The And component from createDefaultRegistry() has valid keys: "digital", "behavioral", "cmos". Setting simulationModel: "logical" is invalid per spec.

Per model-unification-v2.md: "logical" and "analog-pins" were replaced by the discriminated union in resolveComponentRoute(). They are not model keys. getActiveModelKey() should throw for this value.

**Evidence**: `{ simulationModel: "logical" }` applied to a real And element from createDefaultRegistry().

If these tests pass, either: (a) "logical" is silently ignored instead of throwing, meaning getActiveModelKey() is not spec-compliant, or (b) the compile path does not exercise getActiveModelKey() for these elements, meaning the test does not exercise what it claims. Valid test data must use "digital" or "behavioral".

**Severity**: major

---

### V6 — "logical" as model key name in stub ComponentDefinition in test

**File**: `src/editor/__tests__/property-panel-spice.test.ts:143-155`

**Rule**: Code hygiene. Using the removed sub-mode name "logical" as an arbitrary stub model key perpetuates stale terminology from the old architecture.

**Evidence**:
```typescript
function makeLogicalGateDef(): ComponentDefinition {
  return {
    defaultModel: "logical",
    models: { logical: {} as never },
  } as unknown as ComponentDefinition;
}
```
**Severity**: minor

---

### V7 — Digital compiler kind filter absent from inputSchema-driven path

**File**: `src/solver/digital/compiler.ts:334-342`

**Rule**: Spec compliance. model-unification-v2.md "PinDeclaration.kind field" states the filter predicate `pinDecl.kind === "signal"` must be applied in the pin-to-slot matching logic.

Fallback paths (no schema) at lines 357, 369, 387, 390 apply the filter explicitly with `if (ref.kind === "power") continue`. The schema-driven path at lines 334-342 resolves pins by label match only — no kind filter:

```typescript
if (resolvedInputSchema) {
  for (const label of resolvedInputSchema) {
    const refIdx = refs.findIndex(r => r.pinLabel === label);
    if (refIdx >= 0) {
      inputs.push(slotToNetId(i, refIdx));
    }
    // no kind filter — power pins excluded implicitly only
  }
}
```

Power pins are excluded implicitly (not listed in any digital schema) rather than explicitly. The explicit filter mandated by the spec is absent from this code path.

**Severity**: minor

---

## Gaps

### G1 — getPins() power pin check not data-driven from subcircuitRefs

**Spec requirement** (model-unification-v2.md, "Model-dependent pin visibility"):
```typescript
if (activeModel && def.subcircuitRefs?.[activeModel]) {
  basePins.push(VDD pin, GND pin);
}
```

**What was found**: All 8 affected components use `if (activeModel === "cmos")`. The generic check `def.subcircuitRefs?.[activeModel]` was not implemented. Power pins only appear for the hard-coded "cmos" key, not for any user-imported subcircuit definition assigned under a different model key via subcircuitBindings.

**Files**: src/components/gates/and.ts, or.ts, nand.ts, nor.ts, xor.ts, xnor.ts, not.ts, src/components/flipflops/d.ts

---

## Weak Tests

### WT1 — Value assertion too weak: not.toBe("") instead of exact value

**Test path**: `src/editor/__tests__/property-panel-spice.test.ts::showSpiceModelParameters::populates input value from stored _spiceModelOverrides`

**Evidence**:
```typescript
const isInput = inputs[0];
expect(isInput).toBeDefined();
expect(isInput!.value).not.toBe("");
```

The stored override is `{ IS: 1e-14 }`. The assertion should be `expect(isInput!.value).toBe("1e-14")`. A bug that renders any non-empty string passes this test. Flagged in model-unification-v2.md "Weak test assertions" section as requiring specific value assertions.

**Severity**: minor

---

## Legacy References

None found.

---

## Items Verified Clean

1. **src/core/pin.ts**: `kind` required (not optional), type is `"signal" | "power"`. Correct.
2. **All PinDeclaration literals in src/components/**: Exhaustive scan found zero PinDeclaration objects missing `kind`. All 487 static declarations have `kind`. Correct.
3. **Gate appendPowerPins()**: Helper in gate-shared.ts, used by all 8 gates, power pins use `kind: "power"`. Mechanically correct (condition hardcoded — see V4/G1).
4. **Digital compiler fallback paths**: `if (ref.kind === "power") continue` at lines 357, 369, 387, 390. Correct.
5. **src/core/registry.ts**: MnaModel.factory required; no subcircuitModel field; branchCount present; subcircuitRefs on ComponentDefinition; getActiveModelKey handles subcircuitRefs keys; availableModels includes subcircuitRefs keys. All correct.
6. **src/core/circuit.ts**: subcircuitBindings JSDoc correctly says "ComponentType:modelKey" format. Correct.
7. **TransistorModelRegistry rename**: Zero references to TransistorModelRegistry, registerAllCmosGateModels, or transistor-model-registry import paths in src/. File does not exist. Correct.
8. **requiresBranchRow**: Zero occurrences in src/. Correct.
9. **subcircuitModel as field name**: Zero occurrences in src/solver/. Correct.
10. **src/editor/wire-merge.ts**: File does not exist. Correct.
11. **src/editor/pin-voltage-access.ts**: File does not exist. Correct.
12. **AnalogScopePanel alias**: Zero occurrences. Correct.
13. **parseSplittingPattern**: Zero occurrences. Correct.
14. **show() overload in context-menu.ts**: Only showItems() exists, no show() overload. Correct.
15. **DeviceType re-export in model-parser.ts**: import type for own use only, no re-export. Correct.
16. **it.skip in shape-audit/fixture-audit tests**: Zero occurrences. Correct.
17. **"analog-pins" in property-panel.ts**: Zero occurrences. Correct.
18. **"logical" in property-panel.ts production code**: Zero occurrences. Correct.
19. **AnalogModel interface**: No such interface. Only hasAnalogModel utility function. Correct.
20. **DiagnosticCode unresolved-model-ref**: Present in src/compile/types.ts:38 and src/core/analog-types.ts:198. Correct.
21. **"analog-pins" in flatten-pipeline-reorder.test.ts**: Used as invalid-key test data asserting the rejection path. Correct.
