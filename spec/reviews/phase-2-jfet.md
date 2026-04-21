# Review Report: Phase 2 — JFET n-/p-channel MODEINITSMSIG + bitfield migration (Wave 2.4.4)

## Summary

| Item | Value |
|------|-------|
| Tasks reviewed | 1 (task 2.4.4) |
| Files reviewed | `src/components/semiconductors/njfet.ts`, `src/components/semiconductors/pjfet.ts`, `src/components/semiconductors/__tests__/jfet.test.ts` |
| Violations — critical | 1 |
| Violations — major | 3 |
| Violations — minor | 0 |
| Gaps | 0 |
| Weak tests | 5 |
| Legacy references | 0 |
| **Verdict** | **has-violations** |

---

## Violations

### V1 — MAJOR: SLOT_VGS and SLOT_VDS imported as raw constants instead of resolved via stateSchema.getSlotOffset()

- **File**: `src/components/semiconductors/__tests__/jfet.test.ts`, line 23
- **Rule violated**: CLAUDE.md memory entry `feedback_schema_lookups_over_exports.md` — "Tests should resolve pool slots by name via stateSchema.getSlotOffset, not import raw SLOT_* constants"
- **Evidence**:
  ```ts
  import { SLOT_VGS, SLOT_VDS } from "../../../solver/analog/fet-base.js";
  ```
  These are used directly at lines 712–713 (`pool.state0[SLOT_VGS]`, `pool.state0[SLOT_VDS]`) and lines 804–805 (`pool.state1[SLOT_VGS]`, `pool.state1[SLOT_VDS]`) to seed state before calling `load()` in the two new MODEINITSMSIG and MODEINITTRAN test describe blocks.
- **Severity**: major

---

### V2 — MAJOR: SLOT_VGS_JUNCTION, SLOT_GD_JUNCTION, SLOT_ID_JUNCTION imported as raw constants instead of resolved via stateSchema.getSlotOffset()

- **File**: `src/components/semiconductors/__tests__/jfet.test.ts`, lines 19–21
- **Rule violated**: CLAUDE.md memory entry `feedback_schema_lookups_over_exports.md` — "Tests should resolve pool slots by name via stateSchema.getSlotOffset, not import raw SLOT_* constants"
- **Evidence**:
  ```ts
  import {
    SLOT_VGS_JUNCTION,
    SLOT_GD_JUNCTION,
    SLOT_ID_JUNCTION,
  } from "../njfet.js";
  ```
  These are used directly throughout the `"JFET state-pool extension schema"` describe block (lines 473–548) to index into `pool.state0` and `pool.state1` arrays, instead of being resolved via `JFET_SCHEMA.getSlotOffset("VGS_JUNCTION")` etc.
- **Severity**: major

---

### V3 — CRITICAL: Test uses hardcoded numeric literal 45 to verify slot constant, not schema-derived value

- **File**: `src/components/semiconductors/__tests__/jfet.test.ts`, lines 471–476
- **Rule violated**: CLAUDE.md memory entry `feedback_schema_lookups_over_exports.md` — "Tests should resolve pool slots by name via stateSchema.getSlotOffset, not import raw SLOT_* constants"; also spec rule — tests must assert desired behaviour not implementation details
- **Evidence**:
  ```ts
  it("extension_slot_constants_are_45_46_47", () => {
    // FET_BASE_SCHEMA has 45 slots (0-44); JFET extension starts at 45.
    expect(SLOT_VGS_JUNCTION).toBe(45);
    expect(SLOT_GD_JUNCTION).toBe(46);
    expect(SLOT_ID_JUNCTION).toBe(47);
  });
  ```
  This test asserts the numeric value of exported slot constants instead of verifying that schema slot lookup by name returns consistent values. The test hard-pins the raw constant values to literal integers (45, 46, 47), making it an implementation-detail assertion that would break under any schema layout change. The correct approach is to resolve slots via `stateSchema.getSlotOffset("VGS_JUNCTION")` and verify that `pool.state0` at that offset has the expected initial value. The test as written is also trivially vacuous: it tests only that the constant file exported a particular number, not that the state schema is correct or that the element correctly initialises the slot.
- **Severity**: critical

---

### V4 — MAJOR: State-pool slot assertions at hardcoded numeric indices bypass schema lookup

- **File**: `src/components/semiconductors/__tests__/jfet.test.ts`, lines 543–547
- **Rule violated**: CLAUDE.md memory entry `feedback_schema_lookups_over_exports.md`
- **Evidence**:
  ```ts
  it("base_slots_still_initialized_by_initState", () => {
    // ...
    expect(pool.state0[2]).toBe(1e-12); // SLOT_GM = 2
    expect(pool.state0[3]).toBe(1e-12); // SLOT_GDS = 3
    // SLOT_V_GS and SLOT_V_GD are zero-initialised (first-call detection via s1[Q_GS]===0)
    expect(pool.state0[10]).toBe(0); // SLOT_V_GS = 10
    expect(pool.state0[11]).toBe(0); // SLOT_V_GD = 11
  });
  ```
  Slots are accessed by raw numeric literals (2, 3, 10, 11) instead of via schema name resolution. These literals are explained only in comments, which is precisely the pattern the schema-lookup rule exists to prevent.
- **Severity**: major

---

## Gaps

None found. All spec-required elements for task 2.4.4 are present:

- `_updateOp()` in `njfet.ts` has MODEINITSMSIG branch seeding from `s0`, returning early (lines 272–288).
- `_updateOp()` in `njfet.ts` has MODEINITTRAN branch seeding from `s1`, returning early (lines 290–306).
- `_updateOp()` in `njfet.ts` MODEINITJCT check uses `mode & MODEINITJCT` bitfield at line 308.
- `pjfet.ts` applies the identical pattern in `PJfetAnalogElement._updateOp()` (lines 125–178).
- Imports of `SLOT_VGS`/`SLOT_VDS` from `fet-base.js` and `MODEINITSMSIG`/`MODEINITTRAN`/`MODEINITJCT` from `ckt-mode.js` are present in both files.
- No banned Vds clamps (`vds < -10`, `vds > 50`, or equivalent) found in either file.
- `makeDcOpCtx` in `jfet.test.ts` uses `cktMode: MODEDCOP | MODEINITFLOAT` (line 108) with no legacy fields.
- Two new describe blocks are present: `"NJFET MODEINITSMSIG branch"` (lines 688–771) and `"NJFET MODEINITTRAN branch"` (lines 780–861), each with one test asserting seeded voltage values match state0/state1 respectively via exact matrix stamp assertions.
- No `ctx.initMode ===`, `ctx.isTransient`, `ctx.isDcOp`, `ctx.isAc`, or `loadCtx.iteration` references found in any of the three files.

---

## Weak Tests

### WT1 — `NJFET > saturation_current`: assertion does not check the actual Norton stamp value

- **Test path**: `src/components/semiconductors/__tests__/jfet.test.ts::NJFET::saturation_current`
- **Problem**: The test verifies that `expectedIds` computes to approximately 0.2e-3 (a math check on test-local variables, not on the element), then checks only that `hasSignificantCurrent` is true — i.e. that _some_ RHS entry exceeds 1e-5. This does not verify the correct Norton current value is stamped; any nonzero current satisfies the assertion.
- **Evidence**:
  ```ts
  let hasSignificantCurrent = false;
  for (let i = 0; i < rhs.length; i++) {
    if (Math.abs(rhs[i]) > 1e-5) { hasSignificantCurrent = true; break; }
  }
  expect(hasSignificantCurrent).toBe(true);
  ```

### WT2 — `NJFET > linear_region`: same weak pattern as WT1

- **Test path**: `src/components/semiconductors/__tests__/jfet.test.ts::NJFET::linear_region`
- **Problem**: Checks only that some RHS entry exceeds 1e-6. Does not assert the specific Norton current derived from the linear-region formula.
- **Evidence**:
  ```ts
  let hasLinearCurrent = false;
  for (let i = 0; i < rhs.length; i++) {
    if (Math.abs(rhs[i]) > 1e-6) { hasLinearCurrent = true; break; }
  }
  expect(hasLinearCurrent).toBe(true);
  ```

### WT3 — `NJFET > gate_forward_current`: checks only that maxRhs exceeds a threshold

- **Test path**: `src/components/semiconductors/__tests__/jfet.test.ts::NJFET::gate_forward_current`
- **Problem**: Asserts that the maximum RHS entry exceeds 1e-9 without verifying the specific Norton current from the Shockley equation at the correct node.
- **Evidence**:
  ```ts
  expect(maxRhs).toBeGreaterThan(1e-9); // measurable junction current
  ```

### WT4 — `PJFET > polarity_inverted`: two threshold assertions instead of exact stamp values

- **Test path**: `src/components/semiconductors/__tests__/jfet.test.ts::PJFET::polarity_inverted`
- **Problem**: Asserts `nonzeroStamps.length > 0` (trivially satisfied by any conducting element) and `maxRhs > 1e-10` (threshold without expected value). Neither assertion checks the specific P-channel Norton current or conductance stamps.
- **Evidence**:
  ```ts
  expect(nonzeroStamps.length).toBeGreaterThan(0);
  // ...
  expect(maxRhs).toBeGreaterThan(1e-10);
  ```

### WT5 — `JFET state-pool extension schema > junction_slots_are_written_by_load`: bare magnitude check

- **Test path**: `src/components/semiconductors/__tests__/jfet.test.ts::JFET state-pool extension schema::junction_slots_are_written_by_load`
- **Problem**: After forward-biasing the gate junction, checks only `gdJunction > 1e-12` (greater than GMIN) and `abs(idJunction) > 0`. Neither assertion verifies the specific Shockley-equation result at the known bias voltage.
- **Evidence**:
  ```ts
  expect(gdJunction).toBeGreaterThan(1e-12);
  // ...
  expect(Math.abs(idJunction)).toBeGreaterThan(0);
  ```

---

## Legacy References

None found. Searches for `legacy`, `fallback`, `workaround`, `temporary`, `previously`, `backwards compat`, `shim`, `migrated from`, `replaced`, `for now`, `TODO`, `FIXME`, `HACK` across all three reviewed files returned no dead-code markers. The two instances of the word "skip" in njfet.ts (line 310) and pjfet.ts (line 163) are in functional comments explaining that voltage reads are intentionally bypassed in the MODEINITJCT path (`// Skip MNA voltage reads and all voltage limiting`), not dead-code markers. The instance in jfet.test.ts (line 579) reads `// S=0 (ground, skipped)` referring to the ground node being excluded from MNA stamping — also a functional explanation. None of these decorate dead or transitional code.
