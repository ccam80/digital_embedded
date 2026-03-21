# E2E Circuit Assembly Test Plan

## Problem Statement

The test suite has a persistent blind spot: **no E2E test builds a complete circuit through genuine UI interactions (palette click → canvas place → wire draw → simulate → verify correctness)**. Every behavioral test loads pre-built circuits via postMessage XML or the `__test` bridge's mutation methods. Components that work in headless/API regularly break when assembled in the UI, and the tests still pass.

## Audit Summary

| Surface | Status |
|---------|--------|
| Component logic (unit) | 100% — all 154 types covered |
| Digital/analog/mixed engines (unit) | Strong |
| Editor subsystems (unit) | Good |
| PostMessage protocol (E2E parity) | Good |
| MCP server tool handlers | **Zero tests** |
| UI place-wire-simulate (E2E) | **Zero tests** |

Only 5 of 154 component types have ever been placed from the palette in E2E tests. Zero have been wired. Zero have been simulated after UI assembly.

## Goals

1. Every component type can be placed from the palette, wired, and compiled via UI interactions
2. Every width-configurable pin is tested at multiple bit widths
3. Every engine mode (`digital`, `analog`, `both` simulation modes) is exercised per component
4. Complex analog circuits with reactive components, transistor networks, and runtime switching are tested
5. Mixed-mode circuits exercise the digital↔analog bridge under realistic conditions
6. The MCP server tool handlers have dedicated Vitest coverage

## Phases

---

### Phase 1 — Test Infrastructure

**Deliverable:** `e2e/fixtures/ui-circuit-builder.ts`

A Playwright helper class that wraps genuine UI interactions:

| Method | What It Does |
|--------|-------------|
| `placeComponent(type, gridX, gridY)` | Click palette item by `[data-type]`, click canvas at grid coordinates, press Escape to exit placement |
| `setComponentProperty(label, propKey, value)` | Click component to select, find property input in panel, set value |
| `drawWire(fromLabel, fromPin, toLabel, toPin)` | Query bridge for pin screen positions, click-to-click wire drawing |
| `drawWireByGrid(x1, y1, x2, y2)` | Direct grid-coordinate wire drawing (for complex routing) |
| `compileViaUI()` | Click toolbar compile/step button, wait for status indicator |
| `stepViaUI(n?)` | Click step button N times |
| `runViaUI()` / `stopViaUI()` | Click run/stop buttons |
| `switchEngineMode(mode)` | Click circuit mode toggle to switch digital/analog |
| `verifySignal(label, expected)` | Read signal via bridge after stepping, assert value |
| `verifyNoErrors()` | Assert no error banner/toast visible |
| `verifyCompilationSuccess()` | Assert status bar shows compiled state |
| `setPalette(components)` | Use postMessage to restrict palette (for focused tests) |

**Rules for this helper:**
- All circuit mutations go through real UI events (mouse clicks, keyboard presses)
- Bridge is used ONLY for coordinate queries (`getPinPosition`, `getCircuitInfo`) and signal reads
- Bridge mutation methods (`buildAnalogRcCircuit`, `compileCircuit`, `stepAnalog`) are NEVER called
- No `page.evaluate(() => button.click())` — use Playwright's `page.click()` / `page.keyboard.press()`

**Additional infrastructure:**
- Remove conditional fallbacks in `analog-rc-circuit.spec.ts` that silently pass when palette items aren't visible
- Document bridge methods as `query-only` vs `mutation` in `test-bridge.ts` JSDoc

---

### Phase 2 — Core Digital Circuits via UI

**File:** `e2e/gui/digital-circuit-assembly.spec.ts`

Each test places all components from the palette, draws all wires via pin clicks, compiles via toolbar, steps, and verifies outputs.

