# Master Circuit E2E Assertion Spec

## Status

- **Master 1 (Digital)**: Wiring PASSING, minimal assertions (truth table only)
- **Master 2 (Analog)**: Wiring PASSING, assertions placeholder (switch bug blocks voltage verification — being fixed in parallel session)
- **Master 3 (Mixed)**: Wiring PASSING (captured from manual session), assertions placeholder (voltage reads as 1V, needs debug)
- **Tier 4 tests**: DELETED (digital-circuit-assembly, analog-circuit-assembly, mixed-circuit-assembly, analog-rc-circuit)
- **`getCircuitDomain()`**: Test bridge heuristic only (returns 'analog' or 'digital', never 'mixed'). Removed from all masters. Located at `src/app/test-bridge.ts:228`.

## ngspice Reference Values (Corrected OpAmp Feedback)

### Master 2 — m2_dc (R1=10k, R2=10k, Vs=5V, Vcc=12V, BF=100)
```
v_div:  2.500000e+00   (Vs × R2/(R1+R2) = 2.5V)
v_rc:   2.500000e+00   (settled to divider voltage)
v_amp:  2.499998e+00   (unity-gain buffer ≈ v_rc)
v_col:  1.000008e+01   (BJT collector, active region)
v_base: 6.707380e-01   (BJT Vbe)
```

### Master 2 — m2_r1_20k (R1=20k, rest same)
```
v_div:  1.666667e+00   (5 × 10k/30k)
v_rc:   1.666667e+00
v_amp:  1.666665e+00
v_col:  1.088529e+01   (less base drive → higher Vce)
v_base: 6.554076e-01
```

### Master 2 — m2_bf50 (R1=20k, BF=50)
```
v_div:  1.666667e+00
v_rc:   1.666667e+00
v_amp:  1.666665e+00
v_col:  1.143012e+01   (lower gain → even higher Vce)
v_base: 6.379227e-01
```

### Master 3 — m3_dc (Vref=5V, DAC code=10, 4-bit, R1=1k, C1=1µF)
At t=5ms (4.5τ for τ=1.1ms), RC 98.94% settled (ngspice .measure confirmed):
```
v_vref:    5.000000e+00
v_rc:      3.121984e+00   (DAC output node, Thevenin Vdac=3.125V via Rdac=100)
v_cap:     3.091827e+00   (capacitor node, still charging)
v_vref2:   2.500000e+00
```
At t=10ms (99.99% settled):
```
v_rc:      3.124968e+00
v_cap:     3.124648e+00
```
Steady-state (t=inf): v_rc = v_cap = 3.125000e+00.
Note: The earlier contradictory 2.841V value was the initial transient V(rc_node) at t~0,
when maximum current flows through Rdac: 3.125 - 3.125*100/1100 = 2.841V. At steady state
no current flows and both nodes settle to Vdac = 3.125V.

### Master 3 — m3_vref33 (Vref=3.3V → DAC=10/16×3.3=2.0625V)
At t=5ms (ngspice .measure confirmed):
```
v_vref:  3.300000e+00
v_rc:    2.060510e+00   (98.94% settled toward 2.0625V)
v_cap:   2.040606e+00
v_vref2: 2.500000e+00
```
At t=10ms (99.99% settled): v_rc = 2.062479e+00, v_cap = 2.062268e+00.
Steady-state: v_rc = v_cap = 2.062500e+00.
Note: Comparator in- (2.061V) < in+ (2.5V) → output HIGH → counter counts.

### Master 3 — m3_r1_10k (R1=10k, τ=10.1ms, settle at 50ms)
At t=50ms (4.95τ, 99.29% settled, ngspice .measure confirmed):
```
v_rc:    2.062355e+00   (same DAC voltage, slower settle)
v_cap:   2.047898e+00
```
At t=100ms (99.99% settled): v_rc = 2.062499e+00, v_cap = 2.062397e+00.
Steady-state: v_rc = v_cap = 2.062500e+00.

