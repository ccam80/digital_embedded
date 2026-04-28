# Review Report: Batch 2 — Semiconductors + Switching (2.B.* part 1)

**Scope:** task_groups 2.B.bjt, 2.B.mosfet, 2.B.jfet, 2.B.diode, 2.B.semi-misc, 2.B.thyristor-fgnfet, 2.B.fgpfet-sw, 2.B.relay-fets

**Files reviewed:**
- `src/components/semiconductors/bjt.ts`
- `src/components/semiconductors/mosfet.ts`
- `src/components/semiconductors/njfet.ts`
- `src/components/semiconductors/pjfet.ts`
- `src/components/semiconductors/diode.ts`
- `src/components/semiconductors/zener.ts`
- `src/components/semiconductors/tunnel-diode.ts`
- `src/components/semiconductors/varactor.ts`
- `src/components/semiconductors/schottky.ts`
- `src/components/semiconductors/diac.ts`
- `src/components/semiconductors/scr.ts`
- `src/components/semiconductors/triac.ts`
- `src/components/semiconductors/triode.ts`
- `src/components/switching/fgnfet.ts`
- `src/components/switching/fgpfet.ts`
- `src/components/switching/switch.ts`
- `src/components/switching/switch-dt.ts`
- `src/components/switching/relay.ts`
- `src/components/switching/relay-dt.ts`
- `src/components/switching/nfet.ts`
- `src/components/switching/pfet.ts`
- `src/components/switching/trans-gate.ts`
- `src/components/semiconductors/__tests__/bjt.test.ts`
- `src/components/semiconductors/__tests__/tunnel-diode.test.ts`
- `src/components/semiconductors/__tests__/spice-model-overrides-prop.test.ts`

---

## Summary

| Category | Count |
|---|---|
| Tasks reviewed | 8 |
| Violations | 4 |
| Gaps | 0 |
| Weak tests | 2 |
| Legacy references | 3 |

**Verdict: has-violations**

---

## Violations

### V-1 — Historical-provenance comment: relay.ts line 180

**File:** `src/components/switching/relay.ts:180`
**Rule:** rules.md — "Historical-provenance comments are dead-code markers. Any comment containing words like … 'migrated from' … The comment exists because an agent left dead or transitional code in place."
**Severity:** major

**Evidence:**
```
// RelayAnalogElement — W3 migrated composite class
```

The phrase "W3 migrated" is a historical-provenance marker: it records which wave produced this class, not what the class does. This is explicitly banned per rules.md. The class itself is fully implemented (not dead code), but the comment records the history of the refactor rather than explaining the code to future developers.

---

### V-2 — Historical-provenance comment: bjt.test.ts line 2018

**File:** `src/components/semiconductors/__tests__/bjt.test.ts:2018`
**Rule:** rules.md — "Comments exist ONLY to explain complicated code to future developers. They never describe what was changed, what was removed, or historical behaviour."
**Severity:** major

**Evidence:**
```typescript
// SUBS was previously declared as an instance param; it is now expressed as
// separate ModelEntry rows ("spice" = vertical, "spice-lateral" = lateral)
// in NpnBJTDefinition / PnpBJTDefinition modelRegistry. The factory captures
// `isLateral` as a closure constant via createBjtL1Element(polarity, isLateral).
```

This comment describes what SUBS "was previously" and how it was refactored. It is a historical-provenance comment describing a migration, not an explanation of how the current code works. The words "previously declared" and "is now expressed as" describe a before/after transformation, which is explicitly banned.

---

### V-3 — Historical-provenance comment: tunnel-diode.test.ts line 604

**File:** `src/components/semiconductors/__tests__/tunnel-diode.test.ts:604`
**Rule:** rules.md — "Historical-provenance comments are dead-code markers. Any comment containing words like … 'migrated from' …"
**Severity:** major

**Evidence:**
```typescript
// Step 3a: IBEQ/IBSW/NB migrated from plain Diode into TunnelDiode's secondary group.
```

The phrase "migrated from" is in the explicit banned-word list. The comment describes a refactoring step, not the current behavior. Whether or not the code it sits above is functional, the comment itself violates the ban on historical-provenance language.

---

### V-4 — Historical-provenance comment: tunnel-diode.test.ts line 614

**File:** `src/components/semiconductors/__tests__/tunnel-diode.test.ts:614`
**Rule:** rules.md — "Any comment containing words like … 'migrated from' …"
**Severity:** major

**Evidence:**
```typescript
// Step 3a: IBEQ/IBSW/NB migrated from plain Diode (dioload.c:267-285).
```

Same violation as V-3: "migrated from" describes the history of parameter movement. The "Step 3a:" prefix further identifies this as a wave-execution log note embedded as a code comment. Both aspects are banned.