| # | Circuit | Components | Verification | Why This Circuit |
|---|---------|------------|-------------|-----------------|
| 1 | AND gate | In×2, And, Out | Truth table: 4 input combos | Simplest possible — proves the entire pipeline |
| 2 | OR gate | In×2, Or, Out | Truth table: 4 combos | Second gate type, confirms generality |
| 3 | Half adder | In×2, XOr, And, Out×2 | S=A⊕B, C=A∧B for all combos | Multi-output, two gate types |
| 4 | Full adder | In×3, XOr×2, And×2, Or, Out×2 | Sum and carry for all 8 combos | Complex combinational, 7 components |
| 5 | SR latch | NAnd×2, In×2, Out×2 | Set/Reset/Hold states | Feedback loop — sequential + oscillation handling |
| 6 | D flip-flop | In, Clock, FlipflopD, Out | Load D, clock edge, verify Q | Clock-driven — tests clock advancement via UI step |
| 7 | JK flip-flop | In×2, Clock, FlipflopJK, Out×2 | J/K/Toggle/Hold states | Second sequential type |
| 8 | T flip-flop counter | Clock, T_FF×4, Out×4 | Count sequence 0–15 | Chained sequential, multi-bit |
| 9 | 4-bit counter | Clock, Counter, Splitter, Out×4 | Count sequence | Multi-bit output with splitter wiring |
| 10 | 2:1 Mux | In×3, Mux, Out | Select=0→A, Select=1→B | Selector-based routing |
| 11 | 4:1 Mux | In×5 (4 data + sel), Mux(selectorBits=2), Out | All 4 select values | Multi-bit selector |
| 12 | Decoder | In×2, Decoder, Out×4 | Each input combo activates one output | One-hot decoding |
| 13 | 4-bit adder | In×2 (4-bit), Add, Out (4-bit), Out (carry) | 3+5=8, 15+1=0+carry | Multi-bit arithmetic |
| 14 | Comparator | In×2 (4-bit), Comparator, Out×3 | Less/Equal/Greater for several pairs | Three-output comparison |
| 15 | ROM lookup | In (4-bit addr), ROM (preloaded), Out (8-bit) | Read address 0,1,2,3 → expected data | Memory with data loading |
| 16 | RAM write/read | In (addr), In (data), In (WE), Clock, RAMSinglePort, Out | Write then read back | Memory R/W cycle |
| 17 | Register file | In (addr), In (data), In (WE), Clock, RegisterFile, Out | Write R1, read R1 | Register addressing |
| 18 | Tunnel wiring | In, Tunnel×2 (same label), Out | Signal propagates through tunnel | Invisible wire connections |
| 19 | Bus splitter | In (8-bit), Splitter (4+4), Out×2 (4-bit) | Upper/lower nibble extraction | Bit-field slicing |
| 20 | Priority encoder | In (4-bit), PriorityEncoder, Out | Highest set bit → encoded output | Encoding logic |

---

### Phase 3 — Analog Circuits via UI

**File:** `e2e/gui/analog-circuit-assembly.spec.ts`

All tests switch to analog mode via UI, place components from analog palette, wire, compile, step, and verify voltage/current values within tolerance.

#### 3A — Basic Analog

| # | Circuit | Components | Verification |
|---|---------|------------|-------------|
| 1 | RC lowpass | AcVoltageSource, Resistor, Capacitor, Ground, Probe | Steady-state amplitude within 5% of analytical |
| 2 | Voltage divider | DcVoltageSource, Resistor×2, Ground, Probe | Vout = Vin × R2/(R1+R2) |
| 3 | RL circuit | DcVoltageSource, Resistor, Inductor, Ground, Probe | Current rise τ = L/R |
| 4 | RLC series | AcVoltageSource, Resistor, Inductor, Capacitor, Ground, Probe | Resonance frequency f₀ = 1/(2π√LC) |
| 5 | RLC parallel | AcVoltageSource, Resistor ∥ (Inductor + Capacitor), Ground, Probe | Anti-resonance behavior |

#### 3B — Semiconductor Circuits

| # | Circuit | Components | Verification |
|---|---------|------------|-------------|
| 6 | Diode rectifier | AcVoltageSource, AnalogDiode, Capacitor, Resistor, Ground, Probe | Output ≈ Vpeak - Vf, ripple within range |
| 7 | Zener regulator | DcVoltageSource, Resistor, ZenerDiode, Ground, Probe | Output clamps at Vz |
| 8 | BJT common-emitter | DcVoltageSource×2, NpnBjt, Resistor×4 (Rb, Rc, Re, Rload), Capacitor×2 (Cin, Cout), Ground | DC bias point: Vce > 0, Ic > 0; AC gain |
| 9 | BJT differential pair | DcVoltageSource, NpnBjt×2, Resistor×3 (Rc×2, Re_tail), Ground, Probe×2 | Balanced: Vout1 ≈ Vout2; unbalanced: differential gain |
| 10 | BJT Darlington pair | DcVoltageSource, NpnBjt×2, Resistor×3, Ground, Probe | High current gain β₁×β₂ |
| 11 | BJT push-pull output | DcVoltageSource×2, NpnBjt, PnpBjt, Resistor×2, Ground, Probe | Complementary output follows input |
| 12 | MOSFET common-source | DcVoltageSource×2, Nmosfet, Resistor×3 (Rg, Rd, Rs), Ground, Probe | DC bias: Vds > Vgs-Vth; gain |
| 13 | CMOS inverter | DcVoltageSource, Nmosfet, Pmosfet, Ground, Probe | Vin=0→Vout=Vdd, Vin=Vdd→Vout≈0 |
| 14 | CMOS NAND | DcVoltageSource, Nmosfet×2, Pmosfet×2, Ground, Probe | NAND truth table at analog voltages |
| 15 | JFET amplifier | DcVoltageSource×2, NJfet, Resistor×3, Ground, Probe | Pinch-off region operation |

