# Phase 3: Master 3 — Mixed-Signal Assertions

## Target File
`e2e/gui/master-circuit-assembly.spec.ts` — the `Master 3: mixed-signal` test block.

## Reference
Full spec with ngspice values: `spec/master-circuit-assertions.md`

## Wave 3.1

### Task 3.1.1 — DC Operating Point (Phase A) [M]

**Current state**: After wiring + `stepViaUI()` + `verifyNoErrors()`, the test steps to 5ms and checks voltages are finite + loose range checks. These are placeholder assertions.

**Required changes**: Replace the placeholder assertions (lines ~362-396) with precise ngspice-verified assertions:
1. Keep `stepViaUI()` → `verifyNoErrors()`
2. Keep `stepToTimeViaUI('5m')` 
3. Use `getAnalogState()` or `readAllSignals()` and assert at **0.1% tolerance**:
   - VREF node ≈ 5.0V
   - RC node (P_DAC probe) ≈ 3.121984V (98.94% settled toward 3.125V at t=5ms)
   - Cap node ≈ 3.091827V (still charging)
   - Vref2 node ≈ 2.5V
4. Comparator polarity check:
   - `readOutput('GA')` → assert output is 0 (AND gate driven by LOW comparator)
   - Because: in- gets RC voltage (~3.12V) > in+ gets Vref2 (2.5V), comparator output = LOW
5. Remove the loose range checks (`dacVolt > 2.8`, sorted voltages, etc.)

**Note on node identification**: `readAllSignals()` returns labeled signals. Probe `P_DAC` gives the RC node voltage. Use `getAnalogState().nodeVoltages` for unlabeled internal nodes (VREF, Cap, Vref2).

### Task 3.1.2 — Modify Vref (Phase B) [M]

**Current state**: No Vref modification assertions exist.

**Required changes**: After Phase A assertions, add:
1. `setComponentProperty('Vref', 'voltage', 3.3)` — change from 5V to 3.3V
2. `stepToTimeViaUI('5m')` → `getAnalogState()`
3. Assert at 0.1% (ngspice transient at t=5ms):
   - VREF ≈ 3.3V
   - RC node ≈ 2.060510V (98.94% settled toward 2.0625V)
   - Cap node ≈ 2.040606V
4. Comparator behavioral change: 2.5V (in+) > 2.061V (in-) → output HIGH → counter should count
5. `readOutput('GA')` → assert output is 1 (comparator flipped)

### Task 3.1.3 — Modify R1 (Phase C) [M]

**Current state**: No R1 modification assertions exist.

**Required changes**: After Phase B assertions, add:
1. `setComponentProperty('R1', 'resistance', 10000)` — change from 1k to 10k
2. `stepToTimeViaUI('50m')` — new τ = 10.1ms, need 50ms to settle
3. Assert at 0.1% (ngspice transient at t=50ms):
   - RC node ≈ 2.062355V (99.29% settled toward 2.0625V)
   - Cap node ≈ 2.047898V

### Task 3.1.4 — Trace/Scope Expansion (Phase D) [S]

**Current state**: The test already has `addTraceViaContextMenu('R1', 'A')` and `measureAnalogPeaks('2m')` with loose assertions.

**Required changes**: Move trace section to after Phase C, tighten assertions:
1. `addTraceViaContextMenu('R1', 'A')`
2. `measureAnalogPeaks('2m')`
3. Assert: peaks is not null, nodeCount >= 1
4. maxPeak should be in range of current steady-state (~2.06V)

### Task 3.1.5 — Pin Electrical / rOut Override (Phase E) [L]

**Current state**: No pin electrical assertions exist.

**Required changes**: After Phase D, add:
1. Right-click the AND gate (GA) output pin to override Rout:
   ```typescript
   const gaOutPos = await builder.getPinPagePosition('GA', 'out');
   await page.mouse.click(gaOutPos.x, gaOutPos.y, { button: 'right' });
   // Look for pin electrical menu or Rout field
   const rOutInput = await getPinFieldInput(page, 'Rout');
   await rOutInput.fill('75');
   await rOutInput.press('Tab');
   ```
2. `stepToTimeViaUI('5m')` → `getAnalogState()`
3. Assert at 0.1%: V_junction ≈ 4.962779V (with rOut=75, vs default rOut=50: 4.975124V)

**Pattern reference**: `e2e/gui/hotload-params-e2e.spec.ts` — look for `getPinFieldInput` usage.
