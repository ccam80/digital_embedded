# Review Report: Wave E -- Schema Retrofit on Remaining Elements

## Summary

| Field | Value |
|-------|-------|
| Tasks reviewed | 10 (WE1, WE2, WE3, WE4-WE9, WE10) |
| Violations | 12 |
| Gaps | 6 |
| Weak tests | 1 |
| Legacy references | 1 |
| Verdict | **has-violations** |

---

## Violations

### V1 -- scr.ts line 216: isReactive: false with schema declared

- **Rule violated**: Spec section 5.1 Wave E item 21 -- All retrofitted elements become ReactiveAnalogElement (Amendment D). The ReactiveAnalogElement interface requires `readonly isReactive: true`. Leaving `isReactive: false` while adding a stateSchema creates an inconsistent object that does not satisfy ReactiveAnalogElement and defeats the dev-probe narrowing logic.
- **Evidence**: `src/components/semiconductors/scr.ts:216` -- `isReactive: false,`
- **Severity**: critical

### V2 -- scr.ts: stateSchema property absent from element object literal

- **Rule violated**: Spec section 5.1 Wave E item 21 -- schema must be present on the element object, not only at module scope. SCR_STATE_SCHEMA is defined at module scope (lines 95-105) but is never added to the returned element object literal. The element object at lines 213-224 has no `stateSchema:` key.
- **Evidence**: `src/components/semiconductors/scr.ts:213` -- element literal returned by `createScrElement` contains no stateSchema property.
- **Severity**: critical

### V3 -- triac.ts line 239: isReactive: false with schema declared

- **Rule violated**: Spec section 5.1 Wave E item 21 -- all retrofitted elements must have `isReactive: true`.
- **Evidence**: `src/components/semiconductors/triac.ts:239` -- `isReactive: false,`
- **Severity**: critical

### V4 -- triac.ts: stateSchema property absent from element object literal

- **Rule violated**: Same as V2. TRIAC_STATE_SCHEMA declared at module scope (lines 87-100) but never added to returned element object (lines 236-247).
- **Evidence**: `src/components/semiconductors/triac.ts:236` -- element literal returned by `createTriacElement` contains no stateSchema property.
- **Severity**: critical

### V5 -- led.ts line 185: isReactive: false with schema declared

- **Rule violated**: Spec section 5.1 Wave E item 21 -- all retrofitted elements must have `isReactive: true`.
- **Evidence**: `src/components/io/led.ts:185` -- `isReactive: false,`
- **Severity**: critical

### V6 -- led.ts: stateSchema property absent from element object literal

- **Rule violated**: Same as V2. LED_STATE_SCHEMA declared at module scope (lines 145-152) but never added to returned element object (lines 182-193).
- **Evidence**: `src/components/io/led.ts:182` -- element literal returned by `createLedAnalogElement` contains no stateSchema property.
- **Severity**: critical

### V7 -- zener.ts line 117: isReactive: false with schema declared

- **Rule violated**: Spec section 5.1 Wave E item 21 -- all retrofitted elements must have `isReactive: true`.
- **Evidence**: `src/components/semiconductors/zener.ts:117` -- `isReactive: false,`
- **Severity**: critical

### V8 -- zener.ts: stateSchema property absent from element object literal

- **Rule violated**: Same as V2. ZENER_STATE_SCHEMA declared at module scope (lines 77-84) but never added to returned element object (lines 114-125).
- **Evidence**: `src/components/semiconductors/zener.ts:114` -- element literal returned by `createZenerElement` contains no stateSchema property.
- **Severity**: critical

### V9 -- tunnel-diode.ts line 189: isReactive: false with schema declared

- **Rule violated**: Spec section 5.1 Wave E item 21 -- all retrofitted elements must have `isReactive: true`.
- **Evidence**: `src/components/semiconductors/tunnel-diode.ts:189` -- `isReactive: false,`
- **Severity**: critical

### V10 -- tunnel-diode.ts: stateSchema property absent from element object literal

- **Rule violated**: Same as V2. TUNNEL_DIODE_STATE_SCHEMA declared at module scope (lines 129-136) but never added to returned element object (lines 186-197).
- **Evidence**: `src/components/semiconductors/tunnel-diode.ts:186` -- element literal returned by `createTunnelDiodeElement` contains no stateSchema property.
- **Severity**: critical

### V11 -- varactor.ts lines 133-135: SLOT_CAP_FIRST_CALL = 7 is out of bounds for a 7-slot schema

- **Rule violated**: Correctness / spec section 5.1 item 21 (all slots must be in schema). VARACTOR_STATE_SCHEMA declares 7 slots (indices 0-6: VD, GEQ, IEQ, ID, CAP_GEQ, CAP_IEQ, VD_PREV). The local constant `SLOT_CAP_FIRST_CALL = 7` (line 135) is out of bounds. Writes at lines 153 and 217 and the read at line 215 all access index 7, one past the end of the allocated region. This is a silent out-of-bounds pool write that corrupts the adjacent element first slot. `stateSize` was changed from 8 to 7 in this diff, removing the compiler allocation that previously made index 7 valid.
- **Evidence**: `src/components/semiconductors/varactor.ts:133-135` -- `const SLOT_VD = 0, SLOT_GEQ = 1, SLOT_IEQ = 2, SLOT_ID = 3; const SLOT_CAP_GEQ = 4, SLOT_CAP_IEQ = 5, SLOT_VD_PREV = 6; const SLOT_CAP_FIRST_CALL = 7;` -- schema size is 7, max valid index is 6.
- **Severity**: critical