#### 3C — Complex Transistor Networks

| # | Circuit | Components | Verification |
|---|---------|------------|-------------|
| 16 | Cascode amplifier | DcVoltageSource, NpnBjt×2, Resistor×4, Capacitor×2, Ground, Probe | Higher output impedance than single CE |
| 17 | Wilson current mirror | DcVoltageSource, NpnBjt×3, Resistor×2, Ground, Probe | Output current ≈ reference current |
| 18 | Widlar current source | DcVoltageSource, NpnBjt×2, Resistor×3, Ground, Probe | Low current output |
| 19 | MOSFET H-bridge | DcVoltageSource, Nmosfet×2, Pmosfet×2, Resistor (load), Ground, Probe | Forward/reverse/brake states |
| 20 | BJT+MOSFET mixed driver | DcVoltageSource, NpnBjt (level shift), Nmosfet (power), Resistor×3, Ground, Probe | BJT drives MOSFET gate |
| 21 | Multi-stage amplifier | DcVoltageSource, NpnBjt×3, Resistor×8, Capacitor×4, Ground, Probe | Three CE stages, overall gain |

#### 3D — Reactive + Switching Circuits

These circuits include switches (`Switch`, `SwitchDT`, `AnalogSwitchSPST`, `AnalogSwitchSPDT`) that open/close mid-simulation to test the engine's handling of topology changes and transient response.

| # | Circuit | Components | Test Procedure |
|---|---------|------------|---------------|
| 22 | Switched RC charge/discharge | DcVoltageSource, Switch, Resistor, Capacitor, Ground, Probe | Close switch → verify exponential charge. Open switch → verify exponential discharge |
| 23 | LRC with switch | DcVoltageSource, Switch, Inductor, Resistor, Capacitor, Ground, Probe | Close switch → verify damped oscillation. Open switch → verify ringing decay |
| 24 | Relay-driven LC | DcVoltageSource, Relay, Inductor, Capacitor, Resistor, Ground, Probe | Relay toggles to switch between LC and R load — verify transient at switch point |
| 25 | Switched capacitor filter | Clock, AnalogSwitchSPST×2, Capacitor×2, Resistor, OpAmp, Ground, Probe | Clock-driven switch toggling — verify equivalent resistance behavior |
| 26 | SPDT source selector | DcVoltageSource×2 (different V), SwitchDT, Resistor, Capacitor, Ground, Probe | Toggle SPDT → output transitions between V1 and V2 with RC time constant |
| 27 | BJT switch with inductive load | DcVoltageSource, NpnBjt, Resistor×2, Inductor, AnalogDiode (flyback), Ground, Probe | Turn BJT off → verify flyback diode clamps voltage spike |
| 28 | MOSFET PWM into RLC | DcVoltageSource, Nmosfet (driven by Clock), Inductor, Resistor, Capacitor, Ground, Probe | Verify filtered DC output ≈ duty_cycle × Vdd |
| 29 | Crystal oscillator startup | DcVoltageSource, NpnBjt, Crystal, Capacitor×2, Resistor×2, Ground, Probe | Verify oscillation builds up at crystal frequency |

#### 3E — Active ICs + Sensors