### Master 1 — m1_cmos_and (CMOS AND2 gate, VDD=5V)
ngspice .op with NMOS(VTO=1, KP=2e-5, LAMBDA=0.01) and PMOS(VTO=-1, KP=1e-5, LAMBDA=0.01),
W=L=1um, matching CMOS_AND2_NETLIST topology in src/components/gates/and.ts:130.
```
m1_cmos_and_high (both inputs = 5V):
  V(out):      5.000000e+00   (effectively VDD)
  V(nand_out): 2.505000e-07   (effectively 0V)

m1_cmos_and_low (one input = 0V):
  V(out):      6.262500e-08   (effectively 0V)
  V(nand_out): 5.000000e+00   (effectively VDD)

m1_cmos_and_low_ll (both inputs = 0V):
  V(out):      6.262500e-08   (effectively 0V)
  V(nand_out): 5.000000e+00   (effectively VDD)
```

### Master 2 — Pin Loading (m2_pin_loading, R1=R2=10k, Vs=5V)
BridgeInputAdapter stamps 1/rIn (10M ohm) to GND when loaded=true.
```
Unloaded: V(div) = 2.500000e+00
Loaded:   V(div) = 2.498751e+00
Delta:    1.249e-03 V (0.0500%)
```

### Pin Electrical / rOut Override (VOH=5V, Rload=10k)
Gate output modeled as VOH in series with rOut driving Rload to GND.
V_junction = VOH * Rload / (rOut + Rload).
```
rOut=50 (default):  V_junction = 4.975124e+00  (drop = 2.488e-02 V)
rOut=75:            V_junction = 4.962779e+00  (drop = 3.722e-02 V)
rOut=100k:          V_junction = 4.545455e-01  (drop = 4.545e+00 V)
```
Full details in spec/ngspice-refs-complete.md.

## Assertion Flows Per Master

### Master 1: Digital Logic

#### Phase A — Truth table (EXISTING, PASSING)
- `stepViaUI()` → `verifyNoErrors()`
- `runTestVectors('A B AND_Y OR_Y XOR_Y NOT_Y\n0 0 0 0 0 1\n...')` 
- Assert: `passed=4, failed=0`

#### Phase B — Sequential logic (TODO)
- After truth table, inputs are A=1,B=1 from last row
- `stepViaUI()` (one more clock edge)
- Read Q output: D_FF should have latched AND(1,1)=1 → Q=1
- Read CNT_Y output: Counter should have incremented (≥4 from truth table clock edges + 1)
- **Needs**: `readOutput` or equivalent method. Currently UICircuitBuilder has no `readOutput`. May need to add one, or use `runTestVectors` with expected Q/CNT_Y values.

#### Phase C — Switch AND gate to CMOS model (TODO)
- `setComponentProperty('G_AND', 'Model', 'CMOS (Subcircuit)')`
- Model dropdown label is `"Model"`, CMOS option is `"CMOS (Subcircuit)"` (from `src/editor/property-panel.ts:24`)
- `stepViaUI()` → `verifyNoErrors()`
- `stepToTimeViaUI('1m')` → `getAnalogState()`
- Assert CMOS AND output voltages at 0.1% against ngspice refs
- Note: CMOS model adds VDD/GND pins to the gate. May need to wire those or verify they auto-connect.
- **Gate models available**: And, Or, Not, NAnd, NOr, XOr, XNOr all have `cmos` in modelRegistry
- **FF models available**: D_FF has `cmos`, others (JK, T, RS) have `behavioral` only

### Master 2: Analog

#### Phase A — DC operating point (TODO — replace current placeholder assertions)
- `stepViaUI()` → `verifyNoErrors()`
- `stepToTimeViaUI('5m')` → `getAnalogState()`
- Assert all voltages finite
- Assert at **0.1% tolerance**:
  - `P_DIV ≈ 2.500000` (v_div)
  - `P_RC ≈ 2.500000` (v_rc)  
  - `P_AMP ≈ 2.499998` (v_amp)
  - `P_CE ≈ 10.00008` (v_col — BJT collector)
- Switch CTRL toggling fix has landed — no longer blocked.

#### Phase B — Modify R1 resistance (10k→20k) (TODO)
- `setComponentProperty('R1', 'resistance', 20000)`
- `stepToTimeViaUI('10m')` → `getAnalogState()`
- Assert at 0.1%:
  - `P_DIV ≈ 1.666667` (new divider ratio)
  - `P_RC ≈ 1.666667`
  - `P_AMP ≈ 1.666665`
  - `P_CE ≈ 10.88529`

