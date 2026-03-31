# Master Circuit E2E Assertion Spec

## Status

- **Master 1 (Digital)**: Wiring PASSING, minimal assertions (truth table only)
- **Master 2 (Analog)**: Wiring PASSING, assertions placeholder (switch bug blocks voltage verification — being fixed in parallel session)
- **Master 3 (Mixed)**: Wiring PASSING (captured from manual session), assertions placeholder (voltage reads as 1V, needs debug)
- **Tier 4 tests**: DELETED (digital-circuit-assembly, analog-circuit-assembly, mixed-circuit-assembly, analog-rc-circuit)
- **`getCircuitDomain()`**: Test bridge heuristic only (returns 'analog' or 'digital', never 'mixed'). Removed from all masters. Located at `src/app/test-bridge.ts:228`. Consider deleting the method entirely.

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
At t=5ms (5τ for τ=1.1ms), RC settled:
```
v_vref:    5.000000e+00
v_rc:      3.125000e+00   (10/16 × 5V, via R_dac=100Ω + R1=1k)
v_cap:     3.125000e+00   (settled)
v_vref2:   2.500000e+00
```
Note: .tran output wasn't captured in last run — need `.print tran` or `.measure` directives. Values above are analytical (confirmed by the steady-state math: no DC current through C → V_cap = V_dac × R1/(R_dac+R1) ≈ 3.125 × 1000/1100 ≈ 2.841V at DC with R_dac load, BUT at full settle V_cap → V_dac since C blocks DC through R1). Rerun with proper .print needed.

### Master 3 — m3_vref33 (Vref=3.3V → DAC=10/16×3.3=2.0625V)
```
v_vref:  3.300000e+00
v_rc:    2.062500e+00
v_cap:   2.062500e+00
v_vref2: 2.500000e+00
```
Note: Comparator flips (2.0625 < 2.5) → output LOW → counter stops.

### Master 3 — m3_r1_10k (R1=10k, τ=10.1ms, settle at 50ms)
```
v_rc:    2.062500e+00   (same DAC voltage, just slower settle)
```

### Still needed
- **m1_cmos_and_high/low**: CMOS AND gate voltages. Analytically: output ≈ VDD when both inputs high, ≈ 0V when any input low. Need ngspice subcircuit run for exact values with NMOS/PMOS models matching our `CMOS_AND2_NETLIST` in `src/components/gates/and.ts`.

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
- **Blocker**: Switch CTRL not toggling (voltages ≈ 0). Being fixed in parallel session.

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
- Assert: voltage at P_DIV changes from ideal value (parasitic loading effect)
- **Note**: Need to determine expected voltage shift. May need ngspice ref with loading model, or just assert `P_DIV !== previousValue` (qualitative check).

#### Phase F — Pin electrical / rOut override (TODO)
- Right-click AND gate output pin → change Rout
- Pattern from `e2e/gui/hotload-params-e2e.spec.ts`:
  ```typescript
  // Open pin electrical popup
  await page.mouse.click(pinX, pinY, { button: 'right' });
  // Find and click "Pin Electrical" or similar menu item
  const rOutInput = await getPinFieldInput(page, 'Rout');
  await rOutInput.fill('75');
  await rOutInput.press('Tab');
  ```
- This flow fits better on Master 3 (mixed-signal) where digital pins drive analog loads
- Assert: voltage at analog node changes with different rOut

### Master 3: Mixed-Signal

#### Phase A — DC operating point (TODO — replace current placeholder assertions)
- `stepViaUI()` → `verifyNoErrors()`
- `stepToTimeViaUI('5m')` → `getAnalogState()`
- Assert all voltages finite
- Assert at 0.1%:
  - VREF node ≈ 5.0V
  - RC node ≈ 3.125V (DAC output after settling)
  - Vref2 node ≈ 2.5V
- Note: Comparator in- gets RC voltage (3.125V), in+ gets Vref2 (2.5V). Since in+ < in-, comparator output is LOW with this wiring. Counter should NOT count.

#### Phase B — Modify Vref (5V→3.3V) (TODO)
- `setComponentProperty('Vref', 'Voltage (V)', 3.3)`
- `stepToTimeViaUI('5m')` → `getAnalogState()`
- Assert at 0.1%:
  - VREF ≈ 3.3V
  - RC node ≈ 2.0625V (10/16 × 3.3V)
- Comparator: 2.5V (in+) > 2.0625V (in-) → output HIGH → counter should count
- This is a digital behavioral change driven by analog param modification

#### Phase C — Modify R1 (1k→10k) (TODO)
- `setComponentProperty('R1', 'resistance', 10000)`
- `stepToTimeViaUI('50m')` (new τ = 10.1ms)
- Assert at 0.1%:
  - RC node ≈ 2.0625V (same steady-state, different time constant)

#### Phase D — Trace/scope (TODO — expand current placeholder)
- `addTraceViaContextMenu('R1', 'A')`
- `measureAnalogPeaks('2m')`
- Assert: peaks ≠ null, nodeCount ≥ 1

#### Phase E — Pin electrical / rOut override (TODO)
- On the AND gate (GA) output pin, override Rout
- This changes the source impedance driving CNT.en
- `stepToTimeViaUI('5m')` → `getAnalogState()`
- Assert: measurable voltage change at the gate-to-counter junction

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

### Missing / May Need
- **readOutput(label)** — read a single digital Out component value. Needed for Master 1 Phase B (D_FF, Counter).
- **readAllSignals()** — read all signal values. Alternative to readOutput.
- **Right-click wire / pin** — for pin loading and pin electrical flows. Currently done via raw `page.mouse.click(..., { button: 'right' })` in existing tests.

## ngspice Netlists Still Needed

### CMOS AND gate (for Master 1 Phase C)
Need to match the `CMOS_AND2_NETLIST` in `src/components/gates/and.ts:130`:
- Topology: CMOS NAND2 driving a CMOS inverter
- Ports: In_1, In_2, out, VDD, GND
- Need NMOS/PMOS model params matching our defaults
- Simulate: both inputs high → V(out); one input low → V(out)

### Pin electrical / rOut override (for Master 2 Phase F / Master 3 Phase E)
Need reference values for voltage shift when rOut is changed on a digital gate output driving an analog load:
- Baseline: default rOut (check `src/components/gates/and.ts` for default, likely 50-100Ω)
- Override: rOut=100kΩ with RL (load resistor in circuit)
- V_junction = Voh × RL / (rOut + RL) — significant drop when rOut >> RL
- Need ngspice runs for: default rOut, rOut=75Ω, rOut=100kΩ with representative load

### Pin loading (for Master 2 Phase E)
Need reference values for voltage change when pin loading is applied:
- "Loaded" mode adds parasitic capacitance/resistance to the pin
- Check `src/solver/analog/compiler.ts` for the loading model (what parasitics are added)
- Run ngspice with and without the parasitic model to get expected voltage delta

### Master 3 transient (need .print tran directive)
The m3 .cir files ran but didn't output values — need `.print tran v(rc_node) v(cap_pos)` and read last line. Rerun with:
```spice
.tran 1u 5m
.print tran v(vref) v(rc_node) v(cap_pos) v(vref2)
.end
```

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
