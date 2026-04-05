# Review Report: Phase 3 - Remaining PN-junction devices migrated to state pool

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 9 (W3T1-W3T9) |
| Violations | 11 |
| Gaps | 3 |
| Weak tests | 3 |
| Legacy references | 1 |
| Verdict | has-violations |

---

## Violations

### V1 - Historical-provenance comment (critical)

**File:** src/solver/analog/__tests__/buckbjt-convergence.test.ts:8
**Rule:** rules.md - No historical-provenance comments. Any comment describing what code replaced,
what it used to do, why it changed, or where it came from is banned.
**Evidence (line 8):**
    * BJT pnjlim voltage write-back.
Full sentence in context: "is a stress test for the BJT pnjlim voltage write-back."
This describes the old buggy behaviour removed in Phase 3. The comment explains what the test was
validating under the old code, not what it currently validates. Per the rules this is banned
regardless of phrasing.
**Severity:** critical

---

### V2 - Historical-provenance comment in zener.ts

**File:** src/components/semiconductors/zener.ts:143
**Rule:** rules.md - historical-provenance comment ban.
**Evidence:**
    // Save limited voltage to pool - no write-back to voltages[]
The phrase "no write-back to voltages[]" explicitly describes what the old code used to do.
This is a before/after contrast comment - exactly what the rule bans.
**Severity:** major

---

### V3 - Historical-provenance comment in scr.ts

**File:** src/components/semiconductors/scr.ts:256
**Rule:** rules.md - historical-provenance comment ban.
**Evidence:**
    // Save limited voltages to pool - no write-back to voltages[]
Same pattern as V2.
**Severity:** major

---

### V4 - Historical-provenance comment in triac.ts

**File:** src/components/semiconductors/triac.ts:274
**Rule:** rules.md - historical-provenance comment ban.
**Evidence:**
    // Save limited voltages to pool - no write-back to voltages[]
Same pattern as V2.
**Severity:** major

---

### V5 - Historical-provenance comment in tunnel-diode.ts

**File:** src/components/semiconductors/tunnel-diode.ts:222
**Rule:** rules.md - historical-provenance comment ban.
**Evidence:**
    // Save limited voltage to pool - no write-back to voltages[]
Same pattern as V2.
**Severity:** major

---

### V6 - Historical-provenance comment in varactor.ts

**File:** src/components/semiconductors/varactor.ts:176
**Rule:** rules.md - historical-provenance comment ban.
**Evidence:**
    // Save limited voltage to pool - no write-back to voltages[]
Same pattern as V2.
**Severity:** major

---

### V7 - Historical-provenance comment in bjt.ts (simple model)

**File:** src/components/semiconductors/bjt.ts:522
**Rule:** rules.md - historical-provenance comment ban.
**Evidence:**
    // Save limited voltages to pool - no write-back to voltages[]
Same pattern as V2.
**Severity:** major

---

### V8 - Historical-provenance comment in bjt.ts (SPICE L1 model)

**File:** src/components/semiconductors/bjt.ts:888
**Rule:** rules.md - historical-provenance comment ban.
**Evidence:**
    // Apply pnjlim using vold from pool - no write-back to voltages[]
Same pattern as V2.
**Severity:** major

---

### V9 - Historical-provenance comment in test-helpers.ts

**File:** src/solver/analog/__tests__/test-helpers.ts:333
**Rule:** rules.md - historical-provenance comment ban.
**Evidence:**
    // Save limited voltage to pool - no write-back to voltages[]
Same pattern as V2.
**Severity:** major

---

### V10 - Out-of-pool capacitance companion state in varactor.ts breaks rollback

**File:** src/components/semiconductors/varactor.ts:126
**Rule:** Spec - all state that must be consistent after statePool.rollback() must live in the pool.
The varactor capFirstCall closure variable controls whether SLOT_VD_PREV or vNow is used in
stampCompanion. It is not in the pool and is not restored by rollback. After NR failure + rollback,
capFirstCall remains false even though SLOT_VD_PREV has been restored to its checkpoint value,
creating an inconsistency between the closure flag and the pool state.
**Evidence:**
    let capFirstCall = true;   // line 126 - closure, not in pool
    ...
    const vPrevForFormula = capFirstCall ? vNow : s0[base + SLOT_VD_PREV];
    s0[base + SLOT_VD_PREV] = vNow;
    capFirstCall = false;
**Severity:** major

---

### V11 - Out-of-pool junction capacitance state in BJT SPICE L1 breaks rollback