#### Phase C — Modify BJT BF (100→50) via secondary params (TODO)
- `setSpiceParameter('Q1', 'BF', 50)`
- `stepToTimeViaUI('5m')` → `getAnalogState()`
- Assert at 0.1%:
  - `P_CE ≈ 11.43012` (less gain → higher collector voltage)
  - `v_base ≈ 0.6379` (slightly different Vbe)

#### Phase D — Trace/scope (TODO — expand current placeholder)
- `addTraceViaContextMenu('R1', 'A')`
- `measureAnalogPeaks('2m')`
- Assert: peaks ≠ null, nodeCount ≥ 1, maxPeak within range of phase C steady-state values

#### Phase E — Pin loading (TODO)
- Right-click wire on R1-R2 junction → select `"Pin Loading: Loaded"`
- Pattern from `e2e/gui/pin-loading-wire-override.spec.ts`:
  ```typescript
  // Right-click wire near the junction
  await page.mouse.click(wireX, wireY, { button: 'right' });
  const loadedItem = page.locator('.ctx-menu-item .ctx-menu-label')
    .filter({ hasText: 'Pin Loading: Loaded' });
  await loadedItem.click();
  ```
- `stepToTimeViaUI('5m')` → `getAnalogState()`
- Assert at 0.1%: `P_DIV ≈ 2.498751V` (loaded, vs 2.500000V unloaded; delta = 1.249mV)

### Master 3: Mixed-Signal

#### Phase A — DC operating point (TODO — replace current placeholder assertions)
- `stepViaUI()` → `verifyNoErrors()`
- `stepToTimeViaUI('5m')` → `getAnalogState()`
- Assert all voltages finite
- Assert at 0.1% (ngspice transient values at t=5ms, not steady-state):
  - VREF node ≈ 5.0V
  - RC node ≈ 3.121984V (98.94% settled toward 3.125V)
  - Cap node ≈ 3.091827V (still charging)
  - Vref2 node ≈ 2.5V
- Comparator polarity check: in- gets RC voltage (~3.12V), in+ gets Vref2 (2.5V). Since in+ < in-, comparator output must be LOW:
  - `readOutput('GA')` → assert output is 0 (AND gate driven by LOW comparator)
  - This confirms wiring polarity before Phase B tests the flip

#### Phase B — Modify Vref (5V→3.3V) (TODO)
- `setComponentProperty('Vref', 'Voltage (V)', 3.3)`
- `stepToTimeViaUI('5m')` → `getAnalogState()`
- Assert at 0.1% (ngspice transient values at t=5ms):
  - VREF ≈ 3.3V
  - RC node ≈ 2.060510V (98.94% settled toward 2.0625V)
  - Cap node ≈ 2.040606V
- Comparator: 2.5V (in+) > 2.061V (in-) → output HIGH → counter should count
- This is a digital behavioral change driven by analog param modification

#### Phase C — Modify R1 (1k→10k) (TODO)
- `setComponentProperty('R1', 'resistance', 10000)`
- `stepToTimeViaUI('50m')` (new τ = 10.1ms)
- Assert at 0.1% (ngspice transient values at t=50ms):
  - RC node ≈ 2.062355V (99.29% settled toward 2.0625V)
  - Cap node ≈ 2.047898V

#### Phase D — Trace/scope (TODO — expand current placeholder)
- `addTraceViaContextMenu('R1', 'A')`
- `measureAnalogPeaks('2m')`
- Assert: peaks ≠ null, nodeCount ≥ 1

#### Phase E — Pin electrical / rOut override (TODO)
- On the AND gate (GA) output pin, override Rout
- This changes the source impedance driving CNT.en
- Pattern from `e2e/gui/hotload-params-e2e.spec.ts`:
  ```typescript
  await page.mouse.click(pinX, pinY, { button: 'right' });
  const rOutInput = await getPinFieldInput(page, 'Rout');
  await rOutInput.fill('75');
  await rOutInput.press('Tab');
  ```
- `stepToTimeViaUI('5m')` → `getAnalogState()`
- Assert at 0.1%: with rOut=75, `V_junction ≈ 4.962779V` (vs default rOut=50: 4.975124V)

## UI Methods Inventory