---

## Gaps

None found.

---

## Weak Tests

### WT-1 — spice-model-overrides-prop.test.ts: bare .toBeDefined() assertions without content checks

**Test path:** `src/components/semiconductors/__tests__/spice-model-overrides-prop.test.ts`
**Issue:** Multiple assertions use `toBeDefined()` as the sole check, which is a trivially-true guard that provides no coverage of shape or correctness.

**Evidence:**
```typescript
it(`${def.name}: has modelRegistry with default model entry`, () => {
  expect(def.modelRegistry).toBeDefined();
  expect(def.modelRegistry![modelKey]).toBeDefined();
});

it(`${def.name}: default model entry has params record`, () => {
  expect(def.modelRegistry![modelKey]!.params).toBeDefined();
  expect(typeof def.modelRegistry![modelKey]!.params).toBe("object");
});
```

The first `it` block does nothing but verify that a key exists. The second verifies only that `params` is not undefined and is an object — it does not check any param key or value. Per rules.md: "Test assertions that are trivially true (e.g. `assert result is not None`, `assert isinstance(x, dict)` without checking contents)" are flagged.

---

### WT-2 — spice-model-overrides-prop.test.ts: obfuscated key construction hides intent

**Test path:** `src/components/semiconductors/__tests__/spice-model-overrides-prop.test.ts::legacy model override property does not appear in propertyDefs`
**Issue:** The legacy key is constructed via string concatenation to avoid direct string appearance.

**Evidence:**
```typescript
const legacyKey = ["_spice", "Model", "Overrides"].join("");
```

This is test-internal obfuscation: the test verifies that `_spiceModelOverrides` is absent, but constructs the key string by joining fragments rather than writing it directly. This is a code-hygiene concern — it makes the assertion harder to understand and resembles a workaround for a lint or search rule. The test should use a plain string literal.

---

## Legacy References

### LR-1 — relay.ts line 180: "W3 migrated" historical-provenance marker

**File:** `src/components/switching/relay.ts:180`
**Evidence:**
```
// RelayAnalogElement — W3 migrated composite class
```

"W3 migrated" is a wave-execution reference identifying when this class was written. This is a historical-provenance comment per rules.md Section "Code Hygiene". See also V-1 above.

---

### LR-2 — bjt.test.ts line 2018: "previously declared" provenance comment

**File:** `src/components/semiconductors/__tests__/bjt.test.ts:2018`
**Evidence:**
```
// SUBS was previously declared as an instance param; it is now expressed as
```

Contains "previously" — explicit banned word in historical-provenance list. See also V-2 above.

---

### LR-3 — tunnel-diode.test.ts lines 604, 614: "migrated from" provenance comments

**File:** `src/components/semiconductors/__tests__/tunnel-diode.test.ts:604` and `:614`
**Evidence:**
```
// Step 3a: IBEQ/IBSW/NB migrated from plain Diode into TunnelDiode's secondary group.
// Step 3a: IBEQ/IBSW/NB migrated from plain Diode (dioload.c:267-285).
```

Contains "migrated from" — explicit banned word. See also V-3, V-4 above.

---

## Notes on Verified-Clean Items

The following items were independently verified clean (all C.1 forbidden-pattern greps returned zero hits):

- `allNodeIds` field-form: zero hits in all 22 production files
- `pinNodeIds` field-form: zero hits in all 22 production files
- `stateBaseOffset`: zero hits in all 22 production files
- `isReactive` / `isNonlinear`: zero hits in all 22 production files
- `mayCreateInternalNodes` / `getInternalNodeCount`: zero hits in all 22 production files
- `ReactiveAnalogElement` / `ReactiveAnalogElementCore`: zero hits in all 22 production files
- `internalNodeLabels` field-form: zero hits in all 22 production files
- `withNodeIds` / `makeVoltageSource`: zero hits in all 22 production files
- `getString` / `getNumber` / `getBoolean` PropertyBag calls: zero hits in all 22 production files
- TODO / FIXME / HACK: zero hits in all switching files; zero in all semiconductor production files

**A.11 (`label: ""`) verification:** Present in all factories with element literals:
- bjt.ts L0 (line 572), L1 (line 1201)
- mosfet.ts (line 850)
- njfet.ts (line 330), pjfet.ts (line 304)
- diode.ts (line 545), zener.ts (line 241)
- tunnel-diode.ts (line 271), diac.ts (line 72)
- scr.ts (line 80), triac.ts (line 72), triode.ts (line 143)
- fgnfet.ts (FGNFETCapSubElement, FGNFETMosSubElement, FGNFETAnalogElement)
- fgpfet.ts (FGPFETCapSubElement, FGPFETMosSubElement, FGPFETAnalogElement)
- relay.ts (RelayResSubElement line 122, RelayAnalogElement line 190)
- relay-dt.ts (RelayDTAnalogElement line 64)
- nfet.ts (NFETSWSubElement line 192, NFETAnalogElement line 255)
- pfet.ts (PFETAnalogElement line 193)
- trans-gate.ts (TransGateAnalogElement line 215)

