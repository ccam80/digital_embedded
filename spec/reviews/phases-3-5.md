# Review Report: Phases 3–5 (Waves 3.1, 3.2, 4.1, 5.1)

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 13 (W3T1–T9, W4T1, W5T1–T2) |
| Violations — critical | 3 |
| Violations — major | 5 |
| Violations — minor | 3 |
| Gaps | 2 |
| Weak tests | 7 |
| Legacy references | 1 |

**Verdict: has-violations**

---

## Violations

### V1 — CRITICAL
**File:** `src/components/semiconductors/scr.ts`  
**Line:** 237  
**Rule:** Phase 6 task W6T3 spec requirement — `updateOperatingPoint` signature must be `Readonly<Float64Array>` to enforce compile-time write-back prevention.  
**Evidence:**
```typescript
updateOperatingPoint(voltages: Float64Array): void {
```
**Severity:** critical  
**Explanation:** The spec states: "`updateOperatingPoint` signature changes: `voltages: Float64Array` → `voltages: Readonly<Float64Array>`. Compile-time enforcement that devices cannot write back." SCR does not apply `Readonly<>`, leaving the write-back guard unenforced at the type level. W6T3 is listed as pending in `spec/progress.md`, but SCR was migrated in W3T7 and should have adopted the narrowed signature at that point — all other waves-3-migrated devices that do use `Readonly<Float64Array>` (zener, LED, tunnel-diode, varactor, BJT simple, BJT SPICE L1) demonstrate this is achievable. SCR is the only device among the Wave-3 migrations that retains the mutable signature.

---

### V2 — CRITICAL
**File:** `src/components/semiconductors/triac.ts`  
**Line:** 261  
**Rule:** Same as V1 — `updateOperatingPoint` signature must be `Readonly<Float64Array>`.  
**Evidence:**
```typescript
updateOperatingPoint(voltages: Float64Array): void {
```
**Severity:** critical  
**Explanation:** Triac (W3T8) uses the mutable signature. All other W3 devices adopt `Readonly<Float64Array>`. SCR and Triac are the only two exceptions among devices migrated in this review scope.

---

### V3 — CRITICAL
**File:** `src/components/semiconductors/bjt.ts`  
**Lines:** 733–744  
**Rule:** Rules.md — "No fallbacks. No backwards compatibility shims. No safety wrappers." / Code Hygiene — all state moved to pool should reside in pool exclusively.  
**Evidence:**
```typescript
let capGeqBE = 0;
let capIeqBE = 0;
let capGeqBC_int = 0;   // XCJC fraction: internal base to internal collector
let capIeqBC_int = 0;
let capGeqBC_ext = 0;   // (1-XCJC) fraction: external base to external collector
let capIeqBC_ext = 0;
let capGeqCS = 0;
let capIeqCS = 0;
let vbePrev = NaN;
let vbcPrev = NaN;
let vcsPrev = NaN;
let capFirstCall = true;
```
**Severity:** critical  
**Explanation:** The spec (Phase 3) requires BJT SPICE L1 (`stateSize: 12`) to store all operating-point state in the pool. The 12 declared pool slots cover only the DC operating point (VBE, VBC, GPI, GMU, GM, GO, IC, IB, IC_NORTON, IB_NORTON, RB_EFF, IE_NORTON). The junction-capacitance companion state (`capGeqBE`, `capIeqBE`, `capGeqBC_int`, `capIeqBC_int`, `capGeqBC_ext`, `capIeqBC_ext`, `capGeqCS`, `capIeqCS`, `vbePrev`, `vbcPrev`, `vcsPrev`, `capFirstCall`) remains in closure variables, not in pool slots. This means `statePool.rollback()` — when implemented in Phase 6 — will not restore the capacitance companion state after a failed NR iteration. The pool migration for BJT SPICE L1 is incomplete: capacitance history is not covered.

---

### V4 — MAJOR
**File:** `src/components/semiconductors/mosfet.ts`  
**Lines:** 1001–1003  
**Rule:** Rules.md — "No fallbacks. No backwards compatibility shims."  
**Evidence:**
```typescript
/** Read a model param, returning `fallback` if the key is absent (backward compat). */
function mp(key: string, fallback: number): number {
  return props.hasModelParam(key) ? props.getModelParam<number>(key) : fallback;
```
**Severity:** major  
**Explanation:** The comment explicitly says "backward compat" and the function implements a backwards-compatibility fallback pattern. The rules ban both the comment language and the fallback mechanism. This is in `mosfet.ts`, which is used by the MOSFET (reviewed in W4T1), though the `mp` helper appears to be pre-existing in the file. It is present in the files touched in scope of this review. This pattern directly violates the "No fallbacks. No backwards compatibility shims" rule and the historical-provenance comment ban.