| # | Circuit | Components | Verification |
|---|---------|------------|-------------|
| 30 | Op-amp inverting | OpAmp, Resistor×2, DcVoltageSource, Ground, Probe | Gain = -Rf/Rin |
| 31 | Op-amp integrator | OpAmp, Resistor, Capacitor, DcVoltageSource, Ground, Probe | Ramp output for DC input |
| 32 | 555 astable | Timer555, Resistor×2, Capacitor, DcVoltageSource, Ground, Probe | Oscillation frequency ≈ 1.44/((Ra+2Rb)C) |
| 33 | SCR latch circuit | DcVoltageSource, SCR, Resistor×2, Switch (trigger), Ground, Probe | Trigger SCR on → stays latched until current drops below holding |
| 34 | Triac dimmer | AcVoltageSource, Triac, Diac, Resistor, Capacitor, Ground, Probe | Phase-angle control of AC |
| 35 | LDR voltage divider | DcVoltageSource, LDR, Resistor, Ground, Probe | Output varies with simulated light level |

---

### Phase 4 — Mixed-Mode Circuits via UI

**File:** `e2e/gui/mixed-circuit-assembly.spec.ts`

Each test builds a circuit containing both digital and analog components, verifying the mixed-signal bridge works end-to-end through the UI.

#### 4A — Digital→Analog Bridge

| # | Circuit | Components | Verification |
|---|---------|------------|-------------|
| 1 | DAC + RC filter | In×4 (digital), DAC, Resistor, Capacitor, Ground, Probe | Digital input → analog voltage, filtered |
| 2 | Digital gate driving analog load | In (digital), And, Resistor, Led (analog model), Ground | Gate output drives current through load |
| 3 | PWM to analog voltage | Clock, Counter, Comparator (digital), Resistor, Capacitor, Ground, Probe | Counter-generated PWM → filtered DC |

#### 4B — Analog→Digital Bridge

| # | Circuit | Components | Verification |
|---|---------|------------|-------------|
| 4 | Comparator to logic | DcVoltageSource, Potentiometer, AnalogComparator, And, Out | Analog threshold → digital gate input |
| 5 | ADC readout | AcVoltageSource, Resistor, ADC, Out×8 | Analog waveform → digital samples |
| 6 | Schmitt trigger to counter | AcVoltageSource, Resistor, SchmittInverting, Counter, Out×4 | Analog → clean digital clock → count |

#### 4C — Bidirectional Mixed-Signal

| # | Circuit | Components | Verification |
|---|---------|------------|-------------|
| 7 | 555 timer driving digital counter | Timer555, Resistor×2, Capacitor, DcVoltageSource, Ground, Counter, Splitter, Out×4 | Analog oscillator → digital count |
| 8 | Digital servo loop | DcVoltageSource, DAC, OpAmp, Resistor×2, ADC, Counter, Ground, Probe | Digital→analog→feedback→digital |
| 9 | Mixed transistor + gate | DcVoltageSource, NpnBjt, Resistor×2, And (digital), Out, Ground | BJT level-shifts into digital gate |

#### 4D — Mixed-Mode with Switching

| # | Circuit | Components | Verification |
|---|---------|------------|-------------|
| 10 | Digital-controlled analog switch | In (digital), AnalogSwitchSPST, DcVoltageSource, Resistor, Ground, Probe | Digital signal opens/closes analog path |
| 11 | Relay from digital logic | In×2, And, Relay, DcVoltageSource, Resistor, Ground, Probe | Logic output drives relay coil → switches analog load |
| 12 | Mixed switching transient | Clock, FlipflopD, AnalogSwitchSPDT, Inductor, Capacitor, Resistor×2, DcVoltageSource, Ground, Probe | FF output toggles analog switch → verify LRC transient at each toggle |

#### 4E — Per-Component Engine Mode Testing

For every component with `engineType: "both"` or `simulationModes` options, test each available mode:

| Component | Modes to Test | Circuit Context |
|-----------|--------------|----------------|
| And, Or, Not, NAnd, NOr, XOr, XNOr | `logical`, `analog-pins`, `analog-internals` (if transistorModel) | Same truth-table circuit in digital engine, then in analog engine, then mixed |
| D_FF, JK_FF, RS_FF, T_FF | `logical`, `analog-pins`, `analog-internals` | Same sequential circuit across engine modes |
| AnalogComparator | analog mode, mixed mode (feeding digital logic) | Threshold detection in pure analog vs mixed |
| DAC, ADC | mixed mode (both sides active) | Data conversion with both engines running |

**Test structure:**
```
for each component with multiple engine modes:
  for each supported mode:
    - Place component via UI
    - Set simulationMode property via property panel
    - Wire to appropriate In/Out for that engine
    - Compile and step
    - Verify functional correctness matches reference
```

---

### Phase 5 — Component Category Sweep with Bit-Width Variations

**File:** `e2e/gui/component-sweep.spec.ts`