**A.7 (`getInternalNodeLabels`) verification:** Present on all elements that call `ctx.makeVolt`:
- bjt.ts L1 (line 1209) — collector/base/emitter primes conditional
- mosfet.ts (line 859) — drain/source primes conditional
- njfet.ts (line 383) — source/drain primes conditional
- pjfet.ts (line 356) — source/drain primes conditional
- diode.ts (line 584) — internal anode-prime conditional
- zener.ts (line 280) — internal anode-prime conditional
- scr.ts (line 110) — latch node
- triac.ts (line 153) — latch1/latch2 nodes
- relay.ts (line 259) — coilMid node
- relay-dt.ts (line 142) — coilMid node
- fgnfet.ts (line 994) — fg node
- fgpfet.ts (line 941) — fg node

**A.6 (`findBranchFor`) placement:** Correctly on element (not ModelEntry) for all branch-owning elements:
- relay.ts RelayInductorSubElement (line 107) and RelayAnalogElement (line 263)
- relay-dt.ts RelayDTAnalogElement (line 146)

**A.15 composite mandate:** Not applicable to the semiconductors/switching batch. The 18-class mandate covers behavioral-gate, behavioral-combinational, behavioral-sequential, behavioral-flipflop variants, bridge-adapter, adc.ts, dac.ts, and the compiler anonymous class — none of which are in this batch. `ScrCompositeElement`, `TriacCompositeElement`, `RelayAnalogElement`, `TransGateAnalogElement`, `FGNFETAnalogElement`, `FGPFETAnalogElement` all correctly implement `AnalogElement` directly per B.7 scope.

**C19 (composite + makeVolt restriction):** Not triggered. No class in this batch `extends CompositeElement`. The `ctx.makeVolt` calls in `ScrCompositeElement`, `TriacCompositeElement`, `RelayAnalogElement`, `RelayDTAnalogElement`, `FGNFETAnalogElement`, and `FGPFETAnalogElement` are all on non-CompositeElement classes and are therefore outside C19's pattern scope.

**`spice-model-overrides-prop.test.ts` legacy-word analysis:** The word "legacy" at lines 3, 69, 70, 71 and 72 is used in test names and variable names to describe the property being *tested for absence*. The test itself verifies that a legacy property no longer exists. This is different from the banned usage: the comment in the file header (line 3) says "the removed legacy model override property no longer appears" which is testing for removal — this is a test specification comment that accurately describes the test's purpose, not a historical-provenance marker on live code. The word "legacy" appears in a test-name string and a local variable name. This does not decorate dead production code. Reported as information; it is borderline but does not meet the "decorates dead/transitional code" threshold.

**`mosfet.ts` "fallback" hits:** Lines 1212–1216 use `fallback` as a local variable name for the IC-dispatch path in `mos1load.c:419-430`. This is a computation variable (the boolean condition determining whether to apply the ngspice IC fallback), not a comment describing a backwards-compatibility shim. It mirrors the ngspice term for the all-zero IC dispatch path. Not a violation.

**`mosfet.ts` line 1490 "fallback" in comment:** "fallback to 0 when deltaOld[1]=0" is an algorithmic description of a divide-by-zero guard, not a backwards-compatibility marker. Not a violation.

---

## Investigator Reasoning on Non-Violations

**BJT L0 `createBjtElement` non-standard signature:** The L0 factory `createBjtElement(polarity, pinNodes, props)` has a leading `polarity` argument, making it a 4-argument function not matching the A.3 3-arg `AnalogFactory` shape. This was already noted as out-of-band by the SCR agent (progress.md line 339) and triac agent (line 479). The L0 factory is an internal factory (not exported as `AnalogFactory`); it is wrapped by per-polarity lambdas in the modelRegistry. This is a pre-existing architectural choice documented as out-of-band. Not reported as a new violation in this batch since it was explicitly called out in both agents' C.3 sections and is out of this batch's direct scope.

**BJT `ctx.xfact` usage:** `bjt.ts` lines 701-702 and 1402-1404 reference `ctx.xfact`. The `LoadContext` interface (load-context.ts line 107) declares `xfact: number`. This is a valid LoadContext field. Not a violation.