---

### V5 — MAJOR
**File:** `src/components/semiconductors/scr.ts`  
**Line:** 301 (comment in `_latchedState` getter)  
**Rule:** Rules.md — Code Hygiene: implementation details exposed via non-interface members for testing should be on the interface, not as a type-asserted cast.  
**Evidence:**
```typescript
  get _latchedState(): boolean {
    return s0[base + SLOT_LATCHED] !== 0.0;
  },
} as AnalogElementCore & { _latchedState: boolean };
```
**Severity:** major  
**Explanation:** The SCR factory returns `AnalogElementCore & { _latchedState: boolean }` via a `as` type-assertion cast to expose internal state for testing. This is a backwards-compatibility shim pattern: attaching a non-interface field via `as` type assertion to avoid changing the interface. The correct approach is either to expose this via the `AnalogElementCore` interface (as a test-observable contract) or to omit the exposure and read directly from the pool in tests. The type-asserted cast constitutes a shim.

---

### V6 — MAJOR
**File:** `src/components/semiconductors/__tests__/scr.test.ts`  
**Line:** 215  
**Rule:** Rules.md — Tests must assert desired behavior; duplicate assertions are noise.  
**Evidence:**
```typescript
    expect(maxG).toBeGreaterThan(1.0); // >> GMIN, confirms on-state
    expect(maxG).toBeCloseTo(gOn, 0);  // ≈ 100 S
    
    expect(maxG).toBeGreaterThan(1.0);  // ← duplicate on line 215
```
**Severity:** major  
**Explanation:** `expect(maxG).toBeGreaterThan(1.0)` appears twice consecutively in `triggers_with_gate_current` (lines 212 and 215). The second assertion is an exact duplicate of the first. This is dead test code — the duplicate asserts nothing additional.

---

### V7 — MAJOR  
**File:** `src/components/passives/capacitor.ts`  
**Lines:** 210–218  
**Rule:** Spec Phase 5 gate — "No instance field declarations for migrated state: `this.(geq|ieq|vPrev|iPrev)` = 0"  
**Evidence:**
```typescript
  getLteEstimate(dt: number): { truncationError: number } {
    const geq = this.s0[this.base + SLOT_GEQ];
    const vPrev = this.s0[this.base + SLOT_V_PREV];
    // LTE estimate for capacitor using trapezoidal vs BDF-1 comparison.
    // truncationError ~ C * |vNow - vPrev| / (12 * geq * dt) when geq > 0.
    if (geq <= 0 || dt <= 0) return { truncationError: 0 };
    const truncationError = this.C * Math.abs(vPrev) / (12 * geq * dt);
    return { truncationError };
  }
```
**Severity:** major  
**Explanation:** The LTE formula uses `Math.abs(vPrev)` — the stored previous voltage — as the numerator. The spec states: "getLteEstimate reads geq and vPrev/iPrev from pool." This is satisfied in terms of where it reads from. However, the formula `C * |vPrev| / (12 * geq * dt)` is incorrect for a standard LTE estimate: the truncation error for a capacitor companion model should be proportional to `|vNow - vPrev|` (the voltage change), not `|vPrev|` (the absolute previous voltage). The comment in the code even says `truncationError ~ C * |vNow - vPrev| / (12 * geq * dt) when geq > 0` but the implementation computes `C * |vPrev| / (12 * geq * dt)` — `vNow` is absent. This is a functional bug in the migrated method: the implementation does not match the described formula.

---

### V8 — MINOR
**File:** `src/components/semiconductors/zener.ts`  
**Line:** 142  
**Rule:** Rules.md — Comments explain complicated code; they do not describe what was changed or state migration history.  
**Evidence:**
```typescript
      // Save limited voltage to pool — no write-back to voltages[]
      s0[base + SLOT_VD] = vdLimited;
```
**Severity:** minor  
**Explanation:** The comment "no write-back to voltages[]" is a historical-provenance comment. It describes what the code no longer does (write back), not what it does. This pattern appears in zener, LED, tunnel-diode, varactor, BJT simple, BJT SPICE L1, SCR, and Triac — all devices migrated in this review. The comment explains why something was removed, which is the exact kind of provenance comment the rules ban. Each instance is a separate violation; they are aggregated here as a single minor finding since they are identical in nature.

---