**File:** src/components/semiconductors/bjt.ts:733-744
**Rule:** Spec - all rollback-sensitive state must be in the pool. The BJT SPICE L1 stateSize is 12,
covering only the Gummel-Poon DC model. All junction capacitance companion state (capGeqBE,
capIeqBE, capGeqBC_int, capIeqBC_int, capGeqBC_ext, capIeqBC_ext, capGeqCS, capIeqCS, vbePrev,
vbcPrev, vcsPrev, capFirstCall) lives in closure variables. statePool.rollback() does not restore
any of them. For any reactive BJT (CJE > 0, CJC > 0, TF > 0, etc.), NR failure + rollback leaves
the junction capacitance companion model in a post-failure state while state0 is restored, breaking
rollback correctness.
**Evidence (lines 733-744):**
    let capGeqBE = 0;
    let capIeqBE = 0;
    let capGeqBC_int = 0;
    let capIeqBC_int = 0;
    let capGeqBC_ext = 0;
    let capIeqBC_ext = 0;
    let capGeqCS = 0;
    let capIeqCS = 0;
    let vbePrev = NaN;
    let vbcPrev = NaN;
    let vcsPrev = NaN;
    let capFirstCall = true;
**Severity:** major

---

## Gaps

### G1 - Missing voltages-unchanged smoke test for Tunnel Diode (W3T3)

**Spec requirement:** For each migrated device, call updateOperatingPoint(voltages) then assert
voltages is unchanged (deep equal to a snapshot taken before the call).
**What was found:** src/components/semiconductors/__tests__/tunnel-diode.test.ts has no test that
takes a snapshot of the voltages array before updateOperatingPoint and asserts it is unchanged
afterward. The 8 occurrences of voltages[ in that file are all write operations setting up test
inputs - none are post-call assertions on array contents.
**File:** src/components/semiconductors/__tests__/tunnel-diode.test.ts

---

### G2 - Missing voltages-unchanged smoke test for Varactor (W3T4)

**Spec requirement:** Same as G1.
**What was found:** src/components/semiconductors/__tests__/varactor.test.ts has no
voltages-unchanged assertion. The 4 occurrences of voltages[ are all setup writes.
**File:** src/components/semiconductors/__tests__/varactor.test.ts

---

### G3 - Missing voltages-unchanged smoke test for LED analog model (W3T2)

**Spec requirement:** Same as G1.
**What was found:** src/components/io/__tests__/led.test.ts has zero references to
updateOperatingPoint and zero references to voltages[. No direct test of the LED analog element
write-back elimination exists. The LED analog model is exercised only via an integration solve in
behavioral-remaining.test.ts, which does not assert the voltages array is unchanged after
updateOperatingPoint.
**File:** src/components/io/__tests__/led.test.ts

---

## Weak Tests

### WT1 - Bare toBeDefined() on stampCompanion presence

**Test:** src/components/semiconductors/__tests__/varactor.test.ts::isNonlinear_and_isReactive (line 214)
**Problem:** expect(v.stampCompanion).toBeDefined() checks only that the method exists, not that it
functions. Any object with a truthy stampCompanion property passes. The test should call
stampCompanion and assert pool slots are updated with correct companion values.
**Evidence:** expect(v.stampCompanion).toBeDefined();

---

### WT2 - Weak Number.isFinite check instead of specific value for SLOT_IEQ

**Test:** src/components/semiconductors/__tests__/scr.test.ts (line 393)
**Problem:** expect(Number.isFinite(pool.state0[SLOT_IEQ])).toBe(true) verifies only that the value
is not NaN/Infinity. A zero or incorrect Norton current offset passes. A specific expected value
should be asserted.
**Evidence:** expect(Number.isFinite(pool.state0[SLOT_IEQ])).toBe(true);

---

### WT3 - Weak Number.isFinite check instead of specific value for SLOT_G_GATE_GEQ

**Test:** src/components/semiconductors/__tests__/scr.test.ts (line 397)
**Problem:** Same pattern as WT2. expect(Number.isFinite(pool.state0[SLOT_G_GATE_GEQ])).toBe(true)
verifies only finiteness, not a specific expected gate conductance value.
**Evidence:** expect(Number.isFinite(pool.state0[SLOT_G_GATE_GEQ])).toBe(true);

---

## Legacy References

### LR1 - Stale reference to removed write-back behaviour in test file description

**File:** src/solver/analog/__tests__/buckbjt-convergence.test.ts:8
**Evidence:** * BJT pnjlim voltage write-back.
The test file JSDoc identifies the circuit as a "stress test for the BJT pnjlim voltage write-back."
After Phase 3 the write-back mechanism no longer exists. This comment names a removed mechanism as
the feature under test.
(Same file as V1; listed separately per report format requirements.)