### Available in UICircuitBuilder
- `placeComponent(type, x, y)`, `placeLabeled(type, x, y, label)`
- `setComponentProperty(label, propLabel, value)` — uses `_setPopupProperty`, matches `.prop-label` text
- `setSpiceParameter(label, paramKey, value)` — opens Advanced Parameters section if needed
- `drawWireExplicit(from, fromPin, to, toPin, waypoints?)`
- `drawWireFromPinExplicit(from, fromPin, toX, toY, waypoints?)`
- `stepViaUI(count?)`, `stepToTimeViaUI(timeStr)`, `stepAndReadAnalog(steps)`
- `getAnalogState()` → `{ simTime, nodeVoltages, nodeCount }`
- `getCircuitInfo()` → `{ elementCount, wireCount, elements[] }`
- `addTraceViaContextMenu(label, pin)`
- `measureAnalogPeaks(stepsOrTime)` → `{ amplitudes, peaks, troughs, nodeCount }`
- `runTestVectors(testData)` → `{ passed, failed, total }`
- `verifyNoErrors()`
- `toPageCoords(screenX, screenY)` — for manual click targeting

### Recently Added
- **readOutput(label)** — read a single labeled output's numeric value (digital or analog). Added to UICircuitBuilder, delegates to `test-bridge.readSignalByLabel`.
- **readAllSignals()** — read all labeled signals as `Record<string, number>`. Added to UICircuitBuilder, delegates to `test-bridge.readAllSignalValues`.

### Still Manual
- **Right-click wire / pin** — for pin loading and pin electrical flows. Currently done via raw `page.mouse.click(..., { button: 'right' })` in existing tests.

## ngspice Reference Netlists (COMPLETED)

All values confirmed via ngspice batch-mode simulation and analytical cross-verification.
Full details with netlists in `spec/ngspice-refs-complete.md`.

### CMOS AND gate (Master 1 Phase C) -- DONE
NMOS(VTO=1, KP=2e-5, LAMBDA=0.01), PMOS(VTO=-1, KP=1e-5, LAMBDA=0.01), W=L=1um.
- Both HIGH: V(out) = 5.000000e+00 (VDD), V(nand) = 2.505000e-07
- One LOW:   V(out) = 6.262500e-08 (0V),  V(nand) = 5.000000e+00

### Pin loading (Master 2 Phase E) -- DONE
BridgeInputAdapter stamps 1/rIn = 1/10M to GND when loaded=true.
- Unloaded: V(div) = 2.500000e+00
- Loaded:   V(div) = 2.498751e+00 (delta = 1.249e-03 V, 0.05%)

### Pin electrical / rOut override (Master 2 Phase F / Master 3 Phase E) -- DONE
Default rOut = 50 ohm (cmos-3v3 and cmos-5v). VOH=5V, Rload=10k.
- rOut=50:   V_junction = 4.975124e+00
- rOut=75:   V_junction = 4.962779e+00
- rOut=100k: V_junction = 4.545455e-01

### Master 3 transient -- DONE
DAC Thevenin: Vdac in series with Rdac=100. Tau = (Rdac+R1)*C1.
- m3_dc (t=5ms):      v_rc = 3.121984e+00, v_cap = 3.091827e+00
- m3_vref33 (t=5ms):   v_rc = 2.060510e+00, v_cap = 2.040606e+00
- m3_r1_10k (t=50ms):  v_rc = 2.062355e+00, v_cap = 2.047898e+00
- All settle to Vdac at t=inf (confirmed at t=10ms/100ms within 0.01%)

## Wire Capture Files
- `e2e/circuits/debug/master3-wiring-code.ts` — captured wiring from manual session
- `e2e/circuits/debug/master3-reference.dig` — reference .dig file
- Wire capture spec: `e2e/wire-capture.spec.ts` — updated to match compacted layout

## Property Labels (for setComponentProperty)
| Component | Property | UI Label |
|-----------|----------|----------|
| DcVoltageSource | voltage | `"Voltage (V)"` |
| Resistor | resistance | `"resistance"` |
| Capacitor | capacitance | `"capacitance"` |
| VoltageComparator | outputType | `"Output type"` |
| DAC | bits | `"Resolution (bits)"` |
| Counter/Out | bitWidth | `"Bits"` |
| Any | model | `"Model"` (dropdown) |
| Gates (CMOS option) | — | `"CMOS (Subcircuit)"` |
| Gates (behavioral) | — | `"Behavioral (MNA)"` |
| Gates (digital) | — | `"Digital"` |