### V9 — MINOR
**File:** `src/components/semiconductors/bjt.ts`  
**Lines:** 428–443 (and similar in SPICE L1 at lines 756–773)  
**Rule:** Rules.md — Code Hygiene: no unnecessary complexity.  
**Evidence (BJT simple initState):**
```typescript
      s0[base + SLOT_IC_NORTON] = op0.ic - op0.gm * 0 + op0.go * 0;
      s0[base + SLOT_IB_NORTON] = op0.ib - op0.gpi * 0 - op0.gmu * 0;
```
**Severity:** minor  
**Explanation:** `op0.gm * 0` and `op0.go * 0` are always 0; these terms add no value and obscure the intent. The expressions reduce to `op0.ic` and `op0.ib` respectively. This applies to both BJT simple and BJT SPICE L1 `initState` implementations.

---

### V10 — MINOR
**File:** `src/components/semiconductors/varactor.ts`  
**Lines:** 125–127  
**Rule:** Rules.md — No backwards-compatibility shims, no closure-variable state that should be in the pool.  
**Evidence:**
```typescript
  // Capacitance companion model state (non-pool: init sentinel only)
  let capFirstCall = true;
```
**Severity:** minor  
**Explanation:** `capFirstCall` is a closure boolean that tracks whether `stampCompanion` has been called for the first time. The comment says "non-pool: init sentinel only." However, this boolean carries rollback-relevant state: after a failed NR iteration followed by rollback, `capFirstCall` remains `false` when it might need to be reset to its initial value. The spec requires that `initState` be idempotent and reset state from defaults. Because `capFirstCall` is not in the pool, it cannot be reset by `statePool.rollback()`. The comment acknowledging this as a deliberate non-pool decision ("non-pool: init sentinel only") is a historical-provenance comment justifying a deviation.

---

## Gaps

### G1 — Spec requirement not implemented
**Spec requirement:** Phase 3 — BJT SPICE L1 `stateSize: 12` must contain all operating-point state including capacitance companion coefficients, enabling complete rollback via `statePool.rollback()`.  
**What was found:** The 12 pool slots cover only the DC model. The 12 closure variables for junction capacitance (`capGeqBE`, `capIeqBE`, `capGeqBC_int`, `capIeqBC_int`, `capGeqBC_ext`, `capIeqBC_ext`, `capGeqCS`, `capIeqCS`, `vbePrev`, `vbcPrev`, `vcsPrev`, `capFirstCall`) are outside the pool. The spec's per-device slot table for BJT SPICE L1 shows stateSize: 12 with slots 0–11. There is no slot allocation for capacitance history.  
**File:** `src/components/semiconductors/bjt.ts` lines 733–744  
**Note:** This gap means that when Phase 6 wires up checkpoint/rollback, BJT SPICE L1's capacitance companion state will not be restored on NR retry, causing incorrect simulation results for circuits with BJT capacitance enabled.

---

### G2 — Three-Surface Testing Rule not satisfied
**Spec requirement:** CLAUDE.md — "Every user-facing feature MUST be tested across all three surfaces: headless API test, MCP tool test, E2E/UI test."  
**What was found:** The reviewed waves (W3T1–T9, W4T1, W5T1–T2) provide headless unit tests only. No MCP tool tests exercising the state-pool-backed simulation path via MCP server tool handlers were added. No E2E Playwright tests validating that analog simulation (with pool-backed devices) works in the browser were added. The spec itself notes a required MCP surface test and an E2E test under "Test Strategy" (page: "MCP surface test" and "E2E test" sections), but neither was delivered in any of the reviewed waves.  
**Files affected:** All test files for W3–W5; no MCP or E2E test files were created.

---

## Weak Tests

### WT1
**Path:** `src/components/semiconductors/__tests__/zener.test.ts::Zener::reverse_breakdown`  
**Problem:** The test verifies `expectedId` (a locally computed formula value, not from the element) is greater than 1.0, then calls `updateOperatingPoint` and only checks `voltages[0]` is close to -5.5. It never actually asserts what the pool contains after the operating point update — specifically `pool.state0[SLOT_ID]` or `pool.state0[SLOT_GEQ]`. The assertion `expect(expectedId).toBeGreaterThan(1.0)` is testing a local math expression, not the element's behavior.  
**Evidence:**
```typescript
    const expectedId = IBV * bdExpVal;
    expect(expectedId).toBeGreaterThan(1.0); // >> IBV = 1mA
    ...
    expect(voltages[0]).toBeCloseTo(-5.5, 1);
```

---

