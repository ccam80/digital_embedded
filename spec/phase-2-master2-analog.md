# Phase 2: Master 2 — Analog Assertions

## Target File
`e2e/gui/master-circuit-assembly.spec.ts` — the `Master 2: analog` test block.

## Reference
Full spec with ngspice values: `spec/master-circuit-assertions.md`

## Wave 2.1

### Task 2.1.1 — DC Operating Point (Phase A) [M]

**Current state**: After wiring + `stepViaUI()` + `verifyNoErrors()`, the test steps to 1ms and checks voltages are finite + peak range. These are placeholder assertions.

**Required changes**: Replace the placeholder assertions (lines ~228-250) with precise ngspice-verified assertions:
1. Keep `stepViaUI()` → `verifyNoErrors()`
2. Change `stepToTimeViaUI('1m')` to `stepToTimeViaUI('5m')` for proper settling
3. Use `getAnalogState()` and assert at **0.1% tolerance** (`toBeCloseTo` with appropriate precision, or manual relative tolerance check):
   - P_DIV ≈ 2.500000V
   - P_RC ≈ 2.500000V  
   - P_AMP ≈ 2.499998V
   - P_CE ≈ 10.00008V (BJT collector)
4. Keep the "all voltages finite" check
5. Remove the loose range checks (`maxPeak > 2.0`, etc.)

**Tolerance helper**: For 0.1% relative tolerance, use: `expect(Math.abs(actual - expected) / expected).toBeLessThan(0.001)`

**Important**: The probe labels (P_DIV, P_RC, P_AMP, P_CE) are the keys in `nodeVoltages`. Use `readAllSignals()` to get labeled probe values, which is more reliable than parsing nodeVoltages keys.

### Task 2.1.2 — Modify R1 Resistance (Phase B) [M]

**Current state**: No R1 modification assertions exist.

**Required changes**: After Phase A assertions, add:
1. `setComponentProperty('R1', 'resistance', 20000)` — change R1 from 10k to 20k
2. `stepToTimeViaUI('10m')` → `getAnalogState()`
3. Assert at 0.1%:
   - P_DIV ≈ 1.666667V (new divider ratio: 5V × 10k/30k)
   - P_RC ≈ 1.666667V
   - P_AMP ≈ 1.666665V
   - P_CE ≈ 10.88529V

### Task 2.1.3 — Modify BJT BF (Phase C) [M]

**Current state**: No BJT parameter modification assertions exist.

**Required changes**: After Phase B assertions, add:
1. `setSpiceParameter('Q1', 'BF', 50)` — change BJT forward gain from 100 to 50
2. `stepToTimeViaUI('5m')` → `getAnalogState()`
3. Assert at 0.1%:
   - P_CE ≈ 11.43012V (less gain → higher collector voltage)

**Key method**: `builder.setSpiceParameter(label, paramKey, value)` — opens popup, finds param row, sets value.

### Task 2.1.4 — Trace/Scope Expansion (Phase D) [S]

**Current state**: The test already has `addTraceViaContextMenu('R1', 'A')` and `measureAnalogPeaks('5m')` with loose assertions.

**Required changes**: Replace/tighten the existing trace assertions:
1. Move the trace section to after Phase C (so it reads Phase C steady-state values)
2. `addTraceViaContextMenu('R1', 'A')`
3. `measureAnalogPeaks('2m')` 
4. Assert: `peaks` is not null, `nodeCount >= 1`, maxPeak within range of Phase C steady-state values (around the new divider voltage ~1.67V)

### Task 2.1.5 — Pin Loading (Phase E) [L]

**Current state**: No pin loading assertions exist.

**Required changes**: After Phase D, add:
1. Reset R1 back to 10k: `setComponentProperty('R1', 'resistance', 10000)` 
2. Reset BF back to 100: `setSpiceParameter('Q1', 'BF', 100)`
3. Right-click wire on R1-R2 junction to enable pin loading:
   ```typescript
   // Get grid position of the R1-R2 junction (between R1.B and R2.A)
   const junctionPos = await builder.getPinPagePosition('R1', 'B');
   // Right-click near the junction wire
   await page.mouse.click(junctionPos.x + 5, junctionPos.y, { button: 'right' });
   const loadedItem = page.locator('.ctx-menu-item .ctx-menu-label')
     .filter({ hasText: 'Pin Loading: Loaded' });
   await loadedItem.click();
   ```
4. `stepToTimeViaUI('5m')` → `getAnalogState()`
5. Assert at 0.1%: P_DIV ≈ 2.498751V (loaded divider, vs 2.500000V unloaded)

**Pattern reference**: `e2e/gui/pin-loading-wire-override.spec.ts`