### V12 -- varactor.ts line 153: justification comment for bypass of applyInitialValues

- **Rule violated**: Code hygiene rule -- "Comments exist ONLY to explain complicated code to future developers. They never describe what was changed, what was removed, or historical behaviour." The comment `// true: Float64Array zero-inits, must set explicitly` justifies bypassing `applyInitialValues` for SLOT_CAP_FIRST_CALL. It is proof the agent knowingly left the schema incomplete and added a comment to make the bypass seem acceptable.
- **Evidence**: `src/components/semiconductors/varactor.ts:153` -- `s0[base + SLOT_CAP_FIRST_CALL] = 1.0; // true: Float64Array zero-inits, must set explicitly`
- **Severity**: major

---

## Gaps

### G1 -- varactor.ts: CAP_FIRST_CALL slot missing from VARACTOR_STATE_SCHEMA

- **Spec requirement**: Spec section 5.1 item 21 -- all slots must be declared in the schema with explicit init kinds. The CAP_FIRST_CALL slot (first-call flag, initialised to 1.0) is actively used by the element. It must appear in the schema as `{ kind: "constant", value: 1.0 }`.
- **What was found**: VARACTOR_STATE_SCHEMA has 7 slots (VD, GEQ, IEQ, ID, CAP_GEQ, CAP_IEQ, VD_PREV). `SLOT_CAP_FIRST_CALL = 7` is a local constant with no schema entry. `stateSize` was changed from 8 to 7 in this diff, removing the compiler allocation for this slot. The slot is both undeclared in the schema and outside the allocated region.
- **File**: `src/components/semiconductors/varactor.ts:98-106, 133-135, 145`

### G2 -- scr.ts: stateSchema not added to element object

- **Spec requirement**: Spec section 5.1 item 21 -- schema must be on the returned element object so the dev probe can enforce pool-backed state.
- **What was found**: SCR_STATE_SCHEMA declared at module scope, never set as a property on the element object literal.
- **File**: `src/components/semiconductors/scr.ts:213-224`

### G3 -- triac.ts: stateSchema not added to element object

- **Spec requirement**: Same as G2.
- **What was found**: TRIAC_STATE_SCHEMA declared at module scope, never set as a property on the element object literal.
- **File**: `src/components/semiconductors/triac.ts:236-247`

### G4 -- led.ts: stateSchema not added to element object

- **Spec requirement**: Same as G2.
- **What was found**: LED_STATE_SCHEMA declared at module scope, never set as a property on the element object literal.
- **File**: `src/components/io/led.ts:182-193`

### G5 -- zener.ts: stateSchema not added to element object

- **Spec requirement**: Same as G2.
- **What was found**: ZENER_STATE_SCHEMA declared at module scope, never set as a property on the element object literal.
- **File**: `src/components/semiconductors/zener.ts:114-125`

### G6 -- tunnel-diode.ts: stateSchema not added to element object

- **Spec requirement**: Same as G2.
- **What was found**: TUNNEL_DIODE_STATE_SCHEMA declared at module scope, never set as a property on the element object literal.
- **File**: `src/components/semiconductors/tunnel-diode.ts:186-197`

---

## Weak Tests

### WT1 -- bare existence check for stateSchema in BJT suite

- **Test path**: `src/components/semiconductors/__tests__/bjt.test.ts::stateSchema -- BJT simple::stateSchema_declared`
- **What is wrong**: `expect(core.stateSchema).toBeDefined()` does not verify the schema owner, size, or slot layout. Any truthy value satisfies it. The identical pattern repeats in `stateSchema -- BJT SPICE L1::stateSchema_declared`. Sibling tests for size and owner partially compensate but the _declared test itself is trivially true.
- **Evidence**: `expect(core.stateSchema).toBeDefined();`

---

## Legacy References

### LR1 -- varactor.ts line 153: justification comment for bypass of applyInitialValues

- **File**: `src/components/semiconductors/varactor.ts:153`
- **Quoted**: `s0[base + SLOT_CAP_FIRST_CALL] = 1.0; // true: Float64Array zero-inits, must set explicitly`
- **Why it is a legacy reference**: The comment explains why the code bypasses `applyInitialValues` ("Float64Array zero-inits, must set explicitly"). Per rules.md, comments that justify deviations are banned. This comment is evidence the agent knew the schema declaration was incomplete and chose an out-of-schema workaround rather than adding the slot to the schema.

---

## Notes

**WE1 and WE2 (BJT simple and L1)**: Both schemas correctly declared at module scope, `isReactive: true as const` set, `stateSchema` present in element literal, warm-start `fromParams` seeds implemented. Clean.

**WE3 (diode verification)**: No changes made. Pre-existing stateSchema from Wave C confirmed present. Clean.

**WE10 (test-helpers)**: `makeDiode` at line 304 correctly has `isReactive: true`, `stateSchema: DIODE_SCHEMA`, and `applyInitialValues`. Clean.

**SCR / Triac / LED / Zener / Tunnel-Diode systematic failure**: All five elements share the same incomplete migration pattern -- the schema constant was declared at module scope and `applyInitialValues` was wired into `initState`, but `stateSchema` was never added to the element object literal and `isReactive` was never changed from `false` to `true`. The five schema constants are dead code as they stand and provide no dev-probe coverage.