### WT2
**Path:** `src/components/semiconductors/__tests__/zener.test.ts::Zener::forward_bias_positive_current`  
**Problem:** The test calls `makeZenerAtVd(vd, ...)` then asserts a locally computed `id` (not from the element) is greater than 1e-6. The element's pool state is never checked. This is testing local arithmetic, not element behavior.  
**Evidence:**
```typescript
    makeZenerAtVd(vd, { IS, N });
    ...
    const id = IS * (expVal - 1);
    expect(id).toBeGreaterThan(1e-6);
```

---

### WT3
**Path:** `src/components/semiconductors/__tests__/scr.test.ts::SCR::pool_state (first test)`  
**Lines:** 385–397  
**Problem:** Assertions `expect(vakInPool).toBeGreaterThan(0)` and `expect(pool.state0[SLOT_G_GATE_GEQ]).toBeGreaterThan(0)` are bare "greater than zero" checks. The spec requires pool slots to contain specific values — for VAK after convergence at a known operating point, the expected limited voltage can be bounded precisely. Bare `> 0` does not catch sign errors, magnitude errors, or off-by-one slot indexing.  
**Evidence:**
```typescript
    expect(vakInPool).toBeGreaterThan(0); // positive for forward-biased state
    expect(pool.state0[SLOT_G_GATE_GEQ]).toBeGreaterThan(0);
```

---

### WT4
**Path:** `src/components/semiconductors/__tests__/scr.test.ts::SCR::pool_state`  
**Lines:** 393, 397  
**Problem:** `expect(Number.isFinite(pool.state0[SLOT_IEQ])).toBe(true)` and `expect(Number.isFinite(pool.state0[SLOT_G_GATE_GEQ])).toBe(true)` are trivially weak. Any non-NaN, non-Infinity value passes. These do not verify the values are in the physically meaningful range.  
**Evidence:**
```typescript
    expect(Number.isFinite(pool.state0[SLOT_IEQ])).toBe(true);
    expect(Number.isFinite(pool.state0[SLOT_G_GATE_GEQ])).toBe(true);
```

---

### WT5
**Path:** `src/solver/analog/__tests__/fet-base.test.ts` (state pool assertions)  
**Lines:** 432–433  
**Problem:** `expect(pool.state0[SLOT_VGS]).toBeGreaterThan(0)` and `expect(pool.state0[SLOT_VDS]).toBeGreaterThan(0)` are bare directionality checks. Given the test drives a specific operating point (VGS=3V, VDS=5V for an N-channel MOSFET), these should be `toBeCloseTo(3, 2)` and `toBeCloseTo(5, 2)` respectively.  
**Evidence:**
```typescript
    expect(pool.state0[AbstractFetElement.SLOT_VGS]).toBeGreaterThan(0);
    expect(pool.state0[AbstractFetElement.SLOT_VDS]).toBeGreaterThan(0);
```

---

### WT6
**Path:** `src/components/passives/__tests__/capacitor.test.ts`  
**Line:** 280  
**Problem:** `expect(lte).toBeDefined()` tests only that the `getLteEstimate` method returns something — it does not verify the returned value is correct. Given the LTE formula bug identified in V7, this test would pass even with an incorrect formula.  
**Evidence:**
```typescript
    expect(lte).toBeDefined();
```

---

### WT7
**Path:** `src/components/passives/__tests__/inductor.test.ts`  
**Lines:** 299–300  
**Problem:** `expect(lte).toBeDefined()` followed by `expect(lte.truncationError).toBeGreaterThan(0)` does not verify the magnitude of the LTE estimate. A correct LTE estimate for a specific inductor value and operating point should be computable analytically.  
**Evidence:**
```typescript
    expect(lte).toBeDefined();
    expect(lte.truncationError).toBeGreaterThan(0);
```

---

## Legacy References

### LR1
**File:** `src/components/semiconductors/mosfet.ts`  
**Lines:** 1001–1003  
**Evidence:**
```typescript
/** Read a model param, returning `fallback` if the key is absent (backward compat). */
function mp(key: string, fallback: number): number {
  return props.hasModelParam(key) ? props.getModelParam<number>(key) : fallback;
```
**Explanation:** The JSDoc comment "backward compat" is an explicit legacy/backwards-compatibility reference. The rules ban any comment describing backwards-compatibility behaviour. This is present in `mosfet.ts` which is a file touched by the W4T1 migration scope (it contains `AbstractFetElement` subclass MOSFET). The comment and the pattern it describes (fallback for absent keys) constitute a legacy reference and backwards-compat shim combined.
