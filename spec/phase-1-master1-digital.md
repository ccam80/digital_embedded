# Phase 1: Master 1 — Digital Logic Assertions

## Target File
`e2e/gui/master-circuit-assembly.spec.ts` — the `Master 1: digital logic` test block.

## Reference
Full spec with ngspice values: `spec/master-circuit-assertions.md`

## Wave 1.1

### Task 1.1.1 — Sequential Logic Assertions (Phase B) [M]

**Current state**: The test ends after `runTestVectors` truth table (line ~135). Comments mention sequential verification but no assertions exist.

**Required changes**: After the truth table assertions (line 125), add:
1. After truth table, inputs are A=1, B=1 from last row
2. `stepViaUI()` — one more clock edge
3. `readOutput('Q')` — D_FF should have latched AND(1,1)=1 → expect Q === 1
4. `readOutput('CNT_Y')` — Counter should have incremented. After 4 truth-table clock edges + 1 more = 5 edges. Counter counts from 0, so CNT_Y >= 4 (at least).
5. Use `expect()` assertions, not comments.

**Key methods**: `builder.readOutput(label)` returns `number | null`. `builder.stepViaUI()`.

### Task 1.1.2 — CMOS Model Switch (Phase C) [M]

**Current state**: No CMOS assertions exist.

**Required changes**: After the sequential assertions from Task 1.1.1, add a new section:
1. `setComponentProperty('G_AND', 'Model', 'CMOS (Subcircuit)')` — switch AND gate to CMOS model
2. `stepViaUI()` → `verifyNoErrors()` — recompile with CMOS model
3. `stepToTimeViaUI('1m')` → `getAnalogState()` — let CMOS settle
4. Assert CMOS AND output voltages at 0.1% against ngspice refs:
   - With both inputs HIGH (A=1, B=1 from prior state):
     - V(out) ≈ 5.0V (ngspice: 5.000000e+00)
     - V(nand_out) ≈ 0V (ngspice: 2.505000e-07)
   - Note: The test has A=1, B=1 from the last truth table row, so we're in the "both HIGH" case
5. Use `readAllSignals()` or `getAnalogState()` to read the CMOS voltages

**ngspice reference** (from spec):
- m1_cmos_and_high (both inputs = 5V): V(out) = 5.000000e+00, V(nand_out) = 2.505000e-07
- The output we care about is the AND gate final output, which should be ~5V

**Important**: After switching to CMOS, the gate operates in analog domain. The `getAnalogState()` nodeVoltages will contain the CMOS node voltages.