Parametrized tests that place every component type from the palette, wire it to generic I/O, and compile. For width-configurable components, test at multiple bit widths.

#### 5A — Placement + Compilation Sweep

For **every** registered component type (154 types):

```
test.each(allComponentTypes)('$type can be placed and compiled via UI', async ({ type, category }) => {
  if (isAnalog(category)) await builder.switchEngineMode('analog');
  await builder.placeComponent(type, 5, 5);
  // Wire each input pin to an In, each output to an Out
  const pins = await bridge.describePins(type);
  for (const input of pins.inputs) {
    await builder.placeComponent('In', ...);
    await builder.drawWire(...);
  }
  for (const output of pins.outputs) {
    await builder.placeComponent('Out', ...);
    await builder.drawWire(...);
  }
  await builder.compileViaUI();
  await builder.verifyNoErrors();
});
```

#### 5B — Bit-Width Variation Sweep

For every component with width-configurable pins, test at widths: **1, 2, 4, 8, 16, 32** (or component's supported range).

| Component Group | Width Property | Widths to Test | Pins Affected |
|----------------|---------------|----------------|---------------|
| Gates (And, Or, XOr, NAnd, NOr, XNOr, Not) | `bitWidth` (1–32) | 1, 2, 4, 8, 16, 32 | All I/O pins |
| In, Out | `bitWidth` | 1, 2, 4, 8, 16, 32 | out / in |
| Mux, Demux | `selectorBits` (1–4) + `bitWidth` | selectorBits: 1,2,3,4 × bitWidth: 1,4,8 | Data + selector pins |
| Decoder | `selectorBits` | 1, 2, 3, 4 | Input + output count changes |
| Splitter | `bitWidth` + splitting pattern | 8(4,4), 16(8,8), 16(4,4,4,4), 32(16,16) | Split pin widths |
| Add, Sub, Mul, Div | `bitWidth` | 1, 4, 8, 16, 32 | Operand + result pins |
| Comparator | `bitWidth` | 1, 4, 8, 16 | Input pins |
| Counter, CounterPreset | `bitWidth` | 2, 4, 8, 16 | Output pins |
| Register, RegisterFile | `bitWidth` | 1, 4, 8, 16, 32 | Data pins |
| ROM, RAM (all variants) | `dataBits` + `addrBits` | dataBits: 4,8,16 × addrBits: 2,4,8 | Data + address pins |
| FlipflopD, FlipflopJK | `bitWidth` | 1, 4, 8 | D/Q pins |
| BitSelector | `bitWidth` | 4, 8, 16, 32 | Input width |
| PriorityEncoder | `bitWidth` | 2, 4, 8 | Input width |
| BitExtender | `inputBits` + `outputBits` | 4→8, 8→16, 16→32 | In/out widths differ |
| BarrelShifter | `bitWidth` | 4, 8, 16, 32 | Data width |
| Driver, DriverInvSel | `bitWidth` | 1, 4, 8, 16 | Tristate data width |
| Tunnel | `bitWidth` | 1, 4, 8, 16 | Signal width |
| DAC | `bitWidth` (input) | 4, 8, 12 | Digital input width |
| ADC | `bitWidth` (output) | 4, 8, 12 | Digital output width |

**Test structure per width-configurable component:**
```
test.each(widthMatrix)('$type at bitWidth=$width compiles and simulates', async ({ type, width, propKey }) => {
  await builder.placeComponent(type, 5, 5);
  await builder.setComponentProperty(type, propKey, width);
  // Wire matching-width In/Out
  await builder.placeComponent('In', 1, 5, { bitWidth: width });
  await builder.drawWire('In', 'out', type, inputPin);
  await builder.placeComponent('Out', 9, 5, { bitWidth: width });
  await builder.drawWire(type, outputPin, 'Out', 'in');
  await builder.compileViaUI();
  await builder.verifyNoErrors();
  // Verify signal propagation at this width
  await builder.stepViaUI();
  await builder.verifySignal('Out', expectedValue);
});
```

#### 5C — Per-Component Engine Mode Sweep

For every component with `engineType: "both"`, test in each available engine context:

```
test.each(dualEngineComponents)('$type works in $engineMode mode', async ({ type, engineMode, simMode }) => {
  if (engineMode !== 'digital') await builder.switchEngineMode('analog');
  await builder.placeComponent(type, 5, 5);
  if (simMode) await builder.setComponentProperty(type, 'simulationMode', simMode);
  // Wire, compile, verify
  await builder.compileViaUI();
  await builder.verifyNoErrors();
  await builder.stepViaUI();
  // Functional check: e.g., AND gate truth table holds in every mode
});
```

---

### Phase 6 — MCP Server Tool Tests

**File:** `scripts/__tests__/circuit-mcp-server.test.ts`

Unit tests for the MCP server tool handlers (Vitest, not E2E):

| Area | Tests |
|------|-------|
| Handle lifecycle | Create handle, use handle, dispose handle, reject expired handle |
| `circuit_list` | Returns all types, category filter works |
| `circuit_describe` | Returns correct pins and properties for known types |
| `circuit_build` | Valid spec → handle, invalid spec → structured error |
| `circuit_load` | Load .dig file → handle, missing file → error |
| `circuit_netlist` | Returns components, nets, diagnostics |
| `circuit_patch` | Apply set/add/remove/connect/disconnect/replace ops |
| `circuit_validate` | Returns diagnostics array |
| `circuit_compile` | Success case + compilation error case |
| `circuit_test` | Pass + fail cases, embedded test data |
| `circuit_test_equivalence` | Equivalent + non-equivalent circuit pairs |
| `circuit_save` | Writes file, save_all copies subcircuits |
| Error formatting | All errors match MCP protocol structure |
| JSON serialization | Round-trip all response types |

---

## Test File Structure

```
e2e/
  fixtures/
    ui-circuit-builder.ts          ← Phase 1: UI interaction helper
    simulator-harness.ts           ← existing (postMessage helper)
  gui/
    digital-circuit-assembly.spec.ts   ← Phase 2: 20 digital circuits
    analog-circuit-assembly.spec.ts    ← Phase 3: 35 analog circuits
    mixed-circuit-assembly.spec.ts     ← Phase 4: 12 mixed circuits
    component-sweep.spec.ts            ← Phase 5: parametrized sweep
    // existing files unchanged
  parity/
    // existing files unchanged
scripts/
  __tests__/
    circuit-mcp-server.test.ts     ← Phase 6: MCP tool tests
```

## Execution Order

| Priority | Phase | Est. Tests | Rationale |
|----------|-------|-----------|-----------|
| **P0** | Phase 1 (infrastructure) | 0 (helper only) | Everything else depends on this |
| **P0** | Phase 2 test #1 (AND gate) | 1 | Single highest-value test — proves the entire UI pipeline |
| **P1** | Phase 2 remaining (#2–#20) | 19 | Core digital coverage |
| **P1** | Phase 5A (placement sweep) | ~154 | Broad coverage, catches palette/compilation gaps |
| **P2** | Phase 5B (bit-width sweep) | ~300+ | Catches width-mismatch bugs across all configurable components |
| **P2** | Phase 3A–3B (basic analog + semiconductors) | 15 | Analog palette + compilation path |
| **P3** | Phase 3C (complex transistor networks) | 6 | BJT/MOSFET interaction, current mirrors, H-bridges |
| **P3** | Phase 3D (reactive + switching) | 8 | Runtime topology changes, transient response, LRC dynamics |
| **P3** | Phase 3E (active ICs + sensors) | 6 | Op-amps, 555, SCR, Triac, LDR |
| **P3** | Phase 4A–4D (mixed-mode) | 12 | Digital↔analog bridge under UI assembly |
| **P3** | Phase 4E + 5C (engine mode sweep) | ~50+ | Every dual-engine component in every mode |
| **P4** | Phase 6 (MCP tool tests) | ~30 | Fills Three-Surface Rule gap |

## Success Criteria

- [ ] `UICircuitBuilder` helper uses only genuine UI interactions for all circuit mutations
- [ ] At least one circuit per phase compiles and simulates correctly when built entirely through UI
- [ ] Every component type (154) passes placement + compilation sweep
- [ ] Every width-configurable component passes at min, mid, and max supported widths
- [ ] Every `engineType: "both"` component passes in digital, analog, and mixed engine contexts
- [ ] At least 3 circuits include runtime switch toggling with transient verification
- [ ] At least 3 circuits include BJT+MOSFET mixed transistor networks
- [ ] At least 2 circuits include LRC reactive components with transient response checks
- [ ] MCP tool handler tests exist for all 12 tool endpoints
- [ ] No test uses bridge mutation methods or `page.evaluate(() => button.click())`
- [ ] No test has conditional fallback logic that silently passes on failure
- [ ] All existing tests continue to pass (no regressions)
